# Marketplace Shipping Label Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display one normalized shipping-label record per row for Shopee, Lazada, and TikTok Shop.

**Architecture:** A pure TypeScript module owns parsing, validation, duplicate marking, and filtering. Apps Script converts Drive-PDF results to the same record shape and writes `Shipping Labels`; the browser renders the records and never holds Google or Gemini credentials.

**Tech Stack:** TypeScript, React 19, Next.js 16/Vinext, Google Apps Script, Gemini REST API, Node test runner, ESLint.

## Global Constraints

- One page can contain multiple labels; each label yields one row.
- Table columns are `Marketplace`, `ชื่อผู้รับ`, `ที่อยู่จัดส่ง`, `หมายเลขคำสั่งซื้อ`, `เลขพัสดุ` in that order.
- Valid marketplaces are `Shopee`, `Lazada`, `TikTok Shop`, and `Unknown`.
- Missing required data, unknown marketplace, duplicate order ID, or duplicate tracking number produces `status: "review"` with a reason.
- Fixtures use synthetic customer data only.

---

## File Structure

- Create: `src/shipping-label.ts` - shared contract, parser, validation, duplicates, and filter.
- Create: `src/shipping-label.test.ts` - synthetic parser tests.
- Modify: `src/workflow.ts` - import the shared marketplace union.
- Modify: `apps-script/Code.gs` - normalize/write labels to `Shipping Labels`.
- Modify: `tests/apps-script-gemini.test.mjs` - test Apps Script label helpers.
- Modify: `app/page.tsx`, `app/globals.css`, and `tests/rendered-html.test.mjs` - replace output with label table UI.
- Modify: `README.md` - document columns and automatic processing.

## Task 1: Shared shipping-label parser

**Files:**
- Create: `src/shipping-label.ts`
- Create: `src/shipping-label.test.ts`
- Modify: `src/workflow.ts:1-5`

**Interfaces:**
- Produces: `Marketplace`, `ReviewReason`, `ShippingLabel`, `parseShippingLabels`, `markDuplicateShippingLabels`, and `filterShippingLabels`.
- Consumes: PDF-extracted text only; no browser or Google API.

- [ ] **Step 1: Write the failing test**

Create `src/shipping-label.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { filterShippingLabels, markDuplicateShippingLabels, parseShippingLabels } from "./shipping-label";

test("splits two Shopee labels into rows", () => {
  const labels = parseShippingLabels("shopee.pdf", [
    "TH100000000001A ผู้รับ (TO) Mali Demo Address: Bangkok 10110 Shopee Order No. 260728AAA111",
    "TH100000000002B ผู้รับ (TO) Arun Demo Address: Chiang Mai 50000 Shopee Order No. 260728BBB222",
  ].join("\n--- LABEL ---\n"));
  assert.equal(labels.length, 2);
  assert.deepEqual(labels.map((label) => label.orderId), ["260728AAA111", "260728BBB222"]);
  assert.deepEqual(labels.map((label) => label.trackingNumber), ["TH100000000001A", "TH100000000002B"]);
});

test("normalizes Lazada and TikTok Shop", () => {
  const lazada = parseShippingLabels("lazada.pdf", "Lazada Tracking: LEXTH0001 Order Number: LZD-1001 Recipient: Nara Demo Address: Bangkok 10110")[0];
  const tiktok = parseShippingLabels("tiktok.pdf", "TikTok Shop Tracking No: TTS-TRACK-1 Order ID: TTS-1001 Recipient: Ploy Demo Address: Phuket 83000")[0];
  assert.equal(lazada.marketplace, "Lazada");
  assert.equal(tiktok.marketplace, "TikTok Shop");
});

test("marks duplicate identifiers for review", () => {
  const labels = markDuplicateShippingLabels([
    ...parseShippingLabels("one.pdf", "Shopee TH100000000010A Shopee Order No. 260728DDD444 ผู้รับ (TO) A Demo Address: Bangkok"),
    ...parseShippingLabels("two.pdf", "Shopee TH100000000010A Shopee Order No. 260728DDD444 ผู้รับ (TO) B Demo Address: Chiang Mai"),
  ]);
  assert.ok(labels.every((label) => label.status === "review"));
  assert.ok(labels[0].reviewReasons.includes("duplicateOrderId"));
  assert.ok(labels[0].reviewReasons.includes("duplicateTrackingNumber"));
});

test("filters marketplace and tracking values", () => {
  const labels = parseShippingLabels("labels.pdf", "Shopee TH100000000011A Shopee Order No. 260728EEE555 ผู้รับ (TO) Mali Demo Address: Bangkok");
  assert.equal(filterShippingLabels(labels, "0011", "Shopee", "all").length, 1);
  assert.equal(filterShippingLabels(labels, "", "Lazada", "all").length, 0);
});
```

- [ ] **Step 2: Verify red**

