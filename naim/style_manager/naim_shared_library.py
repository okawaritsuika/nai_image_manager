"""In-process adapter for the one NAIM shared-style catalog."""
from copy import deepcopy
import math
import mimetypes
from pathlib import Path
import re
import threading
import time

from flask import jsonify, request, send_file


_catalog = None
_cache = {}
_lock = threading.RLock()
_ID = re.compile(r"common-[a-f0-9]{24}\Z")
IMAGE_PREFIX = "__naim_shared__/"


class SharedLibraryError(RuntimeError):
    pass


def configure(catalog):
    global _catalog
    with _lock:
        _catalog = catalog
        _cache.clear()


def enabled():
    return _catalog is not None


def _configured_catalog():
    if not enabled():
        raise SharedLibraryError('NAIM 공용 그림체 연결이 설정되지 않았습니다.')
    return _catalog


def list_styles(*, force=False, include_excluded=False):
    with _lock:
        cached = _cache.get(bool(include_excluded))
        if not force and cached and time.monotonic() - cached[0] < 2:
            return deepcopy(cached[1])
        try:
            catalog = _configured_catalog()
            styles = catalog.public_records(include_excluded=include_excluded)
            if not isinstance(styles, list) or any(not isinstance(item, dict) or not _ID.fullmatch(str(item.get('id', ''))) for item in styles):
                raise SharedLibraryError('공용 그림체 응답을 확인할 수 없습니다.')
        except (OSError, ValueError, LookupError):
            raise SharedLibraryError('공용 그림체 응답을 확인할 수 없습니다.') from None
        warnings = [value for value in getattr(catalog, 'warnings', []) if isinstance(value, str)]
        _cache[bool(include_excluded)] = (time.monotonic(), deepcopy(styles), warnings)
        return deepcopy(styles)


def exclude_styles(style_ids):
    if (not isinstance(style_ids, list) or not 1 <= len(style_ids) <= 10000
            or any(not isinstance(sid, str) or not _ID.fullmatch(sid) for sid in style_ids)):
        raise ValueError('제외할 그림체를 선택해 주세요.')
    with _lock:
        try:
            _configured_catalog().remove_styles(style_ids)
        except (OSError, ValueError, LookupError):
            raise SharedLibraryError('공유 그림체를 제외하지 못했습니다.') from None
        _cache.clear()


def _image_file(style_id, full):
    try:
        path = Path(_configured_catalog().preview_path(style_id, full=full))
        if not path.is_file():
            raise FileNotFoundError
    except (OSError, LookupError):
        raise SharedLibraryError('공유 그림체 이미지를 찾을 수 없습니다.') from None
    # Windows/Python MIME tables may omit WebP even when Pillow supports it.
    mime = 'image/webp' if path.suffix.lower() == '.webp' else mimetypes.guess_type(path.name)[0]
    if mime not in ('image/png', 'image/jpeg', 'image/webp', 'image/gif'):
        raise SharedLibraryError('공유 그림체 이미지를 확인할 수 없습니다.')
    return path, mime


