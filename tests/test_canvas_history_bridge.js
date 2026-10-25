const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createCanvasHistory} = require('../static/canvas_history');
const {createProjectCanvasAutosave} = require('../static/canvas_project_autosave');

const canvasSource = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');
const bridgeSource = fs.readFileSync(require.resolve('../static/canvas_history_bridge.js'), 'utf8');

function extractFunction(source, name) {
    const start = Math.max(source.indexOf(`function ${name}(`), source.indexOf(`async function ${name}(`));
    assert.notEqual(start, -1, `expected ${name} in its source file`);
    const end = source.indexOf('\n}', source.indexOf('{', start));
    assert.notEqual(end, -1, `expected closing brace for ${name}`);
    const asyncStart = source.lastIndexOf('async ', start);
    return source.slice(asyncStart >= 0 && asyncStart + 6 === start ? asyncStart : start, end + 2);
}

function makeCanvas(overrides = {}) {
    return {
        width: 768,
        height: 1024,
        version: 2,
        activeLayerId: 12,
        checkedSelectionId: 12,
        layerIdSeq: 30,
        canvasZoom: 1,
        clipPreviewZoom: 1,
        savedAt: 10,
        retouchDraft: {draftId: 'retouch-synthetic'},
        oppositeReference: {path: '/canvas-imports/reference-synthetic.png'},
        unknownCanvasField: {kept: true},
        layers: [
            {
                id: 10,
                type: 'folder',
                name: 'Synthetic group',
                children: [{
                    id: 12,
                    type: 'clip',
                    maskSrc: '/canvas-imports/masks/mask-synthetic.png',
                    maskDataUrl: 'data:image/png;base64,synthetic-mask',
                    maskMetadata: {revision: 4, unknownMaskField: 'preserved'},
                    promptInfo: {
                        positive: 'synthetic prompt',
                        negative: 'synthetic negative',
                        unknownPromptField: {source: 'fixture'}
                    },
                    promptControlGroups: [{id: 3, items: ['synthetic'], unknownGroupField: true}],
                    unknownLayerField: {retention: ['all', 'fields']}
                }]
            },
            {id: 20, type: 'image', src: '/canvas-imports/images/remaining-synthetic.png', unknownImageField: 91}
        ],
        ...overrides
    };
}

