"""Canvas retouch preview, mask, detail, and apply routes."""
import base64
import binascii
import hashlib
import io
import json
import math
import re
import struct
import threading
import uuid
import warnings
from collections import OrderedDict
from copy import deepcopy
from urllib.parse import unquote, urlsplit
import zipfile
import zlib

from flask import Response, jsonify, request
from PIL import Image
from naim.images.retouch_preview import (
    NATIVE_RESULT_MAX_PIXELS, PREVIEW_EDGE, WORKING_EDGE, PreviewCache, project_native_preview,
)
from naim.images.retouch_working import WorkingImage


MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_RENDER_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 160_000_000
MAX_COMPLETED_JOBS = 32
APPLY_PREVIEW_WAIT = .1
APPLY_NATIVE_PREVIEW_WAIT = 5
WORKING_RENDER_WAIT = 5
_DATA_URI = re.compile(r'^data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$', re.IGNORECASE)
_WORKING_ID = re.compile(r'^[A-Za-z0-9_-]{1,100}$')


def _png_print_metadata(png, profile, dpi):
    """Attach print metadata to verified RGBA PNGs without encoding pixels again."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack('!I', len(data)) + body + struct.pack('!I', zlib.crc32(body))

    ppm = int(dpi / .0254 + .5)
    if png[24:29] != b'\x08\x06\x00\x00\x00':
        raise ValueError('Expected an 8-bit, non-interlaced RGBA PNG.')
    width, height = struct.unpack_from('!II', png, 16)
    stride = width * 4 + 1
    decoder = zlib.decompressobj()
    decoded = 0
    pieces = [memoryview(png)[:33], chunk(b'iCCP', b'ICC Profile\0\0' + zlib.compress(profile)),
              chunk(b'pHYs', struct.pack('!IIB', ppm, ppm, 1))]
    offset = 33  # PNG signature and verified IHDR.
    while offset < len(png):
        length, kind = struct.unpack_from('!I4s', png, offset)
        end = offset + length + 12
        if kind == b'IDAT':
            compressed = memoryview(png)[offset + 8:end - 4]
            while compressed:
                block = decoder.decompress(compressed, 1_048_576)
                if any(value > 4 for value in block[-decoded % stride::stride]):
                    raise ValueError('Invalid PNG scanline filter.')
                decoded += len(block)
                if decoded > stride * height or decoder.unused_data:
                    raise ValueError('Unexpected PNG pixel data.')
                compressed = decoder.unconsumed_tail
        if kind in {b'IDAT', b'IEND'}:
            pieces.append(memoryview(png)[offset:end])
        offset = end
        if kind == b'IEND':
            break
    if not decoder.eof or decoded != stride * height:
        raise ValueError('Incomplete PNG pixel data.')
    return b''.join(pieces)


class NativePreviewInterrupted(Exception):
    """Allow an apply job to take priority over a live full-document render."""


class CanvasRetouchController:
    """Owns a single apply slot and a bounded in-memory job registry."""

    def __init__(self):
        self.jobs = OrderedDict()
        self.jobs_lock = threading.Lock()
        self.apply_lock = threading.Lock()
        self.render_lock = threading.Lock()
        self.native_preview_running = threading.Event()
        self.preview_cache = PreviewCache()
        self.working_image = None

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
        return value

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
        image.save(stream, format='PNG', compress_level=1, **save_options)
        return Response(stream.getvalue(), mimetype='image/png')

    def validate_working_request(body):
        working_id = body.get('workingId')
        if not isinstance(working_id, str) or not _WORKING_ID.fullmatch(working_id):
            raise ValueError('작업 이미지 ID가 올바르지 않습니다.')
        base_revision = body.get('baseRevision')
        if (isinstance(base_revision, bool) or not isinstance(base_revision, int) or
                base_revision < 0):
            raise ValueError('작업 이미지 버전이 올바르지 않습니다.')
        return working_id, base_revision

    def native_working_source(raw, engine, expected_size):
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as opened:
                    normalized = engine.normalize_image(opened)
            if normalized.size != tuple(expected_size):
                normalized.close()
                raise ValueError('정규화된 원본 크기가 일치하지 않습니다.')
            return normalized
        except ValueError:
            raise
        except Exception:
            raise ValueError('원본 이미지를 정규화하지 못했습니다.') from None

    def working_response(image, box, revision, icc_profile, borrowed=False):
        if image is None:
            response = Response(status=204)
        else:
            try:
                stream = io.BytesIO()
                image.save(stream, format='PNG', compress_level=1, icc_profile=icc_profile)
                response = Response(stream.getvalue(), mimetype='image/png')
            finally:
                if not borrowed:
                    image.close()
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Retouch-Revision'] = str(revision)
        if box is not None:
            x, y, right, bottom = box
            response.headers['X-Retouch-X'] = str(x)
            response.headers['X-Retouch-Y'] = str(y)
            response.headers['X-Retouch-Width'] = str(right - x)
            response.headers['X-Retouch-Height'] = str(bottom - y)
        return response

    def preview_edge(body, native=False):
        quick = body.get('quick', False)
        if not isinstance(quick, bool):
            raise ValueError('미리보기 설정이 올바르지 않습니다.')
        if native and 'displayEdge' in body:
            display_edge = body['displayEdge']
            if (isinstance(display_edge, bool) or not isinstance(display_edge, int) or
                    not 1 <= display_edge <= PREVIEW_EDGE):
                raise ValueError('원본 해상도 표시 크기가 올바르지 않습니다.')
            return display_edge
        return WORKING_EDGE if quick else PREVIEW_EDGE

    @app.post('/api/canvas/retouch/preview')
    def canvas_retouch_preview():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            native = body.get('native', False)
            if not isinstance(native, bool):
                raise ValueError('원본 해상도 보정 설정이 올바르지 않습니다.')
            edge = preview_edge(body, native)
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
            if native:
                custom_display_edge = 'displayEdge' in body
                source_size = controller.preview_cache.source_size(key)
                if source_size is None:
                    try:
                        source_size = inspect_source(raw)
                    except ValueError as exc:
                        return json_error(str(exc), 400)
                controller.preview_cache.remember_viewport_source_size(key, source_size)
                layers = [layer for layer in layers if engine._has_effect(layer)]
                scale = min(1, edge / max(source_size))
                output_size = tuple(max(1, round(length * scale)) for length in source_size)

                if not layers:
                    if custom_display_edge:
                        with engine.render(io.BytesIO(raw), {'layers': []}, max_edge=edge) as prepared:
                            return png_response(prepared, icc_profile=engine.SRGB)
                    cached = controller.preview_cache.get(key)
                    if cached is not None:
                        prepared = cached[0] if edge == PREVIEW_EDGE else controller.preview_cache.working_image()
                        return png_response(prepared, icc_profile=engine.SRGB)
                    prepared = engine.render(io.BytesIO(raw), {'layers': []}, max_edge=PREVIEW_EDGE)
                    try:
                        if edge == PREVIEW_EDGE:
                            return png_response(prepared, icc_profile=engine.SRGB)
                        projection = prepared.resize(output_size, Image.Resampling.LANCZOS)
                        with projection:
                            return png_response(projection, icc_profile=engine.SRGB)
                    finally:
                        prepared.close()

                cached_native = controller.preview_cache.get_native_preview(key, layers, edge)
                if cached_native is not None:
                    return png_response(cached_native, icc_profile=engine.SRGB)
                full_resolution = controller.preview_cache.take_native_result(key, layers)
                controller.preview_cache.clear_native_preview()
                controller.native_preview_running.set()

                def interrupt_for_apply(_progress, _layer_name):
                    if controller.apply_lock.locked():
                        raise NativePreviewInterrupted()

                try:
                    if full_resolution is None:
                        controller.preview_cache.clear_native_source()
                        full_resolution = engine.render(
                            io.BytesIO(raw), {'layers': layers}, progress=interrupt_for_apply,
                        )
                    projection = project_native_preview(full_resolution, output_size)
                    can_reuse = full_resolution.width * full_resolution.height <= NATIVE_RESULT_MAX_PIXELS
                    controller.preview_cache.store_native_preview(
                        key, layers, edge, projection, full_resolution if can_reuse else None,
                    )
                    if can_reuse:
                        full_resolution = None
                    return png_response(projection, icc_profile=engine.SRGB)
                finally:
                    if full_resolution is not None:
                        full_resolution.close()
                    controller.native_preview_running.clear()

            cached = controller.preview_cache.get(key)
            if cached is None:
                controller.preview_cache.clear()
                try:
                    source_size = inspect_source(raw)
                except ValueError as exc:
                    return json_error(str(exc), 400)
                prepared = engine.render(io.BytesIO(raw), {'layers': []}, max_edge=PREVIEW_EDGE)
                controller.preview_cache.store(key, prepared, source_size)
                cached = (prepared, source_size)
            prepared, source_size = cached
            layers = [layer for layer in layers if engine._has_effect(layer)]
            if any(layer['type'] == 'clone' for layer in layers):
                # Clone samples document-space source pixels, so keep its existing full-source path.
                with engine.render(io.BytesIO(raw), {'layers': layers}, max_edge=edge) as image:
                    return png_response(image, icc_profile=engine.SRGB)
            if edge == WORKING_EDGE:
                prepared = controller.preview_cache.working_image()
            scale = min(1, edge / max(source_size))

            def render(base, pending_layers):
                return engine.render_preview(
                    base, {'layers': pending_layers}, scale, mask_cache=controller.preview_cache.masks,
                )

            image = controller.preview_cache.render_layers(prepared, layers, render)
            return png_response(image, icc_profile=engine.SRGB)
        except NativePreviewInterrupted:
            return render_busy_response()
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
            native = body.get('native', False)
            if not isinstance(native, bool):
                raise ValueError('원본 해상도 보정 설정이 올바르지 않습니다.')
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
                key = hashlib.sha256(raw).digest()
                source_size = controller.preview_cache.source_size(key)
                if source_size is None:
                    source_size = inspect_source(raw)
                width, height = source_size
                x, y, requested_width, requested_height = coordinates
                if x >= width or y >= height:
                    raise ValueError('확대 영역이 원본 이미지 밖에 있습니다.')
                clamped_width = min(requested_width, width - x)
                clamped_height = min(requested_height, height - y)
                output_size = checked_output_size(clamped_width, clamped_height)
                effective = [layer for layer in layers if engine._has_effect(layer)]
                if not body.get('original', False):
                    controller.preview_cache.remember_viewport_source_size(key, source_size)
                    if native:
                        if controller.preview_cache.get_native_preview(key, effective) is None:
                            controller.preview_cache.clear_native_preview()
            except ValueError as exc:
                return json_error(str(exc), 400)
            native_result = (
                controller.preview_cache.get_native_result(key, effective)
                if native and not body.get('original', False) else None
            )
            prepared_source = None
            if (native and not body.get('original', False) and native_result is None and
                    width * height <= NATIVE_RESULT_MAX_PIXELS):
                prepared_source = controller.preview_cache.get_native_source(key)
                if prepared_source is None:
                    with Image.open(io.BytesIO(raw)) as opened:
                        prepared_source = engine.normalize_image(opened)
                    prepared_source = controller.preview_cache.store_native_source(key, prepared_source)
            if native_result is not None:
                image = native_result.crop((x, y, x + clamped_width, y + clamped_height))
            else:
                image = engine.render(
                    io.BytesIO(raw),
                    {'layers': [] if body.get('original', False) else layers},
                    region=(x, y, clamped_width, clamped_height),
                    region_scale=1 if native else scale,
                    region_cache=(None if body.get('original', False) else controller.preview_cache),
                    source_key=key,
                    prepared_source=prepared_source,
                )
            if native and image.size != output_size:
                try:
                    resized = project_native_preview(image, output_size)
                except BaseException:
                    image.close()
                    raise
                image.close()
                image = resized
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
            native = body.get('native', False)
            if not isinstance(native, bool):
                raise ValueError('원본 해상도 보정 설정이 올바르지 않습니다.')
            edge = preview_edge(body, native)
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
                cached = controller.preview_cache.source_size(hashlib.sha256(raw).digest())
                width, height = cached or inspect_source(raw)
            except ValueError as exc:
                return json_error(str(exc), 400)
            scale = min(1, edge / max(width, height))
            size = (max(1, round(width * scale)), max(1, round(height * scale)))
            masks = controller.preview_cache.masks if cached else None
            image = engine.mask_image(layer, size, scale, (0, 0), cache=masks)
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

    @app.post('/api/canvas/retouch/working')
    def canvas_retouch_working():
        engine, error = load_engine()
        if error:
            return error
        try:
            body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            working_id, base_revision = validate_working_request(body)
        except ValueError as exc:
            return json_error(str(exc), 400)
        if controller.apply_lock.locked():
            return render_busy_response()
        if not controller.render_lock.acquire(timeout=WORKING_RENDER_WAIT):
            return render_busy_response()

        controller.native_preview_running.set()
        try:
            raw = read_source_bytes(body.get('source'))
            source_key = hashlib.sha256(raw).digest()
            source_size = inspect_source(raw)
            cached = controller.working_image
            if (cached is None or cached.working_id != working_id or
                    cached.source_key != source_key):
                if cached is not None:
                    controller.working_image = None
                    cached.close()
                normalized = native_working_source(raw, engine, source_size)
                try:
                    replacement = WorkingImage(working_id, source_key, normalized)
                except BaseException:
                    normalized.close()
                    raise
                controller.working_image = replacement

            def interrupt_for_apply(_progress, _layer_name):
                if controller.apply_lock.locked():
                    raise NativePreviewInterrupted()

            image, box, revision, borrowed = controller.working_image.update(
                engine, layers, base_revision, progress=interrupt_for_apply,
            )
            return working_response(image, box, revision, engine.SRGB, borrowed)
        except NativePreviewInterrupted:
            return render_busy_response()
        except ValueError as exc:
            return json_error(str(exc), 400)
        except Exception:
            return json_error('원본 해상도 작업 이미지를 갱신하지 못했습니다.', 500)
        finally:
            controller.native_preview_running.clear()
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/working/close')
    def canvas_retouch_working_close():
        try:
            body = read_json_body()
            working_id = body.get('workingId')
            if not isinstance(working_id, str) or not _WORKING_ID.fullmatch(working_id):
                raise ValueError('작업 이미지 ID가 올바르지 않습니다.')
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not controller.render_lock.acquire(timeout=WORKING_RENDER_WAIT):
            return render_busy_response()
        try:
            cached = controller.working_image
            if cached is not None and cached.working_id == working_id:
                controller.working_image = None
                cached.close()
            return Response(status=204)
        finally:
            controller.render_lock.release()

    @app.post('/api/canvas/retouch/apply')
    def canvas_retouch_apply():
        engine, error = load_engine()
        if error:
            return error
        rendered = None
        try:
            if request.mimetype == 'multipart/form-data':
                if request.content_length is not None and request.content_length > MAX_SOURCE_BYTES + MAX_RENDER_MANIFEST_BYTES + 4096:
                    raise ValueError('요청 크기가 한도를 넘었습니다.')
                manifest = request.files.get('document')
                upload = request.files.get('rendered')
                if manifest is None or upload is None or upload.mimetype != 'image/png':
                    raise ValueError('보정 결과 파일이 올바르지 않습니다.')
                manifest_bytes = manifest.stream.read(MAX_RENDER_MANIFEST_BYTES + 1)
                if len(manifest_bytes) > MAX_RENDER_MANIFEST_BYTES:
                    raise ValueError('보정 기록의 크기가 한도를 넘었습니다.')
                body = json.loads(manifest_bytes)
                if not isinstance(body, dict):
                    raise ValueError('보정 기록이 올바르지 않습니다.')
                rendered = upload.stream.read(MAX_SOURCE_BYTES + 1)
                if not rendered or len(rendered) > MAX_SOURCE_BYTES:
                    raise ValueError('보정 결과 파일의 크기가 올바르지 않습니다.')
            else:
                body = read_json_body()
            layers = validate_layers(engine, body.get('layers', []))
            print_spec = validate_print(engine, body.get('print'))
            working_id = body.get('workingId')
            if working_id is not None and (
                    not isinstance(working_id, str) or not _WORKING_ID.fullmatch(working_id)):
                raise ValueError('작업 이미지 ID가 올바르지 않습니다.')
        except ValueError as exc:
            return json_error(str(exc), 400)
        if not controller.apply_lock.acquire(blocking=False):
            return json_error('이미지 보정 작업이 진행 중입니다.', 409)
        # A preview may still be finishing after the browser has canceled its request.
        wait = APPLY_NATIVE_PREVIEW_WAIT if controller.native_preview_running.is_set() else APPLY_PREVIEW_WAIT
        if not controller.render_lock.acquire(timeout=wait):
            controller.apply_lock.release()
            return render_busy_response()
        try:
            raw = read_source_bytes(body.get('source'))
            key = hashlib.sha256(raw).digest()
            width, height = controller.preview_cache.source_size(key) or inspect_source(raw)
            if rendered is not None:
                with warnings.catch_warnings():
                    warnings.simplefilter('ignore', Image.DecompressionBombWarning)
                    with Image.open(io.BytesIO(rendered)) as opened:
                        if (opened.format != 'PNG' or opened.mode != 'RGBA' or opened.size != (width, height) or
                                getattr(opened, 'is_animated', False)):
                            raise ValueError('보정 결과의 형식이나 원본 해상도가 일치하지 않습니다.')
                        opened.verify()
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
        controller.add_job(initial_job.copy())

        def render_worker(source_bytes, layer_snapshot, print_snapshot, source_size, rendered_bytes):
            image = None
            render_acquired = False
            try:
                controller.render_lock.acquire()
                render_acquired = True
                if rendered_bytes is not None:
                    controller.preview_cache.clear()
                else:
                    effective = [layer for layer in layer_snapshot if engine._has_effect(layer)]
                    if working_id is not None and controller.working_image is not None:
                        image = controller.working_image.copy_result_if_matches(
                            working_id, key, engine, layer_snapshot,
                        )
                    if image is None:
                        image = controller.preview_cache.take_native_result(key, effective)
                    if image is None:
                        cached_result = controller.preview_cache.full_size_result(key, effective)
                        if cached_result is not None:
                            image = cached_result.copy()
                    controller.preview_cache.clear()
                    if image is None:
                        image = engine.render(
                            io.BytesIO(source_bytes),
                            {'layers': layer_snapshot},
                            progress=lambda value, name: controller.update_job(
                                job_id, progress=min(.85, max(0, value * .85)), message=f'{name} 보정 중입니다.',
                            ),
                        )
                controller.update_job(job_id, progress=0.9, message='원본 크기 PNG를 저장하고 있습니다.')
                dpi = source_size[0] / (print_snapshot['widthCm'] / 2.54)
                if rendered_bytes is not None:
                    output = _png_print_metadata(rendered_bytes, engine.SRGB, dpi)
                else:
                    stream = io.BytesIO()
                    image.save(stream, format='PNG', compress_level=3, icc_profile=engine.SRGB, dpi=(dpi, dpi))
                    output = stream.getvalue()
                public_src, _rel_path = save_image(
                    output, prefix='canvas_import_retouch', category='retouch', session_id=None,
                )
                controller.update_job(
                    job_id,
                    status='done',
                    progress=1,
                    message='이미지 보정이 끝났습니다.',
                    result={'src': public_src, 'width': source_size[0], 'height': source_size[1]},
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
                args=(raw, layers, print_spec, (width, height), rendered),
                name='canvas-retouch-render',
                daemon=True,
            )
            worker.start()
        except Exception:
            controller.update_job(job_id, status='error', progress=0, message='보정 작업을 시작하지 못했습니다.')
            controller.apply_lock.release()
            return json_error('보정 작업을 시작하지 못했습니다.', 500)
        return jsonify({'status': 'success', 'job': initial_job}), 202

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
            working_id = body.get('workingId')
            if working_id is not None and (
                    not isinstance(working_id, str) or not _WORKING_ID.fullmatch(working_id)):
                raise ValueError('작업 이미지 ID가 올바르지 않습니다.')
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
            if working_id is not None and controller.working_image is not None:
                current_image = controller.working_image.copy_result_if_matches(
                    working_id, hashlib.sha256(current_raw).digest(), engine, layers,
                )
            if current_image is None:
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
