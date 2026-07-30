export type PdfRunMode = "ocr" | "gemini";

export type DrivePdf = {
  fileId: string;
  fileName: string;
  modifiedAt: string;
  location: "input" | "review";
  url: string;
};

export type ProcessingResult = {
  status: string;
  source?: string;
  fileName?: string;
  fileUrl?: string;
  reason?: string;
  message?: string;
  retryable?: boolean;
  shippingLabelsExported?: number;
};

export class AppsScriptClientError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "AppsScriptClientError";
    this.status = status;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AppsScriptClientError("Apps Script ส่งข้อมูลที่อ่านไม่ได้", response.status);
  }

  if (!response.ok) {
    throw new AppsScriptClientError(
      "Apps Script ไม่สามารถประมวลผลคำขอได้",
      response.status,
    );
  }

  if (!body || typeof body !== "object" || !("ok" in body) || body.ok !== true) {
    const message =
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : "Apps Script ปฏิเสธคำขอ";
    throw new AppsScriptClientError(message, response.status);
  }

  return body as T;
}

export async function listDrivePdfs(): Promise<DrivePdf[]> {
  const response = await fetch("/api/apps-script?action=listPdfs", {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const body = await readJson<{ ok: true; files: DrivePdf[] }>(response);
  return Array.isArray(body.files) ? body.files : [];
}

export async function runDrivePdf(
  fileId: string,
  mode: PdfRunMode,
): Promise<ProcessingResult> {
  const response = await fetch("/api/apps-script", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      fileId,
      mode,
      requestId: createRequestId(),
    }),
  });
  const body = await readJson<{ ok: true; result: ProcessingResult }>(response);
  return body.result;
}

function createRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pdf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
