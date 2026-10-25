from naim.storage.json_files import json_lock
from naim.novelai import generated_image_archive
from naim.generation_settings import normalize_inpaint_settings, apply_inpaint_model_constraints
# -*- coding: utf-8 -*-
import shutil
import re
import json
import threading
from flask import Flask, jsonify, send_file, request
import image_logic
from naim.images.comics import decorate_comic_node
import upscale_logic
import subprocess
import sys
import utils
from naim.storage.json_files import read_json, write_json, merge_json_object, json_lock
import time
import os
from PIL import Image, ImageOps
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
import tempfile
from concurrent.futures import ThreadPoolExecutor
from naim.jobs.batches import iter_completed
from naim.images.previews import PreviewCache, get_display_oriented_image_size
from naim.images.canvas_export import save_project_canvas_export, save_project_candidate_image
from naim.images.project_results import validate_project_image_context, process_project_upscale_job
from naim.storage.legacy_archive import list_archive_images, resolve_archive_image
from naim.storage.webp_conversion import resolve_converted_gallery_path
from functools import lru_cache
from urllib.parse import urlsplit, unquote, quote

from naim.paths import get_app_dir, get_file_creation_time
from naim.web.daki import register_daki_routes
from naim.web.canvas_detail_presets import register_canvas_detail_preset_routes
from naim.web.daki_image_import import register_daki_image_import_routes
from naim.web.daki_styles import register_daki_style_routes
from naim.web.daki_style_sync import register_daki_style_sync_routes
from naim.web.daki_personal_styles import register_daki_personal_style_routes
from naim.storage.daki_personal_styles import DakiPersonalStyles
from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.daki_tag_examples import DakiTagExamples
from naim.storage.daki_worldcups import DakiWorldCups
from naim.web.daki_worldcups import register_daki_worldcup_routes
from naim.web.daki_drafts import register_daki_draft_routes
from naim.web.daki_tag_catalog import register_daki_tag_catalog_routes
from naim.web.novelai_account import register_novelai_account_routes
from naim.novelai_account import AccountLookupError, fetch_subscription
from naim.daki_image_refs import resolve_daki_image_reference, daki_image_prompt_fallback, parse_daki_image_reference


app = Flask(__name__)
NOVELAI_ACCOUNT = register_novelai_account_routes(app, lambda: CONFIG_FILE)

GALLERY_INDEX_REBUILD_LOCK = threading.Lock()
GALLERY_INDEX_DB_LOCK = threading.Lock()
GALLERY_INDEX_REBUILD_JOB = {
    "running": False,
    "processed": 0,
    "total": 0,
    "message": "",
    "error": "",
    "done": False,
    "started_at": 0,
    "finished_at": 0
}
GALLERY_PROMPT_INDEX_LOCK = threading.Lock()
GALLERY_PROMPT_INDEX_JOB = {
    "running": False,
    "processed": 0,
    "total": 0,
    "message": "",
    "error": "",
    "done": False,
    "started_at": 0,
    "finished_at": 0,
    "scope_path": "",
    "mode": "all"
}
GALLERY_PROMPT_SEARCH_LOCK = threading.Lock()
GALLERY_PROMPT_SEARCH_JOBS = {}
GALLERY_PROMPT_INDEX_WORKERS = min(4, max(1, (os.cpu_count() or 4)))

# 경로 설정
CURRENT_DIR = get_app_dir()
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
GALLERY_DATA_STATUS_LOCK = threading.Lock()
GALLERY_DATA_LOAD_STATUS = {
    "running": False,
    "phase": "idle",
    "message": "대기 중",
    "mode": "",
    "sort": "",
    "started_at": 0,
    "updated_at": 0,
    "finished_at": 0,
    "elapsed": 0,
    "folders": 0,
    "images": 0,
    "index_mode": "",
    "error": ""
}


def update_gallery_data_status(**kwargs):
    now = time.time()
    with GALLERY_DATA_STATUS_LOCK:
        GALLERY_DATA_LOAD_STATUS.update(kwargs)
        GALLERY_DATA_LOAD_STATUS["updated_at"] = now

        started_at = float(GALLERY_DATA_LOAD_STATUS.get("started_at") or 0)
        if started_at:
            GALLERY_DATA_LOAD_STATUS["elapsed"] = max(0, now - started_at)


def get_gallery_data_status_snapshot():
    with GALLERY_DATA_STATUS_LOCK:
        status = dict(GALLERY_DATA_LOAD_STATUS)

    started_at = float(status.get("started_at") or 0)
    if started_at and status.get("running"):
        status["elapsed"] = max(0, time.time() - started_at)

    return status

UPSCALE_OUTPUT_FOLDER_NAME = "_upscaled"
UPSCALE_IGNORE_FILE_NAME = ".ignore"
CANVAS_SETUPS_FILE = os.path.join(CURRENT_DIR, "canvas_saved_setups.json")
DAKI_PROJECTS_FILE = os.path.join(CURRENT_DIR, "daki_projects.json")
DAKI_PROJECTS = register_daki_routes(
    app, lambda: DAKI_PROJECTS_FILE,
    lambda path: resolve_daki_image_path(path),
    clean_path=lambda path: clean_gallery_rel_path(path),
    deletion_references=lambda paths: (
        DAKI_PERSONAL_STYLES.references(paths=paths) + DAKI_TAG_EXAMPLES.references(paths=paths)
    ),
    image_deleted=lambda source, relative: project_image_deleted(source, relative),
)
register_canvas_detail_preset_routes(app, DAKI_PROJECTS)
DAKI_SHARED_STYLES_DIR = os.path.join(os.path.dirname(CURRENT_DIR), 'dakiMaker', 'research', 'style-catalog')
register_daki_image_import_routes(
    app, DAKI_PROJECTS,
    lambda: os.path.join(CANVAS_IMPORT_DIR, 'project_exports'),
    lambda upload: extract_prompt_info_from_image_filelike(upload),
)
DAKI_STYLE_TESTS_DIR = os.path.join(CURRENT_DIR, 'daki_style_tests')
DAKI_IMPORTED_STYLES_DIR = os.path.join(CURRENT_DIR, 'daki_imported_styles')
DAKI_WORLDCUPS = DakiWorldCups(lambda: os.path.join(CURRENT_DIR, 'daki_worldcups'))
register_daki_worldcup_routes(app, DAKI_WORLDCUPS)
DAKI_PERSONAL_STYLES = DakiPersonalStyles(
    lambda: os.path.join(CURRENT_DIR, 'daki_personal_styles'),
    lambda path: resolve_daki_image_path('/image/' + quote(path, safe='/')),
    lambda path: merge_prompt_info_with_fallback(load_prompt_sidecar(path), extract_prompt_info_from_image(path)),
    prompt_fallback=lambda reference: daki_image_prompt_fallback(reference, DAKI_STYLE_TESTS),
)
register_daki_personal_style_routes(app, DAKI_PERSONAL_STYLES)
DAKI_STYLE_TESTS = register_daki_style_routes(
    app, lambda: DAKI_SHARED_STYLES_DIR, lambda: DAKI_STYLE_TESTS_DIR,
    lambda: str(load_lab_config_data().get('key') or '').strip(),
    imported_root_provider=lambda: DAKI_IMPORTED_STYLES_DIR,
    personal_catalog=DAKI_PERSONAL_STYLES,
)
DAKI_DRAFTS_DIR = os.path.join(CURRENT_DIR, 'daki_drafts')
DAKI_STYLE_SYNC = register_daki_style_sync_routes(
    app, lambda: DAKI_IMPORTED_STYLES_DIR, DAKI_STYLE_TESTS.catalog,
)


def validate_draft_project(project_id):
    try:
        DAKI_PROJECTS.get_project(project_id)
    except LookupError as error:
        raise ValueError('시안을 만들 프로젝트를 찾을 수 없습니다.') from error


DAKI_DRAFTS = register_daki_draft_routes(
    app, lambda: DAKI_DRAFTS_DIR, lambda: str(load_lab_config_data().get('key') or '').strip(),
    project_validator=validate_draft_project,
    excluded_draft_ids_provider=lambda: {
        match.group(1)
        for example in DAKI_TAG_EXAMPLES.list_examples()
        if (match := re.fullmatch(r'__daki_drafts__/([a-f0-9]{32})\.png', example['path']))
    },
    references_provider=lambda paths: (
        DAKI_PROJECTS.references(paths=paths)
        + DAKI_PERSONAL_STYLES.references(paths=paths)
        + DAKI_TAG_EXAMPLES.references(paths=paths)
    ),
)
DAKI_TAG_CATALOG_DIR = os.path.join(os.path.dirname(CURRENT_DIR), 'dakiMaker', 'research', 'tag-catalog')
DAKI_TAG_EXAMPLES = DakiTagExamples(
    lambda: os.path.join(CURRENT_DIR, 'daki_tag_examples'),
    lambda path: resolve_daki_image_path('/image/' + quote(path, safe='/')),
)
DAKI_TAG_CATALOG = register_daki_tag_catalog_routes(
    app, lambda: DAKI_TAG_CATALOG_DIR,
    candidate_provider=lambda tag: iter_daki_tag_candidate_rows(tag),
    candidate_context=lambda: (os.path.realpath(CLASSIFIED_DIR), os.path.realpath(DAKI_DRAFTS_DIR),
                               os.path.realpath(DAKI_STYLE_TESTS_DIR)),
    examples_store=DAKI_TAG_EXAMPLES,
    example_preview=lambda path: serve_image_preview(str(path), 512),
)


def daki_delete_warning(data, paths=None, folders=None):
    if data.get("confirm_daki") is True:
        return None
    references = DAKI_PROJECTS.references(paths=paths or [], folders=folders or [])
    references += DAKI_PERSONAL_STYLES.references(paths=paths or [], folders=folders or [])
    references += DAKI_TAG_EXAMPLES.references(paths=paths or [], folders=folders or [])
    if references:
        return jsonify({
            "status": "error", "code": "daki_references", "references": references,
            "message": "daki 후보, 개인 그림체의 대표 그림 또는 태그사전 예시로 연결되어 있습니다. 삭제하면 원본 연결이 끊길 수 있습니다.",
        }), 409
    return None


def project_image_deleted(source, relative):
    """Refresh gallery records only when the deleted source belongs to it."""
    if source is not None:
        if not utils.is_subpath(os.path.realpath(source), os.path.realpath(CLASSIFIED_DIR)):
            return
        relative = os.path.relpath(source, CLASSIFIED_DIR).replace('\\', '/')
    elif parse_daki_image_reference(relative) is not None:
        return
    db = utils.HistoryDB()
    try:
        with GALLERY_INDEX_DB_LOCK:
            db.remove_all_file_records(relative)
            if not db.remove_gallery_image_record(relative):
                raise OSError('갤러리 색인을 갱신하지 못했습니다.')
            if db.has_full_gallery_index():
                db.refresh_gallery_folder_summaries([os.path.dirname(relative).replace('\\', '/')])
            else:
                db.rebuild_gallery_folder_summaries()
    finally:
        db.close()


from naim.images.canvas_setups import (
    apply_canvas_saved_setup_patch,
    normalize_canvas_saved_setup_item,
    normalize_canvas_saved_setups,
)


CANVAS_SETUPS_LOCK = threading.RLock()


def load_canvas_saved_setups():
    if not os.path.exists(CANVAS_SETUPS_FILE):
        return []

    try:
        data = read_json(CANVAS_SETUPS_FILE, list, expected_type=list, indent=2)
        return normalize_canvas_saved_setups(data)
    except Exception as e:
        print(f"⚠️ 캔버스 저장본 로드 실패: {e}")
        return []


def save_canvas_saved_setups(setups):
    setups = normalize_canvas_saved_setups(setups)
    write_json(CANVAS_SETUPS_FILE, setups, indent=2)
    return setups


@app.route("/api/canvas/setups", methods=["GET"])
def get_canvas_saved_setups():
    with CANVAS_SETUPS_LOCK:
        setups = load_canvas_saved_setups()
    return jsonify({
        "status": "success",
        "setups": setups,
        "count": len(setups),
        "allowLegacyMigration": not getattr(sys, "frozen", False)
    })


@app.route("/api/canvas/setups", methods=["POST"])
@app.route("/api/canvas/setups/patch", methods=["POST"])
def set_canvas_saved_setups():
    data = request.get_json(silent=True)
    error_response = jsonify({
        "status": "error",
        "message": "캔버스 저장본 목록 형식이 올바르지 않습니다."
    }), 400

    if not isinstance(data, dict):
        return error_response

    has_patch = "upserts" in data or "removeIds" in data
    has_full_list = "setups" in data
    if has_patch and has_full_list:
        return error_response

    if has_patch:
        try:
            with CANVAS_SETUPS_LOCK:
                existing = load_canvas_saved_setups()
                merged = apply_canvas_saved_setup_patch(
                    existing,
                    data.get("upserts", []),
                    data.get("removeIds", [])
                )
                saved = save_canvas_saved_setups(merged)
        except ValueError:
            return error_response
    else:
        setups = data.get("setups", [])

        if not isinstance(setups, list):
            return error_response

        with CANVAS_SETUPS_LOCK:
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
    with json_lock(GALLERY_IMAGE_TAGS_FILE):
        if not os.path.exists(GALLERY_IMAGE_TAGS_FILE):
            config = default_gallery_image_tags_config()
            save_gallery_image_tags_config(config)
            return config

        try:
            data = read_json(GALLERY_IMAGE_TAGS_FILE, default_gallery_image_tags_config, expected_type=dict, indent=2)
            return normalize_gallery_image_tag_config(data)
        except Exception as e:
            print(f"⚠️ 폴더 매핑 로드 실패: {e}")
            return default_gallery_image_tags_config()


def save_gallery_image_tags_config(config):
    config = normalize_gallery_image_tag_config(config)
    write_json(GALLERY_IMAGE_TAGS_FILE, config, indent=2)
    return config


def get_gallery_image_tag_for_path(config, rel_path):
    clean_path = clean_gallery_rel_path(rel_path)
    return (config.get("image_tags") or {}).get(clean_path, "")


def move_gallery_image_tag_path(old_path, new_path):
    with json_lock(GALLERY_IMAGE_TAGS_FILE):
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


from naim.images.prompt_metadata import (
    decode_exif_user_comment,
    _decode_prompt_metadata_dict,
    _parse_prompt_metadata,
    _iter_prompt_metadata_dicts,
    _prompt_metadata_field,
    _image_info_value_casefold,
    _normalize_extracted_generation_metadata,
    extract_prompt_info_from_image,
    normalize_prompt_info_for_sidecar,
    has_prompt_info_text,
    has_prompt_info_payload,
    get_prompt_sidecar_path,
    load_prompt_sidecar,
    merge_prompt_info_with_fallback,
    build_fast_upscale_badge_info_from_rel_path,
    load_upscale_badge_info,
    save_prompt_sidecar,
    build_embedded_prompt_payload,
    save_png_with_prompt_metadata,
    normalize_char_prompts,
)































@app.route('/')
def index():
    return send_file('index.html')


@app.route('/daki')
def daki_library():
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
        if getattr(sys, "frozen", False):
            return jsonify({
                "status": "error",
                "message": "lite exe에는 AI 자동분류 패키지가 포함되지 않습니다. AI 자동분류는 소스 버전에서 naim_setup.py로 설치해 사용해 주세요."
            }), 400

        # 시스템의 파이썬을 이용해 백그라운드에서 torch와 transformers 설치
        # 설치가 오래 걸릴 수 있으므로 즉시 응답합니다.
        print("AI 분석 패키지 설치를 백그라운드에서 시작합니다. (완료까지 시간이 걸릴 수 있습니다...)")
        subprocess.Popen([sys.executable, "-m", "pip", "install", "torch", "torchvision", "transformers"])

        return jsonify({"status": "success", "message": "설치를 백그라운드에서 시작했습니다. 완료 후 새로고침하거나 앱을 다시 실행해 주세요."})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})


