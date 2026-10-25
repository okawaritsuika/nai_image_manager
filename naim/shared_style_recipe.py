"""Pure, local extraction of shared rendering recipes and source settings.

Extraction follows dakiMaker's reviewed V2 catalog rules so existing import-v5
identities remain stable. Source scene, character and uncertain tags are omitted.
"""
from functools import lru_cache
import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path

from naim._shared_style_syntax import key, parse, render, signature
from naim._shared_style_terms import classify, QUALITY_TAG_ALIASES, QUALITY_UC
from naim._shared_style_review import reviewed_edit
from naim.generation_settings import V5_FULL_MEDIUM, V5_MEDIUM_FIXED_SETTINGS
from naim.paths import get_app_dir


@lru_cache(maxsize=1)
def _artist_names():
    path = Path(__file__).resolve().parent.parent / 'data' / 'shared_style_artists.json'
    return frozenset(json.loads(path.read_text(encoding='utf-8'))['names'])


def _normalize_artist_key(value):
    normalized = key(value)
    normalized = re.sub(r'\s*\(\s*', ' (', normalized)
    return re.sub(r'\s*\)', ')', normalized)


def _normalized_artist_names(names):
    normalized = set()
    for name in names:
        if isinstance(name, str) and name.strip():
            value = _normalize_artist_key(name)
            if value:
                normalized.add(value)
    return normalized


def load_style_artist_names(dictionary_path=None):
    """Return normalized bundled and local Danbooru artist names, read-only."""
    names = _normalized_artist_names(_artist_names())
    path = (Path(dictionary_path) if dictionary_path is not None else
            Path(get_app_dir()) / 'data' / 'danbooru_tags.sqlite3')
    if not path.exists():
        return frozenset(names)

    connection = None
    try:
        uri = path.resolve().as_uri() + '?mode=ro'
        connection = sqlite3.connect(uri, uri=True)
        rows = connection.execute(
            'SELECT name FROM danbooru_tags WHERE category = 1'
        ).fetchall()
    except (OSError, sqlite3.Error, ValueError):
        raise ValueError('태그 사전을 읽을 수 없습니다.') from None
    finally:
        if connection is not None:
            connection.close()

    names.update(_normalized_artist_names(row[0] for row in rows))
    return frozenset(names)


def recipe_fingerprint(positive, negative):
    """Match the existing catalog's ordered, weighted JSON SHA-256 exactly."""
    return hashlib.sha256(json.dumps([signature(parse(positive)), signature(parse(negative))],
                                    ensure_ascii=False).encode()).hexdigest()


_DUPLICATE_STYLE_CATEGORIES = {
    'medium', 'line', 'color', 'painting', 'shading', 'rendering', 'style',
    '2d', '3d', 'complexity',
}
_QUALITY_DUPLICATE_TAGS = {key(tag) for tag in QUALITY_TAG_ALIASES} | set(QUALITY_UC)


def style_duplicate_key(positive, *, artist_names=None):
    """Return the import duplicate key without changing legacy recipe identity."""
    if not isinstance(positive, str) or len(positive) > 100000:
        raise ValueError('공유 그림체 프롬프트 형식을 확인해 주세요.')
    terms = parse(positive)
    names = _artist_names() if artist_names is None else artist_names

    artists = set()
    for term in terms:
        category, value = classify(term.text, names, version=2)
        if category == 'artist':
            artists.add(_normalize_artist_key(value.removeprefix('artist:')))
    if artists:
        return ('artists', tuple(sorted(artists)))

    styles = set()
    for term in terms:
        if key(term.text) in _QUALITY_DUPLICATE_TAGS:
            continue
        category, value = classify(term.text, names, version=2)
        if category in _DUPLICATE_STYLE_CATEGORIES:
            styles.add(key(value))
    return ('style', tuple(sorted(styles))) if styles else None


def extract_recipe(base_prompt, negative_prompt, *, artist_names=None):
    """Return a style-only recipe; reject unsupported or unidentified recipes."""
    names = _artist_names() if artist_names is None else artist_names
    selected = {}
    edits = []
    for field, raw in (('base_prompt', base_prompt), ('negative_prompt', negative_prompt)):
        if not isinstance(raw, str) or len(raw) > 100000:
            raise ValueError('공유 그림체 프롬프트 형식을 확인해 주세요.')
        try:
            tokens = parse(raw)
        except ValueError as error:
            tokens, changes, repaired = reviewed_edit(raw)
            edits.append({'field': field, 'original_error': str(error),
                          'edits': changes, 'repaired_prompt': repaired})
        selected[field] = [term for term in tokens if classify(term.text, names, version=2)[0]
                           or (field == 'negative_prompt'
                               and term.text.casefold().strip() in QUALITY_UC)]
    positive = selected['base_prompt']
    negative = selected['negative_prompt']
    if not any(classify(term.text, names, version=2)[0] in
               {'artist', 'medium', 'line', 'color', 'painting', 'shading', 'rendering', 'style'}
               for term in positive):
        raise ValueError('식별할 수 있는 작가 또는 그림체 태그가 없습니다.')
    fingerprint = hashlib.sha256(json.dumps([signature(positive), signature(negative)],
                                           ensure_ascii=False).encode()).hexdigest()
    return {'positive': render(positive), 'negative': render(negative),
            'fingerprint': fingerprint, 'import_edits': edits}


_OPTION_FIELDS = {
    'steps': 'steps', 'cfg': 'scale', 'sampler': 'sampler',
    'noise_schedule': 'noise_schedule', 'cfg_rescale': 'cfg_rescale',
    'deliberate_euler_ancestral_bug': 'deliberate_euler_ancestral_bug',
    'prefer_brownian': 'prefer_brownian', 'dynamic_thresholding': 'dynamic_thresholding',
    'legacy_v3_extend': 'legacy_v3_extend', 'strength': 'strength', 'noise': 'noise',
}
_BOOLEAN_FIELDS = {'deliberate_euler_ancestral_bug', 'prefer_brownian',
                   'dynamic_thresholding', 'legacy_v3_extend'}
_REQUIRED_FIELDS = {'steps', 'cfg', 'sampler', 'noise_schedule', 'cfg_rescale'}


def original_options(raw, model):
    """Preserve raw zero/false values; only Medium's model constraints are fixed."""
    if not isinstance(raw, dict):
        raise ValueError('원본 생성 메타데이터는 객체여야 합니다.')
    options = {}
    for target, source in _OPTION_FIELDS.items():
        if source not in raw or raw[source] is None:
            continue
        value = raw[source]
        if target in _BOOLEAN_FIELDS:
            valid = type(value) is bool
        elif target in {'sampler', 'noise_schedule'}:
            valid = isinstance(value, str) and bool(value.strip())
        else:
            valid = type(value) in (int, float) and math.isfinite(value)
            if target == 'steps':
                valid = valid and value == int(value) and value > 0
                if valid:
                    value = int(value)
        if not valid:
            raise ValueError(f'원본 {source} 설정을 확인해 주세요.')
        options[target] = value
    if model == V5_FULL_MEDIUM:
        options.update(V5_MEDIUM_FIXED_SETTINGS)
    missing = _REQUIRED_FIELDS - options.keys()
    if missing:
        raise ValueError('원본 생성 설정이 없습니다: ' + ', '.join(sorted(missing)))
    return options