function createHarness(initialState = makeCanvas(), {
    afterApply,
    enableProjectAutosave = false,
    sendProjectSave
} = {}) {
    const projectCalls = [];
    const projectTimers = new Map();
    let projectTimerId = 0;
    const sandbox = {
        CanvasHistory: {createCanvasHistory},
        URL,
        WeakSet,
        document: {
            handlers: {},
            addEventListener(name, handler) { this.handlers[name] = handler; }
        },
        window: {location: {origin: 'http://synthetic.local'}},
        currentCanvasWidth: initialState.width,
        currentCanvasHeight: initialState.height,
        currentState: structuredClone(initialState),
        canvasZoom: 1,
        clipPreviewZoom: 1,
        activeLayerId: initialState.activeLayerId,
        checkedSelectionId: initialState.checkedSelectionId,
        selectedLayerIds: new Set([initialState.activeLayerId]),
        activeClipSelectionId: null,
        activeClipPromptId: null,
        activeClipAutoMaskPickClipId: null,
        isClipInpaintPreviewMode: false,
        activePinnedReferenceMoveDrag: null,
        activePinnedReferenceResizeDrag: null,
        activeLayerDrag: null,
        activeSelectionDrag: null,
        activeImageResizeDrag: null,
        activeCanvasResizeDrag: null,
        isClipMaskPainting: false,
        clipInpaintLoadingClipId: null,
        externalCanvasImageImportBusy: false,
        pendingCanvasClipMaskWrites: 0,
        canvasLayerEraserEnabled: false,
        canvasLayerEraserSession: {stroke: false},
        autosaveSchedules: 0,
        projectSchedules: 0,
        maskUploads: [],
        warnings: [],
        applyCalls: [],
        toasts: [],
        console: {warn(...args) { sandbox.warnings.push(args); }},
        setTimeout() { return 0; }
    };
    sandbox.buildCanvasStateSnapshot = () => structuredClone(sandbox.currentState);
    sandbox.applyCanvasStateSnapshot = (state, options) => {
        sandbox.applyCalls.push({state: structuredClone(state), options: structuredClone(options)});
        const restored = JSON.parse(JSON.stringify(state));
        if (options?.fromHistory) {
            // These editors own their state and are intentionally not restored by canvas undo.
            for (const key of ['retouchDraft', 'oppositeReference']) {
                if (Object.hasOwn(sandbox.currentState, key)) restored[key] = structuredClone(sandbox.currentState[key]);
            }
        }
        sandbox.currentState = restored;
        sandbox.currentCanvasWidth = Number(state.width) || 0;
        sandbox.currentCanvasHeight = Number(state.height) || 0;
        sandbox.activeLayerId = state.activeLayerId;
        sandbox.checkedSelectionId = state.checkedSelectionId;
        if (afterApply) afterApply(sandbox.currentState);
    };
    sandbox.getCanvasAutosave = () => ({schedule() { sandbox.autosaveSchedules++; return true; }});
    sandbox.saveClipDataUrlToServer = dataUrl => new Promise((resolve, reject) => {
        sandbox.maskUploads.push({dataUrl, resolve, reject});
    });
    sandbox.disposeClipMaskEditor = () => {};
    sandbox.closeCanvasImageLayerContextMenu = () => {};
    sandbox.closeCanvasSelectionContextMenu = () => {};
    sandbox.closeClipOutputClipboardContextMenu = () => {};
    sandbox.showToast = message => sandbox.toasts.push(message);
    sandbox.renderCanvas = () => {};
    sandbox.renderLayerList = () => {};
    sandbox.collectSavedCanvasImportRefs = () => [];
    sandbox.collectStoredCanvasImportRefs = () => [];

    let projectAutosave = null;
    if (enableProjectAutosave) {
        projectAutosave = createProjectCanvasAutosave({
            snapshot: () => structuredClone(sandbox.currentState),
            send: async (binding, state, revision) => {
                projectCalls.push({binding, state, revision});
                if (sendProjectSave) return sendProjectSave(binding, state, revision);
                return {revision: revision + 1};
            },
            setTimer(callback, delay) {
                const id = ++projectTimerId;
                projectTimers.set(id, {callback, delay});
                return id;
            },
            clearTimer(id) { projectTimers.delete(id); }
        });
        projectAutosave.connect({projectId: 'synthetic-project', canvasId: 'synthetic-canvas', revision: 1});
        sandbox.window.CanvasProject = {
            schedule(immediate) {
                sandbox.projectSchedules++;
                return projectAutosave.schedule(immediate);
            }
        };
    } else {
        sandbox.window.CanvasProject = {schedule() { sandbox.projectSchedules++; }};
    }

    const context = vm.createContext(sandbox);
    vm.runInContext('const clipMaskPersistRevisions = new WeakMap();', context);
    for (const name of ['saveCanvasState']) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    vm.runInContext(extractFunction(canvasSource, 'persistClipMask'), context);
    for (const name of [
        'normalizeCanvasImportRef',
        'collectCanvasImportRefsFromValue',
        'collectCurrentCanvasImportRefs',
        'collectRetainedCanvasImportRefs',
        'hasActiveCanvasGeometryDrag'
    ]) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    vm.runInContext(bridgeSource, context);
    context.resetCanvasEditHistory();
    return {context, sandbox, projectAutosave, projectCalls, projectTimers};
}

function fireKey(harness, overrides = {}) {
    let preventDefaultCalls = 0;
    const event = {
        key: 'z',
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        defaultPrevented: false,
        target: {closest: () => Boolean(overrides.closest)},
        preventDefault() { preventDefaultCalls++; },
        ...overrides
    };
    harness.sandbox.document.handlers.keydown(event);
    return {event, preventDefaultCalls};
}

