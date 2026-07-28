# PDF Picker, Drive Link, and Copy Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators select PDF files locally, open the Apps Script input folder, and copy each recipient name or address from the shipping-label table.

**Architecture:** A pure TypeScript module validates the public Drive folder URL and formats file-selection metadata without retaining files. The client page keeps selected `File` objects in component state only, renders the Drive link from `NEXT_PUBLIC_INPUT_DRIVE_URL`, and reuses the existing browser clipboard interaction for name, address, and tracking values.

**Tech Stack:** TypeScript, React 19, Next.js 16/Vinext, Node test runner, ESLint, Vercel.

## Global Constraints

- The browser must not upload, parse, transmit, or persist PDF files.
- Accept multiple files only when their MIME type is `application/pdf` or their filename ends in `.pdf`, case-insensitively.
- `NEXT_PUBLIC_INPUT_DRIVE_URL` must be an HTTPS `drive.google.com` folder URL.
- Copy controls are shown only for nonempty recipient and address values and use the browser clipboard only after a click.
- Keep existing `Go to Sheet` behavior unchanged.

---

## File Structure

- Create: `src/pdf-intake.ts` — Drive URL validation and pure file-selection helpers.
- Create: `src/pdf-intake.test.ts` — tests for URL validation, eligibility, and size formatting.
- Modify: `package.json` — include the new unit test in `test:workflow`.
- Modify: `app/page.tsx` — file picker, Drive action, local selection feedback, and reusable copy controls.
- Modify: `app/globals.css` — action and selection-list styling.
- Modify: `tests/rendered-html.test.mjs` — assert static controls are present.
- Modify: `README.md` — document the new public environment variable and local-only file selection boundary.

### Task 1: Pure Drive and PDF-selection helpers

**Files:**
- Create: `src/pdf-intake.ts`
- Create: `src/pdf-intake.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `getInputDriveUrl(value)`, `isPdfFile(file)`, and `formatFileSize(bytes)`.
- `isPdfFile` consumes `{ name: string; type: string }` so it is testable without browser globals.

- [ ] **Step 1: Write failing tests**

Create `src/pdf-intake.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatFileSize, getInputDriveUrl, isPdfFile } from "./pdf-intake";

test("accepts an HTTPS Google Drive folder URL", () => {
  assert.equal(
    getInputDriveUrl("https://drive.google.com/drive/u/0/folders/folder-1"),
    "https://drive.google.com/drive/u/0/folders/folder-1",
  );
});

test("rejects missing, non-HTTPS, and non-folder Drive URLs", () => {
  assert.equal(getInputDriveUrl(undefined), null);
  assert.equal(getInputDriveUrl("http://drive.google.com/drive/folders/folder-1"), null);
  assert.equal(getInputDriveUrl("https://drive.google.com/drive/my-drive"), null);
});

test("recognizes PDF MIME types and filename fallback", () => {
  assert.equal(isPdfFile({ name: "label.pdf", type: "application/pdf" }), true);
  assert.equal(isPdfFile({ name: "label.PDF", type: "" }), true);
  assert.equal(isPdfFile({ name: "label.png", type: "image/png" }), false);
});

test("formats bytes for the file-selection list", () => {
  assert.equal(formatFileSize(512), "512 B");
  assert.equal(formatFileSize(2048), "2 KB");
  assert.equal(formatFileSize(1_572_864), "1.5 MB");
});
```

- [ ] **Step 2: Verify red**

Run: `node --import tsx --test src/pdf-intake.test.ts`  
Expected: failure because `src/pdf-intake.ts` is absent.

- [ ] **Step 3: Implement minimal helpers**

Create `src/pdf-intake.ts`:

```ts
export type FileLike = { name: string; type: string };

export function getInputDriveUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "drive.google.com" &&
      /\/folders\/[^/]+/.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function isPdfFile(file: FileLike): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
```

Add `src/pdf-intake.test.ts` to the existing `test:workflow` command in `package.json`.

- [ ] **Step 4: Verify green**

Run: `npm run test:workflow`  
Expected: all workflow, destination sheet, shipping-label, and PDF intake tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/pdf-intake.ts src/pdf-intake.test.ts package.json
git commit -m "Add PDF intake helpers"
```

### Task 2: Dashboard controls and copy actions

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: `getInputDriveUrl`, `isPdfFile`, and `formatFileSize` from `src/pdf-intake.ts`.
- Produces: local-only PDF selection feedback, an outbound Drive link, and a `copyValue` event handler.

- [ ] **Step 1: Write failing rendered-page assertions**

Add to `tests/rendered-html.test.mjs`:

```js
assert.match(html, /เลือกไฟล์ PDF/);
assert.match(html, /Go to Drive/);
assert.match(html, /คัดลอกชื่อ/);
assert.match(html, /คัดลอกที่อยู่/);
```

- [ ] **Step 2: Verify red**

