# Multi-Team Folder and Sheet Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one Apps Script project for Team A and Team B while keeping each team's input, processed, review folders and destination spreadsheet completely separate.

**Architecture:** Keep one time-based trigger and store one configuration row per team in a `PDF Config` worksheet in the existing Team A spreadsheet. The trigger obtains enabled team records, locks the run, then processes each team in isolation by passing a `team` context to folder, sheet, deduplication, and file-routing functions. Team A is the first configuration row so its current folder and spreadsheet IDs remain unchanged.

**Tech Stack:** Google Apps Script V8, Google Drive/Docs OCR, Google Sheets, Document AI/Cloud Vision fallback, optional Gemini, Node.js built-in test runner.

## Global Constraints

- Do not change the existing Team A folder IDs, target spreadsheet ID, or current processing behavior during migration.
- Do not put API keys, OAuth tokens, or folder IDs for individual teams in source code.
- Keep `APPS_SCRIPT_SHARED_SECRET`, Gemini, Cloud Vision, and Document AI settings in Script Properties; only folder and destination-sheet routing belongs in `PDF Config`.
- A failure in Team B must be recorded and skipped without aborting Team A or any later enabled team.
- The existing web API must default to Team A when callers omit `teamKey`, preserving the current web app.
- Use a single 10-minute trigger; do not create one trigger per team.

---

## Proposed configuration sheet

Create a `PDF Config` worksheet in the current Team A spreadsheet with this header row:

| Enabled | Team Key | Team Name | Input Folder ID | Processed Folder ID | Review Folder ID | Destination Spreadsheet ID |
|---|---|---|---|---|---|---|
| TRUE | `team-a` | Team A | current Input ID | current Processed ID | current Review ID | current Sheet ID |
| TRUE | `team-b` | Team B | Team B Input ID | Team B Processed ID | Team B Review ID | Team B Sheet ID |

`Team Key` is immutable, lowercase, and URL-safe (`team-a`, `team-b`). It is used in logs, locks, cache keys, and optional web API requests. Folder IDs and spreadsheet IDs are validated before any file is read or moved.

## Target file structure

Keep the existing project style initially; do not split parser code only for cosmetic reasons.

- Modify: `apps-script/Code.gs`
  - Replace single-folder/single-sheet routing with a `team` context.
  - Preserve existing OCR, parser, Gemini, Cloud Vision, Document AI, and label export algorithms.
- Modify: `tests/apps-script-gemini.test.mjs`
  - Add regression coverage for configuration parsing, team isolation, failure isolation, and Team A backward compatibility.
- Modify: `apps-script/appsscript.json`
  - No new scopes are expected; retain the current Drive, Docs, Sheets, Cloud Platform, and external-request scopes.
- Create during implementation only if `Code.gs` becomes unmaintainable: `apps-script/TeamConfig.gs`
  - Own `getTeamConfigs_`, validation, and migration helpers. Do not split it out unless tests show the module boundary is useful.

## Interfaces to introduce

```javascript
// A validated configuration row.
// Returns an immutable plain object; never returns an API key.
function getTeamConfigs_() {}
// [{ key, name, inputFolderId, processedFolderId, reviewFolderId, spreadsheetId }]

function getTeamConfigByKey_(teamKey) {}
// Returns a team object or null.

function processAllTeams_() {}
// Returns [{ teamKey, status, total, ready, review, failed }].

function processTeam_(team, mode) {}
// mode is "ocr" or "gemini". Processes only team.inputFolderId or team.reviewFolderId.

function processDriveFile(fileId, requestId, team) {}
function processDriveFileWithGemini(fileId, requestId, team) {}
// Existing behavior, but every downstream sheet/folder operation uses team.

function resolveRequestedTeam_(parameters) {}
// Uses parameters.teamKey or falls back to `team-a`.
```

## Task 1: Add a tested `PDF Config` reader and migrate Team A

