# Marketplace Shipping Label Reader

Web App สำหรับดูรายการใบปะหน้าจัดส่งจาก Shopee, Lazada และ TikTok Shop หลัง Google Apps Script อ่าน PDF ใน Google Drive อัตโนมัติ

## Run locally

```bash
npm install
npm run dev
```

## Verify

```bash
npm test
npm run lint
npx next build
```

## What the dashboard shows

หนึ่งใบปะหน้าจัดส่งเป็นหนึ่งแถว แม้ PDF หนึ่งหน้าจะมีหลายใบปะหน้า ตารางมีคอลัมน์ดังนี้:

1. `Marketplace`
2. `ชื่อผู้รับ`
3. `ที่อยู่จัดส่ง`
4. `หมายเลขคำสั่งซื้อ`
5. `เลขพัสดุ`

มีช่องค้นหาจากทุกคอลัมน์, ตัวกรอง Marketplace/สถานะ, ปุ่มคัดลอกเลขพัสดุ และป้าย `ต้องตรวจสอบ` เมื่อข้อมูลไม่ครบ, ระบุ Marketplace ไม่ได้, Order ID ซ้ำ หรือเลขพัสดุซ้ำ

## Automatic PDF processing

Apps Script ใน `apps-script/Code.gs` เป็นผู้ประมวลผลเพียงรายเดียว:

1. ตรวจ PDF ใน Google Drive input folder
2. อ่านใบปะหน้าจาก Shopee, Lazada หรือ TikTok Shop
3. ใช้ Gemini เมื่อ parser ต้องการข้อมูลโครงสร้างจาก PDF
4. ตรวจข้อมูลที่จำเป็นและหมายเลขซ้ำ
5. เขียนผลลัพธ์ลง Google Sheet แล้วจึงย้าย PDF ที่บันทึกสำเร็จไป Processed folder

Web App ไม่มี API key และไม่เริ่มประมวลผล PDF ใน production; หน้าจอมีไว้แสดงข้อมูลใบปะหน้ามาตรฐานและเปิด Google Sheet เท่านั้น

## Google Apps Script setup

วางเนื้อหาจาก `apps-script/Code.gs` ใน Apps Script project แล้วกำหนดค่า:

```js
const INPUT_FOLDER_ID = "PASTE_INPUT_FOLDER_ID";
const PROCESSED_FOLDER_ID = "PASTE_PROCESSED_FOLDER_ID";
const SPREADSHEET_ID = "PASTE_SPREADSHEET_ID";
```

ตั้งค่า Script Properties:

```text
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.1-flash-lite
```

เปิดใช้ OCR fallback ใน Apps Script editor ด้วยเมนู **บริการ (+) → Drive API → เพิ่ม**. หากระบบพาไป Google Cloud Console ให้เปิด Google Drive API ด้วย. OCR fallback ใช้สิทธิ์ของ Apps Script และไม่ต้องใช้ API key เพิ่ม; ระบบจะใช้เมื่อ Gemini ตอบว่า quota/rate limit เต็ม และจะสร้าง Google Docs ชั่วคราวเพื่ออ่านข้อความก่อนลบทิ้ง.

ใน Apps Script editor ให้สร้าง installable **time-driven trigger** ที่เรียก `processInputFolder` ทุก 10 นาที. Trigger นี้เป็นผู้เริ่มการสแกน Drive อัตโนมัติ; Web App ไม่ได้เริ่มการประมวลผลเอง.

Apps Script จะเพิ่มแท็บ `Shipping Labels` เมื่อต้องเขียนผลครั้งแรก โดยมีคอลัมน์:

```text
Processed At, Source File, Marketplace, Recipient Name, Shipping Address,
Order ID, Tracking Number, Status, Review Reasons, File URL
```

หาก Gemini หรือ Google Sheet มีความผิดพลาดที่ลองใหม่ได้ ระบบจะคง PDF ไว้ใน input folder สำหรับรอบถัดไป. รายการที่อ่านไม่ครบแต่บันทึกได้จะถูกเก็บเป็น `review` ใน `Shipping Labels` เพื่อไม่ให้ข้อมูลสูญหาย.

## Go to Sheet

The app includes the configured public destination Sheet URL as a fallback, so `Go to Sheet` remains usable even when the Vercel environment variable has not been added yet. Set `NEXT_PUBLIC_DESTINATION_SHEET_URL` to override it for another deployment.

กำหนด Vercel environment variable นี้เป็น URL ของ spreadsheet ปลายทาง:

```bash
NEXT_PUBLIC_DESTINATION_SHEET_URL=https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit
```

ปุ่ม `Go to Sheet` จะแสดงเสมอและเปิดชีตในแท็บใหม่. หากกำหนด environment variable จะใช้ค่านั้น; หากไม่กำหนดจะใช้ URL ปลายทางที่ตั้งไว้ในระบบ. ค่านี้เป็น URL สาธารณะ ไม่ใช่ API key และสิทธิ์เข้าถึงยังควบคุมด้วย Google sharing settings.

## Go to Drive and PDF selection

The app also includes the configured public input-folder URL as a fallback, so `Go to Drive` remains usable without a local `.env` file. Set `NEXT_PUBLIC_INPUT_DRIVE_URL` to override it for another deployment.

กำหนด Vercel environment variable นี้เป็น URL ของ Google Drive input folder ที่ Apps Script เฝ้าดู:

```bash
NEXT_PUBLIC_INPUT_DRIVE_URL=https://drive.google.com/drive/u/0/folders/1w_qEAjYeZFTmENeoFyjGVRX3syTNB2v5
```

ปุ่ม `เลือกไฟล์ PDF` รองรับการเลือกหลายไฟล์และแสดงเฉพาะชื่อ/ขนาดในเบราว์เซอร์เพื่อช่วยตรวจสอบก่อนอัปโหลดเท่านั้น เว็บแอปจะไม่อัปโหลด ส่งต่อ เก็บ หรืออ่านเนื้อหา PDF. ให้กด `Go to Drive` แล้วอัปโหลดไฟล์เหล่านั้นเข้า input folder; time-driven trigger ของ Apps Script จะตรวจพบและประมวลผลไฟล์ในรอบถัดไป.

ในตาราง Shipping Labels สามารถกดคัดลอกชื่อผู้รับ, ที่อยู่ และเลขพัสดุได้ทีละแถว. ข้อมูลจะถูกใช้กับ clipboard หลังผู้ใช้กดปุ่มเท่านั้น และจะไม่ถูกบันทึกเพิ่มโดยหน้าเว็บ.

## Vercel deployment

`vercel.json` กำหนดให้ Vercel ใช้ `npx next build` ซึ่งสร้าง `.next` ที่ Vercel ต้องใช้. เชื่อม repository ที่ root directory และไม่ต้องกำหนด Output Directory เพิ่ม.

## Data safety

อย่า commit PDF ลูกค้าจริง, API key, ชื่อผู้รับ, ที่อยู่, Order ID หรือเลขพัสดุ. Fixtures และ tests ใน repository ใช้ข้อมูลสังเคราะห์เท่านั้น.
