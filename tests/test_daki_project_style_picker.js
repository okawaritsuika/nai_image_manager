const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_project_style_picker.js'), 'utf8');
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
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.value = '';
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
    addEventListener(name, callback) {
        const listeners = this.listeners.get(name) || [];
        listeners.push(callback);
        this.listeners.set(name, listeners);
    }
    emit(name, event = {}) {
        const actual = {target: this, preventDefault() {}, stopPropagation() {}, ...event};
        return (this.listeners.get(name) || []).map(callback => callback(actual));
    }
    focus(options) { this.focusOptions = options; this.ownerDocument.activeElement = this; }
}

function createDocument() {
    const doc = {
        createElement(tagName) { return new FakeElement(tagName, doc); },
    };
    doc.body = new FakeElement('body', doc);
    return doc;
}

function createFixture(fetchImpl, callbacks = {}) {
    const doc = createDocument();
    const win = {document: doc, AbortController, fetch: fetchImpl, CanvasStyleLink: canvasStyleLink};
    const module = {exports: {}};
    vm.runInNewContext(source, {window: win, module, AbortController});
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const selected = [];
    const selectedImports = [];
    const pending = [];
    const picker = module.exports.create({
        host,
        onSelect(style, imports) {
            selected.push(style);
            selectedImports.push(imports);
            return callbacks.onSelect?.(style, imports);
        },
        onPendingChange(value) { pending.push(value); callbacks.onPendingChange?.(value); },
    });
    return {doc, win, host, picker, selected, selectedImports, pending};
}

function response(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function projectPayload(front = [], back = []) {
    return {status: 'success', project: {candidates: {front, back}}};
}

function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
function byText(node, text) { return descendants(node).find(item => item.tagName === 'BUTTON' && item.textContent === text); }
function byClass(node, className) { return descendants(node).filter(item => String(item.className).split(/\s+/).includes(className)); }
function byId(node, id) { return descendants(node).find(item => item.id === id); }
function json(value) { return JSON.parse(JSON.stringify(value)); }
function flush() { return new Promise(resolve => setImmediate(resolve)); }

const projectId = '0123456789abcdef0123456789abcdef';
const frontImage = {id: 'front-candidate', path: 'synthetic/front.png', src: '/front.png', name: '앞면 그림'};
const backImage = {id: 'back-candidate', path: 'synthetic/back.png', src: '/back.png', name: 'back-image'};

test('lists project candidates, loads both full prompts, and saves edited text without normalizing it', async () => {
    const requests = [];
    const fixture = createFixture(async (url, options = {}) => {
        requests.push({url, options});
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage], [backImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'solo, 1.2::INK::, ink, ink', baseCaption: 'ignored fallback', negativePrompt: 'blurry, bad',
        }});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    const cards = byClass(fixture.host, 'daki-project-style-picker-card');
    assert.deepEqual(cards.map(card => card.textContent), ['앞면 · 앞면 그림', '뒷면 · back-image']);
    assert.equal(requests.filter(request => request.url === '/api/prompt_info').length, 0, 'metadata is lazy');

    await cards[0].emit('click')[0];
    assert.equal(fixture.pending.at(-1), true);
    assert.equal(requests.filter(request => request.url === '/api/prompt_info').length, 1);
    assert.equal(JSON.parse(requests.find(request => request.url === '/api/prompt_info').options.body).path, frontImage.path);
    const apply = byText(fixture.host, '편집한 프롬프트로 연결');
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    assert.equal(prompt.value, 'solo, 1.2::INK::, ink, ink');
    assert.equal(prompt.getAttribute('aria-label'), 'Base 프롬프트');
    assert.equal(prompt.maxLength, 100000);
    assert.equal(prompt.rows, 8);
    assert.equal(apply.disabled, false);

    const negativeTab = byId(fixture.host, 'dakiProjectStylePickerNegativeTab');
    negativeTab.emit('click');
    assert.equal(prompt.value, 'blurry, bad');
    assert.equal(prompt.getAttribute('aria-label'), 'Negative 프롬프트');
    prompt.value = 'bad,\n blurry,  ';
    prompt.emit('input');
    byId(fixture.host, 'dakiProjectStylePickerBaseTab').emit('click');
    assert.equal(prompt.value, 'solo, 1.2::INK::, ink, ink');
    prompt.value = ' ink,\n 1.2::INK::, ink ';
    prompt.emit('input');
    apply.emit('click');

    assert.deepEqual(json(fixture.selected[0]), {
        id: 'front-candidate', library: 'project', sourceProjectId: projectId, name: '앞면 그림',
        positive: ' ink,\n 1.2::INK::, ink ', negative: 'bad,\n blurry,  ',
        selection: {
            base: [{token: 'ink', occurrence: 0}, {token: '1.2::INK::', occurrence: 1}, {token: 'ink', occurrence: 2}],
            negative: [{token: 'bad', occurrence: 0}, {token: 'blurry', occurrence: 0}],
        },
    });
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-draft')[0].hidden, true);
    assert.equal(fixture.pending.at(-1), false);
    assert.equal(requests.filter(request => request.url.includes('/api/daki/projects/')).length, 1);
    fixture.picker.dispose();
});

