const test = require('node:test');
const assert = require('node:assert/strict');
const Presets = require('../static/canvas_detail_presets.js');

const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { await flush(); await flush(); };
const preset = (id, name, overrides = {}) => ({id, name, category: 'Body', base: `${name} base`, negative: `${name} negative`, ...overrides});
const catalog = (common = [], project = [], projectId = 'project-a', commonRevision = 0, projectRevision = 0) => ({
    status: 'success', projectId,
    common: {revision: commonRevision, items: common},
    project: projectId ? {revision: projectRevision, items: project} : null
});
const ok = (payload, status = 200) => ({ok: status >= 200 && status < 300, status, async json() { return payload; }});
const failure = (message = 'failed', status = 500) => ok({status: 'error', message}, status);

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.dataset = {};
        this.style = {};
        this.value = '';
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.parentNode = null;
        this._text = '';
        this.className = '';
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._text = String(value ?? '');
    }
    appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._text = '';
        this.append(...children);
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    dispatch(type, props = {}) {
        const event = {type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...props};
        for (const callback of this.listeners[type] || []) callback(event);
        return event;
    }
    click() { return this.dispatch('click'); }
    focus() { this.focused = true; }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    matches(selector) {
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map(item => item.trim());
        return this.descendants().filter(child => selectors.some(item => child.matches(item)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture({link = {projectId: 'project-a', projectName: 'Sample Project'}, fetch, getUuid} = {}) {
    const doc = {createElement: tag => new FakeElement(tag)};
    doc.body = new FakeElement('body');
    doc.getElementById = id => doc.body.descendants().find(item => item.id === id) || null;
    const base = new FakeElement('textarea'); base.id = 'clipInstancePromptInput'; base.value = '';
    const negative = new FakeElement('textarea'); negative.id = 'clipInstanceNegativePromptInput'; negative.value = '';
    const picker = new FakeElement('div'); picker.id = 'clipDetailPresetPicker';
    const manager = new FakeElement('div'); manager.id = 'canvasDetailPresetModal'; manager.hidden = true;
    doc.body.append(base, negative, picker, manager);
    const window = {
        document: doc,
        crypto: {randomUUID: getUuid || (() => '00000000-0000-4000-8000-000000000001')},
        AbortController,
        addEventListener() {}
    };
    const controller = Presets.createCanvasDetailPresetsController({
        document: doc, window, fetch, getLink: () => link && {...link},
        getInputs: () => ({base, negative}), randomUUID: window.crypto.randomUUID
    });
    return {controller, doc, window, base, negative, picker, manager, setLink(value) { link = value; }};
}

function byClass(root, className) { return root.querySelectorAll('.' + className); }
function byId(doc, id) { const result = doc.getElementById(id); assert.ok(result, `missing #${id}`); return result; }

test('append preserves original bytes and weight syntax while handling commas and blank fields', () => {
    const originalBase = '  1.2::(weighted tag)::  ';
    const originalNegative = '{.6::[avoid tag]::},';
    const result = Presets.appendPromptPair(originalBase, originalNegative, {
        base: '2::(second weighted)::', negative: 'new negative'
    });
    assert.equal(result.base, originalBase + ', 2::(second weighted)::');
    assert.equal(result.negative, originalNegative + ' new negative');
    assert.deepEqual(Presets.appendPromptPair('raw', 'negative', {base: '', negative: '  '}), {
        base: 'raw', negative: 'negative'
    });
    assert.equal(Presets.appendPromptText('', '  preserved incoming  '), '  preserved incoming  ');
});

test('picker combines scopes, filters all fields, appends both values repeatedly, and disables without a clip', async () => {
    const calls = [];
    const common = preset('c1', 'Common pose', {base: '2::(anatomy)::', category: 'Anatomy'});
    const project = preset('p1', '프로젝트 자세', {negative: 'path_like_negative'});
    const h = fixture({fetch: async url => {
        calls.push(url);
        return ok(catalog([common], [project]));
    }});
    h.base.value = '1::(existing raw)::';
    h.negative.value = 'old negative,';
    h.controller.refreshPicker();
    await settle();

    const details = byClass(h.picker, 'canvas-detail-preset-picker')[0];
    assert.equal(details.children[0].tagName, 'SUMMARY', 'summary is a direct details child');
    assert.equal(byClass(h.picker, 'canvas-detail-preset-chip').length, 2);
    assert.ok(calls[0].includes('project_id=project-a'));
    const chips = byClass(h.picker, 'canvas-detail-preset-chip');
    chips[0].click();
    chips[0].click();
    assert.equal(h.base.value, '1::(existing raw)::, 2::(anatomy)::, 2::(anatomy)::');
    assert.equal(h.negative.value, 'old negative, Common pose negative, Common pose negative');

    const search = byId(h.doc, 'canvasDetailPresetSearch');
    search.value = 'path_like_negative';
    search.dispatch('input');
    assert.equal(byClass(h.picker, 'canvas-detail-preset-chip').length, 1);
    assert.match(byClass(h.picker, 'canvas-detail-preset-chip')[0].textContent, /프로젝트 자세/);
    const category = byId(h.doc, 'canvasDetailPresetCategory');
    category.value = 'Anatomy';
    category.dispatch('change');
    assert.equal(byClass(h.picker, 'canvas-detail-preset-chip').length, 0);

    h.negative.disabled = true;
    search.value = '';
    category.value = '';
    search.dispatch('input');
    assert.ok(byClass(h.picker, 'canvas-detail-preset-chip').every(button => button.disabled));
    const before = h.base.value;
    byClass(h.picker, 'canvas-detail-preset-chip')[0].click();
    assert.equal(h.base.value, before);
});

test('picker retry is visible after a failed read and a closed picker ignores late results', async () => {
    let mode = 'failure';
    let pending;
    const h = fixture({fetch: (_url, options) => {
        if (mode === 'failure') return Promise.resolve(failure('offline'));
        return new Promise(resolve => { pending = {resolve, signal: options.signal}; });
    }});
    h.controller.refreshPicker();
    await settle();
    const retry = byClass(h.picker, 'canvas-detail-preset-retry')[0];
    assert.equal(retry.hidden, false);
    mode = 'pending';
    retry.click();
    assert.ok(pending);
    h.controller.closePicker();
    pending.resolve(ok(catalog([preset('late', 'late read')], [])));
    await settle();
    assert.equal(h.controller.getState().catalog.picker, null);
    assert.equal(byClass(h.picker, 'canvas-detail-preset-chip').length, 0);
});

test('project switch discards old picker results and only shows the newly linked project', async () => {
    const requests = [];
    const h = fixture({fetch: (url, options) => new Promise(resolve => requests.push({url, options, resolve}))});
    h.controller.refreshPicker();
    assert.equal(requests.length, 1);
    h.setLink({projectId: 'project-b', projectName: 'New Project'});
    h.controller.linkChanged();
    assert.equal(requests.length, 2);
    requests[0].resolve(ok(catalog([preset('old', 'Old project item')], [], 'project-a')));
    requests[1].resolve(ok(catalog([preset('new', 'New project item')], [], 'project-b')));
    await settle();
    assert.equal(byClass(h.picker, 'canvas-detail-preset-chip').length, 1);
    assert.match(byClass(h.picker, 'canvas-detail-preset-chip')[0].textContent, /New project item/);
    assert.equal(h.controller.getState().catalog.picker.projectId, 'project-b');
});

test('manager saves revision zero in the selected scope and includes linked project context for common data', async () => {
    const calls = [];
    let stored = catalog([], [], 'project-a', 0, 0);
    const h = fixture({fetch: async (url, options = {}) => {
        if (options.method === 'GET') return ok(stored);
        calls.push({url, method: options.method, body: JSON.parse(options.body)});
        stored = catalog([preset('new-id', '새 자세')], [], 'project-a', 1, 0);
        return ok(stored);
    }});
    h.controller.openManager();
    await settle();
    byId(h.doc, 'canvasDetailPresetName').value = '새 자세';
    byId(h.doc, 'canvasDetailPresetCategoryInput').value = 'Anatomy';
    byId(h.doc, 'canvasDetailPresetBase').value = 'base detail';
    byId(h.doc, 'canvasDetailPresetNegative').value = 'negative detail';
    const save = byClass(h.manager, 'primary')[0];
    save.click();
    await settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].body, {
        scope: 'common', projectId: 'project-a', revision: 0,
        preset: {id: '00000000-0000-4000-8000-000000000001', name: '새 자세', category: 'Anatomy', base: 'base detail', negative: 'negative detail'}
    });
    assert.equal(byId(h.doc, 'canvasDetailPresetScope').disabled, false);
    assert.equal(byId(h.doc, 'canvasDetailPresetName').value, '');
});

test('failed create retains draft and reuses its POST id; duplicate submits are ignored while pending', async () => {
    const calls = [];
    const replies = [];
    let idCount = 0;
    let reads = catalog([], [], 'project-a', 0, 0);
    const h = fixture({getUuid: () => `stable-id-${++idCount}`, fetch: (url, options = {}) => {
        if (options.method === 'GET') return Promise.resolve(ok(reads));
        calls.push({method: options.method, body: JSON.parse(options.body)});
        return new Promise(resolve => replies.push(resolve));
    }});
    h.controller.openManager();
    await settle();
    byId(h.doc, 'canvasDetailPresetName').value = 'Retry me';
    byId(h.doc, 'canvasDetailPresetCategoryInput').value = 'Figure';
    byId(h.doc, 'canvasDetailPresetBase').value = 'new base';
    byId(h.doc, 'canvasDetailPresetNegative').value = '';
    const save = byClass(h.manager, 'primary')[0];
    save.click();
    save.click();
    assert.equal(calls.length, 1);
    assert.equal(idCount, 1);
    assert.equal(save.disabled, true);
    replies.shift()(failure('temporary error'));
    await settle();
    assert.equal(byId(h.doc, 'canvasDetailPresetName').value, 'Retry me');
    assert.equal(save.disabled, false);

    save.click();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.preset.id, calls[1].body.preset.id);
    assert.equal(idCount, 1);
    reads = catalog([preset(calls[1].body.preset.id, 'Retry me', {category: 'Figure', base: 'new base', negative: ''})], [], 'project-a', 1, 0);
    replies.shift()(ok(reads));
    await settle();
    assert.equal(byId(h.doc, 'canvasDetailPresetName').value, '');
    assert.equal(h.controller.getState().catalog.manager.common.revision, 1);
});

