"""Download portable shared tests without replacing local generation results."""
from copy import deepcopy
from datetime import datetime
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
from naim.hf_http import public_session

from naim.daki_style_archive import (
    DakiStyleArchiveError, HF_REVISION_API_URL, HF_ARCHIVE_INFO_URL,
    _read_metadata, _metadata_json, _download, _verify_digest,
)
from naim.daki_style_tests import BATCH_ID, STYLE_ID, MODELS, _request_settings, _dimensions
from naim.storage.json_files import write_json


FORMAT = 'naim-style-test-packs'
MANIFEST = 'style_test_packs.json'
MAX_PACK_BYTES = 2 * 1024 ** 3
MAX_EXPANDED_BYTES = 4 * 1024 ** 3
MAX_BATCH_BYTES = 64 * 1024 ** 2
MAX_IMAGE_BYTES = 32 * 1024 ** 2
MAX_IMAGES = 10000


class _PackStopped(Exception):
    pass


def _check_stop(stop_event):
    if stop_event is not None and stop_event.is_set():
        raise _PackStopped()


def validate_manifest(document):
    """Validate the fixed-repository manifest; URLs never come from its contents."""
    if (not isinstance(document, dict) or document.get('format') != FORMAT
            or document.get('version') != 1 or not isinstance(document.get('packs'), list)
            or not 1 <= len(document['packs']) <= 32):
        raise ValueError('공유 테스트 목록 형식이 올바르지 않습니다.')
    packs, seen = [], set()
    for raw in document['packs']:
        if not isinstance(raw, dict):
            raise ValueError('공유 테스트 정보가 올바르지 않습니다.')
        pack_id, name = raw.get('id'), raw.get('name')
        if (not isinstance(pack_id, str) or not BATCH_ID.fullmatch(pack_id) or pack_id in seen
                or not isinstance(name, str) or not name.strip() or len(name) > 120
                or raw.get('filename') != 'style_test_' + pack_id + '.zip'
                or not isinstance(raw.get('sha256'), str)
                or not re.fullmatch(r'[0-9a-f]{64}', raw['sha256'])):
            raise ValueError('공유 테스트 이름 또는 파일 정보가 올바르지 않습니다.')
        for key, maximum in (('bytes', MAX_PACK_BYTES), ('expanded_bytes', MAX_EXPANDED_BYTES),
                             ('image_count', MAX_IMAGES)):
            if type(raw.get(key)) is not int or not 0 < raw[key] <= maximum:
                raise ValueError('공유 테스트 크기 또는 그림 수가 허용 범위를 벗어났습니다.')
        seen.add(pack_id)
        packs.append({key: raw[key] for key in
                      ('id', 'name', 'filename', 'sha256', 'bytes', 'expanded_bytes', 'image_count')})
    return packs


def latest_packs(stop_event=None):
    """Pin the manifest and every archive to one public Hugging Face revision."""
    _check_stop(stop_event)
    try:
        with public_session() as session:
            raw = _read_metadata(session, HF_REVISION_API_URL, stop_event, '공유 테스트 버전을 확인하지 못했습니다.')
            _check_stop(stop_event)
            revision_doc = _metadata_json(raw, '공유 테스트 버전')
            revision, siblings = revision_doc.get('sha'), revision_doc.get('siblings')
            if (not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision)
                    or not isinstance(siblings, list)):
                raise ValueError('공유 테스트 버전 정보가 올바르지 않습니다.')
            if not any(isinstance(item, dict) and item.get('rfilename') == MANIFEST for item in siblings):
                raise ValueError('공유 테스트가 아직 게시되지 않았습니다. 나중에 다시 확인해 주세요.')
            raw = _read_metadata(session, HF_ARCHIVE_INFO_URL + revision + '/' + MANIFEST,
                                 stop_event, '공유 테스트 목록을 불러오지 못했습니다.')
            _check_stop(stop_event)
            packs = validate_manifest(_metadata_json(raw, '공유 테스트 목록'))
            for pack in packs:
                matches = [item for item in siblings if isinstance(item, dict)
                           and item.get('rfilename') == pack['filename']]
                if len(matches) != 1 or matches[0].get('size') != pack['bytes']:
                    raise ValueError('공유 테스트 파일 크기가 게시된 목록과 다릅니다.')
                lfs = matches[0].get('lfs')
                if lfs is not None and (not isinstance(lfs, dict) or lfs.get('sha256') != pack['sha256']
                                        or lfs.get('size') != pack['bytes']):
                    raise ValueError('공유 테스트 해시가 게시된 버전과 다릅니다.')
                pack.update(revision=revision, url=HF_ARCHIVE_INFO_URL + revision + '/' + pack['filename'] + '?download=true')
            return packs
    except requests.RequestException:
        raise ValueError('Hugging Face 공유 테스트 목록에 연결하지 못했습니다. 다시 시도해 주세요.') from None


