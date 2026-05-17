# -*- coding: utf-8 -*-
import shutil
import re
import json
import queue
import threading
from flask import Flask, jsonify, send_file, request
import image_logic
import upscale_logic
import subprocess
import sys
import utils
import time
import os
from PIL import Image
from PIL.PngImagePlugin import PngInfo
import urllib.request
import urllib.error
import zipfile
import io
import base64
import datetime
import random
import sqlite3
import atexit
from urllib.parse import urlsplit, unquote, quote

app = Flask(__name__)

# 경로 설정
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
CLASSIFIED_DIR = os.path.join(CURRENT_DIR, "TOTAL_CLASSIFIED")
TRASH_DIR = os.path.join(CLASSIFIED_DIR, "_TRASH")
QUALITY_PRESETS_FILE = os.path.join(CURRENT_DIR, "quality_presets.json")
TAG_DATA_DIR = os.path.join(CURRENT_DIR, "data")
TAG_CATEGORY_FILE = os.path.join(TAG_DATA_DIR, "tag_categories_ko.generated.json")
TAG_CATEGORY_OVERRIDE_FILE = os.path.join(TAG_DATA_DIR, "tag_categories_ko.json")
TAG_DB_FILE = os.path.join(TAG_DATA_DIR, "danbooru_tags.sqlite3")
TAG_GROUP_LABELS = {
    "expression": "표정",
    "top": "상의",
    "bottom": "하의",
    "outfit": "의상",
    "body": "신체",
    "nsfw": "성인",
}
TAG_GROUP_COLORS = {
    "expression": "#f59e0b",
    "top": "#38bdf8",
    "bottom": "#22c55e",
    "outfit": "#a78bfa",
    "body": "#fb7185",
    "nsfw": "#ef4444",
}
DANBOORU_CATEGORY_LABELS = {
    0: "일반",
    1: "작가",
    3: "저작권",
    4: "캐릭터",
    5: "메타",
}
DANBOORU_CATEGORY_COLORS = {
    0: "#64748b",
    1: "#f97316",
    3: "#eab308",
    4: "#ec4899",
    5: "#14b8a6",
}

TAG_DICTIONARY_USER_OVERRIDES = os.path.join(CURRENT_DIR, 'tag_dictionary_user_overrides.json')
GALLERY_IMAGE_TAGS_FILE = os.path.join(CURRENT_DIR, "gallery_image_tags.json")
GALLERY_SERVER_SESSION_ID = f"gallery_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
UPSCALE_OUTPUT_FOLDER_NAME = "_upscaled"
UPSCALE_IGNORE_FILE_NAME = ".ignore"
CANVAS_SETUPS_FILE = os.path.join(CURRENT_DIR, "canvas_saved_setups.json")


def normalize_canvas_saved_setup_item(item):
    if not isinstance(item, dict):
        return None

    state = item.get("state")
    if not isinstance(state, dict):
        return None

    setup_id = str(item.get("id") or "").strip()
    if not setup_id:
        setup_id = f"canvas_setup_server_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"

    name = str(item.get("name") or "이름 없는 캔버스").strip() or "이름 없는 캔버스"

    try:
        saved_at = int(item.get("savedAt") or item.get("saved_at") or int(time.time() * 1000))
    except Exception:
        saved_at = int(time.time() * 1000)

    try:
        width = int(item.get("width") or state.get("width") or 0)
    except Exception:
        width = 0

    try:
        height = int(item.get("height") or state.get("height") or 0)
    except Exception:
        height = 0

    try:
        layer_count = int(item.get("layerCount") or item.get("layer_count") or 0)
    except Exception:
        layer_count = 0

    save_mode = str(item.get("saveMode") or item.get("save_mode") or "normal").strip() or "normal"

    normalized = dict(item)
    normalized.update({
        "id": setup_id,
        "name": name,
        "savedAt": saved_at,
        "width": width,
        "height": height,
        "layerCount": layer_count,
        "saveMode": save_mode,
        "state": state
    })

    return normalized


def normalize_canvas_saved_setups(setups):
    if not isinstance(setups, list):
        return []

    result = []
    seen_ids = set()

    for item in setups:
        normalized = normalize_canvas_saved_setup_item(item)
        if not normalized:
            continue

        setup_id = normalized["id"]

        if setup_id in seen_ids:
            normalized["id"] = f"{setup_id}_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
            setup_id = normalized["id"]

        seen_ids.add(setup_id)
        result.append(normalized)

    result.sort(key=lambda item: int(item.get("savedAt") or 0), reverse=True)
    return result


def load_canvas_saved_setups():
    if not os.path.exists(CANVAS_SETUPS_FILE):
        return []

    try:
        with open(CANVAS_SETUPS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f) or []
        return normalize_canvas_saved_setups(data)
    except Exception as e:
        print(f"⚠️ 캔버스 저장본 로드 실패: {e}")
        return []


def save_canvas_saved_setups(setups):
    setups = normalize_canvas_saved_setups(setups)
    tmp_path = CANVAS_SETUPS_FILE + ".tmp"

    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(setups, f, ensure_ascii=False, indent=2)

    os.replace(tmp_path, CANVAS_SETUPS_FILE)
    return setups


@app.route("/api/canvas/setups", methods=["GET"])
def get_canvas_saved_setups():
    setups = load_canvas_saved_setups()
    return jsonify({
        "status": "success",
        "setups": setups,
        "count": len(setups)
    })


@app.route("/api/canvas/setups", methods=["POST"])
def set_canvas_saved_setups():
    data = request.json or {}
    setups = data.get("setups", [])

    if not isinstance(setups, list):
        return jsonify({
            "status": "error",
            "message": "캔버스 저장본 목록 형식이 올바르지 않습니다."
        }), 400

    saved = save_canvas_saved_setups(setups)

    return jsonify({
        "status": "success",
        "setups": saved,
        "count": len(saved)
    })

def gallery_svg_data_url(svg):
    return "data:image/svg+xml;charset=utf-8," + quote(svg, safe="/:;?&=+$,-_.!~*'()")


def gallery_icon_tag(tag_id, svg):
    return {
        "id": tag_id,
        "type": "image",
        "value": gallery_svg_data_url(svg)
    }


def normalize_gallery_color(value, fallback):
    value = str(value or "").strip()
    if re.match(r"^#[0-9A-Fa-f]{6}$", value):
        return value
    return fallback


