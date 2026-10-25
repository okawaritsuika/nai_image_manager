"""Read-only source catalogs and local exclusions from the shared-style list."""
from copy import deepcopy
import json
from pathlib import Path, PurePosixPath
import re
import threading

from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.json_files import json_lock, write_json
from naim.storage.daki_style_sources import DakiStyleSources
from naim.storage.daki_style_dates import style_sort_date
from naim.images.webp_conversion import resolve_webp_image


_REALISTIC = re.compile(r'\b(?:photorealistic|realistic)\b', re.IGNORECASE)
_CATALOG_FILES = ('default_styles.json', 'source_generation_options.json',
                  'generation_manifest.json')
_IMAGE_SUFFIXES = {'.png', '.jpg', '.jpeg', '.webp'}
_MAX_REMOVE_IDS = 10000


def excluded_style(positive):
    """Negative prompts are deliberately excluded: they can suppress realism."""
    return bool(_REALISTIC.search(positive))


class DakiSharedStyles:
    def __init__(self, catalog_root_provider, imported_root_provider=None):
        self.catalog_root_provider = catalog_root_provider
        self.imported_root_provider = imported_root_provider
        self.sources = DakiStyleSources(imported_root_provider)
        self._lock = threading.RLock()
        self._signature = None
        self._records = {}
        self._previews = {}
        self._root = None
        self._hidden_ids = set()

    def _catalog_root(self):
        value = (self.catalog_root_provider() if callable(self.catalog_root_provider)
                 else self.catalog_root_provider)
        if not value:
            raise FileNotFoundError('공유 그림체 폴더를 찾을 수 없습니다.')
        return Path(value).resolve()

    def _imported_root(self):
        value = (self.imported_root_provider() if callable(self.imported_root_provider)
                 else self.imported_root_provider)
        return Path(value).resolve() if value else None

    def _exclusions_path(self):
        root = self._imported_root()
        if root is None:
            return None
        path = root / 'excluded_styles.json'
        if path.resolve().parent != root:
            raise ValueError('공유 그림체 제외 목록의 저장 위치가 올바르지 않습니다.')
        return path

    def _excluded_ids(self, path):
        if path is None or not path.exists():
            return set()
        data = self._read(path)
        ids = data.get('style_ids')
        if (data.get('version') != 1 or not isinstance(ids, list)
                or any(not isinstance(sid, str) or not sid or len(sid) > 128 for sid in ids)):
            raise ValueError('공유 그림체 제외 목록의 형식이 올바르지 않습니다.')
        return set(ids)

    @staticmethod
    def _read(path):
        try:
            with path.open(encoding='utf-8') as source:
                data = json.load(source)
        except FileNotFoundError as error:
            raise FileNotFoundError('공유 그림체 자료를 찾을 수 없습니다.') from error
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ValueError('공유 그림체 자료를 읽을 수 없습니다.') from error
        if not isinstance(data, dict):
            raise ValueError('공유 그림체 자료 형식이 올바르지 않습니다.')
        return data

    @staticmethod
    def _image_path(root, value):
        if not isinstance(value, str) or not value or '\x00' in value:
            raise ValueError('공유 그림체 이미지 경로가 올바르지 않습니다.')
        relative = PurePosixPath(value.replace('\\', '/'))
        if (relative.is_absolute() or '..' in relative.parts
                or any(':' in part for part in relative.parts)
                or relative.suffix.lower() not in _IMAGE_SUFFIXES):
            raise ValueError('공유 그림체 이미지 경로가 올바르지 않습니다.')
        root = Path(root).resolve()
        target = resolve_webp_image(root / str(relative)).resolve()
        if not target.is_relative_to(root):
            raise ValueError('공유 그림체 폴더 안의 이미지만 사용할 수 있습니다.')
        return target

    def _load(self):
        root = self._catalog_root()
        imported_root = self._imported_root()
        try:
            stats = [(root / name).stat() for name in _CATALOG_FILES]
        except OSError as error:
            # A standalone installation can collect its first local catalog.
            # A partially present legacy catalog still surfaces its read error.
            if imported_root is None or any((root / name).exists() for name in _CATALOG_FILES):
                raise FileNotFoundError('공유 그림체 자료를 찾을 수 없습니다.') from error
            stats = []
        imported_path = imported_root / 'catalog.json' if imported_root else None
        imported_stat = imported_path.stat() if imported_path and imported_path.is_file() else None
        synced_path = imported_root / 'sync_catalog.json' if imported_root else None
        synced_stat = synced_path.stat() if synced_path and synced_path.is_file() else None
        signature = (root, tuple((stat.st_mtime_ns, stat.st_size) for stat in stats),
                     imported_root, (imported_stat.st_mtime_ns, imported_stat.st_size) if imported_stat else None,
                     (synced_stat.st_mtime_ns, synced_stat.st_size) if synced_stat else None)
        if signature == self._signature:
            return
        catalog, source_options, manifest = ([self._read(root / name) for name in _CATALOG_FILES]
                                             if stats else ({'styles': []}, {'styles': {}}, {'jobs': {}}))
        styles = catalog.get('styles')
        options_by_id = source_options.get('styles')
        jobs = manifest.get('jobs')
        if not isinstance(styles, list) or not isinstance(options_by_id, dict) or not isinstance(jobs, dict):
            raise ValueError('공유 그림체 자료 형식이 올바르지 않습니다.')
        records, previews = {}, {}
        for style in styles:
            if not isinstance(style, dict) or any(not isinstance(style.get(key), str)
                                                 for key in ('id', 'name', 'model', 'positive', 'negative')):
                raise ValueError('공유 그림체 항목 형식이 올바르지 않습니다.')
            if excluded_style(style['positive']):
                continue
            sid = style['id']
            preview = style.get('preview')
            source = options_by_id.get(sid)
            if (not sid or sid in records or not isinstance(preview, dict)
                    or not isinstance(source, dict) or not isinstance(source.get('options'), dict)):
                raise ValueError('공유 그림체 생성 설정을 찾을 수 없습니다.')
            if source.get('source_image_id') != style.get('source_image_id'):
                raise ValueError('공유 그림체 생성 설정의 원본 이미지가 일치하지 않습니다.')
            job = jobs.get(preview.get('job_id'))
            seed = job.get('seed') if isinstance(job, dict) else None
            if (not isinstance(job, dict) or job.get('status') != 'success'
                    or type(seed) is not int or not 0 <= seed <= 9007199254740991):
                raise ValueError('공유 그림체 미리보기의 시드를 확인할 수 없습니다.')
            if any(type(preview.get(key)) is not int or preview[key] <= 0 for key in ('width', 'height')):
                raise ValueError('공유 그림체 이미지 크기가 올바르지 않습니다.')
            paths = {key: preview.get(key) for key in ('image', 'thumbnail')}
            for value in paths.values():
                self._image_path(root, value)
            records[sid] = {key: deepcopy(style.get(key)) for key in (
                'id', 'name', 'model', 'positive', 'negative', 'source_image_id', 'source_url',
                'recommendation_count', 'recommendation_collected_at')}
            records[sid].update(options=deepcopy(source['options']), seed=seed, category='upper',
                                preview={key: preview[key] for key in ('width', 'height')})
            if isinstance(style.get('source_posted_at'), str):
                records[sid]['source_posted_at'] = style['source_posted_at']
            previews[sid] = {key: (root, value) for key, value in paths.items()}
            records[sid]['sort_date'] = style_sort_date(style, self._image_path(root, paths['image']))
        hidden_ids = set()
        active_style_ids = None
        has_active_snapshot = False
        for imported_path, imported_stat in ((imported_path, imported_stat), (synced_path, synced_stat)):
            if not imported_stat:
                continue
            imported = self._read(imported_path)
            imported_styles = imported.get('styles')
            is_synced_catalog = imported_path == synced_path
            append_catalog = (is_synced_catalog and isinstance(imported.get('huggingface'), dict)
                              and imported['huggingface'].get('update_mode') == 'append')
            if is_synced_catalog and 'active_style_ids' in imported:
                active_style_ids = imported.get('active_style_ids')
                if (not isinstance(active_style_ids, list)
                        or any(not isinstance(sid, str) or not sid or len(sid) > 128
                               for sid in active_style_ids)
                        or len(set(active_style_ids)) != len(active_style_ids)):
                    raise ValueError('최신화한 공유 그림체 목록의 형식이 올바르지 않습니다.')
                has_active_snapshot = True
            image_root = imported.get('source_image_root')
            if is_synced_catalog:
                # Local collection files move together with the installation.
                if image_root != '.':
                    raise ValueError('최신화한 공유 그림체 이미지 위치가 올바르지 않습니다.')
                image_root = str(imported_root)
            hidden = imported.get('hidden_style_ids', [])
            if (not isinstance(imported_styles, list) or not isinstance(image_root, str)
                    or not Path(image_root).is_absolute() or not isinstance(hidden, list)
                    or any(not isinstance(sid, str) for sid in hidden)):
                raise ValueError('가져온 공유 그림체 자료 형식이 올바르지 않습니다.')
            image_root = Path(image_root).resolve()
            sync_style_ids = set()
            for style in imported_styles:
                if not isinstance(style, dict) or any(not isinstance(style.get(key), str)
                        for key in ('id', 'name', 'model', 'positive', 'negative')):
                    raise ValueError('가져온 공유 그림체 항목 형식이 올바르지 않습니다.')
                sid = style['id']
                if is_synced_catalog and (has_active_snapshot or append_catalog):
                    if not sid or sid in sync_style_ids:
                        raise ValueError('최신화한 공유 그림체 ID가 비어 있거나 중복되었습니다.')
                    sync_style_ids.add(sid)
                allow_realistic = style.get('allow_realistic')
                if is_synced_catalog and 'allow_realistic' in style and type(allow_realistic) is not bool:
                    raise ValueError('최신화한 공유 그림체의 실사 포함 설정이 올바르지 않습니다.')
                if excluded_style(style['positive']) and not (is_synced_catalog and allow_realistic is True):
                    continue
                preview, seed = style.get('preview'), style.get('seed')
                existing = records.get(sid)
                # Older replacement snapshots may already contain a V5 ID from
                # catalog.json. Retain that saved record when adding new cards.
                may_replace_v5 = (is_synced_catalog and (has_active_snapshot or append_catalog)
                                  and isinstance(existing, dict) and existing.get('category') == 'v5')
                if (not sid or (existing is not None and not may_replace_v5) or not isinstance(preview, dict)
                        or not isinstance(style.get('options'), dict)
                        or type(seed) is not int or not 0 <= seed <= 9007199254740991
                        or any(type(preview.get(key)) is not int or preview[key] <= 0
                               for key in ('width', 'height'))):
                    raise ValueError('가져온 공유 그림체 생성 설정이 올바르지 않습니다.')
                paths = {'image': (image_root, preview.get('image')),
                         'thumbnail': (imported_root, preview.get('thumbnail'))}
                for preview_root, relative in paths.values():
                    self._image_path(preview_root, relative)
                records[sid] = {key: deepcopy(style.get(key)) for key in (
                    'id', 'name', 'model', 'positive', 'negative', 'source_image_id', 'source_url',
                    'seed', 'options', 'recommendation_count', 'recommendation_collected_at')}
                records[sid].update(category='v5',
                                    preview={key: preview[key] for key in ('width', 'height')})
                if isinstance(style.get('source_posted_at'), str):
                    records[sid]['source_posted_at'] = style['source_posted_at']
                previews[sid] = paths
                records[sid]['sort_date'] = style_sort_date(style, self._image_path(*paths['image']))
            # Hide exact duplicate cards, while preserving old IDs for saved tests.
            hidden_ids.update(hidden)
            if is_synced_catalog and has_active_snapshot and not set(active_style_ids).issubset(sync_style_ids):
                raise ValueError('최신화한 공유 그림체 활성 ID를 찾을 수 없습니다.')
        if has_active_snapshot:
            # The active snapshot governs all V5 cards, including entries retained
            # by an older imported catalog. Keep their records for saved projects.
            active_ids = set(active_style_ids)
            hidden_ids.update(sid for sid, record in records.items()
                              if record.get('category') == 'v5' and sid not in active_ids)
        # Publish a complete snapshot only after every included record validates.
        self._root, self._records, self._previews = root, records, previews
        self._hidden_ids = hidden_ids
        self._signature = signature

    def list_styles(self, include_excluded=False):
        with self._lock:
            self._load()
            excluded = self._hidden_ids | self._excluded_ids(self._exclusions_path())
            records = [record for sid, record in self._records.items() if include_excluded or sid not in excluded]
            return deepcopy([{**record, **metadata} for record, metadata
                             in zip(records, self.source_metadata_many(records))])

    def source_metadata(self, style):
        return self.sources.metadata(style)

    def sort_dates_many(self, styles):
        """Enrich old saved tests without rewriting their recipe snapshots."""
        with self._lock:
            try:
                self._load()
                records = self._records
            except (OSError, ValueError):
                records = {}
            return [style_sort_date(style) or records.get(style.get('id'), {}).get('sort_date')
                    for style in styles]

    def source_metadata_many(self, styles):
        return self.sources.metadata_many(styles)

    def remove_styles(self, style_ids):
        """Exclude selected recipes from future tests without touching sources."""
        if (not isinstance(style_ids, list) or not 1 <= len(style_ids) <= _MAX_REMOVE_IDS
                or any(not isinstance(sid, str) or not sid or len(sid) > 128 for sid in style_ids)):
            raise ValueError('삭제할 그림체 ID를 1~10000개 선택해 주세요.')
        requested = set(style_ids)
        with self._lock:
            self._load()
            if not requested.issubset(self._records):
                raise DakiNotFoundError('삭제할 공유 그림체를 찾을 수 없습니다.')
            path = self._exclusions_path()
            if path is None:
                raise ValueError('공유 그림체 제외 목록의 저장 위치가 설정되지 않았습니다.')
            # Read/merge/write under the shared JSON lock so independent store
            # instances in this process cannot overwrite each other's choices.
            with json_lock(path):
                excluded = self._excluded_ids(path)
                added = requested - excluded
                if not added:
                    return 0
                path.parent.mkdir(parents=True, exist_ok=True)
                write_json(path, {'version': 1, 'style_ids': sorted(excluded | requested)}, indent=2)
                return len(added)

    def get_style(self, style_id):
        with self._lock:
            self._load()
            if not isinstance(style_id, str) or style_id not in self._records:
                raise DakiNotFoundError('공유 그림체를 찾을 수 없습니다.')
            record = self._records[style_id]
            return deepcopy({**record, **self.source_metadata(record)})

    def upper_test_source(self):
        """Return visible legacy upper styles with their exact source payloads."""
        with self._lock:
            self._load()
            visible_ids = {style['id'] for style in self.list_styles() if style.get('category') == 'upper'}
            if not visible_ids:
                raise ValueError('테스트할 상반신 그림체가 없습니다.')

            root = self._root
            catalog = self._read(root / 'default_styles.json')
            source_options = self._read(root / 'source_generation_options.json')
            manifest = self._read(root / 'generation_manifest.json')
            styles = catalog.get('styles')
            options_by_id = source_options.get('styles')
            jobs = manifest.get('jobs')
            if not isinstance(styles, list) or not isinstance(options_by_id, dict) or not isinstance(jobs, dict):
                raise ValueError('공유 그림체 자료 형식이 올바르지 않습니다.')

            entries = []
            request = None
            for raw_style in styles:
                style_id = raw_style.get('id') if isinstance(raw_style, dict) else None
                if style_id not in visible_ids:
                    continue
                if not isinstance(style_id, str) or style_id not in self._records:
                    raise ValueError('공유 그림체 항목 형식이 올바르지 않습니다.')
                style = self._records[style_id]
                preview = raw_style.get('preview')
                source = options_by_id.get(style_id)
                if (style.get('category') != 'upper' or not isinstance(preview, dict)
                        or not isinstance(source, dict) or not isinstance(source.get('options'), dict)):
                    raise ValueError('공유 그림체 생성 설정을 찾을 수 없습니다.')
                job = jobs.get(preview.get('job_id'))
                payload = job.get('payload') if isinstance(job, dict) else None
                generation = job.get('job') if isinstance(job, dict) else None
                data = generation.get('data') if isinstance(generation, dict) else None
                parameters = payload.get('parameters') if isinstance(payload, dict) else None
                if (not isinstance(job, dict) or job.get('status') != 'success'
                        or not isinstance(data, dict) or not isinstance(payload, dict)
                        or not isinstance(parameters, dict)
                        or any(type(parameters.get(key)) is not int or parameters[key] <= 0
                               for key in ('width', 'height', 'steps'))
                        or not isinstance(payload.get('model'), str)
                        or not isinstance(payload.get('input'), str)):
                    raise ValueError('공유 그림체 미리보기의 생성 요청을 확인할 수 없습니다.')
                if (parameters['width'] != preview.get('width')
                        or parameters['height'] != preview.get('height')):
                    raise ValueError('공유 그림체 미리보기 크기가 생성 요청과 일치하지 않습니다.')
                preview_paths = {}
                for key in ('image', 'thumbnail'):
                    image = self._image_path(root, preview.get(key))
                    if not image.is_file():
                        raise FileNotFoundError('공유 그림체 미리보기 이미지를 찾을 수 없습니다.')
                    preview_paths[key] = image

                base_prompt = data.get('base_prompt')
                negative_prompt = data.get('negative_prompt')
                if (not isinstance(base_prompt, str) or not base_prompt.startswith(raw_style.get('positive', ''))
                        or not isinstance(negative_prompt, str)
                        or not negative_prompt.startswith(raw_style.get('negative', ''))):
                    raise ValueError('공유 그림체 공통 프롬프트를 확인할 수 없습니다.')
                current_request = {
                    'model': payload['model'], 'width': parameters['width'], 'height': parameters['height'],
                    'prompt': base_prompt[len(raw_style['positive']):].lstrip(', '),
                    'negative_prompt': negative_prompt[len(raw_style['negative']):].lstrip(', '),
                    'char_prompts': self._upper_test_char_prompts(parameters),
                    'output_format': 'webp',
                }
                if request is None:
                    request = current_request
                output_format = 'webp' if preview_paths['image'].suffix.lower() == '.webp' else 'png'
                entries.append({'style': deepcopy(style), 'payload': deepcopy(payload),
                                'output_format': output_format})

            if len(entries) != len(visible_ids) or not entries:
                raise ValueError('공유 그림체 생성 설정을 찾을 수 없습니다.')
            return {'request': request, 'entries': entries}

    @staticmethod
    def _upper_test_char_prompts(parameters):
        positive = parameters.get('v4_prompt')
        negative = parameters.get('v4_negative_prompt')
        positive = positive.get('caption') if isinstance(positive, dict) else None
        negative = negative.get('caption') if isinstance(negative, dict) else None
        positive = positive.get('char_captions') if isinstance(positive, dict) else None
        negative = negative.get('char_captions') if isinstance(negative, dict) else None
        if (not isinstance(positive, list) or not isinstance(negative, list)
                or len(positive) != len(negative) or len(positive) > 6):
            raise ValueError('공유 그림체 캐릭터 프롬프트를 확인할 수 없습니다.')
        result = []
        for positive_item, negative_item in zip(positive, negative):
            if (not isinstance(positive_item, dict) or not isinstance(negative_item, dict)
                    or not isinstance(positive_item.get('char_caption'), str)
                    or not isinstance(negative_item.get('char_caption'), str)):
                raise ValueError('공유 그림체 캐릭터 프롬프트를 확인할 수 없습니다.')
            result.append({'prompt': positive_item['char_caption'],
                           'negative_prompt': negative_item['char_caption']})
        return result

    def preview_path(self, style_id, full=False):
        with self._lock:
            self._load()
            if not isinstance(style_id, str) or style_id not in self._records:
                raise DakiNotFoundError('공유 그림체를 찾을 수 없습니다.')
            preview_root, relative = self._previews[style_id]['image' if full else 'thumbnail']
            # Resolve again to detect a symlink changed after the catalog was cached.
            path = self._image_path(preview_root, relative)
            if not path.is_file():
                raise FileNotFoundError('공유 그림체 미리보기 이미지를 찾을 수 없습니다.')
            return path
