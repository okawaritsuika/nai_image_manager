# -*- coding: utf-8 -*-
import os
import re
import json
import time
import shutil
import sqlite3
import hashlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from PIL import Image

import image_logic

WORKSPACE_DIR_NAME = "TOTAL_WORKSPACE"
INDEX_DIR_NAME = ".naia_index"
INDEX_DB_NAME = "workspace_index.db"
ACTIVE_WORKSPACE_SESSION = "__ACTIVE_WORKSPACE__"
ACTIVE_WORKSPACE_FOLDER = "current"

BASE_CHAR_SEP = "\u001eNAIA_BASE_CHAR\u001e"
CHAR_SEP = "\u001fNAIA_CHAR_NEXT\u001f"

IMAGE_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".webp", ".bmp"
}


def normalize_worker_count(value, fallback=4):
    try:
        count = int(value)
    except Exception:
        count = fallback

    return max(1, min(64, count))


def get_app_dir():
    return os.path.dirname(os.path.abspath(__file__))


def get_workspace_root():
    return os.path.join(get_app_dir(), WORKSPACE_DIR_NAME)


def get_workspace_import_root():
    return os.path.join(get_workspace_root(), "imports")


def get_active_workspace_dir():
    return os.path.join(get_workspace_root(), ACTIVE_WORKSPACE_FOLDER)


def get_active_workspace_session_name():
    return ACTIVE_WORKSPACE_SESSION


def get_workspace_index_dir():
    return os.path.join(get_workspace_root(), INDEX_DIR_NAME)


def get_workspace_db_path():
    return os.path.join(get_workspace_index_dir(), INDEX_DB_NAME)


def normalize_rel_path(path):
    return str(path or "").replace("\\", "/").strip("/")


def sanitize_session_name(name):
    text = str(name or "import").strip()
    text = re.sub(r'[<>:"/\\\\|?*]+', "_", text)
    text = re.sub(r"\s+", "_", text)
    return text[:80] or "import"


def make_session_dir(source_dir, clear_workspace=False):
    workspace_dir = get_active_workspace_dir()

    if clear_workspace and os.path.exists(workspace_dir):
        shutil.rmtree(workspace_dir)

    os.makedirs(workspace_dir, exist_ok=True)
    return workspace_dir, ACTIVE_WORKSPACE_SESSION


def collect_image_files(source_dir):
    result = []

    for root, dirs, files in os.walk(source_dir):
        if ".naia_index" in dirs:
            dirs.remove(".naia_index")

        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                result.append(os.path.join(root, filename))

    result.sort()
    return result


def collect_existing_classified_image_files(classified_dir):
    result = []
    classified_dir = os.path.abspath(classified_dir)

    skip_dir_names = {
        ".naia_index",
        "_TRASH",
        "_UNREADABLE",
        "_upscaled"
    }

    for root, dirs, files in os.walk(classified_dir):
        if os.path.exists(os.path.join(root, ".ignore")):
            dirs[:] = []
            continue

        dirs[:] = [
            dirname for dirname in dirs
            if dirname not in skip_dir_names
            and not os.path.exists(os.path.join(root, dirname, ".ignore"))
        ]

        for filename in files:
            ext = os.path.splitext(filename)[1].lower()
            if ext in IMAGE_EXTENSIONS:
                result.append(os.path.join(root, filename))

    result.sort()
    return result


def make_unique_path(path):
    if not os.path.exists(path):
        return path

    folder = os.path.dirname(path)
    base, ext = os.path.splitext(os.path.basename(path))

    for index in range(2, 10000):
        candidate = os.path.join(folder, f"{base}_{index}{ext}")
        if not os.path.exists(candidate):
            return candidate

    raise RuntimeError("以묐났 ?뚯씪紐낆쓣 泥섎━?????놁뒿?덈떎.")


def quick_file_hash(path):
    try:
        size = os.path.getsize(path)
        h = hashlib.md5()
        h.update(str(size).encode("utf-8"))
        with open(path, "rb") as f:
            h.update(f.read(102400))
        return h.hexdigest()
    except Exception:
        return ""


def get_existing_classified_workspace_record_map(session_name):
    conn = ensure_workspace_db()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                workspace_rel_path,
                workspace_path,
                source_path,
                size,
                mtime,
                file_hash,
                status
            FROM workspace_images
            WHERE session_name = ?
              AND workspace_rel_path LIKE 'classified/%'
        """, (session_name,))

        records = {}
        for row in cursor.fetchall():
            workspace_rel_path = normalize_rel_path(row[0] or "")
            if not workspace_rel_path:
                continue
            records[workspace_rel_path] = {
                "workspace_rel_path": workspace_rel_path,
                "workspace_path": row[1] or "",
                "source_path": row[2] or "",
                "size": int(row[3] or 0),
                "mtime": float(row[4] or 0),
                "file_hash": row[5] or "",
                "status": row[6] or ""
            }
        return records
    finally:
        conn.close()


def classified_workspace_rel_from_path(src_path, classified_dir):
    rel_from_classified = os.path.relpath(src_path, classified_dir)
    rel_from_classified = normalize_rel_path(rel_from_classified)
    return normalize_rel_path("classified/" + rel_from_classified)


def normalize_abs_path_for_compare(path):
    if not path:
        return ""
    try:
        return os.path.normcase(os.path.normpath(os.path.abspath(str(path)))).replace("\\", "/")
    except Exception:
        return ""


def is_existing_classified_record_unchanged(src_path, record):
    if not src_path or not os.path.isfile(src_path) or not record:
        return False

    if str(record.get("status") or "") != "indexed":
        return False

    try:
        current_size = os.path.getsize(src_path)
        current_mtime = os.path.getmtime(src_path)
    except Exception:
        return False

    if int(record.get("size") or 0) != int(current_size):
        return False

    try:
        record_mtime = float(record.get("mtime") or 0)
    except Exception:
        record_mtime = 0

    if abs(float(current_mtime) - record_mtime) > 0.001:
        return False

    record_hash = str(record.get("file_hash") or "")
    if record_hash:
        return quick_file_hash(src_path) == record_hash

    return True


def delete_workspace_records_for_paths(session_name, workspace_rel_paths):
    paths = [
        normalize_rel_path(path)
        for path in (workspace_rel_paths or [])
        if normalize_rel_path(path)
    ]
    if not paths:
        return 0

    conn = ensure_workspace_db()
    deleted = 0
    try:
        with conn:
            for start in range(0, len(paths), 500):
                batch = paths[start:start + 500]
                placeholders = ",".join("?" for _ in batch)
                params = [session_name] + batch
                cursor = conn.execute(
                    f"DELETE FROM workspace_images WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                    params
                )
                deleted += int(cursor.rowcount or 0)
                conn.execute(
                    f"DELETE FROM workspace_character_index WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                    params
                )
                conn.execute(
                    f"DELETE FROM workspace_route_preview WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                    params
                )
        return deleted
    finally:
        conn.close()


def delete_non_classified_records_for_final_paths(session_name, final_paths):
    normalized_paths = []
    seen = set()

    for path in final_paths or []:
        full_path = os.path.abspath(str(path or ""))
        if not full_path or full_path in seen:
            continue
        seen.add(full_path)
        normalized_paths.append(full_path)

    if not normalized_paths:
        return 0

    conn = ensure_workspace_db()
    rel_paths = []
    try:
        cursor = conn.cursor()
        for start in range(0, len(normalized_paths), 250):
            batch = normalized_paths[start:start + 250]
            placeholders = ",".join("?" for _ in batch)
            params = [session_name] + batch + batch
            cursor.execute(f"""
                SELECT workspace_rel_path
                FROM workspace_images
                WHERE session_name = ?
                  AND workspace_rel_path NOT LIKE 'classified/%'
                  AND (
                    source_path IN ({placeholders})
                    OR workspace_path IN ({placeholders})
                  )
            """, params)
            rel_paths.extend(row[0] for row in cursor.fetchall() if row and row[0])
    finally:
        conn.close()

    return delete_workspace_records_for_paths(session_name, rel_paths)


def _fetch_workspace_image_row(conn, session_name, workspace_rel_path):
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT *
        FROM workspace_images
        WHERE session_name = ?
          AND workspace_rel_path = ?
        LIMIT 1
    """, (session_name, normalize_rel_path(workspace_rel_path)))
    row = cursor.fetchone()
    return dict(row) if row else None


def _delete_workspace_aux_rows(conn, session_name, rel_paths):
    paths = [normalize_rel_path(path) for path in rel_paths or [] if normalize_rel_path(path)]
    if not paths:
        return {"images": 0, "characters": 0, "previews": 0}

    deleted = {"images": 0, "characters": 0, "previews": 0}
    for start in range(0, len(paths), 500):
        batch = paths[start:start + 500]
        placeholders = ",".join("?" for _ in batch)
        params = [session_name] + batch
        cur = conn.execute(
            f"DELETE FROM workspace_images WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
            params
        )
        deleted["images"] += int(cur.rowcount or 0)
        cur = conn.execute(
            f"DELETE FROM workspace_character_index WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
            params
        )
        deleted["characters"] += int(cur.rowcount or 0)
        cur = conn.execute(
            f"DELETE FROM workspace_route_preview WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
            params
        )
        deleted["previews"] += int(cur.rowcount or 0)
    return deleted


def _cleanup_duplicate_rows_for_physical_path(conn, session_name, final_path, keep_rel):
    normalized_final = normalize_abs_path_for_compare(final_path)
    keep_rel = normalize_rel_path(keep_rel)
    if not normalized_final or not keep_rel:
        return 0

    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("""
        SELECT workspace_rel_path, source_path, workspace_path
        FROM workspace_images
        WHERE session_name = ?
    """, (session_name,))
    duplicate_rels = []
    for row in cursor.fetchall():
        rel = normalize_rel_path(row["workspace_rel_path"])
        if rel == keep_rel:
            continue
        physical = row["workspace_path"] or row["source_path"] or ""
        if normalize_abs_path_for_compare(physical) == normalized_final:
            duplicate_rels.append(rel)

    deleted = _delete_workspace_aux_rows(conn, session_name, duplicate_rels)
    return int(deleted.get("images") or 0)