Run `node --import tsx --test src/shipping-label.test.ts`. Expect `ERR_MODULE_NOT_FOUND` because the implementation file is absent.

- [ ] **Step 3: Implement the smallest contract**

Create `src/shipping-label.ts`:

```ts
export type Marketplace = "Shopee" | "Lazada" | "TikTok Shop" | "Unknown";
export type ReviewReason = "marketplace" | "recipientName" | "shippingAddress" | "orderId" | "trackingNumber" | "duplicateOrderId" | "duplicateTrackingNumber";
export type ShippingLabel = {
  id: string; sourceFileName: string; marketplace: Marketplace;
  recipientName: string; shippingAddress: string; orderId: string;
  trackingNumber: string; status: "ready" | "review"; reviewReasons: ReviewReason[];
};
```

Implement `parseShippingLabels(fileName, text)` by splitting `--- LABEL ---` when present, otherwise parsing one segment. Detect marketplace names case-insensitively; extract only the explicit order/tracking/recipient/address markers in the tests and return empty strings rather than guesses. `buildShippingLabel` adds reasons for missing required values. `markDuplicateShippingLabels` adds duplicate reasons to every record sharing nonempty order/tracking values. `filterShippingLabels` searches all visible fields case-insensitively and applies `"all" | Marketplace` and `"all" | "ready" | "review"` filters. In `src/workflow.ts`, import `Marketplace` from this file and remove its duplicate declaration.

- [ ] **Step 4: Verify green**

Run `node --import tsx --test src/shipping-label.test.ts src/workflow.test.ts`. Expect all label and current workflow tests to pass.

- [ ] **Step 5: Commit**

Run `git add src/shipping-label.ts src/shipping-label.test.ts src/workflow.ts src/workflow.test.ts` followed by `git commit -m "Add marketplace shipping label parser"`.

## Task 2: Apps Script normalization and Sheet output

**Files:**
- Modify: `apps-script/Code.gs:1-58,88-153,365-405,510-527`
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Produces: `normalizeShippingLabels_(fileName, values)`, `writeShippingLabels_(labels, fileUrl)`, and `getShippingLabelsSheet_()`.
- Produces: `SHIPPING_LABELS_SHEET_NAME = "Shipping Labels"` with a stable ten-column header.

- [ ] **Step 1: Write the failing helper test**

Add to `tests/apps-script-gemini.test.mjs`:

```js
test("normalizes labels and marks duplicate orders for review", async () => {
  const context = await loadHelpers();
  const labels = context.normalizeShippingLabels_("fixture.pdf", [
    { marketplace: "shopee", recipientName: "Mali Demo", shippingAddress: "Bangkok 10110", orderId: "260728AAA111", trackingNumber: "TH100000000001A" },
    { marketplace: "tiktok-shop", recipientName: "Ploy Demo", shippingAddress: "Phuket 83000", orderId: "260728AAA111", trackingNumber: "TTS-TRACK-1" },
  ]);
  assert.equal(labels.length, 2);
  assert.equal(labels[0].marketplace, "Shopee");
  assert.equal(labels[1].marketplace, "TikTok Shop");
  assert.ok(labels.every((label) => label.status === "review"));
});
```

- [ ] **Step 2: Verify red**

Run `node --test --test-name-pattern="normalizes labels" tests/apps-script-gemini.test.mjs`. Expect failure because `normalizeShippingLabels_` is absent.

- [ ] **Step 3: Implement schema, validation, and writer**

Add this configuration:

```js
const SHIPPING_LABELS_SHEET_NAME = "Shipping Labels";
const SHIPPING_LABEL_HEADERS = [
  "Processed At", "Source File", "Marketplace", "Recipient Name", "Shipping Address",
  "Order ID", "Tracking Number", "Status", "Review Reasons", "File URL",
];
```

Add a Gemini schema containing an array of `{ marketplace, recipientName, shippingAddress, orderId, trackingNumber }`. `normalizeShippingLabels_` trims values, calls `normalizeMarketplace_`, adds missing/duplicate reasons, and returns `ready` or `review`. `getShippingLabelsSheet_` creates a missing tab, writes headers only to an empty sheet, and freezes row one. `writeShippingLabels_` appends all ten fields for each record. Call the writer after successful extraction; a stored review record permits moving the PDF to Processed while retryable Gemini/sheet failures retain the PDF in the input folder.

- [ ] **Step 4: Verify green**

Run `node --test tests/apps-script-gemini.test.mjs`. Expect legacy Gemini and new label-helper tests to pass.

- [ ] **Step 5: Commit**

Run `git add apps-script/Code.gs tests/apps-script-gemini.test.mjs` followed by `git commit -m "Write normalized shipping labels to Sheets"`.

## Task 3: Five-column browser table

