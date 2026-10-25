'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Regions = require('../static/canvas_daki_regions.js');
const PromptRules = require('../static/canvas_daki_prompt_rules.js');
const focusSource = require('node:fs').readFileSync(require.resolve('../static/canvas_daki_focus.js'), 'utf8');

class FakeClassList {
    constructor(owner) { this.owner = owner; this.values = new Set(); }
    add(value) { this.values.add(value); this.sync(); }
    remove(value) { this.values.delete(value); this.sync(); }
    contains(value) { return this.values.has(value); }
    toggle(value, force) {
        const enabled = force === undefined ? !this.contains(value) : Boolean(force);
        if (enabled) this.values.add(value); else this.values.delete(value);
        this.sync();
        return enabled;
    }
    sync() { this.owner._className = Array.from(this.values).join(' '); }
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = String(tagName).toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.attributes = new Map();
        this.classList = new FakeClassList(this);
        this.style = {};
        this.value = '';
        this.disabled = false;
        this.hidden = false;
        this._textContent = '';
    }
    set className(value) {
        this._className = String(value || '');
        this.classList.values = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    get className() { return this._className || ''; }
    set textContent(value) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this._textContent = String(value ?? '');
    }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
    append(...nodes) {
        for (const node of nodes) {
            if (node.parentNode) node.parentNode.removeChild(node);
            this.children.push(node);
            node.parentNode = this;
        }
    }
    appendChild(node) { this.append(node); return node; }
    replaceChildren(...nodes) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this._textContent = '';
        this.append(...nodes);
    }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    querySelector(selector) {
        if (!selector.startsWith('.')) return null;
        const className = selector.slice(1);
        return find(this, node => node !== this && node.classList.contains(className));
    }
}

class FakeDocument {
    constructor() {
        this.body = new FakeElement('body', this);
        this.listeners = new Map();
    }
    createElement(tagName) { return new FakeElement(tagName, this); }
    getElementById(id) { return find(this.body, node => node.id === id); }
    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
    }
}

function find(root, predicate) {
    if (predicate(root)) return root;
    for (const child of root.children) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}

function byClass(root, className) {
    const node = find(root, item => item.classList?.contains(className));
    assert.ok(node, `missing .${className}`);
    return node;
}

function byAttribute(root, name, value) {
    const node = find(root, item => item.getAttribute?.(name) === value);
    assert.ok(node, `missing [${name}="${value}"]`);
    return node;
}

function invoke(node, handler, event = {}) {
    assert.equal(typeof node[handler], 'function', `missing ${handler} handler`);
    node[handler]({target: node, ...event});
}

function classification(token) {
    if (token === 'blue eyes') return {token, tag: 'blue_eyes', regions: ['face'], sections: ['face.eyes']};
    if (token === 'shirt') return {token, tag: 'shirt', regions: ['chest'], sections: ['chest.clothes']};
    return {token, tag: null, regions: [], sections: []};
}

