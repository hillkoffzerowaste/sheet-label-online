export type Marketplace = "Shopee" | "Lazada" | "TikTok Shop" | "Unknown";

export type OrderStatus = "ready" | "incomplete" | "duplicate" | "failed";

export type ExtractionSource = "parser" | "gemini";

export type MissingField =
  | "orderId"
  | "marketplace"
  | "customerName"
  | "items"
  | "quantity"
  | "address"
  | "total";

export type OrderItem = {
  name: string;
  quantity: number;
};

export type PdfJob = {
  id: string;
  fileName: string;
  source: "upload" | "drive";
  text: string;
};

export type ProcessedOrder = {
  id: string;
  fileName: string;
  marketplace: Marketplace;
  orderId: string;
  customerName: string;
  items: OrderItem[];
  address: string;
  total: number;
  status: OrderStatus;
  missingFields: MissingField[];
  source: ExtractionSource;
  confidence?: number;
  rawNotes?: string;
  reason?: string;
};

export type GeminiExtraction = {
  marketplace: string;
  orderId: string;
  customerName: string;
  items: Array<{ name: string; quantity: number; sku?: string }>;
  quantity: number;
  address: string;
  total: number;
  confidence: number;
  missingFields: string[];
  rawNotes: string;
};

export type WorkflowStep = {
  id: string;
  label: string;
  description: string;
};

export const workflowSteps: WorkflowStep[] = [
  {
    id: "read",
    label: "อ่านข้อความใน PDF",
    description: "ดึงข้อความจากไฟล์เพื่อส่งเข้า parser",
  },
  {
    id: "gemini",
    label: "Gemini อ่าน PDF",
    description: "ดึงข้อมูลคำสั่งซื้อเป็นข้อมูลโครงสร้างพร้อมค่าความเชื่อมั่น",
  },
  {
    id: "marketplace",
    label: "ตรวจช่องทาง Marketplace",
    description: "หาแหล่งที่มาของคำสั่งซื้อ",
  },
  {
    id: "parser",
    label: "เลือก Parser",
    description: "ใช้กติกาแยกข้อมูลให้ตรง marketplace",
  },
  {
    id: "extract",
    label: "แยกรายการคำสั่งซื้อ",
    description: "อ่าน Order ID ลูกค้า รายการสินค้า และยอดรวม",
  },
  {
    id: "duplicate",
    label: "ตรวจ Order ID ซ้ำ",
    description: "เทียบกับรายการที่เคยบันทึกไว้",
  },
  {
    id: "validate",
    label: "ตรวจข้อมูลครบ",
    description: "แยกข้อมูลพร้อมบันทึกกับข้อมูลที่ต้องตรวจ",
  },
];

export const sampleDriveFiles: PdfJob[] = [
  {
    id: "drive-1",
    fileName: "Shopee_SP-1001.pdf",
    source: "drive",
    text: "Shopee Order ID SP-1001 Customer: Mali Item: Phone Case Qty: 2 Address: Bangkok Total: 199",
  },
  {
    id: "drive-2",
    fileName: "Lazada_LZD-2001.pdf",
    source: "drive",
    text: "Lazada Order ID LZD-2001 Customer: Arun Item: Charger Qty: 1 Address: Chiang Mai Total: 299",
  },
  {
    id: "drive-3",
    fileName: "TikTok_missing_customer.pdf",
    source: "drive",
    text: "TikTok Shop Order ID TTS-3001 Item: Linen Shirt Qty: 1 Total: 459",
  },
];

export function detectMarketplace(text: string): Marketplace {
  const normalized = text.toLowerCase();

  if (normalized.includes("shopee")) return "Shopee";
  if (normalized.includes("lazada")) return "Lazada";
  if (normalized.includes("tiktok shop") || normalized.includes("tiktok")) {
    return "TikTok Shop";
  }

  return "Unknown";
}

export function processPdfJob(
  fileName: string,
  text: string,
  existingOrderIds: string[],
): ProcessedOrder {
  const marketplace = detectMarketplace(text);
  const orderId = readValue(text, /Order ID\s+([A-Z]{2,4}-\d+)/i);
  const customerName = readValue(text, /Customer:\s*(.*?)\s+Item:/i);
  const itemName = readValue(text, /Item:\s*(.*?)\s+Qty:/i);
  const quantityText = readValue(text, /Qty:\s*(\d+)/i);
  const address = readValue(text, /Address:\s*(.*?)\s+Total:/i);
  const totalText = readValue(text, /Total:\s*(\d+(?:\.\d+)?)/i);
  const quantity = Number(quantityText || 0);
  const total = totalText ? Number(totalText) : Number.NaN;
  const items = itemName ? [{ name: itemName, quantity }] : [];
  const missingFields = getMissingFields({
    marketplace,
    orderId,
    customerName,
    items,
    address,
    total,
  });

  if (!text.trim()) {
    return buildOrder({
      fileName,
      marketplace,
      orderId,
      customerName,
      items,
      address,
      total,
      status: "failed",
      missingFields,
      reason: "อ่าน PDF ไม่สำเร็จ",
      source: "parser",
    });
  }

  if (orderId && existingOrderIds.includes(orderId)) {
    return buildOrder({
      fileName,
      marketplace,
      orderId,
      customerName,
      items,
      address,
      total,
      status: "duplicate",
      missingFields,
      reason: `Order ID ${orderId} ซ้ำ`,
      source: "parser",
    });
  }

  if (missingFields.length > 0) {
    return buildOrder({
      fileName,
      marketplace,
      orderId,
      customerName,
      items,
      address,
      total,
      status: "incomplete",
      missingFields,
      reason: "ข้อมูลไม่ครบ",
      source: "parser",
    });
  }

  return buildOrder({
    fileName,
    marketplace,
    orderId,
    customerName,
    items,
    address,
    total,
    status: "ready",
    missingFields,
    source: "parser",
  });
}

