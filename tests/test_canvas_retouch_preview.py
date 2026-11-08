import hashlib
import io
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import numpy as np
from flask import Flask
from PIL import Image

from naim.images import retouch as engine
from naim.images import retouch_preview
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

    def test_working_copy_reuses_unchanged_layers_at_its_own_resolution(self):
        low = layer('tone', params={'brightness': 5})
        high = layer('color', params={'color': '#ff9465'}, mask={
            'base': 1, 'strokes': [], 'shape': {'kind': 'rect', 'box': [40, 500, 130, 1100]},
        })
        body = {**self.body, 'quick': True, 'layers': [low, high]}
        first = self.post('/api/canvas/retouch/preview', body)
        with self.response_image(first) as image:
            self.assertEqual(image.size, (89, 800))

        high['opacity'] = .5
        with mock.patch.object(engine, 'apply_adjustment', wraps=engine.apply_adjustment) as adjust:
            second = self.post('/api/canvas/retouch/preview', body)
            self.assertEqual([call.args[1]['id'] for call in adjust.call_args_list], [high['id']])
        self.assertEqual(second.status_code, 200)
        mask = self.post('/api/canvas/retouch/mask', {**body, 'layerId': high['id']})
        with self.response_image(second) as edited, self.response_image(mask) as coverage:
            self.assertEqual(edited.size, coverage.size)
            self.assertEqual(coverage.getpixel((0, 0)), 0)
            self.assertEqual(coverage.getpixel((40, 400)), 255)

        precise = self.post('/api/canvas/retouch/preview', {**body, 'quick': False})
        with self.response_image(precise) as actual, engine.render(
            io.BytesIO(self.source_bytes), {'layers': [low, high]}, max_edge=1600,
        ) as expected:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

        # Undoing the last layer must show the unchanged prefix exactly.
        undone = self.post('/api/canvas/retouch/preview', {**body, 'quick': False, 'layers': [low]})
        with self.response_image(undone) as actual, engine.render(
            io.BytesIO(self.source_bytes), {'layers': [low]}, max_edge=1600,
        ) as expected:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

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

    def test_viewport_reuses_exact_prepared_context_for_layer_edits(self):
        box = (12, 0, 92, 96)
        engine_region = (box[0], box[1], box[2] - box[0], box[3] - box[1])
        region = {'x': box[0], 'y': box[1], 'width': box[2] - box[0], 'height': box[3] - box[1]}
        first_layers = [layer('tone', params={'brightness': 4, 'saturation': 15})]
        edited_layers = [layer('tone', params={'brightness': 23, 'saturation': 72}, opacity=.65)]
        payload = {**self.body, 'region': region, 'scale': 1}

        with mock.patch.object(engine, 'normalize_image', wraps=engine.normalize_image) as normalize:
            first = self.post('/api/canvas/retouch/viewport', {**payload, 'layers': first_layers})
            edited = self.post('/api/canvas/retouch/viewport', {**payload, 'layers': edited_layers})
            self.assertEqual(normalize.call_count, 1)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(edited.status_code, 200)

        with engine.render(
            io.BytesIO(self.source_bytes), {'layers': edited_layers}, region=engine_region, region_scale=1,
        ) as expected, self.response_image(edited) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(actual)[..., 3], np.asarray(expected)[..., 3])

        # Geometry, display scale, filter halo, and source digest each select a new context.
        requests = [
            ({'x': 13, 'y': 0, 'width': 80, 'height': 96}, 1,
             [layer('tone', params={'brightness': 23, 'saturation': 72}, opacity=.65)]),
            (region, .5, edited_layers),
            (region, 1, [layer('blur', params={'radius': 4})]),
        ]
        invalidated_responses = []
        with mock.patch.object(engine, 'normalize_image', wraps=engine.normalize_image) as normalize:
            for request_region, scale, layers in requests:
                response = self.post('/api/canvas/retouch/viewport', {
                    **self.body, 'layers': layers, 'region': request_region, 'scale': scale,
                })
                self.assertEqual(response.status_code, 200)
                invalidated_responses.append(response)
            self.assertEqual(normalize.call_count, len(requests))

        for response, (request_region, scale, layers) in zip(invalidated_responses, requests):
            requested_region = (
                request_region['x'], request_region['y'],
                request_region['width'], request_region['height'],
            )
            with engine.render(
                io.BytesIO(self.source_bytes), {'layers': layers},
                region=requested_region, region_scale=scale,
            ) as expected, self.response_image(response) as actual:
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

        replacement = Image.new('RGBA', self.source.size, (35, 110, 185, 137))
        changed_bytes = encode_png(replacement)
        replacement.close()
        self.inputs['/canvas-imports/original.png'] = changed_bytes
        with mock.patch.object(engine, 'normalize_image', wraps=engine.normalize_image) as normalize:
            response = self.post('/api/canvas/retouch/viewport', {
                **self.body, 'layers': edited_layers, 'region': region, 'scale': 1,
            })
            self.assertEqual(normalize.call_count, 1)
        self.assertEqual(response.status_code, 200)
        with engine.render(
            io.BytesIO(changed_bytes), {'layers': edited_layers}, region=engine_region, region_scale=1,
        ) as expected, self.response_image(response) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

    def test_native_viewport_edits_before_display_downsampling(self):
        layers = [
            layer('tone', params={'saturation': 84, 'contrast': 15}),
            layer('blur', params={'radius': 4}),
        ]
        box = (27, 280, 127, 380)
        payload = {
            **self.body, 'layers': layers,
            'region': {'x': box[0], 'y': box[1], 'width': box[2] - box[0], 'height': box[3] - box[1]},
            'scale': .5, 'native': True,
        }
        response = self.post('/api/canvas/retouch/viewport', payload)
        self.assertEqual(response.status_code, 200)
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as full:
            native_crop = full.crop(box)
        try:
            expected = native_crop.resize((50, 50), Image.Resampling.LANCZOS)
            with expected, self.response_image(response) as actual:
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                self.assertEqual(actual.size, (50, 50))
        finally:
            native_crop.close()

        native_exact = self.post('/api/canvas/retouch/viewport', {
            **payload, 'scale': 1,
        })
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as full:
            expected = full.crop(box)
        with expected, self.response_image(native_exact) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

    def test_native_viewport_reuses_decoded_source_across_shifted_clone_crops(self):
        layers = [
            layer('tone', params={'brightness': 13, 'saturation': 12}),
            layer('clone', strokes=[{
                'points': [[75, 886], [91, 895]], 'source': [24, 830],
                'radius': 11, 'hardness': .8, 'opacity': .7,
            }]),
        ]
        regions = [
            {'x': 42, 'y': 850, 'width': 78, 'height': 98},
            {'x': 63, 'y': 874, 'width': 75, 'height': 98},
        ]
        expected_images = [
            engine.render(
                io.BytesIO(self.source_bytes), {'layers': layers},
                region=(region['x'], region['y'], region['width'], region['height']),
                region_scale=1,
            )
            for region in regions
        ]

        with mock.patch.object(engine, 'normalize_image', wraps=engine.normalize_image) as normalize:
            responses = [self.post('/api/canvas/retouch/viewport', {
                **self.body, 'layers': layers, 'native': True,
                'region': region, 'scale': 1,
            }) for region in regions]
            self.assertEqual(normalize.call_count, 1)

        key = hashlib.sha256(self.source_bytes).digest()
        native_source = self.controller.preview_cache.get_native_source(key)
        self.assertIsNotNone(native_source)
        np.testing.assert_array_equal(np.asarray(native_source), np.asarray(self.source))
        for response, expected in zip(responses, expected_images):
            self.assertEqual(response.status_code, 200)
            with expected, self.response_image(response) as actual:
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

        with mock.patch.object(engine, '_apply_layers', side_effect=RuntimeError('synthetic render failure')):
            failed = self.post('/api/canvas/retouch/viewport', {
                **self.body, 'layers': layers, 'native': True,
                'region': {'x': 83, 'y': 882, 'width': 72, 'height': 92}, 'scale': 1,
            })
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(native_source.getpixel((0, 0)), self.source.getpixel((0, 0)))

    def test_non_native_viewport_retains_legacy_source_decoding_path(self):
        layers = [layer('tone', params={'brightness': 11})]
        regions = [
            {'x': 18, 'y': 80, 'width': 60, 'height': 70},
            {'x': 44, 'y': 108, 'width': 60, 'height': 70},
        ]
        with mock.patch.object(engine, 'normalize_image', wraps=engine.normalize_image) as normalize:
            for region in regions:
                response = self.post('/api/canvas/retouch/viewport', {
                    **self.body, 'layers': layers, 'region': region, 'scale': 1,
                })
                self.assertEqual(response.status_code, 200)
            self.assertEqual(normalize.call_count, 2)
        key = hashlib.sha256(self.source_bytes).digest()
        self.assertIsNone(self.controller.preview_cache.get_native_source(key))

    def test_native_source_cache_invalidates_on_source_change_and_clear(self):
        region = {'x': 12, 'y': 200, 'width': 32, 'height': 40}
        payload = {**self.body, 'native': True, 'region': region, 'scale': 1}
        first = self.post('/api/canvas/retouch/viewport', payload)
        self.assertEqual(first.status_code, 200)
        old_key = hashlib.sha256(self.source_bytes).digest()
        old_source = self.controller.preview_cache.get_native_source(old_key)
        self.assertIsNotNone(old_source)

        replacement = Image.new('RGBA', self.source.size, (35, 110, 185, 137))
        changed_bytes = encode_png(replacement)
        replacement.close()
        self.inputs['/canvas-imports/original.png'] = changed_bytes
        changed = self.post('/api/canvas/retouch/viewport', payload)
        self.assertEqual(changed.status_code, 200)
        with self.assertRaises(ValueError):
            old_source.getpixel((0, 0))

        new_key = hashlib.sha256(changed_bytes).digest()
        new_source = self.controller.preview_cache.get_native_source(new_key)
        self.assertIsNotNone(new_source)
        cached_layers = [layer('tone', params={'brightness': 8})]
        display = Image.new('RGBA', (20, 180), (40, 80, 120, 255))
        corrected = Image.new('RGBA', self.source.size, (80, 120, 160, 255))
        self.controller.preview_cache.store_native_preview(
            new_key, cached_layers, 180, display, corrected,
        )
        self.assertIsNone(self.controller.preview_cache.get_native_source(new_key))
        with self.assertRaises(ValueError):
            new_source.getpixel((0, 0))
        self.assertIs(self.controller.preview_cache.get_native_result(new_key, cached_layers), corrected)
        self.controller.preview_cache.clear()
        with self.assertRaises(ValueError):
            corrected.getpixel((0, 0))

    def test_native_viewport_reuses_exact_layer_prefix_and_invalidates_changed_region(self):
        region = {'x': 24, 'y': 260, 'width': 76, 'height': 100}
        layers = [
            layer('tone', id='base-tone', params={'vibrance': 25, 'shadows': 10, 'saturation': 10}),
            layer('texture', id='texture', params={'scale': 40, 'decay': .4, 'octaves': 3}),
            layer('blur', id='blur', params={'radius': 3}),
            layer('tone', id='last-tone', params={'brightness': 0}),
        ]
        edited_layers = [*layers[:-1], layer('tone', id='last-tone', params={'brightness': 16})]
        payload = {**self.body, 'region': region, 'scale': 1, 'native': True}
        warm = self.post('/api/canvas/retouch/viewport', {**payload, 'layers': layers})
        self.assertEqual(warm.status_code, 200)

        with mock.patch.object(engine, 'apply_adjustment', wraps=engine.apply_adjustment) as adjust:
            edited = self.post('/api/canvas/retouch/viewport', {**payload, 'layers': edited_layers})
            self.assertEqual(
                [call.args[1]['id'] for call in adjust.call_args_list], ['last-tone'],
            )
        self.assertEqual(edited.status_code, 200)
        with engine.render(
            io.BytesIO(self.source_bytes), {'layers': edited_layers},
            region=(region['x'], region['y'], region['width'], region['height']), region_scale=1,
        ) as expected, self.response_image(edited) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

        shifted_region = {**region, 'x': region['x'] + 1}
        with mock.patch.object(engine, 'apply_adjustment', wraps=engine.apply_adjustment) as adjust:
            shifted = self.post('/api/canvas/retouch/viewport', {
                **payload, 'region': shifted_region, 'layers': edited_layers,
            })
            self.assertEqual(
                [call.args[1]['id'] for call in adjust.call_args_list],
                ['base-tone', 'texture', 'blur', 'last-tone'],
            )
        self.assertEqual(shifted.status_code, 200)
        with engine.render(
            io.BytesIO(self.source_bytes), {'layers': edited_layers},
            region=(shifted_region['x'], shifted_region['y'], shifted_region['width'], shifted_region['height']),
            region_scale=1,
        ) as expected, self.response_image(shifted) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

    def test_native_preview_projects_only_after_full_resolution_effects_and_caches_fit(self):
        layers = [
            layer('tone', params={'saturation': 80, 'brightness': 7}),
            layer('blur', params={'radius': 5}),
            layer('clone', strokes=[{
                'points': [[82, 905]], 'source': [26, 846], 'radius': 8,
                'hardness': .8, 'opacity': .75,
            }]),
        ]
        payload = {**self.body, 'layers': layers, 'native': True}
        with mock.patch.object(engine, 'render', wraps=engine.render) as render:
            response = self.post('/api/canvas/retouch/preview', payload)
            cached_response = self.post('/api/canvas/retouch/preview', payload)
            self.assertEqual(render.call_count, 1)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(cached_response.status_code, 200)

        scale = 1600 / max(self.source.size)
        display_size = tuple(max(1, round(length * scale)) for length in self.source.size)
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as full:
            expected = full.resize(display_size, Image.Resampling.LANCZOS)
        with expected, self.response_image(response) as actual, self.response_image(cached_response) as cached:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(cached), np.asarray(expected))

        scaled_effects = engine.render(
            io.BytesIO(self.source_bytes), {'layers': layers}, max_edge=1600,
        )
        try:
            with self.response_image(response) as actual:
                self.assertFalse(np.array_equal(np.asarray(actual), np.asarray(scaled_effects)))
        finally:
            scaled_effects.close()

    def test_native_custom_edge_projects_and_reprojects_full_liquify(self):
        layers = [layer('liquify', strokes=[{
            'points': [[68, 895], [112, 917]], 'radius': 31, 'strength': .8,
        }])]
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as full:
            first_size = (45, 407)
            second_size = (31, 281)
            first_expected = full.resize(first_size, Image.Resampling.LANCZOS)
            second_expected = full.resize(second_size, Image.Resampling.LANCZOS)

        with (
            first_expected,
            second_expected,
            mock.patch.object(engine, 'render', wraps=engine.render) as render,
        ):
            first = self.post('/api/canvas/retouch/preview', {
                **self.body, 'layers': layers, 'native': True, 'displayEdge': 407,
            })
            second = self.post('/api/canvas/retouch/preview', {
                **self.body, 'layers': layers, 'native': True, 'displayEdge': 281,
            })
            self.assertEqual(render.call_count, 1)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        with self.response_image(first) as actual, self.response_image(second) as reprojected:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(first_expected))
            np.testing.assert_array_equal(np.asarray(reprojected), np.asarray(second_expected))

    def test_native_custom_edge_sizes_original_and_mask_together(self):
        original = self.post('/api/canvas/retouch/preview', {
            **self.body, 'native': True, 'displayEdge': 513,
        })
        self.assertEqual(original.status_code, 200)
        with self.response_image(original) as actual:
            self.assertEqual(actual.size, (57, 513))

        masked_layer = layer('tone', params={'brightness': 18}, mask={
            'base': 0, 'strokes': [], 'shape': {'kind': 'rect', 'box': [20, 120, 160, 1500]},
        })
        body = {
            **self.body, 'layers': [masked_layer], 'native': True, 'displayEdge': 347,
        }
        preview = self.post('/api/canvas/retouch/preview', body)
        mask = self.post('/api/canvas/retouch/mask', {**body, 'layerId': masked_layer['id']})
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(mask.status_code, 200)
        with self.response_image(preview) as shown, self.response_image(mask) as coverage:
            self.assertEqual(shown.size, (39, 347))
            self.assertEqual(coverage.size, shown.size)

    def test_native_display_edge_rejects_non_integer_and_out_of_range_values(self):
        for display_edge in (True, False, 0, 1601, 1.5, '400', None):
            with self.subTest(display_edge=display_edge):
                response = self.post('/api/canvas/retouch/preview', {
                    **self.body, 'native': True, 'displayEdge': display_edge,
                })
                self.assertEqual(response.status_code, 400)

    def test_native_viewport_reuses_cached_full_result_for_exact_crop(self):
        layers = [layer('liquify', strokes=[{
            'points': [[65, 880], [105, 904]], 'radius': 29, 'strength': .75,
        }])]
        region = {'x': 42, 'y': 850, 'width': 73, 'height': 116}
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as full:
            expected = full.crop((42, 850, 115, 966))

        with expected, mock.patch.object(engine, 'render', wraps=engine.render) as render:
            preview = self.post('/api/canvas/retouch/preview', {
                **self.body, 'layers': layers, 'native': True, 'displayEdge': 421,
            })
            viewport = self.post('/api/canvas/retouch/viewport', {
                **self.body, 'layers': layers, 'native': True,
                'region': region, 'scale': 1,
            })
            self.assertEqual(render.call_count, 1)

        self.assertEqual(preview.status_code, 200)
        self.assertEqual(viewport.status_code, 200)
        with self.response_image(viewport) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

    def test_native_flags_must_be_boolean(self):
        preview = self.post('/api/canvas/retouch/preview', {**self.body, 'native': 'true'})
        viewport = self.post('/api/canvas/retouch/viewport', {
            **self.body, 'native': 1, 'region': {'x': 0, 'y': 0, 'width': 20, 'height': 20}, 'scale': 1,
        })
        self.assertEqual(preview.status_code, 400)
        self.assertEqual(viewport.status_code, 400)

    def test_parallel_display_projection_matches_lanczos_with_transparency(self):
        pixels = np.random.default_rng(423).integers(0, 256, (100, 119, 4), dtype=np.uint8)
        with Image.fromarray(pixels) as source:
            for size, expected_workers in (((37, 25), 1), ((37, 26), 0)):
                with (
                    self.subTest(size=size),
                    mock.patch.object(retouch_preview, '_PARALLEL_PROJECTION_PIXELS', 1),
                    mock.patch.object(retouch_preview, 'cpu_count', return_value=4),
                    mock.patch.object(retouch_preview, 'ThreadPoolExecutor', wraps=ThreadPoolExecutor) as pool,
                ):
                    expected = source.resize(size, Image.Resampling.LANCZOS)
                    actual = retouch_preview.project_native_preview(source, size)
                    with expected, actual:
                        np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                    self.assertEqual(pool.call_count, expected_workers)

    def test_native_fit_applies_the_already_rendered_source_size_image(self):
        layers = [layer('blur', params={'radius': 3})]
        body = {**self.body, 'layers': layers, 'native': True}
        response = self.post('/api/canvas/retouch/preview', body)
        self.assertEqual(response.status_code, 200)
        with self.response_image(response) as shown:
            self.assertEqual(shown.size, (178, 1600))

        with mock.patch.object(engine, 'render', side_effect=AssertionError('native result is already complete')):
            job = self.wait_for_apply(self.post('/api/canvas/retouch/apply', body))
        path = self.output_dir / job['result']['src'].rsplit('/', 1)[1]
        with Image.open(path) as saved, engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as expected:
            self.assertEqual(saved.size, self.source.size)
            np.testing.assert_array_equal(np.asarray(saved), np.asarray(expected))

    def test_apply_takes_priority_over_an_in_progress_native_fit(self):
        entered = threading.Event()
        original_render = engine.render

        def wait_for_apply(*args, **kwargs):
            if threading.current_thread().name != 'canvas-retouch-render':
                entered.set()
                deadline = time.monotonic() + 2
                while not self.controller.apply_lock.locked() and time.monotonic() < deadline:
                    time.sleep(.005)
                kwargs['progress'](0, 'synthetic tone')
            return original_render(*args, **kwargs)

        def post_native_fit():
            with self.client.application.test_client() as client:
                return client.post('/api/canvas/retouch/preview', json={
                    **self.body, 'layers': [layer('tone', params={'brightness': 8})], 'native': True,
                }).status_code

        with ThreadPoolExecutor(max_workers=1) as executor, mock.patch.object(engine, 'render', side_effect=wait_for_apply):
            response = executor.submit(post_native_fit)
            self.assertTrue(entered.wait(2))
            job = self.wait_for_apply(self.post('/api/canvas/retouch/apply', self.body))
            self.assertEqual(response.result(timeout=2), 409)
        self.assertFalse(self.controller.native_preview_running.is_set())
        self.assertEqual((job['result']['width'], job['result']['height']), self.source.size)

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
            {**valid, 'native': 'true'},
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
        preview = self.post('/api/canvas/retouch/preview', {**self.body, 'quick': True})
        self.assertEqual(preview.status_code, 200)
        key = hashlib.sha256(self.source_bytes).digest()
        self.assertIsNotNone(self.controller.preview_cache.get(key))

        response = self.post('/api/canvas/retouch/apply', self.body)
        job = self.wait_for_apply(response)
        self.assertEqual((job['result']['width'], job['result']['height']), self.source.size)
        self.assertIsNone(self.controller.preview_cache.get(key))

    def test_apply_reuses_exact_working_result_and_writes_print_metadata(self):
        body = {'source': '/image/other.png', 'quick': True,
                'layers': [layer('tone', params={'brightness': 15})]}
        preview = self.post('/api/canvas/retouch/preview', body)
        with mock.patch.object(engine, 'render', side_effect=AssertionError('exact pixels already cached')):
            job = self.wait_for_apply(self.post('/api/canvas/retouch/apply', {
                **body, 'print': {'widthCm': 9},
            }))
        path = self.output_dir / job['result']['src'].rsplit('/', 1)[1]
        with Image.open(path) as saved, self.response_image(preview) as working:
            self.assertEqual(saved.tobytes(), working.tobytes())
            self.assertEqual(saved.info['icc_profile'], engine.SRGB)
            self.assertAlmostEqual(saved.info['dpi'][0], 25.4, places=1)

    def wait_for_apply(self, response):
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
        return job


if __name__ == '__main__':
    unittest.main()
