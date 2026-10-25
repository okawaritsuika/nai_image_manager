"""Standalone CUDA inference worker for optional NVIDIA upscalers.

This file deliberately has no application imports. It is launched by the
portable model runtime so PyTorch and GPU memory stay out of the app process.
"""
import gc
import json
import os
import sys
import tempfile
import time


_ENGINE_SCALES = {"illustrationjanai": 4, "animesharp": 2}
_MAX_PIXELS = 130_000_000
_TILE_SIZES = (128, 96, 64, 32)
_RCAN_TILE_SIZES = (512, 256, 128, 64, 32)
_OVERLAP = 32


class WorkerError(RuntimeError):
    """Short, user-facing inference failure without private path details."""


def validate_dimensions(width, height):
    if type(width) is not int or type(height) is not int:
        raise WorkerError("목표 해상도가 올바르지 않습니다.")
    if width < 64 or height < 64 or width > 20000 or height > 20000:
        raise WorkerError("목표 해상도는 가로·세로 64~20000px 범위여야 합니다.")
    if width * height > _MAX_PIXELS:
        raise WorkerError("목표 해상도가 너무 큽니다. 최대 약 130MP까지만 허용합니다.")
    return width, height


def tile_regions(width, height, tile_size, overlap=_OVERLAP):
    """Yield core and context boxes; only each core is copied to the result."""
    if width <= 0 or height <= 0 or tile_size <= 0 or overlap < 0:
        raise ValueError("타일 크기 설정이 올바르지 않습니다.")
    for top in range(0, height, tile_size):
        bottom = min(height, top + tile_size)
        for left in range(0, width, tile_size):
            right = min(width, left + tile_size)
            expanded = (
                max(0, left - overlap),
                max(0, top - overlap),
                min(width, right + overlap),
                min(height, bottom + overlap),
            )
            yield (left, top, right, bottom), expanded


def process_tiled_image(source, scale, tile_size, predict_tile, progress_callback=None):
    """Run a tile predictor and stitch its uint8 RGB cores into a native image."""
    from PIL import Image

    if source.mode != "RGB":
        source = source.convert("RGB")
    width, height = source.size
    regions = list(tile_regions(width, height, tile_size))
    output = Image.new("RGB", (width * scale, height * scale))
    for index, (core, expanded) in enumerate(regions, 1):
        left, top, right, bottom = core
        x0, y0, x1, y1 = expanded
        predicted = predict_tile(source.crop(expanded))
        if not isinstance(predicted, Image.Image):
            raise RuntimeError("모델 타일 결과가 이미지가 아닙니다.")
        if predicted.size != ((x1 - x0) * scale, (y1 - y0) * scale):
            raise RuntimeError("모델이 예상한 배율의 이미지를 반환하지 않았습니다.")
        core_pixels = predicted.crop((
            (left - x0) * scale,
            (top - y0) * scale,
            (right - x0) * scale,
            (bottom - y0) * scale,
        ))
        output.paste(core_pixels, (left * scale, top * scale))
        if progress_callback:
            progress_callback(index, len(regions))
    return output


def resize_native_to_target(native, source_alpha, target_size):
    """Resize RGB output and independently resize source alpha to final pixels."""
    from PIL import Image

    if native.size == target_size:
        final_rgb = native.copy()
    else:
        final_rgb = native.resize(target_size, Image.Resampling.LANCZOS)
    if source_alpha is None:
        return final_rgb
    final_alpha = source_alpha.resize(target_size, Image.Resampling.LANCZOS)
    final = final_rgb.convert("RGBA")
    final.putalpha(final_alpha)
    final_alpha.close()
    final_rgb.close()
    return final


def _write_json_atomic(path, value):
    folder = os.path.dirname(os.path.abspath(path))
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".naim-progress-", dir=folder)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        for attempt in range(6):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                # Windows briefly locks the old progress file while the app
                # reads it. Keep atomic writes, allowing that reader to close.
                if attempt == 5:
                    raise
                time.sleep(0.02)
        temporary = None
    finally:
        if temporary and os.path.exists(temporary):
            os.remove(temporary)