test('manager edits and project copies never send to an unintended scope', async () => {
    const calls = [];
    let current = catalog([preset('common-one', 'Common item')], [preset('project-one', 'Project item')], 'project-a', 4, 7);
    const h = fixture({fetch: async (_url, options = {}) => {
        if (options.method === 'GET') return ok(current);
        const body = JSON.parse(options.body);
        calls.push({method: options.method, body});
        if (body.scope === 'project') current = catalog([preset('common-one', 'Common item')],
            [preset(body.preset.id, body.preset.name, body.preset)], 'project-a', 4, 8);
        else current = catalog([preset(body.preset.id, body.preset.name, body.preset)],
            [preset('project-one', 'Project item')], 'project-a', 5, 7);
        return ok(current);
    }});
    h.controller.openManager();
    await settle();
    const edit = byClass(h.manager, 'canvas-detail-preset-manager-card')[0].querySelector('button');
    edit.click();
    assert.equal(byId(h.doc, 'canvasDetailPresetScope').disabled, true);
    byId(h.doc, 'canvasDetailPresetName').value = 'Changed common';
    byClass(h.manager, 'primary')[0].click();
    await settle();
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].body.scope, 'common');
    assert.equal(calls[0].body.preset.id, 'common-one');
    assert.equal(byId(h.doc, 'canvasDetailPresetScope').disabled, false);

    const copy = byClass(h.manager, 'canvas-detail-preset-manager-card')[0].querySelectorAll('button')[1];
    copy.click();
    assert.equal(byId(h.doc, 'canvasDetailPresetScope').value, 'project');
    byClass(h.manager, 'primary')[0].click();
    await settle();
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].body.scope, 'project');
    assert.equal(calls[1].body.projectId, 'project-a');
});

