# Drive OCR Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ Apps Script ใช้ Google Drive OCR อัตโนมัติเมื่อ Gemini โควตาเต็ม โดยไม่ทำไฟล์หายหรือเขียนแถวซ้ำ

**Architecture:** Google Drive OCR เป็นด่านแรก. เมื่อ OCR อ่านข้อมูลจำเป็นไม่ครบจึงเรียก Gemini เฉพาะส่วนที่ขาด; ทั้งสองเส้นทาง reuse OCR text ครั้งเดียวต่อ PDF. ผล OCR มี `source: "drive-ocr"` และข้อมูลไม่ครบเป็น `review`.

**Tech Stack:** Google Apps Script, Advanced Drive Service (`Drive.Files.insert`), `DocumentApp`, Node `node:test`, existing `apps-script/Code.gs`.

## Global Constraints

- OCR ต้องทำงานก่อน Gemini; Gemini ใช้เมื่อ OCR แปลงไม่ได้หรือข้อมูลจำเป็นไม่ครบ
- ห้ามเรียก Gemini ซ้ำใน execution เดียวหลัง HTTP 429
- ใช้ `Drive.Files.insert` พร้อม `ocr: true`, `ocrLanguage: "th"`; ลบ Google Docs ชั่วคราวใน `finally`
- ผล OCR ใช้ `source: "drive-ocr"`; ข้อมูลที่ขาดต้องเป็น `review` และห้ามเดา
- ถ้า OCR/Drive/Sheet ล้มเหลวแบบ retryable ให้คง PDF ไว้ใน input folder
- รักษา duplicate protection, date sheets, และ Marketplace ทั้ง Shopee/Lazada/TikTok

---

### Task 1: Define quota and OCR contracts with failing tests

**Files:** Modify `tests/apps-script-gemini.test.mjs`; then modify `apps-script/Code.gs`.

**Interfaces:**

- `isGeminiQuotaError_(status, bodyText)` returns boolean.
- `buildOcrOrder_(fileName, fileUrl, text)` returns existing order shape plus `source: "drive-ocr"`.
- `buildOcrShippingLabels_(fileName, fileUrl, text)` returns review-safe label candidates with OCR source metadata.

- [ ] **Step 1: Add failing tests.** Add tests asserting `isGeminiQuotaError_(429, "RESOURCE_EXHAUSTED") === true`, `isGeminiQuotaError_(200, "quota exceeded") === true`, and invalid-argument response is false. Add tests asserting OCR order source/review fields and an OCR shipping-label candidate with `status: "review"` when text contains only `Shopee`.
- [ ] **Step 2: Run `node --test tests/apps-script-gemini.test.mjs` and verify the new tests fail because helpers are missing.**
- [ ] **Step 3: Implement the three pure helpers.** Reuse `detectMarketplace`, `parseOrder`, `validateOrder`, `normalizeShippingLabels_`, and existing review reasons. Never synthesize non-empty values when OCR has no match.
- [ ] **Step 4: Rerun the focused test and verify all Apps Script helper tests pass.**
- [ ] **Step 5: Commit:** `git add tests/apps-script-gemini.test.mjs apps-script/Code.gs && git commit -m "test: define Drive OCR fallback contracts"`.

### Task 2: Parse OCR text for the three marketplaces

**Files:** Modify `tests/apps-script-gemini.test.mjs`; modify `apps-script/Code.gs`.

**Interfaces:**

- `parseOcrOrder_(marketplace, text)` returns the existing order shape.
- `parseOcrShippingLabels_(fileName, text)` returns label objects containing marketplace, recipientName, shippingAddress, orderId, and trackingNumber.

