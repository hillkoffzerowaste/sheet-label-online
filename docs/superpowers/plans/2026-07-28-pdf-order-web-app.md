# PDF Order Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an easy-to-use prototype web app for marketplace PDF order processing, plus an Apps Script integration skeleton.

**Architecture:** Create a lightweight React/Vite site with pure TypeScript workflow functions for marketplace detection, parser dispatch, duplicate detection, and validation. Keep UI state in the main app component and keep Apps Script code separate under `apps-script/` so frontend prototype and Google integration can evolve independently.

**Tech Stack:** React, TypeScript, Vite, Vitest, CSS, Google Apps Script JavaScript skeleton.

## Global Constraints

- The UI must be operational, not a marketing landing page.
- One main screen should cover upload, queue, processing status, and results.
- User-facing labels should be simple Thai copy for operations users.
- Required fields: Order ID, marketplace, customer name, at least one item, quantity, delivery or address summary.
- First version uses simulated PDF processing in the web app.
- Apps Script skeleton must map directly to Drive, Sheet, failed-read sheet, duplicate check, and Processed folder flow.
- Build or equivalent verification must pass.

---

## File Structure

- `package.json`: scripts and dependencies for the app.
- `index.html`: browser entry with UTF-8 metadata.
- `src/main.tsx`: React bootstrapping.
- `src/App.tsx`: dashboard UI and prototype interactions.
- `src/styles.css`: responsive app styling.
- `src/workflow.ts`: pure workflow model, sample files, parser simulation, validation.
- `src/workflow.test.ts`: Vitest tests for workflow behavior.
- `apps-script/Code.gs`: Google Apps Script skeleton for real Drive/Sheet processing.
- `README.md`: local run notes and Google Apps Script setup placeholders.

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `src/styles.css`

**Interfaces:**
- Produces: Vite app entry at `src/main.tsx`.
- Produces: placeholder `App` component exported as default from `src/App.tsx`.

- [ ] **Step 1: Create package and base files**

Create the minimal Vite React TypeScript structure with scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`

- [ ] **Step 3: Verify scaffold builds far enough to run**

Run: `npm run build`
Expected: PASS after any TypeScript setup files are present.

---

### Task 2: Workflow Logic With TDD

**Files:**
- Create: `src/workflow.test.ts`
- Create: `src/workflow.ts`

**Interfaces:**
- Produces: `detectMarketplace(text: string): Marketplace`
- Produces: `processPdfJob(fileName: string, text: string, existingOrderIds: string[]): ProcessedOrder`
- Produces: `sampleDriveFiles: PdfJob[]`
- Produces: `workflowSteps: WorkflowStep[]`

- [ ] **Step 1: Write failing tests**

Add tests for marketplace detection, successful order extraction, duplicate Order ID status, and missing required field status:

```ts
import { detectMarketplace, processPdfJob } from "./workflow";

test("detects marketplace from PDF text", () => {
  expect(detectMarketplace("Shopee Order ID SP-1001")).toBe("Shopee");
  expect(detectMarketplace("Lazada package LZD-2001")).toBe("Lazada");
  expect(detectMarketplace("TikTok Shop TTS-3001")).toBe("TikTok Shop");
  expect(detectMarketplace("random invoice")).toBe("Unknown");
});

test("extracts a complete Shopee order", () => {
  const result = processPdfJob(
    "shopee-order.pdf",
    "Shopee Order ID SP-1001 Customer: Mali Item: Phone Case Qty: 2 Address: Bangkok Total: 199",
    []
  );
  expect(result.status).toBe("ready");
  expect(result.orderId).toBe("SP-1001");
  expect(result.marketplace).toBe("Shopee");
  expect(result.items[0].name).toBe("Phone Case");
});

test("marks duplicate order ids", () => {
  const result = processPdfJob(
    "duplicate.pdf",
    "Lazada Order ID LZD-2001 Customer: Arun Item: Charger Qty: 1 Address: Chiang Mai Total: 299",
    ["LZD-2001"]
  );
  expect(result.status).toBe("duplicate");
  expect(result.reason).toContain("Order ID");
});

test("marks incomplete data when required fields are missing", () => {
  const result = processPdfJob("bad.pdf", "TikTok Shop Order ID TTS-3001 Item: Shirt", []);
  expect(result.status).toBe("incomplete");
  expect(result.missingFields).toContain("customerName");
  expect(result.missingFields).toContain("address");
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `npm test -- src/workflow.test.ts`
Expected: FAIL because `src/workflow.ts` does not exist or exports are missing.

- [ ] **Step 3: Implement workflow logic**

Implement typed marketplace detection, regex-based prototype extraction, duplicate detection, and required-field validation.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `npm test -- src/workflow.test.ts`
Expected: PASS.

---

### Task 3: Dashboard UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `processPdfJob`, `sampleDriveFiles`, and `workflowSteps` from `src/workflow.ts`.
- Produces: one-screen Thai dashboard with upload queue, workflow progress, summary, result table, and selected detail panel.

- [ ] **Step 1: Replace placeholder with dashboard**

Build the UI states:

- Empty upload area.
- Queue with uploaded PDFs and sample Drive files.
- Processing timeline with the six workflow steps.
- Results table with status chips.
- Detail panel with missing fields or duplicate reason.

- [ ] **Step 2: Add accessible interactions**

Include file input, drag-and-drop, process button, reset button, and row selection. Buttons must have clear Thai labels.

- [ ] **Step 3: Style for easy operations use**

Use compact spacing, high contrast status labels, responsive columns, and avoid landing-page hero treatment.

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: PASS.

---

### Task 4: Apps Script Skeleton And Docs

**Files:**
- Create: `apps-script/Code.gs`
- Create: `README.md`

**Interfaces:**
- Produces: Apps Script functions `doPost`, `processDriveFile`, `detectMarketplace`, `parseOrder`, `isDuplicateOrder`, `validateOrder`, `appendSuccessRow`, `appendFailedRow`, and `moveToProcessed`.
- Produces: README with local run and integration placeholders.

- [ ] **Step 1: Create Apps Script skeleton**

Include constants:

```js
const INPUT_FOLDER_ID = "PASTE_INPUT_FOLDER_ID";
const PROCESSED_FOLDER_ID = "PASTE_PROCESSED_FOLDER_ID";
const SPREADSHEET_ID = "PASTE_SPREADSHEET_ID";
const SUCCESS_SHEET_NAME = "Orders";
const FAILED_SHEET_NAME = "Read Failed";
```

- [ ] **Step 2: Map workflow branches**

Complete rows append to the success sheet. Incomplete, duplicate, unreadable, or unknown marketplace rows append to the failed-read sheet. Every handled PDF moves to Processed.

- [ ] **Step 3: Document setup**

README explains `npm install`, `npm run dev`, `npm test`, `npm run build`, and which Apps Script constants to replace.

- [ ] **Step 4: Final verification**

Run:

```bash
npm test
npm run build
```

Expected: both PASS.
