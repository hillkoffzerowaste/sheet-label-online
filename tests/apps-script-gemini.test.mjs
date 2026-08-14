import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const codeUrl = new URL("../apps-script/Code.gs", import.meta.url);

async function loadHelpers() {
  const source = await readFile(codeUrl, "utf8");
  const forbiddenService = new Proxy(
    {},
    {
      get() {
        throw new Error("Google service must not be called in pure helper tests");
      },
    },
  );
  const context = vm.createContext({
    console,
    DriveApp: forbiddenService,
    SpreadsheetApp: forbiddenService,
    ContentService: forbiddenService,
    PropertiesService: forbiddenService,
    UrlFetchApp: forbiddenService,
  });

  vm.runInContext(source, context, { filename: codeUrl.pathname });
  return context;
}

test("creates a shipping-label sheet name from the processing date", async () => {
  const context = await loadHelpers();
  context.Session = {
    getScriptTimeZone: () => "Asia/Bangkok",
  };
  context.Utilities = {
    formatDate: (date, timeZone, pattern) => {
      assert.equal(date.toISOString(), "2026-07-29T02:00:00.000Z");
      assert.equal(timeZone, "Asia/Bangkok");
      assert.equal(pattern, "yyyy-MM-dd");
      return "2026-07-29";
    },
  };

  assert.equal(
    context.getShippingLabelsSheetName_(new Date("2026-07-29T02:00:00.000Z")),
    "2026-07-29",
  );
});

test("defaults Gemini PDF extraction to the current Flash-Lite model", async () => {
  const context = await loadHelpers();
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (key === "GEMINI_API_KEY" ? "test-key" : null),
    }),
  };

  assert.equal(context.getGeminiConfig_().model, "gemini-3.1-flash-lite");
});

test("recognizes Gemini quota responses without treating other errors as quota", async () => {
  const context = await loadHelpers();

  assert.equal(context.isGeminiQuotaError_(429, "RESOURCE_EXHAUSTED"), true);
  assert.equal(context.isGeminiQuotaError_(200, "quota exceeded"), true);
  assert.equal(context.isGeminiQuotaError_(400, "invalid argument"), false);
});

test("preserves the Google Cloud error reason when OCR returns a non-2xx response", async () => {
  const context = await loadHelpers();
  context.ScriptApp = { getOAuthToken: () => "oauth-token" };
  context.UrlFetchApp = {
    fetch: () => ({
      getResponseCode: () => 403,
      getContentText: () => JSON.stringify({
        error: {
          status: "PERMISSION_DENIED",
          message: "Cloud Vision API is not enabled in project 123",
        },
      }),
    }),
  };

  assert.throws(
    () => context.fetchGoogleCloudOcr_("https://vision.googleapis.com/test", {}),
    (error) => {
      assert.equal(error.name, "CloudOcrError");
      assert.match(error.message, /HTTP 403/);
      assert.match(error.message, /Cloud Vision API is not enabled/);
      return true;
    },
  );
});

test("uses the regional Vision endpoint for a regional OCR project", async () => {
  const context = await loadHelpers();
  const urls = [];
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => ({
        GOOGLE_CLOUD_PROJECT_ID: "project-123",
        GOOGLE_CLOUD_LOCATION: "us",
      })[key] || null,
    }),
  };
  context.Utilities = { base64Encode: () => "pdf-bytes" };
  context.ScriptApp = { getOAuthToken: () => "oauth-token" };
  context.UrlFetchApp = {
    fetch: (url) => {
      urls.push(url);
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ responses: [] }),
      };
    },
  };

  context.extractTextWithVision_({
    getBlob: () => ({ getBytes: () => [1, 2, 3] }),
  });

  assert.equal(
    urls[0],
    "https://us-vision.googleapis.com/v1/projects/project-123/locations/us/files:annotate",
  );
});

test("routes doPost to OCR by default and Gemini only for explicit mode", async () => {
  const context = await loadHelpers();
  const calls = [];
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (key === "APPS_SCRIPT_SHARED_SECRET" ? "test-secret" : null),
    }),
  };
  context.ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput: (value) => ({
      value,
      setMimeType() { return this; },
    }),
  };
  context.processDriveFile = (fileId) => {
    calls.push(["ocr", fileId]);
    return { status: "ready", source: "drive-ocr" };
  };
  context.processDriveFileWithGemini = (fileId) => {
    calls.push(["gemini", fileId]);
    return { status: "ready", source: "gemini" };
  };

  const run = (payload) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(payload) } }).value);

  assert.equal(run({ fileId: "ocr-file", token: "test-secret" }).result.source, "drive-ocr");
  assert.equal(run({ fileId: "gemini-file", mode: "gemini", token: "test-secret" }).result.source, "gemini");
  assert.equal(run({ fileId: "bad-mode", mode: "other", token: "test-secret" }).ok, false);
  assert.deepEqual(calls, [["ocr", "ocr-file"], ["gemini", "gemini-file"]]);
});

test("does not throw when the spreadsheet menu hook runs without a UI context", async () => {
  const context = await loadHelpers();

  assert.doesNotThrow(() => context.onSpreadsheetOpen());
});

test("marks an OCR order with drive-ocr source and review when fields are missing", async () => {
  const context = await loadHelpers();
  const order = context.buildOcrOrder_(
    "fallback.pdf",
    "https://drive/file",
    "Shopee\nCustomer: Mali",
  );

  assert.equal(order.source, "drive-ocr");
  assert.equal(order.status, "incomplete");
  assert.ok(order.missingFields.includes("orderId"));
});

test("returns an incomplete OCR shipping-label candidate instead of guessing missing values", async () => {
  const context = await loadHelpers();
  const labels = context.buildOcrShippingLabels_(
    "fallback.pdf",
    "https://drive/file",
    "Shopee",
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].source, "drive-ocr");
  assert.equal(labels[0].status, "incomplete");
});

test("exports incomplete OCR labels with blanks and a clear incomplete status", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("incomplete.pdf", [
    {
      marketplace: "TikTok Shop",
      recipientName: "",
      shippingAddress: "Bangkok 10120",
      orderId: "",
      trackingNumber: "JTTH201622437590",
    },
  ]);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].status, "incomplete");
  assert.equal(labels[0].recipientName, "");
  assert.equal(labels[0].orderId, "");
  assert.deepEqual(Array.from(labels[0].reviewReasons), ["recipientName", "orderId"]);
});

test("parses OCR order fields for Shopee, Lazada, and TikTok Shop", async () => {
  const context = await loadHelpers();
  const fixtures = [
    [
      "Shopee",
      "Shopee\nRecipient: Mali Demo\nOrder No.: SP-1001\nTracking: TH1001\nAddress: Bangkok 10110",
    ],
    [
      "Lazada",
      "Lazada\nReceiver: Arun Demo\nLAZADA Order Number: LZD-1001\nTracking: LEXTH1001\nAddress: Chiang Mai 50000",
    ],
    [
      "TikTok Shop",
      "TikTok Shop\nTo: Ploy Demo\nOrder ID: TTS-1001\nTracking: JTTH1001\nAddress: Phuket 83000",
    ],
  ];

  fixtures.forEach(([marketplace, text]) => {
    const order = context.parseOcrOrder_(marketplace, text);
    assert.equal(order.marketplace, marketplace);
    assert.ok(order.orderId);
    assert.ok(order.customerName);
    assert.ok(order.address);
  });
});

