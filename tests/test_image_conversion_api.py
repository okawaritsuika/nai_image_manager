import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from flask import Flask
from PIL import Image

from naim.images.gallery_conversion import gallery_image_processor
from naim.images.webp_conversion import convert_image_to_webp, resolve_webp_image, webp_target_path
from naim.jobs.image_conversion import ImageConversionJobs
from naim.storage.catalog_image_conversion import CatalogImageReferences
from naim.storage.history import HistoryDB
from naim.web.image_conversion import register_image_conversion_routes
from naim.web.lifecycle import register_job_shutdown


class ImageConversionAPITests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.gallery = self.root / 'gallery'
        self.gallery.mkdir()
        self.tags = self.root / 'tags.json'
        self.tags.write_text(json.dumps({'image_tags': {'a.png': 'favorite'}, 'unknown': 3}), encoding='utf-8')
        Image.new('RGB', (24, 32), 'skyblue').save(self.gallery / 'a.png')
        Image.new('RGB', (24, 32), 'green').save(self.gallery / 'b.jpg')

        def resolve(relative):
            path = (self.gallery / relative).resolve()
            if not path.is_relative_to(self.gallery):
                raise ValueError('Invalid path')
            path = resolve_webp_image(path)
            if not path.is_file():
                raise FileNotFoundError()
            return str(path), relative

        self.resolve = resolve
        self.jobs = ImageConversionJobs(gallery_image_processor(resolve, lambda: self.gallery, lambda: self.tags))
        self.addCleanup(self.jobs.shutdown)
        self.app = Flask(__name__)
        register_image_conversion_routes(self.app, self.jobs, resolve)
        self.client = self.app.test_client()

    def test_actual_header_batch_conversion_and_existing_references(self):
        response = self.client.post('/api/gallery/image-formats', json={'paths': ['a.png', 'b.jpg', '../outside.png']})
        self.assertEqual(response.json['formats'], {'a.png': 'PNG', 'b.jpg': 'JPEG', '../outside.png': 'UNKNOWN'})
        db = HistoryDB(self.gallery / 'naia_history.db')
        for name in ('a.png', 'b.jpg'):
            db.upsert_gallery_image_file(self.gallery / name, classified_root=self.gallery)
        db.close()
        response = self.client.post('/api/gallery/webp', json={'paths': ['a.png', 'b.jpg', 'a.png'], 'quality': 90})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['job']['total'], 2)
        self.jobs.thread.join(10)
        result = self.client.get('/api/gallery/webp').json['job']
        self.assertEqual((result['status'], result['converted'], result['skipped'], result['failed']), ('completed', 2, 0, 0), result)
        self.assertTrue((self.gallery / 'a.webp').is_file())
        self.assertTrue((self.gallery / 'b.jpg.webp').is_file())
        self.assertFalse((self.gallery / 'a.png').exists())
        self.assertEqual(json.loads(self.tags.read_text())['image_tags'], {'a.webp': 'favorite'})
        self.assertEqual(json.loads(self.tags.read_text())['unknown'], 3)
        # The public PNG-shaped handle must report the actual WebP header.
        formats = self.client.post('/api/gallery/image-formats', json={'paths': ['a.png']}).json['formats']
        self.assertEqual(formats, {'a.png': 'WEBP'})
        self.client.post('/api/gallery/webp', json={'paths': ['a.png']})
        self.jobs.thread.join(10)
        self.assertEqual(self.jobs.snapshot()['skipped'], 1)

    def test_validation_failure_is_read_only(self):
        original = (self.gallery / 'a.png').read_bytes()
        for payload in (None, [], {}, {'paths': []}, {'paths': ['a.png'], 'quality': True},
                        {'paths': ['a.png'], 'quality': 101}, {'paths': [123]}):
            self.assertEqual(self.client.post('/api/gallery/webp', json=payload).status_code, 400)
        self.assertEqual((self.gallery / 'a.png').read_bytes(), original)
        self.assertEqual(self.client.post('/api/gallery/image-formats', json={'paths': ['a.png'] * 201}).status_code, 400)

    def test_duplicate_start_and_stale_cancel_do_not_change_active_job(self):
        entered, release = threading.Event(), threading.Event()

        def processor(path, quality, event):
            entered.set()
            release.wait(5)
            return {'status': 'skipped', 'source_bytes': 5, 'target_bytes': 0}

        self.jobs.processor = processor
        result = self.client.post('/api/gallery/webp', json={'paths': ['a.png', 'b.jpg']})
        self.assertTrue(entered.wait(2))
        try:
            self.assertEqual(self.client.post('/api/gallery/webp', json={'paths': ['b.jpg']}).status_code, 409)
            self.assertEqual(self.client.post('/api/gallery/webp/cancel', json={'id': 'stale'}).status_code, 409)
            cancelled = self.client.post('/api/gallery/webp/cancel', json={'id': result.json['job']['id']})
            self.assertTrue(cancelled.json['job']['cancel_requested'])
        finally:
            release.set()
            self.jobs.thread.join(5)
        self.assertEqual(self.jobs.snapshot()['status'], 'cancelled')
        self.assertEqual(self.jobs.snapshot()['processed'], 1)

    def test_shutdown_also_stops_image_conversion_when_other_service_fails(self):
        import os
        first, second = mock.Mock(), mock.Mock()
        first.shutdown.return_value = False
        second.shutdown.return_value = True
        register_job_shutdown(self.app, first, 'synthetic-control', additional_jobs=(second,))
        response = self.client.post('/api/internal/shutdown_jobs', json={'pid': os.getpid()},
                                    headers={'X-NAIM-Control': 'synthetic-control'})
        self.assertEqual(response.status_code, 503)
        first.shutdown.assert_called_once()
        second.shutdown.assert_called_once()

    def test_failed_file_is_counted_and_later_files_continue(self):
        self.client.post('/api/gallery/webp', json={'paths': ['missing.png', 'a.png']})
        self.jobs.thread.join(10)
        state = self.jobs.snapshot()
        self.assertEqual((state['processed'], state['failed'], state['converted']), (2, 1, 1), state)


