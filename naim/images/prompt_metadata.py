"""PNG/EXIF/sidecar metadata compatibility shared by canvas and gallery."""
import json
import os
import re
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import image_logic
from naim.storage.json_files import write_json

_GENERATION_BOOLEAN_FIELDS = ('prefer_brownian', 'deliberate_euler_ancestral_bug',
                              'dynamic_thresholding', 'legacy_v3_extend')

PROMPT_REGION_LABELS = {
    'whole': '전체', 'hair': '머리카락', 'face': '얼굴', 'chest': '가슴·어깨',
    'back': '등', 'arms': '팔', 'hands': '손', 'abdomen': '배·허리',
    'pelvis': '골반', 'legs': '다리', 'feet': '발', 'clothes': '의상',
}


def normalize_prompt_regions(value):
    """Optional meaning annotations; old prompt files need no new field."""
    if not isinstance(value, list) or len(value) > 64:
        raise ValueError('부위별 프롬프트는 최대 64개 입력할 수 있습니다.')
    result = []
    for item in value:
        if (not isinstance(item, dict) or item.get('region') not in PROMPT_REGION_LABELS
                or not isinstance(item.get('prompt'), str) or len(item['prompt']) > 30000):
            raise ValueError('부위와 프롬프트를 올바르게 지정해 주세요.')
        character_index = item.get('characterIndex')
        if 'characterIndex' in item and (type(character_index) is not int or not 0 <= character_index < 22):
            raise ValueError('부위별 프롬프트의 캐릭터 번호가 올바르지 않습니다.')
        if item['prompt'].strip():
            result.append({'region': item['region'], 'label': PROMPT_REGION_LABELS[item['region']],
                           'prompt': item['prompt'].strip(),
                           **({'characterIndex': character_index} if 'characterIndex' in item else {})})
    return result

def decode_exif_user_comment(user_comment):
    if isinstance(user_comment, bytes):
        if user_comment.startswith(b"UNICODE\x00"):
            payload = user_comment[8:]
            for encoding in ("utf-16-be", "utf-16-le", "utf-16"):
                try:
                    return payload.decode(encoding, errors="strict").replace("\x00", "").strip()
                except UnicodeDecodeError:
                    continue

        if user_comment.startswith(b"ASCII\x00\x00\x00"):
            return user_comment[8:].decode("utf-8", errors="ignore").replace("\x00", "").strip()

        return user_comment.decode("utf-8", errors="ignore").replace("\x00", "").strip()

    text = str(user_comment or "")
    if text.startswith("UNICODE") or text.startswith("ASCII"):
        text = text[8:]
    return text.replace("\x00", "").strip()

def _decode_prompt_metadata_dict(value):
    if isinstance(value, dict):
        return value
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    if not isinstance(value, str) or not value.strip().startswith("{"):
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return None
    return parsed if isinstance(parsed, dict) else None

def _parse_prompt_metadata(value):
    meta = _decode_prompt_metadata_dict(value)
    for _ in range(2):
        if not isinstance(meta, dict):
            return {}
        nested = next(
            (item for key, item in meta.items() if str(key).casefold() == "comment"),
            None,
        )
        nested_meta = _decode_prompt_metadata_dict(nested)
        if nested_meta is None:
            break
        meta = nested_meta
    return meta if isinstance(meta, dict) else {}

def _iter_prompt_metadata_dicts(meta, _seen=None):
    """Yield the top-level generation JSON and its legacy nested containers."""
    if not isinstance(meta, dict):
        return
    if _seen is None:
        _seen = set()
    marker = id(meta)
    if marker in _seen:
        return
    _seen.add(marker)
    yield meta
    for key, value in meta.items():
        if str(key).casefold() not in {"parameters", "comment"}:
            continue
        nested = _decode_prompt_metadata_dict(value)
        if nested is not None:
            yield from _iter_prompt_metadata_dicts(nested, _seen)

def _prompt_metadata_field(meta, *wanted_keys):
    wanted = {str(key).casefold() for key in wanted_keys}
    for node in _iter_prompt_metadata_dicts(meta):
        for key, value in node.items():
            if str(key).casefold() not in wanted or isinstance(value, (dict, list)):
                continue
            if value not in (None, ""):
                return value
    return ""

def _image_info_value_casefold(image, wanted_key):
    wanted_key = str(wanted_key).casefold()
    for key, value in getattr(image, "info", {}).items():
        if str(key).casefold() == wanted_key:
            return value
    return ""

