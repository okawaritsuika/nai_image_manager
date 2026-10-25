const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_project_settings.js'), 'utf8');
const pickerSource = fs.readFileSync(require.resolve('../static/daki_project_style_picker.js'), 'utf8');
const canvasStyleLink = require('../static/canvas_style_link.js');

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = new Map();
        this.dataset = {};
        this.style = {};
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.open = false;
        this.value = '';
        this.scrollTop = 0;
        this._textContent = '';
    }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    get className() { return this._className || ''; }
    set className(value) { this._className = String(value); }
    get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._textContent = String(value ?? '');
    }
    get isConnected() {
        for (let node = this; node; node = node.parentNode) if (node.isDocumentRoot) return true;
        return false;
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) {
        if (node.parentNode) {
            const oldIndex = node.parentNode.children.indexOf(node);
            if (oldIndex >= 0) node.parentNode.children.splice(oldIndex, 1);
        }
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    replaceChildren(...nodes) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._textContent = '';
        this.append(...nodes);
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(callback);
        this.listeners.set(name, listeners);
    }
    emit(name, event = {}) {
        const actual = {target: this, stopPropagation() {}, preventDefault() {}, ...event};
        return (this.listeners.get(name) || []).map(callback => callback(actual));
    }
    focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
    showModal() {
        this.open = true;
        if (this.ownerDocument.simulateRestoreScroll) {
            const findBody = node => {
                if (String(node.className || '').split(/\s+/).includes('daki-project-settings-body')) return node;
                for (const child of node.children || []) {
                    const found = findBody(child);
                    if (found) return found;
                }
                return null;
            };
            const body = findBody(this);
            if (body) body.scrollTop = 432;
        }
    }
    close() { this.open = false; }
    getBoundingClientRect() { return {left: 100, top: 100, right: 900, bottom: 800}; }
}

function settingsResponse(overrides = {}) {
    const defaults = {
        revision: 3,
        style: {id: 'removed-style', name: '저장된 그림체', library: 'shared', positive: 'saved base', negative: 'saved negative'},
        prompts: {
            front: {basePrompt: 'front existing base', negativePrompt: 'front existing negative'},
            back: {basePrompt: 'back existing base', negativePrompt: 'back existing negative'},
        },
        inpaintSettings: {
            model: 'nai-diffusion-5-full', sampler: 'k_euler_ancestral', steps: 28,
            cfg: 6, cfg_rescale: 0, noise_schedule: 'native', seed: 0, strength: 0.65, noise: 0,
        },
    };
    return {status: 'success', settings: {...defaults, ...overrides}};
}

function catalogResponse(styles = []) { return {status: 'success', styles}; }

