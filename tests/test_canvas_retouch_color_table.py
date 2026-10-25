import copy
import unittest

import numpy as np
from PIL import Image

from naim.images import retouch as engine


def make_color_layer(color, mode, opacity):
    return {
        'id': 'synthetic-color',
        'type': 'color',
        'name': 'synthetic color layer',
        'opacity': opacity,
        'visible': True,
        'mask': {'base': 1, 'strokes': []},
        'params': {'color': color, 'mode': mode},
        'strokes': [],
    }


def legacy_composite(base, layer, mask, scale=1, origin=(0, 0)):
    params = layer.get('params', {})
    mode = params.get('mode', 'normal')
    with engine.changed_tile(base, layer['type'], params, origin, scale) as changed:
        return engine.composite(base, changed, mask, layer.get('opacity', 1), mode)


class ColorTableTests(unittest.TestCase):
    def test_channel_independent_tables_match_compositor_for_all_values(self):
        y, x = np.indices((256, 256), dtype=np.uint16)
        pixels = np.empty((256, 256, 4), dtype=np.uint8)
        pixels[..., 0] = x
        pixels[..., 1] = (x * 73 + 19) % 256
        pixels[..., 2] = (x * 151 + 7) % 256
        pixels[..., 3] = (x * 31 + y * 17) % 256
        mask_values = y.astype(np.uint8)
        base = Image.fromarray(pixels, 'RGBA')
        mask = Image.fromarray(mask_values, 'L')
        source_before = base.tobytes()
        mask_before = mask.tobytes()
        colors = ('#000000', '#ffffff', '#ffe0cd', '#2f8ac4')
        try:
            for mode in ('normal', 'soft-light', 'multiply', 'screen'):
                for opacity in (0, .07, .5, 1):
                    for color in colors:
                        with self.subTest(mode=mode, opacity=opacity, color=color):
                            layer = make_color_layer(color, mode, opacity)
                            layer_before = copy.deepcopy(layer)
                            actual = base.copy()
                            try:
                                with legacy_composite(base, layer, mask) as expected:
                                    engine.apply_adjustment(
                                        actual, layer, 1, (0, 0), prepared_mask=mask,
                                    )
                                    np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                                self.assertEqual(layer, layer_before)
                                self.assertEqual(base.tobytes(), source_before)
                                self.assertEqual(mask.tobytes(), mask_before)
                                np.testing.assert_array_equal(np.asarray(actual)[..., 3], pixels[..., 3])
                            finally:
                                actual.close()
        finally:
            base.close()
            mask.close()

    def test_color_blend_and_tone_keep_the_existing_non_table_path(self):
        y, x = np.indices((19, 23), dtype=np.uint16)
        pixels = np.stack((x * 11 % 256, y * 13 % 256, (x * 5 + y * 7) % 256,
                           (x * 29 + y * 17) % 256), axis=2).astype(np.uint8)
        base = Image.fromarray(pixels, 'RGBA')
        mask_values = ((x * 17 + y * 23) % 256).astype(np.uint8)
        mask = Image.fromarray(mask_values, 'L')
        cases = (
            make_color_layer('#2f8ac4', 'color', .63),
            {
                'id': 'synthetic-tone', 'type': 'tone', 'name': 'synthetic tone',
                'opacity': .42, 'visible': True, 'mask': {'base': 1, 'strokes': []},
                'params': {'brightness': 11, 'contrast': -3, 'saturation': 7}, 'strokes': [],
            },
        )
        try:
            for layer in cases:
                with self.subTest(kind=layer['type'], mode=layer['params'].get('mode')):
                    self.assertIsNone(engine._color_table(layer))
                    actual = base.copy()
                    try:
                        with legacy_composite(base, layer, mask) as expected:
                            engine.apply_adjustment(actual, layer, 1, (0, 0), prepared_mask=mask)
                            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                        np.testing.assert_array_equal(np.asarray(actual)[..., 3], pixels[..., 3])
                    finally:
                        actual.close()
        finally:
            base.close()
            mask.close()

    def test_table_matches_legacy_composite_across_800_by_900_tile_boundaries(self):
        y, x = np.indices((900, 800), dtype=np.uint16)
        pixels = np.stack((x % 256, y % 256, (x * 3 + y * 5) % 256,
                           (x * 19 + y * 23) % 256), axis=2).astype(np.uint8)
        base = Image.fromarray(pixels, 'RGBA')
        mask = Image.fromarray(((x * 5 + y * 7) % 256).astype(np.uint8), 'L')
        base_before = base.tobytes()
        mask_before = mask.tobytes()
        layer = make_color_layer('#ffe0cd', 'soft-light', .5)
        layer_before = copy.deepcopy(layer)
        actual = base.copy()
        try:
            with legacy_composite(base, layer, mask) as expected:
                engine.apply_adjustment(actual, layer, 1, (0, 0), prepared_mask=mask)
                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(actual)[..., 3], pixels[..., 3])
            self.assertEqual(base.tobytes(), base_before)
            self.assertEqual(mask.tobytes(), mask_before)
            self.assertEqual(layer, layer_before)
        finally:
            actual.close()
            base.close()
            mask.close()


if __name__ == '__main__':
    unittest.main()
