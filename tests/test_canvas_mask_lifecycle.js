const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('let activeClipMaskEditorCleanup = null;');
const end = source.indexOf('\nfunction bindClipOutputBackgroundScrollDrag(', start);
const editorSource = source.slice(start, end);

function harness(code = editorSource) {
    const listeners = new Set();
    const frames = new Map();
    let frameId = 0;
    let redraws = 0;
    let resizeBindings = 0;
    let resizeDisposals = 0;
    const previews = [];
    const saved = [];
    const observers = new Set();
    function createCanvas() {
        const operations = [];
        const drawing = {clearRect() {}, drawImage() {}, save() {}, restore() {}, beginPath() {},
            getImageData: () => ({data: [0, 0, 0, 255]})};
        for (const action of ['arc', 'moveTo', 'lineTo', 'stroke', 'fill']) {
            drawing[action] = (...args) => operations.push([action, ...args, drawing.globalCompositeOperation]);
        }
        return {width: 0, height: 0, operations, getContext: () => drawing};
    }
    const context = {
        console,
        ResizeObserver: class {
            constructor(callback) { this.callback = callback; }
            observe(panel) { this.panel = panel; observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        window: {
            addEventListener(type, fn) { if (type === 'resize') listeners.add(fn); },
            removeEventListener(type, fn) { if (type === 'resize') listeners.delete(fn); },
        },
        document: {createElement: createCanvas},
        getClipBrushCursor: () => ({style: {}}),
        applyClipPreviewZoom() {}, resizeCanvasPreserveContent() {},
        keepDefaultClipOutputPanelVisible() {},
        bindClipOutputPanelResize() {
            resizeBindings++;
            return () => { resizeDisposals++; };
        },
        bindClipPreviewWheelZoom() {}, bindClipOutputBackgroundScrollDrag() {},
        redrawMaskOverlay(canvas) { redraws++; previews.push(canvas.operations.slice()); },
        requestAnimationFrame(callback) { const id = frameId++; frames.set(id, callback); return id; },
        cancelAnimationFrame(id) { frames.delete(id); },
        updateClipBrushCursor() {},
        persistClipMask: async (_clip, canvas) => { saved.push(canvas.operations.slice()); },
        activeClipMaskTool: 'brush', clipMaskBrushSize: 96,
        activeClipAutoMaskPickClipId: null, isClipMaskPainting: false,
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    const pointStart = source.indexOf('function getClipMaskPoint(');
    const pointEnd = source.indexOf('\nfunction collectAutoMaskSourceCandidateLayers(', pointStart);
    vm.runInContext(source.slice(pointStart, pointEnd), context);
    function bind(index, options = {}) {
        const wrap = {style: {}, classList: {contains: () => Boolean(options.previewMode)}};
        const image = {complete: Boolean(options.imageComplete), naturalWidth: 1024, naturalHeight: 1024,
            offsetLeft: 0, offsetTop: 0, clientWidth: 512, clientHeight: 512};
        const overlay = {style: {}, width: 1024, height: 1024,
            setPointerCapture() {}, releasePointerCapture() {},
            getBoundingClientRect: () => ({left: 0, top: 0, width: 512, height: 512})};
        const panel = {querySelector(selector) {
            return selector.includes('image-wrap') ? wrap : selector.includes('output-image') ? image : overlay;
        }};
        context.bindClipMaskEditor(panel, {id: index, imageWidth: 1024, imageHeight: 1024, ...options});
        image.overlay = overlay;
        return image;
    }
    function flushFrames() {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach(callback => callback());
    }
    return {context, listeners, observers, frames, bind, flushFrames, previews, saved,
        redraws: () => redraws, resizeBindings: () => resizeBindings,
        resizeDisposals: () => resizeDisposals};
}

test('rebuilding the mask panel retains one resize listener instead of old panel closures', () => {
    const fixture = harness();
    const firstImage = fixture.bind(1);
    for (let index = 2; index <= 20; index++) fixture.bind(index);
    assert.equal(fixture.listeners.size, 1);
    assert.equal(fixture.observers.size, 1);
    assert.equal(firstImage.onload, null);
    const before = fixture.redraws();
    for (const listener of fixture.listeners) listener();
    assert.equal(fixture.redraws() - before, 1);
    fixture.context.disposeClipMaskEditor();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.observers.size, 0);
    assert.equal(fixture.resizeBindings(), 20);
    assert.equal(fixture.resizeDisposals(), fixture.resizeBindings());
});

test('disposed pending mask loads cannot redraw their old panel', async () => {
    const fixture = harness();
    let finish;
    fixture.context.loadImageElementForClip = () => new Promise(resolve => { finish = resolve; });
    fixture.bind(1, {maskSrc: '/canvas-imports/synthetic-mask.png'});
    fixture.context.disposeClipMaskEditor();
    const before = fixture.redraws();
    finish({});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.redraws(), before);
    assert.equal(fixture.listeners.size, 0);
});

test('disposing result preview also clears its image callback and queued frame', () => {
    const fixture = harness();
    const image = fixture.bind(1, {previewMode: true, imageComplete: true});
    assert.equal(fixture.listeners.size, 1);
    fixture.context.disposeClipMaskEditor();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.observers.size, 0);
    assert.equal(image.onload, null);
    const before = fixture.redraws();
    fixture.flushFrames();
    assert.equal(fixture.redraws(), before);
});

