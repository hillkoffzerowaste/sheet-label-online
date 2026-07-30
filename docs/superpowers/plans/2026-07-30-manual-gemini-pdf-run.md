# Manual Gemini PDF Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** แยกการประมวลผล PDF ปกติให้ใช้ Google Drive OCR เท่านั้น และเพิ่มการเรียก Gemini แบบกดเองเป็น action แยกสำหรับ PDF แต่ละไฟล์ โดยเขียนผลลง Google Sheet อย่างปลอดภัย

**Architecture:** Apps Script จะมีสองเส้นทางชัดเจนคือ `processDriveFile(fileId)` สำหรับ OCR-only และ `processDriveFileWithGemini(fileId)` สำหรับการกด Gemini โดยตรง หน้าเว็บจะอ่านรายการ PDF จาก Google Drive ผ่าน same-origin API proxy ของ Vercel แล้วแสดงปุ่ม `รัน PDF (OCR)` และ `ใช้ Gemini` แยกกันต่อไฟล์ ผลการประมวลผลที่ OCR ไม่ครบจะยังคงอยู่ในโฟลเดอร์ Review เพื่อให้ผู้ใช้กด Gemini ซ้ำได้ โดยไม่เรียก Gemini จาก trigger อัตโนมัติ

**Tech Stack:** Next.js/Vinext, React, TypeScript, Google Apps Script, Google Drive Advanced Service, Google Sheets, Node `node:test`, Claude CLI สำหรับ review แบบอ่านอย่างเดียว

## Global Constraints

- `processInputFolder` และ `refreshNow` ห้ามเรียก Gemini ไม่ว่ากรณี OCR อ่านไม่ครบหรือไม่พบข้อมูล
- Gemini จะถูกเรียกเฉพาะเมื่อผู้ใช้กด action ที่มี `mode: "gemini"`
- Browser/client จะไม่เห็น `GEMINI_API_KEY`, Apps Script shared secret หรือ credential ใด ๆ
- การรันซ้ำต้องไม่เพิ่มแถว Shipping Labels/Orders ซ้ำ โดยใช้ duplicate protection เดิมและ file/action idempotency
- การเรียก Gemini ที่ quota เต็ม, credential ผิด หรือ transport ล้มเหลวต้องไม่ย้าย PDF ไป `Processed`
- PDF ที่ OCR อ่านไม่ครบต้องถูกเก็บไว้ในโฟลเดอร์ Review เพื่อให้เรียก Gemini ภายหลังได้
- Marketplace ที่รองรับต้องคง Shopee, Lazada และ TikTok Shop
- รอบ implementation นี้ไม่รวมการ deploy, commit หรือ push จนกว่าจะมีการอนุมัติ release แยกต่างหาก

## Current Architecture Evidence

- `app/page.tsx` มี file picker แบบ local-only; เลือกไฟล์แล้วแสดงชื่อ/ขนาด แต่ยังไม่ได้อัปโหลดหรือส่ง `fileId` ไป Apps Script
- `apps-script/Code.gs:117-133` มี `doPost` รับเพียง `fileId` และส่งต่อให้ `processDriveFile`
- `apps-script/Code.gs:135-145` ให้ time-driven trigger และ `refreshNow` เรียก `processInputFolder`
- `apps-script/Code.gs:198-279` ให้ `processDriveFile` ทำ OCR ก่อน แต่ยัง fallback ไป `exportShippingLabels_` และ `extractOrderWithGemini_` เมื่อ OCR ไม่ครบ
- `apps-script/Code.gs:517-611` มี Gemini PDF extractors และอ่าน `GEMINI_API_KEY`/`GEMINI_MODEL` จาก Script Properties อยู่แล้ว
- `apps-script/Code.gs:772-794` มี Drive OCR ผ่าน `Drive.Files.insert` และลบ temporary Google Doc ใน `finally`
- `src/workflow.ts:7` มี `ExtractionSource = "parser" | "gemini"` แต่ Apps Script ใช้ source เพิ่มคือ `drive-ocr`
- `worker/index.ts` เป็น entry ของ Vinext/Cloudflare และไม่มี API route สำหรับคุยกับ Apps Script ในปัจจุบัน

## Recommended Product Decision: Review Folder

เมื่อ OCR อ่านข้อมูลไม่ครบ ให้เขียนแถว `review` แล้วย้าย PDF ไปโฟลเดอร์ Review แทนการย้ายไป `Processed` ทันที โฟลเดอร์นี้ทำให้ไฟล์ยังมีอยู่สำหรับปุ่ม Gemini และไม่ถูก trigger OCR ซ้ำทุก 10 นาที

