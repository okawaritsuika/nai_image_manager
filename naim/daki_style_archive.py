"""Discover, download, and validate the latest public shared-style image pack."""

import hashlib
import json
from pathlib import Path
import re
import sqlite3
import stat
from urllib.parse import urljoin, urlsplit
import zipfile

import requests
from naim.hf_http import public_session
from naim.storage.daki_style_sources import source_url as canonical_source_url


ARCHIVE_FILENAME = 'NAImakeArtistGroup_shared_images_20261010_webp.zip'
ARCHIVE_URL = (
    'https://huggingface.co/datasets/okawaritsuika/nai-shared-styles/resolve/'
    'c421466db686f88cdfe3ffe1053e01ef8c1431d9/' + ARCHIVE_FILENAME + '?download=true'
)
ARCHIVE_SPEC = {
    'bytes': 647_682_130,
    'sha256': 'd365d21ce2f274708e36088fcc1a41322f8fcf3b614395e81a13b283c84df43d',
    'image_count': 4_151,
    'image_bytes': 645_036_788,
}
HF_REVISION_API_URL = (
    'https://huggingface.co/api/datasets/okawaritsuika/nai-shared-styles/revision/main?blobs=true'
)
HF_ARCHIVE_INFO_URL = (
    'https://huggingface.co/datasets/okawaritsuika/nai-shared-styles/resolve/'
)
CHUNK_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 8 * 1024 * 1024
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
MAX_ARCHIVE_IMAGE_BYTES = 16 * 1024 * 1024 * 1024
MAX_ARCHIVE_IMAGE_COUNT = 100_000
MAX_RECOMMENDATION_SEED_BYTES = 256 * 1024 * 1024
MAX_RECOMMENDATION_SEED_POSTS = 100_000
RECOMMENDATION_SEED_FILENAME = 'arca_style_seed.sqlite'
FORMAT = 'naimakeartistgroup-shared-images'


class DakiStyleArchiveError(ValueError):
    pass


def _stopped(stop_event):
    return stop_event is not None and stop_event.is_set()


def _report(progress, downloaded, total, message, images=0, posts=0, *,
            phase=None, phase_current=None, phase_total=None):
    if progress:
        details = {key: value for key, value in (
            ('phase', phase), ('phase_current', phase_current), ('phase_total', phase_total)
        ) if value is not None}
        progress(downloaded_bytes=downloaded, total_bytes=total, message=message,
                 downloaded_images=images, scanned_posts=posts, **details)


def _response(session, headers, url=None):
    url = ARCHIVE_URL if url is None else url
    for _ in range(6):
        try:
            parsed = urlsplit(url)
            host = parsed.hostname or ''
            port = parsed.port
        except ValueError:
            raise DakiStyleArchiveError('이미지팩 다운로드 주소를 확인하지 못했습니다.') from None
        if (parsed.scheme != 'https' or parsed.username or parsed.password
                or port not in (None, 443)
                or not (host == 'huggingface.co' or host.endswith('.huggingface.co')
                        or host.endswith('.hf.co'))):
            raise DakiStyleArchiveError('이미지팩 다운로드 주소를 확인하지 못했습니다.')
        response = session.get(url, headers=headers, stream=True, timeout=(20, 60), allow_redirects=False)
        if response.status_code not in (301, 302, 303, 307, 308):
            return response
        location = response.headers.get('Location')
        response.close()
        if not location:
            break
        url = urljoin(url, location)
    raise DakiStyleArchiveError('이미지팩 다운로드 연결이 너무 많이 변경되었습니다.')


