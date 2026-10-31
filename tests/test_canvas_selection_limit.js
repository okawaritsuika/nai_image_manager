const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {afterEach, test} = require('node:test');

const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const CanvasInpaintReference = require(path.join(__dirname, '..', 'static', 'canvas_inpaint_reference.js'));
const CanvasSelectionRotation = require(path.join(__dirname, '..', 'static', 'canvas_selection_rotation.js'));
const REQUEST_AREA_LIMIT = 3145728;

afterEach(() => {
    CanvasInpaintReference.restore({reference: null, showArea: false, include: false});
});

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `expected ${name} in its source file`);
    let index = source.indexOf('(', start);
    let parentheses = 0;
    for (; index < source.length; index += 1) {
        if (source[index] === '(') parentheses += 1;
        if (source[index] === ')') parentheses -= 1;
        if (parentheses === 0) break;
    }
    const brace = source.indexOf('{', index + 1);
    let depth = 0;
    for (let index = brace; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    assert.fail(`expected closing brace for ${name}`);
}

function restoreReference(width = 320, include = true) {
    CanvasInpaintReference.restore({
        reference: {
            src: '/canvas-imports/synthetic.png',
            name: 'Synthetic reference',
            width,
            x: 0.5,
            y: 0.5,
            zoom: 1
        },
        showArea: include,
        include
    });
}

function makeLimitContext(referenceApi = CanvasInpaintReference) {
    const context = {
        SELECTION_SIZE_STEP: 64,
        CanvasSelectionRotation,
        CanvasInpaintReference: referenceApi
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(canvasSource, 'isSelectionRequestSizeAllowed'), context);
    return context;
}

function makeResizeContext() {
    const context = {
        SELECTION_MIN_SIZE: 64,
        SELECTION_SIZE_STEP: 64,
        CanvasSelectionRotation,
        CanvasInpaintReference,
        activeSelectionDrag: null,
        currentCanvasWidth: 10000,
        currentCanvasHeight: 10000,
        getCanvasPointerPositionForDrag(event) { return event.pointer; },
        resolveSelectionFarEdgeStick({farEdge, stuckState}) {
            return {value: farEdge, stuckState};
        },
        updateSelectionSizeTooltip() {},
        updateCanvasHotLayerGeometry() {}
    };
    vm.createContext(context);
    vm.runInContext([
        extractFunction(canvasSource, 'snapToSelectionStep'),
        extractFunction(canvasSource, 'isSelectionRequestSizeAllowed'),
        extractFunction(canvasSource, 'handleSelectionResize')
    ].join('\n'), context);
    return context;
}

function makeCreationContext() {
    const context = {
        SELECTION_MIN_SIZE: 64,
        SELECTION_SIZE_STEP: 64,
        CanvasSelectionRotation,
        CanvasInpaintReference,
        currentCanvasWidth: 8192,
        currentCanvasHeight: 8192,
        layerIdSeq: 1,
        canvasLayers: [],
        activeLayerId: null,
        checkedSelectionId: null,
        activeClipSelectionId: null,
        el() { return null; },
        countCanvasLayersByType() { return 0; },
        openCanvasDialog() {},
        renderLayerList() {},
        renderCanvasLayersOnSurface() {},
        saveCanvasState() {}
    };
    vm.createContext(context);
    vm.runInContext([
        extractFunction(canvasSource, 'snapToSelectionStep'),
        extractFunction(canvasSource, 'isSelectionRequestSizeAllowed'),
        extractFunction(canvasSource, 'getSelectionAreaCreationCenter'),
        extractFunction(canvasSource, 'addSelectionArea')
    ].join('\n'), context);
    return context;
}

function makeSelection(width, height) {
    return {id: 1, type: 'selection', x: 10, y: 20, layerWidth: width, layerHeight: height, rotation: 0};
}

function makeResizeDrag(layer, {handle = 'br', rotation = 0} = {}) {
    return {
        handle,
        rotation,
        startX: layer.x,
        startY: layer.y,
        startWidth: layer.layerWidth,
        startHeight: layer.layerHeight,
        startPointerX: 0,
        startPointerY: 0,
        anchorRight: layer.x + layer.layerWidth,
        anchorBottom: layer.y + layer.layerHeight,
        stuckX: false,
        stuckY: false
    };
}

test('selection request limit accepts exactly 2048 × 1536 and rejects the next 64px width step', () => {
    const context = makeLimitContext();

    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 2048, layerHeight: 1536}), true);
    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 2112, layerHeight: 1536}), false);
    assert.equal(2048 * 1536, REQUEST_AREA_LIMIT);
});

