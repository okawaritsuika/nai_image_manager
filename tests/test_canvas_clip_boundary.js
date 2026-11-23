const assert = require('node:assert/strict');
const {test} = require('node:test');
require('../static/canvas_selection_rotation.js');
require('../static/inpaint_grid_brush.js');
const boundary = require('../static/canvas_clip_boundary.js');

// Synthetic alpha-only 2D context. All drawing in the mask model is integer, 1:1 and binary.
function maskCanvas() {
    const ink = new Set(), stack = [];
    const canvas = {width: 0, height: 0, ink, getContext: () => ctx,
        toDataURL: () => 'data:image/png;base64,dGVzdA=='};
    const ctx = {
        canvas, globalCompositeOperation: 'source-over',
        save() { stack.push(this.globalCompositeOperation); },
        restore() { this.globalCompositeOperation = stack.pop(); },
        fillRect(x, y, w, h) {
            for (let j = Math.max(0, y); j < Math.min(canvas.height, y + h); j++) {
                for (let i = Math.max(0, x); i < Math.min(canvas.width, x + w); i++) ink.add(j * canvas.width + i);
            }
        },
        clearRect(x, y, w, h) {
            for (const p of ink) {
                const i = p % canvas.width, j = Math.floor(p / canvas.width);
                if (i >= x && i < x + w && j >= y && j < y + h) ink.delete(p);
            }
        },
        drawImage(src, ...args) {
            const cropped = args.length === 8;
            const [sx, sy, sw, sh] = cropped ? args : [0, 0, src.width, src.height];
            const [dx, dy, dw = sw, dh = sh] = cropped ? args.slice(4) : args;
            assert.equal(sw, dw); assert.equal(sh, dh);
            for (const p of src.ink) {
                const i = p % src.width - sx, j = Math.floor(p / src.width) - sy;
                if (i < 0 || j < 0 || i >= sw || j >= sh || dx + i < 0 || dy + j < 0 ||
                    dx + i >= canvas.width || dy + j >= canvas.height) continue;
                const target = (dy + j) * canvas.width + dx + i;
                if (this.globalCompositeOperation === 'destination-out') ink.delete(target);
                else ink.add(target);
            }
        },
        getImageData(x, y, w, h) {
            const data = new Uint8ClampedArray(w * h * 4);
            for (const p of ink) {
                const i = p % canvas.width - x, j = Math.floor(p / canvas.width) - y;
                if (i >= 0 && i < w && j >= 0 && j < h) data[(j * w + i) * 4 + 3] = 255;
            }
            return {data};
        }
    };
    return canvas;
}

global.document = {createElement: tag => { assert.equal(tag, 'canvas'); return maskCanvas(); }};

function sample() {
    const clip = {id: 1, x: 128, y: 128, layerWidth: 256, layerHeight: 128};
    return {clip, state: boundary.toggle(clip, clip, 2048, 1024)};
}

test('a completed pass clears only the submitted area and keeps the same movable editor', () => {
    const {clip, state} = sample();
    const first = {...state.rect};
    const drawAt = (x, y) => boundary.paint(state, {x, y}, {x, y}, 16);
    drawAt(first.x + 30, first.y + 30);
    state.rect = {...first, x: first.x + first.width};
    drawAt(state.rect.x + 30, state.rect.y + 30);
    state.rect = {...first};
    state.adjusting = false;
    boundary.commit(clip, state, true);
    boundary.finishPass(clip, state, first, state.draft);
    assert.equal(boundary.get(clip), state);
    assert.equal(state.adjusting, true);
    assert.deepEqual(state.rect, first);
    assert.equal(boundary.snapshotMask(state), null);
    state.rect.x += first.width;
    assert.ok(boundary.snapshotMask(state));
});

test('a response keeps newer mask edits made while its generation was pending', () => {
    const {clip, state} = sample();
    const submittedDraft = state.draft;
    const point = {x: state.rect.x + 12, y: state.rect.y + 12};
    boundary.paint(state, point, point, 16);
    boundary.commit(clip, state, true);
    boundary.finishPass(clip, state, state.rect, submittedDraft);
    assert.ok(boundary.snapshotMask(state));
});

