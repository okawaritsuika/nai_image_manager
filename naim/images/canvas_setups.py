"""Normalize existing canvas saved-state records without changing their shape."""
import time
import random

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


def apply_canvas_saved_setup_patch(existing, upserts, remove_ids):
    """Apply explicit canvas setup changes while retaining all other records."""
    if not isinstance(existing, list):
        raise ValueError("existing canvas setups must be a list")
    if not isinstance(upserts, list):
        raise ValueError("canvas setup upserts must be a list")
    if not isinstance(remove_ids, list):
        raise ValueError("canvas setup removeIds must be a list")

    normalized_upserts = []
    upsert_ids = set()
    for item in upserts:
        if not isinstance(item, dict):
            raise ValueError("canvas setup upserts must contain objects")

        setup_id = item.get("id")
        if not isinstance(setup_id, str) or not setup_id.strip():
            raise ValueError("canvas setup upserts require a nonempty string id")
        if not isinstance(item.get("state"), dict):
            raise ValueError("canvas setup upserts require an object state")

        normalized = normalize_canvas_saved_setup_item(item)
        normalized_id = normalized["id"]
        if normalized_id in upsert_ids:
            raise ValueError("canvas setup upserts cannot contain duplicate ids")
        upsert_ids.add(normalized_id)
        normalized_upserts.append(normalized)

    normalized_remove_ids = set()
    for setup_id in remove_ids:
        if not isinstance(setup_id, str) or not setup_id.strip():
            raise ValueError("canvas setup removeIds must contain nonempty string ids")
        normalized_remove_ids.add(setup_id.strip())

    result = [
        item for item in normalize_canvas_saved_setups(existing)
        if item["id"] not in normalized_remove_ids
    ]

    for upsert in normalized_upserts:
        for index, item in enumerate(result):
            if item["id"] == upsert["id"]:
                result[index] = upsert
                break
        else:
            result.append(upsert)

    return normalize_canvas_saved_setups(result)
