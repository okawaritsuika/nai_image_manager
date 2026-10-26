"""Explicit archive/delete choice for a whole project."""
from flask import jsonify, request
import sqlite3

from naim.daki_style_tests import DakiStyleTestConflict
from naim.images.project_deletion import ProjectImageReferencesConflict
from naim.storage.daki_projects import DakiNotFoundError


def register_project_removal_routes(app, remove):
    @app.route('/api/daki/projects/<project_id>/delete', methods=['POST'], endpoint='daki_remove_project')
    def remove_project(project_id):
        try:
            data = request.get_json(silent=True)
            if not isinstance(data, dict):
                raise ValueError('삭제 요청을 확인해 주세요.')
            return jsonify(remove(project_id, data.get('action'), confirm_daki=data.get('confirm_daki', False)))
        except ProjectImageReferencesConflict as error:
            return jsonify(status='error', code='daki_references', message=str(error), references=error.references), 409
        except DakiStyleTestConflict as error:
            return jsonify(status='error', code='project_busy', message=str(error)), 409
        except (DakiNotFoundError, FileNotFoundError) as error:
            return jsonify(status='error', message=str(error)), 404
        except ValueError as error:
            return jsonify(status='error', message=str(error)), 400
        except (OSError, sqlite3.Error):
            return jsonify(status='error', message='프로젝트를 정리하지 못했습니다. 자료를 확인한 뒤 다시 시도해 주세요.'), 500
