"""HTTP boundary for standalone image drafts in the Daki gallery."""
from functools import wraps

from flask import jsonify, request, send_file

from naim.daki_drafts import DakiDraftReferencesConflict, DakiDrafts
from naim.daki_style_tests import DakiAnlasConfirmation, DakiStyleTestConflict
from naim.images.daki_framing import FRAMING_LIMITS


def register_daki_draft_routes(app, root_provider, key_provider, generator=None,
                               excluded_draft_ids_provider=None, references_provider=None,
                               project_validator=None):
    manager = DakiDrafts(root_provider, key_provider, generator=generator,
                         excluded_draft_ids_provider=excluded_draft_ids_provider,
                         references_provider=references_provider)

    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except DakiAnlasConfirmation as error:
                return jsonify(status='error', code='anlas_confirmation', message=str(error)), 409
            except DakiDraftReferencesConflict as error:
                return jsonify(status='error', code='daki_references', references=error.references,
                               message=str(error)), 409
            except DakiStyleTestConflict as error:
                return jsonify(status='error', message=str(error)), 409
            except FileNotFoundError:
                return jsonify(status='error', message='시안 또는 생성 결과를 찾을 수 없습니다.'), 404
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='시안을 읽거나 저장하지 못했습니다.'), 500
        return handler

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return data

    @app.route('/api/daki/drafts', methods=['GET', 'POST'])
    @handle_errors
    def daki_drafts():
        if request.method == 'GET':
            return jsonify(status='success', drafts=manager.list_drafts(request.args.get('purpose')))
        return jsonify(status='success', draft=manager.create(body())), 201

    @app.route('/api/daki/drafts/<draft_id>', methods=['GET'])
    @handle_errors
    def daki_draft(draft_id):
        return jsonify(status='success', draft=manager.get(draft_id))

    @app.route('/api/daki/drafts/framing-options', methods=['GET'])
    def daki_draft_framing_options():
        return jsonify(status='success', limits=FRAMING_LIMITS)

    @app.route('/api/daki/drafts/<draft_id>/frame', methods=['POST'])
    @handle_errors
    def daki_draft_frame(draft_id):
        return jsonify(status='success', draft=manager.frame(draft_id, body())), 201

    @app.route('/api/daki/drafts/<draft_id>/retry', methods=['POST'])
    @handle_errors
    def daki_draft_retry(draft_id):
        return jsonify(status='success', draft=manager.retry(draft_id, body().get('allow_anlas', False)))

    @app.route('/api/daki/drafts/<draft_id>/image', methods=['GET'])
    @handle_errors
    def daki_draft_image(draft_id):
        return send_file(manager.image_path(draft_id, full=request.args.get('full') == '1'))

    @app.route('/api/daki/draft-folders', methods=['GET', 'POST'])
    @handle_errors
    def daki_draft_folders():
        if request.method == 'GET':
            project_id = request.args.get('project')
            if project_id is None:
                project_id = request.args.get('project_id')
            return jsonify(status='success', folders=manager.list_folders(project_id))
        data = body()
        if project_validator is not None:
            project_id = data.get('project_id')
            if not isinstance(project_id, str) or not project_id:
                raise ValueError('시안 폴더를 저장할 프로젝트를 선택해 주세요.')
            project_validator(project_id)
        return jsonify(status='success', folder=manager.create_folder(data)), 201

    @app.route('/api/daki/draft-folders/<folder_id>', methods=['GET', 'PUT'])
    @handle_errors
    def daki_draft_folder(folder_id):
        if request.method == 'GET':
            result = manager.get_folder(folder_id)
        else:
            result = manager.update_folder(folder_id, body())
        return jsonify(status='success', **result)

    @app.route('/api/daki/draft-folders/<folder_id>/delete', methods=['POST'])
    @handle_errors
    def daki_draft_folder_remove(folder_id):
        data = body()
        return jsonify(status='success', **manager.delete_folder(
            folder_id, confirm_daki=data.get('confirm_daki', False)))

    @app.route('/api/daki/drafts/<draft_id>/selection', methods=['PUT'])
    @handle_errors
    def daki_draft_selection(draft_id):
        return jsonify(status='success', draft=manager.set_selected(draft_id, body().get('selected')))

    @app.route('/api/daki/draft-folders/<folder_id>/delete-drafts', methods=['POST'])
    @handle_errors
    def daki_draft_folder_delete(folder_id):
        data = body()
        result = manager.delete_folder_drafts(
            folder_id, data.get('ids'), preserve_selected=data.get('preserve_selected', False),
            confirm_daki=data.get('confirm_daki', False))
        remaining = manager.get_folder(folder_id)
        return jsonify(status='success', **result, **remaining)

    return manager