test('save and undo restore deleted nested layers, masks, prompts, and unknown fields', () => {
    const h = createHarness(makeCanvas(), {afterApply: state => { state.appliedNormalization = true; }});
    const originalClip = structuredClone(h.sandbox.currentState.layers[0].children[0]);
    h.sandbox.currentState.layers[0].children.splice(0, 1);
    h.sandbox.currentState.activeLayerId = 20;
    h.context.saveCanvasState();

    assert.equal(h.context.getCanvasEditHistory().canUndo, true);
    assert.equal(h.sandbox.autosaveSchedules, 1);
    assert.equal(h.sandbox.projectSchedules, 1);
    h.context.undoCanvasEdit();

    const restored = h.sandbox.currentState.layers[0].children[0];
    assert.deepEqual(restored, originalClip);
    assert.deepEqual(h.sandbox.currentState.unknownCanvasField, {kept: true});
    assert.equal(h.sandbox.currentState.appliedNormalization, true);
    assert.equal(h.sandbox.currentState.layers[0].children[0].maskSrc, originalClip.maskSrc);
    assert.deepEqual(h.sandbox.currentState.layers[0].children[0].promptInfo, originalClip.promptInfo);
    assert.equal(h.sandbox.autosaveSchedules, 2);
    assert.equal(h.sandbox.projectSchedules, 2);
    assert.equal(h.sandbox.applyCalls[0].options.fromHistory, true);
    assert.equal(h.context.getCanvasEditHistory().states().length, 1);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.sandbox.toasts.at(-1), '실행 취소했습니다.');
});

test('selection, active layer, sequence, and zoom changes update current state without an undo step', () => {
    const h = createHarness();
    h.sandbox.currentState.activeLayerId = 20;
    h.sandbox.currentState.checkedSelectionId = 20;
    h.sandbox.currentState.layerIdSeq = 99;
    h.sandbox.currentState.canvasZoom = 4;
    h.sandbox.currentState.clipPreviewZoom = 2;
    h.sandbox.currentState.savedAt = 500;
    h.context.saveCanvasState();

    const states = h.context.getCanvasEditHistory().states();
    assert.equal(states.length, 1);
    assert.equal(states[0].activeLayerId, 20);
    assert.equal(states[0].checkedSelectionId, 20);
    assert.equal(states[0].layerIdSeq, 99);
    assert.equal(Object.hasOwn(states[0], 'canvasZoom'), false);
    assert.equal(Object.hasOwn(states[0], 'clipPreviewZoom'), false);
    assert.equal(Object.hasOwn(states[0], 'savedAt'), false);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
});

