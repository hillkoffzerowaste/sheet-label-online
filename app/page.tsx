"use client";

import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { getDestinationSheetUrl } from "../src/destination-sheet";
import { formatFileSize, getInputDriveUrl, isPdfFile } from "../src/pdf-intake";
import {
  type DrivePdf,
  listDrivePdfs,
  runDrivePdf,
  type PdfRunMode,
  type ProcessingResult,
} from "../src/apps-script-client";
import {
  type Marketplace,
  type MarketplaceFilter,
  type ReviewReason,
  type ShippingLabel,
  filterShippingLabels,
} from "../src/shipping-label";

/** Labels written by Apps Script to the Google Sheet; empty until data arrives. */
const shippingLabels: ShippingLabel[] = [];

type PdfRunState =
  | { status: "idle" }
  | { status: "running"; mode: PdfRunMode }
  | { status: "success"; mode: PdfRunMode; message: string }
  | { status: "error"; mode: PdfRunMode; message: string };

const reviewReasonCopy: Record<ReviewReason, string> = {
  marketplace: "ไม่พบ Marketplace",
  recipientName: "ไม่พบชื่อผู้รับ",
  shippingAddress: "ไม่พบที่อยู่",
  orderId: "ไม่พบหมายเลขคำสั่งซื้อ",
  trackingNumber: "ไม่พบเลขพัสดุ",
  duplicateOrderId: "หมายเลขคำสั่งซื้อซ้ำ",
  duplicateTrackingNumber: "เลขพัสดุซ้ำ",
};