function response(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function createFixture(fetchImpl) {
    const doc = {
        activeElement: null,
        createElement(tagName) { return new FakeElement(tagName, doc); },
        getElementById(id) {
            const visit = node => {
                if (node.id === id) return node;
                for (const child of node.children || []) {
                    const found = visit(child);
                    if (found) return found;
                }
                return null;
            };
            return visit(doc.body);
        },
    };
    doc.body = new FakeElement('body', doc);
    doc.body.isDocumentRoot = true;
    const events = [];
    const channels = [];
    const generationCalls = [];
    const generationReads = [];
    let generationSettings = settingsResponse().settings.inpaintSettings;
    class FakeCustomEvent {
        constructor(type, init) { this.type = type; this.detail = init.detail; }
    }
    class FakeBroadcastChannel {
        constructor(name) { this.name = name; this.messages = []; this.closed = false; channels.push(this); }
        postMessage(message) { this.messages.push(message); }
        close() { this.closed = true; }
    }
    const win = {
        document: doc,
        AbortController,
        fetch: fetchImpl,
        CanvasStyleLink: canvasStyleLink,
        CustomEvent: FakeCustomEvent,
        BroadcastChannel: FakeBroadcastChannel,
        dispatchEvent(event) { events.push(event); },
        applyGenerationModelConstraints(prefix) { assert.equal(prefix, 'projectLink'); },
        setGenerationSettings(prefix, value) {
            assert.equal(prefix, 'projectLink');
            generationCalls.push({prefix, settings: {...value}});
            generationSettings = {...settingsResponse().settings.inpaintSettings, ...value};
            const host = doc.getElementById('projectLinkGenerationSettings');
            if (host && !host.children.length) {
                for (const id of ['projectLinkModel', 'projectLinkSampler', 'projectLinkSteps', 'projectLinkCfg',
                    'projectLinkRescale', 'projectLinkNoiseSchedule', 'projectLinkSeed', 'projectLinkStrength', 'projectLinkNoise']) {
                    host.appendChild(doc.createElement(id.endsWith('Model') || id.endsWith('Sampler') || id.endsWith('NoiseSchedule') ? 'select' : 'input'));
                }
            }
        },
        readGenerationSettings(prefix) {
            assert.equal(prefix, 'projectLink');
            generationReads.push(prefix);
            return {...generationSettings};
        },
    };
    const pickerModule = {exports: {}};
    vm.runInNewContext(pickerSource, {window: win, module: pickerModule, AbortController});
    win.DakiProjectStylePicker = pickerModule.exports;
    const module = {exports: {}};
    vm.runInNewContext(source, {window: win, module, AbortController});
    const opener = doc.createElement('button');
    opener.textContent = '설정 열기';
    doc.body.appendChild(opener);
    return {api: module.exports, doc, win, opener, events, channels, generationCalls, generationReads};
}

function defaultFetch({put} = {}) {
    const style = {id: 'catalog-style', name: '선택 그림체', positive: 'catalog base exact', negative: 'catalog negative exact'};
    return async (url, options = {}) => {
        if (options.method === 'PUT') {
            if (put) return put(url, options);
            const body = JSON.parse(options.body);
            return response(settingsResponse({revision: body.revision + 1, ...body.settings}));
        }
        if (url.includes('/canvas-settings')) return response(settingsResponse());
        if (url.includes('/shared-styles')) return response(catalogResponse([style]));
        if (url.includes('/personal-styles')) return response(catalogResponse([]));
        throw new Error(`Unexpected request: ${url}`);
    };
}

function get(doc, id) {
    const node = doc.getElementById(id);
    assert.ok(node, `missing #${id}`);
    return node;
}

function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
function byClass(node, className) { return descendants(node).filter(item => String(item.className).split(/\s+/).includes(className)); }

test('save sends exact project settings and shared generation values, then notifies without prompts', async () => {
    let savedBody = null;
    const fixture = createFixture(defaultFetch({put: async (_url, options) => {
        savedBody = JSON.parse(options.body);
        return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
    }}));
    await fixture.api.open({projectId: 'project/one', projectName: 'Long 프로젝트', opener: fixture.opener});
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'front existing base');
    assert.equal(get(fixture.doc, 'projectLinkBackNegativePrompt').value, 'back existing negative');
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'saved base');
    assert.equal(fixture.generationCalls[0].prefix, 'projectLink');

    const choice = get(fixture.doc, 'projectLinkStyleChoice');
    assert.ok(choice.children.some(option => option.value === 'catalog-0'));
    get(fixture.doc, 'projectLinkStyleSearch').value = '선택';
    get(fixture.doc, 'projectLinkStyleSearch').emit('input');
    choice.value = 'catalog-0';
    choice.emit('change');
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'catalog base exact');
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'front existing base', 'style selection never inserts recipe text into a prompt');

    get(fixture.doc, 'projectLinkFrontBasePrompt').value = 'front draft, keep all existing text';
    get(fixture.doc, 'projectLinkBackNegativePrompt').value = 'back draft';
    get(fixture.doc, 'projectLinkInpaintEnabled').checked = true;
    get(fixture.doc, 'projectLinkInpaintEnabled').emit('change');
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];

    assert.deepEqual(Object.keys(savedBody).sort(), ['revision', 'settings']);
    assert.equal(savedBody.revision, 3);
    assert.deepEqual(savedBody.settings.style, {
        id: 'catalog-style', name: '선택 그림체', library: 'shared', positive: 'catalog base exact', negative: 'catalog negative exact',
    });
    assert.deepEqual(savedBody.settings.prompts, {
        front: {basePrompt: 'front draft, keep all existing text', negativePrompt: 'front existing negative', charPrompts: []},
        back: {basePrompt: 'back existing base', negativePrompt: 'back draft', charPrompts: []},
    });
    assert.deepEqual(savedBody.settings.inpaintSettings, {
        model: 'nai-diffusion-5-full', sampler: 'k_euler_ancestral', steps: 28,
        cfg: 6, cfg_rescale: 0, noise_schedule: 'native', seed: 0, strength: 0.65, noise: 0,
    });
    assert.deepEqual(fixture.generationReads, ['projectLink']);
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].type, 'daki-project-settings-changed');
    assert.equal(fixture.events[0].detail.projectId, 'project/one');
    assert.equal(fixture.channels[0].name, 'naim-project-canvas-settings');
    assert.equal(fixture.channels[0].messages.length, 1);
    assert.equal(fixture.channels[0].messages[0].projectId, 'project/one');
    assert.equal(fixture.channels[0].closed, true);
    assert.equal(get(fixture.doc, 'dakiProjectSettingsDialog').open, false);
    assert.equal(fixture.opener.focusOptions.preventScroll, true);
});

