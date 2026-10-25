import builtins
import io
import json
import tempfile
import threading
import time
import unittest
import zipfile
from copy import deepcopy
from pathlib import Path
from unittest import mock

import numpy as np
from flask import Flask
from PIL import Image

from naim.images import retouch as engine
from naim.web.canvas_retouch import register_canvas_retouch_routes


def make_layer(kind, **kwargs):
    layer = {
        'id': 'test-' + kind,
        'type': kind,
        'name': kind,
        'opacity': 1,
        'visible': True,
        'mask': {'base': 1, 'strokes': []},
        'params': {},
        'strokes': [],
    }
    layer.update(kwargs)
    return layer


def png_bytes(image):
    stream = io.BytesIO()
    image.save(stream, format='PNG')
    return stream.getvalue()


class RetouchEngineTests(unittest.TestCase):
    def setUp(self):
        y, x = np.mgrid[:192, :128]
        pixels = np.stack(
            [x * 2, y, np.mod(x * 5 + y * 7, 255), np.full_like(x, 255)],
            axis=2,
        ).astype('uint8')
        pixels[:4, :, 3] = 0
        self.source = Image.fromarray(pixels, 'RGBA')
        self.raw = png_bytes(self.source)

    def tearDown(self):
        self.source.close()

    def render(self, layers, **kwargs):
        return engine.render(io.BytesIO(self.raw), {'layers': layers}, **kwargs)

    def test_original_alpha_and_source_bytes_are_preserved(self):
        before = self.raw
        result = self.render([make_layer('tone', params={'brightness': 12, 'saturation': -15})])
        out = np.asarray(result)
        source = np.asarray(self.source)
        self.assertFalse(np.array_equal(out[10:, :, :3], source[10:, :, :3]))
        np.testing.assert_array_equal(out[:, :, 3], source[:, :, 3])
        self.assertEqual(self.raw, before)
        result.close()

    def test_hidden_and_zero_opacity_layers_have_no_effect(self):
        layers = [
            make_layer('color', visible=False),
            make_layer('tone', opacity=0, params={'brightness': 30}),
        ]
        result = self.render(layers)
        np.testing.assert_array_equal(np.asarray(result), np.asarray(self.source))
        result.close()

    def test_parameter_values_keep_engine_number_clamping(self):
        high = self.render([make_layer('tone', params={'brightness': 1000})])
        clamped = self.render([make_layer('tone', params={'brightness': 40})])
        np.testing.assert_array_equal(np.asarray(high), np.asarray(clamped))
        high.close()
        clamped.close()

    def test_frontend_defaults_for_all_nine_layer_kinds_validate(self):
        defaults = {
            'color': {'color': '#ffe0cd', 'mode': 'soft-light'},
            'tone': {'brightness': 0, 'contrast': 0, 'saturation': 0, 'shadows': 0, 'highlights': 0},
            'paint': {'mode': 'normal'},
            'clone': {},
            'blur': {'radius': 6},
            'sharpen': {'radius': 5, 'amount': 100, 'threshold': 0},
            'line': {'strength': 1.5},
            'texture': {'scale': 100, 'decay': .4, 'octaves': 3, 'seed': 17},
            'liquify': {'mode': 'push', 'strength': .35},
        }
        engine.validate_side({'layers': [
            make_layer(kind, params=params) for kind, params in defaults.items()
        ]})

    def test_rect_and_ellipse_mask_shapes(self):
        rect = make_layer(
            'tone', params={'brightness': 20},
            mask={'base': 1, 'strokes': [], 'shape': {'kind': 'rect', 'box': [20, 20, 70, 80]}},
        )
        result = self.render([rect])
        out = np.asarray(result)
        source = np.asarray(self.source)
        np.testing.assert_array_equal(out[100:], source[100:])
        self.assertGreater(out[40, 40, 0], source[40, 40, 0])
        result.close()

        ellipse = make_layer(
            'tone', mask={'base': 1, 'strokes': [], 'shape': {'kind': 'ellipse', 'box': [20, 20, 80, 100]}},
        )
        mask = engine.mask_image(ellipse, (128, 192), 1, (0, 0))
        self.assertEqual(mask.getpixel((20, 20)), 0)
        self.assertEqual(mask.getpixel((50, 60)), 255)
        mask.close()

    def test_empty_mask_and_freeze_have_no_effect(self):
        layer = make_layer('sharpen', mask={'base': 0, 'strokes': []}, params={'radius': 5, 'amount': 150})
        result = self.render([layer])
        np.testing.assert_array_equal(np.asarray(result), np.asarray(self.source))
        result.close()

    def test_empty_application_areas_skip_expensive_layer_work(self):
        erase_only = {
            'base': 0,
            'strokes': [{
                'points': [[64, 96]], 'radius': 12, 'hardness': 1,
                'opacity': 1, 'erase': True,
            }],
        }
        layers = [
            make_layer('tone', id='tone-empty-mask', mask={'base': 0, 'strokes': []}, params={'brightness': 20}),
            make_layer('sharpen', mask=erase_only, params={'radius': 5, 'amount': 150}),
            make_layer('line', opacity=0, params={'strength': 2}),
            make_layer('color', mask=deepcopy(erase_only), params={'color': '#ff0000'}),
            make_layer('tone', id='tone-zero-opacity', opacity=0, params={'brightness': 20}),
            make_layer('paint'),
            make_layer('clone'),
            make_layer('liquify'),
        ]
        with (
            mock.patch.object(engine, 'changed_tile', side_effect=AssertionError('empty adjustment ran')),
            mock.patch.object(engine, 'apply_paint', side_effect=AssertionError('empty paint ran')),
            mock.patch.object(engine, 'apply_liquify', side_effect=AssertionError('empty liquify ran')),
        ):
            result = self.render(layers)
        np.testing.assert_array_equal(np.asarray(result), np.asarray(self.source))
        result.close()

    def test_base_zero_mask_with_add_stroke_still_applies_adjustment(self):
        layer = make_layer('tone', params={'brightness': 20}, mask={
            'base': 0,
            'strokes': [{
                'points': [[64, 96]], 'radius': 12, 'hardness': 1,
                'opacity': 1,
            }],
        })
        result = self.render([layer])
        output = np.asarray(result)
        source = np.asarray(self.source)
        np.testing.assert_array_equal(output[20:40, :40], source[20:40, :40])
        self.assertFalse(np.array_equal(output[96, 64, :3], source[96, 64, :3]))
        result.close()

    def test_adjustment_skips_tiles_with_empty_masks(self):
        pixels = np.empty((80, 1600, 4), dtype=np.uint8)
        pixels[:] = [90, 120, 160, 255]
        image = Image.fromarray(pixels, 'RGBA')
        layer = make_layer('tone', params={'brightness': 20}, mask={
            'base': 1,
            'strokes': [],
            'shape': {'kind': 'rect', 'box': [10, 10, 60, 60]},
        })
        try:
            with mock.patch.object(engine, 'changed_tile', wraps=engine.changed_tile) as changed_tile:
                engine.apply_adjustment(image, layer, 1, (0, 0))
            self.assertEqual(changed_tile.call_count, 1)
            output = np.asarray(image)
            np.testing.assert_array_equal(output[70, 1000], pixels[70, 1000])
            self.assertFalse(np.array_equal(output[30, 30, :3], pixels[30, 30, :3]))
        finally:
            image.close()

    def test_layer_eraser_reveals_previous_layer_only_in_selected_area(self):
        lower = make_layer('tone', params={'brightness': 5})
        upper = make_layer('color', params={'color': '#ff0000', 'mode': 'normal'}, mask={
            'base': 1,
            'strokes': [{
                'points': [[64, 96]], 'radius': 20, 'hardness': 1,
                'opacity': 1, 'erase': True,
            }],
        })
        before = deepcopy([lower, upper])
        lower_only = self.render([lower])
        combined = self.render([lower, upper])
        output = np.asarray(combined)
        np.testing.assert_array_equal(output[96, 64], np.asarray(lower_only)[96, 64])
        np.testing.assert_array_equal(output[20, 20, :3], [255, 0, 0])
        self.assertEqual([lower, upper], before)
        lower_only.close()
        combined.close()

    def test_soft_layer_eraser_feathers_and_preserves_stroke_format(self):
        stroke = {
            'points': [[64, 96]], 'radius': 20, 'opacity': 1, 'erase': True,
        }
        soft = make_layer('tone', mask={'base': 1, 'strokes': [{**stroke, 'hardness': 0}]})
        hard = make_layer('tone', mask={'base': 1, 'strokes': [{**stroke, 'hardness': 1}]})
        soft_half = make_layer('tone', mask={'base': 1, 'strokes': [{**stroke, 'hardness': 0, 'opacity': .4}]})
        soft_mask = engine.mask_image(soft, (128, 192), 1, (0, 0))
        hard_mask = engine.mask_image(hard, (128, 192), 1, (0, 0))
        half_mask = engine.mask_image(soft_half, (128, 192), 1, (0, 0))
        try:
            values = np.asarray(soft_mask)
            self.assertTrue(np.any((values > 0) & (values < 255)))
            self.assertLess(values[96, 64], 255)
            self.assertGreater(values[96, 86], values[96, 80])
            self.assertLess(values[96, 86], 255)
            np.testing.assert_array_equal(np.asarray(hard_mask)[96, 86], 255)
            self.assertGreaterEqual(np.asarray(half_mask)[96, 86], values[96, 86])
            self.assertGreater(np.asarray(half_mask)[96, 86], values[96, 86])
        finally:
            for mask in (soft_mask, hard_mask, half_mask):
                mask.close()

        restored = make_layer('tone', mask={'base': 0, 'strokes': [
            {'points': [[64, 96]], 'radius': 20, 'hardness': 1, 'opacity': 1},
            {'points': [[64, 96]], 'radius': 8, 'hardness': 1, 'opacity': 1, 'erase': True},
        ]})
        restored_mask = engine.mask_image(restored, (128, 192), 1, (0, 0))
        try:
            self.assertEqual(restored_mask.getpixel((64, 96)), 0)
            self.assertEqual(restored_mask.getpixel((77, 96)), 255)
        finally:
            restored_mask.close()

    def test_clone_samples_original_pixels_after_prior_paint_and_preserves_alpha(self):
        original = np.asarray(self.source).copy()
        source_bytes = self.raw
        paint = make_layer('paint', strokes=[{
            'points': [[25, 35]], 'radius': 8, 'hardness': 1,
            'opacity': 1, 'color': '#ff0000',
        }])
        clone = make_layer('clone', strokes=[{
            'points': [[85, 95]], 'source': [25, 35], 'radius': 6,
            'hardness': 1, 'opacity': 1,
        }])
        result = self.render([paint, clone])
        output = np.asarray(result)
        np.testing.assert_array_equal(output[95, 85], original[35, 25])
        np.testing.assert_array_equal(output[..., 3], original[..., 3])
        self.assertEqual(self.raw, source_bytes)
        result.close()

    def test_adjustment_progress_is_monotone_bounded_and_finishes_at_one(self):
        pixels = np.empty((1600, 128, 4), dtype=np.uint8)
        pixels[:] = [90, 120, 160, 255]
        raw = png_bytes(Image.fromarray(pixels, 'RGBA'))
        progress = []
        result = engine.render(
            io.BytesIO(raw),
            {'layers': [make_layer('tone', params={'brightness': 5})]},
            progress=lambda value, _name: progress.append(value),
        )
        try:
            self.assertGreater(len(progress), 3)
            self.assertTrue(all(0 <= value <= 1 for value in progress))
            self.assertEqual(progress, sorted(progress))
            self.assertEqual(progress[-1], 1)
        finally:
            result.close()

    def test_paint_and_clone_sample_expected_pixels(self):
        paint = make_layer('paint', strokes=[{
            'points': [[80, 80]], 'radius': 12, 'hardness': 1, 'opacity': 1, 'color': '#ff0000',
        }])
        result = self.render([paint])
        np.testing.assert_allclose(np.asarray(result)[80, 80, :3], [255, 0, 0], atol=1)
        result.close()

        clone = make_layer('clone', strokes=[{
            'points': [[85, 95]], 'source': [25, 35], 'radius': 12, 'hardness': 1, 'opacity': 1,
        }])
        result = self.render([clone])
        np.testing.assert_allclose(np.asarray(result)[95, 85, :3], np.asarray(self.source)[35, 25, :3], atol=2)
        result.close()

    def test_airbrush_coverage_falls_off_and_repeated_dabs_build_up(self):
        stroke = {
            'points': [[40, 40]], 'radius': 12, 'hardness': .2, 'flow': .2,
            'opacity': 1, 'color': '#ff0000', 'brush': 'airbrush',
        }
        box, one = engine.airbrush_coverage((100, 100), stroke, 1, (0, 0))
        repeated = {**stroke, 'points': [[40, 40], [40, 40]]}
        repeated_box, two = engine.airbrush_coverage((100, 100), repeated, 1, (0, 0))
        self.assertEqual(box, repeated_box)
        default_flow = {key: value for key, value in stroke.items() if key != 'flow'}
        _, default_coverage = engine.airbrush_coverage((100, 100), default_flow, 1, (0, 0))
        explicit_default = {**default_flow, 'flow': .04}
        _, explicit_coverage = engine.airbrush_coverage((100, 100), explicit_default, 1, (0, 0))
        np.testing.assert_array_equal(default_coverage, explicit_coverage)
        center = (40 - box[1], 40 - box[0])
        middle = (40 - box[1], 46 - box[0])
        edge = (40 - box[1], 52 - box[0])
        self.assertGreater(one[center], one[middle])
        self.assertGreater(one[middle], 0)
        self.assertEqual(one[edge], 0)
        self.assertGreater(two[center], one[center])

    def test_airbrush_arc_length_sampling_is_event_density_independent(self):
        sparse = list(engine.airbrush_dabs([[0, 0], [10, 0]], 10))
        dense = list(engine.airbrush_dabs([[x, 0] for x in range(11)], 10))
        np.testing.assert_allclose(sparse, dense, atol=1e-6)
        dwell = list(engine.airbrush_dabs([[0, 0], [2, 0], [2, 0], [10, 0]], 10))
        self.assertEqual(sum(point[0] == 2 and point[1] == 0 for point in dwell), 2)
        self.assertGreater(len(dwell), len(sparse))

    def test_airbrush_zero_flow_alpha_and_outside_region_are_unchanged(self):
        layer = make_layer('paint', strokes=[{
            'points': [[70, 80]], 'radius': 14, 'hardness': .4, 'flow': 0,
            'opacity': 1, 'color': '#e86a75', 'brush': 'airbrush',
        }])
        unchanged = self.render([layer])
        np.testing.assert_array_equal(np.asarray(unchanged), np.asarray(self.source))
        unchanged.close()

        layer['strokes'][0]['flow'] = .3
        result = self.render([layer])
        output = np.asarray(result)
        original = np.asarray(self.source)
        np.testing.assert_array_equal(output[..., 3], original[..., 3])
        np.testing.assert_array_equal(output[:4], original[:4])
        np.testing.assert_array_equal(output[10:50, :40], original[10:50, :40])
        self.assertFalse(np.array_equal(output[80, 70, :3], original[80, 70, :3]))
        result.close()

    def test_airbrush_color_mode_preserves_skin_luma_and_black_lines(self):
        pixels = np.empty((40, 40, 4), dtype=np.uint8)
        pixels[:] = [190, 140, 120, 255]
        pixels[:, 20, :3] = 0
        self.raw = png_bytes(Image.fromarray(pixels, 'RGBA'))
        layer = make_layer('paint', params={'mode': 'color'}, strokes=[{
            'points': [[20, 20]], 'radius': 12, 'hardness': .5, 'flow': 1,
            'opacity': 1, 'color': '#e86a75', 'brush': 'airbrush',
        }])
        result = self.render([layer])
        output = np.asarray(result)
        weights = np.array([.3, .59, .11])
        before_luma = np.dot(pixels[18, 17, :3], weights)
        after_luma = np.dot(output[18, 17, :3], weights)
        self.assertLessEqual(abs(after_luma - before_luma), 1)
        np.testing.assert_array_equal(output[20, 20, :3], [0, 0, 0])
        result.close()

    def test_multiply_and_screen_blend_direction_and_source_alpha(self):
        base = Image.new('RGBA', (2, 1))
        base.putdata([(100, 120, 140, 0), (100, 120, 140, 255)])
        changed = Image.new('RGBA', (2, 1), (128, 128, 128, 255))
        mask = Image.new('L', (2, 1), 255)
        multiplied = engine.composite(base, changed, mask, 1, 'multiply')
        screened = engine.composite(base, changed, mask, 1, 'screen')
        mul = np.asarray(multiplied)
        scr = np.asarray(screened)
        np.testing.assert_array_less(mul[0, 1, :3], np.asarray(base)[0, 1, :3] + 1)
        np.testing.assert_array_less(np.asarray(base)[0, 1, :3] - 1, scr[0, 1, :3])
        np.testing.assert_array_equal(mul[..., 3], np.asarray(base)[..., 3])
        np.testing.assert_array_equal(scr[..., 3], np.asarray(base)[..., 3])
        for item in (base, changed, mask, multiplied, screened):
            item.close()

    def test_full_normal_composite_replaces_rgb_and_keeps_base_alpha(self):
        base = Image.new('RGBA', (4, 1))
        base.putdata([
            (20, 40, 60, 0), (20, 40, 60, 64),
            (20, 40, 60, 128), (20, 40, 60, 255),
        ])
        changed = Image.new('RGBA', (4, 1))
        changed.putdata([
            (200, 150, 100, 255), (200, 150, 100, 192),
            (200, 150, 100, 64), (200, 150, 100, 0),
        ])
        full_mask = Image.new('L', (4, 1), 255)
        full = engine.composite(base, changed, full_mask, 1, 'normal')
        np.testing.assert_array_equal(np.asarray(full)[..., :3], np.asarray(changed)[..., :3])
        np.testing.assert_array_equal(np.asarray(full)[..., 3], np.asarray(base)[..., 3])

        partial_mask = Image.fromarray(np.array([[128, 0, 255, 64]], dtype=np.uint8), 'L')
        partial = engine.composite(base, changed, partial_mask, .5, 'normal')
        original_rgb = np.asarray(base, dtype=np.float32)[..., :3]
        changed_rgb = np.asarray(changed, dtype=np.float32)[..., :3]
        strength = np.asarray(partial_mask, dtype=np.float32)[..., None] / 255 * .5
        expected_rgb = np.clip(original_rgb + (changed_rgb - original_rgb) * strength + .5, 0, 255).astype('uint8')
        np.testing.assert_array_equal(np.asarray(partial)[..., :3], expected_rgb)
        np.testing.assert_array_equal(np.asarray(partial)[..., 3], np.asarray(base)[..., 3])
        for item in (base, changed, full_mask, full, partial_mask, partial):
            item.close()

    def test_vibrance_preserves_neutrals_white_luma_and_zero_exactness(self):
        pixels = np.array([[[0, 0, 0, 255], [20, 20, 20, 255], [255, 255, 255, 255], [120, 115, 110, 255]]], dtype=np.uint8)
        tile = Image.fromarray(pixels, 'RGBA')
        legacy = engine.changed_tile(tile, 'tone', {}, (0, 0), 1)
        zero = engine.changed_tile(tile, 'tone', {'vibrance': 0}, (0, 0), 1)
        vivid = engine.changed_tile(tile, 'tone', {'vibrance': 100}, (0, 0), 1)
        legacy_pixels = np.asarray(legacy)
        vivid_pixels = np.asarray(vivid)
        np.testing.assert_array_equal(np.asarray(zero), legacy_pixels)
        np.testing.assert_array_equal(vivid_pixels[0, :3], legacy_pixels[0, :3])
        self.assertGreater(vivid_pixels[0, 3, :3].max() - vivid_pixels[0, 3, :3].min(),
                           legacy_pixels[0, 3, :3].max() - legacy_pixels[0, 3, :3].min())
        weights = np.array([.3, .59, .11])
        before = np.dot(legacy_pixels[0, 3, :3], weights)
        after = np.dot(vivid_pixels[0, 3, :3], weights)
        self.assertLessEqual(abs(after - before), 1)
        for item in (tile, legacy, zero, vivid):
            item.close()

    def test_new_fields_validate_and_airbrush_region_matches_full_render(self):
        valid = make_layer('paint', strokes=[{
            'points': [[48, 82], [72, 86]], 'radius': 11, 'hardness': .35,
            'flow': .16, 'opacity': .8, 'color': '#e86a75', 'brush': 'airbrush',
        }])
        invalid_strokes = [
            {**valid['strokes'][0], 'brush': 'mystery'},
            {**valid['strokes'][0], 'flow': True},
            {**valid['strokes'][0], 'flow': 1.1},
            {**valid['strokes'][0], 'flow': '0.5'},
            {**valid['strokes'][0], 'radius': 0},
            {**valid['strokes'][0], 'radius': 801},
        ]
        for stroke in invalid_strokes:
            with self.subTest(stroke=stroke):
                with self.assertRaises(ValueError):
                    engine.validate_side({'layers': [make_layer('paint', strokes=[stroke])]})
        with self.assertRaises(ValueError):
            engine.validate_side({'layers': [make_layer('clone', strokes=[valid['strokes'][0]])]})
        with self.assertRaises(ValueError):
            engine.validate_side({'layers': [make_layer('paint', mask={
                'base': 1, 'strokes': [{**valid['strokes'][0]}],
            })]})
        for value in (True, '25', float('nan'), -101, 101):
            with self.subTest(vibrance=value):
                with self.assertRaises(ValueError):
                    engine.validate_side({'layers': [make_layer('tone', params={'vibrance': value})]})

        full = self.render([valid])
        region = self.render([valid], region=(45, 75, 35, 30))
        np.testing.assert_allclose(np.asarray(region), np.asarray(full.crop((45, 75, 80, 105))), atol=1)
        full.close()
        region.close()

    def test_airbrush_long_and_repeated_strokes_match_region_crop(self):
        stroke = {
            'radius': 18, 'hardness': .25, 'flow': .18, 'opacity': .85,
            'color': '#e86a75', 'brush': 'airbrush',
        }
        layer = make_layer('paint', params={'mode': 'color'}, strokes=[
            {**stroke, 'points': [[-40, 90], [160, 90]]},
            {**stroke, 'points': [[42, 92]]},
            {**stroke, 'points': [[42, 92]]},
            {**stroke, 'points': [[48, 116], [82, 64]]},
        ])
        region_box = (55, 75, 30, 35)
        full = self.render([layer])
        region = self.render([layer], region=region_box)
        expected = full.crop((region_box[0], region_box[1],
                              region_box[0] + region_box[2], region_box[1] + region_box[3]))
        np.testing.assert_allclose(np.asarray(region), np.asarray(expected), atol=1)
        full.close()
        region.close()
        expected.close()

    def test_all_five_liquify_modes_and_freeze_mask(self):
        for mode in ['push', 'expand', 'shrink', 'clockwise', 'counterclockwise']:
            layer = make_layer('liquify', strokes=[{
                'points': [[42, 85], [62, 85]], 'radius': 30, 'strength': .8, 'mode': mode,
            }], params={'mode': mode, 'strength': .8})
            engine.validate_side({'layers': [layer]})
            result = self.render([layer])
            self.assertFalse(np.array_equal(np.asarray(result), np.asarray(self.source)), mode)
            result.close()
            layer['mask'] = {'base': 0, 'strokes': []}
            frozen = self.render([layer])
            np.testing.assert_array_equal(np.asarray(frozen), np.asarray(self.source), mode)
            frozen.close()

    def test_texture_is_stable_and_document_coordinate_based(self):
        layer = make_layer('texture', opacity=.25, params={'scale': 30, 'octaves': 3, 'decay': .4, 'seed': 17})
        full = self.render([layer])
        repeat = self.render([layer])
        np.testing.assert_array_equal(np.asarray(full), np.asarray(repeat))
        patch = self.render([layer], region=(20, 40, 50, 60))
        np.testing.assert_allclose(np.asarray(patch), np.asarray(full.crop((20, 40, 70, 100))), atol=1)
        full.close()
        repeat.close()
        patch.close()

    def test_detail_matches_full_render(self):
        layers = [
            make_layer('tone', params={'brightness': 4}),
            make_layer('blur', params={'radius': 3}),
            make_layer('liquify', strokes=[{
                'points': [[42, 85], [62, 85]], 'radius': 30, 'strength': .5, 'mode': 'push',
            }]),
            make_layer('sharpen', params={'radius': 2, 'amount': 100}),
        ]
        full = self.render(layers)
        detail = self.render(layers, region=(30, 50, 50, 60))
        np.testing.assert_allclose(np.asarray(detail), np.asarray(full.crop((30, 50, 80, 110))), atol=1)
        full.close()
        detail.close()

    def test_mask_brush_crop_consistency(self):
        layer = make_layer('tone', mask={
            'base': 0,
            'strokes': [{'points': [[40, 80], [65, 85]], 'radius': 20, 'hardness': .2, 'opacity': 1}],
        })
        full = engine.mask_image(layer, (128, 192), 1, (0, 0))
        patch = engine.mask_image(layer, (35, 40), 1, (45, 60))
        np.testing.assert_allclose(np.asarray(patch), np.asarray(full.crop((45, 60, 80, 100))), atol=2)
        full.close()
        patch.close()

    def test_tile_boundary_has_no_filter_seam(self):
        rng = np.random.default_rng(4)
        image = Image.fromarray(rng.integers(0, 256, (96, 900, 4), dtype='uint8'))
        image.putalpha(255)
        self.raw = png_bytes(image)
        layer = make_layer('sharpen', params={'radius': 4, 'amount': 100, 'threshold': 0})
        result = self.render([layer])
        expected = image.filter(engine.ImageFilter.UnsharpMask(4, 100, 0))
        np.testing.assert_allclose(np.asarray(result)[:, 755:782], np.asarray(expected)[:, 755:782], atol=1)
        image.close()
        result.close()
        expected.close()


class CanvasRetouchRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.output_dir = Path(self.temp.name)
        y, x = np.mgrid[:192, :128]
        pixels = np.stack(
            [x * 2, y, np.mod(x * 5 + y * 7, 255), np.full_like(x, 255)],
            axis=2,
        ).astype('uint8')
        pixels[:4, :, 3] = 0
        self.source = Image.fromarray(pixels, 'RGBA')
        self.source_bytes = png_bytes(self.source)
        other = Image.new('RGBA', (100, 80), (20, 80, 140, 255))
        self.other_bytes = png_bytes(other)
        other.close()
        self.inputs = {
            '/canvas-imports/original.png': self.source_bytes,
            'canvas_imports/original.png': self.source_bytes,
            '/image/other.png': self.other_bytes,
        }
        self.read_calls = []
        self.saved = []
        self.save_calls = []

        def read_source(source):
            self.read_calls.append(source)
            if source not in self.inputs:
                raise FileNotFoundError('private local path must not leak')
            return self.inputs[source]

        def save_image(raw, prefix='canvas_import_retouch', category='retouch', session_id=None):
            path = self.output_dir / (prefix + '-' + str(len(self.saved)) + '.png')
            path.write_bytes(raw)
            self.saved.append(path)
            self.save_calls.append((prefix, category, session_id))
            return '/image/' + path.name, path.name

        self.app = Flask(__name__)
        self.app.testing = True
        self.controller = register_canvas_retouch_routes(self.app, read_source, save_image)
        self.client = self.app.test_client()
        self.payload = {'source': '/canvas-imports/original.png', 'layers': []}

    def tearDown(self):
        self.source.close()
        self.temp.cleanup()

    def post(self, route, body):
        return self.client.post(route, json=body)

    def read_png(self, response):
        return Image.open(io.BytesIO(response.data))

    def wait_for_job(self, job_id, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            response = self.client.get('/api/canvas/retouch/jobs/' + job_id)
            if response.status_code == 404:
                self.fail('job disappeared before polling completed')
            job = response.get_json()['job']
            self.assertGreaterEqual(job['progress'], 0)
            self.assertLessEqual(job['progress'], 1)
            if job['status'] != 'running':
                return job
            time.sleep(.01)
        self.fail('retouch job did not finish in time')

    def test_preview_mask_and_clamped_detail_endpoints(self):
        preview = self.post('/api/canvas/retouch/preview', {
            **self.payload,
            'layers': [make_layer('tone', params={'brightness': 10})],
        })
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, 'image/png')
        with self.read_png(preview) as image:
            self.assertEqual(image.size, (128, 192))
            self.assertTrue(image.info.get('icc_profile'))

        mask_layer = make_layer(
            'tone', mask={'base': 1, 'strokes': [], 'shape': {'kind': 'rect', 'box': [20, 20, 70, 80]}},
        )
        mask = self.post('/api/canvas/retouch/mask', {
            **self.payload, 'layers': [mask_layer], 'layerId': mask_layer['id'],
        })
        self.assertEqual(mask.status_code, 200)
        with self.read_png(mask) as image:
            self.assertEqual(image.mode, 'L')
            self.assertEqual(image.getpixel((40, 40)), 255)
            self.assertEqual(image.getpixel((100, 100)), 0)

        detail = self.post('/api/canvas/retouch/detail', {
            **self.payload, 'layers': [make_layer('tone', params={'brightness': 30})],
            'x': 999, 'y': -5, 'original': True,
        })
        self.assertEqual(detail.status_code, 200)
        with self.read_png(detail) as image:
            self.assertEqual(image.size, (1, 192))
            np.testing.assert_array_equal(np.asarray(image), np.asarray(self.source)[:, 127:128])

    def test_missing_image_dependency_returns_service_unavailable(self):
        original_import = builtins.__import__

        def without_retouch_package(name, *args, **kwargs):
            if name == 'naim.images':
                raise ModuleNotFoundError("No module named 'numpy'")
            return original_import(name, *args, **kwargs)

        with mock.patch('builtins.__import__', side_effect=without_retouch_package):
            response = self.post('/api/canvas/retouch/preview', self.payload)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.get_json()['status'], 'error')
        self.assertEqual(response.get_json()['message'], response.get_json()['error'])
        self.assertIn('이미지 모듈이 없습니다', response.get_json()['message'])

    def test_pixel_endpoints_return_retryable_409_while_apply_is_active(self):
        cases = [
            ('/api/canvas/retouch/preview', self.payload),
            ('/api/canvas/retouch/mask', {**self.payload, 'layers': [make_layer('tone')], 'layerId': 'test-tone'}),
            ('/api/canvas/retouch/detail', {**self.payload, 'x': 0, 'y': 0}),
            ('/api/canvas/retouch/export-pair', {
                **self.payload, 'otherSource': '/image/other.png', 'side': 'front',
            }),
        ]
        self.controller.apply_lock.acquire()
        try:
            for route, body in cases:
                with self.subTest(route=route, owner='apply'):
                    response = self.post(route, body)
                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(response.get_json()['status'], 'error')
                    self.assertIn('다시 시도', response.get_json()['message'])
        finally:
            self.controller.apply_lock.release()

        self.controller.render_lock.acquire()
        try:
            for route, body in cases + [('/api/canvas/retouch/apply', self.payload)]:
                with self.subTest(route=route, owner='render'):
                    response = self.post(route, body)
                    self.assertEqual(response.status_code, 409)
        finally:
            self.controller.render_lock.release()
        self.assertFalse(self.controller.apply_lock.locked())
        self.assertEqual(self.read_calls, [])

    def test_exif_orientation_dimensions_and_srgb_profile_are_normalized(self):
        oriented = Image.new('RGB', (80, 40), (80, 120, 160))
        exif = Image.Exif()
        exif[274] = 6
        stream = io.BytesIO()
        oriented.save(stream, format='JPEG', exif=exif, icc_profile=engine.SRGB, quality=95)
        oriented.close()
        self.inputs['/canvas-imports/oriented.jpg'] = stream.getvalue()

        response = self.post('/api/canvas/retouch/preview', {
            'source': '/canvas-imports/oriented.jpg', 'layers': [],
        })
        self.assertEqual(response.status_code, 200)
        with self.read_png(response) as image:
            self.assertEqual(image.size, (40, 80))
            self.assertEqual(image.info.get('icc_profile'), engine.SRGB)

        apply_response = self.post('/api/canvas/retouch/apply', {
            'source': '/canvas-imports/oriented.jpg', 'layers': [], 'print': {'widthCm': 10},
        })
        self.assertEqual(apply_response.status_code, 202)
        job = self.wait_for_job(apply_response.get_json()['job']['id'])
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(self.save_calls, [('canvas_import_retouch', 'retouch', None)])
        with Image.open(self.saved[-1]) as image:
            self.assertEqual(image.size, (40, 80))
            self.assertAlmostEqual(image.info['dpi'][0], 40 / (10 / 2.54), places=1)

    def test_detail_is_the_same_as_full_render_crop(self):
        layers = [make_layer('tone', params={'brightness': 8}), make_layer('blur', params={'radius': 2})]
        full = self.post('/api/canvas/retouch/preview', {**self.payload, 'layers': layers})
        detail = self.post('/api/canvas/retouch/detail', {
            **self.payload, 'layers': layers, 'x': 30, 'y': 50,
        })
        with self.read_png(full) as full_image, self.read_png(detail) as detail_image:
            np.testing.assert_allclose(
                np.asarray(detail_image), np.asarray(full_image.crop((30, 50, 128, 192))), atol=1,
            )

    def test_malformed_layers_shapes_modes_points_and_limits_are_400(self):
        cases = [
            {'layers': {}},
            {'layers': [make_layer('unknown')]},
            {'layers': [make_layer('tone', id='x' * 101)]},
            {'layers': [make_layer('tone', params={'mode': 'remote'})]},
            {'layers': [make_layer('liquify', strokes=[{'mode': 'unknown', 'points': []}])]},
            {'layers': [make_layer('tone', mask={'base': 1, 'strokes': [], 'shape': {'kind': 'poly', 'box': [1, 1, 2, 2]}})]},
            {'layers': [make_layer('tone', mask={'base': 1, 'strokes': [], 'shape': {'kind': 'rect', 'box': [2, 1, 1, 3]}})]},
            {'layers': [make_layer('paint', strokes=[{'points': [[float('nan'), 0]]}])]},
            {'layers': [make_layer('tone'), make_layer('blur', id='test-tone')]},
            {'layers': [make_layer('tone') for _ in range(41)]},
            {'layers': [make_layer('paint', strokes=[{'points': [[1, 2]] * 100001}])]},
            {'layers': [make_layer('paint', strokes=[{'points': []} for _ in range(5001)])]},
        ]
        for case in cases:
            with self.subTest(case=case):
                response = self.post('/api/canvas/retouch/preview', {**self.payload, **case})
                self.assertEqual(response.status_code, 400)

        missing = self.post('/api/canvas/retouch/mask', {**self.payload, 'layerId': 'missing'})
        self.assertEqual(missing.status_code, 400)

    def test_nonfinite_and_invalid_print_values_are_400(self):
        nonfinite = self.post('/api/canvas/retouch/preview', {
            **self.payload, 'layers': [make_layer('tone', params={'brightness': float('inf')})],
        })
        self.assertEqual(nonfinite.status_code, 400)
        bad_print = self.post('/api/canvas/retouch/apply', {**self.payload, 'print': {'widthCm': 'many'}})
        self.assertEqual(bad_print.status_code, 400)
        nan_print = self.post('/api/canvas/retouch/apply', {**self.payload, 'print': {'heightCm': float('nan')}})
        self.assertEqual(nan_print.status_code, 400)
        self.assertEqual(self.saved, [])

    def test_source_paths_are_restricted_and_errors_hide_local_details(self):
        for source in ['https://foreign.example/image/a.png', '//foreign.example/a.png', 'C:/private/a.png', '/other/a.png']:
            with self.subTest(source=source):
                response = self.post('/api/canvas/retouch/preview', {**self.payload, 'source': source})
                self.assertEqual(response.status_code, 400)
        before = len(self.read_calls)
        response = self.post('/api/canvas/retouch/preview', {
            **self.payload, 'source': '/canvas-imports/missing.png',
        })
        self.assertEqual(response.status_code, 400)
        self.assertNotIn('private local path', response.get_data(as_text=True))
        self.assertEqual(len(self.read_calls), before + 1)

    def test_data_uri_and_local_input_size_and_pixel_limits(self):
        encoded = __import__('base64').b64encode(self.source_bytes).decode('ascii')
        response = self.post('/api/canvas/retouch/preview', {
            'source': 'data:image/png;base64,' + encoded, 'layers': [],
        })
        self.assertEqual(response.status_code, 200)
        too_large = self.post('/api/canvas/retouch/preview', {
            **self.payload, 'source': 'data:image/gif;base64,AAAA',
        })
        self.assertEqual(too_large.status_code, 400)
        oversized_header = b'\x89PNG\r\n\x1a\n' + b'\x00\x00\x00\x0dIHDR' + (160001).to_bytes(4, 'big') + (1000).to_bytes(4, 'big') + b'\x08\x06\x00\x00\x00' + b'not decoded'
        self.inputs['/canvas-imports/oversized.png'] = oversized_header
        oversized = self.post('/api/canvas/retouch/preview', {
            **self.payload, 'source': '/canvas-imports/oversized.png',
        })
        self.assertEqual(oversized.status_code, 400)

    def test_async_apply_saves_full_png_with_srgb_and_print_dpi(self):
        layer = make_layer('tone', params={'brightness': 10})
        response = self.post('/api/canvas/retouch/apply', {
            **self.payload, 'layers': [layer], 'print': {'widthCm': 10, 'heightCm': 15, 'safeMm': 8},
        })
        self.assertEqual(response.status_code, 202)
        job_data = response.get_json()['job']
        self.assertEqual(job_data['status'], 'running')
        self.assertEqual(response.get_json()['status'], 'success')
        self.assertNotIn('source', job_data)
        job = self.wait_for_job(job_data['id'])
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(len(self.saved), 1)
        self.assertEqual(self.save_calls, [('canvas_import_retouch', 'retouch', None)])
        result = job['result']
        self.assertEqual((result['width'], result['height']), (128, 192))
        self.assertEqual(result['src'], '/image/' + self.saved[0].name)
        with Image.open(self.saved[0]) as image:
            self.assertEqual(image.size, (128, 192))
            self.assertTrue(image.info.get('icc_profile'))
            self.assertAlmostEqual(image.info['dpi'][0], 128 / (10 / 2.54), places=1)
            self.assertNotEqual(image.getpixel((60, 80)), self.source.getpixel((60, 80)))

    def test_frontend_shaped_liquify_layer_previews_and_applies(self):
        layer = make_layer(
            'liquify',
            params={'mode': 'push', 'strength': .35},
            mask={'base': 1, 'strokes': []},
            strokes=[{
                'points': [[42, 85], [62, 85]],
                'radius': 30,
                'hardness': .3,
                'opacity': 1,
                'color': '#e6baa4',
                'mode': 'push',
                'strength': .35,
            }],
        )
        preview = self.post('/api/canvas/retouch/preview', {**self.payload, 'layers': [layer]})
        self.assertEqual(preview.status_code, 200, preview.get_json(silent=True))
        with self.read_png(preview) as image:
            self.assertEqual(image.size, (128, 192))

        response = self.post('/api/canvas/retouch/apply', {**self.payload, 'layers': [layer]})
        self.assertEqual(response.status_code, 202)
        job = self.wait_for_job(response.get_json()['job']['id'])
        self.assertEqual(job['status'], 'done', job)
        self.assertEqual(self.save_calls, [('canvas_import_retouch', 'retouch', None)])
        unknown = self.client.get('/api/canvas/retouch/jobs/not-a-job')
        self.assertEqual(unknown.status_code, 404)

    def test_apply_busy_and_render_failure_do_not_write(self):
        entered = threading.Event()
        release = threading.Event()
        original_render = engine.render

        def blocked_render(*args, **kwargs):
            entered.set()
            release.wait(2)
            return original_render(*args, **kwargs)

        with mock.patch.object(engine, 'render', side_effect=blocked_render):
            first = self.post('/api/canvas/retouch/apply', self.payload)
            self.assertEqual(first.status_code, 202)
            self.assertTrue(entered.wait(1))
            second = self.post('/api/canvas/retouch/apply', self.payload)
            self.assertEqual(second.status_code, 409)
            release.set()
            job = self.wait_for_job(first.get_json()['job']['id'])
            self.assertEqual(job['status'], 'done')

        with mock.patch.object(engine, 'render', side_effect=RuntimeError('private path /secret')):
            failed = self.post('/api/canvas/retouch/apply', self.payload)
            self.assertEqual(failed.status_code, 202)
            job = self.wait_for_job(failed.get_json()['job']['id'])
            self.assertEqual(job['status'], 'error')
            self.assertNotIn('/secret', json.dumps(job))
        self.assertEqual(len(self.saved), 1)
        self.assertEqual(self.save_calls, [('canvas_import_retouch', 'retouch', None)])

    def test_export_pair_applies_layers_to_selected_side_and_keeps_other_merged_pixels(self):
        layer = make_layer('tone', params={'brightness': 15})
        response = self.post('/api/canvas/retouch/export-pair', {
            **self.payload,
            'layers': [layer],
            'otherSource': '/image/other.png',
            'side': 'front',
            'print': {'widthCm': 10, 'heightCm': 20, 'safeMm': 7},
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/zip')
        self.assertEqual(self.saved, [])
        with zipfile.ZipFile(io.BytesIO(response.data)) as bundle:
            self.assertEqual(set(bundle.namelist()), {'daki-front.png', 'daki-back.png', 'print-info.json'})
            front_data = bundle.read('daki-front.png')
            back_data = bundle.read('daki-back.png')
            metadata = json.loads(bundle.read('print-info.json'))
        with Image.open(io.BytesIO(front_data)) as front:
            self.assertEqual(front.size, (128, 192))
            self.assertTrue(front.info.get('icc_profile'))
            self.assertAlmostEqual(front.info['dpi'][0], 128 / (10 / 2.54), places=1)
            self.assertNotEqual(front.getpixel((60, 80)), self.source.getpixel((60, 80)))
        with Image.open(io.BytesIO(back_data)) as back:
            self.assertEqual(back.size, (100, 80))
            self.assertTrue(back.info.get('icc_profile'))
            self.assertAlmostEqual(back.info['dpi'][0], 100 / (10 / 2.54), places=1)
            self.assertEqual(back.getpixel((50, 40)), (20, 80, 140, 255))
        self.assertEqual(metadata, {
            'widthCm': 10, 'heightCm': 20, 'safeMm': 7, 'guides_included': False,
        })


if __name__ == '__main__':
    unittest.main()
