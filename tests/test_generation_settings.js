const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
    const nodes = new Map();
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.value = ''; }
        set id(id) { this._id = id; nodes.set(id, this); }
        get id() { return this._id; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        appendChild(child) {
            if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
            this.children.push(child); child.parentElement = this;
        }
        replaceChildren(...children) { this.children = []; this.append(...children); }
        closest() { return this.parentElement; }
        querySelector(tag) { return this.children.find(child => child.tag === tag); }
        setCustomValidity(value) { this.error = value; }
        reportValidity() {
            if (this.disabled) return true;
            const n = Number(this.value);
            return !this.error && (this.tag === 'select' || (this.value !== '' && Number.isFinite(n) && n >= this.min && n <= this.max));
        }
    }
    const context = vm.createContext({console, structuredClone, setTimeout, clearTimeout,
        document: {getElementById: id => nodes.get(id), createElement: tag => new Element(tag), addEventListener() {}},
        window: {addEventListener() {}}, localStorage: {getItem: () => null},
        Option: function(label, value) { this.label = label; this.value = value; }});
    for (const file of ['generation_settings.js', 'canvas.js', 'canvas_reference.js', 'gallery_inpaint.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', file), 'utf8'), context);
    }
    for (const prefix of ['clip', 'referenceGen', 'galleryInpaint']) {
        const host = new Element('div'); host.id = prefix + 'GenerationSettings';
    }
    return {context, nodes};
}

test('size labels show exact and width-normalized ratios with two decimal places', () => {
    const {context} = setup();
    for (const [width, height, ratio] of [[320, 1024, '5:16 (1:3.20)'], [512, 1664, '4:13 (1:3.25)'], [640, 2048, '5:16 (1:3.20)'],
        [1024, 1024, '1:1 (1:1.00)'], [832, 1216, '13:19 (1:1.46)'], [1920, 1088, '30:17 (1:0.57)'], [768, 512, '3:2 (1:0.67)']]) {
        assert.equal(context.formatGenerationSize(width, height), `${width} × ${height} · ${ratio}`);
    }
});

test('the maximum exact Daki preset label follows the supplied generation limits', () => {
    const {context} = setup(), limits = {step: 64, max: 49152, max_pixels: 3145728};
    assert.match(context.formatGenerationSize(960, 3072, limits), /5:16 최대$/);
    assert.match(context.formatGenerationSize(1024, 3072, limits), /최대 면적$/);
    assert.doesNotMatch(context.formatGenerationSize(640, 2048, limits), /최대/);
    assert.doesNotMatch(context.formatGenerationSize(320, 1024, limits), /최대/);
    assert.doesNotMatch(context.formatGenerationSize(512, 1664, limits), /최대/);
    assert.match(context.formatGenerationSize(320, 1024, {...limits, max_pixels: 1048576}), /최대$/);
});

test('all three editors preserve chosen models, zero values and official setting names', () => {
    const {context, nodes} = setup();
    const selected = {model: 'nai-diffusion-4-5-curated-inpainting', sampler: 'k_dpmpp_2m_sde', steps: 43,
        cfg: 7.5, cfg_rescale: 0, noise_schedule: 'polyexponential', seed: 0, strength: 0.3, noise: 0};
    for (const prefix of ['clip', 'referenceGen', 'galleryInpaint']) {
        context.setGenerationSettings(prefix, selected);
        const result = context.readGenerationSettings(prefix);
        for (const [key, value] of Object.entries(selected)) {
            assert.equal(result[key], key === 'model' ? value.replace('-inpainting', '') : value);
        }
        const suffix = prefix === 'clip' ? 'Input' : '';
        assert.match(nodes.get(prefix + 'Cfg' + suffix).parentElement.children[0].textContent, /Prompt Guidance/);
        const input = nodes.get(prefix + 'Rescale' + suffix);
        input.value = '1.1';
        assert.equal(context.readGenerationSettings(prefix), null);
        context.setGenerationSettings(prefix, selected);
        assert.equal(context.readGenerationSettings(prefix).cfg_rescale, 0);
    }
});

