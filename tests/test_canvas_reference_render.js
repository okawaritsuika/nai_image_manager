const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static/canvas_composite.js'), 'utf8').replace(/\r\n/g, '\n');

function harness(layers = [], {includeCanvasGlobals = true} = {}) {
    const drawn = [], operations = [], canvases = [];
    let exports = 0;
    const context = {structuredClone, canvasLayers: layers,
        document: {createElement(type) {
            assert.equal(type, 'canvas');
            const canvas = {getContext: () => ({scale: (...args) => operations.push(['scale', ...args]),
                clearRect() {}, fillRect: (...args) => operations.push(['background', ...args]),
                drawImage: (image, ...args) => drawn.push([image.src, ...args])}),
                toDataURL: () => { exports += 1; return 'data:image/png;base64,synthetic'; }};
            canvases.push(canvas);
            return canvas;
        }}};
    if (includeCanvasGlobals) {
        context.currentCanvasWidth = 100;
        context.currentCanvasHeight = 200;
    }
    vm.createContext(context);
    vm.runInContext(source, context);
    context.loadImageElementForClip = async src => ({src, naturalWidth: 40, naturalHeight: 80});
    return {context, drawn, operations, canvases, get exports() { return exports; }};
}

test('saved opposite canvas uses its own geometry without changing either canvas', async () => {
    const live = [{id: 9, type: 'image', visible: true, src: '/live.png'}];
    const state = {width: 400, height: 1200, layers: [
        {type: 'image', src: '/reference.png', visible: true, imageWidth: 200, imageHeight: 600},
        {type: 'canvas', visible: true}]};
    const before = structuredClone(state), liveBefore = structuredClone(live);
    const h = harness(live, {includeCanvasGlobals: false});
    await h.context.renderMergedCanvasToDataUrl({state, maxDimension: 600});
    assert.deepEqual(h.drawn, [['/reference.png', 100, 300, 200, 600]]);
    assert.deepEqual(h.operations, [['scale', 0.5, 0.5], ['background', 0, 0, 400, 1200]]);
    assert.equal(h.canvases[0].width, 200);
    assert.equal(h.canvases[0].height, 600);
    assert.deepEqual(state, before);
    assert.deepEqual(live, liveBefore);
    assert.equal(Object.hasOwn(h.context, 'currentCanvasWidth'), false);
});

test('reference compositing preserves visible order, excludes pins and non-rendered clips', async () => {
    const layer = (src, extra = {}) => ({type: 'image', visible: true, src, x: 0, y: 0,
        layerWidth: 40, layerHeight: 80, ...extra});
    const h = harness();
    const state = {width: 100, height: 200, layers: [
        {type: 'folder', visible: false, children: [layer('/hidden.png')]},
        layer('/pin.png', {pinnedReference: true}),
        {type: 'selection', visible: true, children: [
            layer('/edit.png', {type: 'clip', renderOnCanvas: true}),
            layer('/source-clip.png', {type: 'clip'})]},
        layer('/base.png')]};
    await h.context.renderMergedCanvasToDataUrl({state});
    assert.deepEqual(h.drawn.map(item => item[0]), ['/base.png', '/edit.png']);
});

test('existing export without state retains full size and live layer behavior', async () => {
    const h = harness([{type: 'image', visible: true, src: '/live.png', imageWidth: 40, imageHeight: 80}]);
    await h.context.renderMergedCanvasToDataUrl();
    assert.equal(h.canvases[0].width, 100);
    assert.equal(h.canvases[0].height, 200);
    assert.deepEqual(h.drawn, [['/live.png', 30, 60, 40, 80]]);
});

test('invalid saved dimensions and unreadable image fail without exporting a partial preview', async () => {
    const h = harness();
    for (const width of [0, -1, 'bad', Infinity]) {
        await assert.rejects(h.context.renderMergedCanvasToDataUrl({state: {width, height: 100}}));
    }
    h.context.loadImageElementForClip = async () => { throw new Error('missing image'); };
    await assert.rejects(h.context.renderMergedCanvasToDataUrl({state: {width: 100, height: 200,
        layers: [{type: 'image', visible: true, src: '/missing.png'}]}}), /missing image/);
    assert.equal(h.exports, 0);
});

test('optional image loader receives the source and cloned layer', async () => {
    const h = harness();
    const state = {width: 100, height: 200, layers: [
        {type: 'image', visible: true, src: '/custom.png', x: 3, y: 4, layerWidth: 20, layerHeight: 30}
    ]};
    const calls = [];
    await h.context.renderMergedCanvasToDataUrl({state, loadImage: async (src, layer) => {
        calls.push({src, layer});
        return {src, naturalWidth: 20, naturalHeight: 30};
    }});

    assert.equal(calls.length, 1);
    assert.equal(calls[0].src, '/custom.png');
    assert.equal(calls[0].layer.src, '/custom.png');
    assert.equal(calls[0].layer.type, 'image');
    assert.deepEqual(h.drawn, [['/custom.png', 3, 4, 20, 30]]);
});

test('abort before rendering or after a load prevents later loads and export', async () => {
    const beforeStart = harness();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(beforeStart.context.renderMergedCanvasToDataUrl({
        state: {width: 100, height: 200, layers: []}, signal: alreadyAborted.signal
    }), {name: 'AbortError'});
    assert.equal(beforeStart.canvases.length, 0);
    assert.equal(beforeStart.exports, 0);

    const h = harness();
    const controller = new AbortController();
    const loaded = [];
    await assert.rejects(h.context.renderMergedCanvasToDataUrl({
        state: {width: 100, height: 200, layers: [
            {type: 'image', visible: true, src: '/first.png', x: 0, y: 0, layerWidth: 20, layerHeight: 20},
            {type: 'image', visible: true, src: '/second.png', x: 0, y: 0, layerWidth: 20, layerHeight: 20}
        ]},
        signal: controller.signal,
        loadImage: async src => {
            loaded.push(src);
            controller.abort();
            return {src, naturalWidth: 20, naturalHeight: 20};
        }
    }), {name: 'AbortError'});
    assert.deepEqual(loaded, ['/second.png']);
    assert.equal(h.exports, 0);
});

test('maxDimension bounds large canvases and never enlarges small canvases', async () => {
    const square = harness();
    await square.context.renderMergedCanvasToDataUrl({
        state: {width: 16000, height: 16000, layers: []}, maxDimension: 768
    });
    assert.equal(square.canvases[0].width, 768);
    assert.equal(square.canvases[0].height, 768);

    const wide = harness();
    await wide.context.renderMergedCanvasToDataUrl({
        state: {width: 32000, height: 3, layers: []}, maxDimension: 768
    });
    assert.equal(wide.canvases[0].width, 768);
    assert.equal(wide.canvases[0].height, 1);

    const small = harness();
    await small.context.renderMergedCanvasToDataUrl({
        state: {width: 100, height: 200, layers: []}, maxDimension: 768
    });
    assert.equal(small.canvases[0].width, 100);
    assert.equal(small.canvases[0].height, 200);
    assert.deepEqual(small.operations, [['scale', 1, 1]]);
});
