const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end);
}

function harness() {
    const bindings = [];
    let surfaceRect = {left: 0, top: 0};
    const workspace = {dataset: {}, scrollLeft: 0, scrollTop: 0,
        addEventListener: (...args) => bindings.push(args)};
    const surface = {
        clientWidth: 640,
        style: {},
        getBoundingClientRect: () => ({...surfaceRect}),
    };
    let renders = 0, saves = 0, prevented = 0;
    const renderOptions = [], saveOptions = [];
    const frames = [];
    let nextFrameId = 0;
    const context = vm.createContext({
        document: {querySelector: selector => selector === '.canvas-workspace' ? workspace : null},
        window: {},
        el: id => id === 'canvasSurface' ? surface : null,
        currentCanvasWidth: 640, currentCanvasHeight: 2048, canvasZoom: 1,
        canvasLayers: [], pendingCanvasWheelZoomFrame: null, pendingCanvasWheelZoom: null,
        WHEEL_ZOOM_STEP: 1.12, CANVAS_ZOOM_MIN: 0.1,
        hasActiveCanvasGeometryDrag: () => false,
        getCanvasFitScale: () => 1,
        getCanvasDisplayScale: () => surface.clientWidth / context.currentCanvasWidth,
        renderCanvas: (width, height, options) => {
            renders++; renderOptions.push(options);
            surface.clientWidth = width * context.canvasZoom * context.getCanvasFitScale(width, height);
            if (context.afterRender) context.afterRender(surfaceRect);
        },
        saveCanvasState: options => { saves++; saveOptions.push(options); },
        requestAnimationFrame: callback => { const id = ++nextFrameId; frames.push({id, callback, cancelled: false}); return id; },
        cancelAnimationFrame: id => { const frame = frames.find(item => item.id === id); if (frame) frame.cancelled = true; },
    });
    for (const name of ['clampZoom', 'getWheelZoomFactor', 'bindCanvasWheelZoom', 'flushPendingCanvasWheelZoom', 'handleCanvasWheelZoom']) {
        vm.runInContext(functionSource(name), context);
    }
    const wheel = (target, deltaY = -120, clientX = 100, clientY = 200) => context.handleCanvasWheelZoom({
        target, deltaY, clientX, clientY,
        preventDefault: () => { prevented++; }, stopPropagation() {},
    });
    const flushFrames = () => {
        const ready = frames.splice(0);
        for (const frame of ready) if (!frame.cancelled) frame.callback();
        return ready.filter(frame => !frame.cancelled).length;
    };
    return {context, workspace, surface, bindings, wheel, renderOptions, saveOptions, frames, flushFrames,
        setSurfaceRect: (left, top) => { surfaceRect = {left, top}; },
        counts: () => ({renders, saves, prevented})};
}

test('wheel binds once and batches workspace zoom into one frame and one view-only save', () => {
    const h = harness();
    h.context.bindCanvasWheelZoom();
    h.context.bindCanvasWheelZoom();
    assert.equal(h.bindings.length, 1);
    assert.equal(h.bindings[0][0], 'wheel');
    assert.equal(h.bindings[0][2].passive, false);
    for (const area of ['canvas-surface', 'canvas-workspace', 'canvas-opposite-preview']) {
        h.wheel({closest: () => null, className: area});
    }
    assert.equal(h.context.canvasZoom, Math.pow(1.12, 3));
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 3});
    assert.equal(h.frames.length, 1);
    h.flushFrames();
    assert.deepEqual(h.counts(), {renders: 1, saves: 1, prevented: 3});
    assert.deepEqual(h.renderOptions.map(options => options?.zoomOnly), [true]);
    assert.deepEqual(h.saveOptions.map(options => options?.viewOnly), [true]);
    assert.ok(h.workspace.scrollLeft > 0);
    assert.ok(h.workspace.scrollTop > 0);
    h.wheel({closest: () => null}, 120);
    assert.equal(h.context.canvasZoom, Math.pow(1.12, 2));
    assert.deepEqual(h.counts(), {renders: 1, saves: 1, prevented: 4});
    h.flushFrames();
    assert.deepEqual(h.counts(), {renders: 2, saves: 2, prevented: 4});
});

test('embedded controls retain scrolling and zero vertical delta does not zoom', () => {
    const h = harness();
    for (const selector of ['.canvas-clip-output-panel', '.canvas-pinned-reference-panel',
        '#canvasDakiFocus', '.canvas-multi-references', 'input', 'textarea', 'select', 'button', '[contenteditable="true"]']) {
        h.wheel({closest: selectors => selectors.split(', ').includes(selector) ? {} : null});
    }
    h.wheel({closest: () => null}, 0);
    assert.equal(h.context.canvasZoom, 1);
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 0});
});