def finalize_classified_workspace_moves(
    move_records,
    classified_dir,
    session_name=ACTIVE_WORKSPACE_SESSION,
    log_func=None
):
    classified_dir = os.path.abspath(classified_dir)
    records = [item for item in (move_records or []) if isinstance(item, dict)]
    stats = {
        "total": len(records),
        "moved": 0,
        "fallback_indexed": 0,
        "duplicates_removed": 0,
        "character_index_moved": 0,
        "preview_invalidated": 0,
        "errors": 0
    }

    if not records:
        return stats

    fallback_paths = []
    conn = ensure_workspace_db()
    conn.row_factory = sqlite3.Row

    try:
        with conn:
            for item in records:
                try:
                    final_path = os.path.abspath(str(item.get("final_path") or ""))
                    if not final_path or not os.path.isfile(final_path):
                        continue

                    new_rel = classified_workspace_rel_from_path(final_path, classified_dir)
                    old_rel = normalize_rel_path(item.get("old_workspace_rel_path") or "")
                    old_row = _fetch_workspace_image_row(conn, session_name, old_rel) if old_rel else None

                    if not old_row:
                        fallback_paths.append(final_path)
                        continue

                    now = time.time()
                    try:
                        size = os.path.getsize(final_path)
                        mtime = os.path.getmtime(final_path)
                    except Exception:
                        size = old_row.get("size", 0)
                        mtime = old_row.get("mtime", 0)

                    new_record = dict(old_row)
                    new_record.update({
                        "workspace_rel_path": new_rel,
                        "session_name": session_name,
                        "source_path": final_path,
                        "workspace_path": final_path,
                        "file_name": os.path.basename(final_path),
                        "folder_path": os.path.dirname(new_rel).replace("\\", "/"),
                        "size": size,
                        "mtime": mtime,
                        "status": "indexed",
                        "error": old_row.get("error", ""),
                        "indexed_at": now,
                        "exported_at": now
                    })
                    upsert_workspace_record(conn, new_record)

                    if old_rel and old_rel != new_rel:
                        conn.execute(
                            "DELETE FROM workspace_images WHERE session_name = ? AND workspace_rel_path = ?",
                            (session_name, old_rel)
                        )

                    if old_rel:
                        cursor = conn.execute("""
                            SELECT *
                            FROM workspace_character_index
                            WHERE session_name = ?
                              AND workspace_rel_path = ?
                            LIMIT 1
                        """, (session_name, old_rel))
                        char_row = cursor.fetchone()
                        if char_row:
                            char_values = dict(char_row)
                            char_values["workspace_rel_path"] = new_rel
                            conn.execute("""
                                INSERT OR REPLACE INTO workspace_character_index (
                                    workspace_rel_path,
                                    session_name,
                                    detected_characters,
                                    character_count,
                                    character_folder_name,
                                    default_bucket_index,
                                    index_version,
                                    indexed_at,
                                    error
                                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """, (
                                char_values.get("workspace_rel_path", ""),
                                session_name,
                                char_values.get("detected_characters", ""),
                                char_values.get("character_count", 0),
                                char_values.get("character_folder_name", ""),
                                char_values.get("default_bucket_index", 0),
                                char_values.get("index_version", ""),
                                char_values.get("indexed_at", 0),
                                char_values.get("error", "")
                            ))
                            if old_rel != new_rel:
                                conn.execute(
                                    "DELETE FROM workspace_character_index WHERE session_name = ? AND workspace_rel_path = ?",
                                    (session_name, old_rel)
                                )
                            stats["character_index_moved"] += 1

                    preview_rels = [new_rel]
                    if old_rel and old_rel != new_rel:
                        preview_rels.append(old_rel)
                    for start in range(0, len(preview_rels), 500):
                        batch = preview_rels[start:start + 500]
                        placeholders = ",".join("?" for _ in batch)
                        params = [session_name] + batch
                        cur = conn.execute(
                            f"DELETE FROM workspace_route_preview WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                            params
                        )
                        stats["preview_invalidated"] += int(cur.rowcount or 0)

                    stats["duplicates_removed"] += _cleanup_duplicate_rows_for_physical_path(
                        conn,
                        session_name,
                        final_path,
                        new_rel
                    )
                    stats["moved"] += 1
                except Exception as item_error:
                    stats["errors"] += 1
                    if log_func:
                        log_func(f"workspace row 이전 실패: {item_error}")
    finally:
        conn.close()

    if fallback_paths:
        try:
            fallback_result = index_classified_file_paths_as_workspace(
                fallback_paths,
                classified_dir,
                normal_workers=4,
                session_name=session_name,
                incremental=True,
                log_func=log_func,
                progress_update=None,
                stop_check=None
            )
            stats["fallback_indexed"] = int(fallback_result.get("indexed") or 0) + int(fallback_result.get("skipped_unchanged") or 0)

            conn_cleanup = ensure_workspace_db()
            try:
                with conn_cleanup:
                    for final_path in fallback_paths:
                        new_rel = classified_workspace_rel_from_path(final_path, classified_dir)
                        stats["duplicates_removed"] += _cleanup_duplicate_rows_for_physical_path(
                            conn_cleanup,
                            session_name,
                            final_path,
                            new_rel
                        )
            finally:
                conn_cleanup.close()
        except Exception as fallback_error:
            stats["errors"] += len(fallback_paths)
            if log_func:
                log_func(f"workspace fallback 인덱싱 실패: {fallback_error}")

    return stats


def diagnose_workspace_duplicates(session_name=ACTIVE_WORKSPACE_SESSION):
    if not os.path.exists(get_workspace_db_path()):
        return {
            "total_rows": 0,
            "indexed_rows": 0,
            "classified_rows": 0,
            "non_classified_rows": 0,
            "distinct_physical_paths": 0,
            "duplicate_physical_paths": 0,
            "duplicate_rows": 0,
            "samples": []
        }

    conn = ensure_workspace_db()
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT workspace_rel_path, source_path, workspace_path, status
            FROM workspace_images
            WHERE session_name = ?
        """, (session_name,))
        rows = [dict(row) for row in cursor.fetchall()]
    finally:
        conn.close()

    path_map = {}
    indexed_rows = 0
    classified_rows = 0
    for row in rows:
        rel = normalize_rel_path(row.get("workspace_rel_path") or "")
        status = row.get("status") or ""
        if status == "indexed":
            indexed_rows += 1
        if rel.startswith("classified/"):
            classified_rows += 1
        physical = normalize_abs_path_for_compare(row.get("workspace_path") or row.get("source_path") or "")
        if physical:
            path_map.setdefault(physical, []).append(rel)

    duplicate_groups = {path: rels for path, rels in path_map.items() if len(rels) > 1}
    samples = [
        {
            "physical_path": path,
            "count": len(rels),
            "workspace_rel_paths": rels[:10]
        }
        for path, rels in list(duplicate_groups.items())[:20]
    ]

    return {
        "total_rows": len(rows),
        "indexed_rows": indexed_rows,
        "classified_rows": classified_rows,
        "non_classified_rows": len(rows) - classified_rows,
        "distinct_physical_paths": len(path_map),
        "duplicate_physical_paths": len(duplicate_groups),
        "duplicate_rows": sum(max(0, len(rels) - 1) for rels in duplicate_groups.values()),
        "samples": samples
    }


def cleanup_workspace_duplicate_records(session_name=ACTIVE_WORKSPACE_SESSION, dry_run=True, log_func=None):
    conn = ensure_workspace_db()
    conn.row_factory = sqlite3.Row
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT workspace_rel_path, source_path, workspace_path, status, indexed_at, exported_at
            FROM workspace_images
            WHERE session_name = ?
        """, (session_name,))
        rows = [dict(row) for row in cursor.fetchall()]

        groups = {}
        for row in rows:
            physical = normalize_abs_path_for_compare(row.get("workspace_path") or row.get("source_path") or "")
            if physical:
                groups.setdefault(physical, []).append(row)

        duplicate_groups = {path: items for path, items in groups.items() if len(items) > 1}
        remove_rels = []
        samples = []

        def row_rank(row):
            rel = normalize_rel_path(row.get("workspace_rel_path") or "")
            is_classified = 1 if rel.startswith("classified/") else 0
            is_indexed = 1 if (row.get("status") or "") == "indexed" else 0
            recent = max(float(row.get("indexed_at") or 0), float(row.get("exported_at") or 0))
            return (is_classified, is_indexed, recent, rel)

        for physical, items in duplicate_groups.items():
            keep = sorted(items, key=row_rank, reverse=True)[0]
            keep_rel = normalize_rel_path(keep.get("workspace_rel_path") or "")
            removed = [
                normalize_rel_path(item.get("workspace_rel_path") or "")
                for item in items
                if normalize_rel_path(item.get("workspace_rel_path") or "") != keep_rel
            ]
            remove_rels.extend(removed)
            if len(samples) < 20:
                samples.append({
                    "physical_path": physical,
                    "keep": keep_rel,
                    "remove": removed[:10]
                })

        removed_count = 0
        if not dry_run and remove_rels:
            with conn:
                deleted = _delete_workspace_aux_rows(conn, session_name, remove_rels)
                removed_count = int(deleted.get("images") or 0)
            if log_func:
                log_func(f"workspace 중복 DB row 정리: {removed_count}개")

        return {
            "checked_paths": len(groups),
            "duplicate_paths": len(duplicate_groups),
            "would_remove": len(remove_rels),
            "removed": removed_count,
            "samples": samples
        }
    finally:
        conn.close()


