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

test("returns an OCR shipping-label candidate instead of guessing missing values", async () => {
  const context = await loadHelpers();
  const labels = context.buildOcrShippingLabels_(
    "fallback.pdf",
    "https://drive/file",
    "Shopee",
  );

  assert.equal(labels.length, 1);
  assert.equal(labels[0].source, "drive-ocr");
  assert.equal(labels[0].status, "review");
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
  assert.equal(movedToProcessed, false);
});

test("trashes the temporary OCR document even when OCR text reading fails", async () => {
  const context = await loadHelpers();
  let copyOptions;
  let trashed = 0;

  context.MimeType = { GOOGLE_DOCS: "application/vnd.google-apps.document" };
  context.Drive = {
    Files: {
      insert: (resource, blob, options) => {
        copyOptions = { resource, blob, options };
        return { id: "ocr-doc-id" };
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
  assert.equal(trashed, 1);
  assert.equal(copyOptions.options.ocr, true);
  assert.equal(copyOptions.options.ocrLanguage, "th");
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

test("normalizes shipping labels and marks duplicate orders for review", async () => {
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
  assert.ok(labels.every((label) => label.status === "review"));
  assert.ok(labels[0].reviewReasons.includes("duplicateOrderId"));
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
  assert.equal(movedToProcessed, false);
});

test("writes a review shipping row when label extraction is malformed", async () => {
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
  assert.equal(exportedLabels[0].status, "review");
  assert.equal(exportedLabels[0].sourceFileName, "malformed.pdf");
});

test("creates a review row when Gemini returns no shipping labels", async () => {
  const context = await loadHelpers();
  const labels = context.prepareShippingLabelsForExport_("empty.pdf", []);

  assert.equal(labels.length, 1);
  assert.equal(labels[0].marketplace, "Unknown");
  assert.equal(labels[0].status, "review");
  assert.ok(labels[0].reviewReasons.includes("trackingNumber"));
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
