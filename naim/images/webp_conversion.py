"""Verified image replacement, with archived source metadata.

WebP's native EXIF/ICCP/XMP chunks carry standard metadata. A private ``NAIM``
RIFF chunk additionally keeps PNG metadata which WebP cannot represent (text,
language fields, palette/transparency, unknown chunks and duplicate keys).
Version 1 is ``b'PNGM\\x01' + sha256(payload) + zlib(payload)``; payload is a
big-endian JSON byte length, typed JSON Pillow info, and the original PNG
signature/chunks with only IDAT chunks omitted. Original chunk bytes/CRCs and
ordering survive. No pickle, external sidecar, or original pixel copy is used.

Unsupported inputs and failed verification keep the source. Publication never
overwrites an existing WebP. This protects ordinary failures, not power loss
or unrelated programs modifying files during the final filesystem operations.
"""
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
import zlib

from PIL import Image
from PIL.PngImagePlugin import iTXt

from naim.storage.image_files import IMAGE_FILES_LOCK


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_ARCHIVE_MAGIC = b"PNGM\x01"
_ARCHIVE_CHUNK = b"NAIM"
_MAX_METADATA = 64 * 1024 * 1024
# Lossless method 1 avoids method 0's larger outputs at modest extra cost;
# lossy method 0 keeps the selected quality with the fastest encoder search.
_LOSSLESS_ENCODER_METHOD = 1
_LOSSY_ENCODER_METHOD = 0


def _encode_info(value):
    if isinstance(value, iTXt):
        return ["itxt", str(value), value.lang, value.tkey]
    if isinstance(value, bytes):
        return ["bytes", base64.b64encode(value).decode("ascii")]
    if isinstance(value, tuple):
        return ["tuple", [_encode_info(item) for item in value]]
    if isinstance(value, list):
        return ["list", [_encode_info(item) for item in value]]
    if isinstance(value, dict):
        return ["dict", [[_encode_info(key), _encode_info(item)] for key, item in value.items()]]
    if value is None or isinstance(value, (str, bool, int, float)):
        return ["value", value]
    raise ValueError("보존할 수 없는 PNG 메타데이터 형식입니다.")


def _decode_info(value):
    tag, *data = value
    if tag == "itxt" and len(data) == 3:
        return iTXt(*data)
    if tag == "bytes" and len(data) == 1:
        return base64.b64decode(data[0], validate=True)
    if tag in ("tuple", "list") and len(data) == 1:
        decoded = [_decode_info(item) for item in data[0]]
        return tuple(decoded) if tag == "tuple" else decoded
    if tag == "dict" and len(data) == 1:
        return {_decode_info(key): _decode_info(item) for key, item in data[0]}
    if tag == "value" and len(data) == 1 and (data[0] is None or isinstance(data[0], (str, bool, int, float))):
        return data[0]
    raise ValueError("잘못된 PNG 메타데이터 보관 형식입니다.")


def _png_metadata(path):
    """Validate every CRC, retaining every chunk except compressed pixels."""
    metadata = bytearray(_PNG_SIGNATURE)
    digest = hashlib.sha256()
    header = None
    has_pixels = False
    with open(path, "rb") as stream:
        signature = stream.read(8)
        if signature != _PNG_SIGNATURE:
            raise ValueError("PNG 파일이 아닙니다.")
        digest.update(signature)
        while True:
            chunk_header = stream.read(8)
            if len(chunk_header) != 8:
                raise ValueError("PNG 청크가 손상되었습니다.")
            length, kind = struct.unpack(">I4s", chunk_header)
            if header is None and (kind != b"IHDR" or length != 13):
                raise ValueError("PNG 헤더가 손상되었습니다.")
            if kind in (b"acTL", b"fcTL", b"fdAT"):
                raise ValueError("움직이는 PNG는 원본을 유지합니다.")
            if not kind[0] & 32 and kind not in (b"IHDR", b"PLTE", b"IDAT", b"IEND"):
                raise ValueError("지원하지 않는 PNG 필수 청크입니다.")
            keep = kind != b"IDAT"
            if keep and len(metadata) + length + 12 > _MAX_METADATA:
                raise ValueError("PNG 메타데이터가 안전한 보관 한도를 넘습니다.")
            digest.update(chunk_header)
            if keep:
                metadata.extend(chunk_header)
            crc = zlib.crc32(kind)
            remaining = length
            header_data = bytearray()
            while remaining:
                data = stream.read(min(remaining, 1024 * 1024))
                if not data:
                    raise ValueError("PNG 청크가 잘렸습니다.")
                digest.update(data)
                crc = zlib.crc32(data, crc)
                if keep:
                    metadata.extend(data)
                if kind == b"IHDR":
                    header_data.extend(data)
                remaining -= len(data)
            checksum = stream.read(4)
            if len(checksum) != 4 or struct.unpack(">I", checksum)[0] != crc & 0xffffffff:
                raise ValueError("PNG 메타데이터 또는 픽셀 CRC 검증에 실패했습니다.")
            digest.update(checksum)
            if keep:
                metadata.extend(checksum)
            if kind == b"IHDR":
                if header is not None:
                    raise ValueError("중복된 PNG 헤더입니다.")
                header = struct.unpack(">IIBBBBB", header_data)
            elif kind == b"IDAT":
                has_pixels = True
            elif kind == b"IEND":
                if length or not has_pixels or stream.read(1):
                    raise ValueError("지원하지 않는 PNG 종료 데이터입니다.")
                break
    width, height, bit_depth = header[:3]
    if bit_depth == 16:
        raise ValueError("16비트 PNG는 정밀도를 보존하기 위해 원본을 유지합니다.")
    if not (0 < width <= 16383 and 0 < height <= 16383):
        raise ValueError("WebP가 지원하는 이미지 크기를 넘습니다.")
    return bytes(metadata), digest.digest()