test('conflict reload updates the revision without replacing the user draft', async () => {
    const calls = [];
    let gets = 0;
    let current = catalog([preset('existing', 'Original')], [], 'project-a', 0, 0);
    const h = fixture({fetch: async (_url, options = {}) => {
        if (options.method === 'GET') {
            gets += 1;
            if (gets === 2) current = catalog([preset('existing', 'Remote edit')], [], 'project-a', 1, 0);
            return ok(current);
        }
        const body = JSON.parse(options.body);
        calls.push({method: options.method, body});
        if (calls.length === 1) return failure('stale revision', 409);
        current = catalog([preset('existing', body.preset.name, body.preset)], [], 'project-a', 2, 0);
        return ok(current);
    }});
    h.controller.openManager();
    await settle();
    byClass(h.manager, 'canvas-detail-preset-manager-card')[0].querySelector('button').click();
    byId(h.doc, 'canvasDetailPresetName').value = 'My draft';
    const save = byClass(h.manager, 'primary')[0];
    save.click();
    await settle();
    assert.equal(save.disabled, true);
    const reload = h.manager.querySelectorAll('button').find(button => button.textContent === '최신 목록 다시 불러오기');
    assert.equal(reload.hidden, false);
    reload.click();
    await settle();
    assert.equal(byId(h.doc, 'canvasDetailPresetName').value, 'My draft');
    assert.equal(save.disabled, false);
    save.click();
    await settle();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.revision, 0);
    assert.equal(calls[1].body.revision, 1);
    assert.equal(calls[1].body.preset.name, 'My draft');
});

