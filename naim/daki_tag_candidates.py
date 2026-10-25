"""Exact positive-tag matching and bounded, read-only candidate search pages."""
from collections import OrderedDict
from copy import deepcopy
import re
import threading
from urllib.parse import quote

from naim.storage.daki_projects import normalize_relative_path


def normalize_tag(value):
    return re.sub(r'\s+', ' ', str(value or '').replace('_', ' ')).strip().lower()


def positive_prompt_parts(info):
    """Read positive aliases from gallery metadata, draft settings, or payloads."""
    if not isinstance(info, dict):
        return
    for key in ('basePrompt', 'baseCaption', 'prompt', 'base_prompt', 'charPrompt', 'characterPrompt'):
        if isinstance(info.get(key), str):
            yield info[key]
    for key in ('charPrompts', 'char_prompts'):
        values = info.get(key)
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str):
                    yield value
                elif isinstance(value, dict) and isinstance(value.get('prompt'), str):
                    yield value['prompt']
    section = info.get('v4_prompt')
    caption = section.get('caption') if isinstance(section, dict) else None
    if isinstance(caption, dict):
        if isinstance(caption.get('base_caption'), str):
            yield caption['base_caption']
        values = caption.get('char_captions')
        if isinstance(values, list):
            for value in values:
                if isinstance(value, dict) and isinstance(value.get('char_caption'), str):
                    yield value['char_caption']


def has_positive_tag(info, tag):
    expected = normalize_tag(tag)
    if not expected:
        return False
    for text in positive_prompt_parts(info):
        # Numeric :: groups and brace/bracket emphasis surround whole tags.
        # Parentheses are part of real tag names and must remain intact.
        text = re.sub(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)::', '', text)
        text = text.replace('::', '').translate(str.maketrans('', '', '{}[]'))
        if any(normalize_tag(token) == expected for token in re.split(r'[,\r\n]+', text)):
            return True
    return False


class DakiTagCandidates:
    PAGE_SIZE = 40
    MAX_SEARCHES = 4

    def __init__(self, rows_provider, context_provider=lambda: None):
        self.rows_provider = rows_provider
        self.context_provider = context_provider
        self._lock = threading.RLock()
        self._cache = OrderedDict()

    def search(self, tag, page=1):
        if not isinstance(tag, str) or not tag.strip() or len(tag) > 1000:
            raise ValueError('검색할 태그를 확인해 주세요.')
        try:
            page = int(page)
        except (TypeError, ValueError):
            raise ValueError('후보 그림 페이지 번호를 확인해 주세요.') from None
        if page < 1:
            raise ValueError('후보 그림 페이지 번호를 확인해 주세요.')
        with self._lock:
            key = (self.context_provider(), tag)
            if page == 1 or key not in self._cache:
                items, seen = [], set()
                for row in self.rows_provider(tag):
                    if not has_positive_tag(row.get('prompt_info'), tag):
                        continue
                    try:
                        path = normalize_relative_path(row.get('path'))
                    except ValueError:
                        continue
                    if path in seen:
                        continue
                    seen.add(path)
                    items.append({'path': path, 'name': str(row.get('name') or path.rsplit('/', 1)[-1]),
                                  'src': '/image/' + quote(path, safe='/') + '?preview=512'})
                self._cache[key] = items
            self._cache.move_to_end(key)
            while len(self._cache) > self.MAX_SEARCHES:
                self._cache.popitem(last=False)
            items = self._cache[key]
            pages = max(1, (len(items) + self.PAGE_SIZE - 1) // self.PAGE_SIZE)
            page = min(page, pages)
            return {'items': deepcopy(items[(page - 1) * self.PAGE_SIZE:page * self.PAGE_SIZE]),
                    'total': len(items), 'page': page, 'pages': pages}
