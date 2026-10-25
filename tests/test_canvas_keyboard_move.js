const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const CanvasKeyboardMove = require('../static/canvas_keyboard_move');

const canvasSource = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');
const compositeSource = fs.readFileSync(require.resolve('../static/canvas_composite.js'), 'utf8');
const keyboardMoveSource = fs.readFileSync(require.resolve('../static/canvas_keyboard_move.js'), 'utf8');

function extractFunction(source, name) {
    const start = Math.max(source.indexOf(`function ${name}(`), source.indexOf(`async function ${name}(`));
    assert.notEqual(start, -1, `expected ${name} in its source file`);
    const end = source.indexOf('\n}', source.indexOf('{', start));
    assert.notEqual(end, -1, `expected closing brace for ${name}`);
    const asyncStart = source.lastIndexOf('async ', start);
    return source.slice(asyncStart >= 0 && asyncStart + 6 === start ? asyncStart : start, end + 2);
}

class FakeElement {
    constructor(value = '') {
        this.value = value;
        this.handlers = {};
        this.hidden = false;
        this.attributes = {};
    }

    addEventListener(type, callback) {
        (this.handlers[type] ||= []).push(callback);
    }

    dispatch(type) {
        (this.handlers[type] || []).forEach((callback) => callback({target: this}));
    }

    setAttribute(name, value) {
        this.attributes[name] = value;
    }
}

class FakeDocument {
    constructor() {
        this.handlers = {};
        this.controls = new Map([
            ['canvasKeyboardMoveControls', new FakeElement()],
            ['canvasKeyboardMoveUnit', new FakeElement('px')],
            ['canvasKeyboardMoveStep', new FakeElement('1')],
            ['canvasKeyboardMoveShiftStep', new FakeElement('10')]
        ]);
        this.activeElement = null;
        this.hidden = false;
        this.readyState = 'complete';
    }

    addEventListener(type, callback, options = false) {
        (this.handlers[type] ||= []).push({callback, capture: options === true || Boolean(options?.capture)});
    }

    getElementById(id) {
        return this.controls.get(id) || null;
    }

    dispatch(type, event = {}) {
        const listeners = this.handlers[type] || [];
        [...listeners.filter((entry) => entry.capture), ...listeners.filter((entry) => !entry.capture)]
            .forEach((entry) => entry.callback(event));
    }
}

function makeImage(id, x = 0, y = 0, overrides = {}) {
    return {
        id,
        type: 'image',
        imageWidth: 32,
        imageHeight: 32,
        layerWidth: 32,
        layerHeight: 32,
        x,
        y,
        visible: true,
        src: `/canvas-imports/synthetic-${id}.png`,
        ...overrides
    };
}

function createHarness({layers = [makeImage(1, 30, 40)], selectedIds = [1], activeId = 1, moveMode = true} = {}) {
    const document = new FakeDocument();
    const windowHandlers = {};
    const window = {
        document,
        addEventListener(type, callback) { (windowHandlers[type] ||= []).push(callback); },
        CanvasDakiFocus: {selectionChanged(selection) { state.focusChanges.push(selection.id); }}
    };
    const state = {
        saves: 0,
        renders: 0,
        listRenders: 0,
        focusChanges: [],
        order: [],
        layers
    };
    const sandbox = {
        document,
        window,
        SELECTION_MIN_SIZE: 64,
        SELECTION_SIZE_STEP: 64,
        currentCanvasWidth: 960,
        currentCanvasHeight: 3072,
        canvasLayers: layers,
        activeLayerId: activeId,
        selectedLayerIds: new Set(selectedIds),
        isLayerMoveMode: moveMode,
        activeLayerDrag: null,
        activeSelectionDrag: null,
        activeImageResizeDrag: null,
        activeCanvasResizeDrag: null,
        activePinnedReferenceMoveDrag: null,
        activePinnedReferenceResizeDrag: null,
        isClipMaskPainting: false,
        clipInpaintLoadingClipId: null,
        externalCanvasImageImportBusy: false,
        pendingCanvasClipMaskWrites: 0,
        canvasLayerEraserEnabled: false,
        saveCanvasState() { state.saves++; state.order.push('save'); },
        renderCanvasLayersOnSurface() { state.renders++; },
        renderLayerList() { state.listRenders++; },
        getCanvasDisplayScale() { return 0.25; }
    };
    const context = vm.createContext(sandbox);

    for (const [source, names] of [
        [compositeSource, ['getInitialImageLayerGeometry', 'normalizeImageLayerGeometry']],
        [canvasSource, [
            'snapToSelectionStep', 'normalizeSelectionAreaGeometry', 'findCanvasLayer',
            'isResizableCanvasLayer', 'normalizeResizableLayerGeometry', 'isMultiTransformLayer',
            'normalizeTransformLayerGeometry', 'getSelectedTransformLayers', 'getActiveTransformLayerOrNull',
            'isSelectionChildMovableLayer', 'collectSelectionChildMovableLayers', 'buildSelectionChildMoveStarts',
            'hasActiveCanvasGeometryDrag'
        ]]
    ]) {
        for (const name of names) vm.runInContext(extractFunction(source, name), context);
    }
    vm.runInContext(keyboardMoveSource, context);

    const api = window.CanvasKeyboardMove;
    assert.ok(api, 'browser global is initialized');
    return {context, document, window, windowHandlers, sandbox, state, api};
}