def default_gallery_image_tags_config():
    return {
        "tags": [
            gallery_icon_tag("star", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#ffd84d' d='M32 5l7.8 16.1 17.8 2.6-12.9 12.6 3 17.7L32 45.7 16.3 54l3-17.7L6.4 23.7l17.8-2.6z'/></svg>"),
            gallery_icon_tag("moon", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#d8ddff' d='M43.5 51.7A25 25 0 0 1 31.8 4.5 22 22 0 1 0 59.5 32.2 25 25 0 0 1 43.5 51.7z'/></svg>"),
            gallery_icon_tag("sun", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='14' fill='#ffb02e'/><g stroke='#ffb02e' stroke-width='5' stroke-linecap='round'><path d='M32 4v9M32 51v9M4 32h9M51 32h9M12.2 12.2l6.4 6.4M45.4 45.4l6.4 6.4M51.8 12.2l-6.4 6.4M18.6 45.4l-6.4 6.4'/></g></svg>"),
            gallery_icon_tag("heart", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#ff4d7d' d='M32 55S8 41.2 8 22.7C8 13.9 14.4 9 21.5 9c4.5 0 8.5 2.3 10.5 6 2-3.7 6-6 10.5-6C49.6 9 56 13.9 56 22.7 56 41.2 32 55 32 55z'/></svg>"),
            gallery_icon_tag("clover", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#2ecc71' d='M29 31C17 27 17 10 29 10c4 0 6 3 7 6 1-3 3-6 7-6 12 0 12 17 0 21 12 4 12 21 0 21-4 0-6-3-7-6-1 3-3 6-7 6-12 0-12-17 0-21z'/><path stroke='#2ecc71' stroke-width='5' stroke-linecap='round' d='M35 38c-1 8-5 15-11 20'/></svg>"),
            gallery_icon_tag("sparkle", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#ffe66d' d='M32 4l6 20 20 8-20 8-6 20-6-20-20-8 20-8z'/><path fill='#fff4a3' d='M51 4l3 10 10 3-10 3-3 10-3-10-10-3 10-3z'/></svg>"),
            gallery_icon_tag("check", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='28' fill='#2dd4bf'/><path d='M18 33l9 9 20-22' fill='none' stroke='#001' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/></svg>"),
            gallery_icon_tag("cross", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='28' fill='#ff6b6b'/><path d='M22 22l20 20M42 22L22 42' fill='none' stroke='#fff' stroke-width='7' stroke-linecap='round'/></svg>"),
            gallery_icon_tag("crown", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#ffd84d' d='M8 20l14 12L32 12l10 20 14-12-6 32H14z'/><path fill='#fff1a8' d='M14 52h36v6H14z'/></svg>"),
            gallery_icon_tag("fire", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#ff7a1a' d='M32 58c-12 0-20-8-20-19 0-9 6-15 12-22 1 7 5 10 9 13 2-8 0-15-2-24 12 8 21 18 21 32 0 12-8 20-20 20z'/><path fill='#ffd84d' d='M32 55c-6 0-10-4-10-10 0-5 3-8 7-12 1 4 3 6 6 8 1-4 0-8-1-12 6 5 10 10 10 17 0 6-5 9-12 9z'/></svg>"),
            gallery_icon_tag("flower", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='8' fill='#ffd84d'/><g fill='#ff8bd1'><circle cx='32' cy='14' r='10'/><circle cx='32' cy='50' r='10'/><circle cx='14' cy='32' r='10'/><circle cx='50' cy='32' r='10'/></g></svg>"),
            gallery_icon_tag("diamond", "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><path fill='#7dd3fc' d='M32 4l24 28-24 28L8 32z'/><path fill='#e0f2fe' d='M32 4l10 28H22z'/></svg>")
        ],
        "image_tags": {}
    }


def default_gallery_tag_icon_values():
    return {
        str(tag.get("id")): str(tag.get("value"))
        for tag in default_gallery_image_tags_config().get("tags", [])
        if tag.get("id") and tag.get("value")
    }


def normalize_gallery_image_tag_config(data):
    base = default_gallery_image_tags_config()

    if not isinstance(data, dict):
        return base

    raw_tags = data.get("tags")
    raw_image_tags = data.get("image_tags")

    tags = []
    seen = set()
    default_icon_values = default_gallery_tag_icon_values()
    legacy_emoji_values = {"⭐", "🌙", "☀️", "❤️", "🍀", "✨", "✅"}

    if isinstance(raw_tags, list):
        for item in raw_tags:
            if not isinstance(item, dict):
                continue

            tag_id = re.sub(r"[^A-Za-z0-9_-]+", "_", str(item.get("id") or item.get("name") or "").strip()).strip("_")
            tag_id = tag_id[:60]

            if not tag_id or tag_id in seen:
                continue

            value = str(item.get("value") or "").strip()
            if not value:
                continue

            tag_type = str(item.get("type") or "").strip().lower()
            is_image_value = (
                value.startswith("data:image/")
                or value.startswith("/image/")
                or value.startswith("/static/")
                or value.startswith("http://")
                or value.startswith("https://")
            )

            if not tag_type:
                tag_type = "image" if is_image_value else "text"

            if tag_id in default_icon_values and value in legacy_emoji_values:
                tag_type = "image"
                value = default_icon_values[tag_id]
                is_image_value = True

            if tag_type == "image":
                if not is_image_value:
                    continue

                tags.append({
                    "id": tag_id,
                    "type": "image",
                    "value": value
                })
                seen.add(tag_id)
                continue

            if tag_type == "text":
                text_value = value[:12]
                if not text_value:
                    continue

                tags.append({
                    "id": tag_id,
                    "type": "text",
                    "value": text_value,
                    "textColor": normalize_gallery_color(item.get("textColor"), "#ffffff"),
                    "bgColor": normalize_gallery_color(item.get("bgColor"), "#2563eb")
                })
                seen.add(tag_id)
                continue

    if not tags:
        tags = base["tags"]
    else:
        existing_ids = {str(tag.get("id")) for tag in tags}
        merged_tags = []

        for default_tag in base["tags"]:
            if str(default_tag.get("id")) not in existing_ids:
                merged_tags.append(default_tag)

        merged_tags.extend(tags)
        tags = merged_tags

    valid_ids = {tag["id"] for tag in tags}
    image_tags = {}

    if isinstance(raw_image_tags, dict):
        for path, tag_id in raw_image_tags.items():
            clean_path = clean_gallery_rel_path(path)
            tag_id = str(tag_id or "").strip()
            if clean_path and tag_id in valid_ids:
                image_tags[clean_path] = tag_id

    return {
        "tags": tags,
        "image_tags": image_tags
    }


def load_gallery_image_tags_config():
    if not os.path.exists(GALLERY_IMAGE_TAGS_FILE):
        config = default_gallery_image_tags_config()
        save_gallery_image_tags_config(config)
        return config

    try:
        with open(GALLERY_IMAGE_TAGS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        return normalize_gallery_image_tag_config(data)
    except Exception as e:
        print(f"⚠️ 폴더 매핑 로드 실패: {e}")
        return default_gallery_image_tags_config()


def save_gallery_image_tags_config(config):
    config = normalize_gallery_image_tag_config(config)
    with open(GALLERY_IMAGE_TAGS_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
    return config


def get_gallery_image_tag_for_path(config, rel_path):
    clean_path = clean_gallery_rel_path(rel_path)
    return (config.get("image_tags") or {}).get(clean_path, "")


def move_gallery_image_tag_path(old_path, new_path):
    config = load_gallery_image_tags_config()
    image_tags = config.get("image_tags") or {}

    old_key = clean_gallery_rel_path(old_path)
    new_key = clean_gallery_rel_path(new_path)

    if old_key and new_key and old_key in image_tags:
        image_tags[new_key] = image_tags.pop(old_key)
        config["image_tags"] = image_tags
        save_gallery_image_tags_config(config)

def normalize_brand_lookup_key(value):
    text = str(value or "").strip()

    if not text:
        return ""

    text = re.sub(r'_(dakimakura|\d+pcs)$', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+(dakimakura|\d+pcs)$', '', text, flags=re.IGNORECASE)
    text = text.replace("_", " ")
    text = re.sub(r"[()\[\]{}]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


def build_character_brand_lookup_aliases(tag, clean_name=""):
    aliases = set()

    raw_values = [
        tag,
        clean_name,
        str(tag or "").replace("_", " "),
        str(clean_name or "").replace("_", " ")
    ]

    for value in raw_values:
        key = normalize_brand_lookup_key(value)
        if key:
            aliases.add(key)

        # 괄호 안/밖 표기가 있는 캐릭터명 대응
        text = str(value or "").strip()
        for inside in re.findall(r"\(([^)]+)\)", text):
            inside_key = normalize_brand_lookup_key(inside)
            if inside_key:
                aliases.add(inside_key)

        outside = re.sub(r"\([^)]*\)", " ", text)
        outside_key = normalize_brand_lookup_key(outside)
        if outside_key:
            aliases.add(outside_key)

    return aliases

def collect_gallery_tree_brand_lookup_keys(node, output=None):
    if output is None:
        output = set()

    if not isinstance(node, dict):
        return output

    raw_names = []

    if node.get("name"):
        raw_names.append(node.get("name"))

    if isinstance(node.get("char_names"), list):
        raw_names.extend(node.get("char_names"))

    for name in raw_names:
        for alias in build_character_brand_lookup_aliases(name, name):
            if alias:
                output.add(alias)

    folders = node.get("folders") or []
    if isinstance(folders, dict):
        folders = folders.values()

    for child in folders:
        collect_gallery_tree_brand_lookup_keys(child, output)

    return output

def load_folder_display_names(db, verbose=False):
    folder_names_map = {}
    try:
        cursor = db.conn.cursor()
        cursor.execute(
            "CREATE TABLE IF NOT EXISTS folder_display_names (physical_name TEXT PRIMARY KEY, full_name TEXT)")
        cursor.execute("SELECT physical_name, full_name FROM folder_display_names")
        for row in cursor.fetchall():
            folder_names_map[row[0]] = row[1]
    except Exception as e:
        if verbose:
            print(f"⚠️ 폴더 매핑 로드 실패: {e}")
    return folder_names_map


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
                    user_comment = exif[37510]
                    if isinstance(user_comment, bytes):
                        raw_meta = user_comment.decode('utf-8', errors='ignore').replace('\x00', '')
                        if raw_meta.startswith('UNICODE') or raw_meta.startswith('ASCII'):
                            raw_meta = raw_meta[8:]
                    else:
                        raw_meta = str(user_comment)

        raw_meta = str(raw_meta or "").strip()
        meta = {}

        if raw_meta.startswith('{'):
            try:
                meta = json.loads(raw_meta)
                if "Comment" in meta and isinstance(meta["Comment"], str) and meta["Comment"].strip().startswith('{'):
                    meta = json.loads(meta["Comment"])
            except json.JSONDecodeError:
                meta = {}

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

    return {
        "basePrompt": base_prompt,
        "baseCaption": base_caption or base_prompt,
        "negativePrompt": negative_prompt,
        "negative_prompt": negative_prompt,
        "uc": negative_prompt,
        "charPrompt": char_prompt_text,
        "charPrompts": char_prompts,
        "strength": prompt_info.get("strength", ""),
        "noise": prompt_info.get("noise", ""),
        "sampler": prompt_info.get("sampler", ""),
        "steps": prompt_info.get("steps", ""),
        "cfg": prompt_info.get("cfg", prompt_info.get("scale", "")),
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
                "basePrompt": data.get("base_prompt", ""),
                "baseCaption": data.get("base_caption", "") or data.get("basePrompt", "") or data.get("base_prompt", ""),
                "charPrompt": data.get("char_prompt", ""),
                "charPrompts": data.get("char_prompts") or data.get("charPrompts") or [],
                "negativePrompt": data.get("negative_prompt", "")
            }

        info = normalize_prompt_info_for_sidecar(data)
        return info if has_prompt_info_text(info) else None

    except Exception as e:
        print(f"⚠️ 프롬프트 사이드카 로드 실패: {sidecar_path} | {e}")
        return None

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

    if not has_prompt_info_text(info):
        return False

    sidecar_path = get_prompt_sidecar_path(image_path)

    with open(sidecar_path, "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

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
    if single_char_prompt:
        for part in single_char_prompt.split(","):
            part = part.strip()
            if part:
                char_prompts.append(part)

    merged_prompt_parts = [base_prompt] + char_prompts
    merged_prompt = ", ".join(part for part in merged_prompt_parts if part).strip()

    payload = {
        "prompt": merged_prompt or base_prompt,
        "negative_prompt": negative_prompt,
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

    if not has_prompt_info_text(info):
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

@app.route('/')
def index():
    return send_file('index.html')


# 🌟 [새로 추가] 재시도 및 한국어 에러 처리 도우미 함수
def safe_file_operation(target_path, dest_path=None, is_delete=False, retries=5, delay=0.2):
    if not os.path.exists(target_path):
        return False, "파일을 찾을 수 없습니다. (이미 이동되었거나 새로고침이 필요합니다)."

    for attempt in range(retries):
        try:
            if is_delete:
                os.remove(target_path)
            else:
                os.rename(target_path, dest_path)
            return True, "성공"
        except OSError as e:
            if attempt < retries - 1:
                time.sleep(delay)  # 파일이 잠겨있다면 잠깐 대기 후 재시도
                continue

            # 에러 종류별 한국어 친화적 메시지 매핑
            err_msg = str(e)
            if "Errno 22" in err_msg or "WinError 32" in err_msg or "Errno 13" in err_msg:
                return False, "파일이 다른 프로그램 또는 AI 분석 작업에 의해 잠겨 있습니다. 1~2초 후 다시 시도해 주세요."
            elif "Errno 2" in err_msg:
                return False, "파일 경로가 올바르지 않습니다."
            else:
                return False, f"서버 오류: {err_msg}"

    return False, "최대 재시도 횟수를 초과했습니다."


@app.route('/api/install_ai', methods=['POST'])
def install_ai():
    try:
        # 시스템의 파이썬을 이용해 백그라운드에서 torch와 transformers 설치
        # 설치가 오래 걸릴 수 있으므로 즉시 응답합니다.
        print("AI 분석 패키지 설치를 백그라운드에서 시작합니다. (완료까지 시간이 걸릴 수 있습니다...)")
        subprocess.Popen([sys.executable, "-m", "pip", "install", "torch", "torchvision", "transformers"])

        return jsonify({"status": "success", "message": "설치를 백그라운드에서 시작했습니다. 완료 후 새로고침하거나 앱을 다시 실행해 주세요."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})


@app.route('/api/data')
def get_data():
    mode = request.args.get('mode', 'general')
    sort_by = request.args.get('sort', 'name')

    if not os.path.exists(CLASSIFIED_DIR):
        return jsonify({"tree": {"name": "ROOT", "folders": [], "images": [], "total_images": 0}, "baseDir": ""})

    tree_dict = {"name": "ROOT", "path": "", "folders": {}, "images": [], "thumb": None, "total_images": 0}
    gallery_tag_config = load_gallery_image_tags_config()

    # 1. 갤러리 표시용 DB 폴더명 매핑을 먼저 로드
    db = utils.HistoryDB()

    # 2. 🌟 [들여쓰기 수정] 모든 모드에서 폴더명 매핑을 사용할 수 있게 밖으로 꺼냅니다.
    folder_names_map = load_folder_display_names(db, verbose=True)

    # 3. 모드 설정에 따른 스캔 경로 구성 (이제 매핑 로직은 여기서 빠집니다)
    scan_configs = []
    if mode == 'general':
        scan_configs.append({"path": CLASSIFIED_DIR, "ignore": ["_R-18", "_R-15", "_TRASH"]})
    elif mode == 'r18':
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-18"), "ignore": []})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-15"), "ignore": []})
    elif mode == 'all':
        scan_configs.append({"path": CLASSIFIED_DIR, "ignore": ["_R-18", "_R-15", "_TRASH"]})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-18"), "ignore": []})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-15"), "ignore": []})
    elif mode == 'trash':
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_TRASH"), "ignore": []})

    # 정렬 기준에 따라 폴더를 정렬
    def scan_recursive(physical_path, virtual_node, ignore_list=[]):
        if not os.path.exists(physical_path): return
        try:
            with os.scandir(physical_path) as entries:
                for entry in entries:
                    if entry.name in ignore_list: continue

                    if entry.is_dir():
                        if entry.name == UPSCALE_OUTPUT_FOLDER_NAME:
                            try:
                                with os.scandir(entry.path) as upscaled_entries:
                                    for up_entry in upscaled_entries:
                                        if not up_entry.is_file():
                                            continue

                                        if not up_entry.name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                                            continue

                                        rel_img = os.path.relpath(up_entry.path, CLASSIFIED_DIR).replace('\\', '/')
                                        mtime = os.path.getmtime(up_entry.path)
                                        cached = db.get_file_metadata(rel_img)

                                        img_w, img_h = None, None
                                        if cached and cached[2] == mtime:
                                            img_w, img_h = cached[0], cached[1]
                                        else:
                                            try:
                                                with Image.open(up_entry.path) as img:
                                                    img_w, img_h = img.size
                                                db.save_file_metadata(rel_img, img_w, img_h, mtime)
                                            except Exception as img_err:
                                                print(f"⚠️ 업스케일 이미지 크기 확인 실패: {up_entry.path} | {img_err}")

                                        txt_path = os.path.splitext(up_entry.path)[0] + ".txt"
                                        reason_text = ""
                                        if os.path.exists(txt_path):
                                            try:
                                                with open(txt_path, "r", encoding="utf-8") as f:
                                                    reason_text = f.read()
                                            except Exception as txt_err:
                                                print(f"⚠️ 업스케일 이미지 사유 파일 읽기 실패: {txt_path} | {txt_err}")

                                        virtual_node["images"].append({
                                            "name": up_entry.name,
                                            "path": rel_img,
                                            "w": img_w,
                                            "h": img_h,
                                            "mtime": mtime,
                                            "reason": reason_text,
                                            "gallery_tag": get_gallery_image_tag_for_path(gallery_tag_config, rel_img),
                                            "is_upscaled": True
                                        })
                                        virtual_node["total_images"] += 1
                            except Exception as upscaled_err:
                                print(f"⚠️ 업스케일 폴더 스캔 실패: {entry.path} | {upscaled_err}")

                            continue
                        # DB에 저장된 원본 폴더명을 우선 사용해서 잘린 폴더명을 복원
                        display_name = folder_names_map.get(entry.name, entry.name)

                        # _and_ 또는 and 기준으로 다중 캐릭터명을 분리
                        clean_n = re.sub(r'_(dakimakura|\d+pcs)$', '', display_name, flags=re.IGNORECASE)
                        split_chars = re.split(r'_and_|\s+and\s+', clean_n, flags=re.IGNORECASE)
                        char_names_list = [c.replace('_', ' ').strip() for c in split_chars if c.strip()]

                        if entry.name not in virtual_node["folders"]:
                            virtual_node["folders"][entry.name] = {
                                "name": display_name,  # 🌟 화면(UI)에는 380자짜리 풀네임이 렌더링됨
                                "char_names": char_names_list,
                                "path": os.path.relpath(entry.path, CLASSIFIED_DIR).replace('\\', '/'),
                                "folders": {}, "images": [], "thumb": None, "total_images": 0
                            }
                        scan_recursive(entry.path, virtual_node["folders"][entry.name])

                    elif entry.is_file() and entry.name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                        rel_img = os.path.relpath(entry.path, CLASSIFIED_DIR).replace('\\', '/')
                        mtime = os.path.getmtime(entry.path)
                        cached = db.get_file_metadata(rel_img)

                        img_w, img_h = None, None
                        if cached and cached[2] == mtime:
                            img_w, img_h = cached[0], cached[1]
                        else:
                            try:
                                with Image.open(entry.path) as img:
                                    img_w, img_h = img.size
                                db.save_file_metadata(rel_img, img_w, img_h, mtime)
                            except Exception as img_err:
                                print(f"⚠️ 이미지 메타데이터 읽기 실패: {entry.path} | {img_err}")

                        # 이미지 옆의 사유(txt) 파일도 함께 노출
                        txt_path = os.path.splitext(entry.path)[0] + ".txt"
                        reason_text = ""
                        if os.path.exists(txt_path):
                            try:
                                with open(txt_path, "r", encoding="utf-8") as f:
                                    reason_text = f.read()
                            except Exception as txt_err:
                                print(f"⚠️ 사유 텍스트 읽기 실패: {txt_path} | {txt_err}")

                        virtual_node["images"].append({
                            "name": entry.name, "path": rel_img, "w": img_w, "h": img_h,
                            "mtime": mtime,
                            "reason": reason_text,
                            "gallery_tag": get_gallery_image_tag_for_path(gallery_tag_config, rel_img)
                        })
                        virtual_node["total_images"] += 1
        except Exception as scan_err:
            print(f"⚠️ 폴더 스캔 실패: {physical_path} | {scan_err}")

    # 2. 하위 폴더 정리
    for config in scan_configs:
        scan_recursive(config["path"], tree_dict, config["ignore"])

    # 3. 폴더 리스트 정렬 및 빈 폴더 제거
    def finalize_tree(node, depth=0):
        folder_list = list(node["folders"].values())

        # 🌟 [수술 1] 상위 폴더가 엉뚱한 이미지를 가져가지 않도록 하위 폴더를 먼저 이름순으로 정렬!
        if depth == 0:
            order_map = {"1_Solo": 1, "2_Duo": 2, "3_Group": 3, "No_Metadata": 99}
            folder_list.sort(key=lambda x: (order_map.get(x["name"], 50), x["name"]))
        else:
            folder_list.sort(key=lambda x: (x["name"] == "No_Metadata", x["name"]))

        for child in folder_list:
            finalize_tree(child, depth + 1)
            node["total_images"] += child["total_images"]
            # 상위 폴더가 대표 이미지를 가져가지 않도록 정렬 우선순위를 적용
            if not node["thumb"] and child["thumb"]: node["thumb"] = child["thumb"]

        # 기본 정렬
        folder_list = [f for f in folder_list if f["total_images"] > 0]

        # 모드에 따른 최종 폴더 정렬
        if mode == 'trash':
            folder_list.sort(key=lambda x: x["name"], reverse=True)
        elif sort_by == 'count':
            folder_list.sort(key=lambda x: (x["name"] == "No_Metadata", -x["total_images"]))

        node["folders"] = folder_list
        node["images"].sort(key=lambda x: (-float(x.get("mtime") or 0), x["name"]))

        # 메타데이터 없는 폴더명 패턴은 뒤쪽으로 정렬
        main_img = next((img["path"] for img in node["images"] if img["name"].startswith("000_MAIN_")), None)
        if not node["thumb"] and node["images"]:
            node["thumb"] = main_img if main_img else node["images"][0]["path"]

    finalize_tree(tree_dict, depth=0)

    # 브랜드 매핑 및 표시 설정 구성
    # app.py 내 brand_map 생성 부분 보강
    # 브랜드별 캐릭터 매핑 데이터 생성
    # 브랜드 노출 설정 데이터 생성
    brand_map = {}
    brand_visibility = {}

    try:
        needed_brand_keys = collect_gallery_tree_brand_lookup_keys(tree_dict)

        cursor = db.conn.cursor()
        cursor.execute(
            "SELECT tag, clean_name, brand, brand_kr, COALESCE(is_visible, 1) "
            "FROM known_characters "
            "WHERE brand IS NOT NULL AND brand != 'Unknown'"
        )

        for row in cursor.fetchall():
            tag, clean_name, brand, brand_kr, is_visible = row[0], row[1], row[2], row[3], row[4]
            aliases = build_character_brand_lookup_aliases(tag, clean_name)

            matched_aliases = [alias for alias in aliases if alias in needed_brand_keys]
            if not matched_aliases:
                continue

            display_brand = brand_kr if brand_kr else brand.replace('_', ' ').replace('The ', '').title()

            for alias in matched_aliases:
                brand_map[alias] = display_brand

            brand_visibility[display_brand] = is_visible

    except Exception as e:
        print(f"⚠️ 매핑 오류: {e}")

    db.close()

    return jsonify({
        "tree": tree_dict,
        "baseDir": "TOTAL_CLASSIFIED",
        "brand_map": brand_map,
        "brand_visibility": brand_visibility,  # 브랜드별 노출 스위치
        "server_session_id": GALLERY_SERVER_SESSION_ID,
        "gallery_tags": {
            "tags": gallery_tag_config.get("tags", []),
            "image_tags": gallery_tag_config.get("image_tags", {})
        }
    })


@app.route('/api/gallery/tags', methods=['GET'])
def get_gallery_tags():
    config = load_gallery_image_tags_config()
    return jsonify({
        "status": "success",
        "tags": config.get("tags", []),
        "image_tags": config.get("image_tags", {})
    })


@app.route('/api/gallery/tags', methods=['POST'])
def save_gallery_tags():
    data = request.json or {}
    tags = data.get("tags", [])

    current = load_gallery_image_tags_config()
    current["tags"] = tags
    saved = save_gallery_image_tags_config(current)

    return jsonify({
        "status": "success",
        "tags": saved.get("tags", []),
        "image_tags": saved.get("image_tags", {})
    })


@app.route('/api/gallery/image_tag', methods=['POST'])
def set_gallery_image_tag():
    data = request.json or {}
    rel_path = clean_gallery_rel_path(data.get("path", ""))
    tag_id = str(data.get("tag_id") or "").strip()

    if not rel_path:
        return jsonify({"status": "error", "message": "이미지 경로가 없습니다."}), 400

    config = load_gallery_image_tags_config()
    valid_ids = {tag.get("id") for tag in config.get("tags", [])}
    image_tags = config.get("image_tags") or {}

    if tag_id:
        if tag_id not in valid_ids:
            return jsonify({"status": "error", "message": "존재하지 않는 태그입니다."}), 400
        image_tags[rel_path] = tag_id
    else:
        image_tags.pop(rel_path, None)

    config["image_tags"] = image_tags
    saved = save_gallery_image_tags_config(config)

    return jsonify({
        "status": "success",
        "path": rel_path,
        "tag_id": image_tags.get(rel_path, ""),
        "tags": saved.get("tags", []),
        "image_tags": saved.get("image_tags", {})
    })


@app.route('/image/<path:filename>')
def serve_image(filename):
    try:
        file_path = utils.resolve_safe_path(CLASSIFIED_DIR, filename, strip_prefix="TOTAL_CLASSIFIED/")
    except ValueError:
        return "Invalid path", 400
    if os.path.exists(file_path):
        return send_file(file_path)
    return "Not found", 404

_last_reveal_request = {
    "path": "",
    "time": 0
}


def clean_gallery_rel_path(raw_path):
    path = str(raw_path or "").strip()

    # /image/... 형태로 들어와도 처리
    parsed = urlsplit(path)
    if parsed.path:
        path = parsed.path

    path = unquote(path)
    path = path.replace("\\", "/")

    if path.startswith("/image/"):
        path = path[len("/image/"):]

    if path.startswith("image/"):
        path = path[len("image/"):]

    if path.startswith("/"):
        path = path[1:]

    if path.startswith("TOTAL_CLASSIFIED/"):
        path = path[len("TOTAL_CLASSIFIED/"):]

    return path


def resolve_gallery_image_path(raw_path):
    rel_path = clean_gallery_rel_path(raw_path)

    if not rel_path:
        raise FileNotFoundError("이미지 경로가 비어 있습니다.")

    candidates = [rel_path]

    if rel_path.startswith("_R-18/"):
        candidates.append(rel_path[len("_R-18/"):])
    else:
        candidates.append("_R-18/" + rel_path)

    if rel_path.startswith("_R-15/"):
        candidates.append(rel_path[len("_R-15/"):])
    else:
        candidates.append("_R-15/" + rel_path)

    candidates.append("TOTAL_CLASSIFIED/" + rel_path)

    seen = set()

    for candidate in candidates:
        candidate = candidate.replace("\\", "/")
        if candidate in seen:
            continue
        seen.add(candidate)

        try:
            full_path = utils.resolve_safe_path(
                CLASSIFIED_DIR,
                candidate,
                strip_prefix="TOTAL_CLASSIFIED/"
            )
        except Exception:
            continue

        if os.path.exists(full_path) and os.path.isfile(full_path):
            real_rel = os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
            return full_path, real_rel

    # 정확한 파일은 못 찾았지만 폴더는 있는 경우
    try:
        expected_path = utils.resolve_safe_path(
            CLASSIFIED_DIR,
            rel_path,
            strip_prefix="TOTAL_CLASSIFIED/"
        )
        expected_dir = os.path.dirname(expected_path)

        if os.path.exists(expected_dir):
            raise FileNotFoundError(
                f"파일을 찾을 수 없습니다. 필요한 파일명: {os.path.basename(expected_path)}"
            )
    except FileNotFoundError:
        raise
    except Exception:
        pass

    raise FileNotFoundError("파일을 찾을 수 없습니다. 이미 이동되었거나 새로고침이 필요합니다.")

def build_gallery_prompt_filter_text(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    for key in (
        "basePrompt",
        "baseCaption",
        "prompt",
        "base_prompt",
        "negativePrompt",
        "negative_prompt",
        "uc",
        "charPrompt",
        "characterPrompt"
    ):
        value = prompt_info.get(key)
        if value:
            parts.append(str(value))

    char_prompts = prompt_info.get("charPrompts") or prompt_info.get("char_prompts") or []
    if isinstance(char_prompts, list):
        parts.extend(str(item) for item in char_prompts if item)

    return " ".join(parts).lower()


def fetch_gallery_weighted_art_styles_for_paths(db, paths):
    result = {path: [] for path in paths}
    clean_paths = [str(path or "").replace("\\", "/") for path in paths if path]

    if not clean_paths:
        return result

    cursor = db.conn.cursor()
    chunk_size = 450

    rows_by_path = {}

    for i in range(0, len(clean_paths), chunk_size):
        chunk = clean_paths[i:i + chunk_size]
        placeholders = ",".join(["?"] * len(chunk))

        cursor.execute(f"""
            SELECT i.path, i.artist_name, COALESCE(a.name_kr, '')
            FROM image_artists i
            LEFT JOIN art_styles a ON a.artist_name = i.artist_name
            WHERE i.path IN ({placeholders})
        """, chunk)

        for path, artist_name, name_kr in cursor.fetchall():
            if not is_gallery_weighted_art_style_prompt(artist_name):
                continue

            clean_path = str(path).replace("\\", "/")
            rows_by_path.setdefault(clean_path, []).append((artist_name, name_kr or ""))

    for path, rows in rows_by_path.items():
        if not rows:
            continue

        # main 갤러리 그림체 후보 우선순위:
        # 1. [가중치] 또는 [조합형] 접두어가 있는 항목
        # 2. artist 태그가 2개 이상인 순서 보존 가중치 프롬프트
        # 3. 일반 artist 조합, 4. 기타 항목
        def priority(row):
            artist_name = str(row[0] or "")
            if artist_name.startswith("[가중치]") or artist_name.startswith("[조합형]"):
                return 0
            if len(re.findall(r'[-+]?\d+(?:\.\d+)?::\s*artist:', artist_name, flags=re.IGNORECASE)) >= 2:
                return 1
            if "," in artist_name and "artist:" in artist_name:
                return 2
            return 3

        artist_name, name_kr = sorted(rows, key=priority)[0]
        prompt = cleanup_gallery_weighted_art_style_prompt(artist_name)

        if prompt:
            result[path] = [{
                "key": prompt,
                "prompt": prompt,
                "raw_artist": artist_name,
                "name_kr": name_kr
            }]

    return result




def is_gallery_weighted_art_style_prompt(text):
    text = str(text or "").strip()
    if not text:
        return False

    if text.startswith("[가중치]") or text.startswith("[조합형]"):
        return True

    # 가중치/조합형 표기 또는 artist 태그가 있으면 그림체 프롬프트로 판단한다.
    if "artist:" in text:
        return True

    return False




def cleanup_gallery_weighted_art_style_prompt(text):
    text = str(text or "").strip()
    text = re.sub(r'^\[가중치]\s*', '', text).strip()
    text = re.sub(r'^\[조합형]\s*', '', text).strip()
    return cleanup_weighted_order_style_prompt(text)




def extract_gallery_weighted_art_style_prompts_from_text(text):
    text = str(text or "")
    if not text.strip():
        return []

    target_text = text.replace('\\\\n', '\n').replace('\\n', '\n')

    # image_logic.py의 scan_and_extract_artists와 맞춘 추출 규칙:
    # 1) [가중치] 또는 [조합형] 접두어가 붙은 한 줄 프롬프트를 우선 사용
    weighted_blocks = []

    for pattern in (
        r'\[가중치]\s*([^\r\n]+)',
        r'\[조합형]\s*([^\r\n]+)'
    ):
        for match in re.finditer(pattern, target_text, flags=re.IGNORECASE):
            block = match.group(1).strip().strip(',')
            if block and 'artist:' in block.lower():
                weighted_blocks.append(block)

    if weighted_blocks:
        first = weighted_blocks[0]
        return [cleanup_gallery_weighted_art_style_prompt(first)]

    # 2) 0.7::artist:a::, 0.3::artist:b:: 같은 순서 보존 가중치 토큰 수집
    # 여러 가중치 토큰이 있으면 원본 순서를 보존해 하나의 프롬프트로 저장한다.
    weighted_tokens = []
    for match in re.finditer(
        r'[-+]?\d+(?:\.\d+)?::\s*artist:[^:,\]\}\|\n\r\t\\]+::',
        target_text,
        flags=re.IGNORECASE
    ):
        token = match.group(0).strip().strip(',')
        if token:
            weighted_tokens.append(token)

    if weighted_tokens:
        return [", ".join(weighted_tokens)]

    # 3) 일반 artist 태그는 알파벳순으로 정리해 조합형 프롬프트로 저장
    p_std = re.compile(r'(?:[\d\.]*::)?artist:\s*([^,\]\}\|\n\r\t\\]+)', re.IGNORECASE)
    artists = set()
    safe_text = target_text.replace('\\n', ' ').replace('\n', ' ')

    for match in p_std.finditer(safe_text):
        name = match.group(1).replace('_', ' ').strip().lower().replace('::', '')
        name = "_".join(name.split())
        if len(name) > 1 and name not in {
            '1',
            '3',
            'collaboration',
            'artist_collaboration',
            'multiple_artists',
            'none'
        }:
            artists.add(f"artist:{name}")

    if artists:
        return [", ".join(sorted(artists))]

    return []




def extract_gallery_weighted_art_style_prompts_from_prompt_info(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    for key in (
        "basePrompt",
        "baseCaption",
        "prompt",
        "base_prompt",
        "negativePrompt",
        "negative_prompt",
        "uc",
        "charPrompt",
        "characterPrompt"
    ):
        value = prompt_info.get(key)
        if value:
            parts.append(str(value))

    char_prompts = prompt_info.get("charPrompts") or prompt_info.get("char_prompts") or []
    if isinstance(char_prompts, list):
        parts.extend(str(item) for item in char_prompts if item)

    return extract_gallery_weighted_art_style_prompts_from_text("\n".join(parts))


def build_gallery_art_style_items_from_prompt_info(prompt_info):
    prompts = extract_gallery_weighted_art_style_prompts_from_prompt_info(prompt_info)

    if not prompts:
        return []

    # 그림체 프롬프트는 선택 영역당 1개만 저장한다.
    prompt = prompts[0]

    return [{
        "key": prompt,
        "prompt": prompt,
        "raw_artist": prompt,
        "name_kr": ""
    }]




def upsert_gallery_prompt_art_styles(db, rel_path, prompt_info):
    clean_path = clean_gallery_rel_path(rel_path)
    if not clean_path:
        return

    prompts = extract_gallery_weighted_art_style_prompts_from_prompt_info(prompt_info)
    if not prompts:
        return

    # 한 선택 영역에는 대표 그림체 프롬프트 하나만 DB에 기록한다.
    prompts = prompts[:1]
    records = [(clean_path, prompt) for prompt in prompts]
    db.conn.executemany(
        "INSERT OR IGNORE INTO image_artists (path, artist_name) VALUES (?, ?)",
        records
    )
    db.conn.executemany(
        "INSERT OR IGNORE INTO art_styles (artist_name, name_kr) VALUES (?, '')",
        [(prompt,) for prompt in prompts]
    )
    db.conn.commit()


def sync_gallery_prompt_art_styles_for_path(rel_path, prompt_info):
    db = utils.HistoryDB()
    try:
        upsert_gallery_prompt_art_styles(db, rel_path, prompt_info)
    finally:
        db.close()

def build_gallery_filter_lookup_path_variants(rel_path):
    clean = clean_gallery_rel_path(rel_path)
    if not clean:
        return []

    variants = [clean]

    for prefix in ("_R-18/", "_R-15/"):
        if clean.startswith(prefix):
            variants.append(clean[len(prefix):])
        else:
            variants.append(prefix + clean)

    return list(dict.fromkeys(path for path in variants if path))

# ==========================================================
# 갤러리 업스케일 백그라운드 작업 큐
# ==========================================================

UPSCALE_JOBS = {}
UPSCALE_QUEUE = queue.Queue()
UPSCALE_LOCK = threading.Lock()
UPSCALE_WORKER_THREAD = None


def now_iso():
    return datetime.datetime.now().isoformat(timespec="seconds")


def public_upscale_job(job):
    if not job:
        return None

    return {
        "id": job.get("id", ""),
        "status": job.get("status", "queued"),
        "progress": int(job.get("progress", 0) or 0),
        "message": job.get("message", ""),
        "source_path": job.get("source_path", ""),
        "source_name": job.get("source_name", ""),
        "target_width": job.get("target_width", 0),
        "target_height": job.get("target_height", 0),
        "engine": job.get("engine", "realcugan"),
        "quality": job.get("quality", "standard"),
        "result_path": job.get("result_path", ""),
        "result_src": job.get("result_src", ""),
        "error": job.get("error", ""),
        "created_at": job.get("created_at", ""),
        "updated_at": job.get("updated_at", ""),
    }


def update_upscale_job(job_id, **patch):
    with UPSCALE_LOCK:
        job = UPSCALE_JOBS.get(job_id)
        if not job:
            return

        job.update(patch)
        job["updated_at"] = now_iso()


def add_upscale_sidecar_info(image_path, prompt_info, upscale_info):
    save_prompt_sidecar(image_path, prompt_info)

    sidecar_path = get_prompt_sidecar_path(image_path)

    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception:
        data = normalize_prompt_info_for_sidecar(prompt_info)

    data["upscale"] = upscale_info

    with open(sidecar_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def ensure_upscale_output_dir(source_full_path):
    source_dir = os.path.dirname(source_full_path)
    upscale_dir = os.path.join(source_dir, UPSCALE_OUTPUT_FOLDER_NAME)

    os.makedirs(upscale_dir, exist_ok=True)

    ignore_path = os.path.join(upscale_dir, UPSCALE_IGNORE_FILE_NAME)
    if not os.path.exists(ignore_path):
        with open(ignore_path, "w", encoding="utf-8") as f:
            f.write(
                "This folder is ignored by NAI Image Manager classifier/reorganizer.\n"
                "Upscaled images are stored here intentionally.\n"
            )

    return upscale_dir

def build_upscale_output_path(source_full_path, target_width, target_height, engine):
    target_dir = ensure_upscale_output_dir(source_full_path)

    base_name = os.path.splitext(os.path.basename(source_full_path))[0]
    engine_name = safe_folder_name(engine or "upscale")
    filename = f"{base_name}_upscale_{target_width}x{target_height}_{engine_name}.png"

    return upscale_logic.make_unique_output_path(os.path.join(target_dir, filename))


def run_upscale_worker_loop():
    while True:
        job_id = UPSCALE_QUEUE.get()

        try:
            with UPSCALE_LOCK:
                job = UPSCALE_JOBS.get(job_id)

            if not job:
                continue

            cancel_event = job.get("_cancel_event")

            if cancel_event and cancel_event.is_set():
                update_upscale_job(
                    job_id,
                    status="cancelled",
                    progress=100,
                    message="취소됨"
                )
                continue

            update_upscale_job(
                job_id,
                status="running",
                progress=2,
                message="업스케일 준비 중..."
            )

            source_path = job.get("source_path", "")
            source_full_path, real_source_rel = resolve_gallery_image_path(source_path)

            target_width = int(job.get("target_width") or 2500)
            target_height = int(job.get("target_height") or 8000)
            engine = str(job.get("engine") or "realcugan").strip().lower()
            quality = str(job.get("quality") or "standard").strip().lower()

            target_full_path = build_upscale_output_path(
                source_full_path,
                target_width,
                target_height,
                engine
            )

            original_prompt_info = {}
            try:
                original_prompt_info = load_prompt_sidecar(source_full_path) or extract_prompt_info_from_image(source_full_path)
            except Exception:
                original_prompt_info = {}

            def progress_callback(progress, message):
                update_upscale_job(
                    job_id,
                    progress=max(0, min(99, int(progress))),
                    message=message
                )

            result = upscale_logic.run_upscale(
                source_path=source_full_path,
                target_path=target_full_path,
                target_width=target_width,
                target_height=target_height,
                engine=engine,
                quality=quality,
                progress_callback=progress_callback,
                cancel_event=cancel_event
            )

            if cancel_event and cancel_event.is_set():
                try:
                    if os.path.exists(target_full_path):
                        os.remove(target_full_path)
                except Exception:
                    pass

                update_upscale_job(
                    job_id,
                    status="cancelled",
                    progress=100,
                    message="취소됨"
                )
                continue

            result_rel_path = os.path.relpath(target_full_path, CLASSIFIED_DIR).replace("\\", "/")
            result_src = "/image/" + quote(result_rel_path)

            upscale_info = {
                "engine": engine,
                "quality": quality,
                "target_width": target_width,
                "target_height": target_height,
                "source_path": real_source_rel,
                "created_at": now_iso(),
                "result": result
            }

            embedded_metadata_saved = False

            try:
                with Image.open(target_full_path) as out_img:
                    out_img = out_img.convert("RGBA")
                    embedded_metadata_saved = save_png_with_prompt_metadata(
                        out_img,
                        target_full_path,
                        original_prompt_info,
                        source_label="NAI Image Manager Gallery Upscale"
                    )
            except Exception as meta_err:
                print(f"⚠️ 업스케일 결과 PNG 메타데이터 저장 실패: {target_full_path} | {meta_err}")

            add_upscale_sidecar_info(target_full_path, original_prompt_info, upscale_info)
            sync_gallery_prompt_art_styles_for_path(result_rel_path, original_prompt_info)

            update_upscale_job(
                job_id,
                status="done",
                progress=100,
                message="업스케일 완료",
                result_path=result_rel_path,
                result_src=result_src,
                embedded_metadata_saved=embedded_metadata_saved
            )

        except upscale_logic.UpscaleCancelled:
            update_upscale_job(
                job_id,
                status="cancelled",
                progress=100,
                message="취소됨"
            )

        except Exception as e:
            update_upscale_job(
                job_id,
                status="error",
                progress=100,
                message="업스케일 실패",
                error=str(e)
            )

        finally:
            UPSCALE_QUEUE.task_done()


def ensure_upscale_worker_started():
    global UPSCALE_WORKER_THREAD

    if UPSCALE_WORKER_THREAD and UPSCALE_WORKER_THREAD.is_alive():
        return

    UPSCALE_WORKER_THREAD = threading.Thread(
        target=run_upscale_worker_loop,
        daemon=True
    )
    UPSCALE_WORKER_THREAD.start()


@app.route('/api/gallery/upscale/start', methods=['POST'])
def start_gallery_upscale():
    try:
        data = request.json or {}

        source_path = clean_gallery_rel_path(data.get("source_path", ""))
        if not source_path:
            return jsonify({"status": "error", "message": "업스케일할 이미지 경로가 없습니다."}), 400

        # 존재 확인과 실제 경로 보정
        source_full_path, real_source_rel = resolve_gallery_image_path(source_path)

        target_width, target_height = upscale_logic.validate_target_size(
            data.get("target_width", 2500),
            data.get("target_height", 8000)
        )

        engine = str(data.get("engine") or "realcugan").strip().lower()
        if engine not in ("realcugan", "lanczos"):
            engine = "realcugan"

        quality = str(data.get("quality") or "standard").strip().lower()
        if quality not in ("fast", "standard", "high"):
            quality = "standard"

        job_id = f"upscale_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
        cancel_event = threading.Event()

        job = {
            "id": job_id,
            "status": "queued",
            "progress": 0,
            "message": "대기 중...",
            "source_path": real_source_rel,
            "source_name": os.path.basename(source_full_path),
            "target_width": target_width,
            "target_height": target_height,
            "engine": engine,
            "quality": quality,
            "result_path": "",
            "result_src": "",
            "error": "",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "_cancel_event": cancel_event
        }

        with UPSCALE_LOCK:
            UPSCALE_JOBS[job_id] = job

        ensure_upscale_worker_started()
        UPSCALE_QUEUE.put(job_id)

        return jsonify({
            "status": "started",
            "job": public_upscale_job(job),
            "job_id": job_id
        })

    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404

    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/gallery/upscale/status/<job_id>')
def get_gallery_upscale_status(job_id):
    with UPSCALE_LOCK:
        job = UPSCALE_JOBS.get(job_id)

    if not job:
        return jsonify({"status": "error", "message": "작업을 찾을 수 없습니다."}), 404

    return jsonify({
        "status": "success",
        "job": public_upscale_job(job)
    })


@app.route('/api/gallery/upscale/jobs')
def list_gallery_upscale_jobs():
    with UPSCALE_LOCK:
        jobs = [public_upscale_job(job) for job in UPSCALE_JOBS.values()]

    jobs.sort(key=lambda item: item.get("created_at", ""), reverse=True)

    return jsonify({
        "status": "success",
        "jobs": jobs
    })


@app.route('/api/gallery/upscale/cancel/<job_id>', methods=['POST'])
def cancel_gallery_upscale(job_id):
    with UPSCALE_LOCK:
        job = UPSCALE_JOBS.get(job_id)

        if not job:
            return jsonify({"status": "error", "message": "작업을 찾을 수 없습니다."}), 404

        if job.get("status") in ("done", "error", "cancelled"):
            return jsonify({
                "status": "success",
                "job": public_upscale_job(job)
            })

        cancel_event = job.get("_cancel_event")
        if cancel_event:
            cancel_event.set()

        job["status"] = "cancelled" if job.get("status") == "queued" else job.get("status", "running")
        job["message"] = "취소 요청됨"
        job["updated_at"] = now_iso()

    return jsonify({
        "status": "success",
        "job": public_upscale_job(job)
    })

@app.route('/api/gallery/image_filter_meta', methods=['POST'])
def gallery_image_filter_meta():
    data = request.json or {}
    paths = data.get("paths") or []
    include_prompt = bool(data.get("include_prompt"))

    if not isinstance(paths, list):
        return jsonify({"status": "error", "message": "paths는 배열이어야 합니다."}), 400

    clean_paths = []
    for path in paths:
        clean = clean_gallery_rel_path(path)
        if clean:
            clean_paths.append(clean)

    clean_paths = list(dict.fromkeys(clean_paths))

    db = utils.HistoryDB()

    try:
        items = {}
        lookup_paths = []

        for rel_path in clean_paths:
            lookup_paths.extend(build_gallery_filter_lookup_path_variants(rel_path))

            items[rel_path] = {
                "prompt_text": "",
                "prompt_text_loaded": False,
                "real_rel": rel_path,
                "fallback_art_styles": [],
                "upscale": build_fast_upscale_badge_info_from_rel_path(rel_path)
            }

        lookup_paths = list(dict.fromkeys(path for path in lookup_paths if path))
        art_style_map = fetch_gallery_weighted_art_styles_for_paths(db, lookup_paths)

        for rel_path in clean_paths:
            candidates = build_gallery_filter_lookup_path_variants(rel_path)
            db_art_styles = []

            for candidate in candidates:
                db_art_styles = art_style_map.get(candidate) or []
                if db_art_styles:
                    break

            if db_art_styles:
                items[rel_path]["fallback_art_styles"] = db_art_styles[:1]

        # 빠른 모드:
        # 그림체 필터용 DB 정보만 반환하고, PNG/sidecar 파일은 열지 않는다.
        if not include_prompt:
            result_items = {}

            for rel_path, item in items.items():
                result_items[rel_path] = {
                    "prompt_text": "",
                    "prompt_text_loaded": False,
                    "real_rel": item.get("real_rel") or rel_path,
                    "art_styles": item.get("fallback_art_styles", []),
                    "upscale": item.get("upscale") or {"is_upscaled": False}
                }

            return jsonify({
                "status": "success",
                "items": result_items,
                "fast": True
            })

        # 프롬프트 필터 모드:
        # 사용자가 실제로 프롬프트 검색을 할 때만 파일을 열어 prompt_text를 채운다.
        resolved_paths = {}

        for rel_path in clean_paths:
            prompt_text = ""
            prompt_info = {}
            real_rel = rel_path
            upscale_badge = items.get(rel_path, {}).get("upscale") or {"is_upscaled": False}

            try:
                full_path, real_rel = resolve_gallery_image_path(rel_path)
                real_rel = clean_gallery_rel_path(real_rel) or real_rel
                resolved_paths[rel_path] = real_rel

                prompt_info = load_prompt_sidecar(full_path) or extract_prompt_info_from_image(full_path) or {}
                prompt_text = build_gallery_prompt_filter_text(prompt_info)
                upscale_badge = load_upscale_badge_info(full_path)

                # DB에 없는 신규 이미지도 프롬프트에서 그림체를 즉시 fallback 추출
                fallback_styles = build_gallery_art_style_items_from_prompt_info(prompt_info)
                if fallback_styles and not items[rel_path].get("fallback_art_styles"):
                    items[rel_path]["fallback_art_styles"] = fallback_styles

            except Exception as prompt_err:
                print(f"⚠️ 갤러리 프롬프트 필터 메타 로드 실패: {rel_path} | {prompt_err}")

            items[rel_path]["prompt_text"] = prompt_text
            items[rel_path]["prompt_text_loaded"] = True
            items[rel_path]["real_rel"] = real_rel
            items[rel_path]["upscale"] = upscale_badge

        result_items = {}

        for rel_path, item in items.items():
            real_rel = resolved_paths.get(rel_path, item.get("real_rel") or rel_path)

            art_styles = item.get("fallback_art_styles", [])
            if art_styles:
                art_styles = art_styles[:1]

            result_items[rel_path] = {
                "prompt_text": item.get("prompt_text", ""),
                "prompt_text_loaded": bool(item.get("prompt_text_loaded")),
                "real_rel": real_rel,
                "art_styles": art_styles,
                "upscale": item.get("upscale") or {"is_upscaled": False}
            }

        return jsonify({
            "status": "success",
            "items": result_items,
            "fast": False
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

    finally:
        db.close()

def reveal_path_in_explorer(full_path, mode="select"):
    import sys

    full_path = os.path.abspath(full_path)
    folder_path = os.path.dirname(full_path)

    if os.name == "nt":
        now = time.time()
        norm = os.path.normcase(os.path.normpath(full_path))

        if (
            _last_reveal_request["path"] == norm and
            now - _last_reveal_request["time"] < 1.2
        ):
            return "폴더를 열었습니다."

        _last_reveal_request["path"] = norm
        _last_reveal_request["time"] = now

        if mode == "folder":
            subprocess.Popen(["explorer.exe", os.path.normpath(folder_path)])
        else:
            # 파일 선택 상태로 열기
            select_cmd = f'explorer.exe /select,"{os.path.normpath(full_path)}"'
            subprocess.Popen(select_cmd)

        return "상위 폴더를 열었습니다."

    if sys.platform == "darwin":
        if mode == "folder":
            subprocess.Popen(["open", folder_path])
        else:
            subprocess.Popen(["open", "-R", full_path])
        return "Finder에서 파일을 표시했습니다."

    subprocess.Popen(["xdg-open", folder_path])
    return "파일이 있는 폴더를 열었습니다."

@app.route('/api/reveal_in_explorer', methods=['POST'])
def reveal_in_explorer():
    try:
        data = request.json or {}

        raw_path = data.get('path', '')
        mode = str(data.get('mode', 'select') or 'select').strip()

        full_path, rel_path = resolve_gallery_image_path(raw_path)

        message = reveal_path_in_explorer(full_path, mode=mode)

        return jsonify({
            "status": "success",
            "message": message,
            "path": rel_path
        })

    except FileNotFoundError as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        })

    except ValueError as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        })

    except Exception as e:
        return jsonify({
            "status": "error",
            "message": str(e)
        })

@app.route('/api/prompt_info', methods=['POST'])
def get_prompt_info():
    try:
        data = request.json or {}
        raw_path = data.get('path', '')
        rel_path = clean_gallery_rel_path(raw_path)

        full_path, real_rel = resolve_gallery_image_path(rel_path)

        if not os.path.exists(full_path):
            return jsonify({"status": "error", "message": "이미지 파일을 찾을 수 없습니다."})

        prompt_info = load_prompt_sidecar(full_path)

        if not prompt_info:
            prompt_info = extract_prompt_info_from_image(full_path)

        prompt_info = prompt_info or {}
        prompt_info["fileName"] = os.path.basename(full_path)
        prompt_info["path"] = real_rel

        return jsonify({"status": "success", "data": prompt_info})
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)})
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

@app.route('/api/toggle_nsfw', methods=['POST'])
def toggle_nsfw():
    try:
        data = request.json
        rel_path = str(data.get('path', '')).replace('\\', '/')
        full_path = utils.resolve_safe_path(CLASSIFIED_DIR, rel_path)

        if not os.path.exists(full_path):
            return jsonify({"status": "error", "message": "파일을 찾을 수 없습니다."})

        # 1. 원본 이미지 이동
        new_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, target_rel_path)
        os.makedirs(os.path.dirname(new_full_path), exist_ok=True)
        os.replace(full_path, new_full_path)

        # 2. 이동한 이미지 옆의 사유 텍스트 파일도 함께 이동
        try:
            old_txt = os.path.splitext(full_path)[0] + ".txt"
            new_txt = os.path.splitext(new_full_path)[0] + ".txt"

            # 수동 NSFW 전환 사유를 텍스트 파일에 기록
            label = "일반 폴더로 이동" if is_currently_nsfw else "R-19로 이동"
            with open(new_txt, "w", encoding="utf-8") as f:
                f.write(f"✅ [수동] 사용자 분류 ({label})")

            # 과거 경로의 텍스트 파일이 남아있다면 깔끔하게 삭제
            if os.path.exists(old_txt):
                os.remove(old_txt)
        except Exception as txt_e:
            print(f"사유 텍스트 파일 생성/이동 실패: {txt_e}")  # 실패해도 메인 이동은 계속 진행
            # 과거 경로에 텍스트 파일이 남아있다면 깔끔하게 삭제
            if os.path.exists(old_txt):
                os.remove(old_txt)
        except Exception as txt_e:
            print(f"사유 텍스트 파일 생성/이동 실패: {txt_e}")  # 실패해도 메인 이동은 계속 진행

        # DB 기록 갱신
        try:
            db = utils.HistoryDB()  # 기존 DB 경로 기록을 새 위치로 갱신

            if file_hash:  # 해시가 있으면 파일 경로를 새 위치로 갱신
                    db.conn.execute("INSERT OR REPLACE INTO manual_overrides (file_hash, is_nsfw) VALUES (?, ?)",
                                    (file_hash, 0 if is_currently_nsfw else 2))
        except Exception as db_e:
            print(f"DB 저장 에러: {db_e}")
        finally:
            try:
                db.close()
            except Exception:
                pass

        move_gallery_image_tag_path(rel_path, target_rel_path)

        return jsonify({"status": "success", "new_path": target_rel_path, "is_nsfw": not is_currently_nsfw})
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})


@app.route('/api/apply', methods=['POST'])
def apply_changes():
    data = request.json
    try:
        image_logic.handle_integrated_tasks(CLASSIFIED_DIR, data)
        return jsonify({"status": "success", "message": "적용 완료"})
    except Exception as e:
        err_msg = str(e)
        # 에러 종류를 파악해서 한국어 메시지로 변환
        if "Errno 22" in err_msg or "WinError 32" in err_msg or "Errno 13" in err_msg:
            ko_msg = "파일이 AI 분석 등으로 잠겨 있습니다. 잠시 후 다시 시도해 주세요."
        elif "Errno 2" in err_msg:
            ko_msg = "파일을 찾을 수 없습니다. (이미 이동되었거나 새로고침이 필요합니다)"
        else:
            ko_msg = f"서버 오류: {err_msg}"

        return jsonify({"status": "error", "message": ko_msg})

@app.route('/api/restore', methods=['POST'])
def restore_file():
    data = request.json
    rel_path = data.get('path', '').replace('\\', '/')
    try:
        trash_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, rel_path)
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)})

    if not utils.is_subpath(trash_full_path, TRASH_DIR):
        return jsonify({"status": "error", "message": "휴지통 경로만 복구할 수 있습니다."})

    db = utils.HistoryDB()
    try:
        original_path = db.get_original_path(trash_full_path)

        # DB에 기록이 없으면 이름의 타임스탬프를 떼고 루트 복구 폴더로 보냄
        if not original_path:
            fallback_name = os.path.basename(trash_full_path).split('_', 1)[-1]
            original_path = os.path.join(CLASSIFIED_DIR, "_RECOVERED", fallback_name)

        original_path = os.path.normpath(original_path)
        if not utils.is_subpath(original_path, CLASSIFIED_DIR):
            return jsonify({"status": "error", "message": "복구 대상 경로가 올바르지 않습니다."})

        os.makedirs(os.path.dirname(original_path), exist_ok=True)

        # 이미지 이동
        if os.path.exists(trash_full_path):
            os.replace(trash_full_path, original_path)

        # 텍스트 파일(사유) 이동
        trash_txt = os.path.splitext(trash_full_path)[0] + ".txt"
        orig_txt = os.path.splitext(original_path)[0] + ".txt"
        if os.path.exists(trash_txt):
            os.replace(trash_txt, orig_txt)

        db.remove_trash_path(trash_full_path)
        return jsonify({"status": "success", "message": "원래 폴더로 복구되었습니다."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        db.close()


@app.route('/api/empty_trash_folder', methods=['POST'])
def empty_trash_folder():
    data = request.json
    folder_name = data.get('folder', '')
    try:
        target_dir = utils.resolve_safe_path(TRASH_DIR, folder_name)
    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)})

    if not os.path.isdir(target_dir):
        return jsonify({"status": "error", "message": "잘못된 경로이거나 이미 삭제되었습니다."})

    db = utils.HistoryDB()
    try:
        shutil.rmtree(target_dir) # 폴더 내의 모든 파일 통째로 삭제
        db.remove_trash_folder(target_dir) # 관련된 휴지통 맵핑 기록 일괄 삭제
        
        # 🌟 [추가] 휴지통 폴더 내에 남아있던 그림체 스캔 등 모든 하위 찌꺼기 기록 완벽 정리
        folder_rel_path = f"_TRASH/{folder_name}"
        db.remove_folder_records(folder_rel_path)
        
        return jsonify({"status": "success", "message": f"[{folder_name}] 폴더가 완전히 비워졌습니다."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        db.close()


@app.route('/api/stats')
def get_stats():
    threshold = int(request.args.get('threshold', 10))
    include_daki = request.args.get('include_daki', 'true').lower() == 'true'

    stats = {}
    total_files = 0
    nsfw_files = 0

    if not os.path.exists(CLASSIFIED_DIR):
        return jsonify({"summary": {}, "list": []})

    # 🌟 [수술 2-1] 일반 통계에서도 긴 폴더명을 복원하기 위해 DB 연결
    db = utils.HistoryDB()
    folder_names_map = load_folder_display_names(db)
    db.close()

    for root, dirs, files in os.walk(CLASSIFIED_DIR):
        if "_TRASH" in root: continue

        is_daki = "Dakimakura" in root
        if is_daki and not include_daki:
            continue

        img_files = [f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
        if not img_files: continue

        is_nsfw = "_R-18" in root or "_R-15" in root
        folder_name = os.path.basename(root)

        # 원본 폴더명 복원
        display_name = folder_names_map.get(folder_name, folder_name)

        clean_name = re.sub(r'_\d+pcs$', '', display_name, flags=re.IGNORECASE).replace('_Dakimakura', '').replace('_dakimakura', '')
        char_list = [n.replace('_', ' ').strip() for n in re.split(r'_and_|\s+and\s+', clean_name, flags=re.IGNORECASE) if n.strip()]

        for char in char_list:
            char_key = f"{char} (다키)" if is_daki else char

            if char_key not in stats:
                stats[char_key] = {"name": char_key, "total": 0, "safe": 0, "nsfw": 0}

            count = len(img_files)
            stats[char_key]["total"] += count
            if is_nsfw:
                stats[char_key]["nsfw"] += count
                nsfw_files += count
            else:
                stats[char_key]["safe"] += count
            total_files += count

    sorted_stats = sorted(stats.values(), key=lambda x: x['total'], reverse=True)
    filtered_list = [s for s in sorted_stats if s['total'] >= threshold]

    return jsonify({
        "summary": {
            "total_count": total_files,
            "nsfw_ratio": round((nsfw_files / total_files * 100), 1) if total_files > 0 else 0,
            "char_count": len(stats)
        },
        "list": filtered_list
    })


@app.route('/api/brand_stats')
def get_brand_stats():
    db = utils.HistoryDB()
    cursor = db.conn.cursor()

    # 🌟 [수술 1-1] 긴 폴더명을 원래 이름으로 복원하기 위한 매핑 데이터 준비
    folder_names_map = load_folder_display_names(db)

    cursor.execute(
        "SELECT tag, clean_name, brand, brand_kr, COALESCE(is_visible, 1) "
        "FROM known_characters "
        "WHERE brand IS NOT NULL AND brand != 'Unknown'"
    )

    brand_meta = {}
    char_to_brand = {}

    for row in cursor.fetchall():
        tag, clean_name, brand, brand_kr, is_visible = row[0], row[1], row[2], row[3], row[4]
        display_brand = brand_kr if brand_kr else brand.replace('_', ' ').replace('The ', '').title()

        if brand not in brand_meta:
            brand_meta[brand] = {
                "display": display_brand,
                "kr": brand_kr or "",
                "is_visible": is_visible
            }

        for alias in build_character_brand_lookup_aliases(tag, clean_name):
            char_to_brand[alias] = brand

    stats = {}
    for root, dirs, files in os.walk(CLASSIFIED_DIR):
        if "_TRASH" in root: continue
        img_files = [f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
        if not img_files: continue

        is_nsfw = "_R-18" in root or "_R-15" in root
        folder_name = os.path.basename(root)

        # 잘린 폴더명(_and_Others)을 원래 캐릭터명으로 복원
        display_name = folder_names_map.get(folder_name, folder_name)

        clean_name = re.sub(r'_\d+pcs$', '', display_name, flags=re.IGNORECASE)
        clean_name = re.sub(r'_dakimakura$', '', clean_name, flags=re.IGNORECASE)

        char_list = [
            normalize_brand_lookup_key(n)
            for n in re.split(r'_and_|\s+and\s+', clean_name, flags=re.IGNORECASE)
            if normalize_brand_lookup_key(n)
        ]

        for char in char_list:
            brand_raw = char_to_brand.get(char, "Unknown")

            if brand_raw not in stats:
                display_name = brand_meta[brand_raw]["display"] if brand_raw in brand_meta else "Unknown"
                kr_name = brand_meta[brand_raw]["kr"] if brand_raw in brand_meta else ""
                is_vis = brand_meta[brand_raw]["is_visible"] if brand_raw in brand_meta else 1

                stats[brand_raw] = {
                    "name": display_name, "raw_name": brand_raw, "name_kr": kr_name, "is_visible": is_vis,
                    "total": 0, "safe": 0, "nsfw": 0
                }

            count = len(img_files)
            stats[brand_raw]["total"] += count
            if is_nsfw:
                stats[brand_raw]["nsfw"] += count
            else:
                stats[brand_raw]["safe"] += count

    db.close()
    stats_list = list(stats.values())
    stats_list.sort(key=lambda x: (x["name"] == "Unknown", -x["total"]))
    return jsonify(stats_list)

# 🌟 [추가] 스위치 껐다 켤 때 작동하는 API
@app.route('/api/update_brand_visibility', methods=['POST'])
def update_brand_visibility():
    data = request.json
    brand_raw = data.get('raw_name')
    is_visible = data.get('is_visible')
    db = utils.HistoryDB()
    try:
        with db.conn:
            db.conn.execute("UPDATE known_characters SET is_visible = ? WHERE brand = ?", (is_visible, brand_raw))
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})


@app.route('/api/update_brand_kr', methods=['POST'])
def update_brand_kr():
    data = request.json
    brand_raw = data.get('raw_name')  # 영어 원본 브랜드 키
    brand_kr = data.get('brand_kr')
    db = utils.HistoryDB()
    try:
        with db.conn:
            db.conn.execute("UPDATE known_characters SET brand_kr = ? WHERE brand = ?", (brand_kr, brand_raw))
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

# app.py에 추가 (기존 개별 업데이트 API를 대체하거나 밑에 추가)
@app.route('/api/bulk_update_brands', methods=['POST'])
def bulk_update_brands():
    data = request.json  # [{raw_name, brand_kr, is_visible}, ...] ?類ㅻ뻼
    db = utils.HistoryDB()
    try:
        with db.conn:
            for item in data:
                db.conn.execute("""
                    UPDATE known_characters 
                    SET brand_kr = ?, is_visible = ? 
                    WHERE brand = ?
                """, (item['brand_kr'], item['is_visible'], item['raw_name']))
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})

def clean_route_prompt_text(value):
    text = str(value or "").strip()
    return re.sub(r"\s+", " ", text)


def route_prompt_dedupe_key(value):
    text = clean_route_prompt_text(value).lower().replace("_", " ")
    text = re.sub(r"\s+", " ", text).strip()
    compact = re.sub(r"[\s_]+", "", text)
    return compact or text


def dedupe_route_prompts(items):
    deduped = []
    seen = set()

    for item in items or []:
        text = clean_route_prompt_text(item)
        if not text:
            continue

        key = route_prompt_dedupe_key(text)
        if not key or key in seen:
            continue

        seen.add(key)
        deduped.append(text)

    return deduped


def parse_route_tags_single(raw):
    if isinstance(raw, str):
        items = re.split(r"[,\n]+", raw)
    elif isinstance(raw, list):
        items = raw
    else:
        items = []

    return dedupe_route_prompts(items)


def parse_route_tag_groups(raw):
    groups = []

    if isinstance(raw, str):
        for line in raw.splitlines():
            groups.append(re.split(r",+", line))
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, list):
                groups.append(item)
            elif isinstance(item, str):
                groups.append(re.split(r",+", item))
            else:
                groups.append([item])

    normalized = []
    seen_groups = set()

    for group in groups:
        tags = dedupe_route_prompts(group)
        if not tags:
            continue

        group_key = tuple(route_prompt_dedupe_key(tag) for tag in tags)
        if group_key in seen_groups:
            continue

        seen_groups.add(group_key)
        normalized.append(tags)

    return normalized