def load_prompt_sidecar(image_path):
    sidecar_path = os.path.splitext(image_path)[0] + ".json"

    if not os.path.exists(sidecar_path):
        return None

    try:
        with open(sidecar_path, "r", encoding="utf-8") as f:
            data = json.load(f) or {}

        base_prompt = str(
            data.get("basePrompt")
            or data.get("base_prompt")
            or data.get("prompt")
            or data.get("baseCaption")
            or data.get("base_caption")
            or ""
        ).strip()

        raw_char_prompts = (
            data.get("charPrompts")
            or data.get("char_prompts")
            or []
        )

        if isinstance(raw_char_prompts, str):
            raw_char_prompts = [raw_char_prompts]

        char_prompt = str(
            data.get("charPrompt")
            or data.get("char_prompt")
            or ""
        ).strip()

        char_prompts = [
            str(item or "").strip()
            for item in raw_char_prompts
            if str(item or "").strip()
        ]

        if char_prompt and char_prompt not in char_prompts:
            char_prompts.append(char_prompt)

        if not base_prompt and not char_prompts:
            return None

        return {
            "basePrompt": base_prompt,
            "charPrompts": char_prompts,
            "metaType": "sidecar"
        }
    except Exception:
        return None


def extract_prompt_info_from_image(path):
    sidecar_info = load_prompt_sidecar(path)
    if sidecar_info:
        return sidecar_info

    with Image.open(path) as img:
        raw_meta = ""
        meta_source = "none"

        stealth_data = image_logic.read_stealth_info(img)
        if stealth_data:
            raw_meta = stealth_data
            meta_source = "stealth"
        elif "parameters" in img.info:
            raw_meta = img.info["parameters"]
            meta_source = "parameters"
        elif "Comment" in img.info:
            raw_meta = img.info["Comment"]
            if isinstance(raw_meta, bytes):
                raw_meta = raw_meta.decode("utf-8", "ignore")
            meta_source = "comment"
        elif hasattr(img, "getexif"):
            exif = img.getexif()
            if exif and 37510 in exif:
                user_comment = exif[37510]
                if isinstance(user_comment, bytes):
                    raw_meta = user_comment.decode("utf-8", errors="ignore").replace("\x00", "")
                    if raw_meta.startswith("UNICODE") or raw_meta.startswith("ASCII"):
                        raw_meta = raw_meta[8:]
                else:
                    raw_meta = str(user_comment)
                if raw_meta:
                    meta_source = "exif"

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
            base_prompt = str(
                base_caption
                or meta.get("prompt", "")
                or meta.get("basePrompt", "")
                or ""
            ).strip()

            char_prompts = []
            char_captions = caption.get("char_captions", [])
            if isinstance(char_captions, list):
                for item in char_captions:
                    if isinstance(item, dict):
                        char_text = str(item.get("char_caption", "") or "").strip()
                        if char_text:
                            char_prompts.append(char_text)

            return {
                "basePrompt": base_prompt,
                "charPrompts": char_prompts,
                "metaType": meta_source if meta_source != "none" else "json"
            }

        prompt_part = raw_meta
        if "Negative prompt:" in prompt_part:
            prompt_part = prompt_part.split("Negative prompt:", 1)[0]

        if "\n" in prompt_part:
            prompt_part = prompt_part.split("\n")[0]

        return {
            "basePrompt": prompt_part.strip(),
            "charPrompts": [],
            "metaType": meta_source
        }


def encode_prompt_blob(base_prompt, char_prompts):
    base = str(base_prompt or "")
    chars = [
        str(item or "").strip()
        for item in (char_prompts or [])
        if str(item or "").strip()
    ]

    return base + BASE_CHAR_SEP + CHAR_SEP.join(chars)


def decode_prompt_blob(prompt_blob):
    text = str(prompt_blob or "")

    if BASE_CHAR_SEP not in text:
        return text, []

    base, chars_text = text.split(BASE_CHAR_SEP, 1)
    chars = [
        item.strip()
        for item in chars_text.split(CHAR_SEP)
        if item.strip()
    ]

    return base, chars


def workspace_prompt_tokens_from_blob(prompt_blob):
    base_prompt, char_prompts = decode_prompt_blob(prompt_blob)
    parts = [base_prompt] + list(char_prompts or [])

    tokens = []
    seen = set()

    for part in parts:
        for item in re.split(r"[,\n]+", str(part or "")):
            token = str(item or "").strip()
            if not token:
                continue

            key = token.lower()
            if key in seen:
                continue

            seen.add(key)
            tokens.append(token)

    return tokens, base_prompt, char_prompts


def normalize_live_prompt_text(value):
    return str(value or "").lower().replace("_", " ").replace("\r\n", "\n").replace("\r", "\n")


def split_live_rule_tags(value):
    if isinstance(value, list):
        raw_items = value
    else:
        raw_items = re.split(r"[,\n]+", str(value or ""))

    return [
        str(item or "").strip()
        for item in raw_items
        if str(item or "").strip()
    ]


def get_live_rule_prompt_mode(rule):
    mode = str(rule.get("prompt_mode") or rule.get("live_direct_prompt_mode") or rule.get("scope") or "all").strip().lower()

    if mode in ("base", "base_prompt"):
        return "base"
    if mode in ("char", "character", "character_prompt", "char_prompt"):
        return "char"

    return "all"


def get_live_rule_search_text(base_prompt, char_prompts, mode):
    base = normalize_live_prompt_text(base_prompt)
    char = normalize_live_prompt_text("\n".join(char_prompts or []))

    if mode == "base":
        return base
    if mode == "char":
        return char

    return normalize_live_prompt_text(base + "\n" + char)


def live_text_has_tag(search_text, tag):
    tag_text = normalize_live_prompt_text(tag).strip()
    if not tag_text:
        return False

    return tag_text in search_text


def live_rule_matches_prompt(rule, base_prompt, char_prompts):
    if not isinstance(rule, dict):
        return False

    if rule.get("type") == "default":
        return False

    tags = split_live_rule_tags(rule.get("prompt_text") or rule.get("tags") or "")
    if not tags and rule.get("live_direct_tags"):
        tags = split_live_rule_tags(rule.get("live_direct_tags") or [])
    if not tags:
        return False

    mode = get_live_rule_prompt_mode(rule)
    search_text = get_live_rule_search_text(base_prompt, char_prompts, mode)

    condition = str(rule.get("condition") or rule.get("live_direct_condition") or "any").strip().lower()
    condition_mode = str(rule.get("condition_mode") or rule.get("live_direct_condition_mode") or "").strip().lower()

    try:
        match_count = int(rule.get("match_count") or rule.get("live_direct_match_count") or 1)
    except Exception:
        match_count = 1

    match_count = max(1, match_count)

    if condition_mode == "count" or condition == "count" or match_count > 1:
        matched = sum(1 for tag in tags if live_text_has_tag(search_text, tag))
        return matched >= match_count

    if condition == "all":
        return all(live_text_has_tag(search_text, tag) for tag in tags)

    return any(live_text_has_tag(search_text, tag) for tag in tags)


def find_live_route_for_prompt(rules, base_prompt, char_prompts, parent_path=""):
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue

        if rule.get("type") == "default":
            continue

        if not live_rule_matches_prompt(rule, base_prompt, char_prompts):
            continue

        folder = str(rule.get("folder") or "").strip()
        current_path = "/".join(part for part in [parent_path, folder] if part)

        child_match = find_live_route_for_prompt(
            rule.get("children") or [],
            base_prompt,
            char_prompts,
            current_path
        )

        return child_match or current_path

    return ""


def get_live_default_folders(rules):
    defaults = []

    for rule in rules or []:
        if not isinstance(rule, dict) or rule.get("type") != "default":
            continue

        # ?ъ슜?먭? default 洹쒖튃 ?덉뿉 紐낆떆??援ъ“瑜??곗꽑 ?ъ슜?쒕떎.
        for key in ("default_folders", "folders", "children"):
            raw = rule.get(key)
            if isinstance(raw, list):
                for item in raw:
                    if isinstance(item, dict):
                        folder = str(item.get("folder") or item.get("name") or "").strip()
                    else:
                        folder = str(item or "").strip()
                    if folder:
                        defaults.append(folder)

        folder = str(rule.get("folder") or "").strip()
        if folder and folder not in {"Solo / Duo / Group", "default"}:
            defaults.append(folder)

    # config???곸꽭 default 紐⑸줉???놁쓣 ?뚮쭔 ?꾩옱 遺꾨쪟湲곗쓽 湲곗〈 default ?숈옉怨??명솚?섎뒗 fallback???대떎.
    if not defaults:
        defaults = ["1_Solo", "2_Duo", "3_Group", "0_No_Metadata"]

    seen = set()
    result = []
    for folder in defaults:
        if folder not in seen:
            seen.add(folder)
            result.append(folder)

    return result


def get_live_default_folder_by_count(rules, count):
    defaults = get_live_default_folders(rules)

    if count <= 0:
        return next((f for f in defaults if "metadata" in f.lower() or "no_" in f.lower()), "0_No_Metadata")

    if count == 1:
        return defaults[0] if len(defaults) >= 1 else "1_Solo"

    if count == 2:
        return defaults[1] if len(defaults) >= 2 else "2_Duo"

    return defaults[2] if len(defaults) >= 3 else "3_Group"


def sanitize_live_folder_part(value):
    text = str(value or "").strip()
    text = re.sub(r'[<>:"/\\\\|?*]+', "", text)
    text = text.strip(". ")

    if not text:
        return ""

    if len(text) > 100:
        text = text[:100].strip("_ ") + "_and_Others"

    return text


