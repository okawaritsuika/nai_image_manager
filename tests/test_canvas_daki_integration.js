const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const Regions = require('../static/canvas_daki_regions.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8').replace(/\r\n/g, '\n');

function functionSource(name) {
    let start = source.indexOf(`async function ${name}(`);
    if (start < 0) start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing ${name}`);
    const tail = source.slice(start);
    const next = tail.slice(1).search(/\n(?:async )?function /);
    return next < 0 ? tail : tail.slice(0, next + 1);
}

const extractedCanvasFunctions = [
    'findCanvasLayer',
    'findSelectionParentForLayerId',
    'getOrCreateSelectionInpaintFolder',
    'requestClipInpainting',
].map(functionSource).join('\n');

test('automatic OFF styling merges with manual groups and maps nonempty character editors by order', () => {
    const requested = [];
    const fields = [
        {key: 'base', inputId: 'base'},
        {key: 'char-empty', inputId: 'empty', isChar: true},
        {key: 'char-first', inputId: 'first', isChar: true},
        {key: 'char-second', inputId: 'second', isChar: true},
    ];
    const inputs = {base: 'blue eyes, shirt', empty: ' ', first: 'blue eyes', second: 'shirt'};
    const sandbox = {
        getActiveClipForPromptControl: () => ({}),
        ensureClipPromptControlGroups: () => [{enabled: false, items: [{field: 'base', type: 'token', token: 'manual tag'}]}],
        getClipPromptFields: () => fields,
        el: id => ({value: inputs[id]}),
        CanvasDakiFocus: {excludedTokens: field => {
            requested.push(field);
            return ['base', 'char-0'].includes(field) ? ['blue eyes'] : [];
        }},
    };
    vm.createContext(sandbox);
    vm.runInContext(['stripClipWeightMarkers', 'normalizeClipTokenForGroup', 'normalizeClipPromptControlField',
        'getDisabledClipPromptVisualState', 'isClipPromptTokenDisabledByControls', 'isClipPromptGroupDisabledByControls']
        .map(functionSource).join('\n'), sandbox);
    const base = sandbox.getDisabledClipPromptVisualState('base');
    assert.equal(sandbox.isClipPromptTokenDisabledByControls('1.2::blue eyes::', base), true);
    assert.equal(sandbox.isClipPromptTokenDisabledByControls('manual tag', base), true);
    assert.equal(sandbox.isClipPromptTokenDisabledByControls('shirt', base), false);
    assert.equal(sandbox.isClipPromptGroupDisabledByControls(['blue eyes'], base), true);
    assert.equal(sandbox.isClipPromptGroupDisabledByControls(['blue eyes', 'shirt'], base), false);
    assert.equal(sandbox.getDisabledClipPromptVisualState('char-first').tokenKeys.has('blue eyes'), true);
    assert.equal(sandbox.getDisabledClipPromptVisualState('char-second').tokenKeys.size, 0);
    assert.equal(sandbox.getDisabledClipPromptVisualState('negative').tokenKeys.size, 0);
    assert.deepEqual(requested, ['base', 'char-0', 'char-1', 'negative']);
    delete sandbox.CanvasDakiFocus;
    assert.equal(sandbox.getDisabledClipPromptVisualState('base').tokenKeys.has('manual tag'), true);
});

function jsonCopy(value) {
    return JSON.parse(JSON.stringify(value));
}

function harness({focus = true, warningAllowed = true, prepareError = null,
    preparedFocusSequence = null,
    response = {ok: true, body: {status: 'success', src: 'synthetic-result'}}} = {}) {
    const events = [];
    const alerts = [];
    const warnings = [];
    const requests = [];
    const processing = [];
    const renders = [];
    const saves = [];
    const migrations = [];
    const folders = [];
    const originalPrompt = {
        basePrompt: 'linked selection prompt, blue eyes',
        negativePrompt: 'linked negative prompt',
        charPrompts: ['linked character prompt'],
        steps: 21,
    };
    const preparedPrompt = {
        basePrompt: 'linked selection prompt, blue eyes, close-up of the torso and shoulders',
        negativePrompt: 'linked negative prompt',
        charPrompts: ['linked character prompt'],
        steps: 17,
    };
    const clip = {
        id: 22,
        type: 'clip',
        src: 'synthetic-source-image',
        maskDataUrl: 'data:image/png;base64,synthetic-mask',
        promptOwnerId: 77,
        promptInfo: {basePrompt: 'legacy clip prompt'},
        promptControlGroups: [],
        imageWidth: 768,
        imageHeight: 1024,
        layerWidth: 300,
        layerHeight: 400,
        x: 18,
        y: 29,
    };
    const sibling = {id: 23, type: 'image', src: 'synthetic-sibling'};
    const selection = {
        id: 11,
        type: 'selection',
        children: [clip, sibling],
    };
    const originalChildren = [...selection.children];
    let prepareIndex = 0;
    const fetchResponse = {
        ok: response.ok,
        async json() { events.push('response.json'); return jsonCopy(response.body); },
    };
    const context = {
        canvasLayers: [selection],
        layerIdSeq: 100,
        activeLayerId: null,
        activeClipSelectionId: null,
        checkedSelectionId: null,
        isClipInpaintPreviewMode: false,
        isClipInpaintMergedSourceMode: false,
        clipMergedSourcePreviewSeq: 0,
        clipInpaintLoadingClipId: null,
        CANVAS_IMPORT_SESSION_ID: 'synthetic-session',
        structuredClone,
        buildEffectiveClipPromptInfo(actualClip) {
            events.push('build-effective-prompt');
            assert.equal(actualClip.type, 'clip');
            return jsonCopy(originalPrompt);
        },
        normalizePromptInfo(info) { return info; },
        CanvasDakiFocus: focus ? {
            async prepare(actualClip, promptInfo) {
                events.push('prepare');
                assert.equal(actualClip.type, 'clip');
                assert.deepEqual(jsonCopy(promptInfo), originalPrompt);
                if (prepareError) throw prepareError;
                const prepared = Array.isArray(preparedFocusSequence)
                    ? preparedFocusSequence[Math.min(prepareIndex, preparedFocusSequence.length - 1)]
                    : preparedFocusSequence;
                prepareIndex += 1;
                return jsonCopy({
                    promptInfo: preparedPrompt,
                    folderRegion: 'chest',
                    regions: ['chest'],
                    addedPrompt: 'close-up of the torso and shoulders',
                    ...(prepared || {}),
                });
            },
            resultFolder(actualSelection, prepared, makeId) {
                events.push('result-folder');
                folders.push(prepared && prepared.folderRegion);
                return prepared && prepared.folderRegion
                    ? Regions.ensureResultFolder(actualSelection, prepared.folderRegion, makeId)
                    : null;
            },
        } : undefined,
        showAnlasWarningModal: async details => {
            events.push('warning');
            warnings.push(jsonCopy(details));
            context.currentSelectedFocus = 'face';
            return warningAllowed;
        },
        currentSelectedFocus: 'chest',
        setClipInpaintProcessing(...args) {
            processing.push(args);
            context.clipInpaintLoadingClipId = args[1] ? args[0] : null;
            events.push(args[1] ? 'processing-on' : 'processing-off');
        },
        async fetch(url, options) {
            events.push('fetch');
            requests.push({url, options, body: JSON.parse(options.body)});
            return fetchResponse;
        },
        alert(message) { alerts.push(message); },
        clearClipMergedSourcePreviewCache() { renders.push('clear-preview-cache'); },
        migrateAllSelectionClipsToSharedPromptOwner(ownerId) { migrations.push(ownerId); },
        renderLayerList() { renders.push('layers'); },
        renderCanvasLayersOnSurface() { renders.push('canvas'); },
        renderClipOutputPanel() { renders.push('clip-panel'); },
        saveCanvasState() { saves.push(jsonCopy(selection)); },
        async renderMergedClipSourceToDataUrl() { throw new Error('unexpected merged-source render'); },
    };
    vm.createContext(context);
    vm.runInContext(extractedCanvasFunctions, context);
    return {context, events, alerts, warnings, requests, processing, renders, saves, migrations,
        folders, clip, sibling, selection, originalChildren, originalPrompt, preparedPrompt};
}

test('prepared linked prompt is sent and success lands in the frozen body folder under its selection', async () => {
    const h = harness();
    await h.context.requestClipInpainting(h.clip.id);

    assert.deepEqual(h.events.slice(0, 5), [
        'build-effective-prompt', 'prepare', 'warning', 'processing-on', 'fetch',
    ]);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/canvas/inpaint');
    assert.equal(h.requests[0].body.promptInfo.basePrompt, h.preparedPrompt.basePrompt);
    assert.deepEqual(h.requests[0].body.promptInfo.charPrompts, h.preparedPrompt.charPrompts);
    assert.equal(h.requests[0].body.mask, h.clip.maskDataUrl);
    assert.equal(h.requests[0].body.image, h.clip.src);
    assert.equal(h.requests[0].body.width, h.clip.imageWidth);
    assert.equal(h.requests[0].body.height, h.clip.imageHeight);
    assert.equal(h.requests[0].body.tempSessionId, 'synthetic-session');
    assert.equal(h.warnings[0].steps, h.preparedPrompt.steps);
    assert.equal(h.context.currentSelectedFocus, 'face');
    assert.deepEqual(h.folders, ['chest']);

    const bodyFolder = h.selection.children[0];
    assert.equal(bodyFolder.type, 'folder');
    assert.equal(bodyFolder.dakiRegion, 'chest');
    assert.equal(bodyFolder.name, Regions.REGIONS.find(region => region.id === 'chest').label);
    assert.deepEqual(h.selection.children.slice(1), h.originalChildren);
    assert.equal(bodyFolder.children.length, 1);
    const resultClip = bodyFolder.children[0];
    assert.equal(resultClip.type, 'clip');
    assert.equal(resultClip.sourceSelectionId, h.selection.id);
    assert.equal(resultClip.src, 'synthetic-result');
    assert.deepEqual(jsonCopy(resultClip.promptInfo), h.preparedPrompt);
    assert.deepEqual(jsonCopy(resultClip.dakiGenerationFocus), {
        region: 'chest', regions: ['chest'], prompt: 'close-up of the torso and shoulders',
    });
    assert.equal(h.selection.hasInpaintResult, true);
    assert.equal(h.selection.expanded, true);
    assert.deepEqual(h.migrations, [h.clip.promptOwnerId]);
    assert.deepEqual(h.processing.map(entry => entry[1]), [true, false]);
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].children[0].dakiRegion, 'chest');
    assert.deepEqual(h.renders, ['clear-preview-cache', 'layers', 'canvas', 'clip-panel']);
});

test('a selection reuses its first result folder after the prepared focus changes', async () => {
    const h = harness({preparedFocusSequence: [
        {folderRegion: 'chest', regions: ['chest'], addedPrompt: 'chest focus'},
        {folderRegion: 'face', regions: ['face'], addedPrompt: 'face focus'},
    ]});
    await h.context.requestClipInpainting(h.clip.id);
    const folder = h.selection.children[0];
    const folderId = folder.id;
    const folderName = folder.name;
    const preservedChild = {id: 88, type: 'image', src: 'synthetic-preserved-child'};
    folder.children.push(preservedChild);

    await h.context.requestClipInpainting(h.clip.id);

    assert.equal(h.selection.children.filter(child => child.type === 'folder').length, 1);
    assert.equal(h.selection.children[0], folder);
    assert.equal(folder.id, folderId);
    assert.equal(folder.name, folderName);
    assert.deepEqual(folder.children.map(child => child.dakiGenerationFocus?.region || child.src), [
        'face', 'chest', 'synthetic-preserved-child',
    ]);
    assert.equal(folder.children[0].dakiGenerationFocus.region, 'face');
    assert.equal(folder.children[1].dakiGenerationFocus.region, 'chest');
    assert.deepEqual(h.selection.children.slice(1), [h.clip, h.sibling]);
    assert.deepEqual(h.folders, ['chest']);
    assert.equal(h.context.layerIdSeq, 103);
});

test('an existing generic inpainting folder is reused while focus preparation is active', async () => {
    const h = harness();
    const existingChild = {id: 81, type: 'image', src: 'synthetic-existing-child'};
    const folder = {id: 80, type: 'folder', name: '인페인팅', expanded: false, children: [existingChild]};
    h.selection.children = [folder, h.clip, h.sibling];

    await h.context.requestClipInpainting(h.clip.id);

    assert.deepEqual(h.selection.children, [folder, h.clip, h.sibling]);
    assert.equal(folder.id, 80);
    assert.equal(folder.name, '인페인팅');
    assert.equal(folder.expanded, true);
    assert.equal(folder.children[0].dakiGenerationFocus.region, 'chest');
    assert.equal(folder.children[1], existingChild);
    assert.equal(h.context.layerIdSeq, 101);
});

test('a Daki region folder is reused without focus, with null focus, and with focus omitted', async () => {
    const h = harness({focus: false});
    const folder = {id: 90, type: 'folder', name: '가슴·어깨', dakiRegion: 'chest', expanded: false, children: null};
    h.selection.children = [folder, h.clip, h.sibling];

    await h.context.requestClipInpainting(h.clip.id);

    assert.deepEqual(h.selection.children, [folder, h.clip, h.sibling]);
    assert.equal(folder.expanded, true);
    assert.equal(folder.children.length, 1);
    assert.equal(folder.children[0].dakiGenerationFocus, undefined);

    const omittedFolder = {id: 92, type: 'folder', name: 'Old region label', dakiRegion: 'face', children: []};
    const omittedSelection = {id: 91, type: 'selection', children: [omittedFolder]};
    const nullFolder = {id: 94, type: 'folder', name: 'Legacy region', dakiRegion: 'hands', children: []};
    const nullSelection = {id: 93, type: 'selection', children: [nullFolder]};
    const nextId = h.context.layerIdSeq;

    assert.equal(h.context.getOrCreateSelectionInpaintFolder(omittedSelection), omittedFolder);
    assert.equal(h.context.getOrCreateSelectionInpaintFolder(nullSelection, null), nullFolder);
    assert.equal(h.context.layerIdSeq, nextId);

    const uninitializedSelection = {id: 95, type: 'selection', children: null};
    const createdFolder = h.context.getOrCreateSelectionInpaintFolder(uninitializedSelection);
    assert.ok(Array.isArray(uninitializedSelection.children));
    assert.equal(uninitializedSelection.children[0], createdFolder);
    assert.equal(createdFolder.name, '인페인팅');
    assert.equal(h.context.layerIdSeq, nextId + 1);
});

test('an unrelated empty folder is left intact while a result folder is created', async () => {
    const h = harness();
    const unrelated = {id: 80, type: 'folder', name: 'References', expanded: false, children: []};
    h.selection.children = [unrelated, h.clip, h.sibling];

    await h.context.requestClipInpainting(h.clip.id);

    const resultFolder = h.selection.children[0];
    assert.equal(resultFolder.type, 'folder');
    assert.equal(resultFolder.dakiRegion, 'chest');
    assert.notEqual(resultFolder, unrelated);
    assert.deepEqual(h.selection.children.slice(1), [unrelated, h.clip, h.sibling]);
    assert.deepEqual(unrelated, {id: 80, type: 'folder', name: 'References', expanded: false, children: []});
});

test('different selections keep their inpainting results in separate folders', async () => {
    const h = harness({preparedFocusSequence: [
        {folderRegion: 'chest', regions: ['chest'], addedPrompt: 'chest focus'},
        {folderRegion: 'face', regions: ['face'], addedPrompt: 'face focus'},
    ]});
    const secondClip = {
        id: 32, type: 'clip', src: 'synthetic-second-source', maskDataUrl: 'synthetic-second-mask',
        imageWidth: 512, imageHeight: 512, layerWidth: 256, layerHeight: 256,
    };
    const secondSelection = {id: 31, type: 'selection', children: [secondClip]};
    h.context.canvasLayers.push(secondSelection);

    await h.context.requestClipInpainting(h.clip.id);
    await h.context.requestClipInpainting(secondClip.id);

    const firstFolder = h.selection.children.find(child => child.type === 'folder');
    const secondFolder = secondSelection.children.find(child => child.type === 'folder');
    assert.ok(firstFolder);
    assert.ok(secondFolder);
    assert.notEqual(firstFolder.id, secondFolder.id);
    assert.equal(firstFolder.children[0].sourceSelectionId, h.selection.id);
    assert.equal(secondFolder.children[0].sourceSelectionId, secondSelection.id);
    assert.equal(firstFolder.dakiRegion, 'chest');
    assert.equal(secondFolder.dakiRegion, 'face');
});

test('when several result folders exist, the first is reused and later folders remain untouched', async () => {
    const h = harness();
    const firstExistingResult = {id: 111, type: 'clip', renderOnCanvas: true, sourceSelectionId: 11, src: 'first-existing'};
    const laterExistingResult = {id: 113, type: 'clip', renderOnCanvas: true, sourceSelectionId: 11, src: 'later-existing'};
    const firstFolder = {id: 110, type: 'folder', name: 'Chest folder', dakiRegion: 'chest', children: [firstExistingResult]};
    const laterFolder = {id: 112, type: 'folder', name: 'Face folder', dakiRegion: 'face', children: [laterExistingResult]};
    h.selection.children = [firstFolder, laterFolder, h.clip, h.sibling];
    const nextId = h.context.layerIdSeq;

    await h.context.requestClipInpainting(h.clip.id);

    assert.deepEqual(h.selection.children, [firstFolder, laterFolder, h.clip, h.sibling]);
    assert.equal(firstFolder.children[0].dakiGenerationFocus.region, 'chest');
    assert.equal(firstFolder.children[1], firstExistingResult);
    assert.deepEqual(laterFolder.children, [laterExistingResult]);
    assert.equal(h.context.layerIdSeq, nextId + 1);
});

test('a renamed legacy result folder is matched only by a result from the same selection', async () => {
    const h = harness();
    const matchingResult = {id: 121, type: 'clip', renderOnCanvas: true, sourceSelectionId: 11, src: 'same-selection'};
    const otherSelectionResult = {id: 123, type: 'clip', renderOnCanvas: true, sourceSelectionId: 999, src: 'other-selection'};
    const legacyFolder = {id: 120, type: 'folder', name: 'Archived output', children: [matchingResult]};
    const otherFolder = {id: 122, type: 'folder', name: 'Unrelated output', children: [otherSelectionResult]};
    h.selection.children = [otherFolder, legacyFolder, h.clip, h.sibling];
    const nextId = h.context.layerIdSeq;

    await h.context.requestClipInpainting(h.clip.id);

    assert.deepEqual(h.selection.children, [otherFolder, legacyFolder, h.clip, h.sibling]);
    assert.equal(legacyFolder.name, 'Archived output');
    assert.equal(legacyFolder.dakiRegion, undefined);
    assert.equal(legacyFolder.children[0].dakiGenerationFocus.region, 'chest');
    assert.equal(legacyFolder.children[1], matchingResult);
    assert.deepEqual(otherFolder.children, [otherSelectionResult]);
    assert.equal(h.context.layerIdSeq, nextId + 1);
});

test('focus preparation failure stops before the warning and before any request', async () => {
    const h = harness({prepareError: new Error('invalid focus map')});
    await h.context.requestClipInpainting(h.clip.id);
    assert.deepEqual(h.events, ['build-effective-prompt', 'prepare']);
    assert.equal(h.warnings.length, 0);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.selection.children, h.originalChildren);
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /invalid focus map/);
    assert.deepEqual(h.processing, []);
});

test('Anlas warning remains a gate and cancellation creates no request or result folder', async () => {
    const h = harness({warningAllowed: false});
    await h.context.requestClipInpainting(h.clip.id);
    assert.deepEqual(h.events, ['build-effective-prompt', 'prepare', 'warning']);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.selection.children, h.originalChildren);
    assert.deepEqual(h.processing, []);
    assert.equal(h.alerts.length, 0);
});

test('failed inpaint response does not create a body or result folder', async () => {
    const h = harness({response: {ok: false, body: {status: 'error', message: 'synthetic failure'}}});
    await h.context.requestClipInpainting(h.clip.id);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.selection.children, h.originalChildren);
    assert.equal(h.selection.hasInpaintResult, undefined);
    assert.deepEqual(h.folders, []);
    assert.equal(h.alerts.length, 1);
    assert.match(h.alerts[0], /synthetic failure/);
    assert.deepEqual(h.processing.map(entry => entry[1]), [true, false]);
});

test('legacy canvas without Daki focus still sends the original prompt and uses its inpainting folder', async () => {
    const h = harness({focus: false});
    await h.context.requestClipInpainting(h.clip.id);
    assert.equal(h.warnings.length, 1);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0].body.promptInfo, h.originalPrompt);
    const folder = h.selection.children[0];
    assert.equal(folder.name, '인페인팅');
    assert.equal(folder.type, 'folder');
    assert.equal(folder.children.length, 1);
    assert.equal(folder.children[0].dakiGenerationFocus, undefined);
    assert.deepEqual(h.selection.children.slice(1), h.originalChildren);
});
