import copy
import hashlib
import io
import unittest
from unittest import mock

import numpy as np
from flask import Flask
from PIL import Image

from naim.images import retouch as engine
from naim.images.retouch_preview import MaskCache, PreviewCache
from naim.web.canvas_retouch import register_canvas_retouch_routes


def erase_strokes(count=10):
    return [{
        'points': [[40 + index * 36, 90 + index * 130], [50 + index * 36, 96 + index * 130]],
        'radius': 26,
        'hardness': .25,
        'opacity': .7,
        'erase': True,
    } for index in range(count)]


def tone_layer(strokes, brightness=16, shape=None, base=1):
    mask = {'base': base, 'strokes': strokes}
    if shape is not None:
        mask['shape'] = shape
    return {
        'id': 'masked-tone',
        'type': 'tone',
        'visible': True,
        'opacity': 1,
        'params': {'brightness': brightness},
        'mask': mask,
        'strokes': [],
    }


def make_prepared(size=(500, 1600)):
    width, height = size
    y, x = np.mgrid[:height, :width]
    pixels = np.stack([
        (x * 3 + y) % 256,
        (x + y * 5) % 256,
        (x * 7 + y * 2) % 256,
        (x + y) % 256,
    ], axis=2).astype('uint8')
    return Image.fromarray(pixels, 'RGBA')