test('prompt, settings, view, and recursive layer-panel changes do not create project edits', () => {
    const initial = makeCanvas();
    initial.layers.push({
        id: 30,
        type: 'folder',
        name: 'synthetic outer folder',
        expanded: true,
        children: [{
            id: 31,
            type: 'folder',
            name: 'synthetic inner folder',
            expanded: true,
            children: [{id: 32, type: 'image', src: '/canvas-imports/images/nested-synthetic.png'}]
        }]
    });
    const h = createHarness(initial);
    const state = h.sandbox.currentState;
    Object.assign(state, {
        savedAt: 999,
        activeLayerId: 20,
        checkedSelectionId: 20,
        layerIdSeq: 99,
        canvasZoom: 4,
        clipPreviewZoom: 3,
        styleLink: {library: 'synthetic-style'},
        projectSettingsLink: {projectId: 'synthetic-project'},
        dakiBodyMap: {focus: 'synthetic-focus'},
        retouchDraft: {draftId: 'retouch-context-only'},
        oppositeReference: {path: '/canvas-imports/reference-context-only.png'},
        inpaintReference: {path: '/canvas-imports/reference-context-only.png'},
        sharedSelectionClipPromptInfo: {positive: 'synthetic shared prompt'},
        inpaintSettings: {strength: 0.4, prompt: 'synthetic inpaint settings'},
        sharedSelectionClipPromptControlGroups: [{id: 7, items: ['synthetic']}],
        isSelectionOverlayHidden: true,
        isClipInpaintMergedSourceMode: true
    });
    const layerContext = {
        name: 'synthetic renamed panel item',
        expanded: false,
        promptInfo: {positive: 'synthetic layer prompt', negative: 'synthetic negative'},
        promptControlGroups: [{id: 8, items: ['synthetic layer group']}],
        promptOwnerId: 32,
        instancePrompt: 'synthetic instance prompt',
        instanceNegativePrompt: 'synthetic instance negative',
        dakiFocus: {region: 'synthetic region'},
        pinnedWidth: 123,
        pinnedHeight: 234,
        pinnedOffsetX: 3,
        pinnedOffsetY: 4,
        pinnedPanelOffsetX: 5,
        pinnedPanelOffsetY: 6,
        pinnedUiX: 7,
        pinnedUiY: 8,
        pinnedUiLocked: true
    };
    const visit = layers => layers.forEach(layer => {
        Object.assign(layer, structuredClone(layerContext));
        if (Array.isArray(layer.children)) visit(layer.children);
    });
    visit(state.layers);
    h.sandbox.canvasZoom = 4;
    h.sandbox.clipPreviewZoom = 3;

    h.context.saveCanvasState();

    assert.equal(h.context.getCanvasEditHistory().states().length, 1);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.sandbox.projectSchedules, 0);
    assert.equal(h.sandbox.autosaveSchedules, 1);
});

test('geometry, sources, masks, dimensions, and visibility each create one edit', () => {
    const edits = [
        ['layer position', initial => { initial.layers[1].x = 10; }, state => { state.layers[1].x = 17; }],
        ['image source', () => {}, state => { state.layers[1].src = '/canvas-imports/images/next-synthetic.png'; }],
        ['clip mask source', () => {}, state => { state.layers[0].children[0].maskSrc = '/canvas-imports/masks/next-synthetic.png'; }],
        ['canvas width', () => {}, state => { state.width = 900; }],
        ['canvas height', () => {}, state => { state.height = 1200; }],
        ['layer visibility', initial => { initial.layers[1].visible = true; }, state => { state.layers[1].visible = false; }]
    ];

    for (const [name, prepare, edit] of edits) {
        const initial = makeCanvas();
        prepare(initial);
        const h = createHarness(initial);
        edit(h.sandbox.currentState);
        h.context.saveCanvasState();

        assert.equal(h.context.getCanvasEditHistory().states().length, 2, name);
        assert.equal(h.context.getCanvasEditHistory().canUndo, true, name);
        assert.equal(h.sandbox.projectSchedules, 1, name);
        assert.equal(h.sandbox.autosaveSchedules, 1, name);
    }
});

