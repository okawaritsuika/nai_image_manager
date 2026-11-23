"""Read-only bilingual autocomplete for prompt tags."""

import csv
import heapq
import io
import json
import logging
import os
from pathlib import Path
import tempfile
import threading


_CSV_FILES = (
    'action.csv', 'artist.csv', 'attire.csv', 'character.csv', 'count.csv',
    'expression.csv', 'feature.csv', 'meme.csv', 'meta.csv', 'object.csv',
    'other.csv', 'series.csv', 'setting.csv', 'style.csv',
)
_DEFAULT_LIMIT = 12
_MAX_LIMIT = 30
_MAX_QUERY_LENGTH = 100
MAX_IMPORT_BYTES = 40 * 1024 * 1024
_LOGGER = logging.getLogger(__name__)


class PromptSuggestionDataError(Exception):
    """The bundled prompt suggestion data is missing or invalid."""


def _normalize(value):
    return ' '.join(value.replace('_', ' ').casefold().split())


def _parse_import(content):
    if not content or len(content) > MAX_IMPORT_BYTES:
        raise ValueError('40MB 이하의 한글 태그 CSV를 선택해 주세요.')

    tags = {}
    try:
        with io.TextIOWrapper(io.BytesIO(content), encoding='utf-8-sig', newline='') as stream:
            for tag, category, count, text in csv.reader(stream, strict=True):
                tag = tag.strip()
                key = _normalize(tag)
                count = int(count)
                if not key or any(char in tag for char in ',\r\n\x00') or int(category) < 0 or count < 0:
                    raise ValueError
                _, _, keywords = text.partition('<키워드>')
                aliases = {}
                for word in keywords.split(','):
                    label = word.strip(' \t\r\n.')
                    alias = _normalize(label)
                    if alias:
                        aliases.setdefault(alias, label)
                label = next(iter(aliases.values()), '')
                normalized = tuple(aliases)
                previous = tags.get(key)
                if previous is not None:
                    if count <= previous[1]:
                        if previous[3] or not normalized:
                            continue
                        tag, count = previous[:2]
                    elif not normalized:
                        label, normalized = previous[2:]
                tags[key] = (tag, count, label, normalized)
    except (ValueError, csv.Error) as error:
        raise ValueError('CSV 형식을 읽을 수 없습니다. 원본 다운로드 링크의 UTF-8 CSV를 선택해 주세요.') from error
    if not tags:
        raise ValueError('CSV에 가져올 태그가 없습니다.')
    if not any(aliases for _, _, _, aliases in tags.values()):
        raise ValueError('한글 검색 키워드가 없습니다. 원본 다운로드 링크의 CSV를 선택해 주세요.')
    return tags