test('restores saved prompt text and preserves its existing occurrence metadata when unchanged', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'ink, 1.2::INK::, ink', negativePrompt: 'bad, blurry',
        }});
        throw new Error('unexpected request');
    });
    const savedStyle = {
        id: frontImage.id, library: 'project', sourceProjectId: projectId, name: frontImage.name,
        positive: 'INK', negative: '', selection: {base: [{token: 'INK', occurrence: 1}], negative: []},
    };
    await fixture.picker.open({projectId, style: savedStyle});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    assert.equal(prompt.value, 'INK');
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.deepEqual(json(fixture.selected[0]), {
        id: frontImage.id, library: 'project', sourceProjectId: projectId, name: frontImage.name,
        positive: 'INK', negative: '',
        selection: {base: [{token: 'INK', occurrence: 1}], negative: []},
    });
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    assert.equal(prompt.value, 'INK');
    fixture.picker.dispose();
});

test('restores a saved occurrence without substituting it and guides when the project has no candidates', async () => {
    const candidate = {id: 'saved-image', path: 'synthetic/saved.png', src: '/saved.png', name: 'Saved'};
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([candidate]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {basePrompt: 'ink, ink', negativePrompt: ''}});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId, style: {
        id: candidate.id, library: 'project', sourceProjectId: projectId, name: candidate.name,
        positive: 'ink', negative: '', selection: {base: [{token: 'ink', occurrence: 3}], negative: []},
    }});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerPromptText').value, 'ink');
    assert.equal(byText(fixture.host, '편집한 프롬프트로 연결').disabled, false);
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.deepEqual(json(fixture.selected[0].selection), {
        base: [{token: 'ink', occurrence: 3}], negative: [],
    });
    fixture.picker.dispose();

    const empty = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload());
        throw new Error('unexpected request');
    });
    await empty.picker.open({projectId});
    assert.match(byClass(empty.host, 'daki-project-style-picker-status')[0].textContent, /등록된 그림이 없습니다/);
    assert.equal(byClass(empty.host, 'daki-project-style-picker-card').length, 0);
    empty.picker.dispose();
});

test('cancel discards text edits without changing the parent snapshot', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {basePrompt: 'ink', negativePrompt: ''}});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    prompt.value = 'changed';
    prompt.emit('input');
    byText(fixture.host, '편집 취소').emit('click');
    assert.deepEqual(fixture.selected, []);
    assert.equal(fixture.pending.at(-1), false);
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-draft')[0].hidden, true);
    fixture.picker.dispose();
});

