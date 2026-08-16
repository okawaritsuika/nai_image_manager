import os
import tempfile
import unittest
from unittest import mock

from PIL import Image

import upscale_logic


class UpscaleLogicTests(unittest.TestCase):
    def test_supported_engines_use_native_backends_only(self):
        self.assertEqual(
            upscale_logic.SUPPORTED_UPSCALE_ENGINES,
            ("realcugan", "waifu2x", "lanczos"),
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
