import assert from "node:assert/strict";
import test from "node:test";
import { formatFileSize, getInputDriveUrl, isPdfFile } from "./pdf-intake";

test("accepts an HTTPS Google Drive folder URL", () => {
  assert.equal(
    getInputDriveUrl("https://drive.google.com/drive/u/0/folders/folder-1"),
    "https://drive.google.com/drive/u/0/folders/folder-1",
  );
});

test("uses the configured input folder when no environment value is present", () => {
  assert.match(getInputDriveUrl(undefined) ?? "", /drive\.google\.com\/drive\/.*folders\//);
});

test("rejects non-HTTPS and non-folder Drive URLs", () => {
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
