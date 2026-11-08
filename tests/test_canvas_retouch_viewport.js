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
    getImageData(...args) {
        this.calls.push(['getImageData', ...args]);
        return {data: new Uint8ClampedArray([17, 29, 43, 255])};
    }
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
    constructor() { this.elements = []; }
    createElement(tagName) {
        const element = new FakeElement(tagName, this);
        this.elements.push(element);
        return element;
    }
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

function deferred() {
    let resolve, reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

async function waitFor(predicate, message, timeoutMs = 1200) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) await sleep(10);
    assert.ok(predicate(), message);
}

function regionResult(docWidth, docHeight, imageRect, workspaceRect, dpr = 1, baseScale) {
    return Viewport.viewportRegion(docWidth, docHeight, imageRect, workspaceRect, dpr, baseScale);
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

test('viewportRegion accepts the actual base bitmap density and uses the full DPR', () => {
    assert.equal(Viewport.BASE_PREVIEW_EDGE, 1600);
    const baseScale = 203 / 5000;
    assert.equal(regionResult(5000, 16000,
        {left: 0, top: 0, width: 203, height: 651},
        {left: 0, top: 0, width: 203, height: 651}, 1, baseScale), null);

    const zoomed = regionResult(5000, 16000,
        {left: 0, top: 0, width: 448, height: 1432},
        {left: 0, top: 0, width: 448, height: 1432}, 1, baseScale);
    assert.ok(zoomed, 'the zoomed viewport needs a denser tile than the supplied base bitmap');
    assert.equal(zoomed.scale, 448 / 5000);

    const highDpr = regionResult(5000, 16000,
        {left: 0, top: 0, width: 1000, height: 3200},
        {left: 0, top: 0, width: 100, height: 100}, 4);
    assert.equal(highDpr.scale, 0.8);
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
    assert.match(h.imageCanvas.style.clipPath, /16\.8% 8\.375%/);
    h.viewport.destroy();
    assert.equal(bitmap.closeCount, 1);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
});

test('create uses the supplied base bitmap density when deciding whether to request detail', async () => {
    const baseScale = 203 / 5000;
    const h = createHarness({getBaseScale: () => baseScale});
    h.host.rect = {left: 0, top: 0, width: 203, height: 651};
    h.workspace.rect = {left: 0, top: 0, width: 203, height: 651};
    h.viewport.schedule();
    await sleep(220);
    assert.equal(h.requests.length, 0, 'matching the supplied base density does not fetch another crop');

    h.host.rect = {left: 0, top: 0, width: 448, height: 1432};
    h.workspace.rect = {left: 0, top: 0, width: 448, height: 1432};
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'zoomed viewport did not request detail');
    assert.equal(h.requests[0].body.scale, 448 / 5000);
    const bitmap = new FakeBitmap(448, 1434);
    h.requests[0].resolve(bitmap);
    await waitFor(() => h.canvas.style.display === 'block', 'detail crop was not displayed');
    h.viewport.destroy();
    assert.equal(bitmap.closeCount, 1);
});