def _normalize_extracted_generation_metadata(meta, image):
    model = _prompt_metadata_field(meta, "model")
    model_name = _prompt_metadata_field(meta, "modelName", "model_name")
    source = _image_info_value_casefold(image, "source")
    if not model and model_name:
        model = model_name
    if not model_name:
        model_name = model or str(source or "").strip()
    if not model:
        model = model_name
    return {
        "model": str(model or "").strip(),
        "modelName": str(model_name or "").strip(),
        "model_name": str(model_name or "").strip(),
        "sampler": _prompt_metadata_field(meta, "sampler"),
        "steps": _prompt_metadata_field(meta, "steps"),
        "cfg": _prompt_metadata_field(meta, "cfg", "scale"),
        **{key: _prompt_metadata_field(meta, key) for key in
           ("cfg_rescale", "noise_schedule", "seed", "strength", "noise", *_GENERATION_BOOLEAN_FIELDS)}
    }

def extract_prompt_info_from_image(file_path):
    with Image.open(file_path) as img:
        raw_meta = ""
        stealth_data = image_logic.read_stealth_info(img)
        if stealth_data:
            raw_meta = stealth_data
        else:
            if "parameters" in img.info:
                raw_meta = img.info["parameters"]
            elif "Comment" in img.info:
                raw_meta = img.info["Comment"]
                if isinstance(raw_meta, bytes):
                    raw_meta = raw_meta.decode('utf-8', 'ignore')
            elif hasattr(img, 'getexif'):
                exif = img.getexif()
                if exif and 37510 in exif:
                    raw_meta = decode_exif_user_comment(exif[37510])

        raw_meta = str(raw_meta or "").strip()
        meta = {}

        if raw_meta.startswith('{'):
            meta = _parse_prompt_metadata(raw_meta)
        if not meta:
            meta = _parse_prompt_metadata(_image_info_value_casefold(img, "Comment"))

        generation_metadata = _normalize_extracted_generation_metadata(meta, img)

        if meta:
            v4_prompt = meta.get("v4_prompt", {})
            caption = v4_prompt.get("caption", {}) if isinstance(v4_prompt, dict) else {}

            base_caption = str(caption.get("base_caption", "") or "").strip()

            prompt = str(
                base_caption
                or meta.get("prompt", "")
                or meta.get("basePrompt", "")
                or ""
            ).strip()

            v4_negative_prompt = meta.get("v4_negative_prompt", {})
            negative_caption = v4_negative_prompt.get("caption", {}) if isinstance(v4_negative_prompt, dict) else {}

            negative_prompt = str(
                negative_caption.get("base_caption", "")
                or meta.get("negative_prompt", "")
                or meta.get("negativePrompt", "")
                or meta.get("uc", "")
                or meta.get("uncond", "")
                or meta.get("unconditional_prompt", "")
                or ""
            ).strip()

            char_prompts = []

            char_captions = caption.get("char_captions", [])
            if isinstance(char_captions, list):
                for item in char_captions:
                    if isinstance(item, dict):
                        char_prompt = str(item.get("char_caption", "")).strip()
                        if char_prompt:
                            char_prompts.append(char_prompt)

            return {
                "basePrompt": prompt,
                "baseCaption": base_caption,
                "negativePrompt": negative_prompt,
                "negative_prompt": negative_prompt,
                "uc": negative_prompt,
                "charPrompts": char_prompts,
                **({'promptRegions': normalize_prompt_regions(meta['promptRegions'])}
                   if 'promptRegions' in meta else {}),
                **generation_metadata,
                "metaType": "json"
            }

        prompt_part = raw_meta
        negative_prompt = ""
        if "Negative prompt:" in raw_meta:
            prompt_part, negative_prompt = raw_meta.split("Negative prompt:", 1)
            negative_prompt = negative_prompt.strip()
        if "\n" in prompt_part:
            prompt_part = prompt_part.split("\n")[0]

        return {
            "basePrompt": prompt_part.strip(),
            "baseCaption": "",
            "negativePrompt": negative_prompt,
            "negative_prompt": negative_prompt,
            "uc": negative_prompt,
            "charPrompts": [],
            **generation_metadata,
            "metaType": "text"
        }

