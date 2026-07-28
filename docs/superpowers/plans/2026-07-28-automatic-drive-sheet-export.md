# Automatic Drive to Sheet Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create one managed Google Spreadsheet for PDF orders, run Drive processing automatically every ten minutes, and let the Web App open that spreadsheet through a safe `Go to Sheet` control.

**Architecture:** Apps Script owns the destination spreadsheet lifecycle in Script Properties, all PDF-to-Gemini processing, and the time-driven trigger. It processes at most ten PDF files under a script lock per invocation, retaining retryable failures for the next run. The Next.js UI has no Google credential or Sheets API access; it validates the public destination URL locally before rendering a new-tab link.

**Tech Stack:** Google Apps Script (DriveApp, SpreadsheetApp, ScriptApp, LockService, PropertiesService), Gemini REST API, Next.js 16 / React 19 / TypeScript, Node test runner, Vinext build.

## Global Constraints

- Create one spreadsheet named `PDF Order Intake` only when `DESTINATION_SPREADSHEET_ID` is absent from Apps Script Script Properties.
- The managed spreadsheet has exactly the operational tabs `Orders` and `Read Failed` with the header order stated in the approved design.
- `GEMINI_API_KEY` remains exclusively in Apps Script Script Properties; no credential may be added to the browser or repository.
- `NEXT_PUBLIC_DESTINATION_SHEET_URL` is public, must be a valid HTTPS `docs.google.com/spreadsheets` URL, and is not an API credential.
- The Apps Script operator runs spreadsheet setup and trigger installation; neither action is invoked by the Web App or Vercel deployment.
- An invocation processes at most 10 PDFs and leaves retryable failures in the input folder.

---

## File Structure

- Modify: `apps-script/Code.gs` — owns destination-sheet creation/reuse, schema verification, scheduled trigger lifecycle, locking, bounded Drive processing, and existing result writers.
- Modify: `tests/apps-script-gemini.test.mjs` — supplies deterministic Apps Script service doubles and verifies lifecycle, trigger, lock, batch, and existing Gemini contracts.
- Create: `src/destination-sheet.ts` — pure destination-sheet URL validation for reuse by the client component and Node tests.
- Create: `src/destination-sheet.test.ts` — tests valid Google Sheets URLs and rejected URL inputs.
- Modify: `app/page.tsx` — renders a `Go to Sheet` anchor only when the public URL passes validation; otherwise renders a disabled explanatory control.
- Modify: `app/globals.css` — gives links and disabled sheet controls the same compact secondary-action treatment as the existing toolbar.
- Modify: `tests/rendered-html.test.mjs` — asserts the server-rendered control is present and safe in the no-configuration state.
- Modify: `README.md` — replaces manual destination-ID setup with one-time spreadsheet and trigger installation plus the Vercel public URL configuration.

## Task 1: Managed destination spreadsheet contract

**Files:**
- Modify: `apps-script/Code.gs:1-8,365-405,477-527,611-620`
- Test: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Consumes: Apps Script `PropertiesService` and `SpreadsheetApp`.
- Produces: `setupDestinationSpreadsheet() -> { spreadsheetId: string, spreadsheetUrl: string, created: boolean }`, `resetDestinationSpreadsheet() -> void`, `getDestinationSpreadsheet_() -> Spreadsheet`, and `getSheet_(sheetName) -> Sheet`.
- Produces: constants `DESTINATION_SPREADSHEET_PROPERTY`, `DESTINATION_SPREADSHEET_NAME`, `SUCCESS_HEADERS`, and `FAILED_HEADERS` used by writers and schema checks.

- [ ] **Step 1: Write the failing lifecycle tests**

Add a stateful fake `PropertiesService` and `SpreadsheetApp` to `tests/apps-script-gemini.test.mjs`, then add these assertions after loading `Code.gs` in that fake context:

