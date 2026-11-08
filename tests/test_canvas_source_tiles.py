import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from flask import Flask
from PIL import Image

from naim.web import canvas_source_tiles as source_tiles


class CanvasSourceTileTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.paths = {}
        self.app = Flask(__name__)
        source_tiles.register_canvas_source_tile_routes(
            self.app, self.resolve_source, scratch_dir=Path.cwd() / ".qa",
        )
        self.client = self.app.test_client()

    def tearDown(self):
        self.temp_dir.cleanup()

    def resolve_source(self, source_ref):
        if source_ref not in self.paths:
            raise ValueError("unknown test source")
        return str(self.paths[source_ref])

    def save_rgba(self, name, pixels):
        path = self.root / name
        image = Image.frombytes(
            "RGBA", (len(pixels[0]), len(pixels)),
            bytes(channel for row in pixels for pixel in row for channel in pixel),
        )
        image.save(path, format="PNG")
        image.close()
        source_ref = f"/canvas-imports/{name}"
        self.paths[source_ref] = path
        return source_ref

    def post_tile(self, **overrides):
        payload = {
            "sources": ["/canvas-imports/first.png", "/canvas-imports/second.png"],
            "document": [3, 2],
            "sample": [-1, -1, 4, 4],
            "lod": 1,
        }
        payload.update(overrides)
        return self.client.post("/api/canvas/source-tile", json=payload)

    def test_native_lod_one_preserves_straight_rgba_and_vertical_order(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        first = [
            [(255, 20, 10, 0), (255, 20, 10, 64), (255, 20, 10, 255)],
            [(10, 40, 240, 128), (30, 50, 70, 255), (80, 90, 100, 32)],
        ]
        second = [[(4, 5, 6, 7)] * 3 for _ in range(2)]
        self.save_rgba("first.png", first)
        self.save_rgba("second.png", second)

        response = self.post_tile()

        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        self.assertEqual(response.mimetype, "image/png")
        with Image.open(io.BytesIO(response.data)) as atlas:
            self.assertEqual(atlas.mode, "RGBA")
            self.assertEqual(atlas.size, (4, 8))
            self.assertEqual(atlas.getpixel((0, 0)), (0, 0, 0, 0))
            self.assertEqual(atlas.getpixel((1, 1)), first[0][0])
            self.assertEqual(atlas.getpixel((3, 2)), first[1][2])
            self.assertEqual(atlas.getpixel((1, 5)), second[0][0])
            self.assertEqual(atlas.getpixel((0, 4)), (0, 0, 0, 0))

    def test_document_dimension_mismatch_is_rejected_for_fallback(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        source = [[(1, 2, 3, 255)] * 3 for _ in range(2)]
        self.save_rgba("first.png", source)
        self.save_rgba("second.png", source)

        response = self.post_tile(document=[4, 2])

        self.assertEqual(response.status_code, 422)
        self.assertIn("dimensions do not match", response.get_json()["message"])

    def test_missing_pyvips_import_keeps_the_optional_app_backend_disabled(self):
        previous = (
            source_tiles._pyvips,
            source_tiles._PYVIPS_AVAILABLE,
            source_tiles._BACKEND_INITIALIZED,
            source_tiles._VIPS_TEMP_DIR_MANAGER,
            source_tiles._VIPS_PREVIOUS_TEMP_ENV,
        )
        try:
            source_tiles._pyvips = None
            source_tiles._PYVIPS_AVAILABLE = False
            source_tiles._BACKEND_INITIALIZED = False
            previous_temp_values = {
                name: os.environ.get(name) for name in source_tiles._TEMP_ENV_NAMES
            }
            source_tiles._VIPS_TEMP_DIR_MANAGER = None
            source_tiles._VIPS_PREVIOUS_TEMP_ENV = None
            with (
                mock.patch.object(source_tiles.importlib.util, "find_spec", return_value=object()),
                mock.patch.object(source_tiles.importlib, "import_module", side_effect=ImportError),
            ):
                source_tiles._initialize_backend(scratch_dir=Path.cwd() / ".qa")
            self.assertFalse(source_tiles.pyvips_available())
            self.assertEqual(
                {name: os.environ.get(name) for name in source_tiles._TEMP_ENV_NAMES},
                previous_temp_values,
            )
            self.assertIsNone(source_tiles._VIPS_TEMP_DIR_MANAGER)
        finally:
            (source_tiles._pyvips,
             source_tiles._PYVIPS_AVAILABLE,
             source_tiles._BACKEND_INITIALIZED,
             source_tiles._VIPS_TEMP_DIR_MANAGER,
             source_tiles._VIPS_PREVIOUS_TEMP_ENV) = previous

    def test_thumbnail_lod_crops_aligned_pixels_and_pads_outside_document(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        pixels = [[(x * 20, y * 20, (x + y) * 10, 255 if x else 64)
                   for x in range(8)] for y in range(8)]
        first = self.save_rgba("first.png", pixels)
        self.save_rgba("second.png", pixels)
        payload = {
            "sources": [first, "/canvas-imports/second.png"],
            "document": [8, 8],
            "sample": [-4, -4, 8, 8],
            "lod": 4,
        }

        response = self.client.post("/api/canvas/source-tile", json=payload)

        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        with Image.open(io.BytesIO(response.data)) as atlas:
            self.assertEqual(atlas.size, (2, 4))
            self.assertEqual(atlas.getpixel((0, 0)), (0, 0, 0, 0))
            self.assertGreater(atlas.getpixel((1, 1))[3], 0)
            self.assertEqual(atlas.getpixel((1, 3)), atlas.getpixel((1, 1)))

    def test_parallel_overview_atlas_preserves_source_order_and_rgba_pixels(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        colors = [
            (220, 30, 40, 255),
            (10, 180, 60, 192),
            (30, 70, 230, 128),
            (90, 100, 110, 64),
        ]
        sources = [
            self.save_rgba(f"overview-{index}.png", [[color] * 8 for _ in range(8)])
            for index, color in enumerate(colors)
        ]

        response = self.client.post("/api/canvas/source-tile", json={
            "sources": sources,
            "document": [8, 8],
            "sample": [0, 0, 8, 8],
            "lod": 8,
        })

        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        with Image.open(io.BytesIO(response.data)) as atlas:
            self.assertEqual(atlas.mode, "RGBA")
            self.assertEqual(atlas.size, (1, len(colors)))
            self.assertEqual([atlas.getpixel((0, index)) for index in range(len(colors))], colors)

    def test_nonlocal_source_references_are_rejected(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")

        response = self.post_tile(sources=["https://example.test/image/private.png"])

        self.assertEqual(response.status_code, 422)
        self.assertIn("Remote URLs", response.get_json()["message"])

    def test_full_overview_atlas_geometry_fits_the_server_budget(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        source_ref = self.save_rgba("overview.png", [[(1, 2, 3, 255)]])
        sources = [source_ref.replace("overview.png", f"overview-{index}.png")
                   for index in range(25)]
        for item in sources:
            self.paths[item] = self.paths[source_ref]
        payload = {
            "sources": sources,
            "document": [5000, 16000],
            "sample": [-16, -16, 315 * 16, 1002 * 16],
            "lod": 16,
        }

        with mock.patch.object(source_tiles, "_render_atlas", return_value=b"png") as render:
            response = self.client.post("/api/canvas/source-tile", json=payload)

        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        render.assert_called_once()

    def test_processing_errors_do_not_return_local_paths(self):
        if not source_tiles.pyvips_available():
            self.skipTest("pyvips and libvips are unavailable")
        source = [[(1, 2, 3, 255)] * 3 for _ in range(2)]
        self.save_rgba("first.png", source)
        self.save_rgba("second.png", source)

        with mock.patch.object(source_tiles, "_render_atlas",
                               side_effect=OSError(str(self.paths["/canvas-imports/first.png"]))):
            response = self.post_tile()

        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["message"], "Source image could not be read")
        self.assertNotIn(str(self.root), response.get_data(as_text=True))

    def test_unavailable_backend_reports_false_and_returns_service_unavailable(self):
        app = Flask("canvas-source-tiles-fallback")
        with mock.patch.object(source_tiles, "_PYVIPS_AVAILABLE", False):
            source_tiles.register_canvas_source_tile_routes(app, self.resolve_source)
            client = app.test_client()
            script = client.get("/api/canvas/source-tiles.js")
            tile = client.post("/api/canvas/source-tile", json={})

        self.assertEqual(script.status_code, 200)
        self.assertEqual(script.mimetype, "application/javascript")
        self.assertEqual(script.get_data(as_text=True), "window.CanvasSourceTilesAvailable = false;\n")
        self.assertEqual(tile.status_code, 503)

    def test_source_reference_cache_enforces_entry_and_estimated_byte_limits(self):
        cache = source_tiles._SourceImageCache(max_entries=2, max_estimated_bytes=30)
        first, second, third = object(), object(), object()
        key_a = ("a", 1, 1)
        key_b = ("b", 1, 1)
        key_c = ("c", 1, 1)
        cache.put(key_a, first, 10)
        cache.put(key_b, second, 10)
        self.assertIs(cache.get(key_a), first)  # make b the least recently used
        cache.put(key_c, third, 20)

        self.assertIsNone(cache.get(key_b))
        self.assertIs(cache.get(key_a), first)
        self.assertIs(cache.get(key_c), third)
        self.assertLessEqual(len(cache.items), 2)
        self.assertLessEqual(cache.estimated_bytes, 30)


if __name__ == "__main__":
    unittest.main()
