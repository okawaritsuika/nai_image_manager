"""Optional file-backed source tiles for the canvas compositor.

The endpoint returns one straight-RGBA atlas band per source. The browser owns
the compositing step so its Canvas2D blend behavior remains authoritative.
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import importlib
import importlib.util
import os
import tempfile
import threading
from urllib.parse import urlsplit

from flask import Response, jsonify, request

_pyvips = None
_PYVIPS_AVAILABLE = False
_BACKEND_INITIALIZED = False
_BACKEND_LOCK = threading.Lock()
_VIPS_TEMP_DIR_MANAGER = None
_VIPS_PREVIOUS_TEMP_ENV = None
_TEMP_ENV_NAMES = ("TMPDIR", "TMP", "TEMP")


MAX_SOURCES = 32
MAX_DOCUMENT_PIXELS = 160_000_000
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_ATLAS_PIXELS = 8_000_000
MAX_TILE_CACHE_BYTES = 32 * 1024 * 1024
MAX_SOURCE_CACHE_ENTRIES = 32
MAX_SOURCE_CACHE_ESTIMATED_BYTES = 10 * 1024 * 1024 * 1024
_SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
_RENDER_SLOTS = threading.BoundedSemaphore(2)
_OVERVIEW_PARALLEL_MIN_LOD = 8
_OVERVIEW_PARALLEL_MIN_SOURCES = 4
_OVERVIEW_PARALLEL_WORKERS = 2


class _TilePngCache:
    """Small LRU keyed by source file identity and tile geometry."""

    def __init__(self, max_bytes=MAX_TILE_CACHE_BYTES):
        self.max_bytes = max_bytes
        self.bytes_used = 0
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            value = self.items.get(key)
            if value is not None:
                self.items.move_to_end(key)
            return value

    def put(self, key, value):
        if len(value) > self.max_bytes:
            return
        with self.lock:
            previous = self.items.pop(key, None)
            if previous is not None:
                self.bytes_used -= len(previous)
            self.items[key] = value
            self.bytes_used += len(value)
            while self.bytes_used > self.max_bytes:
                _, removed = self.items.popitem(last=False)
                self.bytes_used -= len(removed)


class _SourceImageCache:
    """Keep a bounded set of lazy, random-access source image references."""

    def __init__(self, max_entries=MAX_SOURCE_CACHE_ENTRIES,
                 max_estimated_bytes=MAX_SOURCE_CACHE_ESTIMATED_BYTES):
        self.max_entries = max_entries
        self.max_estimated_bytes = max_estimated_bytes
        self.estimated_bytes = 0
        self.items = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            entry = self.items.get(key)
            if entry is not None:
                self.items.move_to_end(key)
                return entry[0]
            return None

    def put(self, key, image, estimated_bytes):
        if estimated_bytes > self.max_estimated_bytes:
            return
        with self.lock:
            stale_keys = [existing for existing in self.items
                          if existing[0] == key[0] and existing != key]
            for stale_key in stale_keys:
                _, stale_size = self.items.pop(stale_key)
                self.estimated_bytes -= stale_size
            previous = self.items.pop(key, None)
            if previous is not None:
                self.estimated_bytes -= previous[1]
            self.items[key] = (image, estimated_bytes)
            self.estimated_bytes += estimated_bytes
            while (len(self.items) > self.max_entries
                   or self.estimated_bytes > self.max_estimated_bytes):
                _, (_, removed_size) = self.items.popitem(last=False)
                self.estimated_bytes -= removed_size


_TILE_CACHE = _TilePngCache()
_SOURCE_IMAGE_CACHE = _SourceImageCache()


class CanvasSourceTileError(Exception):
    """A safe request/source validation error suitable for an HTTP response."""


def pyvips_available():
    _initialize_backend()
    return _PYVIPS_AVAILABLE


def _initialize_backend(scratch_dir=None):
    """Load pyvips with a private app-local temp directory for libvips scratch."""
    global _pyvips, _PYVIPS_AVAILABLE, _BACKEND_INITIALIZED
    global _VIPS_TEMP_DIR_MANAGER, _VIPS_PREVIOUS_TEMP_ENV
    if _BACKEND_INITIALIZED:
        return
    with _BACKEND_LOCK:
        if _BACKEND_INITIALIZED:
            return
        try:
            if importlib.util.find_spec("pyvips") is None:
                return
            if scratch_dir:
                _VIPS_TEMP_DIR_MANAGER = tempfile.TemporaryDirectory(
                    prefix="canvas_source_tiles_", dir=scratch_dir,
                )
                vips_temp = _VIPS_TEMP_DIR_MANAGER.name
                _VIPS_PREVIOUS_TEMP_ENV = {
                    name: os.environ.get(name) for name in _TEMP_ENV_NAMES
                }
                # GLib/libvips can choose a different variable than Python's
                # tempfile, so direct all of its supported temp variables here.
                for name in _TEMP_ENV_NAMES:
                    os.environ[name] = vips_temp
            _pyvips = importlib.import_module("pyvips")
            # Force DLL initialization now so a missing optional runtime yields
            # a clean false capability flag before any browser request arrives.
            _pyvips.version(0)
            _PYVIPS_AVAILABLE = True
            try:
                _pyvips.cache_set_max_mem(128 * 1024 * 1024)
                _pyvips.cache_set_max(100)
                _pyvips.cache_set_max_files(32)
            except Exception:
                pass
        except Exception:
            _pyvips = None
            _PYVIPS_AVAILABLE = False
            if _VIPS_PREVIOUS_TEMP_ENV is not None:
                for name, previous in _VIPS_PREVIOUS_TEMP_ENV.items():
                    if previous is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = previous
                _VIPS_PREVIOUS_TEMP_ENV = None
            if _VIPS_TEMP_DIR_MANAGER is not None:
                try:
                    _VIPS_TEMP_DIR_MANAGER.cleanup()
                except Exception:
                    pass
                _VIPS_TEMP_DIR_MANAGER = None
        finally:
            _BACKEND_INITIALIZED = True


def _integer(value, name, minimum=None):
    if isinstance(value, bool) or not isinstance(value, int):
        raise CanvasSourceTileError(f"{name} must be an integer")
    if minimum is not None and value < minimum:
        raise CanvasSourceTileError(f"{name} must be at least {minimum}")
    return value


def _pair(value, name, minimum=1):
    if not isinstance(value, list) or len(value) != 2:
        raise CanvasSourceTileError(f"{name} must contain two integers")
    return (_integer(value[0], f"{name}[0]", minimum),
            _integer(value[1], f"{name}[1]", minimum))


def _validate_local_source_ref(source_ref):
    """Accept only same-origin canvas import or gallery image references."""
    if not isinstance(source_ref, str) or not source_ref.strip():
        raise CanvasSourceTileError("Each source must be a local image reference")
    source_ref = source_ref.strip()
    parsed = urlsplit(source_ref)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise CanvasSourceTileError("Remote URLs and decorated source references are not allowed")
    path = parsed.path
    if not (path.startswith("/canvas-imports/")
            or path.startswith("canvas_imports/")
            or path.startswith("/image/")):
        raise CanvasSourceTileError("Source must use /canvas-imports/ or /image/")
    return source_ref


def _check_source_image(path, document_size):
    if not os.path.isfile(path):
        raise CanvasSourceTileError("Source image does not exist")
    extension = os.path.splitext(path)[1].lower()
    if extension not in _SUPPORTED_EXTENSIONS:
        raise CanvasSourceTileError("Unsupported source image format")
    stat = os.stat(path)
    if stat.st_size <= 0 or stat.st_size > MAX_SOURCE_BYTES:
        raise CanvasSourceTileError("Source image file is outside the supported size limit")

    image = _pyvips.Image.new_from_file(path, access="random", fail_on="error")
    fields = set(image.get_fields())
    if "icc-profile-data" in fields:
        raise CanvasSourceTileError("Embedded ICC profiles are not supported by source tiles")
    if "orientation" in fields:
        orientation = image.get("orientation")
        if isinstance(orientation, (tuple, list)):
            orientation = orientation[0] if orientation else 1
        try:
            orientation = int(orientation)
        except (TypeError, ValueError):
            orientation = 0
        if orientation != 1:
            raise CanvasSourceTileError("Nonstandard image orientation is not supported")
    if image.format != "uchar" or image.bands not in (3, 4):
        raise CanvasSourceTileError("Source tiles require 8-bit RGB or RGBA images")
    interpretation = str(image.interpretation).lower()
    if interpretation not in {"srgb", "rgb"}:
        raise CanvasSourceTileError("Source tiles require RGB or sRGB image data")
    if image.width * image.height > MAX_DOCUMENT_PIXELS:
        raise CanvasSourceTileError("Source image exceeds the supported pixel limit")
    if (image.width, image.height) != document_size:
        raise CanvasSourceTileError("Source dimensions do not match the canvas document")
    if image.bands == 3:
        image = image.bandjoin_const(255)
    return image, stat.st_mtime_ns, stat.st_size


def _get_source_image(path, expected_stat, document_size):
    key = (os.path.normcase(os.path.abspath(path)), expected_stat[0], expected_stat[1])
    cached = _SOURCE_IMAGE_CACHE.get(key)
    if cached is not None:
        return cached
    image, mtime_ns, size = _check_source_image(path, document_size)
    if (mtime_ns, size) != expected_stat:
        raise CanvasSourceTileError("Source image changed while preparing the tile")
    estimated_bytes = image.width * image.height * 4
    _SOURCE_IMAGE_CACHE.put(key, image, estimated_bytes)
    return image


def _transparent_rgba(width, height):
    return _pyvips.Image.black(width, height, bands=4).new_from_image([0, 0, 0, 0])


def _normalized_thumbnail(image, lod, document_size):
    if lod == 1:
        return image
    scaled = image.resize(1.0 / lod, kernel="lanczos3")
    expected_width = (document_size[0] + lod - 1) // lod
    expected_height = (document_size[1] + lod - 1) // lod
    # vips rounds output dimensions to the nearest integer; preserve the final
    # partially covered document pixel when the ceil dimensions are larger.
    if scaled.width > expected_width or scaled.height > expected_height:
        scaled = scaled.crop(0, 0, min(scaled.width, expected_width), min(scaled.height, expected_height))
    if scaled.width < expected_width or scaled.height < expected_height:
        scaled = scaled.embed(0, 0, expected_width, expected_height, extend="copy")
    return scaled


def _source_band(image, sample, lod, document_size):
    sample_x, sample_y, sample_width, sample_height = sample
    output_width = sample_width // lod
    output_height = sample_height // lod
    scaled = _normalized_thumbnail(image, lod, document_size)
    origin_x = sample_x // lod
    origin_y = sample_y // lod
    left = max(0, origin_x)
    top = max(0, origin_y)
    right = min(scaled.width, origin_x + output_width)
    bottom = min(scaled.height, origin_y + output_height)
    if right <= left or bottom <= top:
        return _transparent_rgba(output_width, output_height)

    region = scaled.crop(left, top, right - left, bottom - top)
    return region.embed(left - origin_x, top - origin_y, output_width, output_height,
                        extend="background", background=[0, 0, 0, 0])


def _join_source_bands(bands, parallel=False):
    if not parallel or len(bands) < 2:
        return _pyvips.Image.arrayjoin(bands, across=1)

    # A single lazy atlas evaluation walks the source bands in order. For the
    # large overview resize, materializing the small output bands independently
    # lets libvips decode/resize several sources at once. The output atlas is
    # capped at 32 MiB raw, so only thumbnail pixels are retained here.
    workers = min(_OVERVIEW_PARALLEL_WORKERS, len(bands))
    with ThreadPoolExecutor(max_workers=workers) as executor:
        buffers = list(executor.map(lambda band: band.write_to_memory(), bands))
    materialized = [
        _pyvips.Image.new_from_memory(buffer, band.width, band.height, band.bands, band.format)
        for buffer, band in zip(buffers, bands)
    ]
    return _pyvips.Image.arrayjoin(materialized, across=1)


def _render_atlas(source_paths, source_stats, document_size, sample, lod, key):
    cached = _TILE_CACHE.get(key)
    if cached is not None:
        return cached
    if not _RENDER_SLOTS.acquire(blocking=False):
        raise RuntimeError("Source tile renderer is busy")
    try:
        images = {}
        bands = []
        for path, expected_stat in zip(source_paths, source_stats):
            if path not in images:
                images[path] = _get_source_image(path, expected_stat, document_size)
            bands.append(_source_band(images[path], sample, lod, document_size))
        parallel_overview = (lod >= _OVERVIEW_PARALLEL_MIN_LOD
                             and len(bands) >= _OVERVIEW_PARALLEL_MIN_SOURCES)
        atlas = _join_source_bands(bands, parallel=parallel_overview)
        png = atlas.pngsave_buffer()
        _TILE_CACHE.put(key, png)
        return png
    finally:
        _RENDER_SLOTS.release()


def _tile_cache_key(source_paths, source_stats, document_size, sample, lod):
    sources = tuple((os.path.normcase(os.path.abspath(path)), mtime_ns, size)
                    for path, (mtime_ns, size) in zip(source_paths, source_stats))
    return sources, document_size, sample, lod


def register_canvas_source_tile_routes(app, source_path_resolver, scratch_dir=None):
    """Register the optional tile endpoints using the app's safe path resolver."""
    _initialize_backend(scratch_dir)
    if _PYVIPS_AVAILABLE:
        version = ".".join(str(_pyvips.version(part)) for part in range(3))
        app.logger.info("Canvas source tiles enabled (pyvips %s, libvips %s)", _pyvips.__version__, version)

    @app.route("/api/canvas/source-tiles.js", methods=["GET"])
    def canvas_source_tiles_available():
        available = "true" if pyvips_available() else "false"
        return Response(f"window.CanvasSourceTilesAvailable = {available};\n",
                        mimetype="application/javascript")

    @app.route("/api/canvas/source-tile", methods=["POST"])
    def canvas_source_tile():
        if not pyvips_available():
            return jsonify({"status": "error", "message": "Source tile backend unavailable"}), 503
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"status": "error", "message": "A JSON object is required"}), 400

        try:
            source_refs = data.get("sources")
            if not isinstance(source_refs, list) or not 1 <= len(source_refs) <= MAX_SOURCES:
                raise CanvasSourceTileError("sources must contain between 1 and 32 image references")
            source_refs = [_validate_local_source_ref(ref) for ref in source_refs]
            document_size = _pair(data.get("document"), "document")
            if document_size[0] * document_size[1] > MAX_DOCUMENT_PIXELS:
                raise CanvasSourceTileError("Document exceeds the supported pixel limit")
            sample_values = data.get("sample")
            if not isinstance(sample_values, list) or len(sample_values) != 4:
                raise CanvasSourceTileError("sample must contain x, y, width, and height")
            sample_x = _integer(sample_values[0], "sample[0]")
            sample_y = _integer(sample_values[1], "sample[1]")
            sample_width = _integer(sample_values[2], "sample[2]", 1)
            sample_height = _integer(sample_values[3], "sample[3]", 1)
            lod = _integer(data.get("lod"), "lod", 1)
            if lod & (lod - 1):
                raise CanvasSourceTileError("lod must be a power of two")
            if (sample_x % lod or sample_y % lod
                    or sample_width % lod or sample_height % lod):
                raise CanvasSourceTileError("sample coordinates and dimensions must align to lod")
            if sample_x < -lod or sample_y < -lod:
                raise CanvasSourceTileError("sample may extend at most one lod outside the document")
            sample = (sample_x, sample_y, sample_width, sample_height)
            output_pixels = (sample_width // lod) * (sample_height // lod) * len(source_refs)
            if output_pixels > MAX_ATLAS_PIXELS:
                raise CanvasSourceTileError("Requested source atlas exceeds the pixel limit")

            source_paths = []
            source_stats = []
            for source_ref in source_refs:
                try:
                    path = os.path.abspath(os.fspath(source_path_resolver(source_ref)))
                except Exception:
                    raise CanvasSourceTileError("Source image reference could not be resolved")
                if not os.path.isfile(path):
                    raise CanvasSourceTileError("Source image does not exist")
                stat = os.stat(path)
                if stat.st_size <= 0 or stat.st_size > MAX_SOURCE_BYTES:
                    raise CanvasSourceTileError("Source image file is outside the supported size limit")
                source_paths.append(path)
                source_stats.append((stat.st_mtime_ns, stat.st_size))

            key = _tile_cache_key(source_paths, source_stats, document_size, sample, lod)
            png = _render_atlas(source_paths, source_stats, document_size, sample, lod, key)
            return Response(png, mimetype="image/png")
        except CanvasSourceTileError as error:
            return jsonify({"status": "error", "message": str(error)}), 422
        except (OSError, ValueError):
            return jsonify({"status": "error", "message": "Source image could not be read"}), 422
        except TypeError:
            return jsonify({"status": "error", "message": "Invalid source tile request"}), 422
        except RuntimeError as error:
            if str(error) == "Source tile renderer is busy":
                return jsonify({"status": "error", "message": "Source tile renderer is busy"}), 503
            return jsonify({"status": "error", "message": "Source image cannot be processed"}), 422
        except Exception:
            # Loader/encoder failures mean this source is unsuitable for the
            # optional backend; callers can fall back to ordinary image draws.
            # Keep local file paths and libvips diagnostics out of HTTP output.
            return jsonify({"status": "error", "message": "Source image cannot be processed"}), 422

    return app