def validate_batch(batch, pack):
    """Keep exact saved requests while checking the fields consumed by test APIs."""
    if (not isinstance(batch, dict) or batch.get('id') != pack['id']
            or not isinstance(batch.get('name'), str) or not batch['name'].strip() or len(batch['name']) > 120
            or batch.get('name') != pack['name'] or batch.get('library') != 'shared'
            or batch.get('status') != 'completed' or batch.get('model') not in MODELS
            or not isinstance(batch.get('items'), list) or len(batch['items']) != pack['image_count']):
        raise ValueError('공유 테스트 결과 정보가 목록과 일치하지 않습니다.')
    _request_settings(batch)
    if (not isinstance(batch.get('prompt'), str) or not isinstance(batch.get('negative_prompt'), str)
            or not isinstance(batch.get('char_prompts'), list)):
        raise ValueError('공유 테스트 생성 설정을 확인해 주세요.')
    for key in ('created_at', 'updated_at'):
        if not isinstance(batch.get(key), str):
            raise ValueError('공유 테스트 저장 날짜가 올바르지 않습니다.')
        try:
            datetime.fromisoformat(batch[key].replace('Z', '+00:00'))
        except ValueError:
            raise ValueError('공유 테스트 저장 날짜가 올바르지 않습니다.') from None
    seen = set()
    for item in batch['items']:
        if not isinstance(item, dict):
            raise ValueError('공유 테스트 그림 정보가 올바르지 않습니다.')
        sid, style, payload = item.get('style_id'), item.get('style'), item.get('payload')
        if (not isinstance(sid, str) or not STYLE_ID.fullmatch(sid) or sid.casefold() in seen
                or item.get('status') != 'completed'
                or item.get('legacy_preview') or item.get('output_format') not in ('png', 'webp')
                or not isinstance(style, dict) or style.get('id') != sid
                or any(not isinstance(style.get(key), str) for key in ('name', 'model', 'positive', 'negative'))
                or not isinstance(style.get('options'), dict) or not isinstance(style.get('preview'), dict)
                or not isinstance(payload, dict) or payload.get('model') not in MODELS
                or payload.get('action') != 'generate' or not isinstance(payload.get('input'), str)
                or not isinstance(payload.get('parameters'), dict)):
            raise ValueError('공유 테스트 그림 또는 생성 요청 형식이 올바르지 않습니다.')
        parameters = payload['parameters']
        _dimensions(parameters)
        if type(parameters.get('steps')) is not int or not 1 <= parameters['steps'] <= 50:
            raise ValueError('공유 테스트 생성 단계가 올바르지 않습니다.')
        seen.add(sid.casefold())
    return batch