def normalize_prompt_info_for_sidecar(prompt_info):
    prompt_info = prompt_info or {}

    char_prompts = normalize_char_prompts(prompt_info)
    char_prompt_text = ", ".join(char_prompts)

    negative_prompt = str(
        prompt_info.get("negativePrompt")
        or prompt_info.get("negative_prompt")
        or prompt_info.get("uc")
        or ""
    ).strip()

    base_caption = str(
        prompt_info.get("baseCaption")
        or prompt_info.get("base_caption")
        or ""
    ).strip()

    base_prompt = str(
        prompt_info.get("basePrompt")
        or prompt_info.get("prompt")
        or prompt_info.get("base_prompt")
        or base_caption
        or ""
    ).strip()

    model = str(
        prompt_info.get("model")
        or prompt_info.get("model_name")
        or prompt_info.get("modelName")
        or ""
    ).strip()
    model_name = str(
        prompt_info.get("modelName")
        or prompt_info.get("model_name")
        or model
        or ""
    ).strip()

    return {
        "basePrompt": base_prompt,
        "baseCaption": base_caption or base_prompt,
        "negativePrompt": negative_prompt,
        "negative_prompt": negative_prompt,
        "uc": negative_prompt,
        "charPrompt": char_prompt_text,
        "charPrompts": char_prompts,
        **({'promptRegions': normalize_prompt_regions(prompt_info['promptRegions'])}
           if 'promptRegions' in prompt_info else {}),
        "model": model,
        "modelName": model_name,
        "model_name": model_name,
        "strength": prompt_info.get("strength", ""),
        "noise": prompt_info.get("noise", ""),
        "sampler": prompt_info.get("sampler", ""),
        "steps": prompt_info.get("steps", ""),
        "cfg": prompt_info.get("cfg", prompt_info.get("scale", "")),
        "cfg_rescale": prompt_info.get("cfg_rescale", ""),
        "noise_schedule": prompt_info.get("noise_schedule", ""),
        **{key: prompt_info.get(key, "") for key in _GENERATION_BOOLEAN_FIELDS},
        "seed": prompt_info.get("seed", ""),
        "metaType": "sidecar"
    }

def has_prompt_info_text(prompt_info):
    prompt_info = prompt_info or {}
    return bool(
        str(prompt_info.get("basePrompt") or prompt_info.get("prompt") or "").strip()
        or str(prompt_info.get("negativePrompt") or prompt_info.get("negative_prompt") or prompt_info.get("uc") or "").strip()
        or str(prompt_info.get("charPrompt") or "").strip()
        or any(str(p).strip() for p in prompt_info.get("charPrompts", []) if isinstance(prompt_info.get("charPrompts", []), list))
    )

def has_prompt_info_payload(prompt_info):
    """Return whether prompt text or generation metadata is available to save."""
    prompt_info = prompt_info or {}
    return has_prompt_info_text(prompt_info) or any(
        str(prompt_info.get(key) or "").strip()
        for key in ("model", "modelName", "model_name", "sampler", "steps")
    )

def get_prompt_sidecar_path(image_path):
    return os.path.splitext(image_path)[0] + ".json"

def load_prompt_sidecar(image_path):
    sidecar_path = get_prompt_sidecar_path(image_path)

    if not os.path.exists(sidecar_path):
        return None

    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}

        # 기존 다키 저장 json 호환
        if "base_prompt" in data or "char_prompt" in data or "negative_prompt" in data:
            data = {
                **data,
                "basePrompt": data.get("base_prompt", ""),
                "baseCaption": data.get("base_caption", "") or data.get("basePrompt", "") or data.get("base_prompt", ""),
                "charPrompt": data.get("char_prompt", ""),
                "charPrompts": data.get("char_prompts") or data.get("charPrompts") or [],
                "negativePrompt": data.get("negative_prompt", ""),
                "model": data.get("model", ""),
                "modelName": data.get("modelName", "") or data.get("model_name", ""),
                "sampler": data.get("sampler", ""),
                "steps": data.get("steps", "")
            }

        info = normalize_prompt_info_for_sidecar(data)
        return info if has_prompt_info_payload(info) else None

    except Exception as e:
        print(f"⚠️ 프롬프트 사이드카 로드 실패: {sidecar_path} | {e}")
        return None

def merge_prompt_info_with_fallback(primary, fallback):
    """Keep sidecar values primary while filling missing generation metadata."""
    merged = dict(fallback or {})
    for key, value in (primary or {}).items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return normalize_prompt_info_for_sidecar(merged)

def build_fast_upscale_badge_info_from_rel_path(rel_path):
    filename = os.path.basename(str(rel_path or "")).lower()
    match = re.search(r"_upscale_(\d+)x(\d+)_([^.]*)", filename)

    if not match:
        return {"is_upscaled": False}

    return {
        "is_upscaled": True,
        "target_width": int(match.group(1) or 0),
        "target_height": int(match.group(2) or 0),
        "engine": match.group(3) or "",
        "quality": "",
        "source_path": ""
    }

def load_upscale_badge_info(image_path):
    sidecar_path = get_prompt_sidecar_path(image_path)

    info = {
        "is_upscaled": False,
        "engine": "",
        "quality": "",
        "target_width": 0,
        "target_height": 0,
        "source_path": ""
    }

    try:
        if os.path.exists(sidecar_path):
            with open(sidecar_path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}

            upscale = data.get("upscale")
            if isinstance(upscale, dict):
                info.update({
                    "is_upscaled": True,
                    "engine": str(upscale.get("engine") or "").strip(),
                    "quality": str(upscale.get("quality") or "").strip(),
                    "target_width": int(upscale.get("target_width") or 0),
                    "target_height": int(upscale.get("target_height") or 0),
                    "source_path": str(upscale.get("source_path") or "").strip()
                })
                return info
    except Exception:
        pass

    # sidecar가 없거나 예전 업스케일 파일이면 파일명으로 최소 표시
    filename = os.path.basename(str(image_path or "")).lower()
    match = re.search(r"_upscale_(\d+)x(\d+)_([^.]*)", filename)

    if match:
        info.update({
            "is_upscaled": True,
            "target_width": int(match.group(1) or 0),
            "target_height": int(match.group(2) or 0),
            "engine": match.group(3) or ""
        })

    return info

