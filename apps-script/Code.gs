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
].join("\n");

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
].join("\n");

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
  let payload;
  try {
    payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (_) {
    return jsonResponse_({ ok: false, message: "Invalid JSON body" });
  }

  if (!isAuthorizedRequest_(payload.token)) {
    return jsonResponse_({ ok: false, message: "Unauthorized" });
  }

  const fileId = payload.fileId;

  if (!fileId) {
    return jsonResponse_({
      ok: false,
      message: "fileId is required",
    });
  }

  const mode = payload.mode || "ocr";
  if (mode !== "ocr" && mode !== "gemini") {
    return jsonResponse_({ ok: false, message: "mode must be ocr or gemini" });
  }

  const cachedResult = getCachedRequestResult_(payload.requestId, mode);
  if (cachedResult) {
    return jsonResponse_({ ok: cachedResult.status === "ready", result: cachedResult, cached: true });
  }

  const result = mode === "gemini"
    ? processDriveFileWithGemini(fileId, payload.requestId)
    : processDriveFile(fileId, payload.requestId);
  logProcessingResult_(fileId, mode, result, payload.requestId);
  putCachedRequestResult_(payload.requestId, mode, result);
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
    const file = files.next();
    const result = processDriveFile(file.getId());
    logProcessingResult_(file.getId(), "ocr", result, "");
    results.push(result);
  }

  return results;
}

function onSpreadsheetOpen() {
  var ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (error) {
    console.warn(
      "Spreadsheet UI is unavailable; skipping PDF menu setup",
      error && error.message ? error.message : error,
    );
    return false;
  }

  if (!ui || typeof ui.createMenu !== "function") return false;

  ui
    .createMenu("PDF")
    .addItem("รีเฟรช PDF ตอนนี้ (OCR)", "refreshNow")
    .addItem("เรียก Gemini กับ PDF ในโฟลเดอร์หลัก", "refreshWithGemini")
    .addToUi();
  return true;
}

function refreshNow() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  safeSpreadsheetToast_(spreadsheet, "กำลังประมวลผล PDF ใหม่...", "PDF", 5);

  try {
    const results = processInputFolder();
    const ready = results.filter(function (result) {
      return result && result.status === "ready";
    }).length;
    const failed = results.length - ready;
    safeSpreadsheetToast_(spreadsheet,
      "รีเฟรชเสร็จแล้ว: " + results.length + " ไฟล์ | พร้อมใช้ " + ready + " | ล้มเหลว/ลองใหม่ " + failed,
      "PDF",
      8,
    );
    return results;
  } catch (error) {
    safeSpreadsheetToast_(spreadsheet, "รีเฟรชไม่สำเร็จ กรุณาตรวจ Execution log", "PDF", 8);
    throw error;
  }
}

function safeSpreadsheetToast_(spreadsheet, message, title, seconds) {
  try {
    if (spreadsheet && typeof spreadsheet.toast === "function") {
      spreadsheet.toast(message, title, seconds);
    }
  } catch (error) {
    console.warn(
      "Spreadsheet toast is unavailable; continuing without notification",
      error && error.message ? error.message : error,
    );
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

function processDriveFile(fileId, requestId) {
  const file = DriveApp.getFileById(fileId);
  var ocrFile = file;

  var ocrText = null;
  var ocrFetched = false;
  var getOcrText_ = function () {
    if (!ocrFetched) {
      ocrText = extractTextWithDriveOcr_(ocrFile);
      ocrFetched = true;
    }
    return ocrText;
  };

  try {
    ocrFile = prepareOcrInputFile_(file);
    var ocrTextAvailable = false;
    var ocrFailure = null;
    try {
      ocrTextAvailable = Boolean(String(getOcrText_() || "").trim());
    } catch (error) {
      if (isRetryableError_(error)) {
        ocrFailure = error;
      } else {
        throw error;
      }
    }

    var readableOcrText = ocrTextAvailable ? String(getOcrText_() || "") : "";
    var ocrLabels = readableOcrText
      ? buildOcrShippingLabels_(file.getName(), file.getUrl(), readableOcrText)
      : [];
    var fallbackResult = enrichOcrWithCloudReaders_(ocrFile, readableOcrText, ocrLabels);
    readableOcrText = fallbackResult.text;
    ocrLabels = fallbackResult.labels;

    if (ocrFailure && !fallbackResult.used && !readableOcrText) {
      return buildRetryableProcessingResult_(file, ocrFailure, 0, "drive-ocr", requestId);
    }

    var reviewLabels = ocrLabels.length
      ? ocrLabels
      : prepareShippingLabelsForExport_(file.getName(), []);
    var shippingExport = writeShippingLabelCandidates_(reviewLabels, file.getUrl());
    var order = readableOcrText
      ? buildOcrOrder_(file.getName(), file.getUrl(), readableOcrText)
      : buildOcrOrder_(file.getName(), file.getUrl(), "");

    return finalizeOrderResult_(
      order,
      file,
      shippingExport.inserted,
      true,
      shippingExport.total > 0,
    );
  } catch (error) {
    if (isRetryableError_(error)) {
      return buildRetryableProcessingResult_(file, error, 0, "drive-ocr", requestId);
    }

    const order = buildFailedOrder_(file, error, "drive-ocr");
    writeOrderResult_(order);
    return order;
  }
}

function processDriveFileWithGemini(fileId, requestId) {
  const file = DriveApp.getFileById(fileId);
  var shippingExport = { inserted: 0, total: 0, review: 1 };

  try {
    var labels = prepareShippingLabelsForExport_(
      file.getName(),
      extractShippingLabelsWithGemini_(file),
    );
    shippingExport = writeShippingLabelCandidates_(labels, file.getUrl());
  } catch (error) {
    if (isRetryableError_(error)) {
      return buildRetryableProcessingResult_(file, error, 0, "gemini", requestId);
    }
    shippingExport = writeShippingLabelCandidates_(
      prepareShippingLabelsForExport_(file.getName(), []),
      file.getUrl(),
    );
  }

  try {
    var order = extractOrderWithGemini_(file);
    return finalizeOrderResult_(order, file, shippingExport.inserted, true);
  } catch (error) {
    if (isRetryableError_(error)) {
      return buildRetryableProcessingResult_(file, error, shippingExport.inserted, "gemini", requestId);
    }

    var failedOrder = buildFailedOrder_(file, error, "gemini");
    failedOrder.shippingLabelsExported = shippingExport.inserted;
    writeOrderResult_(failedOrder);
    moveToProcessed(file);
    return failedOrder;
  }
}

function refreshWithGemini() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  safeSpreadsheetToast_(spreadsheet, "กำลังเรียก Gemini กับ PDF ในโฟลเดอร์หลัก...", "PDF", 5);

  try {
    const results = listPdfFiles_(INPUT_FOLDER_ID, "input").map(function (pdf) {
      const result = processDriveFileWithGemini(pdf.fileId);
      logProcessingResult_(pdf.fileId, "gemini", result, "");
      return result;
    });
    const ready = results.filter(function (result) {
      return result && result.status === "ready";
    }).length;
    const retryable = results.filter(function (result) {
      return result && result.retryable === true;
    }).length;
    safeSpreadsheetToast_(spreadsheet,
      "Gemini เสร็จแล้ว: " + results.length + " ไฟล์ | พร้อมใช้ " + ready + " | ลองใหม่ " + retryable,
      "PDF",
      8,
    );
    return results;
  } catch (error) {
    safeSpreadsheetToast_(spreadsheet, "เรียก Gemini ไม่สำเร็จ กรุณาตรวจ Execution log", "PDF", 8);
    throw error;
  }
}

function isUsableOcrShippingLabels_(labels) {
  var candidates = Array.isArray(labels) ? labels : [];
  return candidates.length > 0 && candidates.every(function (label) {
    return (
      label &&
      label.status === "ready" &&
      label.marketplace !== "Unknown" &&
      label.recipientName &&
      label.shippingAddress &&
      label.orderId &&
      label.trackingNumber
    );
  });
}

function doGet(e) {
  const parameters = (e && e.parameter) || {};
  if (!isAuthorizedRequest_(parameters.token)) {
    return jsonResponse_({ ok: false, message: "Unauthorized" });
  }

  if (parameters.action !== "listPdfs") {
    return jsonResponse_({ ok: false, message: "Unsupported action" });
  }

  const files = listPdfFiles_(INPUT_FOLDER_ID, "input");
  const reviewFolderId = getReviewFolderId_();
  if (reviewFolderId && reviewFolderId !== INPUT_FOLDER_ID) {
    files.push.apply(files, listPdfFiles_(reviewFolderId, "review"));
  }

  return jsonResponse_({ ok: true, files });
}

function listPdfFiles_(folderId, location) {
  if (!folderId) return [];
  const folder = DriveApp.getFolderById(folderId);
  const iterator = folder.getFilesByType(MimeType.PDF);
  const files = [];

  while (iterator.hasNext()) {
    const file = iterator.next();
    files.push({
      fileId: file.getId(),
      fileName: file.getName(),
      modifiedAt: file.getLastUpdated().toISOString(),
      location,
      url: file.getUrl(),
    });
  }

  return files.sort(function (left, right) {
    return String(right.modifiedAt).localeCompare(String(left.modifiedAt));
  });
}

function getReviewFolderId_() {
  const properties = PropertiesService.getScriptProperties();
  return properties.getProperty("REVIEW_FOLDER_ID") || "";
}

function isAuthorizedRequest_(token) {
  const configuredSecret = PropertiesService.getScriptProperties().getProperty("APPS_SCRIPT_SHARED_SECRET");
  return !configuredSecret || String(token || "") === configuredSecret;
}

function getCachedRequestResult_(requestId, mode) {
  if (!requestId || typeof CacheService === "undefined") return null;
  const value = CacheService.getScriptCache().get("pdf-request:" + mode + ":" + requestId);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function putCachedRequestResult_(requestId, mode, result) {
  if (!requestId || typeof CacheService === "undefined") return;
  CacheService.getScriptCache().put(
    "pdf-request:" + mode + ":" + requestId,
    JSON.stringify(result),
    600,
  );
}

function logProcessingResult_(fileId, mode, result, requestId) {
  console.log(JSON.stringify({
    fileId: fileId || "",
    fileName: result && result.fileName ? result.fileName : "",
    mode: mode || "ocr",
    source: result && result.source ? result.source : "",
    status: result && result.status ? result.status : "failed",
    inserted: result && Number.isFinite(result.shippingLabelsExported)
      ? result.shippingLabelsExported
      : 0,
    retryable: Boolean(result && result.retryable),
    requestId: requestId || "",
  }));
}

function isUsableOcrOrder_(order) {
  return Boolean(
    order &&
      order.status === "ready" &&
      Array.isArray(order.missingFields) &&
      order.missingFields.length === 0,
  );
}

function writeShippingLabelCandidates_(labels, fileUrl) {
  const candidates = Array.isArray(labels) ? labels : [];
  const result = writeShippingLabels_(candidates, fileUrl);
  return {
    inserted: result && Number.isFinite(result.inserted) ? result.inserted : candidates.length,
    total: candidates.length,
    review: candidates.filter(function (label) { return label.status === "review"; }).length,
  };
}

function finalizeOrderResult_(
  order,
  file,
  shippingLabelsExported,
  canMoveToProcessed,
  hasCompleteShippingLabels,
) {
  order.fileName = file.getName();
  order.fileUrl = file.getUrl();

  const isDuplicate = Boolean(order.orderId && isDuplicateOrder(order.orderId));
  const classification = order.source === "gemini"
    ? classifyGeminiOrder_(order, isDuplicate)
    : classifyOcrOrder_(order, isDuplicate);
  order.status = "ready";
  order.reason = classification.reason;
  order.missingFields = classification.missingFields;
  order.shippingLabelsExported = shippingLabelsExported;

  var shippingLabelsReady =
    order.source === "drive-ocr" &&
    hasCompleteShippingLabels === true &&
    canMoveToProcessed === true;

  if (shippingLabelsReady && classification.status !== "ready") {
    order.status = "ready";
    order.reason = "Shipping label data complete";
    order.missingFields = [];
    order.shippingLabelsOnly = true;
  }

  if (!order.shippingLabelsOnly) {
    writeOrderResult_(order);
  }
  if (order.source === "drive-ocr") {
    moveToProcessed(file);
  } else if (canMoveToProcessed !== false) {
    moveToProcessed(file);
  }
  return order;
}

function classifyOcrOrder_(order, isDuplicate) {
  if (isDuplicate) {
    return {
      status: "duplicate",
      reason: "Order ID ซ้ำ",
      missingFields: [],
    };
  }

  const validation = validateOrder(order);
  return validation.complete
    ? { status: "ready", reason: "ข้อมูลครบ", missingFields: [] }
    : {
        status: "incomplete",
        reason: "Drive OCR อ่านข้อมูลไม่ครบ: " + validation.missingFields.join(", "),
        missingFields: validation.missingFields,
      };
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
      id: fileName + "-ocr",
      sourceFileName: fileName,
      marketplace: "Unknown",
      recipientName: "",
      shippingAddress: "",
      orderId: "",
      trackingNumber: "",
      status: "incomplete",
      reviewReasons: ["marketplace", "recipientName", "shippingAddress", "orderId", "trackingNumber"],
    },
  ];
}

