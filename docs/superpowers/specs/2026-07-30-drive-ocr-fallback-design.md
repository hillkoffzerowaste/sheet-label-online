# Google Drive OCR fallback for Gemini quota exhaustion

## Goal

ให้ระบบประมวลผล PDF จาก Google Drive ต่อได้เมื่อ Gemini ใช้งานไม่ได้เพราะโควตาเต็ม โดยไม่ต้องให้ผู้ใช้กดจาก Web App และไม่ทำให้ไฟล์ PDF หายหรือถูกเขียนซ้ำลง Google Sheet

## Recommended design

Apps Script จะยังใช้ Gemini เป็นตัวหลัก เมื่อ Gemini ตอบ HTTP 429 หรือข้อความที่ระบุว่า quota/rate limit/resource exhausted ให้เปลี่ยนไปใช้ Google Drive OCR เฉพาะ execution นั้น

ลำดับการทำงาน:

1. อ่าน PDF จากโฟลเดอร์ input
2. เรียก Gemini ตามปกติ
3. เมื่อพบ quota error ให้สร้าง Google Docs ชั่วคราวจาก PDF ด้วย Advanced Drive Service (`Drive.Files.insert` พร้อม `ocr: true` และ `ocrLanguage: "th"`)
4. อ่านข้อความด้วย `DocumentApp`
5. ตรวจ Marketplace และใช้ parser แบบกำหนดกติกาเดิมเพื่อสร้าง Order/Shipping Label
6. กำหนด `source` เป็น `drive-ocr` และกำหนด `confidence` ต่ำกว่าผล Gemini เพื่อให้ข้อมูลที่ไม่แน่ใจไปสถานะ `review`
7. เขียนผลลงชีตรายวัน/ชีต audit ตาม flow เดิม แล้วลบ Google Docs ชั่วคราว
8. ถ้า OCR อ่านไม่ได้หรือข้อมูลไม่ครบ ให้เขียนแถว `review` เมื่อมีข้อมูล และย้าย PDF ไป Processed หลังบันทึกสำเร็จ
9. ถ้า OCR/Drive/Sheet ล้มเหลวแบบ retryable ให้คง PDF ไว้ใน input เพื่อให้ trigger รอบถัดไปลองใหม่

## Error policy

- เฉพาะ quota/rate-limit errors เท่านั้นที่ใช้ OCR fallback
- Gemini response ผิด schema, PDF เสีย, หรือ API key หาย จะไม่ถูกตีความว่า quota เต็ม
- ห้าม retry Gemini ซ้ำใน execution เดียวหลังพบ HTTP 429 เพื่อไม่ใช้โควตาเพิ่ม
- OCR fallback ต้องไม่เรียก Gemini อีกครั้ง
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
