from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.parse import quote

from PIL import Image
import app
from naim.images.previews import PreviewCache
from naim.storage.legacy_archive import list_archive_images, resolve_archive_image


class LegacyArchiveTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'output'
        self.daki = self.root / 'daki_generated_temp'
        self.output.mkdir()
        self.daki.mkdir()
        for name, value in (('OUTPUT_DIR', str(self.output)), ('DAKI_GENERATED_TEMP_DIR', str(self.daki)),
                            ('IMAGE_PREVIEW_CACHE', PreviewCache(self.root / 'cache'))):
            patch = mock.patch.object(app, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        self.client = app.app.test_client()

    def make_image(self, root, name):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        Image.new('RGB', (16, 8), 'red').save(path)
        return path

    def test_retired_page_urls_and_new_page_keep_archive_access(self):
        for url in ('/style-lab', '/daki-workshop', '/legacy-generation'):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertIn('이전 생성 자료'.encode(), response.data)
            self.assertNotIn(b'/static/style_lab.js', response.data)
            self.assertNotIn(b'/static/daki_workshop.js', response.data)
            response.close()
        for url in ('/canvas', '/static/style_lab.css', '/static/canvas.js',
                    '/static/legacy_generation.css', '/static/legacy_generation.js'):
            response = self.client.get(url)
            self.assertEqual(response.status_code, 200, url)
            response.close()

    def test_listing_pages_images_and_keeps_all_source_bytes(self):
        for name in ('one.png', 'nested/two.png', 'three.png'):
            path = self.make_image(self.output, name)
            path.with_suffix('.json').write_bytes(b'{"synthetic_legacy_extension":true}')
        self.make_image(self.daki, 'draft.png')
        originals = {path: path.read_bytes() for root in (self.output, self.daki)
                     for path in root.rglob('*') if path.is_file()}
        cursor = ''
        found = []
        with mock.patch('naim.novelai.urllib.request.urlopen') as send:
            while True:
                response = self.client.get('/api/legacy-generation/images',
                                           query_string={'source': 'output', 'cursor': cursor, 'limit': 1})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(len(response.json['items']), 1)
                found.extend(item['path'] for item in response.json['items'])
                cursor = response.json['next_cursor']
                if not cursor:
                    break
            draft = self.client.get('/api/legacy-generation/images?source=daki').json
            self.assertEqual([item['name'] for item in draft['items']], ['draft.png'])
        send.assert_not_called()
        self.assertEqual(found, ['nested/two.png', 'one.png', 'three.png'])
        for path, raw in originals.items():
            self.assertEqual(path.read_bytes(), raw)

    def test_original_and_preview_urls_handle_encoded_names(self):
        path = self.make_image(self.output, 'synthetic & 한글.png')
        raw = path.read_bytes()
        result = self.client.get('/api/legacy-generation/images').json
        source = result['items'][0]['src']
        self.assertIn(quote(path.name), source)
        original = self.client.get(source)
        self.assertEqual(original.data, raw)
        original.close()
        preview = self.client.get(source + '?preview=256')
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, 'image/jpeg')
        self.assertEqual(path.read_bytes(), raw)

    def test_unknown_sources_traversal_and_sidecars_are_rejected(self):
        self.make_image(self.root, 'outside.png')
        (self.output / 'settings.json').write_bytes(b'{"synthetic":"private"}')
        self.assertEqual(self.client.get('/api/legacy-generation/images?source=arbitrary').status_code, 400)
        self.assertEqual(self.client.get('/api/legacy-generation/images?limit=invalid').status_code, 400)
        for url in ('/legacy-generation/image/output/../outside.png',
                    '/legacy-generation/image/output/settings.json',
                    '/legacy-generation/image/output/C:/outside.png'):
            self.assertEqual(self.client.get(url).status_code, 400, url)
        self.assertEqual(self.client.get('/legacy-generation/image/unknown/image.png').status_code, 404)
        self.assertEqual(self.client.get('/legacy-generation/image/output/missing.png').status_code, 404)

    def test_page_size_is_bounded_and_missing_folder_is_empty(self):
        for index in range(98):
            self.make_image(self.output, f'{index:03}.png')
        result = list_archive_images(self.output, limit=10000)
        self.assertEqual(len(result['items']), 96)
        self.assertEqual(result['next_cursor'], '095.png')
        self.assertEqual(len(list_archive_images(self.output, result['next_cursor'])['items']), 2)
        self.assertEqual(list_archive_images(self.root / 'missing')['items'], [])

    def test_resolved_path_escape_is_rejected(self):
        outside = self.make_image(self.root, 'outside.png')
        real_resolve = Path.resolve

        def resolved(path, *args, **kwargs):
            if path.name == 'synthetic-link.png':
                return outside
            return real_resolve(path, *args, **kwargs)

        with mock.patch.object(Path, 'resolve', resolved):
            with self.assertRaises(ValueError):
                resolve_archive_image(self.output, 'synthetic-link.png')
