const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.join(__dirname, '..');
const canvasSource = fs.readFileSync(path.join(root, 'static/canvas.js'), 'utf8');
const generationSource = fs.readFileSync(path.join(root, 'static/generation_settings.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(root, 'static/canvas_inpaint_settings.js'), 'utf8');
const setupSource = fs.readFileSync(path.join(root, 'static/canvas_setups.js'), 'utf8');

function section(source, startText, endText) {
    const start = source.indexOf(startText);
    const end = source.indexOf(endText, start);
    assert.notEqual(start, -1, `missing section start: ${startText}`);
    assert.notEqual(end, -1, `missing section end: ${endText}`);
    return source.slice(start, end);
}

const normalizeSource = [
    section(canvasSource, 'function normalizePromptInfo(promptInfo) {', '\nfunction pickNegativePromptText('),
    section(canvasSource, 'function pickNegativePromptText(info) {', '\nfunction buildClipPromptInfoFromSelection('),
    section(canvasSource, 'function normalizeCharPromptList(value) {', '\nfunction getClipCharPromptValues(')
].join('\n');
const applySettingsSource = section(canvasSource,
    'function applyCanvasInpaintSettingsToPromptInfo(promptInfo) {', '\nfunction pickNegativePromptText(');
const promptTextSource = section(canvasSource,
    'function hasAnyPromptText(promptInfo) {', '\nfunction collectPromptSourceLayersFromSelection(');
const exportPromptSource = section(canvasSource,
    'function getCanvasExportPromptInfo() {', '\nfunction isCurrentCanvasDakimakuraLike(');
const effectiveClipSource = section(canvasSource,
    'function buildEffectiveClipPromptInfo(clip) {', '\nfunction applyDisabledClipPromptControlGroups(');
const snapshotSource = section(canvasSource,
    'function buildCanvasStateSnapshot(options = {}) {', '\nfunction cloneCanvasLayersForState(');
const mergedSnapshotSource = section(canvasSource,
    'async function buildMergedOnlyCanvasStateSnapshot(', '\nfunction getPrimaryPromptSourceLayer(');

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(value) { this.values.add(value); }
    remove(value) { this.values.delete(value); }
    contains(value) { return this.values.has(value); }
}

function createHarness({width = 720, height = 960} = {}) {
    const nodes = new Map();
    class Element {
        constructor(tagName = 'div') {
            this.tagName = tagName;
            this.children = [];
            this.dataset = {};
            this.style = {};
            this.value = '';
            this.listeners = new Map();
            this.classList = new FakeClassList();
            this.isConnected = true;
            this.open = false;
        }
        set id(value) { this._id = value; nodes.set(value, this); }
        get id() { return this._id; }
        set value(value) { this._value = String(value); }
        get value() { return this._value; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        appendChild(child) {
            if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
            this.children.push(child);
            child.parentElement = this;
            return child;
        }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (selector === '.clip-prompt-field' && String(node.className || '').split(/\s+/).includes('clip-prompt-field')) return node;
            }
            return null;
        }
        querySelector(selector) { return this.children.find(child => child.tagName === selector) || null; }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        }
        dispatch(type, event = {}) {
            event.preventDefault ||= () => {};
            event.stopPropagation ||= () => {};
            for (const listener of this.listeners.get(type) || []) listener(event);
        }
        focus() { document.activeElement = this; }
        setCustomValidity(value) { this.validityMessage = value; }
        reportValidity() {
            if (this.disabled) return true;
            if (this.validityMessage) return false;
            if (this.tagName === 'select') return true;
            const value = Number(this.value);
            return this.value !== '' && Number.isFinite(value)
                && (this.min === undefined || value >= Number(this.min))
                && (this.max === undefined || value <= Number(this.max));
        }
        showModal() { this.open = true; }
        close() { this.open = false; }
    }

    const document = {
        activeElement: null,
        getElementById(id) { return nodes.get(id) || null; },
        createElement(tagName) { return new Element(tagName); },
        addEventListener() {}
    };
    const context = {
        console: {warn() {}},
        document,
        currentCanvasWidth: width,
        currentCanvasHeight: height,
        structuredClone,
        setTimeout,
        clearTimeout,
        showToast(message) { toasts.push(message); },
        saveCanvasState() { saveCount += 1; },
        getCanvasExportPromptInfo() { return {basePrompt: 'canvas prompt'}; },
        async getCanvasExportPromptInfoAsync() { return {basePrompt: 'recovered source prompt', cfg: 7}; },
        getAllCanvasLayerNodes() { return layers; },
        getPromptOwnerLayer(layer) { return layer; },
        async recoverPromptFromImageLayer(layer) { return layer.recoveredPrompt || null; },
        sharedSelectionClipPromptInfo: null,
        hasAnyPromptText(info) {
            return Boolean(info && (String(info.basePrompt || '').trim() || String(info.negativePrompt || '').trim()
                || String(info.charPrompt || '').trim()));
        },
        ensureClipPromptControlGroups() { return []; },
        applySharedSelectionPromptToClip() {},
        findSelectionParentForLayerId() { return null; },
        getSharedSelectionClipPromptInfo() { return sharedPromptInfo; },
        applyDisabledClipPromptControlGroups(value) { return value; },
        saveCanvasState() { saveCount += 1; },
        renderClipPromptControlGroups() {},
        structuredClone
    };
    let toasts = [];
    let saveCount = 0;
    let layers = [];
    let sharedPromptInfo = null;
    context.window = context;
    vm.createContext(context);

    for (const [id, tag] of [
        ['inpaintGenerationSettings', 'div'], ['clipGenerationSettings', 'div'],
        ['clipPromptModalOverlay', 'div'], ['canvasInpaintSettingsDialog', 'dialog'],
        ['canvasInpaintSettingsForm', 'form'], ['canvasInpaintSettingsBtn', 'button'],
        ['canvasInpaintSettingsClose', 'button'], ['canvasInpaintSettingsCancel', 'button'],
        ['clipBasePromptInput', 'textarea']
    ]) {
        const element = new Element(tag);
        element.id = id;
        if (id === 'canvasInpaintSettingsBtn') element.focus = () => { document.activeElement = element; };
    }
    document.activeElement = document.getElementById('canvasInpaintSettingsBtn');
    context.Option = function Option(label, value) {
        const option = new Element('option');
        option.textContent = label;
        option.value = value;
        return option;
    };

    vm.runInContext(generationSource + '\n' + normalizeSource + '\n' + settingsSource, context,
        {filename: 'canvas_inpaint_settings_harness.js'});

    return {
        context,
        nodes,
        get toasts() { return toasts; },
        get saveCount() { return saveCount; },
        setLayers(value) { layers = value; },
        setSharedPromptInfo(value) { sharedPromptInfo = value; },
        Element
    };
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