def _read_metadata(session, url, stop_event, message):
    if _stopped(stop_event):
        return None
    response = _response(session, {'Accept-Encoding': 'identity'}, url=url)
    with response:
        if response.status_code != 200:
            raise DakiStyleArchiveError(f'{message} (HTTP {response.status_code})')
        if 'text/html' in response.headers.get('Content-Type', '').lower():
            raise DakiStyleArchiveError(f'{message}: 웹페이지가 반환되었습니다.')
        length = response.headers.get('Content-Length')
        if length is not None:
            if not isinstance(length, str) or not length.isascii() or not length.isdigit():
                raise DakiStyleArchiveError(f'{message}: 응답 크기가 올바르지 않습니다.')
            if int(length) > MAX_METADATA_BYTES:
                raise DakiStyleArchiveError(f'{message}: 응답이 허용 크기를 초과했습니다.')
        chunks = []
        total = 0
        for chunk in response.iter_content(CHUNK_BYTES):
            if _stopped(stop_event):
                return None
            if not chunk:
                continue
            total += len(chunk)
            if total > MAX_METADATA_BYTES:
                raise DakiStyleArchiveError(f'{message}: 응답이 허용 크기를 초과했습니다.')
            chunks.append(chunk)
        if _stopped(stop_event):
            return None
        return b''.join(chunks)


def _metadata_json(data, message):
    try:
        value = json.loads(data)
    except (TypeError, ValueError, UnicodeError):
        raise DakiStyleArchiveError(f'{message}: JSON을 읽지 못했습니다.') from None
    if not isinstance(value, dict):
        raise DakiStyleArchiveError(f'{message}: 형식이 올바르지 않습니다.')
    return value


def latest_archive_spec(stop_event=None, progress=None):
    """Resolve and validate the latest archive while pinning every request to its revision."""
    if progress:
        _report(progress, 0, 0, '최신 버전 확인 중', phase='resolve', phase_current=0, phase_total=0)
    if _stopped(stop_event):
        return None
    try:
        with public_session() as session:
            revision_data = _read_metadata(
                session, HF_REVISION_API_URL, stop_event, '최신 이미지팩 정보를 확인하지 못했습니다.'
            )
            if revision_data is None or _stopped(stop_event):
                return None
            revision_doc = _metadata_json(revision_data, '최신 이미지팩 정보')
            revision = revision_doc.get('sha')
            siblings = revision_doc.get('siblings')
            if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}', revision):
                raise DakiStyleArchiveError('최신 이미지팩 리비전 정보가 올바르지 않습니다.')
            if not isinstance(siblings, list):
                raise DakiStyleArchiveError('최신 이미지팩 파일 목록을 확인하지 못했습니다.')

            info_url = HF_ARCHIVE_INFO_URL + revision + '/archive_info.json'
            info_data = _read_metadata(
                session, info_url, stop_event, '최신 이미지팩 설명을 확인하지 못했습니다.'
            )
            if info_data is None or _stopped(stop_event):
                return None
            info = _metadata_json(info_data, '최신 이미지팩 설명')

            filename = info.get('filename')
            size = info.get('bytes')
            digest = info.get('sha256')
            image_count = info.get('image_count')
            image_bytes = info.get('image_bytes')
            if not isinstance(filename, str) or not re.fullmatch(
                    r'NAImakeArtistGroup_shared_images_[0-9]{8}_webp\.zip', filename):
                raise DakiStyleArchiveError('최신 이미지팩 파일명이 올바르지 않습니다.')
            if type(size) is not int or not 0 < size <= MAX_ARCHIVE_BYTES:
                raise DakiStyleArchiveError('최신 이미지팩 크기가 허용 범위를 벗어났습니다.')
            if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
                raise DakiStyleArchiveError('최신 이미지팩 SHA-256 정보가 올바르지 않습니다.')
            if type(image_count) is not int or not 0 < image_count <= MAX_ARCHIVE_IMAGE_COUNT:
                raise DakiStyleArchiveError('최신 이미지팩 이미지 수가 허용 범위를 벗어났습니다.')
            if (type(image_bytes) is not int or not 0 < image_bytes <= MAX_ARCHIVE_IMAGE_BYTES
                    or image_bytes > image_count * MAX_IMAGE_BYTES):
                raise DakiStyleArchiveError('최신 이미지팩 이미지 용량이 허용 범위를 벗어났습니다.')

            matches = [item for item in siblings
                       if isinstance(item, dict) and item.get('rfilename') == filename]
            if len(matches) != 1:
                raise DakiStyleArchiveError('최신 이미지팩 파일을 리비전에서 찾지 못했습니다.')
            sibling = matches[0]
            lfs = sibling.get('lfs')
            if (not isinstance(lfs, dict)
                    or type(sibling.get('size')) is not int or sibling['size'] != size
                    or type(lfs.get('size')) is not int or lfs['size'] != size
                    or lfs.get('sha256') != digest):
                raise DakiStyleArchiveError('최신 이미지팩 크기 또는 해시가 리비전과 일치하지 않습니다.')

            recommendation_seed = None
            if 'seed_sha256' in info:
                seed_digest = info.get('seed_sha256')
                if not isinstance(seed_digest, str) or not re.fullmatch(r'[0-9a-f]{64}', seed_digest):
                    raise DakiStyleArchiveError('게시물 추천수 자료 SHA-256 정보가 올바르지 않습니다.')
                seed_matches = [item for item in siblings
                                if isinstance(item, dict)
                                and item.get('rfilename') == RECOMMENDATION_SEED_FILENAME]
                if len(seed_matches) != 1:
                    raise DakiStyleArchiveError('게시물 추천수 자료를 리비전에서 찾지 못했습니다.')
                seed_sibling = seed_matches[0]
                seed_lfs = seed_sibling.get('lfs')
                seed_size = seed_sibling.get('size')
                if (type(seed_size) is not int or not 0 < seed_size <= MAX_RECOMMENDATION_SEED_BYTES
                        or not isinstance(seed_lfs, dict)
                        or type(seed_lfs.get('size')) is not int or seed_lfs['size'] != seed_size
                        or seed_lfs.get('sha256') != seed_digest):
                    raise DakiStyleArchiveError('게시물 추천수 자료 크기 또는 해시가 리비전과 일치하지 않습니다.')
                recommendation_seed = {
                    'filename': RECOMMENDATION_SEED_FILENAME,
                    'bytes': seed_size,
                    'sha256': seed_digest,
                    'url': (HF_ARCHIVE_INFO_URL + revision + '/' + RECOMMENDATION_SEED_FILENAME
                            + '?download=true'),
                }
            if _stopped(stop_event):
                return None
            spec = {
                'filename': filename,
                'revision': revision,
                'url': (HF_ARCHIVE_INFO_URL + revision + '/' + filename + '?download=true'),
                'bytes': size,
                'sha256': digest,
                'image_count': image_count,
                'image_bytes': image_bytes,
            }
            if recommendation_seed is not None:
                spec['recommendation_seed'] = recommendation_seed
            if progress:
                progress(archive_revision=revision, archive_filename=filename, archive_sha256=digest,
                         total_images=image_count)
            return spec
    except requests.RequestException:
        raise DakiStyleArchiveError('Hugging Face 최신 이미지팩 정보에 연결하지 못했습니다.') from None