def load_live_character_names_from_db():
    names = set()
    app_dir = get_app_dir()
    history_db_path = os.path.join(app_dir, "TOTAL_CLASSIFIED", "naia_history.db")
    danbooru_db_path = os.path.join(app_dir, "danbooru_tags.db")

    if os.path.exists(danbooru_db_path):
        conn = None
        try:
            conn = sqlite3.connect(danbooru_db_path)
            cur = conn.cursor()
            cur.execute("SELECT name FROM characters")
            for row in cur.fetchall():
                name = str(row[0] or "").strip().lower()
                if name:
                    names.add(name)
        except Exception:
            pass
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass

    if os.path.exists(history_db_path):
        conn = None
        try:
            conn = sqlite3.connect(history_db_path)
            cur = conn.cursor()
            cur.execute("SELECT tag, clean_name FROM known_characters")
            for row in cur.fetchall():
                for value in row:
                    name = str(value or "").strip().lower()
                    if name:
                        names.add(name)
        except Exception:
            pass
        finally:
            try:
                if conn:
                    conn.close()
            except Exception:
                pass

    return names


def live_prompt_key_set(base_prompt, char_prompts):
    values = [base_prompt] + list(char_prompts or [])
    key_set = set()

    for value in values:
        for token in re.split(r"[,\n]+", str(value or "")):
            token = token.strip().lower()
            if not token:
                continue

            space_key = re.sub(r"\s+", " ", token.replace("_", " ")).strip()
            underscore_key = re.sub(r"\s+", "_", space_key)
            compact_key = re.sub(r"[\s_]+", "", space_key)

            for key in (token, space_key, underscore_key, compact_key):
                if key:
                    key_set.add(key)

    return key_set


def detect_live_character_names(base_prompt, char_prompts, character_names=None):
    ignore_words = {
        "girl", "girls", "1girl", "2girls", "3girls", "4girls", "5girls",
        "boy", "boys", "1boy", "2boys", "solo", "group", "unknown_char",
        "comic", "no_metadata"
    }

    names = character_names if character_names is not None else load_live_character_names_from_db()
    key_set = live_prompt_key_set(base_prompt, char_prompts)

    matched = []

    for name in names or []:
        raw = str(name or "").strip().lower()
        if not raw or raw in ignore_words:
            continue

        space = raw.replace("_", " ")
        compact = re.sub(r"[\s_]+", "", space)

        if raw in key_set or space in key_set or compact in key_set:
            matched.append(raw)

    matched = sorted(set(matched))
    return matched


def make_live_character_index_version(character_names):
    raw = json.dumps(sorted(character_names or []), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def make_live_character_folder_name(detected_characters):
    chars = [
        str(item or "").strip()
        for item in (detected_characters or [])
        if str(item or "").strip()
    ]

    if not chars:
        return ""

    return sanitize_live_folder_part("_and_".join(sorted(chars)))


def get_live_default_bucket_index(character_count):
    try:
        count = int(character_count or 0)
    except Exception:
        count = 0

    if count <= 0:
        return 0
    if count == 1:
        return 1
    if count == 2:
        return 2
    return 3


def get_workspace_session_image_count(session_name):
    conn = ensure_workspace_db()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(*)
            FROM workspace_images
            WHERE session_name = ? AND status = 'indexed'
        """, (session_name,))
        return int((cursor.fetchone() or [0])[0] or 0)
    finally:
        conn.close()


def get_workspace_character_index_status(session_name):
    session_name = str(session_name or "").strip()
    total = get_workspace_session_image_count(session_name)

    import utils
    db = utils.HistoryDB()
    try:
        character_names = image_logic.build_danbooru_character_cache(db)
    finally:
        try:
            db.close()
        except Exception:
            pass

    index_version = make_live_character_index_version(character_names)

    conn = ensure_workspace_db()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                COUNT(*),
                SUM(CASE WHEN error IS NULL OR error = '' THEN 1 ELSE 0 END),
                SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END),
                MAX(indexed_at)
            FROM workspace_character_index
            WHERE session_name = ?
              AND index_version = ?
        """, (session_name, index_version))

        row = cursor.fetchone() or (0, 0, 0, 0)
        indexed = int(row[0] or 0)
        ok = int(row[1] or 0)
        errors = int(row[2] or 0)

        return {
            "session_name": session_name,
            "total": total,
            "indexed": indexed,
            "ok": ok,
            "errors": errors,
            "missing": max(0, total - indexed),
            "complete": total > 0 and indexed >= total,
            "index_version": index_version,
            "latest_at": float(row[3] or 0)
        }
    finally:
        conn.close()


def get_workspace_character_index_map(session_name, index_version=""):
    session_name = str(session_name or "").strip()

    if not index_version:
        import utils
        db = utils.HistoryDB()
        try:
            character_names = image_logic.build_danbooru_character_cache(db)
        finally:
            try:
                db.close()
            except Exception:
                pass

        index_version = make_live_character_index_version(character_names)

    conn = ensure_workspace_db()
    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                workspace_rel_path,
                detected_characters,
                character_count,
                character_folder_name,
                default_bucket_index,
                error
            FROM workspace_character_index
            WHERE session_name = ?
              AND index_version = ?
        """, (session_name, index_version))

        result = {}
        for row in cursor.fetchall():
            try:
                chars = json.loads(row[1] or "[]")
            except Exception:
                chars = []

            result[row[0]] = {
                "detected_characters": chars,
                "character_count": int(row[2] or 0),
                "character_folder_name": row[3] or "",
                "default_bucket_index": int(row[4] or 0),
                "error": row[5] or ""
            }

        return result
    finally:
        conn.close()


def build_live_default_route_path(rules, character_names, use_char_id=True):
    count = len(character_names or [])
    base_folder = get_live_default_folder_by_count(rules, count)

    if not use_char_id:
        return base_folder

    if count <= 0:
        return get_live_default_folder_by_count(rules, 0)

    char_folder = "_and_".join(sorted(character_names)) or "Unknown_Char"
    char_folder = sanitize_live_folder_part(char_folder) or "Unknown_Char"

    return "/".join(part for part in [base_folder, char_folder] if part)


def make_live_tree_node(name, path=""):
    return {
        "name": str(name or ""),
        "path": str(path or "").replace("\\", "/").strip("/"),
        "folders": {},
        "images": [],
        "thumb": None,
        "total_images": 0,
        "char_names": []
    }


def split_live_route_path(path):
    return [
        part.strip()
        for part in str(path or "").replace("\\", "/").split("/")
        if part.strip()
    ]


def is_live_no_metadata_folder(folder_path):
    parts = split_live_route_path(folder_path)
    if not parts:
        return True

    for part in parts:
        key = str(part or "").strip().lower().replace(" ", "_")
        if key in {"0_no_metadata", "no_metadata", "no_metadata_0"}:
            return True
        if "no_metadata" in key:
            return True

    return False


def get_or_create_live_tree_node(root, folder_path):
    parts = split_live_route_path(folder_path)
    current = root
    current_path = ""

    for part in parts:
        current_path = "/".join([current_path, part]).strip("/")
        folders = current.setdefault("folders", {})
        if part not in folders:
            folders[part] = make_live_tree_node(part, current_path)
        current = folders[part]

    return current


def finalize_live_tree_node(node):
    folder_values = list((node.get("folders") or {}).values())

    total = int(node.get("raw_total_images") or len(node.get("images") or []))

    for child in folder_values:
        finalize_live_tree_node(child)
        total += int(child.get("total_images") or 0)
        if not node.get("thumb") and child.get("thumb"):
            node["thumb"] = child["thumb"]

    node["total_images"] = total
    node.pop("raw_total_images", None)

    if not node.get("thumb") and node.get("images"):
        node["thumb"] = node["images"][0].get("path") or node["images"][0].get("workspace_rel_path")

    folder_values = [
        child for child in folder_values
        if int(child.get("total_images") or 0) > 0 or child.get("force_visible")
    ]
    folder_values.sort(key=lambda item: (item.get("name") == "0_No_Metadata", item.get("name", "")))

    node["folders"] = folder_values
    node["images"] = node.get("images") or []

    return node


def seed_live_tree_from_rules(root, rules, parent_path="", use_char_id=True):
    for rule in rules or []:
        if not isinstance(rule, dict):
            continue

        rule_type = rule.get("type")

        if rule_type == "default":
            if not use_char_id:
                continue
            for folder in get_live_default_folders([rule]):
                path = "/".join([parent_path, folder]).strip("/")
                node = get_or_create_live_tree_node(root, path)
                node["force_visible"] = True
            continue

        folder = str(rule.get("folder") or "").strip()
        if not folder:
            continue

        path = "/".join([parent_path, folder]).strip("/")
        node = get_or_create_live_tree_node(root, path)
        node["force_visible"] = True

        children = rule.get("children") or []
        if isinstance(children, list) and children:
            seed_live_tree_from_rules(root, children, path, use_char_id=use_char_id)


def prompt_hash_from_blob(prompt_blob):
    return hashlib.sha1(str(prompt_blob or "").encode("utf-8", errors="ignore")).hexdigest()


def make_live_rules_hash(rules, use_char_id=True):
    payload = {
        "rules": rules or [],
        "use_char_id": bool(use_char_id)
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(raw.encode("utf-8", errors="ignore")).hexdigest()


def ensure_workspace_db():
    os.makedirs(get_workspace_index_dir(), exist_ok=True)
    conn = sqlite3.connect(get_workspace_db_path())
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")

    with conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspace_images (
                workspace_rel_path TEXT PRIMARY KEY,
                session_name TEXT,
                source_path TEXT,
                workspace_path TEXT,
                file_name TEXT,
                folder_path TEXT,
                width INTEGER,
                height INTEGER,
                size INTEGER,
                mtime REAL,
                file_hash TEXT,
                prompt_blob TEXT,
                prompt_hash TEXT,
                meta_source TEXT,
                status TEXT,
                error TEXT,
                imported_at REAL,
                indexed_at REAL,
                exported_at REAL
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_images_session
            ON workspace_images(session_name)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_images_hash
            ON workspace_images(file_hash)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_images_status
            ON workspace_images(status)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspace_route_preview (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_name TEXT NOT NULL,
                rules_hash TEXT NOT NULL,
                use_char_id INTEGER NOT NULL,
                workspace_rel_path TEXT NOT NULL,
                predicted_folder TEXT NOT NULL,
                matched_rule_path TEXT,
                matched_rule_name TEXT,
                detected_characters TEXT,
                route_status TEXT,
                updated_at REAL,
                UNIQUE(session_name, rules_hash, use_char_id, workspace_rel_path)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_route_preview_lookup
            ON workspace_route_preview(session_name, rules_hash, use_char_id)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_route_preview_folder
            ON workspace_route_preview(session_name, rules_hash, use_char_id, predicted_folder)
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS workspace_character_index (
                workspace_rel_path TEXT PRIMARY KEY,
                session_name TEXT NOT NULL,
                detected_characters TEXT,
                character_count INTEGER,
                character_folder_name TEXT,
                default_bucket_index INTEGER,
                index_version TEXT,
                indexed_at REAL,
                error TEXT
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_character_index_session
            ON workspace_character_index(session_name)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_workspace_character_index_version
            ON workspace_character_index(session_name, index_version)
        """)

    return conn