test('native underlay publishes during a pending crop, clips with the tile, samples exposed detail, and restores on fit', async () => {
    const nativeLoad = deferred();
    let loadCalls = 0;
    let allowRequest = false;
    const h = createHarness({
        canRequest: () => allowRequest,
        loadNativeUnderlay() {
            loadCalls += 1;
            return nativeLoad.promise;
        }
    });
    h.viewport.schedule();
    assert.equal(loadCalls, 1, 'native image loading starts independently from the viewport request');
    await waitFor(() => loadCalls === 1, 'native image load did not start');
    assert.equal(h.imageCanvas.style.visibility, undefined, 'the fitted image stays visible while native source loads');
    assert.equal(h.host.children.some(child => child.tagName === 'IMG'), false);

    const nativeImage = h.document.createElement('img');
    nativeImage.naturalWidth = 5000;
    nativeImage.naturalHeight = 16000;
    nativeLoad.resolve(nativeImage);
    await waitFor(() => nativeImage.parentNode === h.host, 'loaded native image was not inserted');
    assert.deepEqual(h.host.children, [h.imageCanvas, nativeImage, h.canvas, h.inkCanvas]);
    assert.equal(nativeImage.getAttribute('aria-hidden'), 'true');
    assert.equal(nativeImage.alt, '');
    assert.equal(nativeImage.draggable, false);
    assert.equal(nativeImage.style.position, 'absolute');
    assert.equal(nativeImage.style.inset, '0');
    assert.equal(nativeImage.style.width, '100%');
    assert.equal(nativeImage.style.height, '100%');
    assert.equal(nativeImage.style.pointerEvents, 'none');
    assert.equal(nativeImage.style.display, 'block');
    assert.equal(h.imageCanvas.style.visibility, 'hidden', 'fitted source hides only after the native image is ready');
    assert.equal(h.canvas.style.display, 'none', 'native source may publish while the crop is still pending');
    assert.equal(h.requests.length, 0, 'native image loads while viewport requests are unavailable');

    allowRequest = true;
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'viewport crop did not start after requests became available');
    const firstTile = new FakeBitmap(464, 564);
    h.requests[0].resolve(firstTile);
    await waitFor(() => h.canvas.style.display === 'block', 'viewport tile was not displayed');
    const firstClip = h.imageCanvas.style.clipPath;
    assert.match(firstClip, /^polygon\(evenodd,/);
    assert.equal(nativeImage.style.clipPath, firstClip, 'both underlays cut the same tile hole');
    const viewportPixel = new Uint8ClampedArray([1, 2, 3, 4]);
    h.canvas.context.getImageData = () => ({data: viewportPixel});
    const canvasCountBeforeTileSample = h.document.elements.filter(element => element.tagName === 'CANVAS').length;
    assert.strictEqual(h.viewport.sampleAt([1000, 1600]), viewportPixel, 'the presented tile takes sampling priority');
    assert.equal(h.document.elements.filter(element => element.tagName === 'CANVAS').length, canvasCountBeforeTileSample,
        'tile sampling does not allocate a native sample canvas');

    h.workspace.rect = {left: 500, top: 800, width: 250, height: 250};
    h.viewport.schedule();
    assert.equal(h.canvas.style.display, 'block', 'the last tile stays visible during a pan');
    assert.equal(h.imageCanvas.style.clipPath, firstClip);
    assert.equal(nativeImage.style.clipPath, firstClip);
    const nativeSample = h.viewport.sampleAt([3000, 4900]);
    assert.deepEqual(Array.from(nativeSample), [17, 29, 43, 255]);
    assert.equal(h.viewport.sampleAt([100, 100]), null, 'native sampling is limited to the visible workspace');
    const sampleCanvas = h.document.elements.filter(element => element.tagName === 'CANVAS').at(-1);
    assert.equal(sampleCanvas.width, 1);
    assert.equal(sampleCanvas.height, 1);
    assert.ok(sampleCanvas.context.calls.some(call => call[0] === 'drawImage'
        && call[1] === nativeImage && call[2] === 3000 && call[3] === 4900
        && call[4] === 1 && call[5] === 1));

    await waitFor(() => h.requests.length === 2, 'new crop did not start after pan');
    const secondTile = new FakeBitmap(250, 250);
    h.requests[1].resolve(secondTile);
    await waitFor(() => h.canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] === secondTile),
        'new tile was not published');
    assert.notEqual(nativeImage.style.clipPath, firstClip, 'the native hole follows the newly presented tile');
    assert.equal(nativeImage.style.clipPath, h.imageCanvas.style.clipPath);

    h.host.rect = {left: 0, top: 0, width: 500, height: 1600};
    h.workspace.rect = {left: 0, top: 0, width: 500, height: 1600};
    h.viewport.schedule();
    assert.equal(nativeImage.style.display, 'none', 'fit view hides but retains the native image');
    assert.equal(h.imageCanvas.style.visibility, undefined);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    assert.equal(h.viewport.sampleAt([1000, 1600]), null, 'native sampling is disabled at fit scale');
    assert.equal(nativeImage.parentNode, h.host);

    h.host.rect = {left: 0, top: 0, width: 1000, height: 3200};
    h.workspace.rect = {left: 200, top: 300, width: 400, height: 500};
    h.viewport.schedule();
    await waitFor(() => nativeImage.style.display === 'block', 'rezoom did not reuse the loaded native image');
    assert.equal(loadCalls, 1, 'rezoom does not load a second native image');
    h.viewport.destroy();
    assert.equal(nativeImage.parentNode, null);
    assert.equal(h.imageCanvas.style.visibility, undefined);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    assert.equal(firstTile.closeCount, 1);
    assert.equal(secondTile.closeCount, 1);
});

