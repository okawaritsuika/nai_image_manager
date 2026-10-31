const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '..');
const canvasSource = fs.readFileSync(path.join(root, 'static', 'canvas.js'), 'utf8');
const setupsSource = fs.readFileSync(path.join(root, 'static', 'canvas_setups.js'), 'utf8');
const referenceModuleSource = fs.readFileSync(
    path.join(root, 'static', 'canvas_inpaint_reference.js'), 'utf8'
);

function section(source, startText, endText) {
    const start = source.indexOf(startText);
    const end = source.indexOf(endText, start);
    assert.notEqual(start, -1, `missing section start: ${startText}`);
    assert.notEqual(end, -1, `missing section end: ${endText}`);
    return source.slice(start, end);
}

function extractFunction(source, name) {
    const marker = `function ${name}(`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `missing function: ${name}`);
    let index = source.indexOf('(', start);
    let parentheses = 0;
    for (; index < source.length; index += 1) {
        if (source[index] === '(') parentheses += 1;
        if (source[index] === ')') parentheses -= 1;
        if (parentheses === 0) break;
    }
    const brace = source.indexOf('{', index + 1);
    let depth = 0;
    for (let cursor = brace; cursor < source.length; cursor += 1) {
        if (source[cursor] === '{') depth += 1;
        if (source[cursor] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, cursor + 1);
    }
    assert.fail(`missing closing brace for ${name}`);
}

const inpaintFunction = section(
    canvasSource,
    'async function requestClipInpainting(clipId) {',
    '\nfunction findSelectionParentForLayerId('
);
const snapshotFunction = section(
    canvasSource,
    'function buildCanvasStateSnapshot(options = {}) {',
    '\nfunction cloneCanvasLayersForState('
);
const applySnapshotFunction = extractFunction(setupsSource, 'applyCanvasStateSnapshot');

const promptInfo = {
    basePrompt: '  (weighted detail:1.25), exact source prompt  ',
    negativePrompt: '  source negative  ',
    charPrompts: ['first character', ' second character '],
    steps: 28,
    seed: 0
};
const reference = {
    src: '/canvas-imports/synthetic.png',
    width: 320,
    x: 0.5,
    y: 0.5,
    zoom: 1
};

function makeResponse(request) {
    return {
        ok: true,
        async json() {
            return {
                status: 'success',
                src: '/canvas-imports/generated-synthetic.png',
                promptInfo: request.body.promptInfo
            };
        }
    };
}