test('undo keeps current prompt and view context and normalization adds no phantom step', () => {
    const h = createHarness(makeCanvas(), {
        afterApply: state => { state.normalizedAfterHistory = 'synthetic-normalized'; }
    });
    const image = h.sandbox.currentState.layers[1];
    image.x = 40;
    h.context.saveCanvasState();
    assert.equal(h.sandbox.projectSchedules, 1);

    const current = h.sandbox.currentState;
    current.canvasZoom = 4;
    current.clipPreviewZoom = 2;
    current.activeLayerId = 20;
    current.checkedSelectionId = 20;
    current.layerIdSeq = 90;
    current.sharedSelectionClipPromptInfo = {positive: 'latest shared prompt'};
    current.inpaintSettings = {strength: 0.55, prompt: 'latest inpaint settings'};
    current.styleLink = {library: 'latest synthetic style'};
    current.layers[0].children[0].promptInfo.positive = 'latest nested prompt';
    current.layers[0].children[0].promptControlGroups = [{id: 9, items: ['latest group']}];
    current.layers[0].children[0].name = 'latest clip label';
    h.sandbox.canvasZoom = 4;
    h.sandbox.clipPreviewZoom = 2;
    h.context.saveCanvasState();

    assert.equal(h.sandbox.projectSchedules, 1);
    assert.equal(h.context.getCanvasEditHistory().states().length, 2);
    fireKey(h);

    assert.equal(h.sandbox.currentState.layers[1].x, undefined);
    assert.equal(h.sandbox.currentState.sharedSelectionClipPromptInfo.positive, 'latest shared prompt');
    assert.equal(h.sandbox.currentState.inpaintSettings.prompt, 'latest inpaint settings');
    assert.equal(h.sandbox.currentState.styleLink.library, 'latest synthetic style');
    assert.equal(h.sandbox.currentState.layers[0].children[0].promptInfo.positive, 'latest nested prompt');
    assert.deepEqual(h.sandbox.currentState.layers[0].children[0].promptControlGroups, [{id: 9, items: ['latest group']}]);
    assert.equal(h.sandbox.currentState.layers[0].children[0].name, 'latest clip label');
    assert.equal(h.sandbox.currentState.activeLayerId, 20);
    assert.equal(h.sandbox.currentState.checkedSelectionId, 20);
    assert.equal(h.sandbox.currentState.layerIdSeq, 90);
    assert.equal(h.sandbox.currentState.canvasZoom, 4);
    assert.equal(h.sandbox.currentState.clipPreviewZoom, 2);
    assert.equal(h.sandbox.currentState.normalizedAfterHistory, 'synthetic-normalized');
    assert.equal(h.sandbox.projectSchedules, 2);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.context.getCanvasEditHistory().states().length, 1);

    h.sandbox.currentState.canvasZoom = 5;
    h.sandbox.canvasZoom = 5;
    h.sandbox.currentState.sharedSelectionClipPromptInfo.positive = 'newer view-only prompt';
    h.context.saveCanvasState();
    assert.equal(h.sandbox.projectSchedules, 2);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.context.getCanvasEditHistory().states().length, 1);
});

test('in-flight project save ignores view-only scheduling while undo schedules restored artwork', async () => {
    let resolveFirstSave;
    const firstSave = new Promise(resolve => { resolveFirstSave = resolve; });
    const h = createHarness(makeCanvas(), {
        enableProjectAutosave: true,
        sendProjectSave: async (_binding, _state, revision) => {
            if (revision === 1) return firstSave;
            return {revision: revision + 1};
        }
    });
    h.sandbox.currentState.layers[1].x = 25;
    h.context.saveCanvasState({immediate: true});
    assert.equal(h.projectCalls.length, 1);
    assert.equal(h.projectAutosave.isUnsaved(), true);

    h.sandbox.currentState.canvasZoom = 3;
    h.sandbox.currentState.sharedSelectionClipPromptInfo = {positive: 'in-flight view-only prompt'};
    h.sandbox.canvasZoom = 3;
    h.context.saveCanvasState();
    assert.equal(h.sandbox.projectSchedules, 1);

    resolveFirstSave({revision: 2});
    assert.equal(await h.projectAutosave.flush(), true);
    assert.equal(h.projectCalls.length, 1);
    assert.equal(h.projectAutosave.isUnsaved(), false);
    assert.equal(h.projectTimers.size, 0);

    fireKey(h);
    assert.equal(h.sandbox.projectSchedules, 2);
    assert.equal(h.projectAutosave.isUnsaved(), true);
    assert.equal(await h.projectAutosave.flush(), true);
    assert.equal(h.projectCalls.length, 2);
    assert.equal(h.projectCalls[1].state.layers[1].x, undefined);
    assert.equal(h.projectCalls[1].state.canvasZoom, 3);
    assert.deepEqual(h.projectCalls[1].state.sharedSelectionClipPromptInfo, {positive: 'in-flight view-only prompt'});
    assert.equal(h.projectAutosave.isUnsaved(), false);
});

