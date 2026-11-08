'use strict';

const runtime = (async () => {
    importScripts('./vendor/pyodide/pyodide.js');
    const py = await loadPyodide({indexURL: new URL('./vendor/pyodide/', self.location).href});
    const bundle = fetch('./canvas_editor/engine.zip', {cache: 'no-cache'}).then(response => {
        if (!response.ok) throw new Error('The canvas engine bundle is unavailable.');
        return response.arrayBuffer();
    });
    const accelerator = fetch('./canvas_editor/filter.wasm?v=2')
        .then(response => response.ok ? response.arrayBuffer() : null).catch(() => null);
    const [archive, , kernel] = await Promise.all([bundle, py.loadPackage(['numpy', 'pillow']), accelerator]);
    py.unpackArchive(archive, 'zip');
    if (kernel) py.FS.writeFile('/canvas-filter.wasm', new Uint8Array(kernel));
    py.runPython(`
import io
import json
import time
import warnings
from PIL import Image
import retouch as engine
from retouch_working import WorkingImage

try:
    import ctypes
    _filter_library = ctypes.CDLL('/canvas-filter.wasm')
    _normal_blend = _filter_library.blend_normal_rgba
    _normal_blend.argtypes = [ctypes.c_void_p] * 4 + [ctypes.c_uint, ctypes.c_float]
    _normal_blend.restype = None
    engine._native_normal_blend = _normal_blend
except (ImportError, OSError, AttributeError):
    pass

def rgba_rows(image):
    if image.mode != 'RGBA':
        return 0
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', DeprecationWarning)
        return dict(getattr(image.im, 'unsafe_ptrs', ())).get('image32', 0)

try:
    import numpy as np
    _gaussian = _filter_library.gaussian_rgba
    _gaussian.argtypes = [ctypes.c_void_p] * 5 + [ctypes.c_int] * 2 + [ctypes.c_float] + [ctypes.c_int] * 2
    _gaussian.restype = None
    _gaussian_scratch = None

    def gaussian_tile(image, radius, percent, threshold):
        global _gaussian_scratch
        width, height = image.size
        pixels = width * height
        edge = max(width, height)
        needed = pixels + 2 * edge
        output = Image.new('RGBA', image.size, None)
        try:
            # Pillow 11.3 in this worker exposes its image32 row table in the
            # same WASM heap as the SIMD kernel. Keep the owning images alive.
            source, target = rgba_rows(image), rgba_rows(output)
            if not source or not target:
                output.close()
                return None
            if _gaussian_scratch is None or needed > _gaussian_scratch.size:
                _gaussian_scratch = np.empty(needed, dtype=np.uint32)
            scratch = _gaussian_scratch.ctypes.data
            _gaussian(source, target, scratch, scratch + 4 * pixels, scratch + 4 * (pixels + edge),
                      width, height, radius, percent, threshold)
            return output
        except BaseException:
            output.close()
            raise

    engine._native_gaussian = gaussian_tile
except (NameError, AttributeError):
    pass

working = None
packet_image = None
packet_owned = False
update_work = None

def load_source(width, height):
    global working
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', Image.DecompressionBombWarning)
        opened = Image.open('/canvas-retouch-source')
        try:
            if opened.mode == 'RGBA' and not opened.info.get('icc_profile') and opened.getexif().get(274) not in {2, 3, 4, 5, 6, 7, 8}:
                opened.load()
                source, opened = opened, None
            else:
                source = engine.normalize_image(opened)
        finally:
            if opened is not None:
                opened.close()
    if source.size != (width, height):
        source.close()
        raise ValueError('The normalized source dimensions do not match the canvas.')
    if working is not None:
        working.close()
    working = WorkingImage('browser', None, source, checkpoint_pixels=16_000_000)

def start_update(records, base_revision):
    global update_work
    layers = json.loads(records)
    engine.validate_side({'layers': layers})
    update_work = working.iter_update(engine, layers, base_revision)

def step_update():
    global update_work, packet_image, packet_owned
    deadline = time.perf_counter() + .008
    while True:
        try:
            next(update_work)
        except StopIteration as done:
            packet_image, box, revision, borrowed = done.value
            packet_owned = packet_image is not None and not borrowed
            update_work = None
            return json.dumps({'box': box, 'revision': revision})
        if time.perf_counter() >= deadline:
            return None

def cancel_update():
    global update_work
    if update_work is not None:
        update_work.close()
        update_work = None

def render_viewport(records, viewport):
    global packet_image, packet_owned
    layers = json.loads(records)
    engine.validate_side({'layers': layers})
    box = json.loads(viewport)
    packet_image = working.viewport_update(engine, layers, box)
    packet_owned = packet_image is not None
    return packet_owned

def render_mask(record, width, height):
    global packet_image, packet_owned
    layer = json.loads(record)
    scale = min(1, 1600 / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    with engine.mask_image(layer, size, scale, (0, 0)) as mask:
        packet_image = mask.convert('RGBA')
    packet_owned = True
    return json.dumps([0, 0, *size])

def read_rows(top, count):
    if top == 0 and count == packet_image.height:
        return packet_image.tobytes()
    with packet_image.crop((0, top, packet_image.width, top + count)) as band:
        return band.tobytes()

def packet_rows():
    return rgba_rows(packet_image)

def release_packet():
    global packet_image, packet_owned
    if packet_owned:
        packet_image.close()
    packet_image = None
    packet_owned = False

def export_image(revision, records):
    if working is None or working.revision != revision or working.layers != json.loads(records):
        raise ValueError('The export does not match the confirmed document revision.')
    with io.BytesIO() as output:
        working.current.save(output, format='PNG', compress_level=1)
        return output.getvalue()
`);
    return py;
})();
// Observe bootstrap failure even while a new composite is still being created.
runtime.catch(() => {});

