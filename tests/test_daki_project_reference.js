const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/daki_project_reference.js'), 'utf8');
const canvasReference = require('../static/canvas_inpaint_reference.js');

class FakeClassList {
    constructor(element) { this.element = element; }
    values() { return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean)); }
    add(name) { const values = this.values(); values.add(name); this.element.className = [...values].join(' '); }
    remove(name) { const values = this.values(); values.delete(name); this.element.className = [...values].join(' '); }
    contains(name) { return this.values().has(name); }
    toggle(name, force) {
        const values = this.values();
        const shouldAdd = force === undefined ? !values.has(name) : Boolean(force);
        if (shouldAdd) values.add(name); else values.delete(name);
        this.element.className = [...values].join(' ');
        return shouldAdd;
    }
}

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = new Map();
        this.className = '';
        this.classList = new FakeClassList(this);
        this.hidden = false;
        this.disabled = false;
        this.open = false;
        this.value = '';
        this.files = [];
        this._textContent = '';
    }
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
    get src() { return this._src; }
    set src(value) { this._src = String(value); this.attributes.src = this._src; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    appendChild(node) {
        if (node.parentNode) {
            const index = node.parentNode.children.indexOf(node);
            if (index >= 0) node.parentNode.children.splice(index, 1);
        }
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    remove() {
        if (!this.parentNode) return;
        const index = this.parentNode.children.indexOf(this);
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) {
        delete this.attributes[name];
        if (name === 'src') this._src = '';
    }
    addEventListener(name, callback) {
        const handlers = this.listeners.get(name) || [];
        handlers.push(callback);
        this.listeners.set(name, handlers);
    }
    removeEventListener(name, callback) {
        const handlers = this.listeners.get(name) || [];
        this.listeners.set(name, handlers.filter(handler => handler !== callback));
    }
    emit(name, event = {}) {
        const actual = {target: this, preventDefault() {}, stopPropagation() {}, ...event};
        if (typeof this['on' + name] === 'function') this['on' + name](actual);
        return (this.listeners.get(name) || []).map(callback => callback(actual));
    }
    click() { if (!this.disabled) this.emit('click'); }
    focus() { this.ownerDocument.activeElement = this; }
    showModal() { this.open = true; }
    close() {
        if (!this.open) return;
        this.open = false;
        this.emit('close');
    }
}

class FakeDocument {
    constructor() {
        this.activeElement = null;
        this.body = new FakeElement('body', this);
        this.body.isDocumentRoot = true;
    }
    createElement(tagName) { return new FakeElement(tagName, this); }
}

class FakeFormData {
    constructor() { this.values = []; }
    append(key, value) { this.values.push([key, value]); }
}

function response(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function settingsResponse(overrides = {}) {
    const defaults = {
        revision: 4,
        style: {id: 'synthetic-style', name: '합성 그림체', library: 'project', positive: 'base', negative: 'negative'},
        prompts: {
            front: {basePrompt: '합성 앞면', negativePrompt: '앞면 제외'},
            back: {basePrompt: '합성 뒷면', negativePrompt: '뒷면 제외'},
        },
        inpaintSettings: {model: 'nai-diffusion-5-full', sampler: 'k_euler_ancestral', steps: 28},
    };
    return {status: 'success', settings: {...defaults, ...overrides}};
}

function reference(name = 'reference.png', overrides = {}) {
    return {
        src: '/canvas-imports/synthetic/' + name,
        name,
        width: 320,
        x: 0.5,
        y: 0.5,
        zoom: 1,
        ...overrides,
    };
}

function descendants(node) { return [node, ...(node.children || []).flatMap(descendants)]; }
function byClass(node, className) { return descendants(node).find(item => item.classList.contains(className)) || null; }
function byText(node, tagName, text) {
    return descendants(node).find(item => item.tagName === tagName.toUpperCase() && item.textContent === text) || null;
}
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
}

function createFixture(fetchImpl) {
    const doc = new FakeDocument();
    const events = new Map();
    const channels = [];
    class FakeCustomEvent {
        constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    }
    class FakeChannel {
        constructor(name) {
            this.name = name;
            this.listeners = new Map();
            this.messages = [];
            this.closed = false;
            channels.push(this);
        }
        addEventListener(type, handler) {
            const values = this.listeners.get(type) || [];
            values.push(handler);
            this.listeners.set(type, values);
        }
        removeEventListener(type, handler) {
            this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== handler));
        }
        postMessage(data) { this.messages.push(data); }
        emit(data) { (this.listeners.get('message') || []).forEach(handler => handler({data})); }
        close() { this.closed = true; }
    }
    const win = {
        document: doc,
        AbortController,
        FormData: FakeFormData,
        BroadcastChannel: FakeChannel,
        CustomEvent: FakeCustomEvent,
        addEventListener(type, handler) {
            const values = events.get(type) || [];
            values.push(handler);
            events.set(type, values);
        },
        removeEventListener(type, handler) {
            events.set(type, (events.get(type) || []).filter(item => item !== handler));
        },
        dispatchEvent(event) { (events.get(event.type) || []).forEach(handler => handler(event)); },
        fetch: fetchImpl,
    };
    win.CanvasInpaintReference = canvasReference;
    const module = {exports: {}};
    vm.runInNewContext(source, {window: win, module, AbortController});
    const container = doc.createElement('div');
    doc.body.appendChild(container);
    return {api: module.exports, container, doc, win, events, channels};
}

