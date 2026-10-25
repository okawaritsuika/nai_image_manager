const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(save = async () => '/canvas-imports/edited.png') {
    const layer = {id: 1, type: 'image', visible: true, src: '/original.png', layerWidth: 400, layerHeight: 200,
        promptInfo: {basePrompt: 'synthetic'}, x: 50, y: 30};
    const other = {...layer, id: 2, src: '/other.png'};
    const layers = new Map([[1, layer], [2, other]]);
    const snapshots = [], alerts = [];
    const ctx = vm.createContext({console, Math, Number, WeakSet,
        activeLayerId: 1, isLayerMoveMode: false, isImageResizeMode: false, isCanvasResizeMode: false,
        document: {addEventListener() {}}, window: {addEventListener() {}},
        findCanvasLayer: id => layers.has(id) ? {layer: layers.get(id)} : null,
        el: () => null, getCanvasDisplayScale: () => 0.25, saveClipDataUrlToServer: save, alert: message => alerts.push(message),
        clearClipMergedSourcePreviewCache() {}, renderLayerList() {}, renderCanvasLayersOnSurface() {},
        saveCanvasState: () => snapshots.push(JSON.parse(JSON.stringify([...layers.values()])))
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/canvas_eraser.js'), 'utf8'), ctx);
    const session = {layer, source: layer.src, canvas: {toDataURL: () => 'data:image/png;base64,synthetic'}};
    return {ctx, layer, other, layers, snapshots, alerts, session};
}

test('a stroke changes only its target, keeps original metadata and can undo after serialization', async () => {
    const h = setup();
    await h.ctx.commitCanvasLayerEraserStroke(h.session);
    assert.equal(h.layer.src, '/canvas-imports/edited.png');
    assert.equal(h.other.src, '/other.png');
    assert.equal(h.layer.eraserOriginalSrc, '/original.png');
    assert.equal(h.layer.promptInfo.basePrompt, 'synthetic');
    assert.deepEqual([h.layer.x, h.layer.y, h.layer.layerWidth, h.layer.layerHeight], [50, 30, 400, 200]);
    h.layers.set(1, h.snapshots[0][0]);
    h.ctx.undoCanvasLayerEraserStroke();
    assert.equal(h.layers.get(1).src, '/original.png');
});

function groupSession(h) {
    h.layer.type = 'clip'; h.layer.renderOnCanvas = true;
    h.other.type = 'clip'; h.other.renderOnCanvas = true; h.other.visible = false;
    const owner = {id: 3, type: 'selection', children: [h.layer, {type: 'folder', children: [h.other]},
        {id: 4, type: 'clip', src: '/source-clip.png', renderOnCanvas: false}]};
    h.layers.set(3, owner); h.ctx.activeLayerId = 3;
    return {owner, entries: [h.layer, h.other].map(layer => ({layer, source: layer.src,
        touched: true, canvas: h.session.canvas}))};
}

test('selection edits all nested results including hidden results, but excludes the source clip', async () => {
    let count = 0;
    const h = setup(async () => `/group-${++count}.png`);
    const session = groupSession(h);
    assert.deepEqual(Array.from(h.ctx.getCanvasEraserTargets(), layer => layer.id), [1, 2]);
    await h.ctx.commitCanvasLayerEraserStroke(session);
    assert.equal(h.layer.src, '/group-1.png');
    assert.equal(h.other.src, '/group-2.png');
    assert.equal(h.other.visible, false);
    assert.equal(h.snapshots.length, 1);
    h.layers.set(3, JSON.parse(JSON.stringify(session.owner)));
    h.ctx.undoCanvasLayerEraserStroke();
    assert.equal(h.layer.src, '/original.png');
    assert.equal(h.other.src, '/other.png');
    h.ctx.activeLayerId = 1;
    assert.deepEqual(Array.from(h.ctx.getCanvasEraserTargets(), layer => layer.id), [1]);
});

test('group saves are atomic on failure or replacement and group undo never overwrites a newer result', async () => {
    for (const scenario of ['failure', 'replacement', 'undo']) {
        let count = 0;
        const h = setup(async () => {
            count++;
            if (count === 2 && scenario === 'failure') throw new Error('offline');
            if (count === 2 && scenario === 'replacement') h.other.src = '/new-result.png';
            return `/group-${count}.png`;
        });
        const session = groupSession(h);
        await h.ctx.commitCanvasLayerEraserStroke(session);
        if (scenario === 'undo') {
            h.other.src = '/new-result.png';
            h.ctx.undoCanvasLayerEraserStroke();
            assert.equal(h.layer.src, '/group-1.png');
        } else assert.equal(h.layer.src, '/original.png');
        if (scenario !== 'failure') assert.equal(h.other.src, '/new-result.png');
    }
});

test('untouched results are not re-encoded and preview resampling retains the native editing canvas', async () => {
    const h = setup();
    const session = groupSession(h);
    session.entries[1].touched = false;
    await h.ctx.commitCanvasLayerEraserStroke(session);
    assert.equal(h.other.src, '/other.png');
    const draws = [], context = {clearRect() {}, drawImage(...args) { draws.push(args); }};
    const native = {width: 4096, height: 2048};
    h.ctx.refreshCanvasEraserPreview({canvas: native, preview: {width: 1024, height: 512, getContext: () => context}});
    assert.equal(context.imageSmoothingEnabled, true);
    assert.equal(context.imageSmoothingQuality, 'high');
    assert.deepEqual(draws, [[native, 0, 0, 1024, 512]]);
    assert.deepEqual(native, {width: 4096, height: 2048});
});

test('late saves cannot change a different selection, a replaced source or a deleted layer', async () => {
    for (const change of ['selection', 'source', 'delete', 'replace']) {
        let finish;
        const h = setup(() => new Promise(resolve => { finish = resolve; }));
        const request = h.ctx.commitCanvasLayerEraserStroke(h.session);
        if (change === 'selection') h.ctx.activeLayerId = 2;
        if (change === 'source') h.layer.src = '/new-inpaint.png';
        if (change === 'delete') h.layers.delete(1);
        if (change === 'replace') h.layers.set(1, {...h.layer});
        finish('/canvas-imports/edited.png'); await request;
        assert.equal(h.other.src, '/other.png');
        assert.equal(h.snapshots.length, change === 'selection' ? 1 : 0);
        if (change === 'source') assert.equal(h.layer.src, '/new-inpaint.png');
    }
});

test('failed saves leave pixels and undo history unchanged and duplicate commits are blocked', async () => {
    let reject, calls = 0;
    const h = setup(() => { calls++; return new Promise((_, fail) => { reject = fail; }); });
    const pending = h.ctx.commitCanvasLayerEraserStroke(h.session);
    await h.ctx.commitCanvasLayerEraserStroke(h.session);
    assert.equal(calls, 1);
    reject(new Error('offline')); await pending;
    assert.equal(h.layer.src, '/original.png');
    assert.equal(h.layer.eraserUndoSources, undefined);
    assert.equal(h.snapshots.length, 0);
    assert.equal(h.alerts.length, 1);
});

test('undo history is bounded and an unrelated inpaint result cannot be undone as an eraser stroke', async () => {
    let number = 0;
    const h = setup(async () => `/edit-${++number}.png`);
    for (let i = 0; i < 25; i++) {
        await h.ctx.commitCanvasLayerEraserStroke({...h.session, source: h.layer.src});
    }
    assert.equal(h.layer.eraserUndoSources.length, 20);
    assert.equal(h.layer.eraserOriginalSrc, '/original.png');
    h.layer.src = '/unrelated.png';
    h.ctx.undoCanvasLayerEraserStroke();
    assert.equal(h.layer.src, '/unrelated.png');
});

test('brush coordinates respect zoom, pan, layer position and nonuniform image scaling', () => {
    const h = setup();
    const session = {...h.session, node: {getBoundingClientRect: () => ({left: 120, top: 80, width: 100, height: 50})}};
    const point = h.ctx.canvasLayerEraserPoint({clientX: 145, clientY: 105}, session);
    assert.equal(point.x, 100); assert.equal(point.y, 100);
    const transforms = [];
    session.canvas.width = 1600; session.canvas.height = 1200;
    session.ctx = {save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
        arc() {}, setTransform(...args) { transforms.push(args); }};
    h.ctx.drawCanvasLayerEraserSegment(session, point, point, 64);
    assert.deepEqual(transforms, [[4, 0, 0, 6, 0, 0]]);
    assert.equal(session.ctx.globalCompositeOperation, 'destination-out');
});
