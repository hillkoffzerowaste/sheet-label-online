# Marketplace Shipping Label Table Design

## Goal

ปรับ Web App ให้เป็นหน้าดูรายการใบปะหน้าจัดส่งที่อ่านจาก PDF สำหรับ Shopee, Lazada และ TikTok Shop โดยแสดงหนึ่งใบปะหน้าต่อหนึ่งแถวในตารางมาตรฐานเดียวกัน

## Evidence from the supplied PDF

ตัวอย่าง Shopee SPX มี 4 หน้าและหนึ่งหน้ามีได้มากกว่าหนึ่งใบปะหน้า. ข้อมูลที่ต้องดึงต่อใบปะหน้าคือชื่อผู้รับ, ที่อยู่ผู้รับ, `Shopee Order No.` และเลขพัสดุที่อยู่ใต้ barcode. สเปกนี้ไม่เก็บข้อมูลผู้รับจริงจากไฟล์ตัวอย่างไว้ใน repository หรือ fixtures.

## User Experience

ส่วนหัวแสดงชื่อ `Marketplace Shipping Labels`, จำนวนไฟล์ PDF ที่รับเข้า, จำนวนใบปะหน้าที่อ่านได้ และจำนวนรายการที่ต้องตรวจสอบ.

ตารางหลักมีห้าคอลัมน์ตามลำดับนี้:

1. `Marketplace` - ป้ายสีแยก Shopee, Lazada และ TikTok Shop
2. `ชื่อผู้รับ`
3. `ที่อยู่จัดส่ง`
4. `หมายเลขคำสั่งซื้อ`
5. `เลขพัสดุ`

หนึ่งใบปะหน้าเป็นหนึ่งแถว แม้ PDF หนึ่งหน้ามีหลายใบปะหน้า. หมายเลขคำสั่งซื้อและเลขพัสดุใช้ตัวอักษร monospace; เลขพัสดุมีปุ่มคัดลอกที่ไม่เปลี่ยนแปลงข้อมูลต้นทาง. มีช่องค้นหาเดียวที่ค้นทุกห้าคอลัมน์ และตัวกรอง Marketplace/สถานะ.

แถวที่ดึงข้อมูลไม่ครบ, ระบุ Marketplace ไม่ได้, หรือพบหมายเลขคำสั่งซื้อหรือเลขพัสดุซ้ำ จะแสดงป้าย `ต้องตรวจสอบ` และเหตุผลที่เข้าถึงได้จากหน้ารายการ. แถวปกติไม่ต้องมีสถานะแยกเพื่อให้ตารางอ่านง่าย.

## Data Contract

ทุก parser ส่งผลลัพธ์เป็น `ShippingLabel` เดียวกัน:

```ts
type Marketplace = "Shopee" | "Lazada" | "TikTok Shop" | "Unknown";

type ShippingLabel = {
  id: string;
  sourceFileName: string;
  marketplace: Marketplace;
  recipientName: string;
  shippingAddress: string;
  orderId: string;
  trackingNumber: string;
  status: "ready" | "review";
  reviewReasons: string[];
};
```

`status` เป็น `review` เมื่อค่าใดค่าหนึ่งในชื่อ, ที่อยู่, order ID หรือ tracking number ว่าง, Marketplace เป็น `Unknown`, หรือ `orderId`/`trackingNumber` ซ้ำในชุดผลลัพธ์. ระบบเก็บข้อมูลที่อ่านได้แม้แถวต้องตรวจสอบ เพื่อให้ผู้ใช้แก้ไขจากหลักฐาน PDF ได้.

## Processing Flow

```text
PDF in Drive
  -> Apps Script reads file
  -> detects marketplace
  -> marketplace parser extracts one or more ShippingLabel records
  -> Gemini structured extraction only when the marketplace parser is uncertain
  -> validates fields and duplicate IDs
  -> writes normalized records to Google Sheet
  -> Web App displays the same normalized record shape
```

Apps Script ยังคงเป็นผู้ประมวลผล PDF อัตโนมัติและผู้เขียน Google Sheet เพียงรายเดียว. Web App ไม่ส่ง API key, ไม่เรียก Gemini โดยตรง และไม่มีปุ่มเริ่มประมวลผลจริง. หน้าตารางใช้ผลลัพธ์ที่ parser ส่งมาเท่านั้น.

