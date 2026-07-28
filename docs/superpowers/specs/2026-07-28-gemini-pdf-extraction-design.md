# Gemini PDF Extraction Design

## Goal

เพิ่ม Gemini เป็นชั้นอ่านและดึงข้อมูลจาก PDF ใบสั่งซื้อ โดยคงกฎธุรกิจเดิมไว้: ตรวจข้อมูลบังคับ, ป้องกัน Order ID ซ้ำ, บันทึกคำสั่งซื้อที่ผ่านลง Google Sheet, บันทึกงานที่อ่านไม่ได้ลงชีตแยก, และย้ายไฟล์ที่จัดการเสร็จไปยังโฟลเดอร์ Processed

## Scope

การเปลี่ยนแปลงนี้ครอบคลุม Google Apps Script และหน้าจอ Web App ที่มีอยู่แล้วเท่านั้น

- Apps Script ส่ง PDF จาก Google Drive ให้ Gemini วิเคราะห์และขอผลลัพธ์ JSON ตาม schema ที่กำหนด
- Apps Script แปลงผลลัพธ์ให้เป็นรูปแบบคำสั่งซื้อกลาง แล้วใช้กฎตรวจข้อมูลและตรวจ Order ID ซ้ำเดิม
- Web App แสดงว่าแต่ละไฟล์ผ่านขั้น Gemini, แสดงค่าความเชื่อมั่น และแสดงเหตุผลที่ต้องตรวจทานเมื่ออ่านไม่ครบ
- Gemini ใช้เพื่อดึงข้อมูลเท่านั้น ไม่มีสิทธิ์ตัดสินผลซ้ำหรือเขียนข้อมูลลง Google Sheet โดยตรง

ไม่อยู่ในขอบเขต: ระบบล็อกอินใหม่, การสร้างฐานข้อมูลใหม่, การเปลี่ยนหรือย้ายคอลัมน์ Google Sheet เดิม, การเผยแพร่ Web App หรือ Apps Script, และการตั้งค่า/ส่งมอบ Gemini API key จริง. การเพิ่มคอลัมน์ audit ต่อท้ายเป็นข้อยกเว้นที่ระบุไว้ด้านล่าง

## Chosen Architecture

เลือกให้ Google Apps Script เป็นจุดเรียก Gemini เพราะไฟล์ PDF, Google Drive, และ Google Sheet อยู่ใน workflow เดียวกันอยู่แล้ว และทำให้ API key ไม่ผ่านไปถึงเบราว์เซอร์

```text
Web App upload / PDF in Google Drive
                |
                v
        Google Apps Script
                |
                v
 Gemini document extraction (structured JSON)
                |
                v
 normalize -> duplicate check -> required-field validation
                |
       +--------+--------+
       |                 |
       v                 v
 Google Sheet       Read-failed sheet
       |
       v
 Move PDF to Processed
```

Web App ยังเป็นส่วนติดต่อผู้ใช้และแสดงสถานะจำลองของ workflow ในระยะแรก ส่วนการประมวลผลจริงเกิดใน Apps Script เมื่อพบ PDF ในโฟลเดอร์ Google Drive ที่กำหนด

## Components and Responsibilities

### Gemini extractor in Apps Script

รับ `DriveApp.File` ของ PDF, ตรวจชนิดไฟล์, ส่งเนื้อหา PDF ให้ Gemini พร้อมคำสั่งภาษาไทย/อังกฤษที่ระบุว่าให้ตอบ JSON เท่านั้น, แล้วคืนข้อมูลตาม schema นี้ หาก Gemini ไม่ตอบเป็น JSON ที่ parse ได้ ให้ถือว่า extraction ล้มเหลว

```json
{
  "marketplace": "shopee | lazada | tiktok-shop | unknown",
  "orderId": "string",
  "customerName": "string",
  "items": [
    {
      "name": "string",
      "quantity": 1,
      "sku": "string | empty"
    }
  ],
  "quantity": 1,
  "address": "string",
  "total": 0,
  "confidence": 0,
  "missingFields": ["field-name"],
  "rawNotes": "string"
}
```

`confidence` เป็นจำนวนเต็ม 0-100 และบอกความมั่นใจของ Gemini ในการอ่านเอกสาร ไม่ใช่เกณฑ์ผ่านงานด้วยตัวเอง. `items` ต้องเป็น array เสมอ, `quantity` คือผลรวมจำนวนสินค้าทุกรายการ, `total` เป็นตัวเลขไม่ติดสกุลเงิน, และค่าไม่พบข้อมูลต้องเป็นค่าว่างหรืออยู่ใน `missingFields` ไม่ใช่การเดา

### Normalizer and validator

