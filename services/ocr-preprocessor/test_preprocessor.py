import io
import unittest

import fitz
from PIL import Image, ImageDraw

from preprocessor import crop_to_content, preprocess_page, preprocess_pdf_bytes, split_content_regions


class PreprocessorTests(unittest.TestCase):
    def test_splits_a_wide_page_only_when_two_content_regions_are_detected(self):
        image = Image.new("RGB", (240, 100), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((15, 20, 104, 79), fill="black")
        draw.rectangle((135, 20, 224, 79), fill="black")

        regions = split_content_regions(image)

        self.assertEqual(len(regions), 2)
        self.assertGreater(regions[0].width, 80)
        self.assertGreater(regions[1].width, 80)

    def test_crops_blank_margins_without_cutting_content(self):
        image = Image.new("RGB", (120, 100), "white")
        ImageDraw.Draw(image).rectangle((30, 25, 89, 74), fill="black")

        cropped = crop_to_content(image, padding=8)

        self.assertEqual(cropped.size, (76, 66))
        self.assertEqual(cropped.getpixel((8, 8)), (0, 0, 0))
        self.assertEqual(cropped.getpixel((0, 0)), (255, 255, 255))

    def test_preprocess_page_rotates_scales_and_enhances(self):
        image = Image.new("RGB", (80, 40), "white")
        ImageDraw.Draw(image).rectangle((20, 10, 59, 29), fill="black")

        processed = preprocess_page(image, rotation=90, scale=2.0, crop_padding=8)

        self.assertGreater(processed.height, processed.width)
        self.assertEqual(processed.size, (72, 112))
        self.assertLess(min(processed.getextrema()[0]), 80)
        self.assertGreater(max(processed.getextrema()[0]), 220)

    def test_preprocess_pdf_keeps_all_pages_and_returns_pdf_bytes(self):
        source = fitz.open()
        source.new_page(width=200, height=120)
        source.new_page(width=200, height=120)
        source_bytes = source.tobytes()
        source.close()

        output = preprocess_pdf_bytes(source_bytes, dpi=72, rotation_detector=lambda _image: 0)

        self.assertTrue(output.startswith(b"%PDF"))
        processed = fitz.open(stream=io.BytesIO(output), filetype="pdf")
        self.assertEqual(processed.page_count, 2)
        processed.close()


if __name__ == "__main__":
    unittest.main()
