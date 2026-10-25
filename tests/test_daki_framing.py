import io
import json
import unittest

from PIL import Image
from naim.images.daki_framing import FRAMING_LIMITS, frame_image, framed_png_metadata, normalize_framing


class FramingTests(unittest.TestCase):
    def test_padding_preserves_rgba_pixels_and_centers_odd_surplus(self):
        with Image.new('RGBA', (2, 3), (10, 20, 30, 127)) as source:
            source.putpixel((1, 2), (40, 50, 60, 0))
            before = source.tobytes()
            result, layout = frame_image(source, {'width': 5, 'height': 8, 'mode': 'pad'})
            with result:
                self.assertEqual(result.mode, 'RGBA')
                self.assertEqual((layout['left'], layout['top']), (1, 2))
                self.assertEqual(result.crop((1, 2, 3, 5)).tobytes(), before)
                self.assertEqual(result.getpixel((0, 0)), (0, 0, 0, 0))
                self.assertEqual(result.getpixel((4, 7)), (0, 0, 0, 0))
                self.assertEqual(result.getpixel((2, 4)), (40, 50, 60, 0))
            self.assertEqual(source.tobytes(), before)

    def test_padding_same_size_is_a_distinct_lossless_image(self):
        with Image.new('RGBA', (3, 5), (15, 25, 35, 45)) as source:
            result, layout = frame_image(source, {'width': 3, 'height': 5, 'mode': 'pad'})
            with result:
                self.assertIsNot(result, source)
                self.assertEqual(result.tobytes(), source.tobytes())
                self.assertEqual(layout['scale'], 1)

    def test_cover_crops_horizontal_and_vertical_center_without_stretching(self):
        for size, target, marked, expected in (
                ((6, 4), (2, 4), (2, 1), (0, 1)),
                ((4, 6), (4, 2), (1, 2), (1, 0))):
            with self.subTest(size=size), Image.new('RGBA', size, 'blue') as source:
                source.putpixel(marked, (255, 0, 0, 255))
                result, layout = frame_image(source, dict(width=target[0], height=target[1], mode='cover'))
                with result:
                    self.assertEqual(result.size, target)
                    self.assertEqual(result.getpixel(expected), (255, 0, 0, 255))
                    self.assertEqual(layout['scale'], 1)
                    self.assertIsNone(result.getchannel('A').point(lambda p: 255 - p).getbbox())

    def test_cover_can_enlarge_or_reduce_and_keeps_fractional_center(self):
        with Image.new('RGB', (6, 4), 'red') as source:
            for width, height, scale, box in (
                    (12, 12, 3, [1, 0, 5, 4]),
                    (3, 4, 1, [1.5, 0, 4.5, 4]),
                    (1, 1, .25, [1, 0, 5, 4])):
                result, layout = frame_image(source, dict(width=width, height=height, mode='cover'))
                with result:
                    self.assertEqual(result.size, (width, height))
                    self.assertEqual(result.getpixel((0, 0)), (255, 0, 0, 255))
                    self.assertEqual(layout['scale'], scale)
                    self.assertEqual(layout['crop_box'], box)

    def test_validation_bounds_and_padding_never_remove_original_pixels(self):
        self.assertEqual(normalize_framing(dict(width=5000, height=16000, mode='pad'))['height'],
                         FRAMING_LIMITS['max'])
        for data in (None, [], {}, dict(width=True, height=1, mode='pad'),
                     dict(width=1.5, height=1, mode='cover'), dict(width='5', height=8, mode='pad'),
                     dict(width=0, height=3, mode='pad'), dict(width=16001, height=1, mode='pad'),
                     dict(width=5001, height=16000, mode='cover'), dict(width=3, height=5, mode='other')):
            with self.subTest(data=data), self.assertRaises(ValueError):
                normalize_framing(data)
        with Image.new('RGB', (3, 5)) as source:
            for width, height in ((2, 5), (3, 4)):
                with self.assertRaises(ValueError):
                    frame_image(source, dict(width=width, height=height, mode='pad'))

    def test_cover_roundoff_does_not_crop_outside_source_boundary(self):
        with Image.new('RGBA', (2, 7), 'blue') as source:
            result, layout = frame_image(source, dict(width=1, height=17, mode='cover'))
            with result:
                self.assertEqual(result.size, (1, 17))
                self.assertEqual(layout['crop_box'][1], 0)
                self.assertEqual(layout['crop_box'][3], 7)
                self.assertEqual(result.getpixel((0, 16)), (0, 0, 255, 255))

    def test_metadata_keeps_recipe_text_and_records_actual_dimensions(self):
        with Image.new('RGBA', (3, 5)) as source:
            original = {'width': 3, 'height': 5, 'seed': 123, 'model': 'synthetic model',
                        'prompt': 'synthetic ink', 'v4_prompt': {'caption': {'base_caption': 'synthetic ink'}}}
            source.info.update(Comment=json.dumps(original), Source='synthetic source', Description='synthetic text')
            result, layout = frame_image(source, dict(width=5, height=16, mode='pad'))
            with result, io.BytesIO() as stream:
                result.save(stream, format='PNG', pnginfo=framed_png_metadata(source, layout))
                stream.seek(0)
                with Image.open(stream) as reopened:
                    metadata = json.loads(reopened.info['Comment'])
                    self.assertEqual(metadata, {**original, 'width': 5, 'height': 16})
                    self.assertEqual(reopened.info['Source'], 'synthetic source')
                    self.assertEqual(reopened.info['Description'], 'synthetic text')
                    self.assertEqual(json.loads(reopened.info['NAIM Framing']), layout)
            self.assertEqual(json.loads(source.info['Comment']), original)


if __name__ == '__main__':
    unittest.main()