ตั้งค่าเป็น Script Property:

```text
REVIEW_FOLDER_ID=<Google Drive folder id สำหรับ PDF ที่ต้องตรวจสอบ>
```

รายการ PDF ที่หน้าเว็บอ่านจะแบ่งเป็น `input` และ `review` พร้อม `fileId` เดียวกันจาก Drive ผู้ใช้จึงกด `รัน PDF (OCR)` กับไฟล์ใน Input หรือกด `ใช้ Gemini` กับไฟล์ใน Review ได้โดยไม่ต้องอัปโหลดไฟล์ซ้ำ

ถ้าไม่ต้องการเพิ่มโฟลเดอร์ Review ต้องยืนยันก่อนเริ่มพัฒนา เพราะจะต้องเลือกพฤติกรรมอื่นสำหรับไฟล์ OCR ไม่ครบ เช่น เก็บไว้ใน Input พร้อมระบบ lock/dedupe หรือให้ผู้ใช้เลือกจาก Processed ซึ่งมีผลต่อ workflow และการย้ายไฟล์

---

### Task 1: Define the two processing modes and review-file lifecycle

**Files:**
- Modify: `apps-script/Code.gs:117-279`
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- `processDriveFile(fileId): ProcessingResult` — OCR-only; must never call `extractShippingLabelsWithGemini_` or `extractOrderWithGemini_`
- `processDriveFileWithGemini(fileId): ProcessingResult` — explicit Gemini path; calls existing Gemini extractors and writes results
- `moveToReview(file): void` — moves a PDF to `REVIEW_FOLDER_ID`
- `doPost(e): JsonResponse` — accepts `{ fileId: string, mode?: "ocr" | "gemini", requestId?: string, token?: string }`; missing mode defaults to `"ocr"`

- [ ] **Step 1: Add failing tests for mode isolation.** Stub OCR with incomplete text and both Gemini extractors with counters. Assert `processDriveFile` writes review-safe OCR rows, does not increment either Gemini counter, and moves the file to Review rather than Processed.

- [ ] **Step 2: Run the focused test.**

Run:

```bash
node --test tests/apps-script-gemini.test.mjs
```

Expected: the new isolation test fails because the current OCR path still calls Gemini and has no Review lifecycle.

- [ ] **Step 3: Refactor `processDriveFile` to OCR-only.** Keep the existing one-time OCR cache, build shipping-label and order candidates from OCR, persist complete rows as `ready`, persist incomplete rows as `review`, and never call either Gemini extractor. Move to Processed only after a complete result is written; move OCR-incomplete results to Review after their review rows are written.

- [ ] **Step 4: Add `processDriveFileWithGemini`.** Reuse `extractShippingLabelsWithGemini_`, `extractOrderWithGemini_`, duplicate checks, sheet writers, and result normalization. This function is the only normal code path allowed to call Gemini. If Gemini fails with quota/configuration/transport error, return a retryable result, keep the file where it is, and do not create a misleading `ready` row.

- [ ] **Step 5: Add mode routing to `doPost`.** Preserve `{fileId}` callers by treating omitted `mode` as `"ocr"`; route only exact `"gemini"` to `processDriveFileWithGemini`; reject other modes with a stable JSON error and HTTP-compatible `ok: false` response.

- [ ] **Step 6: Add request idempotency.** Accept optional `requestId`, record it in an audit column or Script Cache for the short execution window, and return the existing result when the same request is submitted twice. Keep the existing label composite dedupe as the persistent protection for retries.

- [ ] **Step 7: Run the focused tests.** Verify OCR-only, explicit Gemini, quota failure, transport failure, Review movement, Processed movement, and omitted-mode backward compatibility all pass.

- [ ] **Step 8: Commit only during the future implementation round.** Do not commit this planning round.

### Task 2: Add Drive PDF listing and protected Apps Script transport

**Files:**
- Modify: `apps-script/Code.gs:117-133`
- Create: `app/api/apps-script/route.ts`
- Create: `src/apps-script-client.ts`
- Create: `src/apps-script-client.test.ts`
- Modify: `README.md`

**Interfaces:**
- Apps Script `doGet(e): JsonResponse` supports `action=listPdfs` and returns:

```ts
type DrivePdf = {
  fileId: string;
  fileName: string;
  modifiedAt: string;
  location: "input" | "review";
  url: string;
};
```

- Same-origin Vercel route `GET /api/apps-script?action=listPdfs` returns `{ ok: true, files: DrivePdf[] }`
- Same-origin Vercel route `POST /api/apps-script` accepts `{ fileId, mode, requestId }` and returns `ProcessingResult`
- `src/apps-script-client.ts` exports:

