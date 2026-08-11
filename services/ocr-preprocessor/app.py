import os

from fastapi import FastAPI, Header, HTTPException, Request, Response

from preprocessor import preprocess_pdf_bytes


app = FastAPI(title="Sheet Label OCR Preprocessor", version="1.0.0")
MAX_BYTES = int(os.getenv("MAX_PDF_BYTES", str(25 * 1024 * 1024)))
PREPROCESSOR_TOKEN = os.getenv("PREPROCESSOR_TOKEN", "").strip()


@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.post("/preprocess")
async def preprocess(request: Request, authorization: str | None = Header(default=None)):
    if PREPROCESSOR_TOKEN:
        expected = "Bearer " + PREPROCESSOR_TOKEN
        if authorization != expected:
            raise HTTPException(status_code=401, detail="Unauthorized")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="PDF body is required")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="PDF is too large")
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/pdf":
        raise HTTPException(status_code=415, detail="Content-Type must be application/pdf")

    try:
        processed = preprocess_pdf_bytes(body)
    except Exception as error:
        raise HTTPException(status_code=422, detail="Unable to preprocess PDF") from error

    return Response(
        content=processed,
        media_type="application/pdf",
        headers={"X-Preprocessed": "true"},
    )
