"""Local browser-session bridge and shared-style synchronization endpoints."""
from functools import wraps
import io
from pathlib import Path
from urllib.parse import urlsplit
import zipfile

from flask import jsonify, request, send_file

from naim.daki_style_sync import DakiStyleSync
from naim.arca_shared_styles import ArcaSharedError
from naim.paths import get_app_dir


def register_daki_style_sync_routes(app, root_provider, catalog):
    manager = DakiStyleSync(root_provider, catalog)

    def guarded(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='공유 그림체 최신화 자료를 읽거나 저장하지 못했습니다.'), 500
        return handler

    @app.route('/api/daki/shared-styles/sync', methods=['GET', 'POST'])
    @guarded
    def daki_style_sync():
        result = manager.status() if request.method == 'GET' else manager.start(request.get_json(silent=True))
        return jsonify(status='success', **result)

    @app.route('/api/daki/shared-styles/sync/stop', methods=['POST'])
    @guarded
    def daki_style_sync_stop():
        return jsonify(status='success', **manager.stop())

    @app.route('/api/daki/shared-styles/sync/extension', methods=['GET'])
    @guarded
    def daki_style_sync_extension():
        assets = Path(get_app_dir()) / 'static' / 'arca_session_bridge'
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
            for name in ('manifest.json', 'popup.html', 'popup.css', 'popup.js'):
                package.write(assets / name, 'nai_arca_session_bridge/' + name)
        archive.seek(0)
        return send_file(archive, mimetype='application/zip', as_attachment=True,
                         download_name='nai_arca_session_bridge.zip')

    def bridge_headers(methods, allow_missing_origin=False):
        origin = request.headers.get('Origin', '')
        parsed = urlsplit(origin)
        if (request.remote_addr not in ('127.0.0.1', '::1')
                or request.host.split(':')[0] not in ('127.0.0.1', 'localhost')):
            return None
        # Extension GET requests may omit Origin; writes and preflights may not.
        if not origin and allow_missing_origin:
            return {'Vary': 'Origin'}
        if (parsed.scheme != 'chrome-extension' or not parsed.netloc
                or parsed.path or parsed.query or parsed.fragment):
            return None
        return {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
                'Access-Control-Allow-Methods': methods,
                'Access-Control-Allow-Headers': 'Content-Type, X-Arca-Session-Bridge'}

    @app.route('/api/arca-styles/browser-session', methods=['GET', 'OPTIONS'])
    @guarded
    def daki_style_sync_browser_session_status():
        headers = bridge_headers('GET, OPTIONS', allow_missing_origin=request.method == 'GET')
        if headers is None:
            return jsonify(status='error', message='로컬 Chrome 확장 프로그램에서 연결해 주세요.'), 403
        if request.method == 'OPTIONS':
            return '', 204, headers
        if request.headers.get('X-Arca-Session-Bridge') != '1':
            return jsonify(status='error', message='로그인 연결 요청의 형식이 올바르지 않습니다.'), 400, headers
        connected = bool(manager.client.connected)
        return jsonify(status='success', connected=connected,
                       browser='현재 Chrome' if connected else '', error='',
                       state='connected' if connected else 'idle',
                       message='로그인 연결됨' if connected else '로그인 연결 안 됨'), 200, headers

    @app.route('/api/arca-styles/browser-session/extension', methods=['POST', 'OPTIONS'])
    @guarded
    def daki_style_sync_browser_session():
        headers = bridge_headers('POST, OPTIONS')
        if headers is None:
            return jsonify(status='error', message='로컬 Chrome 확장 프로그램에서 연결해 주세요.'), 403
        if request.method == 'OPTIONS':
            return '', 204, headers
        if request.headers.get('X-Arca-Session-Bridge') != '1' or request.content_length is None or request.content_length > 256 * 1024:
            return jsonify(status='error', message='로그인 연결 요청의 형식이 올바르지 않습니다.'), 400, headers
        try:
            manager.connect(request.get_json(silent=True))
        except ArcaSharedError as error:
            # Only controlled collector errors are public; requests exceptions
            # may contain session values or signed URLs and remain private.
            return jsonify(status='error', connected=bool(manager.client.connected), code=error.code, message=str(error)), 400, headers
        except (ValueError, TypeError):
            return jsonify(status='error', connected=bool(manager.client.connected), message='로그인 연결을 확인하지 못했습니다. Chrome에서 아카라이브 로그인과 🔞 NAI 접근을 확인해 주세요.'), 400, headers
        return jsonify(status='success', connected=True), 200, headers

    return manager