def _download(target, spec, stop_event, progress, url=None, *, label='이미지팩',
              download_message=None, verification_message=None):
    partial = target.with_name(target.name + '.partial')
    phase = 'download' if label == '이미지팩' else 'recommendation_download'
    if download_message is None:
        download_message = ('Hugging Face 이미지팩 다운로드 중' if label == '이미지팩'
                            else f'{label} 다운로드 중')
    if verification_message is None:
        verification_message = ('이미지팩 무결성 확인 중' if label == '이미지팩'
                                 else f'{label} 확인 중')
    offset = partial.stat().st_size if partial.exists() else 0
    if offset > spec['bytes']:
        partial.unlink()
        offset = 0
    if _stopped(stop_event):
        return False
    if offset < spec['bytes']:
        try:
            with public_session() as session:
                headers = {'Accept-Encoding': 'identity'}
                if offset:
                    headers['Range'] = f'bytes={offset}-'
                response = _response(session, headers, url=url)
                with response:
                    if response.status_code not in (200, 206):
                        raise DakiStyleArchiveError(f'{label} 다운로드에 실패했습니다. HTTP {response.status_code}')
                    if response.status_code == 206:
                        expected_range = f'bytes {offset}-{spec["bytes"] - 1}/{spec["bytes"]}'
                        if response.headers.get('Content-Range') != expected_range:
                            raise DakiStyleArchiveError(f'{label} 이어받기 범위가 올바르지 않습니다.')
                    else:
                        offset = 0  # A server ignoring Range returns a complete replacement.
                    length = response.headers.get('Content-Length')
                    if length is not None and length != str(spec['bytes'] - offset):
                        raise DakiStyleArchiveError(f'{label} 다운로드 크기가 예상과 다릅니다.')
                    if 'text/html' in response.headers.get('Content-Type', '').lower():
                        raise DakiStyleArchiveError(f'{label} 대신 웹페이지가 반환되었습니다.')
                    with partial.open('ab' if offset else 'wb') as output:
                        _report(progress, offset, spec['bytes'], download_message,
                                phase=phase, phase_current=offset, phase_total=spec['bytes'])
                        for chunk in response.iter_content(CHUNK_BYTES):
                            if _stopped(stop_event):
                                return False
                            if not chunk:
                                continue
                            if offset + len(chunk) > spec['bytes']:
                                raise DakiStyleArchiveError(f'{label} 크기가 허용 범위를 초과했습니다.')
                            output.write(chunk)
                            offset += len(chunk)
                            _report(progress, offset, spec['bytes'], download_message,
                                    phase=phase, phase_current=offset, phase_total=spec['bytes'])
        except requests.RequestException:
            raise DakiStyleArchiveError(
                f'Hugging Face {label}에 연결하지 못했습니다. 다시 시도하면 이어받습니다.'
            ) from None
    if partial.stat().st_size != spec['bytes']:
        raise DakiStyleArchiveError(f'{label} 다운로드가 완료되지 않았습니다. 다시 시도하면 이어받습니다.')
    if not _verify_digest(partial, spec, stop_event, progress, label=label,
                          message=verification_message):
        return False
    partial.replace(target)
    return True


