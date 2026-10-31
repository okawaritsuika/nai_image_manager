"""Flask routes for the offline Daki tag dictionary screen."""
from __future__ import annotations

import atexit
import ipaddress
import json
import threading
from pathlib import Path
from urllib.parse import urlsplit

from flask import Blueprint, Response, g, jsonify, request, send_file
from werkzeug.exceptions import HTTPException

from naim.daki_dictionary import Dictionary, DictionaryDataError, image_display_tags
from naim.daki_dictionary_download import DictionaryImageDownload


FOLDER_PICKER_LOCK = threading.Lock()
MAX_BODY_BYTES = 65536


def _error(message, status):
    return jsonify({"error": message}), status


def _origin_key(value):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def _local_request_allowed():
    try:
        request_origin = _origin_key(request.host_url)
        if request_origin is None:
            return False
        hostname = request_origin[1]
        if hostname != "localhost":
            try:
                if not ipaddress.ip_address(hostname).is_loopback:
                    return False
            except ValueError:
                return False
        origin = request.headers.get("Origin")
        return origin is None or _origin_key(origin) == request_origin
    except (RuntimeError, ValueError):
        return False


def _query_int(name, default, minimum, maximum=None):
    raw = request.args.get(name, str(default))
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ValueError("페이지 번호가 올바르지 않습니다.") from None
    value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _json_object():
    if request.mimetype != "application/json":
        raise ValueError("JSON 형식으로 요청해 주세요.")
    length = request.content_length
    if length is None or length <= 0 or length > MAX_BODY_BYTES:
        raise ValueError("요청 내용의 크기를 확인해 주세요.")
    try:
        body = json.loads(request.get_data(cache=False).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("JSON 내용을 확인해 주세요.") from None
    if not isinstance(body, dict):
        raise ValueError("요청 내용은 JSON 객체여야 합니다.")
    return body


def register_daki_dictionary_routes(app, data_directory, user_directory):
    """Register the page and API routes; return the lazy state provider."""
    data_directory = Path(data_directory)
    user_directory = Path(user_directory)
    state_lock = threading.RLock()
    state = None
    api = Blueprint("daki_dictionary_api", __name__)

    def provide_state():
        nonlocal state
        with state_lock:
            if state is None:
                state = Dictionary(data_directory, user_directory)
            return state

    def close_state():
        downloads.shutdown()
        with state_lock:
            current = state
        if current is not None:
            current.close()

    downloads = DictionaryImageDownload(lambda: provide_state().images, user_directory)
    app.extensions['daki_dictionary_image_download'] = downloads

    app.extensions["daki_dictionary"] = provide_state
    atexit.register(close_state)

    @api.before_request
    def initialize_state():
        if not _local_request_allowed():
            return _error("이 사전은 현재 컴퓨터에서만 사용할 수 있습니다.", 403)
        try:
            g.daki_dictionary = provide_state()
        except DictionaryDataError:
            return _error("사전 자료를 찾을 수 없습니다. 설치된 자료를 확인한 뒤 다시 시도해 주세요.", 503)
        except Exception:
            return _error("사전 저장소를 열지 못했습니다. 저장 폴더를 확인해 주세요.", 500)
        return None

    @api.after_request
    def set_private_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @api.errorhandler(HTTPException)
    def handle_http_error(error):
        messages = {404: "요청한 기능을 찾을 수 없습니다.", 405: "지원하지 않는 요청 방식입니다."}
        return _error(messages.get(error.code, "요청을 처리할 수 없습니다."), error.code or 400)

    @api.errorhandler(Exception)
    def handle_unexpected_error(_error_value):
        # Keep private prompt data and local paths out of exception logs/responses.
        return _error("요청을 처리하지 못했습니다. 저장소와 이미지 폴더를 확인해 주세요.", 500)

    @api.route("/dictionary", methods=["GET"])
    def dictionary_snapshot():
        return jsonify(g.daki_dictionary.snapshot())

    @api.route("/config", methods=["GET"])
    def config():
        return jsonify({"image_linking_enabled": True, "image_aspect_ratio": [512, 1536]})

    @api.route("/health", methods=["GET"])
    def health():
        state = g.daki_dictionary
        return jsonify({"ready": True, "rows": len(state.rows), "tags": len(state.tags)})

    @api.route("/images/status", methods=["GET"])
    def image_status():
        return jsonify(g.daki_dictionary.images.status())

    @api.route('/image-pack', methods=['GET', 'POST'])
    def dictionary_image_pack():
        try:
            if request.method == 'POST':
                if _json_object():
                    raise ValueError('추가 설정 없이 예시 이미지 다운로드를 시작해 주세요.')
                return jsonify(job=downloads.start())
            return jsonify(job=downloads.status(), available=g.daki_dictionary.images.can_install_image_pack(),
                           image_status=g.daki_dictionary.images.status())
        except ValueError as error:
            return _error(str(error), 400)
        except OSError:
            return _error('예시 이미지 다운로드를 준비하지 못했습니다. 다시 시도해 주세요.', 500)

    @api.route('/image-pack/stop', methods=['POST'])
    def stop_dictionary_image_pack():
        return jsonify(job=downloads.stop())

    @api.route("/images", methods=["GET"])
    def images():
        state = g.daki_dictionary
        tag = request.args.get("tag", "")
        if tag not in state.tags:
            return _error("사전에 없는 태그입니다.", 404)
        try:
            offset = _query_int("offset", 0, 0)
            limit = _query_int("limit", 24, 1, 100)
            return jsonify(state.images.query(tag, offset, limit))
        except ValueError:
            return _error("페이지 번호가 올바르지 않습니다.", 400)

    @api.route("/images/<int:image_id>", methods=["GET"])
    def image_detail(image_id):
        state = g.daki_dictionary
        detail = state.images.detail(image_id)
        if detail is None:
            return _error("이미지를 찾을 수 없습니다.", 404)
        detail["used_tags"] = image_display_tags(detail["matched_tags"], state.tags)
        return jsonify(detail)

    @api.route("/images/<int:image_id>/thumbnail", methods=["GET"])
    def image_thumbnail(image_id):
        try:
            path = g.daki_dictionary.images.thumbnail(image_id)
            if path is None or not path.is_file():
                return _error("이미지 파일을 찾을 수 없습니다.", 404)
            return send_file(path, mimetype="image/webp", conditional=False, max_age=0)
        except (OSError, ValueError):
            return _error("이미지를 읽을 수 없습니다. 다시 검색해 주세요.", 404)

    @api.route("/images/<int:image_id>/file", methods=["GET"])
    def image_file(image_id):
        try:
            path = g.daki_dictionary.images.file_path(image_id)
            if path is None or not path.is_file():
                return _error("이미지 파일을 찾을 수 없습니다.", 404)
            mime = {".png": "image/png", ".webp": "image/webp"}.get(
                path.suffix.lower(), "application/octet-stream")
            return send_file(path, mimetype=mime, conditional=False, max_age=0)
        except (OSError, ValueError):
            return _error("이미지를 읽을 수 없습니다. 다시 검색해 주세요.", 404)

    @api.route("/statistics", methods=["GET"])
    def statistics():
        state = g.daki_dictionary
        tag = request.args.get("tag")
        sort = request.args.get("sort", "combinations")
        try:
            offset = _query_int("offset", 0, 0)
            limit = _query_int("limit", 15, 1, 100)
            return jsonify(state.statistics(tag, sort, offset, limit))
        except KeyError:
            return _error("사전에 없는 태그입니다.", 404)
        except ValueError as error:
            return _error(str(error), 400)

    @api.route("/related", methods=["GET"])
    def related():
        state = g.daki_dictionary
        tag = request.args.get("tag", "")
        try:
            limit = _query_int("limit", 12, 1, 50)
            return jsonify(state.related(tag, limit))
        except KeyError:
            return _error("사전에 없는 태그입니다.", 404)
        except ValueError:
            return _error("연관 태그 개수를 확인하세요.", 400)

    @api.route("/combinations", methods=["GET"])
    def combinations():
        state = g.daki_dictionary
        tag = request.args.get("tag", "")
        try:
            offset = _query_int("offset", 0, 0)
            limit = _query_int("limit", 12, 1, 100)
            return jsonify(state.combinations(tag, offset, limit))
        except KeyError:
            return _error("사전에 없는 태그입니다.", 404)
        except ValueError:
            return _error("페이지 번호가 올바르지 않습니다.", 400)

    @api.route("/export.csv", methods=["GET"])
    def export_csv():
        return Response(
            g.daki_dictionary.export(),
            content_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="tag_dictionary.csv"'},
        )

    @api.route("/tags", methods=["PATCH"])
    def edit_tag():
        try:
            body = _json_object()
            return jsonify(g.daki_dictionary.edit(body))
        except ValueError as error:
            return _error(str(error), 400)
        except OSError:
            return _error("수정 내용을 저장하지 못했습니다. 저장 폴더를 확인하세요.", 500)

    @api.route("/images/scan", methods=["POST"])
    def scan_images():
        return jsonify(g.daki_dictionary.images.scan_async())

    @api.route("/images/folder", methods=["POST"])
    def set_image_folder():
        try:
            body = _json_object()
            folder = body.get("folder")
            if not isinstance(folder, str) or not folder.strip():
                raise ValueError("PNG·WebP가 들어 있는 폴더 경로를 입력하세요.")
            return jsonify(g.daki_dictionary.images.set_folder(folder.strip()))
        except (ValueError, OSError):
            return _error("폴더 경로를 확인하세요. PNG·WebP가 들어 있는 폴더를 선택해 주세요.", 400)

    @api.route("/images/pick-folder", methods=["POST"])
    def pick_image_folder():
        if not FOLDER_PICKER_LOCK.acquire(blocking=False):
            return _error("이미 열려 있는 폴더 선택 창을 확인하세요.", 409)
        root = None
        folder = None
        failed = False
        try:
            import tkinter as tk
            from tkinter import filedialog

            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            folder = filedialog.askdirectory(
                parent=root, title="PNG · WebP 이미지가 있는 폴더 선택", mustexist=True)
        except Exception:
            failed = True
        finally:
            if root is not None:
                try:
                    root.destroy()
                except Exception:
                    pass
            FOLDER_PICKER_LOCK.release()
        if failed:
            return _error("폴더 선택 창을 열지 못했습니다. 폴더 경로를 직접 입력해 주세요.", 500)
        return jsonify({"folder": folder or None})

    @api.route("/", defaults={"unknown_path": ""}, methods=["GET", "PATCH", "POST"])
    @api.route("/<path:unknown_path>", methods=["GET", "PATCH", "POST"])
    def unknown_api_route(unknown_path):
        return _error("요청한 기능을 찾을 수 없습니다.", 404)

    app.register_blueprint(api, url_prefix="/api/daki/dictionary")

    def dictionary_page():
        if not _local_request_allowed():
            return _error("이 사전은 현재 컴퓨터에서만 사용할 수 있습니다.", 403)
        return app.send_static_file("daki_dictionary/index.html")

    app.add_url_rule("/daki/dictionary", "daki_dictionary_page", dictionary_page, methods=["GET"])
    return provide_state