```js
test("creates and stores the managed destination spreadsheet once", async () => {
  const { context, fakes } = await loadAppsScript({ spreadsheetId: null });

  const result = context.setupDestinationSpreadsheet();

  assert.deepEqual(result, {
    spreadsheetId: "sheet-1",
    spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1",
    created: true,
  });
  assert.equal(fakes.properties.DESTINATION_SPREADSHEET_ID, "sheet-1");
  assert.deepEqual(fakes.spreadsheets[0].sheetNames(), ["Orders", "Read Failed"]);
  assert.deepEqual(fakes.spreadsheets[0].headers("Orders"), context.SUCCESS_HEADERS);
  assert.deepEqual(fakes.spreadsheets[0].headers("Read Failed"), context.FAILED_HEADERS);
});

test("reuses the stored destination and reset keeps the spreadsheet", async () => {
  const { context, fakes } = await loadAppsScript({ spreadsheetId: "sheet-1" });
  fakes.addManagedSpreadsheet("sheet-1");

  const result = context.setupDestinationSpreadsheet();
  context.resetDestinationSpreadsheet();

  assert.equal(result.created, false);
  assert.equal(fakes.properties.DESTINATION_SPREADSHEET_ID, undefined);
  assert.equal(fakes.spreadsheets.length, 1);
});

test("rejects a stored destination with a changed schema", async () => {
  const { context, fakes } = await loadAppsScript({ spreadsheetId: "sheet-1" });
  fakes.addManagedSpreadsheet("sheet-1");
  fakes.spreadsheet("sheet-1").setHeaders("Orders", ["Wrong header"]);

  assert.throws(() => context.setupDestinationSpreadsheet(), {
    name: "DestinationSchemaError",
  });
});
```

The fake `addManagedSpreadsheet(id)` helper creates both named tabs with the exact expected header values, while `setHeaders(name, headers)` replaces a fake tab's first row. This keeps the reuse test distinct from the schema-mismatch test.

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test --test-name-pattern="managed destination|stored destination" tests/apps-script-gemini.test.mjs`

Expected: FAIL because `setupDestinationSpreadsheet` and the managed-sheet constants do not exist.

- [ ] **Step 3: Add the destination constants and setup helpers**

Replace the hard-coded `SPREADSHEET_ID` constant with these declarations near the existing folder and sheet-name constants:

```js
const DESTINATION_SPREADSHEET_PROPERTY = "DESTINATION_SPREADSHEET_ID";
const DESTINATION_SPREADSHEET_NAME = "PDF Order Intake";
const SUCCESS_HEADERS = [
  "Processed At", "File Name", "Marketplace", "Order ID", "Customer", "Items",
  "Total", "Address", "File URL", "Result", "Source", "Confidence",
];
const FAILED_HEADERS = [
  "Processed At", "File Name", "Marketplace", "Order ID", "Customer", "Items",
  "Total", "Address", "File URL", "Status", "Reason", "Confidence",
  "Missing Fields", "Raw Notes",
];
```

Implement `setupDestinationSpreadsheet()` to create `SpreadsheetApp.create(DESTINATION_SPREADSHEET_NAME)` only if the property is missing, rename its first sheet to `Orders`, add `Read Failed`, initialize each empty first row with the matching header array, freeze row one, persist the ID, and return the exact object from the test. On reuse, open the stored ID, require both named tabs, and require their row-one header values to equal their respective arrays; throw `DestinationSchemaError` if the document is missing or mismatched. Implement `resetDestinationSpreadsheet()` as only `PropertiesService.getScriptProperties().deleteProperty(DESTINATION_SPREADSHEET_PROPERTY)`.

```js
function getDestinationSpreadsheet_() {
  setupDestinationSpreadsheet();
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty(
    DESTINATION_SPREADSHEET_PROPERTY,
  );
  return SpreadsheetApp.openById(spreadsheetId);
}