def _verify_digest(path, spec, stop_event, progress, *, label='이미지팩', message=None):
    if path.stat().st_size != spec['bytes']:
        raise DakiStyleArchiveError(f'{label} 크기가 예상과 다릅니다.')
    digest = hashlib.sha256()
    if message is None:
        message = '이미지팩 무결성 확인 중' if label == '이미지팩' else f'{label} 확인 중'
    phase = 'verify' if label == '이미지팩' else 'recommendation_verify'
    checked = 0
    _report(progress, spec['bytes'], spec['bytes'], message,
            phase=phase, phase_current=checked, phase_total=spec['bytes'])
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b''):
            if _stopped(stop_event):
                return False
            digest.update(chunk)
            checked += len(chunk)
            _report(progress, spec['bytes'], spec['bytes'], message,
                    phase=phase, phase_current=checked, phase_total=spec['bytes'])
    if digest.hexdigest() != spec['sha256']:
        # Only remove our own invalid cache so a retry can download afresh.
        path.unlink()
        raise DakiStyleArchiveError(f'{label}의 SHA-256이 일치하지 않습니다. 다시 다운로드해 주세요.')
    return True


def _validated_recommendation_seed(value, revision=None):
    if not isinstance(value, dict):
        raise DakiStyleArchiveError('게시물 추천수 자료 정보가 없습니다. 최신 이미지팩 정보를 확인해 주세요.')
    filename = value.get('filename')
    size = value.get('bytes')
    digest = value.get('sha256')
    url = value.get('url')
    if (filename != RECOMMENDATION_SEED_FILENAME
            or type(size) is not int or not 0 < size <= MAX_RECOMMENDATION_SEED_BYTES
            or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest)
            or not isinstance(url, str)
            or not re.fullmatch(re.escape(HF_ARCHIVE_INFO_URL)
                                + r'[0-9a-f]{40}/arca_style_seed\.sqlite\?download=true', url)):
        raise DakiStyleArchiveError('게시물 추천수 자료 정보가 올바르지 않습니다.')
    if revision is not None and url != (
            HF_ARCHIVE_INFO_URL + revision + '/' + RECOMMENDATION_SEED_FILENAME + '?download=true'):
        raise DakiStyleArchiveError('게시물 추천수 자료 리비전 정보가 이미지팩과 일치하지 않습니다.')
    return {'filename': filename, 'bytes': size, 'sha256': digest, 'url': url}


