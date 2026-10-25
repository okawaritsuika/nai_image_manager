"""Authenticated launcher-only cancellation before terminating its server."""
import hmac
import os


def register_job_shutdown(app, jobs, token, *, additional_jobs=()):
    def shutdown_jobs():
        from flask import jsonify, request
        supplied = request.headers.get('X-NAIM-Control', '')
        data = request.get_json(silent=True) or {}
        if (not token or not hmac.compare_digest(token.encode('utf-8'), supplied.encode('utf-8'))
                or not isinstance(data, dict) or data.get('pid') != os.getpid()):
            return jsonify({'status': 'error', 'message': '종료 요청을 확인할 수 없습니다.'}), 403
        results = [service.shutdown() for service in (jobs, *additional_jobs)]
        stopped = all(results)
        return jsonify({'status': 'success' if stopped else 'error', 'stopped': stopped}), 200 if stopped else 503

    app.route('/api/internal/shutdown_jobs', endpoint='shutdown_managed_jobs', methods=['POST'])(shutdown_jobs)
