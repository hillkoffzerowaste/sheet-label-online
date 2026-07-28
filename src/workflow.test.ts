import assert from "node:assert/strict";
import test from "node:test";
import { detectMarketplace, processPdfJob } from "./workflow";

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
