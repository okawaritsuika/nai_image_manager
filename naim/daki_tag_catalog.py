"""Read-only dakiMaker dictionary with separate NAIM user example references."""
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import re
import threading
from urllib.parse import urlencode

from naim.images.webp_conversion import resolve_webp_image


class DakiTagCatalogUnavailable(FileNotFoundError):
    pass


def display_label(tag):
    return (tag.get('label_ko') or tag['tag']) if tag.get('regions') else tag['tag']


class DakiTagCatalog:
    PAGE_SIZE = 40

    def __init__(self, root_provider, examples_store=None):
        self.root_provider = root_provider
        self.examples_store = examples_store
        self._lock = threading.RLock()
        self._signature = None
        self._tags = []
        self._by_tag = {}
        self._by_normalized_tag = {}
        self._categories = []
        self._labels = {}

    def _root(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        if not value:
            raise DakiTagCatalogUnavailable('다키메이커 태그사전 원본 폴더를 찾을 수 없습니다.')
        return Path(value).resolve()

    def _load(self):
        root = self._root()
        files = [root / name for name in ('tags.json', 'rules.json')]
        try:
            signature = (str(root), *((p.stat().st_mtime_ns, p.stat().st_size) for p in files))
        except FileNotFoundError as error:
            raise DakiTagCatalogUnavailable('다키메이커 태그사전 원본이 없습니다. 원본 폴더의 tags.json과 rules.json을 확인해 주세요.') from error
        if signature == self._signature:
            return root
        try:
            tags = json.loads(files[0].read_text('utf-8-sig'))['tags']
            rules = json.loads(files[1].read_text('utf-8-sig'))['regions']
            if not isinstance(tags, list) or not isinstance(rules, dict):
                raise ValueError()
            if any(not isinstance(t, dict) or not isinstance(t.get('tag'), str) for t in tags):
                raise ValueError()
            regions = Counter(r for t in tags for r in t.get('regions', []))
            sections = Counter(s for t in tags for s in t.get('sections', []))
            auxiliary = Counter(a for t in tags for a in t.get('auxiliary', []))
            categories = [{'id': 'all', 'label': '전체 태그', 'count': len(tags), 'sections': []}]
            for key, rule in rules.items():
                categories.append({'id': key, 'label': rule['label'], 'count': regions[key], 'group': '신체·특징',
                    'sections': [{'id': key + '.' + s, 'label': v['label'], 'count': sections[key + '.' + s]}
                                 for s, v in rule['sections'].items()]})
            categories.extend({'id': 'aux:' + label, 'label': label, 'count': auxiliary[label],
                               'group': '장면·스타일·기타', 'sections': []}
                              for label in sorted(auxiliary, key=lambda a: (a == '기타·분류 확인', a)))
            labels = {t['tag'].lower().replace('_', ' '): display_label(t) for t in tags if t.get('regions')}
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            raise ValueError('다키메이커 태그사전 원본 형식을 읽을 수 없습니다.') from error
        labels.update({'adult woman': '성인 여성', 'adult man': '성인 남성', 'facing the viewer': '보는 사람을 향함',
                       'bad face': '잘못 그린 얼굴', 'bad eyes': '잘못 그린 눈', 'fused fingers': '붙어 있는 손가락'})
        normalized_tags = {}
        ambiguous_tags = set()
        for tag in tags:
            normalized = self._normalize_token(tag['tag'])
            canonical = normalized_tags.get(normalized)
            if canonical is not None and canonical != tag['tag']:
                ambiguous_tags.add(normalized)
            else:
                normalized_tags[normalized] = tag['tag']
        for normalized in ambiguous_tags:
            normalized_tags.pop(normalized, None)
        self._tags, self._by_tag = tags, {t['tag']: t for t in tags}
        self._by_normalized_tag, self._categories, self._labels = normalized_tags, categories, labels
        self._signature = signature
        return root

    @staticmethod
    def _normalize_token(token):
        return re.sub(r'\s+', ' ', token.replace('_', ' ')).strip().casefold()

    def categories(self):
        with self._lock:
            self._load()
            return deepcopy(self._categories)

    @staticmethod
    def image_url(tag, index, full=False):
        return '/api/daki/tag-catalog/example?' + urlencode({'tag': tag, 'index': index, 'full': int(full)})

    @staticmethod
    def user_image_url(tag, example_id, full=False):
        return '/api/daki/tag-catalog/example?' + urlencode({'tag': tag, 'id': example_id, 'full': int(full)})

    def _row(self, tag, user_examples=()):
        examples = tag.get('examples', [])
        return {'tag': tag['tag'], 'label_ko': display_label(tag), 'description_ko': tag.get('description_ko'),
                'thumbnail': (self.image_url(tag['tag'], 0) if examples else
                              self.user_image_url(tag['tag'], user_examples[0]['id']) if user_examples else None),
                'exampleKind': examples[0].get('relation', 'direct') if examples else 'direct' if user_examples else None}

    def browse(self, category='all', section='', query='', examples_only=False, page=1):
        if not isinstance(query, str) or len(query) > 1000:
            raise ValueError('검색어는 1,000자 이내로 입력해 주세요.')
        try:
            page = int(page)
        except (ValueError, TypeError) as error:
            raise ValueError('태그사전 페이지 번호를 확인해 주세요.') from error
        if page < 1:
            raise ValueError('태그사전 페이지 번호를 확인해 주세요.')
        with self._lock:
            self._load()
            user_examples = {}
            for example in self.examples_store.list_examples() if self.examples_store else []:
                user_examples.setdefault(example['tag'], []).append(example)
            info = next((c for c in self._categories if c['id'] == category), None)
            if info is None or section and section not in {s['id'] for s in info['sections']}:
                raise ValueError('태그 카테고리와 세부 분류를 확인해 주세요.')
            query = query.strip().lower().replace('_', ' ')
            matches = []
            for tag in self._tags:
                if category.startswith('aux:'):
                    if category[4:] not in tag.get('auxiliary', []):
                        continue
                elif category != 'all' and category not in tag.get('regions', []):
                    continue
                if section and section not in tag.get('sections', []):
                    continue
                if examples_only and not tag.get('examples') and not user_examples.get(tag['tag']):
                    continue
                if query and query not in ' '.join(str(tag.get(k) or '') for k in ('tag', 'label_ko', 'description_ko')).lower().replace('_', ' '):
                    continue
                matches.append(tag)
            pages = max(1, (len(matches) + self.PAGE_SIZE - 1) // self.PAGE_SIZE)
            page = min(page, pages)
            return {'items': [self._row(t, user_examples.get(t['tag'], [])) for t in matches[(page - 1) * self.PAGE_SIZE:page * self.PAGE_SIZE]],
                    'total': len(matches), 'page': page, 'pages': pages, 'pageSize': self.PAGE_SIZE}

    def detail(self, tag):
        with self._lock:
            self._load()
            item = self._by_tag.get(tag)
            if item is None:
                raise KeyError('태그를 찾을 수 없습니다.')
            fields = ('tag', 'description_ko', 'description_status', 'description_review', 'description_original_en',
                      'description_source_license', 'description_references', 'ambiguity_note_ko', 'required_attires', 'auto_insert_disabled')
            result = {k: deepcopy(item.get(k)) for k in fields}
            result.update(label_ko=display_label(item),
                categories=[s['label'] for c in self._categories for s in c['sections'] if s['id'] in item.get('sections', [])] + item.get('auxiliary', []),
                notes=[n['reason'] for n in item.get('compatibility_notes', []) if n.get('reason')],
                related=[{'tag': t, 'label_ko': display_label(self._by_tag[t])} for t in item.get('comparison_tags', []) if t in self._by_tag],
                examples=[{**{k: e.get(k) for k in ('tag', 'relation', 'review_note', 'reference_note')},
                           'thumbnail': self.image_url(tag, i), 'image': self.image_url(tag, i, True)}
                          for i, e in enumerate(item.get('examples', []))])
            for example in self.examples_store.list_examples(tag) if self.examples_store else []:
                result['examples'].append({'id': example['id'], 'tag': tag, 'path': example['path'],
                    'relation': 'direct', 'user_added': True, 'reference_note': '직접 추가한 예시 · 원본 위치 연결',
                    'thumbnail': self.user_image_url(tag, example['id']),
                    'image': self.user_image_url(tag, example['id'], True)})
            return result

    def classify_tokens(self, tokens):
        if not isinstance(tokens, list):
            raise ValueError('태그 토큰은 배열로 입력해 주세요.')
        if len(tokens) > 2000:
            raise ValueError('분류할 태그는 2,000개 이내로 입력해 주세요.')
        total_length = 0
        for token in tokens:
            if not isinstance(token, str):
                raise ValueError('각 태그 토큰은 문자열로 입력해 주세요.')
            if len(token) > 500:
                raise ValueError('각 태그 토큰은 500자 이내로 입력해 주세요.')
            total_length += len(token)
        if total_length > 50000:
            raise ValueError('태그 토큰은 총 50,000자 이내로 입력해 주세요.')
        with self._lock:
            self._load()
            items = []
            for token in tokens:
                canonical = self._by_normalized_tag.get(self._normalize_token(token))
                tag = self._by_tag.get(canonical) if canonical is not None else None
                items.append({'token': token, 'tag': canonical,
                              'regions': deepcopy(tag.get('regions', [])) if tag else [],
                              'sections': deepcopy(tag.get('sections', [])) if tag else []})
            return {'items': items}

    def example_path(self, tag, index=0, full=False, example_id=None):
        if example_id is not None:
            self.detail(tag)
            if self.examples_store is None:
                raise KeyError('등록된 태그 예시를 찾을 수 없습니다.')
            source = Path(self.examples_store.image_path(tag, example_id))
            if source.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
                raise ValueError('예시 그림 경로가 올바르지 않습니다.')
            path = resolve_webp_image(source).resolve()
            if path.parent != source.resolve().parent:
                raise ValueError('예시 그림 경로가 올바르지 않습니다.')
            if not path.is_file():
                raise FileNotFoundError('예시 그림 원본을 찾을 수 없습니다.')
            return path
        try:
            index = int(index)
        except (ValueError, TypeError) as error:
            raise ValueError('예시 그림 번호를 확인해 주세요.') from error
        with self._lock:
            root = self._load()
            item = self._by_tag.get(tag)
            if item is None or not 0 <= index < len(item.get('examples', [])):
                raise KeyError('예시 그림을 찾을 수 없습니다.')
            relative = item['examples'][index].get('image' if full else 'thumbnail')
            if not isinstance(relative, str) or not relative:
                raise ValueError('예시 그림 경로가 올바르지 않습니다.')
            source = root / relative
            if source.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
                raise ValueError('예시 그림 경로가 올바르지 않습니다.')
            path = resolve_webp_image(source).resolve()
            if not path.is_relative_to(root) or not path.is_relative_to((root / 'visuals').resolve()) or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
                raise ValueError('예시 그림 경로가 올바르지 않습니다.')
            if not path.is_file():
                raise FileNotFoundError('예시 그림 원본을 찾을 수 없습니다.')
            return path

    def translate(self, text):
        if not isinstance(text, str) or len(text) > 50000:
            raise ValueError('번역할 프롬프트는 50,000자 이내로 입력해 주세요.')
        with self._lock:
            self._load()
            parts = re.split(r'(-?\d+(?:\.\d+)?::|::|[{},\[\]\n|])', text)
            translated = untranslated = 0
            for i in range(0, len(parts), 2):
                raw = parts[i].strip()
                if not raw:
                    continue
                label = self._labels.get(raw.lower().replace('_', ' '))
                if label and label != raw and re.search('[가-힣]', label):
                    parts[i] = parts[i].replace(raw, label, 1)
                    translated += 1
                elif not re.search('[가-힣]', raw):
                    untranslated += 1
            return {'text': ''.join(parts), 'translated': translated, 'untranslated': untranslated}