function target({matches = false, contentEditable = false} = {}) {
    return {
        isContentEditable: contentEditable,
        closest() { return matches ? {} : null; }
    };
}

function keyEvent(overrides = {}) {
    return {
        key: 'ArrowRight',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        defaultPrevented: false,
        target: target(),
        preventDefault() { this.defaultPrevented = true; },
        ...overrides
    };
}

function keyDown(harness, overrides = {}) {
    const event = keyEvent(overrides);
    harness.document.dispatch('keydown', event);
    return event;
}

function keyUp(harness, key = 'ArrowRight') {
    harness.document.dispatch('keyup', {key});
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('settings default to pixel steps and normalize finite values against the last valid settings', () => {
    assert.deepEqual(CanvasKeyboardMove.getSettings(), {unit: 'px', step: 1, shiftStep: 10});
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({step: 4.6, shiftStep: 20.2}), {
        unit: 'px', step: 5, shiftStep: 20
    });
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({unit: 'percent', step: 1.236, shiftStep: 0.004}), {
        unit: 'percent', step: 1.24, shiftStep: 0.01
    });
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({unit: 'px', step: 10000.6, shiftStep: 0.4}), {
        unit: 'px', step: 10000, shiftStep: 1
    });
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({unit: 'percent', step: 1000, shiftStep: 0.004}), {
        unit: 'percent', step: 100, shiftStep: 0.01
    });

    const fallback = {unit: 'percent', step: 2.25, shiftStep: 9.5};
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({unit: 'invalid', step: '', shiftStep: Infinity}, fallback), fallback);
    assert.deepEqual(CanvasKeyboardMove.normalizeSettings({step: true, shiftStep: null}, fallback), fallback);
});

test('pixel and canvas-percent deltas use the original canvas axes and ignore screen zoom', () => {
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowLeft', false, {unit: 'px', step: 3, shiftStep: 20}, 960, 3072), {dx: -3, dy: 0});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowUp', true, {unit: 'px', step: 3, shiftStep: 20}, 960, 3072), {dx: 0, dy: -20});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowRight', false, {unit: 'percent', step: 1, shiftStep: 10}, 960, 3072), {dx: 10, dy: 0});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowDown', false, {unit: 'percent', step: 1, shiftStep: 10}, 960, 3072), {dx: 0, dy: 31});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowLeft', true, {unit: 'percent', step: 1, shiftStep: 10}, 960, 3072), {dx: -96, dy: 0});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowUp', true, {unit: 'percent', step: 1, shiftStep: 10}, 960, 3072), {dx: 0, dy: -307});
    assert.deepEqual(CanvasKeyboardMove.movementDelta('ArrowRight', false, {unit: 'percent', step: 0.01}, 1, 1), {dx: 1, dy: 0});
    assert.equal(CanvasKeyboardMove.movementDelta('Enter', false, {unit: 'px'}, 960, 3072), null);
    assert.equal(CanvasKeyboardMove.movementDelta('ArrowRight', false, {unit: 'percent'}, 0, 3072), null);

    const h = createHarness();
    h.sandbox.currentCanvasWidth = 960;
    h.sandbox.currentCanvasHeight = 3072;
    h.sandbox.getCanvasDisplayScale = () => 0.1;
    h.api.getSettings();
    const event = keyDown(h);
    assert.equal(h.state.layers[0].x, 31);
    assert.equal(event.defaultPrevented, true);
});

test('keyboard moves the selected transform layer or active fallback and records once on release', () => {
    const h = createHarness({layers: [makeImage(1, 30, 40)], selectedIds: [999], activeId: 1});
    const event = keyDown(h);

    assert.equal(event.defaultPrevented, true);
    assert.deepEqual([h.state.layers[0].x, h.state.layers[0].y], [31, 40]);
    assert.equal(h.state.renders, 1);
    assert.equal(h.state.listRenders, 1);
    assert.equal(h.state.saves, 0);

    keyUp(h);
    assert.equal(h.state.saves, 1);
    assert.equal(h.state.order.join(','), 'save');
    keyUp(h);
    assert.equal(h.state.saves, 1);
});