def _make_archive(info, png_chunks):
    encoded = json.dumps(_encode_info(info), ensure_ascii=True, allow_nan=False,
                         separators=(",", ":")).encode("utf-8")
    payload = struct.pack(">I", len(encoded)) + encoded + png_chunks
    if len(payload) > _MAX_METADATA:
        raise ValueError("PNG 메타데이터가 안전한 보관 한도를 넘습니다.")
    return _ARCHIVE_MAGIC + hashlib.sha256(payload).digest() + zlib.compress(payload)


def _read_archive(archive):
    header_size = len(_ARCHIVE_MAGIC) + 32
    if not archive.startswith(_ARCHIVE_MAGIC):
        raise ValueError("지원하지 않는 PNG 메타데이터 보관 버전입니다.")
    decompressor = zlib.decompressobj()
    payload = decompressor.decompress(archive[header_size:], _MAX_METADATA + 1)
    if (len(payload) > _MAX_METADATA or not decompressor.eof or decompressor.unused_data
            or hashlib.sha256(payload).digest() != archive[len(_ARCHIVE_MAGIC):header_size]):
        raise ValueError("보관된 PNG 메타데이터 검증에 실패했습니다.")
    length = struct.unpack(">I", payload[:4])[0]
    info = _decode_info(json.loads(payload[4:4 + length].decode("utf-8")))
    chunks = payload[4 + length:]
    if not isinstance(info, dict) or not chunks.startswith(_PNG_SIGNATURE):
        raise ValueError("보관된 PNG 메타데이터 형식이 잘못되었습니다.")
    return info, chunks


def restore_webp_metadata(image):
    """Restore archived source info on an opened WebP; ordinary images are unchanged.

    Pillow's WebP demuxer retains unknown chunks even after ``load()`` closes
    its input. Using that copy also supports BytesIO callers without reopening
    a filename. Corrupt/foreign archives are ignored during ordinary reading;
    conversion itself verifies the archive before deleting the source image.
    """
    if getattr(image, "format", None) != "WEBP" or getattr(image, "_naim_metadata_restored", False):
        return image
    try:
        archive = image._decoder.get_chunk(_ARCHIVE_CHUNK.decode("ascii"))
        if archive:
            info, _ = _read_archive(archive)
            # PNG transparency indexes/colors are encoded in WebP's pixels.
            # Reapplying them to decoded RGB could invent new transparent pixels.
            # Their exact original values remain available in the archive.
            image.info.update({key: value for key, value in info.items() if key != "transparency"})
        image._naim_metadata_restored = True
    except (AttributeError, ValueError, TypeError, KeyError, IndexError, RecursionError,
            zlib.error, struct.error, UnicodeError):
        pass
    return image