test("parses OCR shipping-label fields into a review-safe label", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "lazada.pdf",
    "Lazada\nReceiver: Arun Demo\nLAZADA Order Number: LZD-1001\nTracking: LEXTH1001\nAddress: Chiang Mai 50000",
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].marketplace, "Lazada");
  assert.equal(labels[0].recipientName, "Arun Demo");
  assert.equal(labels[0].orderId, "LZD-1001");
  assert.equal(labels[0].trackingNumber, "LEXTH1001");
  assert.equal(labels[0].shippingAddress, "Chiang Mai 50000");
  assert.equal(labels[0].status, "ready");
});

test("parses a Lazada LEX OCR layout with inline customer and address fields", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "2 lazada.pdf",
    [
      "LEXUP0702650797",
      "Order No.: 1117718175852180",
      "Customer NAME: Arun Demo",
      "ADDRESS: 73/1 Moo 13, Ban Pong, Ratchaburi 70110",
      "Phone number: 660****067",
      "Lazada",
    ].join("\n"),
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].marketplace, "Lazada");
  assert.equal(labels[0].recipientName, "Arun Demo");
  assert.equal(labels[0].shippingAddress, "73/1 Moo 13, Ban Pong, Ratchaburi 70110");
  assert.equal(labels[0].orderId, "1117718175852180");
  assert.equal(labels[0].trackingNumber, "LEXUP0702650797");
  assert.equal(labels[0].status, "ready");
});

test("joins a Lazada barcode value when OCR splits the tracking text", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "2 lazada.pdf",
    [
      "LEX",
      "UP0702650797",
      "Order No.: 1117718175852180",
      "Customer NAME: Arun Demo",
      "ADDRESS: 73/1 Moo 13, Ban Pong, Ratchaburi 70110",
      "Lazada",
    ].join("\n"),
  );

  assert.equal(labels[0].trackingNumber, "LEXUP0702650797");
  assert.equal(labels[0].status, "ready");
});

test("parses TikTok J&T OCR from a file-name marketplace hint", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "Tik Tok - 4.pdf",
    [
      "JTTH201180179874",
      "Order ID: 585247221484193247",
      "42 ม 2 ตำบล ขามสมบูรณ์",
      "คง นครราชสีมา",
      "30260",
      "ปวีณา หาญสันเทียะ",
      "30-07-2026",
    ].join("\n"),
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].marketplace, "TikTok Shop");
  assert.equal(labels[0].recipientName, "ปวีณา หาญสันเทียะ");
  assert.match(labels[0].shippingAddress, /30260/);
  assert.equal(labels[0].orderId, "585247221484193247");
  assert.equal(labels[0].trackingNumber, "JTTH201180179874");
  assert.equal(labels[0].status, "ready");
});

test("parses a TikTok recipient printed after ถึง before the postal code", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "Tik Tok - 2.pdf",
    [
      "JTTH201967972485",
      "จาก",
      "บริษัท ฮิลล์คอฟฟ์ จำกัด",
      "ถึง วีระชัย คำสุขดี",
      "(+66)08******98",
      "18 หมู่ 7 ต.ทับพริก บ้านคลองหว้า",
      "อรัญประเทศ, สระแก้ว",
      "27120",
      "Shipping Date: 30-07-2026",
      "Order ID: 585276871493452817",
    ].join("\n"),
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].recipientName, "วีระชัย คำสุขดี");
  assert.match(labels[0].shippingAddress, /18 หมู่ 7/);
  assert.match(labels[0].shippingAddress, /27120/);
  assert.doesNotMatch(labels[0].shippingAddress, /วีระชัย|ฮิลล์คอฟฟ์|JTTH/);
  assert.equal(labels[0].orderId, "585276871493452817");
  assert.equal(labels[0].trackingNumber, "JTTH201967972485");
  assert.equal(labels[0].status, "ready");
});

test("parses every recipient from a multi-label TikTok J&T OCR page", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "Tik Tok - 1.pdf",
    [
      "V",
      "21 Moo 12 Chaloem Phra Kiat, Nakhon Ratchasima 30230",
      "JTTH201061537596",
      "From Hillkoff ถึง",
      "(+66)09******99",
      "Order ID: 585283162771720012 Estimated Date:",
      "JTTH201061537596 30230",
      "Rattana",
      "Shipping Date: 31-07-2026",
      "Qty Total: 1 Order ID: 585283162771720012",
      "V",
      "August Condo 41 Charoenkrung 80, Bangkok 10120",
      "JTTH201622437590",
      "From Hillkoff ถึง",
      "(+66)93*****34",
      "Order ID: 585284651433821511 Estimated Date:",
      "JTTH201622437590 10120",
      "Pailin",
      "Shipping Date: 31-07-2026",
      "Qty Total: 1 Order ID: 585284651433821511",
    ].join("\n"),
  );

  assert.equal(labels.length, 2);
  assert.equal(JSON.stringify(labels.map((label) => label.recipientName)), JSON.stringify(["Rattana", "Pailin"]));
  assert.equal(JSON.stringify(labels.map((label) => label.shippingAddress)), JSON.stringify([
    "21 Moo 12 Chaloem Phra Kiat, Nakhon Ratchasima 30230",
    "August Condo 41 Charoenkrung 80, Bangkok 10120",
  ]));
  assert.equal(JSON.stringify(labels.map((label) => label.orderId)), JSON.stringify([
    "585283162771720012",
    "585284651433821511",
  ]));
  assert.equal(JSON.stringify(labels.map((label) => label.trackingNumber)), JSON.stringify([
    "JTTH201061537596",
    "JTTH201622437590",
  ]));
  assert.equal(labels.every((label) => label.status === "ready"), true);
});

test("prefers the TikTok tracking-and-postal marker over an earlier postal code", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "Tik Tok - 1.pdf",
    [
      "JTTH201061537596",
      "30230",
      "(+66)09******99",
      "JTTH201061537596 30230",
      "Rattana",
      "Shipping Date: 31-07-2026",
      "Order ID: 585283162771720012",
      "JTTH201622437590",
      "10120",
      "(+66)93*****34",
      "JTTH201622437590 10120",
      "Pailin",
      "Shipping Date: 31-07-2026",
      "Order ID: 585284651433821511",
    ].join("\n"),
  );

  assert.equal(labels.length, 2);
  assert.equal(labels[0].recipientName, "Rattana");
  assert.equal(labels[1].recipientName, "Pailin");
  assert.equal(labels.some((label) => /^\(\+66\)/.test(label.recipientName)), false);
});

test("exports incomplete multi-label TikTok OCR results with blanks", async () => {
  const context = await loadHelpers();
  const labels = context.buildOcrShippingLabels_(
    "Tik Tok - 2.pdf",
    "https://drive/tiktok-two",
    [
      "JTTH201180179874",
      "Order ID: 585247221484193247",
      "30260",
      "ปวีณา หาญสันเทียะ",
      "JTTH201180179875",
      "Order ID: 585247221484193248",
    ].join("\n"),
  );

  assert.equal(labels.length, 2);
  assert.equal(labels[0].status, "incomplete");
  assert.equal(labels[1].status, "incomplete");
  assert.equal(labels[1].recipientName, "");
  assert.ok(labels[1].reviewReasons.includes("recipientName"));
});

