"""HTTP boundary for the public shared-test download jobs."""
from functools import wraps

from flask import jsonify, request

from naim.daki_test_packs import DakiTestPacks


def register_daki_test_pack_routes(app, tests):
    manager = DakiTestPacks(tests)

    def guarded(function):
        @wraps(function)
        def handler(*args, **kwargs):
            try:
                return function(*args, **kwargs)
            except ValueError as error:
                return jsonify(status='error', message=str(error)), 400
            except OSError:
                return jsonify(status='error', message='공유 테스트 자료를 읽거나 저장하지 못했습니다.'), 500
        return handler

    @app.route('/api/daki/style-test-packs', methods=['GET', 'POST'])
    @guarded
    def daki_test_packs():
        if request.method == 'GET':
            return jsonify(status='success', **manager.catalog())
        return jsonify(status='success', job=manager.start(request.get_json(silent=True)))

    @app.route('/api/daki/style-test-packs/job', methods=['GET'])
    def daki_test_pack_job():
        return jsonify(status='success', job=manager.status())

    @app.route('/api/daki/style-test-packs/stop', methods=['POST'])
    def daki_test_pack_stop():
        return jsonify(status='success', job=manager.stop())

    return manager