def png_bytes(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class MaskCacheTests(unittest.TestCase):
    def test_lru_hits_refresh_order_and_eviction_closes_owned_masks(self):
        cache = MaskCache(max_pixels=10)
        first = Image.new('L', (2, 2), 30)
        second = Image.new('L', (3, 2), 60)
        third = Image.new('L', (2, 2), 90)
        cache.store('first', first)
        cache.store('second', second)

        self.assertIs(cache.get('first'), first)
        cache.store('third', third)

        self.assertIsNone(cache.get('second'))
        self.assertIs(cache.get('first'), first)
        self.assertIs(cache.get('third'), third)
        self.assertEqual(cache._pixels, 8)
        with self.assertRaises(ValueError):
            second.getpixel((0, 0))

        cache.clear()
        self.assertEqual(cache._pixels, 0)
        for image in (first, third):
            with self.assertRaises(ValueError):
                image.getpixel((0, 0))

    def test_replacement_and_oversized_masks_close_owned_images(self):
        cache = MaskCache(max_pixels=6)
        old = Image.new('L', (2, 2), 10)
        replacement = Image.new('L', (3, 1), 20)
        cache.store('same', old)
        cache.store('same', replacement)
        self.assertEqual(cache._pixels, 3)
        with self.assertRaises(ValueError):
            old.getpixel((0, 0))

        oversized = Image.new('L', (4, 2), 30)
        cache.store('same', oversized)
        self.assertIsNone(cache.get('same'))
        self.assertEqual(cache._pixels, 0)
        for image in (replacement, oversized):
            with self.assertRaises(ValueError):
                image.getpixel((0, 0))

    def test_preview_cache_clear_also_closes_mask_cache_images(self):
        cache = PreviewCache()
        prepared = Image.new('RGBA', (5, 7), (1, 2, 3, 4))
        mask = Image.new('L', (5, 7), 90)
        cache.store('source', prepared, (50, 70))
        cache.masks.store('eraser', mask)

        cache.clear()

        self.assertIsNone(cache.get('source'))
        self.assertIsNone(cache.masks.get('eraser'))
        self.assertEqual(cache.masks._pixels, 0)
        for image in (prepared, mask):
            with self.assertRaises(ValueError):
                image.getpixel((0, 0))


class MaskedRetouchPreviewTests(unittest.TestCase):
    def test_preview_reuses_prefix_and_full_masks_with_uncached_pixel_equivalence(self):
        prepared = make_prepared()
        cache = MaskCache()
        original_records = erase_strokes(10)
        original_layer = tone_layer(original_records)
        first = growing = appended = changed_tone = undone = None
        try:
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                first = engine.render_preview(prepared, {'layers': [original_layer]}, .25, mask_cache=cache)
                self.assertEqual(patch.call_count, 10)
            expected_first = engine.render_preview(prepared, {'layers': [original_layer]}, .25)
            try:
                np.testing.assert_array_equal(np.asarray(first), np.asarray(expected_first))
                np.testing.assert_array_equal(np.asarray(first)[..., 3], np.asarray(prepared)[..., 3])
            finally:
                expected_first.close()

            growing_records = copy.deepcopy(original_records)
            growing_records[-1]['points'].append([390, 1320])
            growing_layer = tone_layer(growing_records)
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                growing = engine.render_preview(prepared, {'layers': [growing_layer]}, .25, mask_cache=cache)
                self.assertEqual(patch.call_count, 1)
            expected_growing = engine.render_preview(prepared, {'layers': [growing_layer]}, .25)
            try:
                np.testing.assert_array_equal(np.asarray(growing), np.asarray(expected_growing))
            finally:
                expected_growing.close()

            appended_records = copy.deepcopy(growing_records)
            appended_records.append(erase_strokes(1)[0])
            appended_layer = tone_layer(appended_records)
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                appended = engine.render_preview(prepared, {'layers': [appended_layer]}, .25, mask_cache=cache)
                self.assertEqual(patch.call_count, 1)
            expected_appended = engine.render_preview(prepared, {'layers': [appended_layer]}, .25)
            try:
                np.testing.assert_array_equal(np.asarray(appended), np.asarray(expected_appended))
            finally:
                expected_appended.close()

            changed_tone_layer = tone_layer(appended_records, brightness=28)
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                changed_tone = engine.render_preview(
                    prepared, {'layers': [changed_tone_layer]}, .25, mask_cache=cache,
                )
                self.assertEqual(patch.call_count, 0)
            expected_tone = engine.render_preview(prepared, {'layers': [changed_tone_layer]}, .25)
            try:
                np.testing.assert_array_equal(np.asarray(changed_tone), np.asarray(expected_tone))
            finally:
                expected_tone.close()

            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                undone = engine.render_preview(prepared, {'layers': [original_layer]}, .25, mask_cache=cache)
                self.assertEqual(patch.call_count, 0)
            np.testing.assert_array_equal(np.asarray(undone), np.asarray(first))
        finally:
            for image in (first, growing, appended, changed_tone, undone, prepared):
                if image is not None:
                    image.close()
            cache.clear()

    def test_shape_base_scale_and_undo_changes_never_reuse_wrong_pixels(self):
        prepared = make_prepared((80, 120))
        cache = MaskCache(max_pixels=100000)
        records = erase_strokes(2)
        rect = {'kind': 'rect', 'box': [0, 0, 55, 120]}
        ellipse = {'kind': 'ellipse', 'box': [0, 0, 65, 120]}
        first_layer = tone_layer(records, shape=rect)
        first = shape_changed = base_changed = scale_changed = undone = None
        try:
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                first = engine.render_preview(prepared, {'layers': [first_layer]}, 1, mask_cache=cache)
                self.assertEqual(patch.call_count, 2)

            shape_layer = tone_layer(records, shape=ellipse)
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                shape_changed = engine.render_preview(prepared, {'layers': [shape_layer]}, 1, mask_cache=cache)
                self.assertEqual(patch.call_count, 0)
            expected_shape = engine.render_preview(prepared, {'layers': [shape_layer]}, 1)
            try:
                np.testing.assert_array_equal(np.asarray(shape_changed), np.asarray(expected_shape))
                self.assertFalse(np.array_equal(np.asarray(first), np.asarray(shape_changed)))
            finally:
                expected_shape.close()

            base_records = copy.deepcopy(records)
            base_records.append({
                'points': [[30, 40]], 'radius': 12, 'hardness': .4,
                'opacity': .8, 'erase': False,
            })
            base_layer = tone_layer(base_records, shape=ellipse, base=0)
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                base_changed = engine.render_preview(prepared, {'layers': [base_layer]}, 1, mask_cache=cache)
                self.assertEqual(patch.call_count, 3)
            expected_base = engine.render_preview(prepared, {'layers': [base_layer]}, 1)
            try:
                np.testing.assert_array_equal(np.asarray(base_changed), np.asarray(expected_base))
            finally:
                expected_base.close()

            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                scale_changed = engine.render_preview(prepared, {'layers': [shape_layer]}, .5, mask_cache=cache)
                self.assertEqual(patch.call_count, 2)
            expected_scale = engine.render_preview(prepared, {'layers': [shape_layer]}, .5)
            try:
                np.testing.assert_array_equal(np.asarray(scale_changed), np.asarray(expected_scale))
            finally:
                expected_scale.close()

            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                undone = engine.render_preview(prepared, {'layers': [first_layer]}, 1, mask_cache=cache)
                self.assertEqual(patch.call_count, 0)
            np.testing.assert_array_equal(np.asarray(undone), np.asarray(first))
        finally:
            for image in (first, shape_changed, base_changed, scale_changed, undone, prepared):
                if image is not None:
                    image.close()
            cache.clear()

    def test_preview_route_uses_controller_mask_cache_for_growing_eraser(self):
        prepared = make_prepared()
        raw = png_bytes(prepared)
        inputs = {'/canvas-imports/source.png': raw}

        def read_source(path):
            return inputs[path]

        def save_image(_raw, **_options):
            return '/image/result.png', 'result.png'

        app = Flask(__name__)
        app.testing = True
        controller = register_canvas_retouch_routes(app, read_source, save_image)
        client = app.test_client()
        records = erase_strokes(10)
        try:
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                first = client.post('/api/canvas/retouch/preview', json={
                    'source': '/canvas-imports/source.png', 'layers': [tone_layer(records)],
                })
                self.assertEqual(first.status_code, 200)
                self.assertEqual(patch.call_count, 10)

            extended = copy.deepcopy(records)
            extended[-1]['points'].append([390, 1320])
            with mock.patch.object(engine, 'stroke_patch', wraps=engine.stroke_patch) as patch:
                second = client.post('/api/canvas/retouch/preview', json={
                    'source': '/canvas-imports/source.png', 'layers': [tone_layer(extended)],
                })
                self.assertEqual(second.status_code, 200)
                self.assertEqual(patch.call_count, 1)

            key = hashlib.sha256(raw).digest()
            self.assertGreater(controller.preview_cache.masks._pixels, 0)
            self.assertIsNotNone(controller.preview_cache.get(key))
        finally:
            controller.preview_cache.clear()
            prepared.close()


if __name__ == '__main__':
    unittest.main()
