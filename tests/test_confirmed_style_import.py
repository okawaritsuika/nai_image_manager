import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.parse import unquote
from unittest.mock import patch

from flask import Flask
from PIL import Image

from naim.daki_style_tests import GENERATION_DEFAULTS
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.storage.daki_projects import DakiNotFoundError
from naim.web.confirmed_style_import import register_confirmed_style_import
from naim.web.daki_personal_styles import register_daki_personal_style_routes


class FakeConfirmedSource:
    def __init__(self, record, image_bytes, content_type="image/png"):
        self.records = {record["id"]: record}
        self.image_bytes = image_bytes
        self.content_type = content_type
        self.calls = []
        self.failure = None

    def fetch(self, suffix, *, origin, image=False):
        self.calls.append((suffix, origin, image))
        if self.failure:
            raise RuntimeError("Synthetic confirmed source failure")
        if suffix == "/api/confirmed-styles":
            return [copy.deepcopy(record) for record in self.records.values()]
        if suffix.startswith("/api/confirmed-styles/"):
            try:
                style_id = int(suffix.rsplit("/", 1)[1])
            except ValueError:
                raise AssertionError("Unexpected detail path") from None
            if style_id not in self.records:
                raise DakiNotFoundError("Synthetic missing style")
            return copy.deepcopy(self.records[style_id])
        if suffix.startswith("/confirmed-style-images/") and image:
            image_path = unquote(suffix[len("/confirmed-style-images/"):])
            if not any(record.get("image_path") == image_path for record in self.records.values()):
                raise DakiNotFoundError("Synthetic missing image")
            return self.image_bytes, self.content_type
        raise AssertionError(f"Unexpected source request: {suffix}")


def image_bytes(color, image_format="PNG"):
    output = io.BytesIO()
    Image.new("RGB", (16, 24), color).save(output, format=image_format)
    return output.getvalue()