function createHarness({referenceRequest, fetchImpl} = {}) {
    const clip = {
        id: 2,
        type: 'clip',
        src: '/canvas-imports/clip-synthetic.png',
        maskDataUrl: 'data:image/png;base64,c3ludGhldGlj',
        imageWidth: 1024,
        imageHeight: 512,
        x: 71,
        y: 83,
        layerWidth: 480,
        layerHeight: 240,
        promptInfo: structuredClone(promptInfo)
    };
    const selection = {id: 1, type: 'selection', children: [clip]};
    const requests = [];
    const warnings = [];
    const alerts = [];
    const toasts = [];
    const referenceCalls = [];
    let fetchStartedResolve;
    const fetchStarted = new Promise(resolve => { fetchStartedResolve = resolve; });
    let context;

    context = {
        canvasLayers: [selection],
        clipInpaintLoadingClipId: null,
        isClipInpaintMergedSourceMode: false,
        CanvasSelectionRotation: require('../static/canvas_selection_rotation.js'),
        layerIdSeq: 100,
        activeLayerId: null,
        activeClipSelectionId: null,
        checkedSelectionId: null,
        clipMergedSourcePreviewSeq: 0,
        structuredClone,
        CANVAS_IMPORT_SESSION_ID: 'synthetic-session',
        findCanvasLayer(id) {
            let found = null;
            const visit = layers => {
                for (const layer of layers || []) {
                    if (Number(layer.id) === Number(id)) found = {layer};
                    if (Array.isArray(layer.children)) visit(layer.children);
                }
            };
            visit(context.canvasLayers);
            return found;
        },
        findSelectionParentForLayerId(id) {
            let parent = null;
            const visit = (layers, currentSelection = null) => {
                for (const layer of layers || []) {
                    if (Number(layer.id) === Number(id)) {
                        parent = currentSelection;
                        return;
                    }
                    const nextSelection = layer.type === 'selection' ? layer : currentSelection;
                    if (Array.isArray(layer.children)) visit(layer.children, nextSelection);
                    if (parent) return;
                }
            };
            visit(context.canvasLayers);
            return parent;
        },
        buildEffectiveClipPromptInfo() { return structuredClone(promptInfo); },
        CanvasInpaintReference: {
            request(width, height) {
                referenceCalls.push([width, height]);
                if (typeof referenceRequest === 'function') return referenceRequest(width, height);
                return referenceRequest || {width, height, reference: null};
            }
        },
        async showAnlasWarningModal(options) {
            warnings.push(options);
            return true;
        },
        setClipInpaintProcessing(id, isLoading) {
            context.clipInpaintLoadingClipId = isLoading ? id : null;
        },
        fetch(url, options) {
            const request = {url, options, body: JSON.parse(options.body)};
            requests.push(request);
            fetchStartedResolve(request);
            return fetchImpl ? fetchImpl(request) : Promise.resolve(makeResponse(request));
        },
        alert(message) { alerts.push(message); },
        showToast(message) { toasts.push(message); },
        getOrCreateSelectionInpaintFolder(parent) { return parent; },
        normalizePromptInfo(value) { return structuredClone(value); },
        clearClipMergedSourcePreviewCache() {},
        migrateAllSelectionClipsToSharedPromptOwner() {},
        renderLayerList() {},
        renderCanvasLayersOnSurface() {},
        renderClipOutputPanel() {},
        animateClipInpaintResult() {},
        saveCanvasState() {}
    };
    vm.createContext(context);
    vm.runInContext(inpaintFunction, context, {filename: 'request_clip_inpainting_harness.js'});

    return {
        context,
        clip,
        selection,
        requests,
        warnings,
        alerts,
        toasts,
        referenceCalls,
        fetchStarted,
        setLayers(layers) { context.canvasLayers = layers; }
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('clip inpainting accounts for the reference width but keeps the original request size and prompt', async () => {
    const h = createHarness({referenceRequest: {
        width: 1344,
        height: 512,
        reference
    }});

    await h.context.requestClipInpainting(2);

    assert.deepEqual(h.referenceCalls, [[1024, 512]]);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.warnings[0].width, 1344);
    assert.equal(h.warnings[0].height, 512);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/canvas/inpaint');
    assert.equal(h.requests[0].body.width, 1024);
    assert.equal(h.requests[0].body.height, 512);
    assert.deepEqual(h.requests[0].body.reference, reference);
    assert.deepEqual(h.requests[0].body.promptInfo, promptInfo);

    const result = h.selection.children[0];
    assert.equal(result.src, '/canvas-imports/generated-synthetic.png');
    for (const key of ['x', 'y', 'layerWidth', 'layerHeight', 'imageWidth', 'imageHeight']) {
        assert.equal(result[key], h.clip[key], key);
    }
    assert.deepEqual(result.promptInfo, promptInfo);
});

test('clip inpainting without a reference uses the original warning size and omits the body field', async () => {
    const h = createHarness({referenceRequest: {
        width: 1024,
        height: 512,
        reference: null
    }});

    await h.context.requestClipInpainting(2);

    assert.equal(h.warnings[0].width, 1024);
    assert.equal(h.warnings[0].height, 512);
    assert.equal(h.requests[0].body.width, 1024);
    assert.equal(h.requests[0].body.height, 512);
    assert.equal(Object.hasOwn(h.requests[0].body, 'reference'), false);
});

test('invalid reference settings stop before the warning and request', async () => {
    const h = createHarness({referenceRequest() {
        throw new Error('invalid synthetic reference');
    }});

    await h.context.requestClipInpainting(2);

    assert.deepEqual(h.alerts, ['invalid synthetic reference']);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.requests.length, 0);
});