def upsert_workspace_record(conn, record):
    with conn:
        conn.execute("""
            INSERT OR REPLACE INTO workspace_images (
                workspace_rel_path,
                session_name,
                source_path,
                workspace_path,
                file_name,
                folder_path,
                width,
                height,
                size,
                mtime,
                file_hash,
                prompt_blob,
                prompt_hash,
                meta_source,
                status,
                error,
                imported_at,
                indexed_at,
                exported_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            record.get("workspace_rel_path", ""),
            record.get("session_name", ""),
            record.get("source_path", ""),
            record.get("workspace_path", ""),
            record.get("file_name", ""),
            record.get("folder_path", ""),
            record.get("width", 0),
            record.get("height", 0),
            record.get("size", 0),
            record.get("mtime", 0),
            record.get("file_hash", ""),
            record.get("prompt_blob", ""),
            record.get("prompt_hash", ""),
            record.get("meta_source", ""),
            record.get("status", ""),
            record.get("error", ""),
            record.get("imported_at", 0),
            record.get("indexed_at", 0),
            record.get("exported_at", 0),
        ))


def process_workspace_import_item(args):
    src_path = args["src_path"]
    source_dir = args["source_dir"]
    session_dir = args["session_dir"]
    workspace_root = args["workspace_root"]
    session_name = args["session_name"]
    method = args["method"]

    rel_from_source = os.path.relpath(src_path, source_dir)
    rel_from_source = normalize_rel_path(rel_from_source)

    dst_path = os.path.join(session_dir, rel_from_source)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    dst_path = make_unique_path(dst_path)

    now = time.time()
    status = "indexed"
    error = ""
    width = 0
    height = 0
    size = 0
    mtime = 0
    file_hash = ""
    prompt_blob = ""
    prompt_hash = ""
    meta_source = "none"

    try:
        if method == "move":
            shutil.move(src_path, dst_path)
        else:
            shutil.copy2(src_path, dst_path)

        src_sidecar = os.path.splitext(src_path)[0] + ".json"
        if os.path.exists(src_sidecar):
            dst_sidecar = os.path.splitext(dst_path)[0] + ".json"
            if method == "move":
                shutil.move(src_sidecar, dst_sidecar)
            else:
                shutil.copy2(src_sidecar, dst_sidecar)

        size = os.path.getsize(dst_path)
        mtime = os.path.getmtime(dst_path)
        file_hash = quick_file_hash(dst_path)

        with Image.open(dst_path) as img:
            width, height = img.size

        prompt_info = extract_prompt_info_from_image(dst_path)
        base_prompt = str(prompt_info.get("basePrompt") or "").strip()
        char_prompts = prompt_info.get("charPrompts") or []
        if not isinstance(char_prompts, list):
            char_prompts = []

        prompt_blob = encode_prompt_blob(base_prompt, char_prompts)
        prompt_hash = prompt_hash_from_blob(prompt_blob)
        meta_source = str(prompt_info.get("metaType") or "none")

    except Exception as item_error:
        status = "error"
        error = str(item_error)

    workspace_rel = os.path.relpath(dst_path, workspace_root).replace("\\", "/")
    folder_path = os.path.dirname(workspace_rel).replace("\\", "/")

    return {
        "workspace_rel_path": workspace_rel,
        "session_name": session_name,
        "source_path": src_path,
        "workspace_path": dst_path,
        "file_name": os.path.basename(dst_path),
        "folder_path": folder_path,
        "width": width,
        "height": height,
        "size": size,
        "mtime": mtime,
        "file_hash": file_hash,
        "prompt_blob": prompt_blob,
        "prompt_hash": prompt_hash,
        "meta_source": meta_source,
        "status": status,
        "error": error,
        "imported_at": now,
        "indexed_at": time.time() if status == "indexed" else 0,
        "exported_at": 0
    }


def process_existing_classified_index_item(args):
    src_path = args["src_path"]
    classified_dir = args["classified_dir"]
    session_name = args["session_name"]

    workspace_rel = classified_workspace_rel_from_path(src_path, classified_dir)
    folder_path = os.path.dirname(workspace_rel).replace("\\", "/")

    now = time.time()
    status = "indexed"
    error = ""
    width = 0
    height = 0
    size = 0
    mtime = 0
    file_hash = ""
    prompt_blob = ""
    prompt_hash = ""
    meta_source = "none"

    try:
        size = os.path.getsize(src_path)
        mtime = os.path.getmtime(src_path)
        file_hash = quick_file_hash(src_path)

        with Image.open(src_path) as img:
            width, height = img.size

        prompt_info = extract_prompt_info_from_image(src_path)
        base_prompt = str(prompt_info.get("basePrompt") or "").strip()
        char_prompts = prompt_info.get("charPrompts") or []
        if not isinstance(char_prompts, list):
            char_prompts = []

        prompt_blob = encode_prompt_blob(base_prompt, char_prompts)
        prompt_hash = prompt_hash_from_blob(prompt_blob)
        meta_source = str(prompt_info.get("metaType") or "none")

    except Exception as item_error:
        status = "error"
        error = str(item_error)

    return {
        "workspace_rel_path": workspace_rel,
        "session_name": session_name,
        "source_path": src_path,
        "workspace_path": src_path,
        "file_name": os.path.basename(src_path),
        "folder_path": folder_path,
        "width": width,
        "height": height,
        "size": size,
        "mtime": mtime,
        "file_hash": file_hash,
        "prompt_blob": prompt_blob,
        "prompt_hash": prompt_hash,
        "meta_source": meta_source,
        "status": status,
        "error": error,
        "imported_at": now,
        "indexed_at": time.time() if status == "indexed" else 0,
        "exported_at": 0
    }


def index_classified_file_paths_as_workspace(
    file_paths,
    classified_dir,
    normal_workers=4,
    session_name=ACTIVE_WORKSPACE_SESSION,
    incremental=True,
    log_func=None,
    progress_update=None,
    stop_check=None
):
    classified_dir = os.path.abspath(classified_dir)
    valid_files = []
    seen = set()

    for src_path in file_paths or []:
        src_path = os.path.abspath(str(src_path or ""))
        ext = os.path.splitext(src_path)[1].lower()
        if src_path in seen or ext not in IMAGE_EXTENSIONS or not os.path.isfile(src_path):
            continue
        seen.add(src_path)
        valid_files.append(src_path)

    total = len(valid_files)
    removed_duplicate_records = delete_non_classified_records_for_final_paths(session_name, valid_files)
    if removed_duplicate_records and log_func:
        log_func(f"중복 workspace 레코드 정리: {removed_duplicate_records}개")

    existing_map = get_existing_classified_workspace_record_map(session_name) if incremental else {}

    task_args = []
    skipped_unchanged = 0
    changed_keys = []

    for src_path in valid_files:
        workspace_rel = classified_workspace_rel_from_path(src_path, classified_dir)
        record = existing_map.get(workspace_rel)

        if incremental and is_existing_classified_record_unchanged(src_path, record):
            skipped_unchanged += 1
            continue

        changed_keys.append(workspace_rel)
        task_args.append({
            "src_path": src_path,
            "classified_dir": classified_dir,
            "session_name": session_name
        })

    conn = ensure_workspace_db()
    indexed_count = 0
    error_count = 0
    done_count = 0

    try:
        if changed_keys:
            with conn:
                for start in range(0, len(changed_keys), 500):
                    batch = changed_keys[start:start + 500]
                    placeholders = ",".join("?" for _ in batch)
                    params = [session_name] + batch
                    conn.execute(
                        f"DELETE FROM workspace_character_index WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                        params
                    )
                    conn.execute(
                        f"DELETE FROM workspace_route_preview WHERE session_name = ? AND workspace_rel_path IN ({placeholders})",
                        params
                    )

        workers = normalize_worker_count(normal_workers)
        workers = min(workers, max(1, len(task_args)))

        if log_func:
            log_func(
                f"?뱴 湲곗〈 遺꾨쪟 ?뚯씪 利앸텇 ?몃뜳?? ???{total} / "
                f"媛깆떊 {len(task_args)} / ?ㅽ궢 {skipped_unchanged}"
            )

        if not task_args:
            return {
                "total": total,
                "indexed": 0,
                "skipped_unchanged": skipped_unchanged,
                "errors": 0
            }

        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(process_existing_classified_index_item, args): args["src_path"]
                for args in task_args
            }

            for future in as_completed(future_map):
                if stop_check and stop_check():
                    if log_func:
                        log_func("??湲곗〈 遺꾨쪟 ?뚯씪 ?몃뜳??以묒? ?붿껌 媛먯?")
                    break

                try:
                    record = future.result()
                except Exception as future_error:
                    src_path = future_map.get(future, "")
                    now = time.time()
                    workspace_rel = classified_workspace_rel_from_path(src_path, classified_dir)
                    record = {
                        "workspace_rel_path": workspace_rel,
                        "session_name": session_name,
                        "source_path": src_path,
                        "workspace_path": src_path,
                        "file_name": os.path.basename(src_path),
                        "folder_path": os.path.dirname(workspace_rel).replace("\\", "/"),
                        "width": 0,
                        "height": 0,
                        "size": 0,
                        "mtime": 0,
                        "file_hash": "",
                        "prompt_blob": "",
                        "prompt_hash": "",
                        "meta_source": "none",
                        "status": "error",
                        "error": str(future_error),
                        "imported_at": now,
                        "indexed_at": 0,
                        "exported_at": 0
                    }

                if record.get("workspace_rel_path"):
                    upsert_workspace_record(conn, record)

                done_count += 1
                if record.get("status") == "indexed":
                    indexed_count += 1
                else:
                    error_count += 1

                if progress_update:
                    progress_update(done_count + skipped_unchanged, total, "기존 분류 폴더 인덱스")

                if log_func and (done_count == 1 or done_count % 500 == 0 or done_count == len(task_args)):
                    log_func(
                        f"?뱴 湲곗〈 遺꾨쪟 ?뚯씪 ?몃뜳??吏꾪뻾: {done_count}/{len(task_args)} / ?ㅻ쪟 {error_count}"
                    )

        return {
            "total": total,
            "indexed": indexed_count,
            "skipped_unchanged": skipped_unchanged,
            "errors": error_count
        }
    finally:
        conn.close()


def import_folder_to_workspace(
    source_dir,
    method="copy",
    normal_workers=4,
    build_character_index=False,
    character_index_max_scan=0,
    clear_workspace=False,
    log_func=None,
    progress_update=None,
    stop_check=None
):
    source_dir = os.path.abspath(source_dir)

    if not os.path.isdir(source_dir):
        raise FileNotFoundError("?먮낯 ?대뜑媛 ?놁뒿?덈떎.")

    method = "move" if method == "move" else "copy"

    workspace_root = get_workspace_root()
    os.makedirs(workspace_root, exist_ok=True)

    session_dir, session_name = make_session_dir(source_dir, clear_workspace=clear_workspace)

    if clear_workspace:
        conn_clear = ensure_workspace_db()
        try:
            with conn_clear:
                conn_clear.execute("DELETE FROM workspace_images WHERE session_name = ?", (ACTIVE_WORKSPACE_SESSION,))
                conn_clear.execute("DELETE FROM workspace_character_index WHERE session_name = ?", (ACTIVE_WORKSPACE_SESSION,))
                conn_clear.execute("DELETE FROM workspace_route_preview WHERE session_name = ?", (ACTIVE_WORKSPACE_SESSION,))
        finally:
            conn_clear.close()

    files = collect_image_files(source_dir)
    total = len(files)

    if log_func:
        log_func(f"?뱿 ?대뜑 ?쎄린 ?쒖옉: {source_dir}")
        log_func(f"?㎞ ?묒뾽 ?대뜑: {session_dir}")
        log_func(f"이미지 파일: {total}개")

    conn = ensure_workspace_db()
    imported_count = 0
    error_count = 0
    done_count = 0

    try:
        workers = normalize_worker_count(normal_workers)
        workers = min(workers, max(1, total))

        if log_func:
            log_func(f"?숋툘 ?대뜑 ?쎄린 蹂묐젹 泥섎━: ?쇰컲 ?ㅻ젅??{workers}媛??ъ슜")

        task_args = [
            {
                "src_path": src_path,
                "source_dir": source_dir,
                "session_dir": session_dir,
                "workspace_root": workspace_root,
                "session_name": session_name,
                "method": method
            }
            for src_path in files
        ]

        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(process_workspace_import_item, args): args["src_path"]
                for args in task_args
            }

            for future in as_completed(future_map):
                if stop_check and stop_check():
                    if log_func:
                        log_func("?썞 以묒? ?붿껌 媛먯?: ?꾨즺???묒뾽源뚯?留?DB????ν빀?덈떎.")
                    break

                try:
                    record = future.result()
                except Exception as future_error:
                    src_path = future_map.get(future, "")
                    now = time.time()
                    record = {
                        "workspace_rel_path": "",
                        "session_name": session_name,
                        "source_path": src_path,
                        "workspace_path": "",
                        "file_name": os.path.basename(src_path),
                        "folder_path": "",
                        "width": 0,
                        "height": 0,
                        "size": 0,
                        "mtime": 0,
                        "file_hash": "",
                        "prompt_blob": "",
                        "prompt_hash": "",
                        "meta_source": "none",
                        "status": "error",
                        "error": str(future_error),
                        "imported_at": now,
                        "indexed_at": 0,
                        "exported_at": 0
                    }

                if record.get("workspace_rel_path"):
                    upsert_workspace_record(conn, record)

                done_count += 1

                if record.get("status") == "indexed":
                    imported_count += 1
                else:
                    error_count += 1

                if progress_update:
                    progress_update(done_count, total, "?대뜑 ?쎄린")

                if log_func and (done_count == 1 or done_count % 200 == 0 or done_count == total):
                    log_func(
                        f"?뱿 ?대뜑 ?쎄린 吏꾪뻾: {done_count}/{total} / "
                        f"?깃났 {imported_count} / ?ㅽ뙣 {error_count}"
                    )

    finally:
        conn.close()

    if log_func:
        log_func(f"폴더 읽기 완료: 성공 {imported_count}개 / 실패 {error_count}개")
        log_func(f"세션: {session_name}")

    character_index_result = None

    if build_character_index and not (stop_check and stop_check()):
        character_index_result = build_workspace_character_index(
            session_name,
            normal_workers=normal_workers,
            max_scan=character_index_max_scan,
            log_func=log_func,
            progress_update=progress_update,
            stop_check=stop_check
        )

    return {
        "session_name": session_name,
        "session_dir": session_dir,
        "total": total,
        "imported": imported_count,
        "errors": error_count,
        "db_path": get_workspace_db_path(),
        "character_index": character_index_result
    }



def index_existing_classified_folder_as_workspace(
    classified_dir,
    normal_workers=4,
    build_character_index=False,
    character_index_max_scan=0,
    clear_workspace=False,
    incremental=True,
    prune_missing=True,
    log_func=None,
    progress_update=None,
    stop_check=None
):
    classified_dir = os.path.abspath(classified_dir)

    if not os.path.isdir(classified_dir):
        raise FileNotFoundError("湲곗〈 遺꾨쪟 寃곌낵 ?대뜑媛 ?놁뒿?덈떎.")

    session_name = ACTIVE_WORKSPACE_SESSION
    incremental = bool(incremental) and not bool(clear_workspace)
    method_name = "index_existing_classified_incremental" if incremental else "index_existing_classified_full"

    if clear_workspace:
        conn_clear = ensure_workspace_db()
        try:
            with conn_clear:
                conn_clear.execute("DELETE FROM workspace_images WHERE session_name = ?", (session_name,))
                conn_clear.execute("DELETE FROM workspace_character_index WHERE session_name = ?", (session_name,))
                conn_clear.execute("DELETE FROM workspace_route_preview WHERE session_name = ?", (session_name,))
        finally:
            conn_clear.close()

    files = collect_existing_classified_image_files(classified_dir)
    total = len(files)
    removed_missing = 0

    if log_func:
        if incremental:
            log_func(f"기존 분류 폴더 인덱스 증분 갱신 시작: {classified_dir}")
        else:
            log_func(f"기존 분류 폴더 인덱스 전체 재생성 시작: {classified_dir}")
        log_func("파일 복사/이동 없이 DB 인덱스만 갱신합니다.")
        log_func(f"이미지 파일: {total}개")

    if prune_missing and not clear_workspace:
        existing_map = get_existing_classified_workspace_record_map(session_name)
        current_keys = {
            classified_workspace_rel_from_path(path, classified_dir)
            for path in files
        }
        missing_keys = [key for key in existing_map.keys() if key not in current_keys]
        removed_missing = delete_workspace_records_for_paths(session_name, missing_keys)
        if log_func and removed_missing:
            log_func(f"사라진 기존 분류 파일 인덱스 삭제: {removed_missing}개")

    result = index_classified_file_paths_as_workspace(
        files,
        classified_dir,
        normal_workers=normal_workers,
        session_name=session_name,
        incremental=incremental,
        log_func=log_func,
        progress_update=progress_update,
        stop_check=stop_check
    )

    character_index_result = None
    if build_character_index and not (stop_check and stop_check()):
        character_index_result = build_workspace_character_index(
            session_name,
            normal_workers=normal_workers,
            max_scan=character_index_max_scan,
            log_func=log_func,
            progress_update=progress_update,
            stop_check=stop_check
        )

    return {
        "session_name": session_name,
        "source_dir": classified_dir,
        "method": method_name,
        "total": result.get("total", total),
        "indexed": result.get("indexed", 0),
        "skipped_unchanged": result.get("skipped_unchanged", 0),
        "removed_missing": removed_missing,
        "errors": result.get("errors", 0),
        "character_index": character_index_result
    }


def get_active_workspace_status():
    db_path = get_workspace_db_path()

    if not os.path.exists(db_path):
        return {
            "session_name": ACTIVE_WORKSPACE_SESSION,
            "label": "?꾩옱 ?뚰겕?ㅽ럹?댁뒪",
            "total": 0,
            "indexed": 0,
            "errors": 0,
            "character_index": {
                "session_name": ACTIVE_WORKSPACE_SESSION,
                "total": 0,
                "indexed": 0,
                "ok": 0,
                "errors": 0,
                "missing": 0,
                "complete": False,
                "index_version": "",
                "latest_at": 0
            }
        }

    conn = ensure_workspace_db()

    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                COUNT(*) AS total_count,
                SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexed_count,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count
            FROM workspace_images
            WHERE session_name = ?
        """, (ACTIVE_WORKSPACE_SESSION,))

        row = cursor.fetchone() or (0, 0, 0)

        return {
            "session_name": ACTIVE_WORKSPACE_SESSION,
            "label": "?꾩옱 ?뚰겕?ㅽ럹?댁뒪",
            "total": int(row[0] or 0),
            "indexed": int(row[1] or 0),
            "errors": int(row[2] or 0),
            "character_index": get_workspace_character_index_status(ACTIVE_WORKSPACE_SESSION)
        }
    finally:
        conn.close()


