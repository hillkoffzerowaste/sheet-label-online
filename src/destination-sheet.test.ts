import assert from "node:assert/strict";
import test from "node:test";
import { getDestinationSheetUrl } from "./destination-sheet";

test("accepts an HTTPS Google Sheets document URL", () => {
  assert.equal(
    getDestinationSheetUrl("https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0"),
    "https://docs.google.com/spreadsheets/d/sheet-1/edit#gid=0",
  );
});

test("uses the configured destination sheet when no environment value is present", () => {
  assert.match(getDestinationSheetUrl(undefined) ?? "", /docs\.google\.com\/spreadsheets\/d\//);
});

test("rejects non-HTTPS and non-Sheets URLs", () => {
  assert.equal(getDestinationSheetUrl("http://docs.google.com/spreadsheets/d/sheet-1"), null);
  assert.equal(getDestinationSheetUrl("https://example.com/spreadsheets/d/sheet-1"), null);
});
