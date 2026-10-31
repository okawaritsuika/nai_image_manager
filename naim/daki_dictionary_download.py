"""Download and safely install the public tag-dictionary image pack."""

from copy import deepcopy
import filecmp
import hashlib
import json
from pathlib import Path
import re
import stat
import tempfile
import threading
import uuid
import zipfile

from PIL import Image
import requests

from naim.daki_dictionary_images import extract_prompt
from naim.daki_dictionary_pack_format import (
    ARCHIVE, INDEX, MANIFEST, MAX_EXPANDED_BYTES, MAX_IMAGE_BYTES, MAX_INDEX_BYTES,
    validate_index, validate_manifest,
)
from naim.daki_style_archive import (
    DakiStyleArchiveError, HF_ARCHIVE_INFO_URL, HF_REVISION_API_URL,
    _download, _metadata_json, _read_metadata, _verify_digest,
)
from naim.hf_http import public_session


_MANIFEST_FIELDS = ('format', 'version', 'filename', 'bytes', 'sha256', 'image_count',
                    'image_bytes', 'index_sha256', 'quality')
_REVISION = re.compile(r'[0-9a-f]{40}')
_NOT_PUBLISHED = '태그 사전 이미지팩이 아직 게시되지 않았습니다.'
_GENERIC_FAILURE = '태그 사전 이미지팩을 설치하지 못했습니다. 다시 시도해 주세요.'


class _DownloadStopped(Exception):
    pass


def _stopped(stop_event):
    return stop_event is not None and stop_event.is_set()


def _check_stop(stop_event):
    if _stopped(stop_event):
        raise _DownloadStopped()


def latest_dictionary_pack(stop_event=None):
    """Resolve public pack metadata and pin its archive URL to one HF revision."""
    if _stopped(stop_event):
        return None
    try:
        with public_session() as session:
            revision_data = _read_metadata(
                session, HF_REVISION_API_URL, stop_event,
                '최신 태그 사전 이미지팩 정보를 확인하지 못했습니다.',
            )
            if _stopped(stop_event):
                return None
            revision_doc = _metadata_json(revision_data, '최신 태그 사전 이미지팩 정보')
            revision = revision_doc.get('sha')
            siblings = revision_doc.get('siblings')
            if not isinstance(revision, str) or not _REVISION.fullmatch(revision) or not isinstance(siblings, list):
                raise DakiStyleArchiveError('최신 태그 사전 이미지팩 정보가 올바르지 않습니다.')

            manifest_siblings = [item for item in siblings
                                 if isinstance(item, dict) and item.get('rfilename') == MANIFEST]
            if not manifest_siblings:
                raise DakiStyleArchiveError(_NOT_PUBLISHED)
            if len(manifest_siblings) != 1:
                raise DakiStyleArchiveError('태그 사전 이미지팩 설명 파일이 중복 게시되었습니다.')

            manifest_url = HF_ARCHIVE_INFO_URL + revision + '/' + MANIFEST
            try:
                manifest_data = _read_metadata(
                    session, manifest_url, stop_event,
                    '태그 사전 이미지팩 설명을 불러오지 못했습니다.',
                )
            except DakiStyleArchiveError as error:
                if '(HTTP 404)' in str(error):
                    raise DakiStyleArchiveError(_NOT_PUBLISHED) from None
                raise
            if _stopped(stop_event):
                return None
            manifest = validate_manifest(
                _metadata_json(manifest_data, '태그 사전 이미지팩 설명')
            )

            archive_siblings = [item for item in siblings
                                if isinstance(item, dict) and item.get('rfilename') == manifest['filename']]
            if len(archive_siblings) != 1:
                raise DakiStyleArchiveError('태그 사전 이미지팩 파일을 리비전에서 찾지 못했습니다.')
            sibling = archive_siblings[0]
            lfs = sibling.get('lfs')
            if (type(sibling.get('size')) is not int or sibling['size'] != manifest['bytes']
                    or not isinstance(lfs, dict)
                    or type(lfs.get('size')) is not int or lfs['size'] != manifest['bytes']
                    or lfs.get('sha256') != manifest['sha256']):
                raise DakiStyleArchiveError('태그 사전 이미지팩 크기 또는 해시가 리비전과 일치하지 않습니다.')
            if _stopped(stop_event):
                return None
            return {
                **manifest,
                'revision': revision,
                'url': HF_ARCHIVE_INFO_URL + revision + '/' + ARCHIVE + '?download=true',
            }
    except requests.RequestException:
        raise DakiStyleArchiveError(
            'Hugging Face 태그 사전 이미지팩 정보에 연결하지 못했습니다.'
        ) from None


