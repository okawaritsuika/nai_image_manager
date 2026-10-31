"""Offline tag dictionary rules and user-editable dictionary state."""
from __future__ import annotations

import csv
import io
import json
import re
import threading
from collections import Counter, defaultdict
from pathlib import Path

from naim.daki_dictionary_images import ImageCatalog
from naim.storage.json_files import json_lock, read_json, write_json


STYLE_TAGS = frozenset({
    "artist collaboration", "digital illustration", "depthness", "flat color",
    "simple illustration", "high complexity", "official art", "official style",
    "best quality", "amazing quality", "very aesthetic", "highres", "muted color",
    "white haze", "fine lineart", "color trace", "detailed eyes",
})


class DictionaryDataError(ValueError):
    """The bundled dictionary or combination rows are missing or invalid."""


def image_display_tags(tags, dictionary=None):
    """Body/actions only; omit character appearance, scenery, style and censorship."""
    result = []
    for tag in tags:
        if (tag in STYLE_TAGS or re.search(r"censor", tag)
                or tag.startswith(("artist:", "character:", "copyright:"))
                or re.fullmatch(r"year \d{4}", tag)):
            continue
        if re.search(r"\b(muscles?|muscular|biceps?|triceps?|deltoids?|pectorals?|abs|abdominals?|toned|six.pack|eight.pack|bodybuilder|bodybuilding)\b", tag):
            continue
        scalp_hair = re.search(r"\b(hair|hairstyle|bangs|ahoge|braids?|ponytails?|twintails?|sidelocks?|sidetails?|tresses|buns?|ringlets?|dreadlocks|cornrows|beard|mustache|moustache)\b", tag)
        body_hair = re.search(r"\b(pubic|anal|armpit|body|chest|leg) hair\b", tag)
        if scalp_hair and not body_hair:
            continue
        categories = (dictionary or {}).get(tag, {}).get("categories", [])
        if not body_hair and any(category.startswith(("신체/머리카락/", "신체 꾸밈/", "신체 특징/종족·성별/"))
               or any(word in category for word in ("헤어", "땋은머리", "땋은 머리")) for category in categories):
            continue
        if any(category.startswith("비인간 신체/") for category in categories):
            continue
        if any(category.endswith("/색상") for category in categories):
            continue
        fallback = [category.split("/") for category in categories if category.startswith("연관 요소/")]
        if any(any(part in {"캐릭터", "설정", "종족", "직업", "배경", "장소", "건축", "저작권", "메타", "검열"}
                   for part in parts) for parts in fallback):
            continue
        body_roots = ("신체/", "신체 상태/", "성인 신체/", "표정/", "자세/", "동작/", "신체 특징/체형/")
        fallback_body = {"신체", "신체 부위", "얼굴", "표정", "감정", "외형", "노출", "성행위", "신체 특징"}
        if categories and not any(category.startswith(body_roots) for category in categories):
            if not any(any(part in fallback_body for part in parts) for parts in fallback):
                continue
        result.append(tag)
    return result