def list_workspace_sessions():
    status = get_active_workspace_status()
    if not status.get("total"):
        return []
    return [status]



def get_workspace_image_record(workspace_rel_path):
    db_path = get_workspace_db_path()

    if not os.path.exists(db_path):
        return None

    conn = ensure_workspace_db()

    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                workspace_rel_path,
                session_name,
                source_path,
                workspace_path,
                file_name,
                folder_path,
                width,
                height,
                size,
                mtime,
                file_hash,
                prompt_blob,
                prompt_hash,
                meta_source,
                status,
                error,
                imported_at,
                indexed_at,
                exported_at
            FROM workspace_images
            WHERE workspace_rel_path = ?
            LIMIT 1
        """, (normalize_rel_path(workspace_rel_path),))

        row = cursor.fetchone()
        if not row:
            return None

        base_prompt, char_prompts = decode_prompt_blob(row[11] or "")

        return {
            "workspace_rel_path": row[0],
            "session_name": row[1],
            "source_path": row[2],
            "workspace_path": row[3],
            "file_name": row[4],
            "folder_path": row[5],
            "width": int(row[6] or 0),
            "height": int(row[7] or 0),
            "size": int(row[8] or 0),
            "mtime": float(row[9] or 0),
            "file_hash": row[10],
            "prompt_blob": row[11] or "",
            "prompt_hash": row[12],
            "meta_source": row[13],
            "status": row[14],
            "error": row[15],
            "imported_at": float(row[16] or 0),
            "indexed_at": float(row[17] or 0),
            "exported_at": float(row[18] or 0),
            "base_prompt": base_prompt,
            "char_prompts": char_prompts
        }
    finally:
        conn.close()


def get_random_workspace_image(session_name=""):
    db_path = get_workspace_db_path()

    if not os.path.exists(db_path):
        return None

    conn = ensure_workspace_db()

    try:
        cursor = conn.cursor()

        if session_name:
            cursor.execute("""
                SELECT workspace_rel_path
                FROM workspace_images
                WHERE session_name = ? AND status = 'indexed'
                ORDER BY RANDOM()
                LIMIT 1
            """, (session_name,))
        else:
            cursor.execute("""
                SELECT workspace_rel_path
                FROM workspace_images
                WHERE status = 'indexed'
                ORDER BY RANDOM()
                LIMIT 1
            """)

        row = cursor.fetchone()
        if not row:
            return None

        return get_workspace_image_record(row[0])
    finally:
        conn.close()


def get_random_workspace_unclassified_image(session_name, rules, use_char_id=True):
    rules_hash = make_live_rules_hash(rules, use_char_id=use_char_id)
    conn = ensure_workspace_db()

    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                i.workspace_rel_path,
                i.file_name,
                i.folder_path,
                i.width,
                i.height,
                i.meta_source,
                i.status,
                i.prompt_blob
            FROM workspace_route_preview p
            JOIN workspace_images i
              ON i.workspace_rel_path = p.workspace_rel_path
            WHERE p.session_name = ?
              AND p.rules_hash = ?
              AND p.use_char_id = ?
              AND (
                    COALESCE(p.route_status, '') != 'matched'
                    OR LOWER(REPLACE(COALESCE(p.predicted_folder, ''), ' ', '_')) LIKE '%no_metadata%'
              )
              AND i.status = 'indexed'
            ORDER BY RANDOM()
            LIMIT 1
        """, (session_name, rules_hash, 1 if use_char_id else 0))

        row = cursor.fetchone()

        if not row:
            return None

        base_prompt, char_prompts = decode_prompt_blob(row[7] or "")

        return {
            "workspace_rel_path": row[0],
            "file_name": row[1],
            "folder_path": row[2],
            "width": int(row[3] or 0),
            "height": int(row[4] or 0),
            "meta_source": row[5],
            "status": row[6],
            "base_prompt": base_prompt,
            "char_prompts": char_prompts
        }

    finally:
        conn.close()


