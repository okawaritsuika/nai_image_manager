import hashlib
import io
import json
import tempfile
import threading
import time
import unittest
import zipfile
from pathlib import Path
from unittest import mock

from PIL import Image

from naim import daki_dictionary_download as download_module
from naim.daki_dictionary_download import DictionaryImageDownload, latest_dictionary_pack
from naim.daki_dictionary_images import ImageCatalog
from naim.daki_dictionary_pack_format import (
    ARCHIVE, FORMAT, INDEX, MANIFEST, MAX_IMAGE_BYTES,
    validate_index, validate_manifest,
)
from naim.daki_style_archive import DakiStyleArchiveError, HF_ARCHIVE_INFO_URL, HF_REVISION_API_URL


REVISION = 'a' * 40
_TEST_TEMP_ROOT = Path(__file__).resolve().parents[1] / '.qa' / 'delete-import-tests-temp'


def _temporary_directory(prefix):
    _TEST_TEMP_ROOT.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix, dir=_TEST_TEMP_ROOT)


def _webp(prompt='smile, closed eyes', negative='frown', size=(24, 32)):
    output = io.BytesIO()
    options = {'format': 'WEBP', 'quality': 90}
    if prompt is not None:
        exif = Image.Exif()
        exif[270] = '%s\nNegative prompt: %s\nSteps: 20' % (prompt, negative)
        options['exif'] = exif
    Image.new('RGB', size, 'white').save(output, **options)
    return output.getvalue()


def _index(image_bytes):
    return {
        'format': FORMAT,
        'version': 1,
        'images': [{
            'id': 123,
            'file': 'images/000123.webp',
            'bytes': len(image_bytes),
            'sha256': hashlib.sha256(image_bytes).hexdigest(),
            'width': 24,
            'height': 32,
        }],
    }


def _archive(members):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for name, content in members:
            target.writestr(name, content)
    return output.getvalue()


