import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.style_manager import app as app_module
from naim.style_manager.novelai import build_generation_payload
from tests.style_manager.helpers import valid_png


INTEGRATED_BASE_PROMPT = "quality_a, 1.2::artist:synthetic_a::, fixed_a, quality_b"


class ConfirmedBaseIntegrationTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        paths = patch.multiple(
            app_module,
            DATA_DIR=root,
            THUMBNAIL_DIR=root / "thumbnails",
            GENERATED_DIR=root / "generated",
            SETTINGS_JSON_PATH=root / "settings.json",
            DB_PATH=root / "test.sqlite",
            CONFIRMED_STYLE_IMAGE_DIR=root / "confirmed",
            COMPARISON_IMAGE_DIR=root / "comparison",
            ARCA_STYLE_IMAGE_DIR=root / "arca",
            ARCA_STYLE_SEED_PATH=root / "missing-seed.sqlite",
            STYLE_GROUP_IMAGE_DIR=root / "style_groups",
            MERGE_SOURCE_DIRS=[],
        )
        paths.start()
        self.addCleanup(paths.stop)
        app_module.init_db()
        self.client = app_module.app.test_client()

    def create_style(self, **overrides):
        payload = {
            "name": "Synthetic style",
            "artist_prompt": "artist:stale",
            "quality_prompt": "stale_quality",
            "fixed_prompt": "stale_fixed",
            "model": "nai-diffusion-5-full",
            "steps": 28,
            "scale": 5,
            "cfg_rescale": 0,
            "sampler": "k_euler_ancestral",
            "noise_schedule": "karras",
            "negative_prompt": "negative_a",
        }
        payload.update(overrides)
        return app_module.create_confirmed_style(
            app_module.DB_PATH,
            app_module.CONFIRMED_STYLE_IMAGE_DIR,
            valid_png(64, 64),
            payload,
        )

    def prepare_comparison(self, style_id):
        response = self.client.post("/api/comparisons", json={
            "name": "Synthetic",
            "style_ids": [style_id],
            "fixed_prompt": "scene_a",
            "character_prompts": ["character_a"],
            "width": 64,
            "height": 64,
            "seed_mode": "none",
            "defaults": {},
            "defer_generation": True,
        })
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()["id"]

    def generate_style(self, group_id, style_id):
        response = self.client.post(
            f"/api/comparisons/{group_id}/styles/{style_id}/generate", json={}
        )
        self.assertEqual(response.status_code, 201, response.get_json())
        return response.get_json()

    def test_integrated_base_is_used_once_for_comparison_generation_and_snapshot(self):
        style = self.create_style(base_prompt=INTEGRATED_BASE_PROMPT)
        group_id = self.prepare_comparison(style["id"])

        with (
            patch("naim.style_manager.app.load_app_key", return_value="synthetic-key"),
            patch(
                "naim.style_manager.app.generate_novelai_png",
                return_value=(valid_png(64, 64), 123),
            ) as generate,
        ):
            result = self.generate_style(group_id, style["id"])

        generate.assert_called_once()
        artist_prompt = generate.call_args.args[2]
        data = generate.call_args.args[1]
        full_base_prompt = f"{INTEGRATED_BASE_PROMPT}, scene_a"
        self.assertEqual(artist_prompt, "")
        self.assertEqual(data["base_prompt"], full_base_prompt)
        self.assertEqual(data["negative_prompt"], "negative_a")
        self.assertEqual(data["character_prompts"], ["character_a"])
        self.assertEqual(
            build_generation_payload(data, artist_prompt)["input"],
            full_base_prompt,
        )

        snapshot = result["settings"]
        self.assertEqual(snapshot["style_base_prompt"], INTEGRATED_BASE_PROMPT)
        self.assertEqual(snapshot["base_prompt"], full_base_prompt)
        saved = self.client.get("/api/comparisons").get_json()[0]["results"][0]["settings"]
        self.assertEqual(saved, snapshot)

    def test_legacy_split_prompts_keep_existing_comparison_generation(self):
        style = self.create_style()
        self.assertIsNone(style["base_prompt"])
        group_id = self.prepare_comparison(style["id"])

        with (
            patch("naim.style_manager.app.load_app_key", return_value="synthetic-key"),
            patch(
                "naim.style_manager.app.generate_novelai_png",
                return_value=(valid_png(64, 64), 123),
            ) as generate,
        ):
            result = self.generate_style(group_id, style["id"])

        generate.assert_called_once()
        artist_prompt = generate.call_args.args[2]
        data = generate.call_args.args[1]
        self.assertEqual(artist_prompt, "artist:stale")
        self.assertEqual(data["base_prompt"], "stale_quality, stale_fixed, scene_a")
        self.assertEqual(
            build_generation_payload(data, artist_prompt)["input"],
            "artist:stale, stale_quality, stale_fixed, scene_a",
        )
        self.assertIsNone(result["settings"]["style_base_prompt"])

    def test_multipart_create_and_patch_preserve_integrated_and_legacy_modes(self):
        integrated_data = {
            "name": "Multipart integrated",
            "artist_prompt": "artist:stale",
            "quality_prompt": "stale_quality",
            "fixed_prompt": "stale_fixed",
            "base_prompt": INTEGRATED_BASE_PROMPT,
            "model": "nai-diffusion-5-full",
        }
        response = self.client.post("/api/confirmed-styles", data={
            "image": (BytesIO(valid_png(64, 64)), "synthetic.png"),
            "data": json.dumps(integrated_data),
        }, content_type="multipart/form-data")
        self.assertEqual(response.status_code, 201, response.get_json())
        style = response.get_json()
        self.assertEqual(style["base_prompt"], INTEGRATED_BASE_PROMPT)
        self.assertEqual(style["base_artist_prompt"], "1.2::artist:synthetic_a::")

        name_patch = self.client.patch(
            f"/api/confirmed-styles/{style['id']}", json={"name": "Renamed"}
        )
        self.assertEqual(name_patch.status_code, 200, name_patch.get_json())
        self.assertEqual(name_patch.get_json()["base_prompt"], INTEGRATED_BASE_PROMPT)
        split_patch = self.client.patch(
            f"/api/confirmed-styles/{style['id']}", json={"base_prompt": None}
        )
        self.assertEqual(split_patch.status_code, 200, split_patch.get_json())
        self.assertIsNone(split_patch.get_json()["base_prompt"])

        legacy_data = {
            "name": "Multipart legacy",
            "artist_prompt": "artist:legacy",
            "quality_prompt": "quality:legacy",
            "fixed_prompt": "fixed:legacy",
            "model": "nai-diffusion-5-full",
        }
        legacy_response = self.client.post("/api/confirmed-styles", data={
            "image": (BytesIO(valid_png(64, 64)), "synthetic-legacy.png"),
            "data": json.dumps(legacy_data),
        }, content_type="multipart/form-data")
        self.assertEqual(legacy_response.status_code, 201, legacy_response.get_json())
        self.assertIsNone(legacy_response.get_json()["base_prompt"])

    def test_image_extraction_and_batch_save_keep_original_base_order(self):
        metadata = PngInfo()
        metadata.add_text("Comment", json.dumps({
            "prompt": INTEGRATED_BASE_PROMPT, "uc": "negative_a",
            "model": "nai-diffusion-5-full", "steps": 28, "sampler": "k_euler_ancestral",
        }))
        output = BytesIO()
        Image.new("RGB", (64, 64), (30, 50, 70)).save(output, format="PNG", pnginfo=metadata)
        image = output.getvalue()
        extracted = self.client.post("/api/confirmed-styles/extract", data={
            "image": (BytesIO(image), "synthetic.png"),
        }, content_type="multipart/form-data")
        self.assertEqual(extracted.status_code, 200, extracted.get_json())
        values = extracted.get_json()
        self.assertEqual(values["base_prompt"], INTEGRATED_BASE_PROMPT)
        self.assertNotEqual(values["artist_prompt"], INTEGRATED_BASE_PROMPT)
        saved = self.client.post("/api/confirmed-styles/import-batch", data={
            "images": (BytesIO(image), "synthetic.png"),
            "manifest": json.dumps([{"file_indexes": [0], "data": values}]),
        }, content_type="multipart/form-data")
        self.assertEqual(saved.status_code, 201, saved.get_json())
        self.assertEqual(saved.get_json()[0]["base_prompt"], INTEGRATED_BASE_PROMPT)


if __name__ == "__main__":
    unittest.main()
