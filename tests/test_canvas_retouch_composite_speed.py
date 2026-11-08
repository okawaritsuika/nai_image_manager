import unittest

import numpy as np
from PIL import Image, ImageFilter

from naim.images import retouch
from naim.images.retouch import composite


class RetouchCompositeSpeedTests(unittest.TestCase):
    def test_full_opacity_rgba_mask_matches_float32_for_every_byte_tuple(self):
        values = np.arange(256, dtype=np.uint8)
        base_red = np.broadcast_to(values, (256, 256))
        changed_red = np.broadcast_to(values[:, None], (256, 256))
        base_pixels = np.stack((
            base_red,
            255 - base_red,
            (base_red.astype(np.uint16) + changed_red.astype(np.uint16)).astype(np.uint8),
            (base_red.astype(np.uint16) * 73 + changed_red.astype(np.uint16) * 19).astype(np.uint8),
        ), axis=2)
        changed_pixels = np.stack((
            changed_red,
            base_red,
            (base_red.astype(np.uint16) * 3 + changed_red.astype(np.uint16) * 7).astype(np.uint8),
            (changed_red.astype(np.uint16) * 41 + base_red.astype(np.uint16) * 13).astype(np.uint8),
        ), axis=2)

        with Image.fromarray(base_pixels, 'RGBA') as base, Image.fromarray(changed_pixels, 'RGBA') as changed:
            base_float = np.asarray(base, dtype=np.float32) / 255
            changed_float = np.asarray(changed, dtype=np.float32) / 255
            for mask_value in range(256):
                mask_pixels = np.full((256, 256), mask_value, dtype=np.uint8)
                with Image.fromarray(mask_pixels, 'L') as mask, composite(base, changed, mask) as result:
                    strength = mask_pixels.astype(np.float32) / 255
                    expected = base_float.copy()
                    expected[..., :3] += (changed_float[..., :3] - expected[..., :3]) * strength[..., None]
                    expected = np.clip(expected * 255 + .5, 0, 255).astype(np.uint8)
                    np.testing.assert_array_equal(np.asarray(result), expected)

    def test_full_mask_gaussian_restores_alpha_across_tile_boundary(self):
        rng = np.random.default_rng(405)
        pixels = rng.integers(0, 256, (48, 900, 4), dtype=np.uint8)
        source = Image.fromarray(pixels, 'RGBA')
        expected = source.filter(ImageFilter.GaussianBlur(2))
        expected.putalpha(source.getchannel('A'))
        layer = {
            'id': 'blur-speed', 'type': 'blur', 'opacity': 1,
            'params': {'radius': 2}, 'mask': {'base': 1, 'strokes': []},
        }

        try:
            retouch.apply_adjustment(source, layer, 1, (0, 0))
            np.testing.assert_array_equal(np.asarray(source), np.asarray(expected))
        finally:
            source.close()
            expected.close()


if __name__ == '__main__':
    unittest.main()