def _read_recommendation_counts(path, stop_event):
    connection = None
    try:
        uri = path.resolve().as_uri() + '?mode=ro&immutable=1'
        connection = sqlite3.connect(uri, uri=True)
        connection.execute('PRAGMA query_only=ON')
        connection.execute('PRAGMA trusted_schema=OFF')
        rows = connection.execute(
            'SELECT source_url, recommendation_count FROM arca_style_items LIMIT 100001'
        ).fetchall()
    except (OSError, ValueError, sqlite3.Error):
        raise DakiStyleArchiveError('게시물 추천수 자료를 읽지 못했습니다.') from None
    finally:
        if connection is not None:
            connection.close()
    if _stopped(stop_event):
        return None
    if len(rows) > MAX_RECOMMENDATION_SEED_POSTS:
        raise DakiStyleArchiveError('게시물 추천수 자료가 허용 크기를 초과했습니다.')
    counts = {}
    for raw_url, raw_count in rows:
        if _stopped(stop_event):
            return None
        canonical = canonical_source_url(raw_url)
        if (canonical is None
                or not isinstance(raw_url, str)
                or not re.fullmatch(r'https://arca\.live/b/aiart/[0-9]+/?', raw_url)
                or not re.fullmatch(r'https://arca\.live/b/aiart/[0-9]+', canonical)):
            raise DakiStyleArchiveError('게시물 추천수 자료에 올바르지 않은 원본 주소가 있습니다.')
        if canonical in counts:
            raise DakiStyleArchiveError('게시물 추천수 자료에 중복된 원본 주소가 있습니다.')
        counts[canonical] = raw_count if type(raw_count) is int and raw_count >= 0 else None
    return counts


def _manifest(archive, spec):
    infos = archive.infolist()
    by_name = {info.filename: info for info in infos}
    if len(infos) != len(by_name) or len(infos) != spec['image_count'] + 1:
        raise DakiStyleArchiveError('이미지팩의 파일 목록이 올바르지 않습니다.')
    for info in infos:
        if info.flag_bits & 1 or info.is_dir() or stat.S_ISLNK(info.external_attr >> 16):
            raise DakiStyleArchiveError('이미지팩에 허용되지 않는 파일이 있습니다.')
    manifest_info = by_name.get('manifest.json')
    if manifest_info is None or manifest_info.file_size > MAX_MANIFEST_BYTES:
        raise DakiStyleArchiveError('이미지팩 매니페스트가 없거나 너무 큽니다.')
    try:
        manifest = json.loads(archive.read(manifest_info))
    except (ValueError, UnicodeError):
        raise DakiStyleArchiveError('이미지팩 매니페스트를 읽지 못했습니다.') from None
    if not isinstance(manifest, dict) or manifest.get('format') != FORMAT or manifest.get('version') != 2:
        raise DakiStyleArchiveError('지원하지 않는 이미지팩 형식입니다.')
    files = manifest.get('files')
    if (not isinstance(files, list) or len(files) != spec['image_count']
            or manifest.get('file_count') != spec['image_count']
            or manifest.get('total_bytes') != spec['image_bytes']):
        raise DakiStyleArchiveError('이미지팩의 이미지 수 또는 용량이 예상과 다릅니다.')
    names = set()
    identities = set()
    total = 0
    for entry in files:
        if not isinstance(entry, dict):
            raise DakiStyleArchiveError('이미지팩의 이미지 항목이 올바르지 않습니다.')
        source, identity = entry.get('source_url'), entry.get('image_identity')
        if (not isinstance(source, str) or not re.fullmatch(r'https://arca\.live/b/aiart/\d+', source)
                or not isinstance(identity, str) or len(identity) > 8192
                or not identity.startswith('https://') or '#' in identity):
            raise DakiStyleArchiveError('이미지팩의 원본 이미지 정보가 올바르지 않습니다.')
        name = hashlib.sha256((source + '\n' + identity).encode()).hexdigest() + '.webp'
        info = by_name.get('arca_style_images/' + name)
        size, digest = entry.get('bytes'), entry.get('sha256')
        if (entry.get('name') != name or name in names or (source, identity) in identities
                or type(entry.get('image_id')) is not int or type(entry.get('item_id')) is not int
                or type(size) is not int or not 0 < size <= MAX_IMAGE_BYTES
                or info is None or info.file_size != size
                or not isinstance(digest, str) or not re.fullmatch('[0-9a-f]{64}', digest)):
            raise DakiStyleArchiveError('이미지팩의 이미지 파일 정보가 올바르지 않습니다.')
        names.add(name)
        identities.add((source, identity))
        total += size
    if total != spec['image_bytes'] or set(by_name) != {'manifest.json'} | {'arca_style_images/' + name for name in names}:
        raise DakiStyleArchiveError('이미지팩의 파일 또는 전체 용량이 일치하지 않습니다.')
    return files