test('panel resizing realigns the mask without changing painted strokes and stale observers are inert', () => {
    const fixture = harness();
    const image = fixture.bind(1, {imageComplete: true});
    fixture.flushFrames();
    image.overlay.onpointerdown(pointer(10));
    fixture.flushFrames();
    const painted = fixture.previews.at(-1);
    const observer = [...fixture.observers][0];
    image.clientWidth = 680;
    image.clientHeight = 680;
    observer.callback();
    assert.equal(image.overlay.style.width, '680px');
    assert.equal(image.overlay.style.height, '680px');
    assert.deepEqual(fixture.previews.at(-1), painted);
    fixture.context.disposeClipMaskEditor();
    const before = fixture.redraws();
    observer.callback();
    assert.equal(fixture.redraws(), before);
});

test('preview contains wide and tall images in both viewport axes and wheel zoom leaves the viewport fixed', () => {
    let pendingFrame = null;
    const context = {
        clipPreviewZoom: 1,
        CLIP_PREVIEW_ZOOM_MIN: 0.25,
        CLIP_PREVIEW_ZOOM_MAX: 8,
        getWheelZoomFactor: () => 2,
        clampZoom: (value, min, max) => Math.max(min, Math.min(max, value)),
        getComputedStyle: () => ({borderLeftWidth: '1px', borderRightWidth: '1px',
            borderTopWidth: '1px', borderBottomWidth: '1px'}),
        requestAnimationFrame(callback) { pendingFrame = callback; },
        saveCanvasState() {},
        document: {querySelector: () => null}
    };
    vm.createContext(context);
    const zoomStart = source.indexOf('function applyClipPreviewZoom(');
    const wheelStart = source.indexOf('function handleClipPreviewWheelZoom(');
    const wheelEnd = source.indexOf('\nfunction normalizeCanvasStateForCompare(', wheelStart);
    const viewportStart = source.indexOf('function getClipOutputViewportSize(');
    const viewportEnd = source.indexOf('\nfunction fitClipOutputPanelToImage(', viewportStart);
    vm.runInContext(source.slice(viewportStart, viewportEnd) +
        source.slice(zoomStart, source.indexOf('\nfunction bindClipPreviewWheelZoom(', zoomStart)) +
        source.slice(wheelStart, wheelEnd), context);
    const wrap = {style: {}, scrollLeft: 0, scrollTop: 0,
        getBoundingClientRect: () => ({left: 10, top: 20, width: 402, height: 602})};
    const img = {style: {}};
    const wideClip = {imageWidth: 1024, imageHeight: 512};
    context.applyClipPreviewZoom(wrap, img, wideClip);
    assert.equal(img.style.width, '400px');
    assert.equal(img.style.height, '200px');

    const tallClip = {imageWidth: 512, imageHeight: 1024};
    context.applyClipPreviewZoom(wrap, img, tallClip);
    assert.equal(img.style.width, '300px');
    assert.equal(img.style.height, '600px');

    const event = {target: img, deltaY: -100, clientX: 110, clientY: 320,
        preventDefault() {}, stopPropagation() {}};
    context.handleClipPreviewWheelZoom(event, wrap, img, tallClip);
    assert.equal(context.clipPreviewZoom, 2);
    assert.equal(img.style.width, '600px');
    assert.equal(img.style.height, '1200px');
    assert.deepEqual(wrap.style, {});
    pendingFrame();

    context.clipPreviewZoom = 1;
    wrap.getBoundingClientRect = () => ({left: 0, top: 0, width: 333.69, height: 333.69});
    context.getComputedStyle = () => ({borderLeftWidth: '1.11111px', borderRightWidth: '1.11111px',
        borderTopWidth: '1.11111px', borderBottomWidth: '1.11111px'});
    context.applyClipPreviewZoom(wrap, img, tallClip);
    assert.equal(img.style.height, '331px');
    assert.ok(parseFloat(img.style.height) <= 331);
});

const pointer = (x, y = x) => ({clientX: x, clientY: y, button: 0, pointerId: 1,
    preventDefault() {}, stopPropagation() {}});