def build_gallery_data_payload_from_scan(mode, sort_by, model_family="all"):
    model_family = image_logic.normalize_model_family_filter(model_family)
    if not os.path.exists(CLASSIFIED_DIR):
        update_gallery_data_status(
            running=False,
            phase="done",
            message="분류 폴더가 아직 없습니다.",
            finished_at=time.time(),
            folders=0,
            images=0,
            error=""
        )
        return {
            "tree": {"name": "ROOT", "folders": [], "images": [], "total_images": 0},
            "baseDir": "",
            "brand_map": {},
            "brand_visibility": {},
            "server_session_id": GALLERY_SERVER_SESSION_ID,
            "gallery_tags": {"tags": [], "image_tags": {}}
        }

    tree_dict = {"name": "ROOT", "path": "", "folders": {}, "images": [], "thumb": None, "total_images": 0}
    update_gallery_data_status(
        phase="prepare",
        message="갤러리 태그와 폴더명 정보를 준비 중입니다."
    )
    gallery_tag_config = load_gallery_image_tags_config()

    # 1. 갤러리 표시용 DB 폴더명 매핑을 먼저 로드
    db = utils.HistoryDB()

    # 2. 🌟 [들여쓰기 수정] 모든 모드에서 폴더명 매핑을 사용할 수 있게 밖으로 꺼냅니다.
    folder_names_map = load_folder_display_names(db, verbose=True)

    # 3. 모드 설정에 따른 스캔 경로 구성 (이제 매핑 로직은 여기서 빠집니다)
    update_gallery_data_status(
        phase="scan_config",
        message="갤러리 스캔 범위를 계산 중입니다."
    )

    scan_configs = []
    if mode == 'general':
        scan_configs.append({"path": CLASSIFIED_DIR, "ignore": ["_R-18", "_R-15", "_TRASH", "_UNREADABLE"]})
    elif mode == 'r18':
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-18"), "ignore": []})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-15"), "ignore": []})
    elif mode == 'all':
        scan_configs.append({"path": CLASSIFIED_DIR, "ignore": ["_R-18", "_R-15", "_TRASH", "_UNREADABLE"]})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-18"), "ignore": []})
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_R-15"), "ignore": []})
    elif mode == 'trash':
        scan_configs.append({"path": os.path.join(CLASSIFIED_DIR, "_TRASH"), "ignore": []})

    # 정렬 기준에 따라 폴더를 정렬
    scan_progress = {
        "folders": 0,
        "images": 0,
        "last_status_at": 0
    }

    def maybe_update_scan_status(force=False):
        now = time.time()

        if not force and now - scan_progress.get("last_status_at", 0) < 1.0:
            return

        scan_progress["last_status_at"] = now
        update_gallery_data_status(
            phase="scan",
            message=f"폴더 스캔 중... 폴더 {scan_progress['folders']}개 / 이미지 {scan_progress['images']}장",
            folders=scan_progress["folders"],
            images=scan_progress["images"],
            index_mode="scan_fallback"
        )

    def scan_recursive(physical_path, virtual_node, ignore_list=[]):
        if not os.path.exists(physical_path): return
        try:
            with os.scandir(physical_path) as entries:
                scan_progress["folders"] += 1
                maybe_update_scan_status()

                for entry in entries:
                    if entry.name in ignore_list: continue
                    if entry.name == "_UNREADABLE":
                        continue

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
                                        model_family_value = image_logic.extract_model_family_from_file(up_entry.path)
                                        if not image_logic.model_family_matches(model_family, model_family_value):
                                            continue
                                        scan_progress["images"] += 1
                                        maybe_update_scan_status()
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
                                            "ctime": get_file_creation_time(up_entry.path, mtime),
                                            "reason": reason_text,
                                            "gallery_tag": get_gallery_image_tag_for_path(gallery_tag_config, rel_img),
                                            "model_family": model_family_value,
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
                        model_family_value = image_logic.extract_model_family_from_file(entry.path)
                        if not image_logic.model_family_matches(model_family, model_family_value):
                            continue
                        scan_progress["images"] += 1
                        maybe_update_scan_status()
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
                            "ctime": get_file_creation_time(entry.path, mtime),
                            "reason": reason_text,
                            "gallery_tag": get_gallery_image_tag_for_path(gallery_tag_config, rel_img),
                            "model_family": model_family_value
                        })
                        virtual_node["total_images"] += 1
        except Exception as scan_err:
            print(f"⚠️ 폴더 스캔 실패: {physical_path} | {scan_err}")

    # 2. 하위 폴더 정리
    update_gallery_data_status(
        phase="scan",
        message="분류 폴더를 스캔 중입니다.",
        folders=0,
        images=0,
        index_mode="scan_fallback"
    )

    for config in scan_configs:
        scan_recursive(config["path"], tree_dict, config["ignore"])

    maybe_update_scan_status(force=True)

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
        decorate_comic_node(node, CLASSIFIED_DIR)

        # 메타데이터 없는 폴더명 패턴은 뒤쪽으로 정렬
        main_img = next((img["path"] for img in node["images"] if img["name"].startswith("000_MAIN_")), None)
        if not node["thumb"] and node["images"]:
            node["thumb"] = main_img if main_img else node["images"][0]["path"]

    update_gallery_data_status(
        phase="finalize",
        message="폴더 개수와 대표 이미지를 정리 중입니다.",
        folders=scan_progress["folders"],
        images=scan_progress["images"]
    )

    finalize_tree(tree_dict, depth=0)

    update_gallery_data_status(
        phase="brand_map",
        message="브랜드/캐릭터 표시 정보를 구성 중입니다.",
        folders=scan_progress["folders"],
        images=scan_progress["images"]
    )

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

    return {
        "tree": tree_dict,
        "baseDir": "TOTAL_CLASSIFIED",
        "brand_map": brand_map,
        "brand_visibility": brand_visibility,  # 브랜드별 노출 스위치
        "server_session_id": GALLERY_SERVER_SESSION_ID,
        "gallery_tags": {
            "tags": gallery_tag_config.get("tags", []),
            "image_tags": gallery_tag_config.get("image_tags", {})
        }
    }


def build_gallery_brand_payload(db, tree_dict):
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
        print(f"?좑툘 留ㅽ븨 ?ㅻ쪟: {e}")
    return brand_map, brand_visibility


def build_gallery_data_payload_from_index(mode, sort_by, model_family="all", summary_only=False):
    model_family = image_logic.normalize_model_family_filter(model_family)
    db = utils.HistoryDB()
    try:
        if not summary_only:
            db.ensure_gallery_image_creation_times(CLASSIFIED_DIR)
        gallery_tag_config = load_gallery_image_tags_config()
        tree = {"name": "ROOT", "path": "", "folders": {}, "images": [], "thumb": None, "total_images": 0}
        folder_nodes = {"": tree}
        cursor = db.conn.cursor()

        from naim.gallery.catalog import gallery_rows
        rows = gallery_rows(db.conn, mode, model_family, summary=summary_only)

        def get_node(folder_path):
            folder_path = str(folder_path or "").replace("\\", "/").strip("/")
            if folder_path in folder_nodes:
                return folder_nodes[folder_path]
            parent_path = os.path.dirname(folder_path).replace("\\", "/")
            parent = get_node(parent_path)
            name = os.path.basename(folder_path)
            node = {"name": name, "path": folder_path, "folders": {}, "images": [], "thumb": None, "total_images": 0}
            if name.lower() == "comic":
                node["is_comic_group"] = True
                node["char_names"] = []
            parent["folders"][name] = node
            folder_nodes[folder_path] = node
            return node

        for row in rows:
            rel_path, folder_path, file_name, width, height, mtime, reason, gallery_tag, row_model_family, ctime = row[:10]
            display_folder_path = normalize_gallery_display_folder_path(folder_path)
            node = get_node(display_folder_path)
            if not node["images"] and not node.get('_images_pending'):
                decorate_comic_node(node, CLASSIFIED_DIR, folder_path)
            if summary_only:
                node['_images_pending'] = node.get('_images_pending', 0) + row[10]
                node.setdefault('_image_sources', []).append(folder_path)
                if node.get('is_comic'):
                    rel_path = row[11]
                    file_name = os.path.basename(rel_path)
                thumb_key = (not file_name.startswith('000_MAIN_'), 0 if node.get('is_comic') else -float(mtime or 0), file_name)
                if '_own_thumb_key' not in node or thumb_key < node['_own_thumb_key']:
                    node['_own_thumb_key'] = thumb_key
                    node['_own_thumb'] = rel_path
                continue
            node["images"].append({
                "name": file_name,
                "path": rel_path,
                "w": width,
                "h": height,
                "mtime": mtime,
                "ctime": ctime,
                "reason": reason or "",
                "gallery_tag": gallery_tag or get_gallery_image_tag_for_path(gallery_tag_config, rel_path),
                "model_family": image_logic.normalize_model_family(row_model_family)
            })

        def finalize_tree(node, depth=0):
            folder_list = list(node["folders"].values())
            for child in folder_list:
                finalize_tree(child, depth + 1)
                node["total_images"] += child["total_images"]
                if not node["thumb"] and child.get("thumb"):
                    node["thumb"] = child["thumb"]
            node["total_images"] += len(node["images"]) + node.get("_images_pending", 0)
            node["images"].sort(key=lambda x: (-float(x.get("mtime") or 0), x["name"]))
            if node.get("is_comic"):
                node["images"].sort(key=lambda x: x["name"])
            main_img = next((img["path"] for img in node["images"] if img["name"].startswith("000_MAIN_")), None)
            if not node["thumb"] and node["images"]:
                node["thumb"] = main_img if main_img else node["images"][0]["path"]
            node.pop("_own_thumb_key", None)
            own_thumb = node.pop("_own_thumb", None)
            if not node["thumb"] and own_thumb:
                node["thumb"] = own_thumb
            folder_list = [f for f in folder_list if f["total_images"] > 0]
            if depth == 0:
                order_map = {"1_Solo": 1, "2_Duo": 2, "3_Group": 3, "No_Metadata": 99}
                folder_list.sort(key=lambda x: (order_map.get(x["name"], 50), x["name"]))
            elif mode == "trash":
                folder_list.sort(key=lambda x: x["name"], reverse=True)
            elif sort_by == "count":
                folder_list.sort(key=lambda x: (x["name"] == "No_Metadata", -x["total_images"]))
            else:
                folder_list.sort(key=lambda x: (x["name"] == "No_Metadata", x["name"]))
            node["folders"] = folder_list

        finalize_tree(tree)
        brand_map, brand_visibility = build_gallery_brand_payload(db, tree)
        return {
            "tree": tree,
            "catalog_mode": bool(summary_only),
            "baseDir": "TOTAL_CLASSIFIED",
            "brand_map": brand_map,
            "brand_visibility": brand_visibility,
            "server_session_id": GALLERY_SERVER_SESSION_ID,
            "gallery_tags": {
                "tags": gallery_tag_config.get("tags", []),
                "image_tags": gallery_tag_config.get("image_tags", {})
            }
        }
    finally:
        db.close()


@app.route('/api/gallery/images', methods=['POST'])
def get_gallery_image_page():
    from naim.gallery.catalog import gallery_image_page
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify(status='error', message='잘못된 조회 요청입니다.'), 400
    db = utils.HistoryDB()
    try:
        if not db.has_full_gallery_index():
            return jsonify(status='error', message='인덱스를 갱신한 뒤 다시 시도해 주세요.'), 409
        rows, next_cursor = gallery_image_page(db.conn, data.get('mode', 'general'),
            image_logic.normalize_model_family_filter(data.get('model_family', 'all')),
            data.get('folders'), data.get('after', ''), data.get('limit', 512), paths=data.get('paths'))
        # Migrate missing creation times only for this page, not the whole library.
        updates = []
        for index, row in enumerate(rows):
            if row[9] is None:
                created = get_file_creation_time(os.path.join(CLASSIFIED_DIR, row[0]), row[5])
                rows[index] = (*row[:9], created)
                updates.append((created, row[0]))
        if updates:
            with db.conn:
                db.conn.executemany('UPDATE gallery_images SET ctime = ? WHERE rel_path = ? AND ctime IS NULL', updates)
        tags = load_gallery_image_tags_config()
        images = [{'path': r[0], 'name': r[2], 'w': r[3], 'h': r[4], 'mtime': r[5],
                   'reason': r[6] or '', 'gallery_tag': r[7] or get_gallery_image_tag_for_path(tags, r[0]),
                   'model_family': image_logic.normalize_model_family(r[8]), 'ctime': r[9]} for r in rows]
        return jsonify(status='success', images=images, next_cursor=next_cursor)
    except (ValueError, TypeError):
        return jsonify(status='error', message='잘못된 페이지 조회 조건입니다.'), 400
    finally:
        db.close()


@app.route('/api/data/status')
def get_gallery_data_status():
    return jsonify({
        "status": "success",
        **get_gallery_data_status_snapshot()
    })


@app.route('/api/data')
def get_data():
    mode = request.args.get('mode', 'general')
    sort_by = request.args.get('sort', 'name')
    model_family = image_logic.normalize_model_family_filter(request.args.get('model_family', 'all'))
    allow_scan = request.args.get('allow_scan', '0') == '1'
    index_mode = "scan_fallback"
    data_started_perf = time.perf_counter()
    data_started_wall = time.time()

    update_gallery_data_status(
        running=True,
        phase="start",
        message="갤러리 데이터 요청을 시작했습니다.",
        mode=mode,
        sort=sort_by,
        started_at=data_started_wall,
        finished_at=0,
        elapsed=0,
        folders=0,
        images=0,
        index_mode="scan_fallback",
        error=""
    )
    print(f"[갤러리] /api/data 시작: mode={mode}, sort={sort_by}, model_family={model_family}")

    try:
        db = utils.HistoryDB()
        has_full_index = db.has_full_gallery_index()
        db.close()
    except Exception:
        has_full_index = False

    if has_full_index:
        try:
            update_gallery_data_status(
                phase="index",
                message="갤러리 인덱스에서 데이터를 불러오는 중입니다.",
                index_mode="full_index"
            )
            payload = build_gallery_data_payload_from_index(mode, sort_by, model_family, summary_only=request.args.get("catalog") == "1")
            index_mode = "full_index"
        except Exception as e:
            print(f"gallery index fallback: {e}")
            if not allow_scan:
                auto_started, rebuild_running = start_gallery_index_rebuild_background(auto=True)
                elapsed = time.perf_counter() - data_started_perf

                update_gallery_data_status(
                    running=False,
                    phase="needs_index",
                    message="갤러리 인덱스 로딩에 실패해 자동 복구 중입니다.",
                    finished_at=time.time(),
                    elapsed=elapsed,
                    index_mode="needs_index",
                    error=str(e)
                )

                print(
                    f"[갤러리] full index 로딩 실패: 자동 인덱스 복구 "
                    f"auto_started={auto_started}, rebuild_running={rebuild_running}, error={e}"
                )

                return jsonify({
                    "status": "success",
                    "needs_index": True,
                    "auto_rebuild_started": bool(auto_started),
                    "rebuild_running": bool(rebuild_running),
                    "index_mode": "needs_index",
                    "message": "갤러리 인덱스 로딩에 실패해 자동으로 복구 중입니다. 완료되면 갤러리를 다시 불러옵니다.",
                    "error": str(e),
                    "tree": {"name": "ROOT", "folders": [], "images": [], "total_images": 0},
                    "baseDir": "TOTAL_CLASSIFIED",
                    "brand_map": {},
                    "brand_visibility": {},
                    "server_session_id": GALLERY_SERVER_SESSION_ID,
                    "gallery_tags": load_gallery_image_tags_config()
                })
            payload = build_gallery_data_payload_from_scan(mode, sort_by, model_family)
    else:
        if not allow_scan:
            auto_started, rebuild_running = start_gallery_index_rebuild_background(auto=True)
            elapsed = time.perf_counter() - data_started_perf

            update_gallery_data_status(
                running=False,
                phase="needs_index",
                message="빠른 갤러리 인덱스가 없어 자동 생성 중입니다.",
                finished_at=time.time(),
                elapsed=elapsed,
                folders=0,
                images=0,
                index_mode="needs_index",
                error=""
            )

            print(
                f"[갤러리] full index 없음: 자동 인덱스 생성 "
                f"auto_started={auto_started}, rebuild_running={rebuild_running}, mode={mode}, sort={sort_by}"
            )

            return jsonify({
                "status": "success",
                "needs_index": True,
                "auto_rebuild_started": bool(auto_started),
                "rebuild_running": bool(rebuild_running),
                "index_mode": "needs_index",
                "message": "빠른 갤러리 인덱스가 없어 자동으로 생성 중입니다. 완료되면 갤러리를 다시 불러옵니다.",
                "tree": {"name": "ROOT", "folders": [], "images": [], "total_images": 0},
                "baseDir": "TOTAL_CLASSIFIED",
                "brand_map": {},
                "brand_visibility": {},
                "server_session_id": GALLERY_SERVER_SESSION_ID,
                "gallery_tags": load_gallery_image_tags_config()
            })

        update_gallery_data_status(
            phase="scan",
            message="사용자 요청으로 기존 전체 스캔 방식으로 불러오는 중입니다.",
            index_mode="scan_fallback"
        )
        payload = build_gallery_data_payload_from_scan(mode, sort_by, model_family)

    elapsed = time.perf_counter() - data_started_perf
    status_snapshot = get_gallery_data_status_snapshot()
    update_gallery_data_status(
        running=False,
        phase="done",
        message=f"갤러리 데이터 준비 완료 ({elapsed:.1f}초)",
        finished_at=time.time(),
        elapsed=elapsed,
        folders=status_snapshot.get("folders", 0),
        images=status_snapshot.get("images", 0),
        index_mode=index_mode,
        error=""
    )

    print(
        f"[갤러리] /api/data 완료: mode={mode}, sort={sort_by}, model_family={model_family}, index_mode={index_mode}, "
        f"folders={status_snapshot.get('folders', 0)}, images={status_snapshot.get('images', 0)}, elapsed={elapsed:.1f}s"
    )

    payload["status"] = "success"
    payload["index_mode"] = index_mode
    return jsonify(payload)

