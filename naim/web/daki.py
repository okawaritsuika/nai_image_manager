"""Daki library HTTP endpoints with injected storage and gallery resolution."""
from datetime import datetime, timezone
from functools import lru_cache, wraps
import os
import stat
from urllib.parse import quote

from flask import jsonify, request
from PIL import Image

from naim.images.dimensions import get_display_image_dimensions
from naim.images.project_deletion import (
    ProjectImageReferencesConflict, delete_project_candidate_image,
)
from naim.paths import get_file_creation_time
from naim.storage.daki_projects import (
    DakiCanvasConflict, DakiNotFoundError, DakiProjectSettingsConflict,
    DakiProjectsStore, SIDES, canvas_metadata,
)


def register_daki_routes(app, store_path_provider, resolve_source, clean_path=None, *,
                         deletion_references=None, image_deleted=None):
    """Register routes and return the store for gallery deletion checks.

    Providers are called at request time, allowing portable paths and isolated
    tests to use the same routes without importing the global application.
    """
    store = DakiProjectsStore(store_path_provider, resolve_source, clean_path)

    @lru_cache(maxsize=512)
    def image_dimensions(path, mtime_ns, file_size):
        # Cache only derived metadata; source changes invalidate it without
        # adding dimensions to the saved project or loading browser originals.
        try:
            return get_display_image_dimensions(path)
        except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
            return None, None

    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except (DakiNotFoundError, FileNotFoundError) as error:
                return jsonify({'status': 'error', 'message': str(error)}), 404
            except ProjectImageReferencesConflict as error:
                return jsonify({
                    'status': 'error', 'code': 'daki_references',
                    'message': str(error), 'references': error.references,
                }), 409
            except DakiProjectSettingsConflict as error:
                return jsonify({
                    'status': 'error', 'code': 'project_settings_conflict',
                    'message': str(error),
                }), 409
            except DakiCanvasConflict as error:
                return jsonify({
                    'status': 'error', 'code': 'canvas_conflict', 'message': str(error),
                }), 409
            except ValueError as error:
                return jsonify({'status': 'error', 'message': str(error)}), 400
            except OSError:
                return jsonify({'status': 'error', 'message': '다키 프로젝트를 읽거나 저장하지 못했습니다.'}), 500
        return handler

    def body():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ValueError('요청 내용은 JSON 객체여야 합니다.')
        return data

    def public_project(project, *, include_dimensions=True):
        # Project settings contain prompt text and have a dedicated lightweight
        # endpoint; broad project summaries only expose canvas metadata.
        project.pop('canvasSettings', None)
        project.pop('detailPromptPresets', None)
        for side in SIDES:
            for candidate in project['candidates'][side]:
                relative = candidate['path']
                missing = True
                candidate['created_at'] = None
                candidate['updated_at'] = None
                if include_dimensions:
                    candidate['width'] = None
                    candidate['height'] = None
                try:
                    full_path, actual_relative = store.resolve_image(relative)
                    file_stat = os.stat(full_path)
                    missing = not stat.S_ISREG(file_stat.st_mode)
                    if not missing:
                        relative = actual_relative
                        candidate['path'] = actual_relative
                        if os.path.splitext(actual_relative)[1].lower() == '.webp':
                            name = candidate.get('name')
                            if isinstance(name, str):
                                stem, extension = os.path.splitext(name)
                                if extension.lower() in ('.png', '.jpg', '.jpeg'):
                                    candidate['name'] = stem + '.webp'
                        if include_dimensions:
                            candidate['width'], candidate['height'] = image_dimensions(
                                full_path, file_stat.st_mtime_ns, file_stat.st_size,
                            )
                        try:
                            created_at = get_file_creation_time(full_path, file_stat.st_mtime)
                            candidate['created_at'] = datetime.fromtimestamp(
                                created_at, timezone.utc,
                            ).isoformat(timespec='milliseconds')
                            candidate['updated_at'] = datetime.fromtimestamp(
                                file_stat.st_mtime, timezone.utc,
                            ).isoformat(timespec='milliseconds')
                        except (OSError, OverflowError, TypeError, ValueError):
                            candidate['created_at'] = None
                            candidate['updated_at'] = None
                except (OSError, ValueError):
                    pass
                candidate['missing'] = missing
                candidate['src'] = '/image/' + quote(relative, safe='/')
        if 'canvases' in project:
            project['canvases'] = {
                side: [
                    canvas_metadata(canvas) if 'state' in canvas else canvas
                    for canvas in project['canvases'].get(side, [])
                ]
                for side in SIDES
            }
        return project

    @app.route('/api/daki/settings', methods=['GET', 'PUT'], endpoint='daki_settings')
    @handle_errors
    def settings():
        values = store.settings() if request.method == 'GET' else store.set_enabled(body().get('enabled'))
        return jsonify({'status': 'success', **values})

    @app.route('/api/daki/projects', methods=['GET', 'POST'], endpoint='daki_projects')
    @handle_errors
    def projects():
        if request.method == 'GET':
            return jsonify({'status': 'success', 'projects': [
                public_project(project, include_dimensions=False)
                for project in store.list_projects(summary=True)
            ]})
        data = body()
        project = store.create_project(
            data.get('name'), data.get('path'), data.get('side'), canvas=data.get('canvas'),
        )
        return jsonify({'status': 'success', 'project': public_project(project)}), 201

    @app.route('/api/daki/projects/<project_id>', methods=['GET'], endpoint='daki_project')
    @handle_errors
    def project(project_id):
        return jsonify({
            'status': 'success',
            'project': public_project(store.get_project(project_id, summary=True)),
        })

    @app.route(
        '/api/daki/projects/<project_id>/canvas-settings',
        methods=['GET', 'PUT'], endpoint='daki_project_canvas_settings',
    )
    @handle_errors
    def project_canvas_settings(project_id):
        if request.method == 'GET':
            settings = store.get_canvas_settings(project_id)
        else:
            data = body()
            settings = store.update_canvas_settings(
                project_id, data.get('settings'), data.get('revision'),
            )
        return jsonify({'status': 'success', 'settings': settings})

    @app.route('/api/daki/projects/<project_id>/candidates', methods=['POST'], endpoint='daki_add_candidate')
    @handle_errors
    def add_candidate(project_id):
        data = body()
        project = store.add_candidate(project_id, data.get('path'), data.get('side'))
        return jsonify({'status': 'success', 'project': public_project(project)})

    @app.route('/api/daki/projects/<project_id>/candidates/<candidate_id>', methods=['DELETE'], endpoint='daki_remove_candidate')
    @handle_errors
    def remove_candidate(project_id, candidate_id):
        project = store.remove_candidate(project_id, candidate_id)
        return jsonify({'status': 'success', 'project': public_project(project)})

    @app.route('/api/daki/projects/<project_id>/candidates/<candidate_id>/delete', methods=['POST'], endpoint='daki_delete_candidate_image')
    @handle_errors
    def delete_candidate_image(project_id, candidate_id):
        data = body()
        project, source, relative = delete_project_candidate_image(
            store, project_id, candidate_id,
            confirm_daki=data.get('confirm_daki', False),
            references_provider=deletion_references,
        )
        result = {'status': 'success', 'project': public_project(project)}
        if image_deleted:
            try:
                image_deleted(source, relative)
            except Exception:
                result['warning'] = '그림은 삭제했지만 갤러리 색인을 갱신하지 못했습니다. 갤러리를 새로고침해 주세요.'
        return jsonify(result)

    @app.route('/api/daki/projects/<project_id>/canvases', methods=['POST'], endpoint='daki_create_canvas')
    @handle_errors
    def create_canvas(project_id):
        canvas = store.create_canvas(project_id, body())
        project = store.get_project(project_id)
        return jsonify({
            'status': 'success',
            'canvas': canvas_metadata(canvas),
            'project': {'id': project['id'], 'name': project['name']},
        }), 201

    @app.route('/api/daki/projects/<project_id>/canvases/<canvas_id>', methods=['GET'], endpoint='daki_canvas')
    @handle_errors
    def get_canvas(project_id, canvas_id):
        project, canvas = store.get_canvas_with_project(
            project_id, canvas_id, preview=request.args.get('preview') == '1',
        )
        return jsonify({
            'status': 'success', 'canvas': canvas,
            'project': project,
        })

    @app.route('/api/daki/projects/<project_id>/canvases/<canvas_id>', methods=['PUT'], endpoint='daki_update_canvas')
    @handle_errors
    def update_canvas(project_id, canvas_id):
        data = body()
        canvas = store.update_canvas(
            project_id, canvas_id, data.get('state'), data.get('revision'),
        )
        project = store.get_project(project_id)
        return jsonify({
            'status': 'success',
            'canvas': canvas_metadata(canvas),
            'project': {'id': project['id'], 'name': project['name']},
        })

    @app.route('/api/daki/projects/<project_id>/canvases/<canvas_id>', methods=['DELETE'], endpoint='daki_remove_canvas')
    @handle_errors
    def remove_canvas(project_id, canvas_id):
        project = store.remove_canvas(project_id, canvas_id)
        return jsonify({'status': 'success', 'project': public_project(project)})

    @app.route('/api/daki/references', methods=['POST'], endpoint='daki_references')
    @handle_errors
    def references():
        data = body()
        matches = store.references(data.get('paths', []), data.get('folders', []))
        return jsonify({'status': 'success', 'references': matches})

    return store
