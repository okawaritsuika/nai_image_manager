const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const {loadPyodide} = require('../static/vendor/pyodide/pyodide.js');

test('the SIMD filter module preserves Pillow RGBA bytes through blend, blur, and unsharp', async () => {
    const project = path.join(__dirname, '..');
    const runtime = await loadPyodide({indexURL: path.join(project, 'static/vendor/pyodide')});
    await runtime.loadPackage(['numpy', 'pillow']);
    runtime.FS.writeFile('/filter.wasm', fs.readFileSync(path.join(project, 'static/canvas_editor/filter.wasm')));
    runtime.FS.writeFile('/retouch.py', fs.readFileSync(path.join(project, 'naim/images/retouch.py')));
    runtime.runPython(`
import ctypes
import sys
import warnings
import numpy as np
from PIL import Image, ImageFilter
sys.path.insert(0, '/')
import retouch

library = ctypes.CDLL('/filter.wasm')
blend = library.blend_normal_rgba
blend.argtypes = [ctypes.c_void_p] * 4 + [ctypes.c_uint, ctypes.c_float]
blend.restype = None
rng = np.random.default_rng(2026)
base = Image.fromarray(rng.integers(0, 256, (289, 271, 4), dtype=np.uint8))
changed = Image.fromarray(rng.integers(0, 256, (289, 271, 4), dtype=np.uint8))
mask = Image.fromarray(rng.integers(0, 256, (289, 271), dtype=np.uint8))
for opacity in (.01, .0625, .125, .3, .5, .501, .87, .995):
    retouch._native_normal_blend = None
    with retouch.composite(base, changed, mask, opacity) as expected:
        retouch._native_normal_blend = blend
        with retouch.composite(base, changed, mask, opacity) as actual:
            np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))

gaussian = library.gaussian_rgba
gaussian.argtypes = [ctypes.c_void_p] * 5 + [ctypes.c_int] * 2 + [ctypes.c_float] + [ctypes.c_int] * 2
gaussian.restype = None
with warnings.catch_warnings():
    warnings.simplefilter('ignore', DeprecationWarning)
    for width, height in ((1, 1), (1, 13), (23, 1), (19, 47), (79, 95)):
        src = Image.fromarray(rng.integers(0, 256, (height, width, 4), dtype=np.uint8))
        pixels, edge = width * height, max(width, height)
        scratch = np.empty(pixels + 2 * edge, dtype=np.uint32)
        ptr = scratch.ctypes.data
        source = dict(src.im.unsafe_ptrs)['image32']
        with src, Image.new('RGBA', src.size) as actual:
            target = dict(actual.im.unsafe_ptrs)['image32']
            radii = [.1, .5, 1.23, 4, 13.5, 40, *rng.uniform(.1, 40, 16)]
            for radius in radii:
                for amount, threshold in ((-1, 0), (0, 4), (137, 3), (250, 0), (83, 50)):
                    filter = (ImageFilter.GaussianBlur(radius) if amount < 0 else
                              ImageFilter.UnsharpMask(radius, amount, threshold))
                    gaussian(source, target, ptr, ptr + 4 * pixels, ptr + 4 * (pixels + edge),
                             width, height, radius, amount, threshold)
                    with src.filter(filter) as expected:
                        np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
`);
});
