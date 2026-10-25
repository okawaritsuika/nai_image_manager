import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import app
import image_logic
from naim.images.webp_conversion import convert_png_to_webp
from naim.jobs.webp_compression import WebPCompressionJobs, gallery_processor
from naim.images import webp_conversion
from naim.storage.history import HistoryDB
from naim.storage.webp_conversion import migrate_webp_references


class GalleryWebPTests(unittest.TestCase):
    def test_parallel_batch_preserves_every_tag_metadata_and_database_reference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            tags = root / 'tags.json'
            image_tags, metadata = {}, {}
            sources = [root / f'{index}.png' for index in range(8)]
            db = HistoryDB(root / 'naia_history.db')
            jobs = None
            try:
                for index, source in enumerate(sources):
                    info = PngInfo()
                    info.add_text('Comment', json.dumps({'prompt': f'synthetic scene {index}', 'seed': index}))
                    Image.new('RGBA', (64, 64), (index * 20, 100, 150, 254)).save(source, pnginfo=info)
                    image_tags[source.name] = f'tag{index}'
                    metadata[source.stem] = app.extract_prompt_info_from_image(source)
                    db.upsert_gallery_image_file(source, classified_root=root, gallery_tag=f'tag{index}')
                tags.write_text(json.dumps({'image_tags': image_tags, 'custom': {'keep': [1, 2]}}), encoding='utf-8')
                barrier = threading.Barrier(4, timeout=5)
                verify = webp_conversion._verify_webp

                def verify_in_parallel(*args, **kwargs):
                    result = verify(*args, **kwargs)
                    barrier.wait()
                    return result

                jobs = WebPCompressionJobs(lambda: root, gallery_processor(db, root, tags), max_workers=4)
                with mock.patch.object(webp_conversion, '_verify_webp', side_effect=verify_in_parallel):
                    jobs.start(lossless=True, quality=90)
                    jobs.thread.join(12)
                self.assertFalse(jobs.thread.is_alive())
                state = jobs.snapshot()
                self.assertEqual((state['status'], state['converted'], state['failed'], state['skipped']),
                                 ('done', 8, 0, 0), state)
                after = json.loads(tags.read_text(encoding='utf-8'))
                self.assertEqual(after['custom'], {'keep': [1, 2]})
                self.assertEqual(after['image_tags'], {f'{index}.webp': f'tag{index}' for index in range(8)})
                for source in sources:
                    target = source.with_suffix('.webp')
                    self.assertFalse(source.exists())
                    self.assertEqual(app.extract_prompt_info_from_image(target), metadata[source.stem])
                    self.assertEqual(db.conn.execute('SELECT new_rel_path FROM gallery_webp_conversions WHERE old_rel_path = ?',
                                                     (source.name,)).fetchone(), (target.name,))
                    self.assertIsNotNone(db.conn.execute('SELECT rel_path FROM gallery_images WHERE rel_path = ?',
                                                        (target.name,)).fetchone())
            finally:
                if jobs is not None:
                    jobs.shutdown(12)
                db.close()

    def test_metadata_search_and_saved_canvas_urls_survive_both_compression_modes(self):
        for lossless in (True, False):
            with self.subTest(lossless=lossless), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / 'nested' / 'sample.png'
                source.parent.mkdir()
                info = PngInfo()
                raw = json.dumps({'prompt': 'synthetic scene', 'uc': 'synthetic negative',
                                  'model': 'nai-diffusion-5-full', 'steps': 28, 'seed': 42,
                                  'v4_prompt': {'caption': {'base_caption': 'synthetic scene',
                                      'char_captions': [{'char_caption': 'synthetic character'}]}}})
                info.add_text('Comment', raw)
                info.add_text('Source', 'NovelAI Diffusion V5')
                info.add_itxt('custom', 'synthetic multilingual 한글', lang='ko', tkey='custom label')
                Image.new('RGBA', (32, 48), (40, 120, 180, 254)).save(source, pnginfo=info)
                source_bytes = source.read_bytes()
                sidecar = source.with_suffix('.json')
                sidecar.write_text('{"custom": {"unknown": [1, 2]}}', encoding='utf-8')
                sidecar_bytes = sidecar.read_bytes()
                tags = root / 'tags.json'
                tags.write_text('{"image_tags": {"nested/sample.png": "star"}}', encoding='utf-8')
                before = app.extract_prompt_info_from_image(source)
                db = HistoryDB(root / 'naia_history.db')
                try:
                    db.upsert_gallery_image_file(source, classified_root=root, gallery_tag='star')
                    result = convert_png_to_webp(source, lossless=lossless, quality=85,
                        before_delete=lambda old, new: migrate_webp_references(db, root, old, new, tags))
                    self.assertEqual(result['status'], 'converted', result)
                finally:
                    db.close()
                target = source.with_suffix('.webp')
                self.assertFalse(source.exists())
                self.assertEqual(sidecar.read_bytes(), sidecar_bytes)
                self.assertEqual(app.extract_prompt_info_from_image(target), before)
                self.assertEqual(image_logic.extract_model_family_from_file(target), 'v5')
                with mock.patch.object(app, 'CLASSIFIED_DIR', str(root)):
                    client = app.app.test_client()
                    response = client.get('/image/nested/sample.png')
                    try:
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.mimetype, 'image/webp')
                    finally:
                        response.close()
                    self.assertEqual(app.resolve_gallery_image_path('nested/sample.png'),
                                     (str(target), 'nested/sample.webp'))
                    self.assertEqual(app.read_canvas_image_bytes('/image/nested/sample.png'), target.read_bytes())
                    old = client.post('/api/extract_metadata', data={
                        'file': (io.BytesIO(source_bytes), 'sample.png')})
                    new = client.post('/api/extract_metadata', data={
                        'file': (io.BytesIO(target.read_bytes()), 'sample.webp')})
                    self.assertEqual(old.json, new.json)
                    self.assertEqual(new.json['prompt'], raw)

    def test_unregistered_same_stem_webp_does_not_replace_a_missing_png_url(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            Image.new('RGB', (8, 8)).save(root / 'missing.webp', 'WEBP')
            with mock.patch.object(app, 'CLASSIFIED_DIR', str(root)):
                self.assertEqual(app.app.test_client().get('/image/missing.png').status_code, 404)
                with self.assertRaises(ValueError):
                    app.resolve_gallery_file_path('../outside.png')


if __name__ == '__main__':
    unittest.main()
