# OCR image preprocessor for Cloud Run

This service accepts a PDF and returns a new OCR-friendly PDF. Each page is rendered at high resolution, auto-rotated when Tesseract can determine the orientation, cropped to the non-empty content area, enlarged, converted to grayscale, contrast-normalized, denoised, and sharpened.

## Local test

```powershell
python -m unittest discover -s services/ocr-preprocessor -p 'test_*.py'
```

## Deploy to Cloud Run

Run from the repository root after selecting the correct Google Cloud project:

```powershell
gcloud run deploy sheet-label-ocr-preprocessor `
  --source services/ocr-preprocessor `
  --region asia-southeast1 `
  --allow-unauthenticated `
  --set-env-vars PREPROCESSOR_TOKEN=REPLACE_WITH_RANDOM_TOKEN
```

The service uses a bearer token at the application layer. Keep the token private and do not commit it. Copy the deployed service URL without a trailing slash into Apps Script Script Properties:

```text
OCR_PREPROCESSOR_URL=https://SERVICE-URL
OCR_PREPROCESSOR_TOKEN=the-same-random-token
```

The Apps Script OCR path calls `/preprocess` once per PDF. If `OCR_PREPROCESSOR_URL` is empty, the existing OCR path remains active without preprocessing.
