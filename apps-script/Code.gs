const INPUT_FOLDER_ID = "PASTE_INPUT_FOLDER_ID";
const PROCESSED_FOLDER_ID = "PASTE_PROCESSED_FOLDER_ID";
const SPREADSHEET_ID = "PASTE_SPREADSHEET_ID";
const SUCCESS_SHEET_NAME = "Orders";
const FAILED_SHEET_NAME = "Read Failed";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
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

function processDriveFile(fileId) {
  const file = DriveApp.getFileById(fileId);

  try {
    const order = extractOrderWithGemini_(file);
    order.fileName = file.getName();
    order.fileUrl = file.getUrl();

    const classification = classifyGeminiOrder_(
      order,
      Boolean(order.orderId && isDuplicateOrder(order.orderId)),
    );
    order.status = classification.status;
    order.reason = classification.reason;
    order.missingFields = classification.missingFields;

    writeOrderResult_(order);
    moveToProcessed(file);
    return order;
  } catch (error) {
    if (isRetryableError_(error)) {
      console.error("Retryable PDF processing error", {
        fileId,
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
        status: "failed",
        reason: error && error.message ? error.message : "การประมวลผลจะลองใหม่ภายหลัง",
      };
    }

    const order = {
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
    writeOrderResult_(order);
    moveToProcessed(file);
    return order;
  }
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

function extractPdfText_(file) {
  // Enable Advanced Google services > Drive API before using OCR conversion.
  const resource = {
    title: "OCR-" + file.getName(),
    mimeType: MimeType.GOOGLE_DOCS,
  };
  const converted = Drive.Files.copy(resource, file.getId(), { ocr: true });
  const doc = DocumentApp.openById(converted.id);
  const text = doc.getBody().getText();
  DriveApp.getFileById(converted.id).setTrashed(true);
  return text;
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

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
