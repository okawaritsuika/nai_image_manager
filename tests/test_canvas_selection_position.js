const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {afterEach, test} = require('node:test');

const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const CanvasInpaintReference = require(path.join(__dirname, '..', 'static', 'canvas_inpaint_reference.js'));
const CanvasSelectionRotation = require(path.join(__dirname, '..', 'static', 'canvas_selection_rotation.js'));

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

function makeRect(left, top, width, height) {
    return {left, top, width, height, right: left + width, bottom: top + height};
}

function makeContext({
    canvasWidth = 4000,
    canvasHeight = 3000,
    surfaceRect = null,
    displayWidth = canvasWidth,
    workspaceRect = makeRect(0, 0, 1280, 720),
    clientLeft = 0,
    clientTop = 0,
    clientWidth = workspaceRect.width,
    clientHeight = workspaceRect.height,
    windowWidth = 1280,
    windowHeight = 720,
    hasSurface = true,
    hasWorkspace = true
} = {}) {
    const canvasLayers = [];
    const calls = {renderLayerList: 0, renderCanvasLayersOnSurface: 0, saveCanvasState: 0};
    const workspace = {
        clientLeft,
        clientTop,
        clientWidth,
        clientHeight,
        getBoundingClientRect: () => workspaceRect
    };
    const surface = hasSurface ? {
        clientWidth: displayWidth,
        style: {},
        getBoundingClientRect: () => surfaceRect || makeRect(0, 0, displayWidth, canvasHeight),
        closest(selector) {
            assert.equal(selector, '.canvas-workspace');
            return hasWorkspace ? workspace : null;
        }
    } : null;
    const context = {
        SELECTION_MIN_SIZE: 64,
        SELECTION_SIZE_STEP: 64,
        CanvasInpaintReference,
        CanvasSelectionRotation,
        currentCanvasWidth: canvasWidth,
        currentCanvasHeight: canvasHeight,
        layerIdSeq: 17,
        canvasLayers,
        activeLayerId: null,
        checkedSelectionId: null,
        activeClipSelectionId: null,
        window: {innerWidth: windowWidth, innerHeight: windowHeight},
        el(id) { return id === 'canvasSurface' ? surface : null; },
        countCanvasLayersByType(type) { return canvasLayers.filter((layer) => layer.type === type).length; },
        openCanvasDialog() {},
        renderLayerList() { calls.renderLayerList += 1; },
        renderCanvasLayersOnSurface() { calls.renderCanvasLayersOnSurface += 1; },
        saveCanvasState() { calls.saveCanvasState += 1; }
    };
    vm.createContext(context);
    vm.runInContext([
        extractFunction(canvasSource, 'getCanvasDisplayScale'),
        extractFunction(canvasSource, 'getCanvasPointerPosition'),
        extractFunction(canvasSource, 'getSelectionAreaCreationCenter'),
        extractFunction(canvasSource, 'snapToSelectionStep'),
        extractFunction(canvasSource, 'isSelectionRequestSizeAllowed'),
        extractFunction(canvasSource, 'addSelectionArea')
    ].join('\n'), context);
    return {context, calls, surface, workspace};
}

function assertCenter(actual, expected) {
    assert.ok(Math.abs(actual.x - expected.x) <= 0.5, `expected x ${expected.x}, got ${actual.x}`);
    assert.ok(Math.abs(actual.y - expected.y) <= 0.5, `expected y ${expected.y}, got ${actual.y}`);
}

test('selection creation center follows the visible viewport across zoom and two-axis scroll', () => {
    const workspaceRect = makeRect(20, 30, 800, 620);
    const cases = [
        {scale: 0.5, left: -240, top: -140},
        {scale: 2, left: -800, top: -300},
        {scale: 3, left: -2000, top: -800}
    ];

    for (const {scale, left, top} of cases) {
        const {context} = makeContext({
            surfaceRect: makeRect(left, top, 4000 * scale, 3000 * scale),
            displayWidth: 4000 * scale,
            workspaceRect,
            clientLeft: 10,
            clientTop: 8,
            clientWidth: 770,
            clientHeight: 590
        });
        const expected = {
            x: (415 - left) / scale,
            y: (333 - top) / scale
        };

        assertCenter(context.getSelectionAreaCreationCenter(), expected);
    }
});