test("clears punctuation, phone numbers, and route codes from TikTok recipient names", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("Tik Tok - 1.pdf", [
    {
      marketplace: "TikTok Shop",
      recipientName: ",",
      shippingAddress: "Bangkok 10120",
      orderId: "585284651433821511",
      trackingNumber: "JTTH201622437590",
    },
    {
      marketplace: "TikTok Shop",
      recipientName: "(+66)09******99",
      shippingAddress: "Bangkok 10120",
      orderId: "585284651433821512",
      trackingNumber: "JTTH201622437591",
    },
    {
      marketplace: "TikTok Shop",
      recipientName: "001A",
      shippingAddress: "Bangkok 10120",
      orderId: "585284651433821513",
      trackingNumber: "JTTH201622437592",
    },
    {
      marketplace: "TikTok Shop",
      recipientName: "JTTH201622437590 จาก H",
      shippingAddress: "Bangkok 10120",
      orderId: "585284651433821514",
      trackingNumber: "JTTH201622437593",
    },
  ]);

  assert.equal(labels.every((label) => label.status === "incomplete"), true);
  assert.equal(labels.every((label) => label.recipientName === ""), true);
  assert.equal(labels.every((label) => label.reviewReasons.includes("recipientName")), true);
});

test("accepts OCR text without marketplace branding when the PDF filename identifies TikTok", async () => {
  const context = await loadHelpers();

  assert.equal(
    context.isUsefulDriveOcrText_(
      "Order ID: 585247221484193247\nJTTH201180179874\nปวีณา หาญสันเทียะ",
      "Tik Tok - 4.pdf",
    ),
    true,
  );
});

test("uses the barcode reader before Vision OCR and Document AI", async () => {
  const context = await loadHelpers();
  let visionCalls = 0;
  let documentAiCalls = 0;
  const file = {
    getName: () => "2 lazada.pdf",
    getUrl: () => "https://drive/lazada",
  };
  const text = [
    "Lazada",
    "Order No.: 1117718175852180",
    "Customer NAME: Arun Demo",
    "ADDRESS: 73/1 Moo 13, Ban Pong, Ratchaburi 70110",
  ].join("\n");
  const labels = context.buildOcrShippingLabels_(file.getName(), file.getUrl(), text);

  context.extractBarcodesWithVision_ = () => ({ barcodes: ["LEXUP0702650797"] });
  context.extractTextWithVision_ = () => {
    visionCalls += 1;
    return { text: "should not be called", barcodes: [] };
  };
  context.extractTextWithDocumentAi_ = () => {
    documentAiCalls += 1;
    return { text: "should not be called", barcodes: [] };
  };

  const result = context.enrichOcrWithCloudReaders_(file, text, labels);

  assert.equal(result.used, true);
  assert.equal(result.labels[0].trackingNumber, "LEXUP0702650797");
  assert.equal(result.labels[0].status, "ready");
  assert.equal(visionCalls, 0);
  assert.equal(documentAiCalls, 0);
});

test("uses a complete OCR reader result without concatenating multi-label layouts", async () => {
  const context = await loadHelpers();
  const file = {
    getName: () => "Tik Tok - 1.pdf",
    getUrl: () => "https://drive/tiktok",
  };
  const driveText = [
    "JTTH201061537596",
    "Order ID: 585283162771720012",
  ].join("\n");
  const visionText = [
    "V",
    "21 Moo 12 Chaloem Phra Kiat 30230",
    "JTTH201061537596",
    "JTTH201061537596 30230",
    "Rattana",
    "Shipping Date: 31-07-2026",
    "Order ID: 585283162771720012",
    "V",
    "August Condo Bangkok 10120",
    "JTTH201622437590",
    "JTTH201622437590 10120",
    "Pailin",
    "Shipping Date: 31-07-2026",
    "Order ID: 585284651433821511",
  ].join("\n");
  const labels = context.buildOcrShippingLabels_(file.getName(), file.getUrl(), driveText);

  context.extractBarcodesWithVision_ = () => ({ text: "", barcodes: [] });
  context.extractTextWithVision_ = () => ({ text: visionText, barcodes: [] });
  context.extractTextWithDocumentAi_ = () => ({ text: "", barcodes: [] });

  const result = context.enrichOcrWithCloudReaders_(file, driveText, labels);

  assert.equal(result.used, true);
  assert.equal(result.text, visionText);
  assert.equal(result.labels.length, 2);
  assert.equal(result.labels.every((label) => label.status === "ready"), true);
  assert.equal(result.labels[0].recipientName, "Rattana");
  assert.equal(result.labels[1].recipientName, "Pailin");
});

test("splits Google Vision TikTok paragraphs by their left and right page positions", async () => {
  const context = await loadHelpers();
  const paragraph = (text, x, y) => ({
    boundingBox: {
      vertices: [{ x, y }, { x: x + 80, y }, { x: x + 80, y: y + 20 }, { x, y: y + 20 }],
    },
    words: text.split(" ").map((word) => ({
      symbols: [...word].map((symbol) => ({ text: symbol })),
    })),
  });
  const response = {
    responses: [{
      responses: [{
        fullTextAnnotation: {
          pages: [{
            width: 1000,
            blocks: [{
              paragraphs: [
                paragraph("21 Moo 12 30230", 80, 80),
                paragraph("JTTH201061537596", 80, 140),
                paragraph("Order ID: 585283162771720012", 80, 200),
                paragraph("JTTH201061537596 30230", 80, 260),
                paragraph("Rattana", 80, 300),
                paragraph("August Condo 10120", 620, 80),
                paragraph("JTTH201622437590", 620, 140),
                paragraph("Order ID: 585284651433821511", 620, 200),
                paragraph("JTTH201622437590 10120", 620, 260),
                paragraph("Pailin", 620, 300),
              ],
            }],
          }],
        },
      }],
    }],
  };

  const blocks = context.collectVisionLayoutLabelTexts_(response);
  const labels = context.parseTikTokVisionLayoutLabels_("Tik Tok - 1.pdf", blocks);

  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /Rattana/);
  assert.match(blocks[1], /Pailin/);
  assert.equal(labels.length, 2);
  assert.equal(labels[0].recipientName, "Rattana");
  assert.equal(labels[1].recipientName, "Pailin");
  assert.equal(labels.every((label) => label.status === "ready"), true);
});

test("splits Google Vision columns when the page width is omitted", async () => {
  const context = await loadHelpers();
  const paragraph = (text, x, y) => ({
    boundingBox: {
      vertices: [{ x, y }, { x: x + 50, y }, { x: x + 50, y: y + 20 }, { x, y: y + 20 }],
    },
    words: text.split(" ").map((word) => ({
      symbols: [...word].map((symbol) => ({ text: symbol })),
    })),
  });
  const response = {
    responses: [{
      responses: [{
        fullTextAnnotation: {
          pages: [{
            blocks: [{
              paragraphs: [
                paragraph("JTTH201061537596", 40, 100),
                paragraph("Rattana", 40, 160),
                paragraph("JTTH201622437590", 640, 100),
                paragraph("Pailin", 640, 160),
              ],
            }],
          }],
        },
      }],
    }],
  };

  const blocks = context.collectVisionLayoutLabelTexts_(response);

  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /Rattana/);
  assert.match(blocks[1], /Pailin/);
});

test("splits interleaved Google Vision words using their individual positions", async () => {
  const context = await loadHelpers();
  const word = (text, x, y) => ({
    boundingBox: {
      vertices: [{ x, y }, { x: x + 70, y }, { x: x + 70, y: y + 20 }, { x, y: y + 20 }],
    },
    symbols: [...text].map((symbol) => ({ text: symbol })),
  });
  const response = {
    responses: [{
      responses: [{
        fullTextAnnotation: {
          pages: [{
            blocks: [{
              paragraphs: [{
                boundingBox: {
                  vertices: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 400 }, { x: 0, y: 400 }],
                },
                words: [
                  word("JTTH201061537596", 60, 100),
                  word("JTTH201622437590", 660, 100),
                  word("Rattana", 60, 160),
                  word("Pailin", 660, 160),
                ],
              }],
            }],
          }],
        },
      }],
    }],
  };

  const blocks = context.collectVisionLayoutLabelTexts_(response);

  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /JTTH201061537596/);
  assert.match(blocks[0], /Rattana/);
  assert.match(blocks[1], /JTTH201622437590/);
  assert.match(blocks[1], /Pailin/);
});