## Parser Strategy

- `Shopee`: ระบุจากคำว่า `Shopee Order No.`, อ่าน order ID จากคำนั้น, หา tracking number ใต้ barcode, และแยกชื่อ/ที่อยู่จากส่วน `ผู้รับ (TO)`.
- `Lazada`: ระบุจากเครื่องหมาย Lazada และรูปแบบ order/tracking ที่ parser ของ Lazada รู้จัก; ส่งคืน Data Contract เดียวกัน.
- `TikTok Shop`: ระบุจากเครื่องหมาย TikTok Shop และรูปแบบ order/tracking ที่ parser ของ TikTok Shop รู้จัก; ส่งคืน Data Contract เดียวกัน.
- `Unknown` หรือ format ที่อ่านไม่ครบ: เรียก Gemini ด้วย schema `ShippingLabel` ที่บังคับให้คืนค่าว่างแทนการเดา; จากนั้นคงแถวไว้เป็น `review` หากยังไม่ครบ.

Parser ต้องสามารถคืนหลาย `ShippingLabel` จากหน้าเดียวและมี `sourceFileName` เพื่อ trace กลับไปที่ PDF เดิม. ค่าที่ Gemini คืนต้องผ่าน validation เดียวกับ parser แบบกำหนดกติกา.

## Google Sheet Mapping

เพิ่มแผ่นงานผลลัพธ์สำหรับข้อมูลใบปะหน้า โดยใช้คอลัมน์:

`Processed At`, `Source File`, `Marketplace`, `Recipient Name`, `Shipping Address`, `Order ID`, `Tracking Number`, `Status`, `Review Reasons`, `File URL`.

`ready` เขียนเป็นข้อมูลพร้อมใช้งาน ส่วน `review` ยังคงเขียนลงแผ่นงานเดียวกันพร้อมเหตุผลเพื่อไม่ให้ข้อมูลใบปะหน้าหาย. PDF จะย้ายไป Processed หลังบันทึกผลลัพธ์สำเร็จ; ความล้มเหลวที่ retry ได้ยังคงอยู่ใน input folder ตาม policy เดิม.

## Error Handling and Privacy

- เมื่อ parser หรือ Gemini เรียกซ้ำได้ล้มเหลว ระบบไม่ย้าย PDF และปล่อยให้ trigger รอบถัดไปลองใหม่.
- เมื่อ parser อ่านข้อมูลไม่ครบ ระบบเขียนแถว `review` พร้อมเหตุผลและย้าย PDF หลังบันทึกสำเร็จ.
- Web App ต้องไม่ log ชื่อ, ที่อยู่, order ID หรือ tracking number ไปที่ browser console, analytics หรือ test fixtures.
- Unit tests ใช้ค่าจำลองที่ไม่ใช่ข้อมูลลูกค้าจริง.

## Testing and Acceptance Criteria

- Unit tests ยืนยันว่า Shopee, Lazada และ TikTok Shop ถูก normalize เป็น `ShippingLabel` เดียวกัน.
- Fixture ที่มีสองใบปะหน้าในหน้าเดียวต้องได้สองแถว.
- Unit tests ครอบคลุมชื่อ/ที่อยู่/order/tracking ที่ขาด, Marketplace Unknown, Order ID ซ้ำ และ Tracking Number ซ้ำ.
- Render test ยืนยันหัวตารางครบห้าคอลัมน์, ป้าย Marketplace, ตัวกรอง, การค้นหา และปุ่มคัดลอกเลขพัสดุ.
- รัน `npm test`, `npm run lint`, และ `npx next build` ก่อน merge.

## Non-goals

- Web App ไม่ส่ง PDF ตรงไป Gemini หรือ Google Drive.
- ไม่เผยแพร่ PDF หรือข้อมูลผู้รับให้ผู้ที่ไม่มีสิทธิ์ Google Sheet/Drive.
- ไม่ออกแบบใบปะหน้าสำหรับพิมพ์ใหม่; ขอบเขตนี้คืออ่านและแสดงรายการเท่านั้น.