def load_gallery_reason_text_for_image(full_path):
    txt_path = os.path.splitext(full_path)[0] + ".txt"

    if not os.path.exists(txt_path):
        return ""

    try:
        with open(txt_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        print(f"⚠️ 갤러리 사유 파일 읽기 실패: {txt_path} | {e}")
        return ""

def infer_gallery_mode_from_rel_path(rel_path):
    rel_path = str(rel_path or "").replace("\\", "/").strip("/")
    if rel_path.startswith("_TRASH/"):
        return "trash"
    if rel_path.startswith("_R-18/") or rel_path.startswith("_R-15/"):
        return "r18"
    return "general"


def normalize_gallery_display_folder_path(folder_path):
    text = str(folder_path or "").replace("\\", "/").strip("/")

    for prefix in ("_R-18/", "_R-15/", "_TRASH/"):
        if text.startswith(prefix):
            return text[len(prefix):].strip("/")

    if text in {"_R-18", "_R-15", "_TRASH"}:
        return ""

    return text


def get_existing_gallery_rel_path(file_path):
    try:
        rel_path = os.path.relpath(file_path, CLASSIFIED_DIR).replace("\\", "/")
    except Exception:
        return clean_gallery_rel_path(file_path)

    if rel_path.startswith(".."):
        return clean_gallery_rel_path(rel_path)

    parts = [part for part in rel_path.split("/") if part]
    parent = CLASSIFIED_DIR
    actual_parts = []

    for part in parts:
        actual_part = part
        try:
            for entry in os.listdir(parent):
                if entry.casefold() == part.casefold():
                    actual_part = entry
                    break
        except Exception:
            pass

        actual_parts.append(actual_part)
        parent = os.path.join(parent, actual_part)

    return "/".join(actual_parts)


def should_skip_gallery_index_directory(folder_path):
    if os.path.basename(str(folder_path or "").rstrip("\\/")) == UPSCALE_OUTPUT_FOLDER_NAME:
        return False
    return os.path.exists(os.path.join(folder_path, ".ignore"))


def should_skip_gallery_index_child_directory(root, dirname):
    if dirname == UPSCALE_OUTPUT_FOLDER_NAME:
        return False
    return os.path.exists(os.path.join(root, dirname, ".ignore"))


def gallery_index_rebuild_worker():
    batch = []
    batch_size = 2000
    last_progress_at = 0
    db = None
    staging_db = None
    staging_directory = None
    try:
        with GALLERY_INDEX_REBUILD_LOCK:
            GALLERY_INDEX_REBUILD_JOB.update({
                "running": True,
                "processed": 0,
                "total": 0,
                "message": "이미지 목록 수집 중...",
                "error": "",
                "done": False,
                "started_at": time.time(),
                "finished_at": 0
            })

        db = utils.HistoryDB()
        staging_directory = tempfile.TemporaryDirectory(prefix="naim-gallery-index-")
        staging_db = utils.HistoryDB(os.path.join(staging_directory.name, "gallery_index.db"))

        with GALLERY_INDEX_DB_LOCK:
            # Keep the live index readable while serializing gallery writers
            # as before. Only the completed temporary index is published.
            staging_db.capture_gallery_index_baseline(db.db_path)

            image_paths = []
            for root, dirs, files in os.walk(CLASSIFIED_DIR):
                dirs[:] = [
                    d for d in dirs
                    if not should_skip_gallery_index_child_directory(root, d)
                ]
                if should_skip_gallery_index_directory(root):
                    dirs[:] = []
                    continue
                for file_name in files:
                    if file_name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                        image_paths.append(os.path.join(root, file_name))

            with GALLERY_INDEX_REBUILD_LOCK:
                GALLERY_INDEX_REBUILD_JOB["total"] = len(image_paths)
                GALLERY_INDEX_REBUILD_JOB["message"] = "갤러리 인덱스 작성 중..."

            gallery_tag_config = load_gallery_image_tags_config()

            for index, full_path in enumerate(image_paths, 1):
                rel_path = os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
                folder_path = os.path.dirname(rel_path).replace("\\", "/")
                if os.path.basename(folder_path) == UPSCALE_OUTPUT_FOLDER_NAME:
                    folder_path = os.path.dirname(folder_path).replace("\\", "/")
                file_name = os.path.basename(rel_path)

                try:
                    mtime = os.path.getmtime(full_path)
                except Exception:
                    mtime = time.time()

                cached = db.get_file_metadata(rel_path)
                width = cached[0] if cached and cached[2] == mtime else None
                height = cached[1] if cached and cached[2] == mtime else None
                reason_text = load_gallery_reason_text_for_image(full_path)
                model_family = image_logic.extract_model_family_from_file(full_path)

                batch.append({
                    "rel_path": rel_path,
                    "folder_path": folder_path,
                    "file_name": file_name,
                    "mode": infer_gallery_mode_from_rel_path(rel_path),
                    "mtime": mtime,
                    "ctime": get_file_creation_time(full_path, mtime),
                    "width": width,
                    "height": height,
                    "reason": reason_text,
                    "gallery_tag": get_gallery_image_tag_for_path(gallery_tag_config, rel_path),
                    "model_family": model_family
                })

                if len(batch) >= batch_size:
                    staging_db.upsert_gallery_image_records(batch)
                    batch = []

                now = time.time()
                if now - last_progress_at >= 0.35 or index == len(image_paths):
                    last_progress_at = now
                    with GALLERY_INDEX_REBUILD_LOCK:
                        GALLERY_INDEX_REBUILD_JOB["processed"] = index

            if batch:
                staging_db.upsert_gallery_image_records(batch)

            with GALLERY_INDEX_REBUILD_LOCK:
                GALLERY_INDEX_REBUILD_JOB["message"] = "폴더 요약 생성 중..."
                GALLERY_INDEX_REBUILD_JOB["processed"] = len(image_paths)

            staging_db.rebuild_gallery_folder_summaries()
            latest_gallery_tag_config = load_gallery_image_tags_config()
            if latest_gallery_tag_config != gallery_tag_config:
                # Image tags are saved independently of the image DB. Refresh
                # the scan's snapshot before publishing a long-running rebuild.
                with staging_db.conn:
                    staging_db.conn.executemany(
                        "UPDATE gallery_images SET gallery_tag = ? WHERE rel_path = ?",
                        ((get_gallery_image_tag_for_path(latest_gallery_tag_config, row[0]), row[0])
                         for row in staging_db.conn.execute("SELECT rel_path FROM gallery_images"))
                    )
            db.replace_gallery_index_from(staging_db)

        with GALLERY_INDEX_REBUILD_LOCK:
            GALLERY_INDEX_REBUILD_JOB.update({
                "running": False,
                "done": True,
                "message": "인덱스 생성 완료",
                "finished_at": time.time()
            })
    except Exception as e:
        with GALLERY_INDEX_REBUILD_LOCK:
            GALLERY_INDEX_REBUILD_JOB.update({
                "running": False,
                "done": True,
                "error": str(e),
                "message": "인덱스 생성 실패",
                "finished_at": time.time()
            })
    finally:
        if staging_db:
            staging_db.close()
        if staging_directory:
            staging_directory.cleanup()
        if db:
            db.close()


def start_gallery_index_rebuild_background(auto=False):
    """
    갤러리 인덱스를 백그라운드에서 생성한다.
    이미 실행 중이면 새로 시작하지 않는다.
    반환값:
      (started, running)
      started=True  : 이번 호출에서 새 작업 시작
      running=True  : 이미 실행 중이거나 방금 시작됨
    """
    with GALLERY_INDEX_REBUILD_LOCK:
        if GALLERY_INDEX_REBUILD_JOB.get("running"):
            return False, True

        GALLERY_INDEX_REBUILD_JOB.update({
            "running": True,
            "processed": 0,
            "total": 0,
            "message": "갤러리 인덱스 자동 생성 준비 중..." if auto else "갤러리 인덱스 생성 준비 중...",
            "error": "",
            "done": False,
            "started_at": time.time(),
            "finished_at": 0
        })

    thread = threading.Thread(target=gallery_index_rebuild_worker, daemon=True)
    thread.start()
    return True, True


def refresh_gallery_index_for_file_change(file_path, rel_path=None, old_rel_path=None, allow_rebuild=True, **overrides):
    result = {
        "index_updated": False,
        "index_full_built": False,
        "index_verified": False,
        "index_rebuild_started": False,
        "index_rebuild_running": False,
        "index_error": ""
    }
    db = None

    try:
        clean_rel_path = clean_gallery_rel_path(rel_path)
        if not clean_rel_path:
            clean_rel_path = os.path.relpath(file_path, CLASSIFIED_DIR).replace("\\", "/")
        actual_rel_path = get_existing_gallery_rel_path(file_path)
        stale_rel_paths = []
        if clean_rel_path and clean_rel_path != actual_rel_path:
            stale_rel_paths.append(clean_rel_path)
        clean_rel_path = actual_rel_path

        db = utils.HistoryDB()

        with GALLERY_INDEX_DB_LOCK:
            index_full_built = db.has_full_gallery_index()
            result["index_full_built"] = bool(index_full_built)

            if index_full_built:
                changed_folders = []
                for previous_path in {clean_rel_path, old_rel_path, *stale_rel_paths}:
                    if previous_path:
                        previous = db.conn.execute(
                            "SELECT folder_path FROM gallery_images WHERE rel_path = ?",
                            (db.normalize_gallery_rel_path(previous_path),),
                        ).fetchone()
                        if previous:
                            changed_folders.append(previous[0])
                if old_rel_path:
                    db.remove_gallery_image_record(old_rel_path)
                for stale_rel_path in stale_rel_paths:
                    db.remove_gallery_image_record(stale_rel_path)

                tag_config = load_gallery_image_tags_config()
                next_overrides = dict(overrides)
                next_overrides["rel_path"] = clean_rel_path
                if "gallery_tag" not in next_overrides:
                    next_overrides["gallery_tag"] = get_gallery_image_tag_for_path(tag_config, clean_rel_path)

                gallery_record = db.upsert_gallery_image_file(
                    file_path,
                    classified_root=CLASSIFIED_DIR,
                    **next_overrides
                )
                db.refresh_gallery_folder_summaries(changed_folders + [gallery_record["folder_path"]])

                index_verified = db.gallery_image_record_exists(gallery_record["rel_path"])
                result["index_verified"] = bool(index_verified)
                result["index_updated"] = bool(index_verified)

    except Exception as e:
        result["index_error"] = str(e)
        print(f"[WARN] gallery index refresh failed: {e}")

    finally:
        if db:
            try:
                db.close()
            except Exception:
                pass

    if allow_rebuild and not result["index_updated"]:
        try:
            index_rebuild_started, index_rebuild_running = start_gallery_index_rebuild_background(auto=True)
            result["index_rebuild_started"] = bool(index_rebuild_started)
            result["index_rebuild_running"] = bool(index_rebuild_running)
        except Exception as rebuild_error:
            result["index_error"] = result["index_error"] or str(rebuild_error)
            print(f"[WARN] gallery index rebuild start failed: {rebuild_error}")

    return result


@app.route('/api/gallery/index/rebuild', methods=['POST'])
def start_gallery_index_rebuild():
    start_gallery_index_rebuild_background(auto=False)

    with GALLERY_INDEX_REBUILD_LOCK:
        payload = dict(GALLERY_INDEX_REBUILD_JOB)

    return jsonify({"status": "success", **payload})


@app.route('/api/gallery/index/status')
def gallery_index_status():
    try:
        db = utils.HistoryDB()
        full_index_built = db.has_full_gallery_index()
        db.close()
    except Exception:
        full_index_built = False

    with GALLERY_INDEX_REBUILD_LOCK:
        payload = dict(GALLERY_INDEX_REBUILD_JOB)

    payload.update({
        "status": "success",
        "full_index_built": bool(full_index_built),
        "index_mode_available": bool(full_index_built)
    })
    return jsonify(payload)


def normalize_gallery_prompt_search_text(value):
    return utils.normalize_gallery_prompt_search_text(value)


def split_gallery_prompt_search_terms(query):
    # Kept as a compatibility wrapper for existing route callers.  The
    # returned value is now the shared OR-of-AND parser structure.
    return utils.parse_gallery_prompt_search_query(query)


def normalize_gallery_prompt_scope_paths(value):
    raw_paths = value if isinstance(value, list) else [value]
    paths = []
    seen = set()

    for raw_path in raw_paths:
        clean = clean_gallery_rel_path(raw_path)
        if clean in seen:
            continue
        seen.add(clean)
        paths.append(clean)

    return paths


def gallery_prompt_mode_matches(rel_path, mode):
    file_mode = infer_gallery_mode_from_rel_path(rel_path)
    if mode == "general":
        return file_mode == "general"
    if mode == "r18":
        return file_mode == "r18"
    if mode == "trash":
        return file_mode == "trash"
    return file_mode != "trash" or mode == "trash"


def iter_gallery_prompt_index_files(scope_path="", mode="all", stop_check=None):
    scope_paths = normalize_gallery_prompt_scope_paths(scope_path)

    if not scope_paths:
        scope_paths = [""]

    roots = []

    for scope in scope_paths:
        if stop_check and stop_check():
            return []
        try:
            root = utils.resolve_safe_path(
                CLASSIFIED_DIR,
                scope,
                strip_prefix="TOTAL_CLASSIFIED/"
            ) if scope else CLASSIFIED_DIR
        except ValueError:
            continue

        if os.path.isdir(root):
            roots.append(root)

    if not roots:
        return []

    image_paths = []
    seen_paths = set()

    for root in roots:
        if stop_check and stop_check():
            return []
        for scan_root, dirs, files in os.walk(root):
            if stop_check and stop_check():
                return []
            dirs[:] = [
                d for d in dirs
                if not should_skip_gallery_index_child_directory(scan_root, d)
            ]

            if should_skip_gallery_index_directory(scan_root):
                dirs[:] = []
                continue

            for file_name in files:
                if stop_check and stop_check():
                    return []
                if not file_name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    continue

                full_path = os.path.join(scan_root, file_name)
                rel_path = os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")

                if rel_path in seen_paths:
                    continue
                seen_paths.add(rel_path)

                if mode == "general" and rel_path.startswith(("_R-18/", "_R-15/", "_TRASH/")):
                    continue
                if mode == "r18" and not rel_path.startswith(("_R-18/", "_R-15/")):
                    continue
                if mode == "trash" and not rel_path.startswith("_TRASH/"):
                    continue
                if mode == "all" and rel_path.startswith("_TRASH/"):
                    continue

                image_paths.append(full_path)

    return image_paths


def build_gallery_prompt_index_record(full_path):
    rel_path = os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
    folder_path = os.path.dirname(rel_path).replace("\\", "/")

    if os.path.basename(folder_path) == UPSCALE_OUTPUT_FOLDER_NAME:
        folder_path = os.path.dirname(folder_path).replace("\\", "/")

    try:
        mtime = os.path.getmtime(full_path)
    except Exception:
        mtime = time.time()

    prompt_info = load_prompt_sidecar(full_path) or extract_prompt_info_from_image(full_path) or {}
    prompt_text = build_gallery_prompt_filter_text(prompt_info)
    positive_prompt_text = build_gallery_positive_prompt_filter_text(prompt_info)

    return {
        "rel_path": rel_path,
        "folder_path": folder_path,
        "file_name": os.path.basename(rel_path),
        "mode": infer_gallery_mode_from_rel_path(rel_path),
        "mtime": mtime,
        "prompt_text": prompt_text,
        "normalized_text": normalize_gallery_prompt_search_text(prompt_text),
        "positive_prompt_text": positive_prompt_text,
        "positive_normalized_text": normalize_gallery_prompt_search_text(positive_prompt_text)
    }


def build_gallery_prompt_index_profile_name(scope_paths, mode):
    scope_paths = normalize_gallery_prompt_scope_paths(scope_paths)
    mode_label = str(mode or "all")

    if not scope_paths:
        return f"{mode_label} · TOTAL_CLASSIFIED 전체"

    if len(scope_paths) == 1:
        return f"{mode_label} · {scope_paths[0]}"

    return f"{mode_label} · {len(scope_paths)}개 필터 폴더"


def filter_gallery_prompt_index_files(db, image_paths, missing_only=False):
    rel_paths = [
        os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
        for full_path in image_paths
    ]
    indexed_mtimes = db.get_gallery_prompt_index_mtimes(rel_paths)
    return utils.select_gallery_prompt_index_paths(
        image_paths,
        indexed_mtimes,
        CLASSIFIED_DIR,
        missing_only=missing_only,
    )


def gallery_prompt_index_worker(scope_path="", mode="all", rebuild=False, missing_only=False):
    db = None

    try:
        clean_scopes = normalize_gallery_prompt_scope_paths(scope_path)
        scope_label = clean_scopes[0] if len(clean_scopes) == 1 else f"{len(clean_scopes)} scopes"
        all_image_paths = iter_gallery_prompt_index_files(clean_scopes, mode)
        image_paths = all_image_paths
        profile_name = build_gallery_prompt_index_profile_name(clean_scopes, mode)

        with GALLERY_PROMPT_INDEX_LOCK:
            GALLERY_PROMPT_INDEX_JOB.update({
                "running": True,
                "processed": 0,
                "total": len(image_paths),
                "message": "프롬프트 인덱스 재생성 중..." if rebuild else "프롬프트 인덱스 갱신 중...",
                "error": "",
                "done": False,
                "started_at": time.time(),
                "finished_at": 0,
                "scope_path": scope_label,
                "mode": mode or "all"
            })

        db = utils.HistoryDB()

        if rebuild:
            for clean_scope in clean_scopes:
                db.clear_gallery_prompt_index(clean_scope)
            if not clean_scopes:
                db.clear_gallery_prompt_index("")
        elif missing_only:
            image_paths = filter_gallery_prompt_index_files(
                db, image_paths, missing_only=True
            )
        else:
            image_paths = filter_gallery_prompt_index_files(db, image_paths)

        with GALLERY_PROMPT_INDEX_LOCK:
            GALLERY_PROMPT_INDEX_JOB.update({
                "processed": 0,
                "total": len(image_paths),
                "message": (
                    "프롬프트 인덱스 재생성 중..." if rebuild else
                    "프롬프트 인덱스 새 파일 추가 중..." if missing_only else
                    "프롬프트 인덱스 갱신 중..."
                )
            })

        batch = []
        processed = 0
        last_progress_at = 0

        with ThreadPoolExecutor(max_workers=GALLERY_PROMPT_INDEX_WORKERS) as executor:
            for full_path, future in iter_completed(
                executor, build_gallery_prompt_index_record, image_paths,
                GALLERY_PROMPT_INDEX_WORKERS * 2,
            ):
                processed += 1

                try:
                    batch.append(future.result())
                except Exception as item_error:
                    print(f"[WARN] gallery prompt index item failed: {full_path} | {item_error}")

                if len(batch) >= 500:
                    db.upsert_gallery_prompt_records(batch)
                    batch = []

                now = time.time()
                if processed % 50 == 0 or now - last_progress_at >= 0.35 or processed == len(image_paths):
                    last_progress_at = now
                    with GALLERY_PROMPT_INDEX_LOCK:
                        GALLERY_PROMPT_INDEX_JOB["processed"] = processed

        if batch:
            db.upsert_gallery_prompt_records(batch)

        rel_paths = [
            os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
            for full_path in all_image_paths
        ]
        status = db.get_gallery_prompt_index_status(clean_scopes, mode)
        profile = db.upsert_gallery_prompt_index_profile(
            name=profile_name,
            mode=mode,
            scope_paths=clean_scopes,
            rel_paths=rel_paths,
            text_bytes=status.get("text_bytes", 0)
        )

        with GALLERY_PROMPT_INDEX_LOCK:
            GALLERY_PROMPT_INDEX_JOB.update({
                "running": False,
                "processed": len(image_paths),
                "done": True,
                "message": "프롬프트 인덱스 생성 완료",
                "profile_id": profile.get("id", ""),
                "profile_name": profile.get("name", ""),
                "finished_at": time.time()
            })

    except Exception as e:
        with GALLERY_PROMPT_INDEX_LOCK:
            GALLERY_PROMPT_INDEX_JOB.update({
                "running": False,
                "done": True,
                "error": str(e),
                "message": "프롬프트 인덱스 생성 실패",
                "finished_at": time.time()
            })
    finally:
        if db:
            db.close()


def build_gallery_prompt_search_payload(rows):
    image_paths = []
    folder_counts = {}

    for row in rows:
        rel_path = clean_gallery_rel_path(row.get("rel_path"))
        folder_path = clean_gallery_rel_path(row.get("folder_path"))

        if not rel_path:
            continue

        image_paths.append(rel_path)
        current = folder_path

        while current:
            folder_counts[current] = folder_counts.get(current, 0) + 1
            current = os.path.dirname(current).replace("\\", "/")

    return {
        "image_paths": image_paths,
        "folder_counts": folder_counts,
        "total_matches": len(image_paths)
    }


def search_gallery_prompts_without_index(query, scope_path="", mode="all", progress=None, positive_only=False, cancel_event=None):
    groups = split_gallery_prompt_search_terms(query)
    if not groups:
        return []

    stop_check = cancel_event.is_set if cancel_event is not None else None
    rows = []
    image_paths = iter_gallery_prompt_index_files(scope_path, mode, stop_check=stop_check)

    if stop_check and stop_check():
        return []

    if progress:
        progress(total=len(image_paths), processed=0, message="인덱스 없이 프롬프트 파일을 읽는 중...")

    processed = 0
    last_progress_at = 0

    def read_record(full_path):
        if stop_check and stop_check():
            return None
        return build_gallery_prompt_index_record(full_path)

    with ThreadPoolExecutor(max_workers=GALLERY_PROMPT_INDEX_WORKERS) as executor:
        results = iter_completed(
            executor, read_record, image_paths, GALLERY_PROMPT_INDEX_WORKERS * 2,
            stop_check=stop_check,
        )
        try:
            for full_path, future in results:
                if stop_check and stop_check():
                    break
                rel_path = os.path.relpath(full_path, CLASSIFIED_DIR).replace("\\", "/")
                processed += 1

                try:
                    record = future.result()
                    if record is None:
                        continue

                    prompt_text_key = "positive_prompt_text" if positive_only else "prompt_text"
                    normalized_text_key = "positive_normalized_text" if positive_only else "normalized_text"
                    if utils.gallery_prompt_search_matches(
                        record.get(prompt_text_key),
                        groups,
                        record.get(normalized_text_key),
                    ):
                        rows.append({
                            "rel_path": rel_path,
                            "folder_path": record.get("folder_path") or os.path.dirname(rel_path).replace("\\", "/"),
                            "file_name": os.path.basename(rel_path)
                        })
                except Exception as e:
                    print(f"[WARN] gallery prompt fallback search failed: {rel_path} | {e}")

                now = time.time()
                if progress and (processed % 25 == 0 or now - last_progress_at >= 0.35 or processed == len(image_paths)):
                    last_progress_at = now
                    progress(total=len(image_paths), processed=processed, message="인덱스 없이 프롬프트 파일을 읽는 중...")
        finally:
            results.close()

    if progress:
        progress(total=len(image_paths), processed=processed, message="인덱스 없이 프롬프트 파일을 읽는 중...")

    return rows


def iter_daki_tag_candidate_rows(tag):
    """Read gallery candidates sequentially; supplement stale/partial indexes."""
    db = get_gallery_history_db()
    seen = set()

    def read_candidate(relative):
        try:
            path, actual = resolve_daki_image_path('/image/' + quote(relative, safe='/'))
            if actual.startswith('_TRASH/') or not path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                return None
            if actual in seen:
                return None
            seen.add(actual)
            with Image.open(path) as image:
                if image.format not in {'PNG', 'JPEG', 'WEBP'}:
                    return None
            info = merge_prompt_info_with_fallback(load_prompt_sidecar(path), extract_prompt_info_from_image(path))
            return {'path': actual, 'name': os.path.basename(actual), 'prompt_info': info}
        except (OSError, ValueError, SyntaxError):
            return None

    def read_unindexed(paths):
        cached = db.get_gallery_prompt_index_mtimes([relative for _, relative in paths])
        for path, relative in paths:
            if relative in seen:
                continue
            try:
                mtime = os.path.getmtime(path)
                sidecar = os.path.splitext(path)[0] + '.json'
                has_sidecar = os.path.isfile(sidecar)
            except OSError:
                continue
            # A sidecar can change independently of image mtime. Older prompt
            # indexes also let a model-only sidecar hide the PNG's prompt.
            if cached.get(relative) != mtime or has_sidecar:
                row = read_candidate(relative)
                if row is not None:
                    yield row

    try:
        # Streaming index matches are broad candidates. The tag search module
        # checks complete positive tokens, so "hair" cannot match "long hair".
        terms = [[{'text': tag, 'partial': False}]]
        for record in db._iter_gallery_prompt_index_matches(terms, mode='all', positive_only=True):
            row = read_candidate(record[0])
            if row is not None:
                yield row
        paths = []
        for scan_root, directories, files in os.walk(CLASSIFIED_DIR):
            directories[:] = sorted(d for d in directories
                if not should_skip_gallery_index_child_directory(scan_root, d)
                and not (scan_root == CLASSIFIED_DIR and d == '_TRASH'))
            if should_skip_gallery_index_directory(scan_root):
                directories[:] = []
                continue
            for name in sorted(files):
                if not name.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')):
                    continue
                path = os.path.join(scan_root, name)
                relative = os.path.relpath(path, CLASSIFIED_DIR).replace('\\', '/')
                paths.append((path, relative))
                if len(paths) == 256:
                    yield from read_unindexed(paths)
                    paths.clear()
        if paths:
            yield from read_unindexed(paths)
    finally:
        db.close()
    yield from DAKI_DRAFTS.iter_completed_prompt_images()
    yield from DAKI_STYLE_TESTS.iter_completed_prompt_images()


def public_gallery_prompt_search_job(job):
    result = job.get("result") or {}
    return {
        "id": job.get("id", ""),
        "running": bool(job.get("running")),
        "done": bool(job.get("done")),
        "cancel_requested": bool(job.get("cancel_requested")),
        "cancelled": bool(job.get("cancelled")),
        "processed": int(job.get("processed") or 0),
        "total": int(job.get("total") or 0),
        "message": job.get("message", ""),
        "error": job.get("error", ""),
        "started_at": job.get("started_at", 0),
        "updated_at": job.get("updated_at", 0),
        "finished_at": job.get("finished_at", 0),
        "result": result
    }


def update_gallery_prompt_search_job(job_id, **kwargs):
    with GALLERY_PROMPT_SEARCH_LOCK:
        job = GALLERY_PROMPT_SEARCH_JOBS.get(job_id)
        if not job or job.get("done"):
            return
        cancel_event = job.get("_cancel_event")
        if cancel_event is not None and cancel_event.is_set():
            if not kwargs.get("done"):
                return
            # Cancellation and completion share this lock; keep collected matches
            # even when cancellation arrives while the final payload is built.
            result = kwargs.get("result") or {
                "image_paths": [], "folder_counts": {}, "total_matches": 0, "indexed": False
            }
            kwargs = {
                "running": False,
                "done": True,
                "cancelled": True,
                "cancel_requested": True,
                "message": "프롬프트 검색을 취소했습니다.",
                "error": "",
                "result": {**result, "partial": True},
                "processed": kwargs.get("processed", job.get("processed", 0)),
                "finished_at": time.time(),
            }
        job.update(kwargs)
        job["updated_at"] = time.time()


def gallery_prompt_search_worker(job_id, query, scope_paths, mode):
    try:
        terms = split_gallery_prompt_search_terms(query)
        profile_id = ""

        with GALLERY_PROMPT_SEARCH_LOCK:
            job = GALLERY_PROMPT_SEARCH_JOBS.get(job_id)
            if not job:
                return
            profile_id = str(job.get("profile_id") or "")
            cancel_event = job.get("_cancel_event")

        if cancel_event is not None and cancel_event.is_set():
            update_gallery_prompt_search_job(job_id, done=True)
            return

        if not terms:
            payload = {"image_paths": [], "folder_counts": {}, "total_matches": 0, "indexed": True}
            update_gallery_prompt_search_job(
                job_id,
                running=False,
                done=True,
                processed=0,
                total=0,
                message="검색어가 비어 있습니다.",
                result=payload,
                finished_at=time.time()
            )
            return

        db = utils.HistoryDB()

        try:
            if profile_id:
                profile_paths = db.get_gallery_prompt_index_profile_paths(profile_id)
                index_status = {"indexed_images": len(profile_paths)}
            else:
                index_status = db.get_gallery_prompt_index_status(scope_paths, mode)
            indexed_total = int(index_status.get("indexed_images") or 0)
            update_gallery_prompt_search_job(
                job_id,
                total=indexed_total,
                processed=0,
                message="프롬프트 인덱스 검색 중..."
            )
            rows = db.search_gallery_prompt_index_profile(profile_id, terms) if profile_id else db.search_gallery_prompt_index(terms, scope_paths, mode)
        finally:
            db.close()

        indexed = indexed_total > 0

        if cancel_event is not None and cancel_event.is_set():
            update_gallery_prompt_search_job(
                job_id, done=True, processed=indexed_total,
                result={**build_gallery_prompt_search_payload(rows), "indexed": indexed},
            )
            return

        if indexed:
            processed = indexed_total
        else:
            processed_holder = {"value": 0}

            def progress(total=0, processed=0, message="검색 중..."):
                processed_holder["value"] = int(processed or 0)
                update_gallery_prompt_search_job(
                    job_id,
                    total=int(total or 0),
                    processed=int(processed or 0),
                    message=message
                )

            rows = search_gallery_prompts_without_index(
                query, scope_paths, mode, progress=progress, cancel_event=cancel_event
            )
            processed = processed_holder["value"]

        payload = build_gallery_prompt_search_payload(rows)
        update_gallery_prompt_search_job(
            job_id,
            running=False,
            done=True,
            processed=processed,
            message="프롬프트 검색 완료",
            result={**payload, "indexed": indexed},
            finished_at=time.time()
        )
    except Exception as e:
        update_gallery_prompt_search_job(
            job_id,
            running=False,
            done=True,
            error=str(e),
            message="프롬프트 검색 실패",
            finished_at=time.time()
        )


@app.route('/api/gallery/prompt_index/status')
def gallery_prompt_index_status():
    if request.args.get("job_only") == "1":
        with GALLERY_PROMPT_INDEX_LOCK:
            job = dict(GALLERY_PROMPT_INDEX_JOB)
        return jsonify({"status": "success", "job": job})

    scope_paths = normalize_gallery_prompt_scope_paths(request.args.getlist("scope_path") or request.args.get("scope_path") or "")
    mode = request.args.get("mode", "all")
    target_files = iter_gallery_prompt_index_files(scope_paths, mode)
    db = utils.HistoryDB()

    try:
        status = db.get_gallery_prompt_index_status(scope_paths, mode)
        profiles = db.list_gallery_prompt_index_profiles()
        missing_count = len(
            filter_gallery_prompt_index_files(db, target_files, missing_only=True)
        )
    finally:
        db.close()

    with GALLERY_PROMPT_INDEX_LOCK:
        job = dict(GALLERY_PROMPT_INDEX_JOB)

    return jsonify({
        "status": "success",
        **status,
        "target_images": len(target_files),
        "missing_images": missing_count,
        "profiles": profiles,
        "job": job
    })


@app.route('/api/gallery/prompt_search/start', methods=['POST'])
def gallery_prompt_search_start():
    data = request.json or {}
    query = data.get("query") or ""
    mode = data.get("mode") or "all"
    profile_id = str(data.get("profile_id") or "")
    scope_paths = normalize_gallery_prompt_scope_paths(
        data.get("scope_paths") if "scope_paths" in data else data.get("scope_path")
    )
    job_id = f"prompt_search_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
    now = time.time()

    with GALLERY_PROMPT_SEARCH_LOCK:
        GALLERY_PROMPT_SEARCH_JOBS[job_id] = {
            "id": job_id,
            "running": True,
            "done": False,
            "cancel_requested": False,
            "cancelled": False,
            "_cancel_event": threading.Event(),
            "processed": 0,
            "total": 0,
            "message": "프롬프트 검색 준비 중...",
            "error": "",
            "result": {},
            "profile_id": profile_id,
            "started_at": now,
            "updated_at": now,
            "finished_at": 0
        }

    threading.Thread(
        target=gallery_prompt_search_worker,
        args=(job_id, query, scope_paths, mode),
        daemon=True
    ).start()

    with GALLERY_PROMPT_SEARCH_LOCK:
        payload = public_gallery_prompt_search_job(GALLERY_PROMPT_SEARCH_JOBS[job_id])

    return jsonify({"status": "success", "job": payload})


@app.route('/api/gallery/prompt_index/profile/<profile_id>', methods=['DELETE'])
def gallery_prompt_index_profile_delete(profile_id):
    db = utils.HistoryDB()
    try:
        deleted = db.delete_gallery_prompt_index_profile(profile_id)
    finally:
        db.close()

    return jsonify({
        "status": "success",
        "deleted": bool(deleted)
    })


@app.route('/api/gallery/prompt_search/status/<job_id>')
def gallery_prompt_search_status(job_id):
    with GALLERY_PROMPT_SEARCH_LOCK:
        job = GALLERY_PROMPT_SEARCH_JOBS.get(job_id)
        payload = public_gallery_prompt_search_job(job) if job else None

    if payload is None:
        return jsonify({"status": "error", "message": "검색 작업을 찾을 수 없습니다."}), 404

    return jsonify({"status": "success", "job": payload})


@app.route('/api/gallery/prompt_search/cancel/<job_id>', methods=['POST'])
def gallery_prompt_search_cancel(job_id):
    with GALLERY_PROMPT_SEARCH_LOCK:
        job = GALLERY_PROMPT_SEARCH_JOBS.get(job_id)
        if not job:
            return jsonify({"status": "error", "message": "검색 작업을 찾을 수 없습니다."}), 404
        if not job.get("done"):
            job["_cancel_event"].set()
            job["cancel_requested"] = True
            job["message"] = "프롬프트 검색 취소 중..."
            job["updated_at"] = time.time()
        payload = public_gallery_prompt_search_job(job)

    return jsonify({"status": "success", "job": payload})


@app.route('/api/gallery/prompt_index/rebuild', methods=['POST'])
def gallery_prompt_index_rebuild():
    data = request.json or {}
    scope_paths = normalize_gallery_prompt_scope_paths(
        data.get("scope_paths") if "scope_paths" in data else data.get("scope_path")
    )
    scope_label = scope_paths[0] if len(scope_paths) == 1 else f"{len(scope_paths)} scopes"
    mode = data.get("mode") or "all"
    rebuild = bool(data.get("rebuild"))
    missing_only = bool(data.get("missing_only"))
    start_message = "프롬프트 인덱스 재생성 준비 중..." if rebuild else ("프롬프트 인덱스 새 파일 추가 준비 중..." if missing_only else "프롬프트 인덱스 갱신 준비 중...")

    with GALLERY_PROMPT_INDEX_LOCK:
        if GALLERY_PROMPT_INDEX_JOB.get("running"):
            return jsonify({"status": "success", **dict(GALLERY_PROMPT_INDEX_JOB)})

        GALLERY_PROMPT_INDEX_JOB.update({
            "running": True,
            "processed": 0,
            "total": 0,
            "message": "프롬프트 인덱스 재생성 준비 중..." if rebuild else "프롬프트 인덱스 갱신 준비 중...",
            "error": "",
            "done": False,
            "started_at": time.time(),
            "finished_at": 0,
            "scope_path": scope_label,
            "mode": mode
        })

    threading.Thread(
        target=gallery_prompt_index_worker,
        args=(scope_paths, mode, rebuild, missing_only),
        daemon=True
    ).start()

    with GALLERY_PROMPT_INDEX_LOCK:
        payload = dict(GALLERY_PROMPT_INDEX_JOB)

    return jsonify({"status": "success", **payload})


@app.route('/api/gallery/prompt_index', methods=['DELETE'])
def gallery_prompt_index_delete_all():
    with GALLERY_PROMPT_INDEX_LOCK:
        if GALLERY_PROMPT_INDEX_JOB.get("running"):
            return jsonify({
                "status": "error",
                "message": "프롬프트 인덱스 작업이 진행 중입니다. 완료 후 삭제해 주세요."
            }), 409

    db = utils.HistoryDB()
    try:
        db.clear_all_gallery_prompt_index_data()
    finally:
        db.close()

    with GALLERY_PROMPT_INDEX_LOCK:
        GALLERY_PROMPT_INDEX_JOB.update({
            "running": False,
            "processed": 0,
            "total": 0,
            "message": "프롬프트 인덱스를 삭제했습니다.",
            "error": "",
            "done": True,
            "finished_at": time.time()
        })

    return jsonify({"status": "success", "deleted": True})


@app.route('/api/gallery/prompt_search', methods=['POST'])
def gallery_prompt_search():
    data = request.json or {}
    query = data.get("query") or ""
    scope_paths = normalize_gallery_prompt_scope_paths(
        data.get("scope_paths") if "scope_paths" in data else data.get("scope_path")
    )
    mode = data.get("mode") or "all"
    terms = split_gallery_prompt_search_terms(query)

    if not terms:
        return jsonify({
            "status": "success",
            "image_paths": [],
            "folder_counts": {},
            "total_matches": 0,
            "indexed": True
        })

    db = utils.HistoryDB()

    try:
        index_status = db.get_gallery_prompt_index_status(scope_paths, mode)
        rows = db.search_gallery_prompt_index(terms, scope_paths, mode)
    finally:
        db.close()

    indexed = int(index_status.get("indexed_images") or 0) > 0

    if not indexed:
        rows = search_gallery_prompts_without_index(query, scope_paths, mode)

    payload = build_gallery_prompt_search_payload(rows)
    return jsonify({
        "status": "success",
        **payload,
        "indexed": indexed
    })


def get_gallery_history_db():
    """Open the normal history DB, with an opt-in path for isolated callers/tests."""
    configured_path = app.config.get("GALLERY_HISTORY_DB_PATH")
    if configured_path is None:
        configured_path = app.config.get("HISTORY_DB_PATH")
    return utils.HistoryDB(configured_path) if configured_path else utils.HistoryDB()


def normalize_virtual_folder_scope_paths(value):
    scopes = normalize_gallery_prompt_scope_paths(value)
    for scope in scopes:
        if any(part == ".." for part in scope.split("/") if part):
            raise ValueError("가상 폴더 검색 범위가 올바르지 않습니다.")
        if scope:
            utils.resolve_safe_path(CLASSIFIED_DIR, scope, strip_prefix="TOTAL_CLASSIFIED/")
    return scopes


def virtual_folder_payload(db, folder, summary=False):
    """Resolve only the folder's persisted query/scope/mode on every request."""
    if not folder.get("query"):
        payload = {
            "image_paths": [],
            "folder_counts": {},
            "total_matches": 0,
            "indexed": True
        }
        if summary:
            payload["thumb"] = None
        return payload

    query = folder.get("query") or ""
    scope_paths = normalize_virtual_folder_scope_paths(folder.get("scope_paths") or [])
    mode = folder.get("mode") or "all"
    terms = split_gallery_prompt_search_terms(query)
    if not terms:
        payload = {
            "image_paths": [],
            "folder_counts": {},
            "total_matches": 0,
            "indexed": True
        }
        if summary:
            payload["thumb"] = None
        return payload

    index_status = db.get_gallery_prompt_index_status(
        scope_paths, mode, positive_only=True
    )
    indexed = int(index_status.get("indexed_images") or 0) > 0
    prompt_revision = db.get_gallery_index_state("prompt_index_updated_at")

    # Keep the legacy filesystem fallback when this scope/mode has no indexed
    # rows yet.  A revision marker alone can also exist immediately after an
    # index clear, so it is not sufficient to claim the DB index is ready.
    if prompt_revision and indexed:
        cache_result = db.resolve_gallery_virtual_folder_cache(
            folder, terms, include_items=not summary
        )
        if summary:
            return {
                "image_paths": [],
                "folder_counts": {},
                "total_matches": cache_result["total_matches"],
                "thumb": cache_result["thumb"],
                "indexed": cache_result["indexed"],
                "cached": cache_result["cached"],
            }
        rows = cache_result.get("rows") or []
        return {
            **build_gallery_prompt_search_payload(rows),
            "indexed": cache_result["indexed"],
            "cached": cache_result["cached"],
        }

    if indexed:
        rows = db.search_gallery_prompt_index(
            terms, scope_paths, mode, positive_only=True
        )
    else:
        rows = search_gallery_prompts_without_index(
            query, scope_paths, mode, positive_only=True
        )

    if summary:
        thumb = None
        total_matches = 0
        for row in rows:
            rel_path = clean_gallery_rel_path(row.get("rel_path"))
            if not rel_path:
                continue
            total_matches += 1
            if thumb is None:
                thumb = rel_path
        return {
            "image_paths": [],
            "folder_counts": {},
            "total_matches": total_matches,
            "thumb": thumb,
            "indexed": indexed,
            "cached": False
        }

    return {**build_gallery_prompt_search_payload(rows), "indexed": indexed, "cached": False}


def virtual_folder_error(message, status_code=400):
    return jsonify({"status": "error", "message": str(message)}), status_code


def virtual_folder_request_data(data, current=None):
    data = data if isinstance(data, dict) else {}
    current = current or {}
    result = {}

    if "name" in data:
        result["name"] = data.get("name")
    if "query" in data:
        result["query"] = data.get("query")
    if "scope_paths" in data or "scope_path" in data:
        raw_scopes = data.get("scope_paths") if "scope_paths" in data else data.get("scope_path")
        result["scope_paths"] = normalize_virtual_folder_scope_paths(raw_scopes)
    if "mode" in data:
        result["mode"] = data.get("mode")
    if "parent_id" in data or "parentId" in data:
        result["parent_id"] = data.get("parent_id") if "parent_id" in data else data.get("parentId")
    if "order_index" in data or "orderIndex" in data:
        result["order_index"] = data.get("order_index") if "order_index" in data else data.get("orderIndex")
    return result


@app.route('/api/gallery/virtual_folders', methods=['GET'])
def gallery_virtual_folder_list():
    parent_id = request.args.get("parent_id", "__all__")
    if parent_id.lower() in {"null", "root"}:
        parent_id = None
    db = get_gallery_history_db()
    try:
        folders = db.list_gallery_virtual_folders(parent_id)
    finally:
        db.close()
    return jsonify({"status": "success", "folders": folders})


@app.route('/api/gallery/virtual_folders', methods=['POST'])
def gallery_virtual_folder_create():
    data = request.json or {}
    try:
        values = virtual_folder_request_data(data)
        if "name" not in values:
            return virtual_folder_error("가상 폴더 이름이 필요합니다.")
        db = get_gallery_history_db()
        try:
            folder = db.create_gallery_virtual_folder(
                name=values["name"],
                query=values.get("query", ""),
                scope_paths=values.get("scope_paths", []),
                mode=values.get("mode", "all"),
                parent_id=values.get("parent_id"),
                order_index=values.get("order_index", 0)
            )
        finally:
            db.close()
        return jsonify({"status": "success", "folder": folder}), 201
    except ValueError as error:
        message = str(error)
        return virtual_folder_error(message, 409 if "이미" in message or "상위" in message or "자기" in message else 400)


@app.route('/api/gallery/virtual_folders/<folder_id>', methods=['GET'])
def gallery_virtual_folder_get(folder_id):
    db = get_gallery_history_db()
    try:
        folder = db.get_gallery_virtual_folder(folder_id)
        children = db.list_gallery_virtual_folders(folder_id) if folder else []
    finally:
        db.close()
    if not folder:
        return virtual_folder_error("가상 폴더를 찾을 수 없습니다.", 404)
    return jsonify({"status": "success", "folder": folder, "children": children})


@app.route('/api/gallery/virtual_folders/<folder_id>', methods=['PATCH', 'PUT'])
def gallery_virtual_folder_update(folder_id):
    db = get_gallery_history_db()
    try:
        if not db.get_gallery_virtual_folder(folder_id):
            return virtual_folder_error("가상 폴더를 찾을 수 없습니다.", 404)
        values = virtual_folder_request_data(request.json or {})
        folder = db.update_gallery_virtual_folder(folder_id, **values)
    except ValueError as error:
        message = str(error)
        return virtual_folder_error(message, 409 if ("이미" in message or "상위" in message or "자기" in message or "순환" in message) else 400)
    finally:
        db.close()
    return jsonify({"status": "success", "folder": folder})


@app.route('/api/gallery/virtual_folders/<folder_id>', methods=['DELETE'])
def gallery_virtual_folder_delete(folder_id):
    db = get_gallery_history_db()
    try:
        if not db.get_gallery_virtual_folder(folder_id):
            return virtual_folder_error("가상 폴더를 찾을 수 없습니다.", 404)
        deleted = db.delete_gallery_virtual_folder(folder_id)
    except ValueError as error:
        return virtual_folder_error(str(error), 409)
    finally:
        db.close()
    return jsonify({"status": "success", "deleted": bool(deleted)})


@app.route('/api/gallery/virtual_folders/<folder_id>/reparent', methods=['POST'])
def gallery_virtual_folder_reparent(folder_id):
    data = request.json or {}
    try:
        parent_id = data.get("parent_id") if "parent_id" in data else data.get("parentId")
        values = {"parent_id": parent_id}
        if "order_index" in data or "orderIndex" in data:
            values["order_index"] = data.get("order_index") if "order_index" in data else data.get("orderIndex")
        db = get_gallery_history_db()
        try:
            folder = db.reparent_gallery_virtual_folder(folder_id, **values)
        finally:
            db.close()
        if not folder:
            return virtual_folder_error("가상 폴더를 찾을 수 없습니다.", 404)
        return jsonify({"status": "success", "folder": folder})
    except ValueError as error:
        message = str(error)
        return virtual_folder_error(message, 409 if ("상위" in message or "자기" in message or "순환" in message) else 400)


def gallery_virtual_folder_resolve(folder_id):
    db = get_gallery_history_db()
    try:
        folder = db.get_gallery_virtual_folder(folder_id)
        if not folder:
            return virtual_folder_error("가상 폴더를 찾을 수 없습니다.", 404)
        summary_value = str(request.args.get("summary") or "").strip().lower()
        summary = summary_value in {"1", "true", "yes", "on"}
        result = virtual_folder_payload(db, folder, summary=summary)
    except ValueError as error:
        return virtual_folder_error(str(error), 400)
    finally:
        db.close()
    return jsonify({"status": "success", "folder": folder, **result})


def gallery_virtual_folder_uncategorized_summary(owner_id=None):
    """Return the indexed count/thumb for images outside an owner's descendants."""
    requested_owner = owner_id
    if requested_owner is None:
        requested_owner = request.args.get("owner_id") or request.args.get("ownerId")
    clean_owner = str(requested_owner or "").strip()
    if clean_owner.lower() in {"", "root", "null"}:
        clean_owner = None

    db = get_gallery_history_db()
    try:
        result = db.summarize_gallery_virtual_uncategorized(
            clean_owner, include_paths=request.args.get('include_paths') == '1')
    except ValueError as error:
        return virtual_folder_error(str(error), 404)
    finally:
        db.close()
    return jsonify({"status": "success", "owner_id": clean_owner or "root", **result})


@app.route('/api/gallery/virtual_folders/uncategorized_summary', methods=['GET'])
def gallery_virtual_folder_uncategorized_summary_route():
    return gallery_virtual_folder_uncategorized_summary()


@app.route('/api/gallery/virtual_folders/<folder_id>/uncategorized_summary', methods=['GET'])
def gallery_virtual_folder_uncategorized_summary_for_folder_route(folder_id):
    return gallery_virtual_folder_uncategorized_summary(folder_id)


@app.route('/api/gallery/virtual_folders/<folder_id>/resolve', methods=['GET'])
def gallery_virtual_folder_resolve_route(folder_id):
    return gallery_virtual_folder_resolve(folder_id)


@app.route('/api/gallery/virtual_folders/<folder_id>/search', methods=['GET'])
def gallery_virtual_folder_search_route(folder_id):
    return gallery_virtual_folder_resolve(folder_id)


@app.route('/api/gallery/prompt_index/autocomplete')
def gallery_prompt_index_autocomplete():
    prefix = normalize_gallery_prompt_search_text(request.args.get("q") or "")

    if len(prefix) < 2:
        return jsonify({"status": "success", "items": []})

    scope_path = clean_gallery_rel_path(request.args.get("scope_path") or "")
    mode = request.args.get("mode") or "all"
    positive_only = (request.args.get("source") or "all").strip().lower() == "virtual_folder"
    db = utils.HistoryDB()
    text_column = "positive_normalized_text" if positive_only else "normalized_text"
    clauses = [f"{text_column} LIKE ?"]
    params = [f"%{prefix}%"]

    if scope_path:
        like_value = scope_path.rstrip("/") + "/%"
        clauses.append("(folder_path = ? OR folder_path LIKE ? OR rel_path LIKE ?)")
        params.extend([scope_path, like_value, like_value])

    if mode == "all":
        clauses.append("mode != ?")
        params.append("trash")
    elif mode:
        clauses.append("mode = ?")
        params.append(str(mode))

    try:
        cur = db.conn.cursor()
        cur.execute(
            f"""
            SELECT {text_column}
            FROM gallery_prompt_index
            WHERE {' AND '.join(clauses)}
            LIMIT 200
            """,
            params
        )
        suggestions = []

        for (text,) in cur.fetchall():
            for token in re.split(r"\s+", str(text or "")):
                token = token.strip()
                if len(token) < 2:
                    continue
                if token.startswith(prefix) and token not in suggestions:
                    suggestions.append(token)
                if len(suggestions) >= 20:
                    break
            if len(suggestions) >= 20:
                break
    finally:
        db.close()

    return jsonify({"status": "success", "items": suggestions})


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
    with json_lock(GALLERY_IMAGE_TAGS_FILE):
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
    with json_lock(GALLERY_IMAGE_TAGS_FILE):
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


CANVAS_DISPLAY_PREVIEW_MAX_SIDE = 4096
IMAGE_PREVIEW_CACHE = PreviewCache()


def get_requested_image_preview_max_side():
    raw_value = request.args.get("preview")
    if raw_value is None:
        return 0

    try:
        requested = int(raw_value)
    except (TypeError, ValueError):
        return 0

    return max(256, min(CANVAS_DISPLAY_PREVIEW_MAX_SIDE, requested))


@lru_cache(maxsize=8)
def build_cached_image_preview(file_path, mtime_ns, file_size, max_side):
    return IMAGE_PREVIEW_CACHE.get(
        file_path, mtime_ns, file_size, max_side, build_image_preview_bytes
    )


def build_image_preview_bytes(file_path, max_side):
    with Image.open(file_path) as source:
        preview = ImageOps.exif_transpose(source)
        preview.thumbnail(
            (max_side, max_side),
            Image.Resampling.LANCZOS,
            reducing_gap=3.0
        )

        has_alpha = "A" in preview.getbands() or "transparency" in preview.info
        output = io.BytesIO()

        if has_alpha:
            preview.convert("RGBA").save(output, format="PNG", compress_level=1)
            mimetype = "image/png"
        else:
            preview.convert("RGB").save(output, format="JPEG", quality=88, optimize=False)
            mimetype = "image/jpeg"

    return output.getvalue(), mimetype


def serve_image_preview(file_path, max_side):
    stat = os.stat(file_path)
    preview_bytes, mimetype = build_cached_image_preview(
        file_path,
        stat.st_mtime_ns,
        stat.st_size,
        max_side
    )
    response = send_file(
        io.BytesIO(preview_bytes),
        mimetype=mimetype,
        max_age=0
    )
    response.set_etag(f"{stat.st_mtime_ns:x}-{stat.st_size:x}-{max_side:x}")
    response.cache_control.public = True
    response.cache_control.must_revalidate = True
    return response.make_conditional(request)


def resolve_gallery_file_path(relative):
    path = utils.resolve_safe_path(CLASSIFIED_DIR, relative, strip_prefix="TOTAL_CLASSIFIED/")
    if os.path.exists(path):
        return path
    old_relative = os.path.relpath(path, CLASSIFIED_DIR).replace('\\', '/')
    return resolve_converted_gallery_path(
        CLASSIFIED_DIR, old_relative, os.path.join(CLASSIFIED_DIR, 'naia_history.db')
    ) or path


def resolve_daki_image_path(raw_path):
    # A saved candidate refers to one location. Rating-folder fallbacks could
    # silently replace a missing candidate with a different image of that name.
    relative = clean_gallery_rel_path(raw_path)
    from naim.daki_image_refs import is_daki_image_reference, resolve_daki_image_reference
    if is_daki_image_reference(relative):
        return resolve_daki_image_reference(relative, DAKI_STYLE_TESTS, DAKI_DRAFTS,
                                            project_exports_root=os.path.join(CANVAS_IMPORT_DIR, 'project_exports'))
    full_path = resolve_gallery_file_path(relative)
    if not utils.is_subpath(os.path.realpath(full_path), os.path.realpath(CLASSIFIED_DIR)):
        raise ValueError('갤러리 안의 이미지 경로를 사용해 주세요.')
    if not os.path.isfile(full_path):
        raise FileNotFoundError('후보의 원본 이미지를 찾을 수 없습니다.')
    return full_path, os.path.relpath(full_path, CLASSIFIED_DIR).replace('\\', '/')


from naim.images.gallery_conversion import gallery_image_processor
from naim.jobs.image_conversion import ImageConversionJobs
from naim.web.image_conversion import register_image_conversion_routes

IMAGE_CONVERSION_JOBS = ImageConversionJobs(gallery_image_processor(
    resolve_daki_image_path, lambda: CLASSIFIED_DIR, lambda: GALLERY_IMAGE_TAGS_FILE,
))
register_image_conversion_routes(app, IMAGE_CONVERSION_JOBS, resolve_daki_image_path)
atexit.register(IMAGE_CONVERSION_JOBS.shutdown)


@app.route('/image/<path:filename>')
def serve_image(filename):
    try:
        reference = resolve_daki_image_reference(clean_gallery_rel_path(filename), DAKI_STYLE_TESTS, DAKI_DRAFTS,
                                                 project_exports_root=os.path.join(CANVAS_IMPORT_DIR, 'project_exports'))
        file_path = reference[0] if reference is not None else resolve_gallery_file_path(filename)
    except ValueError:
        return "Invalid path", 400
    except FileNotFoundError:
        return "Not found", 404
    if os.path.exists(file_path):
        preview_max_side = get_requested_image_preview_max_side()
        if preview_max_side:
            return serve_image_preview(file_path, preview_max_side)
        download_name = None
        if reference is not None:
            parsed = parse_daki_image_reference(reference[1])
            if parsed and parsed[0] == 'export':
                try:
                    project = DAKI_PROJECTS.get_project(parsed[1])
                    for candidates in project['candidates'].values():
                        candidate = next((item for item in candidates if item['path'] == reference[1]), None)
                        if candidate and isinstance(candidate.get('name'), str):
                            download_name = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f-\x9f]', '_',
                                                   candidate['name']).rstrip(' .') or None
                            break
                except DakiNotFoundError:
                    pass
        return send_file(file_path, download_name=download_name,
                         mimetype='image/webp' if file_path.lower().endswith('.webp') else None)
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
            full_path = resolve_gallery_file_path(candidate)
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


