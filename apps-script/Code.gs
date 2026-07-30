const INPUT_FOLDER_ID = "1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5";
const PROCESSED_FOLDER_ID = "1SPcNx77EOtGVMWxvq0IOZDGK1rBizoJH";
const SPREADSHEET_ID = "1iXza5MJJIo1JaMIPNH8o-ReJU4nEoHHNn5JfT6fv2TU";
const SUCCESS_SHEET_NAME = "Orders";
const FAILED_SHEET_NAME = "Read Failed";
const SHIPPING_LABELS_SHEET_NAME = "Shipping Labels";
const SHIPPING_LABEL_HEADERS = [
  "Processed At",
  "Source File",
  "Marketplace",
  "Recipient Name",
  "Shipping Address",
  "Order ID",
  "Tracking Number",
  "Status",
  "Review Reasons",
  "File URL",
];
const SHIPPING_LABEL_DATE_SHEET_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_MIN_CONFIDENCE = 70;

const ORDER_EXTRACTION_PROMPT = [
  "Extract the marketplace order data from this PDF.",
  "Return only the requested JSON structure.",
  "Never guess a value. Use an empty string, empty array, or missingFields when the PDF does not contain a value.",
  "marketplace must be one of shopee, lazada, tiktok-shop, or unknown.",
  "quantity is the sum of all item quantities. total must be numeric without a currency symbol.",
  "confidence is an integer from 0 through 100.",
].join("\\n");

const GEMINI_ORDER_SCHEMA = {
  type: "object",
  properties: {
    marketplace: { type: "string" },
    orderId: { type: "string" },
    customerName: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          quantity: { type: "number" },
          sku: { type: "string" },
        },
        required: ["name", "quantity", "sku"],
      },
    },
    quantity: { type: "number" },
    address: { type: "string" },
    total: { type: "number" },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    missingFields: { type: "array", items: { type: "string" } },
    rawNotes: { type: "string" },
  },
  required: [
    "marketplace",
    "orderId",
    "customerName",
    "items",
    "quantity",
    "address",
    "total",
    "confidence",
    "missingFields",
    "rawNotes",
  ],
};

const SHIPPING_LABEL_EXTRACTION_PROMPT = [
  "Extract every marketplace shipping label from this PDF.",
  "Return one object per label, even when a page contains more than one label.",
  "Never guess: use an empty string when a value is not printed on the label.",
  "marketplace must be shopee, lazada, tiktok-shop, or unknown.",
  "For Shopee SPX labels, each Letter page may contain two physical labels.",
  "Use the visual label boundaries and return exactly one object for each physical label.",
  "For Shopee SPX, recipientName is the name in the recipient section marked ผู้รับ (TO).",
  "For Shopee SPX, shippingAddress is the recipient address directly below that name; never use the sender section marked ผู้ส่ง (FROM).",
  "For Shopee SPX, orderId is the value after Shopee Order No. (the same order may be repeated in the item table).",
  "For Shopee SPX, trackingNumber is the alphanumeric value printed below the top barcode, usually beginning with TH; do not use route, shelf, or pickup codes.",
  "Read the PDF visually when extracted text is in column order or mixes the sender and recipient lines.",
  "For TikTok Shop J&T labels, one A5 page normally contains one physical label with TikTok Shop and J&T Express branding.",
  "For TikTok Shop J&T, recipientName is the name in the section marked ถึง; shippingAddress is the large address block below it.",
  "For TikTok Shop J&T, never use the sender section marked จาก as the recipient name or address.",
  "For TikTok Shop J&T, orderId is the numeric value after Order ID: at the bottom of the label.",
  "For TikTok Shop J&T, trackingNumber is the value below the top barcode, often beginning with JTTH; ignore repeated vertical barcode text and routing codes.",
  "For Lazada LEX labels, one page normally contains one physical label with LEX branding.",
  "For Lazada LEX, recipientName is the name after Receiver: and shippingAddress is the address directly below it before Phone or Sender.",
  "For Lazada LEX, never use the Sender section or Seller Name as the recipient.",
  "For Lazada LEX, orderId is the value after LAZADA Order Number: or Order No.:.",
  "For Lazada LEX, trackingNumber is the complete alphanumeric value below the top barcode, usually beginning with LEX; do not return the standalone LEX logo text.",
].join("\\n");

const GEMINI_SHIPPING_LABEL_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      marketplace: { type: "string" },
      recipientName: { type: "string" },
      shippingAddress: { type: "string" },
      orderId: { type: "string" },
      trackingNumber: { type: "string" },
    },
    required: [
      "marketplace",
      "recipientName",
      "shippingAddress",
      "orderId",
      "trackingNumber",
    ],
  },
};

