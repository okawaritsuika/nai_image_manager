import hashlib
import io
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from flask import Flask
from PIL import Image

from naim.images import retouch as engine
from naim.web.canvas_retouch import register_canvas_retouch_routes


def layer(kind, **values):
    result = {
        'id': 'preview-' + kind,
        'type': kind,
        'visible': True,
        'opacity': 1,
        'mask': {'base': 1, 'strokes': []},
        'params': {},
        'strokes': [],
    }
    result.update(values)
    return result


def encode_png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class CanvasRetouchPreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp.name)
        y, x = np.mgrid[:1800, :200]
        pixels = np.stack(
            [x % 256, y % 256, (x * 3 + y * 5) % 256, np.full_like(x, 255)],
            axis=2,
        ).astype('uint8')
        pixels[:4, :, 3] = 0
        self.source = Image.fromarray(pixels, 'RGBA')
        self.source_bytes = encode_png(self.source)
        other = Image.new('RGBA', (90, 70), (20, 70, 110, 255))
        self.other_bytes = encode_png(other)
        other.close()
        self.inputs = {
            '/canvas-imports/original.png': self.source_bytes,
            '/image/other.png': self.other_bytes,
        }
        self.read_calls = []

        def read_source(source):
            self.read_calls.append(source)
            return self.inputs[source]

        def save_image(raw, prefix='canvas_import_retouch', category='retouch', session_id=None):
            path = self.output_dir / f'{prefix}-{len(list(self.output_dir.iterdir()))}.png'
            path.write_bytes(raw)
            return '/image/' + path.name, path.name

        app = Flask(__name__)
        app.testing = True
        self.controller = register_canvas_retouch_routes(app, read_source, save_image)
        self.client = app.test_client()
        self.body = {'source': '/canvas-imports/original.png', 'layers': []}

    def tearDown(self):
        self.controller.preview_cache.clear()
        self.source.close()
        self.temp.cleanup()

    def post(self, path, body):
        return self.client.post(path, json=body)

    @staticmethod
    def response_image(response):
        return Image.open(io.BytesIO(response.data))

    def test_preview_reuses_prepared_source_but_applies_latest_layers(self):
        first_layers = [layer('tone', params={'brightness': 5})]
        second_layers = [layer('tone', params={'brightness': 20})]
        with mock.patch.object(engine, 'render', wraps=engine.render) as render:
            first = self.post('/api/canvas/retouch/preview', {**self.body, 'layers': first_layers})
            second = self.post('/api/canvas/retouch/preview', {**self.body, 'layers': second_layers})
            self.assertEqual(render.call_count, 1)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        with self.response_image(first) as first_image, self.response_image(second) as second_image:
            self.assertEqual(first_image.size, (178, 1600))
            self.assertNotEqual(first_image.tobytes(), second_image.tobytes())
            np.testing.assert_array_equal(
                np.asarray(first_image)[..., 3], np.asarray(second_image)[..., 3],
            )

        prepared, source_size = self.controller.preview_cache.get(hashlib.sha256(self.source_bytes).digest())
        self.assertEqual(source_size, self.source.size)
        prepared_pixels = np.asarray(prepared).copy()
        expected = engine.render(
            io.BytesIO(self.source_bytes), {'layers': second_layers}, max_edge=1600,
        )
        try:
            with self.response_image(second) as actual:
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(prepared), prepared_pixels)
        finally:
            expected.close()

    def test_source_bytes_change_invalidates_and_closes_single_slot(self):
        self.assertEqual(self.post('/api/canvas/retouch/preview', self.body).status_code, 200)
        old_key = hashlib.sha256(self.source_bytes).digest()
        old_image, _ = self.controller.preview_cache.get(old_key)
        replacement = Image.new('RGBA', self.source.size, (90, 30, 150, 255))
        changed_bytes = encode_png(replacement)
        replacement.close()
        self.inputs['/canvas-imports/original.png'] = changed_bytes

        with mock.patch.object(engine, 'render', wraps=engine.render) as render:
            response = self.post('/api/canvas/retouch/preview', self.body)
            self.assertEqual(render.call_count, 1)
        self.assertEqual(response.status_code, 200)
        with self.assertRaises(ValueError):
            old_image.getpixel((0, 0))
        self.assertIsNone(self.controller.preview_cache.get(old_key))
        self.assertIsNotNone(self.controller.preview_cache.get(hashlib.sha256(changed_bytes).digest()))
        self.assertEqual(self.read_calls.count('/canvas-imports/original.png'), 2)

    def test_clone_preview_keeps_document_space_full_render_fallback(self):
        clone = layer('clone', strokes=[{
            'points': [[80, 900]], 'source': [20, 840], 'radius': 10,
            'hardness': 1, 'opacity': 1,
        }])
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [clone]}, max_edge=1600)
        try:
            with mock.patch.object(engine, 'render', wraps=engine.render) as render:
                response = self.post('/api/canvas/retouch/preview', {**self.body, 'layers': [clone]})
                self.assertEqual(render.call_count, 2)  # cache preparation and clone fallback
            self.assertEqual(response.status_code, 200)
            with self.response_image(response) as actual:
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
        finally:
            expected.close()

    def test_viewport_at_document_scale_matches_full_render_crop(self):
        layers = [
            layer('tone', params={'brightness': 12, 'contrast': 8}),
            layer('blur', params={'radius': 3}, mask={
                'base': 1, 'strokes': [],
                'shape': {'kind': 'ellipse', 'box': [35, 45, 125, 130]},
            }),
            layer('paint', strokes=[{
                'points': [[70, 95], [86, 102]], 'radius': 12, 'hardness': .6,
                'opacity': .9, 'color': '#e86a75',
            }]),
            layer('clone', strokes=[{
                'points': [[82, 105]], 'source': [32, 55], 'radius': 9,
                'hardness': .8, 'opacity': .75,
            }]),
        ]
        box = (42, 51, 92, 111)
        full = engine.render(io.BytesIO(self.source_bytes), {'layers': layers})
        expected = full.crop(box)
        full.close()
        response = self.post('/api/canvas/retouch/viewport', {
            **self.body, 'layers': layers,
            'region': {'x': box[0], 'y': box[1], 'width': box[2] - box[0], 'height': box[3] - box[1]},
            'scale': 1,
        })
        try:
            self.assertEqual(response.status_code, 200)
            with self.response_image(response) as actual:
                self.assertEqual(actual.size, expected.size)
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
        finally:
            expected.close()

    def test_scaled_viewport_dimensions_and_stroke_coordinates(self):
        paint = layer('paint', strokes=[{
            'points': [[40, 50]], 'radius': 8, 'hardness': 1,
            'opacity': 1, 'color': '#ff0000',
        }])
        response = self.post('/api/canvas/retouch/viewport', {
            **self.body, 'layers': [paint],
            'region': {'x': 20, 'y': 30, 'width': 61, 'height': 41}, 'scale': .5,
        })
        self.assertEqual(response.status_code, 200)
        with self.response_image(response) as actual:
            self.assertEqual(actual.size, (30, 20))
            np.testing.assert_array_equal(np.asarray(actual)[10, 10, :3], [255, 0, 0])

    def test_viewport_clamps_right_and_bottom_and_honors_original(self):
        payload = {
            **self.body,
            'layers': [layer('tone', params={'brightness': 40})],
            'region': {'x': 190, 'y': 1790, 'width': 100, 'height': 100},
            'scale': .5,
            'original': True,
        }
        response = self.post('/api/canvas/retouch/viewport', payload)
        context = self.source.crop((182, 1782, 200, 1800)).resize((9, 9), Image.Resampling.LANCZOS)
        expected_crop = context.crop((4, 4, 9, 9))
        context.close()
        try:
            self.assertEqual(response.status_code, 200)
            with self.response_image(response) as actual:
                self.assertEqual(actual.size, (5, 5))
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected_crop))
        finally:
            expected_crop.close()

    def test_viewport_rejects_invalid_and_oversized_geometry(self):
        valid = {
            **self.body,
            'region': {'x': 0, 'y': 0, 'width': 20, 'height': 20},
            'scale': 1,
        }
        invalid = [
            {**valid, 'region': {'x': True, 'y': 0, 'width': 20, 'height': 20}},
            {**valid, 'region': {'x': 0.5, 'y': 0, 'width': 20, 'height': 20}},
            {**valid, 'region': {'x': -1, 'y': 0, 'width': 20, 'height': 20}},
            {**valid, 'region': {'x': 100001, 'y': 0, 'width': 20, 'height': 20}},
            {**valid, 'region': {'x': 0, 'y': 0, 'width': 0, 'height': 20}},
            {**valid, 'scale': True},
            {**valid, 'scale': 0},
            {**valid, 'scale': 1.01},
            {**valid, 'scale': float('nan')},
            {**valid, 'region': {'x': 0, 'y': 0, 'width': 5000, 'height': 20}},
            {**valid, 'region': {'x': 0, 'y': 0, 'width': 4096, 'height': 1025}},
            {**valid, 'region': {'x': 200, 'y': 0, 'width': 1, 'height': 20}},
            {**valid, 'region': {'x': 0, 'y': 1800, 'width': 1, 'height': 20}},
            {**valid, 'original': 'true'},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                response = self.post('/api/canvas/retouch/viewport', payload)
                self.assertEqual(response.status_code, 400)

    def test_viewport_respects_render_lock_and_hides_internal_errors(self):
        valid = {
            **self.body,
            'region': {'x': 1, 'y': 1, 'width': 20, 'height': 20}, 'scale': 1,
        }
        for lock in (self.controller.apply_lock, self.controller.render_lock):
            lock.acquire()
            try:
                response = self.post('/api/canvas/retouch/viewport', valid)
            finally:
                lock.release()
            self.assertEqual(response.status_code, 409)
        self.assertEqual(self.read_calls, [])

        with mock.patch.object(engine, 'render', side_effect=RuntimeError('private implementation detail')):
            failure = self.post('/api/canvas/retouch/viewport', valid)
        self.assertEqual(failure.status_code, 500)
        self.assertEqual(failure.get_json()['message'], '확대 미리보기를 만들지 못했습니다.')
        self.assertNotIn('private implementation detail', failure.get_data(as_text=True))

    def test_full_resolution_apply_clears_prepared_preview(self):
        preview = self.post('/api/canvas/retouch/preview', self.body)
        self.assertEqual(preview.status_code, 200)
        key = hashlib.sha256(self.source_bytes).digest()
        self.assertIsNotNone(self.controller.preview_cache.get(key))

        response = self.post('/api/canvas/retouch/apply', self.body)
        self.assertEqual(response.status_code, 202)
        job_id = response.get_json()['job']['id']
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job_response = self.client.get('/api/canvas/retouch/jobs/' + job_id)
            job = job_response.get_json()['job']
            if job['status'] != 'running':
                break
            time.sleep(.01)
        self.assertEqual(job['status'], 'done')
        self.assertIsNone(self.controller.preview_cache.get(key))


if __name__ == '__main__':
    unittest.main()