def resolve_readable_gallery_image_path(raw_path):
    # Daki source folders are readable by gallery tools, but must never flow
    # through the gallery's move, delete, upscale or overwrite resolvers.
    relative = clean_gallery_rel_path(raw_path)
    reference = resolve_daki_image_reference(relative, DAKI_STYLE_TESTS, DAKI_DRAFTS,
                                             project_exports_root=os.path.join(CANVAS_IMPORT_DIR, 'project_exports'))
    return reference if reference is not None else resolve_gallery_image_path(raw_path)

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


def build_gallery_positive_prompt_filter_text(prompt_info):
    """Return only base/character prompt text for virtual-folder searches."""
    prompt_info = prompt_info or {}
    parts = []

    for key in (
        "basePrompt",
        "baseCaption",
        "prompt",
        "base_prompt",
        "charPrompt",
        "characterPrompt",
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

from naim.jobs.upscale import UpscaleJobs, now_iso, public_upscale_job
from naim.web.upscale import UpscaleAPI
from naim.web.lifecycle import register_job_shutdown
from naim.upscale_assets import UPSCALE_ASSETS
from naim.web.upscale_models import register_upscale_model_routes


def get_upscale_nai_key():
    key = read_json(CONFIG_FILE, expected_type=dict).get('key')
    if not isinstance(key, str) or not key.strip():
        raise ValueError('설정에서 NovelAI API 키를 등록해 주세요.')
    return key.strip()

UPSCALE_SERVICE = UpscaleJobs(lambda job, progress: process_gallery_upscale_job(job, progress))
UPSCALE_API = UpscaleAPI(
    UPSCALE_SERVICE, lambda path: clean_gallery_rel_path(path),
    lambda path: resolve_gallery_image_path(path),
    validate_project_context=lambda context, source_path: validate_project_image_context(
        DAKI_PROJECTS, context, source_path,
    ),
    authorize_nai=get_upscale_nai_key,
)
register_upscale_model_routes(app, UPSCALE_ASSETS, busy=UPSCALE_SERVICE.is_busy)
# Legacy internal handles remain aliases; the service owns all mutation.
UPSCALE_JOBS = UPSCALE_SERVICE.jobs
UPSCALE_QUEUE = UPSCALE_SERVICE.queue
UPSCALE_LOCK = UPSCALE_SERVICE.lock
UPSCALE_WORKER_THREAD = None
atexit.register(UPSCALE_SERVICE.shutdown)
atexit.register(UPSCALE_ASSETS.shutdown)
register_job_shutdown(app, UPSCALE_SERVICE, os.environ.get('NAIM_SERVER_CONTROL_TOKEN', ''),
                      additional_jobs=(IMAGE_CONVERSION_JOBS, UPSCALE_ASSETS, DAKI_STYLE_TESTS.test_packs))


@app.route('/api/upscale/nai/preview', methods=['POST'])
def preview_nai_upscale():
    from naim.images.nai_upscale import plan_nai_upscale
    data = request.get_json(silent=True)
    try:
        if not isinstance(data, dict):
            raise ValueError('이미지 크기를 확인해 주세요.')
        plan = plan_nai_upscale(data.get('width'), data.get('height'))
        return jsonify({'status': 'success', 'plan': plan})
    except ValueError as error:
        return jsonify({'status': 'error', 'message': str(error)}), 400






def update_upscale_job(job_id, **patch):
    UPSCALE_SERVICE.update(job_id, **patch)


def add_upscale_sidecar_info(image_path, prompt_info, upscale_info):
    save_prompt_sidecar(image_path, prompt_info)

    sidecar_path = get_prompt_sidecar_path(image_path)

    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except Exception:
        data = normalize_prompt_info_for_sidecar(prompt_info)

    data["upscale"] = upscale_info

    write_json(sidecar_path, data, indent=2)

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


def process_gallery_upscale_job(job, progress_callback):
    if job.get('projectContext') is not None:
        return process_project_upscale_job(
            job,
            progress_callback,
            store=DAKI_PROJECTS,
            export_root=os.path.join(CANVAS_IMPORT_DIR, 'project_exports'),
            prompt_info_loader=lambda path: (
                load_prompt_sidecar(path) or extract_prompt_info_from_image(path)
            ),
            created_at=now_iso,
            **({'nai_api_key': get_upscale_nai_key()} if job.get('engine') == 'nai' else {}),
        )

    cancel_event = job.get("_cancel_event")
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


    result = upscale_logic.run_upscale(
        source_path=source_full_path,
        target_path=target_full_path,
        target_width=target_width,
        target_height=target_height,
        engine=engine,
        quality=quality,
        progress_callback=progress_callback,
        cancel_event=cancel_event,
        **({'nai_api_key': get_upscale_nai_key()} if engine == 'nai' else {}),
        **({'fit_5_16': True} if job.get('fit_5_16') is True and engine != 'nai' else {}),
    )

    if cancel_event and cancel_event.is_set():
        try:
            if os.path.exists(target_full_path):
                os.remove(target_full_path)
        except Exception:
            pass

        raise upscale_logic.UpscaleCancelled()

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
    refresh_gallery_index_for_file_change(
        target_full_path,
        rel_path=result_rel_path,
        mode=infer_gallery_mode_from_rel_path(result_rel_path)
    )

    return {"result_path": result_rel_path, "result_src": result_src,
            "embedded_metadata_saved": embedded_metadata_saved}


def run_upscale_worker_loop():
    return UPSCALE_SERVICE.run()


def ensure_upscale_worker_started():
    global UPSCALE_WORKER_THREAD
    UPSCALE_WORKER_THREAD = UPSCALE_SERVICE.ensure_started()


@app.route('/api/gallery/upscale/start', methods=['POST'])
def start_gallery_upscale():
    return UPSCALE_API.start()


@app.route('/api/gallery/upscale/status/<job_id>')
def get_gallery_upscale_status(job_id):
    return UPSCALE_API.status(job_id)


@app.route('/api/gallery/upscale/jobs')
def list_gallery_upscale_jobs():
    return UPSCALE_API.list()


@app.route('/api/gallery/upscale/cancel/<job_id>', methods=['POST'])
def cancel_gallery_upscale(job_id):
    return UPSCALE_API.cancel(job_id)

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

        full_path, rel_path = resolve_readable_gallery_image_path(raw_path)

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

        full_path, real_rel = resolve_readable_gallery_image_path(rel_path)

        if not os.path.exists(full_path):
            return jsonify({"status": "error", "message": "이미지 파일을 찾을 수 없습니다."})

        sidecar_info = load_prompt_sidecar(full_path)
        embedded_info = extract_prompt_info_from_image(full_path)
        prompt_info = (
            merge_prompt_info_with_fallback(sidecar_info, embedded_info)
            if sidecar_info
            else embedded_info
        )

        fallback = daki_image_prompt_fallback(real_rel, DAKI_STYLE_TESTS)
        prompt_info = merge_prompt_info_with_fallback(prompt_info, fallback) if fallback else prompt_info or {}
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
    db = None

    try:
        data = request.json or {}
        input_path = data.get('path', '')

        full_path, rel_path = resolve_gallery_image_path(input_path)

        if not os.path.exists(full_path):
            return jsonify({"status": "error", "message": "파일을 찾을 수 없습니다."})

        is_currently_nsfw = rel_path.startswith("_R-18/") or rel_path.startswith("_R-15/")

        if is_currently_nsfw:
            target_rel_path = re.sub(r"^_R-(18|15)/", "", rel_path)
            target_mode = "general"
            label = "일반 폴더로 이동"
            override_value = 0
        else:
            target_rel_path = "_R-18/" + rel_path
            target_mode = "r18"
            label = "R-18로 이동"
            override_value = 2

        new_full_path = utils.resolve_safe_path(CLASSIFIED_DIR, target_rel_path)
        os.makedirs(os.path.dirname(new_full_path), exist_ok=True)

        os.replace(full_path, new_full_path)

        old_txt = os.path.splitext(full_path)[0] + ".txt"
        new_txt = os.path.splitext(new_full_path)[0] + ".txt"
        reason_text = f"✅ [수동] 사용자 분류 ({label})"

        try:
            with open(new_txt, "w", encoding="utf-8") as f:
                f.write(reason_text)

            if os.path.exists(old_txt) and os.path.abspath(old_txt) != os.path.abspath(new_txt):
                os.remove(old_txt)
        except Exception as txt_e:
            print(f"사유 텍스트 파일 생성/이동 실패: {txt_e}")

        move_gallery_image_tag_path(rel_path, target_rel_path)

        db = utils.HistoryDB()

        db.remove_gallery_image_record(rel_path)

        tag_config = load_gallery_image_tags_config()
        gallery_tag = get_gallery_image_tag_for_path(tag_config, target_rel_path)

        db.upsert_gallery_image_file(
            new_full_path,
            classified_root=CLASSIFIED_DIR,
            mode=target_mode,
            reason=reason_text,
            gallery_tag=gallery_tag
        )

        file_hash = db.get_hash(new_full_path)

        if file_hash:
            with db.conn:
                db.conn.execute(
                    "CREATE TABLE IF NOT EXISTS manual_overrides (file_hash TEXT PRIMARY KEY, is_nsfw INTEGER)"
                )
                db.conn.execute(
                    "INSERT OR REPLACE INTO manual_overrides (file_hash, is_nsfw) VALUES (?, ?)",
                    (file_hash, override_value)
                )

        db.rebuild_gallery_folder_summaries()

        return jsonify({
            "status": "success",
            "new_path": target_rel_path,
            "is_nsfw": not is_currently_nsfw
        })

    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)})
    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
    finally:
        if db:
            try:
                db.close()
            except Exception:
                pass

