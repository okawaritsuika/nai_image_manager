"""Saved tagged-image tournaments and their shared rankings."""
from functools import wraps

from flask import jsonify, request

from naim.storage.daki_projects import DakiNotFoundError
from naim.storage.daki_worldcups import DakiWorldCupConflict


def register_daki_worldcup_routes(app, store):
    def handle_errors(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except DakiWorldCupConflict as error:
                return jsonify(status='error', message=str(error)), 409
            except (DakiNotFoundError, FileNotFoundError):
                return jsonify(status='error', message='월드컵 기록을 찾을 수 없습니다.'), 404
            except (ValueError, TypeError) as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='월드컵 기록을 읽거나 저장하지 못했습니다.'), 500
        return handler

    @app.route('/api/daki/worldcups', methods=['GET', 'POST'])
    @handle_errors
    def daki_worldcups():
        if request.method == 'GET':
            return jsonify(status='success', records=store.list_records(request.args.get('gallery_key')))
        data = request.get_json(silent=True)
        return jsonify(status='success', record=store.create(data)), 201

    @app.route('/api/daki/worldcups/<record_id>', methods=['GET'])
    @handle_errors
    def daki_worldcup(record_id):
        return jsonify(status='success', record=store.get(record_id))

    return store
