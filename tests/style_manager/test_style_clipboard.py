import io
import json
import unittest
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.style_manager import app
from naim.style_manager.arca_style_collector import extract_novelai_metadata, read_stealth_info
from naim.style_manager.image_clipboard import prepare_clipboard_png


def source_image(format="PNG", *, size=(128, 128), metadata=True):
    raw = {
        "model": "nai-diffusion-5-full", "prompt": "artist:synthetic, 한글 풍경",
        "uc": "lowres", "seed": 123, "steps": 28, "scale": 5.5,
        "cfg_rescale": 0.15, "noise_schedule": "native", "sampler": "k_euler",
        "qualityToggle": True, "ucPreset": 3, "skip_cfg_above_sigma": 19,
        "v4_prompt": {"caption": {"base_caption": "artist:synthetic, 한글 풍경",
            "char_captions": [{"char_caption": "synthetic character", "centers": [{"x": 0.25, "y": 0.5}]}]}},
        "v4_negative_prompt": {"caption": {"base_caption": "lowres", "char_captions": [{"char_caption": "bad hands"}]}},
        "unknown_future": {"array": [1, False, "한글"]},
    }
    image = Image.new("RGB", size, (25, 50, 75))
    output = io.BytesIO()
    options = {}
    if metadata:
        if format == "PNG":
            info = PngInfo()
            info.add_text("Comment", json.dumps(raw, ensure_ascii=False))
            options["pnginfo"] = info
        elif format == "WEBP":
            exif = Image.Exif()
            exif[37510] = b"UNICODE\x00" + json.dumps(raw, ensure_ascii=False).encode("utf-16-be")
            options.update(exif=exif, lossless=True)
    image.save(output, format, **options)
    return output.getvalue(), raw


class StyleClipboardTest(unittest.TestCase):
    def test_png_and_webp_metadata_survives_pixel_only_png_reencoding(self):
        for format in ("PNG", "WEBP"):
            with self.subTest(format=format):
                original, raw = source_image(format)
                copied = prepare_clipboard_png(original)
                image = Image.open(io.BytesIO(copied))
                self.assertEqual(image.size, (128, 128))
                self.assertEqual(image.convert("RGB").getpixel((0, 0)), (25, 50, 75))
                self.assertIn("Comment", image.info)
                stripped = io.BytesIO()
                Image.frombytes("RGBA", image.size, image.tobytes()).save(stripped, "PNG")
                self.assertEqual(Image.open(io.BytesIO(stripped.getvalue())).info, {})
                envelope = json.loads(read_stealth_info(stripped.getvalue()))
                self.assertEqual(json.loads(envelope["Comment"]), raw)
                after = extract_novelai_metadata(stripped.getvalue())
                before = extract_novelai_metadata(original)
                for key in ("base_prompt", "negative_prompt", "character_prompts", "model", "sampler",
                            "steps", "scale", "cfg_rescale", "noise_schedule", "seed", "quality_toggle",
                            "uc_preset", "skip_cfg_above_sigma"):
                    self.assertEqual(after[key], before[key], key)

    def test_recopying_stealth_metadata_does_not_lose_unknown_fields(self):
        original, raw = source_image("WEBP")
        copied = prepare_clipboard_png(prepare_clipboard_png(original))
        comment = json.loads(json.loads(read_stealth_info(copied))["Comment"])
        self.assertEqual(comment["unknown_future"], raw["unknown_future"])
        self.assertEqual(comment["v4_prompt"], raw["v4_prompt"])

    def test_images_without_metadata_still_copy_without_fabricated_settings(self):
        for format in ("PNG", "WEBP", "JPEG"):
            with self.subTest(format=format):
                original, _ = source_image(format, metadata=False)
                copied = prepare_clipboard_png(original)
                self.assertIsNone(read_stealth_info(copied))
                self.assertEqual(extract_novelai_metadata(copied)["metadata_status"], "no_metadata")
                if format == "PNG":
                    self.assertEqual(copied, original)

    def test_capacity_and_invalid_image_fail_instead_of_silently_dropping_metadata(self):
        original, _ = source_image(size=(1, 1))
        with self.assertRaisesRegex(ValueError, "너무 작아"):
            prepare_clipboard_png(original)
        with self.assertRaises(OSError):
            prepare_clipboard_png(b"not an image")

    def test_clipboard_endpoint_uses_exact_local_source_without_saving(self):
        original, raw = source_image("WEBP")
        with patch.object(app, "_confirmed_source", return_value=(original, {})) as source:
            response = app.app.test_client().get("/api/arca-styles/images/42/clipboard")
        source.assert_called_once_with("shared", 42, local_shared=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(json.loads(read_stealth_info(response.data))["Comment"]), raw)

    def test_clipboard_endpoint_reports_missing_image_and_invalid_id(self):
        client = app.app.test_client()
        with patch.object(app, "_confirmed_source", side_effect=ValueError("원본 이미지가 없습니다.")) as source:
            self.assertEqual(client.get("/api/arca-styles/images/0/clipboard").status_code, 400)
            self.assertEqual(client.get("/api/arca-styles/images/4294967296/clipboard").status_code, 400)
            source.assert_not_called()
            response = client.get("/api/arca-styles/images/42/clipboard")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["error"], "원본 이미지가 없습니다.")