Normalizer รับ JSON ที่ parse แล้ว, trim ข้อความ, แปลง `total` และ `quantity` เป็นตัวเลข, รวมจำนวนสินค้าเมื่อมีรายการ, และแปลง marketplace เป็นชุดค่าที่ Web App และ Google Sheet ใช้ร่วมกัน. ข้อมูลที่ Gemini คืนมาโดยไม่ตรงชนิดข้อมูลถือว่าอ่านไม่ครบ ไม่พยายามคาดเดาหรือแก้ไขด้วย AI รอบสอง

Validator ใช้ required fields เดิม: marketplace ที่รู้จัก, Order ID, ชื่อลูกค้า, รายการสินค้าอย่างน้อยหนึ่งรายการ, จำนวนมากกว่า 0, ที่อยู่, และยอดรวมที่เป็นตัวเลขไม่ติดลบ. งานที่ confidence ต่ำกว่า 70 หรือมี `missingFields` ที่เป็น required field จะถูกส่งไปยังชีตอ่านไม่สำเร็จ แม้ค่าบางส่วนจะมีอยู่

### Duplicate checker and sheets writer

Duplicate checker ทำงานหลัง normalization และก่อนเขียนข้อมูล. หากพบ Order ID ซ้ำ จะบันทึกสถานะ `duplicate` พร้อมชื่อไฟล์และข้อมูลที่อ่านได้ลงชีตอ่านไม่สำเร็จ และไม่เขียนแถวซ้ำลงชีตคำสั่งซื้อ

Sheets writer เป็นจุดเดียวที่เขียนข้อมูลลง Google Sheet. ต้องรักษาลำดับคอลัมน์เดิมทุกคอลัมน์ และเพิ่มคอลัมน์ audit ต่อท้ายเท่านั้น: `Source` และ `Confidence` บน Orders; `Confidence`, `Missing Fields`, และ `Raw Notes` บน Read Failed. แถวคำสั่งซื้อที่ผ่านการตรวจจะมี `Source` เป็น `gemini`; แถวอ่านไม่สำเร็จจะมีชื่อไฟล์, เหตุผล, marketplace/Order ID ที่อ่านได้ (ถ้ามี), และข้อมูล audit เหล่านี้

### Web App status presentation

เพิ่มขั้น `Gemini อ่าน PDF` ไว้หลัง `อ่านข้อความใน PDF` และก่อน `เลือก Parser` ใน workflow UI. งานที่สำเร็จจะแสดง source เป็น Gemini และค่า confidence. งานที่ต้องตรวจจะแสดงเหตุผลที่มาจาก validation, duplicate check, หรือ Gemini response ที่ใช้ไม่ได้ โดยไม่แสดง API key, prompt, หรือไฟล์ PDF เต็มเนื้อหา

## Data Flow

1. ผู้ใช้อัปโหลด PDF ผ่าน Web App หรือวาง PDF ไว้ใน Google Drive input folder
2. Apps Script หาไฟล์ PDF ที่ยังไม่ถูกประมวลผลและเรียก Gemini extractor หนึ่งครั้งต่อไฟล์
3. Apps Script parse และ normalize JSON ที่ Gemini ส่งกลับ
4. Apps Script ตรวจ Order ID ซ้ำ
5. Apps Script ตรวจ required fields, `missingFields`, และ confidence
6. งานที่ผ่านถูกเพิ่มลง Orders sheet; งานที่ไม่ผ่านถูกเพิ่มลง Read Failed sheet
7. หลังบันทึกผลสำเร็จแล้ว Apps Script ย้าย PDF ไป Processed folder เพื่อไม่ให้ประมวลผลซ้ำ

การย้ายไฟล์เกิดหลังจากเขียนผลลัพธ์ลงชีตเท่านั้น. ถ้าเกิดข้อผิดพลาดชั่วคราวในการเรียก Gemini หรือเขียนชีต ไฟล์จะอยู่ใน input folder เพื่อให้รอบถัดไปลองใหม่ได้. เมื่อบันทึก Read Failed sheet สำเร็จแล้ว ไฟล์ที่อ่านไม่ได้หรือซ้ำจะย้ายไป Processed ตาม workflow เดิม

## Error Handling

| Condition | Result |
| --- | --- |
| ไม่มี `GEMINI_API_KEY` | บันทึกข้อผิดพลาดไว้ใน execution log; ไม่ย้ายไฟล์ เพื่อให้แก้การตั้งค่าแล้วลองใหม่ |
| ไฟล์ไม่ใช่ PDF หรืออ่านไฟล์ไม่ได้ | เพิ่มแถว Read Failed พร้อมเหตุผล แล้วจึงย้ายไป Processed |
| Gemini timeout, HTTP error, หรือ response ว่าง | บันทึกข้อผิดพลาดไว้ใน execution log; ไม่ย้ายไฟล์ เพื่อให้ trigger รอบต่อไปลองใหม่ |
| JSON ไม่ถูกต้องหรือผิด schema | เพิ่มแถว Read Failed พร้อมเหตุผลและข้อความที่ปลอดภัยต่อการแสดงผล แล้วจึงย้ายไป Processed |
| confidence ต่ำกว่า 70 หรือข้อมูลบังคับไม่ครบ | เพิ่มแถว Read Failed พร้อม fields ที่ขาด แล้วจึงย้ายไป Processed |
| Order ID ซ้ำ | เพิ่มแถว Read Failed สถานะ `duplicate`; ไม่เขียน Orders sheet; ย้ายไป Processed |
| เขียน Google Sheet ไม่สำเร็จ | โยน error เพื่อให้ Apps Script รายงาน; ไม่ย้ายไฟล์ |