```ts
export type PdfRunMode = "ocr" | "gemini";
export function listDrivePdfs(): Promise<DrivePdf[]>;
export function runDrivePdf(fileId: string, mode: PdfRunMode): Promise<ProcessingResult>;
```

- `APPS_SCRIPT_WEB_APP_URL` and `APPS_SCRIPT_SHARED_SECRET` are server-only Vercel environment variables; neither is exposed through `NEXT_PUBLIC_*`

- [ ] **Step 1: Add failing client tests.** Test that `listDrivePdfs()` calls the same-origin list endpoint, `runDrivePdf(fileId, "ocr")` sends the exact JSON mode, `runDrivePdf(fileId, "gemini")` sends the Gemini mode, and non-2xx/`ok:false` responses become typed errors without leaking secrets.

- [ ] **Step 2: Add Apps Script `doGet` list contract.** Enumerate PDF files from Input and Review folders, return only file ID/name/modified time/location/Drive URL, and require the shared secret for web requests. Do not return file contents or API keys.

- [ ] **Step 3: Add the Vercel same-origin proxy.** Read the server-only Apps Script URL and secret, forward only the allowed actions/modes, set JSON content type, apply a bounded timeout, and return a stable error shape. The browser must never call Apps Script directly so CORS and secrets remain server-side.

- [ ] **Step 4: Document the two environment variables and Apps Script deployment requirement.** State that the Apps Script Web App must execute as the owner, the Vercel proxy must be the only caller, and the shared secret must match in both server-side property stores.

- [ ] **Step 5: Run client tests and typecheck.**

Run:

```bash
node --import tsx --test src/apps-script-client.test.ts
npx tsc --noEmit
```

Expected: PASS with no client-side credential references.

### Task 3: Build the per-PDF UI with separate OCR and Gemini actions

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `src/workflow.ts`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- `ExtractionSource` becomes `"parser" | "drive-ocr" | "gemini"`
- UI run state is:

```ts
type PdfRunState =
  | { status: "idle" }
  | { status: "running"; mode: PdfRunMode }
  | { status: "success"; mode: PdfRunMode; message: string }
  | { status: "error"; mode: PdfRunMode; message: string };
```

- Each `DrivePdf` row renders two independent buttons:
  - `รัน PDF (OCR)` sends `mode: "ocr"`
  - `ใช้ Gemini` sends `mode: "gemini"`

- [ ] **Step 1: Add a failing rendered-page assertion.** Require the HTML to contain separate accessible labels for `รัน PDF (OCR)` and `ใช้ Gemini`, and require the page to explain that Gemini is manual and may consume quota.

- [ ] **Step 2: Add Drive PDF loading state.** On page load, call `listDrivePdfs()`, show Input/Review location, file name, modified time, and a loading/empty/error state. Keep the existing local file picker as a non-processing helper, but clearly state that an actionable run requires the PDF to exist in Drive.

- [ ] **Step 3: Add per-file action state.** Maintain a state map keyed by `fileId`, disable only the active file's two actions while its request is in flight, prevent double-click submissions, and render the returned status/source/message beside that file.

- [ ] **Step 4: Make the action distinction explicit.** The OCR button must describe automatic/parser-safe processing; the Gemini button must describe manual AI processing and quota usage. Never make the OCR button call Gemini on an error.

- [ ] **Step 5: Add accessible error and success feedback.** Use a `role="status"`/`aria-live` region per file, preserve the error message, and keep the Gemini button enabled after retryable failure. Do not display API keys, raw Google response bodies, or stack traces.

- [ ] **Step 6: Style the two actions distinctly without making Gemini look like the default path.** Keep OCR as the primary action and Gemini as a secondary warning/AI action; add responsive layout for narrow screens and visible disabled/focus states.

- [ ] **Step 7: Run the UI tests.**

Run:

```bash
npm run test:workflow
npm run build
node --test tests/rendered-html.test.mjs
```

Expected: separate actions are present in rendered HTML and no sample customer/order data is added.

### Task 4: Add Apps Script menu actions and operational observability

**Files:**
- Modify: `apps-script/Code.gs:147-195`
- Modify: `tests/apps-script-gemini.test.mjs`
- Modify: `README.md`

**Interfaces:**
- `refreshNow()` runs `processInputFolder()` in OCR-only mode
- `refreshWithGemini()` runs only explicit Gemini work and never becomes a time-driven trigger
- `onSpreadsheetOpen()` adds separate menu items:
  - `รีเฟรช PDF ตอนนี้ (OCR)` → `refreshNow`
  - `เรียก Gemini กับ PDF ใน Review` → `refreshWithGemini`

