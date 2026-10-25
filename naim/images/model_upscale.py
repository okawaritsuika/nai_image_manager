"""Isolated adapter for the optional NVIDIA image-upscale models."""
import json
import os
import subprocess
import tempfile
import threading
import time

from naim.processes import UpscaleCancelled


_ENGINE_SCALES = {"illustrationjanai": 4, "animesharp": 2}
_ENGINE_LABELS = {
    "illustrationjanai": "IllustrationJaNai V3detail FDAT M4x",
    "animesharp": "AnimeSharpV4 normal RCAN2x",
}
_GPU_LOCK = threading.Lock()
_WORKER_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "upscale_worker.py")
)
_PROGRESS_PREFIX = 5
_PROGRESS_RANGE = 90


def _check_cancel(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise UpscaleCancelled("업스케일 작업이 취소되었습니다.")


def _validate_dimensions(width, height):
    if isinstance(width, bool) or isinstance(height, bool):
        raise ValueError("목표 해상도가 올바르지 않습니다.")
    try:
        width, height = int(width), int(height)
    except (TypeError, ValueError, OverflowError) as error:
        raise ValueError("목표 해상도가 올바르지 않습니다.") from error
    if width < 64 or height < 64 or width > 20000 or height > 20000:
        raise ValueError("목표 해상도는 가로·세로 64~20000px 범위여야 합니다.")
    if width * height > 130_000_000:
        raise ValueError("목표 해상도가 너무 큽니다. 최대 약 130MP까지만 허용합니다.")
    return width, height


def _asset_paths(engine):
    if engine not in _ENGINE_SCALES:
        raise ValueError("지원하지 않는 NVIDIA 업스케일 모델입니다.")
    try:
        from naim.upscale_assets import UPSCALE_ASSETS
        paths = UPSCALE_ASSETS.paths(engine)
    except ImportError as error:
        raise RuntimeError("NVIDIA 업스케일 자료 관리 기능을 불러오지 못했습니다.") from error
    except Exception as error:
        # The asset manager can include installation paths in its diagnostics.
        raise RuntimeError("업스케일 모델을 사용할 수 없습니다. 모델 관리에서 설치 상태를 확인해 주세요.") from error

    model_path = os.path.abspath(os.fspath(paths.get("model", "")))
    python_path = os.path.abspath(os.fspath(paths.get("python", "")))
    if not os.path.isfile(model_path):
        raise FileNotFoundError(
            f"{_ENGINE_LABELS[engine]} 모델이 설치되지 않았습니다. 모델 관리에서 다운로드해 주세요."
        )
    if os.path.splitext(model_path)[1].lower() != ".safetensors":
        raise RuntimeError("업스케일 모델 파일 형식이 올바르지 않습니다.")
    if not os.path.isfile(python_path):
        raise FileNotFoundError(
            "NVIDIA 업스케일 실행 환경이 설치되지 않았습니다. 모델 관리에서 실행 환경을 설치해 주세요."
        )
    if not os.path.isfile(_WORKER_PATH):
        raise FileNotFoundError("NVIDIA 업스케일 처리 파일을 찾을 수 없습니다.")
    return python_path, model_path


def _read_progress(path):
    try:
        if os.path.getsize(path) > 4096:
            return None
        with open(path, "r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, UnicodeError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    try:
        progress = max(0, min(100, int(value.get("progress", 0))))
    except (TypeError, ValueError, OverflowError):
        return None
    message = value.get("message", "")
    if not isinstance(message, str):
        message = ""
    return progress, message[:160]


def _worker_error(log_path):
    try:
        with open(log_path, "rb") as stream:
            stream.seek(max(0, os.path.getsize(log_path) - 8192))
            content = stream.read(8192).decode("utf-8", errors="replace")
    except OSError:
        return "NVIDIA 업스케일 작업에 실패했습니다."
    for line in reversed(content.splitlines()):
        if line.startswith("NAIM_ERROR:"):
            return line.partition(":")[2].strip()[:240]
    return "NVIDIA 업스케일 작업에 실패했습니다. 실행 환경과 모델 설치 상태를 확인해 주세요."


def _stop_process(process):
    if process.poll() is not None:
        return
    try:
        process.terminate()
    except OSError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except OSError:
            pass
        process.wait()


def _run_worker(python_path, request_path, progress_path, log_path,
                progress_callback, cancel_event):
    command = [python_path, "-I", "-X", "utf8", _WORKER_PATH, request_path]
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    process = None
    last_progress = _PROGRESS_PREFIX
    try:
        _check_cancel(cancel_event)
        with open(log_path, "wb") as log_stream:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=log_stream,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
            while process.poll() is None:
                if cancel_event is not None and cancel_event.is_set():
                    _stop_process(process)
                    raise UpscaleCancelled("업스케일 작업이 취소되었습니다.")
                status = _read_progress(progress_path)
                if status is not None and progress_callback:
                    child_progress, message = status
                    mapped = _PROGRESS_PREFIX + int(_PROGRESS_RANGE * child_progress / 100)
                    last_progress = max(last_progress, min(95, mapped))
                    progress_callback(last_progress, message or "NVIDIA 업스케일 처리 중...")
                time.sleep(0.1)
            return_code = process.wait()
    finally:
        if process is not None and process.poll() is None:
            _stop_process(process)

    _check_cancel(cancel_event)
    if return_code != 0:
        raise RuntimeError(_worker_error(log_path))


def _read_result(path, expected_engine, target_width, target_height,
                 source_width, source_height, stage_path):
    try:
        if os.path.getsize(path) > 16384:
            raise ValueError
        with open(path, "r", encoding="utf-8") as stream:
            result = json.load(stream)
    except (OSError, UnicodeError, ValueError) as error:
        raise RuntimeError("업스케일 결과 확인에 실패했습니다.") from error
    if not isinstance(result, dict):
        raise RuntimeError("업스케일 결과 확인에 실패했습니다.")
    try:
        final_size = (int(result["final_width"]), int(result["final_height"]))
        native_size = (int(result["native_width"]), int(result["native_height"]))
        stages = result["stages"]
        expected_scale = _ENGINE_SCALES[expected_engine]
        allowed_tiles = (512, 256, 128, 64, 32) if expected_engine == 'animesharp' else (128, 96, 64, 32)
        valid_stage = (
            isinstance(stages, list) and len(stages) == 1
            and isinstance(stages[0], dict)
            and stages[0].get("scale") == expected_scale
            and stages[0].get("engine") == expected_engine
            and type(stages[0].get("tile")) is int
            and stages[0].get("tile") in allowed_tiles
        )
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise RuntimeError("업스케일 결과 확인에 실패했습니다.") from error
    if (result.get("engine") != expected_engine
            or result.get("quality") != "standard"
            or final_size != (target_width, target_height)
            or native_size != (
                source_width * expected_scale,
                source_height * expected_scale,
            )
            or native_size[0] * native_size[1] > 130_000_000
            or not valid_stage or not os.path.isfile(stage_path)):
        raise RuntimeError("업스케일 결과 확인에 실패했습니다.")

    try:
        from PIL import Image
        with Image.open(stage_path) as image:
            if image.size != (target_width, target_height) or image.format != "PNG":
                raise ValueError
            image.verify()
    except Exception as error:
        raise RuntimeError("업스케일 결과 이미지가 손상되었거나 크기가 다릅니다.") from error
    return {
        "engine": expected_engine,
        "quality": "standard",
        "stages": [{
            "scale": expected_scale,
            "engine": expected_engine,
            "tile": stages[0]["tile"],
        }],
        "final_width": target_width,
        "final_height": target_height,
        "native_width": native_size[0],
        "native_height": native_size[1],
    }


def run_model_upscale(source_path, target_path, target_width, target_height, engine,
                      progress_callback=None, cancel_event=None):
    """Run one NVIDIA model pass in a private process and publish only a verified PNG."""
    target_width, target_height = _validate_dimensions(target_width, target_height)
    python_path, model_path = _asset_paths(engine)
    source_path = os.path.abspath(os.fspath(source_path))
    target_path = os.path.abspath(os.fspath(target_path))
    if not os.path.isfile(source_path):
        raise FileNotFoundError("업스케일할 원본 이미지를 찾을 수 없습니다.")
    if os.path.normcase(os.path.realpath(source_path)) == os.path.normcase(os.path.realpath(target_path)):
        raise ValueError("원본 이미지와 결과 경로가 같을 수 없습니다.")
    try:
        from PIL import Image
        with Image.open(source_path) as source:
            source_width, source_height = source.size
    except Exception as error:
        raise ValueError("원본 이미지 크기를 확인할 수 없습니다.") from error
    if source_width <= 0 or source_height <= 0:
        raise ValueError("원본 이미지 크기가 올바르지 않습니다.")
    scale = _ENGINE_SCALES[engine]
    if source_width * source_height * scale * scale > 130_000_000:
        raise ValueError("모델의 기본 배율 결과가 130MP를 넘습니다. 더 작은 원본 이미지로 다시 시도해 주세요.")

    acquired = False
    stage_path = None
    try:
        while not acquired:
            _check_cancel(cancel_event)
            acquired = _GPU_LOCK.acquire(timeout=0.1)
        _check_cancel(cancel_event)
        target_folder = os.path.dirname(target_path)
        os.makedirs(target_folder, exist_ok=True)
        stage_fd, stage_path = tempfile.mkstemp(
            prefix=".naim-model-upscale-stage-", suffix=".png", dir=target_folder,
        )
        os.close(stage_fd)
        os.remove(stage_path)
        with tempfile.TemporaryDirectory(prefix=".naim-model-upscale-", dir=target_folder) as work_dir:
            request_path = os.path.join(work_dir, "request.json")
            progress_path = os.path.join(work_dir, "progress.json")
            result_path = os.path.join(work_dir, "result.json")
            log_path = os.path.join(work_dir, "worker.log")
            request = {
                "source_path": source_path,
                "target_path": stage_path,
                "model_path": model_path,
                "engine": engine,
                "target_width": target_width,
                "target_height": target_height,
                "progress_path": progress_path,
                "result_path": result_path,
            }
            with open(request_path, "w", encoding="utf-8") as stream:
                json.dump(request, stream, ensure_ascii=False, separators=(",", ":"))

            if progress_callback:
                progress_callback(5, f"{_ENGINE_LABELS[engine]} 준비 중...")
            _run_worker(
                python_path, request_path, progress_path, log_path,
                progress_callback, cancel_event,
            )
            _check_cancel(cancel_event)
            result = _read_result(
                result_path, engine, target_width, target_height,
                source_width, source_height, stage_path,
            )
            _check_cancel(cancel_event)
            os.replace(stage_path, target_path)

        if progress_callback:
            progress_callback(95, "NVIDIA 업스케일 결과 저장 완료")
        return result
    finally:
        if stage_path and os.path.exists(stage_path):
            try:
                os.remove(stage_path)
            except OSError:
                pass
        if acquired:
            _GPU_LOCK.release()
