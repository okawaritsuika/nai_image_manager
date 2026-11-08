"""Share NAIM-owned settings, catalog and login directly within one process."""
from flask import jsonify, request

from naim.storage.json_files import read_json, merge_json_object
from naim.web.style_shared_settings import _settings_payload, _validate_defaults, _validate_key


def install(workspace, parent, root):
    from . import naim_shared_library

    catalog = parent.extensions.get('shared_style_library')
    if catalog is None:
        raise RuntimeError('공용 그림체 목록을 준비하지 못했습니다. 태그 사전 자료를 확인해 주세요.')
    naim_shared_library.configure(catalog)
    settings_path = root / 'lab_config.json'

    def config():
        return read_json(settings_path, expected_type=dict)

    workspace.load_app_key = lambda *_: _settings_payload(config())['key']
    workspace.save_app_key = lambda _path, key, _root: merge_json_object(settings_path, {'key': _validate_key(key)})
    workspace.delete_app_key = lambda *_: merge_json_object(settings_path, {'key': ''})

    @workspace.app.route('/api/naim-shared-settings', methods=['GET', 'PUT'])
    def shared_settings():
        try:
            if request.method == 'PUT':
                if (request.headers.get('Origin') not in (None, request.host_url.rstrip('/'))
                        or request.headers.get('X-NAIM-Workspace') != '1'):
                    return jsonify(error='이 NAIM 화면에서 설정해 주세요.'), 403
                defaults = _validate_defaults(request.get_json(silent=True))
                data = merge_json_object(settings_path, defaults)
            else:
                data = config()
            response = jsonify(shared=True, defaults=_settings_payload(data)['defaults'])
            response.headers['Cache-Control'] = 'no-store'
            return response
        except (ValueError, TypeError):
            return jsonify(error='설정 형식을 확인해 주세요.'), 400
        except OSError:
            return jsonify(error='공통 설정을 읽거나 저장하지 못했습니다.'), 503

    original_import = workspace.app.view_functions['api_import_arca_browser_session']

    def shared_session():
        manager = parent.extensions.get('naim_arca_sync')
        client = manager.client if manager else None
        if client is not None and client.connected:
            result = workspace.connect_arca_cookie_jar(
                client._cookies, 'NAIM Chrome', user_agent=client._user_agent,
                validator=lambda _session: client._categories)
            return result
        return None

    original_status = workspace.app.view_functions['api_arca_browser_session_status']

    def session_status():
        result = shared_session()
        if result and result.get('connected'):
            return workspace.json_response(workspace._safe_arca_browser_status(result))
        return original_status()

    workspace.app.view_functions['api_arca_browser_session_status'] = session_status

    def import_session():
        result = shared_session()
        if result and result.get('connected'):
            return workspace.json_response(workspace._safe_arca_browser_status(result))
        return original_import()

    workspace.app.view_functions['api_import_arca_browser_session'] = import_session
    original_refresh = workspace.app.view_functions['api_refresh_arca_style_stats']

    def refresh_stats():
        shared_session()
        return original_refresh()

    workspace.app.view_functions['api_refresh_arca_style_stats'] = refresh_stats