def iter_archive_images(root, stop_event=None, progress=None, *, expected=None,
                        include_recommendations=False):
    """Yield verified image bytes; retain the ZIP for interrupted import retries.

    ``expected`` supplies a complete pack specification for small synthetic tests.
    Production callers discover the latest release and pin it to the returned revision.
    ``include_recommendations`` loads the optional, revision-pinned post-count seed.
    """
    root = Path(root)
    if _stopped(stop_event):
        return
    if expected is None:
        spec = latest_archive_spec(stop_event, progress)
        if spec is None or _stopped(stop_event):
            return
        cache_root = root / spec['sha256']
        filename = spec['filename']
        archive_url = spec['url']
    else:
        # Keep the synthetic expected= seam independent of metadata networking.
        spec = expected
        cache_root = root
        filename = ARCHIVE_FILENAME
        archive_url = None
    recommendation_seed = None
    if include_recommendations:
        recommendation_seed = _validated_recommendation_seed(
            spec.get('recommendation_seed'), revision=spec.get('revision'))
    root.mkdir(parents=True, exist_ok=True)
    cache_root.mkdir(parents=True, exist_ok=True)
    target = cache_root / filename
    try:
        if target.exists():
            if not _verify_digest(target, spec, stop_event, progress):
                return
        elif not _download(target, spec, stop_event, progress, url=archive_url):
            return
        if _stopped(stop_event):
            return
        with zipfile.ZipFile(target) as archive:
            files = _manifest(archive, spec)
            recommendation_counts = None
            if recommendation_seed is not None:
                seed_target = cache_root / recommendation_seed['filename']
                if seed_target.exists():
                    if not _verify_digest(
                            seed_target, recommendation_seed, stop_event, progress,
                            label='게시물 추천수 자료', message='게시물 추천수 자료 확인 중'):
                        return
                elif not _download(
                        seed_target, recommendation_seed, stop_event, progress,
                        url=recommendation_seed['url'], label='게시물 추천수 자료',
                        download_message='게시물 추천수 자료 다운로드 중',
                        verification_message='게시물 추천수 자료 확인 중'):
                    return
                if _stopped(stop_event):
                    return
                if progress:
                    progress(phase='recommendations', phase_current=0, phase_total=0,
                             message='게시물 추천수 읽는 중')
                recommendation_counts = _read_recommendation_counts(seed_target, stop_event)
                if recommendation_counts is None:
                    return
            if progress:
                progress(phase='inspect', phase_current=0, phase_total=0,
                         total_images=len(files), message='이미지별 그림체와 필터 확인 중')
            posts = set()
            for index, entry in enumerate(files, 1):
                if _stopped(stop_event):
                    return
                data = archive.read('arca_style_images/' + entry['name'])
                if hashlib.sha256(data).hexdigest() != entry['sha256']:
                    raise DakiStyleArchiveError('이미지팩의 개별 이미지 SHA-256이 일치하지 않습니다.')
                posts.add(entry['source_url'])
                _report(progress, spec['bytes'], spec['bytes'], '공유 그림체 가져오는 중', index, len(posts))
                yield {
                    'source_url': entry['source_url'],
                    'title': '공유 그림체 · #' + entry['source_url'].rsplit('/', 1)[-1],
                    'recommendation_count': (recommendation_counts.get(entry['source_url'])
                                             if recommendation_counts is not None else None),
                    'image_url': entry['image_identity'],
                    'image_bytes': data,
                }
    except DakiStyleArchiveError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError):
        raise DakiStyleArchiveError('이미지팩을 읽지 못했습니다. 저장 공간과 파일 상태를 확인해 주세요.') from None