test('fully visible image uses its own center', () => {
    const {context} = makeContext({
        canvasWidth: 400,
        canvasHeight: 200,
        surfaceRect: makeRect(220, 140, 400, 200),
        displayWidth: 400,
        workspaceRect: makeRect(0, 0, 900, 800),
        clientWidth: 900,
        clientHeight: 800
    });

    assertCenter(context.getSelectionAreaCreationCenter(), {x: 200, y: 100});
});

test('short browser viewport clips the workspace before finding its visible center', () => {
    const {context} = makeContext({
        canvasWidth: 1000,
        canvasHeight: 1000,
        surfaceRect: makeRect(0, 0, 1000, 1000),
        displayWidth: 1000,
        workspaceRect: makeRect(0, 30, 1000, 1000),
        clientWidth: 980,
        clientHeight: 940,
        windowWidth: 1000,
        windowHeight: 300
    });

    assertCenter(context.getSelectionAreaCreationCenter(), {x: 490, y: 165});
});

test('workspace borders and scrollbars are excluded from the visible area', () => {
    const {context} = makeContext({
        canvasWidth: 720,
        canvasHeight: 620,
        surfaceRect: makeRect(80, 80, 720, 620),
        displayWidth: 720,
        workspaceRect: makeRect(100, 100, 600, 500),
        clientLeft: 10,
        clientTop: 20,
        clientWidth: 550,
        clientHeight: 400,
        windowWidth: 1000,
        windowHeight: 800
    });

    assertCenter(context.getSelectionAreaCreationCenter(), {x: 305, y: 240});
});

test('missing, empty, or fully clipped canvas surfaces fall back to the image center', () => {
    const fallback = {x: 2000, y: 1500};
    const missingSurface = makeContext({hasSurface: false});
    assertCenter(missingSurface.context.getSelectionAreaCreationCenter(), fallback);

    const missingWorkspace = makeContext({hasWorkspace: false});
    assertCenter(missingWorkspace.context.getSelectionAreaCreationCenter(), fallback);

    const emptyRect = makeContext({surfaceRect: makeRect(0, 0, 0, 0)});
    assertCenter(emptyRect.context.getSelectionAreaCreationCenter(), fallback);

    const clipped = makeContext({
        surfaceRect: makeRect(1300, 800, 400, 300),
        displayWidth: 4000,
        windowWidth: 1280,
        windowHeight: 720
    });
    assertCenter(clipped.context.getSelectionAreaCreationCenter(), fallback);
});

test('new selection keeps its size and save/render lifecycle while using the visible center', () => {
    const workspaceRect = makeRect(20, 30, 800, 620);
    const surfaceRect = makeRect(-800, -300, 8192, 4096);
    const {context, calls} = makeContext({
        canvasWidth: 4096,
        canvasHeight: 2048,
        surfaceRect,
        displayWidth: 8192,
        workspaceRect,
        clientLeft: 10,
        clientTop: 8,
        clientWidth: 770,
        clientHeight: 590
    });
    const expectedCenter = context.getSelectionAreaCreationCenter();

    context.addSelectionArea();

    assert.equal(context.canvasLayers.length, 1);
    const [selection] = context.canvasLayers;
    assert.equal(selection.type, 'selection');
    assert.equal(selection.id, 17);
    assert.equal(selection.layerWidth, 2048);
    assert.equal(selection.layerHeight, 448);
    assert.equal(selection.layerWidth % 64, 0);
    assert.equal(selection.layerHeight % 64, 0);
    assert.equal(context.isSelectionRequestSizeAllowed(selection), true);
    assertCenter(
        {x: selection.x + selection.layerWidth / 2, y: selection.y + selection.layerHeight / 2},
        expectedCenter
    );
    assert.equal(context.activeLayerId, selection.id);
    assert.equal(context.checkedSelectionId, selection.id);
    assert.equal(context.activeClipSelectionId, selection.id);
    assert.deepEqual(calls, {renderLayerList: 1, renderCanvasLayersOnSurface: 1, saveCanvasState: 1});
    assert.deepEqual(surfaceRect, makeRect(-800, -300, 8192, 4096));
});
