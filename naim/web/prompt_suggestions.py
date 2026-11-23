"""HTTP route for bilingual prompt tag autocomplete."""

import hashlib
import threading
import time

from flask import jsonify, request
from requests import RequestException

from naim.hf_http import public_session
from naim.prompt_suggestions import (
    MAX_IMPORT_BYTES, PromptSuggestionCatalog, PromptSuggestionDataError,
)


_CSV_URL = ('https://huggingface.co/datasets/mengod-hf/danbooru-tags-kr/resolve/'
            '76c33573506eb08f1571ac7550e59c3379681617/danbooru-tags-kr-2026-11-10.csv')
_CSV_BYTES = 27_648_854
_CSV_SHA256 = '5fc8783bc6254f8bfe32e8f1302a05e7574db21e9903f3456006afaf4f20cdc8'


class _PromptTagDownloadError(Exception):
    pass


def _download_prompt_tag_csv():
    content = bytearray()
    deadline = time.monotonic() + 180
    try:
        with public_session() as session, session.get(_CSV_URL, stream=True, timeout=(8, 20)) as response:
            response.raise_for_status()
            for chunk in response.iter_content(128 * 1024):
                if time.monotonic() > deadline:
                    raise _PromptTagDownloadError('다운로드 시간이 초과됐습니다. 다시 시도해 주세요.')
                if len(content) + len(chunk) > _CSV_BYTES:
                    raise _PromptTagDownloadError('받은 CSV의 크기가 원본과 다릅니다.')
                content.extend(chunk)
    except RequestException:
        raise _PromptTagDownloadError('Hugging Face에서 CSV를 다운로드하지 못했습니다. 잠시 후 다시 시도해 주세요.') from None
    if len(content) != _CSV_BYTES or hashlib.sha256(content).hexdigest() != _CSV_SHA256:
        raise _PromptTagDownloadError('받은 CSV가 원본과 일치하지 않습니다. 다시 시도해 주세요.')
    return content


def register_prompt_suggestion_routes(app, directory, import_path=None):
    catalog = PromptSuggestionCatalog(directory, import_path)

    if import_path is not None:
        import_lock = threading.Lock()

        def apply_csv(read_csv, *, downloaded=False):
            if not import_lock.acquire(blocking=False):
                return jsonify(status='error', message='한글 태그를 이미 적용 중입니다. 잠시 후 다시 시도해 주세요.'), 409
            try:
                count = catalog.import_csv(read_csv())
            except _PromptTagDownloadError as error:
                return jsonify(status='error', message=str(error)), 502
            except ValueError as error:
                if downloaded:
                    return jsonify(status='error', message='다운로드한 CSV의 내용을 적용할 수 없습니다.'), 502
                return jsonify(status='error', message=str(error)), 400
            except (OSError, PromptSuggestionDataError):
                app.logger.warning('Could not save the local prompt tag CSV.')
                return jsonify(status='error', message='CSV를 저장할 수 없습니다.'), 503
            finally:
                import_lock.release()
            return jsonify(status='success', count=count)

        @app.route('/api/prompt-tags/import', methods=['GET', 'POST'])
        def prompt_tag_import():
            if request.method == 'GET':
                try:
                    state = catalog.import_state()
                except PromptSuggestionDataError:
                    return jsonify(status='error', message='프롬프트 태그 사전을 사용할 수 없습니다.'), 503
                return jsonify(status='success', imported=state == 'applied', import_state=state)
            if request.mimetype != 'application/octet-stream':
                return jsonify(status='error', message='CSV 파일을 선택해 주세요.'), 415
            if request.content_length is not None and request.content_length > MAX_IMPORT_BYTES:
                return jsonify(status='error', message='40MB 이하의 CSV 파일을 선택해 주세요.'), 413
            return apply_csv(lambda: request.stream.read(MAX_IMPORT_BYTES + 1))

        @app.route('/api/prompt-tags/download', methods=['POST'])
        def prompt_tag_download():
            if not request.is_json:
                return jsonify(status='error', message='태그 사전에서 다운로드를 눌러 주세요.'), 415
            return apply_csv(_download_prompt_tag_csv, downloaded=True)

    @app.route('/api/prompt-tags/suggest', methods=['GET'],
               endpoint='prompt_tag_suggestions')
    def prompt_tag_suggestions():
        query = request.args.get('q', '')
        raw_limit = request.args.get('limit')
        limit = None
        if raw_limit is not None:
            try:
                limit = int(raw_limit)
            except (TypeError, ValueError):
                limit = 0

        try:
            items = (catalog.suggest(query) if limit is None
                     else catalog.suggest(query, limit))
        except PromptSuggestionDataError:
            return jsonify({
                'status': 'error', 'message': '프롬프트 태그 사전을 사용할 수 없습니다.',
            }), 503
        except ValueError as error:
            return jsonify({'status': 'error', 'message': str(error)}), 400
        return jsonify({'status': 'success', 'items': items})

    return prompt_tag_suggestions