function uploadElements(fixture) {
    return {
        add: byText(fixture.container, 'button', '이미지 추가') || byText(fixture.container, 'button', '이미지 교체'),
        view: byText(fixture.container, 'button', '크게 보기'),
        refresh: byText(fixture.container, 'button', '새로고침'),
        input: byClass(fixture.container, 'daki-project-reference-file'),
        status: byClass(fixture.container, 'daki-project-reference-status'),
        preview: byClass(fixture.container, 'daki-project-reference-preview-image'),
        name: byClass(fixture.container, 'daki-project-reference-name'),
    };
}

test('initial GET shows an existing project reference and handles an empty project', async () => {
    const calls = [];
    const fixture = createFixture(async (url, options) => {
        calls.push({url, options});
        return response(settingsResponse({inpaintReference: reference('existing.webp', {width: 384})}));
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'project/one'});
    await flush();

    assert.equal(byClass(fixture.container, 'daki-project-reference').getAttribute('aria-label'), '인페인팅 참고 이미지');
    assert.equal(calls[0].url, '/api/daki/projects/project%2Fone/canvas-settings');
    assert.equal(uploadElements(fixture).preview.src, '/canvas-imports/synthetic/existing.webp?preview=256');
    assert.equal(uploadElements(fixture).name.textContent, 'existing.webp');
    assert.equal(uploadElements(fixture).view.disabled, false);
    assert.equal(byClass(fixture.doc.body, 'daki-project-reference-dialog-image').getAttribute('src'), null,
        'a closed viewer must not request the full-size image');
    mounted.dispose();

    const emptyFixture = createFixture(async () => response(settingsResponse()));
    const emptyMount = emptyFixture.api.mount({container: emptyFixture.container, projectId: 'empty-project'});
    await flush();
    assert.equal(uploadElements(emptyFixture).name.textContent, '등록된 참고 이미지가 없습니다.');
    assert.equal(uploadElements(emptyFixture).view.disabled, true);
    assert.equal(uploadElements(emptyFixture).status.textContent, '등록된 참고 이미지가 없습니다.');
    emptyMount.dispose();

    const failedFixture = createFixture(async () => response({status: 'error', message: 'synthetic GET failure'}, 500));
    const failedMount = failedFixture.api.mount({container: failedFixture.container, projectId: 'failed-project'});
    await flush();
    assert.equal(uploadElements(failedFixture).name.textContent, '프로젝트 참고 이미지 상태를 불러오지 못했습니다.');
    assert.match(uploadElements(failedFixture).status.textContent, /새로고침/);
    assert.equal(uploadElements(failedFixture).add.disabled, false);
    failedMount.dispose();
});

