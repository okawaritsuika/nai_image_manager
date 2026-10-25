import io
import unittest

from PIL import Image

from naim.images.inpaint_reference import (
    crop_reference_result,
    inject_split_screen,
    normalize_reference,
    prepare_reference_input,
    reference_crop_box,
    reference_fit_box,
)


class InpaintReferenceTests(unittest.TestCase):
    @staticmethod
    def png_bytes(image, **save_kwargs):
        output = io.BytesIO()
        image.save(output, format="PNG", **save_kwargs)
        return output.getvalue()

    @staticmethod
    def reference(**overrides):
        value = {"src": "/canvas-imports/reference.png"}
        value.update(overrides)
        return value

    def test_normalize_reference_defaults_and_detaches(self):
        self.assertIsNone(normalize_reference(None))
        original = self.reference()

        normalized = normalize_reference(original)

        self.assertEqual(normalized, {
            "src": "/canvas-imports/reference.png",
            "name": "참고 이미지",
            "width": 320,
            "x": 0.5,
            "y": 0.5,
            "zoom": 1.0,
        })
        original["src"] = "/canvas-imports/changed.png"
        self.assertEqual(normalized["src"], "/canvas-imports/reference.png")

    def test_normalize_reference_accepts_limits_and_rejects_invalid_values(self):
        self.assertEqual(normalize_reference(self.reference(width=1024, x=0, y=1, zoom=8))["width"], 1024)
        invalid_values = [
            [],
            {},
            self.reference(src="https://example.test/image.png"),
            self.reference(src="//example.test/image.png"),
            self.reference(src="/canvas-imports/"),
            self.reference(src="/canvas-imports/image.png?x=1"),
            self.reference(src="/canvas-imports/image.png#part"),
            self.reference(src="/canvas-imports\\image.png"),
            self.reference(src="/canvas-imports/../secret.png"),
            self.reference(src="/canvas-imports/%2e%2e/secret.png"),
            self.reference(src="/canvas-imports/%252e%252e/secret.png"),
            self.reference(src="/canvas-imports/a%2f..%2fsecret.png"),
            self.reference(src="/canvas-imports/%5c..%5csecret.png"),
            self.reference(src="/canvas-imports/" + ("a" * 4082)),
            self.reference(name=1),
            self.reference(name="n" * 501),
            self.reference(width=True),
            self.reference(width=63),
            self.reference(width=65),
            self.reference(width=1088),
            self.reference(x=True),
            self.reference(x=float("nan")),
            self.reference(y=float("inf")),
            self.reference(x=-0.01),
            self.reference(y=1.01),
            self.reference(zoom=False),
            self.reference(zoom=float("nan")),
            self.reference(zoom=0.99),
            self.reference(zoom=8.01),
        ]
        for value in invalid_values:
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "[가-힣]"):
                    normalize_reference(value)

    def test_reference_crop_box_uses_position_and_zoom(self):
        left = reference_crop_box((16, 8), (4, 8), {"x": 0, "y": 0.5, "zoom": 1})
        right = reference_crop_box((16, 8), (4, 8), {"x": 1, "y": 0.5, "zoom": 1})
        zoomed = reference_crop_box((16, 8), (4, 8), {"x": 0.5, "y": 0.5, "zoom": 2})
        self.assertEqual(left, (0, 0, 4, 8))
        self.assertEqual(right, (12, 0, 16, 8))
        self.assertEqual(zoomed, (7, 2, 9, 6))
        with self.assertRaises(ValueError):
            reference_crop_box((0, 8), (4, 8), {"x": 0.5, "y": 0.5, "zoom": 1})

    def test_reference_fit_box_shrinks_and_centers_without_upscaling(self):
        cases = (
            ((800, 800), (320, 768), (0, 224, 320, 320)),
            ((400, 200), (100, 100), (0, 25, 100, 50)),
            ((200, 400), (100, 100), (25, 0, 50, 100)),
            ((64, 64), (320, 768), (128, 352, 64, 64)),
            ((4, 3), (2, 2), (0, 0, 2, 2)),
            ((9, 2), (4, 5), (0, 2, 4, 1)),
            ((1, 10000), (64, 64), (31, 0, 1, 64)),
        )
        for source, target, expected in cases:
            with self.subTest(source=source, target=target):
                self.assertEqual(reference_fit_box(source, target), expected)
        for source, target in (((0, 8), (4, 8)), ((4, 8), (1.5, 8)), ((True, 8), (4, 8))):
            with self.subTest(source=source, target=target), self.assertRaises(ValueError):
                reference_fit_box(source, target)

    def test_prepare_input_fits_entire_reference_with_white_padding_and_black_mask(self):
        source = Image.new("RGB", (2, 2), (10, 20, 30))
        mask = Image.new("RGB", (2, 2))
        mask.putpixel((0, 0), (0, 0, 0))
        mask.putpixel((1, 0), (40, 50, 60))
        mask.putpixel((0, 1), (70, 80, 90))
        mask.putpixel((1, 1), (255, 255, 255))

        reference_image = Image.new("RGB", (128, 2), (255, 0, 0))
        for x in range(64, 128):
            for y in range(2):
                reference_image.putpixel((x, y), (0, 0, 255))
        result = prepare_reference_input(
            self.png_bytes(source),
            self.png_bytes(mask),
            self.png_bytes(reference_image),
            normalize_reference(self.reference(width=64, x=0.75)),
        )

        self.assertEqual((result["width"], result["height"]), (66, 2))
        self.assertEqual((result["sourceWidth"], result["referenceWidth"]), (2, 64))
        with Image.open(io.BytesIO(result["image"])) as combined:
            self.assertEqual(combined.size, (66, 2))
            self.assertEqual(combined.getpixel((8, 0)), (255, 0, 0))
            self.assertEqual(combined.getpixel((56, 0)), (0, 0, 255))
            self.assertEqual(combined.getpixel((32, 1)), (255, 255, 255))
            self.assertEqual(combined.getpixel((64, 0)), source.getpixel((0, 0)))
            self.assertEqual(combined.getpixel((65, 1)), source.getpixel((1, 1)))
        with Image.open(io.BytesIO(result["mask"])) as combined_mask:
            self.assertEqual(combined_mask.size, (66, 2))
            self.assertEqual(combined_mask.getpixel((0, 0)), (0, 0, 0))
            self.assertEqual(combined_mask.getpixel((63, 1)), (0, 0, 0))
            self.assertEqual(combined_mask.getpixel((64, 0)), mask.getpixel((0, 0)))
            self.assertEqual(combined_mask.getpixel((65, 1)), mask.getpixel((1, 1)))

    def test_prepare_input_preserves_all_edges_and_ignores_saved_crop(self):
        source = self.png_bytes(Image.new("RGB", (64, 128), (10, 20, 30)))
        mask = self.png_bytes(Image.new("RGB", (64, 128), "white"))
        for size, box in (((128, 64), (0, 48, 64, 32)),
                          ((64, 256), (16, 0, 32, 128)),
                          ((16, 16), (24, 56, 16, 16))):
            with self.subTest(size=size):
                image = Image.new("RGB", size, "red")
                image.paste("blue", (size[0] // 2, 0, size[0], size[1]))
                image_bytes = self.png_bytes(image)
                result = prepare_reference_input(source, mask, image_bytes,
                    normalize_reference(self.reference(width=64, x=0, y=1, zoom=8)))
                default = prepare_reference_input(source, mask, image_bytes,
                    normalize_reference(self.reference(width=64)))
                self.assertEqual(result["image"], default["image"])
                left, top, width, height = box
                with Image.open(io.BytesIO(result["image"])) as combined:
                    self.assertEqual(combined.getpixel((left, top)), (255, 0, 0))
                    self.assertEqual(combined.getpixel((left + width - 1, top + height - 1)), (0, 0, 255))
                    self.assertEqual(combined.getpixel((0, 0)), (255, 255, 255))
                    self.assertEqual(combined.getpixel((63, 127)), (255, 255, 255))
                    self.assertEqual(combined.getpixel((64, 0)), (10, 20, 30))

    def test_prepare_input_flattens_alpha_and_applies_exif_orientation(self):
        source = self.png_bytes(Image.new("RGB", (64, 128), (1, 2, 3)))
        mask = self.png_bytes(Image.new("RGB", (64, 128), (255, 255, 255)))

        transparent_reference = self.png_bytes(Image.new("RGBA", (4, 4), (255, 0, 0, 0)))
        alpha_result = prepare_reference_input(
            source, mask, transparent_reference, normalize_reference(self.reference(width=64))
        )
        with Image.open(io.BytesIO(alpha_result["image"])) as combined:
            self.assertEqual(combined.getpixel((32, 64)), (255, 255, 255))

        oriented = Image.new("RGB", (128, 64), (255, 0, 0))
        oriented.paste((0, 0, 255), (0, 32, 128, 64))
        exif = Image.Exif()
        exif[274] = 6
        oriented_bytes = self.png_bytes(oriented, exif=exif)
        orientation_result = prepare_reference_input(
            source, mask, oriented_bytes, normalize_reference(self.reference(width=64))
        )
        with Image.open(io.BytesIO(orientation_result["image"])) as combined:
            left_pixel = combined.getpixel((8, 64))
            right_pixel = combined.getpixel((56, 64))
            self.assertGreater(left_pixel[2], 215)
            self.assertLess(left_pixel[0], 40)
            self.assertGreater(right_pixel[0], 215)
            self.assertLess(right_pixel[2], 40)

    def test_prepare_input_rejects_source_mask_size_mismatch(self):
        source = self.png_bytes(Image.new("RGB", (2, 2), "white"))
        mask = self.png_bytes(Image.new("RGB", (3, 2), "black"))
        reference = self.png_bytes(Image.new("RGB", (2, 2), "red"))
        with self.assertRaisesRegex(ValueError, "크기"):
            prepare_reference_input(source, mask, reference, normalize_reference(self.reference()))

    def test_crop_result_removes_strip_and_rejects_wrong_size(self):
        generated = Image.new("RGB", (7, 3), (0, 255, 0))
        for y in range(3):
            for x in range(3, 7):
                generated.putpixel((x, y), (255, 128, 0))

        result = crop_reference_result(self.png_bytes(generated), (4, 3), 3)
        with Image.open(io.BytesIO(result)) as cropped:
            self.assertEqual(cropped.format, "PNG")
            self.assertEqual(cropped.size, (4, 3))
            self.assertEqual(cropped.tobytes(), bytes((255, 128, 0)) * 12)
        with self.assertRaisesRegex(ValueError, "크기"):
            crop_reference_result(self.png_bytes(Image.new("RGB", (6, 3))), (4, 3), 3)

    def test_inject_split_screen_is_idempotent_and_preserves_weighted_terms(self):
        existing = "cat, Split Screen, tree"
        weighted = "cat, split screen:1.2"
        self.assertEqual(inject_split_screen(existing), existing)
        self.assertEqual(inject_split_screen(weighted), f"split screen, {weighted}")
        self.assertEqual(inject_split_screen(""), "split screen")
        self.assertEqual(inject_split_screen("  "), "split screen")


if __name__ == "__main__":
    unittest.main()
