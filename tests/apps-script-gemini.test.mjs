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

test("uses Drive OCR once when Gemini quota is exhausted", async () => {
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

  const result = context.processDriveFile("fixture-id");

  assert.equal(ocrCalls, 1);
  assert.equal(result.source, "drive-ocr");
  assert.equal(movedToProcessed, true);
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

  const result = context.processDriveFile("fixture-id");

  assert.equal(result.status, "failed");
  assert.equal(exportedLabels.length, 1);
  assert.equal(exportedLabels[0].orderId, "260728AAA111");
  assert.equal(movedToProcessed, true);
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

  const result = context.processDriveFile("malformed-id");

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
