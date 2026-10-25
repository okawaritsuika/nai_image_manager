import base64
import io
import json
import unittest
import urllib.error
import zipfile
from unittest import mock

from PIL import Image
import app


class GenerationTransportTests(unittest.TestCase):
    @staticmethod
    def inpaint_request():
        image = io.BytesIO()
        Image.new('RGB', (8, 8), 'white').save(image, 'PNG')
        encoded = 'data:image/png;base64,' + base64.b64encode(image.getvalue()).decode()
        return {'key': 'synthetic-key', 'image': encoded, 'mask': encoded,
                'promptInfo': {'basePrompt': 'synthetic prompt', 'charPrompts': ['synthetic character']},
                'persistResult': False}

    def test_retired_generation_never_contacts_novelai(self):
        with mock.patch('naim.novelai.urllib.request.urlopen') as send:
            for payload in ({'key': 'synthetic-key'}, {}):
                result = app.app.test_client().post('/api/generate', json=payload)
                self.assertEqual(result.status_code, 410)
                self.assertEqual(result.json['status'], 'retired')
                self.assertEqual(result.json['archive_url'], '/legacy-generation')
        send.assert_not_called()

    def test_canvas_inpaint_returns_image_and_preserves_request_contract(self):
        pixels = io.BytesIO()
        Image.new('RGB', (8, 8), 'white').save(pixels, 'PNG')
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('result.png', pixels.getvalue())
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = archive.getvalue()
        with mock.patch('naim.novelai.urllib.request.urlopen', return_value=response) as send:
            result = app.app.test_client().post('/api/canvas/inpaint', json=self.inpaint_request())
        self.assertEqual(result.status_code, 200, result.json)
        with Image.open(io.BytesIO(base64.b64decode(result.json['image'].split(',', 1)[1]))) as image:
            self.assertEqual(image.size, (8, 8))
            self.assertEqual(image.convert('RGB').getpixel((0, 0)), (255, 255, 255))
        request = send.call_args.args[0]
        payload = json.loads(send.call_args.kwargs['data'])
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-key')
        self.assertEqual(payload['model'], app.NAI_INPAINT_MODEL)
        self.assertEqual(payload['action'], 'infill')
        self.assertEqual(payload['parameters']['v4_prompt']['caption']['char_captions'][0]['char_caption'], 'synthetic character')

    def test_canvas_inpaint_http_error_and_non_image_archive_are_reported(self):
        client = app.app.test_client()
        error = urllib.error.HTTPError('synthetic', 429, 'rate limit', {}, io.BytesIO(b'synthetic rate limit'))
        with mock.patch('naim.novelai.urllib.request.urlopen', side_effect=error):
            result = client.post('/api/canvas/inpaint', json=self.inpaint_request())
        self.assertEqual(result.status_code, 500)
        self.assertIn('429', result.json['message'])
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('message.txt', 'no image')
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = archive.getvalue()
        with mock.patch('naim.novelai.urllib.request.urlopen', return_value=response):
            result = client.post('/api/canvas/inpaint', json=self.inpaint_request())
        self.assertEqual(result.status_code, 500)
        self.assertEqual(result.json['status'], 'error')