function getSheet_(sheetName) {
  const sheet = getDestinationSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error("Sheet not found: " + sheetName);
  return sheet;
}
```

Change `ensureGeminiAuditHeaders_()` to verify the complete managed schema instead of appending audit columns. Keep `appendSuccessRow`, `appendFailedRow`, and `isDuplicateOrder` calling `getSheet_`, so they automatically use the newly created destination.

- [ ] **Step 4: Run the Apps Script test file to verify the contract passes**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: PASS, including existing Gemini normalization/classification tests and both lifecycle tests.

- [ ] **Step 5: Commit the destination lifecycle**

```bash
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs
git commit -m "Create managed destination spreadsheet"
```

## Task 2: Automatic scheduled, locked, bounded Drive processing

**Files:**
- Modify: `apps-script/Code.gs:76-87`
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Consumes: `DriveApp`, `ScriptApp`, `LockService`, `processDriveFile(fileId)`.
- Produces: `installProcessingTrigger() -> Trigger`, `removeProcessingTrigger() -> number`, and `processInputFolder() -> Array<OrderResult>`.
- Behavior: `processInputFolder` attempts `tryLock(0)`, returns `[]` if unavailable, processes no more than `MAX_FILES_PER_RUN`, always releases the lock when acquired, and does not move retryable failures because `processDriveFile` already retains them.

- [ ] **Step 1: Write the failing scheduling and batching tests**

Extend the fake Apps Script environment with trigger records, a `newTrigger(name).timeBased().everyMinutes(minutes).create()` builder, a lock counter, and an iterator over synthetic PDF files. Add:

```js
test("installs one ten-minute processing trigger and removes only matching triggers", async () => {
  const { context, fakes } = await loadAppsScript({
    triggers: ["processInputFolder", "otherHandler", "processInputFolder"],
  });

  context.installProcessingTrigger();

  assert.deepEqual(fakes.triggerHandlers(), ["otherHandler", "processInputFolder"]);
  assert.equal(fakes.triggerByHandler("processInputFolder").minutes, 10);
});

test("skips a busy lock and processes only ten input PDFs", async () => {
  const busy = await loadAppsScript({ lockAvailable: false, pdfIds: ["a"] });
  assert.deepEqual(busy.context.processInputFolder(), []);
  assert.equal(busy.fakes.processedIds.length, 0);

  const available = await loadAppsScript({
    lockAvailable: true,
    pdfIds: Array.from({ length: 12 }, (_, index) => `pdf-${index}`),
  });
  available.context.processDriveFile = (id) => {
    available.fakes.processedIds.push(id);
    return { fileId: id };
  };

  assert.equal(available.context.processInputFolder().length, 10);
  assert.equal(available.fakes.processedIds.length, 10);
  assert.equal(available.fakes.lockReleaseCount, 1);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test --test-name-pattern="ten-minute|busy lock" tests/apps-script-gemini.test.mjs`

Expected: FAIL because the installer and bounded locking behavior do not exist.

- [ ] **Step 3: Implement the trigger and lock contract**

Add constants and functions in `apps-script/Code.gs`:

```js
const PROCESS_INPUT_HANDLER = "processInputFolder";
const PROCESS_INTERVAL_MINUTES = 10;
const MAX_FILES_PER_RUN = 10;

function removeProcessingTrigger() {
  const matching = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === PROCESS_INPUT_HANDLER;
  });
  matching.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  return matching.length;
}