def _validate_pack_spec(value):
    if not isinstance(value, dict) or set(value) != set(_MANIFEST_FIELDS) | {'revision', 'url'}:
        raise ValueError('태그 사전 이미지팩 정보가 올바르지 않습니다.')
    manifest = validate_manifest({key: value[key] for key in _MANIFEST_FIELDS})
    revision = value['revision']
    if not isinstance(revision, str) or not _REVISION.fullmatch(revision):
        raise ValueError('태그 사전 이미지팩 리비전 정보가 올바르지 않습니다.')
    url = HF_ARCHIVE_INFO_URL + revision + '/' + ARCHIVE + '?download=true'
    if value['url'] != url:
        raise ValueError('태그 사전 이미지팩 다운로드 주소가 올바르지 않습니다.')
    return {**manifest, 'revision': revision, 'url': url}


def _read_zip_entry(archive, info, limit, stop_event):
    if info.file_size <= 0 or info.file_size > limit:
        raise ValueError('태그 사전 압축파일 항목 크기가 허용 범위를 벗어났습니다.')
    chunks = []
    total = 0
    with archive.open(info, 'r') as source:
        while True:
            _check_stop(stop_event)
            chunk = source.read(min(1024 * 1024, limit + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > limit:
                raise ValueError('태그 사전 압축파일 항목 크기가 허용 범위를 벗어났습니다.')
            chunks.append(chunk)
    if total != info.file_size:
        raise ValueError('태그 사전 압축파일 항목 크기가 저장 정보와 다릅니다.')
    return b''.join(chunks)


def _write_image_entry(archive, info, target, entry, stop_event):
    digest = hashlib.sha256()
    total = 0
    prefix = bytearray()
    with archive.open(info, 'r') as source, target.open('xb') as output:
        while True:
            _check_stop(stop_event)
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > entry['bytes'] or total > MAX_IMAGE_BYTES:
                raise ValueError('태그 사전 이미지 크기가 색인 정보와 다릅니다.')
            if len(prefix) < 12:
                prefix.extend(chunk[:12 - len(prefix)])
            digest.update(chunk)
            output.write(chunk)
    if total != entry['bytes'] or info.file_size != entry['bytes']:
        raise ValueError('태그 사전 이미지 크기가 색인 정보와 다릅니다.')
    if digest.hexdigest() != entry['sha256']:
        raise ValueError('태그 사전 이미지 SHA-256이 색인 정보와 다릅니다.')
    if len(prefix) < 12 or prefix[:4] != b'RIFF' or prefix[8:12] != b'WEBP':
        raise ValueError('태그 사전 이미지가 WebP 형식이 아닙니다.')


def _validate_image(path, entry):
    try:
        with Image.open(path) as image:
            if (image.format != 'WEBP' or image.size != (entry['width'], entry['height'])
                    or not 0 < image.width <= 16_383 or not 0 < image.height <= 16_383
                    or image.width * image.height > 100_000_000):
                raise ValueError('태그 사전 이미지 형식 또는 크기가 색인 정보와 다릅니다.')
            image.load()
            prompt, negative, source = extract_prompt(image)
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as error:
        if isinstance(error, ValueError) and str(error).startswith('태그 사전 이미지'):
            raise
        raise ValueError('태그 사전 WebP 이미지 또는 메타데이터를 읽지 못했습니다.') from None
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError('태그 사전 이미지에 검색할 프롬프트가 없습니다.')
    return prompt.strip(), negative.strip() if isinstance(negative, str) else '', source


def _extract_pack(archive_path, pack, staging, stop_event, progress):
    staging = Path(staging)
    if not staging.is_dir() or any(staging.iterdir()):
        raise ValueError('태그 사전 임시 저장 폴더를 사용할 수 없습니다.')
    _check_stop(stop_event)
    try:
        with zipfile.ZipFile(archive_path, 'r') as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if (len(infos) != pack['image_count'] + 1
                    or len(set(name.casefold() for name in names)) != len(names)):
                raise ValueError('태그 사전 압축파일 항목 수가 올바르지 않습니다.')
            by_name = {}
            expanded_total = 0
            for info in infos:
                mode = stat.S_IFMT(info.external_attr >> 16)
                if (info.is_dir() or mode not in (0, stat.S_IFREG) or info.flag_bits & 1
                        or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                        or not isinstance(info.filename, str)):
                    raise ValueError('태그 사전 압축파일에 허용되지 않는 항목이 있습니다.')
                limit = MAX_INDEX_BYTES if info.filename == INDEX else MAX_IMAGE_BYTES
                if not 0 < info.file_size <= limit:
                    raise ValueError('태그 사전 압축파일 항목 크기가 허용 범위를 벗어났습니다.')
                expanded_total += info.file_size
                if expanded_total > MAX_EXPANDED_BYTES + MAX_INDEX_BYTES:
                    raise ValueError('태그 사전 압축파일 전체 크기가 허용 범위를 벗어났습니다.')
                by_name[info.filename] = info
            if INDEX not in by_name:
                raise ValueError('태그 사전 압축파일에 색인이 없습니다.')

            index_bytes = _read_zip_entry(archive, by_name[INDEX], MAX_INDEX_BYTES, stop_event)
            if hashlib.sha256(index_bytes).hexdigest() != pack['index_sha256']:
                raise ValueError('태그 사전 색인 SHA-256이 이미지팩 설명과 다릅니다.')
            try:
                index_document = json.loads(index_bytes.decode('utf-8'))
            except (UnicodeError, ValueError, TypeError):
                raise ValueError('태그 사전 색인 JSON을 읽지 못했습니다.') from None
            images = validate_index(index_document)
            image_bytes = sum(image['bytes'] for image in images)
            if len(images) != pack['image_count'] or image_bytes != pack['image_bytes']:
                raise ValueError('태그 사전 색인 이미지 수 또는 크기가 이미지팩 설명과 다릅니다.')
            expected_names = {INDEX, *(entry['file'] for entry in images)}
            if set(by_name) != expected_names:
                raise ValueError('태그 사전 압축파일 항목이 색인과 일치하지 않습니다.')

            images_dir = staging / 'images'
            images_dir.mkdir()
            (staging / INDEX).write_bytes(index_bytes)
            records = []
            for number, entry in enumerate(images, 1):
                _check_stop(stop_event)
                info = by_name[entry['file']]
                target = staging.joinpath(*entry['file'].split('/'))
                _write_image_entry(archive, info, target, entry, stop_event)
                prompt, negative, source = _validate_image(target, entry)
                records.append({'id': entry['id'], 'file': entry['file'],
                                'width': entry['width'], 'height': entry['height'],
                                'prompt': prompt, 'negative': negative, 'source': source})
                progress(phase='extract', phase_current=number, phase_total=len(images),
                         message='태그 사전 이미지 확인 중')
            _check_stop(stop_event)
            return records
    except (zipfile.BadZipFile, zipfile.LargeZipFile, EOFError, RuntimeError, NotImplementedError):
        raise ValueError('태그 사전 압축파일을 읽지 못했습니다.') from None


def _files_under(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        return None
    files = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            return None
        if path.is_dir():
            if path.relative_to(root).as_posix() != 'images':
                return None
            continue
        if not path.is_file():
            return None
        files[path.relative_to(root).as_posix()] = path
    return files


def _same_pack_directory(existing, staged, images):
    existing_files = _files_under(existing)
    staged_files = _files_under(staged)
    expected = {INDEX, *(entry['file'] for entry in images)}
    if (existing_files is None or staged_files is None
            or set(existing_files) != expected or set(staged_files) != expected):
        return False
    return all(filecmp.cmp(existing_files[name], staged_files[name], shallow=False)
               for name in expected)


def _publish_pack(staged, destination, images):
    destination = Path(destination)
    if destination.is_symlink():
        raise ValueError('태그 사전 이미지팩 저장 위치를 확인해 주세요.')
    if destination.exists():
        if not _same_pack_directory(destination, staged, images):
            raise ValueError('같은 태그 사전 이미지팩 리비전의 기존 파일이 다릅니다.')
        return destination
    try:
        Path(staged).rename(destination)
    except OSError:
        if destination.exists() and _same_pack_directory(destination, staged, images):
            return destination
        raise
    return destination


class DictionaryImageDownload:
    """Single-flight asynchronous download manager for dictionary image packs."""

    def __init__(self, catalog_provider, user_directory, pack_provider=None):
        self.catalog_provider = catalog_provider
        self.user_directory = Path(user_directory).expanduser().resolve()
        self.pack_provider = pack_provider or latest_dictionary_pack
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._job = None

    def status(self):
        with self._lock:
            return deepcopy(self._job) if self._job is not None else {
                'status': 'idle', 'phase': 'idle', 'phase_current': 0, 'phase_total': 0,
                'message': '', 'installed': 0,
            }

    def _update(self, **changes):
        with self._lock:
            if self._job is not None:
                self._job.update(changes)

    def _progress(self, **progress):
        self._update(**{key: progress[key] for key in ('phase', 'phase_current', 'phase_total', 'message')
                        if key in progress})

    def start(self):
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return deepcopy(self._job)
            catalog = self.catalog_provider()
            with catalog.lock:
                if not catalog.can_install_image_pack():
                    raise ValueError('이미 유효한 태그 사전 이미지 폴더가 연결되어 있습니다.')
                generation = catalog.generation
            self._stop.clear()
            self._job = {
                'id': uuid.uuid4().hex,
                'status': 'running', 'phase': 'resolve', 'phase_current': 0,
                'phase_total': 0, 'message': '태그 사전 이미지팩 확인 중', 'installed': 0,
            }
            self._thread = threading.Thread(
                target=self._worker, args=(catalog, generation), daemon=True,
                name='tag-dictionary-image-pack',
            )
            self._thread.start()
            return deepcopy(self._job)

    def stop(self):
        with self._lock:
            if (self._thread is not None and self._thread.is_alive()
                    and self._job is not None and self._job['status'] == 'running'):
                self._stop.set()
                self._job.update(status='stopping', message='태그 사전 이미지 다운로드 중지 중…')
            return deepcopy(self._job) if self._job is not None else self.status()

    def _directories(self):
        root = self.user_directory
        root.mkdir(parents=True, exist_ok=True)
        cache = root / 'image_pack_downloads'
        shared = root / 'shared_image_packs'
        for directory in (cache, shared):
            if directory.is_symlink():
                raise ValueError('태그 사전 이미지팩 저장 위치를 확인해 주세요.')
            directory.mkdir(parents=True, exist_ok=True)
            if directory.resolve().parent != root:
                raise ValueError('태그 사전 이미지팩 저장 위치를 확인해 주세요.')
        return cache, shared

    def _archive(self, cache, pack):
        target = cache / (pack['sha256'] + '.zip')
        partial = target.with_name(target.name + '.partial')
        if target.is_symlink() or partial.is_symlink():
            raise ValueError('태그 사전 이미지팩 다운로드 파일을 확인해 주세요.')
        if target.exists():
            if not target.is_file():
                raise ValueError('태그 사전 이미지팩 다운로드 파일을 확인해 주세요.')
            if target.stat().st_size == pack['bytes']:
                verified = _verify_digest(target, pack, self._stop, self._progress,
                                          message='태그 사전 이미지팩 확인 중')
                if verified:
                    return target
                raise _DownloadStopped()
            # This digest-keyed file is our cache; a truncated/stale final file
            # cannot be resumed safely, so remove only this exact cache target.
            target.unlink()
        self._update(phase='download', phase_current=0, phase_total=pack['bytes'],
                     message='태그 사전 이미지팩 다운로드 중')
        downloaded = _download(
            target, pack, self._stop, self._progress, url=pack['url'],
            download_message='태그 사전 이미지팩 다운로드 중',
            verification_message='태그 사전 이미지팩 확인 중',
        )
        if not downloaded:
            raise _DownloadStopped()
        return target

    def _worker(self, catalog, generation):
        try:
            pack = self.pack_provider(self._stop)
            _check_stop(self._stop)
            pack = _validate_pack_spec(pack)
            cache, shared = self._directories()
            archive_path = self._archive(cache, pack)
            final_directory = shared / pack['sha256']
            self._update(phase='extract', phase_current=0, phase_total=pack['image_count'],
                         message='태그 사전 이미지 확인 중')
            with tempfile.TemporaryDirectory(prefix='install-', dir=shared) as temporary:
                staging = Path(temporary)
                records = _extract_pack(archive_path, pack, staging, self._stop, self._update)
                _check_stop(self._stop)
                published = _publish_pack(staging, final_directory,
                                          validate_index(json.loads((staging / INDEX).read_text(encoding='utf-8'))))
                self._update(phase='install', phase_current=0, phase_total=len(records),
                             message='태그 사전 이미지 연결 중')
                result = catalog.install_image_pack(
                    published, records, expected_generation=generation, stop_event=self._stop,
                )
                if result is False:
                    raise ValueError('태그 사전 이미지 폴더를 연결하지 못했습니다.')
            self._update(status='completed', phase='complete', phase_current=len(records),
                         phase_total=len(records), message='태그 사전 이미지 설치 완료',
                         installed=len(records))
        except _DownloadStopped:
            self._update(status='stopped', phase='stopped', message='태그 사전 이미지 다운로드를 중지했습니다.')
        except (OSError, ValueError, DakiStyleArchiveError, zipfile.BadZipFile) as error:
            if _stopped(self._stop):
                self._update(status='stopped', phase='stopped', message='태그 사전 이미지 다운로드를 중지했습니다.')
                return
            message = str(error)
            if (not isinstance(error, ValueError) or '\\' in message
                    or re.search(r'(?<!:)\/(?!/)', message)):
                message = _GENERIC_FAILURE
            self._update(status='failed', phase='failed', message=message)
        except Exception:
            self._update(status='failed', phase='failed', message=_GENERIC_FAILURE)

    def wait(self, timeout=10):
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def shutdown(self):
        self.stop()
        return self.wait(2)
