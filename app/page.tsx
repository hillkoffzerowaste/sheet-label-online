"use client";

import { useMemo, useState } from "react";
import { getDestinationSheetUrl } from "../src/destination-sheet";
import {
  type Marketplace,
  type MarketplaceFilter,
  type ReviewReason,
  type ShippingLabel,
  filterShippingLabels,
} from "../src/shipping-label";

const sampleShippingLabels: ShippingLabel[] = [
  {
    id: "sample-shopee-1",
    sourceFileName: "Shopee_SPX.pdf",
    marketplace: "Shopee",
    recipientName: "มาลี ตัวอย่าง",
    shippingAddress: "ถนนทดสอบ กรุงเทพฯ 10110",
    orderId: "260728AAA111",
    trackingNumber: "TH100000000001A",
    status: "ready",
    reviewReasons: [],
  },
  {
    id: "sample-lazada-1",
    sourceFileName: "Lazada_LEX.pdf",
    marketplace: "Lazada",
    recipientName: "อรุณ ตัวอย่าง",
    shippingAddress: "อำเภอเมือง เชียงใหม่ 50000",
    orderId: "LZD-1001",
    trackingNumber: "LEXTH0001",
    status: "ready",
    reviewReasons: [],
  },
  {
    id: "sample-tiktok-1",
    sourceFileName: "TikTok_TTS.pdf",
    marketplace: "TikTok Shop",
    recipientName: "พลอย ตัวอย่าง",
    shippingAddress: "อำเภอเมือง ภูเก็ต 83000",
    orderId: "TTS-1001",
    trackingNumber: "TTS-TRACK-1",
    status: "review",
    reviewReasons: ["duplicateTrackingNumber"],
  },
  {
    id: "sample-unknown-1",
    sourceFileName: "unreadable-label.pdf",
    marketplace: "Unknown",
    recipientName: "",
    shippingAddress: "",
    orderId: "",
    trackingNumber: "",
    status: "review",
    reviewReasons: ["marketplace", "recipientName", "shippingAddress", "orderId", "trackingNumber"],
  },
];

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
  const [labelQuery, setLabelQuery] = useState("");
  const [marketplaceFilter, setMarketplaceFilter] = useState<MarketplaceFilter>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "ready" | "review">("all");
  const [copiedTrackingNumber, setCopiedTrackingNumber] = useState<string | null>(null);

  const filteredLabels = useMemo(
    () => filterShippingLabels(sampleShippingLabels, labelQuery, marketplaceFilter, statusFilter),
    [labelQuery, marketplaceFilter, statusFilter],
  );
  const summary = useMemo(
    () => ({
      total: sampleShippingLabels.length,
      ready: sampleShippingLabels.filter((label) => label.status === "ready").length,
      review: sampleShippingLabels.filter((label) => label.status === "review").length,
      marketplaces: new Set(
        sampleShippingLabels
          .filter((label) => label.marketplace !== "Unknown")
          .map((label) => label.marketplace),
      ).size,
    }),
    [],
  );

  async function copyTrackingNumber(trackingNumber: string) {
    if (!trackingNumber || !navigator.clipboard) return;

    try {
      await navigator.clipboard.writeText(trackingNumber);
      setCopiedTrackingNumber(trackingNumber);
      window.setTimeout(() => setCopiedTrackingNumber(null), 1600);
    } catch {
      setCopiedTrackingNumber(null);
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
                    ไม่พบรายการที่ตรงกับตัวกรอง
                  </td>
                </tr>
              ) : (
                filteredLabels.map((label) => (
                  <tr className={label.status === "review" ? "needs-review" : ""} key={label.id}>
                    <td>
                      <MarketplaceBadge marketplace={label.marketplace} />
                    </td>
                    <td>
                      <strong>{label.recipientName || "-"}</strong>
                      {label.status === "review" ? (
                        <span className="review-reasons">
                          ต้องตรวจสอบ: {label.reviewReasons.map((reason) => reviewReasonCopy[reason]).join(", ")}
                        </span>
                      ) : null}
                    </td>
                    <td>{label.shippingAddress || "-"}</td>
                    <td className="identifier-cell">{label.orderId || "-"}</td>
                    <td className="tracking-cell">
                      <code>{label.trackingNumber || "-"}</code>
                      {label.trackingNumber ? (
                        <button
                          aria-label={`คัดลอกเลขพัสดุ ${label.trackingNumber}`}
                          className="copy-button"
                          onClick={() => copyTrackingNumber(label.trackingNumber)}
                          type="button"
                        >
                          {copiedTrackingNumber === label.trackingNumber ? "คัดลอกแล้ว" : "คัดลอกเลขพัสดุ"}
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
