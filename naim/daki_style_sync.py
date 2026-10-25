"""Background source import with additive, atomic Hugging Face publication."""
from copy import deepcopy
from datetime import date, datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import threading
from urllib.parse import urlsplit

from PIL import Image

from naim.arca_shared_styles import ArcaSharedClient, ArcaSharedError, extract_metadata
from naim.daki_style_archive import iter_archive_images
from naim.daki_style_filters import normalize_style_filters, matches_style_filters
from naim.shared_style_recipe import (extract_recipe, load_style_artist_names, original_options,
                                      recipe_fingerprint, style_duplicate_key)
from naim.daki_style_tests import build_style_test_payload
from naim.storage.daki_shared_styles import excluded_style
from naim.storage.json_files import json_lock, write_json
from naim.storage.daki_style_dates import latest_posted_date, post_date
from naim.storage.daki_style_sources import source_url


def _now():
    return datetime.now(timezone.utc).isoformat()


def _identity(url):
    parsed = urlsplit(url)
    # Signed CDN URLs expire independently of the image identity.
    return hashlib.sha256((parsed.path).encode('utf-8')).hexdigest()


def _write_image(path, data):
    if path.is_file() and path.stat().st_size == len(data) and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as target:
            temporary = Path(target.name)
            target.write(data)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


class _FilteredStyle(ValueError):
    pass