def list_workspace_images_for_session(session_name, limit=5000):
    db_path = get_workspace_db_path()

    if not os.path.exists(db_path):
        return []

    try:
        limit = int(limit)
    except Exception:
        limit = 5000

    conn = ensure_workspace_db()

    try:
        cursor = conn.cursor()
        if limit and limit > 0:
            limit_clause = "LIMIT ?"
            params = (session_name, max(1, min(50000, limit)))
        else:
            limit_clause = ""
            params = (session_name,)

        cursor.execute(f"""
            SELECT
                workspace_rel_path,
                session_name,
                source_path,
                workspace_path,
                file_name,
                folder_path,
                width,
                height,
                size,
                prompt_blob,
                meta_source,
                status,
                error
            FROM workspace_images
            WHERE session_name = ?
            ORDER BY workspace_rel_path
            {limit_clause}
        """, params)

        result = []
        for row in cursor.fetchall():
            base_prompt, char_prompts = decode_prompt_blob(row[9] or "")
            result.append({
                "workspace_rel_path": row[0],
                "session_name": row[1],
                "source_path": row[2],
                "workspace_path": row[3],
                "file_name": row[4],
                "folder_path": row[5],
                "width": int(row[6] or 0),
                "height": int(row[7] or 0),
                "size": int(row[8] or 0),
                "prompt_blob": row[9] or "",
                "base_prompt": base_prompt,
                "char_prompts": char_prompts,
                "meta_source": row[10],
                "status": row[11],
                "error": row[12],
            })

        return result
    finally:
        conn.close()



def build_workspace_character_index(
    session_name,
    normal_workers=4,
    max_scan=0,
    log_func=None,
    progress_update=None,
    stop_check=None,
    job_state=None,
    incremental=True
):
    session_name = str(session_name or "").strip()
    if not session_name:
        raise ValueError("?몄뀡紐낆씠 ?놁뒿?덈떎.")

    import utils

    db = utils.HistoryDB()
    try:
        danbooru_cache = image_logic.build_danbooru_character_cache(db, log_func=log_func)
    finally:
        try:
            db.close()
        except Exception:
            pass

    if not danbooru_cache:
        raise RuntimeError("?⑤낫猷?罹먮┃??DB媛 鍮꾩뼱 ?덉뒿?덈떎. Danbooru character DB瑜?癒쇱? 以鍮꾪븯?몄슂.")

    index_version = make_live_character_index_version(danbooru_cache)

    limit = 50000
    try:
        raw_max = int(max_scan or 0)
        if raw_max > 0:
            limit = raw_max
    except Exception:
        pass

    all_images = list_workspace_images_for_session(session_name, limit=limit)
    skipped_rel_paths = set()

    if incremental:
        conn_existing = ensure_workspace_db()
        try:
            cursor = conn_existing.cursor()
            cursor.execute("""
                SELECT workspace_rel_path, error
                FROM workspace_character_index
                WHERE session_name = ?
                  AND index_version = ?
            """, (session_name, index_version))
            for rel_path, error in cursor.fetchall():
                if not str(error or "").strip():
                    skipped_rel_paths.add(rel_path)
        finally:
            conn_existing.close()

    images = [
        image for image in all_images
        if not (incremental and image.get("workspace_rel_path") in skipped_rel_paths)
    ]

    total_all = len(all_images)
    skipped_count = max(0, total_all - len(images))
    total = len(images)

    if log_func:
        log_func(f"캐릭터 인덱스 증분 생성: 전체 {total_all} / 스킵 {skipped_count} / 처리 {total}")
        log_func(f"단보루 캐릭터 캐시: {len(danbooru_cache)}개")

    if job_state is not None:
        job_state.update({
            "running": True,
            "done": False,
            "processed": 0,
            "total": total,
            "errors": 0,
            "message": "罹먮┃???몃뜳???꾨씫遺??앹꽦 以?.."
        })

    if total == 0:
        if job_state is not None:
            job_state.update({
                "running": False,
                "done": True,
                "processed": 0,
                "total": 0,
                "errors": 0,
                "message": "罹먮┃???몃뜳??理쒖떊 ?곹깭"
            })
        if log_func:
            log_func("??罹먮┃???몃뜳??理쒖떊 ?곹깭")
        return {
            "session_name": session_name,
            "total": 0,
            "indexed": 0,
            "skipped": skipped_count,
            "errors": 0,
            "index_version": index_version
        }

    def process_item(image):
        rel_path = image.get("workspace_rel_path") or ""
        prompt_blob = image.get("prompt_blob") or ""
        error = ""
        detected = []

        try:
            if image.get("status") == "indexed":
                tokens, base_prompt, char_prompts = workspace_prompt_tokens_from_blob(prompt_blob)
                detected = image_logic.detect_character_names_from_prompt_tags(
                    tokens,
                    danbooru_cache,
                    skip_char_id=False
                )
        except Exception as e:
            error = str(e)
            detected = []

        char_count = len(detected)
        folder_name = make_live_character_folder_name(detected)
        bucket_index = get_live_default_bucket_index(char_count)

        return (
            rel_path,
            session_name,
            json.dumps(detected, ensure_ascii=False),
            char_count,
            folder_name,
            bucket_index,
            index_version,
            time.time(),
            error
        )

    workers = normalize_worker_count(normal_workers)
    workers = min(workers, max(1, total))
    rows = []
    done = 0
    errors = 0
    batch_size = 500
    conn = ensure_workspace_db()

    def flush_rows():
        nonlocal rows
        if not rows:
            return
        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO workspace_character_index (
                    workspace_rel_path,
                    session_name,
                    detected_characters,
                    character_count,
                    character_folder_name,
                    default_bucket_index,
                    index_version,
                    indexed_at,
                    error
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, rows)
        rows = []

    try:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(process_item, image): image
                for image in images
            }

            for future in as_completed(future_map):
                if stop_check and stop_check():
                    if log_func:
                        log_func("??罹먮┃???몃뜳???앹꽦 以묒? ?붿껌 媛먯?")
                    break

                row = future.result()
                rows.append(row)
                done += 1
                if row[-1]:
                    errors += 1

                if len(rows) >= batch_size:
                    flush_rows()

                if progress_update:
                    progress_update(done, total, "캐릭터 인덱스")

                if job_state is not None:
                    job_state.update({
                        "processed": done,
                        "total": total,
                        "errors": errors,
                        "message": f"罹먮┃???몃뜳???꾨씫遺??앹꽦 以?.. {done}/{total}"
                    })

                if log_func and (done == 1 or done % 500 == 0 or done == total):
                    log_func(f"캐릭터 인덱스 진행: {done}/{total} / 오류 {errors}")

        flush_rows()
    finally:
        conn.close()

    if job_state is not None:
        job_state.update({
            "running": False,
            "done": True,
            "processed": done,
            "total": total,
            "errors": errors,
            "message": "罹먮┃???몃뜳???꾨즺"
        })

    if log_func:
        log_func(f"??罹먮┃???몃뜳???꾨즺: 泥섎━ {done} / ?ㅽ궢 {skipped_count} / ?ㅻ쪟 {errors}")

    return {
        "session_name": session_name,
        "total": total,
        "indexed": done,
        "skipped": skipped_count,
        "errors": errors,
        "index_version": index_version
    }


