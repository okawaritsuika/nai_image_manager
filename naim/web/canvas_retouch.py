"""Canvas retouch preview, mask, detail, and apply routes."""
import base64
import binascii
import hashlib
import io
import json
import math
import re
import threading
import uuid
import warnings
from collections import OrderedDict
from copy import deepcopy
from urllib.parse import unquote, urlsplit
import zipfile

from flask import Response, jsonify, request
from naim.images.retouch_preview import PreviewCache


MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_PIXELS = 160_000_000
MAX_COMPLETED_JOBS = 32
_DATA_URI = re.compile(r'^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$', re.IGNORECASE)


class CanvasRetouchController:
    """Owns a single apply slot and a bounded in-memory job registry."""

    def __init__(self):
        self.jobs = OrderedDict()
        self.jobs_lock = threading.Lock()
        self.apply_lock = threading.Lock()
        self.render_lock = threading.Lock()
        self.preview_cache = PreviewCache()

    def get_job(self, job_id):
        with self.jobs_lock:
            job = self.jobs.get(job_id)
            return deepcopy(job) if job is not None else None

    def add_job(self, job):
        with self.jobs_lock:
            self.jobs[job['id']] = job
            self._trim_completed_locked()

    def update_job(self, job_id, **updates):
        with self.jobs_lock:
            job = self.jobs.get(job_id)
            if job is not None:
                job.update(updates)
                self.jobs.move_to_end(job_id)
                self._trim_completed_locked()

    def _trim_completed_locked(self):
        completed = [key for key, job in self.jobs.items() if job['status'] != 'running']
        while len(completed) > MAX_COMPLETED_JOBS:
            key = completed.pop(0)
            self.jobs.pop(key, None)


