'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const Viewport = require('../static/canvas_retouch_viewport.js');

class FakeEventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name).add(callback);
    }
    removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
    dispatch(name, extra = {}) {
        for (const callback of this.listeners.get(name) || []) callback({type: name, ...extra});
    }
    listenerCount() {
        return Array.from(this.listeners.values()).reduce((count, callbacks) => count + callbacks.size, 0);
    }
}

class FakeCanvasContext {
    constructor() { this.calls = []; }
    clearRect(...args) { this.calls.push(['clearRect', ...args]); }
    drawImage(...args) { this.calls.push(['drawImage', ...args]); }
    save() { this.calls.push(['save']); }
    beginPath() { this.calls.push(['beginPath']); }
    rect(...args) { this.calls.push(['rect', ...args]); }
    clip() { this.calls.push(['clip']); }
    restore() { this.calls.push(['restore']); }
}

class FakeElement extends FakeEventTarget {
    constructor(tagName, ownerDocument) {
        super();
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.attributes = new Map();
        this.rect = {left: 0, top: 0, width: 1000, height: 3200};
        this.width = 0;
        this.height = 0;
        this.context = this.tagName === 'CANVAS' ? new FakeCanvasContext() : null;
    }
    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    insertBefore(child, before) {
        if (child.parentNode) child.parentNode.removeChild(child);
        const index = before ? this.children.indexOf(before) : -1;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }
    remove() { this.parentNode?.removeChild(this); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getBoundingClientRect() { return {...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height}; }
    getContext(kind) { return kind === '2d' ? this.context : null; }
}

class FakeDocument {
    createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeBitmap {
    constructor(width = 128, height = 128) { this.width = width; this.height = height; this.closeCount = 0; }
    close() { this.closeCount += 1; }
}

function createHarness(overrides = {}) {
    const document = new FakeDocument();
    const host = document.createElement('div');
    const imageCanvas = document.createElement('canvas');
    const inkCanvas = document.createElement('canvas');
    imageCanvas.style.clipPath = 'inset(2px)';
    host.appendChild(imageCanvas);
    host.appendChild(inkCanvas);
    host.rect = {left: 0, top: 0, width: 1000, height: 3200};
    const workspace = document.createElement('div');
    workspace.rect = {left: 200, top: 300, width: 400, height: 500};
    const payload = {source: 'synthetic-source', layers: [{id: 'synthetic-layer'}], print: {widthCm: 50}};
    const requests = [];
    const viewport = Viewport.create({
        host,
        workspace,
        documentWidth: 5000,
        documentHeight: 16000,
        getPayload: () => payload,
        request(body, signal) {
            return new Promise((resolve, reject) => requests.push({body, signal, resolve, reject}));
        },
        ...overrides
    });
    return {document, host, workspace, imageCanvas, inkCanvas, payload, requests, viewport,
        canvas: host.children.find(child => child.className === 'canvas-retouch-viewport')};
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(predicate, message, timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await sleep(10);
    assert.ok(predicate(), message);
}

function regionResult(docWidth, docHeight, imageRect, workspaceRect, dpr = 1) {
    return Viewport.viewportRegion(docWidth, docHeight, imageRect, workspaceRect, dpr);
}

test('viewportRegion maps a zoomed viewport to a padded native-coordinate crop', () => {
    const result = regionResult(5000, 16000,
        {left: 0, top: 0, width: 1000, height: 3200},
        {left: 200, top: 300, width: 400, height: 500});
    assert.deepEqual(result, {region: {x: 840, y: 1340, width: 2320, height: 2820}, scale: 0.2});
});

test('viewportRegion skips sufficient base-preview scale and fully offscreen areas', () => {
    assert.equal(regionResult(5000, 16000,
        {left: 0, top: 0, width: 500, height: 1600},
        {left: 0, top: 0, width: 500, height: 1600}), null);
    assert.equal(regionResult(5000, 16000,
        {left: 0, top: 0, width: 1000, height: 3200},
        {left: 1200, top: 200, width: 300, height: 300}), null);
    assert.equal(regionResult(5000, 16000,
        {left: 0, top: 0, width: 1000, height: 3200},
        {left: 0, top: 0, width: 0, height: 300}), null);
});

test('viewportRegion handles document edges, DPR, and output edge/pixel budgets', () => {
    const edge = regionResult(5000, 16000,
        {left: 0, top: 0, width: 1000, height: 3200},
        {left: 0, top: 0, width: 100, height: 100}, 2);
    assert.deepEqual(edge.region, {x: 0, y: 0, width: 660, height: 660});
    assert.equal(edge.scale, 0.4);

    const budget = regionResult(10000, 10000,
        {left: 0, top: 0, width: 20000, height: 20000},
        {left: 0, top: 0, width: 20000, height: 20000});
    assert.deepEqual(budget.region, {x: 0, y: 0, width: 10000, height: 10000});
    const outputWidth = Math.ceil(budget.region.width * budget.scale);
    const outputHeight = Math.ceil(budget.region.height * budget.scale);
    assert.ok(outputWidth <= 4096 && outputHeight <= 4096);
    assert.ok(outputWidth * outputHeight <= 4194304);
    assert.ok(budget.scale < 0.21);
});

test('create inserts one overlay between image and ink canvases and draws the requested crop', async () => {
    const h = createHarness();
    assert.deepEqual(h.host.children, [h.imageCanvas, h.canvas, h.inkCanvas]);
    assert.equal(h.canvas.className, 'canvas-retouch-viewport');
    assert.equal(h.canvas.style.pointerEvents, 'none');
    assert.equal(h.canvas.style.display, 'none');

    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'debounced tile request did not start');
    const [request] = h.requests;
    assert.deepEqual(request.body.region, {x: 840, y: 1340, width: 2320, height: 2820});
    assert.equal(request.body.scale, 0.2);
    assert.deepEqual(Object.keys(request.body), ['source', 'layers', 'region', 'scale']);
    assert.notStrictEqual(request.body.layers, h.payload.layers, 'request payload must be cloned');
    assert.equal(request.body.original, undefined);
    const bitmap = new FakeBitmap(464, 564);
    request.resolve(bitmap);
    await waitFor(() => h.canvas.style.display === 'block', 'edited tile was not displayed');
    assert.equal(h.canvas.width, 464);
    assert.equal(h.canvas.height, 564);
    assert.equal(h.canvas.style.left, '16.8%');
    assert.equal(h.canvas.style.top, '8.375%');
    assert.equal(h.canvas.style.width, '46.4%');
    assert.equal(h.canvas.style.height, '17.625%');
    assert.ok(h.canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] === bitmap));
    assert.match(h.imageCanvas.style.clipPath, /^polygon\(evenodd,/);
    assert.match(h.imageCanvas.style.clipPath, /16\.8% 8\.375%/);
    h.viewport.destroy();
    assert.equal(bitmap.closeCount, 1);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
});

test('comparison requests original sequentially and split changes only redraw cached tiles', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'edited tile request did not start');
    const edited = new FakeBitmap(464, 564);
    h.requests[0].resolve(edited);
    await waitFor(() => h.canvas.style.display === 'block', 'edited tile was not displayed');