def route_prompt_text_from_rule(rule, tags=None, tag_groups=None, prompt_mode="single"):
    raw = rule.get("prompt_text")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()

    if prompt_mode == "group" and tag_groups:
        return "\n".join(", ".join(group) for group in tag_groups if group)

    if tags:
        return "\n".join(tags)

    return ""


def normalize_custom_route_rules(rules, depth=0):
    if not isinstance(rules, list) or depth > 5:
        return []

    normalized = []

    for rule in rules:
        if not isinstance(rule, dict):
            continue

        rule_type = str(rule.get("type") or "custom").strip()

        if rule_type == "default":
            normalized.append({
                "type": "default",
                "folder": "Solo / Duo / Group"
            })
            continue

        folder = str(rule.get("folder") or "").strip()
        tags = parse_route_tags_single(rule.get("tags") or [])
        prompt_mode = "group" if rule.get("prompt_mode") == "group" else "single"
        tag_groups = parse_route_tag_groups(rule.get("tag_groups") or [])
        prompt_text = route_prompt_text_from_rule(rule, tags, tag_groups, prompt_mode)

        if prompt_text:
            tags_from_text = parse_route_tags_single(prompt_text)
            groups_from_text = parse_route_tag_groups(prompt_text)

            if tags_from_text:
                tags = tags_from_text
            if groups_from_text:
                tag_groups = groups_from_text

        if prompt_mode == "group" and not tag_groups and tags:
            tag_groups = [[tag] for tag in tags]

        if not folder or (not prompt_text and not tags and not tag_groups):
            continue

        condition = str(rule.get("condition") or "any").strip().lower()
        if condition not in ("any", "all"):
            condition = "any"

        try:
            match_count = int(rule.get("match_count") or 1)
        except Exception:
            match_count = 1

        match_count = max(1, match_count)

        children = (
            rule.get("children")
            or rule.get("sub_rules")
            or rule.get("rules")
            or []
        )

        normalized.append({
            "type": "custom",
            "folder": folder,
            "prompt_text": prompt_text,
            "tags": tags,
            "prompt_mode": prompt_mode,
            "tag_groups": tag_groups,
            "condition": condition,
            "match_count": match_count,
            "children": normalize_custom_route_rules(children, depth + 1)
        })

    return normalized