test('canvas, reference, gallery and saved-state normalizers retain all generation fields', () => {
    const {context} = setup();
    const info = {model: 'nai-diffusion-4-5-full', sampler: 'k_euler', steps: 32, cfg: 5.5,
        cfg_rescale: 0, noise_schedule: 'karras', seed: 0, noise: 0, strength: 0.01};
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full-medium']) {
        info.model = model;
        for (const normalize of [context.normalizePromptInfo, context.normalizeReferenceGenPromptInfo, context.normalizeGalleryPromptInfo]) {
            const restored = normalize(JSON.parse(JSON.stringify(info)));
            for (const [key, value] of Object.entries(info)) assert.equal(restored[key], value, key);
        }
    }
});

test('unsupported imported settings stay visible and require an explicit supported selection', () => {
    const {context, nodes} = setup();
    context.setGenerationSettings('clip', {model: 'old-model', sampler: 'ddim_v3'});
    assert.equal(nodes.get('clipModelInput').value, 'old-model');
    assert.equal(context.readGenerationSettings('clip'), null);
    context.setGenerationSettings('clip', {});
    assert.equal(context.readGenerationSettings('clip').model, 'nai-diffusion-5-full');
});

test('reference save uses the selected fields and refuses an invalid form', () => {
    const {context, nodes} = setup();
    context.getReferenceGenCharPromptValues = () => [];
    context.setGenerationSettings('referenceGen', {model: 'nai-diffusion-4-5-full', cfg_rescale: 0, noise: 0, seed: 0});
    const saved = context.buildReferenceGenPromptInfoFromInputs();
    assert.equal(saved.model, 'nai-diffusion-4-5-full');
    assert.equal(saved.cfg_rescale, 0);
    assert.equal(saved.noise, 0);
    assert.equal(saved.seed, 0);
    nodes.get('referenceGenSteps').value = '99';
    assert.equal(context.buildReferenceGenPromptInfoFromInputs(), null);
});

test('all editors restore imported Medium and enforce its effective generation settings', () => {
    const {context, nodes} = setup();
    for (const prefix of ['clip', 'referenceGen', 'galleryInpaint']) {
        context.setGenerationSettings(prefix, {model: 'nai-diffusion-5-full-medium-inpainting',
            sampler: 'k_euler', steps: 32, cfg_rescale: 0.7, noise_schedule: 'native'});
        const suffix = prefix === 'clip' ? 'Input' : '';
        const model = nodes.get(prefix + 'Model' + suffix);
        assert.equal(model.children.filter(option => option.value === 'nai-diffusion-5-full-medium').length, 1);
        const settings = context.readGenerationSettings(prefix);
        assert.equal(settings.model, 'nai-diffusion-5-full-medium');
        assert.equal(settings.sampler, 'k_euler_ancestral');
        assert.equal(settings.steps, 14);
        assert.equal(settings.noise_schedule, 'karras');
        assert.equal(settings.cfg_rescale, 0.7, 'inactive rescale stays available for other models');
        for (const id of ['Sampler', 'Steps', 'NoiseSchedule', 'Rescale']) {
            assert.equal(nodes.get(prefix + id + suffix).disabled, true, id);
        }
        const note = nodes.get(prefix + 'GenerationModelNote');
        assert.equal(note.hidden, false);
        assert.match(note.textContent, /Negative Prompt.*적용되지 않습니다/);
        nodes.get(prefix + 'Steps' + suffix).value = 40;
        nodes.get(prefix + 'Sampler' + suffix).value = 'k_euler';
        nodes.get(prefix + 'NoiseSchedule' + suffix).value = 'native';
        assert.equal(context.readGenerationSettings(prefix).steps, 14);
        assert.equal(context.readGenerationSettings(prefix).sampler, 'k_euler_ancestral');
        assert.equal(context.readGenerationSettings(prefix).noise_schedule, 'karras');
    }
});

