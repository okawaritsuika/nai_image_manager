from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import app


class GalleryTagConcurrencyTests(unittest.TestCase):
    def test_simultaneous_assignments_do_not_lose_other_image_tags(self):
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(app, 'GALLERY_IMAGE_TAGS_FILE', str(Path(temporary) / 'tags.json')):
                app.save_gallery_image_tags_config(app.default_gallery_image_tags_config())
                load = app.load_gallery_image_tags_config
                gate = threading.Barrier(8)

                def delayed_load():
                    config = load()
                    time.sleep(0.02)
                    return config

                def assign(index):
                    gate.wait()
                    with app.app.test_client() as client:
                        return client.post('/api/gallery/image_tag', json={
                            'path': f'synthetic-{index}.png', 'tag_id': 'star',
                        }).status_code

                with mock.patch.object(app, 'load_gallery_image_tags_config', side_effect=delayed_load):
                    with ThreadPoolExecutor(max_workers=8) as executor:
                        self.assertEqual(list(executor.map(assign, range(8))), [200] * 8)
                self.assertEqual(len(load()['image_tags']), 8)