function createHarness({linked = true, selectedId = 'selection-1'} = {}) {
    const document = new FakeDocument();
    const hud = document.createElement('div'); hud.id = 'canvasDakiFocus';
    const promptFocus = document.createElement('div'); promptFocus.id = 'canvasDakiPromptFocus';
    const overlay = document.createElement('div'); overlay.id = 'clipPromptModalOverlay';
    const mapPanel = document.createElement('div'); mapPanel.id = 'canvasDakiMapPanel'; mapPanel.hidden = true;
    const canvasSurface = document.createElement('div'); canvasSurface.id = 'canvasSurface';
    const canvasStage = document.createElement('div'); canvasStage.id = 'canvasStage';
    document.body.append(hud, promptFocus, overlay, mapPanel, canvasSurface, canvasStage);

    const layers = new Map();
    const selectionParents = new Map();
    const clipsBySelection = new Map();
    const microtasks = [];
    const editorOpens = [];
    const fieldRenderCalls = [];
    let fetchCount = 0;
    let saveCount = 0;
    let activeEditor = null;
    let editorCloseCount = 0;
    let editorSyncCount = 0;
    let rasterRenderCount = 0;
    const sandbox = {
        console,
        document,
        CanvasDakiRegions: Regions,
        CanvasDakiPromptRules: PromptRules,
        CanvasProject: {localLink: () => linked ? {projectId: 'synthetic-project', canvasId: 'synthetic-canvas', side: 'front'} : null},
        canvasLayers: {},
        currentCanvasWidth: 1200,
        currentCanvasHeight: 800,
        activeLayerId: selectedId,
        activeClipPromptId: null,
        findCanvasLayer: id => layers.has(id) ? {layer: layers.get(id)} : null,
        findSelectionParentForLayerId: id => selectionParents.get(id) || null,
        getEditableClipForSelection: selection => clipsBySelection.get(selection.id) || null,
        getAllSelectionLayers: () => Array.from(layers.values()).filter(layer => layer.type === 'selection'),
        getClipPromptEditorValue: field => field === 'base' ? 'blue eyes, shirt' : 'red eyes',
        getClipCharPromptValues: () => ['shirt'],
        getClipPromptFields: () => [{key: 'base'}, {key: 'negative'}, {key: 'char-0'}],
        renderClipPromptTokens: field => { fieldRenderCalls.push(field); },
        buildEffectiveClipPromptInfo: () => ({basePrompt: 'blue eyes, shirt', charPrompts: ['shirt'], negativePrompt: 'red eyes'}),
        getSharedSelectionClipPromptInfo: () => ({basePrompt: '', charPrompts: [], negativePrompt: ''}),
        buildLegacyCharPromptText: prompts => prompts.join('\n'),
        parseClipPromptTokens: text => String(text || '').split(',').map(token => token.trim()).filter(Boolean),
        queueMicrotask: callback => microtasks.push(callback),
        setTimeout: () => 1,
        clearTimeout: () => {},
        saveCanvasState: () => { saveCount += 1; },
        fetch: async (url, options) => {
            assert.equal(url, '/api/daki/tag-catalog/classify');
            assert.equal(options.method, 'POST');
            fetchCount += 1;
            const tokens = JSON.parse(options.body).tokens;
            return {ok: true, json: async () => ({status: 'success', items: tokens.map(classification)})};
        },
        renderMergedCanvasToDataUrl: () => {
            rasterRenderCount += 1;
            throw new Error('inline map editing must not rasterize a preview');
        },
        CanvasDakiMapEditor: {
            open: options => { activeEditor = options; editorOpens.push(options); return options; },
            close: () => {
                editorCloseCount += 1;
                const options = activeEditor;
                activeEditor = null;
                options?.onClose?.();
            },
            sync: () => { editorSyncCount += 1; },
        },
        showToast: message => { sandbox.lastToast = message; },
        openClipPromptModal: id => {
            sandbox.activeClipPromptId = id;
            overlay.classList.add('open');
            sandbox.CanvasDakiFocus.refresh();
        },
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    vm.runInContext(focusSource, context, {filename: 'canvas_daki_focus.js'});

    async function flush() {
        for (let pass = 0; pass < 12; pass += 1) {
            while (microtasks.length) microtasks.shift()();
            await new Promise(resolve => setImmediate(resolve));
            if (!microtasks.length) return;
        }
        assert.fail('scheduled canvas focus renders did not settle');
    }

    return {
        context,
        focus: sandbox.CanvasDakiFocus,
        document,
        hud,
        promptFocus,
        overlay,
        mapPanel,
        canvasSurface,
        canvasStage,
        layers,
        editorOpens,
        flush,
        refresh: async () => { sandbox.CanvasDakiFocus.refresh(); await flush(); },
        addSelection(id, dakiFocus = {}) {
            const selection = {id, type: 'selection', name: `Selection ${id}`, children: [], dakiFocus};
            layers.set(id, selection);
            return selection;
        },
        addClip(id, selection) {
            const clip = {id, type: 'clip'};
            layers.set(id, clip);
            selectionParents.set(id, selection);
            clipsBySelection.set(selection.id, clip);
            return clip;
        },
        setSelection(id) { sandbox.activeLayerId = id; },
        setDimensions(width, height) {
            sandbox.currentCanvasWidth = width;
            sandbox.currentCanvasHeight = height;
        },
        fetchCount: () => fetchCount,
        fieldRenderCalls: () => [...fieldRenderCalls],
        saveCount: () => saveCount,
        editorCloseCount: () => editorCloseCount,
        editorSyncCount: () => editorSyncCount,
        rasterRenderCount: () => rasterRenderCount,
    };
}

test('a linked selection shows its resolved body region in the collapsed HUD without classifying tags', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();

        assert.equal(h.hud.hidden, false);
        assert.equal(byClass(h.hud, 'canvas-daki-hud-label').textContent, '가슴·어깨');
        assert.equal(byClass(h.hud, 'canvas-daki-hud-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(byClass(h.hud, 'canvas-daki-hud-controls').hidden, true);
        assert.equal(h.fetchCount(), 0);
    } finally {
        h.focus.restore(null);
    }
});

test('expanded and collapsed HUD toggles preserve the resolved summary and accessibility state', async () => {
    const h = createHarness();
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        await h.refresh();

        invoke(byClass(h.hud, 'canvas-daki-hud-toggle'), 'onclick');
        await h.flush();
        assert.equal(byClass(h.hud, 'canvas-daki-hud-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(byClass(h.hud, 'canvas-daki-hud-controls').hidden, false);
        assert.equal(byClass(h.hud, 'canvas-daki-hud-label').textContent, '가슴·어깨');

        invoke(byClass(h.hud, 'canvas-daki-hud-toggle'), 'onclick');
        await h.flush();
        assert.equal(byClass(h.hud, 'canvas-daki-hud-toggle').getAttribute('aria-expanded'), 'false');
        assert.equal(byClass(h.hud, 'canvas-daki-hud-controls').hidden, true);
        assert.equal(byClass(h.hud, 'canvas-daki-hud-label').textContent, '가슴·어깨');
    } finally {
        h.focus.restore(null);
    }
});

test('moving the HUD to the other top margin survives a later selection change', async () => {
    const h = createHarness();
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        const next = h.addSelection('selection-2', {mode: 'manual', regions: ['arms']});
        await h.refresh();

        const move = byAttribute(h.hud, 'aria-label', '부위 표시를 오른쪽 위로 이동');
        assert.equal(move.textContent, '→');
        assert.equal(move.title, '오른쪽 위로 이동');
        assert.equal(move.parentNode.hidden, false);
        invoke(move, 'onclick');
        await h.flush();
        assert.equal(h.hud.dataset.side, 'right');
        assert.equal(byAttribute(h.hud, 'aria-label', '부위 표시를 왼쪽 위로 이동').textContent, '←');

        h.setSelection('selection-2');
        h.focus.selectionChanged(next);
        await h.flush();
        assert.equal(h.hud.dataset.side, 'right');
        assert.equal(byClass(h.hud, 'canvas-daki-hud-label').textContent, '팔');
    } finally {
        h.focus.restore(null);
    }
});

test('the region dropdown saves manual and automatic choices only on the active selection', async () => {
    const h = createHarness();
    try {
        const selected = h.addSelection('selection-1', {mode: 'auto', regions: []});
        const other = h.addSelection('selection-2', {mode: 'manual', regions: ['feet'], note: 'untouched'});
        await h.refresh();
        const choices = byAttribute(h.hud, 'aria-label', '선택 영역의 부위');

        choices.value = 'face';
        invoke(choices, 'onchange');
        await h.flush();
        assert.equal(selected.dakiFocus.mode, 'manual');
        assert.deepEqual(Array.from(selected.dakiFocus.regions), ['face']);
        assert.deepEqual(other.dakiFocus, {mode: 'manual', regions: ['feet'], note: 'untouched'});
        assert.equal(h.saveCount(), 1);

        const refreshedChoices = byAttribute(h.hud, 'aria-label', '선택 영역의 부위');
        refreshedChoices.value = 'auto';
        invoke(refreshedChoices, 'onchange');
        await h.flush();
        assert.equal(selected.dakiFocus.mode, 'auto');
        assert.deepEqual(Array.from(selected.dakiFocus.regions), []);
        assert.deepEqual(other.dakiFocus, {mode: 'manual', regions: ['feet'], note: 'untouched'});
        assert.equal(h.saveCount(), 2);
    } finally {
        h.focus.restore(null);
    }
});

test('the HUD prompt action opens the existing prompt modal with full controls and classified groups', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        assert.equal(h.context.activeClipPromptId, 'clip-1');
        assert.equal(h.overlay.classList.contains('open'), true);
        assert.equal(h.promptFocus.hidden, false);
        assert.ok(byAttribute(h.promptFocus, 'aria-label', '선택 영역의 부위'));
        assert.ok(byClass(h.promptFocus, 'canvas-daki-focus-extra'));
        assert.ok(byClass(h.promptFocus, 'canvas-daki-auto-group'));
        assert.match(byClass(h.promptFocus, 'canvas-daki-auto-items').textContent, /blue eyes/);
        assert.equal(h.fetchCount(), 1);
    } finally {
        h.focus.restore(null);
    }
});

