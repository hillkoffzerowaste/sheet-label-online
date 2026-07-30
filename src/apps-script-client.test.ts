import assert from "node:assert/strict";
import test from "node:test";
import { listDrivePdfs, runDrivePdf } from "./apps-script-client";

test("lists Drive PDFs through the same-origin endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = async (input, init) => {
    request = new Request(new URL(String(input), "http://localhost"), init);
    return new Response(JSON.stringify({ ok: true, files: [{ fileId: "f1", fileName: "one.pdf", location: "input", modifiedAt: "2026-07-30T00:00:00Z", url: "https://drive/file" }] }), { status: 200 });
  };

  try {
    const files = await listDrivePdfs();
    assert.equal(request?.url, "http://localhost/api/apps-script?action=listPdfs");
    assert.equal(files[0].fileId, "f1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sends the requested OCR or Gemini mode without credentials", async () => {
  const originalFetch = globalThis.fetch;
  let body = "";
  globalThis.fetch = async (_input, init) => {
    body = String(init?.body || "");
    return new Response(JSON.stringify({ ok: true, result: { status: "ready", source: "drive-ocr" } }), { status: 200 });
  };

  try {
    await runDrivePdf("file-1", "ocr");
    assert.equal(JSON.parse(body).mode, "ocr");
    assert.doesNotMatch(body, /API_KEY|shared_secret|token/i);

    await runDrivePdf("file-1", "gemini");
    assert.equal(JSON.parse(body).mode, "gemini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("turns Apps Script failures into a typed client error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, message: "secret must not leak" }), { status: 502 });

  try {
    await assert.rejects(() => listDrivePdfs(), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.match(String(error), /Apps Script/);
      assert.doesNotMatch(String(error), /secret must not leak/);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