def extract_pack(archive_path, pack, staging, stop_event=None, progress=None):
    """Validate the complete archive before exposing an ordinary test directory."""
    staging = Path(staging).resolve()
    if not staging.is_dir() or any(staging.iterdir()):
        raise ValueError('공유 테스트 임시 저장 폴더가 비어 있지 않습니다.')
    _check_stop(stop_event)
    try:
        with zipfile.ZipFile(archive_path) as archive:
            infos = archive.infolist()
            names = [info.filename for info in infos]
            if (len(infos) != pack['image_count'] * 2 + 1
                    or len(set(name.casefold() for name in names)) != len(names)
                    or sum(info.file_size for info in infos) != pack['expanded_bytes']):
                raise ValueError('공유 테스트 압축파일의 항목 수 또는 크기가 다릅니다.')
            for info in infos:
                mode = stat.S_IFMT(info.external_attr >> 16)
                if (info.is_dir() or mode not in (0, stat.S_IFREG) or info.flag_bits & 1
                        or not re.fullmatch(r'(?:batch\.json|[A-Za-z0-9_-]{1,128}\.(?:png|webp|jpg))', info.filename)
                        or not 0 < info.file_size <= (MAX_BATCH_BYTES if info.filename == 'batch.json' else MAX_IMAGE_BYTES)):
                    raise ValueError('공유 테스트 압축파일에 허용되지 않는 항목이 있습니다.')
            if 'batch.json' not in names:
                raise ValueError('공유 테스트 설정 파일이 없습니다.')
            batch = validate_batch(json.loads(archive.read('batch.json')), pack)
            expected = {'batch.json'}
            for item in batch['items']:
                expected.update((item['style_id'] + '.' + item['output_format'], item['style_id'] + '.jpg'))
            if set(names) != expected:
                raise ValueError('공유 테스트 그림 파일이 저장된 설정과 일치하지 않습니다.')
            count = 0
            for item in batch['items']:
                for suffix in ('.' + item['output_format'], '.jpg'):
                    _check_stop(stop_event)
                    filename = item['style_id'] + suffix
                    target = staging / filename
                    with archive.open(filename) as source, target.open('xb') as output:
                        while chunk := source.read(1024 * 1024):
                            _check_stop(stop_event)
                            output.write(chunk)
                    with Image.open(target) as image:
                        if suffix == '.jpg':
                            valid = image.format == 'JPEG' and 0 < image.width <= 512 and 0 < image.height <= 512
                        else:
                            params = item['payload']['parameters']
                            valid = (image.format == item['output_format'].upper()
                                     and image.size == (params['width'], params['height']))
                        if not valid:
                            raise ValueError('공유 테스트 그림 형식 또는 크기가 설정과 다릅니다.')
                        image.verify()
                count += 1
                if progress:
                    progress(phase='extract', phase_current=count, phase_total=pack['image_count'],
                             message='공유 테스트 그림 확인 중')
            _check_stop(stop_event)
            batch['shared_pack'] = {key: pack[key] for key in ('sha256', 'revision') if key in pack}
            write_json(staging / 'batch.json', batch, indent=2)
            return batch
    except (zipfile.BadZipFile, KeyError, UnicodeError, json.JSONDecodeError):
        raise ValueError('공유 테스트 압축파일 또는 설정을 읽지 못했습니다.') from None


