# -*- coding: utf-8 -*-
import math
import os
import shutil
import subprocess
import tempfile
import time
from PIL import Image


CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
REALCUGAN_EXE = os.path.join(
    CURRENT_DIR,
    "tools",
    "realcugan-ncnn-vulkan",
    "realcugan-ncnn-vulkan.exe"
)

try:
    LANCZOS = Image.Resampling.LANCZOS
except AttributeError:
    LANCZOS = Image.LANCZOS


class UpscaleCancelled(Exception):
    pass


QUALITY_SETTINGS = {
    "fast": {
        "label": "빠른 처리",
        # 3x/4x에서도 항상 존재하는 no-denoise 계열을 우선 사용
        "denoise": 0,
        "tta": False,
        "multi_stage": False,
    },
    "standard": {
        "label": "균형 처리",
        # denoise1은 2x에는 있지만 3x/4x에는 없는 경우가 있어 실패 원인이 된다.
        # 기본은 no-denoise로 두고, 선명도는 Real-CUGAN 업스케일 자체에 맡긴다.
        "denoise": 0,
        "tta": False,
        "multi_stage": False,
    },
    "high": {
        "label": "최종본 고품질",
        # 고품질은 TTA를 켜되, denoise는 안전한 no-denoise를 기본으로 둔다.
        # 필요 시 아래 resolve_realcugan_denoise_for_scale()에서 존재 모델 기준으로 보정된다.
        "denoise": 0,
        "tta": True,
        "multi_stage": True,
    },
}

def clamp_int(value, fallback, min_value, max_value):
    try:
        value = int(value)
    except Exception:
        value = fallback
    return max(min_value, min(max_value, value))


def validate_target_size(width, height):
    width = clamp_int(width, 2500, 64, 20000)
    height = clamp_int(height, 8000, 64, 20000)

    pixels = width * height
    if pixels > 130_000_000:
        raise ValueError("목표 해상도가 너무 큽니다. 최대 약 130MP까지만 허용합니다.")

    return width, height


def make_unique_output_path(target_path):
    folder = os.path.dirname(target_path)
    base, ext = os.path.splitext(os.path.basename(target_path))

    candidate = os.path.join(folder, base + ext)
    if not os.path.exists(candidate):
        return candidate

    for index in range(2, 10000):
        candidate = os.path.join(folder, f"{base}_{index}{ext}")
        if not os.path.exists(candidate):
            return candidate

    raise RuntimeError("저장할 파일명을 만들 수 없습니다.")


def get_image_size(path):
    with Image.open(path) as img:
        return img.size


def choose_scale(required_scale):
    if required_scale <= 2:
        return 2
    if required_scale <= 3:
        return 3
    return 4


def build_stage_scales(source_width, source_height, target_width, target_height, quality):
    required = max(target_width / max(1, source_width), target_height / max(1, source_height))
    settings = QUALITY_SETTINGS.get(quality, QUALITY_SETTINGS["standard"])

    if required <= 1:
        return []

    if not settings["multi_stage"]:
        return [choose_scale(required)]

    stages = []
    remaining = required

    while remaining > 4.05 and len(stages) < 2:
        stages.append(4)
        remaining /= 4

    stages.append(choose_scale(remaining))
    return stages


def check_cancel(cancel_event):
    if cancel_event and cancel_event.is_set():
        raise UpscaleCancelled("업스케일 작업이 취소되었습니다.")

def get_realcugan_model_dir():
    return os.path.join(os.path.dirname(REALCUGAN_EXE), "models-se")


def realcugan_model_exists(scale, denoise):
    model_dir = get_realcugan_model_dir()

    if denoise == -1:
        names = [
            f"up{scale}x-conservative.param",
        ]
    elif denoise == 0:
        names = [
            f"up{scale}x-no-denoise.param",
        ]
    else:
        names = [
            f"up{scale}x-denoise{denoise}x.param",
        ]

    return any(os.path.exists(os.path.join(model_dir, name)) for name in names)