test('missing candidates, failed requests, and retry have visible states', async () => {
    let projectCalls = 0;
    let metadataCalls = 0;
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) {
            projectCalls += 1;
            if (projectCalls === 1) return response({status: 'error'}, 503);
            return response(projectPayload([], [{...backImage, missing: true}]));
        }
        if (url === '/api/prompt_info') {
            metadataCalls += 1;
            return metadataCalls === 1 ? response({status: 'error'}, 500)
                : response({status: 'success', data: {baseCaption: 'fallback, caption', negativePrompt: ''}});
        }
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    assert.match(byClass(fixture.host, 'daki-project-style-picker-status')[0].textContent, /불러오지 못했습니다/);
    assert.equal(byText(fixture.host, '프로젝트 그림 다시 불러오기').hidden, false);
    await byText(fixture.host, '프로젝트 그림 다시 불러오기').emit('click')[0];
    assert.equal(projectCalls, 2);
    assert.match(byClass(fixture.host, 'daki-project-style-picker-status')[0].textContent, /1개 그림을 불러왔습니다/);
    const missingCard = byClass(fixture.host, 'daki-project-style-picker-card')[0];
    assert.equal(missingCard.disabled, true);
    assert.match(missingCard.textContent, /파일 없음/);

    fixture.picker.dispose();
    let metadataRetryCalls = 0;
    const sourceCandidate = {id: 'another', path: 'synthetic/retry.png', src: '/retry.png', name: 'Retry'};
    const retryFixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([sourceCandidate]));
        if (url === '/api/prompt_info') {
            metadataRetryCalls += 1;
            return metadataRetryCalls === 1 ? response({status: 'error'}, 500)
                : response({status: 'success', data: {baseCaption: 'fallback, caption', negativePrompt: ''}});
        }
        throw new Error('unexpected request');
    });
    await retryFixture.picker.open({projectId});
    await byClass(retryFixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    assert.equal(byText(retryFixture.host, '프롬프트 다시 불러오기').hidden, false);
    assert.equal(byId(retryFixture.host, 'dakiProjectStylePickerPromptText').disabled, true);
    await byText(retryFixture.host, '프롬프트 다시 불러오기').emit('click')[0];
    assert.equal(byId(retryFixture.host, 'dakiProjectStylePickerPromptText').value, 'fallback, caption');
    retryFixture.picker.dispose();
});

test('blank and comma-only drafts are rejected while one blank side remains valid', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {basePrompt: 'original', negativePrompt: 'negative'}});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    const apply = byText(fixture.host, '편집한 프롬프트로 연결');
    prompt.value = ' ,,, ';
    prompt.emit('input');
    byId(fixture.host, 'dakiProjectStylePickerNegativeTab').emit('click');
    prompt.value = '   ';
    prompt.emit('input');
    assert.equal(apply.disabled, true);
    prompt.value = '';
    prompt.emit('input');
    assert.equal(apply.disabled, true);
    prompt.value = 'negative';
    prompt.emit('input');
    assert.equal(apply.disabled, false);
    apply.emit('click');
    assert.equal(fixture.selected[0].positive, ' ,,, ');
    assert.equal(fixture.selected[0].negative, 'negative');
    fixture.picker.dispose();
});

test('prompt length limit disables apply above 100000 characters and accepts the limit', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {basePrompt: 'original', negativePrompt: ''}});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    const apply = byText(fixture.host, '편집한 프롬프트로 연결');
    prompt.value = 'x'.repeat(100001);
    prompt.emit('input');
    assert.equal(apply.disabled, true);
    prompt.value = 'x'.repeat(100000);
    prompt.emit('input');
    assert.equal(apply.disabled, false);
    fixture.picker.dispose();
});

test('imports checked character prompts in source order to the chosen side without requiring a style', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: '', negativePrompt: '', charPrompts: ['first', 'second', 'third'],
        }});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const rows = byClass(fixture.host, 'daki-project-style-picker-character-row');
    assert.equal(rows.length, 3);
    const checkboxes = rows.map(row => row.children[0].children[0]);
    const prompts = rows.map(row => row.children[1]);
    assert.deepEqual(checkboxes.map(checkbox => checkbox.checked), [false, false, false]);
    assert.equal(prompts[0].getAttribute('aria-label'), 'Character 1 가져올 프롬프트');
    prompts[0].value = ' first edited ';
    prompts[0].emit('input');
    checkboxes[2].checked = true;
    checkboxes[2].emit('change');
    checkboxes[0].checked = true;
    checkboxes[0].emit('change');
    const side = byId(fixture.host, 'dakiProjectStylePickerCharacterSide');
    assert.equal(side.value, 'front');
    side.value = 'back';
    side.emit('change');
    assert.equal(byText(fixture.host, '편집한 프롬프트로 연결').disabled, false);
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.equal(fixture.selected[0], null);
    assert.deepEqual(json(fixture.selectedImports[0]), {
        side: 'back', charPrompts: [' first edited ', 'third'], inpaintSettings: null,
    });
    fixture.picker.dispose();
});