**Files:**
- Modify: `apps-script/Code.gs:1-3`, near existing constants and helper functions
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Consumes: current Script Properties fallback values `REVIEW_FOLDER_ID` and current Team A constants.
- Produces: `getTeamConfigs_()` and `getTeamConfigByKey_(teamKey)`.

- [ ] **Step 1: Write failing tests for configuration parsing and validation**

```javascript
test("reads two enabled teams without mixing their folder or sheet IDs", async () => {
  const context = await loadHelpers();
  context.readTeamConfigRows_ = () => [
    [true, "team-a", "Team A", "input-a", "processed-a", "review-a", "sheet-a"],
    [true, "team-b", "Team B", "input-b", "processed-b", "review-b", "sheet-b"],
  ];

  assert.deepEqual(context.getTeamConfigs_(), [
    { key: "team-a", name: "Team A", inputFolderId: "input-a", processedFolderId: "processed-a", reviewFolderId: "review-a", spreadsheetId: "sheet-a" },
    { key: "team-b", name: "Team B", inputFolderId: "input-b", processedFolderId: "processed-b", reviewFolderId: "review-b", spreadsheetId: "sheet-b" },
  ]);
});

test("rejects a configuration row with a missing destination spreadsheet", async () => {
  const context = await loadHelpers();
  context.readTeamConfigRows_ = () => [[true, "team-b", "Team B", "input-b", "processed-b", "review-b", ""]];
  assert.throws(() => context.getTeamConfigs_(), /team-b.*spreadsheet/i);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: FAIL because `getTeamConfigs_` and `readTeamConfigRows_` do not exist.

- [ ] **Step 3: Implement the minimal configuration reader**

```javascript
const TEAM_CONFIG_SHEET_NAME = "PDF Config";

function getTeamConfigs_() {
  return readTeamConfigRows_()
    .filter(function (row) { return row[0] === true; })
    .map(normalizeTeamConfigRow_)
    .filter(Boolean);
}

