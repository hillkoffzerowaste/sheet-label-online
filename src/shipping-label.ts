export type Marketplace = "Shopee" | "Lazada" | "TikTok Shop" | "Unknown";

export type ReviewReason =
  | "marketplace"
  | "recipientName"
  | "shippingAddress"
  | "orderId"
  | "trackingNumber"
  | "duplicateOrderId"
  | "duplicateTrackingNumber";

export type ShippingLabel = {
  id: string;
  sourceFileName: string;
  marketplace: Marketplace;
  recipientName: string;
  shippingAddress: string;
  orderId: string;
  trackingNumber: string;
  status: "ready" | "review";
  reviewReasons: ReviewReason[];
};

export type LabelStatusFilter = "all" | "ready" | "review";
export type MarketplaceFilter = "all" | Marketplace;

export function parseShippingLabels(fileName: string, text: string): ShippingLabel[] {
  const segments = splitLabelSegments(text);
  const labels = segments.map((segment, index) => parseShippingLabel(fileName, segment, index));

  return markDuplicateShippingLabels(labels);
}

export function markDuplicateShippingLabels(labels: ShippingLabel[]): ShippingLabel[] {
  const duplicateOrderIds = duplicateValues(labels.map((label) => label.orderId));
  const duplicateTrackingNumbers = duplicateValues(labels.map((label) => label.trackingNumber));

  return labels.map((label) => {
    const reviewReasons = uniqueReasons([
      ...label.reviewReasons,
      ...(duplicateOrderIds.has(label.orderId) ? ["duplicateOrderId" as const] : []),
      ...(duplicateTrackingNumbers.has(label.trackingNumber)
        ? ["duplicateTrackingNumber" as const]
        : []),
    ]);

    return {
      ...label,
      reviewReasons,
      status: reviewReasons.length > 0 ? "review" : "ready",
    };
  });
}

export function filterShippingLabels(
  labels: ShippingLabel[],
  query: string,
  marketplace: MarketplaceFilter,
  status: LabelStatusFilter,
): ShippingLabel[] {
  const search = query.trim().toLowerCase();

  return labels.filter((label) => {
    const fields = [
      label.marketplace,
      label.recipientName,
      label.shippingAddress,
      label.orderId,
      label.trackingNumber,
    ].join(" ").toLowerCase();

    return (
      (marketplace === "all" || label.marketplace === marketplace) &&
      (status === "all" || label.status === status) &&
      (!search || fields.includes(search))
    );
  });
}

function splitLabelSegments(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [""];

  if (normalized.includes("--- LABEL ---")) {
    return normalized.split("--- LABEL ---").map((segment) => segment.trim()).filter(Boolean);
  }

  const trackingStarts = normalized
    .split(/(?=\bTH\d{8,}[A-Z]\b)/g)
    .map((segment) => segment.trim())
    .filter((segment) => /\bTH\d{8,}[A-Z]\b/i.test(segment));

  return trackingStarts.length > 1 ? trackingStarts : [normalized];
}

function parseShippingLabel(fileName: string, text: string, index: number): ShippingLabel {
  const marketplace = detectMarketplace(text);
  const recipientName = extractRecipient(text, marketplace);
  const shippingAddress = extractAddress(text);
  const orderId = extractOrderId(text, marketplace);
  const trackingNumber = extractTrackingNumber(text, marketplace);
  const reviewReasons = getReviewReasons({
    marketplace,
    recipientName,
    shippingAddress,
    orderId,
    trackingNumber,
  });

  return {
    id: `${fileName}-${index + 1}-${trackingNumber || orderId || "review"}`,
    sourceFileName: fileName,
    marketplace,
    recipientName,
    shippingAddress,
    orderId,
    trackingNumber,
    status: reviewReasons.length > 0 ? "review" : "ready",
    reviewReasons,
  };
}

function detectMarketplace(text: string): Marketplace {
  const normalized = text.toLowerCase();
  if (normalized.includes("shopee")) return "Shopee";
  if (normalized.includes("lazada")) return "Lazada";
  if (normalized.includes("tiktok shop") || normalized.includes("tiktok")) {
    return "TikTok Shop";
  }
  return "Unknown";
}

function extractOrderId(text: string, marketplace: Marketplace): string {
  if (marketplace === "Shopee") {
    return capture(text, /Shopee\s+Order\s+No\.?:?\s*([A-Z0-9-]+)/i);
  }
  return capture(text, /Order\s*(?:Number|No\.?|ID)\s*:?\s*([A-Z0-9-]+)/i);
}

function extractTrackingNumber(text: string, marketplace: Marketplace): string {
  const labelled = capture(text, /Tracking(?:\s+Number|\s+No\.?)?\s*:?\s*([A-Z0-9-]+)/i);
  if (labelled) return labelled;

  if (marketplace === "Shopee") {
    return capture(text, /\b(TH\d{8,}[A-Z])\b/i);
  }

  return capture(text, /\b((?:LEX|TTS)[A-Z0-9-]+)\b/i);
}

function extractRecipient(text: string, marketplace: Marketplace): string {
  if (marketplace === "Shopee") {
    return capture(text, /ผู้รับ\s*\(TO\)\s*(.*?)(?=\s+Address:|\s+เลขที่|\s+Shopee\s+Order\s+No|$)/i);
  }
  return capture(text, /Recipient\s*:?\s*(.*?)(?=\s+Address:|\s+Order\s*(?:Number|No\.?|ID)|$)/i);
}

function extractAddress(text: string): string {
  return capture(
    text,
    /Address\s*:?\s*(.*?)(?=\s+(?:Shopee\s+Order\s+No|Order\s*(?:Number|No\.?|ID)|Tracking(?:\s+Number|\s+No\.?)?)\b|$)/i,
  );
}

function getReviewReasons(value: Omit<ShippingLabel, "id" | "sourceFileName" | "status" | "reviewReasons">): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (value.marketplace === "Unknown") reasons.push("marketplace");
  if (!value.recipientName) reasons.push("recipientName");
  if (!value.shippingAddress) reasons.push("shippingAddress");
  if (!value.orderId) reasons.push("orderId");
  if (!value.trackingNumber) reasons.push("trackingNumber");
  return reasons;
}

function capture(text: string, pattern: RegExp): string {
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function duplicateValues(values: string[]): Set<string> {
  const counts = new Map<string, number>();
  values.filter(Boolean).forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return new Set([...counts].filter(([, count]) => count > 1).map(([value]) => value));
}

function uniqueReasons(reasons: ReviewReason[]): ReviewReason[] {
  return [...new Set(reasons)];
}
