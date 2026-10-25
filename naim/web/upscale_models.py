"""HTTP routes for optional upscale model assets."""
from flask import jsonify

from naim.upscale_assets import UPSCALE_ASSETS, UpscaleAssetConflict, UpscaleAssetError


def register_upscale_model_routes(app, assets=UPSCALE_ASSETS, busy=None):
    def response():
        return jsonify(status='success', models=assets.list())

    def handle_operation(operation, *, check_busy=False):
        try:
            if check_busy and busy is not None and busy():
                return jsonify(status='error', message='업스케일 작업 중에는 모델 자료를 변경할 수 없습니다.'), 409
            operation()
            return response()
        except UpscaleAssetConflict as error:
            return jsonify(status='error', message=str(error)), 409
        except (ValueError, TypeError):
            return jsonify(status='error', message='요청한 업스케일 모델을 찾을 수 없습니다.'), 400
        except UpscaleAssetError as error:
            return jsonify(status='error', message=str(error)), 500
        except OSError:
            return jsonify(status='error', message='업스케일 모델 자료를 처리하지 못했습니다.'), 500
        except Exception:
            return jsonify(status='error', message='업스케일 모델 자료를 처리하지 못했습니다.'), 500

    @app.get('/api/upscale/models')
    def upscale_models_list():
        try:
            return response()
        except Exception:
            return jsonify(status='error', message='업스케일 모델 목록을 읽지 못했습니다.'), 500

    @app.post('/api/upscale/models/<engine>/download')
    def upscale_models_download(engine):
        return handle_operation(lambda: assets.start_download(engine), check_busy=True)

    @app.post('/api/upscale/models/<engine>/cancel')
    def upscale_models_cancel(engine):
        return handle_operation(lambda: assets.cancel_download(engine))

    @app.post('/api/upscale/models/<engine>/delete')
    def upscale_models_delete(engine):
        return handle_operation(lambda: assets.delete(engine), check_busy=True)

    return assets