def _append_archive(path, archive, size, has_alpha):
    with open(path, "r+b") as stream:
        header = stream.read(12)
        if header[:4] != b"RIFF" or header[8:12] != b"WEBP":
            raise ValueError("잘못된 WebP 출력입니다.")
        body = stream.read()
        if body[:4] != b"VP8X":
            # libwebp only demuxes metadata from the extended container.
            width, height = size
            extended = bytes([0x10 if has_alpha else 0, 0, 0, 0])
            extended += (width - 1).to_bytes(3, "little") + (height - 1).to_bytes(3, "little")
            stream.seek(12)
            stream.write(b"VP8X" + struct.pack("<I", 10) + extended + body)
        stream.seek(0, os.SEEK_END)
        stream.write(_ARCHIVE_CHUNK + struct.pack("<I", len(archive)) + archive)
        if len(archive) & 1:
            stream.write(b"\0")
        size = stream.tell()
        if size - 8 > 0xffffffff:
            raise ValueError("WebP 파일 크기 한도를 넘습니다.")
        stream.seek(4)
        stream.write(struct.pack("<I", size - 8))
        stream.flush()
        os.fsync(stream.fileno())


def _verify_webp(path, original, archive, native, lossless):
    with Image.open(path) as result:
        result.load()
        if result.format != "WEBP" or result.size != original.size or result.n_frames != 1:
            raise ValueError("WebP 이미지 크기 또는 프레임 검증에 실패했습니다.")
        actual_archive = result._decoder.get_chunk(_ARCHIVE_CHUNK.decode("ascii"))
        if actual_archive != archive:
            raise ValueError("WebP의 PNG 메타데이터 보관 검증에 실패했습니다.")
        _read_archive(actual_archive)
        for key, expected in native.items():
            if key == "exif" and expected.startswith(b"Exif\0\0"):
                expected = expected[6:]
            if result.info.get(key, b"") != expected:
                raise ValueError("WebP 표준 메타데이터 검증에 실패했습니다.")
        restored = result.convert("RGBA")
        if restored.getchannel("A").tobytes() != original.getchannel("A").tobytes():
            raise ValueError("투명도 또는 숨겨진 메타데이터 검증에 실패했습니다.")
        if lossless and restored.tobytes() != original.tobytes():
            raise ValueError("무손실 픽셀 검증에 실패했습니다.")