@app.route('/api/apply', methods=['POST'])
def apply_changes():
    data = request.json
    try:
        warning = daki_delete_warning(data, paths=data.get('deletes'), folders=data.get('delete_folders'))
        if warning is not None:
            return warning
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

@app.route('/api/gallery/trash_image', methods=['POST'])
def trash_gallery_image():
    data = request.json or {}
    try:
        relative = str(data.get('path') or '').replace('\\', '/')
        full_path = resolve_gallery_file_path(relative)
        if utils.is_subpath(full_path, os.path.join(CLASSIFIED_DIR, '_TRASH')):
            return jsonify({'status': 'error', 'message': '이미 휴지통에 있는 그림입니다.'}), 400
        if not full_path.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) or not os.path.isfile(full_path):
            return jsonify({'status': 'error', 'message': '이동할 그림을 찾을 수 없습니다.'}), 404
        relative = os.path.relpath(full_path, CLASSIFIED_DIR).replace('\\', '/')
        warning = daki_delete_warning(data, paths=[relative])
        if warning is not None:
            return warning
        image_logic.handle_integrated_tasks(CLASSIFIED_DIR, {'deletes': [relative]}, log_func=lambda _message: None)
        # The legacy batch handler logs individual failures instead of raising.
        if os.path.exists(full_path):
            return jsonify({'status': 'error', 'message': '휴지통으로 보내지 못했습니다. 파일 사용 상태를 확인하고 다시 시도하세요.'}), 409
        return jsonify({'status': 'success', 'path': relative})
    except ValueError:
        return jsonify({'status': 'error', 'message': '허용되지 않은 이미지 경로입니다.'}), 400
    except Exception:
        return jsonify({'status': 'error', 'message': '휴지통 이동 중 오류가 발생했습니다.'}), 500


