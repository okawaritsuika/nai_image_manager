import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import numpy as np
from flask import Flask
from PIL import Image

from naim.images import retouch as engine
from naim.images.retouch_working import WorkingImage
from naim.web.canvas_retouch import register_canvas_retouch_routes


def make_layer(kind, layer_id='working-layer', **values):
    layer = {
        'id': layer_id,
        'type': kind,
        'name': kind,
        'visible': True,
        'opacity': 1,
        'mask': {'base': 1, 'strokes': []},
        'params': {},
        'strokes': [],
    }
    layer.update(values)
    return layer


def encode_png(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class CanvasRetouchWorkingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp.name)
        y, x = np.mgrid[:88, :120]
        pixels = np.stack(
            [x * 2 % 256, y * 3 % 256, (x * 7 + y * 11) % 256,
             (x * 5 + y * 3) % 256],
            axis=2,
        ).astype('uint8')
        pixels[:5, :, 3] = 0
        self.source = Image.fromarray(pixels, 'RGBA')
        self.source_bytes = encode_png(self.source)
        self.inputs = {'/canvas-imports/source.png': self.source_bytes}

        def read_source(source):
            return self.inputs[source]

        def save_image(raw, prefix='canvas_import_retouch', category='retouch', session_id=None):
            path = self.output_dir / f'{prefix}-{len(list(self.output_dir.iterdir()))}.png'
            path.write_bytes(raw)
            return '/image/' + path.name, path.name

        app = Flask(__name__)
        app.testing = True
        self.controller = register_canvas_retouch_routes(app, read_source, save_image)
        self.client = app.test_client()
        self.base = {
            'source': '/canvas-imports/source.png',
            'workingId': 'working_test_1',
            'baseRevision': 0,
            'layers': [],
        }

    def tearDown(self):
        if self.controller.working_image is not None:
            self.controller.working_image.close()
        self.controller.preview_cache.clear()
        self.source.close()
        self.temp.cleanup()

    def post(self, path, body):
        return self.client.post(path, json=body)

    def test_masked_parameter_change_returns_only_changed_pixels_and_undo_restores_them(self):
        base = make_layer('tone', 'bounded', params={'brightness': 4}, mask={
            'base': 1, 'shape': {'kind': 'ellipse', 'box': [21.5, 15.5, 75.5, 62.5]}})
        next_layer = {**base, 'params': {'brightness': 24}}
        blur = make_layer('blur', 'later', params={'radius': 3.5})
        working = WorkingImage('bounded', None, self.source.copy())
        try:
            working.update(engine, [base, blur], 0)
            before = working.current.copy()
            with self.assertRaises(StopIteration) as completed:
                next(working.iter_update(engine, [next_layer, blur], 1))
            patch, dirty, revision, borrowed = completed.exception.value
            self.assertEqual(revision, 2)
            self.assertFalse(borrowed)
            with before, patch, engine.render(
                    None, {'layers': [next_layer, blur]}, region=(0, 0, *self.source.size),
                    region_scale=1, prepared_source=self.source) as expected:
                from PIL import ImageChops
                with ImageChops.difference(before, expected) as difference:
                    self.assertEqual(dirty, difference.getbbox(alpha_only=False))
                reconstructed = before.copy()
                with reconstructed:
                    reconstructed.paste(patch, dirty[:2])
                    np.testing.assert_array_equal(reconstructed, expected)
                undo, undo_box, _, _ = working.update(engine, [base, blur], revision)
                with undo:
                    self.assertEqual(undo_box, dirty)
                    np.testing.assert_array_equal(working.current, before)
        finally:
            working.close()

    def test_cancelling_chunked_filter_preserves_confirmed_pixels_and_revision(self):
        with Image.new('RGBA', (1537, 801), (53, 108, 200, 143)) as source:
            working = WorkingImage('cancel', None, source.copy())
            try:
                tone = make_layer('tone', 'tone', params={'brightness': 15})
                working.update(engine, [tone], 0)
                before = working.current
                blur = make_layer('blur', 'blur', params={'radius': 20})
                update = working.iter_update(engine, [tone, blur], 1)
                next(update)
                update.close()
                self.assertIs(working.current, before)
                self.assertEqual(working.layers, [tone])
                self.assertEqual(working.revision, 1)
            finally:
                working.close()

    def test_stroke_supersedes_full_filter_and_reuses_exact_viewport_prefix(self):
        rng = np.random.default_rng(23)
        with Image.fromarray(rng.integers(0, 256, (801, 1037, 4), dtype=np.uint8)) as source:
            working = WorkingImage('concurrent', None, source.copy(), checkpoint_pixels=0)
            try:
                blur = make_layer('blur', 'blur', params={'radius': 12.5})
                update = working.iter_update(engine, [blur], 0)
                next(update)
                update.close()
                self.assertEqual(working.revision, 0)
                stroke = {'points': [[259.4, 244.8]], 'radius': 62, 'hardness': .42, 'opacity': .91,
                          'color': '#f48c25'}
                paint = make_layer('paint', 'paint', strokes=[stroke])
                latest = [blur, paint]
                with working.viewport_update(engine, latest, (192, 172, 330, 322)) as preview:
                    cached = working._viewport_checkpoint[1]
                    moved = [blur, {**paint, 'strokes': [{**stroke, 'points': [[260.2, 244.8]]}]}]
                    with working.viewport_update(engine, moved, (193, 173, 331, 323)):
                        self.assertIs(cached, working._viewport_checkpoint[1])
                    for _ in working.iter_update(engine, latest, 0):
                        pass
                    with working.current.crop((192, 172, 330, 322)) as confirmed:
                        self.assertEqual(preview.tobytes(), confirmed.tobytes())
                with engine.render(None, {'layers': latest}, region=(0, 0, *source.size),
                                   region_scale=1, prepared_source=source) as expected:
                    self.assertEqual(working.current.tobytes(), expected.tobytes())
                for layers in ([blur], latest):
                    for _ in working.iter_update(engine, layers, working.revision):
                        pass
                    with engine.render(None, {'layers': layers}, region=(0, 0, *source.size),
                                       region_scale=1, prepared_source=source) as expected:
                        self.assertEqual(working.current.tobytes(), expected.tobytes())
            finally:
                working.close()

    def test_masked_liquify_tail_is_exact_and_keeps_working_image_sparse(self):
        pixels = np.random.default_rng(63).integers(0, 256, (988, 1185, 4), dtype=np.uint8)
        with Image.fromarray(pixels) as source:
            for mode in ('push', 'expand', 'shrink', 'clockwise', 'counterclockwise'):
                working = WorkingImage(mode, None, source.copy())
                try:
                    mask = {'base': 1, 'strokes': [{'points': [[816.8, 742.3]], 'radius': 17,
                                                  'hardness': .3, 'opacity': .83, 'erase': True}]}
                    stroke = {'points': [[804.8, 730.6], [812.1, 737.4]],
                              'radius': 28, 'strength': .7, 'mode': mode}
                    warp = make_layer('liquify', mode, strokes=[stroke], mask=mask, opacity=.87)
                    patch, _, revision, _ = working.update(engine, [warp], 0)
                    patch.close()
                    points = [*stroke['points'], [828.4, 748.2], [830.1, 756.3]]
                    warp = {**warp, 'strokes': [{**stroke, 'points': points}]}
                    patch, dirty, _, _ = working.update(engine, [warp], revision)
                    patch.close()
                    self.assertLess(dirty[2] - dirty[0], 100)
                    self.assertIsNone(working.result)
                    with source.copy() as expected:
                        engine.apply_liquify(expected, warp, 1, (0, 0))
                        np.testing.assert_array_equal(working.current, expected)
                finally:
                    working.close()

    def test_chunked_lower_layer_update_keeps_alpha_and_neighborhood_edges(self):
        pixels = np.random.default_rng(47).integers(0, 256, (802, 1555, 4), dtype=np.uint8)
        with Image.fromarray(pixels) as source:
            working = WorkingImage('edges', None, source.copy(), checkpoint_pixels=0)
            try:
                tone = make_layer('tone', 'tone', params={'brightness': 15, 'vibrance': 26})
                blur = make_layer('blur', 'blur', params={'radius': 17, 'mode': 'multiply'}, opacity=.62)
                sharp = make_layer('sharpen', 'sharp', params={'radius': 8, 'amount': 96, 'threshold': 3})
                stack = [tone, blur, sharp]
                working.update(engine, stack, 0)
                updated = [{**tone, 'params': {'brightness': -22, 'saturation': 31}}, blur, sharp]
                task = working.iter_update(engine, updated, 1)
                for _ in task:
                    pass
                with engine.render(None, {'layers': updated}, region=(0, 0, *source.size),
                                    region_scale=1, prepared_source=source) as expected:
                    np.testing.assert_array_equal(working.current, expected)
                self.assertEqual(working.revision, 2)
            finally:
                working.close()

    def test_fused_tone_prefix_and_blur_match_separate_filters(self):
        pixels = np.random.default_rng(29).integers(0, 256, (798, 1041, 4), dtype=np.uint8)
        with Image.fromarray(pixels) as source:
            working = WorkingImage('tone-prefix', None, source.copy(), checkpoint_pixels=0)
            layers = [
                make_layer('tone', 'first-tone', params={'brightness': 19, 'contrast': -33}),
                make_layer('tone', 'second-tone', params={'brightness': -9, 'contrast': 47}),
                make_layer('blur', 'blur', params={'radius': 21, 'mode': 'screen'}, opacity=.62),
            ]
            try:
                for _ in working.iter_update(engine, layers, 0):
                    pass
                with engine.render(None, {'layers': layers}, region=(0, 0, *source.size),
                                   region_scale=1, prepared_source=source) as expected:
                    np.testing.assert_array_equal(working.current, expected)
            finally:
                working.close()

    @staticmethod
    def response_image(response):
        return Image.open(io.BytesIO(response.data)).copy()

    def assert_patch_matches(self, response, expected, previous=None):
        self.assertEqual(response.status_code, 200)
        x = int(response.headers['X-Retouch-X'])
        y = int(response.headers['X-Retouch-Y'])
        width = int(response.headers['X-Retouch-Width'])
        height = int(response.headers['X-Retouch-Height'])
        with self.response_image(response) as patch:
            self.assertEqual(patch.size, (width, height))
            if previous is not None:
                previous.paste(patch, (x, y))
                np.testing.assert_array_equal(np.asarray(previous), np.asarray(expected))
            else:
                np.testing.assert_array_equal(np.asarray(patch), np.asarray(expected))
        return (x, y, x + width, y + height)

    def assert_direct_patch(self, response, expected, previous):
        image, box, _revision, borrowed = response
        self.assertIsNotNone(image)
        self.assertFalse(borrowed)
        try:
            with expected.crop(box) as expected_region:
                np.testing.assert_array_equal(np.asarray(image), np.asarray(expected_region))
            previous.paste(image, box[:2])
            np.testing.assert_array_equal(np.asarray(previous), np.asarray(expected))
        finally:
            image.close()

    def test_first_local_paint_clone_and_masked_adjustment_keep_source_sparse(self):
        layers = [
            make_layer('paint', strokes=[{
                'points': [[1, 2], [13, 7]], 'radius': 7, 'hardness': .35,
                'opacity': .9, 'color': '#ef174b',
            }]),
            make_layer('clone', layer_id='clone-layer', strokes=[{
                'points': [[49, 44], [56, 47]], 'source': [78, 44],
                'radius': 6, 'hardness': .7, 'opacity': .8,
            }]),
            make_layer('tone', layer_id='masked-tone', params={'brightness': 24}, mask={
                'base': 0,
                'strokes': [{
                    'points': [[62, 42], [70, 46]], 'radius': 9,
                    'hardness': .6, 'opacity': .8,
                }],
            }),
        ]
        for layer in layers:
            with self.subTest(kind=layer['type']):
                working = WorkingImage('direct', 'source', self.source.copy())
                expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
                previous = self.source.copy()
                try:
                    with mock.patch.object(
                        working.original, 'copy', side_effect=AssertionError('full source copied'),
                    ):
                        response = working.update(engine, [layer], 0)
                    self.assert_direct_patch(response, expected, previous)
                    self.assertIsNone(working.result)
                    self.assertTrue(working._sparse_tiles)
                finally:
                    expected.close()
                    previous.close()
                    working.close()

    def test_sparse_local_mask_edit_and_transition_undo_redo_need_no_full_copy(self):
        stroke = {
            'points': [[42, 39], [51, 42]], 'radius': 10,
            'hardness': .5, 'opacity': .8, 'color': '#fa1835',
        }
        painted = make_layer('paint', strokes=[stroke])
        masked = make_layer('paint', strokes=[stroke], mask={
            'base': 1,
            'strokes': [{
                'points': [[48, 42]], 'radius': 8, 'hardness': 1,
                'opacity': .9, 'erase': True,
            }],
        })
        expected_painted = engine.render(io.BytesIO(self.source_bytes), {'layers': [painted]})
        expected_masked = engine.render(io.BytesIO(self.source_bytes), {'layers': [masked]})
        cumulative = self.source.copy()
        working = WorkingImage('direct', 'source', self.source.copy())
        try:
            with mock.patch.object(
                working.original, 'copy', side_effect=AssertionError('full source copied'),
            ):
                first = working.update(engine, [painted], 0)
                self.assert_direct_patch(first, expected_painted, cumulative)
                second = working.update(engine, [masked], 1)
                self.assert_direct_patch(second, expected_masked, cumulative)
                undo = working.update(engine, [painted], 2)
                self.assert_direct_patch(undo, expected_painted, cumulative)
                redo = working.update(engine, [masked], 3)
                self.assert_direct_patch(redo, expected_masked, cumulative)
            self.assertIsNone(working.result)
            self.assertTrue(working._sparse_tiles)
        finally:
            expected_painted.close()
            expected_masked.close()
            cumulative.close()
            working.close()

    def test_sparse_cap_promotes_atomically_when_new_tile_would_cross_limit(self):
        source = Image.new('RGBA', (600, 600), (38, 95, 172, 213))
        source_bytes = encode_png(source)
        first_stroke = {
            'points': [[42, 42]], 'radius': 8, 'hardness': .5,
            'opacity': .8, 'color': '#fa1835',
        }
        second_stroke = {
            'points': [[560, 560]], 'radius': 8, 'hardness': .5,
            'opacity': .8, 'color': '#18c4fa',
        }
        first_layer = make_layer('paint', strokes=[first_stroke])
        both_layer = make_layer('paint', strokes=[first_stroke, second_stroke])
        expected_first = engine.render(io.BytesIO(source_bytes), {'layers': [first_layer]})
        expected_both = engine.render(io.BytesIO(source_bytes), {'layers': [both_layer]})
        working = WorkingImage('direct', 'source', source.copy())
        cumulative = source.copy()
        try:
            first = working.update(engine, [first_layer], 0)
            self.assert_direct_patch(first, expected_first, cumulative)
            self.assertIsNone(working.result)
            one_tile_bytes = working._sparse_bytes
            self.assertEqual(len(working._sparse_tiles), 1)

            with mock.patch('naim.images.retouch_working.MAX_SPARSE_BYTES', one_tile_bytes):
                with mock.patch.object(
                    working.original, 'copy', side_effect=AssertionError('synthetic promotion failure'),
                ):
                    with self.assertRaisesRegex(AssertionError, 'synthetic promotion failure'):
                        working.update(engine, [both_layer], 1)
                self.assertEqual(working.revision, 1)
                self.assertEqual(working.layers, [first_layer])
                self.assertIsNone(working.result)
                self.assertEqual(working._sparse_bytes, one_tile_bytes)
                self.assertEqual(len(working._sparse_tiles), 1)
                with working._crop_region((0, 0, 600, 600)) as current:
                    np.testing.assert_array_equal(np.asarray(current), np.asarray(expected_first))

                second = working.update(engine, [both_layer], 1)
                self.assert_direct_patch(second, expected_both, cumulative)
            self.assertIsNotNone(working.result)
            self.assertFalse(working._sparse_tiles)
            self.assertEqual(working._sparse_bytes, 0)
            np.testing.assert_array_equal(np.asarray(working.current), np.asarray(expected_both))
        finally:
            expected_first.close()
            expected_both.close()
            cumulative.close()
            working.close()
            source.close()

    def test_legacy_stroke_radius_is_clamped_before_dirty_bounds(self):
        layer = make_layer('paint', strokes=[{'points': [[60, 44]], 'radius': -20,
            'hardness': 0, 'opacity': 1, 'color': '#ff0000'}])
        response = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        with engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]}) as expected:
            with self.source.copy() as previous:
                self.assert_patch_matches(response, expected, previous)

    def test_appended_paint_strokes_are_applied_once_and_return_native_patches(self):
        initial = self.post('/api/canvas/retouch/working', self.base)
        self.assertEqual(initial.status_code, 204)
        first_stroke = {
            'points': [[24, 28], [32, 30]], 'radius': 8, 'hardness': .45,
            'opacity': .8, 'color': '#f14359',
        }
        second_stroke = {
            'points': [[86, 60], [92, 62]], 'radius': 6, 'hardness': .7,
            'opacity': .6, 'color': '#35d3b4',
        }
        layer = make_layer('paint', strokes=[first_stroke])
        first_expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
        cumulative = self.source.copy()
        with mock.patch.object(engine, 'apply_paint', wraps=engine.apply_paint) as apply_paint:
            first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.headers['X-Retouch-Revision'], '1')
            first_dirty = self.assert_patch_matches(first, first_expected, cumulative)
            self.assertNotEqual(first_dirty, (0, 0, 120, 88))

            updated_layer = make_layer('paint', strokes=[first_stroke, second_stroke])
            second = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 1, 'layers': [updated_layer],
            })
            self.assertEqual(second.status_code, 200)
            self.assertEqual(second.headers['X-Retouch-Revision'], '2')

            unchanged = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 2, 'layers': [updated_layer],
            })
            self.assertEqual(unchanged.status_code, 204)
            self.assertEqual(unchanged.headers['X-Retouch-Revision'], '2')

        self.assertEqual([len(call.args[1]['strokes']) for call in apply_paint.call_args_list], [1, 1])
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [updated_layer]})
        try:
            dirty = self.assert_patch_matches(second, expected, cumulative)
            self.assertNotEqual(dirty, (0, 0, 120, 88))
            self.assertEqual(unchanged.headers['Cache-Control'], 'no-store')
        finally:
            first_expected.close()
            expected.close()
            cumulative.close()

    def test_unchanged_effective_layers_do_no_pixel_work(self):
        layer = make_layer('tone', params={'brightness': 12})
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(first.status_code, 200)
        with mock.patch.object(engine, 'render', side_effect=AssertionError('rendered unchanged layers')):
            same = self.post('/api/canvas/retouch/working', {**self.base, 'baseRevision': 1, 'layers': [layer]})
        self.assertEqual(same.status_code, 204)
        self.assertEqual(same.headers['X-Retouch-Revision'], '1')

    def test_mask_edit_and_active_stroke_growth_match_fresh_native_render(self):
        stroke = {
            'points': [[42, 39]], 'radius': 13, 'hardness': .5,
            'opacity': .8, 'color': '#fa1835',
        }
        layer = make_layer('paint', strokes=[stroke])
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(first.status_code, 200)
        revision = int(first.headers['X-Retouch-Revision'])
        first_expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
        cumulative = self.source.copy()
        try:
            self.assert_patch_matches(first, first_expected, cumulative)
        finally:
            first_expected.close()

        growing = dict(stroke, points=[[42, 39], [57, 44]])
        grown_layer = make_layer('paint', strokes=[growing])
        grown = self.post('/api/canvas/retouch/working', {
            **self.base, 'baseRevision': revision, 'layers': [grown_layer],
        })
        self.assertEqual(grown.status_code, 200)
        revision = int(grown.headers['X-Retouch-Revision'])
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [grown_layer]})
        try:
            self.assert_patch_matches(grown, expected, cumulative)
            cumulative_after_growth = cumulative.copy()
        finally:
            cumulative.close()
            expected.close()

        masked = make_layer('paint', strokes=[growing], mask={
            'base': 1,
            'strokes': [{
                'points': [[50, 43]], 'radius': 9, 'hardness': 1,
                'opacity': 1, 'erase': True,
            }],
        })
        erosion = self.post('/api/canvas/retouch/working', {
            **self.base, 'baseRevision': revision, 'layers': [masked],
        })
        self.assertEqual(erosion.status_code, 200)
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [masked]})
        try:
            self.assert_patch_matches(erosion, expected, cumulative_after_growth)
        finally:
            cumulative_after_growth.close()
            expected.close()

    def test_multi_layer_mask_eraser_recomputes_only_union_region(self):
        layers = [
            make_layer('tone', layer_id='tone-a', params={'brightness': 12}),
            make_layer('tone', layer_id='tone-b', params={'contrast': 15}),
        ]
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': layers})
        self.assertEqual(first.status_code, 200)
        revision = int(first.headers['X-Retouch-Revision'])
        eraser = {
            'points': [[34, 32], [45, 36]], 'radius': 10,
            'hardness': .4, 'opacity': .8, 'erase': True,
        }
        masked = [
            dict(layer, mask={'base': 1, 'strokes': [eraser]})
            for layer in layers
        ]
        response = self.post('/api/canvas/retouch/working', {
            **self.base, 'baseRevision': revision, 'layers': masked,
        })
        self.assertEqual(response.status_code, 200)
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': masked})
        try:
            with self.response_image(first) as cumulative:
                dirty = self.assert_patch_matches(response, expected, cumulative)
            self.assertNotEqual(dirty, (0, 0, 120, 88))
        finally:
            expected.close()

    def test_edit_to_earlier_liquify_stroke_uses_full_fallback(self):
        first_strokes = [
            {'points': [[20, 43], [40, 43]], 'radius': 8, 'strength': .7, 'mode': 'push'},
            {'points': [[70, 43], [90, 43]], 'radius': 7, 'strength': .5, 'mode': 'push'},
        ]
        layer = make_layer('liquify', strokes=first_strokes)
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(first.status_code, 200)
        revision = int(first.headers['X-Retouch-Revision'])
        changed_strokes = [dict(first_strokes[0], points=[[17, 43], [43, 45]]), first_strokes[1]]
        changed_layer = make_layer('liquify', strokes=changed_strokes)
        response = self.post('/api/canvas/retouch/working', {
            **self.base, 'baseRevision': revision, 'layers': [changed_layer],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.headers['X-Retouch-X'], response.headers['X-Retouch-Y']), ('0', '0'))
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [changed_layer]})
        try:
            self.assert_patch_matches(response, expected)
        finally:
            expected.close()

    def test_last_liquify_transition_reuses_before_after_patches_for_undo_redo(self):
        self.assertEqual(self.post('/api/canvas/retouch/working', self.base).status_code, 204)
        layer = make_layer('liquify', strokes=[{
            'points': [[14, 43], [38, 45]], 'radius': 8, 'strength': .75,
            'mode': 'push',
        }])
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(first.status_code, 200)
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
        expected_result = expected.copy()
        cumulative = self.source.copy()
        try:
            self.assert_patch_matches(first, expected, cumulative)
        finally:
            expected.close()

        edited = make_layer('liquify', strokes=[dict(
            layer['strokes'][0], points=[[14, 42], [38, 47]],
        )])
        with mock.patch.object(engine, 'render', side_effect=RuntimeError('synthetic render failure')):
            failed = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 1, 'layers': [edited],
            })
        self.assertEqual(failed.status_code, 500)
        self.assertEqual(self.controller.working_image.revision, 1)

        with (
            mock.patch.object(engine, 'render', side_effect=AssertionError('undo rendered')),
            mock.patch.object(engine, 'apply_liquify', side_effect=AssertionError('undo warped')),
        ):
            undo = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 1, 'layers': [],
            })
            self.assertEqual(undo.status_code, 200)
            self.assertEqual(undo.headers['X-Retouch-Revision'], '2')
            self.assert_patch_matches(undo, self.source, cumulative)

            redo = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 2, 'layers': [layer],
            })
            self.assertEqual(redo.status_code, 200)
            self.assertEqual(redo.headers['X-Retouch-Revision'], '3')
            self.assert_patch_matches(redo, expected_result, cumulative)
        expected_result.close()
        cumulative.close()

    def test_global_setting_change_is_full_native_and_missed_revision_catches_up(self):
        before = make_layer('tone', params={'brightness': 8})
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [before]})
        self.assertEqual(first.status_code, 200)
        after = make_layer('tone', params={'brightness': 24})
        changed = self.post('/api/canvas/retouch/working', {
            **self.base, 'baseRevision': 1, 'layers': [after],
        })
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.headers['X-Retouch-Revision'], '2')
        self.assertEqual((changed.headers['X-Retouch-X'], changed.headers['X-Retouch-Y']), ('0', '0'))
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [after]})
        try:
            self.assert_patch_matches(changed, expected)
            missed = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 0, 'layers': [after],
            })
            self.assertEqual(missed.status_code, 200)
            self.assertEqual(missed.headers['X-Retouch-Revision'], '2')
            self.assert_patch_matches(missed, expected)
        finally:
            expected.close()

    def test_top_adjustment_reuses_the_existing_composite(self):
        lower = make_layer('tone', params={'brightness': 14})
        blur = make_layer('blur', 'blur', params={'radius': 4})
        sharper = make_layer('blur', 'blur', params={'radius': 2})
        first = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [lower]})
        self.assertEqual(first.status_code, 200)
        with mock.patch.object(engine, 'render', side_effect=AssertionError('lower layers recomputed')):
            second = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 1, 'layers': [lower, blur],
            })
            self.assertEqual(second.status_code, 200)
            third = self.post('/api/canvas/retouch/working', {
                **self.base, 'baseRevision': 2, 'layers': [lower, sharper],
            })
            self.assertEqual(third.status_code, 200)
        with engine.render(io.BytesIO(self.source_bytes), {'layers': [lower, sharper]}) as expected:
            self.assert_patch_matches(third, expected)

    def test_apply_saves_uploaded_confirmed_pixels_without_rendering(self):
        layers = [make_layer('tone', params={'brightness': 14})]
        with engine.render(io.BytesIO(self.source_bytes), {'layers': layers}) as expected:
            rendered = encode_png(expected)
            with mock.patch.object(engine, 'render', side_effect=AssertionError('pixels recalculated')):
                response = self.client.post('/api/canvas/retouch/apply', data={
                    'document': (io.BytesIO(json.dumps({**self.base, 'layers': layers}).encode()),
                                 'document.json', 'application/json'),
                    'rendered': (io.BytesIO(rendered), 'retouch.png', 'image/png'),
                })
                self.assertEqual(response.status_code, 202)
                job = response.get_json()['job']
                deadline = time.monotonic() + 3
                while job['status'] == 'running' and time.monotonic() < deadline:
                    time.sleep(.01)
                    job = self.client.get('/api/canvas/retouch/jobs/' + job['id']).get_json()['job']
                self.assertEqual(job['status'], 'done', job)
            with Image.open(self.output_dir / Path(job['result']['src']).name) as saved:
                np.testing.assert_array_equal(np.asarray(saved), np.asarray(expected))
                self.assertIn('icc_profile', saved.info)
                self.assertIn('dpi', saved.info)

    def test_source_hash_resets_single_slot_and_close_only_matches_id(self):
        first = self.post('/api/canvas/retouch/working', self.base)
        self.assertEqual(first.status_code, 204)
        previous = self.controller.working_image
        replacement = Image.new('RGBA', self.source.size, (90, 30, 155, 210))
        self.inputs['/canvas-imports/source.png'] = encode_png(replacement)
        replacement.close()

        current = self.post('/api/canvas/retouch/working', {**self.base, 'baseRevision': 1})
        self.assertEqual(current.status_code, 200)  # stale revision forces source catch-up
        self.assertEqual(current.headers['X-Retouch-Revision'], '0')
        with self.assertRaises(ValueError):
            previous.original.getpixel((0, 0))

        wrong = self.post('/api/canvas/retouch/working/close', {'workingId': 'other'})
        self.assertEqual(wrong.status_code, 204)
        self.assertIsNotNone(self.controller.working_image)
        closed = self.post('/api/canvas/retouch/working/close', {'workingId': 'working_test_1'})
        self.assertEqual(closed.status_code, 204)
        self.assertIsNone(self.controller.working_image)

    def test_failed_stroke_rolls_back_cache_and_revision(self):
        original = np.asarray(self.source).copy()
        layer = make_layer('paint', strokes=[{
            'points': [[32, 36]], 'radius': 10, 'hardness': .3,
            'opacity': 1, 'color': '#ff0000',
        }])

        def partial_then_fail(image, *_args):
            image.putpixel((0, 0), (0, 0, 0, 0))
            raise RuntimeError('synthetic failure')

        with mock.patch.object(engine, 'apply_paint', side_effect=partial_then_fail):
            response = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(response.status_code, 500)
        cached = self.controller.working_image
        self.assertEqual(cached.revision, 0)
        self.assertEqual(cached.layers, [])
        np.testing.assert_array_equal(np.asarray(cached.current), original)
        self.assertIsNone(cached.result)

    def test_apply_and_pair_exports_reuse_matching_native_working_result(self):
        layer = make_layer('tone', params={'brightness': 16})
        working = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(working.status_code, 200)
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
        try:
            with mock.patch.object(engine, 'render', wraps=engine.render) as render:
                applied = self.post('/api/canvas/retouch/apply', {
                    **self.base, 'layers': [layer], 'print': {'widthCm': 10},
                })
                self.assertEqual(applied.status_code, 202)
                job_id = applied.get_json()['job']['id']
                deadline = time.monotonic() + 5
                job = None
                while time.monotonic() < deadline:
                    job = self.client.get(f'/api/canvas/retouch/jobs/{job_id}').get_json()['job']
                    if job['status'] != 'running':
                        break
                    time.sleep(.01)
                self.assertEqual(job['status'], 'done', job)
                self.assertEqual(render.call_count, 0)

            with Image.open(self.output_dir / Path(job['result']['src']).name) as saved:
                np.testing.assert_array_equal(np.asarray(saved), np.asarray(expected))

            other = Image.new('RGBA', (17, 13), (8, 40, 80, 255))
            self.inputs['/image/other.png'] = encode_png(other)
            other.close()
            with mock.patch.object(engine, 'render', wraps=engine.render) as render:
                pair = self.post('/api/canvas/retouch/export-pair', {
                    **self.base, 'layers': [layer],
                    'otherSource': '/image/other.png', 'side': 'front',
                })
                self.assertEqual(pair.status_code, 200)
                self.assertEqual(render.call_count, 1)  # only the uncached other side
            with zipfile.ZipFile(io.BytesIO(pair.data)) as archive:
                with Image.open(io.BytesIO(archive.read('daki-front.png'))) as front:
                    np.testing.assert_array_equal(np.asarray(front), np.asarray(expected))
        finally:
            expected.close()

    def test_working_request_validates_id_revision_and_is_native_only(self):
        for body in (
            {**self.base, 'workingId': 'bad id'},
            {**self.base, 'workingId': 'x' * 101},
            {**self.base, 'baseRevision': True},
            {**self.base, 'baseRevision': -1},
        ):
            with self.subTest(body=body):
                response = self.post('/api/canvas/retouch/working', body)
                self.assertEqual(response.status_code, 400)

    def test_appended_small_radius_long_liquify_uses_full_native_source_context(self):
        self.assertEqual(self.post('/api/canvas/retouch/working', self.base).status_code, 204)
        layer = make_layer('liquify', strokes=[{
            'points': [[8, 44], [111, 44]], 'radius': 2, 'strength': .9,
            'mode': 'push',
        }])
        response = self.post('/api/canvas/retouch/working', {**self.base, 'layers': [layer]})
        self.assertEqual(response.status_code, 200)
        expected = engine.render(io.BytesIO(self.source_bytes), {'layers': [layer]})
        try:
            with self.source.copy() as previous:
                self.assert_patch_matches(response, expected, previous)
        finally:
            expected.close()


if __name__ == '__main__':
    unittest.main()