    h.viewport.setComparison(true, 40);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)', 'underlay clip is restored while original comparison tile is missing');
    await waitFor(() => h.requests.length === 2, 'original tile request did not start');
    assert.equal(h.requests[1].body.original, true);
    assert.equal(h.requests[1].body.source, h.requests[0].body.source);
    const original = new FakeBitmap(464, 564);
    h.requests[1].resolve(original);
    await waitFor(() => h.canvas.context.calls.some(call => call[0] === 'clip'), 'comparison split was not clipped');
    assert.match(h.imageCanvas.style.clipPath, /^polygon\(evenodd,/);
    const drawCount = h.canvas.context.calls.filter(call => call[0] === 'drawImage').length;
    h.viewport.setComparison(true, 65);
    assert.equal(h.requests.length, 2, 'moving the divider must not fetch another edited tile');
    assert.ok(h.canvas.context.calls.filter(call => call[0] === 'drawImage').length > drawCount);
    const stableDrawCount = h.canvas.context.calls.filter(call => call[0] === 'drawImage').length;
    h.viewport.setComparison(true, 65);
    assert.equal(h.canvas.context.calls.filter(call => call[0] === 'drawImage').length, stableDrawCount,
        'repeating the same comparison state does not redraw the tile');
    h.viewport.setComparison(false, 65);
    assert.equal(h.canvas.style.display, 'block');
    h.viewport.destroy();
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    assert.equal(edited.closeCount, 1);
    assert.equal(original.closeCount, 1);
});