test('actual retained import ref collector keeps assets referenced by deleted layers in history', () => {
    const initial = makeCanvas();
    initial.oppositeReference = null;
    initial.layers[0].children[0].sourcePath = '/canvas-imports/images/deleted-synthetic.png?session=fixture';
    initial.layers[0].children[0].maskSrc = '/canvas-imports/masks/deleted-mask-synthetic.png';
    const h = createHarness(initial);
    h.sandbox.currentState.layers[0].children = [];
    h.context.saveCanvasState();

    const refs = h.context.collectRetainedCanvasImportRefs();
    assert.deepEqual([...refs].sort(), [
        'images/deleted-synthetic.png',
        'masks/deleted-mask-synthetic.png',
        'images/remaining-synthetic.png'
    ].sort());
});

test('resetting history for a new canvas prevents undo from crossing canvases', () => {
    const h = createHarness();
    h.sandbox.currentState.unknownCanvasField.changed = true;
    h.context.saveCanvasState();
    assert.equal(h.context.getCanvasEditHistory().canUndo, true);

    h.sandbox.currentState = makeCanvas({
        width: 512,
        height: 512,
        activeLayerId: 80,
        checkedSelectionId: 80,
        layers: [{id: 80, type: 'image', src: '/canvas-imports/images/new-canvas-synthetic.png'}],
        unknownCanvasField: {canvas: 'second'}
    });
    h.sandbox.currentCanvasWidth = 512;
    h.sandbox.currentCanvasHeight = 512;
    h.context.resetCanvasEditHistory();
    h.context.undoCanvasEdit();

    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.sandbox.applyCalls.length, 0);
    assert.deepEqual(h.sandbox.currentState.unknownCanvasField, {canvas: 'second'});
    assert.equal(h.context.getCanvasEditHistory().states()[0].layers[0].id, 80);
});

test('Ctrl+Z ignores editable and modal targets, composing, modifiers, prevented events, and eraser mode', () => {
    const h = createHarness();
    h.sandbox.currentState.unknownCanvasField.changed = true;
    h.context.saveCanvasState();
    const blockedEvents = [
        ['editable target', {closest: true}],
        ['modal target', {closest: true}],
        ['composition', {isComposing: true}],
        ['shift modifier', {shiftKey: true}],
        ['alt modifier', {altKey: true}],
        ['already prevented', {defaultPrevented: true}]
    ];

    for (const [name, overrides] of blockedEvents) {
        const result = fireKey(h, overrides);
        assert.equal(result.preventDefaultCalls, 0, name);
        assert.equal(h.context.getCanvasEditHistory().canUndo, true, name);
    }
    h.sandbox.canvasLayerEraserEnabled = true;
    const eraserResult = fireKey(h);
    h.sandbox.canvasLayerEraserEnabled = false;
    assert.equal(eraserResult.preventDefaultCalls, 0);
    assert.equal(h.context.getCanvasEditHistory().canUndo, true);

    const allowed = fireKey(h);
    assert.equal(allowed.preventDefaultCalls, 1);
    assert.equal(h.context.getCanvasEditHistory().canUndo, false);
    assert.equal(h.sandbox.currentState.unknownCanvasField.changed, undefined);
});