test('switching Medium on and off restores current High controls without leaking across reopened settings', () => {
    const {context, nodes} = setup();
    for (const prefix of ['clip', 'referenceGen', 'galleryInpaint']) {
        const high = {model: 'nai-diffusion-5-full', sampler: 'k_dpmpp_sde', steps: 35,
            cfg_rescale: 0.65, noise_schedule: 'exponential'};
        context.setGenerationSettings(prefix, high);
        const suffix = prefix === 'clip' ? 'Input' : '';
        const model = nodes.get(prefix + 'Model' + suffix);
        for (let i = 0; i < 2; i++) {
            model.value = 'nai-diffusion-5-full-medium';
            model.onchange();
            assert.equal(context.readGenerationSettings(prefix).steps, 14);
            model.value = 'nai-diffusion-5-full';
            model.onchange();
            const restored = context.readGenerationSettings(prefix);
            for (const [key, value] of Object.entries(high)) assert.equal(restored[key], value, key);
            for (const id of ['Sampler', 'Steps', 'NoiseSchedule', 'Rescale']) {
                assert.equal(nodes.get(prefix + id + suffix).disabled, false, id);
            }
            assert.equal(nodes.get(prefix + 'GenerationModelNote').hidden, true);
        }
        model.value = 'nai-diffusion-5-full-medium';
        model.onchange();
        const saved = context.readGenerationSettings(prefix);
        context.setGenerationSettings(prefix, saved);
        model.value = 'nai-diffusion-5-full';
        model.onchange();
        const reopened = context.readGenerationSettings(prefix);
        assert.equal(reopened.steps, 28);
        assert.equal(reopened.sampler, 'k_euler_ancestral');
        assert.equal(reopened.noise_schedule, 'native');
        assert.equal(reopened.cfg_rescale, 0.65);
        context.setGenerationSettings(prefix, {model: 'nai-diffusion-4-5-full', steps: 41});
        assert.equal(context.readGenerationSettings(prefix).steps, 41);
        assert.equal(nodes.get(prefix + 'Steps' + suffix).disabled, false);
    }
});

test('reference editor loads and saves Medium restrictions while retaining negative prompt text', () => {
    const {context, nodes} = setup();
    const negative = context.document.createElement('textarea');
    negative.id = 'referenceGenNegativePrompt';
    context.setReferenceGenCharPromptValues = () => {};
    context.getReferenceGenCharPromptValues = () => [];
    context.setReferenceGenPromptValues({model: 'nai-diffusion-5-full-medium-inpainting',
        sampler: 'k_euler', steps: 32, negativePrompt: 'synthetic negative text'});
    assert.equal(nodes.get('referenceGenSteps').value, 14);
    assert.equal(nodes.get('referenceGenSampler').value, 'k_euler_ancestral');
    const saved = context.buildReferenceGenPromptInfoFromInputs();
    assert.equal(saved.model, 'nai-diffusion-5-full-medium');
    assert.equal(saved.steps, 14);
    assert.equal(saved.noise_schedule, 'karras');
    assert.equal(saved.negativePrompt, 'synthetic negative text');
    const model = nodes.get('referenceGenModel');
    model.value = 'nai-diffusion-5-full';
    model.onchange();
    assert.equal(negative.value, 'synthetic negative text');
});

test('canvas prompt matching does not overwrite shared Medium restrictions', () => {
    const {context, nodes} = setup();
    const modal = context.document.createElement('div');
    modal.id = 'clipPromptModalOverlay';
    modal.classList = {contains: () => true};
    context.setClipPromptEditorValue = () => {};
    context.setClipCharPromptValues = () => {};
    context.getActiveClipForPromptControl = () => null;
    context.renderAllClipPromptTokens = () => {};
    context.refreshOpenClipPromptModalAfterPromptMatch({model: 'nai-diffusion-5-full-medium',
        steps: 35, sampler: 'k_euler'});
    assert.equal(nodes.get('clipStepsInput').value, 14);
    assert.equal(nodes.get('clipSamplerInput').value, 'k_euler_ancestral');
    assert.equal(context.readGenerationSettings('clip').noise_schedule, 'karras');
});