test('automatic-control section starts open and keeps its collapse preference per selection', async () => {
    const h = createHarness();
    try {
        const first = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        const second = h.addSelection('selection-2', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', first);
        h.addClip('clip-2', second);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        let section = byClass(h.promptFocus, 'canvas-daki-prompt-section');
        assert.equal(section.tagName, 'DETAILS');
        assert.equal(section.open, true);
        assert.equal(section.children[0].tagName, 'SUMMARY');
        assert.equal(section.children[0].textContent, '부위별 자동 제어');
        assert.ok(byClass(section, 'canvas-daki-prompt-section-body'));

        const savedState = JSON.stringify(first.dakiFocus);
        const saves = h.saveCount();
        const fetches = h.fetchCount();
        const renderedFields = h.fieldRenderCalls().length;
        section.open = false;
        invoke(section, 'ontoggle');
        await h.refresh();

        section = byClass(h.promptFocus, 'canvas-daki-prompt-section');
        assert.equal(section.open, false);
        assert.equal(JSON.stringify(first.dakiFocus), savedState);
        assert.equal(h.saveCount(), saves);
        assert.equal(h.fetchCount(), fetches);
        assert.deepEqual(h.fieldRenderCalls().slice(renderedFields), ['base', 'negative', 'char-0']);
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), ['blue eyes']);

        h.context.activeClipPromptId = 'clip-2';
        await h.refresh();
        assert.equal(byClass(h.promptFocus, 'canvas-daki-prompt-section').open, true);
        h.context.activeClipPromptId = 'clip-1';
        await h.refresh();
        assert.equal(byClass(h.promptFocus, 'canvas-daki-prompt-section').open, false);
    } finally {
        h.focus.restore(null);
    }
});