class Dictionary:
    def __init__(self, data_directory: Path, user_directory: Path):
        self.directory = Path(data_directory)
        self.user_directory = Path(user_directory)
        self.lock = threading.RLock()
        try:
            self.payload = json.loads((self.directory / "dictionary.json").read_text(encoding="utf-8"))
            raw_rows = json.loads((self.directory / "source_combinations.json").read_text(encoding="utf-8"))
            if (not isinstance(self.payload, dict) or not isinstance(self.payload.get("source"), dict)
                    or not isinstance(self.payload.get("tags"), list) or not isinstance(raw_rows, list)):
                raise ValueError
            self.tags = {item["tag"]: dict(item) for item in self.payload["tags"]}
            self.rows = [{key: row[key] for key in ("id", "general", "rating")} for row in raw_rows]
            if any(not isinstance(row["general"], str) for row in self.rows):
                raise ValueError
        except (OSError, UnicodeError, ValueError, TypeError, KeyError) as error:
            raise DictionaryDataError("사전 자료를 찾을 수 없거나 형식이 올바르지 않습니다.") from error

        self.category_labels = {
            item['id']: item.get('label') or item['id']
            for item in self.payload.get('categories', [])
            if isinstance(item, dict) and isinstance(item.get('id'), str)
        }
        self.overrides_path = self.user_directory / "user_edits.json"
        self.overrides = read_json(self.overrides_path, expected_type=dict)
        if not isinstance(self.overrides, dict):
            self.overrides = {}
        for tag, changes in self.overrides.items():
            if tag in self.tags and isinstance(changes, dict):
                self.tags[tag].update(changes)
        self.index = defaultdict(list)
        self.related_cache = {}
        for index, row in enumerate(self.rows):
            for tag in set(row["general"].split(", ")):
                self.index[tag].append(index)
        if set(self.index) != set(self.tags):
            raise DictionaryDataError("사전 태그와 조합 자료가 일치하지 않습니다.")
        self.images = ImageCatalog(self.user_directory, set(self.tags))

    def close(self):
        self.images.close()

    def snapshot(self):
        with self.lock:
            visible = set(image_display_tags(self.tags, self.tags))
            categories = {}
            for entry in self.tags.values():
                if entry["tag"] not in visible:
                    continue
                for category in set(entry["categories"]):
                    categories[category] = categories.get(category, 0) + 1
            return {
                "source": {**self.payload["source"], "visible_tags": len(visible)},
                "categories": [
                    {"id": category, "label": self.category_labels.get(category, category), "count": count}
                    for category, count in sorted(categories.items())
                ],
                "tags": [dict(entry) for entry in self.tags.values() if entry["tag"] in visible],
            }

    def combinations(self, tag: str, offset: int, limit: int):
        if tag not in self.tags:
            raise KeyError(tag)
        indices = self.index[tag]
        return {
            "total": len(indices), "offset": offset, "limit": limit,
            "items": [{**self.rows[index], "general": ", ".join(image_display_tags(
                self.rows[index]["general"].split(", "), self.tags))}
                for index in indices[offset:offset + limit]],
        }

    def related(self, tag: str, limit: int):
        if tag not in self.tags:
            raise KeyError(tag)
        with self.lock:
            if tag not in self.related_cache:
                counts = Counter()
                for index in self.index[tag]:
                    counts.update(set(self.rows[index]["general"].split(", ")) - {tag})
                self.related_cache[tag] = counts.most_common()
            source_count = len(self.index[tag])
            items = []
            for other, count in self.related_cache[tag]:
                if not image_display_tags([other], self.tags):
                    continue
                percent = count / source_count * 100 if source_count else 0
                baseline = len(self.index[other]) / len(self.rows)
                items.append({"tag": other, "ko": self.tags[other]["ko"], "count": count,
                              "percent": round(percent, 1),
                              "lift": round((count / source_count) / baseline, 2) if baseline else 0})
                if len(items) >= limit:
                    break
            return {"tag": tag, "source_count": source_count,
                    "total_combinations": len(self.rows), "items": items}

    def statistics(self, tag=None, sort="combinations", offset=0, limit=15):
        if tag is not None and tag not in self.tags:
            raise KeyError(tag)
        if sort not in {"combinations", "images"}:
            raise ValueError("통계 정렬을 확인하세요.")
        images = self.images.statistics_counts()
        with self.lock:
            visible = image_display_tags(self.tags, self.tags)
            total = len(self.rows)
            image_total = images["total_images"]
            ordered = sorted(visible, key=lambda value: (-len(self.index[value]), value))
            ranks = {}
            previous_count = None
            rank = 0
            for position, value in enumerate(ordered, 1):
                count = len(self.index[value])
                if count != previous_count:
                    rank = position
                    previous_count = count
                ranks[value] = rank

            def item(value):
                count = len(self.index[value])
                image_count = images["tag_counts"].get(value, 0)
                return {"tag": value, "ko": self.tags[value]["ko"],
                        "combination_count": count,
                        "combination_percent": round(count / total * 100, 2) if total else 0,
                        "rank": ranks.get(value), "image_count": image_count,
                        "image_percent": round(image_count / image_total * 100, 2) if image_total else 0}

            if sort == "images":
                ordered.sort(key=lambda value: (-images["tag_counts"].get(value, 0),
                                                -len(self.index[value]), value))
            linked = sum(images["tag_counts"].get(value, 0) > 0 for value in visible)
            return {"overview": {"source_rows": total, "visible_tags": len(visible),
                                 "total_images": image_total, "linked_tags": linked,
                                 "unlinked_tags": len(visible) - linked,
                                 "coverage_percent": round(linked / len(visible) * 100, 1) if visible else 0},
                    "selected": item(tag) if tag is not None else None,
                    "ranking": [item(value) for value in ordered[offset:offset + limit]],
                    "total": len(ordered), "offset": offset, "limit": limit, "sort": sort}

    def edit(self, body: dict):
        tag = body.get("tag")
        if not isinstance(tag, str) or tag not in self.tags:
            raise ValueError("수정할 태그를 찾을 수 없습니다.")
        changes = {}
        for name, maximum in (("ko", 300), ("description", 5000)):
            value = body.get(name)
            if not isinstance(value, str) or len(value) > maximum:
                raise ValueError("번역 또는 설명의 형식과 길이를 확인하세요.")
            changes[name] = value.strip()
        if not changes["ko"]:
            raise ValueError("한국어 이름을 입력하세요.")
        categories = body.get("categories")
        if (not isinstance(categories, list) or not 1 <= len(categories) <= 30
                or any(not isinstance(value, str) or not value.strip() or len(value) > 200
                       for value in categories)):
            raise ValueError("분류를 하나 이상 입력하세요. 줄마다 분류 하나를 입력할 수 있습니다.")
        changes["categories"] = list(dict.fromkeys(value.strip() for value in categories))
        changes["translation_source"] = "사용자 수정"
        with self.lock, json_lock(self.overrides_path):
            updated = read_json(self.overrides_path, expected_type=dict)
            if not isinstance(updated, dict):
                updated = {}
            saved = updated.get(tag)
            merged = dict(saved) if isinstance(saved, dict) else {}
            merged.update(changes)
            updated[tag] = merged
            write_json(self.overrides_path, updated)
            self.overrides = updated
            self.tags[tag].update(changes)
            return dict(self.tags[tag])

    def export(self):
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        writer.writerow(["영문 태그", "한국어", "설명", "분류", "조합 수", "번역 출처"])
        for entry in self.snapshot()["tags"]:
            values = [entry["tag"], entry["ko"], entry["description"],
                      " | ".join(self.category_labels.get(category, category) for category in entry["categories"]),
                      entry["count"], entry["translation_source"]]
            writer.writerow(["'" + value if isinstance(value, str) and value.startswith(("=", "+", "-", "@"))
                             else value for value in values])
        return ("\ufeff" + output.getvalue()).encode("utf-8")