class CatalogImageConversionTests(unittest.TestCase):
    def test_image_fields_update_with_rollback_and_unknown_values_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'images').mkdir()
            source = root / 'images' / 'sample.png'
            Image.new('RGBA', (16, 24), (40, 80, 120, 230)).save(source)
            document = root / 'catalog.json'
            before = {'cards': [{'image': 'images/sample.png', 'thumbnail': 'images\\sample.png',
                                 'positive': 'images/sample.png', 'unknown': [1, 'preserve']} ]}
            document.write_text(json.dumps(before), encoding='utf-8')
            references = CatalogImageReferences(root)
            target = webp_target_path(source)
            target.write_bytes(b'callback test placeholder')
            undo = references.prepare(source, target)
            after = json.loads(document.read_text(encoding='utf-8'))
            self.assertEqual(after['cards'][0]['image'], 'images/sample.webp')
            self.assertEqual(after['cards'][0]['thumbnail'], 'images/sample.webp')
            self.assertEqual(after['cards'][0]['positive'], 'images/sample.png')
            self.assertEqual(after['cards'][0]['unknown'], [1, 'preserve'])
            undo()
            self.assertEqual(json.loads(document.read_text(encoding='utf-8')), before)
            target.unlink()
            result = convert_image_to_webp(source, before_delete=references.prepare)
            self.assertEqual(result['status'], 'converted', result)
            self.assertEqual(json.loads(document.read_text(encoding='utf-8'))['cards'][0]['image'], 'images/sample.webp')

    def test_catalog_write_failure_preserves_source_and_restores_previous_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'image.png'
            Image.new('RGB', (8, 8)).save(source)
            before = {'image': 'image.png'}
            for name in ('a.json', 'b.json'):
                (root / name).write_text(json.dumps(before), encoding='utf-8')
            refs = CatalogImageReferences(root)
            from naim.storage import catalog_image_conversion as module
            original_write = module.write_json

            def fail_second(path, value, **kwargs):
                if path.name == 'b.json' and value['image'] == 'image.webp':
                    raise OSError('synthetic write failure')
                return original_write(path, value, **kwargs)

            with mock.patch.object(module, 'write_json', side_effect=fail_second):
                result = convert_image_to_webp(source, before_delete=refs.prepare)
            self.assertEqual(result['status'], 'skipped')
            self.assertTrue(source.is_file())
            self.assertFalse(webp_target_path(source).exists())
            for name in ('a.json', 'b.json'):
                self.assertEqual(json.loads((root / name).read_text(encoding='utf-8')), before)