def _load_model(request, torch):
    try:
        import spandrel
        from spandrel import ImageModelDescriptor, ModelLoader
    except ImportError as error:
        raise WorkerError(
            "NVIDIA 업스케일 실행 환경이 설치되지 않았습니다. 모델 관리에서 실행 환경을 설치해 주세요."
        ) from error

    engine = request["engine"]
    if engine == "illustrationjanai":
        try:
            from spandrel.architectures.FDAT import FDATArch
            spandrel.MAIN_REGISTRY.add(
                spandrel.ArchSupport.from_architecture(FDATArch()),
                ignore_duplicates=True,
            )
        except Exception as error:
            raise WorkerError(
                "FDAT 모델 형식 지원 파일을 찾을 수 없습니다. NVIDIA 업스케일 자료를 다시 설치해 주세요."
            ) from error

    device = torch.device("cuda:0")
    try:
        descriptor = ModelLoader(device=device).load_from_file(request["model_path"])
    except torch.cuda.OutOfMemoryError:
        raise
    except Exception as error:
        raise WorkerError("업스케일 모델을 읽지 못했습니다. 모델 파일을 다시 설치해 주세요.") from error
    if not isinstance(descriptor, ImageModelDescriptor):
        raise WorkerError("이미지 업스케일 모델 형식이 아닙니다.")
    if (getattr(descriptor, "scale", None) != _ENGINE_SCALES[engine]
            or getattr(descriptor, "input_channels", None) != 3
            or getattr(descriptor, "output_channels", None) != 3):
        raise WorkerError("설치된 모델의 배율 또는 색상 형식이 올바르지 않습니다.")

    supports_half = bool(getattr(descriptor, "supports_half", False))
    if engine == "illustrationjanai":
        supports_bfloat16 = bool(getattr(descriptor, "supports_bfloat16", False))
        can_use_bfloat16 = False
        if supports_bfloat16:
            try:
                can_use_bfloat16 = bool(torch.cuda.is_bf16_supported())
            except (AttributeError, RuntimeError):
                can_use_bfloat16 = False
        if can_use_bfloat16:
            dtype = torch.bfloat16
        elif supports_half:
            dtype = torch.float16
        else:
            dtype = torch.float32
    else:
        dtype = torch.float16 if supports_half else torch.float32

    try:
        descriptor.model.to(device=device, dtype=dtype)
        descriptor.model.eval()
    except torch.cuda.OutOfMemoryError:
        raise
    except Exception as error:
        raise WorkerError("NVIDIA GPU에 모델을 준비하지 못했습니다.") from error
    return descriptor, device, dtype


def _make_predictor(descriptor, torch, device, dtype, scale):
    import numpy as np
    from PIL import Image

    def predict(tile):
        array = np.array(tile, dtype=np.uint8, copy=True)
        tensor = torch.from_numpy(array).permute(2, 0, 1).unsqueeze(0)
        tensor = tensor.to(device=device, dtype=dtype).div_(255.0)
        try:
            with torch.inference_mode():
                output = descriptor(tensor)
        except torch.cuda.OutOfMemoryError:
            raise
        except RuntimeError as error:
            if "out of memory" in str(error).lower():
                raise torch.cuda.OutOfMemoryError("CUDA out of memory") from error
            raise
        if not torch.is_tensor(output) or output.ndim != 4 or output.shape[0] != 1 or output.shape[1] != 3:
            raise RuntimeError("모델 결과 형식이 올바르지 않습니다.")
        if output.shape[2] != tile.height * scale or output.shape[3] != tile.width * scale:
            raise RuntimeError("모델 결과 배율이 올바르지 않습니다.")
        pixels = output[0].detach().to(device="cpu", dtype=torch.float32)
        if not bool(torch.isfinite(pixels).all().item()):
            raise RuntimeError("모델 결과에 유효하지 않은 픽셀이 있습니다.")
        pixels = (pixels.clamp(0, 1).mul(255).add_(0.5)).to(dtype=torch.uint8)
        pixels = pixels.permute(1, 2, 0).contiguous().numpy()
        return Image.fromarray(pixels, mode="RGB")

    return predict