const chosen = {
    model: 'nai-diffusion-4-5-curated', sampler: 'k_dpmpp_2m_sde', steps: 43,
    cfg: 7.5, cfg_rescale: 0, noise_schedule: 'polyexponential', seed: 0, strength: 0.3, noise: 0
};

test('canvas settings apply over prompt metadata while preserving prompt text and zero values', () => {
    const {context} = createHarness();
    context.CanvasInpaintSettings.update(chosen);
    const applied = plain(context.CanvasInpaintSettings.apply({
        basePrompt: '  original prompt  ', negativePrompt: 'source negative', cfg: 5, seed: 99
    }));
    assert.equal(applied.basePrompt, 'original prompt');
    assert.equal(applied.negativePrompt, 'source negative');
    for (const [key, value] of Object.entries(chosen)) assert.equal(applied[key], value, key);
    assert.deepEqual(plain(context.CanvasInpaintSettings.snapshot()), chosen);
});

test('restore keeps settings-only state and a legacy snapshot without the field falls back to its prompt', () => {
    const {context} = createHarness();
    context.CanvasInpaintSettings.restore(chosen);
    assert.deepEqual(plain(context.CanvasInpaintSettings.snapshot()), chosen);
    context.CanvasInpaintSettings.restore(null);
    const fallback = plain(context.CanvasInpaintSettings.apply({basePrompt: 'legacy prompt', model: 'nai-diffusion-4-5-full', seed: 17}));
    assert.equal(fallback.basePrompt, 'legacy prompt');
    assert.equal(fallback.model, 'nai-diffusion-4-5-full');
    assert.equal(fallback.seed, 17);
    assert.equal(context.CanvasInpaintSettings.snapshot(), null);
});