class PromptSuggestionCatalog:
    """Lazily load and search a read-only prompt tag catalog."""

    def __init__(self, directory, import_path=None):
        self._directory = Path(directory)
        self._import_path = Path(import_path) if import_path else None
        self._entries = None
        self._load_lock = threading.Lock()
        self._import_stamp = None
        self._import_state = 'missing'

    def has_import(self):
        return self.import_state() == 'applied'

    def _file_stamp(self):
        if self._import_path is None:
            return None
        try:
            stat = self._import_path.stat()
        except FileNotFoundError:
            return None
        except OSError:
            return ('unreadable',)
        return stat.st_mtime_ns, stat.st_size, stat.st_ino

    def import_state(self):
        with self._load_lock:
            stamp = self._file_stamp()
            if stamp != self._import_stamp:
                self._reload_entries(stamp)
            return self._import_state

    def import_csv(self, content):
        imported = _parse_import(content)
        path = self._import_path
        with self._load_lock:
            entries = self._load_entries(imported)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.tmp', delete=False) as target:
                    temporary = Path(target.name)
                    target.write(content)
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            self._entries = entries
            self._import_stamp = self._file_stamp()
            self._import_state = 'applied'
        return len(imported)

    def _reload_entries(self, stamp):
        imported = {}
        state = 'missing'
        if stamp is not None:
            try:
                with self._import_path.open('rb') as source:
                    imported = _parse_import(source.read(MAX_IMPORT_BYTES + 1))
                state = 'applied'
            except FileNotFoundError:
                stamp = None
            except (OSError, ValueError):
                state = 'invalid'
                _LOGGER.warning('Could not read the local prompt tag CSV. Using built-in suggestions.')
        self._entries = self._load_entries(imported)
        self._import_stamp = stamp
        self._import_state = state

    def _load_entries(self, imported):
        try:
            translations = json.loads(
                (self._directory / 'ko.json').read_text(encoding='utf-8')
            )
            if not isinstance(translations, dict) or any(
                    not isinstance(tag, str) or not isinstance(label, str)
                    for tag, label in translations.items()):
                raise ValueError('invalid Korean dictionary')

            counts = {}
            for filename in _CSV_FILES:
                with (self._directory / filename).open(
                        'r', encoding='utf-8-sig', newline='') as stream:
                    reader = csv.DictReader(stream)
                    if reader.fieldnames != ['tag', 'count']:
                        raise ValueError('invalid CSV header')
                    for row in reader:
                        tag = row.get('tag')
                        raw_count = row.get('count')
                        if (not isinstance(tag, str) or not tag.strip()
                                or tag != tag.strip() or raw_count is None
                                or None in row):
                            raise ValueError('invalid CSV row')
                        count = int(raw_count) if raw_count else 0
                        if count < 0:
                            raise ValueError('invalid tag count')
                        counts[tag] = max(count, counts.get(tag, count))

            entries = []
            bundled_keys = set()
            for tag, count in sorted(counts.items()):
                key = _normalize(tag)
                bundled_keys.add(key)
                _, _, imported_label, aliases = imported.get(key, ('', 0, '', ()))
                label = translations.get(tag) or imported_label
                entries.append((tag, label, count, key, _normalize(label), aliases))
            entries.extend(
                (tag, label, count, key, _normalize(label), aliases)
                for key, (tag, count, label, aliases) in imported.items()
                if key not in bundled_keys
            )
            return tuple(entries)
        except (OSError, UnicodeError, csv.Error, json.JSONDecodeError,
                TypeError, ValueError) as error:
            raise PromptSuggestionDataError from error

    def _get_entries(self):
        with self._load_lock:
            stamp = self._file_stamp()
            if self._entries is None or stamp != self._import_stamp:
                self._reload_entries(stamp)
            return self._entries

    def suggest(self, query, limit=_DEFAULT_LIMIT):
        query = query.strip()
        if len(query) > _MAX_QUERY_LENGTH:
            raise ValueError('검색어는 100자 이하여야 합니다.')
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _MAX_LIMIT:
            raise ValueError('limit은 1부터 30 사이여야 합니다.')
        if not query:
            return []

        normalized_query = _normalize(query)
        if not normalized_query:
            return []

        def matches():
            for tag, korean, count, normalized_tag, normalized_korean, aliases in self._get_entries():
                if (normalized_query == normalized_tag
                        or normalized_query == normalized_korean or normalized_query in aliases):
                    rank = 0
                elif (normalized_tag.startswith(normalized_query)
                      or normalized_korean.startswith(normalized_query)
                      or (aliases and any(alias.startswith(normalized_query) for alias in aliases))):
                    rank = 1
                elif (normalized_query in normalized_tag
                      or normalized_query in normalized_korean
                      or (aliases and any(normalized_query in alias for alias in aliases))):
                    rank = 2
                else:
                    continue
                yield rank, -count, tag, korean, count

        selected = heapq.nsmallest(limit, matches())
        return [
            {'tag': tag, 'ko': korean, 'count': count}
            for _, _, tag, korean, count in selected
        ]