@app.route('/api/restore', methods=['POST'])
def restore_file():
    data = request.json
    rel_path = data.get('path', '').replace('\\', '/')
    try:
        trash_full_path = resolve_gallery_file_path(rel_path)
        rel_path = os.path.relpath(trash_full_path, CLASSIFIED_DIR).replace('\\', '/')
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
        restored_rel_path = os.path.relpath(original_path, CLASSIFIED_DIR).replace("\\", "/")
        refresh_gallery_index_for_file_change(
            original_path,
            rel_path=restored_rel_path,
            old_rel_path=rel_path,
            mode=infer_gallery_mode_from_rel_path(restored_rel_path)
        )
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

    warning = daki_delete_warning(data, folders=[os.path.relpath(target_dir, CLASSIFIED_DIR).replace('\\', '/')])
    if warning is not None:
        return warning
    db = utils.HistoryDB()
    try:
        shutil.rmtree(target_dir) # 폴더 내의 모든 파일 통째로 삭제
        db.remove_trash_folder(target_dir) # 관련된 휴지통 맵핑 기록 일괄 삭제
        
        # 🌟 [추가] 휴지통 폴더 내에 남아있던 그림체 스캔 등 모든 하위 찌꺼기 기록 완벽 정리
        folder_rel_path = f"_TRASH/{folder_name}"
        db.remove_folder_records(folder_rel_path)
        with GALLERY_INDEX_DB_LOCK:
            db.remove_gallery_folder_records(folder_rel_path)
            db.rebuild_gallery_folder_summaries()
        
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

ROUTE_TEST_JOBS = {}
ROUTE_TEST_LOCK = threading.Lock()

from naim.gallery.rules import (
    clean_route_prompt_text,
    route_prompt_dedupe_key,
    dedupe_route_prompts,
    parse_route_tags_single,
    parse_route_tag_groups,
    route_prompt_text_from_rule,
    normalize_custom_route_rules,
    route_test_clean_prompt_text,
    route_test_match_keys,
    route_test_prompt_tokens_from_text,
    route_test_prompt_tokens_from_prompt_info,
    route_test_build_key_set,
    route_test_build_match_context,
    route_test_is_like_prompt,
    route_test_like_prompt_inner,
    route_test_rule_prompt_matches,
    route_test_unique_prompts,
    route_test_rule_matches,
    route_test_get_rule_by_path,
    route_test_get_rule_paths,
    route_test_path_key,
    route_test_is_ancestor_path,
    route_test_selected_path_jobs,
    route_test_rule_label_by_path,
    route_test_match_rule_chain,
    route_test_match_selected_rules,
    route_test_flatten_rules,
    route_test_find_matching_route,
    route_test_match_single_rule,
    route_test_build_prompt_rule,
    route_test_run_payload,
    route_test_prompt_preview_from_tokens,
    route_test_prompt_text_from_prompt_info,
    public_route_test_job,
)


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
        elif hasattr(img, "getexif"):
            exif = img.getexif()
            if exif and 37510 in exif:
                raw_meta = decode_exif_user_comment(exif[37510])

        raw_meta = str(raw_meta or "").strip()
        meta = {}
        if raw_meta.startswith("{"):
            meta = _parse_prompt_metadata(raw_meta)
        if not meta:
            meta = _parse_prompt_metadata(_image_info_value_casefold(img, "Comment"))

        if meta:
            generation_metadata = _normalize_extracted_generation_metadata(meta, img)
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
                "charPrompts": char_prompts,
                **({'promptRegions': meta['promptRegions']} if 'promptRegions' in meta else {}),
                **generation_metadata
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
            "charPrompts": [],
            **_normalize_extracted_generation_metadata({}, img)
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