test('metadata seeding accepts explicit zeroes once and does not seed from prompt-only metadata', () => {
    const {context} = createHarness();
    const promptOnly = context.normalizePromptInfo({basePrompt: 'source prompt'});
    Object.defineProperty(promptOnly, '__hasGenerationSettings', {value: false});
    assert.equal(context.CanvasInpaintSettings.seed(promptOnly), false);
    assert.equal(context.CanvasInpaintSettings.snapshot(), null);

    const source = {model: 'nai-diffusion-4-5-full', seed: 0, cfg_rescale: 0, noise: 0, cfg: 5};
    assert.equal(context.CanvasInpaintSettings.seed(source), true);
    assert.equal(context.CanvasInpaintSettings.seed({model: 'nai-diffusion-5-full'}), false);
    const settings = plain(context.CanvasInpaintSettings.snapshot());
    assert.equal(settings.seed, 0);
    assert.equal(settings.cfg_rescale, 0);
    assert.equal(settings.noise, 0);
});

test('Medium state uses the shared generation controls fixed values', () => {
    const {context} = createHarness();
    context.CanvasInpaintSettings.seed({model: 'nai-diffusion-5-full-medium', sampler: 'k_euler', steps: 36,
        noise_schedule: 'native', cfg_rescale: 0.7});
    const settings = plain(context.CanvasInpaintSettings.snapshot());
    assert.equal(settings.model, 'nai-diffusion-5-full-medium');
    assert.equal(settings.sampler, 'k_euler_ancestral');
    assert.equal(settings.steps, 14);
    assert.equal(settings.noise_schedule, 'karras');
    assert.equal(settings.cfg_rescale, 0.7);
});

test('updates refresh an open clip settings editor without changing unsaved prompt text', () => {
    const {context, nodes} = createHarness();
    const clipModal = nodes.get('clipPromptModalOverlay');
    clipModal.classList.add('open');
    nodes.get('clipBasePromptInput').value = 'unsaved prompt text';
    context.CanvasInpaintSettings.update(chosen);
    const clipSettings = plain(context.readGenerationSettings('clip'));
    for (const [key, value] of Object.entries(chosen)) assert.equal(clipSettings[key], value, key);
    assert.equal(nodes.get('clipBasePromptInput').value, 'unsaved prompt text');
});

test('cancel does not commit edits and Apply validates, saves once, and commits the settings', async () => {
    const h = createHarness();
    const {context, nodes} = h;
    context.CanvasInpaintSettings.open();
    assert.equal(nodes.get('canvasInpaintSettingsDialog').open, true);
    nodes.get('inpaintSeed').value = '0';
    nodes.get('inpaintNoise').value = '0';
    nodes.get('canvasInpaintSettingsCancel').dispatch('click');
    assert.equal(context.CanvasInpaintSettings.snapshot(), null);
    assert.equal(h.saveCount, 0);

    context.CanvasInpaintSettings.open();
    nodes.get('inpaintSeed').value = '0';
    nodes.get('inpaintNoise').value = '0';
    nodes.get('inpaintRescale').value = '0';
    nodes.get('canvasInpaintSettingsForm').dispatch('submit');
    const saved = plain(context.CanvasInpaintSettings.snapshot());
    assert.equal(saved.seed, 0);
    assert.equal(saved.noise, 0);
    assert.equal(saved.cfg_rescale, 0);
    assert.equal(h.saveCount, 1);
    assert.equal(nodes.get('canvasInpaintSettingsDialog').open, false);
    assert.deepEqual(h.toasts, ['캔버스 인페인팅 설정을 저장했습니다.']);
});

