const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');
const CanvasSelectionRotation = require('../static/canvas_selection_rotation.js');
const source = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');
function extract(name) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\nfunction ', start + 1);
    return source.slice(start, end < 0 ? undefined : end).trim();
}

function sourceContext(layers) {
    const context = {CanvasSelectionRotation, canvasLayers: layers, currentCanvasWidth: 512,
        currentCanvasHeight: 512, normalizeImageLayerGeometry() {}};
    vm.createContext(context);
    for (const name of ['rectsIntersect', 'collectPromptSourceLayersFromSelection',
        'collectAutoMaskSourceCandidateLayers', 'collectAutoMaskSourceLayersForSelection',
        'getAutoMaskSourceLayerRect', 'autoMaskSourceLayerContainsCanvasPoint',
        'findAutoMaskSourceLayerAtMaskPoint', 'applyAutoMaskAboveSourceLayer']) {
        vm.runInContext(extract(name), context);
    }
    return context;
}

test('rotated selection picks prompts only from visibly overlapping source images', () => {
    const image = (id, x, y) => ({id, type: 'image', visible: true, src: 'synthetic',
        x, y, layerWidth: 16, layerHeight: 16});
    const c = sourceContext([image(1, 120, -40), image(2, 0, 40)]);
    const selection = {x: 0, y: 0, layerWidth: 256, layerHeight: 128, rotation: 90};
    assert.deepEqual(Array.from(c.collectPromptSourceLayersFromSelection(selection), x => x.id), [1]);
});

test('auto-mask finds rotated result corners and excludes empty parts of the old box', () => {
    const base = {id: 1, type: 'canvas', visible: true, canvasWidth: 512, canvasHeight: 512};
    const rotated = {id: 2, type: 'clip', visible: true, renderOnCanvas: true, src: 'synthetic',
        x: 100, y: 100, layerWidth: 256, layerHeight: 128, rotation: 90};
    const c = sourceContext([rotated, base]);
    const selection = {x: 0, y: 0, layerWidth: 512, layerHeight: 512};
    assert.equal(c.findAutoMaskSourceLayerAtMaskPoint(selection, selection, {x: 228, y: 70}, {width: 512, height: 512}).id, 2);
    assert.equal(c.findAutoMaskSourceLayerAtMaskPoint(selection, selection, {x: 110, y: 164}, {width: 512, height: 512}).id, 1);
    const corner = {x: 220, y: 60, layerWidth: 16, layerHeight: 16};
    assert.deepEqual(Array.from(c.collectAutoMaskSourceLayersForSelection(corner), x => x.id), [1, 2]);
});

test('auto-mask subtracts the rotated source polygon in rotated preview coordinates', () => {
    const base = {id: 1, type: 'canvas', visible: true, canvasWidth: 512, canvasHeight: 512};
    const layer = {id: 2, type: 'clip', visible: true, renderOnCanvas: true, src: 'synthetic',
        x: 100, y: 100, layerWidth: 256, layerHeight: 128, rotation: 90};
    const c = sourceContext([layer, base]);
    const selection = {x: 0, y: 0, layerWidth: 512, layerHeight: 512, rotation: 90};
    const points = [];
    const ctx = {save() {}, restore() {}, clearRect() {}, fillRect() {}, beginPath() {}, closePath() {}, fill() {},
        moveTo(x,y) {points.push([x,y]);}, lineTo(x,y) {points.push([x,y]);}};
    assert.equal(c.applyAutoMaskAboveSourceLayer(selection, selection, base, {width: 256, height: 256, getContext: () => ctx}), true);
    const expected = [[18,110],[146,110],[146,174],[18,174]];
    assert.equal(points.length, 4);
    points.forEach((p,i) => p.forEach((v,j) => assert.ok(Math.abs(v-expected[i][j]) < 1e-8)));
});
function rotationContext() {
    const layer = {id: 1, type: 'selection', visible: true, x: 0, y: 0, layerWidth: 256, layerHeight: 128};
    const context = {CanvasSelectionRotation, SELECTION_SIZE_STEP: 64, layer, selectedLayerIds: new Set(),
        activeSelectionDrag: null, activeLayerId: 1, checkedSelectionId: 1, activeClipSelectionId: 1,
        findCanvasLayer: () => ({layer}), selectionRequiresLayerMoveMode: () => false,
        getEditableClipForSelection: () => null,
        normalizeSelectionAreaGeometry() {}, hideSelectionSizeTooltip() {}, renderLayerList() {},
        syncCanvasSurfaceSelectionState() {}, updateCanvasHotLayerGeometry() {},
        getCanvasPointerPosition: e => ({x: e.clientX, y: e.clientY, displayScale: 1, surfaceLeft: 0, surfaceTop: 0}),
        getCanvasPointerPositionForDrag: e => ({x: e.clientX, y: e.clientY, displayScale: 1})};
    vm.createContext(context);
    vm.runInContext(extract('isSelectionRequestSizeAllowed') + '\n' + extract('startSelectionRotateDrag') + '\n' + extract('handleSelectionMouseMove'), context);
    return context;
}
function event(x, y, button = 0) {
    return {clientX: x, clientY: y, button, preventDefault() {}, stopPropagation() {}};
}

