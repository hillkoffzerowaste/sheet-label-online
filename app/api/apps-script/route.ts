import { NextResponse } from "next/server";

const allowedModes = new Set(["ocr", "gemini"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get("action") !== "listPdfs") {
    return jsonError("Unsupported action", 400);
  }

  return forwardToAppsScript("GET", "action=listPdfs");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    return jsonError("Request body is required", 400);
  }

  const payload = body as Record<string, unknown>;
  if (typeof payload.fileId !== "string" || !payload.fileId.trim()) {
    return jsonError("fileId is required", 400);
  }
  if (typeof payload.mode !== "string" || !allowedModes.has(payload.mode)) {
    return jsonError("mode must be ocr or gemini", 400);
  }

  return forwardToAppsScript("POST", "", {
    fileId: payload.fileId,
    mode: payload.mode,
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
  });
}

async function forwardToAppsScript(
  method: "GET" | "POST",
  query: string,
  body?: Record<string, unknown>,
) {
  const endpoint = process.env.APPS_SCRIPT_WEB_APP_URL;
  const secret = process.env.APPS_SCRIPT_SHARED_SECRET;
  if (!endpoint || !secret) {
    return jsonError("Apps Script integration is not configured", 503);
  }

  const target = new URL(endpoint);
  if (query) {
    new URLSearchParams(query).forEach((value, key) => target.searchParams.set(key, value));
  }
  target.searchParams.set("token", secret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(target, {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify({ ...body, token: secret }) : undefined,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonError("Apps Script returned invalid JSON", 502);
    }

    if (!response.ok || !parsed || typeof parsed !== "object" || !("ok" in parsed) || parsed.ok !== true) {
      return NextResponse.json(
        { ok: false, message: "Apps Script rejected the request" },
        { status: response.ok ? 502 : response.status },
      );
    }

    return NextResponse.json(parsed, { status: 200 });
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError"
      ? "Apps Script request timed out"
      : "Apps Script is unavailable";
    return jsonError(message, 502);
  } finally {
    clearTimeout(timeout);
  }
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, message }, { status });
}
