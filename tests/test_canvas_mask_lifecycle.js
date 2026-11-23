const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('let activeClipMaskEditorCleanup = null;');
const end = source.indexOf('\nfunction bindClipOutputBackgroundScrollDrag(', start);
const editorSource = source.slice(start, end);
const brushSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'inpaint_grid_brush.js'), 'utf8');

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
    let rectanglesPainted = 0;
    function createCanvas() {
        const operations = [];
        const canvas = {width: 0, height: 0, operations, getContext: () => drawing};
        const drawing = {canvas, clearRect() {}, drawImage() {}, save() {}, restore() {},
            fillRect(x, y, width, height) {
                operations.push([x, y, width, height, drawing.globalCompositeOperation]);
                rectanglesPainted++;
            },
            getImageData: () => ({data: [0, 0, 0, 255]})};
        return canvas;
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
        persistClipMask: async (_clip, canvas) => { saved.push(canvas.operations.slice()); },
        activeClipMaskTool: 'brush', clipMaskBrushSize: 96,
        activeClipAutoMaskPickClipId: null, isClipMaskPainting: false,
    };
    vm.createContext(context);
    vm.runInContext(brushSource, context);
    vm.runInContext(code, context);
    const pointStart = source.indexOf('function getClipMaskPoint(');
    const pointEnd = source.indexOf('\nfunction collectAutoMaskSourceCandidateLayers(', pointStart);
    vm.runInContext(source.slice(pointStart, pointEnd), context);
    function bind(index, options = {}) {
        const wrap = {style: {}, classList: {contains: () => Boolean(options.previewMode)},
            addEventListener() {}, removeEventListener() {}};
        const image = {complete: Boolean(options.imageComplete), naturalWidth: 1024, naturalHeight: 1024,
            offsetLeft: 0, offsetTop: 0, clientWidth: 512, clientHeight: 512};
        const overlay = {style: {}, width: 1024, height: 1024,
            setPointerCapture() {}, releasePointerCapture() {},
            getBoundingClientRect: () => ({left: 0, top: 0, width: 512, height: 512, right: 512, bottom: 512})};
        const cursor = {style: {}, classList: {toggle() {}}, setAttribute() {},
            firstElementChild: {setAttribute() {}}};
        const panel = {querySelector(selector) {
            if (selector === '.clip-brush-cursor') return cursor;
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
        rectanglesPainted: () => rectanglesPainted, redraws: () => redraws, resizeBindings: () => resizeBindings,
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
    let visibleStrip = null;
    const wrap = {style: {}, scrollLeft: 0, scrollTop: 0, querySelector: () => visibleStrip,
        getBoundingClientRect: () => ({left: 10, top: 20, width: 402, height: 602})};
    const img = {style: {}};
    const wideClip = {imageWidth: 1024, imageHeight: 512};
    context.applyClipPreviewZoom(wrap, img, wideClip);
    assert.equal(img.style.width, '400px');
    assert.equal(img.style.height, '200px');

    visibleStrip = {dataset: {referenceWidth: '1024'}, style: {}};
    context.applyClipPreviewZoom(wrap, img, wideClip);
    assert.equal(img.style.width, '200px');
    assert.equal(img.style.height, '100px');
    assert.deepEqual(visibleStrip.style, {width: '200px', height: '100px'});
    visibleStrip = null;

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
        for (let x = 2; x <= 101; x++) {
            const count = fixture.rectanglesPainted();
            overlay.onpointermove(pointer(x));
            assert.ok(fixture.rectanglesPainted() > count);
        }
        fixture.flushFrames();
        fixture.movesRedrawn = fixture.redraws() - startCount;
        await overlay.onpointerup(pointer(101));
    }
    assert.equal(before.movesRedrawn, 100);
    assert.equal(after.movesRedrawn, 1);
    assert.deepEqual(after.saved, before.saved);
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
    assert.ok(fixture.saved[0].some(([x, y, w, h, mode]) =>
        x <= 1023 && x + w === 1024 && y === 0 && h > 0 && mode === 'source-over'));
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
    assert.ok(fixture.saved[0].length > 0);
    assert.ok(fixture.saved[0].every(rect => rect[4] === 'destination-out'));
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

function renderPanelHarness({oldPanel = true, oldKey, oldScrollLeft = 117, oldScrollTop = 209,
    clipId = 42, imageWidth = 640, imageHeight = 480, previewMode = false, resultClip = null, boundary = false} = {}) {
    const events = [];
    const clipSizeKey = `41:${clipId}:${imageWidth}x${imageHeight}`;
    const selection = {id: 41, type: 'selection', name: 'synthetic selection'};
    const clip = {id: clipId, type: 'clip', src: '/synthetic/clip.png', imageWidth, imageHeight};
    const boundaryState = {anchor: clip, rect: {x: 2, y: 3, width: 128, height: 128}, canvasWidth: 800, canvasHeight: 600};
    let newScrollLeft = 0;
    let newScrollTop = 0;
    const wrap = {
        dataset: {},
        get scrollLeft() { return newScrollLeft; },
        set scrollLeft(value) { events.push(`scrollLeft:${value}`); newScrollLeft = value; },
        get scrollTop() { return newScrollTop; },
        set scrollTop(value) { events.push(`scrollTop:${value}`); newScrollTop = value; }
    };
    const image = {style: {}};
    const oldWrap = {scrollLeft: oldScrollLeft, scrollTop: oldScrollTop};
    const priorPanel = oldPanel ? {
        dataset: {clipSizeKey: oldKey ?? clipSizeKey},
        querySelector: () => oldWrap,
        remove() { events.push('remove-old-panel'); }
    } : null;
    const panel = {
        dataset: {},
        style: {},
        classList: {contains: () => false, toggle() {}},
        querySelector(selector) {
            if (selector === '.canvas-clip-output-image-wrap') return wrap;
            if (selector === '.clip-output-image') return image;
            return {};
        }
    };
    const stage = {
        classList: {add() {}, remove() {}},
        querySelector: () => priorPanel,
        appendChild() { events.push('append-new-panel'); }
    };
    const context = {
        currentCanvasWidth: 800, currentCanvasHeight: 600,
        findCanvasLayer: () => ({layer: clip}),
        CanvasClipBoundary: {needsRestore: () => false, get: () => boundary ? boundaryState : null},
        bindClipBoundaryEditor() {events.push('bindClipBoundaryEditor');},
        createClipBoundarySource: () => async () => {
            events.push('render-boundary-scene');
            return {toDataURL: () => '/synthetic/boundary.png'};
        },
        disposeClipMaskEditor() { events.push('dispose-mask-editor'); },
        el: () => stage,
        getClipOutputTarget: () => ({selection, clip}),
        getTopVisibleInpaintClipForSelection: () => resultClip?.visible ? resultClip : null,
        isClipInpaintPreviewMode: previewMode,
        isClipInpaintMergedSourceMode: false,
        clipMergedSourcePreviewCache: {key: '', dataUrl: ''},
        clipPreviewZoom: 1,
        openClipMaskSizeTool: null,
        activeClipMaskTool: 'brush',
        CLIP_MASK_BRUSH_MIN: 1,
        CLIP_MASK_BRUSH_MAX: 256,
        CLIP_MASK_BRUSH_STEP: 1,
        clipMaskBrushSize: 96,
        isSelectionOverlayHidden: false,
        activeClipAutoMaskPickClipId: null,
        clipInpaintLoadingClipId: null,
        clipInpaintLoadingMessage: '',
        escapeHtml: value => String(value),
        document: {createElement: () => panel},
        positionClipOutputPanel() {},
        fitClipOutputPanelToImage() {},
        keepDefaultClipOutputPanelVisible() {},
        bindClipOutputPanelDrag() {},
        bindClipMaskEditor() { events.push('bindClipMaskEditor'); },
        syncClipInpaintProcessing() {},
        applyClipPreviewZoom(outputWrap, outputImage, targetClip) {
            events.push(['applyClipPreviewZoom', outputWrap, outputImage, targetClip]);
            // Model scroll range changes caused by laying out the newly sized image.
            outputWrap.scrollLeft = 5;
            outputWrap.scrollTop = 7;
        }
    };
    vm.createContext(context);
    const renderStart = source.indexOf('function renderClipOutputPanel()');
    const renderEnd = source.indexOf('\nfunction getOrCreateSelectionInpaintFolder(', renderStart);
    assert.ok(renderStart >= 0 && renderEnd > renderStart, 'renderClipOutputPanel source is present');
    vm.runInContext(source.slice(renderStart, renderEnd), context);
    context.renderClipOutputPanel();
    return {context, events, wrap, image, clip, clipSizeKey, panel};
}

test('hiding all inpaint results keeps result view on and showing a result restores its preview', () => {
    const resultClip = {id: 43, src: '/synthetic/result.png', imageWidth: 640, imageHeight: 480, visible: true};
    const {context, wrap, clip, panel} = renderPanelHarness({previewMode: true, resultClip});
    assert.equal(wrap.dataset.displaySrc, resultClip.src);

    resultClip.visible = false;
    context.renderClipOutputPanel();
    assert.equal(context.isClipInpaintPreviewMode, true);
    assert.match(panel.innerHTML, /clip-mask-tool-labeled active"\s+title="인페인팅 결과 보기 토글"\s+aria-pressed="true"/);
    assert.equal(wrap.dataset.displaySrc, clip.src);

    resultClip.visible = true;
    context.renderClipOutputPanel();
    assert.equal(wrap.dataset.displaySrc, resultClip.src);
});

test('an ordinary result stays visible and copies its own geometry while the boundary draft remains active', async () => {
    const resultClip = {id: 43, src: '/synthetic/old-result.png', visible: true, imageWidth: 320, imageHeight: 128,
        x: 50, y: 70, layerWidth: 160, layerHeight: 64, rotation: 15};
    const {context, events, clip, wrap, panel} = renderPanelHarness({boundary: true, previewMode: true, resultClip});
    assert.equal(wrap.dataset.displaySrc, resultClip.src);
    assert.ok(panel.innerHTML.includes('src="' + resultClip.src + '"'));
    assert.ok(events.includes('bindClipMaskEditor'));
    assert.ok(!events.includes('bindClipBoundaryEditor'));

    Object.assign(context, {normalizePromptInfo: value => value,
        CanvasSelectionRotation: require('../static/canvas_selection_rotation')});
    vm.runInContext(source.slice(source.indexOf('function getCurrentClipOutputDisplayState('),
        source.indexOf('function buildExternalClipboardPayloadForClipOutput(')), context);
    const clipboard = await context.captureClipOutputForClipboard(context.getCurrentClipOutputDisplayState());
    assert.deepEqual([clipboard.src, clipboard.clipId, clipboard.x, clipboard.y, clipboard.imageWidth,
        clipboard.imageHeight, clipboard.layerWidth, clipboard.layerHeight, clipboard.rotation],
        [resultClip.src, 43, 50, 70, 320, 128, 160, 64, 15]);
    assert.ok(!events.includes('render-boundary-scene'));
    assert.equal(context.CanvasClipBoundary.get(clip).anchor, clip);
    context.isClipInpaintPreviewMode = false;
    context.renderClipOutputPanel();
    assert.ok(events.includes('bindClipBoundaryEditor'));
    assert.equal(context.CanvasClipBoundary.get(clip).anchor, clip);
});

test('rerendering the same clip restores scroll after applying its preview zoom', () => {
    const fixture = renderPanelHarness({oldPanel: true, oldScrollLeft: 117, oldScrollTop: 209});
    assert.equal(fixture.wrap.scrollLeft, 117);
    assert.equal(fixture.wrap.scrollTop, 209);
    const bindIndex = fixture.events.indexOf('bindClipMaskEditor');
    const zoomIndex = fixture.events.findIndex(event => Array.isArray(event)
        && event[0] === 'applyClipPreviewZoom');
    assert.ok(bindIndex >= 0, 'mask editor is rebound');
    assert.ok(zoomIndex > bindIndex, 'preview zoom is applied after binding the mask editor');
    assert.equal(fixture.events[zoomIndex][1], fixture.wrap);
    assert.equal(fixture.events[zoomIndex][2], fixture.image);
    assert.equal(fixture.events[zoomIndex][3], fixture.clip);
    assert.ok(fixture.events.indexOf('scrollLeft:117') > zoomIndex);
    assert.ok(fixture.events.indexOf('scrollTop:209') > zoomIndex);
});

test('rerendering preserves zero scroll coordinates for the same clip', () => {
    const fixture = renderPanelHarness({oldPanel: true, oldScrollLeft: 0, oldScrollTop: 0});
    assert.equal(fixture.wrap.scrollLeft, 0);
    assert.equal(fixture.wrap.scrollTop, 0);
    assert.ok(fixture.events.includes('scrollLeft:0'));
    assert.ok(fixture.events.includes('scrollTop:0'));
});

test('rerendering another clip or image size does not restore the old panel scroll', () => {
    for (const options of [
        {clipId: 43, imageWidth: 640, imageHeight: 480},
        {clipId: 42, imageWidth: 800, imageHeight: 480}
    ]) {
        const fixture = renderPanelHarness({oldPanel: true, oldScrollLeft: 117, oldScrollTop: 209,
            oldKey: '41:42:640x480', ...options});
        assert.equal(fixture.wrap.scrollLeft, 0);
        assert.equal(fixture.wrap.scrollTop, 0);
        assert.equal(fixture.events.includes('scrollLeft:117'), false);
        assert.equal(fixture.events.includes('scrollTop:209'), false);
        assert.equal(fixture.events.some(event => Array.isArray(event)
            && event[0] === 'applyClipPreviewZoom'), false);
    }
});

test('rendering the first clip output panel needs no previous panel', () => {
    const fixture = renderPanelHarness({oldPanel: false});
    assert.equal(fixture.wrap.scrollLeft, 0);
    assert.equal(fixture.wrap.scrollTop, 0);
    assert.equal(fixture.events.some(event => Array.isArray(event)
        && event[0] === 'applyClipPreviewZoom'), false);
});