- [ ] **Step 1: Add failing fixtures** for Shopee (`Recipient`, `Order No.`, `Tracking`, `Address`), Lazada (`Receiver`, `LAZADA Order Number`, `LEX`), and TikTok Shop (`To`, `Order ID`, `JTTH`). Assert marketplace, name, order ID, and address are extracted.
- [ ] **Step 2: Run `node --test tests/apps-script-gemini.test.mjs` and verify the parser tests fail because the functions are missing.**
- [ ] **Step 3: Implement case-insensitive field aliases and line-bounded extraction.** Support `Recipient/Receiver/To/Customer`, `Order ID/Order No./Shopee Order No./LAZADA Order Number`, `Tracking`, and `Address`. Normalize marketplace through `normalizeMarketplace_`; return one Unknown review candidate if no label fields can be read.
- [ ] **Step 4: Run `node --test tests/apps-script-gemini.test.mjs` and `node --import tsx --test src/shipping-label.test.ts`.** All tests must pass.
- [ ] **Step 5: Commit:** `git add tests/apps-script-gemini.test.mjs apps-script/Code.gs && git commit -m "feat: parse marketplace labels from Drive OCR text"`.

### Task 3: Make OCR first and call Gemini only when OCR is unusable

**Files:** Modify `tests/apps-script-gemini.test.mjs`; modify `apps-script/Code.gs`.

**Interfaces:**

- `extractTextWithDriveOcr_(file)` creates a temporary Google Doc with `Drive.Files.insert`, reads `DocumentApp` text, and trashes the temp file in `finally`.
- `processDriveFile(fileId)` owns an execution-local OCR text cache shared by shipping-label and order fallback.

- [ ] **Step 1: Add a failing flow test.** Stub both Gemini extractors to throw a quota error, stub `extractTextWithDriveOcr_` to count calls, stub writes/movement as in existing tests, and assert `processDriveFile` calls OCR once and returns `source: "drive-ocr"`.
- [ ] **Step 2: Run the focused Apps Script test and verify it fails because quota errors currently return retryable failure without OCR.**
- [ ] **Step 3: Add OCR-first selection.** Call `extractTextWithDriveOcr_` before either Gemini extractor. Write OCR labels directly when all required label fields exist; otherwise call Gemini for shipping labels.
- [ ] **Step 4: Add a local `getOcrText_` closure/cache in `processDriveFile`.** Reuse one OCR conversion for labels and order. Call Gemini for Order only when the OCR order is not complete; on Gemini quota exhaustion keep the OCR result as `review`.
- [ ] **Step 5: Preserve Gemini HTTP status/body before throwing.** Throw a named quota error only when `isGeminiQuotaError_` matches; keep all other errors on existing paths.
- [ ] **Step 6: Make `extractTextWithDriveOcr_` clean up temp Docs in `finally` and convert Drive/OCR failures to retryable processing errors.**
- [ ] **Step 7: Run `npm test`; all existing and new tests must pass.**
- [ ] **Step 8: Commit:** `git add tests/apps-script-gemini.test.mjs apps-script/Code.gs && git commit -m "feat: prioritize Drive OCR before Gemini"`.

### Task 4: Document setup and validate the complete change

**Files:** Modify `README.md`; optionally extend `tests/apps-script-gemini.test.mjs` for copy-paste setup text.

- [ ] **Step 1: Document Apps Script → Services (+) → Drive API → Add, and state that OCR fallback needs no second API key.**
- [ ] **Step 2: Run `npm test` and `git diff --check`; expected result is PASS with no whitespace errors.**
- [ ] **Step 3: Commit:** `git add README.md tests/apps-script-gemini.test.mjs && git commit -m "docs: configure Drive OCR fallback"`.

### Task 5: Claude CLI review and publish

**Files:** Review all files changed by Tasks 1–4.

- [ ] **Step 1: Run Claude review without modification:** `claude -p "Review the Drive OCR fallback against docs/superpowers/specs/2026-07-30-drive-ocr-fallback-design.md. Check quota-only fallback, one OCR conversion per PDF, cleanup, retry semantics, duplicate protection, and tests. Do not modify files; report concrete issues with file and line references." --output-format text`.
- [ ] **Step 2: For each actionable finding, add a failing test first, implement the minimal fix, and rerun the focused test plus `npm test`.**
- [ ] **Step 3: Run final Claude verification:** `claude -p "Review the current diff for the Drive OCR fallback. Confirm it matches the approved design and contains no secrets, placeholders, or unrelated changes. Do not modify files; report PASS or blockers." --output-format text`.
- [ ] **Step 4: Verify `git status -sb` and `git diff --check`, then push verified commits with `git push origin HEAD:main`.**
