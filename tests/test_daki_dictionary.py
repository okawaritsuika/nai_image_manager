import json
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from flask import Flask
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_dictionary import Dictionary
from naim.web.daki_dictionary import register_daki_dictionary_routes


class DictionaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.root = Path(self.temporary.name)
        self.data = self.root / "bundle"
        self.user = self.root / "user"
        self.data.mkdir()
        self.write_bundle()
        (self.user).mkdir()
        (self.user / "user_edits.json").write_text(json.dumps({
            "unrelated": {"kept": True},
            "smile": {"ko": "이전 번역", "private_extension": "preserve", "legacy": 7},
        }), encoding="utf-8")
        self.dictionary = Dictionary(self.data, self.user)

    def tearDown(self):
        self.dictionary.close()
        self.temporary.cleanup()

    def test_image_pack_routes_require_explicit_local_start_and_do_not_download_on_get(self):
        app = Flask(__name__)
        manager = mock.Mock()
        manager.status.return_value = {'status': 'idle', 'installed': 0}
        manager.start.return_value = {'id': 'synthetic', 'status': 'running'}
        manager.stop.return_value = {'id': 'synthetic', 'status': 'stopping'}
        with mock.patch('naim.web.daki_dictionary.DictionaryImageDownload', return_value=manager):
            provider = register_daki_dictionary_routes(app, self.data, self.root / 'download-user')
        self.addCleanup(lambda: provider().close())
        client = app.test_client()
        endpoint = '/api/daki/dictionary/image-pack'
        response = client.get(endpoint)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()['available'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        manager.start.assert_not_called()
        response = client.post(endpoint, json={'url': 'https://invalid.test'})
        self.assertEqual(response.status_code, 400)
        response = client.post(endpoint, json={}, headers={'Origin': 'https://foreign.invalid'})
        self.assertEqual(response.status_code, 403)
        manager.start.assert_not_called()
        self.assertEqual(client.post(endpoint, json={}).get_json()['job']['status'], 'running')
        manager.start.assert_called_once_with()
        self.assertEqual(client.post(endpoint + '/stop', json={}).get_json()['job']['status'], 'stopping')
        manager.stop.assert_called_once_with()

    def write_bundle(self, rows=None):
        tags = [
            {"tag": tag, "ko": ko, "description": "", "categories": ["표정/감정"],
             "count": count, "translation_source": "fixture", "future_field": "kept"}
            for tag, ko, count in [
                ("smile", "미소", 2), ("light smile", "옅은 미소", 2), ("closed eyes", "감은 눈", 3),
            ]
        ]
        (self.data / "dictionary.json").write_text(json.dumps({
            "source": {"rows": 3, "unique_tags": 3, "future_source_field": "kept"},
            "categories": [], "tags": tags,
        }, ensure_ascii=False), encoding="utf-8")
        if rows is None:
            rows = [
                {"id": 1, "general": "smile, closed eyes", "rating": "g"},
                {"id": 2, "general": "light smile, closed eyes", "rating": "s"},
                {"id": 3, "general": "smile, light smile, closed eyes", "rating": "q"},
            ]
        (self.data / "source_combinations.json").write_text(json.dumps(rows), encoding="utf-8")

    def test_exact_tag_matching_related_counts_and_statistics_denominators(self):
        smile = self.dictionary.combinations("smile", 0, 10)
        self.assertEqual(smile["total"], 2)
        self.assertEqual([item["id"] for item in smile["items"]], [1, 3])
        related = self.dictionary.related("smile", 10)
        related_by_tag = {item["tag"]: item for item in related["items"]}
        self.assertEqual({item["id"] for item in smile["items"]}, {1, 3})
        self.assertEqual(related_by_tag["closed eyes"]["count"], 2)
        self.assertEqual(related_by_tag["closed eyes"]["percent"], 100)
        self.assertEqual(related_by_tag["light smile"]["count"], 1)
        result = self.dictionary.statistics("smile")
        self.assertEqual(result["selected"]["combination_count"], 2)
        self.assertEqual(result["selected"]["combination_percent"], 66.67)
        self.assertEqual(result["selected"]["rank"], 2)
        self.assertEqual(result["overview"]["source_rows"], 3)
        self.assertEqual(result["overview"]["total_images"], 0)
        self.assertEqual(result["overview"]["coverage_percent"], 0)

    def test_edit_keeps_base_immutable_and_unknown_override_fields(self):
        original_dictionary = (self.data / "dictionary.json").read_bytes()
        original_rows = (self.data / "source_combinations.json").read_bytes()
        self.dictionary.edit({
            "tag": "smile", "ko": "=FORMULA()", "description": "설명",
            "categories": ["표정/웃음", "입/입꼬리", "표정/웃음"],
        })
        saved = json.loads((self.user / "user_edits.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["unrelated"], {"kept": True})
        self.assertEqual(saved["smile"]["private_extension"], "preserve")
        self.assertEqual(saved["smile"]["legacy"], 7)
        self.assertEqual(self.dictionary.tags["smile"]["future_field"], "kept")
        restarted = Dictionary(self.data, self.user)
        try:
            self.assertEqual(restarted.tags["smile"]["ko"], "=FORMULA()")
            self.assertEqual(restarted.tags["smile"]["categories"], ["표정/웃음", "입/입꼬리"])
            self.assertIn("'=FORMULA()", restarted.export().decode("utf-8-sig"))
            self.assertEqual((self.data / "dictionary.json").read_bytes(), original_dictionary)
            self.assertEqual((self.data / "source_combinations.json").read_bytes(), original_rows)
        finally:
            restarted.close()

    def test_invalid_edits_and_unknown_tags(self):
        for body in [
            {"tag": "missing", "ko": "이름", "description": "", "categories": ["표정"]},
            {"tag": "smile", "ko": "", "description": "", "categories": ["표정"]},
            {"tag": "smile", "ko": "미소", "description": "", "categories": []},
        ]:
            with self.assertRaises(ValueError):
                self.dictionary.edit(body)
        with self.assertRaises(KeyError):
            self.dictionary.combinations("missing", 0, 10)

    def test_translated_category_labels_preserve_ids_and_user_categories(self):
        payload_path = self.data / 'dictionary.json'
        payload = json.loads(payload_path.read_text(encoding='utf-8'))
        payload['categories'] = [{'id': '표정/감정', 'label': '표정/감정 표현', 'count': 3}]
        payload_path.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        translated = Dictionary(self.data, self.user)
        try:
            category = translated.snapshot()['categories'][0]
            self.assertEqual(category['id'], '표정/감정')
            self.assertEqual(category['label'], '표정/감정 표현')
            self.assertEqual(translated.tags['smile']['categories'], ['표정/감정'])
            self.assertIn('표정/감정 표현', translated.export().decode('utf-8-sig'))
            translated.edit({'tag': 'smile', 'ko': '나만의 이름', 'description': '나만의 설명',
                             'categories': ['표정/직접 입력']})
            custom = next(item for item in translated.snapshot()['categories'] if item['id'] == '표정/직접 입력')
            self.assertEqual(custom['label'], '표정/직접 입력')
        finally:
            translated.close()

    def test_routes_paginate_validate_inputs_reject_foreign_origin_and_export_safely(self):
        static = self.root / "static"
        page = static / "daki_dictionary"
        page.mkdir(parents=True)
        (page / "index.html").write_text("dictionary frame", encoding="utf-8")
        app = Flask(__name__, static_folder=str(static))
        provider = register_daki_dictionary_routes(app, self.data, self.root / "http-user")
        client = app.test_client()
        self.assertFalse((self.root / "http-user").exists())
        page_response = client.get("/daki/dictionary")
        self.assertEqual(page_response.status_code, 200)
        page_response.close()
        self.assertFalse((self.root / "http-user").exists())
        denied = client.post("/api/daki/dictionary/images/scan", headers={"Origin": "https://foreign.invalid"})
        self.assertEqual(denied.status_code, 403)
        self.assertFalse((self.root / "http-user").exists())

        prefix = "/api/daki/dictionary"
        self.assertEqual(client.get(prefix + "/health").get_json()["rows"], 3)
        self.assertTrue(client.get(prefix + "/config").get_json()["image_linking_enabled"])
        self.assertEqual(client.get(prefix + "/dictionary").status_code, 200)
        self.assertEqual(client.get(prefix + "/statistics?tag=smile").status_code, 200)
        result = client.get(prefix + "/combinations?tag=smile&offset=-4&limit=1000")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.get_json()["offset"], 0)
        self.assertEqual(result.get_json()["limit"], 100)
        self.assertEqual(result.get_json()["total"], 2)
        self.assertEqual(client.get(prefix + "/combinations?tag=smile&offset=oops").status_code, 400)
        self.assertEqual(client.get(prefix + "/related?tag=missing").status_code, 404)
        self.assertEqual(client.get(prefix + "/images/999999").status_code, 404)
        edited = client.patch(prefix + "/tags", json={
            "tag": "smile", "ko": "=FORMULA()", "description": "", "categories": ["표정/웃음"]})
        self.assertEqual(edited.status_code, 200)

        folder = self.root / "http-images"
        folder.mkdir()
        metadata = PngInfo()
        metadata.add_text("parameters", "smile\nSteps: 20")
        Image.new("RGB", (32, 96), "white").save(folder / "sample.png", pnginfo=metadata)
        connected = client.post(prefix + "/images/folder", json={"folder": str(folder)})
        self.assertEqual(connected.status_code, 200)
        provider().images.worker.join(timeout=5)
        self.assertTrue(client.get(prefix + "/images/status").get_json()["folder"])
        image_result = client.get(prefix + "/images?tag=smile")
        self.assertEqual(image_result.get_json()["total"], 1)
        image_id = image_result.get_json()["items"][0]["id"]
        detail = client.get(prefix + f"/images/{image_id}")
        self.assertEqual(set(detail.get_json()["used_tags"]), {"smile"})
        image_file = client.get(prefix + f"/images/{image_id}/file")
        self.assertEqual(image_file.content_type, "image/png")
        image_file.close()
        thumbnail = client.get(prefix + f"/images/{image_id}/thumbnail")
        self.assertEqual(thumbnail.content_type, "image/webp")
        thumbnail.close()
        csv_response = client.get(prefix + "/export.csv")
        self.assertIn("text/csv", csv_response.content_type)
        self.assertIn("'=FORMULA()", csv_response.get_data(as_text=True))
        csv_response.close()
        self.assertTrue((self.root / "http-user").exists())
        provider().close()

    def test_missing_bundle_returns_retryable_503(self):
        missing = self.root / "missing"
        app = Flask(__name__)
        provider = register_daki_dictionary_routes(app, missing, self.root / "retry-user")
        client = app.test_client()
        self.assertEqual(client.get("/api/daki/dictionary/health").status_code, 503)
        self.assertFalse((self.root / "retry-user").exists())
        missing.mkdir()
        saved_data = self.data
        self.data = missing
        try:
            self.write_bundle()
        finally:
            self.data = saved_data
        response = client.get("/api/daki/dictionary/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["rows"], 3)
        provider().close()


if __name__ == "__main__":
    unittest.main()