ไม่มีกลไก retry ภายใน execution เดียว เพราะ Apps Script มีข้อจำกัดเวลา. การ retry เป็นผลจากไฟล์ยังอยู่ใน input folder และ trigger รอบถัดไป

## Security and Configuration

- เก็บ Gemini API key ใน Apps Script Script Properties ภายใต้ชื่อ `GEMINI_API_KEY`; ห้ามใส่ใน source code, Web App, README ตัวอย่างที่มีค่าใช้งานได้, หรือ Google Sheet
- เก็บชื่อโมเดลใน Script Properties ชื่อ `GEMINI_MODEL` เพื่อให้เปลี่ยนรุ่นได้โดยไม่แก้โค้ด
- ใช้ `UrlFetchApp` จาก Apps Script เพื่อเรียก Gemini API; Web App จะไม่เรียก Gemini โดยตรง
- Prompt ต้องสั่งให้ดึงเฉพาะข้อมูลคำสั่งซื้อ, ไม่เดาข้อมูล, และตอบตาม JSON schema เท่านั้น
- บันทึกเฉพาะข้อมูลจำเป็นสำหรับการตรวจสอบใน Google Sheet; ไม่บันทึกเนื้อหา PDF เต็มฉบับหรือ API response เต็มฉบับ

Gemini รองรับการประมวลผลเอกสาร PDF และ structured output ตาม JSON schema. สำหรับไฟล์ขนาดใหญ่หรือการใช้ File API ในอนาคต ต้องคำนึงว่าไฟล์อัปโหลดเก็บไว้ชั่วคราว; รุ่นแรกจะส่งข้อมูลจาก Apps Script ต่อคำขอและไม่ออกแบบให้เก็บไฟล์กับ Gemini ระยะยาว

## Testing and Acceptance Criteria

- เพิ่ม unit tests ให้ normalizer แปลงข้อมูลจาก Gemini ที่ถูกต้องเป็นรูปแบบคำสั่งซื้อของแอป
- เพิ่ม unit tests สำหรับ response ที่ JSON ผิด, ขาด required fields, confidence 69, และ Order ID ซ้ำ เพื่อยืนยันว่าไม่เข้าชีต Orders
- ยืนยันว่า response ที่ครบและ confidence 70 ขึ้นไปถูกบันทึกเป็นสถานะสำเร็จและประกอบด้วย `source: gemini`
- ยืนยันว่า Web App แสดงขั้น Gemini, confidence, และข้อความเหตุผลของงานที่ต้องตรวจ
- รัน `npm test` และ `npm run lint` เพื่อยืนยันว่า Web App และ workflow tests เดิมไม่เสีย
- ทดสอบ Apps Script แบบ dry-run ด้วย fixture JSON โดยไม่ต้องใช้ API key จริง เพื่อทดสอบ normalization, validation, duplicate handling, และการเลือกปลายทางของชีต

## Decisions

- เริ่มจาก Gemini เป็นตัวดึงข้อมูลหลัก ไม่ใช้ regex parser เป็น fallback ในรุ่นนี้ เพื่อให้ผลลัพธ์และสาเหตุที่ต้องตรวจมีมาตรฐานเดียวกัน
- ใช้เกณฑ์ confidence 70/100 เป็นเกณฑ์ส่งต่อให้ validator; validator ยังมีสิทธิ์ปฏิเสธข้อมูลแม้ confidence สูง
- ไม่เพิ่มโฟลเดอร์ Review ในรุ่นนี้. งานที่ตรวจไม่ผ่านจะไป Read Failed sheet และ PDF ไป Processed เพื่อสอดคล้องกับ workflow ที่ผู้ใช้กำหนด
- ไม่ตั้งค่า API key จริงหรือเรียก Gemini API ระหว่างการพัฒนา; ขั้นตอนนี้ต้องเกิดใน Google Apps Script ของผู้ใช้ภายหลัง

## References

- [Gemini API document processing](https://ai.google.dev/gemini-api/docs/document-processing)
- [Gemini API structured output](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini API file input methods](https://ai.google.dev/gemini-api/docs/file-input-methods)