test("uses normalized Vision coordinates even when the page width is present", async () => {
  const context = await loadHelpers();
  const word = (text, x, y) => ({
    boundingBox: {
      normalizedVertices: [{ x, y }, { x: x + 0.05, y }, { x: x + 0.05, y: y + 0.02 }, { x, y: y + 0.02 }],
    },
    symbols: [...text].map((symbol) => ({ text: symbol })),
  });
  const response = {
    responses: [{
      responses: [{
        fullTextAnnotation: {
          pages: [{
            width: 595,
            blocks: [{
              paragraphs: [{
                words: [
                  word("JTTH201061537596", 0.08, 0.10),
                  word("JTTH201622437590", 0.62, 0.10),
                  word("Rattana", 0.08, 0.16),
                  word("Pailin", 0.62, 0.16),
                ],
              }],
            }],
          }],
        },
      }],
    }],
  };

  const blocks = context.collectVisionLayoutLabelTexts_(response);

  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /Rattana/);
  assert.match(blocks[1], /Pailin/);
});

test("extracts TikTok fields from a positioned Vision label column", async () => {
  const context = await loadHelpers();
  const item = (text, x, y) => ({ text, x, y, height: 0.02, normalized: true });
  const labels = context.parseTikTokVisionLayoutColumns_("Tik Tok - 1.pdf", [{
    items: [
      item("JTTH201061537596", 0.02, 0.12),
      item("ถึง", 0.04, 0.34),
      item("ร", 0.07, 0.34),
      item("ต", 0.08, 0.34),
      item("นา", 0.10, 0.34),
      item("+66", 0.07, 0.38),
      item("21", 0.04, 0.43),
      item("หมู่", 0.08, 0.43),
      item("12", 0.13, 0.43),
      item("ต.", 0.16, 0.43),
      item("พระพุทธ", 0.19, 0.43),
      item("เฉลิมพระเกียรติ", 0.08, 0.46),
      item("นครราชสีมา", 0.08, 0.49),
      item("30230", 0.08, 0.52),
      item("585283162771720012", 0.10, 0.72),
    ],
    text: "unused",
  }]);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].recipientName, "ร ต นา");
  assert.match(labels[0].shippingAddress, /21 หมู่ 12/);
  assert.match(labels[0].shippingAddress, /30230/);
  assert.equal(labels[0].orderId, "585283162771720012");
  assert.equal(labels[0].trackingNumber, "JTTH201061537596");
  assert.equal(labels[0].status, "ready");
});

test("prefers Google Vision layout labels over interleaved TikTok OCR text", async () => {
  const context = await loadHelpers();
  const file = {
    getName: () => "Tik Tok - 1.pdf",
    getUrl: () => "https://drive/tiktok",
  };
  const driveText = "JTTH201061537596\nOrder ID: 585283162771720012";
  const layoutTexts = [
    [
      "21 Moo 12 30230",
      "JTTH201061537596",
      "Order ID: 585283162771720012",
      "JTTH201061537596 30230",
      "Rattana",
    ].join("\n"),
    [
      "August Condo 10120",
      "JTTH201622437590",
      "Order ID: 585284651433821511",
      "JTTH201622437590 10120",
      "Pailin",
    ].join("\n"),
  ];
  const labels = context.buildOcrShippingLabels_(file.getName(), file.getUrl(), driveText);

  context.extractBarcodesWithVision_ = () => ({ text: "", barcodes: [] });
  context.extractTextWithVision_ = () => ({
    text: "interleaved and unusable text",
    barcodes: [],
    layoutTexts,
  });
  context.extractTextWithDocumentAi_ = () => ({ text: "", barcodes: [] });

  const result = context.enrichOcrWithCloudReaders_(file, driveText, labels);

  assert.equal(result.labels.length, 2);
  assert.equal(result.labels.every((label) => label.status === "ready"), true);
  assert.equal(result.labels[0].recipientName, "Rattana");
  assert.equal(result.labels[1].recipientName, "Pailin");
});

test("reads Document AI text and detected barcode values", async () => {
  const context = await loadHelpers();
  let requestUrl = "";
  let requestPayload = "";
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => key === "DOCUMENT_AI_PROCESSOR_NAME"
        ? "projects/demo/locations/asia-southeast1/processors/processor"
        : "",
    }),
  };
  context.ScriptApp = { getOAuthToken: () => "oauth-token" };
  context.Utilities = { base64Encode: () => "encoded-pdf" };
  context.UrlFetchApp = {
    fetch: (url, options) => {
      requestUrl = url;
      requestPayload = options.payload;
      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          document: {
            text: "Lazada\nOrder No.: 1117718175852180",
            pages: [{ detectedBarcodes: [{ barcode: { rawValue: "LEXUP0702650797" } }] }],
          },
        }),
      };
    },
  };

  const result = context.extractTextWithDocumentAi_({
    getBlob: () => ({ getBytes: () => [1, 2, 3] }),
  });

  assert.match(requestUrl, /documentai\.googleapis\.com\/v1\/projects\/demo/);
  assert.deepEqual(JSON.parse(requestPayload).rawDocument, {
    content: "encoded-pdf",
    mimeType: "application/pdf",
  });
  assert.match(result.text, /Order No\./);
  assert.deepEqual(Array.from(result.barcodes), ["LEXUP0702650797"]);
});

test("normalizes a full Document AI processor URL", async () => {
  const context = await loadHelpers();

  assert.equal(
    context.buildDocumentAiProcessUrl_(
      "https://us-documentai.googleapis.com/v1/projects/633651394402/locations/us/processors/81f3c0e27bfad96a:process",
    ),
    "https://us-documentai.googleapis.com/v1/projects/633651394402/locations/us/processors/81f3c0e27bfad96a:process",
  );
  assert.equal(
    context.buildDocumentAiProcessUrl_(
      "projects/633651394402/locations/us/processors/81f3c0e27bfad96a",
    ),
    "https://documentai.googleapis.com/v1/projects/633651394402/locations/us/processors/81f3c0e27bfad96a:process",
  );
});

test("parses four Shopee SPX labels from a two-column PDF OCR reading", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "22.pdf",
    [
      "Shopee TH269321699657I ผู้รับ (TO) Mali One\nเลขที่ 1 ถนนเชียงใหม่ จังหวัดเชียงใหม่ 50000\nผู้ส่ง (FROM) HILLKOFF\nShopee Order No. 2607302AAA111",
      "Shopee TH263542846574F ผู้รับ (TO) Mali Two\nร้านกาแฟ จังหวัดศรีสะเกษ 33270\nผู้ส่ง (FROM) HILLKOFF\nShopee Order No. 2607302BBB222",
      "Shopee TH265776755066F ผู้รับ (TO) Mali Three\n319/241 จังหวัดนนทบุรี 11000\nผู้ส่ง (FROM) HILLKOFF\nShopee Order No. 2607302CCC333",
      "Shopee TH263678467407E ผู้รับ (TO) Mali Four\n45/316 กรุงเทพมหานคร 10240\nผู้ส่ง (FROM) HILLKOFF\nShopee Order No. 2607302DDD444",
      "Shopee Order No. 2607302AAA111 Shopee Order No. 2607302BBB222",
    ].join("\n"),
  );

  assert.equal(labels.length, 4);
  assert.deepEqual(Array.from(labels, (label) => label.orderId), [
    "2607302AAA111",
    "2607302BBB222",
    "2607302CCC333",
    "2607302DDD444",
  ]);
  assert.deepEqual(Array.from(labels, (label) => label.trackingNumber), [
    "TH269321699657I",
    "TH263542846574F",
    "TH265776755066F",
    "TH263678467407E",
  ]);
  assert.equal(labels.every((label) => label.status === "ready"), true);
});