test('upload then GET and PUT preserves settings and the saved reference width', async () => {
    const calls = [];
    const base = settingsResponse({revision: 9, inpaintReference: reference('old.png', {width: 448})});
    const fixture = createFixture(async (url, options = {}) => {
        calls.push({url, options});
        if (url === '/api/canvas/upload_image') {
            return response({status: 'success', src: '/canvas-imports/upload/new.webp', name: 'new.webp', width: 800, height: 600});
        }
        if (options.method === 'PUT') {
            const body = JSON.parse(options.body);
            return response({status: 'success', settings: {...body.settings, revision: body.revision + 1}});
        }
        return response(base);
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'a'.repeat(32)});
    await flush();
    const controls = uploadElements(fixture);
    controls.add.click();
    controls.input.files = [{name: 'new.webp', type: 'image/webp'}];
    controls.input.emit('change');
    await flush();

    assert.deepEqual(calls.map(call => call.options.method || 'GET'), ['GET', 'POST', 'GET', 'PUT']);
    assert.equal(calls[1].options.body.values[0][0], 'file');
    const saved = JSON.parse(calls[3].options.body);
    assert.equal(saved.revision, 9);
    assert.deepEqual(saved.settings.style, base.settings.style);
    assert.deepEqual(saved.settings.prompts, base.settings.prompts);
    assert.deepEqual(saved.settings.inpaintSettings, base.settings.inpaintSettings);
    assert.deepEqual(saved.settings.inpaintReference, {
        src: '/canvas-imports/upload/new.webp', name: 'new.webp', width: 448, x: 0.5, y: 0.5, zoom: 1,
    });
    assert.equal(controls.preview.src, '/canvas-imports/upload/new.webp?preview=256');
    assert.equal(controls.add.textContent, '이미지 교체');
    assert.equal(controls.status.textContent, '인페인팅 참고 이미지를 프로젝트에 등록했습니다.');
    assert.deepEqual(JSON.parse(JSON.stringify(fixture.channels[0].messages)), [{projectId: 'a'.repeat(32)}]);
    mounted.dispose();
});

test('PNG, JPEG, WebP extensions and MIME types are accepted while unsupported files are rejected', async () => {
    const acceptedFiles = [
        {name: 'a.png', type: 'application/octet-stream'},
        {name: 'b.jpg', type: 'image/jpeg'},
        {name: 'c.webp', type: 'image/webp'},
    ];
    const calls = [];
    const fixture = createFixture(async (url, options = {}) => {
        calls.push({url, options});
        if (url === '/api/canvas/upload_image') {
            return response({status: 'success', src: '/canvas-imports/synthetic/upload.png', name: 'upload.png', width: 16, height: 16});
        }
        if (options.method === 'PUT') {
            const body = JSON.parse(options.body);
            return response({status: 'success', settings: {...body.settings, revision: body.revision + 1}});
        }
        return response(settingsResponse());
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'formats'});
    await flush();
    const {add, input, status} = uploadElements(fixture);
    for (const file of acceptedFiles) {
        add.click();
        input.files = [file];
        input.emit('change');
        await flush();
    }
    const postCount = calls.filter(call => call.url === '/api/canvas/upload_image').length;
    assert.equal(postCount, acceptedFiles.length);

    add.click();
    input.files = [{name: 'bad.gif', type: 'image/gif'}];
    input.emit('change');
    await flush();
    assert.equal(calls.filter(call => call.url === '/api/canvas/upload_image').length, postCount);
    assert.match(status.textContent, /PNG, JPEG, WebP/);
    mounted.dispose();
});

test('duplicate upload clicks are blocked while an upload is pending', async () => {
    const upload = deferred();
    const calls = [];
    const fixture = createFixture(async (url, options = {}) => {
        calls.push({url, options});
        if (url === '/api/canvas/upload_image') return upload.promise;
        if (options.method === 'PUT') {
            const body = JSON.parse(options.body);
            return response({status: 'success', settings: {...body.settings, revision: body.revision + 1}});
        }
        return response(settingsResponse());
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'busy'});
    await flush();
    const controls = uploadElements(fixture);
    controls.add.click();
    controls.input.files = [{name: 'busy.png', type: 'image/png'}];
    controls.input.emit('change');
    controls.add.click();
    controls.refresh.click();
    assert.equal(calls.filter(call => call.url === '/api/canvas/upload_image').length, 1);
    assert.equal(calls.filter(call => call.url.endsWith('/canvas-settings')).length, 1);
    assert.equal(controls.add.disabled, true);
    upload.resolve(response({status: 'success', src: '/canvas-imports/synthetic/busy.png', name: 'busy.png', width: 10, height: 10}));
    await flush();
    assert.equal(calls.filter(call => call.options.method === 'PUT').length, 1);
    mounted.dispose();
});