def resolve_realcugan_denoise_for_scale(scale, preferred_denoise):
    """
    Real-CUGAN models-se는 배율마다 존재하는 denoise 모델이 다르다.

    보통:
    - 2x: conservative / no-denoise / denoise1 / denoise2 / denoise3
    - 3x: conservative / no-denoise / denoise3
    - 4x: conservative / no-denoise / denoise3

    따라서 preferred_denoise가 없으면 존재하는 안전한 값으로 자동 보정한다.
    """
    try:
        preferred_denoise = int(preferred_denoise)
    except Exception:
        preferred_denoise = 0

    candidates = [
        preferred_denoise,
        0,    # no-denoise: 가장 안전
        -1,   # conservative
        3,    # strong denoise
        1,
        2,
    ]

    seen = set()

    for denoise in candidates:
        if denoise in seen:
            continue
        seen.add(denoise)

        if realcugan_model_exists(scale, denoise):
            return denoise

    model_dir = get_realcugan_model_dir()

    if os.path.exists(model_dir):
        available = sorted(
            name for name in os.listdir(model_dir)
            if name.startswith(f"up{scale}x-") and name.endswith(".param")
        )
    else:
        available = []

    raise FileNotFoundError(
        f"Real-CUGAN {scale}x 모델 파일을 찾을 수 없습니다. "
        f"models-se 폴더를 확인해 주세요. 사용 가능한 파일: {available}"
    )

def run_process_with_cancel(cmd, cancel_event=None, cwd=None):
    process = subprocess.Popen(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    )

    output_lines = []

    try:
        while True:
            check_cancel(cancel_event)

            line = process.stdout.readline() if process.stdout else ""
            if line:
                output_lines.append(line.rstrip())

            code = process.poll()
            if code is not None:
                if process.stdout:
                    rest = process.stdout.read()
                    if rest:
                        output_lines.extend(rest.splitlines())
                return code, "\n".join(output_lines)

            time.sleep(0.1)

    except UpscaleCancelled:
        try:
            process.terminate()
            process.wait(timeout=5)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        raise

def run_realcugan_once(input_path, output_path, scale, denoise, tta, cancel_event=None):
    if not os.path.exists(REALCUGAN_EXE):
        raise FileNotFoundError(
            "Real-CUGAN 업스케일 엔진을 찾을 수 없습니다. setup의 3단계를 먼저 실행해 주세요."
        )

    model_dir = get_realcugan_model_dir()

    if not os.path.exists(model_dir):
        raise FileNotFoundError(
            f"Real-CUGAN 모델 폴더를 찾을 수 없습니다: {model_dir}\n"
            "setup의 3단계를 다시 실행해 주세요."
        )

    denoise = resolve_realcugan_denoise_for_scale(scale, denoise)

    tile_candidates = [0, 256, 192, 128, 96, 64]
    errors = []

    for tile in tile_candidates:
        check_cancel(cancel_event)

        cmd = [
            REALCUGAN_EXE,
            "-i", input_path,
            "-o", output_path,
            "-s", str(scale),
            "-n", str(denoise),
            "-t", str(tile),
            "-m", model_dir,
            "-g", "0",
            "-f", "png",
        ]

        if tta:
            cmd.append("-x")

        code, output = run_process_with_cancel(
            cmd,
            cancel_event=cancel_event,
            cwd=os.path.dirname(REALCUGAN_EXE)
        )

        if code == 0 and os.path.exists(output_path):
            return {
                "tile": tile,
                "scale": scale,
                "tta": tta,
                "denoise": denoise,
                "model_dir": model_dir,
            }

        errors.append(f"tile={tile}, denoise={denoise}, code={code}\n{output}")

        # 모델 파일 없음은 tile을 줄여도 절대 해결되지 않는다.
        if ".param failed" in output or "_wfopen" in output:
            break

    if tta:
        return run_realcugan_once(
            input_path=input_path,
            output_path=output_path,
            scale=scale,
            denoise=denoise,
            tta=False,
            cancel_event=cancel_event
        )

    raise RuntimeError("Real-CUGAN 실행에 실패했습니다.\n" + "\n\n".join(errors[-2:]))


