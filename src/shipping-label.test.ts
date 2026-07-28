import assert from "node:assert/strict";
import test from "node:test";
import {
  filterShippingLabels,
  markDuplicateShippingLabels,
  parseShippingLabels,
} from "./shipping-label";

test("splits two Shopee labels into rows", () => {
  const labels = parseShippingLabels(
    "shopee.pdf",
    [
      "TH100000000001A ผู้รับ (TO) Mali Demo Address: Bangkok 10110 Shopee Order No. 260728AAA111",
      "TH100000000002B ผู้รับ (TO) Arun Demo Address: Chiang Mai 50000 Shopee Order No. 260728BBB222",
    ].join("\n--- LABEL ---\n"),
  );

  assert.equal(labels.length, 2);
  assert.deepEqual(labels.map((label) => label.marketplace), ["Shopee", "Shopee"]);
  assert.deepEqual(labels.map((label) => label.orderId), ["260728AAA111", "260728BBB222"]);
  assert.deepEqual(labels.map((label) => label.trackingNumber), ["TH100000000001A", "TH100000000002B"]);
});

test("normalizes Lazada and TikTok Shop", () => {
  const lazada = parseShippingLabels(
    "lazada.pdf",
    "Lazada Tracking: LEXTH0001 Order Number: LZD-1001 Recipient: Nara Demo Address: Bangkok 10110",
  )[0];
  const tiktok = parseShippingLabels(
    "tiktok.pdf",
    "TikTok Shop Tracking No: TTS-TRACK-1 Order ID: TTS-1001 Recipient: Ploy Demo Address: Phuket 83000",
  )[0];

  assert.equal(lazada?.marketplace, "Lazada");
  assert.equal(tiktok?.marketplace, "TikTok Shop");
  assert.equal(lazada?.orderId, "LZD-1001");
  assert.equal(tiktok?.trackingNumber, "TTS-TRACK-1");
});

test("marks duplicate identifiers for review", () => {
  const labels = markDuplicateShippingLabels([
    ...parseShippingLabels(
      "one.pdf",
      "Shopee TH100000000010A Shopee Order No. 260728DDD444 ผู้รับ (TO) A Demo Address: Bangkok",
    ),
    ...parseShippingLabels(
      "two.pdf",
      "Shopee TH100000000010A Shopee Order No. 260728DDD444 ผู้รับ (TO) B Demo Address: Chiang Mai",
    ),
  ]);

  assert.ok(labels.every((label) => label.status === "review"));
  assert.ok(labels[0]?.reviewReasons.includes("duplicateOrderId"));
  assert.ok(labels[0]?.reviewReasons.includes("duplicateTrackingNumber"));
});

test("marks incomplete label fields for review", () => {
  const [label] = parseShippingLabels(
    "missing.pdf",
    "Shopee TH100000000012A Shopee Order No. 260728FFF666 ผู้รับ (TO) Mali Demo",
  );

  assert.equal(label?.status, "review");
  assert.ok(label?.reviewReasons.includes("shippingAddress"));
});

test("filters by marketplace and tracking values", () => {
  const labels = parseShippingLabels(
    "labels.pdf",
    "Shopee TH100000000011A Shopee Order No. 260728EEE555 ผู้รับ (TO) Mali Demo Address: Bangkok",
  );

  assert.equal(filterShippingLabels(labels, "0011", "Shopee", "all").length, 1);
  assert.equal(filterShippingLabels(labels, "", "Lazada", "all").length, 0);
});
