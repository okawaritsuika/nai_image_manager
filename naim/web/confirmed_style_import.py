"""Copy confirmed recipes from the linked artist app into personal storage."""
from functools import wraps
from urllib.parse import quote

import requests
from flask import jsonify, request, Response

from naim.daki_style_tests import GENERATION_DEFAULTS
from naim.storage.daki_projects import DakiNotFoundError


class ConfirmedStyleSource:
    def __init__(self, service):
        self.service = service

    def fetch(self, suffix, *, origin, image=False):
        port = self.service.start(origin)
        try:
            with requests.Session() as session:
                session.trust_env = False
                with session.get(f'http://127.0.0.1:{port}' + suffix,
                                 timeout=(5, 30), allow_redirects=False, stream=image) as response:
                    if response.status_code == 404:
                        raise DakiNotFoundError('확정 그림체 또는 대표 그림을 찾을 수 없습니다.')
                    if response.status_code != 200:
                        raise RuntimeError('확정 그림체를 불러오지 못했습니다. 그림체 관리 연결을 확인해 주세요.')
                    if not image:
                        return response.json()
                    data = bytearray()
                    for chunk in response.iter_content(65536):
                        data.extend(chunk)
                        if len(data) > 32 * 1024 * 1024:
                            raise ValueError('대표 그림은 32MB 이하여야 합니다.')
                    return bytes(data), response.headers.get('Content-Type', 'application/octet-stream')
        except (requests.RequestException, requests.exceptions.JSONDecodeError):
            raise RuntimeError('그림체 관리 앱에 연결하지 못했습니다. 다시 시도해 주세요.') from None


def _recipe(source):
    options = {key: source[key] for key in GENERATION_DEFAULTS if source.get(key) not in (None, '')}
    if source.get('scale') is not None:
        options['cfg'] = source['scale']
    return {
        'name': source.get('name') or '가져온 확정 그림체',
        'positive': source.get('artist_prompt') or '',
        'negative': source.get('negative_prompt') or '',
        'model': source.get('model') or 'nai-diffusion-5-full',
        'options': options,
        'preview': {'width': source.get('width') or 832, 'height': source.get('height') or 1216},
    }


def register_confirmed_style_import(app, store, service, *, source=None):
    source = source or ConfirmedStyleSource(service)

    def handle_errors(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except (DakiNotFoundError, FileNotFoundError):
                return jsonify(status='error', message='확정 그림체 또는 대표 그림을 찾을 수 없습니다.'), 404
            except (ValueError, TypeError):
                return jsonify(status='error', message='그림체 프롬프트·모델·생성 설정 또는 대표 그림을 확인해 주세요.'), 400
            except RuntimeError as error:
                return jsonify(status='error', message=str(error)), 503
            except OSError:
                return jsonify(status='error', message='개인 그림체를 저장하지 못했습니다. 다시 시도해 주세요.'), 500
        return wrapped

    def detail(style_id):
        if type(style_id) is not int or style_id < 1:
            raise ValueError('Invalid confirmed style id')
        record = source.fetch(f'/api/confirmed-styles/{style_id}', origin=request.host_url)
        if not isinstance(record, dict):
            raise ValueError('Invalid confirmed style')
        return record

    def picture(item):
        path = item.get('image_path')
        if not isinstance(path, str) or not path:
            return None
        return source.fetch('/confirmed-style-images/' + quote(path, safe='/'), origin=request.host_url, image=True)

    @app.get('/api/daki/confirmed-styles')
    @handle_errors
    def confirmed_styles():
        records = source.fetch('/api/confirmed-styles', origin=request.host_url)
        if not isinstance(records, list):
            raise ValueError('Invalid confirmed styles response')
        styles = []
        for record in records:
            if not isinstance(record, dict) or type(record.get('id')) is not int:
                continue
            styles.append({**_recipe(record), 'id': record['id'],
                           'src': f'/api/daki/confirmed-styles/{record["id"]}/preview' if record.get('image_path') else ''})
        return jsonify(status='success', styles=styles)

    @app.get('/api/daki/confirmed-styles/<int:style_id>/preview')
    @handle_errors
    def confirmed_style_preview(style_id):
        image = picture(detail(style_id))
        if image is None:
            raise DakiNotFoundError('Missing confirmed preview')
        data, content_type = image
        if content_type.split(';')[0] not in ('image/png', 'image/jpeg', 'image/webp'):
            raise ValueError('Unsupported image')
        response = Response(data, content_type=content_type)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        return response

    @app.post('/api/daki/personal-styles/import-confirmed')
    @handle_errors
    def import_confirmed_style():
        if request.headers.get('Origin') not in (None, request.host_url.rstrip('/')):
            return jsonify(status='error', message='이 NAIM 화면에서 가져와 주세요.'), 403
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            raise ValueError('Invalid request')
        item = detail(body.get('style_id'))
        image = picture(item)
        style = store.create_snapshot(_recipe(item), image[0] if image else None)
        if style.get('source_path'):
            style['src'] = f'/api/daki/personal-styles/{style["id"]}/preview'
        return jsonify(status='success', style=style), 201