function normalizeTeamConfigRow_(row) {
  const team = {
    key: String(row[1] || "").trim().toLowerCase(),
    name: String(row[2] || "").trim(),
    inputFolderId: String(row[3] || "").trim(),
    processedFolderId: String(row[4] || "").trim(),
    reviewFolderId: String(row[5] || "").trim(),
    spreadsheetId: String(row[6] || "").trim(),
  };
  validateTeamConfig_(team);
  return Object.freeze(team);
}
```

`readTeamConfigRows_()` must read rows 2 onward from `PDF Config`. Before the configuration sheet is created, it must return one synthesized Team A row from existing constants and `REVIEW_FOLDER_ID`; this preserves the existing production behavior during rollout.

- [ ] **Step 4: Run focused tests and the full Apps Script test file**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: all existing tests plus the new configuration tests pass.

- [ ] **Step 5: Commit the isolated migration reader**

```powershell
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs
git commit -m "feat: read isolated team routing config"
```

### Task 2: Thread team context through OCR, sheet writing, and file routing

**Files:**
- Modify: `apps-script/Code.gs:159-190`, `253-405`, `1494-1765`
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Consumes: team objects from `getTeamConfigs_()`.
- Produces: team-aware `processDriveFile`, `processDriveFileWithGemini`, `writeShippingLabels_`, `writeOrderResult_`, `moveToProcessed`, and `moveToReview`.

- [ ] **Step 1: Write a failing isolation regression test**

```javascript
test("routes Team B output and processed file only to Team B resources", async () => {
  const context = await loadHelpers();
  const openedSheets = [];
  const movedFolders = [];
  context.SpreadsheetApp = { openById: (id) => { openedSheets.push(id); return fakeSpreadsheet(); } };
  context.DriveApp = { getFolderById: (id) => ({ id }) };
  const teamB = { key: "team-b", spreadsheetId: "sheet-b", processedFolderId: "processed-b", reviewFolderId: "review-b" };
  const file = { moveTo: (folder) => movedFolders.push(folder.id) };

  context.moveToProcessed(file, teamB);
  context.getShippingLabelsSheet_(new Date("2026-07-30"), context.SpreadsheetApp.openById(teamB.spreadsheetId));

  assert.deepEqual(movedFolders, ["processed-b"]);
  assert.deepEqual(openedSheets, ["sheet-b"]);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: FAIL because routing functions only use global IDs.

- [ ] **Step 3: Change signatures from global routing to explicit routing**

```javascript
function processDriveFile(fileId, requestId, team) {
  const activeTeam = team || getTeamConfigByKey_("team-a");
  // Existing OCR pipeline unchanged.
  // Pass activeTeam to writeShippingLabelCandidates_, finalizeOrderResult_, and failures.
}

function moveToProcessed(file, team) {
  file.moveTo(DriveApp.getFolderById(team.processedFolderId));
}

function moveToReview(file, team) {
  file.moveTo(DriveApp.getFolderById(team.reviewFolderId));
}
```

Every helper that opens a spreadsheet must take `team` or an already-open spreadsheet. No helper may silently fall back to a global spreadsheet after this task, except the temporary synthesized Team A fallback in Task 1.

- [ ] **Step 4: Add a failed-Team-B test and implement error isolation**

```javascript
test("continues with Team A when Team B configuration cannot open", async () => {
  const context = await loadHelpers();
  context.getTeamConfigs_ = () => [teamA, teamB];
  context.processTeam_ = (team) => {
    if (team.key === "team-b") throw new Error("Folder not found");
    return { teamKey: team.key, status: "ready", total: 1, ready: 1, review: 0, failed: 0 };
  };
  const results = context.processAllTeams_();
  assert.equal(results[0].status, "ready");
  assert.equal(results[1].status, "failed");
});
```

- [ ] **Step 5: Run the Apps Script test suite**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: all previous OCR/parser/deduplication tests remain green and new isolation tests pass.

- [ ] **Step 6: Commit the routing refactor**

```powershell
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs
git commit -m "feat: route PDF processing by team config"
```

### Task 3: Make one trigger process all enabled teams safely

**Files:**
- Modify: `apps-script/Code.gs:159-250`
- Modify: `tests/apps-script-gemini.test.mjs`

**Interfaces:**
- Consumes: `getTeamConfigs_()` and `processTeam_(team, mode)`.
- Produces: `processAllTeams_()`, a revised `processInputFolder()`, and a revised `refreshNow()`.

- [ ] **Step 1: Write a failing trigger/lock test**

```javascript
test("does not start a second multi-team run while a first run holds the script lock", async () => {
  const context = await loadHelpers();
  context.LockService = { getScriptLock: () => ({ tryLock: () => false }) };
  assert.throws(() => context.processAllTeams_(), /already running/i);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test tests/apps-script-gemini.test.mjs`

Expected: FAIL because no multi-team lock exists.

- [ ] **Step 3: Implement the runner with bounded error handling**

```javascript
function processAllTeams_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error("PDF processing is already running");
  try {
    return getTeamConfigs_().map(function (team) {
      try { return processTeam_(team, "ocr"); }
      catch (error) { return summarizeTeamFailure_(team, error); }
    });
  } finally {
    lock.releaseLock();
  }
}
```

`setupPdfProcessingTrigger()` continues to create one 10-minute trigger, but its handler becomes `processAllTeams_` (or `processInputFolder` delegates to it). The spreadsheet menu button calls the same runner and displays counts for all teams.

- [ ] **Step 4: Run tests and inspect the trigger list manually**

Run: `node --test tests/apps-script-gemini.test.mjs`

Manual check: Apps Script > Triggers contains exactly one time trigger for the all-team runner and one spreadsheet-open trigger.

- [ ] **Step 5: Commit the trigger change**

```powershell
git add apps-script/Code.gs tests/apps-script-gemini.test.mjs
git commit -m "feat: process all enabled teams with one trigger"
```

### Task 4: Preserve web API compatibility and optionally expose team selection

**Files:**
- Modify: `apps-script/Code.gs:117-157`, `406-433`
- Modify: `src/apps-script-client.ts` only if the web UI will select Team B
- Modify: `src/workflow.test.ts` and `src/apps-script-client.test.ts` only if the web UI changes

**Interfaces:**
- Consumes: optional HTTP field/query parameter `teamKey`.
- Produces: Team A default behavior and optional Team B requests.

- [ ] **Step 1: Write a failing compatibility test**

```javascript
test("uses Team A when doPost omits teamKey", async () => {
  const context = await loadHelpers();
  context.getTeamConfigByKey_ = (key) => key === "team-a" ? teamA : null;
  context.processDriveFile = (_fileId, _requestId, team) => ({ status: team.key === "team-a" ? "ready" : "failed" });
  const response = context.doPost({ postData: { contents: JSON.stringify({ fileId: "file-a", mode: "ocr" }) } });
  assert.match(response.getContent(), /ready/);
});
```

- [ ] **Step 2: Implement explicit selection with safe default**

```javascript
function resolveRequestedTeam_(parameters) {
  const key = String((parameters && parameters.teamKey) || "team-a").trim().toLowerCase();
  const team = getTeamConfigByKey_(key);
  if (!team) throw new Error("Unknown or disabled team: " + key);
  return team;
}
```

`doGet` and `doPost` use Team A by default. If the web page later adds a Team selector, it sends only `teamKey`; folder IDs and spreadsheet IDs never leave Apps Script.

- [ ] **Step 3: Run API and UI regression tests**

Run: `npm test`

Expected: current single-team web usage remains unchanged; explicit Team B requests cannot read Team A's folder.

- [ ] **Step 4: Commit the API compatibility change**

```powershell
git add apps-script/Code.gs src tests
git commit -m "feat: support team selection in PDF API"
```

### Task 5: Roll out Team B without risking Team A

**Files:**
- Modify: Google Sheet `PDF Config` worksheet only
- No source-code change expected in this task

**Interfaces:**
- Consumes: completed all-team runner.
- Produces: a live Team A and Team B configuration.

- [ ] **Step 1: Create the `PDF Config` sheet and enter only Team A**

Copy Team A's existing Input, Processed, Review, and destination Sheet IDs into its first row. Leave Team B disabled or absent.

- [ ] **Step 2: Run `refreshNow` and compare Team A results**

Expected: Team A reads the same input folder, writes to the same dated output tab, and routes files exactly as before.

- [ ] **Step 3: Add Team B as `Enabled = FALSE` and validate every ID**

Open each ID in Drive/Sheets, then confirm the automation owner has Editor access to all Team B folders and Sheet B.

- [ ] **Step 4: Enable Team B and run a single known PDF manually**

Expected: the resulting row appears only in Sheet B, and the PDF moves only to Team B's Processed or Review folder.

- [ ] **Step 5: Verify trigger run and rollback procedure**

Expected: one trigger run logs a separate summary for `team-a` and `team-b`.

Rollback: change Team B's `Enabled` value to `FALSE`. No Team A IDs, files, or rows are changed by that rollback.

## Verification checklist

- `node --test tests/apps-script-gemini.test.mjs`
- `npm test`
- `npm run lint`
- `git diff --check`
- Manual: Team A PDF writes only to Team A's Sheet and routes only to Team A folders.
- Manual: Team B PDF writes only to Team B's Sheet and routes only to Team B folders.
- Manual: an invalid Team B row appears in logs as a Team B failure while Team A still completes.
- Manual: rerunning an already-imported Team A or B PDF does not add duplicate rows in that team's own sheet.

## Self-review

- **Spec coverage:** Includes two folder/Sheet sets, one trigger, Team A preservation, Team B isolation, error isolation, duplicate isolation, web API backward compatibility, and a non-destructive rollback.
- **Placeholder scan:** No unresolved implementation or validation placeholders remain; each task includes interfaces, commands, expected behavior, and a concrete test.
- **Type consistency:** `team.key`, `team.inputFolderId`, `team.processedFolderId`, `team.reviewFolderId`, and `team.spreadsheetId` are used consistently across every task.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-30-multi-team-folder-sheet-routing.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