def route_test_clean_prompt_text(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return re.sub(r"[ \t\f\v]+", " ", text)


def route_test_match_keys(value):
    text = route_test_clean_prompt_text(value).lower()
    if not text:
        return set()

    space_text = re.sub(r"\s+", " ", text.replace("_", " ")).strip()
    underscore_text = re.sub(r"\s+", "_", space_text)
    compact_text = re.sub(r"[\s_]+", "", space_text)
    return {key for key in (text, space_text, underscore_text, compact_text) if key}


def route_test_prompt_tokens_from_text(text):
    tokens = []
    seen = set()

    for item in re.split(r"[,\n]+", str(text or "")):
        token = route_test_clean_prompt_text(item)
        if not token:
            continue
        key = next(iter(sorted(route_test_match_keys(token))), "")
        if not key or key in seen:
            continue
        seen.add(key)
        tokens.append(token)

    return tokens


def route_test_prompt_tokens_from_prompt_info(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    for key in (
        "basePrompt", "baseCaption", "prompt", "base_prompt",
        "negativePrompt", "negative_prompt", "uc",
        "charPrompt", "characterPrompt"
    ):
        value = prompt_info.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value)

    for key in ("charPrompts", "char_prompts"):
        value = prompt_info.get(key)
        if isinstance(value, list):
            parts.extend(str(item) for item in value if str(item or "").strip())
        elif isinstance(value, str) and value.strip():
            parts.append(value)

    return route_test_prompt_tokens_from_text("\n".join(parts))


def route_test_build_key_set(tokens):
    key_set = set()
    for token in tokens or []:
        key_set.update(route_test_match_keys(token))
    return key_set


def route_test_rule_prompt_matches(prompt, key_set):
    return any(key in key_set for key in route_test_match_keys(prompt))


def route_test_unique_prompts(items):
    prompts = []
    seen = set()
    for item in items or []:
        prompt = route_test_clean_prompt_text(item)
        if not prompt:
            continue
        key = next(iter(sorted(route_test_match_keys(prompt))), "")
        if not key or key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)
    return prompts


def route_test_rule_matches(rule, key_set):
    if not isinstance(rule, dict) or rule.get("type") == "default":
        return {"matched": False, "mode": "default", "matched_tags": [], "missing_tags": [], "message": "기본 분류 규칙은 직접 매칭하지 않습니다."}

    prompt_mode = "group" if rule.get("prompt_mode") == "group" else "single"

    if prompt_mode == "group":
        tag_groups = parse_route_tag_groups(rule.get("tag_groups") or [])
        tags = route_test_unique_prompts(rule.get("tags") or [])
        if not tag_groups and tags:
            tag_groups = [[tag] for tag in tags]

        group_details = []
        for index, group in enumerate(tag_groups):
            needed = route_test_unique_prompts(group)
            found = [tag for tag in needed if route_test_rule_prompt_matches(tag, key_set)]
            missing = [tag for tag in needed if tag not in found]
            passed = bool(needed) and not missing
            group_details.append({
                "group_index": index + 1,
                "needed_tags": needed,
                "matched_tags": found,
                "missing_tags": missing,
                "matched": passed
            })
            if passed:
                return {
                    "matched": True,
                    "mode": "group",
                    "matched_tags": found,
                    "missing_tags": [],
                    "passed_group_index": index + 1,
                    "groups": group_details,
                    "message": f"묶음 조건 {index + 1}번이 통과했습니다."
                }

        missing_all = []
        for detail in group_details:
            missing_all.extend(detail.get("missing_tags", []))
        return {
            "matched": False,
            "mode": "group",
            "matched_tags": [],
            "missing_tags": route_test_unique_prompts(missing_all),
            "passed_group_index": None,
            "groups": group_details,
            "message": "통과한 묶음 조건이 없습니다."
        }

    tags = route_test_unique_prompts(rule.get("tags") or [])
    condition = "all" if rule.get("condition") == "all" else "any"
    try:
        match_count = int(rule.get("match_count") or 1)
    except Exception:
        match_count = 1
    match_count = max(1, match_count)

    matched_tags = [tag for tag in tags if route_test_rule_prompt_matches(tag, key_set)]
    missing_tags = [tag for tag in tags if tag not in matched_tags]
    required_count = len(tags) if condition == "all" else min(match_count, len(tags))
    matched = bool(tags) and (not missing_tags if condition == "all" else len(matched_tags) >= match_count)

    return {
        "matched": matched,
        "mode": "single",
        "condition": condition,
        "match_count": match_count,
        "required_count": required_count,
        "matched_tags": matched_tags,
        "missing_tags": missing_tags,
        "message": "개별 조건이 통과했습니다." if matched else f"필요한 {required_count}개 중 {len(matched_tags)}개만 찾았습니다."
    }


def route_test_get_rule_by_path(rules, path):
    current = rules
    rule = None
    try:
        for raw_index in path or []:
            index = int(raw_index)
            if not isinstance(current, list) or index < 0 or index >= len(current):
                return None
            rule = current[index]
            current = rule.get("children") or []
        return rule if isinstance(rule, dict) else None
    except Exception:
        return None


def route_test_get_rule_paths(data):
    raw_paths = data.get("rule_paths")
    if isinstance(raw_paths, str):
        try:
            raw_paths = json.loads(raw_paths)
        except Exception:
            raw_paths = []

    if isinstance(raw_paths, list) and raw_paths and all(isinstance(p, list) for p in raw_paths):
        return raw_paths

    one = data.get("rule_path")
    if isinstance(one, str):
        try:
            one = json.loads(one)
        except Exception:
            one = []

    return [one] if isinstance(one, list) and one else []


def route_test_path_key(path):
    return json.dumps(path or [], ensure_ascii=False)


def route_test_is_ancestor_path(parent, child):
    return (
        isinstance(parent, list) and
        isinstance(child, list) and
        len(parent) < len(child) and
        child[:len(parent)] == parent
    )


def route_test_selected_path_jobs(rule_paths):
    paths = [path for path in rule_paths if isinstance(path, list)]
    unique = []
    seen = set()

    for path in paths:
        key = route_test_path_key(path)
        if key in seen:
            continue
        unique.append(path)
        seen.add(key)

    jobs = []

    for path in unique:
        selected_ancestors = [
            other for other in unique
            if route_test_is_ancestor_path(other, path)
        ]
        selected_descendants = [
            other for other in unique
            if route_test_is_ancestor_path(path, other)
        ]

        if selected_ancestors:
            ancestor = max(selected_ancestors, key=len)
            jobs.append({"type": "chain", "paths": [ancestor, path]})
            continue

        if selected_descendants:
            continue

        jobs.append({"type": "single", "paths": [path]})

    return jobs


def route_test_rule_label_by_path(rules, path):
    labels = []
    current = rules
    try:
        for raw_index in path or []:
            index = int(raw_index)
            if not isinstance(current, list) or index < 0 or index >= len(current):
                return "알 수 없는 규칙"
            rule = current[index]
            labels.append(str(rule.get("folder") or "(폴더명 없음)").strip() or "(폴더명 없음)")
            current = rule.get("children") or []
    except Exception:
        return "알 수 없는 규칙"

    return " > ".join(labels) if labels else "알 수 없는 규칙"


def route_test_match_rule_chain(rules, key_set, paths):
    details = []
    labels = []
    all_matched = True

    for path in paths:
        rule = route_test_get_rule_by_path(rules, path)
        if not rule:
            all_matched = False
            details.append({
                "matched": False,
                "rule_path": path,
                "message": "선택한 규칙을 찾을 수 없습니다."
            })
            continue

        result = route_test_match_single_rule(rule, key_set)
        result["rule_path"] = path
        result["rule_label"] = route_test_rule_label_by_path(rules, path)
        labels.append(result["rule_label"])
        details.append(result)

        if not result.get("matched"):
            all_matched = False

    return {
        "matched": all_matched,
        "type": "chain",
        "rule_label": " > ".join([label.split(" > ")[-1] for label in labels if label]),
        "details": details,
        "message": "선택한 상위/하위 규칙 조합을 순서대로 검사했습니다."
    }


def route_test_match_selected_rules(rules, key_set, rule_paths):
    jobs = route_test_selected_path_jobs(rule_paths)
    selected_results = []

    for job in jobs:
        paths = job.get("paths") or []

        if job.get("type") == "chain":
            selected_results.append(route_test_match_rule_chain(rules, key_set, paths))
            continue

        path = paths[0] if paths else []
        rule = route_test_get_rule_by_path(rules, path)

        if not rule:
            selected_results.append({
                "matched": False,
                "type": "single",
                "rule_path": path,
                "rule_label": "알 수 없는 규칙",
                "message": "선택한 규칙을 찾을 수 없습니다."
            })
            continue

        result = route_test_match_single_rule(rule, key_set)
        result["type"] = "single"
        result["rule_path"] = path
        result["rule_label"] = route_test_rule_label_by_path(rules, path)
        selected_results.append(result)

    return {
        "matched": any(item.get("matched") for item in selected_results),
        "scope": "single",
        "selected_rule_count": len([path for path in rule_paths if isinstance(path, list)]),
        "job_count": len(selected_results),
        "selected_results": selected_results,
        "message": "선택한 규칙을 검사했습니다."
    }


def route_test_flatten_rules(rules, parent_label="", parent_path=None):
    parent_path = parent_path or []
    flat = []

    for index, rule in enumerate(rules or []):
        if not isinstance(rule, dict) or rule.get("type") == "default":
            continue
        folder = str(rule.get("folder") or "").strip() or "(폴더명 없음)"
        label = f"{parent_label} > {folder}" if parent_label else folder
        path = parent_path + [index]
        flat.append({"path": path, "label": label, "folder": folder, "rule": rule})
        flat.extend(route_test_flatten_rules(rule.get("children") or [], label, path))

    return flat


def route_test_find_matching_route(rules, key_set):
    details = []

    def walk(rule_list, chain=None):
        chain = chain or []
        for rule in rule_list or []:
            if not isinstance(rule, dict):
                continue
            if rule.get("type") == "default":
                return {"matched": False, "default_reached": True, "final_folder": "Solo / Duo / Group", "rule_chain": chain, "details": details}

            folder = str(rule.get("folder") or "").strip()
            match_detail = route_test_rule_matches(rule, key_set)
            details.append({"folder": folder, "label": " > ".join(chain + [folder]) if folder else "", **match_detail})
            if not match_detail.get("matched"):
                continue

            next_chain = chain + ([folder] if folder else [])
            child_result = walk(rule.get("children") or [], next_chain)
            if child_result and child_result.get("matched"):
                return child_result
            return {"matched": True, "default_reached": False, "final_folder": "/".join(next_chain), "rule_chain": next_chain, "details": details}

        return {"matched": False, "default_reached": False, "final_folder": "", "rule_chain": chain, "details": details}

    return walk(rules)


def route_test_match_single_rule(rule, key_set):
    if not rule or rule.get("type") == "default":
        return {"matched": False, "final_folder": "", "rule_chain": [], "details": [], "message": "선택한 규칙을 찾을 수 없습니다."}

    detail = route_test_rule_matches(rule, key_set)
    folder = str(rule.get("folder") or "").strip()
    return {
        "matched": bool(detail.get("matched")),
        "default_reached": False,
        "final_folder": folder if detail.get("matched") else "",
        "rule_chain": [folder] if folder and detail.get("matched") else [],
        "details": [{"folder": folder, "label": folder, **detail}],
        "message": detail.get("message", "")
    }


def route_test_build_prompt_rule(data):
    text = str(data.get("prompt_rule_text") or "").strip()
    mode = "group" if data.get("prompt_rule_mode") == "group" else "single"

    if not text:
        return None

    return {
        "type": "custom",
        "folder": "임시 프롬프트 규칙",
        "prompt_text": text,
        "tags": parse_route_tags_single(text),
        "prompt_mode": mode,
        "tag_groups": parse_route_tag_groups(text),
        "condition": "any",
        "match_count": 1,
        "children": []
    }


def route_test_run_payload(data, tokens):
    rules = normalize_custom_route_rules(data.get("rules", []))
    key_set = route_test_build_key_set(tokens)

    target_mode = data.get("target_mode") or data.get("scope") or "all"

    if target_mode == "prompt":
        temp_rule = route_test_build_prompt_rule(data)
        if not temp_rule:
            return {
                "matched": False,
                "scope": "prompt",
                "rule_label": "임시 프롬프트 규칙",
                "message": "임시 감지 규칙이 비어 있습니다.",
                "details": []
            }

        result = route_test_match_single_rule(temp_rule, key_set)
        result["scope"] = "prompt"
        result["type"] = "single"
        result["rule_label"] = "임시 프롬프트 규칙"
        return result

    if target_mode == "single" or data.get("scope") == "single":
        return route_test_match_selected_rules(rules, key_set, route_test_get_rule_paths(data))

    return route_test_find_matching_route(rules, key_set)


def route_test_prompt_preview_from_tokens(tokens, limit=30):
    tokens = tokens or []
    preview = ", ".join(tokens[:limit])
    if len(tokens) > limit:
        preview += f" ... plus {len(tokens) - limit} more"
    return preview


def route_test_prompt_text_from_prompt_info(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    base_prompt = str(
        prompt_info.get("basePrompt")
        or prompt_info.get("baseCaption")
        or prompt_info.get("prompt")
        or prompt_info.get("base_prompt")
        or ""
    ).strip()

    char_prompts = prompt_info.get("charPrompts") or prompt_info.get("char_prompts") or []
    if not isinstance(char_prompts, list):
        char_prompts = []

    char_prompt = str(
        prompt_info.get("charPrompt")
        or prompt_info.get("characterPrompt")
        or ""
    ).strip()

    negative_prompt = str(
        prompt_info.get("negativePrompt")
        or prompt_info.get("negative_prompt")
        or prompt_info.get("uc")
        or ""
    ).strip()

    if base_prompt:
        parts.append("[Base Prompt]\n" + base_prompt)

    clean_char_prompts = [str(item or "").strip() for item in char_prompts if str(item or "").strip()]
    if char_prompt:
        clean_char_prompts.append(char_prompt)

    if clean_char_prompts:
        parts.append("[Character Prompt]\n" + "\n".join(clean_char_prompts))

    if negative_prompt:
        parts.append("[Negative Prompt]\n" + negative_prompt)

    return "\n\n".join(parts).strip()


ROUTE_TEST_JOBS = {}
ROUTE_TEST_LOCK = threading.Lock()


def public_route_test_job(job):
    if not job:
        return None
    return {
        "job_id": job.get("job_id", ""),
        "state": job.get("state", "queued"),
        "processed_count": int(job.get("processed_count", 0) or 0),
        "total_count": int(job.get("total_count", 0) or 0),
        "matched_count": int(job.get("matched_count", 0) or 0),
        "unmatched_count": int(job.get("unmatched_count", 0) or 0),
        "error_count": int(job.get("error_count", 0) or 0),
        "message": job.get("message", ""),
        "results": job.get("results", []),
        "target_mode": job.get("target_mode", "all"),
        "warning": job.get("warning", "")
    }


def extract_prompt_info_from_image_filelike(file_storage):
    with Image.open(file_storage.stream) as img:
        raw_meta = ""
        stealth_data = image_logic.read_stealth_info(img)
        if stealth_data:
            raw_meta = stealth_data
        elif "parameters" in img.info:
            raw_meta = img.info["parameters"]
        elif "Comment" in img.info:
            raw_meta = img.info["Comment"]
            if isinstance(raw_meta, bytes):
                raw_meta = raw_meta.decode("utf-8", "ignore")

        raw_meta = str(raw_meta or "").strip()
        meta = {}
        if raw_meta.startswith("{"):
            try:
                meta = json.loads(raw_meta)
                if "Comment" in meta and isinstance(meta["Comment"], str) and meta["Comment"].strip().startswith("{"):
                    meta = json.loads(meta["Comment"])
            except Exception:
                meta = {}

        if meta:
            v4_prompt = meta.get("v4_prompt", {})
            caption = v4_prompt.get("caption", {}) if isinstance(v4_prompt, dict) else {}
            base_caption = str(caption.get("base_caption", "") or "").strip()
            v4_negative_prompt = meta.get("v4_negative_prompt", {})
            negative_caption = v4_negative_prompt.get("caption", {}) if isinstance(v4_negative_prompt, dict) else {}
            char_prompts = []
            for item in caption.get("char_captions", []) if isinstance(caption.get("char_captions", []), list) else []:
                if isinstance(item, dict) and str(item.get("char_caption", "")).strip():
                    char_prompts.append(str(item.get("char_caption", "")).strip())
            return normalize_prompt_info_for_sidecar({
                "basePrompt": base_caption or meta.get("prompt", "") or meta.get("basePrompt", ""),
                "baseCaption": base_caption,
                "negativePrompt": negative_caption.get("base_caption", "") or meta.get("negative_prompt", "") or meta.get("negativePrompt", "") or meta.get("uc", ""),
                "charPrompts": char_prompts
            })

        prompt_part = raw_meta
        negative_prompt = ""
        if "Negative prompt:" in raw_meta:
            prompt_part, negative_prompt = raw_meta.split("Negative prompt:", 1)
        if "\n" in prompt_part:
            prompt_part = prompt_part.split("\n")[0]
        return normalize_prompt_info_for_sidecar({
            "basePrompt": prompt_part.strip(),
            "negativePrompt": negative_prompt.strip(),
            "charPrompts": []
        })


@app.route('/api/custom_rules', methods=['GET'])
def get_custom_rules():
    config = utils.load_config()
    rules = normalize_custom_route_rules(config.get("custom_rules", []))
    return jsonify({"rules": rules})


@app.route('/api/save_custom_rules', methods=['POST'])
def save_custom_rules():
    data = request.json or {}
    config = utils.load_config()
    config["custom_rules"] = normalize_custom_route_rules(data.get("rules", []))
    utils.save_config(config)
    return jsonify({"status": "success"})


@app.route('/api/route_test/text', methods=['POST'])
def route_test_text():
    try:
        data = request.json or {}
        tokens = route_test_prompt_tokens_from_text(data.get("prompt") or "")
        result = route_test_run_payload(data, tokens)
        return jsonify({"status": "success", "input_type": "text", "tokens": tokens, "result": result})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/route_test/image', methods=['POST'])
def route_test_image():
    try:
        data = request.json or {}
        full_path, real_rel = resolve_gallery_image_path(data.get("path") or "")
        prompt_info = load_prompt_sidecar(full_path) or extract_prompt_info_from_image(full_path) or {}
        tokens = route_test_prompt_tokens_from_prompt_info(prompt_info)
        prompt_text = route_test_prompt_text_from_prompt_info(prompt_info)
        result = route_test_run_payload(data, tokens)
        return jsonify({
            "status": "success",
            "input_type": "image",
            "path": real_rel,
            "file_name": os.path.basename(full_path),
            "tokens": tokens,
            "prompt_text": prompt_text,
            "prompt_preview": route_test_prompt_preview_from_tokens(tokens),
            "result": result
        })
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/route_test/images', methods=['POST'])
def route_test_images():
    try:
        data = request.json or {}
        results = []
        for raw_path in data.get("paths") or []:
            try:
                full_path, real_rel = resolve_gallery_image_path(raw_path)
                prompt_info = load_prompt_sidecar(full_path) or extract_prompt_info_from_image(full_path) or {}
                tokens = route_test_prompt_tokens_from_prompt_info(prompt_info)
                prompt_text = route_test_prompt_text_from_prompt_info(prompt_info)
                results.append({
                    "status": "success",
                    "input_type": "image",
                    "path": real_rel,
                    "file_name": os.path.basename(full_path),
                    "tokens": tokens,
                    "prompt_text": prompt_text,
                    "prompt_preview": route_test_prompt_preview_from_tokens(tokens),
                    "result": route_test_run_payload(data, tokens)
                })
            except Exception as item_error:
                results.append({
                    "status": "error",
                    "path": str(raw_path or ""),
                    "file_name": os.path.basename(str(raw_path or "")),
                    "message": str(item_error),
                    "result": {"matched": False, "final_folder": "", "rule_chain": [], "details": []}
                })
        return jsonify({"status": "success", "input_type": "images", "results": results})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/route_test/images_upload', methods=['POST'])
def route_test_images_upload():
    try:
        data = {
            "rules": json.loads(request.form.get("rules") or "[]"),
            "target_mode": request.form.get("target_mode") or request.form.get("scope") or "all",
            "scope": request.form.get("scope") or "all",
            "rule_path": json.loads(request.form.get("rule_path") or "[]"),
            "rule_paths": json.loads(request.form.get("rule_paths") or "[]"),
            "prompt_rule_text": request.form.get("prompt_rule_text") or "",
            "prompt_rule_mode": request.form.get("prompt_rule_mode") or "single"
        }
        results = []
        for file_storage in request.files.getlist("files"):
            try:
                prompt_info = extract_prompt_info_from_image_filelike(file_storage)
                tokens = route_test_prompt_tokens_from_prompt_info(prompt_info)
                prompt_text = route_test_prompt_text_from_prompt_info(prompt_info)
                results.append({
                    "status": "success",
                    "input_type": "uploaded_image",
                    "file_name": file_storage.filename or "uploaded image",
                    "tokens": tokens,
                    "prompt_text": prompt_text,
                    "prompt_preview": route_test_prompt_preview_from_tokens(tokens),
                    "result": route_test_run_payload(data, tokens)
                })
            except Exception as item_error:
                results.append({
                    "status": "error",
                    "file_name": file_storage.filename or "uploaded image",
                    "message": str(item_error),
                    "result": {"matched": False, "final_folder": "", "rule_chain": [], "details": []}
                })
        return jsonify({"status": "success", "input_type": "uploaded_images", "results": results})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def route_test_collect_folder_images(folder_full_path, include_subfolders=False):
    exts = {".png", ".jpg", ".jpeg", ".webp"}
    images = []
    if include_subfolders:
        for root, dirs, files in os.walk(folder_full_path):
            dirs[:] = [d for d in dirs if d not in {"_TRASH", UPSCALE_OUTPUT_FOLDER_NAME}]
            for name in files:
                if os.path.splitext(name)[1].lower() in exts:
                    images.append(os.path.join(root, name))
    else:
        for name in os.listdir(folder_full_path):
            full_path = os.path.join(folder_full_path, name)
            if os.path.isfile(full_path) and os.path.splitext(name)[1].lower() in exts:
                images.append(full_path)
    images.sort(key=lambda path: os.path.abspath(path).replace("\\", "/").lower())
    return images


def route_test_sample_images(images, sample_mode):
    sample_mode = sample_mode if sample_mode in ("random100", "first20", "first100", "all") else "random100"
    if sample_mode == "first20":
        return images[:20]
    if sample_mode == "first100":
        return images[:100]
    if sample_mode == "random100":
        return random.sample(images, min(100, len(images)))
    return images


def route_test_update_job(job_id, **patch):
    with ROUTE_TEST_LOCK:
        job = ROUTE_TEST_JOBS.get(job_id)
        if job:
            job.update(patch)


def route_test_folder_worker(job_id):
    with ROUTE_TEST_LOCK:
        job = ROUTE_TEST_JOBS.get(job_id)
    if not job:
        return

    cancel_event = job.get("_cancel_event")
    rules = job.get("rules") or []
    target_mode = job.get("target_mode", "all")
    scope = job.get("scope", "all")
    rule_path = job.get("rule_path") or []
    rule_paths = job.get("rule_paths") or []
    prompt_rule_text = job.get("prompt_rule_text", "")
    prompt_rule_mode = job.get("prompt_rule_mode", "single")
    max_display = int(job.get("max_display", 500) or 500)
    only_unmatched = bool(job.get("only_unmatched"))
    route_test_update_job(job_id, state="running", message="Running folder test.")

    for file_index, full_path in enumerate(job.get("files", [])):
        if cancel_event and cancel_event.is_set():
            route_test_update_job(job_id, state="cancelled", message="Folder test cancelled.")
            return

        rel_path = os.path.relpath(full_path, job.get("folder_full_path") or CLASSIFIED_DIR).replace("\\", "/")
        try:
            prompt_info = load_prompt_sidecar(full_path) or extract_prompt_info_from_image(full_path) or {}
            tokens = route_test_prompt_tokens_from_prompt_info(prompt_info)
            prompt_text = route_test_prompt_text_from_prompt_info(prompt_info)
            result = route_test_run_payload({
                "rules": rules,
                "target_mode": target_mode,
                "scope": scope,
                "rule_path": rule_path,
                "rule_paths": rule_paths,
                "prompt_rule_text": prompt_rule_text,
                "prompt_rule_mode": prompt_rule_mode
            }, tokens)
            matched = bool(result.get("matched") or result.get("default_reached"))
            with ROUTE_TEST_LOCK:
                job = ROUTE_TEST_JOBS.get(job_id)
                if not job:
                    return
                job["processed_count"] += 1
                job["matched_count"] += 1 if matched else 0
                job["unmatched_count"] += 0 if matched else 1
                if ((not only_unmatched) or (not matched)) and len(job["results"]) < max_display:
                    job["results"].append({
                        "path": rel_path,
                        "file_name": os.path.basename(full_path),
                        "tokens": tokens[:30],
                        "prompt_text": prompt_text,
                        "prompt_preview": route_test_prompt_preview_from_tokens(tokens),
                        "preview_url": f"/api/route_test/folder/preview/{job_id}/{file_index}",
                        "result": result
                    })
                job["message"] = f"{job['processed_count']} / {job['total_count']}"
        except Exception as e:
            with ROUTE_TEST_LOCK:
                job = ROUTE_TEST_JOBS.get(job_id)
                if not job:
                    return
                job["processed_count"] += 1
                job["error_count"] += 1
                if len(job["results"]) < max_display:
                    job["results"].append({
                        "path": rel_path,
                        "file_name": os.path.basename(full_path),
                        "error": str(e),
                        "preview_url": f"/api/route_test/folder/preview/{job_id}/{file_index}",
                        "result": {"matched": False, "final_folder": "", "rule_chain": [], "details": []}
                    })

    route_test_update_job(job_id, state="done", message="Folder test complete.")


@app.route('/api/route_test/folder/pick', methods=['POST'])
def route_test_pick_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)

        try:
            folder_path = filedialog.askdirectory(title="라우팅 테스트할 폴더 선택") or ""
        finally:
            root.destroy()

        if not folder_path:
            return jsonify({"status": "cancelled", "message": "폴더 선택이 취소되었습니다."}), 400

        if not os.path.isdir(folder_path):
            return jsonify({"status": "error", "message": "선택한 경로가 폴더가 아닙니다."}), 400

        folder_path = os.path.abspath(folder_path)
        return jsonify({
            "status": "success",
            "folder_path": folder_path,
            "folder_name": os.path.basename(folder_path.rstrip("\\/")) or folder_path
        })
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/route_test/folder/start', methods=['POST'])
def route_test_folder_start():
    try:
        data = request.json or {}
        raw_folder_path = str(data.get("folder_path") or "").strip()
        if not raw_folder_path:
            return jsonify({"status": "error", "message": "폴더 경로를 입력하세요."}), 400

        if os.path.isabs(raw_folder_path):
            folder_full_path = os.path.abspath(raw_folder_path)
        else:
            folder_rel = clean_gallery_rel_path(raw_folder_path)
            folder_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, folder_rel, strip_prefix="TOTAL_CLASSIFIED/")

        if not os.path.isdir(folder_full_path):
            return jsonify({"status": "error", "message": "폴더를 찾을 수 없습니다."}), 404

        all_images = route_test_collect_folder_images(folder_full_path, bool(data.get("include_subfolders")))
        sample_mode = data.get("sample_mode") if data.get("sample_mode") in ("random100", "first20", "first100", "all") else "random100"
        files = route_test_sample_images(all_images, sample_mode)
        warning = "전체 검사는 이미지가 많아 오래 걸릴 수 있습니다." if sample_mode == "all" and len(all_images) >= 500 else ""
        max_display = max(1, min(500, int(data.get("max_display") or 500)))
        job_id = f"route_test_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
        job = {
            "job_id": job_id,
            "state": "queued",
            "processed_count": 0,
            "total_count": len(files),
            "matched_count": 0,
            "unmatched_count": 0,
            "error_count": 0,
            "message": "Queued.",
            "results": [],
            "warning": warning,
            "rules": normalize_custom_route_rules(data.get("rules", [])),
            "target_mode": data.get("target_mode") or data.get("scope") or "all",
            "scope": "single" if data.get("scope") == "single" else "all",
            "rule_path": data.get("rule_path") or [],
            "rule_paths": route_test_get_rule_paths(data),
            "prompt_rule_text": data.get("prompt_rule_text") or "",
            "prompt_rule_mode": data.get("prompt_rule_mode") or "single",
            "files": files,
            "folder_full_path": folder_full_path,
            "only_unmatched": bool(data.get("only_unmatched")),
            "max_display": max_display,
            "_cancel_event": threading.Event()
        }
        with ROUTE_TEST_LOCK:
            ROUTE_TEST_JOBS[job_id] = job
        threading.Thread(target=route_test_folder_worker, args=(job_id,), daemon=True).start()
        return jsonify({"status": "started", "job_id": job_id, "total_count": len(files), "sample_mode": sample_mode, "warning": warning})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/route_test/folder/status/<job_id>')