test('undo is blocked during geometry drags, pinned-reference drags, and busy editing work', () => {
    const h = createHarness();
    h.sandbox.currentState.unknownCanvasField.changed = true;
    h.context.saveCanvasState();
    const guards = [
        ['layer drag', 'activeLayerDrag = {}', 'activeLayerDrag = null'],
        ['selection drag', 'activeSelectionDrag = {}', 'activeSelectionDrag = null'],
        ['image resize drag', 'activeImageResizeDrag = {}', 'activeImageResizeDrag = null'],
        ['canvas resize drag', 'activeCanvasResizeDrag = {}', 'activeCanvasResizeDrag = null'],
        ['pinned reference move', 'activePinnedReferenceMoveDrag = {}', 'activePinnedReferenceMoveDrag = null'],
        ['pinned reference resize', 'activePinnedReferenceResizeDrag = {}', 'activePinnedReferenceResizeDrag = null'],
        ['mask painting', 'isClipMaskPainting = true', 'isClipMaskPainting = false'],
        ['clip loading', "clipInpaintLoadingClipId = 'synthetic-clip'", 'clipInpaintLoadingClipId = null'],
        ['external image import', 'externalCanvasImageImportBusy = true', 'externalCanvasImageImportBusy = false'],
        ['pending clip-mask write', 'pendingCanvasClipMaskWrites = 1', 'pendingCanvasClipMaskWrites = 0'],
        ['eraser stroke', 'canvasLayerEraserSession.stroke = true', 'canvasLayerEraserSession.stroke = false']
    ];

    for (const [name, enable, disable] of guards) {
        vm.runInContext(enable, h.context);
        h.context.undoCanvasEdit();
        assert.equal(h.context.getCanvasEditHistory().canUndo, true, name);
        assert.equal(h.sandbox.autosaveSchedules, 1, name);
        vm.runInContext(disable, h.context);
    }
});

test('clip mask uploads block undo, clean up stale revisions, and save once per accepted write', async () => {
    const h = createHarness();
    h.sandbox.currentState.unknownCanvasField.changed = true;
    h.context.saveCanvasState();
    const clip = h.sandbox.currentState.layers[0].children[0];
    const maskCanvas = label => ({width: 32, height: 48, toDataURL: () => `data:image/png;base64,${label}`});

    const firstWrite = h.context.persistClipMask(clip, maskCanvas('first-revision'));
    const latestWrite = h.context.persistClipMask(clip, maskCanvas('latest-revision'));
    assert.equal(h.sandbox.pendingCanvasClipMaskWrites, 2);
    assert.equal(h.sandbox.maskUploads.length, 2);
    h.context.undoCanvasEdit();
    assert.equal(h.context.getCanvasEditHistory().canUndo, true);
    assert.equal(h.sandbox.applyCalls.length, 0);
    assert.equal(h.sandbox.autosaveSchedules, 1);

    h.sandbox.maskUploads[0].resolve('/canvas-imports/masks/stale-synthetic.png');
    await firstWrite;
    assert.equal(h.sandbox.pendingCanvasClipMaskWrites, 1);
    assert.equal(clip.maskSrc, '/canvas-imports/masks/mask-synthetic.png');
    assert.equal(clip.maskDataUrl, 'data:image/png;base64,latest-revision');
    assert.equal(h.sandbox.autosaveSchedules, 1);

    h.sandbox.maskUploads[1].resolve('/canvas-imports/masks/latest-synthetic.png');
    await latestWrite;
    assert.equal(h.sandbox.pendingCanvasClipMaskWrites, 0);
    assert.equal(clip.maskSrc, '/canvas-imports/masks/latest-synthetic.png');
    assert.equal(Object.hasOwn(clip, 'maskDataUrl'), false);
    assert.equal(h.sandbox.autosaveSchedules, 2);
    assert.equal(h.sandbox.projectSchedules, 2);

    const failedClip = {id: 44, type: 'clip', maskSrc: '/canvas-imports/masks/previous-synthetic.png'};
    h.sandbox.currentState.layers[0].children.push(failedClip);
    const failedWrite = h.context.persistClipMask(failedClip, maskCanvas('fallback-revision'));
    assert.equal(h.sandbox.pendingCanvasClipMaskWrites, 1);
    h.sandbox.maskUploads[2].reject(new Error('synthetic upload failure'));
    await failedWrite;
    assert.equal(h.sandbox.pendingCanvasClipMaskWrites, 0);
    assert.equal(failedClip.maskSrc, '/canvas-imports/masks/previous-synthetic.png');
    assert.equal(failedClip.maskDataUrl, 'data:image/png;base64,fallback-revision');
    assert.equal(h.sandbox.autosaveSchedules, 3);
    assert.equal(h.sandbox.projectSchedules, 3);
    assert.equal(h.sandbox.warnings.length, 1);
});
