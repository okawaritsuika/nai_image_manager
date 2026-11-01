"""Native style management, served by the NAIM process and bundled in its EXE."""
import threading
from pathlib import Path

from flask import jsonify, request, redirect
from werkzeug.middleware.dispatcher import DispatcherMiddleware


class StyleService:
    def __init__(self, app, root):
        self.parent = app
        self.root = Path(root)
        self.lock = threading.Lock()
        self.application = None
        self.workspace = None

    def start(self, origin=None):
        with self.lock:
            if self.workspace is None:
                from naim.style_manager import app as workspace
                from naim.style_manager.integration import install
                workspace.configure_data_directories([self.root / 'data/style_manager'])
                install(workspace, self.parent, self.root)
                self.workspace = workspace
            if self.application is None:
                self.workspace.init_db()
                self.application = self.workspace.app
        return '/style-workspace/?naim=1'

    def __call__(self, environ, start_response):
        try:
            self.start()
        except (OSError, ValueError, RuntimeError):
            from werkzeug.wrappers import Response
            return Response('그림체 관리 자료를 준비하지 못했습니다. NAIM 자료 폴더를 확인해 주세요.',
                            status=503, content_type='text/plain; charset=utf-8')(environ, start_response)
        return self.application(environ, start_response)

    def stop(self):
        # No helper process or separate Python runtime is created.
        return None


def register_style_workspace(app, app_dir):
    root = Path(app_dir)
    service = StyleService(app, root)
    app.extensions['style_manager'] = service
    app.wsgi_app = DispatcherMiddleware(app.wsgi_app, {'/style-workspace': service})

    @app.get('/style-manager')
    def style_workspace_page():
        return redirect('/style-workspace/?naim=1')

    @app.post('/api/style-workspace/connect')
    def style_workspace_connect():
        if request.headers.get('Origin') not in (None, request.host_url.rstrip('/')):
            return jsonify(ok=False, error='이 NAIM 화면에서 열어 주세요.'), 403
        if request.headers.get('X-NAIM-Workspace') != '1':
            return jsonify(ok=False, error='잘못된 요청입니다.'), 403
        try:
            return jsonify(ok=True, url=service.start())
        except (RuntimeError, OSError, ValueError):
            return jsonify(ok=False, error='그림체 관리 자료를 준비하지 못했습니다. 자료 폴더를 확인해 주세요.'), 503

    return service
