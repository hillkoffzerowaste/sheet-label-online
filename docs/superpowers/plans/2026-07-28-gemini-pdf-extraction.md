# Gemini PDF Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** ให้ Google Apps Script ใช้ Gemini อ่าน PDF คำสั่งซื้อเป็น JSON ที่ตรวจสอบได้ พร้อมแสดง Gemini และ confidence บน Web App

**Architecture:** Apps Script เรียก Gemini ผ่าน UrlFetchApp แล้ว normalize ผลลัพธ์ก่อน duplicate check และ validation. TypeScript workflow สร้าง contract เดียวกันสำหรับ UI simulation และ tests

**Tech Stack:** Vinext, React, TypeScript, Node test runner with tsx, Google Apps Script V8, Google Drive/Sheets, Gemini REST API

## Global Constraints

- เก็บ API key ไว้เฉพาะ Script Properties ชื่อ GEMINI_API_KEY; ห้ามใส่ใน source code, Web App, tests, README หรือ Google Sheet
- ชื่อโมเดลอ่านจาก Script Properties ชื่อ GEMINI_MODEL; ถ้าไม่กำหนดใช้ default ที่ประกาศใน Apps Script เพียงจุดเดียว
- Gemini ดึงข้อมูลเท่านั้น; duplicate check, required-field validation และ Google Sheet write ยังคงเป็น business logic ของ Apps Script
- Contract มี marketplace, orderId, customerName, items, quantity, address, total, confidence, missingFields, rawNotes; ห้ามเดาข้อมูล
- confidence ต่ำกว่า 70, required field หาย, หรือ Order ID ซ้ำ ต้องไม่เขียนลง Orders
- รักษาคอลัมน์เดิมตามลำดับเดิม; เพิ่ม audit columns ต่อท้าย: Orders ใช้ Source, Confidence; Read Failed ใช้ Confidence, Missing Fields, Raw Notes
- timeout, HTTP error, response ว่าง, ไม่มี key หรือเขียนชีตล้มเหลวเป็น retryable และต้องเก็บ PDF ไว้ input folder
- JSON parse ไม่ได้, schema ผิด, ข้อมูลไม่ครบ, confidence ต่ำ และ duplicate เป็น terminal: เขียน Read Failed แล้วจึงย้ายไป Processed
- tests ห้ามเรียก Gemini API จริง; ใช้ fixture และ stubs เท่านั้น

---

## File Structure

| File | Responsibility |
| --- | --- |
| src/workflow.ts | Gemini contract, normalizer, UI workflow steps |
| src/workflow.test.ts | Unit tests สำหรับ normalizer, confidence และ duplicate |
| apps-script/Code.gs | Gemini REST request, Apps Script routing, sheet audit columns, move policy |
| tests/apps-script-gemini.test.mjs | Dry-run tests ของ pure Apps Script helpers ผ่าน node:vm |
| app/page.tsx | แสดง source, confidence และ notes |
| app/globals.css | Compact styles สำหรับ Gemini metadata |
| tests/rendered-html.test.mjs | Server-render assertion ของ Gemini UI |
| README.md | Setup Script Properties และ retry policy |
| package.json | รวม Apps Script dry-run test เข้า npm test |

## Task 1: Shared Gemini extraction contract

**Files:**

- Modify: src/workflow.ts:1-220
- Modify: src/workflow.test.ts:1-58

**Interfaces:**

- Consumes: Marketplace, OrderItem, ProcessedOrder
- Produces: ExtractionSource, GeminiExtraction, normalizeGeminiExtraction(raw), processGeminiExtraction(fileName, raw, existingOrderIds)
- Produces: MissingField ที่เพิ่ม total และ workflow step id gemini หลัง id read

- [ ] **Step 1: Write failing tests for complete, low-confidence, and invalid data**

เพิ่ม fixture และ assertions ต่อไปนี้ใน src/workflow.test.ts:

~~~ts
const geminiRaw = {
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
};

assert.equal(processGeminiExtraction("order.pdf", geminiRaw, []).status, "ready");
assert.equal(processGeminiExtraction("order.pdf", { ...geminiRaw, confidence: 69 }, []).status, "incomplete");
assert.equal(processGeminiExtraction("order.pdf", { ...geminiRaw, total: "free" }, []).status, "incomplete");
assert.equal(processGeminiExtraction("order.pdf", geminiRaw, ["SP-1002"]).status, "duplicate");
~~~

เพิ่ม test ที่ marketplace ไม่รู้จักและ missingFields มี address; แต่ละกรณีต้องได้ status incomplete และมี missing field ที่ตรงกัน

- [ ] **Step 2: Run the focused test to verify it fails**

Run: node --import tsx --test src/workflow.test.ts

Expected: FAIL เพราะ processGeminiExtraction ยังไม่มี export

- [ ] **Step 3: Implement contract and normalizer**

