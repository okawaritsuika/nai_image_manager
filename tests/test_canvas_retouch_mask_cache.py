import copy
import unittest
from unittest import mock

import numpy as np
from PIL import Image

from naim.images import retouch as engine


def make_layer(kind, **values):
    layer = {
        'id': 'mask-cache-' + kind,
        'type': kind,
        'visible': True,
        'opacity': 1,
        'mask': {'base': 1, 'strokes': []},
        'params': {},
        'strokes': [],
    }
    layer.update(values)
    return layer


def random_image(width, height, seed):
    pixels = np.random.default_rng(seed).integers(0, 256, (height, width, 4), dtype=np.uint8)
    return Image.fromarray(pixels, 'RGBA')


def prepared_mask_reference(image, layer, scale, origin):
    """Use the endpoint's full-size mask as the prepared-mask reference."""
    result = image.copy()
    mask = engine.mask_image(layer, image.size, scale, origin)
    try:
        engine.apply_adjustment(result, layer, scale, origin, prepared_mask=mask)
    except BaseException:
        result.close()
        raise
    finally:
        mask.close()
    return result


def assert_image_closed(test, image):
    with test.assertRaises(ValueError):
        image.getpixel((0, 0))


class RetouchMaskCacheTests(unittest.TestCase):
    def test_full_soft_mask_matches_prepared_reference_across_tiles_and_preserves_alpha(self):
        image = random_image(900, 128, 20261025)
        layer = make_layer('tone', opacity=.82, params={
            'brightness': 16, 'contrast': -7, 'saturation': 13,
        }, mask={
            'base': 0,
            'strokes': [
                {'points': [[690.25, 63.5], [735.75, 65.25]], 'radius': 28.75,
                 'hardness': .18, 'opacity': .67},
                {'points': [[750.5, 64.25]], 'radius': 15.35,
                 'hardness': .31, 'opacity': .79, 'erase': True},
                {'points': [[750.5, 64.25]], 'radius': 5.65,
                 'hardness': .8, 'opacity': .91},
            ],
            'shape': {'kind': 'rect', 'box': [50.25, 20.5, 880.5, 112.75]},
        })
        original = np.asarray(image).copy()
        before = copy.deepcopy(layer)
        expected = prepared_mask_reference(image, layer, 1, (0, 0))
        actual = image.copy()
        mask = engine.mask_image(layer, image.size, 1, (0, 0))
        try:
            mask_pixels = np.asarray(mask)
            self.assertGreater(int(mask_pixels.max()), 0)
            self.assertEqual(mask.getpixel((12, 12)), 0)
            self.assertEqual(mask.getpixel((200, 64)), 0, 'base-zero pixels inside the shape remain protected')
            engine._apply_layers(actual, [layer], 1, (0, 0), None)

            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(actual)[..., 3], original[..., 3])
            np.testing.assert_array_equal(np.asarray(actual)[12, 12], original[12, 12])
            y, x = np.unravel_index(np.argmax(mask_pixels), mask_pixels.shape)
            self.assertFalse(np.array_equal(np.asarray(actual)[y, x, :3], original[y, x, :3]))
            self.assertEqual(layer, before, 'mask cache preparation must not mutate the layer record')
        finally:
            image.close()
            expected.close()
            actual.close()
            mask.close()

    def test_nonzero_origin_and_quarter_scale_match_full_mask_reference(self):
        image = random_image(400, 240, 271828)
        origin = (300, 200)
        scale = .25
        layer = make_layer('color', opacity=.73, params={'color': '#efb48f', 'mode': 'soft-light'}, mask={
            'base': 0,
            'strokes': [
                {'points': [[1017.25, 641.5], [1068.75, 650.25]], 'radius': 31.5,
                 'hardness': .22, 'opacity': .76},
                {'points': [[1040.5, 647.25]], 'radius': 12.75,
                 'hardness': .4, 'opacity': .58, 'erase': True},
            ],
            'shape': {'kind': 'ellipse', 'box': [460.25, 320.5, 1819.75, 1079.5]},
        })
        original = np.asarray(image).copy()
        before = copy.deepcopy(layer)
        expected = prepared_mask_reference(image, layer, scale, origin)
        actual = image.copy()
        mask = engine.mask_image(layer, image.size, scale, origin)
        try:
            self.assertGreater(mask.getbbox()[2], mask.getbbox()[0])
            self.assertEqual(mask.getpixel((5, 5)), 0)
            engine._apply_layers(actual, [layer], scale, origin, None)

            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
            np.testing.assert_array_equal(np.asarray(actual)[..., 3], original[..., 3])
            self.assertEqual(layer, before)
        finally:
            image.close()
            expected.close()
            actual.close()
            mask.close()

    def test_blur_and_sharpen_keep_filter_halos_at_the_tile_boundary(self):
        for kind, params in (
            ('blur', {'radius': 5}),
            ('sharpen', {'radius': 4, 'amount': 130, 'threshold': 0}),
        ):
            with self.subTest(kind=kind):
                image = random_image(900, 80, 77)
                layer = make_layer(kind, opacity=.78, params=params, mask={
                    'base': 0,
                    'strokes': [{
                        'points': [[750.25, 39.5], [783.75, 41.25]], 'radius': 27.5,
                        'hardness': .36, 'opacity': .84,
                    }],
                })
                original = np.asarray(image).copy()
                before = copy.deepcopy(layer)
                actual = image.copy()
                mask = engine.mask_image(layer, image.size, 1, (0, 0))
                with engine.changed_tile(image, kind, params, (0, 0), 1) as changed:
                    expected = engine.composite(image, changed, mask, .78)
                try:
                    self.assertGreater(mask.getpixel((768, 40)), 0, 'the mask crosses the 768px tile edge')
                    engine._apply_layers(actual, [layer], 1, (0, 0), None)
                    np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
                    np.testing.assert_array_equal(np.asarray(actual)[..., 3], original[..., 3])
                    np.testing.assert_array_equal(np.asarray(actual)[0, 0], original[0, 0])
                    self.assertEqual(layer, before)
                finally:
                    image.close()
                    expected.close()
                    actual.close()
                    mask.close()

    def test_cache_reuses_equal_specs_across_unmasked_layers_and_closes_on_change(self):
        image = random_image(48, 36, 19)
        mask_a = {'base': 1, 'strokes': [{
            'points': [[12.25, 16.5]], 'radius': 10.75, 'hardness': .2,
            'opacity': .7, 'erase': True,
        }]}
        mask_b = {'base': 0, 'strokes': [{
            'points': [[30.5, 17.25]], 'radius': 8.5, 'hardness': .6,
            'opacity': .9,
        }]}
        layers = [
            make_layer('tone', params={'brightness': 8}, mask=copy.deepcopy(mask_a)),
            make_layer('tone', params={'contrast': 4}, mask={'base': 1, 'strokes': []}),
            make_layer('color', params={'color': '#d98d74'}, mask=copy.deepcopy(mask_a)),
            make_layer('sharpen', params={'radius': 1, 'amount': 80}, mask=copy.deepcopy(mask_b)),
            make_layer('tone', params={'brightness': 3}, mask=copy.deepcopy(mask_b)),
        ]
        before = copy.deepcopy(layers)
        created_prepared_masks = []
        real_mask_image = engine.mask_image

        def build_mask(layer, size, scale, origin, cache=None):
            spec = layer.get('mask', {})
            if spec == mask_b and created_prepared_masks:
                assert_image_closed(self, created_prepared_masks[-1])
            result = real_mask_image(layer, size, scale, origin, cache=cache)
            if spec.get('strokes') or spec.get('shape'):
                created_prepared_masks.append(result)
            return result

        actual = image.copy()
        try:
            with mock.patch.object(engine, 'mask_image', side_effect=build_mask) as build, \
                    mock.patch.object(engine, 'apply_adjustment', wraps=engine.apply_adjustment) as adjust:
                engine._apply_layers(actual, layers, 1, (0, 0), None)

            prepared = [call.kwargs['prepared_mask'] for call in adjust.call_args_list]
            self.assertEqual(len(prepared), 5)
            self.assertIs(prepared[0], prepared[2], 'equal masks share one prepared image across a plain layer')
            self.assertIsNone(prepared[1], 'an empty mask keeps the existing tile path')
            self.assertIs(prepared[3], prepared[4], 'the changed mask is reused by following equal layers')
            self.assertIsNot(prepared[0], prepared[3])
            self.assertEqual(build.call_count, 3, 'two prepared masks plus one empty per-tile mask')
            self.assertEqual(len(created_prepared_masks), 2)
            for prepared_mask in created_prepared_masks:
                assert_image_closed(self, prepared_mask)
            self.assertEqual(layers, before)
        finally:
            image.close()
            actual.close()

    def test_empty_mask_keeps_per_tile_mask_path(self):
        image = random_image(1537, 40, 2026)
        original = np.asarray(image).copy()
        layer = make_layer('tone', params={'brightness': 9}, mask={'base': 1, 'strokes': []})
        actual = image.copy()
        try:
            with mock.patch.object(engine, 'mask_image', wraps=engine.mask_image) as build, \
                    mock.patch.object(engine, 'apply_adjustment', wraps=engine.apply_adjustment) as adjust:
                engine._apply_layers(actual, [layer], 1, (0, 0), None)

            self.assertEqual(build.call_count, 3)
            self.assertEqual([call.args[1] for call in build.call_args_list], [(768, 40), (768, 40), (1, 40)])
            self.assertTrue(all(call.kwargs['prepared_mask'] is None for call in adjust.call_args_list))
            self.assertFalse(np.array_equal(np.asarray(actual)[..., :3], original[..., :3]))
            np.testing.assert_array_equal(np.asarray(actual)[..., 3], original[..., 3])
        finally:
            image.close()
            actual.close()

    def test_prepared_mask_is_closed_when_adjustment_raises(self):
        image = random_image(900, 64, 5)
        layer = make_layer('tone', params={'brightness': 10}, mask={
            'base': 0,
            'strokes': [{
                'points': [[42.5, 30.25]], 'radius': 16.75,
                'hardness': .3, 'opacity': .8,
            }],
        })
        created = []
        real_mask_image = engine.mask_image

        def track_mask(*args, **kwargs):
            result = real_mask_image(*args, **kwargs)
            created.append(result)
            return result

        try:
            with mock.patch.object(engine, 'mask_image', side_effect=track_mask), \
                    mock.patch.object(engine, 'changed_tile', side_effect=RuntimeError('synthetic filter failure')):
                with self.assertRaisesRegex(RuntimeError, 'synthetic filter failure'):
                    engine._apply_layers(image, [layer], 1, (0, 0), None)
            self.assertEqual(len(created), 1)
            assert_image_closed(self, created[0])
        finally:
            image.close()


if __name__ == '__main__':
    unittest.main()