class DakiTestPacks:
    def __init__(self, tests, catalog_provider=None):
        self.tests = tests
        self.catalog_provider = catalog_provider or latest_packs
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._job = None

    def _installed(self, pack_id):
        return self.tests._directory(self.tests._root(), pack_id).exists()

    def catalog(self):
        packs = self.catalog_provider()
        return {'packs': [{**{key: pack[key] for key in ('id', 'name', 'image_count', 'bytes')},
                           'installed': self._installed(pack['id'])} for pack in packs], 'job': self.status()}

    def status(self):
        with self._lock:
            return deepcopy(self._job)

    def _update(self, **changes):
        with self._lock:
            self._job.update(changes)

    def start(self, data):
        ids = data.get('pack_ids') if isinstance(data, dict) else None
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 32
                or any(not isinstance(value, str) or not BATCH_ID.fullmatch(value) for value in ids)
                or len(set(ids)) != len(ids)):
            raise ValueError('다운로드할 공유 테스트를 선택해 주세요.')
        with self._lock:
            if self._thread and self._thread.is_alive():
                raise ValueError('공유 테스트를 다운로드하고 있습니다.')
            self._stop.clear()
            self._job = {'id': uuid.uuid4().hex, 'status': 'running', 'phase': 'resolve',
                         'message': '공유 테스트 버전 확인 중', 'pack_name': '', 'completed_packs': 0,
                         'total_packs': len(ids), 'installed': 0, 'skipped': 0,
                         'phase_current': 0, 'phase_total': 0}
            self._thread = threading.Thread(target=self._worker, args=(list(ids),), daemon=True)
            self._thread.start()
            return deepcopy(self._job)

    def stop(self):
        with self._lock:
            if self._thread and self._thread.is_alive() and self._job['status'] == 'running':
                self._stop.set()
                self._job.update(status='stopping', message='다운로드 중지 중…')
            return deepcopy(self._job)

    def _worker(self, ids):
        try:
            packs = {pack['id']: pack for pack in self.catalog_provider(self._stop)}
            _check_stop(self._stop)
            if any(pack_id not in packs for pack_id in ids):
                raise ValueError('선택한 공유 테스트를 찾을 수 없습니다. 목록을 다시 불러와 주세요.')
            root = self.tests._root()
            cache = root / '.packs'
            if cache.is_symlink() or cache.resolve().parent != root:
                raise ValueError('공유 테스트 다운로드 폴더를 확인해 주세요.')
            cache.mkdir(parents=True, exist_ok=True)
            for index, pack_id in enumerate(ids):
                _check_stop(self._stop)
                pack = packs[pack_id]
                self._update(pack_name=pack['name'], phase='resolve', phase_current=0, phase_total=0)
                if self._installed(pack_id):
                    with self._lock:
                        self._job['skipped'] += 1
                    self._update(completed_packs=index + 1)
                    continue
                target = cache / (pack['sha256'] + '.zip')
                if target.is_symlink() or target.with_name(target.name + '.partial').is_symlink():
                    raise ValueError('공유 테스트 다운로드 파일을 확인해 주세요.')
                if target.exists():
                    finished = _verify_digest(target, pack, self._stop, self._update)
                else:
                    finished = _download(target, pack, self._stop, self._update, url=pack['url'],
                                         download_message='공유 테스트 다운로드 중', verification_message='공유 테스트 파일 확인 중')
                if not finished:
                    raise _PackStopped()
                with tempfile.TemporaryDirectory(prefix='install-', dir=cache) as temporary:
                    staging = Path(temporary)
                    batch = extract_pack(target, pack, staging, self._stop, self._update)
                    _check_stop(self._stop)
                    self._update(phase='install', message='테스트 폴더에 추가하는 중', phase_current=0, phase_total=1)
                    installed = self.tests.install_shared_pack(staging, batch, stop_event=self._stop)
                    with self._lock:
                        self._job['installed' if installed else 'skipped'] += 1
                self._update(completed_packs=index + 1)
            self._update(status='completed', phase='complete', phase_current=1, phase_total=1,
                         message='공유 테스트 다운로드 완료')
        except _PackStopped:
            self._update(status='stopped', message='다운로드를 중지했습니다. 다시 실행하면 이어받습니다.')
        except (OSError, ValueError, DakiStyleArchiveError) as error:
            self._update(status='failed', message=str(error) if isinstance(error, ValueError)
                         else '공유 테스트 파일을 읽거나 저장하지 못했습니다. 다시 시도해 주세요.')
        except Exception:
            self._update(status='failed', message='공유 테스트 처리에 실패했습니다. 기존 테스트는 유지됩니다.')

    def wait(self, timeout=10):
        thread = self._thread
        if thread is not None:
            thread.join(timeout)
            return not thread.is_alive()
        return True

    def shutdown(self):
        self.stop()
        return self.wait(2)