test('automatic groups start collapsed and expose an explicit OFF state', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        const group = byClass(h.promptFocus, 'canvas-daki-auto-group');
        const expand = byClass(group, 'canvas-daki-auto-expand');
        const items = byClass(group, 'canvas-daki-auto-items');
        const toggle = byClass(group, 'clip-control-toggle-btn');
        assert.equal(group.classList.contains('off'), true);
        assert.equal(expand.getAttribute('aria-expanded'), 'false');
        assert.equal(expand.getAttribute('aria-controls'), items.id);
        assert.equal(items.hidden, true);
        assert.equal(toggle.textContent, 'OFF');
        assert.equal(toggle.getAttribute('aria-pressed'), 'false');
        assert.match(byClass(group, 'canvas-daki-auto-state').textContent, /제외/);
    } finally {
        h.focus.restore(null);
    }
});

test('automatic exclusions are read-only and each successful render refreshes prompt token fields once', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        const before = JSON.stringify(selection.dakiFocus);
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), ['blue eyes']);
        assert.deepEqual(Array.from(h.focus.excludedTokens('negative')), []);
        assert.deepEqual(Array.from(h.focus.excludedTokens('unknown')), []);
        assert.equal(JSON.stringify(selection.dakiFocus), before);
        assert.deepEqual(h.fieldRenderCalls(), ['base', 'negative', 'char-0']);
        await h.flush();
        assert.deepEqual(h.fieldRenderCalls(), ['base', 'negative', 'char-0']);

        invoke(byClass(h.promptFocus, 'clip-control-toggle-btn'), 'onclick');
        await h.flush();
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), []);
        assert.deepEqual(h.fieldRenderCalls(), [
            'base', 'negative', 'char-0', 'base', 'negative', 'char-0',
        ]);
        h.overlay.classList.remove('open');
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), []);
    } finally {
        h.focus.restore(null);
    }
});