ใน src/workflow.ts เพิ่ม:

~~~ts
export type ExtractionSource = "parser" | "gemini";

export type GeminiExtraction = {
  marketplace: string;
  orderId: string;
  customerName: string;
  items: Array<{ name: string; quantity: number; sku?: string }>;
  quantity: number;
  address: string;
  total: number;
  confidence: number;
  missingFields: string[];
  rawNotes: string;
};
~~~

normalizeGeminiExtraction(raw: unknown) ต้อง trim string, map marketplace เป็น Shopee | Lazada | TikTok Shop | Unknown, เก็บเฉพาะ item ที่มีชื่อ, แปลง quantity/total/confidence เป็น number, clamp confidence 0-100 และรวม quantity จาก items เมื่อมี item ที่จำนวนมากกว่า 0. เมื่อชนิดข้อมูลผิดให้คืนค่าว่างหรือ NaN เพื่อให้ validation ทำงานโดยไม่ throw

processGeminiExtraction สร้าง ProcessedOrder ด้วย source: gemini, confidence และ rawNotes; ตรวจ duplicate ก่อน validation; ถือว่า confidence < 70, missingFields จาก Gemini, total ไม่ finite หรือ total ติดลบเป็นข้อมูลไม่ครบ. เพิ่ม total ใน MissingField และ getMissingFields. processPdfJob เดิมต้องคืน source: parser, confidence: undefined, rawNotes: undefined

เพิ่ม workflow step หลัง read:

~~~ts
{ id: "gemini", label: "Gemini อ่าน PDF", description: "ดึงข้อมูลคำสั่งซื้อเป็นข้อมูลโครงสร้างพร้อมค่าความเชื่อมั่น" }
~~~

- [ ] **Step 4: Run the focused test to verify it passes**

Run: node --import tsx --test src/workflow.test.ts

Expected: PASS ทุก test เดิมและ test ใหม่

- [ ] **Step 5: Commit**

~~~bash
git add src/workflow.ts src/workflow.test.ts
git commit -m "Add Gemini extraction workflow contract"
~~~

## Task 2: Gemini processing in Google Apps Script

**Files:**

- Modify: apps-script/Code.gs:1-228
- Create: tests/apps-script-gemini.test.mjs
- Modify: package.json:5-12

**Interfaces:**

- Consumes: DriveApp.File, Script Properties GEMINI_API_KEY/GEMINI_MODEL, Orders and Read Failed sheets
- Produces: extractOrderWithGemini_(file), normalizeGeminiOrder_(raw), classifyGeminiOrder_(order, isDuplicate), ensureGeminiAuditHeaders_(), isRetryableError_(error)
- Produces: success/failure rows with audit values and an explicit move decision

- [ ] **Step 1: Write dry-run tests that do not invoke Google services**

Create tests/apps-script-gemini.test.mjs. Read apps-script/Code.gs and evaluate it in a fresh node:vm context. Supply stubs for DriveApp, SpreadsheetApp, ContentService, PropertiesService and UrlFetchApp that throw if called. Test only pure helpers:

~~~js
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
assert.equal(context.classifyGeminiOrder_(order, false).status, "ready");
assert.equal(context.classifyGeminiOrder_({ ...order, confidence: 69 }, false).status, "incomplete");
assert.equal(context.classifyGeminiOrder_(order, true).status, "duplicate");
~~~

เพิ่ม fixture ที่ items ไม่ใช่ array, total เป็น free และ marketplace ไม่รู้จัก. ทั้งหมดต้อง return terminal incomplete, ไม่ throw และไม่เรียก stub

- [ ] **Step 2: Run the dry-run test to verify it fails**

Run: node --test tests/apps-script-gemini.test.mjs

Expected: FAIL เพราะ helpers ยังไม่มี

- [ ] **Step 3: Implement configuration, request, and pure helpers**

ใน apps-script/Code.gs เพิ่ม getGeminiConfig_() ที่อ่าน Script Properties และ throw retryable GeminiConfigurationError เมื่อไม่มี key. model default อยู่ใน DEFAULT_GEMINI_MODEL เท่านั้น

extractOrderWithGemini_(file) ต้อง POST หนึ่งครั้งไป:

~~~text
https://generativelanguage.googleapis.com/v1beta/models/<encoded-model>:generateContent
~~~

ส่ง header x-goog-api-key, contentType application/json และ muteHttpExceptions true. PDF part ใช้ inlineData ที่มี mimeType application/pdf และ data จาก Utilities.base64Encode(file.getBlob().getBytes()). Prompt ต้องสั่งดึงข้อมูลคำสั่งซื้อ, ตอบ JSON ตาม schema, และห้ามเดาข้อมูล

โครง request:

