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