test('upload, latest settings, PUT, and revision conflict failures retain the saved preview', async t => {
    let gets = 0;
    const scenarios = [
        {
            name: 'upload failure',
            fetch: async (url, options) => url === '/api/canvas/upload_image'
                ? response({status: 'error', message: 'upload failed'}, 500)
                : response(settingsResponse({inpaintReference: reference('kept.png')})),
            message: /업로드하지 못했습니다/,
            expectedPuts: 0,
        },
        {
            name: 'latest settings failure',
            fetch: async (url, options) => {
                if (url === '/api/canvas/upload_image') return response({status: 'success', src: '/canvas-imports/synthetic/new.png', name: 'new.png', width: 10, height: 10});
                if (!options.method && ++gets > 1) return response({status: 'error', message: 'latest failed'}, 500);
                return response(settingsResponse({inpaintReference: reference('kept.png')}));
            },
            message: /최신 프로젝트 설정을 확인하지 못했습니다/,
            expectedPuts: 0,
        },
        {
            name: 'PUT failure',
            fetch: async (url, options) => {
                if (url === '/api/canvas/upload_image') return response({status: 'success', src: '/canvas-imports/synthetic/new.png', name: 'new.png', width: 10, height: 10});
                if (options.method === 'PUT') return response({status: 'error', message: 'put failed'}, 500);
                return response(settingsResponse({inpaintReference: reference('kept.png')}));
            },
            message: /프로젝트에 저장하지 못했습니다/,
            expectedPuts: 1,
        },
        {
            name: 'revision conflict',
            fetch: async (url, options) => {
                if (url === '/api/canvas/upload_image') return response({status: 'success', src: '/canvas-imports/synthetic/new.png', name: 'new.png', width: 10, height: 10});
                if (options.method === 'PUT') return response({status: 'error', code: 'project_settings_conflict'}, 409);
                return response(settingsResponse({inpaintReference: reference('kept.png')}));
            },
            message: /설정이 다른 곳에서 변경되었습니다.*새로고침/,
            expectedPuts: 1,
        },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.name, async () => {
            gets = 0;
            const calls = [];
            const fixture = createFixture(async (url, options = {}) => {
                calls.push({url, options});
                return scenario.fetch(url, options);
            });
            const mounted = fixture.api.mount({container: fixture.container, projectId: 'failure'});
            await flush();
            const controls = uploadElements(fixture);
            controls.add.click();
            controls.input.files = [{name: 'new.png', type: 'image/png'}];
            controls.input.emit('change');
            await flush();
            assert.equal(controls.preview.src, '/canvas-imports/synthetic/kept.png?preview=256');
            assert.match(controls.status.textContent, scenario.message);
            assert.equal(calls.filter(call => call.options.method === 'PUT').length, scenario.expectedPuts);
            mounted.dispose();
        });
    }
});

test('dispose aborts a pending GET and a pending upload without later DOM or PUT work', async t => {
    await t.test('initial GET', async () => {
        const get = deferred();
        let fetchCall;
        const fixture = createFixture((url, options) => { fetchCall = {url, options}; return get.promise; });
        const mounted = fixture.api.mount({container: fixture.container, projectId: 'late-get'});
        mounted.dispose();
        assert.equal(fetchCall.options.signal.aborted, true);
        get.resolve(response(settingsResponse({inpaintReference: reference('late.png')})));
        await flush();
        assert.equal(fixture.container.children.length, 0);
        assert.equal(fixture.doc.body.children.filter(child => child.classList.contains('daki-project-reference-dialog')).length, 0);
    });
    await t.test('upload', async () => {
        const upload = deferred();
        const calls = [];
        const fixture = createFixture(async (url, options = {}) => {
            calls.push({url, options});
            if (url === '/api/canvas/upload_image') return upload.promise;
            return response(settingsResponse());
        });
        const mounted = fixture.api.mount({container: fixture.container, projectId: 'late-upload'});
        await flush();
        const controls = uploadElements(fixture);
        controls.add.click();
        controls.input.files = [{name: 'late.png', type: 'image/png'}];
        controls.input.emit('change');
        const uploadCall = calls.find(call => call.url === '/api/canvas/upload_image');
        mounted.dispose();
        assert.equal(uploadCall.options.signal.aborted, true);
        upload.resolve(response({status: 'success', src: '/canvas-imports/synthetic/late.png', name: 'late.png', width: 10, height: 10}));
        await flush();
        assert.equal(calls.filter(call => call.options.method === 'PUT').length, 0);
        assert.equal(fixture.container.children.length, 0);
    });
});

test('project switch invalidates a delayed upload before PUT or stale DOM updates', async () => {
    const upload = deferred();
    let current = true;
    const calls = [];
    const fixture = createFixture(async (url, options = {}) => {
        calls.push({url, options});
        if (url === '/api/canvas/upload_image') return upload.promise;
        return response(settingsResponse({inpaintReference: reference('old.png')}));
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'switch-upload', isCurrent: () => current});
    await flush();
    const controls = uploadElements(fixture);
    controls.add.click();
    controls.input.files = [{name: 'late.png', type: 'image/png'}];
    controls.input.emit('change');
    const priorStatus = controls.status.textContent;
    current = false;
    upload.resolve(response({status: 'success', src: '/canvas-imports/synthetic/late.png', name: 'late.png', width: 10, height: 10}));
    await flush();
    assert.equal(calls.filter(call => call.options.method === 'PUT').length, 0);
    assert.equal(controls.preview.src, '/canvas-imports/synthetic/old.png?preview=256');
    assert.equal(controls.status.textContent, priorStatus);
    mounted.dispose();
});