**Files:**
- Modify: `app/page.tsx:1-320`
- Modify: `app/globals.css:79-500`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `ShippingLabel` and `filterShippingLabels` plus synthetic display records.
- Produces: Marketplace/status filters, search, badge, review message, and copy tracking action.

- [ ] **Step 1: Write failing render assertions**

Add to `tests/rendered-html.test.mjs`:

```js
assert.match(html, /Marketplace/);
assert.match(html, /ชื่อผู้รับ/);
assert.match(html, /ที่อยู่จัดส่ง/);
assert.match(html, /หมายเลขคำสั่งซื้อ/);
assert.match(html, /เลขพัสดุ/);
assert.match(html, /Shopee/);
assert.match(html, /Lazada/);
assert.match(html, /TikTok Shop/);
assert.match(html, /ค้นหารายการ/);
assert.match(html, /คัดลอกเลขพัสดุ/);
```

- [ ] **Step 2: Verify red**

Run `npm run build` then `node --test tests/rendered-html.test.mjs`. Expect failure because the current order/product table has none of these controls.

- [ ] **Step 3: Implement the table**

Replace the order-focused output/detail UI in `app/page.tsx` with `ShippingLabelTable`. Add this state:

```ts
const [labelQuery, setLabelQuery] = useState("");
const [marketplaceFilter, setMarketplaceFilter] = useState<"all" | Marketplace>("all");
const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "review">("all");
const [copiedTrackingNumber, setCopiedTrackingNumber] = useState<string | null>(null);
```

Use `filterShippingLabels` inside `useMemo`. Render a text input with `aria-label="ค้นหารายการ"`, marketplace/status selects, and the five approved headers in order. `MarketplaceBadge` maps Shopee/Lazada/TikTok Shop/Unknown to modifier classes. Each nonempty tracking value has a button whose aria label begins `คัดลอกเลขพัสดุ`; it calls `navigator.clipboard.writeText` and displays `คัดลอกแล้ว` without changing source data. Review records render `ต้องตรวจสอบ:` and Thai reason labels under the recipient. A no-results row spans five columns. Keep `Go to Sheet` and remove the simulated production processing control.

Add `.marketplace-badge`, `.marketplace-shopee`, `.marketplace-lazada`, `.marketplace-tiktok-shop`, `.marketplace-unknown`, `.label-toolbar`, `.tracking-cell`, `.copy-button`, and `.review-reasons` styles. Below 760px, retain all identifier/address columns and enable horizontal scrolling.

- [ ] **Step 4: Verify green**

Run `npm run build` then `node --test tests/rendered-html.test.mjs`. Expect the five headers, all marketplace badges, search label, and copy label in rendered HTML.

- [ ] **Step 5: Commit**

Run `git add app/page.tsx app/globals.css tests/rendered-html.test.mjs` followed by `git commit -m "Show marketplace shipping labels in dashboard"`.

## Task 4: Document and verify

**Files:**
- Modify: `README.md:What The Prototype Does, Google Apps Script Setup, Integration Notes`

**Interfaces:**
- Consumes: the `Shipping Labels` ten-column output contract.
- Produces: operator documentation that separates automatic Drive processing from browser display.

- [ ] **Step 1: Document the output contract**

Add `Shipping Labels` and its exact columns: `Processed At`, `Source File`, `Marketplace`, `Recipient Name`, `Shipping Address`, `Order ID`, `Tracking Number`, `Status`, `Review Reasons`, `File URL`. State that one PDF page can produce several rows and that missing/duplicate values remain visible as `ต้องตรวจสอบ`.

- [ ] **Step 2: Document the automatic boundary**

Replace documentation implying the browser begins production extraction. State that Apps Script scans Drive, parses with Gemini fallback, writes normalized labels, and moves successfully written PDFs. State that the browser displays normalized records and opens the configured sheet.

- [ ] **Step 3: Run full verification**

Run `npm test`, `npm run lint`, `npx next build`, `git diff --check`, and `git status --short`. Expect exit code 0 from the three quality commands and only intended source/test/documentation files before staging.

- [ ] **Step 4: Commit and push**

Run `git add README.md`, `git commit -m "Document marketplace shipping label workflow"`, and `git push origin main`.

## Plan Self-Review

**Spec coverage:** Task 1 covers shared types, all marketplaces, multi-label parsing, validation, duplicates, and filtering. Task 2 covers automatic Apps Script normalization and sheet output. Task 3 covers the table, badges, search, copy control, review state, and mobile behavior. Task 4 covers documentation and complete verification.

**Placeholder scan:** No red-flag placeholder wording appears in implementation steps.

**Type consistency:** `Marketplace`, `ReviewReason`, `ShippingLabel`, `parseShippingLabels`, `markDuplicateShippingLabels`, `filterShippingLabels`, `normalizeShippingLabels_`, and `writeShippingLabels_` have one consistent role across the plan.
