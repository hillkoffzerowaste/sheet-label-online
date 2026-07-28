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
