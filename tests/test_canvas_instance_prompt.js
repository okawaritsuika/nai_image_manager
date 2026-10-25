const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const setupsSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_setups.js'), 'utf8');

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

function installFunctions(context, source, names) {
    vm.runInContext(names.map(name => extractFunction(source, name)).join('\n'), context);
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function makeCanvasContext(layers, sharedPrompt = {basePrompt: 'shared base'}) {
    const context = {
        canvasLayers: layers,
        sharedSelectionClipPromptInfo: sharedPrompt,
        sharedSelectionClipPromptControlGroups: [],
        structuredClone,
        console: {warn() {}},
        findCanvasLayer(id) {
            let found = null;
            const visit = items => items.forEach(layer => {
                if (Number(layer.id) === Number(id)) found = layer;
                if (Array.isArray(layer.children)) visit(layer.children);
            });
            visit(context.canvasLayers);
            return found ? {layer: found} : null;
        },
        getAllClipLayers() {
            const clips = [];
            const visit = items => items.forEach(layer => {
                if (layer.type === 'clip') clips.push(layer);
                if (Array.isArray(layer.children)) visit(layer.children);
            });
            visit(context.canvasLayers);
            return clips;
        }
    };
    vm.createContext(context);
    return context;
}

const sharedPromptFunctions = [
    'parseClipPromptTokens',
    'joinClipPromptTokens',
    'stripClipWeightMarkers',
    'normalizeClipTokenForGroup',
    'normalizeClipPromptControlField',
    'applyDisabledClipPromptControlGroups',
    'normalizeCharPromptList',
    'buildLegacyCharPromptText',
    'pickNegativePromptText',
    'normalizePromptInfo',
    'hasAnyPromptText',
    'hasSharedSelectionClipPrompt',
    'getSharedSelectionClipPromptInfo',
    'rememberSharedSelectionClipPrompt',
    'applySharedSelectionPromptToClip',
    'findSelectionParentForLayerId',
    'getPromptOwnerLayer',
    'syncPromptStateFromOwner',
    'migrateAllSelectionClipsToSharedPromptOwner',
    'getClipInstancePrompt'
];

function installSharedPromptFunctions(context) {
    installFunctions(context, canvasSource, sharedPromptFunctions);
    context.ensureClipPromptControlGroups = clip => {
        if (!Array.isArray(clip.promptControlGroups)) clip.promptControlGroups = [];
        return clip.promptControlGroups;
    };
    context.applyCanvasInpaintSettingsToPromptInfo = info => context.normalizePromptInfo(info);
}

function makeBuildHarness() {
    const groups = [{
        id: 1,
        enabled: false,
        items: [{field: 'base', type: 'token', token: 'remove'}]
    }];
    const layers = [
        {id: 10, type: 'selection', instancePrompt: ' instance A ', children: [
            {id: 11, type: 'clip', promptInfo: {basePrompt: 'legacy clip base'}},
            {id: 12, type: 'clip'}
        ]},
        {id: 20, type: 'selection', instancePrompt: 'instance B', children: [
            {id: 21, type: 'clip'}
        ]},
        {id: 30, type: 'selection', children: [
            {id: 31, type: 'clip'}
        ]},
        {id: 40, type: 'selection', instancePrompt: 42, children: [
            {id: 41, type: 'clip'}
        ]},
        {id: 50, type: 'selection', instancePrompt: '   ', children: [
            {id: 51, type: 'clip'}
        ]}
    ];
    const context = makeCanvasContext(layers, {
        basePrompt: 'shared base, remove, keep',
        negativePrompt: 'shared negative',
        charPrompts: ['shared character']
    });
    context.sharedSelectionClipPromptControlGroups = groups;
    installSharedPromptFunctions(context);
    installFunctions(context, canvasSource, ['applyCanvasInpaintSettingsToPromptInfo', 'buildEffectiveClipPromptInfo']);
    return context;
}

test('effective prompt isolates instance text by selection and appends after disabled base tokens', () => {
    const context = makeBuildHarness();
    const [selectionA, selectionB, legacySelection] = context.canvasLayers;
    const firstClip = selectionA.children[0];
    const siblingClip = selectionA.children[1];
    const otherClip = selectionB.children[0];

    const first = plain(context.buildEffectiveClipPromptInfo(firstClip));
    const sibling = plain(context.buildEffectiveClipPromptInfo(siblingClip));
    const other = plain(context.buildEffectiveClipPromptInfo(otherClip));
    const repeated = plain(context.buildEffectiveClipPromptInfo(firstClip));

    assert.equal(first.basePrompt, 'shared base, keep, instance A');
    assert.equal(repeated.basePrompt, first.basePrompt);
    assert.equal(sibling.basePrompt, first.basePrompt);
    assert.equal(other.basePrompt, 'shared base, keep, instance B');
    assert.equal(first.negativePrompt, 'shared negative');
    assert.deepEqual(first.charPrompts, ['shared character']);
    assert.equal(firstClip.promptInfo.basePrompt, 'shared base, remove, keep');
    assert.equal(Object.hasOwn(firstClip.promptInfo, 'instancePrompt'), false);
    assert.equal(Object.hasOwn(context.sharedSelectionClipPromptInfo, 'instancePrompt'), false);
    assert.equal(selectionA.instancePrompt, ' instance A ');
    assert.equal(legacySelection.instancePrompt, undefined);
});

test('instance negative prompts stay within their selection and append once after filtered shared negatives', () => {
    const context = makeBuildHarness();
    const [selectionA, selectionB] = context.canvasLayers;
    selectionA.instanceNegativePrompt = '  avoid A  ';
    selectionB.instanceNegativePrompt = 'avoid B';
    context.sharedSelectionClipPromptInfo.negativePrompt = 'shared negative, remove';
    context.sharedSelectionClipPromptControlGroups[0].items.push({field: 'negative', type: 'token', token: 'remove'});
    const first = context.buildEffectiveClipPromptInfo(selectionA.children[0]);
    assert.equal(first.negativePrompt, 'shared negative, avoid A');
    assert.equal(context.buildEffectiveClipPromptInfo(selectionA.children[1]).negativePrompt, first.negativePrompt);
    assert.equal(context.buildEffectiveClipPromptInfo(selectionB.children[0]).negativePrompt, 'shared negative, avoid B');
    assert.equal(context.buildEffectiveClipPromptInfo(selectionA.children[0]).negativePrompt, first.negativePrompt);
    assert.equal(selectionA.children[0].promptInfo.negativePrompt, 'shared negative, remove');
    assert.equal(Object.hasOwn(context.sharedSelectionClipPromptInfo, 'instanceNegativePrompt'), false);
    context.sharedSelectionClipPromptInfo.negativePrompt = '';
    assert.equal(context.buildEffectiveClipPromptInfo(selectionA.children[0]).negativePrompt, 'avoid A');
    for (const value of [undefined, 42, '   ']) {
        selectionA.instanceNegativePrompt = value;
        assert.equal(context.getClipInstancePrompt(selectionA.children[0], 'instanceNegativePrompt'), '');
    }
});

test('missing, non-string, and whitespace instance prompts resolve to empty without changing legacy prompt data', () => {
    const context = makeBuildHarness();
    const clips = context.canvasLayers.slice(2).map(selection => selection.children[0]);

    assert.deepEqual(clips.map(clip => context.getClipInstancePrompt(clip)), ['', '', '']);
    assert.equal(clips[0].promptInfo, undefined);
    assert.equal(Object.hasOwn(context.sharedSelectionClipPromptInfo, 'instancePrompt'), false);
});

function makeSaveHarness(settings = {steps: 17}) {
    const layers = [
        {id: 100, type: 'selection', instancePrompt: 'old A', children: [
            {id: 101, type: 'clip', promptOwnerId: 101, promptInfo: {basePrompt: 'old shared'}, promptControlGroups: []},
            {id: 102, type: 'clip', promptOwnerId: 101, promptInfo: {basePrompt: 'old shared'}, promptControlGroups: []}
        ]},
        {id: 200, type: 'selection', instancePrompt: 'preserve B', instanceNegativePrompt: 'preserve negative B', children: [
            {id: 201, type: 'clip', promptOwnerId: 101, promptInfo: {basePrompt: 'old shared'}, promptControlGroups: []}
        ]}
    ];
    const context = makeCanvasContext(layers, {basePrompt: 'old shared', negativePrompt: 'old negative'});
    const calls = {settings: 0, saves: 0, closes: 0, settingUpdates: 0};
    const inputs = new Map([
        ['clipInstancePromptInput', {value: '  instance A  '}],
        ['clipInstanceNegativePromptInput', {value: '  avoid A  '}]
    ]);
    context.activeClipPromptId = 101;
    context.el = id => inputs.get(id) || null;
    context.getClipCharPromptValues = () => ['updated character'];
    context.getClipPromptEditorValue = kind => kind === 'base' ? 'updated shared base' : 'updated negative';
    context.readGenerationSettings = () => { calls.settings += 1; return settings; };
    context.CanvasInpaintSettings = {update() { calls.settingUpdates += 1; }};
    context.saveCanvasState = () => { calls.saves += 1; };
    context.closeClipPromptModal = () => { calls.closes += 1; };
    installSharedPromptFunctions(context);
    context.getPromptOwnerLayer = layer => layer;
    installFunctions(context, canvasSource, ['saveClipPromptModal']);
    return {context, calls, inputs};
}

test('saving updates shared base and only the active selection instance prompt', () => {
    const {context, calls} = makeSaveHarness();
    context.saveClipPromptModal();

    const [selectionA, selectionB] = context.canvasLayers;
    const [clip, siblingClip] = selectionA.children;
    const otherClip = selectionB.children[0];
    assert.equal(selectionA.instancePrompt, 'instance A');
    assert.equal(selectionB.instancePrompt, 'preserve B');
    assert.equal(selectionA.instanceNegativePrompt, 'avoid A');
    assert.equal(selectionB.instanceNegativePrompt, 'preserve negative B');
    assert.equal(context.sharedSelectionClipPromptInfo.negativePrompt, 'updated negative');
    assert.equal(Object.hasOwn(clip.promptInfo, 'instanceNegativePrompt'), false);
    assert.equal(context.getClipInstancePrompt(clip), 'instance A');
    assert.equal(context.getClipInstancePrompt(siblingClip), 'instance A');
    assert.equal(context.getClipInstancePrompt(otherClip), 'preserve B');
    assert.equal(context.sharedSelectionClipPromptInfo.basePrompt, 'updated shared base');
    assert.equal(clip.promptInfo.basePrompt, 'updated shared base');
    assert.equal(siblingClip.promptInfo.basePrompt, 'updated shared base');
    assert.equal(otherClip.promptInfo.basePrompt, 'updated shared base');
    assert.equal(Object.hasOwn(context.sharedSelectionClipPromptInfo, 'instancePrompt'), false);
    assert.equal(Object.hasOwn(clip.promptInfo, 'instancePrompt'), false);
    assert.deepEqual(calls, {settings: 1, saves: 1, closes: 1, settingUpdates: 1});
});

test('invalid generation settings leave selection and shared prompt state untouched', () => {
    const {context, calls} = makeSaveHarness(null);
    const beforeShared = JSON.stringify(context.sharedSelectionClipPromptInfo);
    const beforeLayers = JSON.stringify(context.canvasLayers);
    context.saveClipPromptModal();

    assert.equal(JSON.stringify(context.sharedSelectionClipPromptInfo), beforeShared);
    assert.equal(JSON.stringify(context.canvasLayers), beforeLayers);
    assert.deepEqual(calls, {settings: 1, saves: 0, closes: 0, settingUpdates: 0});
});

test('canvas snapshot and restore preserve the optional selection instance prompt', () => {
    const layers = [{id: 300, type: 'selection', instancePrompt: 'snapshot instance', instanceNegativePrompt: 'snapshot negative', children: [
        {id: 301, type: 'clip', promptOwnerId: 301, promptInfo: {basePrompt: 'shared base'}, promptControlGroups: []}
    ]}];
    const context = makeCanvasContext(layers, {basePrompt: 'shared base'});
    Object.assign(context, {
        currentCanvasWidth: 640,
        currentCanvasHeight: 960,
        activeLayerId: 301,
        layerIdSeq: 302,
        sharedSelectionClipPromptControlGroups: [],
        isSelectionOverlayHidden: false,
        checkedSelectionId: null,
        canvasZoom: 1,
        clipPreviewZoom: 1,
        isClipInpaintMergedSourceMode: false,
        clipPromptGroups: [],
        getCanvasStyleLink: () => null,
        normalizeSharedPromptGroups: () => [],
        normalizeCanvasLayerTree() {},
        syncAllPromptCopiesFromOwners() {},
        syncClipPromptControlGroupSeqFromAllLayers() {},
        refreshPinnedReferenceStateFromLayers() {},
        ensureCheckedSelectionId() {},
        updateSelectionOverlayToggleUI() {},
        renderCanvas() {},
        renderLayerList() {},
        updateCanvasRatioInfo() {},
        migrateCanvasLayerDataUrlsToServer() {},
        resetCanvasEditHistory() {}
    });
    installSharedPromptFunctions(context);
    installFunctions(context, canvasSource, ['clearClipInpaintMask', 'cloneCanvasLayersForState', 'buildCanvasStateSnapshot']);
    installFunctions(context, setupsSource, ['applyCanvasStateSnapshot']);

    const snapshot = context.buildCanvasStateSnapshot();
    context.canvasLayers[0].instancePrompt = 'mutated after snapshot';
    context.canvasLayers[0].instanceNegativePrompt = 'mutated negative';
    context.sharedSelectionClipPromptInfo.basePrompt = 'mutated shared base';
    context.applyCanvasStateSnapshot(snapshot);

    const restoredSelection = context.findSelectionParentForLayerId(301);
    assert.equal(restoredSelection.instancePrompt, 'snapshot instance');
    assert.equal(restoredSelection.instanceNegativePrompt, 'snapshot negative');
    assert.equal(context.getClipInstancePrompt(context.canvasLayers[0].children[0]), 'snapshot instance');
    assert.equal(context.sharedSelectionClipPromptInfo.basePrompt, 'shared base');
    assert.equal(context.canvasLayers[0].children[0].promptInfo.basePrompt, 'shared base');
});

test('instance prompt tabs toggle visibility without changing prompt values or shared prompt tabs', () => {
    const makeButton = active => {
        const classes = new Set(active ? ['active'] : []);
        const attributes = new Map([['aria-pressed', String(active)]]);
        return {
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                toggle(name, force) {
                    if (force) classes.add(name);
                    else classes.delete(name);
                },
                contains(name) { return classes.has(name); }
            },
            setAttribute(name, value) { attributes.set(name, value); },
            getAttribute(name) { return attributes.get(name); }
        };
    };
    const elements = new Map([
        ['clipInstanceTabBaseBtn', makeButton(true)],
        ['clipInstanceTabNegativeBtn', makeButton(false)],
        ['clipInstanceTabBase', {hidden: false}],
        ['clipInstanceTabNegative', {hidden: true}],
        ['clipInstancePromptInput', {value: 'base instance text'}],
        ['clipInstanceNegativePromptInput', {value: 'negative instance text'}],
        ['clipBtnTabBase', makeButton(true)],
        ['clipBtnTabNegative', makeButton(false)],
        ['clipTabBase', {style: {display: 'block'}}],
        ['clipTabNegative', {style: {display: 'none'}}]
    ]);
    const context = {el: id => elements.get(id) || null};
    vm.createContext(context);
    installFunctions(context, canvasSource, ['switchClipInstancePromptTab']);

    context.switchClipInstancePromptTab('negative');

    assert.equal(elements.get('clipInstanceTabBase').hidden, true);
    assert.equal(elements.get('clipInstanceTabNegative').hidden, false);
    assert.equal(elements.get('clipInstanceTabBaseBtn').classList.contains('active'), false);
    assert.equal(elements.get('clipInstanceTabNegativeBtn').classList.contains('active'), true);
    assert.equal(elements.get('clipInstanceTabBaseBtn').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('clipInstanceTabNegativeBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('clipInstancePromptInput').value, 'base instance text');
    assert.equal(elements.get('clipInstanceNegativePromptInput').value, 'negative instance text');
    assert.equal(elements.get('clipTabBase').style.display, 'block');
    assert.equal(elements.get('clipTabNegative').style.display, 'none');

    context.switchClipInstancePromptTab('base');

    assert.equal(elements.get('clipInstanceTabBase').hidden, false);
    assert.equal(elements.get('clipInstanceTabNegative').hidden, true);
    assert.equal(elements.get('clipInstanceTabBaseBtn').classList.contains('active'), true);
    assert.equal(elements.get('clipInstanceTabNegativeBtn').classList.contains('active'), false);
    assert.equal(elements.get('clipInstanceTabBaseBtn').getAttribute('aria-pressed'), 'true');
    assert.equal(elements.get('clipInstanceTabNegativeBtn').getAttribute('aria-pressed'), 'false');
    assert.equal(elements.get('clipInstancePromptInput').value, 'base instance text');
    assert.equal(elements.get('clipInstanceNegativePromptInput').value, 'negative instance text');
});

test('instance prompt tab switch is safe when its controls are unavailable', () => {
    const context = {el: () => null};
    vm.createContext(context);
    installFunctions(context, canvasSource, ['switchClipInstancePromptTab']);

    assert.doesNotThrow(() => context.switchClipInstancePromptTab('base'));
});