function installProcessingTrigger() {
  removeProcessingTrigger();
  return ScriptApp.newTrigger(PROCESS_INPUT_HANDLER)
    .timeBased()
    .everyMinutes(PROCESS_INTERVAL_MINUTES)
    .create();
}
```

Replace `processInputFolder()` with a lock-protected iterator. It calls `LockService.getScriptLock().tryLock(0)`, returns `[]` if it cannot acquire the lock, pushes no more than ten `processDriveFile(files.next().getId())` results, and calls `lock.releaseLock()` in `finally` only after lock acquisition. It must not catch and convert errors from individual processing because `processDriveFile` already classifies retryable and terminal paths.

- [ ] **Step 4: Run the Apps Script test file to verify the scheduled behavior passes**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: PASS with trigger lifecycle, busy-lock, ten-file batch, lifecycle, and Gemini behavior covered.

- [ ] **Step 5: Commit automatic processing**

```bash
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs
git commit -m "Schedule bounded Drive PDF processing"
```

## Task 3: Safe public destination link in the Web App

**Files:**
- Create: `src/destination-sheet.ts`
- Create: `src/destination-sheet.test.ts`
- Modify: `app/page.tsx:1-117`
- Modify: `app/globals.css:79-119`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Produces: `getDestinationSheetUrl(value: string | undefined) -> string | null`.
- Consumes: `process.env.NEXT_PUBLIC_DESTINATION_SHEET_URL` in `app/page.tsx`.
- Behavior: accepts only `https://docs.google.com/spreadsheets/d/<nonempty-id>` URLs; an accepted URL renders a new-tab `Go to Sheet` anchor, and every other value renders a disabled button with an explanation.

- [ ] **Step 1: Write the failing URL validator test**

Create `src/destination-sheet.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getDestinationSheetUrl } from "./destination-sheet";

test("accepts an HTTPS Google Sheets document URL", () => {
  assert.equal(
    getDestinationSheetUrl("https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0"),
    "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0",
  );
});

test("rejects missing, non-HTTPS, and non-Sheets URLs", () => {
  assert.equal(getDestinationSheetUrl(undefined), null);
  assert.equal(getDestinationSheetUrl("http://docs.google.com/spreadsheets/d/sheet-1"), null);
  assert.equal(getDestinationSheetUrl("https://example.com/spreadsheets/d/sheet-1"), null);
});
```

Add the file to `test:workflow` in `package.json` by changing the command to `node --import tsx --test src/workflow.test.ts src/destination-sheet.test.ts`.

- [ ] **Step 2: Run the URL test to verify it fails**

Run: `node --import tsx --test src/destination-sheet.test.ts`

Expected: FAIL because `src/destination-sheet.ts` does not exist.

- [ ] **Step 3: Implement the smallest URL parser**

Create `src/destination-sheet.ts`:

```ts
export function getDestinationSheetUrl(value: string | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    const hasDocumentId = /^\/spreadsheets\/d\/[^/]+/.test(url.pathname);
    return url.protocol === "https:" && url.hostname === "docs.google.com" && hasDocumentId
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
```

Import it into `app/page.tsx`, calculate `const destinationSheetUrl = getDestinationSheetUrl(process.env.NEXT_PUBLIC_DESTINATION_SHEET_URL);`, and insert this control first in `.topbar-actions`:

```tsx
{destinationSheetUrl ? (
  <a
    aria-label="Open the destination Google Sheet in a new tab"
    className="ghost-button sheet-link"
    href={destinationSheetUrl}
    rel="noreferrer"
    target="_blank"
  >
    Go to Sheet
  </a>
) : (
  <button
    aria-label="Destination Google Sheet has not been configured"
    className="ghost-button sheet-link"
    disabled
    title="Set NEXT_PUBLIC_DESTINATION_SHEET_URL to enable this link"
    type="button"
  >
    Go to Sheet
  </button>
)}
```

Add `.sheet-link { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; }` and make `.ghost-button:disabled` visibly unavailable with `cursor: not-allowed`, neutral colors, and no hover transform.

- [ ] **Step 4: Extend the render test before running the full suite**

In `tests/rendered-html.test.mjs`, assert that the default no-environment render contains `Go to Sheet`, has a disabled button rather than a destination `href`, and does not include any `NEXT_PUBLIC_DESTINATION_SHEET_URL` value:

```js
assert.match(html, /<button[^>]*disabled[^>]*>Go to Sheet<\/button>/);
assert.doesNotMatch(html, /href="https:\/\/docs\.google\.com\/spreadsheets/);
```

- [ ] **Step 5: Run focused UI verification**

