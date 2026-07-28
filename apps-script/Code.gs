const INPUT_FOLDER_ID = "PASTE_INPUT_FOLDER_ID";
const PROCESSED_FOLDER_ID = "PASTE_PROCESSED_FOLDER_ID";
const SPREADSHEET_ID = "PASTE_SPREADSHEET_ID";
const SUCCESS_SHEET_NAME = "Orders";
const FAILED_SHEET_NAME = "Read Failed";

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
  let order;

  try {
    const text = extractPdfText_(file);
    const marketplace = detectMarketplace(text);
    order = parseOrder(marketplace, text);
    order.fileName = file.getName();
    order.fileUrl = file.getUrl();

    const duplicate = order.orderId && isDuplicateOrder(order.orderId);
    const validation = validateOrder(order);

    if (duplicate) {
      order.status = "duplicate";
      order.reason = "Order ID ซ้ำ";
      appendFailedRow(order);
    } else if (!validation.complete) {
      order.status = "incomplete";
      order.reason = "ข้อมูลไม่ครบ: " + validation.missingFields.join(", ");
      appendFailedRow(order);
    } else {
      order.status = "ready";
      order.reason = "ข้อมูลครบ";
      appendSuccessRow(order);
    }
  } catch (error) {
    order = {
      fileName: file.getName(),
      fileUrl: file.getUrl(),
      marketplace: "Unknown",
      orderId: "",
      customerName: "",
      items: [],
      total: "",
      address: "",
      status: "failed",
      reason: "อ่าน PDF ไม่สำเร็จ: " + error.message,
    };
    appendFailedRow(order);
  }

  moveToProcessed(file);
  return order;
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

  if (!order.orderId) missingFields.push("Order ID");
  if (!order.marketplace || order.marketplace === "Unknown") {
    missingFields.push("Marketplace");
  }
  if (!order.customerName) missingFields.push("Customer");
  if (!order.items || order.items.length === 0) missingFields.push("Items");
  if (!order.items || !order.items.some(function (item) { return item.quantity > 0; })) {
    missingFields.push("Quantity");
  }
  if (!order.address) missingFields.push("Address");

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
  ]);
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
