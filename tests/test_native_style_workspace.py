"""Exercise the native mounted workspace with synthetic data and no helper."""
import json
import ast
import os
from pathlib import Path
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock


class NativeWorkspaceTests(unittest.TestCase):
    def test_frozen_app_never_relaunches_an_external_virtual_environment(self):
        root = Path(__file__).resolve().parents[1]
        tree = ast.parse((root / 'main_executor.pyw').read_text(encoding='utf-8'))
        branch = next(node for node in tree.body if isinstance(node, ast.If)
                      and 'sys.prefix' in ast.unparse(node.test))
        launcher = Mock()
        namespace = {'is_frozen_app': lambda: True, 'os': os,
                     'sys': SimpleNamespace(prefix='runtime', base_prefix='runtime'),
                     'subprocess': SimpleNamespace(Popen=launcher)}
        exec(compile(ast.Module(body=[branch], type_ignores=[]), '<launcher>', 'exec'), namespace)
        launcher.assert_not_called()

    def test_workspace_runs_in_naim_without_external_source_or_python(self):
        script = r'''
import json, tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from flask import Flask
from requests.cookies import RequestsCookieJar
from naim.web.style_workspace import register_style_workspace
from naim.style_manager import app as workspace

class Catalog:
    warnings = []
    def public_records(self, include_excluded=False): return []

with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary:
    root = Path(temporary)
    (root / 'style_workspace.html').write_text('<h1>NAIM</h1>')
    (root / 'lab_config.json').write_text(json.dumps({'key':'synthetic-key', 'steps':24}))
    workspace.ARCA_STYLE_SEED_PATH = root / 'absent-seed.sqlite'
    parent = Flask(__name__)
    parent.extensions['shared_style_library'] = Catalog()
    jar = RequestsCookieJar()
    jar.set('session', 'synthetic-cookie', domain='.arca.live', path='/')
    parent.extensions['naim_arca_sync'] = SimpleNamespace(client=SimpleNamespace(
        connected=True, _cookies=jar, _categories={'NAI':{},'R18_NAI':{}}, _user_agent='Synthetic Browser'))
    service = register_style_workspace(parent, root)
    client = parent.test_client()
    with patch('subprocess.Popen', side_effect=AssertionError('external process')):
        response = client.post('/api/style-workspace/connect',headers={'X-NAIM-Workspace':'1'})
        assert response.status_code == 200, response.data
        assert response.json['url'] == '/style-workspace/?naim=1'
        page = client.get(response.json['url'])
        assert page.status_code == 200
        assert b'/style-workspace/static/app.js' in page.data
        assert b'<iframe' not in page.data
        direct = client.get('/style-manager', follow_redirects=True)
        assert direct.status_code == 200 and b'workspace-header-navigation' in direct.data
        with patch.object(workspace, 'import_arca_browser_session', side_effect=AssertionError('browser import')), \
             patch.object(workspace.ARCA_LOGIN_MANAGER, 'start', side_effect=AssertionError('login window')):
            login_status = client.get('/style-workspace/api/arca-styles/browser-session')
            assert login_status.status_code == 200
            assert login_status.json['connected'], 'Existing NAIM login must connect without import POST'
            assert login_status.json['browser'] == 'NAIM Chrome'
            assert b'synthetic-cookie' not in login_status.data
            manager = parent.extensions.pop('naim_arca_sync')
            with patch.object(workspace, 'connect_arca_cookie_jar', side_effect=AssertionError('no shared login')):
                retained = client.get('/style-workspace/api/arca-styles/browser-session')
                assert retained.json['connected'], 'Keep the workspace login when no shared login is available'
                workspace.clear_arca_browser_session()
                disconnected = client.get('/style-workspace/api/arca-styles/browser-session')
                assert not disconnected.json['connected'], 'A status lookup must not open a login window'
            parent.extensions['naim_arca_sync'] = manager
            with patch.object(workspace, 'connect_arca_cookie_jar', return_value={'connected':False}):
                failed = client.get('/style-workspace/api/arca-styles/browser-session')
                assert not failed.json['connected'], 'Failed sharing must use the existing status path'
            reconnected = client.get('/style-workspace/api/arca-styles/browser-session')
            assert reconnected.json['connected'], 'A later lookup must retry the available shared login'
        assert workspace.DB_PATH == root / 'data/style_manager/artist_rater.sqlite'
        assert not (root / 'style_workspace.local.json').exists()
        for url in ['/style-workspace/api/ratings', '/style-workspace/api/arca-styles',
                    '/style-workspace/api/naim-shared-library', '/style-workspace/api/style-worldcups']:
            result = client.get(url)
            assert result.status_code == 200, (url, result.status_code, result.data[:300])
        settings = client.get('/style-workspace/api/naim-shared-settings')
        assert settings.status_code == 200
        assert settings.json['defaults']['steps'] == 24
        assert b'synthetic-key' not in settings.data
        assert settings.headers['Cache-Control'] == 'no-store'
        changed = client.put('/style-workspace/api/naim-shared-settings', json={'steps':30},
            headers={'X-NAIM-Workspace':'1'})
        assert changed.status_code == 200
        assert json.loads((root/'lab_config.json').read_text())['steps'] == 30
        with patch.object(workspace, 'connect_arca_cookie_jar', return_value={'connected':True}) as connect, \
             patch.object(workspace, 'start_stats_refresh_job', return_value=73) as start:
            refreshed = client.post('/style-workspace/api/arca-styles/refresh-stats', json={'model':'all'})
            assert refreshed.status_code == 202 and refreshed.json['job_id'] == 73
            connect.assert_called_once()
            start.assert_called_once_with(workspace.DB_PATH, model='all')
            assert b'synthetic-cookie' not in refreshed.data
        login = client.post('/style-workspace/api/arca-styles/browser-session/import')
        assert login.status_code == 200 and login.json['connected']
        assert b'synthetic-cookie' not in login.data
        from naim.web.confirmed_style_import import ConfirmedStyleSource
        confirmed = ConfirmedStyleSource(service)
        assert confirmed.fetch('/api/confirmed-styles', origin='http://localhost') == []
    print('NATIVE_WORKSPACE_OK')
'''
        result = subprocess.run([sys.executable, '-B', '-c', script],
                                cwd=Path(__file__).resolve().parents[1],
                                text=True, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('NATIVE_WORKSPACE_OK', result.stdout)

    def test_frozen_spec_includes_native_resources_and_no_companion_runtime(self):
        root = Path(__file__).resolve().parents[1]
        spec = (root / 'NAI_Image_Manager.spec').read_text(encoding='utf-8')
        for resource in ('templates', 'static', 'arca_style_seed.sqlite', 'arca_image_archive_legacy.json'):
            self.assertIn('naim/style_manager/' + resource, spec)
        source = (root / 'naim/web/style_workspace.py').read_text(encoding='utf-8')
        self.assertNotIn('subprocess', source)
        self.assertNotIn('source_dir', source)
        self.assertNotIn('naim_runner', source)
