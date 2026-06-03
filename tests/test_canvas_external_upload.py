import io
import os
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import app


class CanvasExternalUploadTests(unittest.TestCase):
    def build_png(self):
        output = io.BytesIO()
        image = Image.new("RGB", (24, 32), "white")
        meta = PngInfo()
        meta.add_text("parameters", "masterpiece, 한글 프롬프트\nNegative prompt: low quality")
        image.save(output, format="PNG", pnginfo=meta)
        output.seek(0)
        return output

    def build_jpeg_with_user_comment(self):
        output = io.BytesIO()
        image = Image.new("RGB", (24, 32), "white")
        exif = Image.Exif()
        exif[37510] = b"UNICODE\x00" + "best quality, 외부 JPG 프롬프트\nNegative prompt: bad anatomy".encode("utf-16-be")
        image.save(output, format="JPEG", exif=exif)
        output.seek(0)
        return output

    def test_canvas_external_upload_stores_image_and_returns_prompt_payload(self):
        client = app.app.test_client()

        with tempfile.TemporaryDirectory() as temp_dir:
            upload_dir = os.path.join(temp_dir, "canvas", "test_session")

            with patch.object(app, "CANVAS_IMPORT_DIR", temp_dir), \
                 patch.object(app, "get_canvas_import_save_dir", return_value=(upload_dir, "canvas/test_session")):
                response = client.post(
                    "/api/canvas/upload_image",
                    data={
                        "sessionId": "test_session",
                        "file": (self.build_png(), "한글이미지.png"),
                    },
                    content_type="multipart/form-data",
                )

        data = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["name"], "한글이미지.png")
        self.assertTrue(data["src"].startswith("/canvas-imports/canvas/test_session/canvas_upload_"))
        self.assertEqual(data["path"], data["src"])
        self.assertTrue(data["hasPromptInfo"])
        self.assertEqual(data["promptInfo"]["basePrompt"], "masterpiece, 한글 프롬프트")
        self.assertEqual(data["promptInfo"]["negativePrompt"], "low quality")

    def test_canvas_external_upload_reads_exif_user_comment_prompt(self):
        client = app.app.test_client()

        with tempfile.TemporaryDirectory() as temp_dir:
            upload_dir = os.path.join(temp_dir, "canvas", "test_session")

            with patch.object(app, "CANVAS_IMPORT_DIR", temp_dir), \
                 patch.object(app, "get_canvas_import_save_dir", return_value=(upload_dir, "canvas/test_session")):
                response = client.post(
                    "/api/canvas/upload_image",
                    data={
                        "sessionId": "test_session",
                        "file": (self.build_jpeg_with_user_comment(), "외부사진.jpg"),
                    },
                    content_type="multipart/form-data",
                )

        data = response.get_json()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(data["status"], "success")
        self.assertTrue(data["hasPromptInfo"])
        self.assertEqual(data["promptInfo"]["basePrompt"], "best quality, 외부 JPG 프롬프트")
        self.assertEqual(data["promptInfo"]["negativePrompt"], "bad anatomy")


if __name__ == "__main__":
    unittest.main()
