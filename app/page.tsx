"use client";

import { useMemo, useState } from "react";
import {
  type PdfJob,
  type ProcessedOrder,
  type WorkflowStep,
  processGeminiExtraction,
  processPdfJob,
  sampleDriveFiles,
  workflowSteps,
} from "../src/workflow";

const existingOrderIds = ["LZD-2001"];

const statusCopy: Record<ProcessedOrder["status"], string> = {
  ready: "ข้อมูลครบ",
  incomplete: "ข้อมูลไม่ครบ",
  duplicate: "Order ID ซ้ำ",
  failed: "อ่าน PDF ไม่สำเร็จ",
};

const missingFieldCopy: Record<string, string> = {
  orderId: "Order ID",
  marketplace: "Marketplace",
  customerName: "ชื่อลูกค้า",
  items: "รายการสินค้า",
  quantity: "จำนวน",
  address: "ที่อยู่จัดส่ง",
  total: "ยอดรวม",
};

export default function Home() {
  const [jobs, setJobs] = useState<PdfJob[]>(sampleDriveFiles);
  const [results, setResults] = useState<ProcessedOrder[]>([]);
  const [activeStep, setActiveStep] = useState(-1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const selectedOrder = useMemo(
    () => results.find((order) => order.id === selectedId) ?? results[0],
    [results, selectedId],
  );

  const summary = useMemo(
    () => ({
      total: results.length,
      ready: results.filter((order) => order.status === "ready").length,
      duplicate: results.filter((order) => order.status === "duplicate").length,
      needsReview: results.filter(
        (order) => order.status === "incomplete" || order.status === "failed",
      ).length,
    }),
    [results],
  );

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;

    const nextJobs = Array.from(fileList)
      .filter((file) => file.type === "application/pdf" || file.name.endsWith(".pdf"))
      .map((file, index) => ({
        id: `upload-${Date.now()}-${index}`,
        fileName: file.name,
        source: "upload" as const,
        text: buildDemoPdfText(file.name, index),
      }));

    setJobs((current) => [...nextJobs, ...current]);
  }

  async function runProcessing() {
    setIsProcessing(true);
    setResults([]);
    setSelectedId(null);

    for (let step = 0; step < workflowSteps.length; step += 1) {
      setActiveStep(step);
      await wait(220);
    }

    const processed = jobs.map((job) =>
      processGeminiExtraction(
        job.fileName,
        buildDemoGeminiExtraction(job),
        existingOrderIds,
      ),
    );
    setResults(processed);
    setSelectedId(processed[0]?.id ?? null);
    setIsProcessing(false);
  }

  function resetBatch() {
    setJobs(sampleDriveFiles);
    setResults([]);
    setSelectedId(null);
    setActiveStep(-1);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Sheet Lable online</p>
          <h1>รับ PDF คำสั่งซื้อ</h1>
        </div>
        <div className="topbar-actions">
          <button className="ghost-button" onClick={resetBatch} type="button">
            ล้างชุดงาน
          </button>
          <button
            className="primary-button"
            disabled={jobs.length === 0 || isProcessing}
            onClick={runProcessing}
            type="button"
          >
            {isProcessing ? "กำลังประมวลผล" : "เริ่มประมวลผล"}
          </button>
        </div>
      </header>

      <section className="summary-strip" aria-label="ภาพรวมชุดงาน">
        <SummaryTile label="ไฟล์ในคิว" value={jobs.length} tone="neutral" />
        <SummaryTile label="ประมวลผลแล้ว" value={summary.total} tone="blue" />
        <SummaryTile label="ข้อมูลครบ" value={summary.ready} tone="green" />
        <SummaryTile label="ต้องตรวจ" value={summary.needsReview + summary.duplicate} tone="amber" />
      </section>

      <section className="workspace-grid">
        <div className="panel intake-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Input</p>
              <h2>อัปโหลด PDF</h2>
            </div>
            <span className="source-pill">Google Drive</span>
          </div>

          <label
            className={`dropzone ${isDragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              addFiles(event.dataTransfer.files);
            }}
          >
            <input
              accept="application/pdf,.pdf"
              aria-label="เลือกไฟล์ PDF"
              multiple
              onChange={(event) => addFiles(event.target.files)}
              type="file"
            />
            <span className="dropzone-title">เลือกไฟล์ PDF</span>
            <span className="dropzone-meta">รองรับหลายไฟล์ต่อรอบ</span>
          </label>

          <div className="queue-list" aria-label="คิวไฟล์ PDF">
            {jobs.map((job) => (
              <div className="queue-row" key={job.id}>
                <div>
                  <strong>{job.fileName}</strong>
                  <span>{job.source === "drive" ? "จาก Google Drive" : "อัปโหลดผ่าน Web App"}</span>
                </div>
                <small>{job.source === "drive" ? "รออ่าน" : "เพิ่มใหม่"}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="panel workflow-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Workflow</p>
              <h2>ขั้นตอนประมวลผล</h2>
            </div>
            <span className={`run-state ${isProcessing ? "active" : ""}`}>
              {isProcessing ? "กำลังทำงาน" : results.length > 0 ? "เสร็จสิ้น" : "พร้อมเริ่ม"}
            </span>
          </div>

          <ol className="workflow-list">
            {workflowSteps.map((step, index) => (
              <WorkflowStepRow
                activeStep={activeStep}
                index={index}
                isProcessing={isProcessing}
                key={step.id}
                step={step}
              />
            ))}
          </ol>
        </div>

        <div className="panel detail-panel">
          <div className="panel-heading">
            <div>
              <p className="section-kicker">Review</p>
              <h2>รายละเอียดรายการ</h2>
            </div>
          </div>

          {selectedOrder ? (
            <div className="detail-stack">
              <span className={`status-chip ${selectedOrder.status}`}>
                {statusCopy[selectedOrder.status]}
              </span>
              <div>
                <p className="detail-label">Order ID</p>
                <strong>{selectedOrder.orderId || "ไม่พบข้อมูล"}</strong>
              </div>
              <div>
                <p className="detail-label">Marketplace</p>
                <strong>{selectedOrder.marketplace}</strong>
              </div>
              <div>
                <p className="detail-label">ลูกค้า</p>
                <strong>{selectedOrder.customerName || "ไม่พบข้อมูล"}</strong>
              </div>
              <div>
                <p className="detail-label">รายการสินค้า</p>
                <strong>{formatItems(selectedOrder)}</strong>
              </div>
              <div>
                <p className="detail-label">ผลตรวจ</p>
                <span>
                  {selectedOrder.missingFields.length > 0
                    ? selectedOrder.missingFields
                        .map((field) => missingFieldCopy[field])
                        .join(", ")
                    : selectedOrder.reason ?? "พร้อมบันทึกลง Google Sheet"}
                </span>
              </div>
              {selectedOrder.source === "gemini" ? (
                <div className="ai-meta">
                  <p className="ai-meta-label">Gemini อ่าน PDF</p>
                  <strong>ความมั่นใจ: {formatConfidence(selectedOrder.confidence)}</strong>
                  {selectedOrder.rawNotes ? (
                    <span className="ai-meta-note">{selectedOrder.rawNotes}</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            <p className="empty-state">
              ยังไม่มีผลลัพธ์ — เมื่อ Gemini อ่านไฟล์แล้วจะแสดงความมั่นใจที่นี่
            </p>
          )}
        </div>
      </section>

      <section className="panel results-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Output</p>
            <h2>ผลลัพธ์สำหรับ Google Sheet</h2>
          </div>
          <span className="source-pill">Processed folder</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ไฟล์</th>
                <th>Marketplace</th>
                <th>Order ID</th>
                <th>ลูกค้า</th>
                <th>สินค้า</th>
                <th>ยอดรวม</th>
                <th>AI</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td className="table-empty" colSpan={8}>
                    กดเริ่มประมวลผลเพื่อดูรายการ
                  </td>
                </tr>
              ) : (
                results.map((order) => (
                  <tr
                    className={selectedOrder?.id === order.id ? "selected" : ""}
                    key={order.id}
                    onClick={() => setSelectedId(order.id)}
                  >
                    <td>{order.fileName}</td>
                    <td>{order.marketplace}</td>
                    <td>{order.orderId || "-"}</td>
                    <td>{order.customerName || "-"}</td>
                    <td>{formatItems(order)}</td>
                    <td>{order.total > 0 ? order.total.toLocaleString("th-TH") : "-"}</td>
                    <td>
                      {order.source === "gemini"
                        ? `Gemini ${formatConfidence(order.confidence)}`
                        : "Parser"}
                    </td>
                    <td>
                      <span className={`status-chip ${order.status}`}>
                        {statusCopy[order.status]}
                      </span>
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

function WorkflowStepRow({
  activeStep,
  index,
  isProcessing,
  step,
}: {
  activeStep: number;
  index: number;
  isProcessing: boolean;
  step: WorkflowStep;
}) {
  const state =
    activeStep > index || (!isProcessing && activeStep === workflowSteps.length - 1)
      ? "done"
      : activeStep === index
        ? "active"
        : "waiting";

  return (
    <li className={`workflow-row ${state}`}>
      <span className="step-number">{index + 1}</span>
      <div>
        <strong>{step.label}</strong>
        <span>{step.description}</span>
      </div>
    </li>
  );
}

function buildDemoPdfText(fileName: string, index: number) {
  const normalized = fileName.toLowerCase();

  if (normalized.includes("lazada")) {
    return `Lazada Order ID LZD-${4000 + index} Customer: Narin Item: USB Cable Qty: 3 Address: Khon Kaen Total: 180`;
  }

  if (normalized.includes("tiktok")) {
    return `TikTok Shop Order ID TTS-${5000 + index} Customer: Sirin Item: Desk Lamp Qty: 1 Address: Phuket Total: 690`;
  }

  return `Shopee Order ID SP-${6000 + index} Customer: Dara Item: Label Paper Qty: 5 Address: Bangkok Total: 550`;
}

function buildDemoGeminiExtraction(job: PdfJob) {
  const parsed = processPdfJob(job.fileName, job.text, []);
  const hasMissingFields = parsed.missingFields.length > 0;

  return {
    marketplace: parsed.marketplace.toLowerCase().replace(" ", "-"),
    orderId: parsed.orderId,
    customerName: parsed.customerName,
    items: parsed.items,
    quantity: parsed.items.reduce((sum, item) => sum + item.quantity, 0),
    address: parsed.address,
    total: parsed.total,
    confidence: hasMissingFields ? 62 : 88,
    missingFields: parsed.missingFields,
    rawNotes: hasMissingFields
      ? "Gemini พบข้อมูลที่ต้องตรวจทานก่อนบันทึก"
      : "Gemini แยกข้อมูลจาก PDF เรียบร้อย",
  };
}

function formatItems(order: ProcessedOrder) {
  if (order.items.length === 0) return "-";

  return order.items
    .map((item) => `${item.name} x${item.quantity || "-"}`)
    .join(", ");
}

function formatConfidence(confidence?: number) {
  return typeof confidence === "number" ? `${confidence}%` : "ไม่ระบุ";
}

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}
