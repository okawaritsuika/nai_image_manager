import base64
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import zipfile

from PIL import Image, ImageDraw

import app
import naim.images.nai_upscale as nai_upscale
from naim.jobs.upscale import UpscaleJobs
from naim.processes import UpscaleCancelled
from naim.web.upscale import UpscaleAPI


def _png_bytes(size, color=(20, 40, 60, 255)):
    stream = io.BytesIO()
    Image.new('RGBA', size, color).save(stream, 'PNG')
    return stream.getvalue()


def _response_zip(images):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in images:
            archive.writestr(name, data)
    return output.getvalue()


class FakeResponse:
    def __init__(self, data):
        self.data = data
        self.read_limit = None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit):
        self.read_limit = limit
        return self.data


class NaiUpscalePlanTests(unittest.TestCase):
    def test_exact_ratio_and_64_multiple_plans(self):
        unchanged = nai_upscale.plan_nai_upscale(640, 2048)
        self.assertEqual(unchanged['crop_box'], [0, 0, 640, 2048])
        self.assertFalse(unchanged['cropped'])
        self.assertFalse(unchanged['resized'])
        self.assertEqual((unchanged['input_width'], unchanged['input_height']), (640, 2048))
        self.assertEqual((unchanged['output_width'], unchanged['output_height']), (1280, 4096))

        centered = nai_upscale.plan_nai_upscale(1024, 1638)
        self.assertEqual((centered['crop_width'], centered['crop_height']), (510, 1632))
        self.assertEqual(centered['crop_box'], [257, 3, 767, 1635])
        self.assertTrue(centered['cropped'])
        self.assertTrue(centered['resized'])
        self.assertEqual((centered['input_width'], centered['input_height']), (320, 1024))
        self.assertEqual((centered['output_width'], centered['output_height']), (640, 2048))

        large = nai_upscale.plan_nai_upscale(2500, 8000)
        self.assertEqual((large['input_width'], large['input_height']), (960, 3072))
        self.assertEqual((large['output_width'], large['output_height']), (1920, 6144))

        for plan in (unchanged, centered, large):
            self.assertEqual(plan['input_width'] * 16, plan['input_height'] * 5)
            self.assertEqual(plan['input_width'] % 64, 0)
            self.assertEqual(plan['input_height'] % 64, 0)

    def test_rejects_too_small_invalid_dimensions_and_over_130mp(self):
        for size in ((320, 1023), (0, 2048), (-1, 2048), (640.0, 2048), ('640', 2048),
                     (True, 2048), (13001, 10000)):
            with self.subTest(size=size), self.assertRaises(ValueError):
                nai_upscale.plan_nai_upscale(*size)