test('selection request limit accepts a long 49152 × 64 crop', () => {
    const context = makeLimitContext();

    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 49152, layerHeight: 64}), true);
});

test('included 320px reference width is counted at the exact request area boundary', () => {
    restoreReference(320, true);
    const context = makeLimitContext();

    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 1728, layerHeight: 1536}), true);
    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 1792, layerHeight: 1536}), false);
});

test('included reference without an image uses the 320px default width', () => {
    CanvasInpaintReference.restore({reference: null, showArea: false, include: true});
    const context = makeLimitContext();

    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 1728, layerHeight: 1536}), true);
    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 1792, layerHeight: 1536}), false);
});

test('disabled reference does not add its width to the request area', () => {
    restoreReference(1024, false);
    const context = makeLimitContext();

    assert.equal(context.isSelectionRequestSizeAllowed({layerWidth: 2048, layerHeight: 1536}), true);
});

test('rotated 45-degree square budgets the unrotated request dimensions', () => {
    const context = makeLimitContext();
    const selection = {x: 0, y: 0, layerWidth: 1536, layerHeight: 1536, rotation: 45};
    const bounds = CanvasSelectionRotation.bounds(selection);

    assert.ok(bounds.width > selection.layerWidth);
    assert.ok(bounds.height > selection.layerHeight);
    assert.equal(context.isSelectionRequestSizeAllowed(selection), true);
    assert.equal(context.isSelectionRequestSizeAllowed({...selection, layerWidth: 2112}), false);
});

test('90-degree rotation preserves request dimensions when budgeting included reference width', () => {
    restoreReference(320, true);
    const context = makeLimitContext();
    const selection = {x: 0, y: 0, layerWidth: 2048, layerHeight: 1280, rotation: 0};

    assert.equal(context.isSelectionRequestSizeAllowed(selection), true);
    selection.rotation = 90;
    assert.equal(context.isSelectionRequestSizeAllowed(selection), true);
    assert.equal(context.isSelectionRequestSizeAllowed({...selection, layerHeight: 1344}), false);
});

test('new selection on a large canvas is reduced to a requestable 64px-grid size', () => {
    restoreReference(320, true);
    const context = makeCreationContext();

    context.addSelectionArea();

    assert.equal(context.canvasLayers.length, 1);
    const [selection] = context.canvasLayers;
    assert.equal(selection.type, 'selection');
    assert.equal(selection.layerWidth % 64, 0);
    assert.equal(selection.layerHeight % 64, 0);
    assert.equal(context.isSelectionRequestSizeAllowed(selection), true);
    assert.ok(selection.layerWidth < 4096 || selection.layerHeight < 1792);
});

test('bottom-right resize rejects an over-limit candidate without changing current geometry', () => {
    const context = makeResizeContext();
    const layer = makeSelection(2048, 1536);
    context.activeSelectionDrag = makeResizeDrag(layer);

    context.handleSelectionResize({clientX: 64, clientY: 0, pointer: {x: 64, y: 0, displayScale: 1}}, layer);

    assert.deepEqual(
        {x: layer.x, y: layer.y, width: layer.layerWidth, height: layer.layerHeight},
        {x: 10, y: 20, width: 2048, height: 1536}
    );
});

test('bottom-right resize allows a shrink and an enlargement that reaches the limit exactly', () => {
    const shrinkingContext = makeResizeContext();
    const shrinkingLayer = makeSelection(2048, 1536);
    shrinkingContext.activeSelectionDrag = makeResizeDrag(shrinkingLayer);

    shrinkingContext.handleSelectionResize({clientX: -64, clientY: -64, pointer: {x: -64, y: -64, displayScale: 1}}, shrinkingLayer);

    assert.deepEqual(
        {width: shrinkingLayer.layerWidth, height: shrinkingLayer.layerHeight},
        {width: 1984, height: 1472}
    );

    const enlargingContext = makeResizeContext();
    const enlargingLayer = makeSelection(1984, 1472);
    enlargingContext.activeSelectionDrag = makeResizeDrag(enlargingLayer);

    enlargingContext.handleSelectionResize({clientX: 64, clientY: 64, pointer: {x: 64, y: 64, displayScale: 1}}, enlargingLayer);

    assert.deepEqual(
        {width: enlargingLayer.layerWidth, height: enlargingLayer.layerHeight},
        {width: 2048, height: 1536}
    );
});