from naim.gallery.art_styles import (
    format_artist_style_prompt_for_daki,
    is_weighted_order_style_prompt,
    cleanup_weighted_order_style_prompt,
    normalize_style_lab_artist_name_from_manager,
    parse_art_style_manager_prompt_to_style_tags,
    make_unique_style_lab_style_name,
)


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

    write_json(ARTISTS_FILE, artists_data, indent=4)

    write_json(STYLES_FILE, styles_data, indent=4)

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
NAI_INPAINT_MODEL = "nai-diffusion-5-full-inpainting"
CANVAS_IMPORT_CLEANUP_CATEGORIES = {"canvas", "canvas_inpaint"}
CANVAS_IMPORT_ALLOWED_CATEGORIES = CANVAS_IMPORT_CLEANUP_CATEGORIES | {"gallery_inpaint"}


def build_inpaint_prompt_info(prompt_info):
    """Validate and attach the selected inpainting generation metadata."""
    info = dict(prompt_info or {})
    info.update(normalize_inpaint_settings(info))
    info["modelName"] = info["model"]
    info["model_name"] = info["model"]
    return normalize_prompt_info_for_sidecar(info)


def safe_canvas_import_token(value, fallback):
    token = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip())
    token = token.strip("._-")
    return token[:80] or fallback


def canvas_import_relative_path(filename):
    return str(filename or "").replace("\\", "/").lstrip("/")


def canvas_import_public_src(filename):
    return f"/canvas-imports/{canvas_import_relative_path(filename)}"


def canvas_upload_original_name(filename):
    name = os.path.basename(str(filename or "").replace("\\", "/")).strip()
    return name or "외부 이미지"


def canvas_upload_extension(filename, content_type=""):
    ext = os.path.splitext(str(filename or ""))[1].lower().lstrip(".")

    if ext == "jpeg":
        ext = "jpg"

    if ext in {"png", "jpg", "webp"}:
        return ext

    content_type = str(content_type or "").lower()
    if "png" in content_type:
        return "png"
    if "jpeg" in content_type or "jpg" in content_type:
        return "jpg"
    if "webp" in content_type:
        return "webp"

    return ""


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

    retained = project_canvas_import_refs()
    deleted = 0
    for root, _, files in os.walk(session_dir):
        for filename in files:
            full_path = os.path.join(root, filename)
            relative = os.path.relpath(full_path, CANVAS_IMPORT_DIR).replace('\\', '/')
            if relative in retained:
                continue
            try:
                os.remove(full_path)
                deleted += 1
            except OSError:
                pass
    remove_empty_canvas_import_dirs()
    return deleted


def project_canvas_import_refs():
    """Protect assets of every linked workspace, including canvases in other tabs."""
    refs = set()
    pending = list(DAKI_PROJECTS.canvas_states())
    pending.extend(project.get('canvasSettings', {}).get('inpaintReference')
                   for project in DAKI_PROJECTS.list_projects())
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
        elif isinstance(value, str):
            ref = extract_canvas_import_ref(value)
            if ref:
                refs.add(ref)
    return refs


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
    retained.update(project_canvas_import_refs())
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
    retained.update(project_canvas_import_refs())
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


def is_canvas_import_image_file(filename):
    return os.path.splitext(str(filename or ""))[1].lower() in {".png", ".jpg", ".jpeg", ".webp"}


def canvas_import_category_label(category):
    labels = {
        "canvas": "외부 이미지",
        "canvas_inpaint": "인페인팅",
        "gallery_inpaint": "갤러리 인페인팅"
    }
    return labels.get(category or "", "기타")


def list_canvas_import_items():
    items = []

    for root, _, files in os.walk(CANVAS_IMPORT_DIR):
        for filename in files:
            if not is_canvas_import_image_file(filename):
                continue

            full_path = os.path.join(root, filename)
            rel_path = os.path.relpath(full_path, CANVAS_IMPORT_DIR).replace("\\", "/")
            parts = rel_path.split("/")
            category = parts[0] if len(parts) >= 3 else ""
            session_id = parts[1] if len(parts) >= 3 else ""

            try:
                stat = os.stat(full_path)
            except OSError:
                continue

            width = 0
            height = 0
            prompt_info = None

            try:
                with Image.open(full_path) as img:
                    width, height = get_display_oriented_image_size(img)
            except Exception:
                pass

            try:
                extracted = extract_prompt_info_from_image(full_path)
                if has_prompt_info_text(extracted):
                    prompt_info = extracted
            except Exception as e:
                print(f"캔버스 외부 이미지 프롬프트 읽기 실패: {rel_path} | {e}")

            items.append({
                "ref": rel_path,
                "src": canvas_import_public_src(rel_path),
                "name": filename,
                "category": category,
                "categoryLabel": canvas_import_category_label(category),
                "sessionId": session_id,
                "size": stat.st_size,
                "mtime": int(stat.st_mtime * 1000),
                "width": width,
                "height": height,
                "promptInfo": prompt_info,
                "hasPromptInfo": has_prompt_info_text(prompt_info)
            })

    items.sort(key=lambda item: item.get("mtime") or 0, reverse=True)
    return items


@app.route('/canvas-imports/<path:filename>')
def serve_canvas_import(filename):
    try:
        file_path = utils.resolve_safe_path(CANVAS_IMPORT_DIR, filename)
    except ValueError:
        return "Invalid path", 400

    if os.path.exists(file_path):
        preview_max_side = get_requested_image_preview_max_side()
        if preview_max_side:
            return serve_image_preview(file_path, preview_max_side)
        return send_file(file_path)

    return "Not found", 404


@app.route('/api/canvas/imports/list')
def list_canvas_imports_route():
    return jsonify({
        "status": "success",
        "items": list_canvas_import_items()
    })


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


