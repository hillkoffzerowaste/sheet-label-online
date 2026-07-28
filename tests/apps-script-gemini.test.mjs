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
