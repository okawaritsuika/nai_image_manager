import ast
from io import BytesIO
import hashlib
import os
from pathlib import Path
import random
import re
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote

from flask import Flask, jsonify, redirect, request, send_from_directory
from PIL import Image, ImageOps

from naim.images.previews import PREVIEW_BUILD_SLOTS


class FakeSharedLibraryError(RuntimeError):
    pass


class FakeSharedLibrary:
    SharedLibraryError = FakeSharedLibraryError

    def __init__(self):
        self.connected = False
        self.calls = []
        self.images = {}

    def enabled(self):
        return self.connected

    def _image_file(self, style_id, full):
        self.calls.append((style_id, full))
        if style_id not in self.images:
            raise self.SharedLibraryError("synthetic missing shared image")
        return self.images[style_id], "image/png"


class StyleThumbnailPerformanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source_path = Path(__file__).resolve().parents[1] / "naim" / "style_manager" / "app.py"
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        names = {"_add_arca_urls", "style_manager_thumbnail", "arca_style_image"}
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        if {node.name for node in functions} != names:
            raise AssertionError("Required style thumbnail functions were not found in app.py")
        cls.function_nodes = functions

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="naim-style-thumbnails-test-",
            dir=Path.cwd(),
        )
        self.addCleanup(self.temporary.cleanup)
        self.data_dir = Path(self.temporary.name) / "data"
        self.data_dir.mkdir()
        self.generated_dir = self.data_dir / "generated"
        self.confirmed_dir = self.data_dir / "confirmed_style_images"
        self.comparison_dir = self.data_dir / "comparison_images"
        self.arca_dir = self.data_dir / "arca_style_images"
        for root in (self.generated_dir, self.confirmed_dir, self.comparison_dir, self.arca_dir):
            root.mkdir(parents=True)

        self.app = Flask("style_thumbnail_test")
        self.app.config.update(TESTING=True)
        self.shared_library = FakeSharedLibrary()

        def json_response(payload, status=200):
            return jsonify(payload), status

        self.namespace = {
            "app": self.app,
            "Path": Path,
            "request": request,
            "jsonify": jsonify,
            "json_response": json_response,
            "redirect": redirect,
            "send_from_directory": send_from_directory,
            "Image": Image,
            "ImageOps": ImageOps,
            "quote": quote,
            "hashlib": hashlib,
            "os": os,
            "random": random,
            "re": re,
            "DATA_DIR": self.data_dir,
            "GENERATED_DIR": self.generated_dir,
            "CONFIRMED_STYLE_IMAGE_DIR": self.confirmed_dir,
            "COMPARISON_IMAGE_DIR": self.comparison_dir,
            "ARCA_STYLE_IMAGE_DIR": self.arca_dir,
            "PREVIEW_BUILD_SLOTS": PREVIEW_BUILD_SLOTS,
            "naim_shared_library": self.shared_library,
        }
        module = ast.fix_missing_locations(ast.Module(body=self.function_nodes, type_ignores=[]))
        exec(compile(module, "naim/style_manager/app.py", "exec"), self.namespace)
        self.client = self.app.test_client()

    def get(self, *args, **kwargs):
        response = self.client.get(*args, **kwargs)
        self.addCleanup(response.close)
        return response

    def image_path(self, relative="sample.png"):
        return self.arca_dir / relative

    @staticmethod
    def write_image(path, size=(128, 64), color=(180, 90, 30), image_format="PNG", exif=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", size, color)
        image.save(path, format=image_format, exif=exif)

    def test_add_arca_urls_preserves_originals_and_adds_encoded_thumbnails_recursively(self):
        path = "nested dir/한글 #space.png"
        item = {
            "representative_image_path": path,
            "images": [{"image_path": path}, {"image_path": ""}],
            "artists": [{"representative_image": {"image_path": path}}],
            "quality_tags": [{"representative_image": {"image_path": path}}],
            "quality_sequences": [{"representative_image": {"image_path": path}}],
            "style_groups": [{"images": [{"image_path": path}]}],
        }

        result = self.namespace["_add_arca_urls"](item)
        encoded = quote(path, safe="/")
        original = f"/style-workspace/arca-style-images/{path}"
        thumbnail = f"/style-workspace/style-manager-thumbnails/shared/{encoded}"
        self.assertEqual(result["representative_image_url"], original)
        self.assertEqual(result["representative_thumbnail_url"], thumbnail)
        self.assertEqual(result["images"][0]["image_url"], original)
        self.assertEqual(result["images"][0]["thumbnail_url"], thumbnail)
        self.assertEqual(result["artists"][0]["representative_image"]["thumbnail_url"], thumbnail)
        self.assertEqual(result["quality_tags"][0]["representative_image"]["thumbnail_url"], thumbnail)
        self.assertEqual(result["quality_sequences"][0]["representative_image"]["thumbnail_url"], thumbnail)
        self.assertEqual(result["style_groups"][0]["images"][0]["thumbnail_url"], thumbnail)
        self.assertEqual(result["images"][1]["image_url"], "")
        self.assertEqual(result["images"][1]["thumbnail_url"], "")
        self.assertFalse(result["images"][1]["image_available"])

        missing = self.namespace["_add_arca_urls"]({"images": [{"image_path": ""}]})
        self.assertEqual(missing["representative_image_url"], "")
        self.assertEqual(missing["representative_thumbnail_url"], "")
        self.assertEqual(missing["images"][0]["thumbnail_url"], "")

    def test_thumbnail_is_small_webp_cached_with_conditional_etag_and_original_unchanged(self):
        original = self.image_path("nested/photo.png")
        self.write_image(original, size=(1536, 768))
        original_bytes = original.read_bytes()
        url = f"/style-manager-thumbnails/shared/{quote('nested/photo.png', safe='/')}"

        first = self.get(url)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.mimetype, "image/webp")
        with Image.open(BytesIO(first.get_data())) as thumbnail:
            self.assertEqual(thumbnail.size, (384, 192))
        etag = first.headers["ETag"]
        self.assertTrue(etag)

        with mock.patch.object(Image, "open", wraps=Image.open) as image_open:
            cached = self.get(url)
            self.assertEqual(cached.status_code, 200)
            self.assertEqual(cached.mimetype, "image/webp")
            image_open.assert_not_called()

            conditional = self.get(url, headers={"If-None-Match": etag})
            self.assertEqual(conditional.status_code, 304)
            image_open.assert_not_called()

        self.assertEqual(original.read_bytes(), original_bytes)
        self.assertEqual(len(list((self.data_dir / "style_manager_thumbnails").glob("*.webp"))), 1)

    def test_shared_special_id_uses_small_file_while_original_route_keeps_full_redirect(self):
        style_id = "common-" + "a" * 24
        original = self.image_path("shared-preview.png")
        self.write_image(original, size=(1200, 900))
        self.shared_library.connected = True
        self.shared_library.images[style_id] = original

        thumbnail = self.get(f"/style-manager-thumbnails/shared/__naim_shared__/{style_id}")
        self.assertEqual(thumbnail.status_code, 200)
        self.assertEqual(thumbnail.mimetype, "image/webp")
        self.assertEqual(self.shared_library.calls, [(style_id, False)])
        self.assertEqual(thumbnail.cache_control.max_age, 60)
        self.assertNotEqual(thumbnail.status_code, 302)

        full = self.get(f"/arca-style-images/__naim_shared__/{style_id}")
        self.assertEqual(full.status_code, 302)
        self.assertTrue(full.headers["Location"].endswith(f"/{style_id}/preview?full=1"))

    def test_thumbnail_applies_exif_orientation_and_keeps_alpha(self):
        path = self.image_path("oriented.png")
        path.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGBA", (80, 40), (0, 0, 0, 0))
        image.putpixel((10, 10), (220, 40, 20, 255))
        exif = Image.Exif()
        exif[274] = 6
        image.save(path, format="PNG", exif=exif)

        response = self.get("/style-manager-thumbnails/shared/oriented.png")
        self.assertEqual(response.status_code, 200)
        with Image.open(BytesIO(response.get_data())) as thumbnail:
            self.assertEqual(thumbnail.size, (40, 80))
            self.assertEqual(thumbnail.mode, "RGBA")
            self.assertEqual(thumbnail.getchannel("A").getextrema(), (0, 255))

    def test_mtime_change_creates_a_new_cache_entry(self):
        original = self.image_path("mtime.png")
        self.write_image(original, size=(512, 256))
        url = "/style-manager-thumbnails/shared/mtime.png"
        first = self.get(url)
        self.assertEqual(first.status_code, 200)
        before = original.stat()
        os.utime(original, ns=(before.st_atime_ns, before.st_mtime_ns + 5_000_000_000))
        after = original.stat()
        self.assertGreater(after.st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(after.st_size, before.st_size)

        with mock.patch.object(Image, "open", wraps=Image.open) as image_open:
            second = self.get(url)
            self.assertEqual(second.status_code, 200)
            image_open.assert_called_once()
        self.assertEqual(len(list((self.data_dir / "style_manager_thumbnails").glob("*.webp"))), 2)

    def test_invalid_paths_sources_and_missing_images_keep_existing_http_errors(self):
        view = self.namespace["style_manager_thumbnail"]
        with self.app.test_request_context():
            invalid_source, status = view("unknown", "image.png")
            self.assertEqual(status, 400)
            traversal, status = view("shared", "../outside.png")
            self.assertEqual(status, 400)
            missing, status = view("shared", "missing.png")
            self.assertEqual(status, 404)
            invalid_original, status = self.namespace["arca_style_image"]("../outside.png")
            self.assertEqual(status, 400)
        self.assertEqual(invalid_source.json["error"], "Invalid style manager thumbnail path.")
        self.assertEqual(traversal.json["error"], "Invalid style manager thumbnail path.")
        self.assertEqual(missing.json["error"], "Style manager image not found.")
        self.assertEqual(invalid_original.json["error"], "Invalid archive image path.")

    def test_thumbnail_decode_failure_falls_back_to_original_bytes(self):
        original = self.image_path("fallback.png")
        self.write_image(original, size=(640, 320))
        original_bytes = original.read_bytes()
        with mock.patch.object(Image, "open", side_effect=OSError("synthetic decode failure")):
            response = self.get("/style-manager-thumbnails/shared/fallback.png")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.get_data(), original_bytes)
        self.assertEqual(list((self.data_dir / "style_manager_thumbnails").glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