test("normalizes Shopee Thai private-use glyphs from PDF text extraction", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "22.pdf",
    "Shopee TH269321699657I ผ\uF70Bูรับ (TO) Mali One\nเลขที่ 1 เชียงใหม่ 50000\nผ\uF70Bูส่ง (FROM) HILLKOFF\nShopee Order No. 2607302AAA111",
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].recipientName, "Mali One");
  assert.equal(labels[0].orderId, "2607302AAA111");
  assert.equal(labels[0].trackingNumber, "TH269321699657I");
  assert.equal(labels[0].status, "ready");
});

test("uses the Shopee recipient address block before the tracking barcode", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "shopee-address.pdf",
    "ASTAT-AG - Sri That\n131/10 Recipient Road, Udon Thani 41230\nG-1\nTH269321699657I\nShopee Order No. 2607302AAA111\nผู้รับ (TO)\nMali One\nผู้ส่ง (FROM)\n66 Sender Road, Chiang Mai 50200",
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].shippingAddress, "131/10 Recipient Road, Udon Thani 41230");
});

test("moves a complete OCR shipping-label PDF to Processed without a legacy order row", async () => {
  const context = await loadHelpers();
  let movedToProcessed = false;
  let orderWrites = 0;
  const file = {
    getId: () => "shopee-spx-id",
    getName: () => "22.pdf",
    getUrl: () => "https://drive/22",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractTextWithDriveOcr_ = () =>
    "Route - City\n131/10 Recipient Road, Udon Thani 41230\nG-1\nTH269321699657I\nShopee Order No. 2607302AAA111\nผู้รับ (TO)\nMali One\nผู้ส่ง (FROM)\n66 Sender Road, Chiang Mai 50200";
  context.writeShippingLabels_ = () => ({ inserted: 1 });
  context.writeOrderResult_ = () => { orderWrites += 1; };
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => { movedToProcessed = true; };
  context.moveToReview = () => { throw new Error("should not move complete labels to review"); };

  const result = context.processDriveFile("shopee-spx-id");

  assert.equal(result.status, "ready");
  assert.equal(result.shippingLabelsExported, 1);
  assert.equal(movedToProcessed, true);
  assert.equal(orderWrites, 0);
});

test("moves a complete OCR PDF even when every label was already imported", async () => {
  const context = await loadHelpers();
  let movedToProcessed = false;
  let movedToReview = false;
  const file = {
    getId: () => "already-imported-id",
    getName: () => "already-imported.pdf",
    getUrl: () => "https://drive/already-imported",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractTextWithDriveOcr_ = () =>
    "Route - City\n131/10 Recipient Road, Udon Thani 41230\nG-1\nTH269321699657I\nShopee Order No. 2607302AAA111\nผู้รับ (TO)\nMali One\nผู้ส่ง (FROM)\n66 Sender Road, Chiang Mai 50200";
  context.writeShippingLabels_ = () => ({ inserted: 0 });
  context.writeOrderResult_ = () => {};
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => { movedToProcessed = true; };
  context.moveToReview = () => { movedToReview = true; };

  const result = context.processDriveFile("already-imported-id");

  assert.equal(result.status, "ready");
  assert.equal(result.shippingLabelsExported, 0);
  assert.equal(movedToProcessed, true);
  assert.equal(movedToReview, false);
});

test("keeps the PDF available for retry when Drive OCR fails", async () => {
  const context = await loadHelpers();
  let movedToProcessed = false;
  let movedToReview = false;
  const file = {
    getId: () => "ocr-failure-id",
    getName: () => "22.pdf",
    getUrl: () => "https://drive/22",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractTextWithDriveOcr_ = () => {
    throw context.createProcessingError_("DriveOcrError", "OCR conversion failed", true);
  };
  context.moveToReview = () => {
    movedToReview = true;
  };
  context.moveToProcessed = () => {
    movedToProcessed = true;
  };

  const result = context.processDriveFile("ocr-failure-id");

  assert.equal(result.status, "failed");
  assert.equal(result.retryable, true);
  assert.equal(result.source, "drive-ocr");
  assert.equal(movedToProcessed, false);
  assert.equal(movedToReview, false);
});

test("moves an incomplete OCR PDF to Processed after exporting blank fields", async () => {
  const context = await loadHelpers();
  let movedToProcessed = false;
  let movedToReview = false;
  const file = {
    getName: () => "incomplete.pdf",
    getUrl: () => "https://drive/incomplete",
  };
  const order = context.buildOcrOrder_(
    "incomplete.pdf",
    "https://drive/incomplete",
    "Shopee\nCustomer: Mali",
  );

  context.isDuplicateOrder = () => false;
  context.writeOrderResult_ = () => {};
  context.moveToProcessed = () => { movedToProcessed = true; };
  context.moveToReview = () => { movedToReview = true; };

  const result = context.finalizeOrderResult_(order, file, 1, false);

  assert.equal(result.status, "ready");
  assert.equal(movedToProcessed, true);
  assert.equal(movedToReview, false);
});

test("runs the batch Gemini option against the main Input folder", async () => {
  const context = await loadHelpers();
  const locations = [];
  context.SpreadsheetApp = {
    openById: () => ({ toast: () => {} }),
  };
  context.listPdfFiles_ = (_folderId, location) => {
    locations.push(location);
    return [];
  };

  context.refreshWithGemini();

  assert.deepEqual(locations, ["input"]);
});

test("uses Drive OCR once without calling Gemini when quota is exhausted", async () => {
  const context = await loadHelpers();
  let ocrCalls = 0;
  let movedToProcessed = false;
  const file = {
    getId: () => "fixture-id",
    getName: () => "fallback.pdf",
    getUrl: () => "https://drive/file",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractShippingLabelsWithGemini_ = () => {
    throw context.createProcessingError_("GeminiQuotaError", "quota exceeded", true);
  };
  context.extractOrderWithGemini_ = () => {
    throw context.createProcessingError_("GeminiQuotaError", "quota exceeded", true);
  };
  context.extractTextWithDriveOcr_ = () => {
    ocrCalls += 1;
    return "Shopee\nRecipient: Mali Demo\nOrder No.: SP-1001\nTracking: TH1001\nAddress: Bangkok 10110";
  };
  context.writeShippingLabels_ = () => ({ inserted: 1 });
  context.writeOrderResult_ = () => {};
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => {
    movedToProcessed = true;
  };
  context.moveToReview = () => {};

  const result = context.processDriveFile("fixture-id");

  assert.equal(ocrCalls, 1);
  assert.equal(result.source, "drive-ocr");
  assert.equal(movedToProcessed, true);
});

test("trashes the temporary OCR document even when OCR text reading fails", async () => {
  const context = await loadHelpers();
  const copyOptions = [];
  let trashed = 0;

  context.MimeType = { GOOGLE_DOCS: "application/vnd.google-apps.document" };
  context.Drive = {
    Files: {
      insert: (resource, blob, options) => {
        copyOptions.push({ resource, blob, options });
        return { id: `ocr-doc-id-${copyOptions.length}` };
      },
    },
  };
  context.DocumentApp = {
    openById: () => {
      throw new Error("OCR read failed");
    },
  };
  context.DriveApp = {
    getFileById: () => ({
      setTrashed: () => {
        trashed += 1;
      },
    }),
  };

  let caught;
  try {
    context.extractTextWithDriveOcr_({
      getName: () => "fallback.pdf",
      getId: () => "pdf-id",
      getBlob: () => "pdf-blob",
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught.name, "DriveOcrError");
  assert.equal(caught.retryable, true);
  assert.equal(trashed, 2);
  assert.equal(copyOptions.length, 2);
  assert.equal(copyOptions[0].options.ocr, true);
  assert.equal(copyOptions[0].options.ocrLanguage, "th");
  assert.equal(copyOptions[1].options.ocrLanguage, "en");
});

test("uses Drive API v3 Files.create when the advanced service exposes it", async () => {
  const context = await loadHelpers();
  let request;
  context.MimeType = { GOOGLE_DOCS: "application/vnd.google-apps.document" };
  context.Drive = {
    Files: {
      create: (resource, blob, options) => {
        request = { resource, blob, options };
        return { id: "ocr-v3-doc-id" };
      },
    },
  };

  const result = context.createDriveOcrDocument_(
    { getName: () => "lazada.pdf", getBlob: () => "pdf-blob" },
    "th",
  );

  assert.equal(result.id, "ocr-v3-doc-id");
  assert.equal(request.resource.name, "OCR-lazada.pdf");
  assert.equal(request.resource.mimeType, "application/vnd.google-apps.document");
  assert.equal(request.blob, "pdf-blob");
  assert.equal(request.options.ocr, true);
  assert.equal(request.options.ocrLanguage, "th");
  assert.equal(request.options.fields, "id");
});

test("uses readable OCR shipping labels without calling Gemini", async () => {
  const context = await loadHelpers();
  let ocrCalls = 0;
  let shippingGeminiCalls = 0;
  let orderGeminiCalls = 0;
  let writtenLabels = [];
  const file = {
    getId: () => "ocr-first-id",
    getName: () => "ocr-first.pdf",
    getUrl: () => "https://drive/ocr-first",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractTextWithDriveOcr_ = () => {
    ocrCalls += 1;
    return "Shopee\nRecipient: Mali Demo\nOrder No.: SP-1001\nTracking: TH1001\nAddress: Bangkok 10110";
  };
  context.extractShippingLabelsWithGemini_ = () => {
    shippingGeminiCalls += 1;
    return [];
  };
  context.extractOrderWithGemini_ = () => {
    orderGeminiCalls += 1;
    return context.normalizeGeminiOrder_({
      marketplace: "shopee",
      orderId: "SP-1001",
      customerName: "Mali Demo",
      items: [{ name: "Coffee", quantity: 1 }],
      quantity: 1,
      address: "Bangkok 10110",
      total: 100,
      confidence: 90,
      missingFields: [],
      rawNotes: "",
    });
  };
  context.writeShippingLabels_ = (labels) => {
    writtenLabels = labels;
    return { inserted: labels.length };
  };
  context.writeOrderResult_ = () => {};
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => {};
  context.moveToReview = () => {};

  context.processDriveFile("ocr-first-id");

  assert.equal(ocrCalls, 1);
  assert.equal(shippingGeminiCalls, 0);
  assert.equal(orderGeminiCalls, 0);
  assert.equal(writtenLabels[0].source, "drive-ocr");
});

test("calls Gemini only when the explicit Gemini mode is selected", async () => {
  const context = await loadHelpers();
  let shippingGeminiCalls = 0;
  let orderGeminiCalls = 0;
  const file = {
    getId: () => "ocr-incomplete-id",
    getName: () => "ocr-incomplete.pdf",
    getUrl: () => "https://drive/ocr-incomplete",
  };

  context.DriveApp = { getFileById: () => file };
  context.extractTextWithDriveOcr_ = () => "Shopee";
  context.extractShippingLabelsWithGemini_ = () => {
    shippingGeminiCalls += 1;
    return [
      {
        marketplace: "shopee",
        recipientName: "Mali Demo",
        shippingAddress: "Bangkok 10110",
        orderId: "SP-1001",
        trackingNumber: "TH1001",
      },
    ];
  };
  context.extractOrderWithGemini_ = () => {
    orderGeminiCalls += 1;
    return context.normalizeGeminiOrder_({
      marketplace: "shopee",
      orderId: "SP-1001",
      customerName: "Mali Demo",
      items: [{ name: "Coffee", quantity: 1 }],
      quantity: 1,
      address: "Bangkok 10110",
      total: 100,
      confidence: 90,
      missingFields: [],
      rawNotes: "",
    });
  };
  context.writeShippingLabels_ = () => ({ inserted: 1 });
  context.writeOrderResult_ = () => {};
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => {};
  context.moveToReview = () => {};

  context.moveToProcessed = () => {};
  context.processDriveFile("ocr-incomplete-id");

  assert.equal(shippingGeminiCalls, 0);
  assert.equal(orderGeminiCalls, 0);

  context.processDriveFileWithGemini("ocr-incomplete-id");

  assert.equal(shippingGeminiCalls, 1);
  assert.equal(orderGeminiCalls, 1);
});

test("hides only older dated shipping-label sheets", async () => {
  const context = await loadHelpers();
  const hidden = [];
  const sheets = [
    { getName: () => "2026-07-28", hideSheet: () => hidden.push("2026-07-28") },
    { getName: () => "2026-07-29", hideSheet: () => hidden.push("2026-07-29") },
    { getName: () => "2026-07-30", hideSheet: () => hidden.push("2026-07-30") },
    { getName: () => "Orders", hideSheet: () => hidden.push("Orders") },
  ];

  context.hideOlderShippingLabelSheets_({ getSheets: () => sheets }, "2026-07-29");

  assert.deepEqual(hidden, ["2026-07-28"]);
});

test("normalizes a complete Gemini extraction before classifying it", async () => {
  const context = await loadHelpers();
  const order = context.normalizeGeminiOrder_({
    marketplace: "lazada",
    orderId: "LZD-2002",
    customerName: "Arun",
    items: [{ name: "Charger", quantity: 1 }],
    quantity: 1,
    address: "Chiang Mai",
    total: 299,
    confidence: 82,
    missingFields: [],
    rawNotes: "",
  });

  assert.equal(order.marketplace, "Lazada");
  assert.equal(order.source, "gemini");
  assert.equal(context.classifyGeminiOrder_(order, false).status, "ready");
  assert.equal(context.classifyGeminiOrder_(order, true).status, "duplicate");
});

test("routes malformed and low-confidence Gemini results to read failed", async () => {
  const context = await loadHelpers();
  const malformed = context.normalizeGeminiOrder_({
    marketplace: "marketplace-x",
    orderId: "BAD-1",
    customerName: "Mali",
    items: "not-an-array",
    quantity: 1,
    address: "Bangkok",
    total: "free",
    confidence: 90,
    missingFields: [],
    rawNotes: "",
  });
  const lowConfidence = context.normalizeGeminiOrder_({
    marketplace: "shopee",
    orderId: "SP-1003",
    customerName: "Mali",
    items: [{ name: "Phone Case", quantity: 1 }],
    quantity: 1,
    address: "Bangkok",
    total: 199,
    confidence: 69,
    missingFields: [],
    rawNotes: "",
  });

  const malformedResult = context.classifyGeminiOrder_(malformed, false);
  assert.equal(malformedResult.status, "incomplete");
  assert.ok(malformedResult.missingFields.includes("marketplace"));
  assert.ok(malformedResult.missingFields.includes("items"));
  assert.ok(malformedResult.missingFields.includes("total"));
  assert.equal(context.classifyGeminiOrder_(lowConfidence, false).status, "incomplete");
});

test("normalizes duplicate shipping labels as exportable rows", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("fixture.pdf", [
    {
      marketplace: "shopee",
      recipientName: "Mali Demo",
      shippingAddress: "Bangkok 10110",
      orderId: "260728AAA111",
      trackingNumber: "TH100000000001A",
    },
    {
      marketplace: "tiktok-shop",
      recipientName: "Ploy Demo",
      shippingAddress: "Phuket 83000",
      orderId: "260728AAA111",
      trackingNumber: "TTS-TRACK-1",
    },
  ]);

  assert.equal(labels.length, 2);
  assert.equal(labels[0].marketplace, "Shopee");
  assert.equal(labels[1].marketplace, "TikTok Shop");
  assert.ok(labels.every((label) => label.status === "ready"));
  assert.equal(labels[0].reviewReasons.length, 0);
});

test("gives Gemini the Shopee SPX visual extraction anchors", async () => {
  const source = await readFile(codeUrl, "utf8");

  assert.match(source, /two physical labels/);
  assert.match(source, /ผู้รับ \(TO\)/);
  assert.match(source, /ผู้ส่ง \(FROM\)/);
  assert.match(source, /below the top barcode/);
  assert.match(source, /Read the PDF visually/);
  assert.match(source, /one A5 page normally contains one physical label/);
  assert.match(source, /marked ถึง/);
  assert.match(source, /marked จาก/);
  assert.match(source, /beginning with JTTH/);
  assert.match(source, /Lazada LEX/);
  assert.match(source, /after Receiver:/);
  assert.match(source, /Seller Name/);
  assert.match(source, /standalone LEX logo text/);
});

test("exports shipping labels even when order extraction fails", async () => {
  const context = await loadHelpers();
  const file = {
    getName: () => "fixture.pdf",
    getUrl: () => "https://drive.google.com/file/d/fixture/view",
  };
  let exportedLabels = [];
  let movedToProcessed = false;

  context.DriveApp = { getFileById: () => file };
  context.extractShippingLabelsWithGemini_ = () => [
    {
      marketplace: "shopee",
      recipientName: "Mali Demo",
      shippingAddress: "Bangkok 10110",
      orderId: "260728AAA111",
      trackingNumber: "TH100000000001A",
    },
  ];
  context.writeShippingLabels_ = (labels) => {
    exportedLabels = labels;
  };
  context.extractOrderWithGemini_ = () => {
    throw new Error("order extraction failed");
  };
  context.writeOrderResult_ = () => {};
  context.moveToProcessed = () => {
    movedToProcessed = true;
  };

  context.moveToReview = () => {};
  const result = context.processDriveFileWithGemini("fixture-id");

  assert.equal(result.status, "failed");
  assert.equal(exportedLabels.length, 1);
  assert.equal(exportedLabels[0].orderId, "260728AAA111");
  assert.equal(movedToProcessed, true);
});

test("writes an incomplete blank shipping row when label extraction is malformed", async () => {
  const context = await loadHelpers();
  const file = {
    getName: () => "malformed.pdf",
    getUrl: () => "https://drive.google.com/file/d/malformed/view",
  };
  let exportedLabels = [];

  context.DriveApp = { getFileById: () => file };
  context.extractShippingLabelsWithGemini_ = () => {
    throw new Error("malformed Gemini label response");
  };
  context.writeShippingLabels_ = (labels) => {
    exportedLabels = labels;
  };
  context.extractOrderWithGemini_ = () => {
    throw new Error("order extraction failed");
  };
  context.writeOrderResult_ = () => {};
  context.moveToProcessed = () => {};

  context.moveToReview = () => {};
  const result = context.processDriveFileWithGemini("malformed-id");

  assert.equal(result.status, "failed");
  assert.equal(exportedLabels.length, 1);
  assert.equal(exportedLabels[0].status, "incomplete");
  assert.equal(exportedLabels[0].sourceFileName, "malformed.pdf");
});

test("creates an incomplete blank row when Gemini returns no shipping labels", async () => {
  const context = await loadHelpers();
  const labels = context.prepareShippingLabelsForExport_("empty.pdf", []);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].marketplace, "Unknown");
  assert.equal(labels[0].status, "incomplete");
  assert.ok(labels[0].reviewReasons.includes("recipientName"));
});

test("classifies unparseable Gemini body during label extraction as retryable transport error", async () => {
  const context = await loadHelpers();
  const mockResponse = {
    getResponseCode: () => 200,
    getContentText: () => "not-valid-json",
  };
  context.UrlFetchApp = { fetch: () => mockResponse };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (key === "GEMINI_API_KEY" ? "test-key" : null),
    }),
  };
  context.MimeType = { PDF: "application/pdf" };
  context.Utilities = { base64Encode: () => "" };

  const file = {
    getMimeType: () => "application/pdf",
    getBlob: () => ({ getBytes: () => [] }),
  };

  let caught;
  try {
    context.extractShippingLabelsWithGemini_(file);
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "extractShippingLabelsWithGemini_ must throw on unparseable body");
  assert.equal(
    caught.retryable,
    true,
    "body parse failure is a transport error and must be retryable",
  );
});

test("classifies empty Gemini response text during label extraction as retryable transport error", async () => {
  const context = await loadHelpers();
  const emptyBody = { candidates: [] };
  const mockResponse = {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify(emptyBody),
  };
  context.UrlFetchApp = { fetch: () => mockResponse };
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (key === "GEMINI_API_KEY" ? "test-key" : null),
    }),
  };
  context.MimeType = { PDF: "application/pdf" };
  context.Utilities = { base64Encode: () => "" };

  const file = {
    getMimeType: () => "application/pdf",
    getBlob: () => ({ getBytes: () => [] }),
  };

  let caught;
  try {
    context.extractShippingLabelsWithGemini_(file);
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, "extractShippingLabelsWithGemini_ must throw when Gemini returns no text");
  assert.equal(
    caught.retryable,
    true,
    "empty Gemini response is a transport error and must be retryable",
  );
});