function doPost(e) {
  const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  const fileId = payload.fileId;

  if (!fileId) {
    return jsonResponse_({
      ok: false,
      message: "fileId is required",
    });
  }

  const result = processDriveFile(fileId);
  return jsonResponse_({
    ok: result.status === "ready",
    result,
  });
}

function processInputFolder() {
  const folder = DriveApp.getFolderById(INPUT_FOLDER_ID);
  const files = folder.getFilesByType(MimeType.PDF);
  const results = [];

  while (files.hasNext()) {
    results.push(processDriveFile(files.next().getId()));
  }

  return results;
}

function onSpreadsheetOpen() {
  SpreadsheetApp.getUi()
    .createMenu("PDF")
    .addItem("รีเฟรช PDF ตอนนี้", "refreshNow")
    .addToUi();
}

function refreshNow() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  spreadsheet.toast("กำลังประมวลผล PDF ใหม่...", "PDF", 5);

  try {
    const results = processInputFolder();
    const ready = results.filter(function (result) {
      return result && result.status === "ready";
    }).length;
    const review = results.length - ready;
    spreadsheet.toast(
      "รีเฟรชเสร็จแล้ว: " + results.length + " ไฟล์ | พร้อมใช้ " + ready + " | ตรวจสอบ " + review,
      "PDF",
      8,
    );
    return results;
  } catch (error) {
    spreadsheet.toast("รีเฟรชไม่สำเร็จ กรุณาตรวจ Execution log", "PDF", 8);
    throw error;
  }
}

function setupPdfProcessingTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    const handler = trigger.getHandlerFunction();
    if (
      handler === "runLabelSync" ||
      handler === "processInputFolder" ||
      handler === "onSpreadsheetOpen"
    ) {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger("processInputFolder")
    .timeBased()
    .everyMinutes(10)
    .create();
  ScriptApp.newTrigger("onSpreadsheetOpen")
    .forSpreadsheet(SPREADSHEET_ID)
    .onOpen()
    .create();
}

function processDriveFile(fileId) {
  const file = DriveApp.getFileById(fileId);

  var ocrText = null;
  var ocrFetched = false;
  var getOcrText_ = function () {
    if (!ocrFetched) {
      ocrText = extractTextWithDriveOcr_(file);
      ocrFetched = true;
    }
    return ocrText;
  };

  try {
    let shippingExport;
    try {
      shippingExport = exportShippingLabels_(file);
    } catch (error) {
      if (isGeminiQuotaProcessingError_(error)) {
        const ocrLabels = buildOcrShippingLabels_(
          file.getName(),
          file.getUrl(),
          getOcrText_(),
        );
        const ocrResult = writeShippingLabels_(ocrLabels, file.getUrl());
        shippingExport = {
          inserted:
            ocrResult && Number.isFinite(ocrResult.inserted)
              ? ocrResult.inserted
              : ocrLabels.length,
          total: ocrLabels.length,
        };
      } else if (isRetryableError_(error)) {
        throw error;
      } else {
        const reviewLabels = prepareShippingLabelsForExport_(file.getName(), []);
        const reviewResult = writeShippingLabels_(reviewLabels, file.getUrl());
        shippingExport = {
          inserted:
            reviewResult && Number.isFinite(reviewResult.inserted)
              ? reviewResult.inserted
              : reviewLabels.length,
          total: reviewLabels.length,
        };
      }
    }

    try {
      let order;
      if (ocrFetched) {
        order = buildOcrOrder_(file.getName(), file.getUrl(), getOcrText_());
      } else {
        try {
          order = extractOrderWithGemini_(file);
        } catch (error) {
          if (!isGeminiQuotaProcessingError_(error)) throw error;
          order = buildOcrOrder_(file.getName(), file.getUrl(), getOcrText_());
        }
      }

      return finalizeOrderResult_(order, file, shippingExport.inserted);
    } catch (error) {
      if (isRetryableError_(error)) {
        return buildRetryableProcessingResult_(file, error, shippingExport.inserted);
      }

      const order = buildFailedOrder_(file, error);
      order.shippingLabelsExported = shippingExport.inserted;
      writeOrderResult_(order);
      moveToProcessed(file);
      return order;
    }
  } catch (error) {
    if (isRetryableError_(error)) {
      return buildRetryableProcessingResult_(file, error, 0);
    }

    const order = buildFailedOrder_(file, error);
    writeOrderResult_(order);
    moveToProcessed(file);
    return order;
  }
}

