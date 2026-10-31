"""NAIM bridge; artist data remains owned by the linked artist application."""
import atexit
import json
import os
import secrets
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from flask import jsonify, request, send_file


class StyleService:
    def __init__(self, config_path, settings_token=None):
        self.config_path = Path(config_path)
        self.process = None
        self.temp = None
        self.port = None
        self.lock = threading.Lock()
        self.settings_token = settings_token

    def start(self, origin=None):
        with self.lock:
            if self.process is not None and self.process.poll() is None and self.port:
                return self.port
            self._stop()
            try:
                config = json.loads(self.config_path.read_text(encoding='utf-8'))
                source = Path(config['source_dir'])
                python = Path(config['python'])
                runner = source / 'naim_runner.py'
                if not runner.is_file() or not python.is_file():
                    raise ValueError('missing runtime')
            except (OSError, ValueError, KeyError, TypeError):
                raise RuntimeError('리모콘의 그림체 프로그램 연결에서 기존 프로그램 폴더를 지정해 주세요.') from None
            self.temp = tempfile.TemporaryDirectory(prefix='naim-style-')
            ready = Path(self.temp.name) / 'ready.json'
            command = [str(python), '-B', str(runner), '--ready-file', str(ready)]
            if origin:
                from urllib.parse import urlsplit
                address = urlsplit(origin)
                if address.scheme != 'http' or address.hostname not in ('127.0.0.1', 'localhost') or address.username or address.password:
                    self._stop()
                    raise RuntimeError('이 PC의 NAIM 화면에서 연결해 주세요.')
                command.extend(['--naim-origin', f'http://127.0.0.1:{address.port or 80}'])
            if config.get('data_dir'):
                command.extend(['--data-dir', config['data_dir']])
            try:
                self.process = subprocess.Popen(
                    command, cwd=source, stdin=subprocess.PIPE,
                    env={**os.environ, **({'NAIM_SETTINGS_TOKEN': self.settings_token} if self.settings_token else {})},
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                )
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if self.process.poll() is not None:
                        raise RuntimeError('그림체 관리 실행에 실패했습니다. 연결된 Python의 앱 의존성을 확인해 주세요.')
                    if ready.is_file():
                        try:
                            self.port = int(json.loads(ready.read_text(encoding='utf-8'))['port'])
                            if not 1 <= self.port <= 65535:
                                raise ValueError('port')
                            return self.port
                        except (OSError, ValueError, KeyError):
                            pass
                    time.sleep(0.1)
                raise RuntimeError('그림체 관리 시작 시간이 초과되었습니다. 다시 연결해 주세요.')
            except Exception:
                self._stop()
                raise

    def _stop(self):
        if self.process is not None:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                self.process.wait(timeout=5)
            self.process = None
        self.port = None
        if self.temp:
            self.temp.cleanup()
            self.temp = None

    def stop(self):
        with self.lock:
            self._stop()


def register_style_workspace(app, app_dir):
    root = Path(app_dir)
    from naim.web.style_shared_settings import register_style_shared_settings
    token = secrets.token_urlsafe(32)
    register_style_shared_settings(app, root / 'lab_config.json', token)
    service = StyleService(root / 'style_workspace.local.json', token)
    atexit.register(service.stop)

    @app.get('/style-manager')
    def style_workspace_page():
        return send_file(root / 'style_workspace.html')

    @app.post('/api/style-workspace/connect')
    def style_workspace_connect():
        # Only this NAIM page may start the local helper; no cross-site POSTs.
        if request.headers.get('Origin') not in (None, request.host_url.rstrip('/')):
            return jsonify(ok=False, error='이 NAIM 화면에서 연결해 주세요.'), 403
        if request.headers.get('X-NAIM-Workspace') != '1':
            return jsonify(ok=False, error='잘못된 연결 요청입니다.'), 403
        try:
            port = service.start(request.host_url)
            return jsonify(ok=True, url=f'http://127.0.0.1:{port}/?naim=1')
        except (RuntimeError, OSError) as exc:
            message = str(exc) if isinstance(exc, RuntimeError) else '그림체 관리 실행 파일을 열 수 없습니다.'
            return jsonify(ok=False, error=message), 503

    return service
