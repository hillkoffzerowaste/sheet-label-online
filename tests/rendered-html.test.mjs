import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

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

test("server-renders the PDF order intake dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>PDF Order Intake<\/title>/i);
  assert.match(html, /รับ PDF คำสั่งซื้อ/);
  assert.match(html, /อัปโหลด PDF/);
  assert.match(html, /Google Drive/);
  assert.match(html, /Gemini/);
  assert.match(html, /ความมั่นใจ/);
  assert.match(html, /ตรวจ Order ID ซ้ำ/);
  assert.match(html, /ข้อมูลครบ/);
  assert.match(html, /Go to Sheet/);
  assert.match(html, /<button[^>]*disabled[^>]*>Go to Sheet<\/button>/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|react-loading-skeleton/);

  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});