def route_test_folder_status(job_id):
    with ROUTE_TEST_LOCK:
        job = ROUTE_TEST_JOBS.get(job_id)
    if not job:
        return jsonify({"status": "error", "message": "테스트 작업을 찾을 수 없습니다."}), 404
    return jsonify({"status": "success", "job": public_route_test_job(job)})


@app.route('/api/route_test/folder/preview/<job_id>/<int:file_index>')
def route_test_folder_preview(job_id, file_index):
    with ROUTE_TEST_LOCK:
        job = ROUTE_TEST_JOBS.get(job_id)

    if not job:
        return "Not found", 404

    files = job.get("files") or []
    if file_index < 0 or file_index >= len(files):
        return "Not found", 404

    full_path = files[file_index]
    if not os.path.isfile(full_path):
        return "Not found", 404

    return send_file(full_path)


@app.route('/api/route_test/folder/cancel/<job_id>', methods=['POST'])
def route_test_folder_cancel(job_id):
    with ROUTE_TEST_LOCK:
        job = ROUTE_TEST_JOBS.get(job_id)
        if not job:
            return jsonify({"status": "error", "message": "테스트 작업을 찾을 수 없습니다."}), 404
        cancel_event = job.get("_cancel_event")
        if cancel_event:
            cancel_event.set()
        if job.get("state") in ("queued", "running"):
            job["state"] = "cancelled"
            job["message"] = "Folder test cancelled."
    return jsonify({"status": "success", "job": public_route_test_job(job)})

# 🌟 [추가] 그림체 통계 및 랜덤 썸네일 제공
# [수정] 그림체 통계 API - 유효한 파일만 샘플로 사용
@app.route('/api/art_style_stats', methods=['GET'])
def art_style_stats():
    db = utils.HistoryDB()
    try:
        cursor = db.conn.cursor()
        cursor.execute("""
            SELECT a.artist_name, a.name_kr, COUNT(i.path) as img_count
            FROM art_styles a
            JOIN image_artists i ON a.artist_name = i.artist_name
            GROUP BY a.artist_name
            ORDER BY img_count DESC
        """)
        stats = []
        rows = cursor.fetchall()

        cursor.execute("SELECT artist_name, path FROM image_artists")
        import random
        artist_images = {}
        for r in cursor.fetchall():
            if r[0] not in artist_images:
                artist_images[r[0]] = []
            artist_images[r[0]].append(r[1])

        for row in rows:
            artist = row[0]
            # [핵심] 휴지통에 없고 실제 디스크에 존재하는 파일만 필터링
            all_paths = artist_images.get(artist, [])
            valid_paths = [p for p in all_paths if "_TRASH" not in p and os.path.exists(os.path.join(CLASSIFIED_DIR, p))]
            
            samples = []
            if valid_paths:
                samples = random.sample(valid_paths, min(3, len(valid_paths)))
                
            stats.append({
                "artist_name": artist,
                "name_kr": row[1] or "",
                "count": len(valid_paths), # 실제 존재하는 파일 수로 표시
                "samples": samples
            })
        return jsonify(stats)
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        db.close()

@app.route('/api/daki/art_style_sources', methods=['GET'])
def daki_art_style_sources():
    result = {
        "saved_styles": [],
        "weighted_artists": []
    }

    # 1. 저장된 스타일 프리셋(styles.json)
    try:
        if os.path.exists(STYLES_FILE):
            with open(STYLES_FILE, 'r', encoding='utf-8') as f:
                styles_data = json.load(f) or {}

            if isinstance(styles_data, dict):
                for name, prompt in styles_data.items():
                    name = str(name or '').strip()
                    prompt = str(prompt or '').strip()

                    if not name and not prompt:
                        continue

                    result["saved_styles"].append({
                        "source": "saved_styles",
                        "name": name or prompt[:40],
                        "name_kr": "",
                        "prompt": prompt,
                        "count": 0,
                        "samples": []
                    })
    except Exception as e:
        print(f"⚠️ 그림체 보관함 로드 실패: {e}")

    # 2. ART STYLE MANAGER: art_styles / image_artists 기반
    db = None
    try:
        db = utils.HistoryDB()
        cursor = db.conn.cursor()

        cursor.execute("""
            SELECT a.artist_name, a.name_kr, COUNT(i.path) as img_count
            FROM art_styles a
            LEFT JOIN image_artists i ON a.artist_name = i.artist_name
            GROUP BY a.artist_name
            ORDER BY img_count DESC, a.artist_name ASC
        """)

        rows = cursor.fetchall()

        cursor.execute("SELECT artist_name, path FROM image_artists")
        artist_images = {}
        for artist_name, path in cursor.fetchall():
            artist_images.setdefault(artist_name, []).append(path)

        for artist_name, name_kr, img_count in rows:
            artist_name = str(artist_name or '').strip()
            if not artist_name:
                continue

            all_paths = artist_images.get(artist_name, [])
            valid_paths = [
                p for p in all_paths
                if "_TRASH" not in str(p) and os.path.exists(os.path.join(CLASSIFIED_DIR, str(p)))
            ]

            samples = random.sample(valid_paths, min(3, len(valid_paths))) if valid_paths else []

            # 순서 보존 가중치 또는 artist 조합 프롬프트만 다키 소스로 사용
            if not is_weighted_order_style_prompt(artist_name):
                continue

            weighted_prompt = cleanup_weighted_order_style_prompt(artist_name)

            result["weighted_artists"].append({
                "source": "weighted_artists",
                "name": weighted_prompt,
                "name_kr": name_kr or "",
                "prompt": weighted_prompt,
                "raw_artist": artist_name,
                "count": len(valid_paths),
                "samples": samples
            })

    except Exception as e:
        print(f"⚠️ 다키 그림체 목록 로드 실패: {e}")
    finally:
        if db:
            db.close()

    return jsonify(result)


def format_artist_style_prompt_for_daki(artist_name):
    text = str(artist_name or '').strip()

    if not text:
        return ""

    # 이미 가중치 문법이면 그대로 사용
    if "::" in text:
        return text

    # 이미 artist: 형식이면 그대로 가중치 문법으로 감싼다.
    if text.startswith("artist:"):
        return f"1.0::{text}::"

    # DB의 artist 원본 키를 NovelAI 가중치 문법으로 변환
    return f"1.0::artist:{text}::"

def is_weighted_order_style_prompt(text):
    text = str(text or "").strip()
    if not text:
        return False

    # ART STYLE MANAGER의 그림체 값을 다키 프롬프트에 맞게 변환
    if text.startswith("[가중치]"):
        return True

    # 0.30::artist:xxx:: 같은 NovelAI 가중치 문법 포함
    if "::artist:" in text or re.search(r'\d+(?:\.\d+)?::\s*artist:', text):
        return True

    return False


def cleanup_weighted_order_style_prompt(text):
    text = str(text or "").strip()

    # 표시용 접두어 제거
    text = re.sub(r'^\[가중치]\s*', '', text).strip()

    return text

def normalize_style_lab_artist_name_from_manager(value):
    text = str(value or "").strip()
    text = text.replace("\\\\n", " ").replace("\\n", " ").replace("\n", " ")
    text = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', text).strip()
    text = re.sub(r'^[-+]?\d+(?:\.\d+)?::\s*', '', text).strip()

    if text.lower().startswith("artist:"):
        text = text[7:].strip()

    text = re.sub(r'\s*::$', '', text).strip()
    text = text.strip(" ,[]{}()")
    text = re.sub(r'\s+', '_', text)

    blocked = {
        "",
        "1",
        "3",
        "none",
        "collaboration",
        "artist_collaboration",
        "artist:collaboration",
        "multiple_artists",
        "solo_artist",
        "artist_request",
    }

    if text.lower() in blocked:
        return ""

    return text


def parse_art_style_manager_prompt_to_style_tags(raw_text):
    text = str(raw_text or "").strip()
    text = text.replace("\\\\n", "\n").replace("\\n", "\n")
    text = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', text).strip()

    result = []
    seen = set()

    def add_artist(name, weight=1.0):
        name = normalize_style_lab_artist_name_from_manager(name)
        if not name:
            return

        key = name.lower()
        if key in seen:
            return

        seen.add(key)
        result.append({
            "weight": float(weight),
            "name": name
        })

    # 1. 가중치 artist 토큰 먼저 수집
    # 예: 1.25::artist:foo::, -0.2::artist:bar::
    weighted_pattern = re.compile(
        r'([-+]?\d+(?:\.\d+)?)::\s*artist:\s*(.*?)(?=::)',
        re.IGNORECASE | re.DOTALL
    )

    weighted_spans = []

    for match in weighted_pattern.finditer(text):
        try:
            weight = float(match.group(1))
        except Exception:
            weight = 1.0

        add_artist(match.group(2), weight)
        weighted_spans.append(match.span())

    # 2. 가중치 토큰을 공백으로 지운 뒤, 남은 일반 artist 태그도 수집
    # 예: artist:foo, artist:bar
    remainder_parts = []
    last = 0

    for start, end in weighted_spans:
        remainder_parts.append(text[last:start])
        remainder_parts.append(" ")
        last = end

    remainder_parts.append(text[last:])
    remainder = "".join(remainder_parts)

    plain_artist_pattern = re.compile(
        r'artist:\s*([^,\]\}\|\n\r\t\\:]+)',
        re.IGNORECASE
    )

    for match in plain_artist_pattern.finditer(remainder):
        add_artist(match.group(1), 1.0)

    # 3. artist: 없이 단일 작가명만 저장된 오래된 항목 폴백
    if not result and "artist:" not in text.lower() and "," not in text:
        add_artist(text, 1.0)

    return result

def make_unique_style_lab_style_name(base_name, styles_data, artists_data):
    base_name = str(base_name or "").strip()
    base_name = base_name.replace("\\\\n", " ").replace("\\n", " ").replace("\n", " ")
    base_name = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', base_name).strip()
    base_name = re.sub(r'\s+', ' ', base_name).strip()

    if len(base_name) > 80:
        base_name = base_name[:77].rstrip() + "..."

    if not base_name:
        base_name = "ART STYLE MANAGER"

    used = set(styles_data.keys()) | set(artists_data.keys())

    if base_name not in used:
        return base_name

    for index in range(2, 10000):
        candidate = f"{base_name} ({index})"
        if candidate not in used:
            return candidate

    return f"{base_name} {int(time.time())}"


@app.route('/api/art_style_to_lab', methods=['POST'])
def art_style_to_lab():
    data = request.json or {}

    raw_artist = str(data.get("artist_name") or "").strip()
    name_kr = str(data.get("name_kr") or "").strip()
    requested_name = str(data.get("style_name") or "").strip()

    if not raw_artist:
        return jsonify({
            "status": "error",
            "message": "추가할 그림체 이름이 없습니다."
        }), 400

    style_tags = parse_art_style_manager_prompt_to_style_tags(raw_artist)

    if not style_tags:
        return jsonify({
            "status": "error",
            "message": "artist 태그를 추출하지 못했습니다."
        }), 400

    styles_data = {}
    artists_data = {}

    try:
        if os.path.exists(STYLES_FILE):
            with open(STYLES_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f) or {}
                if isinstance(loaded, dict):
                    styles_data = loaded
    except Exception:
        styles_data = {}

    try:
        if os.path.exists(ARTISTS_FILE):
            with open(ARTISTS_FILE, "r", encoding="utf-8") as f:
                loaded = json.load(f) or {}
                if isinstance(loaded, dict):
                    artists_data = loaded
    except Exception:
        artists_data = {}

    base_name = requested_name or name_kr or raw_artist
    style_name = make_unique_style_lab_style_name(base_name, styles_data, artists_data)

    artists_data[style_name] = [item["name"] for item in style_tags]
    styles_data[style_name] = json.dumps({
        "styleTags": style_tags,
        "qualityTags": ""
    }, ensure_ascii=False)

    with open(ARTISTS_FILE, "w", encoding="utf-8") as f:
        json.dump(artists_data, f, ensure_ascii=False, indent=4)

    with open(STYLES_FILE, "w", encoding="utf-8") as f:
        json.dump(styles_data, f, ensure_ascii=False, indent=4)

    return jsonify({
        "status": "success",
        "style_name": style_name,
        "artist_count": len(style_tags)
    })

# [수정] 랜덤 이미지 갱신 API - 유효성 검사 추가
@app.route('/api/random_artist_images', methods=['GET'])
def random_artist_images():
    artist = request.args.get('artist')
    db = utils.HistoryDB()
    try:
        cursor = db.conn.cursor()
        cursor.execute("SELECT path FROM image_artists WHERE artist_name = ?", (artist,))
        paths = [r[0] for r in cursor.fetchall()]
        
        # [핵심] 실제 디스크에 존재하고 휴지통이 아닌 파일만 추출
        valid_paths = [p for p in paths if "_TRASH" not in p and os.path.exists(os.path.join(CLASSIFIED_DIR, p))]
        
        samples = []
        if valid_paths:
            samples = random.sample(valid_paths, min(3, len(valid_paths)))
            
        return jsonify({"samples": samples})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        db.close()

# 🌟 [추가] 그림체 한국어 이름 일괄 업데이트
@app.route('/api/bulk_update_art_styles', methods=['POST'])
def bulk_update_art_styles():
    data = request.json
    db = utils.HistoryDB()
    try:
        with db.conn:
            for item in data:
                db.conn.execute("UPDATE art_styles SET name_kr = ? WHERE artist_name = ?", (item['name_kr'], item['artist_name']))
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        db.close()

# =====================================================================
# 🌟 그림체 연구소 & NovelAI 생성 전용 API 통합 🌟
# =====================================================================
import urllib.request
import urllib.error
import base64
import zipfile
import io
import random

CONFIG_FILE = os.path.join(CURRENT_DIR, "lab_config.json")
ARTISTS_FILE = os.path.join(CURRENT_DIR, "artists.json")
STYLES_FILE = os.path.join(CURRENT_DIR, "styles.json")
OUTPUT_DIR = os.path.join(CURRENT_DIR, "output")
CANVAS_IMPORT_DIR = os.path.join(CURRENT_DIR, "canvas_imports")
DAKI_GENERATED_TEMP_DIR = os.path.join(CURRENT_DIR, "daki_generated_temp")
os.makedirs(CANVAS_IMPORT_DIR, exist_ok=True)
os.makedirs(DAKI_GENERATED_TEMP_DIR, exist_ok=True)
NAI_IMAGE_MODEL = "nai-diffusion-4-5-full"
NAI_INPAINT_MODEL = "nai-diffusion-4-5-full-inpainting"
CANVAS_IMPORT_CLEANUP_CATEGORIES = {"canvas", "canvas_inpaint"}
CANVAS_IMPORT_ALLOWED_CATEGORIES = CANVAS_IMPORT_CLEANUP_CATEGORIES | {"gallery_inpaint"}


def safe_canvas_import_token(value, fallback):
    token = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip())
    token = token.strip("._-")
    return token[:80] or fallback


def canvas_import_relative_path(filename):
    return str(filename or "").replace("\\", "/").lstrip("/")


def canvas_import_public_src(filename):
    return f"/canvas-imports/{canvas_import_relative_path(filename)}"


def get_canvas_import_save_dir(category=None, session_id=None):
    category = safe_canvas_import_token(category, "") if category else ""

    if category not in CANVAS_IMPORT_ALLOWED_CATEGORIES:
        return CANVAS_IMPORT_DIR, ""

    session_id = safe_canvas_import_token(session_id, f"{category}_{int(time.time() * 1000)}")
    rel_dir = f"{category}/{session_id}"
    save_dir = utils.resolve_safe_path(CANVAS_IMPORT_DIR, rel_dir)
    os.makedirs(save_dir, exist_ok=True)
    return save_dir, rel_dir


def extract_canvas_import_ref(value):
    parsed_path = urlsplit(str(value or "")).path

    if parsed_path.startswith("/canvas-imports/"):
        return unquote(parsed_path[len("/canvas-imports/"):]).replace("\\", "/").lstrip("/")

    if parsed_path.startswith("canvas_imports/"):
        return unquote(parsed_path[len("canvas_imports/"):]).replace("\\", "/").lstrip("/")

    return ""


def remove_empty_canvas_import_dirs():
    for root, dirs, files in os.walk(CANVAS_IMPORT_DIR, topdown=False):
        if root == CANVAS_IMPORT_DIR:
            continue

        try:
            if not os.listdir(root):
                os.rmdir(root)
        except OSError:
            pass


def cleanup_canvas_import_session(category, session_id):
    category = safe_canvas_import_token(category, "")
    session_id = safe_canvas_import_token(session_id, "")

    if category not in CANVAS_IMPORT_ALLOWED_CATEGORIES or not session_id:
        return 0

    session_dir = utils.resolve_safe_path(CANVAS_IMPORT_DIR, f"{category}/{session_id}")

    if not os.path.isdir(session_dir):
        return 0

    deleted = 0
    for _, _, files in os.walk(session_dir):
        deleted += len(files)

    shutil.rmtree(session_dir, ignore_errors=True)
    remove_empty_canvas_import_dirs()
    return deleted


