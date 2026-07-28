# PDF picker and Google Drive link design

## Goal

Add clear controls to the dashboard so an operator can select one or more PDF
files, review the selection locally, and open the Google Drive input folder
that Apps Script monitors.

## Scope

- Add a `เลือกไฟล์ PDF` control that accepts multiple PDF files.
- Display each accepted file name and formatted file size in a local selection
  list.
- Reject non-PDF files with an accessible Thai error message.
- Add a `Go to Drive` link that opens the configured Google Drive input folder
  in a new tab.
- Use `NEXT_PUBLIC_INPUT_DRIVE_URL` for the Drive folder URL, with validation
  that accepts only a Google Drive folder URL.
- Configure the URL in Vercel production and redeploy after implementation.

## Non-goals

- The web app does not upload, retain, parse, or transmit PDF files.
- The web app does not start Apps Script processing.
- No Google OAuth, Drive API, Apps Script web endpoint, or server upload route
  is introduced.

## User flow

1. The operator clicks `เลือกไฟล์ PDF` and chooses one or more local files.
2. The browser accepts files whose MIME type is `application/pdf` or whose
   filename ends with `.pdf` (case-insensitive).
3. Accepted files appear with name and size. Rejected files produce a visible
   message and are not listed.
4. The dashboard instructs the operator to upload the selected files to the
   input folder.
5. `Go to Drive` opens the configured Drive input folder in a new tab. Apps
   Script later detects and processes the uploaded PDFs automatically.

## UI and accessibility

- Place the two actions together in the header near `Go to Sheet`.
- Keep a native file input behind the styled button for keyboard and assistive
  technology compatibility.
- Use an `aria-live` status message for selection and validation feedback.
- Disable `Go to Drive` with an explanatory tooltip when its environment
  variable is absent or invalid.

## Data and validation

- The selected `File` objects remain in React component state only and are
  discarded on refresh.
- A small URL utility validates `https://drive.google.com/.../folders/<id>`
  URLs before rendering the outbound link.
- File size is shown in KB or MB using a deterministic local formatter.

## Tests and verification

- Add unit tests for Drive URL validation and PDF file eligibility/size
  formatting helpers.
- Run `npm test`, `npm run lint`, and `npx next build`.
- Verify the Vercel production deployment renders the configured Drive folder
  URL and responds successfully.