function finalizeOrderResult_(order, file, shippingLabelsExported) {
  order.fileName = file.getName();
  order.fileUrl = file.getUrl();

  const classification = classifyGeminiOrder_(
    order,
    Boolean(order.orderId && isDuplicateOrder(order.orderId)),
  );
  order.status = classification.status;
  order.reason = classification.reason;
  order.missingFields = classification.missingFields;
  order.shippingLabelsExported = shippingLabelsExported;

  writeOrderResult_(order);
  moveToProcessed(file);
  return order;
}

function exportShippingLabels_(file) {
  const labels = prepareShippingLabelsForExport_(
    file.getName(),
    extractShippingLabelsWithGemini_(file),
  );
  const result = writeShippingLabels_(labels, file.getUrl());

  return {
    inserted: result && Number.isFinite(result.inserted) ? result.inserted : labels.length,
    total: labels.length,
  };
}

function prepareShippingLabelsForExport_(fileName, values) {
  const labels = normalizeShippingLabels_(fileName, values);
  if (labels.length > 0) return labels;

  return [
    {
      id: fileName + "-review",
      sourceFileName: fileName,
      marketplace: "Unknown",
      recipientName: "",
      shippingAddress: "",
      orderId: "",
      trackingNumber: "",
      status: "review",
      reviewReasons: [
        "marketplace",
        "recipientName",
        "shippingAddress",
        "orderId",
        "trackingNumber",
      ],
    },
  ];
}

function buildRetryableProcessingResult_(file, error, shippingLabelsExported) {
  console.error("Retryable PDF processing error", {
    fileId: file.getId ? file.getId() : "unknown",
    errorName: error && error.name,
    message: error && error.message,
  });

  return {
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    marketplace: "Unknown",
    orderId: "",
    customerName: "",
    items: [],
    total: "",
    address: "",
    source: "gemini",
    confidence: 0,
    missingFields: [],
    shippingLabelsExported,
    status: "failed",
    reason: error && error.message ? error.message : "Retryable PDF processing error",
  };
}

function buildFailedOrder_(file, error) {
  return {
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    marketplace: "Unknown",
    orderId: "",
    customerName: "",
    items: [],
    total: "",
    address: "",
    source: "gemini",
    confidence: 0,
    missingFields: [],
    status: "failed",
    reason:
      "Gemini อ่าน PDF ไม่สำเร็จ: " +
      (error && error.message ? error.message : "ไม่ทราบสาเหตุ"),
  };
}