def canvas_import_ref_is_active_session(rel_path, active_session_ids):
    parts = canvas_import_relative_path(rel_path).split("/")
    if len(parts) < 3:
        return False

    category, session_id = parts[0], parts[1]
    return category in CANVAS_IMPORT_CLEANUP_CATEGORIES and session_id in active_session_ids


def cleanup_unreferenced_canvas_imports(retained_refs, active_session_ids=None):
    retained = {
        canvas_import_relative_path(ref)
        for ref in (retained_refs or [])
        if canvas_import_relative_path(ref)
    }
    active_sessions = {
        safe_canvas_import_token(session_id, "")
        for session_id in (active_session_ids or [])
        if safe_canvas_import_token(session_id, "")
    }

    deleted = 0

    for root, _, files in os.walk(CANVAS_IMPORT_DIR):
        for filename in files:
            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, CANVAS_IMPORT_DIR).replace("\\", "/")
            first_part = rel_path.split("/", 1)[0]
            is_managed = first_part in CANVAS_IMPORT_CLEANUP_CATEGORIES
            is_legacy_managed = "/" not in rel_path and (
                filename.startswith("canvas_import_") or filename.startswith("canvas_inpaint_")
            )

            if not (is_managed or is_legacy_managed):
                continue

            if rel_path in retained:
                continue

            if canvas_import_ref_is_active_session(rel_path, active_sessions):
                continue

            try:
                os.remove(full_path)
                deleted += 1
            except OSError:
                pass

    remove_empty_canvas_import_dirs()
    return deleted


def cleanup_canvas_import_refs(refs, retained_refs):
    retained = {
        canvas_import_relative_path(ref)
        for ref in (retained_refs or [])
        if canvas_import_relative_path(ref)
    }
    target_refs = {
        canvas_import_relative_path(ref)
        for ref in (refs or [])
        if canvas_import_relative_path(ref)
    }

    deleted = 0

    for rel_path in target_refs:
        first_part = rel_path.split("/", 1)[0]
        filename = os.path.basename(rel_path)
        is_managed = first_part in CANVAS_IMPORT_ALLOWED_CATEGORIES
        is_legacy_managed = "/" not in rel_path and (
            filename.startswith("canvas_import_") or filename.startswith("canvas_inpaint_")
        )

        if not (is_managed or is_legacy_managed):
            continue

        if rel_path in retained:
            continue

        try:
            file_path = utils.resolve_safe_path(CANVAS_IMPORT_DIR, rel_path)
        except ValueError:
            continue

        if not os.path.isfile(file_path):
            continue

        try:
            os.remove(file_path)
            deleted += 1
        except OSError:
            pass

    remove_empty_canvas_import_dirs()
    return deleted


@app.route('/canvas-imports/<path:filename>')
def serve_canvas_import(filename):
    try:
        file_path = utils.resolve_safe_path(CANVAS_IMPORT_DIR, filename)
    except ValueError:
        return "Invalid path", 400

    if os.path.exists(file_path):
        return send_file(file_path)

    return "Not found", 404