test('cancel leaves project untouched and restores focus to the opener', async () => {
    const requests = [];
    const fixture = createFixture(async (url, options = {}) => {
        requests.push({url, options});
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'cancel-case', opener: fixture.opener});
    get(fixture.doc, 'projectLinkFrontBasePrompt').value = 'unsaved local draft';
    get(fixture.doc, 'projectLinkCancel').emit('click');
    assert.equal(get(fixture.doc, 'dakiProjectSettingsDialog').open, false);
    assert.equal(fixture.opener.focusOptions.preventScroll, true);
    assert.equal(requests.some(request => request.options.method === 'PUT'), false);
});

test('reopening resets scroll after native focus restoration and does not refocus prior inputs', async () => {
    const fixture = createFixture(defaultFetch());
    await fixture.api.open({projectId: 'first-open'});
    const body = descendants(get(fixture.doc, 'dakiProjectSettingsDialog'))
        .find(node => String(node.className || '').split(/\s+/).includes('daki-project-settings-body'));
    const previousInput = get(fixture.doc, 'projectLinkFrontBasePrompt');
    previousInput.focus();
    body.scrollTop = 510;
    fixture.api.close();
    fixture.doc.simulateRestoreScroll = true;

    await fixture.api.open({projectId: 'second-open'});
    assert.equal(body.scrollTop, 0);
    assert.equal(fixture.doc.activeElement, get(fixture.doc, 'dakiProjectSettingsDialog').children[0].children[1]);
    assert.notEqual(fixture.doc.activeElement, previousInput);
});

test('initial load and save errors keep retry available and retain the entered draft', async () => {
    let settingsGets = 0;
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/canvas-settings') && options.method !== 'PUT') {
            settingsGets++;
            if (settingsGets === 1) return response({status: 'error'}, 503);
            return response(settingsResponse());
        }
        if (options.method === 'PUT') return response({status: 'error'}, 500);
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'retry-case'});
    assert.equal(get(fixture.doc, 'projectLinkRetryLoad').hidden, false);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').disabled, true);
    await get(fixture.doc, 'projectLinkRetryLoad').emit('click')[0];
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, false);
    get(fixture.doc, 'projectLinkFrontBasePrompt').value = 'draft survives save error';
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'draft survives save error');
    assert.match(get(fixture.doc, 'projectLinkStatus').textContent, /초안은 유지됩니다/);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, false);
    assert.equal(fixture.events.length, 0);
});

test('conflict preserves draft and only explicit latest reload replaces it', async () => {
    let gets = 0;
    let putBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/canvas-settings') && options.method === 'PUT') {
            putBody = JSON.parse(options.body);
            return response({code: 'project_settings_conflict'}, 409);
        }
        if (url.includes('/canvas-settings')) {
            gets++;
            return response(gets === 1 ? settingsResponse() : settingsResponse({revision: 7,
                prompts: {front: {basePrompt: 'latest front', negativePrompt: 'latest front negative'},
                    back: {basePrompt: 'latest back', negativePrompt: 'latest back negative'}}}));
        }
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'conflict-case'});
    get(fixture.doc, 'projectLinkFrontBasePrompt').value = 'my conflict draft';
    get(fixture.doc, 'projectLinkFrontAddCharacterPrompt').emit('click');
    get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls[0].value = 'my conflict character';
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(putBody.revision, 3);
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'my conflict draft');
    assert.equal(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls[0].value, 'my conflict character');
    assert.equal(get(fixture.doc, 'projectLinkReloadLatest').hidden, false);
    assert.match(get(fixture.doc, 'projectLinkStatus').textContent, /초안은 유지됩니다/);
    await get(fixture.doc, 'projectLinkReloadLatest').emit('click')[0];
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'latest front');
    assert.equal(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls.length, 0);
    assert.equal(get(fixture.doc, 'projectLinkReloadLatest').hidden, true);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, true);
});

test('missing catalog entry stays selected as a saved snapshot when both lists are empty', async () => {
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/shared-styles')) return response(catalogResponse([]));
        if (url.includes('/personal-styles')) return response(catalogResponse([]));
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'removed-style-case'});
    const choice = get(fixture.doc, 'projectLinkStyleChoice');
    assert.equal(choice.value, 'snapshot');
    assert.ok(choice.children.some(option => option.textContent === '저장된 그림체 · 저장된 그림체'));
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'saved base');
    assert.equal(get(fixture.doc, 'projectLinkStyleNegativePreview').textContent, 'saved negative');
    assert.match(get(fixture.doc, 'projectLinkSharedStatus').textContent, /그림체가 없습니다/);
});

test('empty initial project settings open as an editable blank draft', async () => {
    const empty = settingsResponse({revision: 0, style: null,
        prompts: {front: {basePrompt: '', negativePrompt: ''}, back: {basePrompt: '', negativePrompt: ''}},
        inpaintSettings: null});
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/canvas-settings')) return response(empty);
        if (url.includes('/shared-styles')) return response(catalogResponse([]));
        if (url.includes('/personal-styles')) return response(catalogResponse([]));
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'empty-settings'});
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, '');
    assert.equal(get(fixture.doc, 'projectLinkBackNegativePrompt').value, '');
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, false);
    assert.equal(get(fixture.doc, 'projectLinkGenerationSettings').hidden, true);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, false);
    assert.equal(get(fixture.doc, 'projectLinkStyleChoice').value, '');
});