def register_canvas_retouch_routes(app, read_source, save_image):
    """Register canvas retouch endpoints using injected image I/O adapters."""
    controller = CanvasRetouchController()

    def json_error(message, status):
        return jsonify({'status': 'error', 'message': message, 'error': message}), status

    def render_busy_response():
        return json_error('다른 캔버스 이미지 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.', 409)

    def acquire_sync_render():
        if controller.apply_lock.locked():
            return False
        return controller.render_lock.acquire(blocking=False)

    def load_engine():
        try:
            from naim.images import retouch
            return retouch, None
        except (ImportError, ModuleNotFoundError):
            return None, json_error('보정에 필요한 이미지 모듈이 없습니다. 설치 도구에서 필수 패키지를 설치해 주세요.', 503)

    def read_json_body():
        # The only unusually large legal request is a base64 data URI for a 512 MiB image.
        if request.content_length is not None and request.content_length > MAX_SOURCE_BYTES * 4 // 3 + 2 * 1024 * 1024:
            raise ValueError('요청 크기가 한도를 넘었습니다.')
        body = request.get_json(silent=True)
        if not isinstance(body, dict):
            raise ValueError('요청 본문은 JSON 객체여야 합니다.')
        return body

    def read_source_bytes(value):
        if not isinstance(value, str) or not value:
            raise ValueError('원본 이미지가 필요합니다.')
        if len(value) > MAX_SOURCE_BYTES * 4 // 3 + 512:
            raise ValueError('원본 이미지가 512MB 한도를 넘었습니다.')
        match = _DATA_URI.fullmatch(value)
        if match:
            encoded = match.group(2)
            if len(encoded) > ((MAX_SOURCE_BYTES + 2) // 3) * 4:
                raise ValueError('원본 이미지가 512MB 한도를 넘었습니다.')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise ValueError('이미지 데이터가 올바르지 않습니다.') from None
        else:
            parts = urlsplit(value)
            if parts.scheme or parts.netloc or value.startswith('//') or parts.query or parts.fragment:
                raise ValueError('같은 출처의 캔버스 이미지 참조만 사용할 수 있습니다.')
            path = unquote(parts.path)
            if ('\\' in path or '\x00' in path or any(part == '..' for part in path.split('/')) or
                    not path.startswith(('/canvas-imports/', 'canvas_imports/', '/image/'))):
                raise ValueError('같은 출처의 캔버스 이미지 참조만 사용할 수 있습니다.')
            try:
                raw = read_source(value)
            except Exception:
                raise ValueError('원본 이미지를 읽을 수 없습니다.') from None
            if not isinstance(raw, bytes):
                raise ValueError('원본 이미지 데이터가 올바르지 않습니다.')
        if not raw or len(raw) > MAX_SOURCE_BYTES:
            raise ValueError('원본 이미지는 512MB 이하이어야 합니다.')
        return raw

    def inspect_source(raw):
        from PIL import Image

        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    width, height = image.size
                    image_format = image.format
                    if image_format not in {'PNG', 'JPEG', 'WEBP'}:
                        raise ValueError('PNG, JPEG 또는 WebP 이미지만 사용할 수 있습니다.')
                    if width < 1 or height < 1 or width * height > MAX_PIXELS:
                        raise ValueError('이미지 크기는 최대 160MP까지 사용할 수 있습니다.')
                    if image.getexif().get(274) in {5, 6, 7, 8}:
                        width, height = height, width
                with Image.open(io.BytesIO(raw)) as image:
                    image.verify()
        except ValueError:
            raise
        except Exception:
            raise ValueError('원본 이미지가 올바르지 않습니다.') from None
        return width, height

    def validate_layers(engine, value):
        if not isinstance(value, list):
            raise ValueError('레이어 목록이 올바르지 않습니다.')
        snapshot = {'layers': value}
        engine.validate_side(snapshot)
        return deepcopy(value)

    def validate_print(engine, value):
        if value is None:
            value = {}
        if not isinstance(value, dict):
            raise ValueError('인쇄 크기 설정이 올바르지 않습니다.')
        engine._validate_tree(value)

        def bound(key, low, high, default):
            if key not in value:
                return default
            raw = value[key]
            if isinstance(raw, bool):
                raise ValueError('인쇄 크기 설정은 숫자여야 합니다.')
            try:
                number = float(raw)
            except (TypeError, ValueError, OverflowError):
                raise ValueError('인쇄 크기 설정은 숫자여야 합니다.') from None
            if not math.isfinite(number):
                raise ValueError('유한한 인쇄 크기만 사용할 수 있습니다.')
            return engine.number(number, low, high, default)

        return {
            'widthCm': bound('widthCm', 1, 300, 50),
            'heightCm': bound('heightCm', 1, 400, 160),
            'safeMm': bound('safeMm', 0, 100, 5),
        }

    def png_response(image, **save_options):
        stream = io.BytesIO()
        image.save(stream, format='PNG', **save_options)
        return Response(stream.getvalue(), mimetype='image/png')

    @app.post('/api/canvas/retouch/preview')
    def canvas_retouch_preview():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not acquire_sync_render():
            return render_busy_response()
        try:
            try:
                raw = read_source_bytes(body.get('source'))
            except ValueError as exc:
                return json_error(str(exc), 400)
            key = hashlib.sha256(raw).digest()
            cached = controller.preview_cache.get(key)
            if cached is None:
                controller.preview_cache.clear()
                try:
                    source_size = inspect_source(raw)
                except ValueError as exc:
                    return json_error(str(exc), 400)
                prepared = engine.render(io.BytesIO(raw), {'layers': []}, max_edge=1600)
                controller.preview_cache.store(key, prepared, source_size)
                cached = (prepared, source_size)
            prepared, source_size = cached
            scale = min(1, 1600 / max(source_size))
            has_clone = any(layer['type'] == 'clone' and engine._has_effect(layer) for layer in layers)
            if has_clone:
                # Clone samples document-space source pixels, so keep its existing full-source path.
                image = engine.render(io.BytesIO(raw), {'layers': layers}, max_edge=1600)
            else:
                image = engine.render_preview(
                    prepared, {'layers': layers}, scale,
                    mask_cache=controller.preview_cache.masks,
                )
            with image:
                return png_response(image, icc_profile=engine.SRGB)
        except Exception:
            return json_error('미리보기 이미지를 만들지 못했습니다.', 500)
        finally:
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/viewport')
    def canvas_retouch_viewport():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            region = body.get('region')
            if not isinstance(region, dict):
                raise ValueError('확대 영역 설정이 올바르지 않습니다.')
            coordinates = []
            for key, low, high in (('x', 0, 100000), ('y', 0, 100000),
                                   ('width', 1, 100000), ('height', 1, 100000)):
                value = region.get(key)
                if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                    raise ValueError('확대 영역 좌표가 올바르지 않습니다.')
                coordinates.append(value)
            scale = body.get('scale')
            if (isinstance(scale, bool) or not isinstance(scale, (int, float)) or
                    not 0 < scale <= 1 or not math.isfinite(scale)):
                raise ValueError('확대 영역 배율이 올바르지 않습니다.')
            if 'original' in body and not isinstance(body['original'], bool):
                raise ValueError('원본 보기 설정이 올바르지 않습니다.')

            def checked_output_size(width, height):
                output_width = max(1, round(width * scale))
                output_height = max(1, round(height * scale))
                if max(output_width, output_height) > 4096 or output_width * output_height > 4194304:
                    raise ValueError('확대 영역 출력 크기가 너무 큽니다.')
                return output_width, output_height

            checked_output_size(coordinates[2], coordinates[3])
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not acquire_sync_render():
            return render_busy_response()
        try:
            try:
                raw = read_source_bytes(body.get('source'))
                width, height = inspect_source(raw)
                x, y, requested_width, requested_height = coordinates
                if x >= width or y >= height:
                    raise ValueError('확대 영역이 원본 이미지 밖에 있습니다.')
                clamped_width = min(requested_width, width - x)
                clamped_height = min(requested_height, height - y)
                checked_output_size(clamped_width, clamped_height)
            except ValueError as exc:
                return json_error(str(exc), 400)
            image = engine.render(
                io.BytesIO(raw),
                {'layers': [] if body.get('original', False) else layers},
                region=(x, y, clamped_width, clamped_height),
                region_scale=scale,
            )
            with image:
                return png_response(image, icc_profile=engine.SRGB)
        except Exception:
            return json_error('확대 미리보기를 만들지 못했습니다.', 500)
        finally:
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/mask')
    def canvas_retouch_mask():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            layer_id = body.get('layerId')
            if not isinstance(layer_id, str) or not layer_id or len(layer_id) > 100:
                raise ValueError('레이어 ID가 올바르지 않습니다.')
            layer = next((item for item in layers if item['id'] == layer_id), None)
            if layer is None:
                raise ValueError('레이어를 찾을 수 없습니다.')
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not acquire_sync_render():
            return render_busy_response()
        try:
            try:
                raw = read_source_bytes(body.get('source'))
                width, height = inspect_source(raw)
            except ValueError as exc:
                return json_error(str(exc), 400)
            scale = min(1, 1600 / max(width, height))
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
            image = engine.mask_image(layer, size, scale, (0, 0))
            with image:
                return png_response(image)
        except Exception:
            return json_error('마스크 미리보기를 만들지 못했습니다.', 500)
        finally:
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/detail')
    def canvas_retouch_detail():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            if 'original' in body and not isinstance(body['original'], bool):
                raise ValueError('원본 보기 설정이 올바르지 않습니다.')
            coordinates = []
            for key in ('x', 'y'):
                value = body.get(key)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    raise ValueError('상세 영역 좌표가 올바르지 않습니다.')
                coordinates.append(int(round(value)))
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not acquire_sync_render():
            return render_busy_response()
        try:
            try:
                raw = read_source_bytes(body.get('source'))
                width, height = inspect_source(raw)
            except ValueError as exc:
                return json_error(str(exc), 400)
            x = min(width - 1, max(0, coordinates[0]))
            y = min(height - 1, max(0, coordinates[1]))
            region = (x, y, min(512, width - x), min(512, height - y))
            if body.get('original', False):
                layers = []
            image = engine.render(io.BytesIO(raw), {'layers': layers}, region=region)
            with image:
                return png_response(image, icc_profile=engine.SRGB)
        except Exception:
            return json_error('상세 이미지를 만들지 못했습니다.', 500)
        finally:
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/apply')
    def canvas_retouch_apply():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            print_spec = validate_print(engine, body.get('print'))
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not controller.apply_lock.acquire(blocking=False):
            return json_error('이미지 보정 작업이 진행 중입니다.', 409)
        if not controller.render_lock.acquire(blocking=False):
            controller.apply_lock.release()
            return render_busy_response()
        try:
            raw = read_source_bytes(body.get('source'))
            width, height = inspect_source(raw)
        except ValueError as exc:
            controller.render_lock.release()
            controller.apply_lock.release()
            return json_error(str(exc), 400)
        except Exception:
            controller.render_lock.release()
            controller.apply_lock.release()
            return json_error('원본 이미지를 확인하지 못했습니다.', 400)
        else:
            controller.render_lock.release()

        job_id = uuid.uuid4().hex
        initial_job = {
            'id': job_id,
            'status': 'running',
            'progress': 0,
            'message': '이미지를 보정하고 있습니다.',
        }
        controller.add_job(initial_job)

        def render_worker(source_bytes, layer_snapshot, print_snapshot, source_size):
            image = None
            render_acquired = False
            try:
                controller.render_lock.acquire()
                render_acquired = True
                controller.preview_cache.clear()
                image = engine.render(
                    io.BytesIO(source_bytes),
                    {'layers': layer_snapshot},
                    progress=lambda value, name: controller.update_job(
                        job_id, progress=min(.85, max(0, value * .85)), message=f'{name} 보정 중입니다.',
                    ),
                )
                controller.update_job(job_id, progress=0.9, message='원본 크기 PNG를 저장하고 있습니다.')
                dpi = source_size[0] / (print_snapshot['widthCm'] / 2.54)
                output = io.BytesIO()
                image.save(output, format='PNG', icc_profile=engine.SRGB, dpi=(dpi, dpi))
                public_src, _rel_path = save_image(
                    output.getvalue(), prefix='canvas_import_retouch', category='retouch', session_id=None,
                )
                controller.update_job(
                    job_id,
                    status='done',
                    progress=1,
                    message='이미지 보정이 끝났습니다.',
                    result={'src': public_src, 'width': image.width, 'height': image.height},
                )
            except Exception:
                controller.update_job(
                    job_id,
                    status='error',
                    progress=0,
                    message='이미지를 보정하거나 저장하지 못했습니다.',
                )
            finally:
                try:
                    if image is not None:
                        image.close()
                finally:
                    del source_bytes
                    if render_acquired:
                        controller.render_lock.release()
                    controller.apply_lock.release()

        try:
            worker = threading.Thread(
                target=render_worker,
                args=(raw, layers, print_spec, (width, height)),
                name='canvas-retouch-render',
                daemon=True,
            )
            worker.start()
        except Exception:
            controller.update_job(job_id, status='error', progress=0, message='보정 작업을 시작하지 못했습니다.')
            controller.apply_lock.release()
            return json_error('보정 작업을 시작하지 못했습니다.', 500)
        return jsonify({'status': 'success', 'job': deepcopy(initial_job)}), 202

    @app.post('/api/canvas/retouch/export-pair')
    def canvas_retouch_export_pair():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            print_spec = validate_print(engine, body.get('print'))
            side = body.get('side')
            if not isinstance(side, str) or side not in {'front', 'back'}:
                raise ValueError('면은 front 또는 back이어야 합니다.')
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not acquire_sync_render():
            return render_busy_response()

        current_image = other_image = None
        try:
            current_raw = read_source_bytes(body.get('source'))
            current_size = inspect_source(current_raw)
            other_raw = read_source_bytes(body.get('otherSource'))
            other_size = inspect_source(other_raw)
            controller.preview_cache.clear()
            current_image = engine.render(io.BytesIO(current_raw), {'layers': layers})
            other_image = engine.render(io.BytesIO(other_raw), {'layers': []})

            def png_bytes(image, source_size):
                output = io.BytesIO()
                dpi = source_size[0] / (print_spec['widthCm'] / 2.54)
                image.save(output, format='PNG', icc_profile=engine.SRGB, dpi=(dpi, dpi))
                return output.getvalue()

            front_bytes = png_bytes(current_image if side == 'front' else other_image,
                                    current_size if side == 'front' else other_size)
            back_bytes = png_bytes(other_image if side == 'front' else current_image,
                                   other_size if side == 'front' else current_size)
            metadata = {
                'widthCm': print_spec['widthCm'],
                'heightCm': print_spec['heightCm'],
                'safeMm': print_spec['safeMm'],
                'guides_included': False,
            }
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as bundle:
                bundle.writestr('daki-front.png', front_bytes)
                bundle.writestr('daki-back.png', back_bytes)
                bundle.writestr('print-info.json', json.dumps(metadata, ensure_ascii=False).encode('utf-8'))
            return Response(
                archive.getvalue(),
                mimetype='application/zip',
                headers={'Content-Disposition': 'attachment; filename="daki-canvas.zip"'},
            )
        except ValueError as exc:
            return json_error(str(exc), 400)
        except Exception:
            return json_error('양면 출력 파일을 만들지 못했습니다.', 500)
        finally:
            try:
                if current_image is not None:
                    current_image.close()
            finally:
                try:
                    if other_image is not None:
                        other_image.close()
                finally:
                    controller.render_lock.release()

    @app.get('/api/canvas/retouch/jobs/<job_id>')
    def canvas_retouch_job(job_id):
        job = controller.get_job(job_id)
        if job is None:
            return json_error('작업을 찾을 수 없습니다.', 404)
        return jsonify({'status': 'success', 'job': job})

    return controller
