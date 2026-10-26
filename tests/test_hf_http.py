import hashlib
import json
import os
import ssl
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import requests
from requests.adapters import HTTPAdapter

from naim import daki_style_archive as archive
from naim import daki_test_packs as packs
from naim import hf_http


def _response(request, content, content_type='application/json'):
    response = requests.Response()
    response.status_code = 200
    response.headers = {'Content-Type': content_type, 'Content-Length': str(len(content))}
    response._content = content
    response._content_consumed = True
    response.url = request.url
    response.request = request
    return response


class HuggingFaceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def assert_verified_adapter(self, adapter):
        self.assertIsInstance(adapter, HTTPAdapter)
        pool_context = adapter.poolmanager.connection_pool_kw.get('ssl_context')
        self.assertIsInstance(pool_context, ssl.SSLContext)
        self.assertIsNone(pool_context.keylog_filename)
        self.assertEqual(pool_context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(pool_context.check_hostname)
        self.assertGreaterEqual(pool_context.minimum_version, ssl.TLSVersion.TLSv1_2)
        self.assertGreater(pool_context.cert_store_stats()['x509_ca'], 0)

        prepared = requests.Request('GET', 'https://huggingface.co/').prepare()
        _, pool_key = adapter.build_connection_pool_key_attributes(prepared, True, None)
        self.assertIs(pool_key['ssl_context'], pool_context)
        return pool_context

    def test_sslkeylogfile_is_ignored_for_missing_and_existing_paths(self):
        missing_path = self.root / 'missing-parent' / 'ssl-keylog.log'
        existing_path = self.root / 'existing-keylog.log'
        sentinel = b'pre-existing synthetic key log\n'
        existing_path.write_bytes(sentinel)

        for keylog_path, expected_contents in ((missing_path, None), (existing_path, sentinel)):
            with self.subTest(path=keylog_path.name), mock.patch.dict(
                    os.environ, {'SSLKEYLOGFILE': str(keylog_path)}):
                original_value = os.environ['SSLKEYLOGFILE']
                with hf_http.public_session() as session:
                    self.assertFalse(session.trust_env)
                    self.assertIs(session.verify, True)
                    adapter = session.get_adapter('https://huggingface.co')
                    self.assert_verified_adapter(adapter)
                self.assertEqual(os.environ['SSLKEYLOGFILE'], original_value)
                if expected_contents is None:
                    self.assertFalse(missing_path.parent.exists())
                else:
                    self.assertEqual(existing_path.read_bytes(), expected_contents)

    def test_tls_certificate_verification_error_is_not_suppressed(self):
        def reject_certificate(adapter, request, **kwargs):
            self.assertIs(kwargs['verify'], True)
            self.assert_verified_adapter(adapter)
            raise requests.exceptions.SSLError('synthetic certificate verify failed')

        with hf_http.public_session() as session, mock.patch.object(
                HTTPAdapter, 'send', autospec=True, side_effect=reject_certificate):
            with self.assertRaisesRegex(requests.exceptions.SSLError, 'certificate verify failed'):
                session.get('https://huggingface.co/', timeout=1)

    def test_metadata_callers_and_zip_download_use_verified_https_adapter(self):
        revision = 'a' * 40
        archive_filename = 'NAImakeArtistGroup_shared_images_20261024_webp.zip'
        archive_bytes = b'synthetic-zip'
        archive_digest = hashlib.sha256(archive_bytes).hexdigest()
        pack_id = 'b' * 32
        pack_filename = 'style_test_' + pack_id + '.zip'
        pack_bytes = 23
        pack_digest = 'c' * 64
        revision_doc = {
            'sha': revision,
            'siblings': [
                {'rfilename': packs.MANIFEST},
                {'rfilename': archive_filename, 'size': len(archive_bytes),
                 'lfs': {'size': len(archive_bytes), 'sha256': archive_digest}},
                {'rfilename': pack_filename, 'size': pack_bytes,
                 'lfs': {'size': pack_bytes, 'sha256': pack_digest}},
            ],
        }
        archive_info = {
            'filename': archive_filename, 'bytes': len(archive_bytes),
            'sha256': archive_digest, 'image_count': 1, 'image_bytes': 1,
        }
        pack_spec = {
            'id': pack_id, 'name': 'Synthetic pack', 'filename': pack_filename,
            'bytes': pack_bytes, 'sha256': pack_digest, 'image_count': 1,
            'expanded_bytes': 10,
        }
        manifest = {'format': packs.FORMAT, 'version': 1, 'packs': [pack_spec]}
        download_url = archive.HF_ARCHIVE_INFO_URL + revision + '/synthetic.zip?download=true'
        bodies = {
            archive.HF_REVISION_API_URL: json.dumps(revision_doc).encode(),
            archive.HF_ARCHIVE_INFO_URL + revision + '/archive_info.json': json.dumps(archive_info).encode(),
            packs.HF_ARCHIVE_INFO_URL + revision + '/' + packs.MANIFEST: json.dumps(manifest).encode(),
            download_url: archive_bytes,
        }
        sent = []

        def send_without_network(adapter, request, **kwargs):
            sent.append((adapter, request, kwargs))
            content_type = 'application/zip' if request.url == download_url else 'application/json'
            return _response(request, bodies[request.url], content_type)

        with mock.patch.object(HTTPAdapter, 'send', autospec=True, side_effect=send_without_network):
            discovered_archive = archive.latest_archive_spec()
            discovered_packs = packs.latest_packs()
            target = self.root / 'synthetic.zip'
            downloaded = archive._download(
                target,
                {'bytes': len(archive_bytes), 'sha256': archive_digest},
                None, None, url=download_url,
            )

        self.assertEqual(discovered_archive['revision'], revision)
        self.assertEqual(discovered_packs[0]['revision'], revision)
        self.assertTrue(downloaded)
        self.assertEqual(target.read_bytes(), archive_bytes)
        self.assertEqual(len(sent), 5)
        for adapter, request, kwargs in sent:
            with self.subTest(url=request.url):
                context = self.assert_verified_adapter(adapter)
                self.assertIs(kwargs['verify'], True)
                self.assertEqual(kwargs['proxies'], {})
                self.assertIsNone(context.keylog_filename)


if __name__ == '__main__':
    unittest.main()