test('initial crop follows the displayed rotated result and never allocates a mask', () => {
    const clip = {id: 1};
    const anchor = {id: 2, x: 128, y: 128, layerWidth: 256, layerHeight: 128, rotation: 90};
    const state = boundary.toggle(clip, anchor, 1001, 801);
    assert.equal(state.anchor, anchor);
    assert.deepEqual(state.rect, {x: 128, y: 0, width: 256, height: 384});
    assert.equal(boundary.displayMask(state), null);
    assert.equal(boundary.snapshotMask(state), null);
    assert.equal(boundary.toggle(clip, anchor, 1001, 801), null);
    assert.equal(boundary.get(clip), null);
    assert.equal(boundary.toggle(clip, anchor, 1001, 801), state);
    const edge = {id: 3, x: -10, y: 280, layerWidth: 380, layerHeight: 220};
    assert.deepEqual(boundary.toggle(edge, edge, 299, 315).rect, {x: 43, y: 59, width: 256, height: 256});
    assert.equal(boundary.toggle({}, edge, 63, 500), null);
});

test('all four handles preserve the opposite corner and valid request dimensions on a non-aligned canvas', () => {
    const start = {x: 35, y: 71, width: 192, height: 128};
    for (const handle of ['nw', 'ne', 'sw', 'se']) {
        for (const dx of [-9999, -81, 45, 9999]) {
            for (const dy of [-9999, -87, 71, 9999]) {
                const r = boundary.adjustRect(start, handle, dx, dy, 410, 503);
                assert.ok(r.x >= 0 && r.x + r.width <= 410 && r.y >= 0 && r.y + r.height <= 503);
                assert.ok(r.width >= 64 && r.height >= 64);
                assert.equal(r.width % 64, 0); assert.equal(r.height % 64, 0);
                assert.equal(handle.endsWith('w') ? r.x + r.width : r.x, handle.endsWith('w') ? 227 : 35);
                assert.equal(handle.startsWith('n') ? r.y + r.height : r.y, handle.startsWith('n') ? 199 : 71);
            }
        }
    }
    assert.deepEqual(boundary.adjustRect(start, 'move', 2.6, -999, 410, 503), {...start, x: 38, y: 0});
});

test('brush and eraser use the request grid at a one-pixel origin, preserve off-crop pixels and start empty', () => {
    const {state} = sample();
    state.rect = {x: 255, y: 127, width: 192, height: 128};
    const corner = {x: 255, y: 127}, next = {x: 303, y: 150};
    boundary.paint(state, corner, next, 16, false);
    const reference = maskCanvas(); reference.width = 192; reference.height = 128;
    InpaintGridBrush.paint(reference.getContext('2d'), {x: 0, y: 0}, {x: 48, y: 23}, 16, '#fff', false);
    assert.deepEqual(boundary.snapshotMask(state).ink, reference.ink);
    const oldRect = state.rect;
    state.rect = {...oldRect, x: 260};
    const shift = boundary.snapshotMask(state);
    assert.equal(shift.ink.size, [...reference.ink].filter(p => p % 192 >= 5).length);
    state.rect = {...oldRect, x: 1100};
    assert.equal(boundary.snapshotMask(state), null);
    state.rect = oldRect;
    boundary.paint(state, corner, next, 16, true);
    assert.equal(boundary.snapshotMask(state), null);
});

test('small strokes in a large document allocate a local plane and replaceMask touches only the current crop', () => {
    const {state} = sample();
    state.rect = {x: 1100, y: 127, width: 640, height: 640};
    const p = {x: 1110, y: 131};
    boundary.paint(state, p, p, 8, false);
    const plane = boundary.displayMask(state);
    assert.ok(plane.canvas.width <= 256 && plane.canvas.height <= 256);
    const oldRect = state.rect;
    const oldPixels = new Set(boundary.snapshotMask(state).ink);
    state.rect = {...oldRect, x: 1150, width: 64, height: 64};
    const replacement = maskCanvas(); replacement.width = replacement.height = 64;
    replacement.getContext('2d').fillRect(7, 8, 1, 1);
    boundary.replaceMask(state, replacement);
    assert.deepEqual(boundary.snapshotMask(state).ink, replacement.ink);
    boundary.replaceMask(state, null);
    assert.equal(boundary.snapshotMask(state), null);
    state.rect = oldRect;
    assert.deepEqual(boundary.snapshotMask(state).ink, oldPixels);
});

