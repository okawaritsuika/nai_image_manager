const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_composite.js'), 'utf8');

function helperHarness() {
    const operations = [];
    const context2d = {
        save() { operations.push(['save']); },
        translate(...args) { operations.push(['translate', ...args]); },
        rotate(angle) { operations.push(['rotate', angle]); },
        drawImage(image, ...args) { operations.push(['drawImage', image.id, ...args]); },
        restore() { operations.push(['restore']); }
    };
    const context = {structuredClone, currentCanvasWidth: 100, currentCanvasHeight: 200,
        canvasLayers: [], document: {createElement: () => ({getContext: () => context2d})}};
    vm.createContext(context);
    vm.runInContext(source, context, {filename: 'canvas_composite.js'});
    return {context, operations, context2d};
}

test('rotated clips translate to their offset-adjusted center before rotation and drawing', () => {
    for (const rotation of [45, 90, -90]) {
        const h = helperHarness();
        const image = {id: 'clip'};
        const layer = {type: 'clip', x: 10, y: 20, layerWidth: 80, layerHeight: 40, rotation};

        h.context.drawCanvasLayerImage(h.context2d, image, layer, 3, 4);

        assert.deepEqual(h.operations, [
            ['save'],
            ['translate', 47, 36],
            ['rotate', rotation * Math.PI / 180],
            ['drawImage', 'clip', -40, -20, 80, 40],
            ['restore']
        ]);
    }
});

test('missing, zero, full-turn, or invalid clip rotations draw directly without transforms', () => {
    const h = helperHarness();
    const image = {id: 'clip'};
    const layers = [
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: 0},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: 360},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: -720},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: '45'},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: Infinity},
        {type: 'clip', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: NaN},
        {type: 'image', x: 5, y: 6, layerWidth: 7, layerHeight: 8, rotation: 90}
    ];

    for (const layer of layers) h.context.drawCanvasLayerImage(h.context2d, image, layer);

    assert.deepEqual(h.operations, layers.map(() => ['drawImage', 'clip', 5, 6, 7, 8]));
});

test('offsets apply to zero-position layers and existing dimension fallbacks', () => {
    const h = helperHarness();
    const image = {id: 'image', naturalWidth: 0, naturalHeight: 0, width: 13, height: 17};

    h.context.drawCanvasLayerImage(h.context2d, image,
        {type: 'image', x: 0, y: 0, layerWidth: 0, imageWidth: 21, layerHeight: 0, imageHeight: 22}, 5, 6);
    h.context.drawCanvasLayerImage(h.context2d, image,
        {type: 'image', x: 0, y: 0, layerWidth: 0, imageWidth: 0, layerHeight: 0, imageHeight: 0}, 5, 6);

    assert.deepEqual(h.operations, [
        ['drawImage', 'image', -5, -6, 21, 22],
        ['drawImage', 'image', -5, -6, 13, 17]
    ]);
});

test('merged rendering invokes the helper in layer order after applying output scaling', async () => {
    const events = [];
    const context2d = {
        scale(...args) { events.push(['scale', ...args]); },
        clearRect(...args) { events.push(['clearRect', ...args]); },
        fillRect(...args) { events.push(['fillRect', ...args]); }
    };
    const context = {structuredClone, canvasLayers: [], currentCanvasWidth: 100, currentCanvasHeight: 100,
        document: {createElement: type => {
            assert.equal(type, 'canvas');
            return {width: 0, height: 0, getContext: () => context2d,
                toDataURL: () => 'data:image/png;base64,synthetic'};
        }}};
    vm.createContext(context);
    vm.runInContext(source, context, {filename: 'canvas_composite.js'});
    context.drawCanvasLayerImage = (ctx, image, layer) => {
        assert.equal(ctx, context2d);
        events.push(['layer', image.src, layer.type]);
    };

    const state = {width: 200, height: 100, layers: [
        {type: 'clip', visible: true, renderOnCanvas: true, src: '/top.png'},
        {type: 'clip', visible: true, renderOnCanvas: true, src: '/bottom.png'}
    ]};
    const result = await context.renderMergedCanvasToDataUrl({state, maxDimension: 100,
        loadImage: async src => ({src, naturalWidth: 10, naturalHeight: 20})});

    assert.equal(result, 'data:image/png;base64,synthetic');
    assert.deepEqual(events, [
        ['scale', 0.5, 0.5],
        ['clearRect', 0, 0, 200, 100],
        ['layer', '/bottom.png', 'clip'],
        ['layer', '/top.png', 'clip']
    ]);
});