test('a late metadata fallback cannot replace settings restored while the dialog is open', async () => {
    const h = createHarness();
    const pending = {};
    pending.promise = new Promise(resolve => { pending.resolve = resolve; });
    h.context.getCanvasExportPromptInfoAsync = () => pending.promise;
    h.context.CanvasInpaintSettings.open();
    h.context.CanvasInpaintSettings.restore(chosen);
    pending.resolve({basePrompt: 'late metadata', cfg: 2, seed: 5});
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(plain(h.context.CanvasInpaintSettings.snapshot()), chosen);
    assert.equal(h.nodes.get('inpaintSeed').value, '0');
});

test('opening settings without a canvas gives the established create-canvas guidance', () => {
    const h = createHarness({width: 0, height: 0});
    h.context.CanvasInpaintSettings.open();
    assert.deepEqual(h.toasts, ['먼저 캔버스를 만들어 주세요.']);
    assert.equal(h.nodes.get('canvasInpaintSettingsDialog').open, false);
});

test('effective clip settings and empty-prompt export both use the canvas values', async () => {
    const h = createHarness();
    const {context} = h;
    vm.runInContext(applySettingsSource + '\n' + promptTextSource + '\n' + effectiveClipSource
        + '\n' + exportPromptSource, context, {filename: 'canvas_inpaint_integration.js'});
    context.CanvasInpaintSettings.update(chosen);
    h.setSharedPromptInfo({basePrompt: 'shared clip prompt', sampler: 'k_euler', steps: 22, seed: 5});
    const clipInfo = plain(context.buildEffectiveClipPromptInfo({type: 'clip'}));
    assert.equal(clipInfo.basePrompt, 'shared clip prompt');
    assert.equal(clipInfo.sampler, chosen.sampler);
    assert.equal(clipInfo.steps, chosen.steps);
    assert.equal(clipInfo.seed, 0);

    h.setLayers([]);
    const emptyExport = plain(context.getCanvasExportPromptInfo());
    const asyncExport = plain(await context.getCanvasExportPromptInfoAsync());
    assert.equal(emptyExport.basePrompt, '');
    assert.equal(emptyExport.seed, 0);
    assert.equal(asyncExport.cfg_rescale, 0);
    assert.equal(asyncExport.noise, 0);
});

test('metadata export fallback applies common settings without mutating source metadata', async () => {
    const h = createHarness();
    const {context} = h;
    vm.runInContext(applySettingsSource + '\n' + promptTextSource + '\n' + exportPromptSource, context,
        {filename: 'canvas_export_prompt_inpaint.js'});
    context.CanvasInpaintSettings.update(chosen);
    const imageLayer = {type: 'image', visible: true, sourcePath: '/synthetic/source.png', promptInfo: {},
        recoveredPrompt: {basePrompt: 'recovered source prompt', model: 'nai-diffusion-5-full', cfg_rescale: 0.4, seed: 91}};
    h.setLayers([imageLayer]);
    const exported = plain(await context.getCanvasExportPromptInfoAsync());
    assert.equal(exported.basePrompt, 'recovered source prompt');
    assert.equal(exported.model, chosen.model);
    assert.equal(exported.cfg_rescale, 0);
    assert.equal(exported.seed, 0);
    assert.equal(imageLayer.promptInfo.seed, 91);
});

test('legacy settings-only image metadata remains available when no canvas settings were saved', () => {
    const h = createHarness();
    const {context} = h;
    vm.runInContext(applySettingsSource + '\n' + promptTextSource + '\n' + exportPromptSource, context,
        {filename: 'canvas_export_legacy_generation.js'});
    const legacyInfo = {model: 'nai-diffusion-4-5-full', sampler: 'k_euler', steps: 19, cfg: 5.5,
        cfg_rescale: 0.25, noise_schedule: 'native', seed: 42, strength: 0.6, noise: 0.1};
    h.setLayers([{type: 'image', visible: true, promptInfo: legacyInfo}]);
    const exported = plain(context.getCanvasExportPromptInfo());
    for (const [key, value] of Object.entries(legacyInfo)) assert.equal(exported[key], value, key);
});