test('moving the crop by one pixel preserves the painted cell at its world position', () => {
    const {state} = sample();
    state.rect = {x: 64, y: 64, width: 64, height: 64};
    const center = {x: 100, y: 100};
    boundary.paint(state, center, center, 4);
    const displayed = boundary.displayMask(state);
    for (const [x, y, width] of [[65, 65, 8], [101, 65, 3]]) {
        state.rect = {...state.rect, x, y};
        const submitted = boundary.snapshotMask(state);
        assert.equal(submitted.ink.size, width * 8);
        for (const pixel of submitted.ink) {
            const worldX = x + pixel % 64;
            const worldY = y + Math.floor(pixel / 64);
            assert.ok(worldX >= 96 && worldX < 104 && worldY >= 96 && worldY < 104);
            assert.ok(displayed.canvas.ink.has((worldY - displayed.y) * displayed.canvas.width + worldX - displayed.x));
        }
    }
});

test('save, disable and restore retain the positioned mask, without re-encoding a geometry-only edit', async () => {
    const {clip, state} = sample();
    boundary.paint(state, {x: 102, y: 93}, {x: 106, y: 98}, 16);
    const plane = boundary.displayMask(state);
    const expected = new Set(boundary.snapshotMask(state).ink);
    let encodes = 0;
    plane.canvas.toDataURL = () => {encodes++; return 'data:image/png;base64,dGVzdA==';};
    boundary.commit(clip, state, true);
    const prior = clip.boundaryDraft;
    state.rect = {...state.rect, x: state.rect.x + 1};
    boundary.commit(clip, state);
    assert.equal(prior.rect.x, state.rect.x - 1);
    assert.equal(encodes, 1);
    boundary.toggle(clip, clip, 2048, 1024);
    const restored = structuredClone(clip);
    assert.equal(boundary.needsRestore(restored), true);
    let finish;
    global.loadImageElementForClip = () => new Promise(resolve => {finish = resolve;});
    const ready = boundary.restore(restored, restored, 2048, 1024);
    assert.equal(boundary.needsRestore(restored), false);
    assert.equal(boundary.get(restored), null);
    finish({...plane.canvas, naturalWidth: plane.canvas.width, naturalHeight: plane.canvas.height});
    assert.equal(await ready, null);
    const resumed = boundary.toggle(restored, restored, 2048, 1024);
    resumed.rect = prior.rect;
    assert.deepEqual(boundary.snapshotMask(resumed).ink, expected);
    assert.equal(encodes, 1);
});

test('an old image decode cannot overwrite a later restored draft', async () => {
    const {clip, state} = sample();
    const p = {x: 102, y: 93};
    boundary.paint(state, p, p, 8);
    boundary.commit(clip, state, true);
    const restored = structuredClone(clip);
    let finish;
    global.loadImageElementForClip = () => new Promise(resolve => {finish = resolve;});
    const waiting = boundary.restore(restored, restored, 2048, 1024);
    const replacement = {...restored.boundaryDraft, maskDataUrl: undefined, rect: {x: 30, y: 7, width: 64, height: 64}};
    restored.boundaryDraft = replacement;
    const current = await boundary.restore(restored, restored, 2048, 1024);
    finish({});
    assert.equal(await waiting, null);
    assert.equal(boundary.get(restored), current);
    assert.deepEqual(current.rect, replacement.rect);
    assert.equal(boundary.snapshotMask(current), null);
});

test('decode failures preserve the previous PNG and the next toggle allows recovery', async () => {
    const {clip, state} = sample();
    const p = {x: 103, y: 97};
    boundary.paint(state, p, p, 8);
    boundary.commit(clip, state, true);
    const restored = structuredClone(clip), saved = restored.boundaryDraft;
    global.loadImageElementForClip = async () => { throw new Error('decode failed'); };
    await assert.rejects(boundary.restore(restored, restored, 2048, 1024), /decode failed/);
    assert.equal(boundary.needsRestore(restored), false);
    assert.equal(boundary.toggle(restored, restored, 2048, 1024), null);
    assert.equal(restored.boundaryDraft, saved);
    assert.equal(boundary.needsRestore(restored), true);
});