test('native underlay failures keep the fit visible and late resolution after destroy is ignored', async () => {
    const failed = createHarness({loadNativeUnderlay: () => Promise.reject(new Error('synthetic source failure'))});
    failed.viewport.schedule();
    await sleep(20);
    assert.equal(failed.host.children.some(child => child.tagName === 'IMG'), false);
    assert.equal(failed.imageCanvas.style.visibility, undefined);
    failed.viewport.destroy();

    const nativeLoad = deferred();
    const late = createHarness({loadNativeUnderlay: () => nativeLoad.promise});
    late.viewport.schedule();
    late.viewport.destroy();
    const nativeImage = late.document.createElement('img');
    nativeImage.naturalWidth = 5000;
    nativeImage.naturalHeight = 16000;
    nativeLoad.resolve(nativeImage);
    await sleep(20);
    assert.equal(nativeImage.parentNode, null);
    assert.equal(late.host.children.some(child => child.tagName === 'IMG'), false);
    assert.equal(late.imageCanvas.style.visibility, undefined);
});

test('comparison requests original sequentially and split changes only redraw cached tiles', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'edited tile request did not start');
    const edited = new FakeBitmap(464, 564);
    h.requests[0].resolve(edited);
    await waitFor(() => h.canvas.style.display === 'block', 'edited tile was not displayed');

    h.viewport.setComparison(true, 40);
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)', 'the fitted image remains visible while loading comparison');
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

test('live edits keep the previous detail tile until an updated tile at the same size is ready', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'initial tile request did not start');
    const original = new FakeBitmap(464, 564);
    h.requests[0].resolve(original);
    await waitFor(() => h.canvas.style.display === 'block', 'initial tile was not drawn');

    const edited = {...h.payload, native: true, layers: [{id: 'edited', opacity: .5}]};
    const pending = h.viewport.renderEdit(edited, new AbortController().signal);
    await waitFor(() => h.requests.length === 2, 'edited tile did not start immediately');
    assert.equal(h.requests[1].body.native, true);
    assert.deepEqual(h.requests[1].body.region, h.requests[0].body.region);
    assert.equal(h.requests[1].body.scale, h.requests[0].body.scale);
    assert.equal(h.canvas.style.display, 'block');
    assert.equal(h.canvas.width, 464);
    assert.equal(original.closeCount, 0);
    assert.match(h.imageCanvas.style.clipPath, /^polygon\(evenodd,/);

    const next = new FakeBitmap(464, 564);
    h.requests[1].resolve(next);
    assert.equal(await pending, true);
    assert.equal(original.closeCount, 1);
    assert.equal(h.canvas.context.calls.at(-1)[1], next);

    const cancelled = h.viewport.renderEdit(edited, new AbortController().signal);
    await waitFor(() => h.requests.length === 3, 'second edit did not start');
    h.viewport.cancelPending();
    assert.equal(h.requests[2].signal.aborted, true);
    const late = new FakeBitmap(464, 564);
    h.requests[2].resolve(late);
    assert.equal(await cancelled, false);
    assert.equal(late.closeCount, 1);
    assert.equal(h.canvas.context.calls.at(-1)[1], next);
    assert.equal(h.canvas.style.display, 'block');
    h.viewport.destroy();
    assert.equal(next.closeCount, 1);
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

test('geometry handoff keeps the presented tile until a fresh crop replaces it', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'initial tile request did not start');
    const first = new FakeBitmap(464, 564);
    h.requests[0].resolve(first);
    await waitFor(() => h.canvas.style.display === 'block', 'initial tile was not drawn');
    const previousClip = h.imageCanvas.style.clipPath;
    const previousPosition = [h.canvas.style.left, h.canvas.style.top,
        h.canvas.style.width, h.canvas.style.height];

    const editPromise = h.viewport.renderEdit(h.payload, new AbortController().signal);
    await waitFor(() => h.requests.length === 2, 'replacement request did not start');
    const staleRequest = h.requests[1];
    h.workspace.rect = {left: 500, top: 800, width: 250, height: 250};
    h.viewport.schedule();
    assert.equal(staleRequest.signal.aborted, true);
    assert.equal(h.canvas.style.display, 'block', 'the last sharp tile remains visible during handoff');
    assert.equal(h.imageCanvas.style.clipPath, previousClip, 'the fitted image fills beyond the last native crop');
    assert.deepEqual([h.canvas.style.left, h.canvas.style.top, h.canvas.style.width, h.canvas.style.height],
        previousPosition, 'the old tile retains its document-space geometry');

    await waitFor(() => h.requests.length === 3, 'fresh geometry request did not start');
    const stale = new FakeBitmap(464, 564);
    staleRequest.resolve(stale);
    assert.equal(await editPromise, false);
    assert.equal(stale.closeCount, 1, 'a stale response is released exactly once');
    const replacement = new FakeBitmap(250, 250);
    h.requests[2].resolve(replacement);
    await waitFor(() => h.canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] === replacement),
        'replacement tile was not published');
    assert.equal(first.closeCount, 1, 'the replaced presentation is released exactly once');
    assert.equal(h.canvas.style.display, 'block');
    assert.notEqual(h.imageCanvas.style.clipPath, previousClip);
    h.viewport.destroy();
    assert.equal(replacement.closeCount, 1);
});