export default function Home() {
  const destinationSheetUrl = getDestinationSheetUrl(
    process.env.NEXT_PUBLIC_DESTINATION_SHEET_URL,
  );
  const inputDriveUrl = getInputDriveUrl(process.env.NEXT_PUBLIC_INPUT_DRIVE_URL);
  const [labelQuery, setLabelQuery] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplaceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "review">("all");
  const [selectedPdfFiles, setSelectedPdfFiles] = useState<File[]>([]);
  const [fileSelectionMessage, setFileSelectionMessage] = useState("");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [drivePdfs, setDrivePdfs] = useState<DrivePdf[]>([]);
  const [driveLoading, setDriveLoading] = useState(true);
  const [driveError, setDriveError] = useState("");
  const [pdfRunStates, setPdfRunStates] = useState<Record<string, PdfRunState>>({});

  useEffect(() => {
    let active = true;
    listDrivePdfs()
      .then((files) => {
        if (!active) return;
        setDrivePdfs(files);
        setDriveError("");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDriveError(error instanceof Error ? error.message : "โหลดรายการ PDF ไม่สำเร็จ");
      })
      .finally(() => {
        if (active) setDriveLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const filteredLabels = useMemo(
    () => filterShippingLabels(shippingLabels, labelQuery, marketplaceFilter, statusFilter),
    [labelQuery, marketplaceFilter, statusFilter],
  );
  const summary = useMemo(
    () => ({
      total: shippingLabels.length,
      ready: shippingLabels.filter((label) => label.status === "ready").length,
      review: shippingLabels.filter((label) => label.status === "review").length,
      marketplaces: new Set(
        shippingLabels
          .filter((label) => label.marketplace !== "Unknown")
          .map((label) => label.marketplace),
      ).size,
    }),
    [],
  );

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    const acceptedFiles = files.filter(isPdfFile);
    const rejectedFiles = files.filter((file) => !isPdfFile(file));

    setSelectedPdfFiles(acceptedFiles);
    setFileSelectionMessage(
      rejectedFiles.length > 0
        ? `ไม่เพิ่ม ${rejectedFiles.length} ไฟล์ เพราะรองรับเฉพาะ PDF`
        : acceptedFiles.length > 0
          ? `เลือกไฟล์ PDF แล้ว ${acceptedFiles.length} ไฟล์`
          : "ยังไม่ได้เลือกไฟล์ PDF",
    );
    event.currentTarget.value = "";
  }

  async function copyValue(value: string, copiedKey: string) {
    if (!value || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(copiedKey);
      window.setTimeout(() => setCopiedValue(null), 1600);
    } catch {
      setCopiedValue(null);
    }
  }

  async function handlePdfRun(file: DrivePdf, mode: PdfRunMode) {
    const current = pdfRunStates[file.fileId];
    if (current?.status === "running") return;

    setPdfRunStates((states) => ({
      ...states,
      [file.fileId]: { status: "running", mode },
    }));

    try {
      const result = await runDrivePdf(file.fileId, mode);
      setPdfRunStates((states) => ({
        ...states,
        [file.fileId]: {
          status: "success",
          mode,
          message: getProcessingMessage(result, mode),
        },
      }));
      setDrivePdfs((files) => files.filter((item) => item.fileId !== file.fileId || result.status !== "ready"));
    } catch (error: unknown) {
      setPdfRunStates((states) => ({
        ...states,
        [file.fileId]: {
          status: "error",
          mode,
          message: error instanceof Error ? error.message : "ประมวลผล PDF ไม่สำเร็จ",
        },
      }));
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sheet Label Online</p>
          <h1>รับ PDF คำสั่งซื้อ</h1>
          <p className="topbar-description">
            ความมั่นใจจาก Gemini ใช้เพื่อระบุรายการที่ต้องตรวจสอบ.
            ไม่ต้องอัปโหลด PDF จากหน้าเว็บ: Apps Script อ่านจาก Google Drive, ใช้ Gemini เมื่อรูปแบบไม่ชัดเจน,
            ตรวจ Order ID ซ้ำ และส่งเฉพาะข้อมูลครบหรือรายการที่ต้องตรวจสอบมายังตารางนี้
          </p>
        </div>
        <div className="topbar-actions">
          <label className="primary-button file-picker-button">
            <span>เลือกไฟล์ PDF</span>
            <input accept="application/pdf,.pdf" multiple onChange={handleFileSelection} type="file" />
          </label>
          {inputDriveUrl ? (
            <a
              aria-label="Open the Google Drive input folder in a new tab"
              className="ghost-button sheet-link"
              href={inputDriveUrl}
              rel="noreferrer"
              target="_blank"
            >
              Go to Drive
            </a>
          ) : (
            <button
              aria-label="Google Drive input folder has not been configured"
              className="ghost-button sheet-link"
              disabled
              title="Set NEXT_PUBLIC_INPUT_DRIVE_URL to enable this link"
              type="button"
            >
              Go to Drive
            </button>
          )}
          {destinationSheetUrl ? (
            <a
              aria-label="Open the destination Google Sheet in a new tab"
              className="ghost-button sheet-link"
              href={destinationSheetUrl}
              rel="noreferrer"
              target="_blank"
            >
              Go to Sheet
            </a>
          ) : (
            <button
              aria-label="Destination Google Sheet has not been configured"
              className="ghost-button sheet-link"
              disabled
              title="Set NEXT_PUBLIC_DESTINATION_SHEET_URL to enable this link"
              type="button"
            >
              Go to Sheet
            </button>
          )}
        </div>
      </header>

      {(selectedPdfFiles.length > 0 || fileSelectionMessage) ? (
        <section aria-live="polite" className="pdf-selection-notice" role="status">
          <div>
            <strong>{fileSelectionMessage}</strong>
            <p>ไฟล์ยังอยู่ในอุปกรณ์ของคุณ กรุณาอัปโหลดไปยัง Input Folder ใน Google Drive เพื่อให้ Apps Script ประมวลผลอัตโนมัติ</p>
          </div>
          {selectedPdfFiles.length > 0 ? (
            <ul className="pdf-selection-list">
              {selectedPdfFiles.map((file) => (
                <li key={`${file.name}-${file.lastModified}`}>
                  <span>{file.name}</span>
                  <small>{formatFileSize(file.size)}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="panel drive-pdfs-panel" aria-labelledby="drive-pdfs-heading">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Drive PDF Actions</p>
            <h2 id="drive-pdfs-heading">ประมวลผล PDF จาก Google Drive</h2>
          </div>
          <span className="source-pill">OCR เป็นค่าเริ่มต้น</span>
        </div>
        <div className="drive-panel-intro">
          <p>
            ปุ่ม OCR ใช้ Google Drive OCR เท่านั้น ส่วนปุ่ม Gemini เป็นการเรียกใช้แบบกดเองและอาจใช้โควต้า Gemini
          </p>
          <button
            className="ghost-button"
            onClick={() => {
              setDriveLoading(true);
              setDriveError("");
              listDrivePdfs()
                .then(setDrivePdfs)
                .catch((error: unknown) => setDriveError(error instanceof Error ? error.message : "รีเฟรชรายการไม่สำเร็จ"))
                .finally(() => setDriveLoading(false));
            }}
            type="button"
          >
            รีเฟรชรายการ PDF
          </button>
        </div>

        {driveLoading ? <p className="drive-empty">กำลังโหลดรายการ PDF จาก Drive...</p> : null}
        {!driveLoading && driveError ? <p className="drive-error" role="alert">{driveError}</p> : null}
        {!driveLoading && !driveError && drivePdfs.length === 0 ? (
          <p className="drive-empty">ยังไม่พบ PDF ใน Input หรือ Review Folder กรุณาอัปโหลดเข้า Google Drive ก่อน</p>
        ) : null}
        {!driveLoading && !driveError && drivePdfs.length > 0 ? (
          <div className="drive-pdf-list">
            {drivePdfs.map((file) => (
              <DrivePdfRow
                file={file}
                key={file.fileId}
                onRun={handlePdfRun}
                state={pdfRunStates[file.fileId] ?? { status: "idle" }}
              />
            ))}
          </div>
        ) : null}

        <div className="drive-action-guide" aria-label="ตัวเลือกการประมวลผล PDF">
          <button className="primary-button" disabled type="button">รัน PDF (OCR)</button>
          <button className="gemini-button" disabled type="button">ใช้ Gemini</button>
        </div>
      </section>

      <section className="summary-strip" aria-label="ภาพรวมใบปะหน้าจัดส่ง">
        <SummaryTile label="ใบปะหน้าที่พบ" value={summary.total} tone="neutral" />
        <SummaryTile label="ข้อมูลครบ" value={summary.ready} tone="green" />
        <SummaryTile label="ต้องตรวจ" value={summary.review} tone="amber" />
        <SummaryTile label="Marketplace" value={summary.marketplaces} tone="blue" />
      </section>

      <section className="panel labels-panel" aria-labelledby="shipping-labels-heading">
        <div className="panel-heading labels-heading">
          <div>
            <p className="section-kicker">Shipping Labels</p>
            <h2 id="shipping-labels-heading">รายการใบปะหน้า</h2>
          </div>
          <span className="source-pill">Google Drive + Gemini</span>
        </div>

        <div className="label-toolbar">
          <label className="search-field">
            <span>ค้นหารายการ</span>
            <input
              aria-label="ค้นหารายการ"
              onChange={(event) => setLabelQuery(event.target.value)}
              placeholder="ชื่อ, ที่อยู่, Order No. หรือเลขพัสดุ"
              type="search"
              value={labelQuery}
            />
          </label>
          <label className="filter-field">
            <span>Marketplace</span>
            <select
              onChange={(event) => setMarketplaceFilter(event.target.value as MarketplaceFilter)}
              value={marketplaceFilter}
            >
              <option value="all">ทั้งหมด</option>
              <option value="Shopee">Shopee</option>
              <option value="Lazada">Lazada</option>
              <option value="TikTok Shop">TikTok Shop</option>
              <option value="Unknown">Unknown</option>
            </select>
          </label>
          <label className="filter-field">
            <span>สถานะ</span>
            <select
              onChange={(event) => setStatusFilter(event.target.value as "all" | "ready" | "review")}
              value={statusFilter}
            >
              <option value="all">ทั้งหมด</option>
              <option value="ready">ข้อมูลครบ</option>
              <option value="review">ต้องตรวจสอบ</option>
            </select>
          </label>
        </div>

        <div className="table-wrap">
          <table className="shipping-label-table">
            <thead>
              <tr>
                <th>Marketplace</th>
                <th>ชื่อผู้รับ</th>
                <th>ที่อยู่จัดส่ง</th>
                <th>หมายเลขคำสั่งซื้อ</th>
                <th>เลขพัสดุ</th>
              </tr>
            </thead>
            <tbody>
              {filteredLabels.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan={5}>
                    {shippingLabels.length === 0
                      ? "ยังไม่มีข้อมูลใบปะหน้า Apps Script จะเขียนข้อมูลลง Google Sheet อัตโนมัติเมื่อประมวลผล PDF"
                      : "ไม่พบรายการที่ตรงกับตัวกรอง"}
                  </td>
                </tr>
              ) : (
                filteredLabels.map((label) => (
                  <tr className={label.status === "review" ? "needs-review" : ""} key={label.id}>
                    <td>
                      <MarketplaceBadge marketplace={label.marketplace} />
                    </td>
                    <td>
                      {label.recipientName ? (
                        <div className="copy-inline">
                          <strong>{label.recipientName}</strong>
                          <button
                            aria-label={`คัดลอกชื่อ ${label.recipientName}`}
                            className="copy-button"
                            onClick={() => copyValue(label.recipientName, `name:${label.id}`)}
                            type="button"
                          >
                            {copiedValue === `name:${label.id}` ? "คัดลอกแล้ว" : "คัดลอกชื่อ"}
                          </button>
                        </div>
                      ) : (
                        <strong>-</strong>
                      )}
                      {label.status === "review" ? (
                        <span className="review-reasons">
                          ต้องตรวจสอบ: {label.reviewReasons.map((reason) => reviewReasonCopy[reason]).join(", ")}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {label.shippingAddress ? (
                        <div className="copy-inline">
                          <span>{label.shippingAddress}</span>
                          <button
                            aria-label={`คัดลอกที่อยู่ ${label.shippingAddress}`}
                            className="copy-button"
                            onClick={() => copyValue(label.shippingAddress, `address:${label.id}`)}
                            type="button"
                          >
                            {copiedValue === `address:${label.id}` ? "คัดลอกแล้ว" : "คัดลอกที่อยู่"}
                          </button>
                        </div>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="identifier-cell">{label.orderId || "-"}</td>
                    <td className="tracking-cell">
                      <code>{label.trackingNumber || "-"}</code>
                      {label.trackingNumber ? (
                        <button
                          aria-label={`คัดลอกเลขพัสดุ ${label.trackingNumber}`}
                          className="copy-button"
                          onClick={() => copyValue(label.trackingNumber, `tracking:${label.id}`)}
                          type="button"
                        >
                          {copiedValue === `tracking:${label.id}` ? "คัดลอกแล้ว" : "คัดลอกเลขพัสดุ"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function DrivePdfRow({
  file,
  state,
  onRun,
}: {
  file: DrivePdf;
  state: PdfRunState;
  onRun: (file: DrivePdf, mode: PdfRunMode) => Promise<void>;
}) {
  const isRunning = state.status === "running";
  const statusMessage = state.status === "running"
    ? `กำลังประมวลผลด้วย ${state.mode === "gemini" ? "Gemini" : "OCR"}...`
    : state.status === "idle"
      ? "ยังไม่ได้ประมวลผล"
      : state.message;

  return (
    <article className="drive-pdf-row">
      <div className="drive-pdf-meta">
        <a href={file.url} rel="noreferrer" target="_blank">{file.fileName}</a>
        <span>{file.location === "review" ? "Review" : "Input"} · {formatDriveDate(file.modifiedAt)}</span>
      </div>
      <div className="drive-pdf-actions">
        <button
          aria-label={`รัน PDF (OCR) ${file.fileName}`}
          className="primary-button"
          disabled={isRunning}
          onClick={() => onRun(file, "ocr")}
          type="button"
        >
          รัน PDF (OCR)
        </button>
        <button
          aria-label={`ใช้ Gemini ${file.fileName}`}
          className="gemini-button"
          disabled={isRunning}
          onClick={() => onRun(file, "gemini")}
          type="button"
        >
          ใช้ Gemini
        </button>
      </div>
      <p aria-live="polite" className={`drive-pdf-status ${state.status === "error" ? "is-error" : ""}`} role="status">
        {statusMessage}
      </p>
    </article>
  );
}

function formatDriveDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "ไม่ทราบวันที่";
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getProcessingMessage(result: ProcessingResult, mode: PdfRunMode) {
  if (result.status === "ready") {
    return `${mode === "gemini" ? "Gemini" : "OCR"} เสร็จแล้ว และส่งข้อมูลเข้า Google Sheet`;
  }
  return result.reason || result.message || "ประมวลผลแล้ว แต่ต้องตรวจสอบข้อมูลใน Google Sheet";
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "blue" | "green" | "amber";
}) {
  return (
    <div className={`summary-tile ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MarketplaceBadge({ marketplace }: { marketplace: Marketplace }) {
  const className = marketplace.toLowerCase().replaceAll(" ", "-");
  return <span className={`marketplace-badge marketplace-${className}`}>{marketplace}</span>;
}