test('group expansion is ephemeral, survives a group toggle refresh, and preserves open settings', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        const settings = byClass(h.promptFocus, 'canvas-daki-focus-settings');
        settings.open = true;
        invoke(settings, 'ontoggle');
        const group = byClass(h.promptFocus, 'canvas-daki-auto-group');
        const baselineSaves = h.saveCount();
        invoke(byClass(group, 'canvas-daki-auto-expand'), 'onclick');
        assert.equal(h.saveCount(), baselineSaves);
        assert.equal(byClass(group, 'canvas-daki-auto-items').hidden, false);

        invoke(byClass(group, 'clip-control-toggle-btn'), 'onclick');
        await h.flush();
        const refreshedGroup = byClass(h.promptFocus, 'canvas-daki-auto-group');
        assert.equal(refreshedGroup.classList.contains('off'), false);
        assert.equal(byClass(refreshedGroup, 'clip-control-toggle-btn').textContent, 'ON');
        assert.equal(byClass(refreshedGroup, 'canvas-daki-auto-expand').getAttribute('aria-expanded'), 'true');
        assert.equal(byClass(refreshedGroup, 'canvas-daki-auto-items').hidden, false);
        assert.equal(byClass(h.promptFocus, 'canvas-daki-focus-settings').open, true);
        assert.equal(h.saveCount(), baselineSaves + 1);
    } finally {
        h.focus.restore(null);
    }
});

test('disabled automatic filtering displays groups as ON without changing their saved override', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {
            mode: 'manual', regions: ['chest'], filterEnabled: false, usePrompt: false,
            enabledGroups: {face: false},
            groups: [{region: 'face', name: '얼굴', items: [{field: 'base', token: 'blue eyes', key: 'blue eyes'}]}],
        });
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        const group = byClass(h.promptFocus, 'canvas-daki-auto-group');
        const toggle = byClass(group, 'clip-control-toggle-btn');
        assert.equal(group.classList.contains('off'), false);
        assert.equal(toggle.textContent, 'ON');
        assert.equal(toggle.disabled, true);
        assert.equal(toggle.getAttribute('aria-pressed'), 'true');
        assert.match(toggle.title, /항상 포함/);
        assert.equal(selection.dakiFocus.enabledGroups.face, false);
        assert.match(byClass(group, 'canvas-daki-auto-state').textContent, /항상 사용/);
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), []);
    } finally {
        h.focus.restore(null);
    }
});

test('restored tags stay legible and are included when preparing the prompt', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {
            mode: 'manual', regions: ['chest'], usePrompt: false,
        });
        const clip = h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        let group = byClass(h.promptFocus, 'canvas-daki-auto-group');
        invoke(byClass(group, 'canvas-daki-auto-expand'), 'onclick');
        let chip = byClass(group, 'clip-control-chip');
        assert.equal(chip.classList.contains('canvas-daki-excluded'), true);
        assert.equal(chip.classList.contains('canvas-daki-kept'), false);
        const before = await h.focus.prepare(clip, {basePrompt: 'blue eyes, shirt', charPrompts: ['shirt'], negativePrompt: ''});
        assert.equal(before.promptInfo.basePrompt, 'shirt');
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), ['blue eyes']);

        invoke(byClass(chip, 'clip-control-chip-remove'), 'onclick');
        await h.flush();
        group = byClass(h.promptFocus, 'canvas-daki-auto-group');
        chip = byClass(group, 'clip-control-chip');
        assert.equal(group.classList.contains('off'), true);
        assert.equal(chip.classList.contains('canvas-daki-excluded'), false);
        assert.equal(chip.classList.contains('canvas-daki-kept'), true);
        assert.equal(byClass(chip, 'canvas-daki-keep-indicator').textContent, '사용');
        assert.equal(byClass(group, 'canvas-daki-auto-items').hidden, false);
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), []);
        const after = await h.focus.prepare(clip, {basePrompt: 'blue eyes, shirt', charPrompts: ['shirt'], negativePrompt: ''});
        assert.equal(after.promptInfo.basePrompt, 'blue eyes, shirt');
    } finally {
        h.focus.restore(null);
    }
});