test('comparison enabled during a geometry handoff fetches original for the new target', async () => {
    const h = createHarness();
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 1, 'initial tile request did not start');
    const first = new FakeBitmap(464, 564);
    h.requests[0].resolve(first);
    await waitFor(() => h.canvas.style.display === 'block', 'initial tile was not drawn');

    h.workspace.rect = {left: 500, top: 800, width: 250, height: 250};
    h.viewport.schedule();
    await waitFor(() => h.requests.length === 2, 'new edited target request did not start');
    const nextTargetRegion = h.requests[1].body.region;
    h.viewport.setComparison(true, 50);
    assert.equal(h.canvas.style.display, 'none', 'comparison waits for matching original data');
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');

    const nextEdited = new FakeBitmap(250, 250);
    h.requests[1].resolve(nextEdited);
    await waitFor(() => h.requests.length === 3, 'matching original target request did not start');
    assert.equal(h.requests[2].body.original, true);
    assert.deepEqual(h.requests[2].body.region, nextTargetRegion);
    const nextOriginal = new FakeBitmap(250, 250);
    h.requests[2].resolve(nextOriginal);
    await waitFor(() => h.canvas.context.calls.some(call => call[0] === 'drawImage' && call[1] === nextEdited),
        'new comparison target was not published');
    assert.equal(first.closeCount, 1, 'the previous presentation is released once the pair is ready');
    assert.equal(h.canvas.style.display, 'block');
    assert.match(h.imageCanvas.style.clipPath, /^polygon\(evenodd,/);
    h.viewport.destroy();
    assert.equal(nextEdited.closeCount, 1);
    assert.equal(nextOriginal.closeCount, 1);
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

test('panning during a long conflict keeps the newly exposed area visible and replaces the old crop', async () => {
    let busy = false;
    let attempts = 0;
    const states = [];
    const h = createHarness({
        getConflictRetryDelay: retry => retry < 8 ? 15 : null,
        onDetailStatus: status => states.push(status),
        request(body) {
            attempts += 1;
            if (busy && attempts <= 6) return Promise.reject(Object.assign(new Error('busy'), {status: 409}));
            return Promise.resolve(new FakeBitmap(Math.round(body.region.width * body.scale), Math.round(body.region.height * body.scale)));
        },
    });
    h.viewport.schedule();
    await waitFor(() => h.canvas.style.display === 'block', 'initial crop did not display');
    const previousTop = h.canvas.style.top;
    const previousClip = h.imageCanvas.style.clipPath;
    busy = true;
    h.workspace.rect = {left: 200, top: 550, width: 400, height: 500};
    h.viewport.schedule();
    assert.notEqual(h.imageCanvas.style.visibility, 'hidden', 'the exposed area must remain visible while waiting');
    assert.match(previousClip, /^polygon\(evenodd,/);
    assert.equal(h.imageCanvas.style.clipPath, previousClip, 'only the previous crop covers the fitted image');
    await waitFor(() => h.canvas.style.top !== previousTop, 'the viewport stopped before the renderer recovered', 2500);
    assert.equal(attempts, 7);
    assert.deepEqual(states, ['loading', 'ready', 'loading', 'ready']);
    h.viewport.invalidate();
    assert.equal(h.imageCanvas.style.clipPath, 'inset(2px)');
    h.viewport.destroy();
});