let commands = Promise.resolve();
let source;
let pendingSource;
const updates = new Map();
const yieldChannel = new MessageChannel();
let resumeUpdate;
yieldChannel.port1.onmessage = () => {
    const resume = resumeUpdate;
    resumeUpdate = null;
    resume();
};

function yieldUpdate() {
    return new Promise(resolve => {
        resumeUpdate = resolve;
        yieldChannel.port2.postMessage(null);
    });
}

function fetchSource(path) {
    if (!path || path === source) return;
    if (pendingSource?.path === path) return pendingSource;
    pendingSource?.controller.abort();
    const url = new URL(path, self.location.origin + '/');
    if (url.origin !== self.location.origin && url.protocol !== 'data:') throw new Error('The canvas source is not local.');
    const controller = new AbortController();
    const bytes = fetch(url, {signal: controller.signal}).then(response => {
        if (!response.ok) throw new Error('The source image could not be loaded.');
        return response.arrayBuffer();
    });
    const pending = {path, controller, bytes};
    pendingSource = pending;
    bytes.catch(() => {if (pendingSource === pending) pendingSource = null;});
    return pending;
}

async function prepareSource(py, body, update) {
    if (source && (body.source === undefined || source === body.source)) return;
    if (!body.source) throw new Error('The canvas source is unavailable.');
    const pending = fetchSource(body.source);
    const bytes = await pending.bytes;
    if (update?.cancelled) return;
    if (pendingSource === pending) pendingSource = null;
    py.FS.writeFile('/canvas-retouch-source', new Uint8Array(bytes), {canOwn: true});
    const loadSource = py.globals.get('load_source');
    try {
        loadSource(body.width, body.height);
        source = body.source;
    } finally {
        loadSource.destroy();
        py.FS.unlink('/canvas-retouch-source');
    }
}

function sendPixels(py, id, box, provisional = false) {
    if (!box) return;
    const [x, y, right, bottom] = box;
    const width = right - x;
    const rows = Math.max(1, Math.floor(1_048_576 / width));
    const rowTable = py.runPython('packet_rows()');
    const memory = py._module.HEAPU8;
    const pointers = rowTable ? new Uint32Array(memory.buffer, rowTable, bottom - y) : null;
    const readRows = pointers ? null : py.globals.get('read_rows');
    try {
        for (let top = y; top < bottom; top += rows) {
            const height = Math.min(rows, bottom - top);
            let pixels;
            if (pointers) {
                // Copy directly to transferable memory while Pillow still owns
                // the rows. The WASM heap cannot be transferred to the page.
                const rowBytes = width * 4;
                pixels = new Uint8Array(rowBytes * height);
                for (let row = 0; row < height; row++) {
                    const offset = pointers[top - y + row];
                    pixels.set(memory.subarray(offset, offset + rowBytes), row * rowBytes);
                }
            } else {
                const raw = readRows(top - y, height);
                try {pixels = raw.toJs();}
                finally {raw.destroy();}
            }
            self.postMessage({id, region: {x, y: top, width, height}, pixels, provisional}, [pixels.buffer]);
        }
    } finally {readRows?.destroy();}
}