function buildRetryableProcessingResult_(file, error, shippingLabelsExported, source, requestId) {
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
    source: source || "gemini",
    confidence: 0,
    missingFields: [],
    shippingLabelsExported,
    status: "failed",
    reason: error && error.message ? error.message : "Retryable PDF processing error",
    retryable: true,
    requestId: requestId || "",
  };
}

function buildFailedOrder_(file, error, source) {
  return {
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    marketplace: "Unknown",
    orderId: "",
    customerName: "",
    items: [],
    total: "",
    address: "",
    source: source || "gemini",
    confidence: 0,
    missingFields: [],
    status: "failed",
    reason:
      (source === "drive-ocr" ? "Drive OCR อ่าน PDF ไม่สำเร็จ: " : "Gemini อ่าน PDF ไม่สำเร็จ: ") +
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

function getOcrPreprocessorUrl_() {
  return getOptionalScriptProperty_("OCR_PREPROCESSOR_URL");
}

function getOcrPreprocessorToken_() {
  return getOptionalScriptProperty_("OCR_PREPROCESSOR_TOKEN");
}

function prepareOcrInputFile_(file) {
  if (!getOcrPreprocessorUrl_()) return file;
  return preprocessPdfForOcr_(file);
}

function preprocessPdfForOcr_(file) {
  var url = getOcrPreprocessorUrl_();
  if (!url) return file;
  if (typeof UrlFetchApp === "undefined") {
    throw createProcessingError_(
      "OcrPreprocessorError",
      "OCR preprocessor ต้องใช้ UrlFetchApp",
      true,
    );
  }

  var headers = {};
  var token = getOcrPreprocessorToken_();
  if (token) headers.Authorization = "Bearer " + token;

  var response = UrlFetchApp.fetch(url.replace(/\/$/, "") + "/preprocess", {
    method: "post",
    contentType: "application/pdf",
    payload: file.getBlob().getBytes(),
    headers: headers,
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw createProcessingError_(
      "OcrPreprocessorError",
      "OCR preprocessor ตอบกลับ HTTP " + status,
      true,
    );
  }

  var processedBlob = response.getBlob();
  if (processedBlob && typeof processedBlob.setName === "function") {
    processedBlob.setName(file.getName().replace(/\.pdf$/i, "") + ".preprocessed.pdf");
  }
  return {
    getId: function () { return file.getId() + "-preprocessed"; },
    getName: function () {
      return file.getName().replace(/\.pdf$/i, "") + ".preprocessed.pdf";
    },
    getUrl: function () { return file.getUrl(); },
    getBlob: function () { return processedBlob; },
    getMimeType: function () { return MimeType.PDF; },
  };
}

function extractTextWithDriveOcr_(file) {
  var lastError = null;
  var bestText = "";
  var ocrLanguages = ["th", "en"];

  for (var languageIndex = 0; languageIndex < ocrLanguages.length; languageIndex++) {
    var converted;
    try {
      converted = createDriveOcrDocument_(file, ocrLanguages[languageIndex]);

      var text = waitForDriveOcrText_(converted.id, file.getName());
      if (text.length > bestText.length) bestText = text;
      if (isUsefulDriveOcrText_(text, file.getName())) return text;
    } catch (error) {
      lastError = error;
    } finally {
      if (converted && converted.id) {
        try {
          DriveApp.getFileById(converted.id).setTrashed(true);
        } catch (_) {}
      }
    }
  }

  if (isUsefulDriveOcrText_(bestText, file.getName())) return bestText;
  if (lastError) {
    throw createProcessingError_(
      "DriveOcrError",
      "Drive OCR ไม่สามารถอ่าน PDF ได้: " + (lastError.message || lastError),
      true,
    );
  }
  throw createProcessingError_(
    "DriveOcrEmptyError",
    "Drive OCR แปลง PDF แล้วแต่ไม่พบข้อความที่อ่านได้",
    true,
  );
}

function createDriveOcrDocument_(file, language) {
  if (Drive.Files && typeof Drive.Files.create === "function") {
    return Drive.Files.create(
      { name: "OCR-" + file.getName(), mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob(),
      { ocr: true, ocrLanguage: language, fields: "id" },
    );
  }
  if (Drive.Files && typeof Drive.Files.insert === "function") {
    return Drive.Files.insert(
      { title: "OCR-" + file.getName(), mimeType: MimeType.GOOGLE_DOCS },
      file.getBlob(),
      { ocr: true, ocrLanguage: language },
    );
  }
  throw new Error("Drive Advanced Service Files.create/insert is unavailable");
}

function waitForDriveOcrText_(documentId, fileName) {
  var lastText = "";
  for (var attempt = 0; attempt < 4; attempt++) {
    lastText = DocumentApp.openById(documentId).getBody().getText() || "";
    if (isUsefulDriveOcrText_(lastText, fileName)) return lastText;
    if (attempt < 3) Utilities.sleep(1000);
  }
  return lastText;
}

function isUsefulDriveOcrText_(text, fileName) {
  var value = normalizeOcrText_(text).trim();
  var fileValue = normalizeOcrText_(fileName).toLowerCase();
  if (value.length < 30) return false;
  return (
    (/shopee|lazada|tiktok/i.test(value) || /shopee|lazada|tik[\s_-]*tok/i.test(fileValue)) &&
    (/\b(?:TH|JTTH|LEX)[A-Z0-9-]{6,}\b/i.test(value) ||
      /order\s*(?:no\.?|id)|เลขที่คำสั่งซื้อ|หมายเลขคำสั่งซื้อ/i.test(value))
  );
}

function enrichOcrWithCloudReaders_(file, text, labels) {
  var result = {
    text: String(text || ""),
    labels: Array.isArray(labels) ? labels : [],
    used: false,
  };
  if (isUsableOcrShippingLabels_(result.labels)) return result;

  var readers = [
    { name: "barcode-reader", read: extractBarcodesWithVision_ },
    { name: "google-vision", read: extractTextWithVision_ },
    { name: "document-ai", read: extractTextWithDocumentAi_ },
  ];

  for (var index = 0; index < readers.length; index++) {
    try {
      var enrichment = readers[index].read(file);
      var extraText = enrichment && enrichment.text ? String(enrichment.text) : "";
      var barcodes = enrichment && Array.isArray(enrichment.barcodes)
        ? enrichment.barcodes.join("\n")
        : "";
      var layoutTexts = enrichment && Array.isArray(enrichment.layoutTexts)
        ? enrichment.layoutTexts
        : [];
      var layoutColumns = enrichment && Array.isArray(enrichment.layoutColumns)
        ? enrichment.layoutColumns
        : [];
      if (
        detectMarketplaceForFile_(file.getName(), result.text) === "TikTok Shop" &&
        (layoutColumns.length > 0 || layoutTexts.length > 0)
      ) {
        var layoutLabels = layoutColumns.length
          ? parseTikTokVisionLayoutColumns_(file.getName(), layoutColumns)
          : parseTikTokVisionLayoutLabels_(file.getName(), layoutTexts);
        if (scoreOcrShippingLabels_(layoutLabels) > scoreOcrShippingLabels_(result.labels)) {
          result.text = layoutTexts.join("\n\n");
          result.labels = layoutLabels;
          result.used = true;
        }
        if (isUsableOcrShippingLabels_(result.labels)) break;
      }
      if (!extraText && !barcodes) continue;

      if (readers[index].name === "barcode-reader") {
        var barcodeText = [result.text, barcodes].filter(Boolean).join("\n");
        if (barcodeText === result.text) continue;
        result.text = barcodeText;
        result.labels = buildOcrShippingLabels_(file.getName(), file.getUrl(), result.text);
        result.used = true;
      } else {
        var readerText = [extraText, barcodes].filter(Boolean).join("\n");
        var readerLabels = buildOcrShippingLabels_(file.getName(), file.getUrl(), readerText);
        if (scoreOcrShippingLabels_(readerLabels) > scoreOcrShippingLabels_(result.labels)) {
          result.text = readerText;
          result.labels = readerLabels;
          result.used = true;
        }
      }
      if (isUsableOcrShippingLabels_(result.labels)) break;
    } catch (error) {
      console.warn(
        "OCR fallback unavailable: " + readers[index].name,
        error && error.message ? error.message : error,
      );
    }
  }
  return result;
}

function scoreOcrShippingLabels_(labels) {
  return (Array.isArray(labels) ? labels : []).reduce(function (score, label) {
    if (!label) return score;
    var fields = [
      label.marketplace,
      label.recipientName,
      label.shippingAddress,
      label.orderId,
      label.trackingNumber,
    ];
    return score + (label.status === "ready" ? 100 : 0) + fields.filter(Boolean).length;
  }, 0);
}

function getCloudReaderConfig_() {
  return {
    projectId: getOptionalScriptProperty_("GOOGLE_CLOUD_PROJECT_ID"),
    location: getOptionalScriptProperty_("GOOGLE_CLOUD_LOCATION") || "us",
    documentAiProcessor: getOptionalScriptProperty_("DOCUMENT_AI_PROCESSOR_NAME"),
  };
}

function getOptionalScriptProperty_(key) {
  try {
    if (typeof PropertiesService === "undefined") return "";
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return value ? String(value).trim() : "";
  } catch (_) {
    return "";
  }
}

function fetchGoogleCloudOcr_(url, payload) {
  if (typeof ScriptApp === "undefined" || typeof UrlFetchApp === "undefined") {
    return null;
  }

  var accessToken = ScriptApp.getOAuthToken();
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + accessToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    var errorReason = extractGoogleCloudErrorReason_(response.getContentText());
    var errorMessage =
      "Google Cloud OCR ตอบกลับ HTTP " + status +
      (errorReason ? ": " + errorReason : "");
    throw createProcessingError_(
      "CloudOcrError",
      errorMessage,
      true,
    );
  }

  return JSON.parse(response.getContentText() || "{}");
}

function extractGoogleCloudErrorReason_(bodyText) {
  try {
    var body = JSON.parse(String(bodyText || ""));
    var cloudError = body && body.error ? body.error : {};
    var message = cloudError.message || cloudError.status || "";
    return String(message).replace(/[\r\n]+/g, " ").trim().slice(0, 240);
  } catch (_) {
    return "";
  }
}

function extractBarcodesWithVision_(file) {
  var config = getCloudReaderConfig_();
  if (!config.projectId) return { text: "", barcodes: [] };

  var response = fetchGoogleCloudOcr_(
    buildVisionFileAnnotateUrl_(config),
    {
      requests: [{
        inputConfig: {
          content: Utilities.base64Encode(file.getBlob().getBytes()),
          mimeType: "application/pdf",
        },
        features: [{ type: "BARCODE_DETECTION", maxResults: 50 }],
        pages: [1, 2, 3, 4, 5],
      }],
    },
  );
  return {
    text: "",
    barcodes: collectVisionBarcodeValues_(response),
  };
}

function extractTextWithVision_(file) {
  var config = getCloudReaderConfig_();
  if (!config.projectId) return { text: "", barcodes: [] };

  var response = fetchGoogleCloudOcr_(
    buildVisionFileAnnotateUrl_(config),
    {
      requests: [{
        inputConfig: {
          content: Utilities.base64Encode(file.getBlob().getBytes()),
          mimeType: "application/pdf",
        },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        pages: [1, 2, 3, 4, 5],
      }],
    },
  );
  return {
    text: collectVisionText_(response),
    barcodes: [],
    layoutTexts: collectVisionLayoutLabelTexts_(response),
    layoutColumns: collectVisionLayoutColumns_(response),
  };
}

function buildVisionFileAnnotateUrl_(config) {
  var location = String((config && config.location) || "us").trim().toLowerCase();
  var host = location === "global" ? "vision.googleapis.com" : location + "-vision.googleapis.com";
  return "https://" + host + "/v1/projects/" +
    encodeURIComponent(config.projectId) +
    "/locations/" + encodeURIComponent(location) +
    "/files:annotate";
}

function collectVisionText_(response) {
  var texts = [];
  (response && response.responses || []).forEach(function (fileResponse) {
    (fileResponse.responses || []).forEach(function (pageResponse) {
      if (pageResponse.fullTextAnnotation && pageResponse.fullTextAnnotation.text) {
        texts.push(pageResponse.fullTextAnnotation.text);
      } else if (pageResponse.textAnnotations && pageResponse.textAnnotations[0]) {
        texts.push(pageResponse.textAnnotations[0].description || "");
      }
    });
  });
  return texts.filter(Boolean).join("\n");
}

function collectVisionLayoutLabelTexts_(response) {
  return collectVisionLayoutColumns_(response).map(function (column) { return column.text; });
}

function collectVisionLayoutColumns_(response) {
  var columns = [];
  (response && response.responses || []).forEach(function (fileResponse) {
    (fileResponse.responses || []).forEach(function (pageResponse) {
      var pages = pageResponse && pageResponse.fullTextAnnotation
        ? pageResponse.fullTextAnnotation.pages || []
        : [];
      pages.forEach(function (page) {
        splitVisionPageIntoColumnsData_(page).forEach(function (column) {
          if (/\bJTTH[A-Z0-9-]{6,}\b/i.test(column.text)) columns.push(column);
        });
      });
    });
  });
  return columns;
}

function splitVisionPageIntoColumns_(page) {
  return splitVisionPageIntoColumnsData_(page).map(function (column) { return column.text; });
}

function splitVisionPageIntoColumnsData_(page) {
  var items = collectVisionPageLayoutItems_(page);
  if (!items.length) return [];

  var pageWidth = Number(page && page.width) || 0;
  var xValues = items.map(function (item) { return item.x; });
  var minX = Math.min.apply(null, xValues);
  var maxX = Math.max.apply(null, xValues);
  var usesNormalizedCoordinates = items.some(function (item) { return item.normalized; });
  var splitX = usesNormalizedCoordinates ? 0.5 : pageWidth / 2;
  if (!splitX && maxX > minX) splitX = minX + ((maxX - minX) / 2);

  var columns = [[], []];
  items.forEach(function (item) {
    columns[splitX && item.x >= splitX ? 1 : 0].push(item);
  });
  return columns.map(function (columnItems) {
    return { items: columnItems, text: joinVisionLayoutItems_(columnItems) };
  }).filter(function (column) { return Boolean(column.text); });
}

function collectVisionPageLayoutItems_(page) {
  var wordItems = [];
  var paragraphItems = [];
  (page && page.blocks || []).forEach(function (block) {
    (block.paragraphs || []).forEach(function (paragraph) {
      var paragraphItem = makeVisionLayoutItem_(collectVisionParagraphText_(paragraph), paragraph.boundingBox);
      if (paragraphItem) paragraphItems.push(paragraphItem);
      (paragraph.words || []).forEach(function (word) {
        var item = makeVisionLayoutItem_(collectVisionWordText_(word), word.boundingBox);
        if (item) wordItems.push(item);
      });
    });
  });
  // Vision can merge two side-by-side labels into one paragraph. Individual word
  // positions preserve the physical column in that response, so prefer them.
  return wordItems.length >= 4 ? wordItems : paragraphItems;
}

function makeVisionLayoutItem_(text, boundingBox) {
  if (!text) return null;
  var box = boundingBox || {};
  var normalized = (!box.vertices || !box.vertices.length) &&
    Boolean(box.normalizedVertices && box.normalizedVertices.length);
  var vertices = box.vertices || box.normalizedVertices || [];
  if (!vertices.length) return null;
  var xValues = vertices.map(function (vertex) { return Number(vertex.x); }).filter(isFinite);
  var yValues = vertices.map(function (vertex) { return Number(vertex.y); }).filter(isFinite);
  if (!xValues.length || !yValues.length) return null;
  var minX = Math.min.apply(null, xValues);
  var maxX = Math.max.apply(null, xValues);
  var minY = Math.min.apply(null, yValues);
  var maxY = Math.max.apply(null, yValues);
  return {
    text: text,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    height: Math.max(normalized ? 0.001 : 1, maxY - minY),
    normalized: normalized,
  };
}

function joinVisionLayoutItems_(items) {
  if (!items.length) return "";
  var sorted = items.slice().sort(function (left, right) {
    return left.y === right.y ? left.x - right.x : left.y - right.y;
  });
  var heights = sorted.map(function (item) { return item.height; }).sort(function (left, right) {
    return left - right;
  });
  var medianHeight = heights[Math.floor(heights.length / 2)] || 12;
  var minTolerance = sorted.some(function (item) { return item.normalized; }) ? 0.003 : 5;
  var tolerance = Math.max(minTolerance, medianHeight * 0.65);
  var lines = [];
  sorted.forEach(function (item) {
    var line = lines[lines.length - 1];
    if (!line || Math.abs(item.y - line.y) > tolerance) {
      lines.push({ y: item.y, items: [item] });
      return;
    }
    line.items.push(item);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  });
  return lines.map(function (line) {
    return line.items.sort(function (left, right) { return left.x - right.x; })
      .map(function (item) { return item.text; })
      .join(" ");
  }).join("\n").trim();
}

function collectVisionParagraphText_(paragraph) {
  return (paragraph && paragraph.words || []).map(function (word) {
    return (word.symbols || []).map(function (symbol) { return symbol.text || ""; }).join("");
  }).filter(Boolean).join(" ").trim();
}

function collectVisionWordText_(word) {
  return (word && word.symbols || []).map(function (symbol) {
    return symbol.text || "";
  }).join("").trim();
}

function parseTikTokVisionLayoutLabels_(fileName, layoutTexts) {
  var values = [];
  (Array.isArray(layoutTexts) ? layoutTexts : []).forEach(function (text) {
    parseTikTokOcrShippingLabels_(fileName, text).forEach(function (label) {
      values.push({
        marketplace: "TikTok Shop",
        recipientName: label.recipientName,
        shippingAddress: label.shippingAddress,
        orderId: label.orderId,
        trackingNumber: label.trackingNumber,
      });
    });
  });
  return normalizeShippingLabels_(fileName, values);
}

function parseTikTokVisionLayoutColumns_(fileName, columns) {
  var values = (Array.isArray(columns) ? columns : []).map(function (column) {
    var items = Array.isArray(column && column.items) ? column.items : [];
    var trackingNumbers = items.map(function (item) { return item.text; }).filter(function (text) {
      return /^JTTH[A-Z0-9-]{6,}$/i.test(String(text || "").trim());
    });
    var orderIds = items.map(function (item) { return String(item.text || "").trim(); }).filter(function (text) {
      return /^\d{15,22}$/.test(text);
    });
    return {
      marketplace: "TikTok Shop",
      recipientName: extractTikTokVisionRecipientByPosition_(items) ||
        extractTikTokVisionRecipientNearPhone_(items),
      shippingAddress: extractTikTokVisionAddress_(items),
      orderId: orderIds.length ? orderIds[orderIds.length - 1] : "",
      trackingNumber: mostFrequentText_(trackingNumbers),
    };
  });
  return normalizeShippingLabels_(fileName, values);
}

function mostFrequentText_(values) {
  var counts = {};
  (values || []).forEach(function (value) { counts[value] = (counts[value] || 0) + 1; });
  return Object.keys(counts).sort(function (left, right) { return counts[right] - counts[left]; })[0] || "";
}

function extractTikTokVisionRecipient_(items) {
  var marker = (items || []).filter(function (item) { return String(item.text || "").trim() === "ถึง"; })[0];
  var phone = findTikTokVisionPhone_(items);
  var candidates = [];
  if (marker) {
    candidates = (items || []).filter(function (item) {
      return item.x > marker.x && item.y >= marker.y - 0.02 && item.y <= marker.y + 0.03 &&
        (!phone || item.y < phone.y - 0.01);
    });
  } else if (phone) {
    candidates = (items || []).filter(function (item) {
      return item.y >= phone.y - 0.06 && item.y < phone.y - 0.01;
    });
  }
  return joinVisionLayoutItems_(candidates).replace(/\n/g, " ").replace(/\b(?:JTTH|PICK|COD)\b.*$/i, "").trim();
}

function extractTikTokVisionAddress_(items) {
  var phone = findTikTokVisionPhone_(items);
  if (!phone) return "";
  var postalCodes = (items || []).filter(function (item) {
    return /^\d{5}$/.test(String(item.text || "").trim()) && item.y > phone.y;
  }).sort(function (left, right) { return left.y - right.y; });
  var postal = postalCodes[0];
  if (!postal) return "";
  var addressItems = (items || []).filter(function (item) {
    var text = String(item.text || "").trim();
    return item.y > phone.y + 0.01 && item.y <= postal.y + 0.01 &&
      !/^JTTH[A-Z0-9-]{6,}$/i.test(text) &&
      !/^(?:PICK|UP|COD|Shipping|Date|Order|ID)$/i.test(text);
  });
  return joinVisionLayoutItems_(addressItems).replace(/\n/g, " ").trim();
}

function findTikTokVisionPhone_(items) {
  return (items || []).filter(function (item) {
    var value = String(item.text || "").replace(/\s/g, "");
    return /^\+?66$/.test(value) || /^\(?\+?66\)?\d{1,}/.test(value);
  }).sort(function (left, right) { return left.y - right.y; })[0] || null;
}

function extractTikTokVisionRecipientFromPosition_(items) {
  var values = Array.isArray(items) ? items : [];
  var marker = values.filter(function (item) {
    return String(item.text || "").trim() === "ถึง";
  })[0];
  if (!marker) return "";
  var phone = findTikTokVisionPhone_(values);
  var candidates = values.filter(function (item) {
    var text = String(item.text || "").trim();
    return item.x > marker.x && item.y >= marker.y - 0.02 && item.y <= marker.y + 0.03 &&
      (!phone || item.y < phone.y - 0.01) &&
      !/^JTTH[A-Z0-9-]{6,}$/i.test(text) &&
      !/^(?:PICK|UP|COD|Order|ID|Shipping|Date)$/i.test(text) &&
      !/^[A-Z]?\d{2,4}[A-Z]?(?:-\d+)?$/i.test(text);
  });
  return joinVisionLayoutItems_(candidates).replace(/\n/g, " ").trim();
}

function extractTikTokVisionRecipientNearPhone_(items) {
  var values = Array.isArray(items) ? items : [];
  var phone = findTikTokVisionPhone_(values);
  if (!phone) return "";
  var candidates = values.filter(function (item) {
    var text = String(item.text || "").trim();
    return item.y >= phone.y - 0.06 && item.y < phone.y - 0.01 &&
      !/^JTTH[A-Z0-9-]{6,}$/i.test(text) &&
      !/^(?:PICK|UP|COD|Order|ID|Shipping|Date|From)$/i.test(text) &&
      !/^[A-Z]?\d{2,4}[A-Z]?(?:-\d+)?$/i.test(text);
  });
  return joinVisionLayoutItems_(candidates).replace(/\n/g, " ").trim();
}

function extractTikTokVisionRecipientByPosition_(items) {
  var values = Array.isArray(items) ? items : [];
  var marker = values.filter(function (item) {
    return isTikTokVisionRecipientMarker_(item.text);
  })[0];
  if (!marker) return "";
  var phone = findTikTokVisionPhone_(values);
  var candidates = values.filter(function (item) {
    var text = String(item.text || "").trim();
    return item.x > marker.x && item.y >= marker.y - 0.02 && item.y <= marker.y + 0.03 &&
      (!phone || item.y < phone.y - 0.01) &&
      !/^JTTH[A-Z0-9-]{6,}$/i.test(text) &&
      !/^(?:PICK|UP|COD|Order|ID|Shipping|Date)$/i.test(text) &&
      !/^[A-Z]\d{1,2}$/i.test(text) &&
      !/^[A-Z]?\d{2,4}[A-Z]?(?:-\d+)?$/i.test(text) &&
      !isTikTokVisionRouteCode_(text);
  });
  return joinVisionLayoutItems_(candidates).replace(/\n/g, " ").trim();
}

function isTikTokVisionRecipientMarker_(value) {
  var text = normalizePdfTextForParsing_(String(value || "")).replace(/\s+/g, "").trim();
  return /^(?:ถึง|ถง|ถึ?ง|เถิง|to)\s*:?$/i.test(text);
}

function isTikTokVisionRouteCode_(value) {
  return /^[A-Z]{1,2}\d{0,2}(?:\s+[A-Z]?\d{1,3}(?:-\d+)?)+$/i.test(String(value || "").trim());
}

function collectVisionBarcodeValues_(response) {
  var values = [];
  (response && response.responses || []).forEach(function (fileResponse) {
    (fileResponse.responses || []).forEach(function (pageResponse) {
      ["barcodeAnnotations", "localizedBarcodeAnnotations"].forEach(function (key) {
        (pageResponse[key] || []).forEach(function (barcode) {
          var value = barcode.value || barcode.rawValue || barcode.description || "";
          if (value) values.push(String(value).trim());
        });
      });
    });
  });
  return uniqueValues_(values);
}

function extractTextWithDocumentAi_(file) {
  var config = getCloudReaderConfig_();
  if (!config.documentAiProcessor) return { text: "", barcodes: [] };

  var response = fetchGoogleCloudOcr_(
    buildDocumentAiProcessUrl_(config.documentAiProcessor),
    {
      rawDocument: {
        content: Utilities.base64Encode(file.getBlob().getBytes()),
        mimeType: "application/pdf",
      },
    },
  );
  var document = response && response.document ? response.document : {};
  var barcodes = [];
  (document.pages || []).forEach(function (page) {
    (page.detectedBarcodes || []).forEach(function (detected) {
      var barcode = detected && detected.barcode ? detected.barcode : {};
      var value = barcode.rawValue || "";
      if (value) barcodes.push(String(value).trim());
    });
  });
  return {
    text: document.text || "",
    barcodes: uniqueValues_(barcodes),
  };
}

function buildDocumentAiProcessUrl_(processorName) {
  var value = String(processorName || "").trim().replace(/:process$/i, "");
  if (/^https?:\/\//i.test(value)) return value + ":process";
  return "https://documentai.googleapis.com/v1/" + value + ":process";
}

function normalizeOcrText_(text) {
  return String(text || "")
    .replace(/[\u0000\u000b\u000c\u00a0]/g, " ")
    .replace(/[ \t]+/g, " ");
}

function detectMarketplace(text) {
  const value = normalizeOcrText_(text).toLowerCase();

  if (value.indexOf("shopee") >= 0) return "Shopee";
  if (value.indexOf("lazada") >= 0) return "Lazada";
  if (value.indexOf("tiktok shop") >= 0 || value.indexOf("tiktok") >= 0) {
    return "TikTok Shop";
  }

  return "Unknown";
}

function detectMarketplaceForFile_(fileName, text) {
  var marketplace = detectMarketplace(text);
  if (marketplace !== "Unknown") return marketplace;

  var fileValue = normalizeOcrText_(fileName).toLowerCase();
  var textValue = normalizeOcrText_(text).toLowerCase();
  if (/shopee/.test(fileValue)) return "Shopee";
  if (/lazada|lex/.test(fileValue) || /\blex[a-z0-9-]{6,}/i.test(textValue)) return "Lazada";
  if (/tik[\s_-]*tok/.test(fileValue) || /\bjtth[a-z0-9-]{6,}/i.test(textValue)) {
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
    return {
      id: fileName + "-" + (index + 1),
      sourceFileName: fileName,
      marketplace,
      recipientName: cleanShippingRecipientName_(
        marketplace,
        stringValue_(value && value.recipientName),
      ),
      shippingAddress: cleanShippingAddress_(
        stringValue_(value && value.shippingAddress),
      ),
      orderId: stringValue_(value && value.orderId),
      trackingNumber: stringValue_(value && value.trackingNumber),
      status: "incomplete",
      reviewReasons: [],
    };
  });

  return dedupeShippingLabels_(labels).map(function (label) {
    label.reviewReasons = getShippingLabelReviewReasons_(label);
    label.status = label.reviewReasons.length ? "incomplete" : "ready";
    return label;
  });
}

function dedupeShippingLabels_(labels) {
  var keptByTracking = {};
  var output = [];
  (Array.isArray(labels) ? labels : []).forEach(function (label) {
    var tracking = stringValue_(label && label.trackingNumber).toUpperCase();
    if (!tracking) {
      output.push(label);
      return;
    }

    var existingIndex = keptByTracking[tracking];
    if (existingIndex === undefined) {
      keptByTracking[tracking] = output.length;
      output.push(label);
      return;
    }

    if (shippingLabelCompletenessScore_(label) > shippingLabelCompletenessScore_(output[existingIndex])) {
      output[existingIndex] = label;
    }
  });
  return output;
}

function shippingLabelCompletenessScore_(label) {
  if (!label) return 0;
  return [
    label.marketplace && label.marketplace !== "Unknown",
    label.recipientName,
    label.shippingAddress,
    label.orderId,
    label.trackingNumber,
  ].filter(Boolean).length;
}

function cleanShippingRecipientName_(marketplace, value) {
  var name = normalizePdfTextForParsing_(stringValue_(value));
  if (marketplace === "Lazada") {
    name = name
      .replace(/\s*(?:ที่อยู่\s*)?ADDRESS\s*:.*$/i, "")
      .replace(/\s*ที่อยู่\s*:.*$/i, "")
      .trim();
  }
  if (marketplace === "Shopee" && hasShopeeDeliveryInstruction_(name)) return "";
  if (marketplace === "TikTok Shop" && !isLikelyTikTokRecipientName_(name)) return "";
  return name;
}

function cleanShippingAddress_(value) {
  var address = normalizePdfTextForParsing_(stringValue_(value))
    .replace(/^(?:ADDRESS|ที่อยู่)\s*:?\s*/i, "")
    .replace(/\s+(?:Shopee\s+Order\s+No\.?|Order\s*ID|Product\s*Name|ชื่อสินค้า|ตัวเลือกสินค้า|In\s+transit\s+by|Qty\s*Total|NickName)\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  var postalMatch = /^(.*?\b\d{5}\b)(?:\s+.*)?$/.exec(address);
  if (postalMatch && /(?:\bHOME\b|#[\s]*ชื่อสินค้า|[A-Z]\d+[\s_-])/i.test(address.slice(postalMatch[1].length))) {
    address = postalMatch[1].trim();
  }
  return isLikelyShippingAddress_(address) ? address : "";
}

function hasShopeeDeliveryInstruction_(value) {
  return /(?:จัดส่ง|จันทร์\s*ถึง\s*ศุกร์|ส่ง(?:ได้)?\s*เฉพาะ)/i.test(String(value || ""));
}

function isLikelyShippingAddress_(value) {
  var address = stringValue_(value);
  if (address.length < 8) return false;
  if (/\b(?:Shopee\s+Order\s+No\.?|Order\s*ID|Product\s*Name|ชื่อสินค้า|ตัวเลือกสินค้า|In\s+transit\s+by|Qty\s*Total|NickName)\b/i.test(address)) {
    return false;
  }
  if (/\bHOME\b/i.test(address)) return false;
  if (/^[A-Z0-9]+(?:[ _-]+[A-Z0-9.]+){2,}$/i.test(address) && !/[a-z\u0E00-\u0E7F]/.test(address)) {
    return false;
  }
  return /\b\d{5}\b/.test(address) ||
    /(?:บ้านเลขที่|เลขที่|หมู่|ม\.|ตำบล|ต\.|อำเภอ|อ\.|จังหวัด|จ\.|แขวง|เขต|ถนน|ซอย|road|street|district|bangkok|chiang|phuket|udon|thani)/i.test(address);
}

function getShippingLabelReviewReasons_(label) {
  const reasons = [];
  if (label.marketplace === "Unknown") reasons.push("marketplace");
  if (
    !label.recipientName ||
    (label.marketplace === "TikTok Shop" && !isLikelyTikTokRecipientName_(label.recipientName))
  ) {
    reasons.push("recipientName");
  }
  if (!isLikelyShippingAddress_(label.shippingAddress)) reasons.push("shippingAddress");
  if (!label.orderId) reasons.push("orderId");
  if (!label.trackingNumber) reasons.push("trackingNumber");
  return reasons;
}

function isLikelyTikTokRecipientName_(value) {
  var name = String(value || "").trim();
  if (name.length < 2) return false;
  if (!/[A-Za-z\u0E00-\u0E7F]/.test(name)) return false;
  if (/^\(\+?\d{2,3}\)\d|^\+?\d{8,}/.test(name)) return false;
  if (/^JTTH[A-Z0-9-]{6,}\b/i.test(name)) return false;
  if (/^[A-Z]?\d{2,4}[A-Z]?$/i.test(name)) return false;
  if (/^(?:จาก|from)(?:\s|$)/i.test(name)) return false;
  if (/^(?:nickname|order\s*id|shipping date|estimated date|in transit by|product name|qty total)\b/i.test(name)) return false;
  return true;
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
    const sheetRows =
      lastRow > 1
        ? sheet.getRange(2, 1, lastRow - 1, SHIPPING_LABEL_HEADERS.length).getValues()
        : [];
    const existingRows = getExistingShippingLabelRows_(spreadsheet);
    const newLabels = filterNewShippingLabels_(labels, existingRows, fileUrl);
    const readyFileNames = {};
    (labels || []).forEach(function (label) {
      if (label && label.status !== "review" && label.sourceFileName) {
        readyFileNames[label.sourceFileName] = true;
      }
    });
    removeStaleReviewPlaceholders_(sheet, sheetRows, readyFileNames);
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
        .getRange(
          sheet.getLastRow() + 1,
          1,
          rows.length,
          SHIPPING_LABEL_HEADERS.length,
        )
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

function removeStaleReviewPlaceholders_(sheet, existingRows, readyFileNames) {
  if (!sheet || typeof sheet.deleteRow !== "function") return;

  const staleRows = [];
  (existingRows || []).forEach(function (row, index) {
    if (!row || !readyFileNames[stringValue_(row[1])]) return;
    if (stringValue_(row[2]) !== "Unknown" || stringValue_(row[7]) !== "review") {
      return;
    }
    if (row.slice(3, 7).some(function (value) { return stringValue_(value); })) {
      return;
    }
    staleRows.push(index + 2);
  });

  staleRows.reverse().forEach(function (rowNumber) {
    sheet.deleteRow(rowNumber);
  });
}

function filterNewShippingLabels_(labels, existingRows, fileUrl) {
  const existingKeys = {};
  const importedIdentifiers = {};
  (existingRows || []).forEach(function (row) {
    const rowSource = fileUrl ? stringValue_(row[9]) : stringValue_(row[1]);
    existingKeys[
      shippingLabelRowKey_(rowSource, row[5], row[6], row[3], row[4])
    ] = true;
    if (fileUrl && rowSource === fileUrl) {
      if (stringValue_(row[5])) importedIdentifiers["order:" + stringValue_(row[5])] = true;
      if (stringValue_(row[6])) importedIdentifiers["tracking:" + stringValue_(row[6])] = true;
    }
  });

  return (labels || []).filter(function (label) {
    if (fileUrl && label) {
      if (
        (label.orderId && importedIdentifiers["order:" + stringValue_(label.orderId)]) ||
        (label.trackingNumber && importedIdentifiers["tracking:" + stringValue_(label.trackingNumber)])
      ) {
        return false;
      }
    }

    const sourceKey = fileUrl ? fileUrl : label.sourceFileName;
    const key = shippingLabelRowKey_(
      sourceKey,
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

function moveToReview(file) {
  const reviewFolderId = getReviewFolderId_();
  if (!reviewFolderId) {
    throw createProcessingError_(
      "ReviewFolderConfigurationError",
      "ยังไม่ได้ตั้งค่า REVIEW_FOLDER_ID",
      true,
    );
  }

  const reviewFolder = DriveApp.getFolderById(reviewFolderId);
  file.moveTo(reviewFolder);
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
  const marketplace = detectMarketplaceForFile_(fileName, text);
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
  const labels = ensureOcrLabelCompleteness_(
    fileName,
    text,
    parseOcrShippingLabels_(fileName, text),
  );
  labels.forEach(function (label) {
    label.fileUrl = fileUrl;
    label.source = "drive-ocr";
  });
  return labels;
}

function ensureOcrLabelCompleteness_(fileName, text, labels) {
  var value = normalizeOcrText_(text);
  var marketplace = detectMarketplaceForFile_(fileName, value);
  var expectedCount = 0;
  if (marketplace === "Shopee") {
    var shopeeOrderIds = uniqueValues_(collectRegexValues_(
      value,
      /Shopee\s+Order\s+No\.?\s*:?[ \t]*([A-Z0-9-]+)/gi,
    )).filter(function (orderId) {
      return /^\d{6,}[A-Z0-9-]+$/i.test(orderId);
    });
    expectedCount = Math.max(
      uniqueValues_(collectRegexValues_(value, /\bTH[A-Z0-9-]{8,}\b/gi)).length,
      shopeeOrderIds.length,
      Array.isArray(labels) ? labels.length : 0,
    );
  } else if (marketplace === "Lazada") {
    expectedCount = Math.max(
      uniqueValues_(collectRegexValues_(value, /(?:LAZADA\s+)?Order\s+(?:No\.?|Number)\s*:\s*([A-Z0-9-]+)/gi)).length,
      uniqueValues_(collectRegexValues_(value, /\bLEX[A-Z0-9-]{6,}\b/gi)).length,
    );
  } else if (marketplace === "TikTok Shop") {
    expectedCount = Math.max(
      uniqueValues_(collectRegexValues_(value, /Order\s*ID\s*:\s*([A-Z0-9-]+)/gi)).length,
      uniqueValues_(collectRegexValues_(value, /\bJTTH[A-Z0-9-]{6,}\b/gi)).length,
    );
  }

  var candidates = Array.isArray(labels) ? labels.slice() : [];
  var missingCount = expectedCount - candidates.length;
  for (var index = 0; index < missingCount; index++) {
    candidates.push({
      id: fileName + "-missing-" + (index + 1),
      sourceFileName: fileName,
      marketplace: marketplace,
      recipientName: "",
      shippingAddress: "",
      orderId: "",
      trackingNumber: "",
      status: "incomplete",
      reviewReasons: ["marketplace", "recipientName", "shippingAddress", "orderId", "trackingNumber"],
    });
  }
  return candidates;
}

function readOcrField_(text, aliases) {
  var lines = normalizeOcrText_(text).split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    for (var j = 0; j < aliases.length; j++) {
      var escaped = aliases[j].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var match = new RegExp("^" + escaped + "(?:\\s+(?:NAME|NUMBER))?\\s*:\\s*(.*)", "i").exec(line);
      if (match && match[1].trim()) return match[1].trim();
    }
  }
  return "";
}

function readOcrInlineField_(text, pattern) {
  var match = new RegExp(pattern, "im").exec(normalizeOcrText_(text));
  return match && match[1] ? match[1].trim() : "";
}

function readOcrBlockField_(text, startPattern, endPattern) {
  var value = normalizeOcrText_(text);
  var match = new RegExp(startPattern + "\\s*:?\\s*([\\s\\S]*?)(?:" + endPattern + "|$)", "i").exec(value);
  return match && match[1] ? match[1].replace(/\s+/g, " ").trim() : "";
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
  var marketplace = detectMarketplaceForFile_(fileName, text);

  if (marketplace === "Shopee") {
    return parseShopeeOcrShippingLabels_(fileName, text);
  }
  if (marketplace === "Lazada") {
    return parseLazadaOcrShippingLabels_(fileName, text);
  }
  if (marketplace === "TikTok Shop") {
    return parseTikTokOcrShippingLabels_(fileName, text);
  }

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
    return normalizeShippingLabels_(fileName, [{
      marketplace: "Unknown",
      recipientName: "",
      shippingAddress: "",
      orderId: "",
      trackingNumber: "",
    }]);
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

function parseLazadaOcrShippingLabels_(fileName, text) {
  var value = normalizeOcrText_(text);
  var trackingNumber = extractLazadaTrackingNumber_(value);
  var recipientName = readOcrInlineField_(value, "Customer\\s*(?:NAME)?\\s*:\\s*([^\\r\\n]+)") ||
    readOcrField_(value, ["Receiver", "Customer"]);
  var shippingAddress = readLazadaAddress_(value) || readOcrField_(value, ["Address"]);
  var orderId = readOcrInlineField_(value, "(?:LAZADA\\s+)?Order\\s+(?:No\\.?|Number)\\s*:\\s*([A-Z0-9-]+)") ||
    readOcrField_(value, ["LAZADA Order Number", "Order No."]);
  var label = {
    marketplace: "Lazada",
    recipientName: recipientName,
    shippingAddress: shippingAddress,
    orderId: orderId,
    trackingNumber: trackingNumber || readOcrField_(value, ["Tracking"]),
  };
  return normalizeShippingLabels_(fileName, [label]);
}

function readLazadaAddress_(text) {
  var lines = normalizeOcrText_(text).split(/\r?\n/);
  for (var index = 0; index < lines.length; index++) {
    var match = /^(?:ADDRESS|ที่อยู่)\s*:?\s*(.*)$/i.exec(lines[index].trim());
    if (!match) continue;

    var parts = [match[1]].filter(Boolean);
    for (var nextIndex = index + 1; nextIndex < lines.length; nextIndex++) {
      var line = lines[nextIndex].trim();
      if (/^(?:Phone number|Seller Name|Payment Type)\s*:/i.test(line)) break;
      if (line) parts.push(line);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return "";
}

function extractLazadaTrackingNumber_(text) {
  var value = normalizeOcrText_(text);
  var directMatch = /\bLEX[A-Z0-9-]{6,}\b/i.exec(value);
  if (directMatch) return directMatch[0].replace(/-/g, "").toUpperCase();

  var lines = value.split(/\r?\n/);
  for (var index = 0; index < lines.length; index++) {
    if (!/\bLEX/i.test(lines[index])) continue;
    var barcodeText = lines[index];
    for (var nextIndex = index + 1; nextIndex < Math.min(lines.length, index + 3); nextIndex++) {
      var nextLine = lines[nextIndex].trim();
      if (!nextLine || /^Order\b|^Customer\b|^Address\b|^Lazada\b/i.test(nextLine)) break;
      if (!/^[A-Z0-9 -]{4,24}$/i.test(nextLine)) break;
      barcodeText += " " + nextLine;
    }
    var compact = barcodeText.replace(/[\s-]/g, "").toUpperCase();
    var splitMatch = /LEX[A-Z0-9]{10,20}/.exec(compact);
    if (splitMatch) return splitMatch[0];
  }
  return "";
}

function parseTikTokOcrShippingLabels_(fileName, text) {
  var value = normalizeOcrText_(text);
  var lines = value.split(/\r?\n/).map(function (line) { return line.trim(); });
  var multiLabelValues = parseTikTokMultiLabelOcr_(lines, value);
  if (multiLabelValues.length > 1) {
    return normalizeShippingLabels_(fileName, multiLabelValues);
  }
  var columnTrackingEntries = collectTikTokTrackingEntries_(lines);
  if (columnTrackingEntries.length === 1) {
    var columnEntry = columnTrackingEntries[0];
    var columnRecipient = findTikTokRecipientAfterPostal_(lines, columnEntry, lines.length);
    var columnAddress = readTikTokAddressBeforeTracking_(lines, columnEntry.lineIndex, -1);
    if (columnRecipient.name && columnAddress) {
      if (columnRecipient.postalCode && columnAddress.indexOf(columnRecipient.postalCode) < 0) {
        columnAddress = (columnAddress + " " + columnRecipient.postalCode).trim();
      }
      return normalizeShippingLabels_(fileName, [{
        marketplace: "TikTok Shop",
        recipientName: columnRecipient.name,
        shippingAddress: columnAddress,
        orderId: readOcrInlineField_(value, "Order\\s*ID\\s*:\\s*([A-Z0-9-]+)"),
        trackingNumber: columnEntry.value,
      }]);
    }
  }
  var trackingMatch = /\bJTTH[A-Z0-9-]{6,}\b/i.exec(value);
  var recipientBlock = parseTikTokRecipientBeforePostal_(lines);
  var postalIndex = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (/^\d{5}$/.test(lines[i])) {
      postalIndex = i;
      break;
    }
  }

  var recipientName = recipientBlock.name;
  if (!recipientName && postalIndex >= 0) {
    var recipientParts = [];
    for (var recipientIndex = postalIndex + 1; recipientIndex < lines.length; recipientIndex++) {
      if (/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(lines[recipientIndex])) break;
      if (isTikTokNoiseLine_(lines[recipientIndex])) continue;
      recipientParts.push(lines[recipientIndex]);
    }
    recipientName = recipientParts.join(" ").trim();
  }

  var leadingAddress = [];
  var senderIndex = lines.findIndex(function (line) { return /^จาก$/.test(line); });
  var leadingEnd = senderIndex >= 0 ? senderIndex : postalIndex >= 0 ? postalIndex : lines.length;
  for (var leadingIndex = 0; leadingIndex < leadingEnd; leadingIndex++) {
    if (!isTikTokNoiseLine_(lines[leadingIndex])) leadingAddress.push(lines[leadingIndex]);
  }

  var shippingDateIndex = lines.findIndex(function (line) {
    return /^Shipping Date\s*:/i.test(line);
  });
  var trailingAddress = [];
  if (shippingDateIndex >= 0) {
    for (var trailingIndex = shippingDateIndex + 1; trailingIndex < lines.length; trailingIndex++) {
      if (!isTikTokNoiseLine_(lines[trailingIndex]) && !/^\d{1,2}$|^[A-Z]$/i.test(lines[trailingIndex])) {
        trailingAddress.push(lines[trailingIndex]);
      }
    }
  }

  var addressParts = recipientBlock.addressParts.length
    ? recipientBlock.addressParts
    : leadingAddress.concat(trailingAddress);
  if (postalIndex >= 0 && addressParts.indexOf(lines[postalIndex]) < 0) {
    addressParts.push(lines[postalIndex]);
  }

  return normalizeShippingLabels_(fileName, [{
    marketplace: "TikTok Shop",
    recipientName: recipientName,
    shippingAddress: addressParts.join(" ").replace(/\s+/g, " ").trim(),
    orderId: readOcrInlineField_(value, "Order\\s*ID\\s*:\\s*([A-Z0-9-]+)"),
    trackingNumber: trackingMatch ? trackingMatch[0] : "",
  }]);
}

function parseTikTokMultiLabelOcr_(lines, text) {
  var entries = collectTikTokTrackingEntries_(lines);
  if (entries.length < 2) return [];

  var orderIds = uniqueValues_(collectRegexValues_(
    text,
    /Order\s*ID\s*:\s*([A-Z0-9-]+)/gi,
  ));
  return entries.map(function (entry, index) {
    var previousIndex = index > 0 ? entries[index - 1].lineIndex : -1;
    var nextIndex = index + 1 < entries.length ? entries[index + 1].lineIndex : lines.length;
    var recipient = findTikTokRecipientAfterPostal_(lines, entry, nextIndex);
    var address = readTikTokAddressBeforeTracking_(lines, entry.lineIndex, previousIndex);

    // The Drive OCR order can place the sender block immediately before the
    // tracking number. Without a recipient name, that address is unsafe.
    if (!recipient.name) address = "";

    if (recipient.postalCode && address.indexOf(recipient.postalCode) < 0) {
      address = (address + " " + recipient.postalCode).trim();
    }
    return {
      marketplace: "TikTok Shop",
      recipientName: recipient.name,
      shippingAddress: address.replace(/\s+/g, " ").trim(),
      orderId: orderIds[index] || "",
      trackingNumber: entry.value,
    };
  });
}

function collectTikTokTrackingEntries_(lines) {
  var entries = [];
  var seen = {};
  (Array.isArray(lines) ? lines : []).forEach(function (line, lineIndex) {
    collectRegexValues_(String(line || ""), /\bJTTH[A-Z0-9-]{6,}\b/gi).forEach(function (trackingNumber) {
      var value = trackingNumber.replace(/-/g, "").toUpperCase();
      if (seen[value]) return;
      seen[value] = true;
      entries.push({ value: value, lineIndex: lineIndex });
    });
  });
  return entries;
}

function findTikTokRecipientAfterPostal_(lines, entry, endIndex) {
  var values = Array.isArray(lines) ? lines : [];
  var trackingPattern = new RegExp("\\b" + entry.value + "\\s+(\\d{5})\\b", "i");
  for (var index = entry.lineIndex + 1; index < endIndex; index++) {
    var match = trackingPattern.exec(values[index]);
    if (match) return readTikTokRecipientAfterPostalIndex_(values, index, endIndex, match[1]);
  }
  for (var fallbackIndex = entry.lineIndex + 1; fallbackIndex < endIndex; fallbackIndex++) {
    if (/^\d{5}$/.test(values[fallbackIndex])) {
      return readTikTokRecipientAfterPostalIndex_(values, fallbackIndex, endIndex, values[fallbackIndex]);
    }
  }
  return { name: "", postalCode: "" };
}

function readTikTokRecipientAfterPostalIndex_(lines, postalIndex, endIndex, postalCode) {
  for (var nextIndex = postalIndex + 1; nextIndex < Math.min(endIndex, postalIndex + 6); nextIndex++) {
    var candidate = lines[nextIndex];
    if (/^(?:Shipping Date|Estimated Date|Order\s*ID|In transit by|Product Name|Qty Total|NickName)\b/i.test(candidate)) break;
    if (
      !isTikTokNoiseLine_(candidate) &&
      !/^\(\+?\d{2,3}\)\d|^[A-Z]\d\s+[A-Z]\d|^EZ$/i.test(candidate)
    ) {
      return { name: candidate, postalCode: postalCode };
    }
  }
  return { name: "", postalCode: postalCode };
}

function readTikTokAddressBeforeTracking_(lines, trackingIndex, previousTrackingIndex) {
  var values = Array.isArray(lines) ? lines : [];
  var startIndex = Math.max(0, previousTrackingIndex + 1);
  for (var index = trackingIndex - 1; index >= startIndex; index--) {
    if (/^V$/i.test(values[index]) || /^Qty Total\b/i.test(values[index])) {
      startIndex = index + 1;
      break;
    }
  }
  return values.slice(startIndex, trackingIndex)
    .filter(function (line) {
      return !isTikTokNoiseLine_(line) && !/^Qty Total\b|^Order\s*ID\b/i.test(line);
    })
    .join(" ")
    .trim();
}

function parseTikTokRecipientBeforePostal_(lines) {
  var values = Array.isArray(lines) ? lines : [];
  var marker = /^(?:ถึง|ถง|ถึ?ง|เถิง|เธ–เธถเธ|to)\s*:?\s*(.*)$/i;
  var boundary = /^(?:shipping date|estimated date|order\s*id|in transit by|product name|qty total|nickname)\b/i;

  for (var index = 0; index < values.length; index++) {
    var match = marker.exec(values[index]);
    if (!match) continue;

    var name = String(match[1] || "").trim();
    var addressParts = [];
    for (var nextIndex = index + 1; nextIndex < values.length; nextIndex++) {
      var line = values[nextIndex];
      if (boundary.test(line)) break;
      if (/^\d{5}$/.test(line)) {
        addressParts.push(line);
        break;
      }
      if (isTikTokNoiseLine_(line)) continue;
      if (!name) {
        name = line;
      } else {
        addressParts.push(line);
      }
    }

    if (name) return { name: name, addressParts: addressParts };
  }

  return { name: "", addressParts: [] };
}

function isTikTokNoiseLine_(line) {
  var value = String(line || "").trim();
  return (
    !value ||
    /^V$|^จาก$|^ถึง$|^COD$|^PICK[- ]?UP$|^Order ID/i.test(value) ||
    /^Estimated Date|^Shipping Date|^người mua/i.test(value) ||
    /^\(?\+?\d{8,}|^JTTH[A-Z0-9-]{6,}$/i.test(value) ||
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(value)
  );
}

function parseShopeeOcrShippingLabels_(fileName, text) {
  var value = normalizePdfTextForParsing_(normalizeOcrText_(text));
  var recipientMarkers = collectRegexMatches_(
    value,
    /ผู้รับ\s*\(\s*TO\s*\)/gi,
  );

  if (recipientMarkers.length === 0) {
    return prepareShippingLabelsForExport_(fileName, []);
  }

  var trackingEntries = [];
  var trackingSeen = {};
  collectRegexMatches_(value, /\bTH[A-Z0-9-]{8,}\b/gi).forEach(function (match) {
    var trackingNumber = match[0].trim();
    if (trackingSeen[trackingNumber]) return;
    trackingSeen[trackingNumber] = true;
    trackingEntries.push({ value: trackingNumber, index: match.index });
  });
  var orderIds = uniqueValues_(
    collectRegexValues_(
      value,
      /Shopee\s+Order\s+No\.?\s*:?\s*([A-Z0-9-]+)/gi,
    ),
  ).filter(function (orderId) {
    return /^\d{6,}[A-Z0-9-]+$/i.test(orderId);
  });

  var values = recipientMarkers.map(function (marker, index) {
    var nextMarker = recipientMarkers[index + 1];
    var block = value.slice(
      marker.index + marker[0].length,
      nextMarker ? nextMarker.index : value.length,
    );
    var recipient = parseShopeeRecipientBlock_(block);
    var tracking = trackingEntries[index];

    return {
      marketplace: "Shopee",
      recipientName: recipient.name,
      shippingAddress:
        (tracking
          ? parseShopeeAddressBeforeTracking_(value, tracking.index)
          : "") || recipient.address,
      orderId: orderIds[index] || "",
      trackingNumber: tracking ? tracking.value : "",
    };
  });

  return normalizeShippingLabels_(fileName, values);
}

function normalizePdfTextForParsing_(text) {
  return String(text || "")
    .replace(/\uF70A/g, "\u0E48")
    .replace(/\uF70B/g, "\u0E49")
    .replace(/\uF70C/g, "\u0E4A")
    .replace(/\uF70D/g, "\u0E4B")
    .replace(/\uF70E/g, "\u0E4C")
    .replace(/([\u0E00-\u0E7F])([่้๊๋])ู/g, "$1ู$2");
}

function parseShopeeRecipientBlock_(block) {
  var value = String(block || "");
  var recipientSection = value.split(
    /ผู้ส่ง\s*\(\s*FROM\s*\)|PICKUP\s+DATE|SHIP\s+BY\s+DATE|NOTE\b/i,
  )[0];
  var lines = recipientSection
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(Boolean);

  if (lines.length === 0) {
    var afterSender = value.split(/ผู้ส่ง\s*\(\s*FROM\s*\)/i)[1] || "";
    recipientSection = afterSender.split(/NOTE\b|PICKUP\s+DATE|SHIP\s+BY\s+DATE/i)[0];
    lines = recipientSection
      .split(/\r?\n/)
      .map(function (line) { return line.trim(); })
      .filter(Boolean);
  }

  return {
    name: lines.shift() || "",
    address: lines.join(" ").trim(),
  };
}

function parseShopeeAddressBeforeTracking_(text, trackingIndex) {
  if (trackingIndex < 0) return "";

  var lines = String(text || "")
    .slice(0, trackingIndex)
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(Boolean);
  var routeHeaderIndex = -1;
  var routeStopIndex = -1;

  for (var i = lines.length - 1; i >= 0; i--) {
    if (/\s-\s/.test(lines[i])) {
      routeHeaderIndex = i;
      break;
    }
  }

  if (routeHeaderIndex >= 0) {
    for (var j = routeHeaderIndex + 1; j < lines.length; j++) {
      if (/^[A-Z]\d*-(?:\d+|\([A-Z0-9.]+\))$/i.test(lines[j])) {
        routeStopIndex = j;
        break;
      }
    }
  }

  if (routeHeaderIndex < 0 || routeStopIndex <= routeHeaderIndex + 1) return "";
  var address = lines.slice(routeHeaderIndex + 1, routeStopIndex).join(" ").trim();
  return isLikelyShippingAddress_(address) ? address : "";
}

function collectRegexValues_(text, pattern) {
  return collectRegexMatches_(text, pattern).map(function (match) {
    return (match[1] || match[0]).trim();
  });
}

function collectRegexMatches_(text, pattern) {
  var regex = new RegExp(pattern.source, pattern.flags);
  var matches = [];
  var match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    matches.push(match);
    if (match[0] === "") regex.lastIndex += 1;
  }

  return matches;
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
