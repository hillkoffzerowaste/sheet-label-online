import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const codeUrl = new URL("../apps-script/Code.gs", import.meta.url);

async function loadHelpers() {
  const source = await readFile(codeUrl, "utf8");
  const forbiddenService = new Proxy({}, {
    get() {
      throw new Error("Google service must not be called in pure helper tests");
    },
  });
  const context = vm.createContext({
    console,
    DriveApp: forbiddenService,
    SpreadsheetApp: forbiddenService,
    ContentService: forbiddenService,
    PropertiesService: forbiddenService,
    UrlFetchApp: forbiddenService,
  });
  vm.runInContext(source, context, { filename: codeUrl.pathname });
  return context;
}

test("preprocesses the PDF once before Drive OCR", async () => {
  const context = await loadHelpers();

  const original = {
    getId: () => "source-id",
    getName: () => "label.pdf",
    getUrl: () => "https://drive/source",
    getBlob: () => "original-blob",
    getMimeType: () => "application/pdf",
  };
  const processed = {
    getId: () => "source-id-preprocessed",
    getName: () => "label.preprocessed.pdf",
    getUrl: () => "https://drive/source",
    getBlob: () => "preprocessed-blob",
    getMimeType: () => "application/pdf",
  };
  const seen = [];

  context.DriveApp = { getFileById: () => original };
  context.getOcrPreprocessorUrl_ = () => "https://preprocessor.example.com";
  context.preprocessPdfForOcr_ = (file) => {
    assert.equal(file.getBlob(), "original-blob");
    return processed;
  };
  context.extractTextWithDriveOcr_ = (file) => {
    seen.push(["drive-ocr", file.getName(), file.getBlob()]);
    return "Shopee\nRecipient: Mali Demo\nOrder No.: SP-1001\nTracking: TH1001\nAddress: Bangkok 10110";
  };
  context.enrichOcrWithCloudReaders_ = (file, text, labels) => {
    seen.push(["cloud-readers", file.getName(), file.getBlob(), text, labels.length]);
    return { text, labels, used: false };
  };
  context.writeShippingLabels_ = () => ({ inserted: 1 });
  context.writeOrderResult_ = () => {};
  context.isDuplicateOrder = () => false;
  context.moveToProcessed = () => {};

  const result = context.processDriveFile("source-id");

  assert.equal(result.status, "ready");
  assert.deepEqual(seen.map((entry) => entry.slice(0, 3)), [
    ["drive-ocr", "label.preprocessed.pdf", "preprocessed-blob"],
    ["cloud-readers", "label.preprocessed.pdf", "preprocessed-blob"],
  ]);
});

test("sends the source PDF to Cloud Run with the configured bearer token", async () => {
  const context = await loadHelpers();
  const requests = [];
  const blob = {
    setName(name) {
      this.name = name;
      return this;
    },
  };
  const file = {
    getId: () => "source-id",
    getName: () => "label.pdf",
    getUrl: () => "https://drive/source",
    getBlob: () => ({ getBytes: () => [1, 2, 3] }),
  };

  context.MimeType = { PDF: "application/pdf" };
  context.getOcrPreprocessorUrl_ = () => "https://preprocessor.example.com/";
  context.getOcrPreprocessorToken_ = () => "test-token";
  context.UrlFetchApp = {
    fetch: (url, options) => {
      requests.push({ url, options });
      return {
        getResponseCode: () => 200,
        getBlob: () => blob,
      };
    },
  };

  const processed = context.preprocessPdfForOcr_(file);

  assert.equal(requests[0].url, "https://preprocessor.example.com/preprocess");
  assert.equal(requests[0].options.contentType, "application/pdf");
  assert.deepEqual(requests[0].options.payload, [1, 2, 3]);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
  assert.equal(processed.getName(), "label.preprocessed.pdf");
  assert.equal(blob.name, "label.preprocessed.pdf");
});