test('invalidate aborts an active request and closes a late bitmap without drawing it', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'tile request did not start');
    const request = h.requests[0];
    h.viewport.invalidate();
    assert.equal(request.signal.aborted, true);
    assert.equal(h.canvas.style.display, 'none');
    assert.equal(h.canvas.width, 1);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    const stale = new FakeBitmap();
    request.resolve(stale);
    await sleep(20);
    assert.equal(stale.closeCount, 1);

    h.viewport.schedule();
    await waitFor(() => h.requests.length === 2, 'rescheduled tile request did not start');
    const visible = new FakeBitmap(464, 564);
    h.requests[1].resolve(visible);
    await waitFor(() => h.canvas.style.display === 'block', 'tile did not draw before second invalidation');
    assert.match(h.imageCanvas.style.clipPath, /^polygon\(evenodd,/);
    h.viewport.invalidate();
    assert.equal(h.canvas.style.display, 'none');
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    assert.equal(visible.closeCount, 1);
    h.viewport.destroy();
});

test('geometry changes abort the old crop and only display the latest response', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'first crop request did not start');
    const staleRequest = h.requests[0];
    h.workspace.rect = {left: 500, top: 800, width: 250, height: 250};
    h.viewport.schedule();
    assert.equal(staleRequest.signal.aborted, true);
    await waitFor(() => h.requests.length === 2, 'updated crop request did not start');
    const stale = new FakeBitmap();
    staleRequest.resolve(stale);
    const current = new FakeBitmap(250, 250);
    h.requests[1].resolve(current);
    await waitFor(() => h.canvas.style.display === 'block', 'latest crop was not displayed');
    await sleep(20);
    assert.equal(stale.closeCount, 1);
    assert.ok(h.canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] === current));
    h.viewport.destroy();
});

test('canRequest false does not poll or retry until the caller schedules again', async () => {
    let allowed = false;
    const h = createHarness({canRequest: () => allowed});
    h.viewport.schedule();
    await sleep(450);
    assert.equal(h.requests.length, 0);
    allowed = true;
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'explicit reschedule did not start request');
    h.requests[0].resolve(new FakeBitmap(464, 564));
    await waitFor(() => h.canvas.style.display === 'block', 'tile did not display after reschedule');
    h.viewport.destroy();
});

test('destroy removes listeners and canvas, and closes late results without further DOM writes', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'tile request did not start');
    const request = h.requests[0];
    const canvas = h.canvas;
    h.viewport.destroy();
    assert.equal(request.signal.aborted, true);
    assert.equal(h.host.children.includes(canvas), false);
    assert.equal(h.workspace.listenerCount(), 0);
    assert.equal(canvas.style.display, 'none');
    const stale = new FakeBitmap();
    request.resolve(stale);
    await sleep(20);
    assert.equal(stale.closeCount, 1);
    assert.equal(canvas.style.display, 'none');
    assert.equal(canvas.width, 1);
});

test('409 retries are bounded to three retries and stop after the fourth conflict', async () => {
    let attempts = 0;
    const h = createHarness({request(_body, _signal) {
        attempts += 1;
        const error = new Error('conflict');
        error.status = 409;
        return Promise.reject(error);
    }});
    h.viewport.schedule();
    await waitFor(() => attempts === 4, 'request did not stop after three conflict retries', 1800);
    await sleep(20);
    assert.equal(attempts, 4);
    assert.equal(h.canvas.style.display, 'none');
    h.viewport.destroy();
});