test('numeric catalog IDs are canonicalized to strings before save', async () => {
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: 1, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(settingsResponse({revision: 0, style: null,
            prompts: {front: {basePrompt: '', negativePrompt: ''}, back: {basePrompt: '', negativePrompt: ''}},
            inpaintSettings: null}));
        if (url.includes('/shared-styles')) return response(catalogResponse([{id: 123, name: 'numeric style', positive: 'p', negative: 'n'}]));
        if (url.includes('/personal-styles')) return response(catalogResponse([]));
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId: 'numeric-style'});
    get(fixture.doc, 'projectLinkStyleLibrary').value = 'shared';
    get(fixture.doc, 'projectLinkStyleLibrary').emit('change');
    const choice = get(fixture.doc, 'projectLinkStyleChoice');
    choice.value = 'catalog-0';
    choice.emit('change');
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(savedBody.settings.style.id, '123');
});

test('catalog failure has its own retry and keeps the saved style snapshot intact', async () => {
    let sharedGets = 0;
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/shared-styles')) {
            sharedGets++;
            return sharedGets === 1 ? response({status: 'error'}, 503) : response(catalogResponse([]));
        }
        if (url.includes('/personal-styles')) return response(catalogResponse([]));
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'catalog-retry-case'});
    assert.equal(get(fixture.doc, 'projectLinkSharedRetry').hidden, false);
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'saved base');
    await get(fixture.doc, 'projectLinkSharedRetry').emit('click')[0];
    assert.equal(get(fixture.doc, 'projectLinkSharedRetry').hidden, true);
    assert.equal(get(fixture.doc, 'projectLinkStyleChoice').value, 'snapshot');
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'saved base');
});

test('turning off common inpaint linkage stores null without reading disabled controls', async () => {
    let savedBody = null;
    const fixture = createFixture(defaultFetch({put: async (_url, options) => {
        savedBody = JSON.parse(options.body);
        return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
    }}));
    await fixture.api.open({projectId: 'inpaint-off-case'});
    const toggle = get(fixture.doc, 'projectLinkInpaintEnabled');
    assert.equal(toggle.checked, true);
    toggle.checked = false;
    toggle.emit('change');
    assert.equal(get(fixture.doc, 'projectLinkGenerationSettings').hidden, true);
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(savedBody.settings.inpaintSettings, null);
    assert.deepEqual(fixture.generationReads, []);
});

test('late requests from a closed project cannot replace the newly opened project', async () => {
    let resolveOldSettings;
    const fixture = createFixture((url, options = {}) => {
        if (url.includes('/projects/old/canvas-settings')) {
            return new Promise(resolve => { resolveOldSettings = resolve; });
        }
        if (url.includes('/projects/new/canvas-settings')) {
            return Promise.resolve(response(settingsResponse({revision: 11,
                prompts: {front: {basePrompt: 'new project value', negativePrompt: ''}, back: {basePrompt: '', negativePrompt: ''}}})));
        }
        return defaultFetch()(url, options);
    });
    const oldOpen = fixture.api.open({projectId: 'old'});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get(fixture.doc, 'dakiProjectSettingsDialog').open, true);
    fixture.api.close();
    await fixture.api.open({projectId: 'new', projectName: 'new project'});
    resolveOldSettings(response(settingsResponse({prompts: {
        front: {basePrompt: 'stale old project', negativePrompt: ''}, back: {basePrompt: '', negativePrompt: ''},
    }})));
    await oldOpen;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'new project value');
    assert.match(get(fixture.doc, 'dakiProjectSettingsTitle').textContent, /new/);
});

test('invalid settings response is surfaced and does not enable save', async () => {
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/canvas-settings')) return response({status: 'success', settings: {revision: -1}});
        return defaultFetch()(url, options);
    });
    await fixture.api.open({projectId: 'invalid-case'});
    assert.match(get(fixture.doc, 'projectLinkStatus').textContent, /불러오지 못했습니다/);
    assert.equal(get(fixture.doc, 'projectLinkRetryLoad').hidden, false);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
});