@app.route('/api/canvas/import_base64', methods=['POST'])
def canvas_import_base64():
    data = request.json or {}
    image_data = str(data.get("image", "") or "")

    if not image_data:
        return jsonify({"status": "error", "message": "이미지 데이터가 없습니다."}), 400

    try:
        if "," in image_data:
            header, b64 = image_data.split(",", 1)
        else:
            header, b64 = "", image_data

        ext = "png"
        if "image/jpeg" in header or "image/jpg" in header:
            ext = "jpg"
        elif "image/webp" in header:
            ext = "webp"

        raw = base64.b64decode(b64)
        save_dir, rel_dir = get_canvas_import_save_dir(
            data.get("category"),
            data.get("sessionId")
        )
        filename = f"canvas_import_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.{ext}"
        file_path = os.path.join(save_dir, filename)
        rel_name = f"{rel_dir}/{filename}" if rel_dir else filename

        with open(file_path, "wb") as f:
            f.write(raw)

        return jsonify({
            "status": "success",
            "src": canvas_import_public_src(rel_name),
            "name": rel_name
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


def read_canvas_image_bytes(image_ref):
    image_ref = str(image_ref or "").strip()
    if not image_ref:
        raise ValueError("이미지 데이터가 없습니다.")

    if "," in image_ref and image_ref.startswith("data:"):
        return base64.b64decode(image_ref.split(",", 1)[1])

    parsed_path = urlsplit(image_ref).path

    if parsed_path.startswith("/canvas-imports/"):
        filename = parsed_path[len("/canvas-imports/"):]
        file_path = utils.resolve_safe_path(CANVAS_IMPORT_DIR, filename)
        with open(file_path, "rb") as f:
            return f.read()

    if parsed_path.startswith("canvas_imports/"):
        filename = parsed_path[len("canvas_imports/"):]
        file_path = utils.resolve_safe_path(CANVAS_IMPORT_DIR, filename)
        with open(file_path, "rb") as f:
            return f.read()

    if parsed_path.startswith("/image/"):
        rel_path = unquote(parsed_path[len("/image/"):])
        file_path = utils.resolve_safe_path(CLASSIFIED_DIR, rel_path, strip_prefix="TOTAL_CLASSIFIED/")
        with open(file_path, "rb") as f:
            return f.read()

    raise ValueError("캔버스 이미지 경로를 읽을 수 없습니다.")


def prepare_inpaint_mask_bytes(mask_bytes):
    with Image.open(io.BytesIO(mask_bytes)) as mask_img:
        mask_img = mask_img.convert("RGBA")
        gray = mask_img.convert("L")
        binary = gray.point(lambda px: 255 if px > 32 else 0, "L")
        alpha = mask_img.getchannel("A").point(lambda px: 255 if px >= 16 else 0, "L")
        black = Image.new("L", mask_img.size, 0)
        binary = Image.composite(binary, black, alpha)

        width, height = binary.size
        grid = 8
        small_w = max(1, (width + grid - 1) // grid)
        small_h = max(1, (height + grid - 1) // grid)
        small = Image.new("L", (small_w, small_h), 0)

        for gy in range(small_h):
            top = gy * grid
            bottom = min(height, top + grid)
            for gx in range(small_w):
                left = gx * grid
                right = min(width, left + grid)
                if binary.crop((left, top, right, bottom)).getbbox():
                    small.putpixel((gx, gy), 255)

        binary = small.resize((small_w * grid, small_h * grid), Image.Resampling.NEAREST).crop((0, 0, width, height))

        output = io.BytesIO()
        binary.convert("RGB").save(output, format="PNG", compress_level=0, optimize=False)
        return output.getvalue()


def image_to_png_bytes(image):
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def blend_canvas_inpaint_result_with_source(source_bytes, generated_bytes, mask_bytes, feather=0):
    with Image.open(io.BytesIO(source_bytes)) as source_img:
        source_rgb = source_img.convert("RGB")
    with Image.open(io.BytesIO(generated_bytes)) as generated_img:
        generated_rgb = generated_img.convert("RGB")
    with Image.open(io.BytesIO(mask_bytes)) as mask_img:
        mask_l = mask_img.convert("L")

    if generated_rgb.size != source_rgb.size:
        generated_rgb = generated_rgb.resize(source_rgb.size, Image.Resampling.LANCZOS)
    if mask_l.size != source_rgb.size:
        mask_l = mask_l.resize(source_rgb.size, Image.Resampling.NEAREST)

    feather = max(0, int(feather or 0))
    if feather:
        from PIL import ImageFilter
        mask_l = mask_l.filter(ImageFilter.GaussianBlur(radius=feather))

    return Image.composite(generated_rgb, source_rgb, mask_l)


def save_canvas_generated_image(raw_bytes, prefix="canvas_inpaint", category=None, session_id=None):
    save_dir, rel_dir = get_canvas_import_save_dir(category, session_id)
    filename = f"{prefix}_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.png"
    file_path = os.path.join(save_dir, filename)
    rel_name = f"{rel_dir}/{filename}" if rel_dir else filename

    with open(file_path, "wb") as f:
        f.write(raw_bytes)

    return canvas_import_public_src(rel_name), rel_name


@app.route('/api/canvas/cleanup_imports', methods=['POST'])
def cleanup_canvas_imports():
    data = request.json or {}
    refs = data.get("retainedRefs") or []
    active_session_ids = data.get("activeSessionIds") or []

    if not isinstance(refs, list):
        return jsonify({"status": "error", "message": "retainedRefs must be a list."}), 400
    if not isinstance(active_session_ids, list):
        return jsonify({"status": "error", "message": "activeSessionIds must be a list."}), 400

    retained_refs = [extract_canvas_import_ref(ref) for ref in refs]
    deleted = cleanup_unreferenced_canvas_imports(retained_refs, active_session_ids)

    return jsonify({
        "status": "success",
        "deleted": deleted
    })


@app.route('/api/canvas/cleanup_import_refs', methods=['POST'])
def cleanup_canvas_import_refs_route():
    data = request.json or {}
    refs = data.get("refs") or []
    retained_refs = data.get("retainedRefs") or []

    if not isinstance(refs, list):
        return jsonify({"status": "error", "message": "refs must be a list."}), 400
    if not isinstance(retained_refs, list):
        return jsonify({"status": "error", "message": "retainedRefs must be a list."}), 400

    deleted = cleanup_canvas_import_refs(
        [extract_canvas_import_ref(ref) for ref in refs],
        [extract_canvas_import_ref(ref) for ref in retained_refs]
    )

    return jsonify({
        "status": "success",
        "deleted": deleted
    })


@app.route('/api/canvas/cleanup_import_session', methods=['POST'])
def cleanup_canvas_import_session_route():
    data = request.json or {}
    deleted = cleanup_canvas_import_session(
        data.get("category"),
        data.get("sessionId")
    )

    return jsonify({
        "status": "success",
        "deleted": deleted
    })


@app.route('/api/canvas/inpaint', methods=['POST'])
def canvas_inpaint():
    data = request.json or {}
    prompt_info = data.get("promptInfo") or {}

    api_key = str(data.get("key") or "").strip()
    if not api_key and os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                api_key = str((json.load(f) or {}).get("key") or "").strip()
        except Exception:
            api_key = ""
    if not api_key:
        return jsonify({"status": "error", "message": "NAI API Key가 없습니다."}), 400

    try:
        image_bytes = read_canvas_image_bytes(data.get("image"))
        mask_bytes = prepare_inpaint_mask_bytes(read_canvas_image_bytes(data.get("mask")))
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400

    width = int(data.get("width") or prompt_info.get("width") or 0)
    height = int(data.get("height") or prompt_info.get("height") or 0)
    if width <= 0 or height <= 0:
        try:
            with Image.open(io.BytesIO(image_bytes)) as img:
                width, height = img.size
        except Exception:
            return jsonify({"status": "error", "message": "이미지 크기를 확인할 수 없습니다."}), 400

    base_prompt = str(prompt_info.get("basePrompt") or data.get("base_prompt") or "").strip()
    char_prompt = str(prompt_info.get("charPrompt") or data.get("char_prompt") or "").strip()
    negative_prompt = str(prompt_info.get("negativePrompt") or data.get("negative_prompt") or "").strip()
    seed = int(prompt_info.get("seed") if prompt_info.get("seed") not in (None, "") else -1)
    if seed < 0:
        seed = random.randint(1, 4294967295)

    strength = float(prompt_info.get("strength") if prompt_info.get("strength") not in (None, "") else 1.0)
    strength = max(0.01, min(1.0, strength))

    char_prompts = normalize_char_prompts(prompt_info)
    char_captions_list = [
        {"char_caption": text, "centers": [{"x": 0.5, "y": 0.5}]}
        for text in char_prompts
    ]

    payload = {
        "input": base_prompt,
        "model": "nai-diffusion-4-5-full-inpainting",
        "action": "infill",
        "parameters": {
            "width": width,
            "height": height,
            "n_samples": 1,
            "seed": seed,
            "extra_noise_seed": seed,
            "sampler": prompt_info.get("sampler") or "k_euler_ancestral",
            "steps": int(prompt_info.get("steps") or 28),
            "scale": float(prompt_info.get("cfg") or prompt_info.get("scale") or 6),
            "negative_prompt": negative_prompt,
            "cfg_rescale": float(prompt_info.get("cfg_rescale") or 0.4),
            "noise_schedule": "native",
            "params_version": 3,
            "legacy": False,
            "legacy_v3_extend": False,
            "add_original_image": True,
            "prefer_brownian": True,
            "use_coords": False,
            "image": base64.b64encode(image_bytes).decode("utf-8"),
            "mask": base64.b64encode(mask_bytes).decode("utf-8"),
            "inpaintImg2ImgStrength": strength,
            "request_type": "NativeInfillingRequest",
            "deliberate_euler_ancestral_bug": False,
            "controlnet_strength": float(prompt_info.get("controlnet_strength") or 1),
            "noise": float(prompt_info.get("noise") or 0.0),
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": negative_prompt,
                    "char_captions": []
                },
                "legacy_uc": False
            },
            "v4_prompt": {
                "caption": {
                    "base_caption": base_prompt,
                    "char_captions": char_captions_list
                },
                "use_coords": False,
                "use_order": True
            }
        }
    }

    req = urllib.request.Request("https://image.novelai.net/ai/generate-image", method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0")

    try:
        with urllib.request.urlopen(req, data=json.dumps(payload).encode('utf-8')) as response:
            zip_data = response.read()
            with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
                for filename in z.namelist():
                    if filename.endswith('.png'):
                        generated_data = z.read(filename)
                        inpainted = blend_canvas_inpaint_result_with_source(
                            image_bytes,
                            generated_data,
                            mask_bytes,
                            feather=int(prompt_info.get("feather") or prompt_info.get("mask_blur") or 0)
                        )
                        img_data = image_to_png_bytes(inpainted)
                        image_data_url = f"data:image/png;base64,{base64.b64encode(img_data).decode('utf-8')}"

                        if data.get("persistResult") is False:
                            return jsonify({
                                "status": "success",
                                "src": image_data_url,
                                "name": "",
                                "image": image_data_url
                            })

                        src, saved_name = save_canvas_generated_image(
                            img_data,
                            category=data.get("tempCategory") or "canvas_inpaint",
                            session_id=data.get("tempSessionId")
                        )
                        return jsonify({
                            "status": "success",
                            "src": src,
                            "name": saved_name,
                            "image": image_data_url
                        })
            return jsonify({"status": "error", "message": "압축 파일에서 이미지를 찾을 수 없습니다."}), 500
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8', errors='ignore')
        return jsonify({"status": "error", "message": f"NovelAI 서버 에러(HTTP {e.code}): {error_body}"}), 500
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

if not os.path.exists(OUTPUT_DIR):
    os.makedirs(OUTPUT_DIR)


def cleanup_daki_generated_temp_dir():
    try:
        if os.path.isdir(DAKI_GENERATED_TEMP_DIR):
            shutil.rmtree(DAKI_GENERATED_TEMP_DIR, ignore_errors=True)
        os.makedirs(DAKI_GENERATED_TEMP_DIR, exist_ok=True)
    except Exception as e:
        print(f"⚠️ 다키 임시 목록 로드 실패: {e}")


cleanup_daki_generated_temp_dir()
atexit.register(cleanup_daki_generated_temp_dir)


def safe_daki_generated_id(value=None):
    raw = str(value or "").strip()
    raw = re.sub(r"[^A-Za-z0-9_-]+", "_", raw)
    raw = raw.strip("._-")
    if not raw:
        raw = f"daki_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
    return raw[:90]


def daki_temp_image_path(temp_id):
    temp_id = safe_daki_generated_id(temp_id)
    return utils.resolve_safe_path(DAKI_GENERATED_TEMP_DIR, f"{temp_id}.png")


def daki_temp_meta_path(temp_id):
    temp_id = safe_daki_generated_id(temp_id)
    return utils.resolve_safe_path(DAKI_GENERATED_TEMP_DIR, f"{temp_id}.json")


def build_daki_prompt_info_from_request(data):
    char_prompts = normalize_char_prompts(data)
    base_prompt = str(data.get("base_prompt") or data.get("basePrompt") or "").strip()
    negative_prompt = str(data.get("negative_prompt") or data.get("negativePrompt") or data.get("uc") or "").strip()

    return {
        "basePrompt": base_prompt,
        "baseCaption": base_prompt,
        "charPrompts": char_prompts,
        "charPrompt": ", ".join(char_prompts),
        "negativePrompt": negative_prompt,
        "negative_prompt": negative_prompt,
        "uc": negative_prompt,
        "width": data.get("width", ""),
        "height": data.get("height", ""),
        "scale": data.get("scale", ""),
        "cfg": data.get("scale", ""),
        "cfg_rescale": data.get("cfg_rescale", ""),
        "steps": data.get("steps", ""),
        "sampler": data.get("sampler", ""),
        "createdAt": datetime.datetime.now().isoformat()
    }


def save_daki_generated_temp_image(img_bytes, prompt_info):
    temp_id = safe_daki_generated_id()
    image_path = daki_temp_image_path(temp_id)
    meta_path = daki_temp_meta_path(temp_id)

    with open(image_path, "wb") as f:
        f.write(img_bytes)

    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(prompt_info or {}, f, ensure_ascii=False, indent=2)

    return {
        "id": temp_id,
        "src": f"/daki-generated-temp/{temp_id}.png",
        "name": f"{temp_id}.png",
        "prompt": prompt_info or {},
        "createdAt": prompt_info.get("createdAt") if isinstance(prompt_info, dict) else ""
    }


def load_daki_generated_meta(temp_id):
    meta_path = daki_temp_meta_path(temp_id)
    if not os.path.exists(meta_path):
        return {}

    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def list_daki_generated_temp_images():
    items = []

    if not os.path.isdir(DAKI_GENERATED_TEMP_DIR):
        return items

    for name in os.listdir(DAKI_GENERATED_TEMP_DIR):
        if not name.lower().endswith(".png"):
            continue

        temp_id = os.path.splitext(name)[0]
        image_path = daki_temp_image_path(temp_id)

        if not os.path.isfile(image_path):
            continue

        meta = load_daki_generated_meta(temp_id)

        items.append({
            "id": temp_id,
            "src": f"/daki-generated-temp/{temp_id}.png?t={int(os.path.getmtime(image_path))}",
            "name": name,
            "prompt": meta,
            "createdAt": meta.get("createdAt", ""),
            "mtime": os.path.getmtime(image_path)
        })

    items.sort(key=lambda item: item.get("mtime", 0), reverse=True)
    return items


@app.route('/daki-generated-temp/<path:filename>')
def serve_daki_generated_temp(filename):
    try:
        file_path = utils.resolve_safe_path(DAKI_GENERATED_TEMP_DIR, filename)
    except ValueError:
        return "Invalid path", 400

    if os.path.exists(file_path) and os.path.isfile(file_path):
        return send_file(file_path)

    return "Not found", 404


@app.route('/api/daki/generated_temp', methods=['GET'])
def daki_generated_temp_list():
    return jsonify({
        "status": "success",
        "items": list_daki_generated_temp_images()
    })


def remove_daki_temp_assets(temp_id):
    errors = []
    deleted = []

    for path in (daki_temp_image_path(temp_id), daki_temp_meta_path(temp_id)):
        try:
            if os.path.exists(path):
                os.remove(path)
                deleted.append(path)
        except Exception as e:
            errors.append(f"{os.path.basename(path)}: {e}")

    return deleted, errors


def count_image_files_in_dir(target_dir):
    count = 0

    if not os.path.isdir(target_dir):
        return 0

    for root, _, files in os.walk(target_dir):
        for name in files:
            if name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                count += 1

    return count


@app.route('/api/daki/generated_temp/delete', methods=['POST'])
def daki_generated_temp_delete():
    data = request.json or {}
    temp_id = safe_daki_generated_id(data.get("id"))

    deleted, errors = remove_daki_temp_assets(temp_id)

    return jsonify({
        "status": "success",
        "deleted": bool(deleted),
        "id": temp_id,
        "errors": errors
    })


@app.route('/api/daki/save_generated_to_gallery', methods=['POST'])
def daki_save_generated_to_gallery():
    data = request.json or {}
    ids = data.get("ids") or []
    options = data.get("options") or {}

    if not isinstance(ids, list) or not ids:
        return jsonify({"status": "error", "message": "저장할 임시 파일이 없습니다."}), 400

    clean_ids = []
    for item in ids:
        temp_id = safe_daki_generated_id(item)
        if temp_id and temp_id not in clean_ids:
            clean_ids.append(temp_id)

    if not clean_ids:
        return jsonify({"status": "error", "message": "저장할 임시 파일이 없습니다."}), 400

    staging_id = safe_daki_generated_id(f"save_{int(time.time() * 1000)}_{random.randint(1000, 9999)}")
    staging_dir = utils.resolve_safe_path(DAKI_GENERATED_TEMP_DIR, f"_gallery_save_{staging_id}")
    os.makedirs(staging_dir, exist_ok=True)

    copied = 0
    missing = []

    try:
        for temp_id in clean_ids:
            src_image = daki_temp_image_path(temp_id)
            src_meta = daki_temp_meta_path(temp_id)

            if not os.path.isfile(src_image):
                missing.append(temp_id)
                continue

            dst_image = os.path.join(staging_dir, f"{temp_id}.png")
            shutil.copy2(src_image, dst_image)

            if os.path.isfile(src_meta):
                shutil.copy2(src_meta, os.path.join(staging_dir, f"{temp_id}.json"))

            copied += 1

        if copied <= 0:
            return jsonify({"status": "error", "message": "선택한 임시 파일이 없습니다."}), 400

        use_classifier = bool(options.get("useClassifier", True))

        process_warning = ""

        if use_classifier:
            try:
                image_logic.process(
                    staging_dir,
                    method="move",
                    is_fast=False,
                    reorg_mode=False,
                    use_ai=bool(options.get("useAiNsfw", False)),
                    use_gpu=bool(options.get("useGpu", True)),
                    skip_nsfw=bool(options.get("ignoreNsfw", False)),
                    skip_char_id=bool(options.get("ignoreCharacter", False)),
                    log_func=lambda msg: print(f"[다키 갤러리 저장] {msg}")
                )
            except Exception as process_err:
                remaining_staged_images = count_image_files_in_dir(staging_dir)

                # image_logic.process는 파일 이동/DB 갱신을 처리하므로 staging 경로를 그대로 넘긴다.
                if remaining_staged_images < copied:
                    process_warning = f"갤러리 재분류 중 경고: {process_err}"
                    print(f"⚠️ [다키 갤러리 저장] {process_warning}")
                else:
                    raise
        else:
            for temp_id in clean_ids:
                src_image = daki_temp_image_path(temp_id)
                if not os.path.isfile(src_image):
                    continue

                meta = load_daki_generated_meta(temp_id)
                prompt_info = normalize_prompt_info_for_sidecar(meta)
                is_dakimakura = True
                target_dir = build_canvas_export_folder(
                    [] if options.get("ignoreCharacter") else detect_canvas_export_characters(prompt_info),
                    is_dakimakura
                )
                os.makedirs(target_dir, exist_ok=True)

                timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                filename = safe_folder_name(f"daki_{temp_id}_{timestamp}.png")
                if not filename.lower().endswith(".png"):
                    filename += ".png"

                target_path = os.path.join(target_dir, filename)
                shutil.copy2(src_image, target_path)
                save_prompt_sidecar(target_path, prompt_info)

        cleanup_errors = []

        if bool(options.get("deleteAfterSave", True)):
            for temp_id in clean_ids:
                _, errors = remove_daki_temp_assets(temp_id)
                cleanup_errors.extend(errors)

        return jsonify({
            "status": "success",
            "saved_count": copied,
            "missing": missing,
            "warning": process_warning,
            "cleanup_errors": cleanup_errors,
            "remaining": list_daki_generated_temp_images()
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

    finally:
        shutil.rmtree(staging_dir, ignore_errors=True)


def save_pil_image_preserve_extension(image, target_path):
    ext = os.path.splitext(target_path)[1].lower()

    if ext in (".jpg", ".jpeg"):
        image.convert("RGB").save(target_path, "JPEG", quality=95)
    elif ext == ".webp":
        image.convert("RGB").save(target_path, "WEBP", quality=95)
    else:
        image.save(target_path, "PNG")

def save_pil_image_with_prompt_metadata_preserve_extension(
    image,
    target_path,
    prompt_info,
    source_label="NAI Image Manager Gallery"
):
    ext = os.path.splitext(target_path)[1].lower()

    if ext in ("", ".png"):
        return save_png_with_prompt_metadata(
            image,
            target_path,
            prompt_info,
            source_label=source_label
        )

    save_pil_image_preserve_extension(image, target_path)
    return False

def save_gallery_prompt_sidecar(image_path, prompt_info):
    return save_prompt_sidecar(image_path, prompt_info)

@app.route('/api/gallery/overwrite_image', methods=['POST'])
def overwrite_gallery_image():
    try:
        data = request.json or {}

        source_image = data.get("source_image", "")
        target_path = str(data.get("target_path", "") or "").replace("\\", "/")
        prompt_info = data.get("promptInfo") or {}

        if not source_image or not target_path:
            return jsonify({"status": "error", "message": "필수 값이 없습니다."}), 400

        target_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, target_path, strip_prefix="TOTAL_CLASSIFIED/")
        os.makedirs(os.path.dirname(target_full_path), exist_ok=True)

        source_bytes = read_canvas_image_bytes(source_image)

        original_prompt_info = load_prompt_sidecar(target_full_path)

        if not original_prompt_info:
            try:
                original_prompt_info = extract_prompt_info_from_image(target_full_path)
            except Exception:
                original_prompt_info = {}

        final_prompt_info = prompt_info if has_prompt_info_text(prompt_info) else original_prompt_info
        target_ext = os.path.splitext(target_full_path)[1].lower() or ".png"
        temp_path = target_full_path + ".tmp" + target_ext

        with Image.open(io.BytesIO(source_bytes)) as img:
            img = img.convert("RGBA")
            embedded_metadata_saved = save_pil_image_with_prompt_metadata_preserve_extension(
                img,
                temp_path,
                final_prompt_info,
                source_label="NAI Image Manager Gallery Inpaint Overwrite"
            )
            os.replace(temp_path, target_full_path)

        sidecar_saved = save_prompt_sidecar(target_full_path, final_prompt_info)
        target_rel_path = os.path.relpath(target_full_path, CLASSIFIED_DIR).replace("\\", "/")
        sync_gallery_prompt_art_styles_for_path(target_rel_path, final_prompt_info)

        return jsonify({
            "status": "success",
            "path": target_rel_path,
            "sidecar_saved": sidecar_saved,
            "embedded_metadata_saved": embedded_metadata_saved
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route('/api/gallery/save_inpaint_as_new', methods=['POST'])
def save_gallery_inpaint_as_new():
    try:
        data = request.json or {}

        source_image = data.get("source_image", "")
        source_path = str(data.get("source_path", "") or "").replace("\\", "/")
        prompt_info = data.get("promptInfo") or {}

        if not source_image:
            return jsonify({"status": "error", "message": "이미지 데이터가 없습니다."}), 400

        source_bytes = read_canvas_image_bytes(source_image)

        if source_path:
            source_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, source_path, strip_prefix="TOTAL_CLASSIFIED/")
            target_dir = os.path.dirname(source_full_path)
            base_name = os.path.splitext(os.path.basename(source_full_path))[0]
        else:
            target_dir = OUTPUT_DIR
            base_name = "gallery_inpaint"

        os.makedirs(target_dir, exist_ok=True)

        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        target_full_path = os.path.join(target_dir, f"{base_name}_inpaint_{timestamp}.png")

        original_prompt_info = {}

        if source_path:
            try:
                source_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, source_path, strip_prefix="TOTAL_CLASSIFIED/")
                original_prompt_info = load_prompt_sidecar(source_full_path) or extract_prompt_info_from_image(source_full_path)
            except Exception:
                original_prompt_info = {}
        final_prompt_info = prompt_info if has_prompt_info_text(prompt_info) else original_prompt_info

        with Image.open(io.BytesIO(source_bytes)) as img:
            img = img.convert("RGBA")
            embedded_metadata_saved = save_png_with_prompt_metadata(
                img,
                target_full_path,
                final_prompt_info,
                source_label="NAI Image Manager Gallery Inpaint"
            )

        sidecar_saved = save_prompt_sidecar(target_full_path, final_prompt_info)
        target_rel_path = (
            os.path.relpath(target_full_path, CLASSIFIED_DIR).replace("\\", "/")
            if utils.is_subpath(target_full_path, CLASSIFIED_DIR)
            else target_full_path
        )
        if utils.is_subpath(target_full_path, CLASSIFIED_DIR):
            sync_gallery_prompt_art_styles_for_path(target_rel_path, final_prompt_info)

        return jsonify({
            "status": "success",
            "path": target_rel_path,
            "sidecar_saved": sidecar_saved,
            "embedded_metadata_saved": embedded_metadata_saved
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

def safe_folder_name(name):
    name = str(name or "").strip()
    name = re.sub(r'[<>:"/\\\\|?*]', '_', name)
    name = re.sub(r'\s+', '_', name)
    name = re.sub(r'_+', '_', name)
    return name.strip('._ ') or "No_Metadata"


def normalize_tag_text(value):
    return str(value or "").lower().replace("_", " ").strip()


def get_known_character_tags():
    db = None
    tags = []
    try:
        db = utils.HistoryDB()
        cursor = db.conn.cursor()
        cursor.execute("""
            SELECT tag, brand, brand_kr
            FROM known_characters
            WHERE tag IS NOT NULL AND tag != ''
        """)
        for tag, brand, brand_kr in cursor.fetchall():
            tag = str(tag or "").strip()
            if not tag:
                continue

            clean = re.sub(r'_(dakimakura|\\d+pcs)$', '', tag, flags=re.IGNORECASE)
            tags.append({
                "tag": tag,
                "clean": clean,
                "search": normalize_tag_text(clean),
                "brand": brand,
                "brand_kr": brand_kr
            })
    except Exception as e:
        print(f"⚠️ 캐릭터 태그 로드 실패: {e}")
    finally:
        if db:
            db.close()
    return tags


def normalize_canvas_export_character_token(value):
    text = str(value or "").strip()

    if not text:
        return ""

    text = text.replace("\\\\n", "\n").replace("\\n", "\n")
    text = re.sub(r'^[-+]?\d+(?:\.\d+)?::\s*', '', text).strip()
    text = re.sub(r'\s*::$', '', text).strip()
    text = re.sub(r':[0-9.]+$', '', text).strip()

    lowered = text.lower().strip()

    # artist/style/quality 계열은 캐릭터 판정에서 제외
    if lowered.startswith("artist:"):
        return ""

    if lowered.startswith("character:"):
        text = text.split(":", 1)[1].strip()

    while text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    while text.startswith("[") and text.endswith("]"):
        text = text[1:-1].strip()
    while text.startswith("{") and text.endswith("}"):
        text = text[1:-1].strip()

    text = text.replace("_", " ")
    text = re.sub(r"[{}()[\]]", " ", text)
    text = re.sub(r"\s+", " ", text).strip().lower()

    blocked = {
        "",
        "1girl",
        "1boy",
        "solo",
        "portrait",
        "standing",
        "sitting",
        "dakimakura",
        "body pillow",
        "pillow cover",
        "artist collaboration",
        "highres",
        "masterpiece",
        "best quality",
        "amazing quality",
        "very aesthetic"
    }

    if text in blocked:
        return ""

    return text


def iter_canvas_export_character_tokens(prompt_info):
    prompt_info = normalize_prompt_info_for_sidecar(prompt_info or {})

    raw_parts = []

    char_prompts = prompt_info.get("charPrompts") or []
    if isinstance(char_prompts, list):
        raw_parts.extend(str(item or "") for item in char_prompts if str(item or "").strip())

    char_prompt = str(prompt_info.get("charPrompt") or "").strip()
    if char_prompt:
        raw_parts.append(char_prompt)

    # charPrompt가 없는 예전 메타데이터만 basePrompt를 fallback으로 사용
    if not raw_parts:
        for key in ("basePrompt", "baseCaption", "prompt"):
            value = str(prompt_info.get(key) or "").strip()
            if value:
                raw_parts.append(value)

    tokens = set()

    for part in raw_parts:
        for token in re.split(r"[,;\n]+", str(part or "")):
            key = normalize_canvas_export_character_token(token)
            if key:
                tokens.add(key)

    return tokens


def detect_canvas_export_characters(prompt_info):
    token_keys = iter_canvas_export_character_tokens(prompt_info)

    if not token_keys:
        return []

    found = []

    for item in get_known_character_tags():
        keys = {
            normalize_canvas_export_character_token(item.get("clean", "")),
            normalize_canvas_export_character_token(item.get("tag", ""))
        }
        keys = {key for key in keys if key}

        if keys & token_keys:
            found.append(item)

    found.sort(key=lambda item: len(item.get("clean", "")), reverse=True)

    unique = []
    seen = set()

    for item in found:
        key = str(item.get("clean", "")).lower()
        if not key or key in seen:
            continue

        seen.add(key)
        unique.append(item)

    return unique

def build_canvas_export_folder(chars, is_dakimakura):
    if not chars:
        if is_dakimakura:
            return os.path.join(CLASSIFIED_DIR, "No_Metadata", "dakimakura")
        return os.path.join(CLASSIFIED_DIR, "No_Metadata")

    if len(chars) == 1:
        folder = safe_folder_name(chars[0]["clean"])
        if is_dakimakura:
            folder = f"{folder}_dakimakura"
        return os.path.join(CLASSIFIED_DIR, "1_Solo", folder)

    if len(chars) == 2:
        names = [safe_folder_name(c["clean"]) for c in chars[:2]]
        folder = "_and_".join(names)
        if is_dakimakura:
            folder = f"{folder}_dakimakura"
        return os.path.join(CLASSIFIED_DIR, "2_Duo", folder)

    names = [safe_folder_name(c["clean"]) for c in chars[:4]]
    folder = "_and_".join(names)
    if is_dakimakura:
        folder = f"{folder}_dakimakura"
    return os.path.join(CLASSIFIED_DIR, "3_Group", folder)


def decode_canvas_data_url(data_url):
    data_url = str(data_url or "")

    if "," in data_url:
        _, encoded = data_url.split(",", 1)
    else:
        encoded = data_url

    raw = base64.b64decode(encoded)
    return Image.open(io.BytesIO(raw)).convert("RGBA")

@app.route('/api/canvas/export_merged', methods=['POST'])
def export_merged_canvas():
    try:
        data = request.json or {}

        image_data = data.get("image", "")
        prompt_info = data.get("promptInfo") or {}
        width = int(data.get("width") or 0)
        height = int(data.get("height") or 0)
        is_dakimakura = bool(data.get("isDakimakura"))

        if not image_data:
            return jsonify({"status": "error", "message": "이미지 데이터가 없습니다."}), 400

        # 서버에서도 다키마쿠라 비율 한 번 더 확인
        if width > 0 and height > 0:
            ratio = width / height
            if abs(ratio - (5 / 16)) < 0.035:
                is_dakimakura = True

        prompt_text = " ".join([
            str(prompt_info.get("basePrompt", "")),
            str(prompt_info.get("charPrompt", "")),
        ]).lower()

        if "dakimakura" in prompt_text or "body pillow" in prompt_text or "pillow cover" in prompt_text:
            is_dakimakura = True

        chars = detect_canvas_export_characters(prompt_info)
        target_dir = build_canvas_export_folder(chars, is_dakimakura)
        os.makedirs(target_dir, exist_ok=True)

        img = decode_canvas_data_url(image_data)

        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        char_part = "No_Metadata"
        if chars:
            char_part = "_and_".join([safe_folder_name(c["clean"]) for c in chars[:3]])

        daki_part = "_dakimakura" if is_dakimakura else ""
        filename = f"canvas_{char_part}{daki_part}_{timestamp}.png"
        filename = safe_folder_name(filename)
        if not filename.lower().endswith(".png"):
            filename += ".png"

        save_path = os.path.join(target_dir, filename)

        final_prompt_info = normalize_prompt_info_for_sidecar(prompt_info)
        embedded_metadata_saved = save_png_with_prompt_metadata(
            img,
            save_path,
            final_prompt_info,
            source_label="NAI Image Manager Canvas Export"
        )
        sidecar_saved = save_prompt_sidecar(save_path, final_prompt_info)

        rel_path = os.path.relpath(save_path, CLASSIFIED_DIR).replace("\\", "/")

        if has_prompt_info_text(final_prompt_info):
            sync_gallery_prompt_art_styles_for_path(rel_path, final_prompt_info)

        return jsonify({
            "status": "success",
            "path": rel_path,
            "src": "/image/" + quote(rel_path),
            "sidecar_saved": sidecar_saved,
            "embedded_metadata_saved": embedded_metadata_saved,
            "characters": [c["clean"] for c in chars],
            "isDakimakura": is_dakimakura
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/style-lab')
def style_lab():
    return send_file('style_lab.html')

@app.route('/daki-workshop')
def daki_workshop():
    return send_file('daki_workshop.html')

@app.route('/canvas')
def canvas_page():
    return send_file('canvas.html')

def _load_tag_category_file(path, dictionary):
    if not os.path.exists(path):
        return
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except Exception as e:
        print(f"⚠️ 태그 분류 파일 로드 실패: {path} | {e}")
        return

    for group, entries in (data or {}).items():
        if isinstance(entries, dict):
            iterable = []
            for tag, value in entries.items():
                if isinstance(value, dict):
                    item = dict(value)
                    item.setdefault("tag", tag)
                    iterable.append(item)
                else:
                    iterable.append({"tag": tag, "ko": str(value or "")})
        elif isinstance(entries, list):
            iterable = entries
        else:
            continue

        for item in iterable:
            if not isinstance(item, dict):
                continue
            tag = str(item.get("tag", "")).strip()
            if not tag:
                continue
            key = tag.lower().replace(" ", "_")
            ko = str(item.get("ko", "") or "").strip()
            current = dictionary.get(key, {"tag": tag})
            current.update({
                "tag": tag,
                "ko": ko or current.get("ko", ""),
                "group": group,
                "group_ko": TAG_GROUP_LABELS.get(group, group),
                "color": TAG_GROUP_COLORS.get(group, current.get("color", "#64748b")),
            })
            dictionary[key] = current


def build_tag_dictionary():
    dictionary = {}
    _load_tag_category_file(TAG_CATEGORY_FILE, dictionary)
    _load_tag_category_file(TAG_CATEGORY_OVERRIDE_FILE, dictionary)

    if os.path.exists(TAG_DB_FILE):
        try:
            conn = sqlite3.connect(TAG_DB_FILE)
            cursor = conn.cursor()
            cursor.execute("""
                SELECT name, ko, app_group, category
                FROM danbooru_tags
            """)
            for name, ko, app_group, category in cursor.fetchall():
                tag = str(name or "").strip()
                if not tag:
                    continue
                key = tag.lower().replace(" ", "_")
                group = str(app_group or dictionary.get(key, {}).get("group", "") or "").strip()
                try:
                    category = int(category)
                except (TypeError, ValueError):
                    category = 0
                current = dictionary.get(key, {"tag": tag})
                has_group_color = bool(current.get("group"))
                current.update({
                    "tag": tag,
                    "ko": str(ko or current.get("ko", "") or "").strip(),
                    "group": group,
                    "group_ko": TAG_GROUP_LABELS.get(group, group),
                    "category": category,
                    "category_ko": DANBOORU_CATEGORY_LABELS.get(category, "기타"),
                    "color": current.get("color") if has_group_color else DANBOORU_CATEGORY_COLORS.get(category, "#64748b"),
                })
                dictionary[key] = current
        except Exception as e:
            print(f"⚠️ 태그 DB 로드 실패: {e}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
    merge_user_app_tag_overrides_into_dictionary(dictionary)
    return dictionary


def _tag_response_item(tag, ko="", group="", category=0, post_count=0):
    try:
        category = int(category)
    except (TypeError, ValueError):
        category = 0
    group = str(group or "").strip()
    return {
        "tag": str(tag or "").strip(),
        "ko": str(ko or "").strip(),
        "group": group,
        "group_ko": TAG_GROUP_LABELS.get(group, group),
        "category": category,
        "category_ko": DANBOORU_CATEGORY_LABELS.get(category, "기타"),
        "post_count": int(post_count or 0),
        "color": TAG_GROUP_COLORS.get(group, DANBOORU_CATEGORY_COLORS.get(category, "#64748b")),
    }


def load_tag_dictionary_override():
    if not os.path.exists(TAG_CATEGORY_OVERRIDE_FILE):
        return {}
    try:
        with open(TAG_CATEGORY_OVERRIDE_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_tag_dictionary_override(tag, ko, group):
    tag = str(tag or "").strip()
    ko = str(ko or "").strip()
    group = str(group or "").strip() or "custom"
    if not tag:
        raise ValueError("태그 이름이 없습니다.")

    data = load_tag_dictionary_override()
    for group_name, entries in list(data.items()):
        if isinstance(entries, dict):
            entries.pop(tag, None)
        elif isinstance(entries, list):
            data[group_name] = [
                item for item in entries
                if not (isinstance(item, dict) and str(item.get("tag", "")).strip() == tag)
            ]

    if group not in data or not isinstance(data[group], dict):
        data[group] = {}
    data[group][tag] = {"tag": tag, "ko": ko}

    with open(TAG_CATEGORY_OVERRIDE_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.route('/api/tag_dictionary', methods=['GET'])
def tag_dictionary():
    return jsonify({"tags": build_tag_dictionary(), "groups": TAG_GROUP_LABELS})


@app.route('/api/tag_dictionary/search', methods=['GET'])
def search_tag_dictionary():
    query = request.args.get('q', '').strip()
    try:
        limit = min(max(int(request.args.get('limit', 60)), 1), 120)
    except ValueError:
        limit = 60

    if not query:
        return jsonify({"items": [], "groups": TAG_GROUP_LABELS})
    if not os.path.exists(TAG_DB_FILE):
        return jsonify({"items": [], "groups": TAG_GROUP_LABELS})

    dictionary = build_tag_dictionary()
    like = f"%{query.lower().replace(' ', '_')}%"
    items = []
    conn = None
    try:
        conn = sqlite3.connect(TAG_DB_FILE)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT name, ko, app_group, category, post_count
            FROM danbooru_tags
            WHERE lower(name) LIKE ? OR lower(replace(name, '_', ' ')) LIKE ? OR lower(COALESCE(ko, '')) LIKE ?
            ORDER BY post_count DESC, name ASC
            LIMIT ?
        """, (like, f"%{query.lower()}%", f"%{query.lower()}%", limit))
        for name, ko, app_group, category, post_count in cursor.fetchall():
            key = str(name or "").lower().replace(" ", "_")
            override = dictionary.get(key, {})
            items.append(_tag_response_item(
                name,
                override.get("ko") or ko,
                override.get("group") or app_group,
                category,
                post_count
            ))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if conn:
            conn.close()

    return jsonify({"items": items, "groups": TAG_GROUP_LABELS})

def load_app_tag_category_tree():
    """
    tag_categories_ko.generated.json + tag_categories_ko.json을
    DB의 app_group 트리를 우선 사용하고, 없으면 JSON 번역 사전으로 보강한다.
    """
    tree = {}
    by_key = {}

    def normalize_key(tag):
        return str(tag or "").strip().lower().replace(" ", "_")

    def ingest_file(path):
        if not os.path.exists(path):
            return

        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"⚠️ 태그 분류 파일 로드 실패: {path} | {e}")
            return

        if not isinstance(data, dict):
            return

        for group, entries in data.items():
            group = str(group or "").strip()
            if not group:
                continue

            if isinstance(entries, dict):
                iterable = []
                for tag, value in entries.items():
                    if isinstance(value, dict):
                        item = dict(value)
                        item.setdefault("tag", tag)
                    else:
                        item = {"tag": tag, "ko": str(value or "")}
                    iterable.append(item)
            elif isinstance(entries, list):
                iterable = entries
            else:
                continue

            for item in iterable:
                if not isinstance(item, dict):
                    continue

                tag = str(item.get("tag", "")).strip()
                if not tag:
                    continue

                key = normalize_key(tag)

                old = by_key.get(key, {})
                old_group = old.get("group")
                if old_group and old_group in tree:
                    tree[old_group] = [x for x in tree[old_group] if x.get("_key") != key]

                merged = dict(old)
                merged.update({
                    "_key": key,
                    "tag": tag,
                    "ko": str(item.get("ko", merged.get("ko", "")) or "").strip(),
                    "group": group,
                    "group_ko": TAG_GROUP_LABELS.get(group, group),
                    "category": int(item.get("category", merged.get("category", 0)) or 0),
                    "category_ko": DANBOORU_CATEGORY_LABELS.get(
                        int(item.get("category", merged.get("category", 0)) or 0),
                        "기타"
                    ),
                    "post_count": int(item.get("post_count", merged.get("post_count", 0)) or 0),
                    "review": item.get("review", merged.get("review", False)),
                    "color": TAG_GROUP_COLORS.get(group, "#64748b"),
                })

                by_key[key] = merged
                tree.setdefault(group, []).append(merged)

    ingest_file(TAG_CATEGORY_FILE)
    ingest_file(TAG_CATEGORY_OVERRIDE_FILE)

    merge_user_app_tag_overrides_into_tree(tree, by_key)

    for group in tree:
        tree[group].sort(key=lambda x: (-int(x.get("post_count", 0) or 0), x.get("tag", "")))

    return tree

def get_app_group_color(group_key):
    return TAG_GROUP_COLORS.get(group_key, "#64748b")


def get_app_group_label(group_key):
    return TAG_GROUP_LABELS.get(group_key, group_key)


def build_app_group_cards(app_tree):
    groups = []
    seen = set()

    # 기존 고정 앱 분류는 항상 먼저 표시
    for key, label in TAG_GROUP_LABELS.items():
        seen.add(key)
        groups.append({
            "type": "app_group",
            "value": key,
            "label": label,
            "count": len(app_tree.get(key, [])),
            "color": get_app_group_color(key),
        })

    # 사용자가 새로 만든 앱 분류 추가
    extra_keys = sorted(
        key for key, items in app_tree.items()
        if key not in seen and len(items) > 0
    )

    for key in extra_keys:
        groups.append({
            "type": "app_group",
            "value": key,
            "label": get_app_group_label(key),
            "count": len(app_tree.get(key, [])),
            "color": get_app_group_color(key),
        })

    return groups

def app_tag_to_response(item):
    return _tag_response_item(
        item.get("tag", ""),
        item.get("ko", ""),
        item.get("group", ""),
        item.get("category", 0),
        item.get("post_count", 0)
    )


def db_has_table(cursor, table_name):
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", (table_name,))
    return cursor.fetchone() is not None

def get_danbooru_category_count(category):
    """
    Danbooru 카테고리별 전체 태그 수를 계산한다.
    """
    category = int(category)

    # 일반 태그는 앱 분류 JSON 기준으로 계산
    if category == 0:
        app_tree = load_app_tag_category_tree()
        seen = set()
        for items in app_tree.values():
            for item in items:
                tag = str(item.get("tag", "")).strip().lower()
                if tag:
                    seen.add(tag)
        return len(seen)

    if not os.path.exists(TAG_DB_FILE):
        return 0

    conn = None
    try:
        conn = sqlite3.connect(TAG_DB_FILE)
        cursor = conn.cursor()

        # 정규화된 data/danbooru_tags.sqlite3 구조
        if db_has_table(cursor, "danbooru_tags"):
            cursor.execute(
                "SELECT COUNT(*) FROM danbooru_tags WHERE category = ?",
                (category,)
            )
            return int(cursor.fetchone()[0] or 0)

        # 루트 danbooru_tags.db 구조 대응
        if category == 4 and db_has_table(cursor, "characters"):
            cursor.execute("SELECT COUNT(*) FROM characters")
            return int(cursor.fetchone()[0] or 0)

        if category == 3 and db_has_table(cursor, "copyrights"):
            cursor.execute("SELECT COUNT(*) FROM copyrights")
            return int(cursor.fetchone()[0] or 0)

        return 0

    except Exception as e:
        print(f"⚠️ Danbooru 카테고리 카운트 실패: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def get_danbooru_bucket_count(category, bucket):
    """
    Danbooru 상세 분류 카드의 태그 수를 계산한다.
    예: A-C, D-F, 기타 범위
    """
    category = int(category)
    bucket = bucket or "all"

    if not os.path.exists(TAG_DB_FILE):
        return 0

    conn = None
    try:
        conn = sqlite3.connect(TAG_DB_FILE)
        cursor = conn.cursor()

        sql_extra, sql_params = build_category_bucket_sql(bucket)

        if db_has_table(cursor, "danbooru_tags"):
            cursor.execute(f"""
                SELECT COUNT(*)
                FROM danbooru_tags
                WHERE category = ?
                {sql_extra}
            """, [category] + sql_params)
            return int(cursor.fetchone()[0] or 0)

        if category == 4 and db_has_table(cursor, "characters"):
            cursor.execute(f"""
                SELECT COUNT(*)
                FROM characters
                WHERE 1 = 1
                {sql_extra}
            """, sql_params)
            return int(cursor.fetchone()[0] or 0)

        if category == 3 and db_has_table(cursor, "copyrights"):
            cursor.execute(f"""
                SELECT COUNT(*)
                FROM copyrights
                WHERE 1 = 1
                {sql_extra}
            """, sql_params)
            return int(cursor.fetchone()[0] or 0)

        return 0

    except Exception as e:
        print(f"⚠️ Danbooru 버킷 카운트 실패: {e}")
        return 0
    finally:
        if conn:
            conn.close()


def category_detail_groups(category):
    category = int(category)
    label = DANBOORU_CATEGORY_LABELS.get(category, "기타")
    color = DANBOORU_CATEGORY_COLORS.get(category, "#64748b")

    # 앱 태그 사전을 JSON 번역 데이터와 병합해 브라우징용 트리로 만든다.
    if category == 0:
        app_tree = load_app_tag_category_tree()
        groups = build_app_group_cards(app_tree)

        groups.append({
            "type": "category_all",
            "value": "0",
            "label": "일반 전체",
            "count": 0,
            "color": color,
        })

        return groups

    # 일반/작가/저작권/캐릭터/메타 카테고리를 Danbooru DB 기준으로 집계한다.
    buckets = [
        ("all", f"{label} 인기순 전체"),
        ("num", "숫자/기호"),
        ("a-c", "A-C"),
        ("d-f", "D-F"),
        ("g-i", "G-I"),
        ("j-l", "J-L"),
        ("m-o", "M-O"),
        ("p-r", "P-R"),
        ("s-u", "S-U"),
        ("v-z", "V-Z"),
    ]

    return [
        {
            "type": "category_bucket",
            "value": str(category),
            "bucket": bucket,
            "label": bucket_label,
            "count": get_danbooru_bucket_count(category, bucket),
            "color": color,
        }
        for bucket, bucket_label in buckets
    ]


def build_category_bucket_sql(bucket):
    if bucket == "all":
        return "", []

    if bucket == "num":
        return " AND lower(substr(name, 1, 1)) NOT BETWEEN 'a' AND 'z' ", []

    ranges = {
        "a-c": ("a", "c"),
        "d-f": ("d", "f"),
        "g-i": ("g", "i"),
        "j-l": ("j", "l"),
        "m-o": ("m", "o"),
        "p-r": ("p", "r"),
        "s-u": ("s", "u"),
        "v-z": ("v", "z"),
    }

    if bucket in ranges:
        start, end = ranges[bucket]
        return " AND lower(substr(name, 1, 1)) BETWEEN ? AND ? ", [start, end]

    return "", []


@app.route('/api/tag_dictionary/groups', methods=['GET'])
def tag_dictionary_groups():
    app_tree = load_app_tag_category_tree()

    app_groups = build_app_group_cards(app_tree)

    danbooru_categories = []
    for key, label in DANBOORU_CATEGORY_LABELS.items():
        danbooru_categories.append({
            "type": "category",
            "value": str(key),
            "label": label,
            "count": get_danbooru_category_count(key),
            "color": DANBOORU_CATEGORY_COLORS.get(key, "#64748b"),
        })

    return jsonify({
        "app_groups": app_groups,
        "danbooru_categories": danbooru_categories,
    })


@app.route('/api/tag_dictionary/browse', methods=['GET'])
def browse_tag_dictionary():
    browse_type = request.args.get("type", "").strip()
    value = request.args.get("value", "").strip()
    bucket = request.args.get("bucket", "all").strip() or "all"

    try:
        limit = min(max(int(request.args.get("limit", 120)), 1), 300)
    except ValueError:
        limit = 120

    try:
        offset = max(int(request.args.get("offset", 0)), 0)
    except ValueError:
        offset = 0

    # 1) 앱 번역 JSON 기반 태그 조회
    if browse_type == "app_group":
        app_tree = load_app_tag_category_tree()
        items = [app_tag_to_response(item) for item in app_tree.get(value, [])]
    # 2) Danbooru DB에서 카테고리별 인기 태그를 조회
    if browse_type == "category":
        try:
            category = int(value)
        except ValueError:
            category = 0

        return jsonify({
            "mode": "groups",
            "label": DANBOORU_CATEGORY_LABELS.get(category, "기타"),
            "groups": category_detail_groups(category),
        })

    # 3) Danbooru 브라우징 결과를 응답 형식으로 변환
    if browse_type in {"category_all", "category_bucket"}:
        if not os.path.exists(TAG_DB_FILE):
            return jsonify({
                "mode": "items",
                "items": [],
                "type": browse_type,
                "value": value,
                "bucket": bucket,
                "has_more": False,
            })

        try:
            category = int(value)
        except ValueError:
            category = 0

        sql_extra, sql_params = build_category_bucket_sql(bucket)
        dictionary = build_tag_dictionary()
        items = []
        conn = None

        try:
            conn = sqlite3.connect(TAG_DB_FILE)
            cursor = conn.cursor()

            # 현재 프로젝트의 정규화된 태그 DB 구조
            if db_has_table(cursor, "danbooru_tags"):
                cursor.execute(f"""
                    SELECT name, ko, app_group, category, post_count
                    FROM danbooru_tags
                    WHERE category = ?
                    {sql_extra}
                    ORDER BY post_count DESC, name ASC
                    LIMIT ? OFFSET ?
                """, [category] + sql_params + [limit, offset])

                for name, ko, app_group, category_value, post_count in cursor.fetchall():
                    key = str(name or "").lower().replace(" ", "_")
                    override = dictionary.get(key, {})
                    items.append(_tag_response_item(
                        name,
                        override.get("ko") or ko,
                        override.get("group") or app_group,
                        category_value,
                        post_count
                    ))

            # 기존 danbooru_tags.db에 characters/copyrights 테이블이 있으면 함께 검색
            elif category == 4 and db_has_table(cursor, "characters"):
                cursor.execute(f"""
                    SELECT name, post_count
                    FROM characters
                    WHERE 1 = 1
                    {sql_extra}
                    ORDER BY post_count DESC, name ASC
                    LIMIT ? OFFSET ?
                """, sql_params + [limit, offset])

                for name, post_count in cursor.fetchall():
                    key = str(name or "").lower().replace(" ", "_")
                    override = dictionary.get(key, {})
                    items.append(_tag_response_item(
                        name,
                        override.get("ko", ""),
                        override.get("group", ""),
                        4,
                        post_count
                    ))

            elif category == 3 and db_has_table(cursor, "copyrights"):
                cursor.execute(f"""
                    SELECT name, post_count
                    FROM copyrights
                    WHERE 1 = 1
                    {sql_extra}
                    ORDER BY post_count DESC, name ASC
                    LIMIT ? OFFSET ?
                """, sql_params + [limit, offset])

                for name, post_count in cursor.fetchall():
                    key = str(name or "").lower().replace(" ", "_")
                    override = dictionary.get(key, {})
                    items.append(_tag_response_item(
                        name,
                        override.get("ko", ""),
                        override.get("group", ""),
                        3,
                        post_count
                    ))

        except Exception as e:
            return jsonify({"error": str(e)}), 500
        finally:
            if conn:
                conn.close()

        return jsonify({
            "mode": "items",
            "items": items,
            "type": browse_type,
            "value": value,
            "bucket": bucket,
            "limit": limit,
            "offset": offset,
            "next_offset": offset + len(items),
            "has_more": len(items) == limit,
        })

    return jsonify({"error": "분류 타입이 올바르지 않습니다."}), 400

@app.route('/api/tag_dictionary/override', methods=['POST'])
def update_tag_dictionary_override():
    data = request.json or {}
    tag = data.get("tag", "")
    ko = data.get("ko", "")
    group = data.get("group", "")
    try:
        save_tag_dictionary_override(tag, ko, group)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"status": "success"})

@app.route('/api/extract_metadata', methods=['POST'])
def extract_metadata():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    file = request.files['file']
    if not file or not file.filename:
        return jsonify({'error': 'Empty file'}), 400
    
    try:
        file_data = file.read()
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(file_data))
        
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
                    user_comment = exif[37510]
                    if isinstance(user_comment, bytes):
                        raw_meta = user_comment.decode('utf-8', errors='ignore').replace('\x00', '')
                        if raw_meta.startswith('UNICODE') or raw_meta.startswith('ASCII'):
                            raw_meta = raw_meta[8:]
                    else:
                        raw_meta = str(user_comment)
        
        if not raw_meta:
            # Fallback brute-force text scan over file bytes
            text_data = file_data.decode('utf-8', errors='ignore')
            import re
            json_match = re.search(r'"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"', text_data)
            if json_match:
                prompt_text = json_match.group(1).replace('\\"', '"').replace('\\\\', '\\')
                if 'artist:' in prompt_text:
                    raw_meta = prompt_text
            else:
                tags_match = re.findall(r'([0-9.]+::artist:[^:]+::)', text_data)
                if tags_match:
                    raw_meta = ", ".join(tags_match)
        
        return jsonify({'prompt': raw_meta or ""})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def load_lab_config_data():
    if not os.path.exists(CONFIG_FILE):
        return {}

    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_lab_config_data(data):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(data if isinstance(data, dict) else {}, f, ensure_ascii=False, indent=4)


def normalize_shared_prompt_groups(groups):
    normalized = []

    if not isinstance(groups, list):
        return normalized

    for group in groups:
        if not isinstance(group, dict):
            continue

        name = str(group.get("name") or "").strip()
        prompts = group.get("prompts") or []

        if not name or not isinstance(prompts, list):
            continue

        clean_prompts = [
            str(prompt or "").strip()
            for prompt in prompts
            if str(prompt or "").strip()
        ]

        if not clean_prompts:
            continue

        raw_tags = group.get("tags", [])
        if isinstance(raw_tags, str):
            raw_tags = re.split(r"[,#\n]+", raw_tags)
        if not isinstance(raw_tags, list):
            raw_tags = []

        clean_tags = []
        for tag in raw_tags:
            tag = str(tag or "").strip().lstrip("#")
            if tag and tag not in clean_tags:
                clean_tags.append(tag)

        # 프롬프트 그룹 정규화: 잘못된 collapsed 값은 기본값으로 보정
        collapsed_raw = group.get("collapsed", True)
        if isinstance(collapsed_raw, str):
            collapsed = collapsed_raw.lower() in ("1", "true", "yes", "on")
        else:
            collapsed = bool(collapsed_raw)

        normalized.append({
            "name": name,
            "prompts": clean_prompts,
            "tags": clean_tags,
            "collapsed": collapsed
        })

    merged = {}
    order = []

    for group in normalized:
        name = group["name"]
        if name not in merged:
            order.append(name)
        merged[name] = group

    return [merged[name] for name in order]


def get_shared_prompt_groups_from_config(config):
    merged = {}
    order = []

    for key in (
        "shared_prompt_groups",
        "daki_prompt_groups",
        "clip_prompt_groups",
        "prompt_groups"
    ):
        groups = normalize_shared_prompt_groups(config.get(key))

        for group in groups:
            name = group["name"]
            if name not in merged:
                order.append(name)
            merged[name] = group

    return [merged[name] for name in order]


@app.route('/api/shared_prompt_groups', methods=['GET', 'POST'])
def shared_prompt_groups():
    config = load_lab_config_data()

    if request.method == 'GET':
        groups = get_shared_prompt_groups_from_config(config)

        return jsonify({
            "status": "success",
            "groups": groups
        })

    data = request.json or {}
    groups = normalize_shared_prompt_groups(data.get("groups") or [])

    config["shared_prompt_groups"] = groups

    # 프롬프트 그룹 설정을 저장
    config["daki_prompt_groups"] = groups

    # 다키 프롬프트 그룹 설정을 저장
    config["clip_prompt_groups"] = groups

    save_lab_config_data(config)

    return jsonify({
        "status": "success",
        "groups": groups
    })


@app.route('/api/lab/config', methods=['GET', 'POST'])
def handle_lab_config():
    if request.method == 'GET':
        return jsonify(load_lab_config_data())

    existing_data = load_lab_config_data()
    incoming = request.json or {}

    existing_data.update(incoming)
    save_lab_config_data(existing_data)

    return jsonify({"status": "success"})

@app.route('/api/artists', methods=['GET', 'POST'])
def handle_artists():
    if request.method == 'GET':
        if os.path.exists(ARTISTS_FILE):
            with open(ARTISTS_FILE, 'r', encoding='utf-8') as f: return jsonify(json.load(f))
        return jsonify({})
    else:
        with open(ARTISTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(request.json, f, ensure_ascii=False, indent=4)
        return jsonify({"status": "success"})

@app.route('/api/styles', methods=['GET', 'POST', 'DELETE'])
def handle_styles():
    if request.method == 'GET':
        if os.path.exists(STYLES_FILE):
            with open(STYLES_FILE, 'r', encoding='utf-8') as f: return jsonify(json.load(f))
        return jsonify({})
        
    elif request.method == 'POST':
        data = request.json
        styles_data = {}
        if os.path.exists(STYLES_FILE):
            with open(STYLES_FILE, 'r', encoding='utf-8') as f: styles_data = json.load(f)
        styles_data[data["name"]] = data["prompt"]
        with open(STYLES_FILE, 'w', encoding='utf-8') as f:
            json.dump(styles_data, f, ensure_ascii=False, indent=4)
        return jsonify({"status": "success"})
        
    elif request.method == 'DELETE':
        data = request.json
        style_name = data.get("name")
        
        # 1. styles.json에서 삭제
        styles_data = {}
        if os.path.exists(STYLES_FILE):
            with open(STYLES_FILE, 'r', encoding='utf-8') as f: styles_data = json.load(f)
            
        if style_name in styles_data:
            del styles_data[style_name]
            with open(STYLES_FILE, 'w', encoding='utf-8') as f:
                json.dump(styles_data, f, ensure_ascii=False, indent=4)
        
        # 2. artists.json에서 동일한 이름의 그룹 함께 삭제
        artists_data = {}
        if os.path.exists(ARTISTS_FILE):
            with open(ARTISTS_FILE, 'r', encoding='utf-8') as f: artists_data = json.load(f)
            
        if style_name in artists_data:
            del artists_data[style_name]
            with open(ARTISTS_FILE, 'w', encoding='utf-8') as f:
                json.dump(artists_data, f, ensure_ascii=False, indent=4)
                
        return jsonify({"status": "success"})



# 🚀 [핵심] NovelAI 이미지 생성 API
@app.route('/api/generate', methods=['POST'])
def api_generate():
    data = request.json
    api_key = data.get('key')
    if not api_key:
        return jsonify({"error": "API Key가 없습니다."}), 400

    req = urllib.request.Request("https://image.novelai.net/ai/generate-image", method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "Mozilla/5.0")

    base_prompt = data.get('base_prompt', '')
    safe_seed = random.randint(1, 4294967295)

    char_prompts = normalize_char_prompts(data)

    char_captions_list = []
    for char_prompt in char_prompts:
        char_captions_list.append({
            "char_caption": char_prompt,
            "centers": [{"x": 0.5, "y": 0.5}]
        })

    # NovelAI V4.5 Full 모델 규격에 맞춘 페이로드
    payload = {
        "input": base_prompt,
        "model": "nai-diffusion-4-5-full",
        "action": "generate",
        "parameters": {
            "width": data.get("width"),
            "height": data.get("height"),
            "n_samples": 1,
            "seed": safe_seed,
            "extra_noise_seed": safe_seed,
            "sampler": data.get("sampler", "k_euler_ancestral"),
            "steps": data.get("steps", 28),
            "scale": data.get("scale", 5.0),
            "negative_prompt": data.get("negative_prompt", ""),
            "cfg_rescale": data.get("cfg_rescale", 0.4),
            "noise_schedule": "native",
            "params_version": 3,
            "legacy": False,
            "legacy_v3_extend": False,
            "add_original_image": True,
            "prefer_brownian": True,
            "use_coords": False,
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": data.get("negative_prompt", ""),
                    "char_captions": []
                },
                "legacy_uc": False
            },
            "v4_prompt": {
                "caption": {
                    "base_caption": base_prompt,
                    "char_captions": char_captions_list
                },
                "use_coords": False,
                "use_order": True
            }
        }
    }

    try:
        with urllib.request.urlopen(req, data=json.dumps(payload).encode('utf-8')) as response:
            zip_data = response.read()
            with zipfile.ZipFile(io.BytesIO(zip_data)) as z:
                for filename in z.namelist():
                    if filename.endswith('.png'):
                        img_data = z.read(filename)
                        b64_img = base64.b64encode(img_data).decode('utf-8')
                        response_data = {"image": f"data:image/png;base64,{b64_img}"}

                        if data.get("persist_temp"):
                            prompt_info = build_daki_prompt_info_from_request(data)
                            temp_item = save_daki_generated_temp_image(img_data, prompt_info)
                            response_data.update({
                                "temp_id": temp_item["id"],
                                "temp_src": temp_item["src"],
                                "name": temp_item["name"],
                                "prompt": temp_item["prompt"]
                            })

                        return jsonify(response_data)
            return jsonify({"error": "압축 파일에서 이미지를 찾을 수 없습니다."}), 500
    except urllib.error.HTTPError as e:
        error_body = e.read().decode('utf-8')
        return jsonify({"error": f"NovelAI 서버 에러(HTTP {e.code}): {error_body}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 💎 Anlas 잔액 조회 API
@app.route('/api/anlas', methods=['GET'])
def api_anlas():
    api_key = request.args.get('key', '').strip()
    if not api_key: return jsonify({"error": "No API Key"}), 400
    req = urllib.request.Request("https://api.novelai.net/user/subscription", method="GET")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("User-Agent", "Mozilla/5.0")
    try:
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode('utf-8'))
            t_steps = data.get('trainingStepsLeft', {})
            return jsonify({"anlas": int(t_steps.get('fixedTrainingStepsLeft', 0)) + int(t_steps.get('purchasedTrainingSteps', 0))})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# 💾 로컬 저장 API
@app.route('/api/save', methods=['POST'])
def api_save():
    data = request.json
    img_data = data.get("image", "")
    if "base64," in img_data:
        img_data = img_data.split(",")[1]
    
    img_bytes = base64.b64decode(img_data)
    import datetime
    ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    fname, jname = f"daki_{ts}.png", f"daki_{ts}.json"
    
    with open(os.path.join(OUTPUT_DIR, fname), 'wb') as f:
        f.write(img_bytes)
        
    with open(os.path.join(OUTPUT_DIR, jname), 'w', encoding='utf-8') as jf:
        char_prompts = normalize_char_prompts(data)

        json.dump({
            "api_key": data.get("key"),
            "base_prompt": data.get("base_prompt"),
            "char_prompt": data.get("char_prompt"),
            "char_prompts": char_prompts,
            "negative_prompt": data.get("negative_prompt")
        }, jf, ensure_ascii=False, indent=4)
        
    return jsonify({"status": "saved", "path": os.path.join(OUTPUT_DIR, fname)})


@app.route('/api/lab/quality_presets', methods=['GET', 'POST'])
def handle_quality_presets():
    if request.method == 'GET':
        if os.path.exists(QUALITY_PRESETS_FILE):
            with open(QUALITY_PRESETS_FILE, 'r', encoding='utf-8') as f:
                return jsonify(json.load(f))
        return jsonify({}) # 파일 없으면 빈 객체 반환
    else:
        # POST: 앱 번역 사전 저장
        with open(QUALITY_PRESETS_FILE, 'w', encoding='utf-8') as f:
            json.dump(request.json, f, ensure_ascii=False, indent=4)
        return jsonify({"status": "success"})
    
def load_tag_dictionary_user_overrides():
    if not os.path.exists(TAG_DICTIONARY_USER_OVERRIDES):
        return {"app": {}}

    try:
        with open(TAG_DICTIONARY_USER_OVERRIDES, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if not isinstance(data, dict):
                return {"app": {}}
            if "app" not in data or not isinstance(data["app"], dict):
                data["app"] = {}
            return data
    except Exception as e:
        print(f"⚠️ 사용자 태그 번역 로드 실패: {e}")
        return {"app": {}}

def normalize_tag_key(tag):
    return str(tag or "").strip().lower().replace(" ", "_")


def normalize_app_group_key(category_name):
    name = str(category_name or "").strip()

    if not name:
        return "custom"

    ko_to_key = {v: k for k, v in TAG_GROUP_LABELS.items()}

    if name in TAG_GROUP_LABELS:
        return name

    if name in ko_to_key:
        return ko_to_key[name]

    if name in ("기타", "커스텀", "사용자 정의"):
        return "custom"

    return name

def merge_user_app_tag_overrides_into_dictionary(dictionary):
    overrides = load_tag_dictionary_user_overrides().get("app", {})

    for tag, info in overrides.items():
        tag = str(tag or "").strip()
        if not tag or not isinstance(info, dict):
            continue

        key = normalize_tag_key(tag)
        ko = str(info.get("ko", "") or "").strip()
        group = normalize_app_group_key(info.get("category") or "기타")

        current = dictionary.get(key, {"tag": tag})
        current.update({
            "tag": tag,
            "ko": ko or current.get("ko", ""),
            "group": group,
            "group_ko": TAG_GROUP_LABELS.get(group, group),
            "color": TAG_GROUP_COLORS.get(group, current.get("color", "#64748b")),
        })
        dictionary[key] = current

    return dictionary


def merge_user_app_tag_overrides_into_tree(tree, by_key):
    overrides = load_tag_dictionary_user_overrides().get("app", {})

    for tag, info in overrides.items():
        tag = str(tag or "").strip()
        if not tag or not isinstance(info, dict):
            continue

        key = normalize_tag_key(tag)
        ko = str(info.get("ko", "") or "").strip()
        group = normalize_app_group_key(info.get("category") or "기타")

        old = by_key.get(key, {})
        old_group = old.get("group")

        if old_group and old_group in tree:
            tree[old_group] = [
                item for item in tree[old_group]
                if item.get("_key") != key
            ]

        merged = dict(old)
        merged.update({
            "_key": key,
            "tag": tag,
            "ko": ko or merged.get("ko", ""),
            "group": group,
            "group_ko": TAG_GROUP_LABELS.get(group, group),
            "category": int(merged.get("category", 0) or 0),
            "category_ko": DANBOORU_CATEGORY_LABELS.get(
                int(merged.get("category", 0) or 0),
                "기타"
            ),
            "post_count": int(merged.get("post_count", 0) or 0),
            "review": merged.get("review", False),
            "color": TAG_GROUP_COLORS.get(group, "#64748b"),
        })

        by_key[key] = merged
        tree.setdefault(group, []).append(merged)

    return tree

def save_tag_dictionary_user_overrides(data):
    with open(TAG_DICTIONARY_USER_OVERRIDES, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def parse_tag_translation_input(raw_text):
    text = str(raw_text or '').strip()
    if not text:
        return None

    if '/' in text:
        left, right = text.split('/', 1)
        category = left.strip() or '기타'
        ko = right.strip()
        if not ko:
            return None
        return {
            "category": category,
            "ko": ko
        }

    return {
        "category": "기타",
        "ko": text
    }

@app.route('/api/tag_dictionary/save_app_translation', methods=['POST'])
def save_app_translation():
    try:
        data = request.get_json(force=True) or {}

        tag = str(data.get('tag') or '').strip()
        raw_input = str(data.get('input') or '').strip()

        if not tag:
            return jsonify({"status": "error", "message": "태그가 없습니다."}), 400

        parsed = parse_tag_translation_input(raw_input)
        if not parsed:
            return jsonify({"status": "error", "message": "입력값이 올바르지 않습니다."}), 400

        overrides = load_tag_dictionary_user_overrides()
        overrides.setdefault("app", {})
        overrides["app"][tag] = {
            "category": parsed["category"],
            "ko": parsed["ko"]
        }
        save_tag_dictionary_user_overrides(overrides)

        return jsonify({
            "status": "success",
            "tag": tag,
            "category": parsed["category"],
            "ko": parsed["ko"]
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

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

if __name__ == '__main__':
    app.run(
        host='127.0.0.1',
        port=5000,
        debug=False,
        use_reloader=False,
        threaded=True
    )