export function normalizeGeminiExtraction(raw: unknown): GeminiExtraction {
  const value = isRecord(raw) ? raw : {};
  const items = Array.isArray(value.items)
    ? value.items
        .filter(isRecord)
        .map((item) => ({
          name: stringValue(item.name),
          quantity: numberValue(item.quantity),
          sku: stringValue(item.sku) || undefined,
        }))
        .filter((item) => item.name)
    : [];
  const itemQuantity = items.reduce(
    (sum, item) => sum + (item.quantity > 0 ? item.quantity : 0),
    0,
  );

  return {
    marketplace: normalizeMarketplace(stringValue(value.marketplace)),
    orderId: stringValue(value.orderId),
    customerName: stringValue(value.customerName),
    items,
    quantity: itemQuantity > 0 ? itemQuantity : numberValue(value.quantity),
    address: stringValue(value.address),
    total: numberValue(value.total),
    confidence: clampConfidence(value.confidence),
    missingFields: Array.isArray(value.missingFields)
      ? value.missingFields.filter((field): field is string => typeof field === "string")
      : [],
    rawNotes: stringValue(value.rawNotes),
  };
}

export function processGeminiExtraction(
  fileName: string,
  raw: unknown,
  existingOrderIds: string[],
): ProcessedOrder {
  const extraction = normalizeGeminiExtraction(raw);
  const items = extraction.items.map(({ name, quantity }) => ({ name, quantity }));
  const missingFields = uniqueMissingFields([
    ...getMissingFields({
      marketplace: extraction.marketplace as Marketplace,
      orderId: extraction.orderId,
      customerName: extraction.customerName,
      items,
      address: extraction.address,
      total: extraction.total,
    }),
    ...extraction.missingFields.filter(isMissingField),
  ]);

  if (extraction.orderId && existingOrderIds.includes(extraction.orderId)) {
    return buildOrder({
      fileName,
      marketplace: extraction.marketplace as Marketplace,
      orderId: extraction.orderId,
      customerName: extraction.customerName,
      items,
      address: extraction.address,
      total: extraction.total,
      status: "duplicate",
      missingFields,
      source: "gemini",
      confidence: extraction.confidence,
      rawNotes: extraction.rawNotes || undefined,
      reason: `Order ID ${extraction.orderId} ซ้ำ`,
    });
  }

  if (missingFields.length > 0 || extraction.confidence < 70) {
    return buildOrder({
      fileName,
      marketplace: extraction.marketplace as Marketplace,
      orderId: extraction.orderId,
      customerName: extraction.customerName,
      items,
      address: extraction.address,
      total: extraction.total,
      status: "incomplete",
      missingFields,
      source: "gemini",
      confidence: extraction.confidence,
      rawNotes: extraction.rawNotes || undefined,
      reason:
        extraction.confidence < 70
          ? "ความมั่นใจของ Gemini ต่ำ"
          : "ข้อมูลไม่ครบ",
    });
  }

  return buildOrder({
    fileName,
    marketplace: extraction.marketplace as Marketplace,
    orderId: extraction.orderId,
    customerName: extraction.customerName,
    items,
    address: extraction.address,
    total: extraction.total,
    status: "ready",
    missingFields,
    source: "gemini",
    confidence: extraction.confidence,
    rawNotes: extraction.rawNotes || undefined,
  });
}

function readValue(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function getMissingFields(order: {
  marketplace: Marketplace;
  orderId: string;
  customerName: string;
  items: OrderItem[];
  address: string;
  total: number;
}): MissingField[] {
  const missing: MissingField[] = [];
  const hasQuantity = order.items.some((item) => item.quantity > 0);

  if (!order.orderId) missing.push("orderId");
  if (order.marketplace === "Unknown") missing.push("marketplace");
  if (!order.customerName) missing.push("customerName");
  if (order.items.length === 0) missing.push("items");
  if (!hasQuantity) missing.push("quantity");
  if (!order.address) missing.push("address");
  if (!Number.isFinite(order.total) || order.total < 0) missing.push("total");

  return missing;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  if (value === "" || value === null || value === undefined) return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function clampConfidence(value: unknown): number {
  const confidence = numberValue(value);
  return Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence)))
    : 0;
}

function normalizeMarketplace(value: string): Marketplace {
  const marketplace = value.toLowerCase();

  if (marketplace === "shopee") return "Shopee";
  if (marketplace === "lazada") return "Lazada";
  if (marketplace === "tiktok shop" || marketplace === "tiktok-shop") {
    return "TikTok Shop";
  }

  return "Unknown";
}

function isMissingField(value: string): value is MissingField {
  return [
    "orderId",
    "marketplace",
    "customerName",
    "items",
    "quantity",
    "address",
    "total",
  ].includes(value);
}

function uniqueMissingFields(fields: MissingField[]): MissingField[] {
  return [...new Set(fields)];
}

function buildOrder(order: Omit<ProcessedOrder, "id">): ProcessedOrder {
  return {
    id: `${order.fileName}-${order.orderId || "unreadable"}`,
    ...order,
  };
}