test('malformed full prompt fields return no automatic visual exclusions', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', selection);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        h.context.getClipPromptEditorValue = field => field === 'base' ? '[blue eyes, shirt' : 'red eyes';
        assert.deepEqual(Array.from(h.focus.excludedTokens('base')), []);
        assert.deepEqual(Array.from(h.focus.excludedTokens('char-4')), []);
    } finally {
        h.focus.restore(null);
    }
});

test('automatic group expansion remains local to each selection', async () => {
    const h = createHarness();
    try {
        const first = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        const second = h.addSelection('selection-2', {mode: 'manual', regions: ['chest']});
        h.addClip('clip-1', first);
        h.addClip('clip-2', second);
        await h.refresh();
        invoke(find(h.hud, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), 'onclick');
        await h.flush();

        invoke(byClass(byClass(h.promptFocus, 'canvas-daki-auto-group'), 'canvas-daki-auto-expand'), 'onclick');
        h.context.activeClipPromptId = 'clip-2';
        await h.refresh();
        assert.equal(byClass(h.promptFocus, 'canvas-daki-auto-expand').getAttribute('aria-expanded'), 'false');
        h.context.activeClipPromptId = 'clip-1';
        await h.refresh();
        assert.equal(byClass(h.promptFocus, 'canvas-daki-auto-expand').getAttribute('aria-expanded'), 'true');
    } finally {
        h.focus.restore(null);
    }
});

test('without a selected layer the expanded HUD keeps map editing but offers no prompt or region selector', async () => {
    const h = createHarness({selectedId: 'missing-layer'});
    try {
        await h.refresh();
        invoke(byClass(h.hud, 'canvas-daki-hud-toggle'), 'onclick');
        await h.flush();

        const controls = byClass(h.hud, 'canvas-daki-hud-controls');
        assert.equal(controls.hidden, false);
        assert.ok(byAttribute(controls, 'aria-label', '부위 지도 편집'));
        assert.equal(find(controls, node => node.tagName === 'BUTTON' && node.textContent === '프롬프트'), null);
        assert.equal(find(controls, node => node.tagName === 'SELECT'), null);
    } finally {
        h.focus.restore(null);
    }
});

test('an unlinked canvas hides the HUD and prompt-focus panel', async () => {
    const h = createHarness({linked: false});
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        await h.refresh();
        assert.equal(h.hud.hidden, true);
        assert.equal(h.promptFocus.hidden, true);
        assert.equal(h.fetchCount(), 0);
    } finally {
        h.focus.restore(null);
    }
});

test('custom regions appear in the HUD summary and region selector', async () => {
    const h = createHarness();
    try {
        const custom = Regions.addCustomRegion(Regions.defaultMap(), {
            label: '허벅지', baseRegion: 'legs', prompt: 'close-up of the thighs',
        }, 'custom-thigh');
        h.focus.restore(custom.map);
        h.addSelection('selection-1', {mode: 'manual', regions: ['custom-thigh']});
        await h.flush();

        assert.equal(byClass(h.hud, 'canvas-daki-hud-label').textContent, '허벅지');
        const choices = byAttribute(h.hud, 'aria-label', '선택 영역의 부위');
        assert.ok(find(choices, option => option.tagName === 'OPTION' && option.value === 'custom-thigh'));
        assert.equal(choices.title, '허벅지');
    } finally {
        h.focus.restore(null);
    }
});

