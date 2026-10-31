"""Personal style registration and linked representative image routes."""
import base64
from io import BytesIO
from functools import wraps
import secrets
import threading
from urllib.parse import quote

from flask import jsonify, request, send_file

from naim.novelai import generate_text_image
from naim.storage.daki_projects import DakiNotFoundError


def register_daki_personal_style_routes(app, store, key_provider=None):
    generation_lock = threading.Lock()

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
            data = body()
            style = (store.save_with_image(data) if 'representative_image' in data
                     else store.create(data))
            return jsonify(status='success', style=public(style)), 201
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

    @app.route('/api/daki/personal-styles/generate', methods=['POST'])
    @handle_errors
    def daki_personal_style_generate():
        data = body()
        payload = store.generation_payload(data)
        parameters = payload['parameters']
        if (parameters['width'] * parameters['height'] > 1048576 or parameters['steps'] > 28):
            if data.get('allow_anlas') is not True:
                return jsonify(status='error', code='anlas_confirmation',
                               message='이 설정은 Anlas가 소모될 수 있습니다. 사용에 동의한 뒤 실행해 주세요.'), 409
        key = key_provider() if callable(key_provider) else None
        if not isinstance(key, str) or not key.strip():
            return jsonify(status='error', code='api_key_required',
                           message='NovelAI API Key를 먼저 설정해 주세요.'), 400
        if not generation_lock.acquire(blocking=False):
            return jsonify(status='error', code='generation_in_progress',
                           message='개인 그림체 미리보기를 이미 생성하고 있습니다.'), 409
        image = None
        try:
            seed = secrets.randbelow(2 ** 32)
            parameters.update(seed=seed, extra_noise_seed=seed, n_samples=1)
            try:
                image = generate_text_image(key.strip(), payload)
                output = BytesIO()
                image.save(output, format='PNG')
                encoded = base64.b64encode(output.getvalue()).decode('ascii')
            except Exception:
                return jsonify(status='error', code='generation_failed',
                               message='미리보기 생성 요청에 실패했습니다.'), 502
            return jsonify(status='success', image='data:image/png;base64,' + encoded)
        finally:
            if image is not None:
                image.close()
            generation_lock.release()

    @app.route('/api/daki/personal-styles/<style_id>', methods=['GET', 'PUT', 'DELETE'])
    @handle_errors
    def daki_personal_style(style_id):
        if request.method == 'DELETE':
            store.remove_style(style_id)
            return jsonify(status='success')
        if request.method == 'PUT':
            data = body()
            style = (store.save_with_image(data, style_id=style_id) if 'representative_image' in data
                     else store.update(style_id, data))
        else:
            style = store.get_style(style_id)
        return jsonify(status='success', style=public(style))

    @app.route('/api/daki/personal-styles/<style_id>/preview', methods=['GET'])
    @handle_errors
    def daki_personal_style_preview(style_id):
        return send_file(store.preview_path(style_id, full=request.args.get('full') == '1'))

    return store
