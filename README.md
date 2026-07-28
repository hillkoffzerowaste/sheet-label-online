# PDF Order Intake Web App

Prototype web app สำหรับรับ PDF คำสั่งซื้อ marketplace แล้วจำลอง workflow ก่อนบันทึกลง Google Sheet

## Run Locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm run test:workflow
npm test
npm run build
```

## What The Prototype Does

- รับไฟล์ PDF ผ่านหน้าเว็บด้วย file picker หรือ drag-and-drop
- แสดงคิวไฟล์จาก Web App และตัวอย่างไฟล์จาก Google Drive
- จำลอง workflow 7 ขั้นตอน:
  - อ่านข้อความใน PDF
  - Gemini อ่าน PDF
  - ตรวจช่องทาง Marketplace
  - เลือก Parser
  - แยกรายการคำสั่งซื้อ
  - ตรวจ Order ID ซ้ำ
  - ตรวจข้อมูลครบ
- แยกผลลัพธ์เป็นข้อมูลครบ, ข้อมูลไม่ครบ, Order ID ซ้ำ, และอ่าน PDF ไม่สำเร็จ
- แสดงผลลัพธ์ที่พร้อมนำไปลง Google Sheet

## Google Apps Script Setup

ไฟล์ตัวอย่างอยู่ที่ `apps-script/Code.gs`

ก่อนใช้งานจริง ให้เปลี่ยน constants ด้านบนของไฟล์:

```js
const INPUT_FOLDER_ID = "PASTE_INPUT_FOLDER_ID";
const PROCESSED_FOLDER_ID = "PASTE_PROCESSED_FOLDER_ID";
const SPREADSHEET_ID = "PASTE_SPREADSHEET_ID";
const SUCCESS_SHEET_NAME = "Orders";
const FAILED_SHEET_NAME = "Read Failed";
```

โครงสร้างชีตที่แนะนำ:

- `Orders`: เก็บรายการที่ข้อมูลครบ
- `Read Failed`: เก็บรายการที่อ่านไม่ได้, ข้อมูลไม่ครบ, Marketplace ไม่รู้จัก, หรือ Order ID ซ้ำ

ถ้าจะใช้ OCR อ่าน PDF ใน Apps Script ให้เปิด Advanced Google services > Drive API ก่อน เพราะ `extractPdfText_()` ใช้ `Drive.Files.copy()` เพื่อแปลง PDF เป็น Google Docs ชั่วคราว

## Gemini Setup

การประมวลผลจริงใน `apps-script/Code.gs` ใช้ Gemini อ่าน PDF โดยตรง และไม่ส่ง API key ไปที่ Web App

1. เปิด Apps Script project แล้วเลือก **Project Settings** > **Script Properties**
2. เพิ่ม `GEMINI_API_KEY` ด้วย Gemini API key ที่ใช้งานจริง
3. เพิ่ม `GEMINI_MODEL` ด้วยชื่อโมเดลที่ต้องการใช้ เช่น `gemini-2.5-flash` (หากไม่กำหนด ระบบจะใช้ค่า default เดียวกันใน Apps Script)
4. ตรวจว่า `Orders` รักษาคอลัมน์เดิมไว้ และมี `Source`, `Confidence` ต่อท้าย; `Read Failed` ต้องมี `Confidence`, `Missing Fields`, `Raw Notes` ต่อท้าย
5. วาง PDF ที่ทราบผลไว้ใน input folder หนึ่งไฟล์, ตรวจ execution log, ตรวจแถวในชีตปลายทาง และยืนยันว่าไฟล์ถูกย้ายไปยัง Processed folder ตามสถานะ

Gemini จะดึงข้อมูลออกมาเป็น JSON เท่านั้น จากนั้น Apps Script จะตรวจ Order ID ซ้ำ, ข้อมูลบังคับ, และ confidence อย่างน้อย 70 ก่อนเขียน `Orders` sheet

- ปัญหา Gemini transport, การตั้งค่า หรือการเขียน Google Sheet จะคงไฟล์ไว้ใน input folder เพื่อให้ trigger รอบต่อไปลองใหม่
- JSON ที่ไม่ตรง schema, ข้อมูลไม่ครบ, confidence ต่ำ และ Order ID ซ้ำ จะถูกบันทึกลง `Read Failed` แล้วจึงย้าย PDF ไป `Processed`
- Web App รุ่นนี้ใช้ข้อมูลจำลองเพื่อแสดง Gemini status และไม่เรียก Gemini API โดยตรง

## Integration Notes

- หน้าเว็บรุ่นนี้ยังจำลองการอ่าน PDF ใน browser
- เมื่อต้องเชื่อมจริง ให้สร้าง Apps Script Web App แล้วให้ frontend ส่ง `fileId` ไปที่ `doPost(e)`
- PDF ที่ประมวลผลแล้วจะถูกย้ายไปโฟลเดอร์ Processed จากฝั่ง Apps Script
