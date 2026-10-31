"""NAIM adapter for the single shared library and read-only source ingestion."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import threading
from urllib.parse import quote

from flask import jsonify, request, send_file
from naim.paths import get_app_dir
from naim.storage.daki_projects import DakiNotFoundError
from naim.shared_style_recipe import extract_recipe, load_style_artist_names, style_duplicate_key
import naim.shared_style_recipe as recipe_module
from .shared_library_store import SharedLibraryStore


# Bump when source normalization or duplicate-key parsing semantics change.
SOURCE_SCAN_VERSION = 1


def _stamp(path):
    try:
        stat = Path(path).stat()
        return stat.st_mtime_ns, stat.st_size
    except FileNotFoundError:
        return None


def _safe_raw(raw):
    allowed = {'prompt', 'base_prompt', 'negative_prompt', 'uc', 'model', 'seed', 'steps',
               'width', 'height', 'scale', 'cfg_rescale', 'sampler', 'noise_schedule',
               'qualityToggle', 'ucPreset', 'v4_prompt', 'v4_negative_prompt',
               'prefer_brownian', 'deliberate_euler_ancestral_bug', 'dynamic_thresholding',
               'legacy_v3_extend', 'strength', 'noise', 'skip_cfg_above_sigma',
               'quality_toggle', 'uc_preset', 'complexity'}
    return {key: deepcopy(value) for key, value in raw.items() if key in allowed}


class SharedLibraryCatalog:
    def __init__(self, legacy, database, artist_data, *, artist_names=None):
        self.legacy = legacy
        self.store = SharedLibraryStore(database)
        self.artist_data = Path(artist_data)
        self._provided_artist_names = artist_names is not None
        self.artist_names = load_style_artist_names() if artist_names is None else artist_names
        self._artist_names_signature = (hashlib.sha256(json.dumps(sorted(self.artist_names), ensure_ascii=False).encode()).hexdigest()
                                        if self._provided_artist_names else None)
        self._lock = threading.RLock()
        self._signature = None
        self.warnings = []

    def __getattr__(self, name):
        # Keep legacy private helpers used by the existing acquisition pipeline.
        return getattr(self.legacy, name)

    def _current_signature(self):
        files = [self.artist_data / 'artist_rater.sqlite', self.artist_data / 'artist_rater.sqlite-wal']
        for provider, names in ((self.legacy._catalog_root, ('default_styles.json', 'source_generation_options.json', 'generation_manifest.json')),
                                (self.legacy._imported_root, ('catalog.json', 'sync_catalog.json', 'excluded_styles.json', 'source_posts.json'))):
            root = provider()
            if root:
                files.extend(Path(root) / name for name in names)
        if not self._provided_artist_names:
            files.append(Path(recipe_module.__file__).resolve().parent.parent / 'data/shared_style_artists.json')
            dictionary = Path(get_app_dir()) / 'data/danbooru_tags.sqlite3'
            files.extend((dictionary, Path(str(dictionary) + '-wal')))
        payload = {'version': SOURCE_SCAN_VERSION, 'artist_names': self._artist_names_signature,
                   'sources': [(str(path.resolve()), _stamp(path)) for path in files]}
        return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()

    def _key(self, positive):
        return style_duplicate_key(positive, artist_names=self.artist_names)

    def _legacy_entries(self):
        visible = {record['id'] for record in self.legacy.list_styles()}
        entries = []
        for record in self.legacy.list_styles(include_excluded=True):
            if record.get('category') == 'upper':
                continue
            key = self._key(record['positive'])
            if key is None:
                continue
            paths = {}
            for full, label in ((True, 'image_path'), (False, 'thumbnail_path')):
                try:
                    paths[label] = str(self.legacy.preview_path(record['id'], full=full))
                except FileNotFoundError:
                    paths[label] = ''
            entries.append({'key': key, 'record': record, 'origin': 'naim', 'source_id': record['id'],
                            'aliases': [record['id']], 'excluded': record['id'] not in visible,
                            'source': {'origin': 'naim', 'legacy_id': record['id'], 'source_url': record.get('source_url'),
                                       '_legacy_record': record}, **paths})
        return sorted(entries, key=lambda entry: entry['excluded'])

    def _artist_entries(self):
        database = self.artist_data / 'artist_rater.sqlite'
        if not database.is_file():
            return []
        uri = database.resolve().as_uri() + '?mode=ro'
        connection = sqlite3.connect(uri, uri=True, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            rows = connection.execute('''SELECT image.*,item.title AS article_title,item.source_url AS article_url,
                item.posted_at AS article_posted_at,item.recommendation_count AS article_recommendation_count
                FROM arca_style_images image JOIN arca_style_items item ON item.id=image.item_id
                WHERE image.metadata_status='ok' ORDER BY image.id''').fetchall()
        finally:
            connection.close()
        root = (self.artist_data / 'arca_style_images').resolve()
        source_namespace = hashlib.sha256(str(database.resolve()).casefold().encode('utf-8')).hexdigest()[:16]
        entries = []
        rejected = 0
        for row in rows:
            image = dict(row)
            try:
                positive = image.get('base_prompt') or image.get('prompt') or ''
                negative = image.get('negative_prompt') or ''
                recipe = extract_recipe(positive, negative, artist_names=self.artist_names)
                key = self._key(recipe['positive'])
                if key is None:
                    continue
                model = image.get('model_id') or image.get('model') or 'unknown'
                try:
                    raw = json.loads(image.get('raw_metadata_json') or '{}')
                except (ValueError, TypeError):
                    raw = {}
                    self.warnings.append('일부 원본의 생성 메타데이터 형식을 읽지 못했습니다. 그림체와 원본은 보존했습니다.')
                if not isinstance(raw, dict):
                    raw = {}
                options = {target: image[source] for target, source in (
                    ('steps', 'steps'), ('cfg', 'scale'), ('cfg_rescale', 'cfg_rescale'),
                    ('sampler', 'sampler'), ('noise_schedule', 'noise_schedule')) if image.get(source) is not None}
                for field in ('prefer_brownian', 'deliberate_euler_ancestral_bug', 'dynamic_thresholding', 'legacy_v3_extend', 'strength', 'noise'):
                    if field in raw:
                        options[field] = raw[field]
                def integer(value, minimum, maximum):
                    try:
                        parsed = int(value)
                        return parsed if minimum <= parsed <= maximum else None
                    except (ValueError, TypeError, OverflowError):
                        return None
                seed = integer(image.get('seed'), 0, 9007199254740991)
                width, height = integer(image.get('width'), 1, 100000), integer(image.get('height'), 1, 100000)
                relative = image.get('image_path') or ''
                path = (root / relative).resolve() if relative else None
                if path is not None and (path == root or not path.is_relative_to(root)):
                    raise ValueError('unsafe image path')
                record = {'name': image.get('article_title') or '공유 그림체', 'model': model,
                          'positive': recipe['positive'], 'negative': recipe['negative'],
                          'options': options, 'seed': seed, 'preview': {'width': width, 'height': height},
                          'category': 'v5', 'source_image_id': image['id'], 'source_url': image.get('article_url'),
                          'recommendation_count': image.get('article_recommendation_count'),
                          'recommendation_collected_at': None, 'sort_date': image.get('article_posted_at')}
                raw = {**raw, 'base_prompt': positive, 'negative_prompt': negative}
                source = {'origin': 'artist', 'image_id': image['id'], 'item_id': image['item_id'],
                          'image_url': image.get('image_url'), 'source_url': image.get('article_url'),
                          '_source_database': str(database.resolve()), '_image_root': str(root)}
                identity = source_namespace + '-' + str(image['id'])
                entries.append({'key': key, 'record': record, 'origin': 'artist', 'source_id': identity,
                                'aliases': ['artist-image-' + identity], 'source': source,
                                'raw_metadata': raw, 'image_path': str(path or ''), 'thumbnail_path': str(path or '')})
            except (ValueError, TypeError, KeyError):
                rejected += 1
        if rejected:
            self.warnings.append(f'그림체로 해석할 수 없는 원본 이미지 {rejected}개는 원본 자료에 보존했습니다.')
        return entries

    def refresh(self):
        with self._lock:
            signature = self._current_signature()
            if signature == self._signature:
                return
            saved = self.store.scan_state()
            if saved and saved['signature'] == signature:
                self.warnings = list(saved['warnings'])
                self._signature = signature
                return
            self.warnings = []
            if not self._provided_artist_names:
                recipe_module._artist_names.cache_clear()
                self.artist_names = load_style_artist_names()
            entries = []
            complete = True
            for loader in (self._legacy_entries, self._artist_entries):
                try:
                    entries.extend(loader())
                except (OSError, ValueError, sqlite3.Error):
                    complete = False
                    self.warnings.append('공유 원본 자료 일부를 읽지 못했습니다. 저장된 공용 그림체는 유지됩니다.')
            self.store.ingest(entries)
            if complete and signature == self._current_signature():
                self.store.save_scan_state(signature, self.warnings)
                self._signature = signature

    def list_styles(self, include_excluded=False):
        self.refresh()
        return self.store.list_records(include_excluded)

    def get_style(self, style_id):
        self.refresh()
        try:
            return self.store.get_record(style_id)
        except KeyError:
            return self.legacy.get_style(style_id)

    def preview_path(self, style_id, full=False):
        self.refresh()
        try:
            sources = self.store.sources(style_id)
        except KeyError:
            return self.legacy.preview_path(style_id, full=full)
        # A legacy alias keeps the same image used by its saved test.
        sources.sort(key=lambda source: source['source_id'] != style_id)
        return self._preview_for_sources(sources, full=full)

    def _preview_for_sources(self, sources, full=False):
        for source in sources:
            if source['origin'] == 'naim':
                try:
                    original = json.loads(source['source_json']).get('_legacy_record') or {}
                    return self.legacy.preview_path(original.get('id') or source['source_id'], full=full)
                except (FileNotFoundError, DakiNotFoundError):
                    continue
            value = source['image_path' if full else 'thumbnail_path'] or source['image_path']
            details = json.loads(source['source_json'])
            root = Path(details.get('_image_root') or self.artist_data / 'arca_style_images').resolve()
            if value and Path(value).resolve().is_relative_to(root) and Path(value).is_file():
                return Path(value).resolve()
        raise FileNotFoundError('공유 그림체 원본 이미지를 찾을 수 없습니다.')

    def remove_styles(self, style_ids):
        self.refresh()
        try:
            return self.store.exclude(style_ids)
        except KeyError:
            raise DakiNotFoundError('공유 그림체를 찾을 수 없습니다.') from None

    def sort_dates_many(self, styles):
        result = []
        for style in styles:
            try:
                result.append(style.get('sort_date') or self.get_style(style.get('id'))['sort_date'])
            except (KeyError, DakiNotFoundError):
                result.append(style.get('sort_date'))
        return result

    def public_records(self, include_excluded=False):
        records = self.list_styles(include_excluded)
        grouped_sources = self.store.all_sources()
        for record in records:
            sources = grouped_sources.get(record['id'], [])
            record['sources'] = []
            for row in sources:
                source = json.loads(row['source_json'])
                record['sources'].append({key: value for key, value in source.items() if not key.startswith('_')})
            raw = next((json.loads(row['raw_json']) for row in sources if row['raw_json'] != '{}'), {})
            record['raw_metadata'] = _safe_raw(raw)
            record['src'] = '/api/shared-style-library/' + quote(record['id'], safe='') + '/preview'
            try:
                self._preview_for_sources(sources, full=True)
                record['available'] = True
            except (FileNotFoundError, DakiNotFoundError):
                record['available'] = False
        return records


def build_shared_catalog(app, legacy_catalog, *, root=None, artist_names=None):
    if 'shared_style_library' in app.extensions:
        return app.extensions['shared_style_library']
    root = Path(root or (get_app_dir() if getattr(sys, 'frozen', False) else app.root_path))
    config_path = root / 'style_workspace.local.json'
    if not config_path.is_file():
        return legacy_catalog
    try:
        config = json.loads(config_path.read_text(encoding='utf-8'))
        source = Path(config['source_dir'])
        data = Path(config.get('data_dir') or source / 'data')
        catalog = SharedLibraryCatalog(legacy_catalog, root / 'data/shared_style_library.sqlite', data, artist_names=artist_names)
    except (OSError, ValueError, TypeError, KeyError):
        app.logger.warning('공용 그림체 연결 설정을 읽지 못해 기존 NAIM 목록을 유지합니다.')
        app.extensions['shared_style_library_error'] = '공용 그림체 연결 설정을 확인해 주세요.'
        return legacy_catalog
    app.extensions['shared_style_library'] = catalog

    @app.get('/api/shared-style-library')
    def shared_style_library_list():
        styles = catalog.public_records(include_excluded=request.args.get('include_excluded') == '1')
        return jsonify(styles=styles, count=len(styles), warnings=catalog.warnings)

    @app.get('/api/shared-style-library/<style_id>')
    def shared_style_library_detail(style_id):
        try:
            requested = catalog.get_style(style_id)
            canonical = next((style for style in catalog.public_records(include_excluded=True)
                              if style['id'] == style_id), None)
            if canonical is None:
                canonical = requested
                canonical['src'] = '/api/shared-style-library/' + quote(style_id, safe='') + '/preview'
            return jsonify(style=canonical)
        except (KeyError, DakiNotFoundError):
            return jsonify(error='공유 그림체를 찾을 수 없습니다.'), 404

    @app.get('/api/shared-style-library/<style_id>/preview')
    def shared_style_library_preview(style_id):
        try:
            return send_file(catalog.preview_path(style_id, full=request.args.get('full') == '1'))
        except (FileNotFoundError, DakiNotFoundError):
            return jsonify(error='공유 그림체 이미지를 찾을 수 없습니다.'), 404

    @app.post('/api/shared-style-library/exclude')
    def shared_style_library_exclude():
        if request.headers.get('Origin') not in (None, request.host_url.rstrip('/')) or request.headers.get('X-NAIM-Workspace') != '1':
            return jsonify(error='이 NAIM 화면에서 요청해 주세요.'), 403
        body = request.get_json(silent=True)
        try:
            if not isinstance(body, dict):
                raise ValueError('JSON 객체를 보내 주세요.')
            return jsonify(ok=True, removed=catalog.remove_styles(body.get('style_ids')))
        except (ValueError, DakiNotFoundError) as error:
            return jsonify(error=str(error)), 400

    return catalog
