export type Marketplace = "Shopee" | "Lazada" | "TikTok Shop" | "Unknown";

export type OrderStatus = "ready" | "incomplete" | "duplicate" | "failed";

export type MissingField =
  | "orderId"
  | "marketplace"
  | "customerName"
  | "items"
  | "quantity"
  | "address";

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
  reason?: string;
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
  const total = Number(totalText || 0);
  const items = itemName ? [{ name: itemName, quantity }] : [];
  const missingFields = getMissingFields({
    marketplace,
    orderId,
    customerName,
    items,
    address,
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
}): MissingField[] {
  const missing: MissingField[] = [];
  const hasQuantity = order.items.some((item) => item.quantity > 0);

  if (!order.orderId) missing.push("orderId");
  if (order.marketplace === "Unknown") missing.push("marketplace");
  if (!order.customerName) missing.push("customerName");
  if (order.items.length === 0) missing.push("items");
  if (!hasQuantity) missing.push("quantity");
  if (!order.address) missing.push("address");

  return missing;
}

function buildOrder(order: Omit<ProcessedOrder, "id">): ProcessedOrder {
  return {
    id: `${order.fileName}-${order.orderId || "unreadable"}`,
    ...order,
  };
}