test('parses available generation fields, preserves zero, and supports legacy metadata fallbacks', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: '', negativePrompt: '',
            model: {bad: true}, modelName: 'future-model', model_name: 'ignored-model',
            sampler: 'future-sampler', steps: '28', cfg: '', scale: '7.5', cfg_rescale: 0,
            noise_schedule: 'future-schedule', seed: '0', strength: 'invalid', noise: false,
        }});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const checkbox = byId(fixture.host, 'dakiProjectStylePickerImportGeneration');
    assert.equal(checkbox.checked, true);
    assert.equal(checkbox.disabled, false);
    assert.deepEqual(byClass(fixture.host, 'daki-project-style-picker-generation-row').map(row => row.textContent), [
        '모델future-model', '샘플러future-sampler', 'Steps28', 'CFG7.5', 'Rescale0',
        '노이즈 스케줄future-schedule', '시드0',
    ]);
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.equal(fixture.selected[0], null);
    assert.deepEqual(json(fixture.selectedImports[0]), {
        side: 'front', charPrompts: [],
        inpaintSettings: {
            model: 'future-model', sampler: 'future-sampler', steps: 28, cfg: 7.5,
            cfg_rescale: 0, noise_schedule: 'future-schedule', seed: 0,
        },
    });
    fixture.picker.dispose();
});

test('missing, empty, and malformed character metadata does not block base or generation imports', async () => {
    const cases = [
        {label: 'missing', omit: true, message: '이 그림에 캐릭터 프롬프트가 없습니다.'},
        {label: 'empty', value: [], message: '이 그림에 캐릭터 프롬프트가 없습니다.'},
        {label: 'non-array', value: 'not-an-array'},
        {label: 'too-many', value: Array(23).fill('character')},
        {label: 'non-string', value: ['valid', 7]},
        {label: 'too-long', value: ['x'.repeat(100001)]},
    ];
    for (const item of cases) {
        const fixture = createFixture(async url => {
            if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
            if (url === '/api/prompt_info') {
                const data = {basePrompt: 'base works', negativePrompt: '', steps: 19};
                if (!item.omit) data.charPrompts = item.value;
                return response({status: 'success', data});
            }
            throw new Error('unexpected request');
        });
        await fixture.picker.open({projectId});
        await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
        assert.equal(byClass(fixture.host, 'daki-project-style-picker-character-row').length, 0, item.label);
        assert.equal(byId(fixture.host, 'dakiProjectStylePickerCharacterSide').disabled, true, item.label);
        assert.equal(byId(fixture.host, 'dakiProjectStylePickerImportGeneration').checked, true, item.label);
        if (item.message) assert.equal(byClass(fixture.host, 'daki-project-style-picker-import-status')[0].textContent, item.message);
        else assert.match(byClass(fixture.host, 'daki-project-style-picker-import-status')[0].textContent, /가져올 수 없습니다/);
        byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
        assert.equal(fixture.selected[0].positive, 'base works', item.label);
        assert.deepEqual(json(fixture.selectedImports[0].charPrompts), [], item.label);
        assert.deepEqual(json(fixture.selectedImports[0].inpaintSettings), {steps: 19}, item.label);
        fixture.picker.dispose();
    }
});

test('rejects selected blank or oversized character edits and enables apply after correction', async () => {
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: '', negativePrompt: '', charPrompts: ['source prompt'],
        }});
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const row = byClass(fixture.host, 'daki-project-style-picker-character-row')[0];
    const checkbox = row.children[0].children[0];
    const prompt = row.children[1];
    const apply = byText(fixture.host, '편집한 프롬프트로 연결');
    checkbox.checked = true;
    checkbox.emit('change');
    prompt.value = '  \n';
    prompt.emit('input');
    assert.equal(apply.disabled, true);
    assert.match(byClass(fixture.host, 'daki-project-style-picker-import-status')[0].textContent, /비어 있을 수 없고/);
    prompt.value = 'x'.repeat(100001);
    prompt.emit('input');
    assert.equal(apply.disabled, true);
    prompt.value = ' valid ';
    prompt.emit('input');
    assert.equal(apply.disabled, false);
    const basePrompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    basePrompt.value = 'x'.repeat(100001);
    basePrompt.emit('input');
    assert.equal(apply.disabled, true, 'an oversized Base prompt blocks an otherwise valid character-only import');
    basePrompt.value = '';
    basePrompt.emit('input');
    assert.equal(apply.disabled, false);
    apply.emit('click');
    assert.equal(fixture.selected[0], null);
    assert.deepEqual(json(fixture.selectedImports[0].charPrompts), [' valid ']);
    fixture.picker.dispose();
});