def preview_response(style_id, full=False):
    if not _ID.fullmatch(style_id):
        return jsonify(error='그림체를 찾을 수 없습니다.'), 404
    path, mime = _image_file(style_id, full)
    try:
        response = send_file(path, mimetype=mime)
    except OSError:
        raise SharedLibraryError('공유 그림체 이미지를 찾을 수 없습니다.') from None
    response.headers['Cache-Control'] = 'private, max-age=60'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def indexed_prompt_rows(filters=None):
    """Match the source app's prompt-index shape without persisting duplicate rows."""
    from .arca_style_collector import _canonical_artist_tag, _prompt_preset_parts, parse_weighted_prompt_tags
    from .novelai_metadata import classify_model
    rows = []
    filters = filters or {}
    model_filter = filters.get('model_filter', filters.get('model', 'all'))
    for style in list_styles():
        model = classify_model(style.get('model'))
        if model_filter not in (None, '', 'all', model['model_id'], model['model_family']):
            continue
        positive = style.get('positive') or ''
        base, excluded = _prompt_preset_parts(positive)
        artists = {artist for item in parse_weighted_prompt_tags(positive)
                   if (artist := _canonical_artist_tag(item['tag']))}
        source = next((item for item in style.get('sources', []) if isinstance(item, dict) and type(item.get('image_id')) is int), {})
        image_id = source.get('image_id') or (2 ** 48 + int(style['id'].split('-', 1)[1][:12], 16))
        rows.append({
            'image_id': image_id, 'image_path': IMAGE_PREFIX + style['id'],
            'remote_image_url': '/style-workspace/api/naim-shared-library/' + style['id'] + '/preview',
            'title': style.get('name', ''), 'source_url': style.get('source_url', ''),
            'base_prompt': base, 'negative_prompt': style.get('negative', ''),
            'excluded_tags': excluded, 'parsed_artists': artists,
            'recommendation_count': style.get('recommendation_count'),
            'model': style.get('model', ''),
            **{key: model.get(key, '') for key in ('model_id', 'model_family', 'model_generation', 'model_variant')},
        })
    return rows


def stats_refresh_items(model="all"):
    """Return active shared source URLs that need statistics refreshes."""
    from .arca_style_collector import ArcaCollectorError, normalize_arca_article_url
    from .novelai_metadata import classify_model, model_filter_value

    try:
        selected_model = model_filter_value(model)
    except ValueError as exc:
        raise ArcaCollectorError(str(exc)) from exc

    try:
        styles = list_styles(force=True)
    except SharedLibraryError as exc:
        raise ArcaCollectorError(str(exc)) from exc

    rows = {}
    for style in styles:
        model_fields = classify_model(style.get("model"))
        if selected_model == "all":
            matches = True
        elif selected_model in {"v5", "v4.5", "unknown"}:
            matches = model_fields["model_family"] == selected_model
        else:
            matches = model_fields["model_id"] == selected_model
        if not matches:
            continue

        urls = [style.get("source_url")]
        urls.extend(source.get("source_url") for source in style.get("sources", [])
                    if isinstance(source, dict))
        for raw_url in urls:
            board_tab = "R18_NAI" if "/R18_NAI/" in str(raw_url or "") else "NAI"
            try:
                source_url = normalize_arca_article_url(raw_url)
            except (ArcaCollectorError, TypeError, ValueError):
                continue
            row = rows.setdefault(source_url, {
                "id": "shared:" + source_url,
                "source_url": source_url,
                "board_tab": board_tab,
                "common_only": True,
            })
            if board_tab == "R18_NAI":
                row["board_tab"] = board_tab
    return list(rows.values())


def update_recommendations(source_url, count, collected_at):
    """Persist a known recommendation count in the shared catalog."""
    if count is None:
        return 0
    if isinstance(count, bool) or not isinstance(count, int) or count < 0:
        raise ValueError("추천수는 0 이상의 정수여야 합니다.")
    with _lock:
        updated = _configured_catalog().store.update_recommendations(source_url, count, collected_at)
        _cache.clear()
    return updated


