import os
import tempfile
import unittest
from unittest import mock

from PIL import Image

import upscale_logic


class UpscaleLogicTests(unittest.TestCase):
    def test_large_model_downsize_skips_native_scale_and_model_assets(self):
        for engine in ('illustrationjanai', 'animesharp'):
            with self.subTest(engine=engine), \
                 mock.patch.object(upscale_logic, 'get_image_size', return_value=(5000, 16000)), \
                 mock.patch.object(upscale_logic, 'run_lanczos_only', return_value={'engine': 'lanczos'}) as resize, \
                 mock.patch('naim.upscale_assets.UPSCALE_ASSETS.use') as assets, \
                 mock.patch('naim.images.model_upscale.run_model_upscale') as model:
                result = upscale_logic.run_upscale('synthetic.png', 'result.png', 2500, 8000, engine=engine)
                self.assertEqual(result['engine'], 'lanczos')
                resize.assert_called_once_with('synthetic.png', 'result.png', 2500, 8000, None, None)
                assets.assert_not_called()
                model.assert_not_called()

    def test_model_downsize_writes_requested_size_preserves_alpha_and_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = os.path.join(temporary, 'source.png')
            target = os.path.join(temporary, 'result.png')
            Image.new('RGBA', (160, 512), (30, 60, 90, 128)).save(source)
            with open(source, 'rb') as stream:
                original = stream.read()
            for engine in ('illustrationjanai', 'animesharp'):
                with self.subTest(engine=engine), \
                     mock.patch('naim.upscale_assets.UPSCALE_ASSETS.use') as assets:
                    result = upscale_logic.run_upscale(source, target, 80, 256, engine=engine)
                    self.assertEqual(result['stages'], [])
                    with Image.open(target) as output:
                        self.assertEqual(output.size, (80, 256))
                        self.assertEqual(output.mode, 'RGBA')
                        self.assertEqual(output.getpixel((40, 128))[3], 128)
                    with open(source, 'rb') as stream:
                        self.assertEqual(stream.read(), original)
                    assets.assert_not_called()

    def test_models_still_run_if_either_dimension_grows_or_size_is_unchanged(self):
        for engine in ('illustrationjanai', 'animesharp'):
            for target in ((128, 256), (80, 64), (64, 256), (64, 128)):
                with self.subTest(engine=engine, target=target), \
                     mock.patch.object(upscale_logic, 'get_image_size', return_value=(64, 128)), \
                     mock.patch('naim.upscale_assets.UPSCALE_ASSETS.use') as assets, \
                     mock.patch('naim.images.model_upscale.run_model_upscale', return_value={'engine': engine}) as model:
                    result = upscale_logic.run_upscale('synthetic.png', 'result.png', *target, engine=engine)
                    self.assertEqual(result['engine'], engine)
                    assets.assert_called_once_with(engine)
                    model.assert_called_once()

    def test_model_downsize_keeps_cancellation_and_target_limits(self):
        import threading
        from naim.processes import UpscaleCancelled
        event = threading.Event()
        event.set()
        with mock.patch.object(upscale_logic, 'get_image_size', return_value=(5000, 16000)), \
             mock.patch('naim.upscale_assets.UPSCALE_ASSETS.use') as assets:
            with self.assertRaises(UpscaleCancelled):
                upscale_logic.run_upscale('synthetic.png', 'result.png', 2500, 8000,
                                          engine='animesharp', cancel_event=event)
            with self.assertRaisesRegex(ValueError, '130MP'):
                upscale_logic.run_upscale('synthetic.png', 'result.png', 20000, 20000,
                                          engine='animesharp')
            assets.assert_not_called()

    def test_supported_engines_keep_native_and_add_optional_backends(self):
        self.assertEqual(
            upscale_logic.SUPPORTED_UPSCALE_ENGINES,
            ("realcugan", "waifu2x", "lanczos", "illustrationjanai", "animesharp", "nai"),
        )
        self.assertEqual(upscale_logic.normalize_upscale_engine("waifu"), "waifu2x")
        self.assertEqual(upscale_logic.normalize_upscale_engine("waifu2x-ncnn-vulkan"), "waifu2x")

    def test_waifu2x_uses_native_two_or_four_times_scales(self):
        self.assertEqual(upscale_logic.choose_waifu2x_scale(1.5), 2)
        self.assertEqual(upscale_logic.choose_waifu2x_scale(3.0), 4)
        self.assertEqual(
            upscale_logic.build_waifu2x_stage_scales(100, 100, 300, 300, "standard"),
            [4],
        )

    def test_run_upscale_routes_waifu2x_engine(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            Image.new("RGBA", (16, 16), (255, 0, 0, 255)).save(source_path)

            def fake_waifu2x_runner(**kwargs):
                Image.new("RGBA", (32, 32), (0, 0, 255, 255)).save(kwargs["target_path"])
                return {
                    "engine": "waifu2x",
                    "final_width": kwargs["target_width"],
                    "final_height": kwargs["target_height"],
                }

            with mock.patch.object(
                upscale_logic,
                "run_waifu2x_upscale",
                side_effect=fake_waifu2x_runner,
            ) as runner:
                result = upscale_logic.run_upscale(
                    source_path=source_path,
                    target_path=target_path,
                    target_width=32,
                    target_height=32,
                    engine="waifu2x",
                    quality="standard",
                )

        self.assertEqual(result["engine"], "waifu2x")
        runner.assert_called_once()

    def test_fit_5_16_crops_after_scaling_and_preserves_original_dimensions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            source_image = Image.new("RGBA", (32, 64), (0, 0, 0, 255))
            for x in range(32):
                color = (255, 0, 0, 255) if x < 6 else (0, 0, 255, 255) if x < 26 else (0, 255, 0, 255)
                for y in range(64):
                    source_image.putpixel((x, y), color)
            source_image.save(source_path)
            with open(source_path, "rb") as source_file:
                original_bytes = source_file.read()

            result = upscale_logic.run_upscale(
                source_path=source_path,
                target_path=target_path,
                target_width=64,
                target_height=128,
                engine="lanczos",
                fit_5_16=True,
            )

            with Image.open(target_path) as output:
                self.assertEqual(output.size, (40, 128))
                self.assertEqual(output.getpixel((20, 64)), (0, 0, 255, 255))
            self.assertEqual((result["source_width"], result["source_height"]), (32, 64))
            self.assertEqual((result["final_width"], result["final_height"]), (40, 128))
            self.assertTrue(result["fit_5_16"])
            self.assertEqual(result["crop_box"], [12, 0, 52, 128])
            with open(source_path, "rb") as source_file:
                self.assertEqual(source_file.read(), original_bytes)

    def test_fit_5_16_uses_maximum_centered_integer_crop_for_tall_image(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            source_image = Image.new("RGBA", (16, 64), (0, 0, 255, 255))
            for y in range(64):
                color = (255, 0, 0, 255) if y < 8 else (0, 0, 255, 255) if y < 56 else (0, 255, 0, 255)
                for x in range(16):
                    source_image.putpixel((x, y), color)
            source_image.save(source_path)

            result = upscale_logic.run_upscale(
                source_path=source_path,
                target_path=target_path,
                target_width=64,
                target_height=256,
                engine="lanczos",
                fit_5_16=True,
            )

            with Image.open(target_path) as output:
                self.assertEqual(output.size, (60, 192))
                self.assertEqual(output.getpixel((30, 96)), (0, 0, 255, 255))
            self.assertEqual(result["crop_box"], [2, 32, 62, 224])

    def test_fit_5_16_keeps_an_already_matching_ratio(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            Image.new("RGBA", (20, 64), (10, 20, 30, 255)).save(source_path)

            result = upscale_logic.run_upscale(
                source_path=source_path,
                target_path=target_path,
                target_width=80,
                target_height=256,
                engine="lanczos",
                fit_5_16=True,
            )

            with Image.open(target_path) as output:
                self.assertEqual(output.size, (80, 256))
            self.assertEqual(result["crop_box"], [0, 0, 80, 256])

    def test_waifu2x_command_uses_bundled_cunet_model(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            engine_dir = os.path.join(temp_dir, "waifu2x")
            model_dir = os.path.join(engine_dir, "models-cunet")
            os.makedirs(model_dir)
            executable = os.path.join(engine_dir, "waifu2x-ncnn-vulkan.exe")
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            open(executable, "wb").close()
            Image.new("RGBA", (8, 8), (10, 20, 30, 255)).save(source_path)

            seen = {}

            def fake_process(cmd, cancel_event=None, cwd=None):
                seen["cmd"] = cmd
                seen["cwd"] = cwd
                Image.new("RGBA", (16, 16), (10, 20, 30, 255)).save(target_path)
                return 0, ""

            with mock.patch.object(upscale_logic, "WAIFU2X_EXE", executable), \
                 mock.patch.object(upscale_logic, "run_process_with_cancel", side_effect=fake_process):
                result = upscale_logic.run_waifu2x_once(
                    input_path=source_path,
                    output_path=target_path,
                    scale=2,
                    noise=-1,
                    tta=False,
                )

        self.assertEqual(result["scale"], 2)
        self.assertEqual(result["noise"], -1)
        self.assertIn("-m", seen["cmd"])
        self.assertIn(model_dir, seen["cmd"])
        self.assertEqual(seen["cwd"], engine_dir)

    def test_matching_png_target_is_copied_without_full_pixel_decode(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "target.png")
            Image.new("RGBA", (32, 64), (10, 20, 30, 255)).save(source_path)

            with mock.patch.object(Image.Image, "convert", side_effect=AssertionError("decoded")):
                upscale_logic.resize_to_target(source_path, target_path, 32, 64)

            self.assertTrue(os.path.exists(target_path))
            self.assertEqual(os.path.getsize(target_path), os.path.getsize(source_path))


if __name__ == "__main__":
    unittest.main()
