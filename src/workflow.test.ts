import assert from "node:assert/strict";
import test from "node:test";
import {
  detectMarketplace,
  processGeminiExtraction,
  processPdfJob,
} from "./workflow";

test("detects marketplace from PDF text", () => {
  assert.equal(detectMarketplace("Shopee Order ID SP-1001"), "Shopee");
  assert.equal(detectMarketplace("Lazada package LZD-2001"), "Lazada");
  assert.equal(detectMarketplace("TikTok Shop TTS-3001"), "TikTok Shop");
  assert.equal(detectMarketplace("random invoice"), "Unknown");
});

test("extracts a complete Shopee order", () => {
  const result = processPdfJob(
    "shopee-order.pdf",
    "Shopee Order ID SP-1001 Customer: Mali Item: Phone Case Qty: 2 Address: Bangkok Total: 199",
    [],
  );

  assert.equal(result.status, "ready");
  assert.equal(result.orderId, "SP-1001");
  assert.equal(result.marketplace, "Shopee");
  assert.equal(result.items[0]?.name, "Phone Case");
});

test("marks duplicate order ids", () => {
  const result = processPdfJob(
    "duplicate.pdf",
    "Lazada Order ID LZD-2001 Customer: Arun Item: Charger Qty: 1 Address: Chiang Mai Total: 299",
    ["LZD-2001"],
  );

  assert.equal(result.status, "duplicate");
  assert.match(result.reason ?? "", /Order ID/);
});

test("marks incomplete data when required fields are missing", () => {
  const result = processPdfJob(
    "bad.pdf",
    "TikTok Shop Order ID TTS-3001 Item: Shirt",
    [],
  );

  assert.equal(result.status, "incomplete");
  assert.ok(result.missingFields.includes("customerName"));
  assert.ok(result.missingFields.includes("address"));
});

test("accepts a complete Gemini extraction with sufficient confidence", () => {
  const result = processGeminiExtraction(
    "gemini-order.pdf",
    {
      marketplace: "shopee",
      orderId: "SP-1002",
      customerName: "Mali",
      items: [{ name: "Phone Case", quantity: 2, sku: "PC-01" }],
      quantity: 2,
      address: "Bangkok",
      total: 199,
      confidence: 84,
      missingFields: [],
      rawNotes: "",
    },
    [],
  );

  assert.equal(result.status, "ready");
  assert.equal(result.source, "gemini");
  assert.equal(result.confidence, 84);
  assert.equal(result.marketplace, "Shopee");
});

test("sends low-confidence and invalid Gemini data for review", () => {
  const raw = {
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
  };

  assert.equal(
    processGeminiExtraction("low-confidence.pdf", { ...raw, confidence: 69 }, [])
      .status,
    "incomplete",
  );
  assert.ok(
    processGeminiExtraction("invalid-total.pdf", { ...raw, total: "free" }, [])
      .missingFields.includes("total"),
  );
  assert.ok(
    processGeminiExtraction(
      "unknown-marketplace.pdf",
      { ...raw, missingFields: ["address"] },
      [],
    ).missingFields.includes("address"),
  );
});

test("marks Gemini extractions with duplicate order ids", () => {
  const result = processGeminiExtraction(
    "duplicate-gemini.pdf",
    {
      marketplace: "TikTok Shop",
      orderId: "TTS-3002",
      customerName: "Nok",
      items: [{ name: "Bag", quantity: 1 }],
      quantity: 1,
      address: "Bangkok",
      total: 490,
      confidence: 90,
      missingFields: [],
      rawNotes: "",
    },
    ["TTS-3002"],
  );

  assert.equal(result.status, "duplicate");
});