test('recovered source metadata wins over normalized settings-only layer fallback', async () => {
    const h = createHarness();
    const {context} = h;
    vm.runInContext(applySettingsSource + '\n' + promptTextSource + '\n' + exportPromptSource, context,
        {filename: 'canvas_export_recovered_metadata.js'});
    const imageLayer = {
        type: 'image', visible: true, sourcePath: '/synthetic/source.png',
        promptInfo: {model: 'nai-diffusion-4-5-full', cfg_rescale: 0.25, seed: 42},
        recoveredPrompt: {basePrompt: 'actual source prompt', model: 'nai-diffusion-5-full', cfg_rescale: 0.4, seed: 91}
    };
    h.setLayers([imageLayer]);
    const exported = plain(await context.getCanvasExportPromptInfoAsync());
    assert.equal(exported.basePrompt, 'actual source prompt');
    assert.equal(exported.model, 'nai-diffusion-5-full');
    assert.equal(exported.cfg_rescale, 0.4);
    assert.equal(exported.seed, 91);
});

test('autosave and image-only setup snapshots include settings, and legacy restore is before migration', async () => {
    const h = createHarness();
    const {context} = h;
    vm.runInContext(applySettingsSource + '\n' + promptTextSource + '\n' + exportPromptSource
        + '\n' + snapshotSource + '\n' + mergedSnapshotSource, context,
        {filename: 'canvas_state_inpaint.js'});
    context.currentCanvasWidth = 720;
    context.currentCanvasHeight = 960;
    context.canvasLayers = [];
    context.activeLayerId = null;
    context.layerIdSeq = 1;
    context.sharedSelectionClipPromptInfo = null;
    context.sharedSelectionClipPromptControlGroups = [];
    context.isSelectionOverlayHidden = false;
    context.checkedSelectionId = null;
    context.canvasZoom = 1;
    context.clipPreviewZoom = 1;
    context.isClipInpaintMergedSourceMode = false;
    context.cloneCanvasLayersForState = layers => structuredClone(layers);
    context.renderMergedCanvasToDataUrl = async () => 'data:image/png;base64,c3ludGhldGlj';
    context.saveClipDataUrlToServer = async () => '/synthetic/merged.png';
    context.CanvasInpaintSettings.update(chosen);
    assert.deepEqual(plain(context.buildCanvasStateSnapshot().inpaintSettings), chosen);
    assert.deepEqual(plain((await context.buildMergedOnlyCanvasStateSnapshot()).inpaintSettings), chosen);
    context.renderMergedCanvasToDataUrl = async () => { throw new Error('must reuse the exported image'); };
    let uploadedImage;
    context.saveClipDataUrlToServer = async image => { uploadedImage = image; return '/synthetic/exported.png'; };
    const exportedPrompt = {basePrompt: 'synthetic exported prompt'};
    const merged = await context.buildMergedOnlyCanvasStateSnapshot('data:image/png;base64,ZXhwb3J0', exportedPrompt);
    assert.equal(uploadedImage, 'data:image/png;base64,ZXhwb3J0');
    assert.deepEqual(plain(merged.layers[0].promptInfo), exportedPrompt);

    const restoreIndex = setupSource.indexOf('CanvasInpaintSettings.restore(');
    const migrationIndex = setupSource.indexOf('const needsLegacyPromptMigration', restoreIndex);
    assert.ok(restoreIndex >= 0 && migrationIndex > restoreIndex, 'settings restore must precede legacy prompt migration');
    assert.match(canvasSource, /CanvasInpaintSettings\.restore\(null\)/, 'canvas resets clear settings');
    assert.match(canvasSource, /CanvasInpaintSettings\.seed\(payload\.promptInfo\)/, 'image imports seed settings once');
});