test('each side toggles its Base and Negative fields independently and saves character prompt arrays as entered', async () => {
    const initial = settingsResponse({revision: 1, style: null,
        prompts: {
            front: {basePrompt: 'original front base', negativePrompt: 'original front negative', charPrompts: [' first ', '', 'third']},
            back: {basePrompt: 'original back base', negativePrompt: 'original back negative'},
        }});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: 2, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [], back: []}}});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId: 'fedcba9876543210fedcba9876543210'});
    assert.equal(get(fixture.doc, 'projectLinkStyleLibrary').value, 'project');
    assert.equal(get(fixture.doc, 'projectLinkFrontBaseTab').getAttribute('aria-selected'), 'true');
    assert.equal(get(fixture.doc, 'projectLinkBackBaseTab').getAttribute('aria-selected'), 'true');

    const frontBase = get(fixture.doc, 'projectLinkFrontBasePrompt');
    const frontNegative = get(fixture.doc, 'projectLinkFrontNegativePrompt');
    frontBase.value = 'front value remains raw';
    get(fixture.doc, 'projectLinkFrontBaseTab').emit('keydown', {key: 'ArrowRight'});
    assert.equal(get(fixture.doc, 'projectLinkFrontNegativeTab').getAttribute('aria-selected'), 'true');
    frontNegative.value = 'front negative remains raw';
    get(fixture.doc, 'projectLinkBackNegativeTab').emit('click');
    get(fixture.doc, 'projectLinkBackNegativePrompt').value = 'back negative draft';
    get(fixture.doc, 'projectLinkFrontBaseTab').emit('click');
    assert.equal(frontBase.value, 'front value remains raw');
    assert.equal(frontNegative.value, 'front negative remains raw');

    get(fixture.doc, 'projectLinkFrontAddCharacterPrompt').emit('click');
    const frontRows = get(fixture.doc, 'projectLinkFrontCharacterRows');
    frontRows._promptControls[3].value = '  final character  ';
    get(fixture.doc, 'projectLinkBackAddCharacterPrompt').emit('click');
    get(fixture.doc, 'projectLinkBackCharacterRows')._promptControls[0].value = 'back character';
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];

    assert.deepEqual(savedBody.settings.prompts, {
        front: {basePrompt: 'front value remains raw', negativePrompt: 'front negative remains raw', charPrompts: [' first ', '', 'third', '  final character  ']},
        back: {basePrompt: 'original back base', negativePrompt: 'back negative draft', charPrompts: ['back character']},
    });
    assert.equal(savedBody.settings.style, null);
});

test('character prompt rows are limited to 22, renumber on deletion, and stay locked while settings load', async () => {
    const values = Array.from({length: 22}, (_, index) => `char-${index + 1}`);
    const settings = settingsResponse({revision: 1, style: null, prompts: {
        front: {basePrompt: '', negativePrompt: '', charPrompts: values},
        back: {basePrompt: '', negativePrompt: ''},
    }});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: 2, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(settings);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [], back: []}}});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId: '00112233445566778899aabbccddeeff'});
    const rows = get(fixture.doc, 'projectLinkFrontCharacterRows');
    const add = get(fixture.doc, 'projectLinkFrontAddCharacterPrompt');
    assert.equal(rows._promptControls.length, 22);
    assert.equal(add.disabled, true);
    const removeFirst = descendants(rows).find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'Character 1 프롬프트 삭제');
    removeFirst.emit('click');
    assert.equal(rows._promptControls.length, 21);
    assert.equal(descendants(rows).find(node => node.tagName === 'LABEL').textContent, 'Character 1');
    assert.equal(add.disabled, false);
    add.emit('click');
    assert.equal(rows._promptControls.length, 22);
    rows._promptControls[21].value = '';
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(savedBody.settings.prompts.front.charPrompts.length, 22);
    assert.equal(savedBody.settings.prompts.front.charPrompts[21], '');
});

test('project image metadata loading blocks Save and canceling settings discards the pending selection', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const initial = settingsResponse({revision: 2, style: null, prompts: {
        front: {basePrompt: 'actual front base', negativePrompt: 'actual front negative'},
        back: {basePrompt: 'actual back base', negativePrompt: 'actual back negative'},
    }});
    let savedBody = null;
    let metadataResolve;
    const fixture = createFixture((url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return Promise.resolve(response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings})));
        }
        if (url.includes('/canvas-settings')) return Promise.resolve(response(initial));
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return Promise.resolve(response(catalogResponse([])));
        if (url.includes('/api/daki/projects/')) return Promise.resolve(response({status: 'success', project: {candidates: {front: [candidate], back: []}}}));
        if (url === '/api/prompt_info') return new Promise(resolve => { metadataResolve = resolve; });
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    const card = descendants(pickerHost).find(node => node.tagName === 'BUTTON' && node.className.includes('daki-project-style-picker-card'));
    assert.ok(card);
    card.emit('click');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
    assert.equal(get(fixture.doc, 'dakiProjectStylePickerPromptText').disabled, true);
    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'actual front base');
    get(fixture.doc, 'projectLinkCancel').emit('click');
    assert.equal(savedBody, null, 'canceling settings does not persist a draft');
    assert.equal(get(fixture.doc, 'dakiProjectSettingsDialog').open, false);
    metadataResolve(response({status: 'success', data: {basePrompt: 'solo, 1.2::ink::, ink, ink', negativePrompt: 'bad, blurry'}}));
});

