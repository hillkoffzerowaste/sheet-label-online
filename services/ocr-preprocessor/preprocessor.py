import io
import os
import re
from typing import Callable

import fitz
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps


DEFAULT_DPI = int(os.getenv("OCR_RENDER_DPI", "300"))
DEFAULT_SCALE = float(os.getenv("OCR_IMAGE_SCALE", "1.5"))
DEFAULT_CROP_PADDING = int(os.getenv("OCR_CROP_PADDING", "24"))


def crop_to_content(image: Image.Image, padding: int = DEFAULT_CROP_PADDING) -> Image.Image:
    """Trim blank page margins while keeping a small border around the label."""
    rgb = image.convert("RGB")
    gray = ImageOps.grayscale(rgb)
    background = Image.new("L", gray.size, 255)
    difference = ImageChops.difference(gray, background)
    mask = difference.point(lambda value: 255 if value > 18 else 0)
    bbox = mask.getbbox()
    if not bbox:
        return rgb

    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(rgb.width, bbox[2] + padding)
    bottom = min(rgb.height, bbox[3] + padding)
    return rgb.crop((left, top, right, bottom))


def split_content_regions(image: Image.Image) -> list[Image.Image]:
    """Split only wide pages with a clear low-ink valley between two regions."""
    rgb = image.convert("RGB")
    if rgb.width < rgb.height * 1.15:
        return [rgb]

    gray = ImageOps.grayscale(rgb)
    pixels = gray.load()
    ink_by_column = [
        sum(1 for y in range(gray.height) if pixels[x, y] < 235)
        for x in range(gray.width)
    ]
    search_start = int(rgb.width * 0.35)
    search_end = int(rgb.width * 0.65)
    valley_threshold = max(2, int(rgb.height * 0.02))
    runs = []
    run_start = None
    for x in range(search_start, search_end):
        if ink_by_column[x] <= valley_threshold:
            if run_start is None:
                run_start = x
        elif run_start is not None:
            runs.append((run_start, x))
            run_start = None
    if run_start is not None:
        runs.append((run_start, search_end))

    viable = [run for run in runs if run[1] - run[0] >= max(4, int(rgb.width * 0.015))]
    if not viable:
        return [rgb]
    gap_start, gap_end = max(viable, key=lambda run: run[1] - run[0])
    split_at = (gap_start + gap_end) // 2
    left_ink = sum(ink_by_column[:gap_start])
    right_ink = sum(ink_by_column[gap_end:])
    if left_ink < rgb.height or right_ink < rgb.height:
        return [rgb]

    overlap = max(2, int(rgb.width * 0.01))
    return [
        rgb.crop((0, 0, min(rgb.width, split_at + overlap), rgb.height)),
        rgb.crop((max(0, split_at - overlap), 0, rgb.width, rgb.height)),
    ]


def detect_orientation_degrees(image: Image.Image) -> int:
    """Use Tesseract OSD when available; return zero without it."""
    try:
        import pytesseract

        osd = pytesseract.image_to_osd(image, config="--psm 0")
        match = re.search(r"(?:Rotate|Orientation in degrees):\s*(\d+)", osd, re.IGNORECASE)
        if match:
            return int(match.group(1)) % 360
    except Exception:
        pass
    return 0


def preprocess_page(
    image: Image.Image,
    rotation: int | None = None,
    scale: float = DEFAULT_SCALE,
    crop_padding: int = DEFAULT_CROP_PADDING,
) -> Image.Image:
    """Normalize one PDF page for Thai/English shipping-label OCR."""
    prepared = ImageOps.exif_transpose(image.convert("RGB"))
    degrees = detect_orientation_degrees(prepared) if rotation is None else rotation % 360
    if degrees:
        prepared = prepared.rotate(-degrees, expand=True, resample=Image.Resampling.BICUBIC)

    prepared = crop_to_content(prepared, crop_padding)
    prepared = ImageOps.grayscale(prepared)
    prepared = ImageOps.autocontrast(prepared, cutoff=1)
    prepared = ImageEnhance.Contrast(prepared).enhance(1.35)
    prepared = prepared.filter(ImageFilter.MedianFilter(size=3))
    prepared = ImageEnhance.Sharpness(prepared).enhance(1.7)

    if scale != 1:
        width = max(1, round(prepared.width * scale))
        height = max(1, round(prepared.height * scale))
        prepared = prepared.resize((width, height), Image.Resampling.LANCZOS)
    return prepared.convert("RGB")


def preprocess_pdf_bytes(
    pdf_bytes: bytes,
    dpi: int = DEFAULT_DPI,
    rotation_detector: Callable[[Image.Image], int] | None = None,
) -> bytes:
    """Render, normalize, and rebuild every PDF page as an OCR-friendly PDF."""
    source = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    detector = rotation_detector or detect_orientation_degrees
    try:
        for page in source:
            pixmap = page.get_pixmap(dpi=dpi, alpha=False)
            image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
            rotation = detector(image)
            if rotation:
                image = image.rotate(-rotation % 360, expand=True, resample=Image.Resampling.BICUBIC)
            for region in split_content_regions(image):
                pages.append(preprocess_page(region, rotation=0))
    finally:
        source.close()

    if not pages:
        raise ValueError("PDF contains no pages")

    output = io.BytesIO()
    pages[0].save(
        output,
        format="PDF",
        resolution=dpi,
        save_all=True,
        append_images=pages[1:],
    )
    return output.getvalue()