test("filters shipping label rows already exported for the same file", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("fixture.pdf", [
    {
      marketplace: "shopee",
      recipientName: "Mali Demo",
      shippingAddress: "Bangkok 10110",
      orderId: "260728AAA111",
      trackingNumber: "TH100000000001A",
    },
    {
      marketplace: "lazada",
      recipientName: "Nara Demo",
      shippingAddress: "Chiang Mai 50000",
      orderId: "LZD-2002",
      trackingNumber: "LEXTH0002",
    },
  ]);
  const existingRows = [
    [
      new Date(),
      "fixture.pdf",
      "Shopee",
      "Mali Demo",
      "Bangkok 10110",
      "260728AAA111",
      "TH100000000001A",
      "ready",
      "",
      "https://drive.google.com/file/d/fixture/view",
    ],
  ];

  const newLabels = context.filterNewShippingLabels_(labels, existingRows);

  assert.equal(newLabels.length, 1);
  assert.equal(newLabels[0].marketplace, "Lazada");
});

test("skips an already imported label when OCR text changes but file and identifiers match", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("fixture.pdf", [
    {
      marketplace: "shopee",
      recipientName: "Mali Corrected",
      shippingAddress: "Bangkok 10110 corrected",
      orderId: "260728AAA111",
      trackingNumber: "TH100000000001A",
    },
  ]);
  const existingRows = [
    [
      new Date(),
      "fixture.pdf",
      "Shopee",
      "Mali OCR Variant",
      "Bangkok 10110",
      "260728AAA111",
      "TH100000000001A",
      "ready",
      "",
      "https://drive.google.com/file/d/fixture/view",
    ],
  ];

  const newLabels = context.filterNewShippingLabels_(
    labels,
    existingRows,
    "https://drive.google.com/file/d/fixture/view",
  );

  assert.equal(newLabels.length, 0);
});

