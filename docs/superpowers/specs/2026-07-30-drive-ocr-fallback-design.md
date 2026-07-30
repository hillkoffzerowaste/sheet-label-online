# Google Drive OCR fallback for Gemini quota exhaustion

## Goal

ให้ระบบประมวลผล PDF จาก Google Drive ต่อได้เมื่อ Gemini ใช้งานไม่ได้เพราะโควตาเต็ม โดยไม่ต้องให้ผู้ใช้กดจาก Web App และไม่ทำให้ไฟล์ PDF หายหรือถูกเขียนซ้ำลง Google Sheet

## Recommended design

Apps Script จะใช้ Google Drive OCR เป็นด่านแรก เมื่อ OCR อ่านข้อมูลที่จำเป็นไม่ได้จริงจึงเรียก Gemini เพื่ออ่าน PDF แบบ multimodal. หาก Gemini ตอบ HTTP 429 หรือข้อความที่ระบุว่า quota/rate limit/resource exhausted ระบบจะเก็บผล OCR ที่มีอยู่เป็น `review` และไม่เรียก Gemini ซ้ำ

ลำดับการทำงาน:

1. อ่าน PDF จากโฟลเดอร์ input
2. สร้าง Google Docs ชั่วคราวจาก PDF ด้วย Advanced Drive Service (`Drive.Files.insert` พร้อม `ocr: true` และ `ocrLanguage: "th"`)
3. อ่านข้อความด้วย `DocumentApp`
4. ตรวจ Marketplace และใช้ parser แบบกำหนดกติกาเดิมเพื่อสร้าง Order/Shipping Label
5. ถ้า OCR ให้ข้อมูลใบปะหน้าครบ ให้เขียนผล OCR โดยไม่เรียก Gemini; ถ้าไม่ครบ ให้เรียก Gemini เฉพาะส่วนที่อ่านไม่สำเร็จ
6. กำหนด `source` เป็น `drive-ocr` และกำหนด `confidence` ต่ำกว่าผล Gemini เพื่อให้ข้อมูลที่ไม่แน่ใจไปสถานะ `review`
7. เขียนผลลงชีตรายวัน/ชีต audit ตาม flow เดิม แล้วลบ Google Docs ชั่วคราว
8. ถ้า OCR อ่านไม่ได้หรือข้อมูลไม่ครบ ให้เขียนแถว `review` เมื่อมีข้อมูล และย้าย PDF ไป Processed หลังบันทึกสำเร็จ
9. ถ้า OCR/Drive/Sheet ล้มเหลวแบบ retryable ให้คง PDF ไว้ใน input เพื่อให้ trigger รอบถัดไปลองใหม่

## Error policy

- OCR เป็นเส้นทางหลัก; Gemini เป็น fallback เมื่อ OCR แปลงไม่ได้หรือข้อมูลจำเป็นไม่ครบ
- Gemini response ผิด schema, PDF เสีย, หรือ API key หาย จะไม่ถูกตีความว่า quota เต็ม
- ห้ามเรียก Gemini ซ้ำใน execution เดียวหลังพบ HTTP 429 เพื่อไม่ใช้โควตาเพิ่ม
- ใช้ข้อความ OCR เดิมร่วมกับการ parse ใบปะหน้าและ Order ภายใน execution เดียว
- การเขียนข้อมูลต้องใช้ key เดิมของไฟล์/Order ID/Tracking เพื่อป้องกันแถวซ้ำ

## Google services

ใช้ Advanced Google Service: Drive API ที่มีอยู่ใน Apps Script project และ `DocumentApp` สำหรับอ่านข้อความ OCR ไม่เพิ่ม API key ใหม่ ไม่ส่งไฟล์ไปบริการภายนอกเพิ่มเติม

## Parser boundary

แยกขั้นตอน `extractTextWithDriveOcr_` ออกจากการตรวจ Marketplace และ parser เพื่อให้ทดสอบได้โดยไม่เรียกบริการ Google จริง ค่าที่ parser อ่านไม่ได้จะเป็นค่าว่างและถูกจัดเป็น `review` ไม่เดาข้อมูลจากบริบท

## Testing

เพิ่ม unit tests สำหรับ:

- ตรวจว่า HTTP 429/ข้อความ quota ถูกจัดเป็น quota error
- ตรวจว่า error อื่นไม่เข้า OCR fallback
- ตรวจว่า OCR result ถูกกำหนด source เป็น `drive-ocr`
- ตรวจว่า OCR fallback คืน review เมื่อข้อมูลจำเป็นขาด
- ตรวจว่าไฟล์ไม่ถูกย้ายเมื่อ OCR/Sheet ล้มเหลวแบบ retryable
- รักษา test เดิมของ Gemini, duplicate detection, date sheets และ Marketplace ทั้งสามแบบ

## Scope limits

รุ่นแรกไม่รับประกันการแบ่งขอบเขตใบปะหน้าหลายใบใน PDF ที่ OCR ทำลายลำดับคอลัมน์ หากแยกไม่ได้ให้เขียนเป็น `review` พร้อมเหตุผล แทนการเดาข้อมูลหรือส่งไฟล์ไป Gemini ซ้ำ
