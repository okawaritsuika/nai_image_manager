import unittest
from unittest import mock

import numpy as np
from PIL import Image

from naim.images import retouch as engine


def reference_vibrance_adjust(c, amount):
    """Original reduction-based formula retained here as a small test oracle."""
    weights = np.array([.3, .59, .11], dtype=np.float32)
    luma = (c * weights).sum(axis=2, keepdims=True)
    saturation = c.max(axis=2, keepdims=True) - c.min(axis=2, keepdims=True)
    factor = 1 + amount / 100 * (1 - saturation)
    c = luma + (c - luma) * factor
    minimum = c.min(axis=2, keepdims=True)
    maximum = c.max(axis=2, keepdims=True)
    c = np.where(minimum < 0, luma + (c - luma) * np.clip(luma, 0, 1)
                 / np.maximum(luma - minimum, 1e-6), c)
    c = np.where(maximum > 1, luma + (c - luma) * (1 - np.clip(luma, 0, 1))
                 / np.maximum(maximum - luma, 1e-6), c)
    return np.clip(c, 0, 1)


class VibranceCompatibilityTests(unittest.TestCase):
    def test_rgb_direct_formula_matches_reference_for_float_dtypes_and_boundaries(self):
        rng = np.random.default_rng(97)
        random_rgb = rng.uniform(-.5, 1.5, size=(97, 83, 3))
        boundary_rgb = np.array([
            [0, 0, 0], [.5, .5, .5], [1, 1, 1],
            [1, 0, 0], [0, 1, 0], [0, 0, 1],
            [1, 1, 0], [1, 0, 1], [0, 1, 1],
            [-.5, .2, .2], [1.5, .5, .5], [-.5, 1.5, 1.0],
        ], dtype=np.float64).reshape(1, -1, 3)

        for dtype in (np.float32, np.float64):
            for data_name, data in (('random', random_rgb), ('grayscale and gamut edges', boundary_rgb)):
                for amount in (-100, -30, 0, 18, 100):
                    with self.subTest(dtype=dtype.__name__, data=data_name, amount=amount):
                        original = data.astype(dtype, copy=True)
                        actual = engine.vibrance_adjust(original.copy(), amount)
                        expected = reference_vibrance_adjust(original.copy(), amount)
                        np.testing.assert_array_equal(actual, expected)

    def test_tone_tile_matches_reference_vibrance_and_preserves_rgba_alpha(self):
        y, x = np.indices((97, 83), dtype=np.uint16)
        pixels = np.stack((x * 11 % 256, y * 7 % 256, (x * 3 + y * 13) % 256,
                           (x * 29 + y * 17) % 256), axis=2).astype(np.uint8)
        source = Image.fromarray(pixels, 'RGBA')
        try:
            for vibrance in (-100, 68):
                params = {
                    'brightness': 18,
                    'contrast': -17,
                    'saturation': 24,
                    'shadows': -13,
                    'highlights': 16,
                    'vibrance': vibrance,
                }
                with self.subTest(vibrance=vibrance):
                    with engine.changed_tile(source, 'tone', params, (0, 0), 1) as actual:
                        with mock.patch.object(engine, 'vibrance_adjust', side_effect=reference_vibrance_adjust):
                            with engine.changed_tile(source, 'tone', params, (0, 0), 1) as expected:
                                np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                        np.testing.assert_array_equal(np.asarray(actual)[..., 3], pixels[..., 3])
        finally:
            source.close()


if __name__ == '__main__':
    unittest.main()