def _fixture(image_bytes=None, *, members=None, index_document=None, index_bytes=None):
    image_bytes = _webp() if image_bytes is None else image_bytes
    index_document = _index(image_bytes) if index_document is None else index_document
    if index_bytes is None:
        index_bytes = json.dumps(index_document, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if members is None:
        members = [(INDEX, index_bytes), (index_document['images'][0]['file'], image_bytes)]
    archive_bytes = _archive(members)
    spec = {
        'format': FORMAT,
        'version': 1,
        'filename': ARCHIVE,
        'bytes': len(archive_bytes),
        'sha256': hashlib.sha256(archive_bytes).hexdigest(),
        'image_count': len(index_document.get('images', [])),
        'image_bytes': sum(item['bytes'] for item in index_document.get('images', [])),
        'index_sha256': hashlib.sha256(index_bytes).hexdigest(),
        'quality': 90,
        'revision': REVISION,
        'url': HF_ARCHIVE_INFO_URL + REVISION + '/' + ARCHIVE + '?download=true',
    }
    return archive_bytes, spec, index_document, index_bytes, image_bytes


class DictionaryPackFormatTests(unittest.TestCase):
    def test_manifest_and_index_return_copies_and_reject_unknown_or_unsafe_fields(self):
        _, manifest, index, _, _ = _fixture()
        raw_manifest = {key: manifest[key] for key in (
            'format', 'version', 'filename', 'bytes', 'sha256', 'image_count',
            'image_bytes', 'index_sha256', 'quality')}
        validated_manifest = validate_manifest(raw_manifest)
        self.assertEqual(validated_manifest, raw_manifest)
        self.assertIsNot(validated_manifest, raw_manifest)
        validated_index = validate_index(index)
        self.assertEqual(validated_index, index['images'])
        self.assertIsNot(validated_index, index['images'])

        for change in (
            {'extra': 'private/path'},
            {'bytes': True},
            {'version': True},
            {'filename': '../archive.zip'},
        ):
            bad = {**raw_manifest, **change}
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_manifest(bad)

        invalid_indexes = []
        path_traversal = json.loads(json.dumps(index))
        path_traversal['images'][0]['file'] = 'images/../outside.webp'
        invalid_indexes.append(path_traversal)
        boolean_size = json.loads(json.dumps(index))
        boolean_size['images'][0]['bytes'] = True
        invalid_indexes.append(boolean_size)
        unknown = json.loads(json.dumps(index))
        unknown['images'][0]['path'] = 'C:/private/image.webp'
        invalid_indexes.append(unknown)
        duplicate = json.loads(json.dumps(index))
        duplicate['images'].append(dict(duplicate['images'][0]))
        invalid_indexes.append(duplicate)
        for bad in invalid_indexes:
            with self.subTest(index=bad), self.assertRaises(ValueError):
                validate_index(bad)

    def test_index_enforces_dimension_and_expanded_byte_bounds(self):
        image = _webp()
        _, _, index, _, _ = _fixture(image)
        for width, height in ((16384, 1), (10000, 10001)):
            bad = json.loads(json.dumps(index))
            bad['images'][0].update(width=width, height=height)
            with self.subTest(size=(width, height)), self.assertRaises(ValueError):
                validate_index(bad)
        bad = json.loads(json.dumps(index))
        bad['images'][0]['bytes'] = MAX_IMAGE_BYTES + 1
        with self.assertRaises(ValueError):
            validate_index(bad)


class LatestDictionaryPackTests(unittest.TestCase):
    def test_latest_pack_uses_manifest_and_archive_at_the_same_public_revision(self):
        archive_bytes, spec, _, _, _ = _fixture()
        del archive_bytes
        manifest = {key: spec[key] for key in (
            'format', 'version', 'filename', 'bytes', 'sha256', 'image_count',
            'image_bytes', 'index_sha256', 'quality')}
        revision_doc = {
            'sha': REVISION,
            'siblings': [
                {'rfilename': MANIFEST, 'size': 256},
                {'rfilename': ARCHIVE, 'size': spec['bytes'],
                 'lfs': {'size': spec['bytes'], 'sha256': spec['sha256']}},
            ],
        }
        session = mock.MagicMock()
        with mock.patch.object(download_module, 'public_session') as public_session, \
                mock.patch.object(download_module, '_read_metadata', side_effect=[
                    json.dumps(revision_doc).encode(), json.dumps(manifest).encode(),
                ]) as read_metadata:
            public_session.return_value.__enter__.return_value = session
            result = latest_dictionary_pack()
        self.assertEqual(result['revision'], REVISION)
        self.assertEqual(result['url'], HF_ARCHIVE_INFO_URL + REVISION + '/' + ARCHIVE + '?download=true')
        self.assertEqual(read_metadata.call_args_list[0].args[1], HF_REVISION_API_URL)
        self.assertEqual(read_metadata.call_args_list[1].args[1],
                         HF_ARCHIVE_INFO_URL + REVISION + '/' + MANIFEST)

    def test_missing_manifest_404_has_friendly_message(self):
        revision_doc = {'sha': REVISION, 'siblings': [{'rfilename': ARCHIVE}]}
        with mock.patch.object(download_module, 'public_session') as public_session, \
                mock.patch.object(download_module, '_read_metadata', side_effect=[
                    json.dumps(revision_doc).encode(),
                    DakiStyleArchiveError('설명 (HTTP 404)'),
                ]):
            public_session.return_value.__enter__.return_value = mock.MagicMock()
            with self.assertRaisesRegex(ValueError, '태그 사전 이미지팩이 아직 게시되지 않았습니다'):
                latest_dictionary_pack()


class DictionaryImageDownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = _temporary_directory(prefix='daki-dictionary-pack-')
        self.root = Path(self.temporary.name)
        self.image_bytes, self.spec, self.index, self.index_bytes, _ = _fixture()
        self.catalog = ImageCatalog(self.root, {'smile', 'closed eyes', 'frown'})
        self.manager = None

    def tearDown(self):
        if self.manager is not None:
            self.manager.shutdown()
        self.catalog.close()
        self.temporary.cleanup()

    def manager_for(self, provider=None, catalog=None):
        self.manager = DictionaryImageDownload(
            lambda: catalog or self.catalog, self.root,
            pack_provider=provider or (lambda stop_event=None: self.spec),
        )
        return self.manager

    def download_stub(self, archive_bytes=None):
        archive_bytes = archive_bytes or _fixture()[0]

        def write_archive(target, spec, stop_event, progress, url=None, **kwargs):
            if stop_event.is_set():
                return False
            progress(phase='download', phase_current=len(archive_bytes),
                     phase_total=spec['bytes'], message='합성 다운로드')
            target.write_bytes(archive_bytes)
            return True
        return write_archive

    def start_and_wait(self):
        job = self.manager.start()
        self.assertTrue(self.manager.wait(10), 'pack job did not finish')
        return job, self.manager.status()

    def test_download_extracts_metadata_and_installs_records_without_network(self):
        manager = self.manager_for()
        with mock.patch.object(download_module, '_download', side_effect=self.download_stub()):
            started, final = self.start_and_wait()
        self.assertEqual(started['status'], 'running')
        self.assertTrue(started['id'])
        self.assertEqual(final['status'], 'completed')
        self.assertEqual(final['installed'], 1)
        self.assertEqual(final['phase'], 'complete')
        self.assertEqual(self.catalog.query('smile')['total'], 1)
        item = self.catalog.query('closed eyes')['items'][0]
        detail = self.catalog.detail(item['id'])
        self.assertEqual(detail['id'], 123)
        self.assertEqual(detail['negative_prompt'], 'frown')
        self.assertEqual(detail['metadata_source'], 'EXIF')
        self.assertTrue(Path(detail['path']).is_relative_to(self.root / 'shared_image_packs'))

    def test_duplicate_start_is_single_flight_and_stop_is_reported(self):
        entered, release = threading.Event(), threading.Event()

        def provider(stop_event=None):
            entered.set()
            release.wait(5)
            return self.spec

        manager = self.manager_for(provider)
        first = manager.start()
        self.assertTrue(entered.wait(5))
        second = manager.start()
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(manager.stop()['status'], 'stopping')
        release.set()
        self.assertTrue(manager.wait(5))
        self.assertEqual(manager.status()['status'], 'stopped')
        self.assertIsNone(self.catalog.status()['folder'])

    def test_retry_keeps_partial_cache_and_reports_download_progress(self):
        manager = self.manager_for()
        attempts = []
        archive_bytes, _, _, _, _ = _fixture()

        def resumable(target, spec, stop_event, progress, url=None, **kwargs):
            partial = target.with_name(target.name + '.partial')
            attempts.append(partial.exists())
            if len(attempts) == 1:
                partial.write_bytes(b'partial')
                progress(phase='download', phase_current=7, phase_total=spec['bytes'],
                         message='다운로드 중')
                raise DakiStyleArchiveError('연결이 끊겼습니다. 다시 시도해 주세요.')
            self.assertTrue(partial.exists())
            self.assertEqual(url, self.spec['url'])
            target.write_bytes(archive_bytes)
            partial.unlink()
            progress(phase='download', phase_current=len(archive_bytes),
                     phase_total=spec['bytes'], message='완료')
            return True

        with mock.patch.object(download_module, '_download', side_effect=resumable):
            manager.start()
            self.assertTrue(manager.wait(5))
            self.assertEqual(manager.status()['status'], 'failed')
            self.assertEqual(manager.status()['phase_current'], 7)
            manager.start()
            self.assertTrue(manager.wait(10))
        self.assertEqual(attempts, [False, True])
        self.assertEqual(manager.status()['status'], 'completed')
        self.assertEqual(self.catalog.query('smile')['total'], 1)

    def test_wrong_size_final_cache_is_removed_and_redownloaded(self):
        manager = self.manager_for()
        cache = self.root / 'image_pack_downloads'
        cache.mkdir()
        target = cache / (self.spec['sha256'] + '.zip')
        target.write_bytes(b'truncated')
        downloader = self.download_stub()
        with mock.patch.object(download_module, '_download', side_effect=downloader) as download:
            manager.start()
            self.assertTrue(manager.wait(10))
        self.assertEqual(download.call_count, 1)
        self.assertEqual(manager.status()['status'], 'completed')
        self.assertEqual(target.stat().st_size, self.spec['bytes'])

    def test_generation_change_preserves_new_connection_and_old_rows(self):
        entered, release = threading.Event(), threading.Event()

        def provider(stop_event=None):
            entered.set()
            release.wait(5)
            return self.spec

        manager = self.manager_for(provider)
        with mock.patch.object(download_module, '_download', side_effect=self.download_stub()):
            manager.start()
            self.assertTrue(entered.wait(5))
            other = self.root / 'other'
            other.mkdir()
            self._write_local_png(other / 'current.png')
            self.catalog.set_folder(str(other))
            self.assertTrue(self._wait_scan())
            release.set()
            self.assertTrue(manager.wait(10))
        self.assertEqual(manager.status()['status'], 'failed')
        self.assertEqual(self.catalog.status()['folder'], str(other.resolve()))
        self.assertEqual(self.catalog.query('smile')['total'], 1)
        self.assertEqual(self.catalog.query('closed eyes')['total'], 0)

    def test_existing_usable_folder_blocks_download_start(self):
        existing = self.root / 'existing'
        existing.mkdir()
        self._write_local_png(existing / 'keep.png')
        self.catalog.set_folder(str(existing))
        self.assertTrue(self._wait_scan())
        manager = self.manager_for()
        with self.assertRaisesRegex(ValueError, '이미 유효한'):
            manager.start()
        self.assertEqual(self.catalog.query('smile')['total'], 1)

    def test_invalid_archive_does_not_connect_catalog(self):
        bad_archive = _archive([(INDEX, self.index_bytes), ('../escape.webp', self.image_bytes)])
        manager = self.manager_for()
        with mock.patch.object(download_module, '_download', side_effect=self.download_stub(bad_archive)):
            manager.start()
            self.assertTrue(manager.wait(10))
        self.assertEqual(manager.status()['status'], 'failed')
        self.assertIsNone(self.catalog.status()['folder'])
        self.assertFalse((self.root.parent / 'escape.webp').exists())

    def test_extract_rejects_hash_corrupt_index_missing_entry_and_unprompted_webp(self):
        with _temporary_directory(prefix='daki-pack-extract-') as temporary:
            stage = Path(temporary)
            pack = {key: self.spec[key] for key in (
                'bytes', 'sha256', 'image_count', 'image_bytes', 'index_sha256',
            )}
            pack['index_sha256'] = '0' * 64
            archive_path = self.root / 'fixture.zip'
            archive_path.write_bytes(_fixture()[0])
            with self.assertRaisesRegex(ValueError, '색인 SHA-256'):
                download_module._extract_pack(archive_path, pack, stage, threading.Event(), lambda **kw: None)

            pack = {key: self.spec[key] for key in (
                'bytes', 'sha256', 'image_count', 'image_bytes', 'index_sha256',
            )}
            archive_path.write_bytes(_archive([(INDEX, self.index_bytes)]))
            with self.assertRaisesRegex(ValueError, '항목 수'):
                download_module._extract_pack(archive_path, pack, stage, threading.Event(), lambda **kw: None)

            empty_image = _webp(prompt=None)
            index = _index(empty_image)
            index_data = json.dumps(index, separators=(',', ':')).encode()
            archive_path.write_bytes(_archive([(INDEX, index_data), ('images/000123.webp', empty_image)]))
            pack.update(index_sha256=hashlib.sha256(index_data).hexdigest(),
                        image_bytes=len(empty_image), image_count=1)
            with self.assertRaisesRegex(ValueError, '프롬프트가 없습니다'):
                download_module._extract_pack(archive_path, pack, stage, threading.Event(), lambda **kw: None)

    def test_extract_rejects_corrupt_index_json_and_image_hash(self):
        _, spec, _, index_bytes, image_bytes = _fixture()
        with _temporary_directory(prefix='daki-pack-corrupt-') as temporary:
            root = Path(temporary)
            archive_path = root / 'fixture.zip'
            pack = {key: spec[key] for key in (
                'bytes', 'sha256', 'image_count', 'image_bytes', 'index_sha256',
            )}
            stage = root / 'stage-json'
            stage.mkdir()
            malformed_index = b'{"broken":'
            archive_path.write_bytes(_archive([
                (INDEX, malformed_index), ('images/000123.webp', image_bytes),
            ]))
            pack['index_sha256'] = hashlib.sha256(malformed_index).hexdigest()
            with self.assertRaisesRegex(ValueError, '색인 JSON'):
                download_module._extract_pack(archive_path, pack, stage, threading.Event(), lambda **kw: None)

            stage = root / 'stage-image'
            stage.mkdir()
            changed_image = image_bytes[:-1] + bytes([image_bytes[-1] ^ 1])
            archive_path.write_bytes(_archive([
                (INDEX, index_bytes), ('images/000123.webp', changed_image),
            ]))
            pack['index_sha256'] = hashlib.sha256(index_bytes).hexdigest()
            with self.assertRaisesRegex(ValueError, '이미지 SHA-256'):
                download_module._extract_pack(archive_path, pack, stage, threading.Event(), lambda **kw: None)

    @staticmethod
    def _write_local_png(path):
        from PIL.PngImagePlugin import PngInfo
        info = PngInfo()
        info.add_text('parameters', 'smile\nSteps: 20')
        Image.new('RGB', (12, 18), 'white').save(path, pnginfo=info)

    def _wait_scan(self):
        deadline = time.monotonic() + 5
        while self.catalog.status()['scanning']:
            if time.monotonic() > deadline:
                self.fail('catalog scan did not finish')
            time.sleep(0.01)
        return self.catalog.status()['error'] is None


if __name__ == '__main__':
    unittest.main()