test('project style applies exact edited prompt text and saves generated selection metadata', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const initial = settingsResponse({revision: 2, style: null, prompts: {
        front: {basePrompt: 'actual front base', negativePrompt: 'actual front negative'},
        back: {basePrompt: 'actual back base', negativePrompt: 'actual back negative'},
    }});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'solo, 1.2::ink::, ink, ink', negativePrompt: 'bad, blurry', charPrompts: ['ignored'],
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    const card = descendants(pickerHost).find(node => node.tagName === 'BUTTON' && node.className.includes('daki-project-style-picker-card'));
    await card.emit('click')[0];
    const prompt = get(fixture.doc, 'dakiProjectStylePickerPromptText');
    assert.equal(prompt.value, 'solo, 1.2::ink::, ink, ink');
    const negativeTab = get(fixture.doc, 'dakiProjectStylePickerNegativeTab');
    negativeTab.emit('click');
    prompt.value = 'bad, blurry';
    prompt.emit('input');
    get(fixture.doc, 'dakiProjectStylePickerBaseTab').emit('click');
    prompt.value = '  solo,\n 1.2::ink::, ink  ';
    prompt.emit('input');
    descendants(pickerHost).find(node => node.tagName === 'BUTTON' && node.textContent === '편집한 프롬프트로 연결').emit('click');

    assert.equal(get(fixture.doc, 'projectLinkFrontBasePrompt').value, 'actual front base');
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, '  solo,\n 1.2::ink::, ink  ');
    assert.equal(get(fixture.doc, 'projectLinkStyleNegativePreview').textContent, 'bad, blurry');
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.deepEqual(savedBody.settings.style, {
        id: candidate.id, library: 'project', sourceProjectId: projectId, name: candidate.name,
        positive: '  solo,\n 1.2::ink::, ink  ', negative: 'bad, blurry',
        selection: {
            base: [{token: 'solo', occurrence: 0}, {token: '1.2::ink::', occurrence: 0}, {token: 'ink', occurrence: 1}],
            negative: [{token: 'bad', occurrence: 0}, {token: 'blurry', occurrence: 0}],
        },
    });
    assert.deepEqual(savedBody.settings.prompts.front, {
        basePrompt: 'actual front base', negativePrompt: 'actual front negative', charPrompts: [],
    });
});

test('project picker appends selected characters to the candidate side and saves both faces without deduplication', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const frontCandidate = {id: 'front-candidate', path: 'synthetic/front.png', src: '/front.png', name: 'Front'};
    const backCandidate = {id: 'back-candidate', path: 'synthetic/back.png', src: '/back.png', name: 'Back'};
    const initial = settingsResponse({revision: 4, style: null, inpaintSettings: null, prompts: {
        front: {basePrompt: 'keep front base', negativePrompt: 'keep front negative', charPrompts: ['front old']},
        back: {basePrompt: 'keep back base', negativePrompt: 'keep back negative', charPrompts: ['back old']},
    }});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {
            candidates: {front: [frontCandidate], back: [backCandidate]},
        }});
        if (url === '/api/prompt_info') {
            const path = JSON.parse(options.body).path;
            return path === frontCandidate.path
                ? response({status: 'success', data: {basePrompt: '', negativePrompt: '', charPrompts: ['front old', ' front new ']}})
                : response({status: 'success', data: {basePrompt: '', negativePrompt: '', charPrompts: ['back new']}});
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    let cards = byClass(pickerHost, 'daki-project-style-picker-card');
    await cards[0].emit('click')[0];
    assert.equal(get(fixture.doc, 'dakiProjectStylePickerCharacterSide').value, 'front');
    let characterRows = byClass(pickerHost, 'daki-project-style-picker-character-row');
    for (const row of characterRows) {
        row.children[0].children[0].checked = true;
        row.children[0].children[0].emit('change');
    }
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.deepEqual(Array.from(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls, control => control.value), [
        'front old', 'front old', ' front new ',
    ]);

    cards = byClass(pickerHost, 'daki-project-style-picker-card');
    await cards[1].emit('click')[0];
    assert.equal(get(fixture.doc, 'dakiProjectStylePickerCharacterSide').value, 'back');
    characterRows = byClass(pickerHost, 'daki-project-style-picker-character-row');
    characterRows[0].children[0].children[0].checked = true;
    characterRows[0].children[0].children[0].emit('change');
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.deepEqual(Array.from(get(fixture.doc, 'projectLinkBackCharacterRows')._promptControls, control => control.value), [
        'back old', 'back new',
    ]);
    assert.deepEqual(fixture.generationReads, [], 'character-only imports do not read generation settings');
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.equal(savedBody.settings.style, null);
    assert.deepEqual(savedBody.settings.prompts, {
        front: {basePrompt: 'keep front base', negativePrompt: 'keep front negative', charPrompts: ['front old', 'front old', ' front new ']},
        back: {basePrompt: 'keep back base', negativePrompt: 'keep back negative', charPrompts: ['back old', 'back new']},
    });
    assert.equal(savedBody.settings.inpaintSettings, null);
});

