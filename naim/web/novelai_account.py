"""Sanitized NovelAI account status and saved-key management endpoints."""
from flask import jsonify, request

from naim.novelai_account import NovelAIAccount


def register_novelai_account_routes(app, config_path_provider):
    account = NovelAIAccount(config_path_provider)

    def response(data, status=200):
        result = jsonify(data)
        result.status_code = status
        result.headers['Cache-Control'] = 'no-store'
        return result

    @app.route('/api/novelai/account', methods=['GET'])
    def novelai_account_status():
        try:
            return response(account.get(refresh=request.args.get('refresh') == '1'))
        except OSError:
            return response({'status': 'error', 'message': 'NovelAI 키 설정을 읽지 못했습니다.'}, 500)

    @app.route('/api/novelai/key', methods=['PUT'])
    def novelai_account_key():
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or 'key' not in data:
            return response({'status': 'error', 'message': 'NovelAI 키를 입력해 주세요.'}, 400)
        try:
            return response(account.set_key(data['key']))
        except ValueError as error:
            return response({'status': 'error', 'message': str(error)}, 400)
        except OSError:
            return response({'status': 'error', 'message': 'NovelAI 키 설정을 저장하지 못했습니다.'}, 500)

    return account