test('100 pointer moves preserve every stroke while coalescing 100 previews to one', async () => {
    const immediateSource = editorSource.replace('lastPoint = point;\n        queueMaskPreview();',
        'lastPoint = point;\n        renderMaskPreview();');
    assert.notEqual(immediateSource, editorSource);
    const before = harness(immediateSource);
    const after = harness();
    for (const fixture of [before, after]) {
        const {overlay} = fixture.bind(1);
        overlay.onpointerdown(pointer(1));
        const startCount = fixture.redraws();
        for (let x = 2; x <= 101; x++) overlay.onpointermove(pointer(x));
        fixture.flushFrames();
        fixture.movesRedrawn = fixture.redraws() - startCount;
        await overlay.onpointerup(pointer(101));
    }
    assert.equal(before.movesRedrawn, 100);
    assert.equal(after.movesRedrawn, 1);
    assert.deepEqual(after.saved, before.saved);
    assert.equal(after.saved[0].filter(operation => operation[0] === 'lineTo').length, 100);
});

test('release before the next frame flushes the final stroke including clipped outside points', async () => {
    const fixture = harness();
    const {overlay} = fixture.bind(1);
    overlay.onpointerdown(pointer(8));
    overlay.onpointermove(pointer(32));
    overlay.onpointermove(pointer(640, -20));
    assert.equal(fixture.frames.size, 1);
    const before = fixture.redraws();
    await overlay.onpointerup(pointer(640, -20));
    assert.equal(fixture.frames.size, 0);
    assert.equal(fixture.redraws(), before + 1);
    assert.deepEqual(fixture.previews.at(-1), fixture.saved[0]);
    assert.deepEqual(fixture.saved[0].filter(operation => operation[0] === 'lineTo').at(-1),
        ['lineTo', 1024, 0, 'source-over']);
    fixture.flushFrames();
    assert.equal(fixture.redraws(), before + 1);
});

test('pointer cancellation flushes erasing and rebinding cancels an obsolete pending preview', async () => {
    const fixture = harness();
    fixture.context.activeClipMaskTool = 'eraser';
    const {overlay} = fixture.bind(1);
    overlay.onpointerdown(pointer(8));
    overlay.onpointermove(pointer(64));
    await overlay.onpointercancel();
    assert.equal(fixture.frames.size, 0);
    assert.deepEqual(fixture.saved[0].filter(operation => operation[0] === 'stroke').at(-1),
        ['stroke', 'destination-out']);
    overlay.onpointerdown(pointer(20));
    overlay.onpointermove(pointer(40));
    assert.equal(fixture.frames.size, 1);
    fixture.bind(2);
    assert.equal(fixture.frames.size, 0);
    const before = fixture.redraws();
    fixture.flushFrames();
    assert.equal(fixture.redraws(), before);
});

test('mask overlay preserves transparent pixels and clamps every nonzero alpha to 150', () => {
    const alphas = [0, 1, 127, 149, 150, 151, 254, 255];
    const data = new Uint8ClampedArray(alphas.flatMap(alpha => [13, 27, 41, alpha]));
    const ctx = {clearRect() {}, drawImage() {}, getImageData: () => ({data}), putImageData() {}};
    const context = {document: {createElement: () => ({getContext: () => ctx})}};
    vm.createContext(context);
    const redrawStart = source.indexOf('function redrawMaskOverlay(');
    vm.runInContext(source.slice(redrawStart, source.indexOf('\nasync function persistClipMask(', redrawStart)), context);
    context.redrawMaskOverlay({width: 8, height: 1, getContext: () => ctx}, {width: 8, height: 1, getContext: () => ctx});
    assert.deepEqual([...data], alphas.flatMap(alpha => alpha === 0
        ? [13, 27, 41, 0] : [72, 160, 255, Math.min(150, alpha)]));
});

test('rendering a closed panel and clearing the canvas both run cleanup', () => {
    const renderStart = source.indexOf('function renderClipOutputPanel()');
    const renderEnd = source.indexOf('\nfunction getOrCreateSelectionInpaintFolder(', renderStart);
    const renderSource = source.slice(renderStart, renderEnd);
    const fixture = harness();
    fixture.bind(1);
    fixture.context.el = () => null;
    vm.runInContext(renderSource, fixture.context);
    fixture.context.renderClipOutputPanel();
    assert.equal(fixture.listeners.size, 0);
    assert.equal(fixture.resizeDisposals(), fixture.resizeBindings());
    const clearStart = source.indexOf('function clearCurrentCanvasCompletely()');
    const clearEnd = source.indexOf('\nfunction ', clearStart + 10);
    assert.match(source.slice(clearStart, clearEnd), /disposeClipMaskEditor\(\)/);
});