test('project picker merges partial generation settings with current values and preserves zero values', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const savedStyle = {id: 'saved-style', name: 'Existing shared style', library: 'shared', positive: 'saved base', negative: 'saved negative'};
    const initial = settingsResponse({revision: 6, style: savedStyle, inpaintSettings: null});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: '', negativePrompt: '', cfg_rescale: 0, seed: '0', steps: '19', cfg: '7.5',
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    get(fixture.doc, 'projectLinkStyleLibrary').value = 'project';
    get(fixture.doc, 'projectLinkStyleLibrary').emit('change');
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    const card = byClass(pickerHost, 'daki-project-style-picker-card')[0];
    const priorSetCount = fixture.generationCalls.length;
    await card.emit('click')[0];
    assert.equal(get(fixture.doc, 'dakiProjectStylePickerImportGeneration').checked, true);
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.deepEqual(fixture.generationReads, ['projectLink']);
    assert.equal(fixture.generationCalls.length, priorSetCount + 1);
    assert.equal(fixture.generationCalls.at(-1).settings.cfg_rescale, 0);
    assert.equal(fixture.generationCalls.at(-1).settings.seed, 0);
    assert.equal(fixture.generationCalls.at(-1).settings.steps, 19);
    assert.equal(fixture.generationCalls.at(-1).settings.cfg, 7.5);
    assert.equal(fixture.generationCalls.at(-1).settings.strength, 0.65);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, true);
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, 'saved base');
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.deepEqual(savedBody.settings.style, savedStyle);
    assert.equal(savedBody.settings.inpaintSettings.cfg_rescale, 0);
    assert.equal(savedBody.settings.inpaintSettings.seed, 0);
    assert.equal(savedBody.settings.inpaintSettings.strength, 0.65);
});

test('unchecked generation import leaves the existing common inpaint setting and toggle unchanged', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const initial = settingsResponse({revision: 7, style: null});
    let savedBody = null;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            savedBody = JSON.parse(options.body);
            return response(settingsResponse({revision: savedBody.revision + 1, ...savedBody.settings}));
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'source style', negativePrompt: '', cfg_rescale: 0,
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    await byClass(pickerHost, 'daki-project-style-picker-card')[0].emit('click')[0];
    const importGeneration = get(fixture.doc, 'dakiProjectStylePickerImportGeneration');
    assert.equal(importGeneration.checked, true);
    importGeneration.checked = false;
    importGeneration.emit('change');
    const generationCalls = fixture.generationCalls.length;
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.deepEqual(fixture.generationReads, []);
    assert.equal(fixture.generationCalls.length, generationCalls);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, true);
    await get(fixture.doc, 'projectLinkSave').emit('click')[0];
    assert.deepEqual(savedBody.settings.inpaintSettings, initial.settings.inpaintSettings);
});

test('character count overflow rejects all project picker changes before generation settings are read', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const existing = Array.from({length: 22}, (_, index) => `existing-${index + 1}`);
    const initial = settingsResponse({revision: 8, style: null, inpaintSettings: null, prompts: {
        front: {basePrompt: 'original base', negativePrompt: 'original negative', charPrompts: existing},
        back: {basePrompt: '', negativePrompt: ''},
    }});
    const fixture = createFixture(async url => {
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'new style', negativePrompt: '', charPrompts: ['extra character'], cfg_rescale: 0,
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    await byClass(pickerHost, 'daki-project-style-picker-card')[0].emit('click')[0];
    const row = byClass(pickerHost, 'daki-project-style-picker-character-row')[0];
    row.children[0].children[0].checked = true;
    row.children[0].children[0].emit('change');
    const generationCalls = fixture.generationCalls.length;
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
    assert.match(byClass(pickerHost, 'daki-project-style-picker-status')[1].textContent, /최대 22개/);
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, '그림체를 선택하면 프롬프트가 표시됩니다.');
    assert.deepEqual(Array.from(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls, control => control.value), existing);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, false);
    assert.deepEqual(fixture.generationReads, []);
    assert.equal(fixture.generationCalls.length, generationCalls);
});

