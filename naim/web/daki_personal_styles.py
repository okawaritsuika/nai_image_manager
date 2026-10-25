"""Personal style registration and linked representative image routes."""
from functools import wraps
from urllib.parse import quote

from flask import jsonify, request, send_file

from naim.storage.daki_projects import DakiNotFoundError


def register_daki_personal_style_routes(app, store):
    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except (FileNotFoundError, DakiNotFoundError):
                return jsonify(status='error', message='개인 그림체 또는 연결한 원본 그림을 찾을 수 없습니다.'), 404
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='개인 그림체 자료를 읽거나 저장하지 못했습니다.'), 500
        return handler

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return data

    def public(style):
        if style.get('source_path'):
            return {**style, 'src': '/api/daki/personal-styles/' + quote(style['id'], safe='') + '/preview'}
        return style

    @app.route('/api/daki/personal-styles', methods=['GET', 'POST'])
    @handle_errors
    def daki_personal_styles():
        if request.method == 'POST':
            return jsonify(status='success', style=public(store.create(body()))), 201
        summaries = []
        include_prompts = request.args.get('include_prompts') == '1'
        for style in store.list_styles():
            summary = {key: style.get(key) for key in
                       ('id', 'name', 'model', 'category', 'source_path', 'source_url', 'source_image_id', 'seed')}
            summary.update(width=style['preview']['width'], height=style['preview']['height'])
            if include_prompts:
                summary.update({key: style.get(key, '') for key in ('positive', 'negative')})
            summaries.append(public(summary))
        return jsonify(status='success', styles=summaries)

    @app.route('/api/daki/personal-styles/import', methods=['POST'])
    @handle_errors
    def daki_personal_style_import():
        return jsonify(status='success', style=store.draft_from_image(body().get('path')))

    @app.route('/api/daki/personal-styles/<style_id>', methods=['GET', 'PUT'])
    @handle_errors
    def daki_personal_style(style_id):
        style = store.update(style_id, body()) if request.method == 'PUT' else store.get_style(style_id)
        return jsonify(status='success', style=public(style))

    @app.route('/api/daki/personal-styles/<style_id>/preview', methods=['GET'])
    @handle_errors
    def daki_personal_style_preview(style_id):
        return send_file(store.preview_path(style_id, full=request.args.get('full') == '1'))

    return store