test('normal and retouch zoom pass native scale without an upper clamp and zoom out from high magnification', () => {
    for (const retouch of [false, true]) {
        const h = harness();
        h.context.getCanvasFitScale = () => .04;
        h.context.currentCanvasWidth = 5000;
        h.context.currentCanvasHeight = 16000;
        h.context.canvasZoom = 25;
        h.surface.clientWidth = 5000;
        if (retouch) h.context.window.CanvasRetouch = {isOpen: () => true};
        for (let index = 0; index < 20; index += 1) h.wheel({closest: () => null});
        assert.ok(Math.abs(h.context.canvasZoom - 25 * Math.pow(1.12, 20)) < 1e-10);
        assert.ok(h.context.canvasZoom * h.context.getCanvasFitScale() > 8, 'zoom exceeds 800% of native scale');
        assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 20});
        assert.equal(h.frames.length, 1, 'a wheel burst queues one frame');
        h.flushFrames();
        h.wheel({closest: () => null}, 120);
        assert.ok(Math.abs(h.context.canvasZoom - 25 * Math.pow(1.12, 19)) < 1e-10,
            'zoom out applies one inverse step without snapping to a cap');
        h.flushFrames();
    }
});

test('wheel burst uses the latest pointer and post-render surface geometry for anchoring', () => {
    const h = harness();
    h.setSurfaceRect(10, 20);
    h.context.afterRender = rect => { rect.left = 35; rect.top = 55; };
    h.wheel({closest: () => null}, -120, 50, 80);
    h.wheel({closest: () => null}, -120, 200, 250);
    h.flushFrames();
    const scale = Math.pow(1.12, 2);
    assert.ok(Math.abs(h.workspace.scrollLeft - (35 + (200 - 10) * scale - 200)) < 1e-9);
    assert.ok(Math.abs(h.workspace.scrollTop - (55 + (250 - 20) * scale - 250)) < 1e-9);
});

test('stale wheel frames do not render after document, dimensions, or zoom changes', () => {
    const mutations = [
        h => { h.context.canvasLayers = [{id: 'replacement'}]; },
        h => { h.context.currentCanvasWidth += 1; },
        h => { h.context.canvasZoom += 1; },
    ];
    for (const mutate of mutations) {
        const h = harness();
        h.wheel({closest: () => null});
        mutate(h);
        h.flushFrames();
        assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
    }
});

test('nonfinite wheel multiplication preserves the prior finite zoom', () => {
    const h = harness();
    h.context.canvasZoom = Number.MAX_VALUE;
    h.wheel({closest: () => null});
    assert.equal(h.context.canvasZoom, Number.MAX_VALUE);
    assert.equal(h.frames.length, 0);
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
});

test('working canvas layers use the original at every display scale', () => {
    const context = vm.createContext({URL, CANVAS_DISPLAY_PREVIEW_MAX_SIDE: 4096,
        window: {location: {origin: 'http://localhost'}, devicePixelRatio: 1}});
    for (const name of ['getCanvasDisplayImageSrc', 'getCanvasLayerDisplaySrc']) {
        vm.runInContext(functionSource(name), context);
    }
    const layer = {src: '/canvas-imports/result.png', imageWidth: 5000, imageHeight: 16000,
        layerWidth: 5000, layerHeight: 16000};
    assert.equal(context.getCanvasDisplayImageSrc(layer.src, 5000, 16000), '/canvas-imports/result.png?preview=4096',
        'thumbnail callers can still request a bounded preview');
    assert.equal(context.getCanvasLayerDisplaySrc(layer, .1), layer.src);
    assert.equal(context.getCanvasLayerDisplaySrc(layer, 1), layer.src);
    assert.equal(context.getCanvasLayerDisplaySrc(layer), layer.src);
});