def _infer_with_retries(source, descriptor, torch, device, dtype, scale, progress,
                        tile_sizes=_TILE_SIZES):
    import gc

    predictor = _make_predictor(descriptor, torch, device, dtype, scale)
    retry_message = False
    for tile_size in tile_sizes:
        try:
            if retry_message:
                progress(7, "GPU 메모리에 맞춰 처리 타일을 줄였습니다...")
            native = process_tiled_image(
                source, scale, tile_size, predictor,
                progress_callback=lambda done, total: progress(
                    8 + int(78 * done / max(1, total)),
                    f"NVIDIA 모델 처리 중... ({done}/{total})",
                ),
            )
            return native, tile_size
        except torch.cuda.OutOfMemoryError:
            retry_message = True
            gc.collect()
            try:
                torch.cuda.empty_cache()
            except RuntimeError:
                pass
    raise WorkerError("GPU 메모리가 부족합니다. 더 작은 원본 이미지로 다시 시도해 주세요.")


def _throttled_progress_writer(path, interval=0.2):
    last_write = 0.0
    last_progress = 0

    def report(progress, message):
        nonlocal last_write, last_progress
        try:
            progress = max(0, min(100, int(progress)))
        except (TypeError, ValueError, OverflowError):
            return
        last_progress = max(last_progress, progress)
        now = time.monotonic()
        if last_progress < 100 and now - last_write < interval:
            return
        _write_json_atomic(path, {"progress": last_progress, "message": str(message)[:160]})
        last_write = now

    return report