- [ ] **Step 1: Add a failing menu/trigger test.** Verify trigger setup creates only the OCR time-driven trigger and that the Gemini menu handler is not registered as a time-driven trigger.

- [ ] **Step 2: Implement `refreshWithGemini()`.** Enumerate only Review PDFs by default, process each with `processDriveFileWithGemini`, summarize ready/review/retryable counts in the spreadsheet toast, and leave retryable files in Review.

- [ ] **Step 3: Add structured logs.** Log `{fileId, fileName, mode, source, status, inserted, retryable, requestId}` without raw PDF text, API keys, addresses, or full Gemini payloads.

- [ ] **Step 4: Document the operator workflow.** Explain: wait for OCR automation; inspect Review; click `ใช้ Gemini` on one file or use the Review menu for a batch; verify Sheet rows; retry only when the result is retryable.

- [ ] **Step 5: Run the Apps Script tests.** Verify normal trigger mode never calls Gemini and explicit menu/API mode does.

### Task 5: Full verification and release gate

**Files:**
- Review all files changed by Tasks 1–4
- No additional source file is changed unless a failing verification identifies a concrete defect

- [ ] **Step 1: Run the complete test suite.**

```bash
npm test
npm run lint
git diff --check
```

- [ ] **Step 2: Run Claude CLI review in read-only mode.** Ask Claude to review the final diff against this plan and verify that normal OCR never calls Gemini, explicit Gemini mode is reachable, Review files remain retryable, secrets stay server-side, and tests cover both branches. Claude must not edit, commit, push, or deploy.

- [ ] **Step 3: Manually verify the production flow.** Use a synthetic PDF in Input, confirm OCR processing writes the Sheet and does not call Gemini; use an OCR-incomplete PDF in Review, click `ใช้ Gemini`, confirm the result and status; simulate quota failure and confirm the PDF remains in Review.

- [ ] **Step 4: Inspect the final diff and Git scope.** Confirm no PDF fixtures, credentials, customer data, `.env` files, build output, or unrelated changes are staged.

- [ ] **Step 5: Commit and deploy only after explicit approval.** This planning round does not authorize implementation, deployment, commit, or push.

## Decisions to Confirm Before Implementation

1. ยืนยันให้ใช้โฟลเดอร์ `Review` สำหรับ PDF ที่ OCR อ่านไม่ครบหรือไม่ หรือให้ไฟล์คงอยู่ใน Input/ใช้ Processed แทน
2. ยืนยันว่าเว็บต้องแสดงรายการ PDF จาก Google Drive และมีปุ่มต่อไฟล์ ไม่ใช่เพียงเลือกไฟล์จากเครื่อง เพราะ local `File` ปัจจุบันไม่มี `fileId` ที่ Apps Script ใช้ได้
3. ยืนยันให้ตั้งค่า `APPS_SCRIPT_WEB_APP_URL`, `APPS_SCRIPT_SHARED_SECRET` ใน Vercel และ secret คู่กันใน Apps Script เพื่อให้ปุ่มเว็บเรียกได้อย่างปลอดภัย
4. ยืนยันว่าการกด Gemini ต้องประมวลผลเฉพาะไฟล์ใน Review เป็นค่าเริ่มต้น หรืออนุญาตให้กดกับไฟล์ใน Input ด้วย

## Claude CLI Review Evidence

Claude Code `2.1.183` was run in read-only plan mode. Its review confirmed the current boundary problem: `processDriveFile` still falls back to Gemini, `app/page.tsx` has no Apps Script action, and `src/workflow.ts` does not include `drive-ocr` in `ExtractionSource`. The recommended split is preserved in this plan, with the Review-folder lifecycle added so manual Gemini remains possible after an OCR run.

## Implementation Status

Implemented in the current worktree:

- Apps Script OCR-only path, explicit Gemini path, `mode` routing, Review movement, shared-secret check, request cache, and structured logs.
- Drive PDF listing through Apps Script `doGet` and the Vercel same-origin `/api/apps-script` proxy.
- Per-file web actions `รัน PDF (OCR)` and `ใช้ Gemini` with independent loading/error status.
- Client, Apps Script, rendered HTML, workflow, build, lint, and no-sample-data verification.

Still required before production use:

- Create a dedicated Drive Review folder and set `REVIEW_FOLDER_ID` in Apps Script Script Properties.
- Deploy the Apps Script Web App and set matching `APPS_SCRIPT_WEB_APP_URL` and `APPS_SCRIPT_SHARED_SECRET` in Vercel/Apps Script.
- Perform one real Drive/Sheet smoke test with a synthetic PDF before release.