test('rotation does not increase the request pixel budget including reference width', () => {
    const c = rotationContext();
    const selection = {layerWidth: 1024, layerHeight: 2048, rotation: 45};
    assert.equal(c.isSelectionRequestSizeAllowed(selection), true);
    c.CanvasInpaintReference = {snapshot: () => ({include: true, reference: {width: 320}})};
    assert.equal(c.isSelectionRequestSizeAllowed(selection), true);
    assert.equal(c.isSelectionRequestSizeAllowed({...selection, layerWidth: 1536}), false);
});
test('central drag ignores the singular center then rotates about the fixed center', () => {
    const c = rotationContext();
    c.startSelectionRotateDrag(event(128, 64), 1);
    c.handleSelectionMouseMove(event(128, 64));
    assert.equal(c.layer.rotation, undefined);
    c.handleSelectionMouseMove(event(148, 64));
    c.handleSelectionMouseMove(event(128, 84));
    assert.equal(c.layer.rotation, 90);
    assert.equal(c.layer.x, 0);
    assert.equal(c.layer.y, 0);
    assert.equal(c.layer.layerWidth, 256);
});
test('rotation obeys existing result movement lock and ignores secondary clicks', () => {
    const c = rotationContext();
    c.startSelectionRotateDrag(event(148, 64, 2), 1);
    assert.equal(c.activeSelectionDrag, null);
    c.selectionRequiresLayerMoveMode = () => true;
    c.isLayerMoveMode = false;
    c.startSelectionRotateDrag(event(148, 64), 1);
    assert.equal(c.activeSelectionDrag, null);
});

test('rotation drag sticks at quarter turns then releases beyond five degrees', () => {
    const c = rotationContext();
    c.startSelectionRotateDrag(event(228, 64), 1);
    for (const [degrees, expected] of [[84, 84], [85, 90], [94, 90], [96, 96], [179, -180], [269, -90], [359, 0]]) {
        const radians = degrees * Math.PI / 180;
        c.handleSelectionMouseMove(event(128 + 100 * Math.cos(radians), 64 + 100 * Math.sin(radians)));
        assert.ok(Math.abs(c.layer.rotation - expected) < 1e-9);
    }
});

test('selection with an editable clip cannot start rotation', () => {
    const c = rotationContext();
    c.getEditableClipForSelection = () => ({id: 2, type: 'clip'});
    c.startSelectionRotateDrag(event(228, 64), 1);
    assert.equal(c.activeSelectionDrag, null);
});
test('rotated crop unrotates into the original pixel dimensions', async () => {
    const calls = [];
    const ctx = Object.fromEntries(['clearRect', 'translate', 'rotate', 'drawImage']
        .map(name => [name, (...args) => calls.push([name, ...args])]));
    const offscreen = {getContext: () => ctx, toDataURL: () => 'synthetic'};
    const selection = {x: 0, y: 0, layerWidth: 256, layerHeight: 128, rotation: 90};
    // Stop at the existing save boundary: no disk, server, or prompt data is needed.
    const stop = new Error('save boundary');
    const c = {CanvasSelectionRotation, document: {createElement: () => offscreen}, canvasLayers: [],
        normalizeSelectionAreaGeometry() {}, hasVisibleCanvasBaseLayer: () => false,
        collectDrawableImageLayersForClip: () => [{x: 0, y: 0, layerWidth: 512, layerHeight: 512, src: 'synthetic'}],
        normalizeImageLayerGeometry() {}, rectsIntersect: () => true,
        drawCanvasLayerImage: (ctx, img, layer, x, y) => ctx.drawImage(img, layer.x-x, layer.y-y, layer.layerWidth, layer.layerHeight),
        loadImageElementForClip: async () => 'image', saveClipDataUrlToServer: async () => {throw stop;}};
    vm.createContext(c);
    vm.runInContext('async ' + extract('createClipFromSelection'), c);
    await assert.rejects(c.createClipFromSelection(selection), error => error === stop);
    assert.equal(offscreen.width, 256);
    assert.equal(offscreen.height, 128);
    assert.deepEqual(calls.slice(1, 4), [['translate', 128, 64], ['rotate', -Math.PI / 2], ['translate', -128, -64]]);
    assert.deepEqual(calls.find(call => call[0] === 'drawImage'), ['drawImage', 'image', 0, 0, 512, 512]);
});