def run_request(request):
    """Validate a private request, infer one native scale, then save atomically."""
    from PIL import Image

    engine = request.get("engine")
    if engine not in _ENGINE_SCALES:
        raise WorkerError("지원하지 않는 NVIDIA 업스케일 모델입니다.")
    width, height = validate_dimensions(request.get("target_width"), request.get("target_height"))
    source_path = request.get("source_path")
    target_path = request.get("target_path")
    model_path = request.get("model_path")
    progress_path = request.get("progress_path")
    result_path = request.get("result_path")
    if not all(isinstance(value, str) and value for value in (
            source_path, target_path, model_path, progress_path, result_path)):
        raise WorkerError("업스케일 요청이 올바르지 않습니다.")
    if not os.path.isfile(source_path):
        raise WorkerError("업스케일할 원본 이미지를 찾을 수 없습니다.")
    if not os.path.isfile(model_path):
        raise WorkerError("업스케일 모델이 설치되지 않았습니다. 모델 관리에서 다운로드해 주세요.")
    if os.path.splitext(model_path)[1].lower() != ".safetensors":
        raise WorkerError("업스케일 모델 파일 형식이 올바르지 않습니다.")
    if os.path.exists(target_path):
        raise WorkerError("업스케일 임시 결과 경로가 이미 사용 중입니다.")
    if os.path.normcase(os.path.realpath(source_path)) == os.path.normcase(os.path.realpath(target_path)):
        raise WorkerError("원본 이미지와 결과 경로가 같을 수 없습니다.")

    scale = _ENGINE_SCALES[engine]
    try:
        image = Image.open(source_path)
    except Exception as error:
        raise WorkerError("원본 이미지를 읽지 못했습니다.") from error
    with image:
        source_width, source_height = image.size
        if source_width <= 0 or source_height <= 0:
            raise WorkerError("원본 이미지 크기가 올바르지 않습니다.")
        native_width, native_height = source_width * scale, source_height * scale
        if native_width * native_height > _MAX_PIXELS:
            raise WorkerError(
                "모델의 기본 배율 결과가 130MP를 넘습니다. 더 작은 원본 이미지로 다시 시도해 주세요."
            )
        try:
            image.load()
        except Exception as error:
            raise WorkerError("원본 이미지를 읽지 못했습니다.") from error
        has_alpha = "A" in image.getbands() or "transparency" in image.info
        source_alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
        source_rgb = image.convert("RGB")

    torch = None
    descriptor = None
    native = None
    final = None
    temporary_output = None
    try:
        try:
            import torch
        except ImportError as error:
            raise WorkerError(
                "NVIDIA 업스케일 실행 환경이 설치되지 않았습니다. 모델 관리에서 실행 환경을 설치해 주세요."
            ) from error
        if not torch.cuda.is_available():
            raise WorkerError(
                "NVIDIA CUDA GPU를 사용할 수 없습니다. NVIDIA 그래픽 드라이버와 업스케일 실행 환경을 확인해 주세요."
            )

        _write_json_atomic(progress_path, {"progress": 2, "message": "NVIDIA 모델 불러오는 중..."})
        try:
            descriptor, device, dtype = _load_model(request, torch)
        except torch.cuda.OutOfMemoryError as error:
            raise WorkerError("GPU 메모리가 부족합니다. 더 작은 원본 이미지로 다시 시도해 주세요.") from error
        report_progress = _throttled_progress_writer(progress_path)
        native, tile_size = _infer_with_retries(
            source_rgb, descriptor, torch, device, dtype, scale,
            report_progress,
            tile_sizes=_RCAN_TILE_SIZES if engine == 'animesharp' else _TILE_SIZES,
        )
        _write_json_atomic(progress_path, {"progress": 88, "message": "요청한 크기로 정리 중..."})
        if native.size != (native_width, native_height):
            raise WorkerError("모델이 예상한 기본 크기의 이미지를 반환하지 않았습니다.")
        final = resize_native_to_target(native, source_alpha, (width, height))
        native.close()
        native = None

        # The parent owns this private directory and removes it even if a
        # cancellation terminates us while PNG encoding is still in progress.
        output_folder = os.path.dirname(os.path.abspath(progress_path))
        descriptor_fd, temporary_output = tempfile.mkstemp(
            prefix=".naim-model-output-", suffix=".png", dir=output_folder,
        )
        os.close(descriptor_fd)
        final.save(temporary_output, format="PNG")
        final.close()
        final = None
        os.replace(temporary_output, target_path)
        temporary_output = None
    finally:
        if native is not None:
            native.close()
        if final is not None:
            final.close()
        source_rgb.close()
        if source_alpha is not None:
            source_alpha.close()
        if temporary_output is not None:
            try:
                os.remove(temporary_output)
            except OSError:
                pass
        if descriptor is not None:
            del descriptor
        gc.collect()
        if torch is not None:
            try:
                torch.cuda.empty_cache()
            except RuntimeError:
                pass

    result = {
        "engine": engine,
        "quality": "standard",
        "stages": [{"scale": scale, "engine": engine, "tile": tile_size}],
        "final_width": width,
        "final_height": height,
        "native_width": native_width,
        "native_height": native_height,
    }
    _write_json_atomic(result_path, result)
    _write_json_atomic(progress_path, {"progress": 100, "message": "NVIDIA 업스케일 완료"})
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if len(argv) != 1:
            raise WorkerError("업스케일 요청이 올바르지 않습니다.")
        try:
            with open(argv[0], "r", encoding="utf-8") as stream:
                request = json.load(stream)
        except (OSError, UnicodeError, ValueError) as error:
            raise WorkerError("업스케일 요청을 읽지 못했습니다.") from error
        if not isinstance(request, dict):
            raise WorkerError("업스케일 요청이 올바르지 않습니다.")
        run_request(request)
        return 0
    except WorkerError as error:
        print("NAIM_ERROR:" + str(error), flush=True)
        return 2
    except Exception:
        print("NAIM_ERROR:NVIDIA 업스케일 작업에 실패했습니다. 실행 환경과 모델 설치 상태를 확인해 주세요.", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