function sendViewport(py, id, records, viewport, provisional, timings, mark) {
    const view = py.globals.get('render_viewport');
    try {
        mark?.('viewport-compute-start');
        if (!view(records, JSON.stringify(viewport))) return;
        mark?.('viewport-computed');
        sendPixels(py, id, viewport, provisional);
        mark?.('viewport-transferred');
        if (provisional) self.postMessage({id, viewportReady: true, timings});
    } finally {
        view.destroy();
        py.runPython('release_packet()');
    }
}

async function execute({id, kind, body, receivedAt}) {
    let py;
    const timings = body?.profile ? {'worker-received': receivedAt} : null;
    const mark = phase => {if (timings) timings[phase] = performance.timeOrigin + performance.now();};
    try {
        const update = updates.get(id);
        if (update?.cancelled) {
            self.postMessage({id, cancelled: true});
            return;
        }
        py = await runtime;
        mark('runtime-ready');
        if (kind === 'warm') {
            self.postMessage({id, done: true});
            return;
        }
        if (kind === 'export') {
            const render = py.globals.get('export_image');
            try {
                const raw = render(body.revision, JSON.stringify(body.layers));
                try {
                    const png = raw.toJs();
                    self.postMessage({id, done: true, png}, [png.buffer]);
                } finally {raw.destroy();}
            } finally {render.destroy();}
            return;
        }
        if (kind === 'prepare') {
            await prepareSource(py, body);
            self.postMessage({id, done: true});
            return;
        }
        let box, revision;
        if (kind === 'mask') {
            const render = py.globals.get('render_mask');
            try {box = JSON.parse(render(JSON.stringify(body.layer), body.width, body.height));}
            finally {render.destroy();}
        } else {
            if (!update?.cancelled) await prepareSource(py, body, update);
            mark('source-ready');
            if (update?.cancelled) {
                self.postMessage({id, cancelled: true});
                return;
            }
            const records = JSON.stringify(body.layers);
            if (kind === 'viewport') {
                mark('compute-start');
                sendViewport(py, id, records, body.viewport, false);
                mark('computed');
                self.postMessage({id, done: true, timings});
                return;
            }
            if (body.viewport) {
                try {sendViewport(py, id, records, body.viewport, true, timings, mark);}
                catch (_) {
                    // The full update remains authoritative if the early region fails.
                }
            }
            const start = py.globals.get('start_update');
            const step = py.globals.get('step_update');
            try {
                mark('compute-start');
                start(records, body.baseRevision);
                let completed;
                while (!(completed = step())) {
                    await yieldUpdate();
                    if (updates.get(id)?.cancelled) {
                        self.postMessage({id, cancelled: true});
                        return;
                    }
                }
                ({box, revision} = JSON.parse(completed));
                mark('computed');
            } finally {
                start.destroy(); step.destroy();
                py.runPython('cancel_update()');
            }
        }
        sendPixels(py, id, box);
        mark('pixels-transferred');
        self.postMessage({id, done: true, revision, timings});
    } catch (error) {
        self.postMessage({id, error: error.message || String(error)});
    } finally {
        updates.delete(id);
        if (py && (kind === 'update' || kind === 'mask')) py.runPython('release_packet()');
    }
}

self.onmessage = ({data}) => {
    if (data.kind === 'cancel') {
        const update = updates.get(data.id);
        if (update) update.cancelled = true;
        return;
    }
    if (data.kind === 'update' || data.kind === 'viewport') updates.set(data.id, {cancelled: false});
    if (data.body?.profile) data.receivedAt = performance.timeOrigin + performance.now();
    if (data.body?.source && !pendingSource && (data.kind === 'prepare' || data.kind === 'update' || data.kind === 'viewport')) {
        try {fetchSource(data.body.source);}
        catch (_) { /* Report invalid sources through the command's normal error path. */ }
    }
    commands = commands.then(() => execute(data)).catch(error => {
        self.postMessage({id: data.id, error: error.message || String(error)});
    });
};