def source_image_rows():
    """Image-shaped shared candidates for existing source consumers."""
    from .novelai_metadata import classify_model
    rows = []
    for style in list_styles():
        sources = style.get('sources') or []
        source = next((item for item in sources if isinstance(item, dict) and type(item.get('image_id')) is int), {})
        image_id = source.get('image_id') or (2 ** 48 + int(style['id'].split('-', 1)[1][:12], 16))
        options = style.get('options') or {}
        preview = style.get('preview') or {}
        rows.append({
            'id': image_id, 'item_id': source.get('item_id') or image_id,
            'source_ids': list(dict.fromkeys([2 ** 48 + int(style['id'].split('-', 1)[1][:12], 16)] + [item['image_id'] for item in sources if isinstance(item, dict) and type(item.get('image_id')) is int])),
            'common_id': style['id'], 'image_path': IMAGE_PREFIX + style['id'],
            'image_url': '/style-workspace/api/naim-shared-library/' + style['id'] + '/preview',
            'title': style.get('name', ''), 'source_url': style.get('source_url', ''),
            'base_prompt': style.get('positive', ''), 'prompt': style.get('positive', ''),
            'negative_prompt': style.get('negative', ''),
            'scale': options.get('cfg', options.get('scale')),
            'cfg_rescale': options.get('cfg_rescale'), 'seed': style.get('seed'),
            'model': style.get('model', ''), **classify_model(style.get('model')),
            'width': preview.get('width'), 'height': preview.get('height'),
            'recommendation_count': style.get('recommendation_count'),
            'raw_metadata': style.get('raw_metadata') or {},
            'metadata_status': 'ok', 'character_prompts': [],
            'board_tab': 'R18_NAI' if '/R18_NAI/' in style.get('source_url', '') else 'NAI',
            'posted_at': style.get('source_posted_at') or style.get('sort_date') or '',
            'sampler': options.get('sampler'), 'steps': options.get('steps'),
            'noise_schedule': options.get('noise_schedule'),
            'remote_image_url': '/style-workspace/api/naim-shared-library/' + style['id'] + '/preview',
            'confirmed': False, 'image_available': style.get('available', style.get('image_available', True)),
        })
    return rows


def style_for_image_id(image_id, include_excluded=True):
    try:
        image_id = int(image_id)
    except (ValueError, TypeError):
        return None
    for style in list_styles(include_excluded=include_excluded):
        sources = style.get('sources') or []
        source_ids = [row.get('image_id') for row in sources if isinstance(row, dict)]
        synthetic = 2 ** 48 + int(style['id'].split('-', 1)[1][:12], 16)
        if image_id == synthetic or image_id in source_ids:
            return style
    return None


def read_image(style_id, full=True, max_bytes=64 * 1024 * 1024):
    if not _ID.fullmatch(style_id):
        raise SharedLibraryError('공유 그림체를 찾을 수 없습니다.')
    if not isinstance(max_bytes, int) or max_bytes < 0:
        raise SharedLibraryError('공유 그림체 이미지의 허용 크기를 확인해 주세요.')
    path, mime = _image_file(style_id, full)
    try:
        with path.open('rb') as stream:
            data = stream.read(max_bytes + 1)
    except OSError:
        raise SharedLibraryError('공유 그림체 이미지를 찾을 수 없습니다.') from None
    if len(data) > max_bytes:
        raise SharedLibraryError('공유 그림체 이미지가 허용 크기를 초과합니다.')
    return data, mime


def dependency_images():
    from .arca_style_collector import _canonical_artist_tag, parse_weighted_prompt_tags
    result = []
    for row in source_image_rows():
        artists, seen = [], set()
        for parsed in parse_weighted_prompt_tags(row['base_prompt']):
            tag = _canonical_artist_tag(parsed['tag'])
            if not tag:
                continue
            name = tag.split(':', 1)[1].strip().replace(' ', '_')
            if name.casefold() in seen:
                continue
            weight = float(parsed.get('weight', 1.0))
            if not math.isfinite(weight) or weight <= 0:
                weight = 1.0
            artists.append({'artist':name, 'weight':round(weight, 6)})
            seen.add(name.casefold())
        if artists:
            result.append({**{key:row[key] for key in ('id','item_id','source_ids','source_url','title','image_url','image_path','scale','cfg_rescale')}, 'artists':artists})
    return result