Run: `npm run build && node --test tests/rendered-html.test.mjs`  
Expected: rendered HTML assertion failure because these controls do not exist.

- [ ] **Step 3: Implement the controls**

In `app/page.tsx`, import the Task 1 helpers. Read `process.env.NEXT_PUBLIC_INPUT_DRIVE_URL` through `getInputDriveUrl`. Add React state for `selectedPdfFiles: File[]`, `fileSelectionMessage: string`, and `copiedValue: string | null`.

Render in `.topbar-actions`:

```tsx
<label className="primary-button file-picker-button">
  <span>เลือกไฟล์ PDF</span>
  <input accept="application/pdf,.pdf" multiple onChange={handleFileSelection} type="file" />
</label>
```

`handleFileSelection` must use `Array.from(event.currentTarget.files ?? [])`, separate accepted and rejected entries with `isPdfFile`, replace the existing accepted selection, set an explicit Thai `aria-live` message for rejected files, and reset `event.currentTarget.value` so the same file can be chosen again. Below the header, render a `.pdf-selection-notice` only when a selection or rejection message exists. It lists accepted file names and `formatFileSize(file.size)`, and states that the file remains on the device until the operator uploads it to Drive.

Render `Go to Drive` as an external anchor when `inputDriveUrl` is valid; otherwise render a disabled button with a configuration tooltip. Use `target="_blank"` and `rel="noreferrer"` for both external links.

Replace `copyTrackingNumber` with `copyValue(value, copiedKey)` and use a key prefixed by `name:`, `address:`, or `tracking:`. Add a `คัดลอกชื่อ` button next to every nonempty recipient name, a `คัดลอกที่อยู่` button next to every nonempty address, and retain the tracking-number copy control. The clicked button displays `คัดลอกแล้ว` for 1600 ms; clipboard failure keeps the original label.

In `app/globals.css`, add `.file-picker-button`, `.file-picker-button input`, `.pdf-selection-notice`, `.pdf-selection-list`, `.copy-inline`, and mobile wrapping rules. The native input remains visually hidden but is activated by its label.

- [ ] **Step 4: Verify green**

Run: `npm run build && node --test tests/rendered-html.test.mjs`  
Expected: the four new Thai controls appear in server-rendered HTML and the existing checks remain green.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "Add PDF picker Drive link and copy controls"
```

### Task 3: Documentation, Vercel configuration, and release verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `NEXT_PUBLIC_INPUT_DRIVE_URL` configured with the approved input folder.
- Produces: operator instructions that distinguish local selection from actual Drive upload.

- [ ] **Step 1: Update documentation**

Add a `Go to Drive and PDF selection` section to `README.md` stating that the picker does not upload or send files; it only shows the local selection. Document:

```bash
NEXT_PUBLIC_INPUT_DRIVE_URL=https://drive.google.com/drive/u/0/folders/1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5
```

Explain that the operator must upload selected PDFs to that folder and the existing time-driven Apps Script trigger processes them later.

- [ ] **Step 2: Run repository verification**

Run: `npm test && npm run lint && npx next build && git diff --check`  
Expected: all commands exit successfully.

- [ ] **Step 3: Commit and push source changes**

```bash
git add README.md
git commit -m "Document PDF picker and Drive input link"
git push origin main
```

- [ ] **Step 4: Configure Vercel production and deploy**

Run the following exact commands from the repository root:

```powershell
$inputDriveUrl = 'https://drive.google.com/drive/u/0/folders/1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5'
$inputDriveUrl | vercel env add NEXT_PUBLIC_INPUT_DRIVE_URL production --scope store-hk-5474s-projects
vercel --prod --yes --scope store-hk-5474s-projects
```

If the variable already exists, remove only `NEXT_PUBLIC_INPUT_DRIVE_URL` from the production environment with `vercel env rm NEXT_PUBLIC_INPUT_DRIVE_URL production --scope store-hk-5474s-projects`, then add the value above and redeploy.

- [ ] **Step 5: Verify the production result**

Run:

```powershell
$response = Invoke-WebRequest -Uri 'https://sheet-label-online-seven.vercel.app' -UseBasicParsing
$response.StatusCode
$response.Content -match '1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5'
```

Expected: status `200` and `True` for the folder ID. Inspect the deployment with `vercel inspect sheet-label-online-seven.vercel.app --scope store-hk-5474s-projects` and confirm target `production` has status `Ready`.

## Plan Self-Review

**Spec coverage:** Task 1 covers URL validation, accepted file eligibility, and size formatting. Task 2 covers the multiple-file picker, non-PDF feedback, local-only disclosure, Drive link, and name/address copy controls. Task 3 covers the environment value, deployment, documentation, and all required verification.

**Placeholder scan:** No placeholders or undefined implementation choices remain.

**Type consistency:** The UI consumes exactly `getInputDriveUrl`, `isPdfFile`, and `formatFileSize` produced by Task 1. `copyValue` is local to the page and does not create a cross-file contract.