test('keeps prompt and import drafts when settings callback returns an error string', async () => {
    let callbackCalls = 0;
    const fixture = createFixture(async url => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage]));
        if (url === '/api/prompt_info') return response({status: 'success', data: {
            basePrompt: 'source base', negativePrompt: '', charPrompts: ['source character'],
        }});
        throw new Error('unexpected request');
    }, {onSelect() { callbackCalls++; return callbackCalls === 1 ? '캐릭터 목록이 가득 찼습니다.' : undefined; }});
    await fixture.picker.open({projectId});
    await byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const prompt = byId(fixture.host, 'dakiProjectStylePickerPromptText');
    prompt.value = 'edited base';
    prompt.emit('input');
    const row = byClass(fixture.host, 'daki-project-style-picker-character-row')[0];
    row.children[0].children[0].checked = true;
    row.children[0].children[0].emit('change');
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-draft')[0].hidden, false);
    assert.equal(fixture.pending.at(-1), true);
    assert.equal(prompt.value, 'edited base');
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-status')[1].textContent, '캐릭터 목록이 가득 찼습니다.');
    byText(fixture.host, '편집한 프롬프트로 연결').emit('click');
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-draft')[0].hidden, true);
    assert.equal(fixture.pending.at(-1), false);
    fixture.picker.dispose();
});

test('new candidate resets character and generation import state to its side and metadata', async () => {
    const fixture = createFixture(async (url, options = {}) => {
        if (url.includes('/api/daki/projects/')) return response(projectPayload([frontImage], [backImage]));
        if (url === '/api/prompt_info') {
            const path = JSON.parse(options.body).path;
            return path === frontImage.path
                ? response({status: 'success', data: {basePrompt: 'front', negativePrompt: '', charPrompts: ['first'], steps: 19}})
                : response({status: 'success', data: {basePrompt: 'back', negativePrompt: ''}});
        }
        throw new Error('unexpected request');
    });
    await fixture.picker.open({projectId});
    const cards = byClass(fixture.host, 'daki-project-style-picker-card');
    await cards[0].emit('click')[0];
    const firstRow = byClass(fixture.host, 'daki-project-style-picker-character-row')[0];
    firstRow.children[0].children[0].checked = true;
    firstRow.children[0].children[0].emit('change');
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerImportGeneration').checked, true);
    await cards[1].emit('click')[0];
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerCharacterSide').value, 'back');
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerImportGeneration').checked, false);
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerImportGeneration').disabled, true);
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-character-row').length, 0);
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-import-status')[0].textContent, '이 그림에 캐릭터 프롬프트가 없습니다.');
    assert.equal(byId(fixture.host, 'dakiProjectStylePickerPromptText').value, 'back');
    fixture.picker.cancel();
    assert.equal(byClass(fixture.host, 'daki-project-style-picker-character-row').length, 0);
    fixture.picker.dispose();
});

test('switching project and closing during requests blocks late responses', async () => {
    const pendingProjects = new Map();
    const pendingPrompts = new Map();
    const fixture = createFixture((url, options = {}) => {
        if (url.includes('/api/daki/projects/')) {
            const id = decodeURIComponent(url.split('/').pop());
            return new Promise(resolve => pendingProjects.set(id, resolve));
        }
        if (url === '/api/prompt_info') {
            const path = JSON.parse(options.body).path;
            return new Promise(resolve => pendingPrompts.set(path, resolve));
        }
        throw new Error('unexpected request');
    });

    const openOld = fixture.picker.open({projectId});
    pendingProjects.get(projectId)(response(projectPayload([frontImage])));
    await openOld;
    const oldCardClick = byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    const nextProjectId = 'abcdef0123456789abcdef0123456789';
    const openNew = fixture.picker.open({projectId: nextProjectId});
    pendingProjects.get(nextProjectId)(response(projectPayload([], [backImage])));
    await openNew;
    pendingPrompts.get(frontImage.path)(response({status: 'success', data: {basePrompt: 'stale', negativePrompt: ''}}));
    await oldCardClick;
    assert.deepEqual(byClass(fixture.host, 'daki-project-style-picker-card').map(card => card.textContent), ['뒷면 · back-image']);

    const newCardClick = byClass(fixture.host, 'daki-project-style-picker-card')[0].emit('click')[0];
    fixture.picker.dispose();
    pendingPrompts.get(backImage.path)(response({status: 'success', data: {basePrompt: 'late', negativePrompt: ''}}));
    await newCardClick;
    assert.equal(fixture.selected.length, 0);
    assert.equal(fixture.host.children.length, 0);
});