test('a busy clip blocks duplicate inpainting requests', async () => {
    const pendingResponse = deferred();
    const h = createHarness({fetchImpl: () => pendingResponse.promise});
    const firstRequest = h.context.requestClipInpainting(2);
    await h.fetchStarted;

    assert.equal(h.context.clipInpaintLoadingClipId, 2);
    await h.context.requestClipInpainting(2);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.requests.length, 1);

    pendingResponse.resolve(makeResponse(h.requests[0]));
    await firstRequest;
    assert.equal(h.context.clipInpaintLoadingClipId, null);
    assert.equal(h.requests.length, 1);
});

test('a deferred response is discarded if its clip is removed or the canvas is replaced', async t => {
    for (const change of ['removed', 'replaced']) {
        await t.test(change, async () => {
            const pendingResponse = deferred();
            const h = createHarness({fetchImpl: () => pendingResponse.promise});
            const request = h.context.requestClipInpainting(2);
            await h.fetchStarted;

            if (change === 'removed') {
                h.setLayers([]);
            } else {
                const replacementClip = {...h.clip};
                h.setLayers([{
                    id: h.selection.id,
                    type: 'selection',
                    children: [replacementClip]
                }]);
            }

            pendingResponse.resolve(makeResponse(h.requests[0]));
            await request;

            assert.equal(h.toasts.length, 1);
            assert.match(h.toasts[0], /캔버스가 변경되어/);
            if (change === 'replaced') {
                assert.equal(h.context.canvasLayers[0].children.length, 1);
                assert.equal(h.context.canvasLayers[0].children[0].src, h.clip.src);
            } else {
                assert.deepEqual(h.context.canvasLayers, []);
            }
        });
    }
});

test('canvas snapshots use the reference module snapshot and detach its saved crop', () => {
    const context = {
        document: null,
        console: {warn() {}},
        structuredClone,
        window: null,
        currentCanvasWidth: 1024,
        currentCanvasHeight: 512,
        canvasLayers: [],
        activeLayerId: null,
        layerIdSeq: 1,
        sharedSelectionClipPromptInfo: null,
        sharedSelectionClipPromptControlGroups: [],
        isSelectionOverlayHidden: false,
        checkedSelectionId: null,
        canvasZoom: 1,
        clipPreviewZoom: 1,
        isClipInpaintMergedSourceMode: false,
        cloneCanvasLayersForState(layers) { return structuredClone(layers); }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(referenceModuleSource, context, {filename: 'canvas_inpaint_reference_snapshot_harness.js'});
    vm.runInContext(snapshotFunction, context, {filename: 'build_canvas_state_snapshot_harness.js'});
    context.CanvasInpaintReference.restore({reference, include: true, showArea: false});

    const snapshot = context.buildCanvasStateSnapshot();
    assert.deepEqual(plain(snapshot.inpaintReference), {
        reference: {...reference, name: '참고 이미지'},
        include: true,
        showArea: true
    });
    snapshot.inpaintReference.reference.x = 0.9;
    assert.equal(context.CanvasInpaintReference.snapshot().reference.x, 0.5);
});

test('snapshot restore passes both new reference state and a missing legacy field to the module', () => {
    const restoreCalls = [];
    const context = {
        structuredClone,
        CanvasInpaintReference: {restore(value) { restoreCalls.push(value); }},
        clipPromptGroups: [],
        normalizeSharedPromptGroups() { return []; },
        normalizeCanvasLayerTree() {},
        syncAllPromptCopiesFromOwners() {},
        migrateAllSelectionClipsToSharedPromptOwner() {},
        ensureCheckedSelectionId() {},
        updateSelectionOverlayToggleUI() {},
        renderCanvas() {},
        renderLayerList() {},
        updateCanvasRatioInfo() {},
        migrateCanvasLayerDataUrlsToServer() {}
    };
    vm.createContext(context);
    vm.runInContext(applySnapshotFunction, context, {filename: 'apply_canvas_state_snapshot_harness.js'});

    context.applyCanvasStateSnapshot({width: 1024, height: 512, layers: []});
    const savedReferenceState = {reference, include: true, showArea: true};
    context.applyCanvasStateSnapshot({
        width: 1024,
        height: 512,
        layers: [],
        inpaintReference: savedReferenceState
    });

    assert.equal(restoreCalls.length, 2);
    assert.equal(restoreCalls[0], undefined);
    assert.equal(restoreCalls[1], savedReferenceState);
});