class ConfirmedStyleImportTests(unittest.TestCase):
    def setUp(self):
        self.temp_parent = Path(__file__).resolve().parents[1] / ".qa" / "delete-import-tests-temp"
        self.temp_parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=self.temp_parent)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.gallery_root = self.root / "gallery"
        self.gallery_root.mkdir()
        self.gallery_image = self.gallery_root / "original.png"
        self.original_gallery_bytes = image_bytes("blue")
        self.gallery_image.write_bytes(self.original_gallery_bytes)

        self.record = {
            "id": 42,
            "name": "Synthetic confirmed style",
            "image_path": "confirmed/portrait.png",
            "artist_prompt": "ink linework, soft watercolor",
            "negative_prompt": "lowres, blurry",
            "model": "nai-diffusion-4-5-full",
            "width": 1152,
            "height": 896,
            "steps": 19,
            "scale": 6.25,
            "cfg_rescale": 0.35,
            "sampler": "k_euler",
            "noise_schedule": "native",
            "unsupported_option": "omit this explicit source field",
            "seed": 987654321,
        }
        self.original_record = copy.deepcopy(self.record)
        self.source_image = image_bytes("green")
        self.source = FakeConfirmedSource(self.record, self.source_image)

        self.personal_root = self.root / "personal"

        def resolve_source(reference):
            return self.gallery_image, reference

        self.store = DakiPersonalStyles(
            lambda: self.personal_root,
            resolve_source,
            lambda _path: {},
        )
        self.app = Flask("confirmed_style_import_tests")
        register_daki_personal_style_routes(self.app, self.store)
        register_confirmed_style_import(self.app, self.store, service=object(), source=self.source)
        self.client = self.app.test_client()

    def response_body(self, response):
        return response.get_json()

    def import_style(self, style_id=42, **headers):
        return self.client.post(
            "/api/daki/personal-styles/import-confirmed",
            json={"style_id": style_id},
            headers=headers,
        )

    def owned_files(self):
        if not self.personal_root.exists():
            return []
        return [path for path in self.personal_root.rglob("*") if path.is_file() and path.name != "catalog.json"]

    def test_list_preview_and_import_copy_recipe_and_exact_image_bytes(self):
        listed = self.client.get("/api/daki/confirmed-styles")
        self.assertEqual(listed.status_code, 200)
        item = self.response_body(listed)["styles"][0]
        self.assertEqual(item["id"], 42)
        self.assertEqual(item["positive"], self.record["artist_prompt"])
        self.assertEqual(item["negative"], self.record["negative_prompt"])
        self.assertEqual(item["preview"], {"width": 1152, "height": 896})

        preview = self.client.get(item["src"])
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.data, self.source_image)
        self.assertEqual(preview.content_type, "image/png")
        preview.close()

        imported = self.import_style()
        self.assertEqual(imported.status_code, 201, imported.get_json())
        style = self.response_body(imported)["style"]
        self.assertEqual(style["positive"], self.record["artist_prompt"])
        self.assertEqual(style["negative"], self.record["negative_prompt"])
        self.assertEqual(style["model"], self.record["model"])
        self.assertEqual(style["preview"], {"width": 1152, "height": 896})
        expected_options = {
            **GENERATION_DEFAULTS,
            "steps": 19,
            "cfg": 6.25,
            "cfg_rescale": 0.35,
            "sampler": "k_euler",
            "noise_schedule": "native",
        }
        self.assertEqual(style["options"], expected_options)
        self.assertNotIn("unsupported_option", style["options"])
        self.assertNotIn("seed", style["options"])
        self.assertTrue(style["source_path"].startswith("__daki_owned__/personal_"))

        owned_preview = self.client.get(style["src"])
        self.assertEqual(owned_preview.status_code, 200)
        self.assertEqual(owned_preview.data, self.source_image)
        owned_preview.close()
        owned_path = self.store.preview_path(style["id"])
        self.assertEqual(owned_path.read_bytes(), self.source_image)

        self.source.records[42].update(
            artist_prompt="changed source prompt",
            negative_prompt="changed source negative",
            scale=10,
            width=640,
        )
        self.source.image_bytes = image_bytes("red")
        saved = self.store.get_style(style["id"])
        self.assertEqual(saved["positive"], self.original_record["artist_prompt"])
        self.assertEqual(saved["negative"], self.original_record["negative_prompt"])
        self.assertEqual(saved["options"]["cfg"], 6.25)
        self.assertEqual(saved["preview"], {"width": 1152, "height": 896})
        saved_preview = self.client.get(style["src"])
        self.assertEqual(saved_preview.data, self.source_image)
        saved_preview.close()

    def test_import_validation_missing_records_and_source_origin_failures(self):
        self.assertEqual(self.import_style(style_id="42").status_code, 400)
        self.assertEqual(self.client.post(
            "/api/daki/personal-styles/import-confirmed", json=[42]
        ).status_code, 400)
        self.assertEqual(self.import_style(style_id=0).status_code, 400)

        wrong_origin = self.import_style(
            Origin="https://untrusted.example",
        )
        self.assertEqual(wrong_origin.status_code, 403)
        self.assertEqual(self.store.list_styles(), [])

        missing = self.import_style(style_id=999)
        self.assertEqual(missing.status_code, 404)
        missing_preview = self.client.get("/api/daki/confirmed-styles/999/preview")
        self.assertEqual(missing_preview.status_code, 404)

        self.source.failure = True
        unavailable = self.client.get("/api/daki/confirmed-styles")
        self.assertEqual(unavailable.status_code, 503)
        self.assertEqual(self.store.list_styles(), [])

    def test_invalid_image_and_model_do_not_save_records_or_assets(self):
        self.source.content_type = "image/gif"
        self.source.image_bytes = image_bytes("yellow", "GIF")
        invalid_image = self.import_style()
        self.assertEqual(invalid_image.status_code, 400)
        self.assertEqual(self.store.list_styles(), [])
        self.assertFalse((self.personal_root / "catalog.json").exists())
        self.assertEqual(self.owned_files(), [])

        self.source.content_type = "image/png"
        self.source.image_bytes = image_bytes("green")
        self.source.records[42]["model"] = "unsupported-synthetic-model"
        invalid_model = self.import_style()
        self.assertEqual(invalid_model.status_code, 400)
        self.assertEqual(self.store.list_styles(), [])
        self.assertFalse((self.personal_root / "catalog.json").exists())
        self.assertEqual(self.owned_files(), [])

    def test_copy_failure_rolls_back_owned_file_and_remove_failure_restores_it(self):
        with patch("naim.storage.daki_personal_styles.write_json", side_effect=OSError("synthetic write failure")):
            failed_copy = self.import_style()
        self.assertEqual(failed_copy.status_code, 500)
        self.assertEqual(self.store.list_styles(), [])
        self.assertFalse((self.personal_root / "catalog.json").exists())
        self.assertEqual(self.owned_files(), [])

        imported = self.import_style()
        self.assertEqual(imported.status_code, 201)
        style = imported.get_json()["style"]
        image_path = self.store.preview_path(style["id"])
        before = image_path.read_bytes()
        with patch("naim.storage.daki_personal_styles.write_json", side_effect=OSError("synthetic write failure")):
            failed_remove = self.client.delete("/api/daki/personal-styles/" + style["id"])
        self.assertEqual(failed_remove.status_code, 500)
        self.assertEqual(self.store.get_style(style["id"])["id"], style["id"])
        self.assertTrue(image_path.is_file())
        self.assertEqual(image_path.read_bytes(), before)

    def test_personal_delete_removes_owned_copy_but_keeps_linked_gallery_image(self):
        imported = self.import_style()
        self.assertEqual(imported.status_code, 201)
        copied = imported.get_json()["style"]
        owned_path = self.store.preview_path(copied["id"])
        self.assertTrue(owned_path.is_file())

        deleted_copy = self.client.delete("/api/daki/personal-styles/" + copied["id"])
        self.assertEqual(deleted_copy.status_code, 200)
        self.assertFalse(owned_path.exists())
        self.assertEqual(self.store.list_styles(), [])

        linked = self.store.create({
            "name": "Synthetic linked style",
            "positive": "gallery linked prompt",
            "source_path": "gallery/original.png",
        })
        self.assertTrue(self.gallery_image.exists())
        deleted_link = self.client.delete("/api/daki/personal-styles/" + linked["id"])
        self.assertEqual(deleted_link.status_code, 200)
        self.assertEqual(self.store.list_styles(), [])
        self.assertTrue(self.gallery_image.exists())
        self.assertEqual(self.gallery_image.read_bytes(), self.original_gallery_bytes)

        missing = self.client.delete("/api/daki/personal-styles/personal_" + "0" * 32)
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