def _preserve_times(path, source_stat):
    os.utime(path, ns=(source_stat.st_atime_ns, source_stat.st_mtime_ns))
    if os.name != "nt":
        return
    # Windows creation time drives the gallery's creation-date ordering.
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.SetFileTime.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME),
                                  ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
    kernel.SetFileTime.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.CreateFileW(str(path), 0x100, 7, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        nanoseconds = getattr(source_stat, "st_birthtime_ns", source_stat.st_ctime_ns)
        ticks = nanoseconds // 100 + 116444736000000000
        creation = wintypes.FILETIME(ticks & 0xffffffff, ticks >> 32)
        if not kernel.SetFileTime(handle, ctypes.byref(creation), None, None):
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(handle)


def _identity(stat):
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def _digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.digest()


def _sidecar_snapshot(path):
    """Return a stable regular-file identity and digest, or None if absent."""
    try:
        before = path.lstat()
    except FileNotFoundError:
        return None
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError("이미지 보조 파일은 일반 파일이어야 합니다.")
    digest = _digest_file(path)
    after = path.lstat()
    if _identity(after) != _identity(before) or _digest_file(path) != digest:
        raise ValueError("변환 중 이미지 보조 파일이 변경되었습니다.")
    return _identity(after), after.st_size, digest


def _retain_target(error):
    try:
        error.retain_target = True
    except Exception:
        pass
    return error


def _undo_sidecar(path, identity, size, digest):
    """Remove only the exact sidecar this conversion atomically published."""
    try:
        current = _sidecar_snapshot(path)
    except Exception as error:
        raise _retain_target(error)
    if current is None:
        return
    if current != (identity, size, digest):
        raise _retain_target(ValueError("이미지 보조 파일이 변경되어 WebP와 함께 보존합니다."))
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except Exception as error:
        raise _retain_target(error)


def _rollback_sidecars(undos):
    errors = []
    for undo in reversed(undos):
        try:
            undo()
        except Exception as error:
            errors.append(error)
    return errors


def _copy_one_sidecar(source, target):
    source_state = _sidecar_snapshot(source)
    if source_state is None:
        return None
    source_identity, source_size, source_digest = source_state
    target_state = _sidecar_snapshot(target)
    if target_state is not None:
        if target_state[1:] == (source_size, source_digest):
            return None
        raise FileExistsError("같은 이름의 다른 이미지 보조 파일이 있어 원본을 유지합니다.")

    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
                dir=target.parent, prefix=".naim-webp-sidecar-", suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            copied_digest = hashlib.sha256()
            with open(source, "rb") as input_stream:
                if _identity(os.fstat(input_stream.fileno())) != source_identity:
                    raise ValueError("복사 중 이미지 보조 파일이 변경되었습니다.")
                for data in iter(lambda: input_stream.read(1024 * 1024), b""):
                    copied_digest.update(data)
                    output.write(data)
            output.flush()
            os.fsync(output.fileno())

        copied_digest = copied_digest.digest()
        final_source_state = _sidecar_snapshot(source)
        if (final_source_state != source_state or copied_digest != source_digest
                or temporary.stat().st_size != source_size or _digest_file(temporary) != source_digest):
            raise ValueError("복사 중 이미지 보조 파일이 변경되었습니다.")
        try:
            os.link(temporary, target)
        except FileExistsError:
            # Another writer may have published the same bytes after our check.
            target_state = _sidecar_snapshot(target)
            if target_state is not None and target_state[1:] == (source_size, source_digest):
                return None
            raise FileExistsError("같은 이름의 다른 이미지 보조 파일이 있어 원본을 유지합니다.")
        published_state = _sidecar_snapshot(target)
        if published_state is None or published_state[1:] != (source_size, source_digest):
            raise _retain_target(ValueError("게시된 이미지 보조 파일 검증에 실패했습니다."))
        identity, size, digest = published_state
        return lambda: _undo_sidecar(target, identity, size, digest)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


def _copy_image_sidecars(source, target):
    """Copy non-PNG companion files at the callback's locked commit boundary."""
    undos = []
    try:
        for suffix in (".json", ".txt"):
            source_sidecar = source.with_suffix(suffix)
            target_sidecar = target.with_suffix(suffix)
            if source_sidecar == target_sidecar:
                continue
            undo = _copy_one_sidecar(source_sidecar, target_sidecar)
            if undo is not None:
                undos.append(undo)
    except Exception as error:
        if _rollback_sidecars(undos):
            _retain_target(error)
        raise
    return undos


def _with_image_sidecars(source, target, before_delete):
    """Compose sidecar publication with existing reference update/rollback."""
    sidecar_undos = _copy_image_sidecars(source, target)
    try:
        reference_undo = before_delete(str(source), str(target)) if before_delete is not None else None
        if reference_undo is not None and not callable(reference_undo):
            raise ValueError("경로 갱신의 복구 함수가 올바르지 않습니다.")
    except Exception as error:
        if not getattr(error, "retain_target", False) and _rollback_sidecars(sidecar_undos):
            _retain_target(error)
        raise

    if not sidecar_undos:
        return reference_undo

    def combined_undo():
        if callable(reference_undo):
            try:
                reference_undo()
            except Exception as error:
                # References may still point at WebP, so its companion files
                # must remain available with the image if reference rollback fails.
                raise _retain_target(error)
        errors = _rollback_sidecars(sidecar_undos)
        if errors:
            raise errors[0]

    return combined_undo


def _check_cancelled(cancel_event):
    if cancel_event is not None and cancel_event.is_set():
        raise InterruptedError("WebP 변환이 취소되어 이미지 원본을 유지합니다.")


def webp_target_path(source_path):
    """Return the WebP output path without colliding with same-stem inputs."""
    source = Path(source_path)
    if source.suffix.lower() == ".png":
        return source.with_suffix(".webp")
    return source.with_name(source.name + ".webp")


def _has_symlink_component(path):
    path = Path(path)
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink() or getattr(current, "is_junction", lambda: False)():
            return True
    return False


def resolve_webp_image(source_path):
    """Resolve a missing source to its exact existing WebP replacement."""
    source = Path(source_path).absolute()
    target = webp_target_path(source)
    if target.parent != source.parent or _has_symlink_component(source):
        raise ValueError("심볼릭 링크 또는 폴더 이탈 이미지 경로는 사용할 수 없습니다.")
    if os.path.lexists(source):
        if source.is_symlink() or source.is_dir():
            raise ValueError("일반 이미지 파일만 사용할 수 있습니다.")
        return source
    if _has_symlink_component(target):
        raise ValueError("심볼릭 링크 또는 폴더 이탈 이미지 경로는 사용할 수 없습니다.")
    if target.is_file():
        return target
    return source


def _convert_image_to_webp(source_path, *, png_only, lossless=True, quality=90, before_delete=None,
                           dry_run=False, cancel_event=None, keep_original=False):
    """Convert one source image and delete it only after pixels/metadata are verified.

    ``before_delete(source, target)`` keeps its historical name for compatibility
    and may update path references after WebP is published. It returns a rollback
    callable, used if a later check fails; a callback that raises must undo its
    own partial changes. The callback runs whether or not the source is retained.
    ``dry_run`` encodes and verifies a temporary WebP, returning ``estimated``
    and actual encoded byte counts without publishing, callbacks or deletion.
    ``keep_original=True`` publishes the verified WebP without deleting the source.
    Preparation may run concurrently. Publication, reference updates, source
    deletion and their rollback serialize under ``IMAGE_FILES_LOCK``. Optional
    ``cancel_event`` is checked between stages; a running native encode finishes
    before cancellation is observed. Cancellation returns ``skipped``. Encoder
    failures return ``failed``; unsupported inputs and other safe skips return
    ``skipped``. Results include byte counts and an optional human-readable ``reason``.
    """
    source = Path(source_path).absolute()
    target = webp_target_path(source)
    result = {"status": "skipped", "source_bytes": 0, "target_bytes": 0}
    temporary = None
    published = False
    rollback = None
    target_digest = None
    with ExitStack() as commit:
        try:
            _check_cancelled(cancel_event)
            if source.is_symlink() or (png_only and source.suffix.lower() != ".png"):
                raise ValueError("일반 PNG 파일만 변환합니다.")
            if not png_only and source.suffix.lower() == ".webp":
                raise ValueError("이미 WebP 파일이라 변환을 건너뜁니다.")
            if not png_only and source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".bmp", ".gif"}:
                raise ValueError("PNG, JPEG, BMP 또는 정지 GIF 파일만 변환합니다.")
            if not isinstance(keep_original, bool):
                raise ValueError("원본 보존 설정이 올바르지 않습니다.")
            if not isinstance(lossless, bool) or isinstance(quality, bool) or not isinstance(quality, (int, float)) or not 0 <= quality <= 100:
                raise ValueError("WebP 압축 설정이 올바르지 않습니다.")
            source_stat = source.stat()
            result["source_bytes"] = source_stat.st_size
            if os.path.lexists(target) or (os.name != 'nt' and any(
                    item.name.casefold() == target.name.casefold() for item in source.parent.iterdir())):
                raise ValueError("같은 이름의 WebP가 이미 있어 원본을 유지합니다.")
            _check_cancelled(cancel_event)
            if png_only:
                png_chunks, source_digest = _png_metadata(source)
            else:
                png_chunks, source_digest = None, _digest_file(source)
            _check_cancelled(cancel_event)
            with Image.open(source) as image:
                image.load()
                if image.format not in {"PNG", "JPEG", "BMP", "GIF"}:
                    raise ValueError("지원하는 PNG, JPEG, BMP 또는 GIF 이미지가 아닙니다.")
                if png_only and image.format != "PNG":
                    raise ValueError("정지 PNG 파일만 변환합니다.")
                if getattr(image, "is_animated", False) or getattr(image, "n_frames", 1) != 1:
                    raise ValueError("움직이는 이미지는 원본을 유지합니다.")
                if not (0 < image.width <= 16383 and 0 < image.height <= 16383):
                    raise ValueError("WebP가 지원하는 이미지 크기를 넘습니다.")
                if image.format == "PNG" and png_chunks is None:
                    png_chunks, source_digest = _png_metadata(source)
                _check_cancelled(cancel_event)
                archive = _make_archive(image.info, png_chunks if png_chunks is not None else _PNG_SIGNATURE)
                native = {key: image.info[key] for key in ("exif", "icc_profile", "xmp") if image.info.get(key)}
                if "xmp" not in native and image.info.get("XML:com.adobe.xmp"):
                    xmp = image.info["XML:com.adobe.xmp"]
                    native["xmp"] = xmp.encode("utf-8") if isinstance(xmp, str) else xmp
                rgba = image.convert("RGBA")
            with tempfile.NamedTemporaryFile(dir=source.parent, prefix=".naim-webp-", suffix=".tmp", delete=False) as stream:
                temporary = Path(stream.name)
            _check_cancelled(cancel_event)
            encoder_options = {
                "lossless": lossless,
                "quality": quality,
                "method": _LOSSLESS_ENCODER_METHOD if lossless else _LOSSY_ENCODER_METHOD,
                "exact": True,
                "alpha_quality": 100,
            }
            try:
                rgba.save(temporary, "WEBP", **encoder_options, **native)
            except ValueError as error:
                if lossless or str(error).strip().lower() != "encoding error 6":
                    raise
                _check_cancelled(cancel_event)
                # Retry only VP8's partition-0 overflow with the same quality and metadata.
                encoder_options["method"] = 4
                rgba.save(temporary, "WEBP", **encoder_options, **native)
            _check_cancelled(cancel_event)
            _append_archive(temporary, archive, rgba.size, rgba.getchannel("A").getextrema()[0] < 255)
            _check_cancelled(cancel_event)
            _verify_webp(temporary, rgba, archive, native, lossless)
            _check_cancelled(cancel_event)
            if not dry_run:
                _preserve_times(temporary, source_stat)
                target_digest = _digest_file(temporary)
            # Keep expensive preparation outside the shared file lock. ExitStack
            # holds it through exception handling and cleanup once publication
            # becomes possible, including callback rollback on cancellation.
            commit.enter_context(IMAGE_FILES_LOCK)
            _check_cancelled(cancel_event)
            if _identity(source.stat()) != _identity(source_stat) or _digest_file(source) != source_digest:
                raise ValueError("변환 중 원본 이미지가 변경되어 원본을 유지합니다.")
            _check_cancelled(cancel_event)
            if dry_run:
                result.update(status="estimated", target_bytes=temporary.stat().st_size)
                return result
            # A hard link atomically publishes a complete file without replacing
            # another file. Unsupported filesystems safely keep their source.
            os.link(temporary, target)
            published = True
            _check_cancelled(cancel_event)
            if before_delete is not None:
                rollback = before_delete(str(source), str(target))
                if rollback is not None and not callable(rollback):
                    raise ValueError("경로 갱신의 복구 함수가 올바르지 않습니다.")
            _check_cancelled(cancel_event)
            if _identity(source.stat()) != _identity(source_stat) or _digest_file(source) != source_digest:
                raise ValueError("변환 중 원본 이미지가 변경되어 원본을 유지합니다.")
            if _digest_file(target) != target_digest:
                raise ValueError("변환 중 WebP가 변경되어 원본을 유지합니다.")
            result["target_bytes"] = target.stat().st_size
            _check_cancelled(cancel_event)
            if not keep_original:
                source.unlink()
            result["status"] = "converted"
            return result
        except Exception as error:
            encoding_error = (re.fullmatch(r"encoding error ([0-9]+)", str(error).strip().lower())
                              if isinstance(error, ValueError) else None)
            if encoding_error:
                code = encoding_error.group(1)
                result["status"] = "failed"
                result["reason"] = (
                    "WebP 압축 한도를 초과해 변환하지 못했습니다(인코딩 오류 6). 원본은 유지했습니다."
                    if code == "6" else f"WebP 인코딩 실패(오류 {code})로 원본을 유지했습니다."
                )
            else:
                result["reason"] = str(error)
            if getattr(error, "retain_target", False):
                published = False
            if callable(rollback):
                try:
                    rollback()
                except Exception:
                    # References may still point to WebP; retain both files.
                    published = False
                    result["reason"] += " (경로 복구 실패: 원본과 WebP를 모두 보존했습니다.)"
            if published:
                try:
                    if _digest_file(target) == target_digest:
                        target.unlink()
                except OSError:
                    result["reason"] += " (WebP 정리 실패: 원본은 보존했습니다.)"
            return result
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    pass


def convert_png_to_webp(source_path, *, lossless=True, quality=90, before_delete=None,
                        dry_run=False, cancel_event=None, keep_original=False):
    """Convert one PNG using its complete original PNG metadata archive."""
    return _convert_image_to_webp(
        source_path, png_only=True, lossless=lossless, quality=quality,
        before_delete=before_delete, dry_run=dry_run, cancel_event=cancel_event,
        keep_original=keep_original,
    )


def convert_image_to_webp(source_path, *, lossless=False, quality=90, before_delete=None,
                          dry_run=False, cancel_event=None, keep_original=False):
    """Convert one supported still image, preserving its native metadata."""
    return _convert_image_to_webp(
        source_path, png_only=False, lossless=lossless, quality=quality,
        before_delete=lambda source, target: _with_image_sidecars(
            Path(source), Path(target), before_delete),
        dry_run=dry_run, cancel_event=cancel_event, keep_original=keep_original,
    )