test('failed generation read keeps style, character prompts, and inpaint toggle unchanged', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const initial = settingsResponse({revision: 9, style: null, inpaintSettings: null, prompts: {
        front: {basePrompt: 'original base', negativePrompt: 'original negative', charPrompts: ['existing character']},
        back: {basePrompt: '', negativePrompt: ''},
    }});
    let readCalls = 0;
    const fixture = createFixture(async url => {
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'new style', negativePrompt: '', charPrompts: ['new character'], cfg_rescale: 0,
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    fixture.win.readGenerationSettings = () => { readCalls++; return null; };
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    await byClass(pickerHost, 'daki-project-style-picker-card')[0].emit('click')[0];
    const row = byClass(pickerHost, 'daki-project-style-picker-character-row')[0];
    row.children[0].children[0].checked = true;
    row.children[0].children[0].emit('change');
    const generationCalls = fixture.generationCalls.length;
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.equal(readCalls, 1);
    assert.equal(fixture.generationCalls.length, generationCalls);
    assert.equal(byClass(fixture.doc.body, 'daki-project-style-picker-draft')[0].hidden, false);
    assert.equal(get(fixture.doc, 'projectLinkStyleBasePreview').textContent, '그림체를 선택하면 프롬프트가 표시됩니다.');
    assert.deepEqual(Array.from(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls, control => control.value), ['existing character']);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, false);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
});

test('cancel discards imported characters and generation settings without issuing a PUT', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    const candidate = {id: 'candidate-1', path: 'synthetic/source.png', src: '/source.png', name: 'Source image'};
    const initial = settingsResponse({revision: 10, style: null, inpaintSettings: null, prompts: {
        front: {basePrompt: '', negativePrompt: '', charPrompts: []},
        back: {basePrompt: '', negativePrompt: '', charPrompts: []},
    }});
    let putCalls = 0;
    const fixture = createFixture(async (url, options = {}) => {
        if (options.method === 'PUT') {
            putCalls++;
            return response(settingsResponse());
        }
        if (url.includes('/canvas-settings')) return response(initial);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        if (url.includes('/api/daki/projects/')) return response({status: 'success', project: {candidates: {front: [candidate], back: []}}});
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: '', negativePrompt: '', charPrompts: ['new character'], steps: 19,
        }});
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    const pickerHost = get(fixture.doc, 'projectLinkProjectStylePicker');
    await byClass(pickerHost, 'daki-project-style-picker-card')[0].emit('click')[0];
    const row = byClass(pickerHost, 'daki-project-style-picker-character-row')[0];
    row.children[0].children[0].checked = true;
    row.children[0].children[0].emit('change');
    byClass(pickerHost, 'daki-project-style-picker-apply')[0].emit('click');
    assert.equal(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls.length, 1);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, true);
    get(fixture.doc, 'projectLinkCancel').emit('click');
    assert.equal(putCalls, 0);
    await fixture.api.open({projectId});
    assert.equal(get(fixture.doc, 'projectLinkFrontCharacterRows')._promptControls.length, 0);
    assert.equal(get(fixture.doc, 'projectLinkInpaintEnabled').checked, false);
    assert.equal(putCalls, 0);
});

test('project picker loads after settings unlock even when catalog responses finish first', async () => {
    const projectId = '0123456789abcdef0123456789abcdef';
    let resolveSettings;
    let projectGets = 0;
    const fixture = createFixture((url, options = {}) => {
        if (url.includes('/canvas-settings')) return new Promise(resolve => { resolveSettings = resolve; });
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return Promise.resolve(response(catalogResponse([])));
        if (url.includes('/api/daki/projects/')) {
            projectGets += 1;
            return Promise.resolve(response({status: 'success', project: {candidates: {front: [], back: []}}}));
        }
        throw new Error(`Unexpected request: ${url}`);
    });
    const opening = fixture.api.open({projectId});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(projectGets, 0, 'the picker waits while project settings are locked');
    resolveSettings(response(settingsResponse({revision: 1, style: null})));
    await opening;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(projectGets, 1, 'unlocking starts exactly one project candidate request');
    assert.match(get(fixture.doc, 'projectLinkProjectStylePicker').textContent, /등록된 그림이 없습니다/);
    fixture.api.close();
});

test('invalid character prompt arrays are surfaced and keep Save disabled', async () => {
    const invalid = settingsResponse({revision: 1, prompts: {
        front: {basePrompt: '', negativePrompt: '', charPrompts: ['ok', 7]},
        back: {basePrompt: '', negativePrompt: ''},
    }});
    const fixture = createFixture(async url => {
        if (url.includes('/canvas-settings')) return response(invalid);
        if (url.includes('/shared-styles') || url.includes('/personal-styles')) return response(catalogResponse([]));
        throw new Error(`Unexpected request: ${url}`);
    });
    await fixture.api.open({projectId: 'invalid-char-prompts'});
    assert.match(get(fixture.doc, 'projectLinkStatus').textContent, /불러오지 못했습니다/);
    assert.equal(get(fixture.doc, 'projectLinkSave').disabled, true);
});
