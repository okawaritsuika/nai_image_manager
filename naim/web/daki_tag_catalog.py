"""Dictionary HTTP boundary, separate from project data and generation."""
from functools import wraps

from flask import jsonify, request, send_file

from naim.daki_tag_catalog import DakiTagCatalog, DakiTagCatalogUnavailable
from naim.daki_tag_candidates import DakiTagCandidates


def register_daki_tag_catalog_routes(app, root_provider, candidate_provider=None, candidate_context=None,
                                    examples_store=None, example_preview=None):
    catalog = DakiTagCatalog(root_provider, examples_store)
    candidates = DakiTagCandidates(candidate_provider, candidate_context or (lambda: None)) if candidate_provider else None

    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except DakiTagCatalogUnavailable as error:
                return jsonify(status='error', message=str(error)), 404
            except (FileNotFoundError, KeyError):
                return jsonify(status='error', message='태그 또는 예시 그림 원본을 찾을 수 없습니다.'), 404
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='태그사전 또는 예시 정보를 읽거나 저장하지 못했습니다.'), 500
        return handler

    def flag(name):
        value = request.args.get(name, '0')
        if value not in {'0', '1'}:
            raise ValueError('태그사전 조회 옵션을 확인해 주세요.')
        return value == '1'

    @app.get('/api/daki/tag-catalog/categories')
    @handle_errors
    def daki_tag_catalog_categories():
        return jsonify(status='success', categories=catalog.categories())

    @app.get('/api/daki/tag-catalog/browse')
    @handle_errors
    def daki_tag_catalog_browse():
        return jsonify(status='success', **catalog.browse(request.args.get('category', 'all'),
            request.args.get('section', ''), request.args.get('q', ''), flag('examples'), request.args.get('page', '1')))

    @app.get('/api/daki/tag-catalog/detail')
    @handle_errors
    def daki_tag_catalog_detail():
        return jsonify(status='success', tag=catalog.detail(request.args.get('tag', '')))

    @app.get('/api/daki/tag-catalog/candidates')
    @handle_errors
    def daki_tag_catalog_candidates():
        tag = request.args.get('tag', '')
        catalog.detail(tag)
        if candidates is None:
            raise ValueError('예시 후보 검색을 사용할 수 없습니다.')
        return jsonify(status='success', **candidates.search(tag, request.args.get('page', '1')))

    @app.get('/api/daki/tag-catalog/example')
    @handle_errors
    def daki_tag_catalog_example():
        full = flag('full')
        example_id = request.args.get('id')
        path = catalog.example_path(request.args.get('tag', ''), request.args.get('index', '0'), full, example_id)
        if example_id is not None and not full and example_preview:
            return example_preview(path)
        return send_file(path)

    @app.post('/api/daki/tag-catalog/examples')
    @handle_errors
    def daki_tag_catalog_add_example():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        tag = data.get('tag')
        if not isinstance(tag, str):
            raise ValueError('예시를 추가할 태그를 확인해 주세요.')
        catalog.detail(tag)
        if examples_store is None:
            raise ValueError('태그 예시를 추가할 수 없습니다.')
        return jsonify(status='success', example=examples_store.add(tag, data.get('path')))

    @app.post('/api/daki/tag-catalog/translate')
    @handle_errors
    def daki_tag_catalog_translate():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return jsonify(status='success', **catalog.translate(data.get('text')))

    @app.post('/api/daki/tag-catalog/classify')
    @handle_errors
    def daki_tag_catalog_classify():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return jsonify(status='success', **catalog.classify_tokens(data.get('tokens')))

    return catalog