def resize_to_target(input_path, output_path, target_width, target_height, cancel_event=None):
    check_cancel(cancel_event)

    with Image.open(input_path) as img:
        img = img.convert("RGBA")

        if img.size != (target_width, target_height):
            img = img.resize((target_width, target_height), LANCZOS)

        check_cancel(cancel_event)
        img.save(output_path, "PNG")


def run_lanczos_only(source_path, target_path, target_width, target_height, progress_callback=None, cancel_event=None):
    if progress_callback:
        progress_callback(25, "이미지를 읽는 중...")

    check_cancel(cancel_event)

    if progress_callback:
        progress_callback(65, "목표 해상도로 리사이즈 중...")

    resize_to_target(source_path, target_path, target_width, target_height, cancel_event=cancel_event)

    if progress_callback:
        progress_callback(95, "파일 저장 완료")

    return {
        "engine": "lanczos",
        "stages": [],
        "final_width": target_width,
        "final_height": target_height,
    }


def run_upscale(
    source_path,
    target_path,
    target_width,
    target_height,
    engine="realcugan",
    quality="standard",
    progress_callback=None,
    cancel_event=None,
):
    target_width, target_height = validate_target_size(target_width, target_height)
    engine = str(engine or "realcugan").strip().lower()
    quality = str(quality or "standard").strip().lower()

    if quality not in QUALITY_SETTINGS:
        quality = "standard"

    source_width, source_height = get_image_size(source_path)

    if progress_callback:
        progress_callback(5, f"원본 확인: {source_width} × {source_height}px")

    if engine == "lanczos":
        return run_lanczos_only(
            source_path,
            target_path,
            target_width,
            target_height,
            progress_callback=progress_callback,
            cancel_event=cancel_event
        )

    if engine != "realcugan":
        raise ValueError(f"지원하지 않는 업스케일 엔진입니다: {engine}")

    settings = QUALITY_SETTINGS[quality]
    stages = build_stage_scales(source_width, source_height, target_width, target_height, quality)

    if not stages:
        return run_lanczos_only(
            source_path,
            target_path,
            target_width,
            target_height,
            progress_callback=progress_callback,
            cancel_event=cancel_event
        )

    os.makedirs(os.path.dirname(target_path), exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="naia_upscale_") as temp_dir:
        current_input = source_path
        stage_results = []

        total_stages = len(stages)

        for index, scale in enumerate(stages, 1):
            check_cancel(cancel_event)

            stage_output = os.path.join(temp_dir, f"stage_{index}_x{scale}.png")

            if progress_callback:
                start_progress = 12 + int((index - 1) * 58 / max(1, total_stages))
                progress_callback(start_progress, f"Real-CUGAN {scale}x 처리 중... ({index}/{total_stages})")

            result = run_realcugan_once(
                input_path=current_input,
                output_path=stage_output,
                scale=scale,
                denoise=settings["denoise"],
                tta=settings["tta"],
                cancel_event=cancel_event
            )

            stage_results.append(result)
            current_input = stage_output

            if progress_callback:
                done_progress = 12 + int(index * 58 / max(1, total_stages))
                progress_callback(done_progress, f"Real-CUGAN 단계 완료 ({index}/{total_stages})")

        if progress_callback:
            progress_callback(82, f"최종 해상도 {target_width} × {target_height}px로 정리 중...")

        resize_to_target(
            current_input,
            target_path,
            target_width,
            target_height,
            cancel_event=cancel_event
        )

    if progress_callback:
        progress_callback(95, "결과 파일 저장 완료")

    return {
        "engine": "realcugan",
        "quality": quality,
        "stages": stage_results,
        "final_width": target_width,
        "final_height": target_height,
    }