test('controls change only in-memory steps, update ranges, and preserve the focused input during sync', () => {
    const h = createHarness();
    const step = h.document.getElementById('canvasKeyboardMoveStep');
    const shiftStep = h.document.getElementById('canvasKeyboardMoveShiftStep');
    const unit = h.document.getElementById('canvasKeyboardMoveUnit');

    step.value = '3.4';
    step.dispatch('change');
    shiftStep.value = '20';
    shiftStep.dispatch('change');
    assert.deepEqual(plain(h.api.getSettings()), {unit: 'px', step: 3, shiftStep: 20});
    assert.equal(h.state.saves, 0);

    unit.value = 'percent';
    unit.dispatch('change');
    assert.deepEqual(plain(h.api.getSettings()), {unit: 'percent', step: 3, shiftStep: 20});
    assert.deepEqual([step.min, step.max, step.step], ['0.01', '100', '0.01']);
    step.value = '1.25';
    h.document.activeElement = step;
    h.api.syncControls();
    assert.equal(step.value, '1.25');
    h.document.activeElement = null;
    step.dispatch('change');
    assert.equal(h.state.layers[0].x, 30);
    assert.equal(h.state.saves, 0);

    const rightEvent = keyDown(h, {key: 'ArrowRight'});
    assert.equal(rightEvent.defaultPrevented, true);
    assert.equal(h.state.layers[0].x, 42);
    keyUp(h, 'ArrowRight');
    assert.equal(h.state.saves, 1);

    const event = keyDown(h, {key: 'ArrowDown'});
    assert.equal(event.defaultPrevented, true);
    assert.equal(h.state.layers[0].y, 78);
    keyUp(h, 'ArrowDown');
    assert.equal(h.state.saves, 2);
});

test('multi-selection and nested selection children follow the existing group-drag movement rules', () => {
    const directChild = makeImage(2, 10, 20);
    const nestedImage = makeImage(5, 50, 60);
    const hiddenImage = makeImage(6, 70, 80, {visible: false});
    const pinnedImage = makeImage(7, 90, 100, {pinnedReference: true});
    const renderedClip = {id: 3, type: 'clip', renderOnCanvas: true, src: '/canvas-imports/synthetic-clip.png', x: 11, y: 21, visible: true};
    const unrenderedClip = {id: 8, type: 'clip', renderOnCanvas: false, src: '/canvas-imports/synthetic-hidden-clip.png', x: 30, y: 40, visible: true};
    const nestedSelectionChild = makeImage(10, 5, 7);
    const nestedSelection = {id: 9, type: 'selection', x: 1, y: 2, layerWidth: 64, layerHeight: 64, visible: true, children: [nestedSelectionChild]};
    const selection = {
        id: 1,
        type: 'selection',
        x: 100,
        y: 200,
        layerWidth: 256,
        layerHeight: 256,
        visible: true,
        children: [
            directChild,
            renderedClip,
            {id: 4, type: 'folder', children: [nestedImage]},
            hiddenImage,
            pinnedImage,
            unrenderedClip,
            nestedSelection
        ]
    };
    const roots = [selection, directChild];
    const h = createHarness({layers: roots, selectedIds: [1, 2], activeId: 1});
    const event = keyDown(h, {key: 'ArrowDown'});
    assert.equal(event.defaultPrevented, true);

    assert.deepEqual([selection.x, selection.y], [100, 201]);
    assert.deepEqual([directChild.x, directChild.y], [10, 21]);
    assert.deepEqual([renderedClip.x, renderedClip.y], [11, 22]);
    assert.deepEqual([nestedImage.x, nestedImage.y], [50, 61]);
    assert.deepEqual([nestedSelection.x, nestedSelection.y], [1, 3]);
    assert.deepEqual([nestedSelectionChild.x, nestedSelectionChild.y], [5, 8]);
    assert.deepEqual([hiddenImage.x, hiddenImage.y], [70, 80]);
    assert.deepEqual([pinnedImage.x, pinnedImage.y], [90, 101]);
    assert.deepEqual([unrenderedClip.x, unrenderedClip.y], [30, 41]);
    keyUp(h, 'ArrowDown');
    assert.equal(h.state.saves, 1);
    assert.deepEqual(h.state.focusChanges.sort((a, b) => a - b), [1, 9]);
});