def gallery_page(offset=0, limit=60, filters=None):
    from .arca_style_collector import ArcaCollectorError, split_artist_quality_prompt
    from .novelai_metadata import model_filter_value
    try:
        offset, limit = max(0, int(offset)), min(200, max(1, int(limit)))
    except (ValueError, TypeError):
        raise ArcaCollectorError('갤러리 표시 개수와 위치를 확인해 주세요.') from None
    filters = filters or {}
    selected_model = model_filter_value(filters.get('model', filters.get('model_filter', filters.get('model_family', 'all'))))
    query = str(filters.get('q') or '').casefold().strip()
    threshold = filters.get('recommendation_min')
    try:
        threshold = int(threshold) if threshold not in (None, '') else None
        if threshold is not None and threshold < 0:
            raise ValueError
    except (ValueError, TypeError):
        raise ArcaCollectorError('최소 추천수는 0 이상의 숫자여야 합니다.') from None
    rows = []
    for row in source_image_rows():
        if row['image_available'] is False:
            continue
        if selected_model not in ('all', row['model_id'], row['model_family']):
            continue
        if filters.get('tab', 'all') not in ('all', row['board_tab']):
            continue
        if filters.get('metadata', 'all') not in ('all', 'ok'):
            continue
        if threshold is not None and (row['recommendation_count'] is None or row['recommendation_count'] < threshold):
            continue
        if query and not any(query in str(row.get(key) or '').casefold() for key in ('title','source_url','prompt','negative_prompt','model')):
            continue
        row['artist_prompt'], row['quality_prompt'] = split_artist_quality_prompt(row['base_prompt'])
        raw = row['raw_metadata']
        row['variety_plus'] = bool(raw['skip_cfg_above_sigma']) if 'skip_cfg_above_sigma' in raw else None
        row['skip_cfg_above_sigma'] = raw.get('skip_cfg_above_sigma')
        rows.append(row)
    sort = filters.get('sort', 'posted_desc')
    rows.sort(key=(lambda row: (row['recommendation_count'] if row['recommendation_count'] is not None else -1, row['id'])) if sort == 'recommend_desc' else lambda row:(row['posted_at'],row['id']), reverse=sort != 'posted_asc')
    total = len(rows)
    return {'items':rows[offset:offset+limit], 'offset':offset, 'limit':limit, 'total':total, 'has_more':offset+limit<total}


def register_routes(app):
    @app.get('/api/naim-shared-library')
    def naim_shared_library_list():
        if not enabled():
            return jsonify(enabled=False, styles=[], count=0)
        try:
            styles = list_styles(force=request.args.get('refresh') == '1')
            with _lock:
                warnings = list(_cache.get(False, (None, None, []))[2])
            return jsonify(enabled=True, styles=styles, count=len(styles), warnings=warnings)
        except SharedLibraryError as error:
            return jsonify(error=str(error)), 503

    @app.get('/api/naim-shared-library/<style_id>/preview')
    def naim_shared_library_preview(style_id):
        try:
            return preview_response(style_id, request.args.get('full') == '1')
        except SharedLibraryError as error:
            return jsonify(error=str(error)), 503

    @app.get('/api/naim-shared-library/<style_id>')
    def naim_shared_library_detail(style_id):
        if not _ID.fullmatch(style_id):
            return jsonify(error='그림체를 찾을 수 없습니다.'), 404
        try:
            style = next((item for item in list_styles(include_excluded=True) if item['id'] == style_id), None)
            if style is None:
                return jsonify(error='그림체를 찾을 수 없습니다.'), 404
            image = {**style, 'id': style_id, 'base_prompt': style.get('positive', ''),
                     'prompt': style.get('positive', ''), 'negative_prompt': style.get('negative', ''),
                     'character_prompts': [], 'local_image_url': '/arca-style-images/' + IMAGE_PREFIX + style_id,
                     'image_available': style.get('available', style.get('image_available', True))}
            return jsonify(title=style.get('name', ''), source_url=style.get('source_url', ''), images=[image])
        except SharedLibraryError as error:
            return jsonify(error=str(error)), 503

    @app.post('/api/naim-shared-library/exclude')
    def naim_shared_library_exclude():
        if (request.headers.get('Origin') not in (None, request.host_url.rstrip('/'))
                or request.headers.get('X-NAIM-Workspace') != '1'):
            return jsonify(error='그림체 관리 화면에서 제외해 주세요.'), 403
        try:
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                raise ValueError('그림체 선택을 확인해 주세요.')
            exclude_styles(body.get('style_ids'))
            return jsonify(ok=True)
        except ValueError as error:
            return jsonify(error=str(error)), 400
        except SharedLibraryError as error:
            return jsonify(error=str(error)), 503