def save_prompt_sidecar(image_path, prompt_info):
    info = normalize_prompt_info_for_sidecar(prompt_info)

    if not has_prompt_info_payload(info):
        return False

    sidecar_path = get_prompt_sidecar_path(image_path)

    write_json(sidecar_path, info, indent=2)

    return True

def build_embedded_prompt_payload(prompt_info):
    info = normalize_prompt_info_for_sidecar(prompt_info or {})

    base_prompt = str(
        info.get("basePrompt")
        or info.get("baseCaption")
        or info.get("prompt")
        or ""
    ).strip()

    negative_prompt = str(
        info.get("negativePrompt")
        or info.get("negative_prompt")
        or info.get("uc")
        or ""
    ).strip()

    char_prompts = info.get("charPrompts") or []
    if not isinstance(char_prompts, list):
        char_prompts = []

    char_prompts = [
        str(item or "").strip()
        for item in char_prompts
        if str(item or "").strip()
    ]

    single_char_prompt = str(info.get("charPrompt") or "").strip()
    if single_char_prompt and not char_prompts:
        for part in single_char_prompt.split(","):
            part = part.strip()
            if part:
                char_prompts.append(part)

    merged_prompt_parts = [base_prompt] + char_prompts
    merged_prompt = ", ".join(part for part in merged_prompt_parts if part).strip()

    payload = {
        "prompt": merged_prompt or base_prompt,
        **({'promptRegions': info['promptRegions']} if 'promptRegions' in info else {}),
        "negative_prompt": negative_prompt,
        "model": info.get("model", ""),
        "modelName": info.get("modelName", ""),
        "model_name": info.get("model_name", ""),
        "sampler": info.get("sampler", ""),
        "steps": info.get("steps", ""),
        "scale": info.get("cfg", ""),
        **{key: info.get(key, "") for key in
           ("cfg_rescale", "noise_schedule", "seed", "strength", "noise", *_GENERATION_BOOLEAN_FIELDS)},
        "v4_prompt": {
            "caption": {
                "base_caption": base_prompt,
                "char_captions": [
                    {"char_caption": item}
                    for item in char_prompts
                ]
            }
        },
        "v4_negative_prompt": {
            "caption": {
                "base_caption": negative_prompt
            }
        }
    }

    return payload, merged_prompt or base_prompt, negative_prompt

def save_png_with_prompt_metadata(image_obj, save_path, prompt_info, source_label="NAI Image Manager"):
    """
    PNG 내부에 Comment / parameters 메타데이터를 저장한다.
    main_executor -> image_logic 기존 분류 로직이 이 메타를 읽을 수 있게 하기 위한 함수.
    """
    info = normalize_prompt_info_for_sidecar(prompt_info or {})

    if not has_prompt_info_payload(info):
        image_obj.save(save_path, "PNG")
        return False

    payload, prompt_text, negative_prompt = build_embedded_prompt_payload(info)
    raw_json = json.dumps(payload, ensure_ascii=False)

    pnginfo = PngInfo()
    pnginfo.add_text("Comment", raw_json)
    pnginfo.add_text("comment", raw_json)

    parameters_text = prompt_text or ""
    if negative_prompt:
        if parameters_text:
            parameters_text += f"\nNegative prompt: {negative_prompt}"
        else:
            parameters_text = f"Negative prompt: {negative_prompt}"

    if parameters_text:
        pnginfo.add_text("parameters", parameters_text)

    pnginfo.add_text("Software", source_label)

    image_obj.save(save_path, "PNG", pnginfo=pnginfo)
    return True

def normalize_char_prompts(data):
    if isinstance(data, list):
        return [str(item).strip() for item in data if str(item).strip()]

    if isinstance(data, dict):
        for key in ("char_prompts", "charPrompts", "characterPrompts"):
            arr = data.get(key)
            if isinstance(arr, list):
                cleaned = [str(item).strip() for item in arr if str(item).strip()]
                if cleaned:
                    return cleaned

        for key in ("char_prompt", "charPrompt", "characterPrompt"):
            single = str(data.get(key, "") or "").strip()
            if single:
                return [single]

        return []

    single = str(data or "").strip()
    return [single] if single else []
