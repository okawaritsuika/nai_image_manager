"""Shared styles and persistent generation comparisons in the gallery shell."""
from functools import wraps
from urllib.parse import quote

from flask import jsonify, request, send_file

from naim.daki_style_tests import DakiStyleTests, DakiStyleTestConflict, DakiAnlasConfirmation, SIZE_PRESETS, SIZE_LIMITS
from naim.storage.daki_shared_styles import DakiSharedStyles
from naim.storage.daki_projects import DakiNotFoundError
from naim.daki_style_filters import normalize_style_filters, matches_style_filters


def register_daki_style_routes(app, catalog_root_provider, tests_root_provider, key_provider, imported_root_provider=None, personal_catalog=None):
    catalog = DakiSharedStyles(catalog_root_provider, imported_root_provider)
    manager = DakiStyleTests(tests_root_provider, catalog, key_provider, personal_catalog=personal_catalog)
    from naim.web.daki_test_packs import register_daki_test_pack_routes
    manager.test_packs = register_daki_test_pack_routes(app, manager)

    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except DakiAnlasConfirmation as error:
                return jsonify(status='error', code='anlas_confirmation', message=str(error)), 409
            except DakiStyleTestConflict as error:
                return jsonify(status='error', message=str(error)), 409
            except (FileNotFoundError, KeyError, DakiNotFoundError):
                return jsonify(status='error', message='공유 그림체 또는 테스트 묶음을 찾을 수 없습니다.'), 404
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='공유 그림체 자료를 읽거나 저장하지 못했습니다.'), 500
        return handler

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return data

    def style_src(style):
        return '/api/daki/shared-styles/' + quote(style['id'], safe='') + '/preview'

    @app.route('/api/daki/shared-styles', methods=['GET'])
    @handle_errors
    def daki_shared_styles():
        summaries = []
        include_prompts = request.args.get('include_prompts') == '1'
        for style in catalog.list_styles():
            summaries.append({**{key: style.get(key) for key in ('id', 'name', 'model', 'category', 'source_url', 'source_image_id', 'seed',
                                                               'recommendation_count', 'recommendation_collected_at', 'sort_date')},
                              **({key: style.get(key, '') for key in ('positive', 'negative')} if include_prompts else {}),
                              'src': style_src(style), 'width': style['preview']['width'], 'height': style['preview']['height']})
        return jsonify(status='success', styles=summaries, configured=bool(key_provider()))

    @app.route('/api/daki/shared-styles/remove', methods=['POST'])
    @handle_errors
    def daki_shared_styles_remove():
        return jsonify(status='success', removed=catalog.remove_styles(body().get('style_ids')))

    @app.route('/api/daki/shared-styles/<style_id>', methods=['GET'])
    @handle_errors
    def daki_shared_style(style_id):
        style = catalog.get_style(style_id)
        return jsonify(status='success', style={**style, 'src': style_src(style)})

    @app.route('/api/daki/shared-styles/<style_id>/preview', methods=['GET'])
    @handle_errors
    def daki_shared_style_preview(style_id):
        return send_file(catalog.preview_path(style_id, full=request.args.get('full') == '1'))

    @app.route('/api/daki/style-tests/targets/filter', methods=['POST'])
    @handle_errors
    def daki_style_test_target_filter():
        data = body()
        library = data.get('library', 'shared')
        if library not in ('shared', 'personal'):
            raise ValueError('그림체 라이브러리를 확인해 주세요.')
        if library == 'personal' and personal_catalog is None:
            raise ValueError('개인 그림체 라이브러리를 사용할 수 없습니다.')
        filters = normalize_style_filters({
            'exclude_realistic': False,
            'include_query': data.get('include_query', ''),
            'exclude_tags': data.get('exclude_tags', []),
        })
        source = personal_catalog if library == 'personal' else catalog
        return jsonify(status='success', style_ids=[style['id'] for style in source.list_styles()
                       if matches_style_filters(style.get('positive', ''), filters)])

    @app.route('/api/daki/style-tests', methods=['GET', 'POST'])
    @handle_errors
    def daki_style_tests():
        if request.method == 'GET':
            return jsonify(status='success', batches=manager.list_batches())
        return jsonify(status='success', batch=manager.create(body())), 201

    @app.route('/api/daki/style-tests/upper', methods=['POST'])
    @handle_errors
    def daki_style_test_upper():
        return jsonify(status='success', batch=manager.ensure_upper_test())

    @app.route('/api/daki/style-tests/<batch_id>', methods=['GET'])
    @handle_errors
    def daki_style_test(batch_id):
        return jsonify(status='success', batch=manager.get(batch_id))

    @app.route('/api/daki/style-tests/<batch_id>/name', methods=['PUT'])
    @handle_errors
    def daki_style_test_name(batch_id):
        return jsonify(status='success', batch=manager.rename(batch_id, body().get('name')))

    @app.route('/api/daki/style-tests/<batch_id>/styles', methods=['POST'])
    @handle_errors
    def daki_style_test_append(batch_id):
        return jsonify(status='success', batch=manager.append_styles(batch_id, body().get('style_ids')))

    @app.route('/api/daki/style-tests/options', methods=['GET'])
    @handle_errors
    def daki_style_test_options():
        return jsonify(status='success', configured=bool(key_provider()), size_presets=SIZE_PRESETS, size_limits=SIZE_LIMITS)

    @app.route('/api/daki/style-tests/<batch_id>/settings', methods=['POST'])
    @handle_errors
    def daki_style_test_settings(batch_id):
        return jsonify(status='success', batch=manager.update_settings(batch_id, body()))

    @app.route('/api/daki/style-tests/<batch_id>/run', methods=['POST'])
    @handle_errors
    def daki_style_test_run(batch_id):
        data = body()
        return jsonify(status='success', batch=manager.run(batch_id, data.get('mode'), data.get('allow_anlas', False)))

    @app.route('/api/daki/style-tests/<batch_id>/stop', methods=['POST'])
    @handle_errors
    def daki_style_test_stop(batch_id):
        return jsonify(status='success', batch=manager.stop(batch_id))

    @app.route('/api/daki/style-tests/<batch_id>/images/<style_id>', methods=['GET'])
    @handle_errors
    def daki_style_test_image(batch_id, style_id):
        path = manager.image_path(batch_id, style_id, full=request.args.get('full') == '1')
        return send_file(path, mimetype='image/webp' if path.suffix.lower() == '.webp' else None)

    return manager
