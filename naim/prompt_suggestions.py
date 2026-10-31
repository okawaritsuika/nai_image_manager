"""Read-only bilingual autocomplete for prompt tags."""

import csv
import heapq
import json
from pathlib import Path
import threading


_CSV_FILES = (
    'action.csv', 'artist.csv', 'attire.csv', 'character.csv', 'count.csv',
    'expression.csv', 'feature.csv', 'meme.csv', 'meta.csv', 'object.csv',
    'other.csv', 'series.csv', 'setting.csv', 'style.csv',
)
_DEFAULT_LIMIT = 12
_MAX_LIMIT = 30
_MAX_QUERY_LENGTH = 100


class PromptSuggestionDataError(Exception):
    """The bundled prompt suggestion data is missing or invalid."""


def _normalize(value):
    return ' '.join(value.replace('_', ' ').casefold().split())


class PromptSuggestionCatalog:
    """Lazily load and search a read-only prompt tag catalog."""

    def __init__(self, directory):
        self._directory = Path(directory)
        self._entries = None
        self._load_lock = threading.Lock()

    def _load_entries(self):
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

            return tuple(
                (tag, translations.get(tag, ''), count,
                 _normalize(tag), _normalize(translations.get(tag, '')))
                for tag, count in sorted(counts.items())
            )
        except (OSError, UnicodeError, csv.Error, json.JSONDecodeError,
                TypeError, ValueError) as error:
            raise PromptSuggestionDataError from error

    def _get_entries(self):
        if self._entries is None:
            with self._load_lock:
                if self._entries is None:
                    self._entries = self._load_entries()
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
            for entry in self._get_entries():
                tag, korean, count, normalized_tag, normalized_korean = entry
                if (normalized_query == normalized_tag
                        or normalized_query == normalized_korean):
                    rank = 0
                elif (normalized_tag.startswith(normalized_query)
                      or normalized_korean.startswith(normalized_query)):
                    rank = 1
                elif (normalized_query in normalized_tag
                      or normalized_query in normalized_korean):
                    rank = 2
                else:
                    continue
                yield rank, -count, tag, korean, count

        selected = heapq.nsmallest(limit, matches())
        return [
            {'tag': tag, 'ko': korean, 'count': count}
            for _, _, tag, korean, count in selected
        ]


