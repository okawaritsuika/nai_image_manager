"""HTTP routes for common and project-scoped canvas detail prompt presets."""
from flask import jsonify, request

from naim.detail_prompt_presets import (
    DetailPresetConflict, DetailPresetNotFound, DetailPresetStorageError,
)
from naim.storage.daki_projects import DakiNotFoundError


def register_canvas_detail_preset_routes(app, store):
    """Register preset routes against an injected DakiProjectsStore."""
    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return value

    def error_response(error):
        if isinstance(error, (DakiNotFoundError, DetailPresetNotFound)):
            return jsonify({'status': 'error', 'message': str(error)}), 404
        if isinstance(error, DetailPresetConflict):
            return jsonify({'status': 'error', 'message': str(error)}), 409
        if isinstance(error, DetailPresetStorageError):
            return jsonify({
                'status': 'error',
                'message': '캔버스 상세 프롬프트 프리셋을 읽거나 저장하지 못했습니다.',
            }), 500
        if isinstance(error, ValueError):
            return jsonify({'status': 'error', 'message': str(error)}), 400
        if isinstance(error, OSError):
            return jsonify({
                'status': 'error',
                'message': '캔버스 상세 프롬프트 프리셋을 읽거나 저장하지 못했습니다.',
            }), 500
        raise error

    @app.route(
        '/api/canvas/detail-presets', methods=['GET', 'POST', 'PUT', 'DELETE'],
        endpoint='canvas_detail_prompt_presets',
    )
    def detail_prompt_presets():
        try:
            if request.method == 'GET':
                project_id = request.args.get('project_id')
                result = store.get_detail_prompt_presets(project_id)
                return jsonify({'status': 'success', **result})

            data = body()
            result = store.mutate_detail_prompt_presets(
                data.get('scope'),
                data.get('projectId'),
                data.get('revision'),
                request.method,
                preset=data.get('preset'),
                preset_id=data.get('id'),
            )
            status_code = 201 if request.method == 'POST' else 200
            return jsonify({'status': 'success', **result}), status_code
        except (DakiNotFoundError, DetailPresetNotFound, DetailPresetConflict,
                DetailPresetStorageError, OSError, ValueError) as error:
            return error_response(error)

    return detail_prompt_presets
