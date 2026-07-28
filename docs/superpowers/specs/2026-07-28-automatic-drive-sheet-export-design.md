# Automatic Drive-to-Sheet Export Design

## Goal

ให้ Google Apps Script ตรวจ PDF ใน Google Drive input folder อัตโนมัติทุก 10 นาที, ใช้ Gemini อ่านข้อมูล, เขียนผลลัพธ์ไปยัง Google Sheet ปลายทางเดิม, และให้ Web App มีปุ่มเปิด Google Sheet นั้นโดยตรง

## Scope

- เพิ่ม installable time-driven trigger สำหรับเรียก `processInputFolder` ทุก 10 นาที
- ทำให้การติดตั้ง trigger ทำซ้ำได้โดยไม่สร้าง trigger ซ้อนกัน
- ป้องกันการประมวลผลพร้อมกันด้วย script lock
- จำกัดจำนวน PDF ที่ประมวลผลต่อรอบเพื่ออยู่ภายในเวลา execution ของ Apps Script
- เก็บผลลัพธ์ลง `Orders` หรือ `Read Failed` sheet เดิม แล้วจึงย้าย PDF ตาม policy ที่มีอยู่
- เพิ่มปุ่ม `ดู Google Sheet` ใน Web App ที่เปิด Google Sheet ปลายทางในแท็บใหม่

ไม่อยู่ในขอบเขต: เปลี่ยนรูปแบบข้อมูลใน Orders/Read Failed, สร้างระบบล็อกอิน, เชื่อม Google OAuth ใน browser, หรือส่ง API key ไปยัง Web App

## Chosen Architecture

```text
Google Drive input folder
          |
          v
Apps Script time-driven trigger (every 10 minutes)
          |
          v
LockService -> process a bounded batch of PDFs
          |
          v
Gemini extraction -> duplicate/validation -> Google Sheet
          |
          +-- ready / incomplete / duplicate -> Processed folder
          +-- retryable failure -> stay in input folder

Web App -- public destination-sheet URL --> Google Sheet
```

Apps Script remains the only writer to Google Sheet. The Web App only opens the destination URL; it does not call Google Sheets or receive any credentials.

## Components

### Trigger lifecycle

`installProcessingTrigger()` removes existing triggers whose handler is `processInputFolder`, then creates one time-driven trigger that calls `processInputFolder` every 10 minutes. `removeProcessingTrigger()` removes only triggers with that handler name.

The operator runs `installProcessingTrigger()` once from the Apps Script editor and authorizes Drive, Spreadsheet, ScriptApp, and Gemini-related permissions. Installable triggers run under the account that created them, so that account must keep access to the input folder, processed folder, destination spreadsheet, and Gemini API key property.

### Bounded and locked processing

`processInputFolder()` acquires a script lock with a short non-blocking wait. If a prior execution still holds the lock, it returns a skipped result without changing files or sheets. It processes at most 10 PDF files in one execution, in Drive iterator order, then releases the lock in a `finally` block.

The 10-file limit controls execution time and Gemini usage. Remaining PDFs stay in the input folder and are picked up by the next 10-minute run.

### Destination Sheet link

The Web App reads `NEXT_PUBLIC_DESTINATION_SHEET_URL`. When it contains a valid HTTPS Google Sheets URL, the `ดู Google Sheet` button opens it with `target="_blank"` and `rel="noreferrer"`. When missing or invalid, the button is disabled and explains that the destination URL must be configured.

This public value is the URL of the same spreadsheet identified by `SPREADSHEET_ID` in Apps Script. It is not a credential. The sheet's normal Google sharing settings still decide who can open it.

## Data and Failure Policy

| Situation | Action |
| --- | --- |
| Complete, unique Gemini result | Append to Orders, then move PDF to Processed |
| Duplicate, incomplete, low confidence, or terminal Gemini response error | Append to Read Failed, then move PDF to Processed |
| Gemini transport/configuration error | Log safe error metadata; leave PDF in input folder |
| Google Sheet write failure | Surface error; leave PDF in input folder |
| Concurrent scheduled execution | Skip the later execution; leave all files unchanged |
| More than 10 input PDFs | Process first 10; leave remainder for the next run |

## Web App Experience

The top bar gains a secondary `ดู Google Sheet` link beside the existing batch controls. It is visually secondary to processing actions, has an accessible label that states it opens the destination sheet in a new tab, and never displays the spreadsheet URL as text.

## Testing and Acceptance Criteria

- Add Apps Script dry-run tests that confirm trigger installation removes only old `processInputFolder` triggers and creates one 10-minute trigger
- Add tests that confirm a busy lock skips processing, and a 12-file fixture invokes the file processor 10 times
- Add a Web App render test for the sheet-link control and its disabled state when no URL is configured
- Add unit tests for valid/invalid destination-sheet URL detection
- Run `npm test`, `npm run lint`, and `npx next build`
- Document the one-time Apps Script trigger installation and the `NEXT_PUBLIC_DESTINATION_SHEET_URL` Vercel setting in README

## Security and Operational Notes

- `GEMINI_API_KEY` remains only in Apps Script Script Properties
- `NEXT_PUBLIC_DESTINATION_SHEET_URL` is intentionally public and must never contain an API key or private query parameter
- The trigger installer must not run automatically from the Web App or deployment; it is an operator action inside Apps Script
- Apps Script's time-driven triggers can run slightly later than the nominal time; 10 minutes is a cadence target, not an exact clock time

## References

- [Apps Script installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)
- [Apps Script clock trigger builder](https://developers.google.com/apps-script/reference/script/clock-trigger-builder)