test('closing and reopening manager prevents an old mutation response from repainting the new session', async () => {
    const replies = [];
    let current = catalog([], [], 'project-a', 0, 0);
    const h = fixture({fetch: (url, options = {}) => {
        if (options.method === 'GET') return Promise.resolve(ok(current));
        return new Promise(resolve => replies.push(resolve));
    }});
    h.controller.openManager();
    await settle();
    byId(h.doc, 'canvasDetailPresetName').value = 'Old session';
    byId(h.doc, 'canvasDetailPresetCategoryInput').value = 'Anatomy';
    byId(h.doc, 'canvasDetailPresetBase').value = 'old';
    byClass(h.manager, 'primary')[0].click();
    assert.equal(replies.length, 1);
    h.controller.closeManager();
    h.controller.openManager();
    await settle();
    byId(h.doc, 'canvasDetailPresetName').value = 'New session draft';
    replies.shift()(ok(current));
    await settle();
    assert.equal(byId(h.doc, 'canvasDetailPresetName').value, 'New session draft');
    assert.doesNotMatch(byClass(h.manager, 'canvas-detail-preset-manager-card')[0]?.textContent || '', /Old session/);
});

test('pending delete cannot restore its confirmation into a reopened manager session', async () => {
    const deleteReplies = [];
    const item = preset('delete-me', 'Delete me');
    const current = catalog([item], [], 'project-a', 3, 0);
    const h = fixture({fetch: (url, options = {}) => {
        if (options.method === 'GET') return Promise.resolve(ok(current));
        return new Promise(resolve => deleteReplies.push(resolve));
    }});
    h.controller.openManager();
    await settle();
    const card = byClass(h.manager, 'canvas-detail-preset-manager-card')[0];
    card.querySelectorAll('button').find(button => button.textContent === '삭제').click();
    const confirm = byClass(h.manager, 'canvas-detail-preset-manager-card')[0]
        .querySelector('.canvas-detail-preset-delete-confirm');
    confirm.querySelectorAll('button').find(button => button.textContent === '삭제').click();
    assert.equal(deleteReplies.length, 1);

    h.controller.closeManager();
    h.controller.openManager();
    await settle();
    deleteReplies.shift()(ok(catalog([], [], 'project-a', 4, 0)));
    await settle();
    assert.equal(byClass(h.manager, 'canvas-detail-preset-delete-confirm').length, 0);
    assert.equal(byClass(h.manager, 'canvas-detail-preset-manager-card').length, 1,
        'new session keeps the list fetched for its own context');
});