class DakiStyleSync:
    def __init__(self, root_provider, catalog, client=None, archive_provider=None):
        self.root_provider = root_provider
        self.catalog = catalog
        self.client = client or ArcaSharedClient()
        self.archive_provider = archive_provider or self._archive_images
        self._lock = threading.RLock()
        self._thread = None
        self._stop = threading.Event()
        self._job = None

    def _archive_images(self, root, stop, progress):
        return iter_archive_images(root, stop, progress, include_recommendations=(
            self._job['filters'].get('low_recommendation_limit') is not None))

    def _post_is_limited(self, image, imported_posts, filters):
        limit = filters.get('low_recommendation_limit')
        if limit is None or source_url(image.get('source_url')) not in imported_posts:
            return False
        count = self.catalog.source_metadata(image)['recommendation_count']
        # Unknown recommendations are deliberately not treated as zero.
        return type(count) is int and 0 <= count <= limit

    def _root(self):
        value = self.root_provider() if callable(self.root_provider) else self.root_provider
        if not value:
            raise ValueError('공유 그림체 저장 위치가 설정되지 않았습니다.')
        return Path(value).resolve()

    @staticmethod
    def _read(path, default):
        if not path.exists():
            return deepcopy(default)
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (ValueError, UnicodeError) as error:
            raise ValueError('공유 그림체 최신화 자료를 읽을 수 없습니다.') from error
        if not isinstance(data, dict):
            raise ValueError('공유 그림체 최신화 자료의 형식이 올바르지 않습니다.')
        return data

    def status(self):
        with self._lock:
            if self._job is None:
                self._job = self._read(self._root() / 'sync_job.json', {}) or None
                if self._job and self._job.get('status') == 'running':
                    self._job.update(status='failed', message='앱이 종료되어 가져오기가 중단되었습니다. 다시 실행해 주세요.')
                    if self._job.get('source') == 'huggingface':
                        # A crash can occur between catalog publication and job persistence.
                        self._job['published'] = None
            today = datetime.now().astimezone().date()
            latest = latest_posted_date(self.catalog.list_styles(), today=today)
            return {'connected': self.client.connected, 'job': deepcopy(self._job),
                    'defaults': {'start_date': latest or today.isoformat(), 'end_date': today.isoformat(),
                                 'basis': 'latest_style' if latest else 'today'}}

    def connect(self, data):
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise ValueError('수집 중에는 로그인 연결을 변경할 수 없습니다.')
            self.client.connect(data)

    def start(self, data):
        if not isinstance(data, dict):
            raise ValueError('수집 기간을 선택해 주세요.')
        source = data.get('source', 'arca')
        if source not in ('arca', 'huggingface'):
            raise ValueError('지원하지 않는 공유 그림체 가져오기 경로입니다.')
        filters = normalize_style_filters(data.get('filters'))
        start = end = None
        if source == 'arca':
            try:
                start, end = (date.fromisoformat(data[key]) for key in ('start_date', 'end_date'))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError('시작일과 종료일을 선택해 주세요.') from error
            if start > end or end > datetime.now().astimezone().date():
                raise ValueError('수집 기간은 시작일부터 오늘까지의 날짜로 선택해 주세요.')
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise ValueError('공유 그림체를 최신화하고 있습니다.')
            if source == 'arca' and not self.client.connected:
                raise ValueError('확장 프로그램에서 아카라이브 로그인을 먼저 연결해 주세요.')
            root = self._root()
            root.mkdir(parents=True, exist_ok=True)
            self._job = {'status': 'running', 'source': source,
                         'start_date': start.isoformat() if start else None,
                         'end_date': end.isoformat() if end else None,
                         'scanned_posts': 0, 'downloaded_images': 0, 'added': 0, 'skipped': 0,
                         'failed_images': 0, 'last_image_error': '', 'filters': filters, 'filtered': 0,
                         'post_limited': 0,
                         'downloaded_bytes': 0, 'total_bytes': 0,
                         'message': '공유 그림체 수집을 시작합니다.', 'started_at': _now()}
            if source == 'huggingface':
                self._job.update(filters=filters, prepared=0, updated=0, filtered=0, published=False,
                                 phase='resolve', phase_current=0, phase_total=0,
                                 processed_images=0, total_images=0)
            write_json(root / 'sync_job.json', self._job, indent=2)
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, args=(root, start, end, source), daemon=True)
            self._thread.start()
            return self.status()

    def stop(self):
        with self._lock:
            self._stop.set()
            if self._job and self._job['status'] == 'running':
                self._job['message'] = '현재 요청이 끝나면 수집을 중지합니다.'
            return self.status()

    def wait(self, timeout=10):
        thread = self._thread
        if thread:
            thread.join(timeout)
        return not thread or not thread.is_alive()

    def _progress(self, **values):
        with self._lock:
            for key in ('scanned_posts', 'downloaded_images', 'message', 'downloaded_bytes', 'total_bytes', 'failed_images', 'last_image_error',
                        'archive_revision', 'archive_filename', 'archive_sha256',
                        'phase', 'phase_current', 'phase_total', 'total_images'):
                if key in values:
                    self._job[key] = values[key]
            tab = {'NAI': 'NAI', 'R18_NAI': '🔞 NAI'}.get(values.get('tab'))
            if tab and not self._stop.is_set():
                messages = {
                    'search': f'{tab}에서 ‘그림체’ 제목 검색 중 · {values.get("page", 1)}페이지',
                    'article': f'{tab}에서 ‘그림체’와 ‘공유’가 있는 게시글 확인 중',
                    'download': f'{tab} 게시글의 이미지 받는 중',
                    'image': f'{tab} 이미지의 V5 메타데이터와 그림체 확인 중',
                    'image_error': f'{tab} 이미지 일부를 받지 못해 다음 이미지로 진행합니다.',
                }
                if values.get('stage') in messages:
                    self._job['message'] = messages[values['stage']]

    def _run(self, root, start, end, source):
        try:
            known_images = set()
            def skip_image(url):
                if _identity(url) not in known_images:
                    return False
                with self._lock:
                    self._job['skipped'] += 1
                return True
            images = (self.archive_provider(root / 'sync' / 'downloads', self._stop, self._progress)
                      if source == 'huggingface' else self.client.iter_images(
                          start, end, self._stop, self._progress, skip_image=skip_image))
            try:
                if source == 'huggingface':
                    self._collect_huggingface(root, images)
                else:
                    self._collect(root, images, known_images)
            finally:
                # Closing a partial generator also releases pending downloads.
                close = getattr(images, 'close', None)
                if close is not None:
                    close()
            with self._lock:
                stopped = self._stop.is_set() and not self._job.get('published')
                self._job.update(status='stopped' if stopped else 'completed',
                                 message='수집을 중지했습니다.' if stopped else '공유 그림체 최신화를 완료했습니다.')
                if source == 'huggingface':
                    self._job['message'] = ('갱신을 중지했습니다. 기존 그림체 일람을 유지합니다.' if stopped
                                            else '기존 그림체를 유지하고 새 그림체를 추가했습니다.')
                    if not stopped and self._job.get('published'):
                        self._job['phase'] = 'complete'
                if self._job['failed_images']:
                    self._job['message'] += f" 이미지 {self._job['failed_images']}개를 받지 못했습니다. 같은 기간으로 다시 실행하면 실패한 이미지를 재시도합니다."
        except (ArcaSharedError, ValueError) as error:
            with self._lock:
                self._job.update(status='failed', message=str(error))
        except Exception:
            # Network/library exceptions can contain signed URLs or local paths.
            with self._lock:
                self._job.update(status='failed', message='공유 그림체를 수집하거나 저장하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.')
        finally:
            with self._lock:
                self._job['finished_at'] = _now()
                try:
                    write_json(root / 'sync_job.json', self._job, indent=2)
                except OSError:
                    self._job.update(status='failed', message='최신화 작업 상태를 저장하지 못했습니다.')

    def _prepare_style(self, image, fingerprints, pixel_hashes, filters=None, *,
                       style_keys=None, artist_names=None):
        metadata = extract_metadata(image['image_bytes'])
        if metadata is None:
            raise ValueError('지원되는 V5 메타데이터가 없습니다.')
        if type(metadata['seed']) is not int or not 0 <= metadata['seed'] <= 9007199254740991:
            raise ValueError('원본 시드를 확인할 수 없습니다.')
        if filters is not None:
            if not matches_style_filters(metadata['base_prompt'], filters):
                raise _FilteredStyle('가져오기 필터에서 제외되었습니다.')
        elif excluded_style(metadata['base_prompt']):
            raise ValueError('실사 그림체는 제외합니다.')
        recipe = extract_recipe(metadata['base_prompt'], metadata['negative_prompt'],
                                artist_names=artist_names)
        if recipe['fingerprint'] in fingerprints:
            raise ValueError('이미 있는 그림체입니다.')
        duplicate_key = style_duplicate_key(recipe['positive'], artist_names=artist_names)
        if style_keys is not None:
            if duplicate_key is None:
                raise ValueError('식별할 수 있는 작가 또는 그림체 태그가 없습니다.')
            if duplicate_key in style_keys:
                raise ValueError('이미 있는 그림체입니다.')
        sid = 'import-v5-' + recipe['fingerprint'][:24]
        image_name = sid + '-' + hashlib.sha256(image['image_bytes']).hexdigest()[:16]
        with Image.open(io.BytesIO(image['image_bytes'])) as original:
            original.load()
            pixels = original.convert('RGBA')
            digest = hashlib.sha256(str(pixels.size).encode('ascii'))
            digest.update(pixels.tobytes())
            pixel_hash = digest.hexdigest()
            if pixel_hash in pixel_hashes:
                raise ValueError('이미 있는 그림입니다.')
            suffix = '.webp' if original.format == 'WEBP' else '.png'
            width, height = original.size
            record = {'id': sid, 'name': image['title'][:120], 'category': 'v5',
                      'positive': recipe['positive'], 'negative': recipe['negative'],
                      'model': metadata['model'], 'seed': metadata['seed'],
                      'options': original_options(metadata['raw'], metadata['model']),
                      'source_image_id': _identity(image['image_url']), 'source_url': image['source_url'],
                      'recommendation_count': image.get('recommendation_count'),
                      'recommendation_collected_at': _now(), 'fingerprint': recipe['fingerprint'],
                      'pixel_sha256': pixel_hash,
                      'preview': {'image': f'sync/images/{image_name}{suffix}',
                                  'thumbnail': f'sync/thumbs/{image_name}.webp', 'width': width, 'height': height}}
            if filters is not None:
                record['allow_realistic'] = not filters['exclude_realistic']
            if posted := post_date(image):
                record['source_posted_at'] = posted
            build_style_test_payload(record, {'model': record['model'], 'prompt': '',
                                               'negative_prompt': '', 'char_prompts': []})
            original.thumbnail((384, 384))
            preview = io.BytesIO()
            original.convert('RGB').save(preview, 'WEBP', quality=87)
        return record, preview.getvalue()

    def _collect_huggingface(self, root, images):
        path = root / 'sync_catalog.json'
        previous = self._read(path, {'version': 1, 'source_image_root': '.', 'styles': [], 'seen_images': []})
        if (previous.get('version') != 1 or not isinstance(previous.get('styles'), list)
                or not isinstance(previous.get('seen_images', []), list)
                or previous.get('source_image_root') != '.'):
            raise ValueError('공유 그림체 최신화 자료의 형식이 올바르지 않습니다.')
        existing = {style['id']: style for style in self.catalog.list_styles(include_excluded=True)}
        records = {style['id']: deepcopy(style) for style in previous['styles']}
        previous_import = self._read(root / 'catalog.json', {})
        fingerprints = set()
        artist_names = load_style_artist_names()
        style_keys = set()
        # Upper-body samples are a separate collection. Include hidden V5 cards
        # and retained raw records so an import cannot overwrite or revive them.
        imported_posts = set()
        for style in [*existing.values(), *records.values(), *previous_import.get('styles', [])]:
            if style.get('category') == 'upper':
                continue
            if post := source_url(style.get('source_url')):
                imported_posts.add(post)
            try:
                fingerprints.add(recipe_fingerprint(style['positive'], style['negative']))
                duplicate_key = style_duplicate_key(style['positive'], artist_names=artist_names)
                if duplicate_key is not None:
                    style_keys.add(duplicate_key)
            except (KeyError, ValueError):
                continue
        pixel_hashes = set(previous_import.get('pixel_hashes', {}).values())
        pixel_hashes.update(style['pixel_sha256'] for style in records.values() if style.get('pixel_sha256'))
        seen = set(previous.get('seen_images', []))
        added_ids = []
        with self._lock:
            filters = deepcopy(self._job['filters'])
        for image in images:
            if self._stop.is_set():
                return
            self._progress(phase='inspect')
            if self._post_is_limited(image, imported_posts, filters):
                with self._lock:
                    self._job['post_limited'] += 1
                    self._job['processed_images'] += 1
                continue
            try:
                record, preview = self._prepare_style(
                    image, fingerprints, pixel_hashes, filters,
                    style_keys=style_keys, artist_names=artist_names)
            except _FilteredStyle:
                with self._lock:
                    self._job['filtered'] += 1
                    self._job['processed_images'] += 1
                continue
            except (ValueError, OSError, KeyError, TypeError):
                with self._lock:
                    self._job['skipped'] += 1
                    self._job['processed_images'] += 1
                continue
            sid = record['id']
            if sid in existing and existing[sid].get('category') == 'upper':
                raise ValueError('상반신 자료와 그림체 ID가 겹쳐 갱신하지 않았습니다.')
            if sid in records or sid in existing:
                with self._lock:
                    self._job['skipped'] += 1
                    self._job['processed_images'] += 1
                continue
            _write_image(self.catalog._image_path(root, record['preview']['image']), image['image_bytes'])
            _write_image(self.catalog._image_path(root, record['preview']['thumbnail']), preview)
            records[sid] = record
            added_ids.append(sid)
            fingerprints.add(record['fingerprint'])
            duplicate_key = style_duplicate_key(record['positive'], artist_names=artist_names)
            if duplicate_key is not None:
                style_keys.add(duplicate_key)
            pixel_hashes.add(record['pixel_sha256'])
            seen.add(record['source_image_id'])
            if post := source_url(record.get('source_url')):
                imported_posts.add(post)
            with self._lock:
                self._job['prepared'] = len(added_ids)
                self._job['processed_images'] += 1
        # No catalog is published until the generator has verified every image.
        if self._stop.is_set():
            return
        self._progress(phase='publish', phase_current=0, phase_total=0, message='새 그림체를 목록에 반영하는 중')
        with self._lock, json_lock(path):
            if self._stop.is_set():
                return
            manifest = deepcopy(previous)
            manifest.update(styles=list(records.values()), seen_images=sorted(seen))
            manifest.pop('active_style_ids', None)
            manifest['huggingface'] = {**manifest.get('huggingface', {}),
                                      'update_mode': 'append', 'filters': filters, 'updated_at': _now(),
                                      **{key: self._job[key] for key in
                                         ('archive_revision', 'archive_filename', 'archive_sha256') if key in self._job}}
            if path.exists():
                write_json(root / 'sync_catalog.before-huggingface.json', previous, indent=2)
            write_json(path, manifest, indent=2)
            self._job.update(published=True, added=len(added_ids), updated=0)

    def _collect(self, root, images, known_images=None):
        path = root / 'sync_catalog.json'
        manifest = self._read(path, {'version': 1, 'source_image_root': '.', 'styles': [], 'seen_images': []})
        if (manifest.get('version') != 1 or not isinstance(manifest.get('styles'), list)
                or not isinstance(manifest.get('seen_images', []), list)
                or manifest.get('source_image_root') != '.'):
            raise ValueError('공유 그림체 최신화 자료의 형식이 올바르지 않습니다.')
        seen = known_images if known_images is not None else set()
        seen.update(manifest.get('seen_images', []))
        fingerprints = set()
        previous_import = self._read(root / 'catalog.json', {})
        artist_names = load_style_artist_names()
        style_keys = set()
        pixel_hashes = set(previous_import.get('pixel_hashes', {}).values())
        pixel_hashes.update(style.get('pixel_sha256') for style in manifest['styles'] if style.get('pixel_sha256'))
        existing = self.catalog.list_styles(include_excluded=True)
        imported_posts = {post for style in [*existing, *manifest['styles'], *previous_import.get('styles', [])]
                          if style.get('category') != 'upper' and (post := source_url(style.get('source_url')))}
        # Include manually excluded cards: importing a duplicate must not revive them.
        for style in existing:
            try:
                fingerprints.add(recipe_fingerprint(style['positive'], style['negative']))
            except ValueError:
                continue
        # Derive comparison groups from retained recipes, without changing IDs
        # or stored prompts. Hidden V5 entries also prevent another import.
        for style in [*existing, *manifest['styles'], *previous_import.get('styles', [])]:
            if style.get('category') == 'upper':
                continue
            try:
                duplicate_key = style_duplicate_key(style['positive'], artist_names=artist_names)
                if duplicate_key is not None:
                    style_keys.add(duplicate_key)
            except (KeyError, ValueError):
                continue
        for image in images:
            if self._stop.is_set():
                break
            if self._post_is_limited(image, imported_posts, self._job['filters']):
                with self._lock:
                    self._job['post_limited'] += 1
                continue
            identity = _identity(image['image_url'])
            if identity in seen:
                with self._lock:
                    self._job['skipped'] += 1
                continue
            try:
                record, preview = self._prepare_style(
                    image, fingerprints, pixel_hashes, self._job['filters'],
                    style_keys=style_keys, artist_names=artist_names)
            except _FilteredStyle:
                with self._lock:
                    self._job['filtered'] += 1
                continue
            except (ValueError, OSError, KeyError, TypeError):
                with self._lock:
                    self._job['skipped'] += 1
                # Unsupported recipes are retried on a later explicit run.
                continue
            # File failures stop this run; a partially written image is never published.
            original_path = self.catalog._image_path(root, record['preview']['image'])
            thumbnail = self.catalog._image_path(root, record['preview']['thumbnail'])
            _write_image(original_path, image['image_bytes'])
            _write_image(thumbnail, preview)
            manifest['styles'].append(record)
            if 'active_style_ids' in manifest:
                manifest['active_style_ids'].append(record['id'])
            seen.add(identity)
            manifest['seen_images'] = sorted(seen)
            write_json(path, manifest, indent=2)
            fingerprints.add(record['fingerprint'])
            duplicate_key = style_duplicate_key(record['positive'], artist_names=artist_names)
            if duplicate_key is not None:
                style_keys.add(duplicate_key)
            pixel_hashes.add(record['pixel_sha256'])
            if post := source_url(record.get('source_url')):
                imported_posts.add(post)
            with self._lock:
                self._job['added'] += 1
                write_json(root / 'sync_job.json', self._job, indent=2)
