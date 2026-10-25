import json
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageChops

from naim.images import model_upscale
from naim.processes import UpscaleCancelled
from naim import upscale_worker


class ModelUpscaleTests(unittest.TestCase):
    def test_rcan_retries_smaller_tiles_after_gpu_memory_failure(self):
        class SyntheticOOM(RuntimeError):
            pass
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(OutOfMemoryError=SyntheticOOM, empty_cache=mock.Mock()))
        result = Image.new('RGB', (16, 16))
        with mock.patch.object(upscale_worker, '_make_predictor', return_value=mock.Mock()), \
                mock.patch.object(upscale_worker, 'process_tiled_image',
                                  side_effect=[SyntheticOOM(), result]) as process:
            actual, tile = upscale_worker._infer_with_retries(
                Image.new('RGB', (8, 8)), None, fake_torch, None, None, 2, mock.Mock(),
                tile_sizes=upscale_worker._RCAN_TILE_SIZES)
        self.assertIs(actual, result)
        self.assertEqual(tile, 256)
        self.assertEqual([call.args[2] for call in process.call_args_list], [512, 256])
        fake_torch.cuda.empty_cache.assert_called_once()

    def test_progress_write_retries_a_temporary_windows_reader_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'progress.json'
            target.write_text('{"progress":1}')
            replace = upscale_worker.os.replace
            calls = []
            def briefly_locked(source, destination):
                calls.append(destination)
                if len(calls) == 1:
                    raise PermissionError('synthetic reader lock')
                return replace(source, destination)
            with mock.patch.object(upscale_worker.os, 'replace', side_effect=briefly_locked):
                upscale_worker._write_json_atomic(str(target), {'progress': 50})
            self.assertEqual(json.loads(target.read_text()), {'progress': 50})
            self.assertEqual(len(calls), 2)
            self.assertEqual(list(Path(folder).iterdir()), [target])

    def test_progress_write_does_not_hide_persistent_permission_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'progress.json'
            target.write_text('{"progress":1}')
            with mock.patch.object(upscale_worker.os, 'replace', side_effect=PermissionError), \
                    mock.patch.object(upscale_worker.time, 'sleep'):
                with self.assertRaises(PermissionError):
                    upscale_worker._write_json_atomic(str(target), {'progress': 50})
            self.assertEqual(json.loads(target.read_text()), {'progress': 1})
            self.assertEqual(list(Path(folder).iterdir()), [target])

    def test_tiled_nearest_model_covers_uneven_edges_without_seams(self):
        source = Image.new("RGB", (257, 131))
        pixels = source.load()
        for y in range(source.height):
            for x in range(source.width):
                pixels[x, y] = (x % 256, y % 256, (x + y) % 256)

        def nearest(tile):
            return tile.resize((tile.width * 4, tile.height * 4), Image.Resampling.NEAREST)

        progress = []
        actual = upscale_worker.process_tiled_image(
            source, 4, 48, nearest,
            progress_callback=lambda done, total: progress.append((done, total)),
        )
        expected = source.resize((source.width * 4, source.height * 4), Image.Resampling.NEAREST)
        self.assertEqual(actual.size, expected.size)
        self.assertIsNone(ImageChops.difference(actual, expected).getbbox())
        self.assertEqual(progress[-1][0], progress[-1][1])
        self.assertEqual(actual.getpixel((actual.width - 1, actual.height - 1)), expected.getpixel((actual.width - 1, actual.height - 1)))

    def test_alpha_is_resized_from_source_independently_of_model_rgb(self):
        native = Image.new("RGB", (8, 8), (30, 60, 90))
        alpha = Image.new("L", (3, 2))
        alpha.putdata([0, 40, 100, 150, 220, 255])
        expected_alpha = alpha.resize((7, 5), Image.Resampling.LANCZOS)
        result = upscale_worker.resize_native_to_target(native, alpha, (7, 5))
        self.assertEqual(result.mode, "RGBA")
        self.assertEqual(result.size, (7, 5))
        self.assertIsNone(ImageChops.difference(result.getchannel("A"), expected_alpha).getbbox())

    def test_worker_dimension_validation_enforces_limits(self):
        self.assertEqual(upscale_worker.validate_dimensions(2500, 8000), (2500, 8000))
        with self.assertRaisesRegex(upscale_worker.WorkerError, "130MP"):
            upscale_worker.validate_dimensions(20000, 10000)
        with self.assertRaises(upscale_worker.WorkerError):
            upscale_worker.validate_dimensions(True, 8000)

    def _fixture(self, root, worker_source):
        root = Path(root)
        source = root / "source.png"
        Image.new("RGB", (8, 8), (12, 34, 56)).save(source)
        model = root / "model.safetensors"
        model.write_bytes(b"synthetic model placeholder")
        worker = root / "fake_worker.py"
        worker.write_text(worker_source, encoding="utf-8")
        return source, model, worker

    def _assets_patch(self, model_path, python_path=None):
        asset_module = types.ModuleType("naim.upscale_assets")
        asset_module.UPSCALE_ASSETS = types.SimpleNamespace(
            paths=lambda engine: {
                "model": str(model_path),
                "python": python_path or sys.executable,
            }
        )
        return mock.patch.dict(sys.modules, {"naim.upscale_assets": asset_module})

    @staticmethod
    def _success_worker():
        return '''
import json, sys
from PIL import Image
with open(sys.argv[1], encoding="utf-8") as stream:
    request = json.load(stream)
Image.new("RGB", (request["target_width"], request["target_height"]), (7, 8, 9)).save(request["target_path"])
with open(request["result_path"], "w", encoding="utf-8") as stream:
    json.dump({"engine": request["engine"], "quality": "standard", "stages": [{"scale": 4 if request["engine"] == "illustrationjanai" else 2, "engine": request["engine"], "tile": 512 if request["engine"] == "animesharp" else 128}], "final_width": request["target_width"], "final_height": request["target_height"], "native_width": 32 if request["engine"] == "illustrationjanai" else 16, "native_height": 32 if request["engine"] == "illustrationjanai" else 16}, stream)
with open(request["progress_path"], "w", encoding="utf-8") as stream:
    json.dump({"progress": 100, "message": "완료"}, stream)
'''

    def test_success_publishes_only_verified_result_and_reports_native_size(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, model, worker = self._fixture(temporary, self._success_worker())
            target = Path(temporary) / "result.png"
            progress = []
            with self._assets_patch(model), \
                 mock.patch.object(model_upscale, "_WORKER_PATH", str(worker)):
                result = model_upscale.run_model_upscale(
                    source, target, 64, 64, "illustrationjanai",
                    progress_callback=lambda value, message: progress.append((value, message)),
                )
            self.assertEqual(result["native_width"], 32)
            self.assertEqual(result["native_height"], 32)
            self.assertEqual(result["final_width"], 64)
            self.assertEqual(result["engine"], "illustrationjanai")
            with Image.open(target) as image:
                self.assertEqual(image.size, (64, 64))
                self.assertEqual(image.getpixel((0, 0)), (7, 8, 9))
            self.assertTrue(progress)
            self.assertLessEqual(max(value for value, _ in progress), 95)

    def test_animesharp_result_requires_its_native_two_times_scale(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, model, worker = self._fixture(temporary, self._success_worker())
            target = Path(temporary) / "result.png"

            with self._assets_patch(model), \
                 mock.patch.object(model_upscale, "_WORKER_PATH", str(worker)):
                result = model_upscale.run_model_upscale(
                    source, target, 64, 64, "animesharp",
                )
            self.assertEqual(result["native_width"], 16)
            self.assertEqual(result["native_height"], 16)
            self.assertEqual(result["stages"][0]["scale"], 2)

    def test_worker_failure_keeps_existing_target_unchanged(self):
        failing = '''
import sys
print("NAIM_ERROR:synthetic worker failure", flush=True)
raise SystemExit(2)
'''
        with tempfile.TemporaryDirectory() as temporary:
            source, model, worker = self._fixture(temporary, failing)
            target = Path(temporary) / "result.png"
            Image.new("RGB", (64, 64), (90, 80, 70)).save(target)
            before = target.read_bytes()
            with self._assets_patch(model), mock.patch.object(model_upscale, "_WORKER_PATH", str(worker)):
                with self.assertRaisesRegex(RuntimeError, "synthetic worker failure"):
                    model_upscale.run_model_upscale(source, target, 64, 64, "illustrationjanai")
            self.assertEqual(target.read_bytes(), before)

    def test_missing_model_or_runtime_fails_without_starting_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.png"
            Image.new("RGB", (8, 8)).save(source)
            missing = Path(temporary) / "missing.safetensors"
            asset_module = types.ModuleType("naim.upscale_assets")
            asset_module.UPSCALE_ASSETS = types.SimpleNamespace(
                paths=lambda engine: {"model": str(missing), "python": sys.executable}
            )
            with mock.patch.dict(sys.modules, {"naim.upscale_assets": asset_module}), \
                 mock.patch.object(model_upscale.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(FileNotFoundError, "모델 관리"):
                    model_upscale.run_model_upscale(source, Path(temporary) / "out.png", 64, 64, "animesharp")
                popen.assert_not_called()

            model = Path(temporary) / "model.safetensors"
            model.write_bytes(b"placeholder")
            asset_module.UPSCALE_ASSETS.paths = lambda engine: {
                "model": str(model), "python": str(Path(temporary) / "missing-python.exe")
            }
            with mock.patch.dict(sys.modules, {"naim.upscale_assets": asset_module}), \
                 mock.patch.object(model_upscale.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(FileNotFoundError, "실행 환경"):
                    model_upscale.run_model_upscale(source, Path(temporary) / "out.png", 64, 64, "animesharp")
                popen.assert_not_called()

    def test_cancellation_terminates_child_and_preserves_existing_output(self):
        waiting = '''
import json, sys, time
with open(sys.argv[1], encoding="utf-8") as stream:
    request = json.load(stream)
with open(request["progress_path"], "w", encoding="utf-8") as stream:
    json.dump({"progress": 10, "message": "synthetic running"}, stream)
time.sleep(30)
'''
        with tempfile.TemporaryDirectory() as temporary:
            source, model, worker = self._fixture(temporary, waiting)
            target = Path(temporary) / "result.png"
            Image.new("RGB", (64, 64), (1, 2, 3)).save(target)
            before = target.read_bytes()
            cancel = threading.Event()

            def cancel_when_started(_progress, message):
                if message == "synthetic running":
                    cancel.set()

            with self._assets_patch(model), mock.patch.object(model_upscale, "_WORKER_PATH", str(worker)):
                with self.assertRaises(UpscaleCancelled):
                    model_upscale.run_model_upscale(
                        source, target, 64, 64, "illustrationjanai",
                        progress_callback=cancel_when_started,
                        cancel_event=cancel,
                    )
            self.assertEqual(target.read_bytes(), before)

    def test_cancellation_while_waiting_for_gpu_lock_does_not_launch_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            source, model, worker = self._fixture(temporary, self._success_worker())
            cancel = threading.Event()
            failure = []
            model_upscale._GPU_LOCK.acquire()

            def run():
                try:
                    model_upscale.run_model_upscale(
                        source, Path(temporary) / "result.png", 64, 64,
                        "illustrationjanai", cancel_event=cancel,
                    )
                except BaseException as error:
                    failure.append(error)

            try:
                with self._assets_patch(model), mock.patch.object(model_upscale, "_WORKER_PATH", str(worker)), \
                     mock.patch.object(model_upscale.subprocess, "Popen") as popen:
                    thread = threading.Thread(target=run)
                    thread.start()
                    time.sleep(0.15)
                    cancel.set()
                    thread.join(timeout=2)
                    self.assertFalse(thread.is_alive())
                    popen.assert_not_called()
            finally:
                model_upscale._GPU_LOCK.release()
            self.assertEqual(len(failure), 1)
            self.assertIsInstance(failure[0], UpscaleCancelled)


if __name__ == "__main__":
    unittest.main()