Run: `npm run test:workflow && npm run build && node --test tests/rendered-html.test.mjs`

Expected: PASS; the production build produces the rendered disabled control when no public URL is set.

- [ ] **Step 6: Commit the Go to Sheet experience**

```bash
git add package.json src/destination-sheet.ts src/destination-sheet.test.ts app/page.tsx app/globals.css tests/rendered-html.test.mjs
git commit -m "Add destination sheet link"
```

## Task 4: Operational documentation and final verification

**Files:**
- Modify: `README.md:Google Apps Script Setup, Gemini Setup, Vercel Deployment, Integration Notes`

**Interfaces:**
- Consumes: implemented public functions `setupDestinationSpreadsheet()`, `installProcessingTrigger()`, `removeProcessingTrigger()`, and public variable `NEXT_PUBLIC_DESTINATION_SHEET_URL`.
- Produces: an operator runbook that makes the automatic behavior and recovery action unambiguous.

- [ ] **Step 1: Update Apps Script setup instructions**

Remove `SPREADSHEET_ID` from the constants snippet. Tell the operator to set only input/processed folder IDs and Gemini Script Properties, run `setupDestinationSpreadsheet()` once from the Apps Script editor, record its returned `spreadsheetUrl`, then run `installProcessingTrigger()` once and grant the requested authorization. State that the trigger processes at most ten PDFs about every ten minutes, not on an exact clock.

- [ ] **Step 2: Document sheet schema and recovery**

List the two generated tabs and their exact header columns from `SUCCESS_HEADERS` and `FAILED_HEADERS`. Explain the routing policy: ready records go to `Orders`; duplicate, incomplete, low-confidence, and terminal extraction records go to `Read Failed`; retryable Gemini/configuration/sheet-write failures remain in the input folder. Explain that `resetDestinationSpreadsheet()` only clears the stored ID and does not delete a Google Spreadsheet, so it must be used only when an operator intentionally wants the next setup to create a new file.

- [ ] **Step 3: Document the Web App configuration**

Add a Vercel environment-variable example with no secrets:

```bash
NEXT_PUBLIC_DESTINATION_SHEET_URL=https://docs.google.com/spreadsheets/d/DESTINATION_SPREADSHEET_ID/edit
```

State that the operator copies the actual `spreadsheetUrl` returned by setup, redeploys after changing the variable, and configures normal Google sharing permissions independently. State explicitly that the Web App does not initiate PDF processing; Apps Script owns automatic processing.

- [ ] **Step 4: Run final automated verification**

Run:

```bash
npm test
npm run lint
npx next build
git diff --check
git status --short
```

Expected: all test/build/lint commands exit 0, `git diff --check` has no output, and status lists only intended source/test/documentation changes before staging.

- [ ] **Step 5: Commit and push the documentation and integrated work**

```bash
git add README.md
git commit -m "Document automatic Drive to Sheet setup"
git push origin codex/pdf-order-web-app
```

## Plan Self-Review

**Spec coverage:** Task 1 covers one-time creation, managed ID storage, exact `Orders`/`Read Failed` headers, no hard-coded spreadsheet ID, and reset-without-delete behavior. Task 2 covers the idempotent ten-minute trigger, lock, and ten-file limit. Task 3 covers the public validated `Go to Sheet` link and unavailable state. Task 4 covers setup, sharing, retry/terminal routing, environment configuration, and all requested verification commands.

**Placeholder scan:** No red-flag placeholder wording remains in implementation steps.

**Type consistency:** `setupDestinationSpreadsheet`, `resetDestinationSpreadsheet`, `getDestinationSpreadsheet_`, `installProcessingTrigger`, `removeProcessingTrigger`, `processInputFolder`, and `getDestinationSheetUrl` have identical names and contracts in every task where they appear. The public variable is consistently `NEXT_PUBLIC_DESTINATION_SHEET_URL` and the Script Property is consistently `DESTINATION_SPREADSHEET_ID`.