class NaiUpscaleImageTests(unittest.TestCase):
    def _source(self, path, size):
        width, height = size
        plan = nai_upscale.plan_nai_upscale(width, height)
        left, _top, right, _bottom = plan['crop_box']
        image = Image.new('RGBA', size, (10, 200, 30, 255))
        draw = ImageDraw.Draw(image)
        if left:
            draw.rectangle((0, 0, left - 1, height - 1), fill=(240, 10, 10, 255))
        if right < width:
            draw.rectangle((right, 0, width - 1, height - 1), fill=(10, 10, 240, 255))
        alpha_start = left + 20
        draw.rectangle((alpha_start, 0, alpha_start + 7, height - 1), fill=(10, 200, 30, 70))
        image.save(path, 'PNG')
        image.close()
        return plan, alpha_start - left

    def test_center_crop_alpha_and_source_bytes_are_preserved(self):
        for size in ((640, 2048), (900, 2048)):
            with self.subTest(size=size), tempfile.TemporaryDirectory() as directory:
                source_path = Path(directory) / 'source.png'
                target_path = Path(directory) / 'target.png'
                plan, alpha_local_x = self._source(source_path, size)
                original = source_path.read_bytes()
                observations = {}

                def request(_key, image_bytes, expected_size):
                    with Image.open(io.BytesIO(image_bytes)) as sent:
                        sent = sent.convert('RGB')
                        observations['size'] = sent.size
                        observations['left'] = sent.getpixel((0, 1000))
                        observations['right'] = sent.getpixel((sent.width - 1, 1000))
                        observations['alpha_flattened'] = sent.getpixel((alpha_local_x + 3, 1000))
                    return Image.new('RGBA', expected_size, (90, 100, 110, 255))

                with mock.patch.object(nai_upscale, 'request_nai_upscale', side_effect=request) as call:
                    result = nai_upscale.run_nai_upscale(
                        str(source_path), str(target_path), plan['output_width'], plan['output_height'],
                        api_key='synthetic-api-key',
                    )

                self.assertEqual(observations['size'], (plan['input_width'], plan['input_height']))
                self.assertEqual(observations['left'], (10, 200, 30))
                self.assertEqual(observations['right'], (10, 200, 30))
                self.assertNotEqual(observations['alpha_flattened'], (10, 200, 30))
                self.assertEqual(call.call_args.args[0], 'synthetic-api-key')
                self.assertEqual(result['nai_plan'], plan)
                self.assertEqual(source_path.read_bytes(), original)
                self.assertTrue(target_path.is_file())
                with Image.open(target_path) as output:
                    self.assertEqual(output.size, (plan['output_width'], plan['output_height']))
                    alpha = output.getpixel((alpha_local_x * 2 + 6, 2000))[3]
                    self.assertLessEqual(abs(alpha - 70), 3)

    def test_same_path_mismatch_and_pre_cancel_reject_before_request(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / 'source.png'
            source_path.write_bytes(_png_bytes((640, 2048)))
            original = source_path.read_bytes()
            request = mock.Mock()

            with mock.patch.object(nai_upscale, 'request_nai_upscale', request):
                with self.assertRaises(ValueError):
                    nai_upscale.run_nai_upscale(
                        str(source_path), str(source_path), 1280, 4096, api_key='mock-key')
                mismatch_target = Path(directory) / 'mismatch.png'
                with self.assertRaises(ValueError):
                    nai_upscale.run_nai_upscale(
                        str(source_path), str(mismatch_target), 640, 2048, api_key='mock-key')
                pre_cancel_target = Path(directory) / 'pre-cancel.png'
                cancelled = threading.Event()
                cancelled.set()
                with self.assertRaises(UpscaleCancelled):
                    nai_upscale.run_nai_upscale(
                        str(source_path), str(pre_cancel_target), 1280, 4096,
                        api_key='mock-key', cancel_event=cancelled)

            request.assert_not_called()
            self.assertEqual(source_path.read_bytes(), original)
            self.assertFalse((Path(directory) / 'mismatch.png').exists())
            self.assertFalse((Path(directory) / 'pre-cancel.png').exists())

    def test_cancel_during_request_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory) / 'source.png'
            target_path = Path(directory) / 'target.png'
            source_path.write_bytes(_png_bytes((640, 2048)))
            original = source_path.read_bytes()
            event = threading.Event()

            def cancel_during_call(_key, _image, expected_size):
                event.set()
                return Image.new('RGBA', expected_size, (10, 20, 30, 255))

            with mock.patch.object(nai_upscale, 'request_nai_upscale', side_effect=cancel_during_call) as request:
                with self.assertRaises(UpscaleCancelled):
                    nai_upscale.run_nai_upscale(
                        str(source_path), str(target_path), 1280, 4096,
                        api_key='mock-key', cancel_event=event)

            request.assert_called_once()
            self.assertFalse(target_path.exists())
            self.assertEqual(source_path.read_bytes(), original)
            self.assertFalse(list(Path(directory).glob('.nai-upscale-*')))