test('project switch invalidates a delayed GET before it can update the UI or start a PUT', async () => {
    const get = deferred();
    let current = true;
    const fixture = createFixture(async () => get.promise);
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'switch', isCurrent: () => current});
    const status = uploadElements(fixture).status;
    current = false;
    get.resolve(response(settingsResponse({inpaintReference: reference('stale.png')})));
    await flush();
    assert.equal(uploadElements(fixture).name.textContent, '프로젝트 참고 이미지를 불러오는 중…');
    assert.equal(status.textContent, '프로젝트 참고 이미지를 불러오는 중…');
    mounted.dispose();
});

test('viewer closes with focus restoration, cleans up on dispose, and reports broken images', async () => {
    const fixture = createFixture(async () => response(settingsResponse({inpaintReference: reference('broken.png')})));
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'viewer'});
    await flush();
    const controls = uploadElements(fixture);
    controls.preview.emit('error');
    assert.equal(controls.status.textContent, '이미지를 불러오지 못했습니다.');
    assert.equal(controls.preview.hidden, true);
    assert.equal(controls.add.disabled, false);

    const viewerImage = byClass(fixture.doc.body, 'daki-project-reference-dialog-image');
    assert.equal(viewerImage.getAttribute('src'), null, 'the full-size image stays unloaded before the view action');
    controls.view.click();
    const dialog = byClass(fixture.doc.body, 'daki-project-reference-dialog');
    assert.ok(dialog.open);
    assert.equal(dialog.getAttribute('aria-labelledby'), byClass(dialog, 'daki-project-reference-dialog-title').id);
    assert.equal(viewerImage.getAttribute('src'), '/canvas-imports/synthetic/broken.png');
    assert.equal(fixture.doc.activeElement.textContent, '닫기');
    viewerImage.emit('error');
    assert.equal(viewerImage.hidden, true);
    assert.equal(byClass(dialog, 'daki-project-reference-dialog-error').textContent, '이미지를 불러오지 못했습니다.');
    dialog.close();
    assert.equal(fixture.doc.activeElement, controls.view);
    assert.equal(viewerImage.getAttribute('src'), null);
    assert.equal(viewerImage.hidden, true);

    controls.view.click();
    const activeBeforeDispose = fixture.doc.activeElement;
    mounted.dispose();
    assert.equal(dialog.open, false);
    assert.equal(dialog.isConnected, false);
    assert.equal(viewerImage.getAttribute('src'), null);
    assert.equal(fixture.doc.activeElement, activeBeforeDispose, 'dispose must not restore focus');
    assert.equal(fixture.channels[0].closed, true);
    assert.equal((fixture.events.get('daki-project-settings-changed') || []).length, 0);
});

test('manual refresh and filtered project notifications reload the project settings', async () => {
    const refs = [reference('first.png'), reference('second.png'), reference('third.png')];
    let gets = 0;
    const fixture = createFixture(async () => {
        const savedReference = refs[Math.min(gets, refs.length - 1)];
        gets += 1;
        return response(settingsResponse({inpaintReference: savedReference}));
    });
    const mounted = fixture.api.mount({container: fixture.container, projectId: 'events'});
    await flush();
    const controls = uploadElements(fixture);
    const viewerImage = byClass(fixture.doc.body, 'daki-project-reference-dialog-image');
    assert.equal(controls.preview.src, '/canvas-imports/synthetic/first.png?preview=256');
    assert.equal(viewerImage.getAttribute('src'), null);

    fixture.win.dispatchEvent(new fixture.win.CustomEvent('daki-project-settings-changed', {detail: {projectId: 'other'}}));
    await flush();
    assert.equal(gets, 1);

    controls.refresh.click();
    await flush();
    assert.equal(controls.preview.src, '/canvas-imports/synthetic/second.png?preview=256');
    assert.equal(viewerImage.getAttribute('src'), null, 'refreshing a closed viewer must not load the original');

    fixture.channels[0].emit({projectId: 'events'});
    await flush();
    assert.equal(controls.preview.src, '/canvas-imports/synthetic/third.png?preview=256');
    mounted.dispose();
});
