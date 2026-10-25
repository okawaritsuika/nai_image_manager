import hashlib
import io
import json
from pathlib import Path
import sqlite3
import stat
import tempfile
import threading
import unittest
from unittest import mock
import zipfile

from naim import daki_style_archive as archive


def pack(change=None, extra=None, image=b'synthetic-image-bytes', sources=None):
    if sources is None:
        sources = [('https://arca.live/b/aiart/123', image)]
        identities = ['https://ac.namu.la/synthetic.webp']
    else:
        identities = [f'https://ac.namu.la/synthetic-{index}.webp'
                      for index in range(len(sources))]
    files = []
    total_bytes = 0
    for index, ((source, image_data), identity) in enumerate(zip(sources, identities), 1):
        name = hashlib.sha256((source + '\n' + identity).encode()).hexdigest() + '.webp'
        files.append({'name': name, 'source_url': source, 'image_identity': identity,
                      'image_id': index, 'item_id': index, 'bytes': len(image_data),
                      'sha256': hashlib.sha256(image_data).hexdigest()})
        total_bytes += len(image_data)
    manifest = {'format': archive.FORMAT, 'version': 2, 'files': files,
                'file_count': len(files), 'total_bytes': total_bytes}
    if change:
        change(manifest)
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as zipped:
        for entry, (source, image_data), identity in zip(files, sources, identities):
            zipped.writestr('arca_style_images/' + entry['name'], image_data)
        zipped.writestr('manifest.json', json.dumps(manifest))
        if extra:
            zipped.writestr(*extra)
    data = output.getvalue()
    return data, {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
                  'image_count': len(files), 'image_bytes': total_bytes}


def response(data, status=200, headers=None):
    result = mock.MagicMock()
    result.status_code = status
    result.headers = headers or {}
    result.iter_content.return_value = iter([data])
    result.__enter__.return_value = result
    return result


def latest_metadata(spec, revision='a' * 40, filename='NAImakeArtistGroup_shared_images_20261024_webp.zip',
                    seed=None):
    info = {'filename': filename, 'bytes': spec['bytes'], 'sha256': spec['sha256'],
            'image_count': spec['image_count'], 'image_bytes': spec['image_bytes']}
    sibling = {'rfilename': filename, 'size': spec['bytes'],
               'lfs': {'sha256': spec['sha256'], 'size': spec['bytes'], 'pointerSize': 128}}
    siblings = [sibling]
    if seed is not None:
        seed_digest = hashlib.sha256(seed).hexdigest()
        info['seed_sha256'] = seed_digest
        siblings.append({'rfilename': archive.RECOMMENDATION_SEED_FILENAME, 'size': len(seed),
                         'lfs': {'sha256': seed_digest, 'size': len(seed), 'pointerSize': 128}})
    revision_info = {'sha': revision, 'siblings': siblings}
    return (json.dumps(revision_info).encode(), json.dumps(info).encode(),
            revision_info, info)


def seed_database(path, rows):
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            'CREATE TABLE arca_style_items '
            '(source_url TEXT NOT NULL UNIQUE, recommendation_count INTEGER)'
        )
        connection.executemany(
            'INSERT INTO arca_style_items(source_url, recommendation_count) VALUES (?, ?)', rows
        )
        connection.commit()
    finally:
        connection.close()
    return Path(path).read_bytes()


def seed_spec(data, revision='a' * 40):
    return {'filename': archive.RECOMMENDATION_SEED_FILENAME,
            'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
            'url': archive.HF_ARCHIVE_INFO_URL + revision + '/'
                   + archive.RECOMMENDATION_SEED_FILENAME + '?download=true'}


class DakiStyleArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data, self.spec = pack()
        self.events = []
        self.session = mock.MagicMock()
        self.session.__enter__.return_value = self.session
        self.session.get.return_value = response(self.data)
        patcher = mock.patch.object(archive.requests, 'Session', return_value=self.session)
        patcher.start()
        self.addCleanup(patcher.stop)

    def images(self, stop=None):
        return list(archive.iter_archive_images(self.root, stop, lambda **event: self.events.append(event),
                                               expected=self.spec))

    def cache(self, data=None):
        (self.root / archive.ARCHIVE_FILENAME).write_bytes(self.data if data is None else data)

    def test_download_then_reuse_valid_cache(self):
        images = self.images()
        self.assertEqual(images[0]['source_url'], 'https://arca.live/b/aiart/123')
        self.assertEqual(images[0]['title'], '공유 그림체 · #123')
        self.assertEqual(images[0]['image_bytes'], b'synthetic-image-bytes')
        self.assertIsNone(images[0]['recommendation_count'])
        self.assertFalse(self.session.trust_env)
        self.assertEqual(len(self.images()), 1)
        self.assertEqual(self.session.get.call_count, 1)
        self.assertEqual(self.events[-1]['downloaded_images'], 1)
        self.assertEqual(self.events[-1]['scanned_posts'], 1)
        self.assertEqual(self.events[-1]['downloaded_bytes'], self.spec['bytes'])

    def test_download_verify_and_inspect_progress_reports_actual_pack_work(self):
        sources = [('https://arca.live/b/aiart/123', b'first-image'),
                   ('https://arca.live/b/aiart/124', b'second-image'),
                   ('https://arca.live/b/aiart/125', b'third-image')]
        self.data, self.spec = pack(sources=sources)
        seed = seed_database(self.root / 'source.sqlite', [
            (source, index) for index, (source, _) in enumerate(sources)
        ])
        self.spec['recommendation_seed'] = seed_spec(seed)
        archive_response = response(self.data)
        archive_response.iter_content.side_effect = lambda size: iter(
            self.data[index:index + size] for index in range(0, len(self.data), size))
        seed_response = response(seed)
        seed_response.iter_content.side_effect = lambda size: iter(
            seed[index:index + size] for index in range(0, len(seed), size))
        self.session.get.side_effect = [archive_response, seed_response]

        with mock.patch.object(archive, 'CHUNK_BYTES', 32):
            images = list(archive.iter_archive_images(
                self.root, expected=self.spec, include_recommendations=True,
                progress=lambda **event: self.events.append(event)))

        self.assertEqual(len(images), 3)
        self.assertEqual([item['recommendation_count'] for item in images], [0, 1, 2])
        for phase, total in (('download', self.spec['bytes']),
                             ('verify', self.spec['bytes']),
                             ('recommendation_download', len(seed)),
                             ('recommendation_verify', len(seed))):
            with self.subTest(phase=phase):
                events = [event for event in self.events if event.get('phase') == phase]
                self.assertGreater(len(events), 2)
                self.assertEqual(events[0]['phase_current'], 0)
                self.assertEqual(events[0]['phase_total'], total)
                self.assertEqual(events[-1]['phase_current'], total)
                self.assertEqual(events[-1]['phase_total'], total)
                self.assertTrue(all(0 <= event['phase_current'] <= total for event in events))

        inspect = [event for event in self.events if event.get('phase') == 'inspect']
        self.assertEqual(len(inspect), 1)
        self.assertEqual(inspect[0]['total_images'], 3)
        self.assertEqual(self.session.get.call_count, 2)

    def test_cached_archive_verification_progress_starts_at_zero_without_download(self):
        self.cache()

        images = self.images()

        verify = [event for event in self.events if event.get('phase') == 'verify']
        self.assertEqual(len(images), 1)
        self.assertGreater(len(verify), 1)
        self.assertEqual(verify[0]['phase_current'], 0)
        self.assertEqual(verify[0]['phase_total'], self.spec['bytes'])
        self.assertEqual(verify[-1]['phase_current'], self.spec['bytes'])
        self.assertFalse(any(event.get('phase') == 'download' for event in self.events))
        self.session.get.assert_not_called()

    def test_partial_download_resumes_with_verified_range(self):
        (self.root / (archive.ARCHIVE_FILENAME + '.partial')).write_bytes(self.data[:20])
        self.session.get.return_value = response(self.data[20:], 206, {
            'Content-Range': f'bytes 20-{len(self.data) - 1}/{len(self.data)}',
            'Content-Length': str(len(self.data) - 20),
        })
        self.assertEqual(len(self.images()), 1)
        self.assertEqual(self.session.get.call_args.kwargs['headers'], {'Range': 'bytes=20-', 'Accept-Encoding': 'identity'})

    def test_server_ignoring_range_replaces_partial(self):
        (self.root / (archive.ARCHIVE_FILENAME + '.partial')).write_bytes(b'incorrect partial')
        self.assertEqual(len(self.images()), 1)
        self.assertEqual((self.root / archive.ARCHIVE_FILENAME).read_bytes(), self.data)

    def test_wrong_range_rejected_without_changing_partial(self):
        partial = self.root / (archive.ARCHIVE_FILENAME + '.partial')
        partial.write_bytes(self.data[:20])
        self.session.get.return_value = response(self.data, 206, {'Content-Range': 'bytes 0-1/2'})
        with self.assertRaises(archive.DakiStyleArchiveError):
            self.images()
        self.assertEqual(partial.read_bytes(), self.data[:20])

    def test_oversized_response_never_written(self):
        self.session.get.return_value = response(self.data + b'overflow')
        with self.assertRaises(archive.DakiStyleArchiveError):
            self.images()
        self.assertEqual((self.root / (archive.ARCHIVE_FILENAME + '.partial')).stat().st_size, 0)

    def test_short_response_keeps_partial_for_retry(self):
        self.session.get.return_value = response(self.data[:20])
        with self.assertRaises(archive.DakiStyleArchiveError):
            self.images()
        self.assertEqual((self.root / (archive.ARCHIVE_FILENAME + '.partial')).read_bytes(), self.data[:20])

    def test_bad_sha_removes_invalid_cache_and_yields_nothing(self):
        self.cache(b'x' * len(self.data))
        with self.assertRaises(archive.DakiStyleArchiveError):
            self.images()
        self.assertFalse((self.root / archive.ARCHIVE_FILENAME).exists())

    def test_stop_during_download_keeps_valid_prefix(self):
        stop = threading.Event()
        def chunks(_):
            yield self.data[:20]
            stop.set()
            yield self.data[20:]
        self.session.get.return_value.iter_content.side_effect = chunks
        self.assertEqual(self.images(stop), [])
        self.assertEqual((self.root / (archive.ARCHIVE_FILENAME + '.partial')).stat().st_size, 20)

    def test_stop_before_start_does_not_access_network(self):
        stop = threading.Event()
        stop.set()
        self.assertEqual(self.images(stop), [])
        self.session.get.assert_not_called()

    def test_manifest_rejects_incorrect_identity_hash_count_and_version(self):
        for change in (
                lambda value: value.update(version=1),
                lambda value: value.update(file_count=2),
                lambda value: value['files'][0].update(name='../image.webp'),
                lambda value: value['files'][0].update(source_url='https://example.org/123'),
                lambda value: value['files'][0].update(bytes=100),
                lambda value: value['files'][0].update(sha256='0' * 64)):
            with self.subTest(change=change):
                self.data, self.spec = pack(change)
                self.cache()
                with self.assertRaises(archive.DakiStyleArchiveError):
                    self.images()

    def test_path_traversal_and_symlink_entries_rejected(self):
        symbolic = zipfile.ZipInfo('symlink')
        symbolic.create_system = 3
        symbolic.external_attr = (stat.S_IFLNK | 0o777) << 16
        for extra in (('../escape', b'x'), (symbolic, b'target')):
            with self.subTest(extra=extra[0]):
                self.data, self.spec = pack(extra=extra)
                self.cache()
                with self.assertRaises(archive.DakiStyleArchiveError):
                    self.images()
        self.assertFalse((self.root.parent / 'escape').exists())

    def test_manifest_size_cap_applies_before_read(self):
        self.cache()
        with mock.patch.object(archive, 'MAX_MANIFEST_BYTES', 1):
            with self.assertRaises(archive.DakiStyleArchiveError):
                self.images()

    def test_network_error_hides_signed_url(self):
        self.session.get.side_effect = archive.requests.ConnectionError('secret-key=never-display')
        with self.assertRaises(archive.DakiStyleArchiveError) as caught:
            self.images()
        self.assertNotIn('secret', str(caught.exception))

    def test_redirect_is_restricted_to_https_huggingface_hosts(self):
        self.session.get.return_value = response(b'', 302, {'Location': 'https://example.org/private'})
        with self.assertRaises(archive.DakiStyleArchiveError):
            self.images()
        self.assertEqual(self.session.get.call_count, 1)

    def test_allowed_cdn_redirect_keeps_range(self):
        self.session.get.side_effect = [response(b'', 302, {'Location': 'https://cas-bridge.xethub.hf.co/file'}),
                                        response(self.data)]
        self.assertEqual(len(self.images()), 1)
        self.assertEqual(self.session.get.call_count, 2)

    def test_latest_archive_download_uses_revision_pinned_metadata_and_zip(self):
        revision = 'b' * 40
        api_data, info_data, _, _ = latest_metadata(self.spec, revision)
        # The API's main branch may move after this response. Both subsequent
        # requests must still use the SHA returned by the initial snapshot.
        self.session.get.side_effect = [response(api_data), response(info_data), response(self.data)]
        events = []
        images = list(archive.iter_archive_images(
            self.root / 'production', progress=lambda **event: events.append(event)))
        self.assertEqual(images[0]['image_bytes'], b'synthetic-image-bytes')
        calls = self.session.get.call_args_list
        self.assertEqual(calls[0].args[0], archive.HF_REVISION_API_URL)
        self.assertIn(f'/resolve/{revision}/archive_info.json', calls[1].args[0])
        self.assertEqual(calls[2].args[0],
                         archive.HF_ARCHIVE_INFO_URL + revision + '/'
                         'NAImakeArtistGroup_shared_images_20261024_webp.zip?download=true')
        self.assertTrue((self.root / 'production' / self.spec['sha256'] /
                         'NAImakeArtistGroup_shared_images_20261024_webp.zip').is_file())
        self.assertFalse(self.session.trust_env)
        discovery = [event for event in events if 'archive_revision' in event]
        self.assertEqual(discovery, [{'archive_revision': revision,
                                      'archive_filename': 'NAImakeArtistGroup_shared_images_20261024_webp.zip',
                                      'archive_sha256': self.spec['sha256'],
                                      'total_images': self.spec['image_count']}])
        self.assertEqual(events[0]['message'], '최신 버전 확인 중')

    def test_latest_archive_rejects_invalid_metadata_before_zip_request(self):
        cases = (
            ('revision', lambda api, info: api.update(sha='B' * 40)),
            ('filename', lambda api, info: info.update(filename='../unsafe.zip')),
            ('hash', lambda api, info: info.update(sha256='g' * 64)),
            ('size', lambda api, info: info.update(bytes=True)),
            ('image count', lambda api, info: info.update(image_count=True)),
            ('image bytes', lambda api, info: info.update(image_bytes=archive.MAX_IMAGE_BYTES + 1)),
            ('lfs hash', lambda api, info: api['siblings'][0]['lfs'].update(sha256='0' * 64)),
            ('lfs size', lambda api, info: api['siblings'][0]['lfs'].update(size=info['bytes'] + 1)),
        )
        for label, mutate in cases:
            with self.subTest(label=label):
                _, _, api_doc, info_doc = latest_metadata(self.spec)
                mutate(api_doc, info_doc)
                self.session.get.reset_mock()
                self.session.get.side_effect = [response(json.dumps(api_doc).encode()),
                                                response(json.dumps(info_doc).encode())]
                with self.assertRaises(archive.DakiStyleArchiveError):
                    list(archive.iter_archive_images(self.root / ('bad-' + label)))
                self.assertFalse(any('.zip?download=true' in call.args[0]
                                     for call in self.session.get.call_args_list))

    def test_latest_archive_bounds_metadata_and_sanitizes_network_errors(self):
        oversized = response(b'x' * (archive.MAX_METADATA_BYTES + 1))
        self.session.get.return_value = oversized
        with self.assertRaises(archive.DakiStyleArchiveError) as caught:
            archive.latest_archive_spec()
        self.assertIn('허용 크기', str(caught.exception))

        self.session.get.side_effect = archive.requests.ConnectionError('token=private-marker')
        with self.assertRaises(archive.DakiStyleArchiveError) as caught:
            archive.latest_archive_spec()
        self.assertNotIn('private-marker', str(caught.exception))

    def test_cancelled_metadata_discovery_does_not_create_cache_or_request_zip(self):
        stop = threading.Event()
        api_data, _, _, _ = latest_metadata(self.spec)
        api_response = response(api_data)

        def stop_while_reading(_):
            stop.set()
            yield api_data

        api_response.iter_content.side_effect = stop_while_reading
        self.session.get.side_effect = [api_response]
        production_root = self.root / 'production'
        self.assertEqual(list(archive.iter_archive_images(production_root, stop)), [])
        self.assertFalse(production_root.exists())
        self.assertEqual(self.session.get.call_count, 1)

    def test_production_cache_is_separated_by_content_hash_and_rechecked(self):
        production_root = self.root / 'production'
        filename = 'NAImakeArtistGroup_shared_images_20261024_webp.zip'
        revision_one = '1' * 40
        api_one, info_one, _, _ = latest_metadata(self.spec, revision_one, filename)
        self.session.get.side_effect = [response(api_one), response(info_one), response(self.data)]
        self.assertEqual(len(list(archive.iter_archive_images(production_root))), 1)
        first_cache = production_root / self.spec['sha256'] / filename
        self.assertTrue(first_cache.is_file())

        self.session.get.reset_mock()
        self.session.get.side_effect = [response(api_one), response(info_one)]
        self.assertEqual(len(list(archive.iter_archive_images(production_root))), 1)
        self.assertEqual(self.session.get.call_count, 2)
        self.assertTrue(first_cache.is_file())

        other_data, other_spec = pack(image=b'another-synthetic-image')
        self.assertNotEqual(self.spec['sha256'], other_spec['sha256'])
        revision_two = '2' * 40
        api_two, info_two, _, _ = latest_metadata(other_spec, revision_two, filename)
        self.session.get.reset_mock()
        self.session.get.side_effect = [response(api_two), response(info_two), response(other_data)]
        images = list(archive.iter_archive_images(production_root))
        self.assertEqual(images[0]['image_bytes'], b'another-synthetic-image')
        self.assertTrue(first_cache.is_file())
        self.assertTrue((production_root / other_spec['sha256'] / filename).is_file())
        self.assertEqual(self.session.get.call_count, 3)

    def test_latest_archive_includes_revision_pinned_seed_only_when_declared(self):
        revision = 'c' * 40
        source = 'https://arca.live/b/aiart/123'
        seed = seed_database(self.root / 'source.sqlite', [(source, 0)])
        api_data, info_data, _, _ = latest_metadata(self.spec, revision, seed=seed)
        self.session.get.side_effect = [response(api_data), response(info_data),
                                        response(self.data), response(seed)]
        images = list(archive.iter_archive_images(
            self.root / 'production', include_recommendations=True))
        self.assertEqual(images[0]['recommendation_count'], 0)
        calls = self.session.get.call_args_list
        self.assertIn(f'/resolve/{revision}/archive_info.json', calls[1].args[0])
        self.assertEqual(calls[3].args[0], archive.HF_ARCHIVE_INFO_URL + revision + '/'
                         + archive.RECOMMENDATION_SEED_FILENAME + '?download=true')
        cache_root = self.root / 'production' / self.spec['sha256']
        self.assertTrue((cache_root / archive.RECOMMENDATION_SEED_FILENAME).is_file())

    def test_invalid_seed_metadata_is_rejected_before_archive_download(self):
        seed = b'synthetic seed bytes'
        cases = (
            ('seed hash', lambda api, info: info.update(seed_sha256='g' * 64)),
            ('seed LFS hash', lambda api, info: api['siblings'][1]['lfs'].update(sha256='0' * 64)),
            ('seed size', lambda api, info: api['siblings'][1].update(
                size=archive.MAX_RECOMMENDATION_SEED_BYTES + 1,
                lfs={'sha256': info['seed_sha256'],
                     'size': archive.MAX_RECOMMENDATION_SEED_BYTES + 1})),
        )
        for label, mutate in cases:
            with self.subTest(label=label):
                api_data, info_data, api_doc, info_doc = latest_metadata(self.spec, seed=seed)
                mutate(api_doc, info_doc)
                self.session.get.reset_mock()
                self.session.get.side_effect = [response(json.dumps(api_doc).encode()),
                                                response(json.dumps(info_doc).encode())]
                with self.assertRaises(archive.DakiStyleArchiveError):
                    list(archive.iter_archive_images(self.root / ('bad-seed-' + label),
                                                     include_recommendations=True))
                self.assertFalse(any('.zip?download=true' in call.args[0]
                                     for call in self.session.get.call_args_list))

    def test_requested_recommendations_require_seed_metadata_before_download(self):
        with self.assertRaisesRegex(archive.DakiStyleArchiveError, '추천수 자료'):
            list(archive.iter_archive_images(self.root / 'missing-seed', expected=self.spec,
                                              include_recommendations=True))
        self.session.get.assert_not_called()
        self.assertFalse((self.root / 'missing-seed').exists())

    def test_cached_seed_counts_are_attached_and_missing_counts_stay_unknown(self):
        sources = [('https://arca.live/b/aiart/123', b'first-image'),
                   ('https://arca.live/b/aiart/124', b'second-image'),
                   ('https://arca.live/b/aiart/125', b'third-image')]
        self.data, self.spec = pack(sources=sources)
        self.cache()
        seed = seed_database(self.root / 'source.sqlite', [
            ('https://arca.live/b/aiart/123', 0),
            ('https://arca.live/b/aiart/124', 11),
            ('https://arca.live/b/aiart/125', None),
        ])
        self.spec['recommendation_seed'] = seed_spec(seed)
        (self.root / archive.RECOMMENDATION_SEED_FILENAME).write_bytes(seed)
        images = list(archive.iter_archive_images(
            self.root, expected=self.spec, include_recommendations=True,
            progress=lambda **event: self.events.append(event)))
        self.assertEqual([item['recommendation_count'] for item in images], [0, 11, None])
        self.assertEqual([item['title'] for item in images], [
            '공유 그림체 · #123', '공유 그림체 · #124', '공유 그림체 · #125'])
        self.session.get.assert_not_called()
        self.assertIn('게시물 추천수 자료 확인 중', [event.get('message') for event in self.events])

    def test_seed_download_resumes_to_sqlite_filename_and_never_yields_partial_results(self):
        source = 'https://arca.live/b/aiart/123'
        seed = seed_database(self.root / 'source.sqlite', [(source, 9)])
        self.spec['recommendation_seed'] = seed_spec(seed)
        self.cache()
        self.session.get.return_value = response(seed[:20])
        with self.assertRaises(archive.DakiStyleArchiveError):
            list(archive.iter_archive_images(self.root, expected=self.spec,
                                              include_recommendations=True))
        partial = self.root / (archive.RECOMMENDATION_SEED_FILENAME + '.partial')
        self.assertEqual(partial.read_bytes(), seed[:20])
        self.assertFalse((self.root / archive.RECOMMENDATION_SEED_FILENAME).exists())

    def test_seed_download_resumes_with_verified_range(self):
        source = 'https://arca.live/b/aiart/123'
        seed = seed_database(self.root / 'source.sqlite', [(source, 9)])
        self.spec['recommendation_seed'] = seed_spec(seed)
        self.cache()
        partial = self.root / (archive.RECOMMENDATION_SEED_FILENAME + '.partial')
        partial.write_bytes(seed[:20])
        self.session.get.return_value = response(seed[20:], 206, {
            'Content-Range': f'bytes 20-{len(seed) - 1}/{len(seed)}',
            'Content-Length': str(len(seed) - 20),
        })
        images = list(archive.iter_archive_images(
            self.root, expected=self.spec, include_recommendations=True))
        self.assertEqual(images[0]['recommendation_count'], 9)
        self.assertEqual(self.session.get.call_args.kwargs['headers'], {
            'Range': 'bytes=20-', 'Accept-Encoding': 'identity'})
        self.assertEqual((self.root / archive.RECOMMENDATION_SEED_FILENAME).read_bytes(), seed)
        self.assertFalse(partial.exists())

    def test_invalid_seed_database_and_duplicate_canonical_urls_are_rejected(self):
        self.cache()
        invalid = sqlite3.connect(self.root / 'invalid.sqlite')
        invalid.execute('CREATE TABLE other_table (value TEXT)')
        invalid.commit()
        invalid.close()
        invalid_bytes = (self.root / 'invalid.sqlite').read_bytes()
        self.spec['recommendation_seed'] = seed_spec(invalid_bytes)
        (self.root / archive.RECOMMENDATION_SEED_FILENAME).write_bytes(invalid_bytes)
        with self.assertRaisesRegex(archive.DakiStyleArchiveError, '추천수 자료를 읽지 못했습니다'):
            list(archive.iter_archive_images(self.root, expected=self.spec,
                                              include_recommendations=True))

        duplicate = seed_database(self.root / 'duplicate.sqlite', [
            ('https://arca.live/b/aiart/123', 1),
            ('https://arca.live/b/aiart/123/', 2),
        ])
        self.spec['recommendation_seed'] = seed_spec(duplicate)
        (self.root / archive.RECOMMENDATION_SEED_FILENAME).write_bytes(duplicate)
        with self.assertRaisesRegex(archive.DakiStyleArchiveError, '중복된 원본 주소'):
            list(archive.iter_archive_images(self.root, expected=self.spec,
                                              include_recommendations=True))

    def test_seed_download_cancellation_never_yields_images(self):
        stop = threading.Event()
        source = 'https://arca.live/b/aiart/123'
        seed = seed_database(self.root / 'source.sqlite', [(source, 9)])
        self.spec['recommendation_seed'] = seed_spec(seed)
        self.cache()
        seed_response = response(b'')

        def stop_during_seed(_):
            yield seed[:20]
            stop.set()
            yield seed[20:]

        seed_response.iter_content.side_effect = stop_during_seed
        self.session.get.return_value = seed_response
        self.assertEqual(list(archive.iter_archive_images(
            self.root, stop, expected=self.spec, include_recommendations=True)), [])
        self.assertEqual((self.root / (archive.RECOMMENDATION_SEED_FILENAME + '.partial')).read_bytes(),
                         seed[:20])


if __name__ == '__main__':
    unittest.main()
