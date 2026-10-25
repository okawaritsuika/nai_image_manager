"""Comic folder identity, gallery metadata and session-local pixel deduplication."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path

from PIL import Image
from naim.storage.json_files import write_json

MANIFEST = "_comic.json"


def read_comic(folder):
    try:
        with open(os.path.join(folder, MANIFEST), encoding="utf-8") as stream:
            data = json.load(stream)
        if isinstance(data, dict) and data.get("version") == 1:
            return data
    except (OSError, ValueError):
        pass
    return None


def find_comic_folder(path):
    """Recognize maker exports and our classified manifests, including reordering."""
    for folder in Path(path).absolute().parents:
        if folder.parent.name.lower() == "comic_maker":
            return str(folder), str(folder.parent.parent)
        if folder.parent.name.lower() == "_maker" and folder.parent.parent.name.lower() == "comic":
            return str(folder), str(folder.parent.parent.parent)
        if (folder / MANIFEST).is_file():
            return str(folder), None
    return None


def collect_comics(paths):
    groups, by_path = {}, {}
    # Usually many pages share one parent; avoid repeating ancestor checks.
    parents = {}
    for path in paths:
        parent = os.path.dirname(path)
        if parent not in parents:
            parents[parent] = find_comic_folder(path)
        found = parents[parent]
        if not found:
            continue
        folder, session = found
        if folder not in groups:
            saved = read_comic(folder) or {}
            title = saved.get("title") or os.path.basename(folder)
            prompt_tags = []
            base_prompt = ""
            try:
                with open(os.path.join(folder, "comic_plan.json"), encoding="utf-8") as stream:
                    plan = json.load(stream)
                title = str(plan.get("title") or title)
                base_prompt = str(plan.get("global_prompt") or "")
                prompts = plan.get("character_prompts") or {}
                if isinstance(prompts, dict):
                    prompt_tags.extend(str(value) for value in prompts.values() if isinstance(value, str))
            except (OSError, ValueError, AttributeError):
                pass
            try:
                with open(os.path.join(folder, "character_snapshot.json"), encoding="utf-8") as stream:
                    snapshot = json.load(stream)
                prompts = snapshot.get("prompts") or {}
                if isinstance(prompts, dict):
                    prompt_tags.extend(str(value) for value in prompts.values() if isinstance(value, str))
            except (OSError, ValueError, AttributeError):
                pass
            name = os.path.basename(folder)
            if len(name) > 100:
                name = name[:80] + "_" + hashlib.sha256(name.encode()).hexdigest()[:12]
            groups[folder] = {
                "folder": folder, "session": session, "name": name,
                "title": title, "paths": [],
                "source_id": saved.get("source_id") or hashlib.sha256(os.path.normcase(folder).encode()).hexdigest(),
                "prompt_tags": [tag.strip() for value in prompt_tags for tag in value.split(",")],
                "base_prompt": base_prompt,
                "characters": list(saved.get("characters") or []),
                "rating": int(saved.get("rating") or 0),
            }
        group = groups[folder]
        group["paths"].append(path)
        by_path[path] = group
    return groups, by_path


def pixel_digest(path, sizes=None):
    """Decode only matching dimensions. Metadata does not participate in identity."""
    with Image.open(path) as image:
        if getattr(image, "n_frames", 1) != 1:
            return None
        if sizes is not None and image.size not in sizes:
            return None
        size = image.size
        # Maker exports strip alpha (including NAI stealth metadata). The user
        # explicitly chose RGB identity, so alpha differences are ignored.
        with image.convert("RGB") as rgb:
            return size, hashlib.sha256(rgb.tobytes()).hexdigest()


def find_comic_duplicates(paths, groups, by_path, stop_check=None, progress=None):
    """Return outside path -> preferred comic page; never deduplicate comic pages."""
    sessions = {}
    for group in groups.values():
        if group["session"]:
            sessions.setdefault(group["session"], []).extend(group["paths"])
    if not sessions:
        return {}
    duplicates = {}
    completed = 0

    def checked_digest(path, sizes=None):
        if stop_check and stop_check():
            return path, None
        try:
            return path, pixel_digest(path, sizes)
        except (OSError, ValueError, Image.DecompressionBombError):
            return path, None

    # At most four decoded pages are resident at once; no image-pair comparisons.
    with ThreadPoolExecutor(max_workers=4) as pool:
        for session, pages in sessions.items():
            if stop_check and stop_check():
                break
            candidates = [p for p in paths if p not in by_path
                          and Path(session) in Path(p).parents]
            if not candidates:
                continue
            known = {}
            for path, digest in pool.map(checked_digest, sorted(pages)):
                if digest is not None:
                    known.setdefault(digest, path)
            sizes = {digest[0] for digest in known}
            if not sizes:
                continue
            for path, digest in pool.map(lambda p: checked_digest(p, sizes), candidates):
                if digest in known:
                    duplicates[path] = known[digest]
                completed += 1
                if progress:
                    progress(completed, len(paths), "코믹 중복 확인")
    return duplicates


def save_comic(folder, group):
    write_json(os.path.join(folder, MANIFEST), {
        "version": 1, "title": group["title"],
        "source_id": group["source_id"],
        "characters": sorted(set(group["characters"])), "rating": group["rating"],
    })


def comic_destination(classified_root, group):
    category = os.path.join("_R-18", "comic") if group["rating"] in (1, 2) else "comic"
    destination = os.path.join(classified_root, category, group["name"])
    if os.path.isdir(destination) and os.path.normcase(destination) != os.path.normcase(group["folder"]):
        previous = read_comic(destination)
        if not previous or previous.get("source_id") != group["source_id"]:
            group["name"] = group["name"][:80] + "_" + group["source_id"][:12]
            destination = os.path.join(classified_root, category, group["name"])
    return destination


def decorate_comic_node(node, classified_root, physical_folder=None):
    """Both indexed and scan galleries use the same title and character metadata."""
    path = node.get("path") or ""
    data = read_comic(os.path.join(classified_root, physical_folder or path)) if path else None
    if os.path.basename(path).lower() == "comic":
        node["is_comic_group"] = True
        node["char_names"] = []
    if data:
        node["is_comic"] = True
        node["name"] = str(data.get("title") or node["name"])
        node["char_names"] = list(data.get("characters") or [])
        node["images"].sort(key=lambda image: image["name"])


def delete_imported_duplicates(duplicates, destinations, stop_check=None, log_func=print):
    """Delete only after rechecking the imported image and the outside original."""
    deleted = 0
    for outside, page in duplicates.items():
        if stop_check and stop_check():
            break
        destination = destinations.get(page)
        if not destination:
            continue
        try:
            if os.path.samefile(outside, destination):
                continue
            before = os.stat(outside)
            digest = pixel_digest(destination)
            if digest is None or pixel_digest(outside) != digest:
                continue
            after = os.stat(outside)
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                continue
            os.remove(outside)
            deleted += 1
        except (OSError, ValueError, Image.DecompressionBombError):
            log_func("⚠️ 코믹 중복 원본을 확인/삭제하지 못해 유지했습니다.")
    return deleted