test('held repeats form one undo step, separate presses form separate steps, and Ctrl+Z flushes first', () => {
    const h = createHarness();
    keyDown(h, {repeat: false});
    keyDown(h, {repeat: true});
    keyUp(h);
    assert.equal(h.state.layers[0].x, 32);
    assert.equal(h.state.saves, 1);

    keyDown(h);
    keyUp(h);
    assert.equal(h.state.saves, 2);

    keyDown(h);
    h.document.addEventListener('keydown', event => {
        if (event.key === 'z' && event.ctrlKey) h.state.order.push(`undo-after-${h.state.saves}`);
    });
    h.document.dispatch('keydown', keyEvent({key: 'z', ctrlKey: true}));
    assert.equal(h.state.saves, 3);
    assert.equal(h.state.order.at(-1), 'undo-after-3');
    keyUp(h);
    assert.equal(h.state.saves, 3);
});

test('blur, pointerdown, and hidden-tab changes flush pending moves without a second release save', () => {
    const h = createHarness();
    keyDown(h);
    h.document.dispatch('pointerdown', {target: target()});
    assert.equal(h.state.saves, 1);
    keyUp(h);
    assert.equal(h.state.saves, 1);

    keyDown(h);
    h.windowHandlers.blur[0]();
    keyUp(h);
    assert.equal(h.state.saves, 2);

    keyDown(h);
    h.document.hidden = true;
    h.document.dispatch('visibilitychange');
    keyUp(h);
    assert.equal(h.state.saves, 3);
});

test('ignored targets, modifiers, composition, move mode, busy editors, and no eligible layers keep browser defaults', () => {
    const h = createHarness();
    const image = h.state.layers[0];
    const ignoredEvents = [
        {target: target({matches: true})},
        {target: target({contentEditable: true})},
        {ctrlKey: true}, {metaKey: true}, {altKey: true}, {isComposing: true}, {defaultPrevented: true},
        {key: 'Enter'}
    ];
    for (const overrides of ignoredEvents) {
        const event = keyDown(h, overrides);
        assert.equal(event.defaultPrevented, Boolean(overrides.defaultPrevented));
        assert.deepEqual([image.x, image.y], [30, 40]);
    }

    h.sandbox.isLayerMoveMode = false;
    assert.equal(keyDown(h).defaultPrevented, false);
    h.sandbox.isLayerMoveMode = true;

    const busyChanges = [
        ['activeLayerDrag', {}], ['activeSelectionDrag', {}], ['activeImageResizeDrag', {}], ['activeCanvasResizeDrag', {}],
        ['activePinnedReferenceMoveDrag', {}], ['activePinnedReferenceResizeDrag', {}], ['isClipMaskPainting', true],
        ['clipInpaintLoadingClipId', 'synthetic-clip'], ['externalCanvasImageImportBusy', true],
        ['pendingCanvasClipMaskWrites', 1], ['canvasLayerEraserEnabled', true]
    ];
    for (const [field, value] of busyChanges) {
        h.sandbox[field] = value;
        assert.equal(keyDown(h).defaultPrevented, false, field);
        h.sandbox[field] = typeof value === 'boolean' ? false : typeof value === 'number' ? 0 : null;
    }
    h.window.CanvasRetouch = {isOpen: () => true};
    assert.equal(keyDown(h).defaultPrevented, false);
    h.window.CanvasRetouch = null;

    h.sandbox.currentCanvasWidth = 0;
    assert.equal(keyDown(h).defaultPrevented, false);
    h.sandbox.currentCanvasWidth = 960;
    h.sandbox.selectedLayerIds = new Set([99]);
    h.sandbox.activeLayerId = 98;
    h.state.layers.push({id: 98, type: 'folder', visible: true, children: []});
    assert.equal(keyDown(h).defaultPrevented, false);
    assert.equal(h.state.saves, 0);
});

test('settings are not written to canvas state and a removed layer cannot create a stale undo step', () => {
    const h = createHarness();
    const step = h.document.getElementById('canvasKeyboardMoveStep');
    step.value = '5';
    step.dispatch('change');
    assert.equal(h.state.saves, 0);

    keyDown(h);
    h.sandbox.canvasLayers = [makeImage(1, 200, 300)];
    h.state.layers = h.sandbox.canvasLayers;
    keyUp(h);
    assert.equal(h.state.saves, 0);
    assert.deepEqual(plain(h.api.getSettings()), {unit: 'px', step: 5, shiftStep: 10});
});

test('syncControls shows settings only while layer move mode is enabled', () => {
    const h = createHarness({moveMode: false});
    const group = h.document.getElementById('canvasKeyboardMoveControls');
    assert.equal(group.hidden, true);
    h.sandbox.isLayerMoveMode = true;
    h.api.syncControls();
    assert.equal(group.hidden, false);
    h.sandbox.isLayerMoveMode = false;
    h.api.syncControls();
    assert.equal(group.hidden, true);
});