test('zoom-only surface refresh reuses layer nodes and keeps a loaded original after zooming back out', () => {
    const layer = {id: 7, type: 'image', visible: true, src: '/canvas-imports/large.png',
        imageWidth: 5000, imageHeight: 9000, layerWidth: 5000, layerHeight: 9000, x: 12, y: 34};
    let imageSrc = layer.src;
    let srcWrites = 0;
    const image = {
        getAttribute: name => name === 'src' ? imageSrc : null,
        setAttribute: (name, value) => { if (name === 'src') { imageSrc = value; srcWrites++; } },
    };
    let geometryLookups = 0;
    const node = {
        dataset: {layerId: '7'},
        style: {},
        querySelector: selector => selector === 'img' ? image : null,
        remove() { this.removed = true; },
    };
    const surface = {
        querySelectorAll: selector => selector === '.canvas-render-layer[data-layer-id]' ? [node] : [],
    };
    const context = vm.createContext({
        URL,
        CANVAS_DISPLAY_PREVIEW_MAX_SIDE: 4096,
        window: {location: {origin: 'http://localhost'}, devicePixelRatio: 1},
        canvasLayers: [layer],
        isSelectionOverlayHidden: false,
        isSelectionChecked: () => true,
        getCanvasDisplayScale: () => 0.1,
        normalizeImageLayerGeometry: () => {},
        document: {querySelector: () => { geometryLookups++; return null; }},
        el: () => ({querySelector: () => null}),
        updateCanvasHotMultiLayerOverlay() {},
        updateCanvasHotResizeControls() {},
        renderCanvasResizeHandles() {},
        renderCanvasResizeSpacingGuides() {},
        getClipOutputTarget: () => null,
        updateActiveImageResizeGuideOverlay() {},
        isImageResizeMode: false,
        isCanvasResizeMode: false,
        activeCanvasResizeDrag: null,
    });
    for (const name of [
        'forEachCanvasLayerDeep', 'getCanvasDisplayImageSrc', 'getCanvasLayerDisplaySrc',
        'setCanvasLayerNodePosition', 'updateCanvasLayerNodeGeometry',
        'updateCanvasLayerNodeImageForZoom', 'renderCanvasLayersOnSurfaceZoomOnly',
    ]) vm.runInContext(functionSource(name), context);

    assert.equal(context.renderCanvasLayersOnSurfaceZoomOnly(surface, 0.1), true);
    assert.equal(node.style.width, '500px');
    assert.equal(node.style.transform, 'translate3d(1.2000000000000002px, 3.4000000000000004px, 0)');
    assert.equal(geometryLookups, 0, 'geometry update uses the mapped existing node');
    assert.equal(imageSrc, layer.src, 'the full source is used at fit scale');
    assert.equal(srcWrites, 0);

    assert.equal(context.renderCanvasLayersOnSurfaceZoomOnly(surface, 1), true);
    assert.equal(imageSrc, layer.src, 'zooming in does not replace the source');
    assert.equal(srcWrites, 0);
    assert.equal(context.renderCanvasLayersOnSurfaceZoomOnly(surface, 0.1), true);
    assert.equal(imageSrc, layer.src, 'zooming out does not replace the source');
    assert.equal(srcWrites, 0);
    assert.equal(node.removed, undefined, 'the existing layer node stays attached');
});

test('retouch zoom-only rendering syncs the overlay and skips hidden base-layer traversal', () => {
    let syncCalls = 0, surfaceQueries = 0;
    const surface = {querySelectorAll() { surfaceQueries++; return []; }};
    const context = vm.createContext({
        CanvasRetouch: {isOpen: () => true, sync: options => { syncCalls++; assert.equal(options.baseZoomSkipped, true); }},
        canvasLayers: [{id: 7}],
        forEachCanvasLayerDeep() { throw new Error('hidden layers must not be traversed'); },
    });
    vm.runInContext(functionSource('renderCanvasLayersOnSurfaceZoomOnly'), context);
    assert.equal(context.renderCanvasLayersOnSurfaceZoomOnly(surface, .04), true);
    assert.equal(syncCalls, 1);
    assert.equal(surfaceQueries, 0);
});

test('canvas resize preserves finite zoom beyond the former upper limit', () => {
    const context = vm.createContext({
        activeCanvasResizeDrag: {displayScale: 100}, canvasZoom: 2,
        CANVAS_ZOOM_MIN: .15, getCanvasFitScale: () => .1,
    });
    vm.runInContext(functionSource('preserveCanvasResizeDisplayScale'), context);
    context.preserveCanvasResizeDisplayScale(5000, 16000);
    assert.equal(context.canvasZoom, 1000);
});

test('view-only autosave schedules one small view save and skips document serialization', () => {
    let histories = 0, projectSchedules = 0, autosaves = 0, views = 0;
    const context = vm.createContext({
        canvasViewSaveTimer: null,
        saveCanvasView: () => {views++; return true;},
        setTimeout: () => 1,
        recordCanvasEditHistory: () => { histories++; return true; },
        window: {CanvasProject: {schedule: () => { projectSchedules++; }}, addEventListener() {}},
        getCanvasAutosave: () => ({schedule: immediate => { autosaves++; return immediate; }}),
    });
    vm.runInContext(functionSource('saveCanvasState'), context);

    assert.equal(context.saveCanvasState({viewOnly: true}), true);
    assert.equal(context.canvasViewSaveTimer, 1);
    assert.equal(context.saveCanvasState({viewOnly: true, immediate: true}), true);
    assert.deepEqual({histories, projectSchedules, autosaves, views}, {histories: 0, projectSchedules: 0, autosaves: 0, views: 1});
});

test('geometry dragging blocks wheel zoom and empty canvases remain unchanged', () => {
    const h = harness();
    h.context.hasActiveCanvasGeometryDrag = () => true;
    h.wheel({closest: () => null});
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
    h.context.currentCanvasWidth = 0;
    h.wheel({closest: () => null});
    assert.equal(h.context.canvasZoom, 1);
    assert.deepEqual(h.counts(), {renders: 0, saves: 0, prevented: 1});
});
