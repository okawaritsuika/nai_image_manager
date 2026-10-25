import hashlib
import io
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
import zipfile

from flask import Flask

from naim.upscale_assets import (
    UpscaleAssetConflict,
    UpscaleAssetError,
    UpscaleAssets,
)
from naim.web.upscale_models import register_upscale_model_routes


def _zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, content)
    return output.getvalue()


def _download(url, data, *, sha256=None, **extra):
    return {
        'url': url,
        'sha256': sha256 or hashlib.sha256(data).hexdigest(),
        'size': len(data),
        **extra,
    }


def _catalog(model_bytes=None, runtime_bytes=None):
    model_bytes = model_bytes or _zip_bytes({'model.bin': b'model'})
    runtime_bytes = runtime_bytes or _zip_bytes({
        'python.exe': b'synthetic-python',
        'Lib/site-packages/torch/__init__.py': b'',
        'Lib/site-packages/torchvision/__init__.py': b'',
        'Lib/site-packages/spandrel/__init__.py': b'',
        'Lib/site-packages/spandrel/architectures/FDAT.py': b'class FDATArch: pass',
    })
    runtime_required = [
        'python.exe',
        'python311._pth',
        'Lib/site-packages/torch/__init__.py',
        'Lib/site-packages/torchvision/__init__.py',
        'Lib/site-packages/spandrel/__init__.py',
        'Lib/site-packages/spandrel/architectures/FDAT.py',
    ]
    catalog = {
        'runtime': {
            'name': 'Runtime', 'description': 'Synthetic runtime',
            'folder': 'upscale_models/runtime', 'required': runtime_required,
            'downloads': [_download('https://assets.invalid/runtime.zip', runtime_bytes,
                                   kind='zip', target='.')],
        },
    }
    for engine, folder in (
        ('realcugan', 'tools/realcugan-ncnn-vulkan'),
        ('waifu2x', 'tools/waifu2x-ncnn-vulkan'),
        ('illustrationjanai', 'upscale_models/illustrationjanai'),
        ('animesharp', 'upscale_models/animesharp'),
    ):
        is_new = engine in ('illustrationjanai', 'animesharp')
        files = ({'weights/model.pth': engine.encode('ascii')} if is_new
                 else {'model.bin': engine.encode('ascii')})
        archive = model_bytes if engine == 'realcugan' else _zip_bytes(files)
        required = ['weights/model.pth'] if is_new else ['model.bin']
        url = f'https://assets.invalid/{engine}.zip'
        catalog[engine] = {
            'name': engine.title(), 'description': f'{engine} test model',
            'folder': folder, 'required': required,
            'downloads': [_download(url, archive, kind='zip', target='.')],
        }
        if is_new:
            catalog[engine]['dependency'] = 'runtime'
    return catalog


class SyntheticResponse(io.BytesIO):
    def __init__(self, data, url):
        super().__init__(data)
        self._url = url

    def geturl(self):
        return self._url


class BlockingResponse:
    def __init__(self, data, url):
        self.data = data
        self.url = url
        self.started = threading.Event()
        self.release = threading.Event()
        self._sent = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self.url

    def read(self, _size=-1):
        self.started.set()
        self.release.wait(3)
        if self._sent:
            return b''
        self._sent = True
        return self.data


class UpscaleAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = _catalog()
        self.catalog_patch = mock.patch('naim.upscale_assets._load_catalog', return_value=self.catalog)
        self.catalog_patch.start()
        self.addCleanup(self.catalog_patch.stop)
        self.assets = UpscaleAssets(self.root)
        self.assets._verify_runtime = lambda *_args: None
        self.addCleanup(self.assets.shutdown)

    def _fetch_patch(self, sources=None, default=None):
        sources = sources or {}

        def open_url(url):
            data = sources.get(url, default)
            if data is None:
                for spec in self.catalog.values():
                    for item in spec.get('downloads', []):
                        if item['url'] == url:
                            data = getattr(item, '_test_data', None)
            if data is None:
                raise AssertionError(f'No synthetic content configured for {url}')
            if isinstance(data, BlockingResponse):
                return data
            return SyntheticResponse(data, url)

        return mock.patch('naim.upscale_assets._open_https', side_effect=open_url)

    def _sources_from_catalog(self):
        # The test manifest stores payloads by deterministic URL separately
        # from the public download metadata, mirroring a local synthetic server.
        return getattr(self, 'sources', {})

    def _wait(self, engine, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            row = next(item for item in self.assets.list() if item['id'] == engine)
            if row['state'] != 'downloading':
                return row
            time.sleep(0.01)
        self.fail(f'{engine} download did not finish')

    def _set_sources(self):
        self.sources = {}
        for spec in self.catalog.values():
            for item in spec.get('downloads', []):
                if item['kind'] == 'zip':
                    # Recreate the small archive from the test fixture. Runtime
                    # and model archives use these exact files in _catalog.
                    if item['url'].endswith('/runtime.zip'):
                        self.sources[item['url']] = _zip_bytes({
                            'python.exe': b'synthetic-python',
                            'Lib/site-packages/torch/__init__.py': b'',
                            'Lib/site-packages/torchvision/__init__.py': b'',
                            'Lib/site-packages/spandrel/__init__.py': b'',
                            'Lib/site-packages/spandrel/architectures/FDAT.py': b'class FDATArch: pass',
                        })
                    elif item['url'].endswith('/realcugan.zip'):
                        self.sources[item['url']] = _zip_bytes({'model.bin': b'model'})
                    elif item['url'].endswith('/waifu2x.zip'):
                        self.sources[item['url']] = _zip_bytes({'model.bin': b'waifu2x'})
                    else:
                        engine = item['url'].rsplit('/', 1)[-1].split('.', 1)[0]
                        self.sources[item['url']] = _zip_bytes({'weights/model.pth': engine.encode('ascii')})

    def _download(self, engine):
        self._set_sources()
        with self._fetch_patch(self._sources_from_catalog()):
            self.assets.start_download(engine)
            return self._wait(engine)

    def _wait_after_start(self, engine):
        self.assets.start_download(engine)
        return self._wait(engine)

    def test_missing_installed_and_new_model_paths_include_runtime(self):
        initial = {item['id']: item for item in self.assets.list()}
        self.assertEqual(initial['realcugan']['state'], 'missing')
        self.assertFalse(initial['illustrationjanai']['runtime_installed'])

        row = self._download('illustrationjanai')
        self.assertEqual(row['state'], 'installed', row)
        self.assertTrue(row['installed'])
        self.assertTrue(row['runtime_installed'])
        paths = self.assets.paths('illustrationjanai')
        self.assertEqual(Path(paths['model']), self.root / 'upscale_models/illustrationjanai/weights/model.pth')
        self.assertEqual(Path(paths['python']), self.root / 'upscale_models/runtime/python.exe')
        pth = (self.root / 'upscale_models/runtime/python311._pth').read_text(encoding='ascii')
        self.assertEqual(pth, 'python311.zip\n.\nLib/site-packages\nimport site\n')

    def test_integrity_mismatch_never_marks_model_installed(self):
        item = self.catalog['realcugan']['downloads'][0]
        item['sha256'] = '0' * 64
        self._set_sources()
        with self._fetch_patch(self._sources_from_catalog()):
            self.assets.start_download('realcugan')
            row = self._wait('realcugan')
        self.assertEqual(row['state'], 'error')
        self.assertFalse(row['installed'])
        self.assertFalse((self.root / 'tools/realcugan-ncnn-vulkan').exists())
        self.assertFalse(list(self.root.rglob('*.staging-*')))

    def test_cancellation_preserves_existing_engine_folder(self):
        folder = self.root / 'tools/realcugan-ncnn-vulkan'
        folder.mkdir(parents=True)
        marker = folder / 'preserve.txt'
        marker.write_text('old installation')
        self._set_sources()
        item = self.catalog['realcugan']['downloads'][0]
        response = BlockingResponse(self.sources[item['url']], item['url'])
        with self._fetch_patch({item['url']: response}):
            self.assets.start_download('realcugan')
            self.assertTrue(response.started.wait(2))
            self.assertTrue(self.assets.cancel_download('realcugan'))
            response.release.set()
            row = self._wait('realcugan')
        self.assertEqual(row['state'], 'cancelled')
        self.assertEqual(marker.read_text(), 'old installation')
        self.assertFalse((folder / 'model.bin').exists())

    def test_archive_traversal_is_rejected_and_stays_inside_root(self):
        payload = _zip_bytes({'../outside.txt': b'nope'})
        catalog = _catalog(model_bytes=payload)
        catalog['realcugan']['downloads'][0]['sha256'] = hashlib.sha256(payload).hexdigest()
        self.catalog.clear()
        self.catalog.update(catalog)
        self._set_sources()
        self.sources[catalog['realcugan']['downloads'][0]['url']] = payload
        with self._fetch_patch(self._sources_from_catalog()):
            self.assets.start_download('realcugan')
            row = self._wait('realcugan')
        self.assertEqual(row['state'], 'error')
        self.assertFalse((self.root.parent / 'outside.txt').exists())

    def test_invalid_id_cannot_delete_and_reparse_folder_is_confined(self):
        sentinel = self.root.parent / 'outside-upscale-sentinel.txt'
        sentinel.write_text('keep')
        self.addCleanup(lambda: sentinel.unlink(missing_ok=True))
        with self.assertRaises(ValueError):
            self.assets.delete('../outside-upscale-sentinel.txt')
        self.assertEqual(sentinel.read_text(), 'keep')

        outside = self.root.parent / 'outside-upscale-folder'
        outside.mkdir(exist_ok=True)
        external = outside / 'keep.txt'
        external.write_text('keep')
        self.addCleanup(lambda: external.unlink(missing_ok=True))
        link = self.root / 'tools/realcugan-ncnn-vulkan'
        link.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('directory symlink creation is unavailable')
        with self.assertRaises(UpscaleAssetError):
            self.assets.delete('realcugan')
        self.assertEqual(external.read_text(), 'keep')

    def test_wheel_installs_imports_and_skips_console_scripts_and_cpp_headers(self):
        item = self.catalog['realcugan']['downloads'][0]
        item.update(kind='wheel', target='Lib/site-packages')
        self.catalog['realcugan']['required'] = [
            'Lib/site-packages/demo/__init__.py',
            'Lib/site-packages/native_module.pyd',
        ]
        payload = _zip_bytes({
            'demo-1.0.data/purelib/demo/__init__.py': b'pure',
            'demo-1.0.data/platlib/native_module.pyd': b'native',
            'demo-1.0.data/scripts/runner.py': b'not needed for imports',
            'torch/include/ATen/ops/' + 'long_header_' * 18 + '.h': b'developer header',
        })
        item.update(sha256=hashlib.sha256(payload).hexdigest(), size=len(payload))
        self._set_sources()
        self.sources[item['url']] = payload
        with self._fetch_patch(self._sources_from_catalog()):
            row = self._wait_after_start('realcugan')
        self.assertEqual(row['state'], 'installed', row)
        self.assertEqual((self.root / 'tools/realcugan-ncnn-vulkan/Lib/site-packages/demo/__init__.py').read_bytes(), b'pure')
        self.assertEqual((self.root / 'tools/realcugan-ncnn-vulkan/Lib/site-packages/native_module.pyd').read_bytes(), b'native')
        self.assertFalse((self.root / 'tools/realcugan-ncnn-vulkan/Lib/site-packages/runner.py').exists())
        self.assertFalse((self.root / 'tools/realcugan-ncnn-vulkan/Lib/site-packages/torch/include').exists())

        self.assets.delete('realcugan')
        scripts_payload = _zip_bytes({'demo-1.0.data/scripts/runner.py': b'not installed'})
        item.update(sha256=hashlib.sha256(scripts_payload).hexdigest(), size=len(scripts_payload))
        self.sources[item['url']] = scripts_payload
        with self._fetch_patch(self._sources_from_catalog()):
            row = self._wait_after_start('realcugan')
        self.assertEqual(row['state'], 'error')
        self.assertFalse((self.root / 'tools/realcugan-ncnn-vulkan').exists())

    def test_shared_runtime_stays_until_last_dependent_model_is_removed(self):
        self.assertEqual(self._download('illustrationjanai')['state'], 'installed', self.assets.list())
        self.assertEqual(self._download('animesharp')['state'], 'installed')
        runtime = self.root / 'upscale_models/runtime'
        self.assertTrue(runtime.exists())
        self.assets.delete('illustrationjanai')
        self.assertTrue(runtime.exists())
        self.assertTrue((self.root / 'upscale_models/animesharp').exists())
        self.assets.delete('animesharp')
        self.assertFalse(runtime.exists())

    def test_in_use_model_cannot_be_deleted(self):
        self.assertEqual(self._download('realcugan')['state'], 'installed', self.assets.list())
        with self.assets.use('realcugan'):
            with self.assertRaises(UpscaleAssetConflict):
                self.assets.delete('realcugan')
            self.assertTrue((self.root / 'tools/realcugan-ncnn-vulkan/model.bin').exists())
        self.assets.delete('realcugan')
        self.assertFalse((self.root / 'tools/realcugan-ncnn-vulkan').exists())

    def test_duplicate_downloads_coalesce_and_other_engine_conflicts(self):
        self._set_sources()
        item = self.catalog['realcugan']['downloads'][0]
        response = BlockingResponse(self.sources[item['url']], item['url'])
        with self._fetch_patch({item['url']: response}):
            first = self.assets.start_download('realcugan')
            self.assertEqual(first['state'], 'downloading')
            self.assertTrue(response.started.wait(2))
            duplicate = self.assets.start_download('realcugan')
            self.assertEqual(duplicate['state'], 'downloading')
            with self.assertRaises(UpscaleAssetConflict):
                self.assets.start_download('waifu2x')
            self.assets.cancel_download('realcugan')
            response.release.set()
            self.assertEqual(self._wait('realcugan')['state'], 'cancelled')

    def test_routes_list_download_cancel_delete_and_reject_busy_or_invalid_ids(self):
        self._set_sources()
        item = self.catalog['waifu2x']['downloads'][0]
        response = BlockingResponse(self.sources[item['url']], item['url'])
        busy_state = {'value': False}
        app = Flask(__name__)
        register_upscale_model_routes(app, self.assets, busy=lambda: busy_state['value'])
        client = app.test_client()

        self.assertEqual(client.get('/api/upscale/models').status_code, 200)
        busy_state['value'] = True
        self.assertEqual(client.post('/api/upscale/models/waifu2x/download').status_code, 409)
        busy_state['value'] = False
        with self._fetch_patch({item['url']: response}):
            started = client.post('/api/upscale/models/waifu2x/download')
            self.assertEqual(started.status_code, 200, started.json)
            self.assertTrue(response.started.wait(2))
            duplicate = client.post('/api/upscale/models/waifu2x/download')
            self.assertEqual(duplicate.status_code, 200)
            self.assertEqual(client.post('/api/upscale/models/waifu2x/cancel').status_code, 200)
            response.release.set()
            self.assertEqual(self._wait('waifu2x')['state'], 'cancelled')
        invalid = client.post('/api/upscale/models/../../outside/delete')
        self.assertIn(invalid.status_code, (400, 404))
        busy_state['value'] = True
        self.assertEqual(client.post('/api/upscale/models/waifu2x/delete').status_code, 409)
        busy_state['value'] = False
        invalid = client.post('/api/upscale/models/not-a-model/delete')
        self.assertEqual(invalid.status_code, 400)


if __name__ == '__main__':
    unittest.main()