function extractOrderWithGemini_(file) {
  if (file.getMimeType() !== MimeType.PDF) {
    throw createProcessingError_("GeminiResponseError", "ไฟล์ต้องเป็น PDF", false);
  }

  const config = getGeminiConfig_();
  const payload = {
    contents: [
      {
        parts: [
          { text: ORDER_EXTRACTION_PROMPT },
          {
            inlineData: {
              mimeType: MimeType.PDF,
              data: Utilities.base64Encode(file.getBlob().getBytes()),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: GEMINI_ORDER_SCHEMA,
    },
  };
  const endpoint =
    GEMINI_API_ROOT + encodeURIComponent(config.model) + ":generateContent";
  let response;

  try {
    response = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": config.apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (error) {
    throw createProcessingError_(
      "GeminiTransportError",
      "ไม่สามารถเชื่อมต่อ Gemini ได้",
      true,
    );
  }

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const bodyText = response.getContentText();
    if (isGeminiQuotaError_(status, bodyText)) {
      throw createProcessingError_(
        "GeminiQuotaError",
        "Gemini quota exhausted: HTTP " + status,
        true,
      );
    }
    throw createProcessingError_(
      "GeminiTransportError",
      "Gemini ตอบกลับด้วย HTTP " + status,
      true,
    );
  }

  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw createProcessingError_(
      "GeminiTransportError",
      "Gemini ส่ง response ที่อ่านไม่ได้",
      true,
    );
  }

  const text = getGeminiResponseText_(body);
  if (!text) {
    throw createProcessingError_(
      "GeminiTransportError",
      "Gemini ไม่ส่งข้อมูลคำสั่งซื้อกลับมา",
      true,
    );
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw createProcessingError_(
      "GeminiResponseError",
      "Gemini ส่ง JSON คำสั่งซื้อที่ไม่ถูกต้อง",
      false,
    );
  }

  if (!hasGeminiResponseContract_(raw)) {
    throw createProcessingError_(
      "GeminiResponseError",
      "Gemini ส่งข้อมูลที่ไม่ตรง schema",
      false,
    );
  }

  return normalizeGeminiOrder_(raw);
}

function extractShippingLabelsWithGemini_(file) {
  if (file.getMimeType() !== MimeType.PDF) {
    throw createProcessingError_("GeminiResponseError", "ไฟล์ต้องเป็น PDF", false);
  }

  const config = getGeminiConfig_();
  const payload = {
    contents: [
      {
        parts: [
          { text: SHIPPING_LABEL_EXTRACTION_PROMPT },
          {
            inlineData: {
              mimeType: MimeType.PDF,
              data: Utilities.base64Encode(file.getBlob().getBytes()),
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: GEMINI_SHIPPING_LABEL_SCHEMA,
    },
  };
  const endpoint = GEMINI_API_ROOT + encodeURIComponent(config.model) + ":generateContent";
  let response;

  try {
    response = UrlFetchApp.fetch(endpoint, {
      method: "post",
      contentType: "application/json",
      headers: { "x-goog-api-key": config.apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
  } catch (error) {
    throw createProcessingError_("GeminiTransportError", "ไม่สามารถเชื่อมต่อ Gemini ได้", true);
  }

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    const bodyText = response.getContentText();
    if (isGeminiQuotaError_(status, bodyText)) {
      throw createProcessingError_(
        "GeminiQuotaError",
        "Gemini quota exhausted: HTTP " + status,
        true,
      );
    }
    throw createProcessingError_("GeminiTransportError", "Gemini ตอบกลับด้วย HTTP " + status, true);
  }

  let body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (error) {
    throw createProcessingError_("GeminiTransportError", "Gemini ส่ง response ที่อ่านไม่ได้", true);
  }

  const text = getGeminiResponseText_(body);
  if (!text) {
    throw createProcessingError_("GeminiTransportError", "Gemini ไม่ส่งข้อมูลใบปะหน้ากลับมา", true);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw createProcessingError_("GeminiResponseError", "Gemini ส่ง JSON ใบปะหน้าที่ไม่ถูกต้อง", false);
  }

  if (!Array.isArray(raw)) {
    throw createProcessingError_("GeminiResponseError", "Gemini ส่งผลลัพธ์ใบปะหน้าเป็นรูปแบบที่ไม่ถูกต้อง", false);
  }

  return raw;
}

function getGeminiConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const apiKey = properties.getProperty("GEMINI_API_KEY");

  if (!apiKey) {
    throw createProcessingError_(
      "GeminiConfigurationError",
      "ยังไม่ได้ตั้งค่า GEMINI_API_KEY",
      true,
    );
  }

  return {
    apiKey,
    model: properties.getProperty("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL,
  };
}

function getGeminiResponseText_(body) {
  const candidates = body && body.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return "";

  const parts = candidates[0] && candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts)) return "";

  const textPart = parts.find(function (part) {
    return part && typeof part.text === "string";
  });
  return textPart && textPart.text ? textPart.text.trim() : "";
}

function hasGeminiResponseContract_(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;

  return (
    typeof raw.marketplace === "string" &&
    typeof raw.orderId === "string" &&
    typeof raw.customerName === "string" &&
    Array.isArray(raw.items) &&
    typeof raw.quantity === "number" &&
    typeof raw.address === "string" &&
    typeof raw.total === "number" &&
    typeof raw.confidence === "number" &&
    Array.isArray(raw.missingFields) &&
    typeof raw.rawNotes === "string"
  );
}

function normalizeGeminiOrder_(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const items = Array.isArray(value.items) ? value.items : [];
  const normalizedItems = items
    .map(function (item) {
      return {
        name: stringValue_(item && item.name),
        quantity: numberValue_(item && item.quantity),
      };
    })
    .filter(function (item) {
      return item.name;
    });
  const itemQuantity = normalizedItems.reduce(function (sum, item) {
    return sum + (item.quantity > 0 ? item.quantity : 0);
  }, 0);

  return {
    marketplace: normalizeMarketplace_(value.marketplace),
    orderId: stringValue_(value.orderId),
    customerName: stringValue_(value.customerName),
    items: normalizedItems,
    quantity: itemQuantity > 0 ? itemQuantity : numberValue_(value.quantity),
    address: stringValue_(value.address),
    total: numberValue_(value.total),
    confidence: clampConfidence_(value.confidence),
    missingFields: normalizeMissingFields_(value.missingFields),
    rawNotes: stringValue_(value.rawNotes),
    source: "gemini",
  };
}

function classifyGeminiOrder_(order, isDuplicate) {
  if (isDuplicate) {
    return {
      status: "duplicate",
      reason: "Order ID ซ้ำ",
      missingFields: [],
    };
  }

  const validation = validateOrder(order);
  const missingFields = uniqueValues_(validation.missingFields.concat(order.missingFields));

  if (missingFields.length > 0) {
    return {
      status: "incomplete",
      reason: "ข้อมูลไม่ครบ: " + missingFields.join(", "),
      missingFields,
    };
  }

  if (order.confidence < GEMINI_MIN_CONFIDENCE) {
    return {
      status: "incomplete",
      reason: "ความมั่นใจของ Gemini ต่ำ",
      missingFields: [],
    };
  }

  return {
    status: "ready",
    reason: "ข้อมูลครบ",
    missingFields: [],
  };
}

function writeOrderResult_(order) {
  try {
    ensureGeminiAuditHeaders_();
    if (order.status === "ready") {
      appendSuccessRow(order);
    } else {
      appendFailedRow(order);
    }
  } catch (error) {
    throw createProcessingError_(
      "SheetWriteError",
      "ไม่สามารถบันทึกผลลง Google Sheet ได้",
      true,
    );
  }
}

function ensureGeminiAuditHeaders_() {
  ensureAuditHeaders_(getSheet_(SUCCESS_SHEET_NAME), ["Source", "Confidence"]);
  ensureAuditHeaders_(getSheet_(FAILED_SHEET_NAME), [
    "Confidence",
    "Missing Fields",
    "Raw Notes",
  ]);
}

function ensureAuditHeaders_(sheet, auditHeaders) {
  const lastColumn = sheet.getLastColumn();
  const existingHeaders = lastColumn
    ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String)
    : [];
  const missingHeaders = auditHeaders.filter(function (header) {
    return existingHeaders.indexOf(header) === -1;
  });

  if (missingHeaders.length > 0) {
    sheet
      .getRange(1, lastColumn + 1, 1, missingHeaders.length)
      .setValues([missingHeaders]);
  }
}

function createProcessingError_(name, message, retryable) {
  const error = new Error(message);
  error.name = name;
  error.retryable = retryable;
  return error;
}

function isRetryableError_(error) {
  return Boolean(error && error.retryable);
}

function isGeminiQuotaProcessingError_(error) {
  return Boolean(
    error &&
      (error.name === "GeminiQuotaError" ||
        isGeminiQuotaError_(error.status, error.message)),
  );
}

function extractTextWithDriveOcr_(file) {
  var converted;
  try {
    converted = Drive.Files.insert(
      { title: "OCR-" + file.getName(), mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob(),
      { ocr: true, ocrLanguage: "th" },
    );
    return DocumentApp.openById(converted.id).getBody().getText();
  } catch (error) {
    throw createProcessingError_(
      "DriveOcrError",
      "Drive OCR ไม่สามารถแปลง PDF ได้: " + (error && error.message ? error.message : ""),
      true,
    );
  } finally {
    if (converted && converted.id) {
      try {
        DriveApp.getFileById(converted.id).setTrashed(true);
      } catch (_) {}
    }
  }
}

function detectMarketplace(text) {
  const value = String(text || "").toLowerCase();

  if (value.indexOf("shopee") >= 0) return "Shopee";
  if (value.indexOf("lazada") >= 0) return "Lazada";
  if (value.indexOf("tiktok shop") >= 0 || value.indexOf("tiktok") >= 0) {
    return "TikTok Shop";
  }

  return "Unknown";
}

function parseOrder(marketplace, text) {
  if (marketplace === "Shopee") return parseShopee_(text);
  if (marketplace === "Lazada") return parseLazada_(text);
  if (marketplace === "TikTok Shop") return parseTikTok_(text);

  return buildOrder_("Unknown", text);
}

function parseShopee_(text) {
  return buildOrder_("Shopee", text);
}

function parseLazada_(text) {
  return buildOrder_("Lazada", text);
}

function parseTikTok_(text) {
  return buildOrder_("TikTok Shop", text);
}

function buildOrder_(marketplace, text) {
  const itemName = readValue_(text, /Item:\s*(.*?)\s+Qty:/i);
  const quantity = Number(readValue_(text, /Qty:\s*(\d+)/i) || 0);

  return {
    marketplace,
    orderId: readValue_(text, /Order ID\s+([A-Z]{2,4}-\d+)/i),
    customerName: readValue_(text, /Customer:\s*(.*?)\s+Item:/i),
    items: itemName ? [{ name: itemName, quantity }] : [],
    total: readValue_(text, /Total:\s*(\d+(?:\.\d+)?)/i),
    address: readValue_(text, /Address:\s*(.*?)\s+Total:/i),
  };
}

function isDuplicateOrder(orderId) {
  const sheet = getSheet_(SUCCESS_SHEET_NAME);
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) return false;

  const orderIds = sheet.getRange(2, 4, lastRow - 1, 1).getValues().flat();
  return orderIds.indexOf(orderId) >= 0;
}

function validateOrder(order) {
  const missingFields = [];

  if (!order.orderId) missingFields.push("orderId");
  if (!order.marketplace || order.marketplace === "Unknown") {
    missingFields.push("marketplace");
  }
  if (!order.customerName) missingFields.push("customerName");
  if (!order.items || order.items.length === 0) missingFields.push("items");
  if (!order.items || !order.items.some(function (item) { return item.quantity > 0; })) {
    missingFields.push("quantity");
  }
  if (!order.address) missingFields.push("address");
  if (!Number.isFinite(Number(order.total)) || Number(order.total) < 0) {
    missingFields.push("total");
  }

  return {
    complete: missingFields.length === 0,
    missingFields,
  };
}

function appendSuccessRow(order) {
  getSheet_(SUCCESS_SHEET_NAME).appendRow([
    new Date(),
    order.fileName,
    order.marketplace,
    order.orderId,
    order.customerName,
    formatItems_(order.items),
    order.total,
    order.address,
    order.fileUrl,
    "ข้อมูลครบ",
    order.source || "parser",
    Number.isFinite(order.confidence) ? order.confidence : "",
  ]);
}

function appendFailedRow(order) {
  getSheet_(FAILED_SHEET_NAME).appendRow([
    new Date(),
    order.fileName,
    order.marketplace,
    order.orderId,
    order.customerName,
    formatItems_(order.items),
    order.total,
    order.address,
    order.fileUrl,
    order.status,
    order.reason,
    Number.isFinite(order.confidence) ? order.confidence : "",
    (order.missingFields || []).join(", "),
    order.rawNotes || "",
  ]);
}

function normalizeShippingLabels_(fileName, values) {
  const labels = (Array.isArray(values) ? values : []).map(function (value, index) {
    const marketplace = normalizeMarketplace_(value && value.marketplace);
    const label = {
      id: fileName + "-" + (index + 1),
      sourceFileName: fileName,
      marketplace,
      recipientName: stringValue_(value && value.recipientName),
      shippingAddress: stringValue_(value && value.shippingAddress),
      orderId: stringValue_(value && value.orderId),
      trackingNumber: stringValue_(value && value.trackingNumber),
      status: "ready",
      reviewReasons: [],
    };
    label.reviewReasons = getShippingLabelReviewReasons_(label);
    label.status = label.reviewReasons.length > 0 ? "review" : "ready";
    return label;
  });

  const duplicateOrderIds = duplicateShippingLabelValues_(labels, "orderId");
  const duplicateTrackingNumbers = duplicateShippingLabelValues_(labels, "trackingNumber");

  return labels.map(function (label) {
    if (duplicateOrderIds.indexOf(label.orderId) >= 0) {
      label.reviewReasons.push("duplicateOrderId");
    }
    if (duplicateTrackingNumbers.indexOf(label.trackingNumber) >= 0) {
      label.reviewReasons.push("duplicateTrackingNumber");
    }
    label.reviewReasons = uniqueValues_(label.reviewReasons);
    label.status = label.reviewReasons.length > 0 ? "review" : "ready";
    return label;
  });
}

function getShippingLabelReviewReasons_(label) {
  const reasons = [];
  if (label.marketplace === "Unknown") reasons.push("marketplace");
  if (!label.recipientName) reasons.push("recipientName");
  if (!label.shippingAddress) reasons.push("shippingAddress");
  if (!label.orderId) reasons.push("orderId");
  if (!label.trackingNumber) reasons.push("trackingNumber");
  return reasons;
}

function duplicateShippingLabelValues_(labels, fieldName) {
  const counts = {};
  labels.forEach(function (label) {
    const value = label[fieldName];
    if (value) counts[value] = (counts[value] || 0) + 1;
  });
  return Object.keys(counts).filter(function (value) {
    return counts[value] > 1;
  });
}

function writeShippingLabels_(labels, fileUrl) {
  try {
    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = getShippingLabelsSheet_(new Date(), spreadsheet);
    const lastRow = sheet.getLastRow();
    const existingRows = getExistingShippingLabelRows_(spreadsheet);
    const newLabels = filterNewShippingLabels_(labels, existingRows);
    const rows = newLabels.map(function (label) {
      return [
        new Date(),
        label.sourceFileName,
        label.marketplace,
        label.recipientName,
        label.shippingAddress,
        label.orderId,
        label.trackingNumber,
        label.status,
        label.reviewReasons.join(", "),
        fileUrl,
      ];
    });

    if (rows.length > 0) {
      sheet
        .getRange(lastRow + 1, 1, rows.length, SHIPPING_LABEL_HEADERS.length)
        .setValues(rows);
    }

    return {
      inserted: rows.length,
      skipped: labels.length - rows.length,
    };
  } catch (error) {
    throw createProcessingError_(
      "SheetWriteError",
      "ไม่สามารถบันทึกใบปะหน้าลง Google Sheet ได้",
      true,
    );
  }
}

function filterNewShippingLabels_(labels, existingRows) {
  const existingKeys = {};
  (existingRows || []).forEach(function (row) {
    existingKeys[
      shippingLabelRowKey_(row[1], row[5], row[6], row[3], row[4])
    ] = true;
  });

  return (labels || []).filter(function (label) {
    const key = shippingLabelRowKey_(
      label.sourceFileName,
      label.orderId,
      label.trackingNumber,
      label.recipientName,
      label.shippingAddress,
    );
    if (existingKeys[key]) return false;

    existingKeys[key] = true;
    return true;
  });
}

function shippingLabelRowKey_(fileName, orderId, trackingNumber, recipientName, shippingAddress) {
  return [fileName, orderId, trackingNumber, recipientName, shippingAddress]
    .map(stringValue_)
    .join("\u001f");
}

function getShippingLabelsSheet_(date, spreadsheet) {
  const workbook = spreadsheet || SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheetName = getShippingLabelsSheetName_(date || new Date());
  let sheet = workbook.getSheetByName(sheetName);
  if (!sheet) sheet = workbook.insertSheet(sheetName);

  if (typeof sheet.isSheetHidden === "function" && sheet.isSheetHidden()) {
    sheet.showSheet();
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, SHIPPING_LABEL_HEADERS.length).setValues([
      SHIPPING_LABEL_HEADERS,
    ]);
    sheet.setFrozenRows(1);
  }

  hideOlderShippingLabelSheets_(workbook, sheetName);
  return sheet;
}

function getShippingLabelsSheetName_(date) {
  const timeZone =
    typeof Session !== "undefined" && Session.getScriptTimeZone
      ? Session.getScriptTimeZone() || "Asia/Bangkok"
      : "Asia/Bangkok";
  return Utilities.formatDate(date || new Date(), timeZone, "yyyy-MM-dd");
}

function getExistingShippingLabelRows_(spreadsheet) {
  return spreadsheet.getSheets().reduce(function (rows, sheet) {
    const name = sheet.getName();
    if (
      name !== SHIPPING_LABELS_SHEET_NAME &&
      !SHIPPING_LABEL_DATE_SHEET_PATTERN.test(name)
    ) {
      return rows;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      rows.push(
        ...sheet
          .getRange(2, 1, lastRow - 1, SHIPPING_LABEL_HEADERS.length)
          .getValues(),
      );
    }
    return rows;
  }, []);
}

function hideOlderShippingLabelSheets_(spreadsheet, currentSheetName) {
  spreadsheet.getSheets().forEach(function (sheet) {
    const name = sheet.getName();
    if (
      !SHIPPING_LABEL_DATE_SHEET_PATTERN.test(name) ||
      name >= currentSheetName
    ) {
      return;
    }

    if (
      typeof sheet.isSheetHidden !== "function" ||
      !sheet.isSheetHidden()
    ) {
      sheet.hideSheet();
    }
  });
}

function stringValue_(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue_(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function clampConfidence_(value) {
  const confidence = numberValue_(value);
  return Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, Math.round(confidence)))
    : 0;
}

function normalizeMarketplace_(value) {
  const marketplace = stringValue_(value).toLowerCase();
  if (marketplace === "shopee") return "Shopee";
  if (marketplace === "lazada") return "Lazada";
  if (marketplace === "tiktok-shop" || marketplace === "tiktok shop") {
    return "TikTok Shop";
  }
  return "Unknown";
}

function normalizeMissingFields_(value) {
  if (!Array.isArray(value)) return [];

  const aliases = {
    "order id": "orderId",
    orderid: "orderId",
    marketplace: "marketplace",
    customer: "customerName",
    customername: "customerName",
    items: "items",
    quantity: "quantity",
    address: "address",
    total: "total",
  };

  return uniqueValues_(
    value
      .filter(function (field) {
        return typeof field === "string";
      })
      .map(function (field) {
        return aliases[field.trim().toLowerCase()] || "";
      })
      .filter(Boolean),
  );
}

function uniqueValues_(values) {
  return values.filter(function (value, index) {
    return values.indexOf(value) === index;
  });
}

function moveToProcessed(file) {
  const processedFolder = DriveApp.getFolderById(PROCESSED_FOLDER_ID);
  file.moveTo(processedFolder);
}

function getSheet_(sheetName) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error("Sheet not found: " + sheetName);
  }

  return sheet;
}

function readValue_(text, pattern) {
  const match = pattern.exec(String(text || ""));
  return match && match[1] ? match[1].trim() : "";
}

function formatItems_(items) {
  return (items || [])
    .map(function (item) {
      return item.name + " x" + item.quantity;
    })
    .join(", ");
}

function isGeminiQuotaError_(status, bodyText) {
  if (Number(status) === 429) return true;

  const message = String(bodyText || "").toLowerCase();
  return (
    message.indexOf("quota") >= 0 ||
    message.indexOf("resource_exhausted") >= 0 ||
    message.indexOf("resource exhausted") >= 0 ||
    message.indexOf("rate limit") >= 0 ||
    message.indexOf("too many requests") >= 0
  );
}

function buildOcrOrder_(fileName, fileUrl, text) {
  const marketplace = detectMarketplace(text);
  const order = parseOcrOrder_(marketplace, text);
  const validation = validateOrder(order);

  order.fileName = fileName;
  order.fileUrl = fileUrl;
  order.source = "drive-ocr";
  order.confidence = 40;
  order.missingFields = validation.missingFields;
  order.status = validation.complete ? "ready" : "incomplete";
  order.reason = validation.complete
    ? ""
    : "Drive OCR อ่านข้อมูลไม่ครบ: " + validation.missingFields.join(", ");
  return order;
}

function buildOcrShippingLabels_(fileName, fileUrl, text) {
  const labels = parseOcrShippingLabels_(fileName, text);
  labels.forEach(function (label) {
    label.fileUrl = fileUrl;
    label.source = "drive-ocr";
  });
  return labels;
}

function readOcrField_(text, aliases) {
  var lines = String(text || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    for (var j = 0; j < aliases.length; j++) {
      var escaped = aliases[j].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var match = new RegExp("^" + escaped + "\\s*:\\s*(.*)", "i").exec(line);
      if (match && match[1].trim()) return match[1].trim();
    }
  }
  return "";
}

function parseOcrOrder_(marketplace, text) {
  var normalizedMarketplace = normalizeMarketplace_(marketplace);
  var customerName = readOcrField_(text, ["Recipient", "Receiver", "To", "Customer"]);
  var orderId = readOcrField_(text, [
    "Shopee Order No.",
    "LAZADA Order Number",
    "Order No.",
    "Order ID",
  ]);
  var address = readOcrField_(text, ["Address"]);

  var order = {
    marketplace: normalizedMarketplace,
    orderId: orderId,
    customerName: customerName,
    items: [],
    quantity: 0,
    total: NaN,
    address: address,
    source: "drive-ocr",
    confidence: 40,
    rawNotes: "",
  };

  var validation = validateOrder(order);
  order.missingFields = validation.missingFields;
  order.status = validation.complete ? "ready" : "incomplete";
  order.reason = validation.complete
    ? ""
    : "Drive OCR อ่านข้อมูลไม่ครบ: " + validation.missingFields.join(", ");

  return order;
}

function parseOcrShippingLabels_(fileName, text) {
  var marketplace = detectMarketplace(text);
  var recipientName = readOcrField_(text, ["Recipient", "Receiver", "To", "Customer"]);
  var orderId = readOcrField_(text, [
    "Shopee Order No.",
    "LAZADA Order Number",
    "Order No.",
    "Order ID",
  ]);
  var trackingNumber = readOcrField_(text, ["Tracking"]);
  var shippingAddress = readOcrField_(text, ["Address"]);

  if (!recipientName && !orderId && !trackingNumber && !shippingAddress) {
    return [
      {
        id: fileName + "-ocr-unknown",
        sourceFileName: fileName,
        marketplace: "Unknown",
        recipientName: "",
        shippingAddress: "",
        orderId: "",
        trackingNumber: "",
        status: "review",
        reviewReasons: [
          "marketplace",
          "recipientName",
          "shippingAddress",
          "orderId",
          "trackingNumber",
        ],
      },
    ];
  }

  return normalizeShippingLabels_(fileName, [
    {
      marketplace: marketplace,
      recipientName: recipientName,
      shippingAddress: shippingAddress,
      orderId: orderId,
      trackingNumber: trackingNumber,
    },
  ]);
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
