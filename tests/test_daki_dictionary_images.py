import hashlib
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from naim.daki_dictionary_images import ImageCatalog, _comfy, extract_prompt, prompt_tags


class ImageCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.root = Path(self.temporary.name)
        self.images = self.root / "images"
        self.images.mkdir()
        self.catalog_dir = self.root / "catalog"
        self.catalog = ImageCatalog(
            self.catalog_dir, {"smile", "light smile", "closed eyes", "blush"})

    def tearDown(self):
        self.catalog.close()
        self.temporary.cleanup()

    def png(self, path, metadata=None):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        info = PngInfo()
        for key, value in (metadata or {}).items():
            info.add_text(key, value if isinstance(value, str) else json.dumps(value))
        Image.new("RGB", (32, 96), "#d9dce3").save(path, pnginfo=info)
        return path

    def wait_scan(self):
        deadline = time.monotonic() + 10
        while self.catalog.status()["scanning"]:
            self.assertLess(time.monotonic(), deadline, "Scan did not finish")
            time.sleep(0.02)
        self.assertIsNone(self.catalog.status()["error"])

    def test_exact_positive_tags_ignore_negative_and_include_nai_character_prompts(self):
        path = self.png(self.images / "nested" / "sample.png", {"Comment": {
            "prompt": "1.2::light_smile::, (closed eyes:1.1)",
            "uc": "smile",
            "v4_prompt": {"caption": {
                "base_caption": "light smile, closed eyes",
                "char_captions": [{"char_caption": "blush"}],
            }},
            "v4_negative_prompt": {"caption": {"base_caption": "smile", "char_captions": []}},
        }})
        original = hashlib.sha256(path.read_bytes()).hexdigest()
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        self.assertEqual(self.catalog.query("smile")["total"], 0)
        self.assertEqual(self.catalog.query("light smile")["total"], 1)
        detail = self.catalog.detail(self.catalog.query("light smile")["items"][0]["id"])
        self.assertEqual(set(detail["matched_tags"]), {"light smile", "closed eyes", "blush"})
        self.assertEqual(detail["negative_prompt"], "smile")
        self.assertIn("light smile, closed eyes", detail["prompt"])
        self.assertEqual(original, hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(prompt_tags("smile, light_smile", self.catalog.vocabulary),
                         {"smile", "light smile"})

    def test_non_list_optional_character_collections_keep_base_prompts(self):
        malformed = [None, 7, "not a list", {"char_caption": "ignored"}]
        for value in malformed:
            with self.subTest(collection="character_prompts", value=value):
                image = Image.new("RGB", (1, 1))
                image.info["Comment"] = {
                    "prompt": "smile", "uc": "blush", "character_prompts": value,
                }
                self.assertEqual(extract_prompt(image), ("smile", "blush", "Comment"))
                image.close()

            with self.subTest(collection="char_captions", value=value):
                image = Image.new("RGB", (1, 1))
                image.info["Comment"] = {
                    "v4_prompt": {"caption": {"base_caption": "smile", "char_captions": value}},
                    "v4_negative_prompt": {"caption": {"base_caption": "blush", "char_captions": value}},
                }
                self.assertEqual(extract_prompt(image), ("smile", "blush", "Comment"))
                image.close()

    def test_mixed_character_lists_keep_only_valid_character_prompts(self):
        image = Image.new("RGB", (1, 1))
        image.info["Comment"] = {
            "prompt": "smile", "uc": "blush",
            "character_prompts": [None, "skip", {"prompt": "closed eyes", "negative_prompt": "blush"}],
            "v4_prompt": {"caption": {
                "base_caption": "smile", "char_captions": [None, "skip", {"char_caption": "closed eyes"}],
            }},
            "v4_negative_prompt": {"caption": {"base_caption": "blush", "char_captions": []}},
        }
        self.assertEqual(extract_prompt(image), ("smile,\nclosed eyes", "blush", "Comment"))
        image.close()

    def test_comfy_parser_ignores_malformed_link_nodes_and_input_shapes(self):
        for linked_node in (None, 7, []):
            with self.subTest(linked_node=linked_node):
                graph = {
                    "sampler": {"class_type": "KSampler", "inputs": {
                        "positive": ["positive"], "negative": ["negative"],
                    }},
                    "positive": linked_node,
                    "negative": {"class_type": "CLIPTextEncode", "inputs": {"text": "blush"}},
                }
                self.assertEqual(_comfy(graph), ("", "blush"))

        for inputs in (None, 7, [], "invalid"):
            with self.subTest(inputs=inputs):
                self.assertEqual(_comfy({"sampler": {"class_type": "KSampler", "inputs": inputs}}), ("", ""))

        graph = {
            "sampler": {"class_type": "KSampler", "inputs": {
                "positive": ["positive"], "negative": ["negative"],
            }},
            "positive": {"class_type": "CLIPTextEncode", "inputs": {"text": "smile"}},
            "negative": {"class_type": "CLIPTextEncode", "inputs": {"text": "blush"}},
        }
        self.assertEqual(_comfy(graph), ("smile", "blush"))

    def test_malformed_png_metadata_does_not_stop_later_catalog_scan(self):
        malformed = self.png(self.images / "a-malformed.png", {"Comment": {
            "v4_prompt": {"caption": {"base_caption": "smile", "char_captions": None}},
            "v4_negative_prompt": {"caption": {"base_caption": "blush", "char_captions": 7}},
        }})
        normal = self.png(self.images / "b-normal.png", {"Comment": {"prompt": "closed eyes"}})
        original_rglob = Path.rglob

        def ordered_rglob(path, pattern):
            if path == self.images:
                yield malformed
                yield normal
                return
            yield from original_rglob(path, pattern)

        with mock.patch.object(Path, "rglob", ordered_rglob):
            self.catalog.set_folder(str(self.images))
            self.wait_scan()

        self.assertEqual(self.catalog.query("smile")["total"], 1)
        self.assertEqual(self.catalog.query("closed eyes")["total"], 1)
        item = self.catalog.query("smile")["items"][0]
        detail = self.catalog.detail(item["id"])
        self.assertEqual(detail["prompt"], "smile")
        self.assertEqual(detail["negative_prompt"], "blush")

    def test_webp_metadata_is_extracted(self):
        exif = Image.Exif()
        exif[37510] = b"UNICODE\x00" + "smile\nNegative prompt: blush\nSteps: 20".encode("utf-16-be")
        Image.new("RGB", (32, 96), "white").save(self.images / "sample.webp", exif=exif)
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        self.assertEqual(self.catalog.query("smile")["total"], 1)
        self.assertEqual(self.catalog.query("blush")["total"], 0)
        detail = self.catalog.detail(self.catalog.query("smile")["items"][0]["id"])
        self.assertEqual(detail["metadata_source"], "EXIF")
        self.assertEqual(detail["negative_prompt"], "blush")

    def test_archived_png_metadata_is_searchable_after_lossy_webp_copy(self):
        import random
        from naim.images.webp_conversion import convert_png_to_webp
        path = self.images / 'copy.png'
        metadata = PngInfo()
        metadata.add_text('Comment', json.dumps({'prompt': 'smile, closed eyes', 'uc': 'blush'}))
        Image.frombytes('RGB', (128, 192), random.Random(7).randbytes(128 * 192 * 3)).save(path, pnginfo=metadata)
        original = path.read_bytes()
        result = convert_png_to_webp(path, lossless=False, quality=90, keep_original=True)
        self.assertEqual(result['status'], 'converted', result.get('reason'))
        self.assertEqual(path.read_bytes(), original)
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        matches = self.catalog.query('smile')['items']
        self.assertEqual(len(matches), 2)
        for item in matches:
            detail = self.catalog.detail(item['id'])
            self.assertEqual(detail['prompt'], 'smile, closed eyes')
            self.assertEqual(detail['negative_prompt'], 'blush')
            self.assertEqual(detail['metadata_source'], 'Comment')

    def pack_image(self):
        root = self.catalog.directory / 'shared_image_packs' / ('a' * 64)
        path = root / 'images' / '000037.webp'
        path.parent.mkdir(parents=True)
        Image.new('RGB', (32, 96), 'white').save(path, 'WEBP', quality=90)
        return root, [{'id': 37, 'file': 'images/000037.webp', 'width': 32, 'height': 96,
                       'prompt': 'smile, closed eyes', 'negative': 'blush', 'source': 'Comment'}]

    def test_verified_pack_connects_with_stable_ids_and_keeps_user_edits(self):
        root, records = self.pack_image()
        edits = self.catalog.directory / 'user_edits.json'
        edits.write_text('{"synthetic":true}', encoding='utf-8')
        original_edits = edits.read_bytes()
        self.assertTrue(self.catalog.can_install_image_pack())
        status = self.catalog.install_image_pack(root, records, self.catalog.generation)
        self.assertEqual(status['total_files'], 1)
        self.assertEqual(self.catalog.query('smile')['items'][0]['id'], 37)
        self.assertEqual(self.catalog.detail(37)['negative_prompt'], 'blush')
        self.assertFalse(self.catalog.can_install_image_pack())
        self.assertEqual(edits.read_bytes(), original_edits)

    def test_pack_cannot_replace_a_working_folder_or_later_folder_choice(self):
        root, records = self.pack_image()
        generation = self.catalog.generation
        self.png(self.images / 'original.png', {'Comment': {'prompt': 'smile'}})
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        original = self.catalog.query('smile')
        with self.assertRaises(ValueError):
            self.catalog.install_image_pack(root, records, generation)
        with self.assertRaises(ValueError):
            self.catalog.install_image_pack(root, records, self.catalog.generation)
        self.assertEqual(self.catalog.query('smile'), original)
        self.assertEqual(Path(self.catalog.folder), self.images.resolve())

    def test_pack_cancel_and_database_failure_leave_connection_unchanged(self):
        root, records = self.pack_image()
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(InterruptedError):
            self.catalog.install_image_pack(root, records, self.catalog.generation, cancelled)
        self.assertIsNone(self.catalog.folder)
        with self.catalog._connect() as db:
            db.execute("CREATE TRIGGER fail_pack BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT,'synthetic'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.catalog.install_image_pack(root, records, self.catalog.generation)
        self.assertIsNone(self.catalog.folder)
        self.assertEqual(self.catalog.status()['total_files'], 0)
        with self.catalog._connect() as db:
            self.assertIsNone(db.execute("SELECT value FROM settings WHERE key='folder'").fetchone())

    def test_incremental_update_deletion_folder_switch_and_persistent_connection(self):
        path = self.png(self.images / "one.png", {"parameters": "smile\nSteps: 20"})
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        identifier = self.catalog.query("smile")["items"][0]["id"]
        revision = self.catalog.status()["revision"]
        self.catalog.scan_async()
        self.wait_scan()
        self.assertEqual(self.catalog.status()["revision"], revision)
        self.assertEqual(self.catalog.query("smile")["items"][0]["id"], identifier)

        self.png(path, {"parameters": "light smile\nNegative prompt: blush\nSteps: 20"})
        os.utime(path, ns=(time.time_ns() + 2_000_000_000, time.time_ns() + 2_000_000_000))
        self.catalog.scan_async()
        self.wait_scan()
        self.assertEqual(self.catalog.query("smile")["total"], 0)
        self.assertEqual(self.catalog.query("light smile")["items"][0]["id"], identifier)
        self.assertGreater(self.catalog.status()["revision"], revision)

        path.unlink()
        self.catalog.scan_async()
        self.wait_scan()
        self.assertEqual(self.catalog.query("light smile")["total"], 0)
        self.assertIsNone(self.catalog.detail(identifier))

        other = self.root / "other"
        self.png(other / "two.png", {"parameters": "blush\nSteps: 20"})
        self.catalog.set_folder(str(other))
        self.wait_scan()
        self.assertEqual(self.catalog.status()["folder"], str(other.resolve()))
        self.assertEqual(self.catalog.query("blush")["total"], 1)
        self.catalog.close()
        self.catalog = ImageCatalog(self.catalog_dir, {"smile", "light smile", "closed eyes", "blush"})
        self.wait_scan()
        self.assertEqual(Path(self.catalog.status()["folder"]), other.resolve())
        self.assertEqual(self.catalog.query("blush")["total"], 1)

    def test_empty_and_unreadable_metadata_stays_unlinked(self):
        self.png(self.images / "empty.png")
        (self.images / "broken.webp").write_bytes(b"not an image")
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        status = self.catalog.status()
        self.assertEqual(status["total_files"], 2)
        self.assertEqual(status["no_prompt"], 1)
        self.assertEqual(status["unreadable"], 1)
        self.assertEqual(self.catalog.query("smile")["total"], 0)

    def test_api_ids_must_remain_inside_the_connected_folder(self):
        path = self.png(self.images / "inside.png", {"parameters": "smile\nSteps: 20"})
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        outside = self.png(self.root / "outside.png", {"parameters": "smile\nSteps: 20"})
        with sqlite3.connect(self.catalog.database) as db:
            db.execute("""INSERT INTO images(id,path,mtime,size,width,height,prompt,negative,source,tags,status)
                VALUES(9001,?,?,?,?,?,?,?,?,?,?)""", (
                str(outside), 0, outside.stat().st_size, 32, 96, "smile", "", "fixture", '["smile"]', "indexed"))
            db.execute("INSERT INTO image_tags(image_id,tag) VALUES(9001,'smile')")
        matches = self.catalog.query("smile", 0, 100)
        self.assertNotIn(9001, {item["id"] for item in matches["items"]})
        self.assertIsNone(self.catalog.detail(9001))
        self.assertIsNone(self.catalog.file_path(9001))
        inside_id = self.catalog.query("smile")["items"][0]["id"]
        path.unlink()
        self.assertIsNone(self.catalog.detail(inside_id))
        self.assertIsNone(self.catalog.file_path(inside_id))

    def test_stop_after_enumeration_does_not_purge_unseen_database_rows(self):
        first = self.png(self.images / "first.png", {"parameters": "smile\nSteps: 20"})
        second = self.png(self.images / "second.png", {"parameters": "blush\nSteps: 20"})
        self.catalog.set_folder(str(self.images))
        self.wait_scan()
        second_row = self.catalog.detail(self.catalog.query("blush")["items"][0]["id"])
        second_key = str(second.resolve())
        second.unlink()

        entered = threading.Event()
        release = threading.Event()
        original_rglob = Path.rglob

        def delayed_rglob(path, pattern):
            if path == self.images:
                yield first
                entered.set()
                release.wait(5)
                return
            yield from original_rglob(path, pattern)

        with mock.patch.object(Path, "rglob", delayed_rglob):
            self.catalog.scan_async()
            self.assertTrue(entered.wait(5))
            closer = threading.Thread(target=self.catalog.close)
            closer.start()
            self.assertTrue(self.catalog.stop.wait(2))
            release.set()
            closer.join(7)
            self.assertFalse(closer.is_alive())

        with sqlite3.connect(self.catalog.database) as db:
            kept = db.execute("SELECT COUNT(*) FROM images WHERE path=?", (second_key,)).fetchone()[0]
        self.assertEqual(kept, 1)
        self.assertIsNone(self.catalog.detail(second_row["id"]))


if __name__ == "__main__":
    unittest.main()