~~~js
{
  contents: [{ parts: [{ text: ORDER_EXTRACTION_PROMPT }, { inlineData: pdfPart }] }],
  generationConfig: {
    responseMimeType: "application/json",
    responseJsonSchema: GEMINI_ORDER_SCHEMA,
  },
}
~~~

ตรวจ HTTP status ก่อน parse. non-2xx, candidates ว่าง และ part text ว่าง ให้ throw retryable GeminiTransportError. JSON parse error หรือ response ที่เป็น JSON แต่ไม่ตรง contract ให้ throw terminal GeminiResponseError. Log เฉพาะ error class, status และ file id; ห้าม log key, PDF base64, prompt เต็ม หรือ response เต็ม

เพิ่ม helpers:

~~~js
function normalizeGeminiOrder_(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const items = Array.isArray(value.items) ? value.items : [];
  return buildNormalizedGeminiOrder_(value, items);
}
function buildNormalizedGeminiOrder_(value, items) {
  return {
    marketplace: normalizeMarketplace_(value.marketplace),
    orderId: stringValue_(value.orderId),
    customerName: stringValue_(value.customerName),
    items: normalizeItems_(items),
    quantity: numberValue_(value.quantity),
    address: stringValue_(value.address),
    total: numberValue_(value.total),
    confidence: clampConfidence_(value.confidence),
    missingFields: stringArray_(value.missingFields),
    rawNotes: stringValue_(value.rawNotes),
    source: "gemini",
  };
}
function stringValue_(value) {
  return typeof value === "string" ? value.trim() : "";
}
function numberValue_(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}
function clampConfidence_(value) {
  const number = numberValue_(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}
function stringArray_(value) {
  return Array.isArray(value) ? value.filter(function (item) { return typeof item === "string"; }) : [];
}
function normalizeItems_(items) {
  return items.map(function (item) {
    return { name: stringValue_(item && item.name), quantity: numberValue_(item && item.quantity) };
  }).filter(function (item) { return item.name; });
}
function normalizeMarketplace_(value) {
  const marketplace = stringValue_(value).toLowerCase();
  if (marketplace === "shopee") return "Shopee";
  if (marketplace === "lazada") return "Lazada";
  if (marketplace === "tiktok-shop" || marketplace === "tiktok shop") return "TikTok Shop";
  return "Unknown";
}
function classifyGeminiOrder_(order, isDuplicate) {
  if (isDuplicate) return { status: "duplicate", reason: "Order ID ซ้ำ", missingFields: [] };
  const validation = validateOrder(order);
  const missingFields = validation.missingFields.concat(order.missingFields);
  return missingFields.length === 0 && order.confidence >= 70
    ? { status: "ready", reason: "ข้อมูลครบ", missingFields: [] }
    : { status: "incomplete", reason: "ข้อมูลไม่ครบ", missingFields: missingFields };
}
function isRetryableError_(error) {
  return Boolean(error && error.retryable);
}
~~~

helpers ต้องมีกฎเดียวกับ Task 1 รวม total, missingFields, confidence 70 และ duplicate. ปรับ validateOrder ให้ตรวจ total ด้วย

- [ ] **Step 4: Integrate route, sheet audits, and move policy**

แทนเส้นทาง OCR/detectMarketplace/parseOrder ใน processDriveFile ด้วย extractOrderWithGemini_(file), isDuplicateOrder และ classifyGeminiOrder_. คง extractPdfText_ และ parser helpers ไว้แต่เลิกเรียกจาก flow หลัก เพื่อให้ rollback เป็นการคืนจุดเรียกเดียว

Policy ที่ต้องได้:

~~~text
ready             -> appendSuccessRow -> moveToProcessed
duplicate         -> appendFailedRow  -> moveToProcessed
incomplete        -> appendFailedRow  -> moveToProcessed
terminal failure  -> appendFailedRow  -> moveToProcessed
retryable error   -> log only         -> keep in input folder
sheet write error -> throw            -> keep in input folder
~~~

เพิ่ม ensureGeminiAuditHeaders_() ก่อน append: อ่าน row 1, ห้ามย้าย/แก้ header เดิม และ append header audit ที่ยังไม่มีทางขวาสุด. appendSuccessRow เพิ่ม gemini, confidence. appendFailedRow เพิ่ม confidence, missingFields.join(", "), rawNotes. ห้ามแก้ Google Sheet อื่น

- [ ] **Step 5: Run dry-run tests**

Run: node --test tests/apps-script-gemini.test.mjs

Expected: PASS และไม่มี stub ถูกเรียก

- [ ] **Step 6: Add the test to npm test and run it**

แก้ package.json:

~~~json
"test": "npm run test:workflow && node --test tests/apps-script-gemini.test.mjs && npm run build && node --test tests/rendered-html.test.mjs"
~~~

Run: npm test

Expected: PASS ทุกขั้น

- [ ] **Step 7: Commit**

~~~bash
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs package.json
git commit -m "Add Gemini PDF extraction to Apps Script"
~~~

## Task 3: Dashboard status and confidence

**Files:**

- Modify: app/page.tsx:1-372
- Modify: app/globals.css:330-440
- Modify: tests/rendered-html.test.mjs:1-45

**Interfaces:**

- Consumes: ProcessedOrder.source, ProcessedOrder.confidence, ProcessedOrder.rawNotes และ gemini workflow step
- Produces: result table/detail panel ที่บอกว่า Gemini อ่านไฟล์, confidence และเหตุผลที่ต้องตรวจ

- [ ] **Step 1: Write failing rendered-HTML assertions**

เพิ่มใน tests/rendered-html.test.mjs:

~~~js
assert.match(html, /Gemini/);
assert.match(html, /ความมั่นใจ/);
~~~

Run: npm run build && node --test tests/rendered-html.test.mjs

Expected: FAIL เพราะ dashboard ยังไม่ render Gemini metadata

- [ ] **Step 2: Render Gemini metadata**

ใน app/page.tsx คง status chips เดิมและเพิ่ม ai-meta block ใน result detail กับ selected order detail. Render เฉพาะ order.source === gemini; แสดง Gemini อ่าน PDF, ความมั่นใจ: <confidence>% และ rawNotes เฉพาะเมื่อไม่ว่าง. สำหรับ incomplete, duplicate และ failed ให้ order.reason เป็นคำอธิบายหลัก แล้ว rawNotes เป็นข้อมูลรอง

เพิ่ม helper:

~~~ts
function formatConfidence(confidence?: number) {
  return typeof confidence === "number" ? String(confidence) + "%" : "ไม่ระบุ";
}
~~~

ปรับ sample Drive data หรือ processing route เพื่อให้ผล server-rendered อย่างน้อยหนึ่งรายการมี source: gemini และ confidence แบบตัวเลข. ห้ามเพิ่ม client-side Gemini call หรือ key-bearing environment variable

- [ ] **Step 3: Add focused styles**

เพิ่ม .ai-meta, .ai-meta-label และ .ai-meta-note ใกล้ .detail-stack ใน app/globals.css. Metadata ต้องกระชับ, ใช้สี/spacing เดิม, wrap ได้บนหน้าจอแคบ และห้ามเปลี่ยนสีของ status chips ทุกสถานะ

- [ ] **Step 4: Verify dashboard**

Run: npm run build && node --test tests/rendered-html.test.mjs && npm run lint

Expected: PASS; HTML มี Gemini และ ความมั่นใจ; lint ไม่มี error

- [ ] **Step 5: Commit**

~~~bash
git add app/page.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "Show Gemini extraction status in dashboard"
~~~

## Task 4: Documentation and final verification

**Files:**

- Modify: README.md:1-63

**Interfaces:**

- Consumes: Script Properties, sheet audit headers, Apps Script behavior และ npm test command
- Produces: secure setup instructions and retry guidance

- [ ] **Step 1: Update setup documentation**

ใน README.md เปลี่ยน workflow จาก 6 เป็น 7 ขั้น แล้วแทรก Gemini อ่าน PDF หลังอ่าน PDF. เพิ่ม Gemini Setup ด้วย actions เหล่านี้:

1. เปิด Apps Script project แล้วเลือก Project Settings > Script Properties
2. เพิ่ม GEMINI_API_KEY ด้วย key จริง และ GEMINI_MODEL ด้วยชื่อโมเดล
3. ตรวจ Orders ว่าคอลัมน์เดิมอยู่ที่เดิมและมี Source, Confidence ต่อท้าย; ตรวจ Read Failed ว่ามี Confidence, Missing Fields, Raw Notes ต่อท้าย
4. ทดสอบ PDF ที่ทราบผลหนึ่งไฟล์จาก input folder, ตรวจ execution log แล้วตรวจชีตปลายทางและ Processed folder

ระบุ policy: transport/configuration/sheet error คงไฟล์ใน input; duplicate/incomplete/schema-invalid เขียน Read Failed แล้วค่อย move. ระบุว่า prototype UI ไม่เรียก Gemini โดยตรง

- [ ] **Step 2: Run complete verification**

Run: npm test

Expected: workflow tests, Apps Script dry-run tests, build และ rendered dashboard test PASS

Run: npm run lint

Expected: PASS ไม่มี error

Run: git diff --check HEAD

Expected: ไม่มี whitespace error

- [ ] **Step 3: Review scope**

Run: git status --short

Expected: มีเฉพาะ README.md ที่ยังไม่ commit ใน task นี้; ไม่มี API key, .env, build artifact หรือไฟล์ผู้ใช้อื่น

- [ ] **Step 4: Commit**

~~~bash
git add README.md
git commit -m "Document Gemini PDF extraction setup"
~~~
