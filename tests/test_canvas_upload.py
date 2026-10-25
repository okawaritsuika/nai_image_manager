import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from PIL import Image
import app


class CanvasUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        patch = mock.patch.object(app, 'CANVAS_IMPORT_DIR', self.temp.name)
        patch.start()
        self.addCleanup(patch.stop)
        self.client = app.app.test_client()

    def test_ordinary_website_png_without_metadata_can_be_imported(self):
        image = io.BytesIO()
        Image.new('RGB', (64, 48), (40, 120, 200)).save(image, format='PNG')
        raw = image.getvalue()
        response = self.client.post('/api/canvas/upload_image', data={
            'file': (io.BytesIO(raw), 'clipboard.png'), 'sessionId': 'test-session',
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual((response.json['width'], response.json['height']), (64, 48))
        self.assertEqual(next(Path(self.temp.name).rglob('*.png')).read_bytes(), raw)

    def test_jpeg_orientation_dimensions_are_preserved(self):
        image = io.BytesIO()
        exif = Image.Exif()
        exif[274] = 6
        Image.new('RGB', (64, 48)).save(image, format='JPEG', exif=exif)
        response = self.client.post('/api/canvas/upload_image', data={
            'file': (io.BytesIO(image.getvalue()), 'rotated.jpg'),
        })
        self.assertEqual(response.status_code, 200, response.get_json())
        self.assertEqual((response.json['width'], response.json['height']), (48, 64))

    def test_corrupt_image_is_rejected_without_writing_files(self):
        response = self.client.post('/api/canvas/upload_image', data={
            'file': (io.BytesIO(b'not an image'), 'broken.png'),
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(list(Path(self.temp.name).rglob('*')), [])
