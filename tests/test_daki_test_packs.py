import copy
import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from flask import Flask
from PIL import Image

import naim.daki_test_packs as packs_module
from naim.daki_style_tests import DakiStyleTests
from naim.web.daki_test_packs import register_daki_test_pack_routes
from tests.test_daki_style_tests import synthetic_request, synthetic_styles, synthetic_upper_source


REVISION = '1' * 40
PACK_ID = 'a' * 32
PACK_NAME = 'Synthetic shared pack'


def _image_bytes(size, image_format, color):
    output = io.BytesIO()
    Image.new('RGB', size, color).save(output, format=image_format)
    return output.getvalue()


def _fixture_members(pack_id=PACK_ID, pack_name=PACK_NAME, count=1):
    styles = synthetic_styles(count)
    source = synthetic_upper_source(styles)
    request = source['request']
    now = '2026-10-25T00:00:00+00:00'
    batch = {
        'id': pack_id, 'name': pack_name, 'library': 'shared', 'status': 'completed',
        'created_at': now, 'updated_at': now, **copy.deepcopy(request), 'items': [],
    }
    members = [('batch.json', json.dumps(batch, ensure_ascii=False).encode('utf-8'))]
    for index, entry in enumerate(source['entries']):
        style_id = entry['style']['id']
        item = {
            'style_id': style_id, 'status': 'completed',
            'style': copy.deepcopy(entry['style']), 'output_format': 'png',
            'payload': copy.deepcopy(entry['payload']),
        }
        batch['items'].append(item)
        members.extend((
            (style_id + '.png', _image_bytes((64, 128), 'PNG', (20 + index, 80, 120))),
            (style_id + '.jpg', _image_bytes((32, 64), 'JPEG', (120, 80, 20))),
        ))
    members[0] = ('batch.json', json.dumps(batch, ensure_ascii=False).encode('utf-8'))
    return batch, members


def _zip_bytes(members, symlink_names=()):
    output = io.BytesIO()
    symlink_names = set(symlink_names)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in members:
            info = zipfile.ZipInfo(name)
            if name in symlink_names:
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(info, data)
    return output.getvalue()


def _pack_spec(pack_id, name, archive_bytes, expanded_bytes):
    return {
        'id': pack_id, 'name': name, 'filename': 'style_test_' + pack_id + '.zip',
        'bytes': len(archive_bytes), 'sha256': hashlib.sha256(archive_bytes).hexdigest(),
        'image_count': 1,
        'expanded_bytes': expanded_bytes,
        'revision': REVISION,
        'url': packs_module.HF_ARCHIVE_INFO_URL + REVISION + '/style_test_' + pack_id + '.zip?download=true',
    }


def _fixture(pack_id=PACK_ID, pack_name=PACK_NAME, count=1, *, members=None):
    batch, original_members = _fixture_members(pack_id, pack_name, count)
    members = original_members if members is None else members
    archive_bytes = _zip_bytes(members)
    expanded_bytes = sum(len(data) for _, data in members)
    spec = _pack_spec(pack_id, pack_name, archive_bytes, expanded_bytes)
    spec['image_count'] = count
    return batch, members, archive_bytes, spec


class DakiTestPacksTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'tests'
        self.catalog = mock.Mock()
        styles = synthetic_styles(8)
        self.catalog.list_styles.side_effect = lambda: copy.deepcopy(styles)
        self.catalog.get_style.side_effect = lambda style_id: copy.deepcopy(
            next(style for style in styles if style['id'] == style_id))
        self.generator = mock.Mock(side_effect=AssertionError('shared packs must not generate images'))
        self.tests = DakiStyleTests(lambda: self.root, self.catalog,
                                    lambda: (_ for _ in ()).throw(AssertionError('API key requested')),
                                    self.generator)

    def manager(self, specs):
        frozen = copy.deepcopy(specs)
        return packs_module.DakiTestPacks(
            self.tests, catalog_provider=lambda stop_event=None: copy.deepcopy(frozen))

    def download_stub(self, archives):
        def download(target, spec, stop_event, progress, **kwargs):
            target.write_bytes(archives[spec['id']])
            return True
        return download

    def start_and_wait(self, manager, pack_ids, archives):
        with mock.patch.object(packs_module, '_download', side_effect=self.download_stub(archives)):
            manager.start({'pack_ids': pack_ids})
            self.assertTrue(manager.wait(5), 'pack import worker did not finish')
        return manager.status()

    def test_import_is_an_editable_ordinary_test_and_never_generates(self):
        batch, _, archive_bytes, spec = _fixture(count=2)
        manager = self.manager([spec])
        status = self.start_and_wait(manager, [spec['id']], {spec['id']: archive_bytes})

        self.assertEqual(status['status'], 'completed')
        self.assertEqual((status['installed'], status['skipped']), (1, 0))
        full = self.root / batch['id'] / 'style-0.png'
        thumb = self.root / batch['id'] / 'style-0.jpg'
        self.assertTrue(full.is_file())
        self.assertTrue(thumb.is_file())
        with Image.open(full) as image:
            self.assertEqual((image.format, image.size), ('PNG', (64, 128)))
        with Image.open(thumb) as image:
            self.assertEqual((image.format, image.size), ('JPEG', (32, 64)))

        imported = self.tests.get(batch['id'])
        self.assertEqual(imported['status'], 'completed')
        self.assertEqual(imported['items'][0]['src'],
                         f'/api/daki/style-tests/{batch["id"]}/images/style-0')
        self.tests.rename(batch['id'], 'My editable copy')
        self.tests.append_styles(batch['id'], ['style-2'])
        before_settings = self.tests.get(batch['id'])
        completed_payload = copy.deepcopy(before_settings['items'][0])
        saved_path = self.root / batch['id'] / 'batch.json'
        saved_before = json.loads(saved_path.read_text(encoding='utf-8'))
        completed_snapshot = copy.deepcopy(saved_before['items'][0])
        self.tests.update_settings(batch['id'], synthetic_request(prompt='edited common prompt'))
        after_settings = self.tests.get(batch['id'])
        saved_after = json.loads(saved_path.read_text(encoding='utf-8'))
        self.assertEqual(after_settings['name'], 'My editable copy')
        self.assertEqual(after_settings['prompt'], 'edited common prompt')
        self.assertEqual(after_settings['completed'], 2)
        self.assertEqual(after_settings['pending'], 1)
        self.assertEqual(after_settings['items'][0]['seed'], completed_payload['seed'])
        self.assertEqual(after_settings['items'][0]['width'], completed_payload['width'])
        self.assertEqual(after_settings['items'][0]['height'], completed_payload['height'])
        self.assertEqual(saved_after['items'][0], completed_snapshot)
        self.generator.assert_not_called()

    def test_existing_local_batch_is_skipped_byte_for_byte(self):
        batch, _, archive_bytes, spec = _fixture()
        manager = self.manager([spec])
        self.assertEqual(self.start_and_wait(manager, [spec['id']], {spec['id']: archive_bytes})['status'], 'completed')
        self.tests.rename(batch['id'], 'Locally renamed')
        path = self.root / batch['id'] / 'batch.json'
        saved = json.loads(path.read_text(encoding='utf-8'))
        saved['user_note'] = 'local-only synthetic value'
        path.write_text(json.dumps(saved, ensure_ascii=False), encoding='utf-8')
        before = path.read_bytes()

        status = self.start_and_wait(manager, [spec['id']], {spec['id']: archive_bytes})

        self.assertEqual(status['status'], 'completed')
        self.assertEqual((status['installed'], status['skipped']), (0, 1))
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.tests.get(batch['id'])['name'], 'Locally renamed')

    def test_shared_pack_preserves_explicitly_published_personal_style_snapshot(self):
        batch, members = _fixture_members()
        sid = 'personal_' + 'b' * 32
        batch['items'][0]['style_id'] = sid
        batch['items'][0]['style']['id'] = sid
        members = [('batch.json', json.dumps(batch).encode())] + [
            (name.replace('style-0', sid), content) for name, content in members[1:]]
        archive = _zip_bytes(members)
        spec = _pack_spec(PACK_ID, PACK_NAME, archive, sum(len(content) for _, content in members))
        manager = self.manager([spec])
        status = self.start_and_wait(manager, [PACK_ID], {PACK_ID: archive})
        self.assertEqual(status['status'], 'completed')
        loaded = self.tests.get(PACK_ID)
        self.assertEqual(loaded['items'][0]['style_id'], sid)
        self.assertIsNone(loaded['items'][0]['source_src'])
        stored = json.loads((self.root / PACK_ID / 'batch.json').read_text(encoding='utf-8'))
        self.assertEqual(stored['items'][0]['payload'], batch['items'][0]['payload'])
        self.assertTrue(self.tests.image_path(PACK_ID, sid, full=True).is_file())
        self.generator.assert_not_called()

    def test_manifest_and_batch_reject_malformed_snapshots(self):
        _, _, _, spec = _fixture()
        valid_manifest = {'format': packs_module.FORMAT, 'version': 1,
                          'packs': [{key: spec[key] for key in
                                     ('id', 'name', 'filename', 'bytes', 'sha256', 'image_count', 'expanded_bytes')}]}
        self.assertEqual(packs_module.validate_manifest(valid_manifest)[0]['id'], PACK_ID)
        bad_manifests = []
        duplicate = copy.deepcopy(valid_manifest)
        duplicate['packs'].append(copy.deepcopy(duplicate['packs'][0]))
        bad_manifests.append(duplicate)
        for field, value in (('id', '../' + PACK_ID), ('filename', 'elsewhere.zip'),
                             ('sha256', 'A' * 64), ('bytes', True),
                             ('expanded_bytes', 0), ('image_count', 1.0)):
            malformed = copy.deepcopy(valid_manifest)
            malformed['packs'][0][field] = value
            bad_manifests.append(malformed)
        for malformed in bad_manifests:
            with self.subTest(manifest=malformed):
                with self.assertRaises(ValueError):
                    packs_module.validate_manifest(malformed)

        batch, _, _, spec = _fixture(count=2)
        for mutate in (
                lambda value: value['items'][1].update(style_id=value['items'][0]['style_id']),
                lambda value: value['items'][0].update(style_id='../invalid'),
                lambda value: value['items'][0].update(status='failed'),
                lambda value: value['items'][0].update(legacy_preview=True),
                lambda value: value['items'][0]['payload']['parameters'].update(width=65),
                lambda value: value['items'][0]['payload']['parameters'].update(steps=True),
                lambda value: value.update(status='ready'),
        ):
            malformed = copy.deepcopy(batch)
            mutate(malformed)
            with self.subTest(batch=malformed):
                with self.assertRaises(ValueError):
                    packs_module.validate_batch(malformed, spec)
        casefold_duplicate = copy.deepcopy(batch)
        casefold_duplicate['items'][1]['style_id'] = 'STYLE-0'
        casefold_duplicate['items'][1]['style']['id'] = 'STYLE-0'
        with self.assertRaises(ValueError):
            packs_module.validate_batch(casefold_duplicate, spec)

    def test_latest_catalog_pins_manifest_and_archive_and_checks_lfs(self):
        _, _, _, spec = _fixture()
        manifest = {'format': packs_module.FORMAT, 'version': 1,
                    'packs': [{key: spec[key] for key in
                               ('id', 'name', 'filename', 'bytes', 'sha256', 'image_count', 'expanded_bytes')}]}
        revision_doc = {'sha': REVISION, 'siblings': [
            {'rfilename': packs_module.MANIFEST},
            {'rfilename': spec['filename'], 'size': spec['bytes'],
             'lfs': {'size': spec['bytes'], 'sha256': spec['sha256']}},
        ]}
        session = mock.MagicMock()
        session.__enter__.return_value = session
        session.trust_env = True
        with mock.patch.object(packs_module.requests, 'Session', return_value=session), \
                mock.patch.object(packs_module, '_read_metadata',
                                  side_effect=[json.dumps(revision_doc).encode(), json.dumps(manifest).encode()]) as read:
            result = packs_module.latest_packs()
        self.assertFalse(session.trust_env)
        self.assertEqual(result[0]['revision'], REVISION)
        self.assertEqual(result[0]['url'], packs_module.HF_ARCHIVE_INFO_URL + REVISION + '/' + spec['filename'] + '?download=true')
        self.assertEqual(read.call_args_list[0].args[1], packs_module.HF_REVISION_API_URL)
        self.assertEqual(read.call_args_list[1].args[1], packs_module.HF_ARCHIVE_INFO_URL + REVISION + '/' + packs_module.MANIFEST)

        for mismatch in ('size', 'lfs size', 'lfs sha256'):
            bad_revision = copy.deepcopy(revision_doc)
            if mismatch == 'size':
                bad_revision['siblings'][1]['size'] += 1
            elif mismatch == 'lfs size':
                bad_revision['siblings'][1]['lfs']['size'] += 1
            else:
                bad_revision['siblings'][1]['lfs']['sha256'] = '0' * 64
            with self.subTest(mismatch=mismatch), \
                    mock.patch.object(packs_module.requests, 'Session', return_value=session), \
                    mock.patch.object(packs_module, '_read_metadata',
                                      side_effect=[json.dumps(bad_revision).encode(), json.dumps(manifest).encode()]):
                with self.assertRaises(ValueError):
                    packs_module.latest_packs()

    def test_bad_archives_fail_without_publishing_or_leaving_staging(self):
        batch, members = _fixture_members()
        png = _image_bytes((128, 64), 'PNG', (4, 5, 6))
        invalid_archives = {
            'traversal': [(('../escape.jpg' if name == 'style-0.jpg' else name), data) for name, data in members],
            'duplicate case': [(('BATCH.JSON' if name == 'style-0.jpg' else name), data) for name, data in members],
            'extra member': members[:-1] + [('extra.txt', members[-1][1])],
            'missing file': members[:-1],
            'symlink': members,
            'wrong dimensions': [(name, png if name == 'style-0.png' else data) for name, data in members],
            'HTML image': [(name, b'<html>not an image</html>' if name == 'style-0.png' else data) for name, data in members],
        }
        for label, invalid_members in invalid_archives.items():
            with self.subTest(archive=label):
                archive_bytes = _zip_bytes(invalid_members, {'style-0.jpg'} if label == 'symlink' else ())
                spec = _pack_spec(PACK_ID, PACK_NAME, archive_bytes,
                                  sum(len(data) for _, data in invalid_members))
                manager = self.manager([spec])
                status = self.start_and_wait(manager, [PACK_ID], {PACK_ID: archive_bytes})
                self.assertEqual(status['status'], 'failed')
                self.assertFalse((self.root / PACK_ID).exists())
                self.assertEqual(list((self.root / '.packs').glob('install-*')), [])

        _, _, valid_archive, spec = _fixture()
        spec['expanded_bytes'] += 1
        manager = self.manager([spec])
        status = self.start_and_wait(manager, [PACK_ID], {PACK_ID: valid_archive})
        self.assertEqual(status['status'], 'failed')
        self.assertFalse((self.root / PACK_ID).exists())
        self.assertEqual(list((self.root / '.packs').glob('install-*')), [])

        non_zip = b'not a zip'
        spec = _pack_spec(PACK_ID, PACK_NAME, non_zip, len(non_zip))
        manager = self.manager([spec])
        status = self.start_and_wait(manager, [PACK_ID], {PACK_ID: non_zip})
        self.assertEqual(status['status'], 'failed')
        self.assertFalse((self.root / PACK_ID).exists())
        self.assertEqual(list((self.root / '.packs').glob('install-*')), [])

    def test_corrupt_cached_sha_fails_then_retry_downloads_cleanly(self):
        batch, _, archive_bytes, spec = _fixture()
        manager = self.manager([spec])
        cache = self.root / '.packs'
        cache.mkdir(parents=True)
        cached = cache / (spec['sha256'] + '.zip')
        corrupt = bytearray(archive_bytes)
        corrupt[-1] ^= 1
        cached.write_bytes(corrupt)

        manager.start({'pack_ids': [PACK_ID]})
        self.assertTrue(manager.wait(5))
        self.assertEqual(manager.status()['status'], 'failed')
        self.assertFalse(cached.exists())
        self.assertFalse((self.root / PACK_ID).exists())

        with mock.patch.object(packs_module, '_download', side_effect=self.download_stub({PACK_ID: archive_bytes})):
            manager.start({'pack_ids': [PACK_ID]})
            self.assertTrue(manager.wait(5))
        self.assertEqual(manager.status()['status'], 'completed')
        self.assertTrue((self.root / batch['id'] / 'style-0.png').is_file())

    def test_duplicate_start_and_cancellation_at_resolution_download_and_extract(self):
        _, _, archive_bytes, spec = _fixture()
        entered, release = threading.Event(), threading.Event()

        def blocked_catalog(stop_event=None):
            entered.set()
            release.wait(5)
            return [copy.deepcopy(spec)]

        resolving = packs_module.DakiTestPacks(self.tests, catalog_provider=blocked_catalog)
        resolving.start({'pack_ids': [PACK_ID]})
        self.assertTrue(entered.wait(2))
        with self.assertRaises(ValueError):
            resolving.start({'pack_ids': [PACK_ID]})
        resolving.stop()
        release.set()
        self.assertTrue(resolving.wait(5))
        self.assertEqual(resolving.status()['status'], 'stopped')
        self.assertFalse((self.root / PACK_ID).exists())

        downloading = self.manager([spec])
        download_entered = threading.Event()

        def blocked_download(target, pack, stop_event, progress, **kwargs):
            download_entered.set()
            self.assertTrue(stop_event.wait(5))
            return False

        with mock.patch.object(packs_module, '_download', side_effect=blocked_download):
            downloading.start({'pack_ids': [PACK_ID]})
            self.assertTrue(download_entered.wait(2))
            downloading.stop()
            self.assertTrue(downloading.wait(5))
        self.assertEqual(downloading.status()['status'], 'stopped')
        self.assertFalse((self.root / PACK_ID).exists())

        extracting = self.manager([spec])
        original_extract = packs_module.extract_pack
        stop_requested = threading.Event()

        def extract_then_stop(archive_path, pack, staging, stop_event=None, progress=None):
            def progress_and_stop(**changes):
                progress(**changes)
                if changes.get('phase') == 'extract' and not stop_requested.is_set():
                    stop_requested.set()
                    extracting.stop()
            return original_extract(archive_path, pack, staging, stop_event, progress_and_stop)

        with mock.patch.object(packs_module, '_download', side_effect=self.download_stub({PACK_ID: archive_bytes})), \
                mock.patch.object(packs_module, 'extract_pack', side_effect=extract_then_stop):
            extracting.start({'pack_ids': [PACK_ID]})
            self.assertTrue(extracting.wait(5))
        self.assertTrue(stop_requested.is_set())
        self.assertEqual(extracting.status()['status'], 'stopped')
        self.assertFalse((self.root / PACK_ID).exists())
        self.assertEqual(list((self.root / '.packs').glob('install-*')), [])

    def test_later_pack_failure_preserves_prior_install_and_retry_skips_it(self):
        first_batch, _, first_bytes, first = _fixture(pack_id='a' * 32, pack_name='First')
        _, _, second_bytes, second = _fixture(pack_id='b' * 32, pack_name='Second')
        manager = self.manager([first, second])
        attempts = 0

        def fail_second_once(target, spec, stop_event, progress, **kwargs):
            nonlocal attempts
            if spec['id'] == second['id'] and attempts == 0:
                attempts += 1
                raise ValueError('synthetic second-pack failure')
            target.write_bytes({first['id']: first_bytes, second['id']: second_bytes}[spec['id']])
            return True

        with mock.patch.object(packs_module, '_download', side_effect=fail_second_once):
            manager.start({'pack_ids': [first['id'], second['id']]})
            self.assertTrue(manager.wait(5))
        self.assertEqual(manager.status()['status'], 'failed')
        first_path = self.root / first['id'] / 'batch.json'
        first_before = first_path.read_bytes()
        self.assertTrue((self.root / first['id'] / 'style-0.png').is_file())
        self.assertFalse((self.root / second['id']).exists())

        with mock.patch.object(packs_module, '_download', side_effect=fail_second_once):
            manager.start({'pack_ids': [first['id'], second['id']]})
            self.assertTrue(manager.wait(5))
        self.assertEqual(manager.status()['status'], 'completed')
        self.assertEqual((manager.status()['installed'], manager.status()['skipped']), (1, 1))
        self.assertEqual(first_path.read_bytes(), first_before)
        self.assertTrue((self.root / second['id'] / 'style-0.png').is_file())

    def test_start_input_and_shutdown(self):
        _, _, _, spec = _fixture()
        manager = self.manager([spec])
        for value in (None, {}, {'pack_ids': []}, {'pack_ids': [PACK_ID, PACK_ID]},
                      {'pack_ids': ['../invalid']}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                manager.start(value)

        entered = threading.Event()

        def wait_for_stop(stop_event=None):
            entered.set()
            stop_event.wait(5)
            return [copy.deepcopy(spec)]

        stopping = packs_module.DakiTestPacks(self.tests, catalog_provider=wait_for_stop)
        stopping.start({'pack_ids': [PACK_ID]})
        self.assertTrue(entered.wait(2))
        self.assertTrue(stopping.shutdown())
        self.assertEqual(stopping.status()['status'], 'stopped')
        self.assertFalse((self.root / PACK_ID).exists())

    def test_routes_cover_catalog_validation_jobs_failures_and_stop(self):
        _, _, archive_bytes, spec = _fixture()
        manager = self.manager([spec])
        app = Flask(__name__)
        with mock.patch('naim.web.daki_test_packs.DakiTestPacks', return_value=manager):
            routed = register_daki_test_pack_routes(app, self.tests)
        client = app.test_client()

        catalog = client.get('/api/daki/style-test-packs')
        self.assertEqual(catalog.status_code, 200)
        self.assertFalse(catalog.json['packs'][0]['installed'])
        self.assertIsNone(catalog.json['job'])
        for payload in ({}, {'pack_ids': [PACK_ID, PACK_ID]}):
            with self.subTest(payload=payload):
                self.assertEqual(client.post('/api/daki/style-test-packs', json=payload).status_code, 400)

        with mock.patch.object(packs_module, '_download', side_effect=self.download_stub({PACK_ID: archive_bytes})):
            started = client.post('/api/daki/style-test-packs', json={'pack_ids': [PACK_ID]})
            self.assertEqual(started.status_code, 200)
            self.assertTrue(routed.wait(5))
        job = client.get('/api/daki/style-test-packs/job')
        self.assertEqual(job.status_code, 200)
        self.assertEqual(job.json['job']['status'], 'completed')

        missing_id = 'b' * 32
        self.assertEqual(client.post('/api/daki/style-test-packs', json={'pack_ids': [missing_id]}).status_code, 200)
        self.assertTrue(routed.wait(5))
        self.assertEqual(client.get('/api/daki/style-test-packs/job').json['job']['status'], 'failed')

        entered = threading.Event()
        release = threading.Event()

        def blocking_catalog(stop_event=None):
            entered.set()
            release.wait(5)
            return [copy.deepcopy(spec)]

        stopping = packs_module.DakiTestPacks(self.tests, catalog_provider=blocking_catalog)
        stop_app = Flask('stop-route')
        with mock.patch('naim.web.daki_test_packs.DakiTestPacks', return_value=stopping):
            register_daki_test_pack_routes(stop_app, self.tests)
        stop_client = stop_app.test_client()
        self.assertEqual(stop_client.post('/api/daki/style-test-packs', json={'pack_ids': [PACK_ID]}).status_code, 200)
        self.assertTrue(entered.wait(2))
        stopped = stop_client.post('/api/daki/style-test-packs/stop')
        self.assertEqual(stopped.status_code, 200)
        self.assertEqual(stopped.json['job']['status'], 'stopping')
        release.set()
        self.assertTrue(stopping.wait(5))
        self.assertEqual(stop_client.get('/api/daki/style-test-packs/job').json['job']['status'], 'stopped')


if __name__ == '__main__':
    unittest.main()