class NaiUpscaleTransportTests(unittest.TestCase):
    def _opener(self, data=None, error=None):
        response = FakeResponse(data or b'')
        opener = mock.Mock()
        opener.open.side_effect = error or (lambda request, timeout: response)
        return opener, response

    def test_transport_request_contract_and_single_png_zip_image(self):
        image_bytes = _png_bytes((8, 16), (1, 2, 3, 255))
        payload = _response_zip([('result.png', image_bytes)])
        opener, response = self._opener(payload)
        with mock.patch.object(nai_upscale.urllib.request, 'build_opener', return_value=opener) as build:
            result = nai_upscale.request_nai_upscale('synthetic-secret', b'input-image', (8, 16))

        build.assert_called_once()
        opener.open.assert_called_once()
        request = opener.open.call_args.args[0]
        timeout = opener.open.call_args.kwargs['timeout']
        self.assertEqual(request.full_url, 'https://image.novelai.net/ai/upscale')
        self.assertEqual(request.get_method(), 'POST')
        self.assertEqual(timeout, 180)
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-secret')
        self.assertEqual(request.get_header('Content-type'), 'application/json')
        data = json.loads(request.data.decode('utf-8'))
        self.assertEqual(data['model'], 'nai-diffusion-5-curated')
        self.assertEqual(data['declared_blur_sigma'], 0)
        self.assertEqual(base64.b64decode(data['image']), b'input-image')
        self.assertEqual(response.read_limit, nai_upscale.MAX_RESPONSE_BYTES + 1)
        self.assertEqual(result.size, (8, 16))
        self.assertEqual(result.mode, 'RGBA')
        result.close()

    def test_auth_balance_and_rate_errors_are_sanitized_without_retry(self):
        expected = {
            401: '인증에 실패했습니다',
            402: 'Anlas 잔액이 부족합니다',
            429: '요청이 많습니다',
        }
        for code, phrase in expected.items():
            with self.subTest(code=code):
                server_text = 'secret-token-from-server'
                error = urllib.error.HTTPError(
                    'https://image.novelai.net/ai/upscale', code, server_text, {}, io.BytesIO(server_text.encode()))
                opener, _response = self._opener(error=error)
                with mock.patch.object(nai_upscale.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(ValueError, phrase) as caught:
                        nai_upscale.request_nai_upscale('local-secret-key', b'input', (8, 16))
                opener.open.assert_called_once()
                self.assertNotIn('local-secret-key', str(caught.exception))
                self.assertNotIn(server_text, str(caught.exception))

    def test_wrong_size_multiple_images_and_malformed_json_are_rejected(self):
        wrong_size = _response_zip([('wrong.png', _png_bytes((16, 8)))])
        multiple = _response_zip([
            ('one.png', _png_bytes((8, 16))), ('two.png', _png_bytes((8, 16))),
        ])
        responses = (wrong_size, multiple, b'{"images":not-json')
        for payload in responses:
            with self.subTest(payload_length=len(payload)):
                opener, _response = self._opener(payload)
                with mock.patch.object(nai_upscale.urllib.request, 'build_opener', return_value=opener):
                    with self.assertRaisesRegex(ValueError, '응답의 이미지 형식 또는 크기'):
                        nai_upscale.request_nai_upscale('local-secret-key', b'input', (8, 16))
                opener.open.assert_called_once()


class NaiUpscaleRouteTests(unittest.TestCase):
    def _source(self, directory, size=(640, 2048)):
        path = Path(directory) / 'source.png'
        Image.new('RGB', size, (30, 60, 90)).save(path, 'PNG')
        return path

    def test_preview_is_local_and_does_not_read_credentials_or_call_nai(self):
        client = app.app.test_client()
        with mock.patch.object(app, 'get_upscale_nai_key') as key, \
             mock.patch.object(nai_upscale, 'request_nai_upscale') as request:
            response = client.post('/api/upscale/nai/preview', json={'width': 640, 'height': 2048})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json['plan']['output_width'], 1280)
        self.assertEqual(response.json['plan']['output_height'], 4096)
        key.assert_not_called()
        request.assert_not_called()

    def test_gallery_requires_confirmation_key_and_exact_planned_target(self):
        with tempfile.TemporaryDirectory() as directory:
            source = self._source(directory)
            jobs = mock.Mock()
            jobs.submit.return_value = {'id': 'synthetic-job', 'status': 'queued'}
            api = UpscaleAPI(
                jobs, lambda value: value,
                lambda _value: (str(source), source.name),
                authorize_nai=app.get_upscale_nai_key,
            )
            client = app.app.test_client()
            with mock.patch.object(app, 'UPSCALE_API', api), \
                 mock.patch.object(app, 'read_json', return_value={'key': ' synthetic-secret '} ) as read_config:
                unconfirmed = client.post('/api/gallery/upscale/start', json={
                    'source_path': 'source.png', 'engine': 'nai',
                    'target_width': 1280, 'target_height': 4096, 'nai_confirmed': False,
                })
                self.assertEqual(unconfirmed.status_code, 400)
                read_config.assert_not_called()
                jobs.submit.assert_not_called()

                wrong_target = client.post('/api/gallery/upscale/start', json={
                    'source_path': 'source.png', 'engine': 'nai',
                    'target_width': 640, 'target_height': 2048, 'nai_confirmed': True,
                })
                self.assertEqual(wrong_target.status_code, 400)
                jobs.submit.assert_not_called()

                accepted = client.post('/api/gallery/upscale/start', json={
                    'source_path': 'source.png', 'engine': 'nai',
                    'target_width': 1280, 'target_height': 4096, 'nai_confirmed': True,
                })
                self.assertEqual(accepted.status_code, 200, accepted.json)
                self.assertEqual(accepted.json['status'], 'started')
                job = jobs.submit.call_args.args[0]
                self.assertEqual((job['target_width'], job['target_height']), (1280, 4096))
                self.assertEqual(job['engine'], 'nai')
                self.assertNotIn('synthetic-secret', accepted.get_data(as_text=True))

            jobs.submit.reset_mock()
            with mock.patch.object(app, 'UPSCALE_API', api), \
                 mock.patch.object(app, 'read_json', return_value={}):
                no_key = client.post('/api/gallery/upscale/start', json={
                    'source_path': 'source.png', 'engine': 'nai',
                    'target_width': 1280, 'target_height': 4096, 'nai_confirmed': True,
                })
            self.assertEqual(no_key.status_code, 400)
            jobs.submit.assert_not_called()

    def test_canvas_requires_confirmation_before_key_or_generation_and_uses_mocked_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            source_bytes = _png_bytes((640, 2048), (30, 60, 90, 255))
            service = UpscaleJobs(mock.Mock())

            def fake_engine(**kwargs):
                self.assertEqual(kwargs['engine'], 'nai')
                self.assertEqual((kwargs['target_width'], kwargs['target_height']), (1280, 4096))
                self.assertEqual(kwargs['nai_api_key'], 'synthetic-secret')
                Image.new('RGBA', (1280, 4096), (1, 2, 3, 255)).save(kwargs['target_path'], 'PNG')
                return {'engine': 'nai', 'final_width': 1280, 'final_height': 4096}

            client = app.app.test_client()
            with mock.patch.object(app, 'UPSCALE_SERVICE', service), \
                 mock.patch.object(app, 'read_canvas_image_bytes', return_value=source_bytes), \
                 mock.patch.object(app, 'get_upscale_nai_key', return_value='synthetic-secret') as key, \
                 mock.patch.object(app.upscale_logic, 'run_upscale', side_effect=fake_engine) as engine, \
                 mock.patch.object(nai_upscale, 'request_nai_upscale') as paid_request, \
                 mock.patch.object(app, 'save_canvas_generated_image', return_value=('/generated.png', 'generated.png')) as save:
                unconfirmed = client.post('/api/canvas/reference_upscale', json={
                    'image': 'synthetic-reference.png', 'engine': 'nai',
                    'target_width': 1280, 'target_height': 4096, 'nai_confirmed': False,
                })
                self.assertEqual(unconfirmed.status_code, 400)
                key.assert_not_called()
                engine.assert_not_called()
                save.assert_not_called()

                wrong_target = client.post('/api/canvas/reference_upscale', json={
                    'image': 'synthetic-reference.png', 'engine': 'nai',
                    'target_width': 640, 'target_height': 2048, 'nai_confirmed': True,
                })
                self.assertEqual(wrong_target.status_code, 400)
                key.assert_not_called()
                engine.assert_not_called()
                save.assert_not_called()

                accepted = client.post('/api/canvas/reference_upscale', json={
                    'image': 'synthetic-reference.png', 'engine': 'nai',
                    'target_width': 1280, 'target_height': 4096, 'nai_confirmed': True,
                })
                self.assertEqual(accepted.status_code, 200, accepted.json)
                self.assertEqual(accepted.json['engine'], 'nai')
                engine.assert_called_once()
                save.assert_called_once()
                paid_request.assert_not_called()
                self.assertNotIn('synthetic-secret', accepted.get_data(as_text=True))
            self.assertTrue(service.shutdown(timeout=2))


if __name__ == '__main__':
    unittest.main()