test("does not reinsert an incomplete label when its file and tracking number already exist", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("fixture.pdf", [{
    marketplace: "Shopee",
    recipientName: "",
    shippingAddress: "",
    orderId: "2608138N3AJJB0",
    trackingNumber: "TH260525610831P",
  }]);
  const existingRows = [[
    new Date(),
    "fixture.pdf",
    "Shopee",
    "",
    "",
    "2608138N3AJJB0",
    "TH260525610831P",
    "incomplete",
    "recipientName, shippingAddress",
    "https://drive.google.com/file/d/fixture/view",
  ]];

  const newLabels = context.filterNewShippingLabels_(
    labels,
    existingRows,
    "https://drive.google.com/file/d/fixture/view",
  );

  assert.equal(newLabels.length, 0);
});

test("removes stale empty review placeholders when a file later reads successfully", async () => {
  const context = await loadHelpers();
  const deletedRows = [];
  const sheet = {
    deleteRow: (rowNumber) => deletedRows.push(rowNumber),
  };
  const existingRows = [
    [
      new Date(),
      "22.pdf",
      "Unknown",
      "",
      "",
      "",
      "",
      "review",
      "marketplace,recipientName,shippingAddress,orderId,trackingNumber",
      "https://drive/22",
    ],
    [
      new Date(),
      "22.pdf",
      "Shopee",
      "Mali One",
      "Bangkok 10110",
      "2607302AAA111",
      "TH269321699657I",
      "review",
      "duplicateOrderId",
      "https://drive/22",
    ],
  ];

  context.removeStaleReviewPlaceholders_(sheet, existingRows, { "22.pdf": true });

  assert.deepEqual(deletedRows, [2]);
});