def reclassify_workspace_preview(
    session_name,
    rules,
    per_group_limit=300,
    max_scan=50000,
    use_char_id=True
):
    rules_hash = make_live_rules_hash(rules, use_char_id=use_char_id)
    images = list_workspace_images_for_session(session_name, limit=max_scan)
    character_index_status = get_workspace_character_index_status(session_name)

    if use_char_id and not character_index_status.get("complete"):
        raise RuntimeError(
            "\uce90\ub9ad\ud130 \uc778\ub371\uc2a4\uac00 \uc5c6\ub294 \uc138\uc158\uc785\ub2c8\ub2e4. \uce90\ub9ad\ud130 \ud310\ubcc4 \uc0ac\uc6a9 \uc804 \uce90\ub9ad\ud130 \uc778\ub371\uc2a4\ub97c \uba3c\uc800 \uc0dd\uc131\ud558\uc138\uc694."
        )

    character_index_map = {}
    if use_char_id:
        character_index_map = get_workspace_character_index_map(
            session_name,
            character_index_status.get("index_version") or ""
        )

    conn = ensure_workspace_db()
    now = time.time()
    rows = []

    try:
        with conn:
            conn.execute("""
                DELETE FROM workspace_route_preview
                WHERE session_name = ? AND rules_hash = ? AND use_char_id = ?
            """, (session_name, rules_hash, 1 if use_char_id else 0))

        for image in images:
            base_prompt = image.get("base_prompt") or ""
            char_prompts = image.get("char_prompts") or []

            detected_chars = []
            character_folder_name = ""
            character_count = 0

            if use_char_id:
                char_info = character_index_map.get(image.get("workspace_rel_path") or "") or {}
                detected_chars = char_info.get("detected_characters") or []
                character_folder_name = char_info.get("character_folder_name") or ""
                character_count = int(char_info.get("character_count") or 0)

            if image.get("status") != "indexed":
                predicted_folder = get_live_default_folder_by_count(rules, 0)
                matched_rule_path = ""
                matched_rule_name = ""
                route_status = "error"
            else:
                custom_folder = find_live_route_for_prompt(
                    rules,
                    base_prompt,
                    char_prompts
                )

                if custom_folder:
                    if use_char_id and character_folder_name:
                        predicted_folder = "/".join(part for part in [custom_folder, character_folder_name] if part)
                    else:
                        predicted_folder = custom_folder
                    matched_rule_path = custom_folder
                    matched_rule_name = custom_folder
                    route_status = "matched"
                else:
                    if use_char_id:
                        base_folder = get_live_default_folder_by_count(rules, character_count)
                        predicted_folder = "/".join(part for part in [base_folder, character_folder_name] if part)
                    else:
                        predicted_folder = get_live_default_folder_by_count(rules, 0)
                    matched_rule_path = ""
                    matched_rule_name = "default"
                    route_status = "default"

            if not predicted_folder:
                predicted_folder = get_live_default_folder_by_count(rules, 0)

            rows.append((
                session_name,
                rules_hash,
                1 if use_char_id else 0,
                image.get("workspace_rel_path") or "",
                predicted_folder,
                matched_rule_path,
                matched_rule_name,
                json.dumps(detected_chars, ensure_ascii=False),
                route_status,
                now
            ))

        with conn:
            conn.executemany("""
                INSERT OR REPLACE INTO workspace_route_preview (
                    session_name,
                    rules_hash,
                    use_char_id,
                    workspace_rel_path,
                    predicted_folder,
                    matched_rule_path,
                    matched_rule_name,
                    detected_characters,
                    route_status,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, rows)

        return {
            "session_name": session_name,
            "rules_hash": rules_hash,
            "use_char_id": bool(use_char_id),
            "total": len(images),
            "saved": len(rows),
            "updated_at": now
        }

    finally:
        conn.close()


def load_live_preview_tree(
    session_name,
    rules,
    use_char_id=True,
    per_folder_limit=300,
    no_metadata_limit=500
):
    rules_hash = make_live_rules_hash(rules, use_char_id=use_char_id)

    try:
        per_folder_limit = int(per_folder_limit or 300)
    except Exception:
        per_folder_limit = 300

    try:
        no_metadata_limit = int(no_metadata_limit or 500)
    except Exception:
        no_metadata_limit = 500

    per_folder_limit = max(1, per_folder_limit)
    no_metadata_limit = max(1, no_metadata_limit)

    conn = ensure_workspace_db()

    root = make_live_tree_node("ROOT", "")
    seed_live_tree_from_rules(root, rules, use_char_id=use_char_id)

    try:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                p.workspace_rel_path,
                p.predicted_folder,
                p.detected_characters,
                p.route_status,
                i.file_name,
                i.width,
                i.height,
                i.meta_source,
                i.status
            FROM workspace_route_preview p
            JOIN workspace_images i
              ON i.workspace_rel_path = p.workspace_rel_path
            WHERE p.session_name = ?
              AND p.rules_hash = ?
              AND p.use_char_id = ?
            ORDER BY p.predicted_folder, i.file_name
        """, (session_name, rules_hash, 1 if use_char_id else 0))

        folder_image_counts = {}
        preview_stats = {
            "total": 0,
            "classified": 0,
            "unclassified": 0,
            "no_metadata": 0,
            "default": 0,
            "error": 0
        }

        for row in cursor.fetchall():
            rel_path = row[0]
            predicted_folder = row[1] or get_live_default_folder_by_count(rules, 0)
            detected_raw = row[2] or "[]"
            route_status = str(row[3] or "").strip().lower()
            is_no_metadata = is_live_no_metadata_folder(predicted_folder)

            preview_stats["total"] += 1

            if is_no_metadata:
                preview_stats["no_metadata"] += 1

            if route_status == "matched" and not is_no_metadata:
                preview_stats["classified"] += 1
            else:
                preview_stats["unclassified"] += 1

            if route_status == "default":
                preview_stats["default"] += 1
            elif route_status == "error":
                preview_stats["error"] += 1

            try:
                detected_chars = json.loads(detected_raw)
            except Exception:
                detected_chars = []

            folder_image_counts[predicted_folder] = folder_image_counts.get(predicted_folder, 0) + 1

            node = get_or_create_live_tree_node(root, predicted_folder)
            node["char_names"] = detected_chars or node.get("char_names") or []
            node["raw_total_images"] = int(node.get("raw_total_images") or 0) + 1

            display_limit = no_metadata_limit if is_no_metadata else per_folder_limit

            if len(node.get("images") or []) >= display_limit:
                continue

            item = {
                "name": row[4],
                "file_name": row[4],
                "path": rel_path,
                "workspace_rel_path": rel_path,
                "w": int(row[5] or 0),
                "h": int(row[6] or 0),
                "width": int(row[5] or 0),
                "height": int(row[6] or 0),
                "meta_source": row[7],
                "status": row[8],
                "route_status": route_status,
                "predicted_folder": predicted_folder,
                "detected_characters": detected_chars
            }

            node.setdefault("images", []).append(item)

        finalized = finalize_live_tree_node(root)

        return {
            "session_name": session_name,
            "rules_hash": rules_hash,
            "use_char_id": bool(use_char_id),
            "tree": finalized,
            "folder_counts": folder_image_counts,
            "preview_stats": preview_stats,
            "per_folder_limit": per_folder_limit,
            "no_metadata_limit": no_metadata_limit,
            "has_preview": bool(folder_image_counts)
        }

    finally:
        conn.close()

