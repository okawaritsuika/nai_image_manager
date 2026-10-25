const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_setups.js'), 'utf8');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.attributes = {};
        this.listeners = new Map();
        this.style = {};
        this.className = '';
        this.hidden = false;
        this.open = false;
        this.value = '';
        this._textContent = '';
        this.classList = {
            add: name => { this.className = `${this.className} ${name}`.trim(); },
            remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
            contains: name => this.className.split(/\s+/).includes(name),
        };
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, reference) {
        const index = this.children.indexOf(reference);
        child.parentNode = this;
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        return child;
    }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._textContent = '';
        children.forEach(child => this.appendChild(child));
    }
    set textContent(value) {
        this.replaceChildren();
        this._textContent = String(value ?? '');
    }
    get textContent() {
        return this._textContent + this.children.map(child => child.textContent).join('');
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) || [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
    }
    dispatch(name) { (this.listeners.get(name) || []).forEach(callback => callback({target: this})); }
    click() { this.dispatch('click'); }
    showModal() { this.open = true; }
    close() {
        if (!this.open) return;
        this.open = false;
        this.dispatch('close');
    }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        return this.tagName === selector;
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

function harness() {
    const requests = [];
    const managers = [];
    const document = {
        body: new FakeElement('body'),
        createElement: tagName => new FakeElement(tagName),
        getElementById(id) {
            const visit = node => {
                if (node.id === id) return node;
                for (const child of node.children) {
                    const match = visit(child);
                    if (match) return match;
                }
                return null;
            };
            return visit(this.body);
        },
    };
    const modal = new FakeElement('div');
    modal.id = 'savedCanvasSetupsModal';
    modal.style.display = 'none';
    const content = new FakeElement('div');
    content.className = 'modal-content saved-canvas-modal';
    const header = new FakeElement('div');
    header.className = 'saved-canvas-modal-header';
    const list = new FakeElement('div');
    list.id = 'savedCanvasSetupList';
    list.className = 'saved-canvas-list';
    content.append(header, list);
    modal.appendChild(content);
    document.body.appendChild(modal);

    const previewApi = {
        create() {
            const manager = {
                observations: [],
                disposed: false,
                observeState(container, item) {
                    this.observations.push({container, item});
                    container.textContent = '합성 미리보기';
                },
                dispose() { this.disposed = true; },
            };
            managers.push(manager);
            return manager;
        },
    };
    const context = {
        document,
        window: {DakiCanvasPreviews: previewApi},
        localStorage: {getItem: () => null},
        CANVAS_SAVED_SETUPS_KEY: 'synthetic-key',
        cachedSavedCanvasSetups: null,
        savedCanvasSetupsLoadPromise: null,
        savedCanvasSetupsSavePromise: Promise.resolve(),
        canvasLegacySetupMigrationMessage: '',
        console: {warn() {}},
        el: id => document.getElementById(id),
        getCanvasSaveModeLabel: mode => mode === 'imageOnly' ? '그림만 저장' : '전체 저장',
        fetch: url => {
            const request = deferred();
            requests.push({url, ...request});
            return request.promise;
        },
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return {context, document, modal, list, requests, managers};
}

function reply(request, setups, {ok = true} = {}) {
    request.resolve({
        ok,
        json: async () => ({status: ok ? 'success' : 'error', allowLegacyMigration: false, setups}),
    });
}

const setup = (name = 'Synthetic canvas') => ({
    id: 'synthetic-canvas', name, savedAt: 1234, width: 640, height: 480,
    state: {width: 640, height: 480, layers: [{type: 'synthetic'}]},
    layerCount: 1, saveMode: 'normal',
});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('gallery distinguishes load failure, retries, filters safely, and disposes preview managers', async () => {
    const h = harness();
    const opening = h.context.openSavedCanvasSetupsModal();
    assert.equal(h.modal.style.display, 'flex');
    assert.equal(h.requests.length, 1);

    reply(h.requests[0], [], {ok: false});
    await opening;
    assert.match(h.list.textContent, /불러오지 못했습니다/);
    assert.doesNotMatch(h.list.textContent, /저장된 캔버스가 없습니다/);
    const retry = h.document.getElementById('savedCanvasSetupsModal').querySelector('.saved-canvas-retry');
    assert.equal(retry.hidden, false);

    retry.click();
    await flush();
    assert.equal(h.requests.length, 2);
    const unsafeName = '<img src=x onerror=alert(1)>';
    reply(h.requests[1], [setup(unsafeName)]);
    await flush();
    await flush();

    assert.equal(h.list.querySelector('.saved-canvas-name').textContent, unsafeName);
    assert.equal(h.managers.length, 1);
    assert.equal(h.managers[0].observations.length, 1);
    assert.equal(h.managers[0].observations[0].item.state.width, 640);

    const search = h.document.getElementById('savedCanvasSetupsModal').querySelector('.saved-canvas-search');
    search.value = 'no match';
    search.dispatch('input');
    assert.match(h.list.textContent, /검색 결과가 없습니다/);
    assert.equal(h.managers[0].disposed, true);
    assert.match(h.document.getElementById('savedCanvasSetupsModal').querySelector('.saved-canvas-result-count').textContent, /0 \/ 1개/);

    search.value = '';
    search.dispatch('input');
    const thumbnail = h.list.querySelector('.saved-canvas-thumbnail');
    thumbnail.click();
    const dialog = h.document.getElementById('savedCanvasPreviewDialog');
    assert.equal(dialog.open, true);
    assert.equal(h.document.getElementById('savedCanvasPreviewTitle').textContent, unsafeName);
    assert.equal(h.managers.at(-1).observations[0].item.id, 'synthetic-canvas');

    h.context.closeSavedCanvasSetupsModal();
    assert.equal(h.modal.style.display, 'none');
    assert.equal(dialog.open, false);
    assert.equal(h.managers.at(-1).disposed, true);
});

test('an empty successful response is distinct from a failed load', async () => {
    const h = harness();
    const opening = h.context.openSavedCanvasSetupsModal();
    const duplicateOpening = h.context.openSavedCanvasSetupsModal();
    assert.equal(h.requests.length, 1);
    reply(h.requests[0], []);
    await Promise.all([opening, duplicateOpening]);
    await h.context.openSavedCanvasSetupsModal();
    assert.equal(h.requests.length, 1);
    assert.match(h.list.textContent, /저장된 캔버스가 없습니다/);
    assert.doesNotMatch(h.list.textContent, /불러오지 못했습니다/);
});

test('a response arriving after close cannot reopen or rerender the gallery', async () => {
    const h = harness();
    const opening = h.context.openSavedCanvasSetupsModal();
    const before = h.list.textContent;
    h.context.closeSavedCanvasSetupsModal();
    reply(h.requests[0], [setup()]);
    await opening;
    assert.equal(h.modal.style.display, 'none');
    assert.equal(h.list.textContent, before);
    assert.equal(h.managers.length, 0);
});
