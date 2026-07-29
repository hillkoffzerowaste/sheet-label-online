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

test("reads recipient name and address from the Shopee SPX label layout", () => {
  const labels = parseShippingLabels(
    "shopee-spx.pdf",
    [
      [
        "TH267292251982A",
        "ผู้รับ (TO)",
        "ผู้ทดสอบ หนึ่ง",
        "เลขที่ 99 หมู่ 1 ตำบลเวียง อำเภอฝาง จังหวัดเชียงใหม่ 50110",
        "Shopee Order No. 260728TEST001",
      ].join("\n"),
      [
        "TH261186562919A",
        "ผู้รับ (TO)",
        "ผู้ทดสอบ สอง",
        "16 หมู่ 3 ตำบลป่าสัก อำเภอภูซาง จังหวัดพะเยา 56110",
        "Shopee Order No. 260728TEST002",
      ].join("\n"),
    ].join("\n"),
  );

  assert.equal(labels.length, 2);
  assert.equal(labels[0]?.recipientName, "ผู้ทดสอบ หนึ่ง");
  assert.equal(
    labels[0]?.shippingAddress,
    "เลขที่ 99 หมู่ 1 ตำบลเวียง อำเภอฝาง จังหวัดเชียงใหม่ 50110",
  );
  assert.equal(labels[1]?.recipientName, "ผู้ทดสอบ สอง");
  assert.equal(
    labels[1]?.shippingAddress,
    "16 หมู่ 3 ตำบลป่าสัก อำเภอภูซาง จังหวัดพะเยา 56110",
  );
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

test("reads the TikTok Shop J&T label layout", () => {
  const [label] = parseShippingLabels(
    "tiktok-jt.pdf",
    [
      "TikTok Shop J&T Express",
      "JTTH201180179874",
      "จาก ร้านตัวอย่าง",
      "ถึง ผู้ทดสอบ TikTok",
      "42 หมู่ 2 ตำบลขามสมบูรณ์ จังหวัดนครราชสีมา 30260",
      "Order ID: 585247221484193247",
      "Shipping Date: 30-07-2026",
    ].join("\n"),
  );

  assert.equal(label?.marketplace, "TikTok Shop");
  assert.equal(label?.recipientName, "ผู้ทดสอบ TikTok");
  assert.equal(
    label?.shippingAddress,
    "42 หมู่ 2 ตำบลขามสมบูรณ์ จังหวัดนครราชสีมา 30260",
  );
  assert.equal(label?.orderId, "585247221484193247");
  assert.equal(label?.trackingNumber, "JTTH201180179874");
});

test("reads the Lazada LEX label layout", () => {
  const [label] = parseShippingLabels(
    "lazada-lex.pdf",
    [
      "LEXPU0702650797",
      "Sender: ร้านตัวอย่าง",
      "บริษัทตัวอย่าง จำกัด เลขที่ 66 ถนนช้างเผือก จังหวัดเชียงใหม่ 50200",
      "Receiver: ผู้ทดสอบ Lazada",
      "73/1 หมู่ 13 ตำบลเขาขลุง อำเภอบ้านโป่ง จังหวัดราชบุรี 70110",
      "Phone: 660****067",
      "LAZADA Order Number: 1117718175852180",
    ].join("\n"),
  );

  assert.equal(label?.marketplace, "Lazada");
  assert.equal(label?.recipientName, "ผู้ทดสอบ Lazada");
  assert.equal(
    label?.shippingAddress,
    "73/1 หมู่ 13 ตำบลเขาขลุง อำเภอบ้านโป่ง จังหวัดราชบุรี 70110",
  );
  assert.equal(label?.orderId, "1117718175852180");
  assert.equal(label?.trackingNumber, "LEXPU0702650797");
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