test('map editing opens inline on the canvas, ignores duplicate opens, and applies one normalized save', async () => {
    const h = createHarness();
    try {
        const selection = h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        await h.refresh();
        h.focus.editMap();
        await h.flush();

        assert.equal(h.editorOpens.length, 1);
        assert.equal(h.editorOpens[0].region, 'chest');
        assert.strictEqual(h.editorOpens[0].panelHost, h.mapPanel);
        assert.strictEqual(h.editorOpens[0].canvasSurface, h.canvasSurface);
        assert.strictEqual(h.editorOpens[0].overlayHost, h.canvasStage);
        assert.equal('preview' in h.editorOpens[0], false);
        assert.equal(typeof h.editorOpens[0].onZoom, 'function');
        assert.equal(typeof h.editorOpens[0].onFocus, 'function');
        assert.equal(typeof h.editorOpens[0].onWheel, 'function');
        assert.equal(h.mapPanel.hidden, false);
        assert.equal(h.document.body.classList.contains('canvas-daki-map-editing'), true);
        assert.equal(h.hud.hidden, true);
        assert.equal(h.promptFocus.hidden, true);
        assert.ok(h.editorSyncCount() >= 1);

        h.focus.editMap();
        await h.flush();
        assert.equal(h.editorOpens.length, 1);
        assert.equal(h.rasterRenderCount(), 0);

        const invalidMap = {version: 9, front: {chest: [{x: 2, y: -1, width: 2, height: 2}]}, back: {chest: []}};
        h.editorOpens[0].onSave(invalidMap);
        const savedMap = h.focus.snapshot();
        assert.equal(savedMap.front.chest[0].x, 0);
        assert.equal(savedMap.front.chest[0].y, 0);
        assert.equal(savedMap.front.chest[0].width, 1);
        assert.equal(savedMap.front.chest[0].height, 1);
        assert.equal(savedMap.version, 1);
        assert.equal(selection.dakiFocus.revision, 1);
        assert.equal(h.saveCount(), 1);

        h.context.CanvasDakiMapEditor.close();
        await h.flush();
        assert.equal(h.mapPanel.hidden, true);
        assert.equal(h.document.body.classList.contains('canvas-daki-map-editing'), false);
        assert.equal(h.hud.hidden, false);
        assert.equal(h.saveCount(), 1);
        assert.equal(h.rasterRenderCount(), 0);
    } finally {
        h.focus.restore(null);
    }
});

test('closing the inline map editor without applying does not save', async () => {
    const h = createHarness();
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['arms']});
        h.focus.editMap();
        await h.flush();
        assert.equal(h.editorOpens.length, 1);

        h.context.CanvasDakiMapEditor.close();
        await h.flush();
        assert.equal(h.saveCount(), 0);
        assert.equal(h.mapPanel.hidden, true);
        assert.equal(h.document.body.classList.contains('canvas-daki-map-editing'), false);
        assert.equal(h.hud.hidden, false);
    } finally {
        h.focus.restore(null);
    }
});

test('restoring a body map closes an active inline editor and restores the canvas controls', async () => {
    const h = createHarness();
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.focus.editMap();
        await h.flush();
        assert.equal(h.mapPanel.hidden, false);

        h.focus.restore(Regions.defaultMap());
        await h.flush();
        assert.equal(h.editorCloseCount(), 1);
        assert.equal(h.mapPanel.hidden, true);
        assert.equal(h.document.body.classList.contains('canvas-daki-map-editing'), false);
        assert.equal(h.hud.hidden, false);
        assert.equal(h.saveCount(), 0);
    } finally {
        h.focus.restore(null);
    }
});

test('a canvas dimension change closes the inline map editor during synchronization', async () => {
    const h = createHarness();
    try {
        h.addSelection('selection-1', {mode: 'manual', regions: ['chest']});
        h.focus.editMap();
        await h.flush();
        assert.equal(h.mapPanel.hidden, false);

        h.setDimensions(1300, 800);
        h.focus.syncEditor();
        await h.flush();
        assert.equal(h.editorCloseCount(), 1);
        assert.equal(h.mapPanel.hidden, true);
        assert.equal(h.document.body.classList.contains('canvas-daki-map-editing'), false);
        assert.equal(h.saveCount(), 0);
    } finally {
        h.focus.restore(null);
    }
});
