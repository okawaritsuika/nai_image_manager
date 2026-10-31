import json
import tempfile
import unittest
from pathlib import Path

from flask import Flask

from naim.storage.json_files import merge_json_object, write_json
from naim.web.style_shared_settings import register_style_shared_settings


class StyleSharedSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1])
        self.config_path = Path(self.temp.name) / "lab_config.json"
        self.config = {
            "key": "synthetic-private-key",
            "model": "synthetic-model",
            "width": 1216,
            "height": 832,
            "steps": 28,
            "scale": 5,
            "cfg_rescale": 0.2,
            "sampler": "synthetic-sampler",
            "noise_schedule": "synthetic-schedule",
            "unrelated": {"preserve": True},
        }
        write_json(self.config_path, self.config)
        self.app = Flask(__name__)
        self.app.testing = True
        register_style_shared_settings(self.app, self.config_path, "synthetic-bearer-token")
        self.client = self.app.test_client()
        self.headers = {"Authorization": "Bearer synthetic-bearer-token"}

    def tearDown(self):
        self.temp.cleanup()

    def assert_no_store(self, response):
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")

    def patch(self, payload, **kwargs):
        return self.client.patch(
            "/api/style-workspace/settings",
            json=payload,
            headers={**self.headers, **kwargs.get("headers", {})},
        )

    def test_get_requires_bearer_token_and_never_caches_responses(self):
        unauthorized = self.client.get("/api/style-workspace/settings")
        self.assertEqual(unauthorized.status_code, 401)
        self.assert_no_store(unauthorized)
        self.assertNotIn("synthetic-private-key", unauthorized.get_data(as_text=True))

        wrong_token = self.client.get(
            "/api/style-workspace/settings",
            headers={"Authorization": "Bearer wrong-token"},
        )
        self.assertEqual(wrong_token.status_code, 401)
        self.assert_no_store(wrong_token)

        unsupported_method = self.client.post(
            "/api/style-workspace/settings", headers=self.headers
        )
        self.assertEqual(unsupported_method.status_code, 405)
        self.assert_no_store(unsupported_method)

        response = self.client.get("/api/style-workspace/settings", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assert_no_store(response)

    def test_get_returns_key_and_only_existing_common_defaults(self):
        response = self.client.get("/api/style-workspace/settings", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), {
            "key": "synthetic-private-key",
            "defaults": {
                "model": "synthetic-model",
                "width": 1216,
                "height": 832,
                "steps": 28,
                "scale": 5,
                "cfg_rescale": 0.2,
                "sampler": "synthetic-sampler",
                "noise_schedule": "synthetic-schedule",
            },
        })

        partial = dict(self.config)
        del partial["height"]
        write_json(self.config_path, partial)
        response = self.client.get("/api/style-workspace/settings", headers=self.headers)
        self.assertNotIn("height", response.get_json()["defaults"])

    def test_patch_merges_fields_and_preserves_unrelated_settings(self):
        response = self.patch({"key": "  updated-key  ", "defaults": {"width": 1344, "scale": 3.5}})
        self.assertEqual(response.status_code, 200)
        self.assert_no_store(response)
        self.assertEqual(response.get_json()["key"], "updated-key")
        self.assertEqual(response.get_json()["defaults"]["width"], 1344)
        self.assertEqual(response.get_json()["defaults"]["scale"], 3.5)

        saved = json.loads(self.config_path.read_text(encoding="utf-8"))
        self.assertEqual(saved["height"], self.config["height"])
        self.assertEqual(saved["unrelated"], self.config["unrelated"])

    def test_mismatched_origin_is_rejected(self):
        response = self.client.get(
            "/api/style-workspace/settings",
            headers={**self.headers, "Origin": "https://untrusted.example"},
        )
        self.assertEqual(response.status_code, 403)
        self.assert_no_store(response)
        self.assertNotIn("synthetic-private-key", response.get_data(as_text=True))

    def test_invalid_patch_values_are_rejected_without_changes(self):
        invalid_payloads = [
            {"other": "value"},
            {"defaults": {"other": "value"}},
            {"defaults": []},
            {"defaults": {"width": True}},
            {"defaults": {"width": 63}},
            {"defaults": {"height": 4097}},
            {"defaults": {"steps": 51}},
            {"defaults": {"scale": 0}},
            {"defaults": {"cfg_rescale": 1.01}},
            {"defaults": {"scale": float("inf")}},
            {"defaults": {"model": "   "}},
            {"defaults": {"sampler": "s" * 129}},
            {"key": 123},
            {"key": "bad\nkey"},
            {"key": "k" * 8193},
        ]
        original = json.loads(self.config_path.read_text(encoding="utf-8"))

        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                response = self.patch(payload)
                self.assertEqual(response.status_code, 400)
                self.assert_no_store(response)
                self.assertNotIn("synthetic-private-key", response.get_data(as_text=True))
                self.assertEqual(
                    json.loads(self.config_path.read_text(encoding="utf-8")), original
                )

        malformed = self.client.patch(
            "/api/style-workspace/settings",
            data='{"defaults":{"scale":NaN}}',
            content_type="application/json",
            headers=self.headers,
        )
        self.assertEqual(malformed.status_code, 400)
        self.assert_no_store(malformed)

    def test_empty_key_clears_key_and_external_updates_are_visible_on_next_get(self):
        response = self.patch({"key": "   "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["key"], "")
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf-8"))["key"], "")

        merge_json_object(self.config_path, {"steps": 17})
        response = self.client.get("/api/style-workspace/settings", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["defaults"]["steps"], 17)
        self.assert_no_store(response)


if __name__ == "__main__":
    unittest.main()
