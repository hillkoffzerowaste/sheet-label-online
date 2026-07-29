/** Regression test for accidental hardcoded sample data in the live dashboard. */
import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("rendered page does not contain sample order or tracking identifiers", async () => {
  const response = await render();
  const html = await response.text();

  for (const sampleValue of [
    "260728AAA111",
    "LZD-1001",
    "TTS-1001",
    "TH100000000001A",
    "LEXTH0001",
    "TTS-TRACK-1",
  ]) {
    assert.doesNotMatch(html, new RegExp(sampleValue), `sample value ${sampleValue} must not appear`);
  }
});

test("rendered page shows an empty-state placeholder when no labels are loaded", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /ยังไม่มีข้อมูลใบปะหน้า|ไม่พบรายการที่ตรงกับตัวกรอง/,
    "page must show an empty-state message when no labels are present");
});