test("marks blank shipping-label fields as incomplete without routing them to review", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("incomplete.pdf", [{
    marketplace: "Shopee",
    recipientName: "",
    shippingAddress: "",
    orderId: "2608138N3AJJB0",
    trackingNumber: "TH260525610831P",
  }]);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].status, "incomplete");
  assert.deepEqual(Array.from(labels[0].reviewReasons), ["recipientName", "shippingAddress"]);
});

test("clears Shopee warehouse routing codes instead of exporting them as addresses", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("shopee.pdf", [{
    marketplace: "Shopee",
    recipientName: "ปาลิตา วงทมนา",
    shippingAddress: "W 0 C13 207 HSAKN-B",
    orderId: "2608138GD25XW0",
    trackingNumber: "TH266686087147V",
  }]);

  assert.equal(labels[0].shippingAddress, "");
  assert.equal(labels[0].status, "incomplete");
  assert.ok(labels[0].reviewReasons.includes("shippingAddress"));
});

test("trims Shopee order and warehouse text that follows a valid postal code", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("shopee.pdf", [{
    marketplace: "Shopee",
    recipientName: "อัญรินทร์ ขนุนทอง",
    shippingAddress: "บ้านเลขที่ 91/1 ม.7 ตำบลบางโทรัด จังหวัดสมุทรสาคร 74000 Shopee Order No. 2608138GAG45FP 13-08-2026",
    orderId: "2608138GAG45FP",
    trackingNumber: "TH2659183081979",
  }, {
    marketplace: "Shopee",
    recipientName: "สหภาพ เนื่องแก้ว",
    shippingAddress: "บ้านเลขที่198 หมู่13 ต.บ้านเป็ด จังหวัดขอนแก่น 40000 HOME H24-(HOU.8) 198",
    orderId: "2608138FH4K8J1",
    trackingNumber: "TH261636476871S",
  }]);

  assert.equal(labels[0].shippingAddress, "บ้านเลขที่ 91/1 ม.7 ตำบลบางโทรัด จังหวัดสมุทรสาคร 74000");
  assert.equal(labels[1].shippingAddress, "บ้านเลขที่198 หมู่13 ต.บ้านเป็ด จังหวัดขอนแก่น 40000");
  assert.equal(labels.every((label) => label.status === "ready"), true);
});

test("keeps one best label when OCR returns the same tracking number twice", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("Tik Tok - 1.pdf", [
    {
      marketplace: "TikTok Shop",
      recipientName: "จาก H ** f",
      shippingAddress: "ถ . ช้างเผือก ต . ศรีภูมิ อ . เมือง จ . เชียงใหม่ 50200",
      orderId: "585523355876427426",
      trackingNumber: "JTTH202373114484",
    },
    {
      marketplace: "TikTok Shop",
      recipientName: "",
      shippingAddress: "",
      orderId: "585523355876427426",
      trackingNumber: "JTTH202373114484",
    },
  ]);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].trackingNumber, "JTTH202373114484");
  assert.equal(labels[0].recipientName, "");
  assert.equal(labels[0].shippingAddress.includes("เชียงใหม่ 50200"), true);
  assert.equal(labels[0].status, "incomplete");
});

test("separates a Lazada recipient name from an inline Thai address heading", async () => {
  const context = await loadHelpers();
  const labels = context.parseOcrShippingLabels_(
    "Lazada -4.pdf",
    [
      "LEXPU0706169335",
      "Order No.: 1112426874984193",
      "Customer NAME: ณัฐพร อุดรสฤษฎ์กุล ที่อยู่ADDRESS:587 ซอยพัฒนาการ 20 กรุงเทพมหานคร 10250",
      "ADDRESS:587 ซอยพัฒนาการ 20 กรุงเทพมหานคร 10250",
      "Phone number: 660****067",
      "Lazada",
    ].join("\n"),
  );

  assert.equal(labels[0].recipientName, "ณัฐพร อุดรสฤษฎ์กุล");
  assert.equal(labels[0].shippingAddress, "587 ซอยพัฒนาการ 20 กรุงเทพมหานคร 10250");
  assert.equal(labels[0].status, "ready");
});

test("normalizes Drive OCR private-use Thai tone marks and thanthakhat", async () => {
  const context = await loadHelpers();

  assert.equal(
    context.normalizePdfTextForParsing_("ป\uF70Cอปป\uF70D ศุกร\uF70E"),
    "ป๊อปป๋ ศุกร์",
  );
});

test("marks Shopee delivery instructions in the recipient field as incomplete", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("1 รวม SPX.pdf", [{
    marketplace: "Shopee",
    recipientName: "Sukhum Office ห้องด้านหลัง จัดส่งจันทร์ถึงศุกร์เท่านั้น",
    shippingAddress: "Sukhum Craft เลขที่ 29 หมู่ที่ 5 จังหวัดเชียงใหม่ 50230",
    orderId: "2608138EDB7WXD",
    trackingNumber: "TH2685687819624",
  }]);

  assert.equal(labels[0].recipientName, "");
  assert.equal(labels[0].status, "incomplete");
  assert.ok(labels[0].reviewReasons.includes("recipientName"));
});
