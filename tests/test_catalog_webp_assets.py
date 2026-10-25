import csv
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image

from naim.images.webp_conversion import convert_image_to_webp, webp_target_path
from naim.storage import catalog_image_conversion as catalog_module
from naim.storage.catalog_image_conversion import CatalogImageReferences
from naim.storage.webp_conversion import WebpReferenceRollbackError


class CatalogWebpAssetsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'images').mkdir()
        Image.new('RGB', (12, 9), 'navy').save(self.root / 'images' / 'portrait.jpg', quality=95)
        Image.new('RGBA', (10, 8), (20, 30, 40, 200)).save(self.root / 'images' / 'icon.png')

        html_data = {
            'items': [
                {'image': 'images/portrait.jpg', 'image_sha256': 'old-jpg', 'job_sha256': 'job-origin',
                 'prompt': '한글 "quoted" <keep> images/portrait.jpg', 'unknown': {'positive': 'images/icon.png'}},
                {'image_path': 'images/icon.png', 'image_sha256': 'old-png', 'job_sha256': 'job-png'},
            ],
        }
        self.html_before = (
            '<!doctype html>\n<section>outside "text"</section>\n'
            '<script>window.keep = "untouched";</script>\n'
            '<script type="application/json" id="data">\n' + json.dumps(html_data, ensure_ascii=False, indent=2)
            + '\n</script>\n<footer>remain exactly</footer>\n'
        ).encode('utf-8')
        (self.root / 'index.html').write_bytes(self.html_before)

        csv_rows = [
            ['tag', 'prompt', 'examples', 'note'],
            ['portrait', 'keep ".png" and 한글', json.dumps([
                {'image': 'images/portrait.jpg', 'thumbnail': 'images/portrait.jpg',
                 'image_sha256': 'old-csv-jpg', 'job_sha256': 'csv-job', 'review_note': 'line one\nline "two"'},
                {'image_path': 'images/icon.png', 'image_sha256': 'old-csv-png', 'tag': 'unrelated.png'},
            ], ensure_ascii=False, indent=2), 'quoted "column"'],
        ]
        csv_buffer = io.StringIO(newline='')
        csv.writer(csv_buffer, lineterminator='\r\n').writerows(csv_rows)
        self.csv_before = b'\xef\xbb\xbf' + csv_buffer.getvalue().encode('utf-8')
        (self.root / 'tags.csv').write_bytes(self.csv_before)

        self.json_before = {
            'cards': [
                {'image': 'images/portrait.jpg', 'image_sha256': 'old-json-jpg', 'job_sha256': 'json-job',
                 'positive': 'images/portrait.jpg'},
                {'thumbnail': 'images/icon.png', 'image_sha256': 'thumbnail-hash-must-stay'},
            ],
            'unknown': {'prompt': 'do not edit images/portrait.jpg'},
        }
        (self.root / 'catalog.json').write_text(json.dumps(self.json_before, ensure_ascii=False), encoding='utf-8')
        self.json_path = self.root / 'catalog.json'
        self.html_path = self.root / 'index.html'
        self.csv_path = self.root / 'tags.csv'

    def _read_html_data(self):
        text = self.html_path.read_text(encoding='utf-8')
        return catalog_module._data_script(text)[2]

    def _read_csv(self):
        raw = self.csv_path.read_bytes()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        rows = list(csv.reader(io.StringIO(raw.decode('utf-8-sig'), newline='')))
        return rows, json.loads(rows[1][2])

    def test_conversion_updates_json_html_and_csv_refs_and_hashes(self):
        refs = CatalogImageReferences(self.root)
        jpg_source = self.root / 'images' / 'portrait.jpg'
        png_source = self.root / 'images' / 'icon.png'
        jpg_result = convert_image_to_webp(jpg_source, before_delete=refs.prepare)
        png_result = convert_image_to_webp(png_source, before_delete=refs.prepare)
        self.assertEqual(jpg_result['status'], 'converted', jpg_result)
        self.assertEqual(png_result['status'], 'converted', png_result)
        jpg_target = webp_target_path(jpg_source)
        png_target = webp_target_path(png_source)
        self.assertTrue(jpg_target.is_file())
        self.assertTrue(png_target.is_file())
        self.assertFalse(jpg_source.exists())
        self.assertFalse(png_source.exists())
        jpg_hash = hashlib.sha256(jpg_target.read_bytes()).hexdigest()
        png_hash = hashlib.sha256(png_target.read_bytes()).hexdigest()

        catalog = json.loads(self.json_path.read_text(encoding='utf-8'))
        self.assertEqual(catalog['cards'][0]['image'], 'images/portrait.jpg.webp')
        self.assertEqual(catalog['cards'][0]['image_sha256'], jpg_hash)
        self.assertEqual(catalog['cards'][0]['job_sha256'], 'json-job')
        self.assertEqual(catalog['cards'][0]['positive'], 'images/portrait.jpg')
        self.assertEqual(catalog['cards'][1]['thumbnail'], 'images/icon.webp')
        self.assertEqual(catalog['cards'][1]['image_sha256'], 'thumbnail-hash-must-stay')
        self.assertEqual(catalog['unknown']['prompt'], 'do not edit images/portrait.jpg')

        html_data = self._read_html_data()
        self.assertEqual(html_data['items'][0]['image'], 'images/portrait.jpg.webp')
        self.assertEqual(html_data['items'][0]['image_sha256'], jpg_hash)
        self.assertEqual(html_data['items'][0]['job_sha256'], 'job-origin')
        self.assertEqual(html_data['items'][0]['prompt'], '한글 "quoted" <keep> images/portrait.jpg')
        self.assertEqual(html_data['items'][0]['unknown']['positive'], 'images/icon.png')
        self.assertEqual(html_data['items'][1]['image_path'], 'images/icon.webp')
        self.assertEqual(html_data['items'][1]['image_sha256'], png_hash)
        html_text = self.html_path.read_text(encoding='utf-8')
        self.assertIn('window.keep = "untouched";', html_text)
        self.assertIn('<footer>remain exactly</footer>', html_text)
        self.assertIn('\\u003ckeep>', html_text)

        rows, examples = self._read_csv()
        self.assertEqual(rows[0], ['tag', 'prompt', 'examples', 'note'])
        self.assertEqual(rows[1][0], 'portrait')
        self.assertEqual(rows[1][1], 'keep ".png" and 한글')
        self.assertEqual(rows[1][3], 'quoted "column"')
        self.assertEqual(examples[0]['image'], 'images/portrait.jpg.webp')
        self.assertEqual(examples[0]['thumbnail'], 'images/portrait.jpg.webp')
        self.assertEqual(examples[0]['image_sha256'], jpg_hash)
        self.assertEqual(examples[0]['job_sha256'], 'csv-job')
        self.assertEqual(examples[0]['review_note'], 'line one\nline "two"')
        self.assertEqual(examples[1]['image_path'], 'images/icon.webp')
        self.assertEqual(examples[1]['image_sha256'], png_hash)
        self.assertEqual(examples[1]['tag'], 'unrelated.png')

    def test_second_text_write_failure_rolls_back_every_catalog_and_keeps_source(self):
        refs = CatalogImageReferences(self.root)
        source = self.root / 'images' / 'portrait.jpg'
        old_html = self.html_path.read_bytes()
        old_csv = self.csv_path.read_bytes()
        original_atomic_write = catalog_module._atomic_write_bytes

        def fail_csv(path, data):
            if path.name == 'tags.csv':
                raise OSError('synthetic CSV replace failure')
            return original_atomic_write(path, data)

        with mock.patch.object(catalog_module, '_atomic_write_bytes', side_effect=fail_csv):
            result = convert_image_to_webp(source, before_delete=refs.prepare)
        self.assertEqual(result['status'], 'skipped', result)
        self.assertTrue(source.is_file())
        self.assertFalse(webp_target_path(source).exists())
        self.assertEqual(json.loads(self.json_path.read_text(encoding='utf-8')), self.json_before)
        self.assertEqual(self.html_path.read_bytes(), old_html)
        self.assertEqual(self.csv_path.read_bytes(), old_csv)

    def test_rollback_does_not_replace_external_html_edit(self):
        refs = CatalogImageReferences(self.root)
        source = self.root / 'images' / 'portrait.jpg'
        target = webp_target_path(source)
        target.write_bytes(b'synthetic verified webp target')
        rollback = refs.prepare(source, target)
        external = self.html_path.read_bytes() + b'<!-- external change -->\n'
        self.html_path.write_bytes(external)
        with self.assertRaises(WebpReferenceRollbackError):
            rollback()
        self.assertEqual(self.html_path.read_bytes(), external)
        # Other catalog files are still restored even though HTML was edited externally.
        self.assertEqual(json.loads(self.json_path.read_text(encoding='utf-8')), self.json_before)

    def test_malformed_html_or_examples_json_fails_during_preflight(self):
        self.html_path.write_text('<script id="data" type="application/json">{broken</script>', encoding='utf-8')
        with self.assertRaises(ValueError):
            CatalogImageReferences(self.root)

        self.html_path.unlink()
        self.csv_path.write_text('tag,examples\nitem,"{broken}"\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            CatalogImageReferences(self.root)


if __name__ == '__main__':
    unittest.main()