@app.route('/api/canvas/upload_image', methods=['POST'])
def canvas_upload_image():
    file_storage = request.files.get("file")

    if not file_storage:
        return jsonify({"status": "error", "message": "이미지 파일이 없습니다."}), 400

    original_name = canvas_upload_original_name(file_storage.filename)
    ext = canvas_upload_extension(original_name, file_storage.content_type)

    if not ext:
        return jsonify({"status": "error", "message": "PNG, JPG, WebP 이미지만 가져올 수 있습니다."}), 400

    raw = file_storage.read()
    if not raw:
        return jsonify({"status": "error", "message": "이미지 파일이 비어 있습니다."}), 400

    width = 0
    height = 0

    try:
        with Image.open(io.BytesIO(raw)) as img:
            img.verify()
        # PNG EXIF inspection may load/close the decoder. Verify on a fresh
        # image first, then inspect orientation using a separate decoder.
        with Image.open(io.BytesIO(raw)) as img:
            width, height = get_display_oriented_image_size(img)
    except Exception:
        return jsonify({"status": "error", "message": "이미지 파일을 읽을 수 없습니다."}), 400

    prompt_info = None
    try:
        temp_file = type("CanvasUploadFile", (), {"stream": io.BytesIO(raw)})()
        extracted = extract_prompt_info_from_image_filelike(temp_file)
        if has_prompt_info_text(extracted):
            prompt_info = extracted
    except Exception as e:
        print(f"⚠️ 외부 캔버스 이미지 프롬프트 읽기 실패: {original_name} | {e}")

    try:
        save_dir, rel_dir = get_canvas_import_save_dir(
            "canvas",
            request.form.get("sessionId") or request.form.get("session_id")
        )
        os.makedirs(save_dir, exist_ok=True)

        filename = f"canvas_upload_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.{ext}"
        file_path = os.path.join(save_dir, filename)
        rel_name = f"{rel_dir}/{filename}" if rel_dir else filename

        with open(file_path, "wb") as f:
            f.write(raw)

        src = canvas_import_public_src(rel_name)

        return jsonify({
            "status": "success",
            "src": src,
            "path": src,
            "name": original_name,
            "width": width,
            "height": height,
            "promptInfo": prompt_info,
            "hasPromptInfo": has_prompt_info_text(prompt_info)
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
        reference = resolve_daki_image_reference(rel_path, DAKI_STYLE_TESTS, DAKI_DRAFTS,
                                                 project_exports_root=os.path.join(CANVAS_IMPORT_DIR, 'project_exports'))
        file_path = reference[0] if reference is not None else resolve_gallery_file_path(rel_path)
        with open(file_path, "rb") as f:
            return f.read()

    raise ValueError("캔버스 이미지 경로를 읽을 수 없습니다.")


from naim.images.inpaint import (
    prepare_inpaint_mask_bytes,
    image_to_png_bytes,
    blend_canvas_inpaint_result_with_source,
)
from naim.images.inpaint_reference import (
    normalize_reference, prepare_reference_input, crop_reference_result, inject_split_screen,
)


def save_canvas_generated_image(raw_bytes, prefix="canvas_inpaint", category=None, session_id=None):
    save_dir, rel_dir = get_canvas_import_save_dir(category, session_id)
    filename = f"{prefix}_{int(time.time() * 1000)}_{random.randint(1000, 9999)}.png"
    file_path = os.path.join(save_dir, filename)
    rel_name = f"{rel_dir}/{filename}" if rel_dir else filename

    with open(file_path, "wb") as f:
        f.write(raw_bytes)

    return canvas_import_public_src(rel_name), rel_name


from naim.web.canvas_retouch import register_canvas_retouch_routes

CANVAS_RETOUCH = register_canvas_retouch_routes(
    app, read_canvas_image_bytes, save_canvas_generated_image,
)


@app.route('/api/canvas/reference_upscale', methods=['POST'])
def canvas_reference_upscale():
    try:
        data = request.json or {}

        image_ref = data.get("image", "")
        if not image_ref:
            return jsonify({"status": "error", "message": "업스케일할 참조 이미지가 없습니다."}), 400

        engine = upscale_logic.normalize_upscale_engine(data.get("engine") or "realcugan")
        fit_5_16 = data.get('fit_5_16') is True and engine != 'nai'
        target_width, target_height = upscale_logic.validate_target_size(
            data.get("target_width", 2500),
            data.get("target_height", 8000)
        )

        quality = str(data.get("quality") or "standard").strip().lower()
        if quality not in ("fast", "standard", "high"):
            quality = "standard"

        source_bytes = read_canvas_image_bytes(image_ref)
        nai_options = {}
        if engine == 'nai':
            from naim.images.nai_upscale import plan_nai_upscale
            if data.get('nai_confirmed') is not True:
                raise ValueError('NAI 자동 맞춤 크기와 Anlas 사용 안내를 확인해 주세요.')
            with Image.open(io.BytesIO(source_bytes)) as source:
                plan = plan_nai_upscale(*source.size)
            if (target_width, target_height) != (plan['output_width'], plan['output_height']):
                raise ValueError('NAI 맞춤 크기를 업스케일 창에서 다시 확인해 주세요.')
            nai_options['nai_api_key'] = get_upscale_nai_key()
        session_id = data.get("sessionId") or None
        save_category = data.get("tempCategory") or data.get("temp_category") or "canvas"
        save_prefix = "canvas_inpaint_upscale" if save_category == "canvas_inpaint" else "canvas_reference_upscale"

        with UPSCALE_SERVICE.direct_operation() as cancel_event, tempfile.TemporaryDirectory(prefix="naia_reference_upscale_") as temp_dir:
            source_path = os.path.join(temp_dir, "source.png")
            target_path = os.path.join(temp_dir, "upscaled.png")

            with Image.open(io.BytesIO(source_bytes)) as img:
                img.convert("RGBA").save(source_path, "PNG")

            result = upscale_logic.run_upscale(
                source_path=source_path,
                target_path=target_path,
                target_width=target_width,
                target_height=target_height,
                engine=engine,
                quality=quality,
                cancel_event=cancel_event,
                **nai_options,
                **({'fit_5_16': True} if fit_5_16 else {}),
            )

            if cancel_event.is_set():
                raise upscale_logic.UpscaleCancelled()

            with open(target_path, "rb") as f:
                result_bytes = f.read()

            src, rel_name = save_canvas_generated_image(
                result_bytes,
                prefix=save_prefix,
                category=save_category,
                session_id=session_id
            )

        return jsonify({
            "status": "success",
            "src": src,
            "name": rel_name,
            "width": result.get("final_width", target_width),
            "height": result.get("final_height", target_height),
            "engine": engine,
            "quality": quality,
            "result": result
        })

    except ValueError as e:
        return jsonify({"status": "error", "message": str(e)}), 400

    except FileNotFoundError as e:
        return jsonify({"status": "error", "message": str(e)}), 404

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


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
    project_context = None
    if 'projectContext' in data:
        try:
            project_context = validate_project_image_context(
                DAKI_PROJECTS,
                data.get('projectContext'),
                data.get('source_path'),
            )['projectContext']
        except (DakiNotFoundError, FileNotFoundError) as error:
            return jsonify({"status": "error", "message": str(error)}), 404
        except (ValueError, TypeError) as error:
            return jsonify({"status": "error", "message": str(error)}), 400

    try:
        prompt_info = build_inpaint_prompt_info(data.get("promptInfo") or {})
    except (ValueError, TypeError) as error:
        return jsonify({"status": "error", "message": str(error)}), 400

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
        reference = normalize_reference(data.get("reference"))
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

    source_size = (width, height)
    request_image_bytes, request_mask_bytes = image_bytes, mask_bytes
    if reference is not None:
        try:
            with Image.open(io.BytesIO(image_bytes)) as source_image:
                if source_image.size != source_size:
                    raise ValueError('작업 영역 크기와 원본 이미지 크기가 일치하지 않습니다.')
            combined = prepare_reference_input(
                image_bytes, mask_bytes, read_canvas_image_bytes(reference['src']), reference,
            )
            request_image_bytes, request_mask_bytes = combined['image'], combined['mask']
            width, height = combined['width'], combined['height']
        except (ValueError, OSError, TypeError) as error:
            return jsonify({"status": "error", "message": str(error)}), 400

    base_prompt = str(prompt_info.get("basePrompt") or data.get("base_prompt") or "").strip()
    if reference is not None:
        # This tag describes the temporary request layout, not the user's saved prompt.
        base_prompt = inject_split_screen(base_prompt)
    char_prompt = str(prompt_info.get("charPrompt") or data.get("char_prompt") or "").strip()
    negative_prompt = str(prompt_info.get("negativePrompt") or data.get("negative_prompt") or "").strip()
    seed = int(prompt_info.get("seed") if prompt_info.get("seed") not in (None, "") else -1)
    if seed < 0:
        seed = random.randint(1, 4294967295)
    prompt_info["seed"] = seed

    strength = float(prompt_info.get("strength") if prompt_info.get("strength") not in (None, "") else 1.0)
    strength = max(0.01, min(1.0, strength))

    char_prompts = normalize_char_prompts(prompt_info)
    char_captions_list = [
        {"char_caption": text, "centers": [{"x": 0.5, "y": 0.5}]}
        for text in char_prompts
    ]

    payload = {
        "input": base_prompt,
        "model": prompt_info["model"],
        "action": "infill",
        "parameters": {
            "width": width,
            "height": height,
            "n_samples": 1,
            "seed": seed,
            "extra_noise_seed": seed,
            "sampler": prompt_info.get("sampler") or "k_euler_ancestral",
            "steps": int(prompt_info.get("steps") or 28),
            "scale": prompt_info["cfg"],
            "negative_prompt": negative_prompt,
            "cfg_rescale": prompt_info["cfg_rescale"],
            "noise_schedule": prompt_info["noise_schedule"],
            "params_version": 3,
            "legacy": False,
            "legacy_v3_extend": False,
            "add_original_image": True,
            "prefer_brownian": True,
            "use_coords": False,
            "image": base64.b64encode(request_image_bytes).decode("utf-8"),
            "mask": base64.b64encode(request_mask_bytes).decode("utf-8"),
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


    apply_inpaint_model_constraints(payload, prompt_info)

    try:
        with generated_image_archive(api_key, payload) as z:
            for filename in z.namelist():
                if filename.endswith('.png'):
                    generated_data = z.read(filename)
                    if reference is not None:
                        generated_data = crop_reference_result(generated_data, source_size, reference['width'])
                    inpainted = blend_canvas_inpaint_result_with_source(
                        image_bytes,
                        generated_data,
                        mask_bytes,
                        feather=int(prompt_info.get("feather") or prompt_info.get("mask_blur") or 0)
                    )
                    img_data = image_to_png_bytes(inpainted, prompt_info)
                    image_data_url = f"data:image/png;base64,{base64.b64encode(img_data).decode('utf-8')}"

                    if project_context is not None:
                        try:
                            validated = validate_project_image_context(
                                DAKI_PROJECTS,
                                project_context,
                                data.get('source_path'),
                            )
                        except (DakiNotFoundError, FileNotFoundError) as error:
                            return jsonify({"status": "error", "message": str(error)}), 404
                        except (ValueError, TypeError) as error:
                            return jsonify({"status": "error", "message": str(error)}), 400
                        saved = save_project_candidate_image(
                            DAKI_PROJECTS,
                            os.path.join(CANVAS_IMPORT_DIR, 'project_exports'),
                            project_context['projectId'],
                            validated['side'],
                            inpainted,
                            prompt_info,
                            source_label='NAI Image Manager Daki Project Inpaint',
                        )
                        return jsonify({
                            "status": "success",
                            "src": saved['src'],
                            "name": os.path.basename(saved['path']),
                            "image": image_data_url,
                            "promptInfo": prompt_info,
                            "model": prompt_info["model"],
                            "sampler": prompt_info.get("sampler"),
                            "steps": prompt_info.get("steps"),
                            "destination": "project",
                            "path": saved['path'],
                            "projectId": project_context['projectId'],
                            "projectName": saved['projectName'],
                            "side": validated['side'],
                            "projectContext": project_context,
                        })

                    if data.get("persistResult") is False:
                        return jsonify({
                            "status": "success",
                            "src": image_data_url,
                            "name": "",
                            "image": image_data_url,
                            "promptInfo": prompt_info
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
                        "image": image_data_url,
                        "promptInfo": prompt_info,
                        "model": prompt_info["model"],
                        "sampler": prompt_info.get("sampler"),
                        "steps": prompt_info.get("steps")
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


# Keep imported/generated drafts across restarts; the list UI deletes them explicitly.


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

    write_json(meta_path, prompt_info or {}, indent=2)

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
                target_rel_path = os.path.relpath(target_path, CLASSIFIED_DIR).replace("\\", "/")
                refresh_gallery_index_for_file_change(
                    target_path,
                    rel_path=target_rel_path,
                    mode=infer_gallery_mode_from_rel_path(target_rel_path),
                    character_names=json.dumps(
                        [c["clean"] for c in detect_canvas_export_characters(prompt_info)],
                        ensure_ascii=False
                    ),
                    is_dakimakura=1
                )

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

        target_full_path = resolve_gallery_file_path(target_path)
        os.makedirs(os.path.dirname(target_full_path), exist_ok=True)

        source_bytes = read_canvas_image_bytes(source_image)

        original_prompt_info = load_prompt_sidecar(target_full_path)

        if not original_prompt_info:
            try:
                original_prompt_info = extract_prompt_info_from_image(target_full_path)
            except Exception:
                original_prompt_info = {}

        source_prompt_info = prompt_info if has_prompt_info_payload(prompt_info) else original_prompt_info
        final_prompt_info = build_inpaint_prompt_info(source_prompt_info)
        from naim.storage.image_files import staged_image_bundle
        with staged_image_bundle(target_full_path) as temp_path:
            with Image.open(io.BytesIO(source_bytes)) as img:
                img = img.convert("RGBA")
                embedded_metadata_saved = save_pil_image_with_prompt_metadata_preserve_extension(
                    img,
                    temp_path,
                    final_prompt_info,
                    source_label="NAI Image Manager Gallery Inpaint Overwrite"
                )
            sidecar_saved = save_prompt_sidecar(temp_path, final_prompt_info)
        target_rel_path = os.path.relpath(target_full_path, CLASSIFIED_DIR).replace("\\", "/")
        sync_gallery_prompt_art_styles_for_path(target_rel_path, final_prompt_info)
        refresh_gallery_index_for_file_change(
            target_full_path,
            rel_path=target_rel_path,
            mode=infer_gallery_mode_from_rel_path(target_rel_path)
        )

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
            source_full_path = resolve_gallery_file_path(source_path)
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
                source_full_path = resolve_gallery_file_path(source_path)
                original_prompt_info = load_prompt_sidecar(source_full_path) or extract_prompt_info_from_image(source_full_path)
            except Exception:
                original_prompt_info = {}
        source_prompt_info = prompt_info if has_prompt_info_payload(prompt_info) else original_prompt_info
        final_prompt_info = build_inpaint_prompt_info(source_prompt_info)

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
            refresh_gallery_index_for_file_change(
                target_full_path,
                rel_path=target_rel_path,
                mode=infer_gallery_mode_from_rel_path(target_rel_path)
            )

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

    if image_logic.is_generic_character_name(text):
        return ""

    blocked = {
        "",
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


def _iter_canvas_export_character_token_keys(prompt_info):
    prompt_info = normalize_prompt_info_for_sidecar(prompt_info or {})

    raw_parts = []

    # normalize_prompt_info_for_sidecar() exposes charPrompt as a joined alias
    # of charPrompts. Use the list as the source so the same prompt is not
    # counted twice merely because both aliases are present.
    char_prompts = prompt_info.get("charPrompts") or []
    if isinstance(char_prompts, list):
        raw_parts.extend(str(item or "") for item in char_prompts if str(item or "").strip())

    # basePrompt/baseCaption can also be aliases after normalization. Keep
    # distinct prompt text, but avoid counting the same normalized value twice.
    seen_base_parts = set()
    for key in ("basePrompt", "baseCaption", "prompt"):
        value = str(prompt_info.get(key) or "").strip()
        if value and value not in seen_base_parts:
            raw_parts.append(value)
            seen_base_parts.add(value)

    token_keys = []

    for part in raw_parts:
        for token in re.split(r"[,;\n]+", str(part or "")):
            key = normalize_canvas_export_character_token(token)
            if key:
                token_keys.append(key)

    return token_keys


def iter_canvas_export_character_tokens(prompt_info):
    return set(_iter_canvas_export_character_token_keys(prompt_info))


def _count_canvas_export_character_matches(token, character_key):
    if not token or not character_key:
        return 0

    # Short ASCII aliases are common words or abbreviations (for example
    # "ta" and "holo"). Only accept them when the whole comma-delimited
    # token is the alias; longer names retain boundary-aware LIKE matching.
    if re.fullmatch(r"[a-z0-9]{1,4}", character_key):
        return 1 if token == character_key else 0

    # Match a known name inside a longer prompt token while keeping names
    # such as "alice" out of unrelated words such as "malice".
    pattern = rf"(?<!\w){re.escape(character_key)}(?!\w)"
    return len(re.findall(pattern, token, flags=re.IGNORECASE))


def detect_canvas_export_characters(prompt_info):
    token_keys = _iter_canvas_export_character_token_keys(prompt_info)

    if not token_keys:
        return []

    found = []
    character_groups = {}

    for item in get_known_character_tags():
        clean = str(item.get("clean", "") or "").strip()
        if not clean or image_logic.is_generic_character_name(clean):
            continue

        group_key = clean.lower()
        group = character_groups.setdefault(group_key, {"item": item, "keys": set()})
        group["keys"].update({
            normalize_canvas_export_character_token(item.get("clean", "")),
            normalize_canvas_export_character_token(item.get("tag", ""))
        })

    for group in character_groups.values():
        item = group["item"]
        keys = {key for key in group["keys"] if key}

        matched = any(
            _count_canvas_export_character_matches(token, key)
            for token in token_keys
            for key in keys
        )
        if matched:
            found.append(item)

    found.sort(key=lambda item: len(item.get("clean", "")), reverse=True)

    return found

def build_canvas_export_folder(chars, is_dakimakura):
    if not chars:
        if is_dakimakura:
            return os.path.join(CLASSIFIED_DIR, "No_Metadata", "dakimakura")
        return os.path.join(CLASSIFIED_DIR, "No_Metadata")

    if len(chars) == 1:
        folder = safe_folder_name(chars[0]["clean"])
        if is_dakimakura:
            folder = f"{folder}_Dakimakura"
        return os.path.join(CLASSIFIED_DIR, "1_Solo", folder)

    if len(chars) == 2:
        names = [safe_folder_name(c["clean"]) for c in chars[:2]]
        folder = "_and_".join(names)
        if is_dakimakura:
            folder = f"{folder}_Dakimakura"
        return os.path.join(CLASSIFIED_DIR, "2_Duo", folder)

    names = [safe_folder_name(c["clean"]) for c in chars[:4]]
    folder = "_and_".join(names)
    if is_dakimakura:
        folder = f"{folder}_Dakimakura"
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
        if not isinstance(data, dict):
            return jsonify({"status": "error", "message": "요청 내용은 JSON 객체여야 합니다."}), 400

        destination = data.get("destination", "gallery")
        if destination not in ("gallery", "project"):
            return jsonify({"status": "error", "message": "내보낼 위치가 올바르지 않습니다."}), 400

        image_data = data.get("image", "")
        prompt_info = data.get("promptInfo")
        if prompt_info is None:
            prompt_info = {}
        if not isinstance(prompt_info, dict):
            return jsonify({"status": "error", "message": "프롬프트 정보는 JSON 객체여야 합니다."}), 400
        width = int(data.get("width") or 0)
        height = int(data.get("height") or 0)
        is_dakimakura = bool(data.get("isDakimakura"))

        if not image_data:
            return jsonify({"status": "error", "message": "이미지 데이터가 없습니다."}), 400

        if destination == "project":
            try:
                img = decode_canvas_data_url(image_data)
            except (ValueError, TypeError, OSError):
                return jsonify({"status": "error", "message": "내보낼 이미지 데이터를 읽을 수 없습니다."}), 400
            try:
                return jsonify(save_project_canvas_export(
                    DAKI_PROJECTS, os.path.join(CANVAS_IMPORT_DIR, 'project_exports'),
                    data.get("projectId"), data.get("canvasId"), img, prompt_info,
                ))
            except (DakiNotFoundError, FileNotFoundError) as error:
                return jsonify({"status": "error", "message": str(error)}), 404
            except ValueError as error:
                return jsonify({"status": "error", "message": str(error)}), 400
            except OSError:
                return jsonify({"status": "error", "message": "프로젝트에 통합 이미지를 저장하지 못했습니다."}), 500
            finally:
                img.close()

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

        db = utils.HistoryDB()
        index_updated = False
        index_full_built = False
        index_verified = False
        index_rebuild_started = False
        index_rebuild_running = False

        try:
            with GALLERY_INDEX_DB_LOCK:
                index_full_built = db.has_full_gallery_index()

                if index_full_built:
                    gallery_tag_config = load_gallery_image_tags_config()
                    gallery_record = db.upsert_gallery_image_file(
                        save_path,
                        classified_root=CLASSIFIED_DIR,
                        rel_path=rel_path,
                        mode=infer_gallery_mode_from_rel_path(rel_path),
                        character_names=json.dumps([c["clean"] for c in chars], ensure_ascii=False),
                        is_dakimakura=1 if is_dakimakura else 0,
                        width=width or img.width,
                        height=height or img.height,
                        reason="",
                        gallery_tag=get_gallery_image_tag_for_path(gallery_tag_config, rel_path)
                    )

                    db.rebuild_gallery_folder_summaries()
                    db.set_gallery_index_state("full_index_built", "1")

                    index_verified = db.gallery_image_record_exists(gallery_record["rel_path"])
                    index_updated = bool(index_verified)

                if has_prompt_info_text(final_prompt_info):
                    upsert_gallery_prompt_art_styles(db, rel_path, final_prompt_info)

        finally:
            db.close()

        if not index_updated:
            try:
                index_rebuild_started, index_rebuild_running = start_gallery_index_rebuild_background(auto=True)
            except Exception as rebuild_error:
                print(f"⚠️ 캔버스 내보내기 후 갤러리 인덱스 자동 갱신 시작 실패: {rebuild_error}")

        return jsonify({
            "status": "success",
            "path": rel_path,
            "src": "/image/" + quote(rel_path),
            "sidecar_saved": sidecar_saved,
            "embedded_metadata_saved": embedded_metadata_saved,
            "characters": [c["clean"] for c in chars],
            "isDakimakura": is_dakimakura,
            "index_updated": index_updated,
            "index_full_built": index_full_built,
            "index_verified": index_verified,
            "index_rebuild_started": index_rebuild_started,
            "index_rebuild_running": index_rebuild_running
        })

    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route('/style-lab')
def style_lab():
    return send_file(os.path.join(CURRENT_DIR, 'legacy_generation.html'))

@app.route('/daki-workshop')
def daki_workshop():
    return send_file(os.path.join(CURRENT_DIR, 'legacy_generation.html'))


@app.route('/legacy-generation')
def legacy_generation_page():
    return send_file(os.path.join(CURRENT_DIR, 'legacy_generation.html'))


def legacy_generation_roots():
    return {'output': OUTPUT_DIR, 'daki': DAKI_GENERATED_TEMP_DIR}


@app.route('/api/legacy-generation/images')
def legacy_generation_images():
    source = request.args.get('source', 'output')
    root = legacy_generation_roots().get(source)
    if root is None:
        return jsonify({'status': 'error', 'message': '알 수 없는 자료 위치입니다.'}), 400
    cursor = request.args.get('cursor', '')
    if len(cursor) > 4096:
        return jsonify({'status': 'error', 'message': '페이지 위치가 올바르지 않습니다.'}), 400
    try:
        result = list_archive_images(root, cursor, request.args.get('limit', 48))
    except (TypeError, ValueError):
        return jsonify({'status': 'error', 'message': '페이지 크기가 올바르지 않습니다.'}), 400
    for item in result['items']:
        item['src'] = '/legacy-generation/image/' + source + '/' + quote(item['path'], safe='/')
    return jsonify({'status': 'success', **result})


@app.route('/legacy-generation/image/<source>/<path:filename>')
def legacy_generation_image(source, filename):
    root = legacy_generation_roots().get(source)
    if root is None:
        return 'Not found', 404
    try:
        file_path = resolve_archive_image(root, filename)
    except FileNotFoundError:
        return 'Not found', 404
    except (OSError, ValueError):
        return 'Invalid path', 400
    preview_max_side = get_requested_image_preview_max_side()
    if preview_max_side:
        return serve_image_preview(file_path, preview_max_side)
    return send_file(file_path)

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

    write_json(TAG_CATEGORY_OVERRIDE_FILE, data, indent=2)


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
    return read_json(CONFIG_FILE, expected_type=dict)


def save_lab_config_data(data):
    write_json(CONFIG_FILE, data if isinstance(data, dict) else {})


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

    merge_json_object(CONFIG_FILE, {
        "shared_prompt_groups": groups,
        "daki_prompt_groups": groups,
        "clip_prompt_groups": groups,
    })

    return jsonify({
        "status": "success",
        "groups": groups
    })


@app.route('/api/lab/config', methods=['GET', 'POST'])
def handle_lab_config():
    if request.method == 'GET':
        return jsonify(load_lab_config_data())

    incoming = dict(request.json or {})
    merge_json_object(CONFIG_FILE, incoming)

    return jsonify({"status": "success"})

@app.route('/api/artists', methods=['GET', 'POST'])
def handle_artists():
    if request.method == 'GET':
        return jsonify(read_json(ARTISTS_FILE))
    else:
        write_json(ARTISTS_FILE, request.json, indent=4)
        return jsonify({"status": "success"})

@app.route('/api/styles', methods=['GET', 'POST', 'DELETE'])
def handle_styles():
    if request.method == 'GET':
        return jsonify(read_json(STYLES_FILE))
        
    elif request.method == 'POST':
        data = request.json
        merge_json_object(STYLES_FILE, {data["name"]: data["prompt"]})
        return jsonify({"status": "success"})
        
    elif request.method == 'DELETE':
        data = request.json
        style_name = data.get("name")
        
        # 1. styles.json에서 삭제
        with json_lock(STYLES_FILE):
            styles_data = read_json(STYLES_FILE, expected_type=dict)
            if style_name in styles_data:
                del styles_data[style_name]
                write_json(STYLES_FILE, styles_data, indent=4)
        
        # 2. artists.json에서 동일한 이름의 그룹 함께 삭제
        with json_lock(ARTISTS_FILE):
            artists_data = read_json(ARTISTS_FILE, expected_type=dict)
            if style_name in artists_data:
                del artists_data[style_name]
                write_json(ARTISTS_FILE, artists_data, indent=4)
                
        return jsonify({"status": "success"})



# Retired generation endpoint: cached old pages must not send paid requests.
@app.route('/api/generate', methods=['POST'])
def api_generate():
    message = '그림체 연구소와 다키 제작소의 생성 기능은 종료되었습니다. 기존 이미지는 이전 생성 자료에서 열 수 있습니다.'
    return jsonify({'status': 'retired', 'error': message, 'message': message,
                    'archive_url': '/legacy-generation'}), 410

# 💎 Anlas 잔액 조회 API
@app.route('/api/anlas', methods=['GET'])
def api_anlas():
    api_key = request.args.get('key', '').strip()
    try:
        # Keep the legacy response contract; new UI uses the saved-key account API.
        data = fetch_subscription(api_key) if api_key else NOVELAI_ACCOUNT.get()
        if data.get('anlas') is None:
            return jsonify({"error": data.get('message') or 'Anlas 잔액을 확인할 수 없습니다.'}), 502
        return jsonify({"anlas": data['anlas']})
    except AccountLookupError as error:
        return jsonify({"error": str(error)}), 502
    except OSError:
        return jsonify({"error": 'NovelAI 키 설정을 읽지 못했습니다.'}), 500

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
        
    char_prompts = normalize_char_prompts(data)
    write_json(os.path.join(OUTPUT_DIR, jname), {
        "base_prompt": data.get("base_prompt"),
        "char_prompt": data.get("char_prompt"),
        "char_prompts": char_prompts,
        "negative_prompt": data.get("negative_prompt")
    })
        
    return jsonify({"status": "saved", "path": os.path.join(OUTPUT_DIR, fname)})


@app.route('/api/lab/quality_presets', methods=['GET', 'POST'])
def handle_quality_presets():
    if request.method == 'GET':
        return jsonify(read_json(QUALITY_PRESETS_FILE))
    else:
        # POST: 앱 번역 사전 저장
        write_json(QUALITY_PRESETS_FILE, request.json, indent=4)
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
    write_json(TAG_DICTIONARY_USER_OVERRIDES, data, indent=2)


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


def run_server():
    app.run(
        host='127.0.0.1',
        port=5000,
        debug=False,
        use_reloader=False,
        threaded=True
    )


if __name__ == '__main__':
    run_server()
