const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const reference = require('../static/canvas_inpaint_reference.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_inpaint_reference.js'), 'utf8');

const validReference = {
    src: '/canvas-imports/session/source.webp',
    name: '참고 이미지.webp',
    width: 320,
    x: 0.5,
    y: 0.5,
    zoom: 1
};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function createHarness(fetchImpl = async () => {
    throw new Error('Unexpected fetch');
}, imageSize = {width: 128, height: 128}) {
    const ids = new Map();
    class Element {
        constructor(tagName) {
            this.tagName = String(tagName).toLowerCase();
            this.children = [];
            this.parentElement = null;
            this.attributes = {};
            this.dataset = {};
            this.style = {};
            this.hidden = false;
            this.disabled = false;
            this.checked = false;
            this.open = false;
            this.value = '';
            this.files = [];
            this.listeners = new Map();
            this.className = '';
            this.textContent = '';
            this.clientWidth = 800;
            this.offsetLeft = 0;
            this.offsetTop = 0;
            this.classList = {
                add: name => { this.className = [...new Set((this.className + ' ' + name).trim().split(/\s+/))].join(' '); },
                remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
                toggle: (name, force) => {
                    const has = this.className.split(/\s+/).includes(name);
                    const next = force === undefined ? !has : Boolean(force);
                    if (next) this.classList.add(name); else this.classList.remove(name);
                    return next;
                }
            };
        }
        set id(value) { this._id = value; ids.set(value, this); }
        get id() { return this._id; }
        get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
        appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
        replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
        remove() {
            if (!this.parentElement) return;
            this.parentElement.children = this.parentElement.children.filter(child => child !== this);
            this.parentElement = null;
        }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(type, handler) {
            const handlers = this.listeners.get(type) || [];
            handlers.push(handler);
            this.listeners.set(type, handlers);
        }
        dispatch(type, extra = {}) {
            const event = {type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra};
            (this.listeners.get(type) || []).forEach(handler => handler(event));
            return event;
        }
        click() { if (!this.disabled) this.dispatch('click'); }
        focus() { document.activeElement = this; }
        showModal() { this.open = true; }
        close() { this.open = false; this.dispatch('close'); }
        getBoundingClientRect() { return {width: 520, height: 380}; }
        querySelector(selector) {
            const matches = node => selector.startsWith('.')
                ? node.className.split(/\s+/).includes(selector.slice(1))
                : selector === 'input[type="checkbox"]'
                    ? node.tagName === 'input' && node.type === 'checkbox'
                    : selector === 'button' ? node.tagName === 'button' : false;
            const visit = node => {
                for (const child of node.children || []) {
                    if (matches(child)) return child;
                    const found = visit(child);
                    if (found) return found;
                }
                return null;
            };
            return visit(this);
        }
    }
    const document = {
        activeElement: null,
        createElement: tag => new Element(tag),
        createTextNode: text => {
            const node = new Element('#text');
            node.textContent = String(text);
            return node;
        },
        getElementById: id => ids.get(id) || null,
        querySelectorAll: selector => {
            if (selector !== '.canvas-inpaint-reference-actions') return [];
            const found = [];
            const visit = node => {
                for (const child of node.children || []) {
                    if (child.className.split(/\s+/).includes('canvas-inpaint-reference-actions')) {
                        found.push(child);
                    }
                    visit(child);
                }
            };
            visit(document.body);
            return found;
        },
        body: null
    };
    document.body = new Element('body');
    const host = new Element('section');
    host.id = 'canvasInpaintReferenceControls';
    document.body.appendChild(host);
    const stage = new Element('div');
    stage.id = 'canvasStage';
    const surface = new Element('div');
    surface.id = 'canvasSurface';
    stage.appendChild(surface);
    document.body.appendChild(stage);

    class FakeFormData {
        constructor() { this.entries = []; }
        append(...args) { this.entries.push(args); }
    }
    class FakeImage {
        constructor() {
            this.complete = false;
            this.naturalWidth = imageSize.width;
            this.naturalHeight = imageSize.height;
        }
        set src(value) {
            this._src = value;
            this.complete = true;
            this.onload?.();
        }
        get src() { return this._src; }
    }
    const window = {
        document,
        fetch: fetchImpl,
        FormData: FakeFormData,
        Image: FakeImage,
        AbortController,
        devicePixelRatio: 1
    };
    vm.runInNewContext(source, {window, module: {exports: {}}, AbortController});
    return {api: window.CanvasInpaintReference, document, host, stage, surface, window};
}

function findByText(root, tagName, text) {
    if (root.tagName === tagName && root.textContent === text) return root;
    for (const child of root.children || []) {
        const found = findByText(child, tagName, text);
        if (found) return found;
    }
    return null;
}

function findFileInput(root) {
    if (root.tagName === 'input' && root.type === 'file') return root;
    for (const child of root.children || []) {
        const found = findFileInput(child);
        if (found) return found;
    }
    return null;
}

function findNumberInput(root) {
    if (root.tagName === 'input' && root.type === 'number') return root;
    for (const child of root.children || []) {
        const found = findNumberInput(child);
        if (found) return found;
    }
    return null;
}

function findCheckboxInputs(root) {
    const found = [];
    const visit = node => {
        if (node.tagName === 'input' && node.type === 'checkbox') found.push(node);
        for (const child of node.children || []) visit(child);
    };
    visit(root);
    return found;
}

function assertJsonEqual(actual, expected) {
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

async function flushAsync() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

function jsonResponse(payload, status = 200) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function installOppositePicker(harness) {
    const picker = {calls: []};
    picker.open = options => picker.calls.push(options);
    harness.window.CanvasOppositeReference = picker;
    return picker;
}

function findReferenceButton(harness) {
    return findByText(harness.host, 'button', '반대면에서 가져오기');
}

test('normalizes missing state and clones valid reference snapshots', () => {
    assert.deepEqual(reference.normalizeSnapshot(undefined), {
        reference: null, showArea: false, include: false
    });
    assert.deepEqual(reference.normalizeSnapshot({
        reference: {src: validReference.src},
        showArea: true,
        include: true
    }), {
        reference: {...validReference, name: '참고 이미지', width: 320, x: 0.5, y: 0.5, zoom: 1},
        showArea: true,
        include: true
    });

    reference.restore({reference: validReference, showArea: true, include: true});
    const first = reference.snapshot();
    first.reference.width = 64;
    first.reference.name = 'changed';
    first.showArea = false;
    const second = reference.snapshot();
    assert.deepEqual(second, {reference: validReference, showArea: true, include: true});
    assert.notEqual(second.reference, first.reference);
});

test('restored checkbox mismatch follows include while preserving both saved keys', () => {
    assert.deepEqual(reference.normalizeSnapshot({showArea: true, include: false}), {
        reference: null, showArea: false, include: false
    });
    assert.deepEqual(reference.normalizeSnapshot({showArea: false, include: true}), {
        reference: null, showArea: true, include: true
    });
});

test('invalid saved reference data normalizes to no reference', () => {
    const invalid = [
        {...validReference, src: 'https://example.invalid/image.png'},
        {...validReference, src: '/canvas-imports/a/../image.png'},
        {...validReference, src: '/canvas-imports/%252e%252e/image.png'},
        {...validReference, src: '/canvas-imports/image.png?download=1'},
        {...validReference, width: 319},
        {...validReference, name: 'x'.repeat(501)},
        {...validReference, x: Number.NaN},
        {...validReference, y: 1.01},
        {...validReference, zoom: 0.9}
    ];
    for (const item of invalid) {
        assert.deepEqual(reference.normalizeSnapshot({
            reference: item, showArea: true, include: true
        }), {reference: null, showArea: true, include: true});
    }
});

test('cropBox matches cover scaling for wide, tall, zoomed, and edge-focused crops', () => {
    const wide = reference.cropBox(400, 200, 100, 100, validReference);
    assert.deepEqual(wide, {x: 100, y: 0, width: 200, height: 200});

    const zoomed = reference.cropBox(400, 200, 100, 100, {
        ...validReference, zoom: 2
    });
    assert.deepEqual(zoomed, {x: 150, y: 50, width: 100, height: 100});

    const tall = reference.cropBox(200, 400, 100, 100, validReference);
    assert.deepEqual(tall, {x: 0, y: 100, width: 200, height: 200});

    const edge = reference.cropBox(400, 200, 100, 100, {
        ...validReference, x: 0, y: 1
    });
    assert.deepEqual(edge, {x: 0, y: 0, width: 200, height: 200});
});

test('fitBox contains the whole image without upscaling and centers it in the target', () => {
    assert.deepEqual(reference.fitBox(400, 200, 100, 100), {x: 0, y: 25, width: 100, height: 50});
    assert.deepEqual(reference.fitBox(200, 400, 100, 100), {x: 25, y: 0, width: 50, height: 100});
    assert.deepEqual(reference.fitBox(800, 800, 320, 768), {x: 0, y: 224, width: 320, height: 320});
    assert.deepEqual(reference.fitBox(64, 64, 320, 768), {x: 128, y: 352, width: 64, height: 64});
    assert.deepEqual(reference.fitBox(5, 3, 4, 4), {x: 0, y: 1, width: 4, height: 2});
    for (const sizes of [[0, 2, 4, 4], [2, 0, 4, 4], [2, 2, 0, 4], [2, 2, 4, 1.5]]) {
        assert.throws(() => reference.fitBox(...sizes), /양의 정수/);
    }
});

test('request keeps size when reference is off and expands width when included', () => {
    reference.configure({
        getContext: () => ({selection: {id: 1}, canvasWidth: 800, canvasHeight: 1024}),
        save: () => {},
        redraw: () => {},
        getProjectLink: () => null,
        sessionId: 'synthetic-session'
    });
    reference.restore({reference: validReference, showArea: false, include: false});
    assert.deepEqual(reference.request(512, 384), {
        width: 512, height: 384, reference: null
    });

    reference.restore({reference: validReference, showArea: true, include: true});
    const result = reference.request(512, 384);
    assert.deepEqual(result, {
        width: 832, height: 384, reference: validReference
    });
    assert.deepEqual(reference.request(704, 1024), {
        width: 1024, height: 1024, reference: validReference
    });
    result.reference.name = 'mutated';
    assert.equal(reference.snapshot().reference.name, validReference.name);
});

test('request rejects a missing included reference and invalid work sizes', () => {
    reference.restore({include: true});
    assert.throws(() => reference.request(512, 384), /참고 이미지를 먼저 추가/);
    reference.restore({include: false});
    assert.throws(() => reference.request(0, 384), /양의 정수/);
    assert.throws(() => reference.request(512, 1.5), /양의 정수/);
});

test('sidebar exposes width and include controls without the crop editor', () => {
    const harness = createHarness();
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => {},
        redraw: () => {},
        getProjectLink: () => null
    });
    harness.api.restore({reference: validReference});
    assert.ok(findByText(harness.host, 'p', '참고 폭 320px · 포함 해제됨'));
    assert.ok(findByText(harness.host, 'p',
        '선택 영역을 조절하면 참고 폭을 포함한 전체 크기를 확인할 수 있습니다.'));

    const widthInput = findNumberInput(harness.host);
    assert.ok(widthInput);
    assert.equal(widthInput.min, '64');
    assert.equal(widthInput.max, '1024');
    assert.equal(widthInput.step, '64');
    assert.equal(widthInput.value, '320');
    assert.equal(widthInput.disabled, false);
    assert.equal(findByText(harness.host, 'button', '구도 조절'), null);
    assert.equal(findByText(harness.host, 'button', '참고 편집'), null);
    assert.equal(harness.document.getElementById('canvasInpaintReferenceDialog'), null);

    const actionContainer = harness.document.createElement('div');
    const actionRow = harness.api.mountActions(actionContainer);
    assert.equal(actionRow.children.length, 1);
    assert.equal(actionRow.children[0].children[0].type, 'checkbox');

    harness.api.restore({});
    assert.equal(widthInput.value, '320');
    assert.equal(widthInput.disabled, true);
    assert.ok(findByText(harness.host, 'p', '선택 영역을 조절하면 요청 크기를 확인할 수 있습니다.'));
    assert.ok(findByText(harness.host, 'p',
        '참고 이미지를 추가하고 선택 영역을 조절해 전체 크기를 확인하세요.'));
});

test('sidebar and every mounted action checkbox stay synchronized with one save per change', () => {
    let saveCalls = 0;
    const harness = createHarness();
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => null
    });
    harness.api.restore({reference: validReference});

    const actionContainers = [harness.document.createElement('div'), harness.document.createElement('div')];
    actionContainers.forEach(container => {
        harness.document.body.appendChild(container);
        harness.api.mountActions(container);
    });
    const checkboxes = findCheckboxInputs(harness.document.body);
    assert.equal(checkboxes.length, 3);

    const changes = [
        [checkboxes[0], true],
        [checkboxes[1], false],
        [checkboxes[2], true],
        [checkboxes[0], false],
        [checkboxes[1], true],
        [checkboxes[2], false]
    ];
    changes.forEach(([checkbox, checked], index) => {
        checkbox.checked = checked;
        checkbox.dispatch('change');
        assertJsonEqual(harness.api.snapshot(), {
            reference: validReference, showArea: checked, include: checked
        });
        assert.deepEqual(checkboxes.map(input => input.checked), [checked, checked, checked]);
        assert.equal(saveCalls, index + 1);
    });
});

test('width changes clamp and round once while preserving legacy position and zoom fields', () => {
    let saveCalls = 0;
    const harness = createHarness();
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => null
    });
    const savedReference = {...validReference, x: 0.2, y: 0.8, zoom: 8};
    harness.api.restore({reference: savedReference});
    const widthInput = findNumberInput(harness.host);

    widthInput.value = '';
    widthInput.dispatch('change');
    widthInput.value = 'not-a-number';
    widthInput.dispatch('change');
    assert.equal(widthInput.value, '320');
    assert.equal(saveCalls, 0);

    widthInput.value = '33';
    widthInput.dispatch('change');
    assert.equal(widthInput.value, '64');
    assertJsonEqual(harness.api.snapshot().reference, {...savedReference, width: 64});
    assert.equal(saveCalls, 1);

    widthInput.value = '9999';
    widthInput.dispatch('change');
    assert.equal(widthInput.value, '1024');
    assert.equal(harness.api.snapshot().reference.width, 1024);
    assert.equal(saveCalls, 2);

    widthInput.value = '130';
    widthInput.dispatch('change');
    assert.equal(widthInput.value, '128');
    assert.equal(harness.api.snapshot().reference.x, savedReference.x);
    assert.equal(harness.api.snapshot().reference.y, savedReference.y);
    assert.equal(harness.api.snapshot().reference.zoom, savedReference.zoom);
    assert.equal(saveCalls, 3);
    widthInput.value = '129';
    widthInput.dispatch('change');
    assert.equal(widthInput.value, '128');
    assert.equal(saveCalls, 3);
});

test('restoring state aborts a pending upload and ignores its delayed response', async () => {
    const upload = deferred();
    const fetchCalls = [];
    const harness = createHarness(async (url, options) => {
        fetchCalls.push({url, options});
        return upload.promise;
    });
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({selection: {id: 1}, clip: {id: 2, imageWidth: 256, imageHeight: 256},
            canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => null,
        sessionId: 'test-session'
    });
    harness.api.restore({reference: validReference, showArea: true, include: true});

    const picker = findFileInput(harness.host);
    picker.files = [{name: 'replacement.png', type: 'image/png'}];
    picker.dispatch('change');
    assert.equal(fetchCalls.length, 1);
    assert.equal(findNumberInput(harness.host).disabled, true);

    const restoredReference = {...validReference, name: 'restored.webp', width: 384};
    harness.api.restore({reference: restoredReference, showArea: false, include: true});
    assert.equal(fetchCalls[0].options.signal.aborted, true);
    upload.resolve({
        ok: true, status: 200,
        json: async () => ({status: 'success', src: '/canvas-imports/replacement.png',
            name: 'replacement.png', width: 128, height: 128})
    });
    await flushAsync();

    assertJsonEqual(harness.api.snapshot(), {
        reference: restoredReference, showArea: true, include: true
    });
    assert.equal(saveCalls, 0);
});

test('successful upload replaces the reference using its saved width', async () => {
    const fetchCalls = [];
    let saveCalls = 0;
    const harness = createHarness(async (url, options) => {
        fetchCalls.push({url, options});
        return {
            ok: true, status: 200,
            json: async () => ({status: 'success', src: '/canvas-imports/uploaded.webp',
                name: 'uploaded.webp', width: 800, height: 600})
        };
    });
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => null,
        sessionId: 'synthetic-session'
    });
    harness.api.restore({reference: {...validReference, width: 384, x: 0.2, y: 0.8, zoom: 4}});
    const picker = findFileInput(harness.host);
    picker.files = [{name: 'uploaded.webp', type: 'image/webp'}];
    picker.dispatch('change');
    await flushAsync();

    assert.equal(fetchCalls[0].url, '/api/canvas/upload_image');
    assert.equal(fetchCalls[0].options.method, 'POST');
    assertJsonEqual(harness.api.snapshot().reference, {
        src: '/canvas-imports/uploaded.webp', name: 'uploaded.webp',
        width: 384, x: 0.5, y: 0.5, zoom: 1
    });
    assert.equal(saveCalls, 1);
});

test('failed upload preserves the current reference', async () => {
    let saveCalls = 0;
    const harness = createHarness(async () => ({
        ok: false, status: 422,
        json: async () => ({status: 'error', message: 'synthetic upload failure'})
    }));
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => null
    });
    harness.api.restore({reference: validReference, showArea: true, include: true});
    const picker = findFileInput(harness.host);
    picker.files = [{name: 'failed.png', type: 'image/png'}];
    picker.dispatch('change');
    await flushAsync();

    assertJsonEqual(harness.api.snapshot(), {
        reference: validReference, showArea: true, include: true
    });
    assert.equal(findNumberInput(harness.host).disabled, false);
    assert.equal(saveCalls, 0);
});

test('opposite-side candidate is imported through the existing image upload and included once', async () => {
    const projectId = 'a'.repeat(32);
    const canvasId = 'c'.repeat(32);
    const candidateId = 'd'.repeat(32);
    const calls = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        if (url === `/api/daki/projects/${projectId}`) {
            return jsonResponse({status: 'success', project: {
                id: projectId,
                candidates: {back: [{id: candidateId, side: 'back', src: '/images/back.webp', name: '뒷면 후보'}]},
                canvases: {back: []}
            }});
        }
        if (url === '/images/back.webp') {
            return {ok: true, blob: async () => new Blob(['candidate'], {type: 'image/webp'})};
        }
        if (url === '/api/canvas/upload_image') {
            return jsonResponse({status: 'success', src: '/canvas-imports/imported.webp',
                name: 'opposite-reference.webp', width: 800, height: 600});
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    const picker = installOppositePicker(harness);
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => ({projectId, canvasId, side: 'front'}),
        sessionId: 'synthetic-session'
    });
    harness.api.restore({reference: validReference, showArea: false, include: false});

    const button = findReferenceButton(harness);
    assert.equal(button.disabled, false);
    button.click();
    assert.equal(picker.calls.length, 1);
    const chosen = {projectId, kind: 'candidate', id: candidateId, visible: true};
    picker.calls[0].onChoose(chosen);
    picker.calls[0].onChoose(chosen);
    assert.equal(button.disabled, true);
    await flushAsync();

    assert.deepEqual(calls.map(call => call.url), [
        `/api/daki/projects/${projectId}`, '/images/back.webp', '/api/canvas/upload_image'
    ]);
    const fileEntry = calls[2].options.body.entries.find(entry => entry[0] === 'file');
    assert.equal(fileEntry[2], 'opposite-reference.webp');
    assert.equal(calls[2].options.signal.aborted, false);
    assertJsonEqual(harness.api.snapshot(), {
        reference: {src: '/canvas-imports/imported.webp', name: '뒷면 후보',
            width: 320, x: 0.5, y: 0.5, zoom: 1},
        showArea: true,
        include: true
    });
    assert.equal(saveCalls, 1);
    assert.equal(button.disabled, false);
});

test('opposite-side saved canvas is rendered and imported from the other face', async () => {
    const projectId = 'e'.repeat(32);
    const canvasId = 'f'.repeat(32);
    const selectedCanvasId = '1'.repeat(32);
    const calls = [];
    const rendered = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        if (url === `/api/daki/projects/${projectId}`) {
            return jsonResponse({status: 'success', project: {
                id: projectId, candidates: {front: []},
                canvases: {front: [{id: selectedCanvasId, side: 'front'}]}
            }});
        }
        if (url === `/api/daki/projects/${projectId}/canvases/${selectedCanvasId}`) {
            return jsonResponse({status: 'success', project: {id: projectId}, canvas: {
                id: selectedCanvasId, side: 'front', name: '앞면 저장 캔버스', state: {layers: [{id: 'layer'}]}
            }});
        }
        if (url === 'data:image/png;base64,synthetic') {
            return {ok: true, blob: async () => new Blob(['canvas'], {type: 'image/png'})};
        }
        if (url === '/api/canvas/upload_image') {
            return jsonResponse({status: 'success', src: '/canvas-imports/canvas.png',
                name: 'opposite-reference.png', width: 700, height: 900});
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    const picker = installOppositePicker(harness);
    harness.window.renderMergedCanvasToDataUrl = async options => {
        rendered.push(options);
        return 'data:image/png;base64,synthetic';
    };
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => ({projectId, canvasId, side: 'back'}),
        sessionId: 'canvas-session'
    });
    harness.api.restore({reference: validReference, showArea: false, include: false});

    findReferenceButton(harness).click();
    picker.calls[0].onChoose({projectId, kind: 'canvas', id: selectedCanvasId, visible: true});
    await flushAsync();

    assert.deepEqual(calls.map(call => call.url), [
        `/api/daki/projects/${projectId}`,
        `/api/daki/projects/${projectId}/canvases/${selectedCanvasId}`,
        'data:image/png;base64,synthetic',
        '/api/canvas/upload_image'
    ]);
    assert.equal(JSON.stringify(rendered), JSON.stringify([
        {state: {layers: [{id: 'layer'}]}, maxDimension: 1600}
    ]));
    const upload = calls[3].options.body.entries;
    assert.deepEqual(upload.find(entry => entry[0] === 'sessionId'), ['sessionId', 'canvas-session']);
    assert.equal(upload.find(entry => entry[0] === 'file')[2], 'opposite-reference.png');
    assertJsonEqual(harness.api.snapshot(), {
        reference: {src: '/canvas-imports/canvas.png', name: '앞면 저장 캔버스',
            width: 320, x: 0.5, y: 0.5, zoom: 1},
        showArea: true,
        include: true
    });
    assert.equal(saveCalls, 1);
});

test('opposite-side import button requires a canvas, a valid link, and the picker', () => {
    const projectId = 'a'.repeat(32);
    const canvasId = 'b'.repeat(32);
    const harness = createHarness();
    let link = null;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        getProjectLink: () => link
    });
    const picker = installOppositePicker(harness);
    harness.api.render();
    const button = findReferenceButton(harness);
    assert.equal(button.disabled, true);
    button.click();
    assert.equal(picker.calls.length, 0);

    link = {projectId, canvasId, side: 'front'};
    harness.api.render();
    assert.equal(button.disabled, false);
    delete harness.window.CanvasOppositeReference;
    harness.api.render();
    assert.equal(button.disabled, true);

    installOppositePicker(harness);
    link = {projectId, canvasId, side: 'left'};
    harness.api.render();
    assert.equal(button.disabled, true);

    link = {projectId, canvasId, side: 'back'};
    harness.api.configure({getContext: () => ({canvasWidth: 0, canvasHeight: 0}), getProjectLink: () => link});
    assert.equal(button.disabled, true);
});

test('failed opposite-side upload preserves the existing reference and include state', async () => {
    const projectId = '2'.repeat(32);
    const canvasId = '3'.repeat(32);
    const candidateId = '4'.repeat(32);
    const calls = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        if (url === `/api/daki/projects/${projectId}`) {
            return jsonResponse({status: 'success', project: {id: projectId,
                candidates: {back: [{id: candidateId, src: '/images/source.jpg'}]}, canvases: {back: []}}});
        }
        if (url === '/images/source.jpg') {
            return {ok: true, blob: async () => new Blob(['candidate'], {type: 'image/jpeg'})};
        }
        if (url === '/api/canvas/upload_image') {
            return jsonResponse({status: 'error', message: 'synthetic upload failure'}, 422);
        }
        throw new Error(`Unexpected fetch: ${url}`);
    });
    const picker = installOppositePicker(harness);
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; }, redraw: () => {},
        getProjectLink: () => ({projectId, canvasId, side: 'front'})
    });
    harness.api.restore({reference: validReference, showArea: true, include: true});

    findReferenceButton(harness).click();
    picker.calls[0].onChoose({projectId, kind: 'candidate', id: candidateId, visible: true});
    await flushAsync();

    assert.deepEqual(calls.map(call => call.url), [
        `/api/daki/projects/${projectId}`, '/images/source.jpg', '/api/canvas/upload_image'
    ]);
    assert.equal(calls[2].options.body.entries.find(entry => entry[0] === 'file')[2], 'opposite-reference.jpg');
    assertJsonEqual(harness.api.snapshot(), {reference: validReference, showArea: true, include: true});
    assert.equal(saveCalls, 0);
    assert.equal(findReferenceButton(harness).disabled, false);
});

test('opposite-side import ignores project data after the linked canvas or side changes', async t => {
    for (const change of ['canvas', 'side']) {
        await t.test(change, async () => {
            const projectId = '5'.repeat(32);
            const canvasId = '6'.repeat(32);
            const candidateId = '7'.repeat(32);
            const projectRequest = deferred();
            const calls = [];
            const harness = createHarness(async (url, options) => {
                calls.push({url, options});
                return projectRequest.promise;
            });
            const picker = installOppositePicker(harness);
            let link = {projectId, canvasId, side: 'front'};
            let saveCalls = 0;
            harness.api.configure({
                getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
                save: () => { saveCalls += 1; }, redraw: () => {}, getProjectLink: () => link
            });
            harness.api.restore({reference: validReference, showArea: false, include: false});
            findReferenceButton(harness).click();
            picker.calls[0].onChoose({projectId, kind: 'candidate', id: candidateId, visible: true});
            assert.equal(calls.length, 1);

            link = change === 'canvas'
                ? {...link, canvasId: '8'.repeat(32)}
                : {...link, side: 'back'};
            harness.api.render();
            assert.equal(calls[0].options.signal.aborted, true);
            projectRequest.resolve(jsonResponse({status: 'success', project: {id: projectId,
                candidates: {back: [{id: candidateId, src: '/images/stale.webp'}]}}}));
            await flushAsync();

            assert.equal(calls.length, 1, 'stale result must not trigger an image fetch or upload');
            assertJsonEqual(harness.api.snapshot(), {reference: validReference, showArea: false, include: false});
            assert.equal(saveCalls, 0);
        });
    }
});

test('opposite-side import rejects a record assigned to the linked side', async () => {
    const projectId = '9'.repeat(32);
    const canvasId = 'a'.repeat(32);
    const candidateId = 'b'.repeat(32);
    const calls = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        return jsonResponse({status: 'success', project: {id: projectId,
            candidates: {back: [{id: candidateId, side: 'front', src: '/images/wrong-side.png'}]}}});
    });
    const picker = installOppositePicker(harness);
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; }, redraw: () => {},
        getProjectLink: () => ({projectId, canvasId, side: 'front'})
    });
    harness.api.restore({reference: validReference, showArea: true, include: true});

    findReferenceButton(harness).click();
    picker.calls[0].onChoose({projectId, kind: 'candidate', id: candidateId, visible: true});
    await flushAsync();

    assert.equal(calls.length, 1);
    assertJsonEqual(harness.api.snapshot(), {reference: validReference, showArea: true, include: true});
    assert.equal(saveCalls, 0);
});

test('render does not add a reference overlay or change stage padding', () => {
    const harness = createHarness();
    harness.stage.style.paddingLeft = 'preserved';
    harness.api.configure({
        getContext: () => ({
            selection: {id: 1, x: 0, y: 0, layerWidth: 800, layerHeight: 768},
            clip: {id: 2, imageWidth: 800, imageHeight: 768},
            canvasWidth: 800, canvasHeight: 768
        }),
        save: () => {},
        redraw: () => {},
        getProjectLink: () => null
    });
    harness.api.restore({
        reference: {...validReference, x: 0, y: 1, zoom: 8},
        showArea: true,
        include: true
    });

    harness.api.render();
    assert.equal(harness.stage.querySelector('.canvas-inpaint-reference-overlay'), null);
    assert.equal(harness.stage.style.paddingLeft, 'preserved');
});

test('project template save does not PUT after the linked project changes during GET', async () => {
    const getSettings = deferred();
    const calls = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        return getSettings.promise;
    });
    let link = {projectId: 'a'.repeat(32)};
    let saveCalls = 0;
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => { saveCalls += 1; },
        redraw: () => {},
        getProjectLink: () => link
    });
    harness.api.restore({reference: validReference});

    findByText(harness.host, 'button', '프로젝트에 등록').click();
    assert.equal(calls.length, 1);
    link = {projectId: 'b'.repeat(32)};
    getSettings.resolve({
        ok: true, status: 200,
        json: async () => ({status: 'success', settings: {
            revision: 4, style: {}, prompts: {}, inpaintSettings: {}
        }})
    });
    await flushAsync();

    assert.equal(calls.length, 1, 'no PUT should reach the newly linked project');
    assertJsonEqual(harness.api.snapshot(), {
        reference: validReference, showArea: false, include: false
    });
    assert.equal(saveCalls, 0);
});

test('project template save keeps its project-level scope when the linked canvas changes', async () => {
    const projectId = 'b'.repeat(32);
    const getSettings = deferred();
    const calls = [];
    const harness = createHarness(async (url, options) => {
        calls.push({url, options});
        if (calls.length === 1) return getSettings.promise;
        return jsonResponse({status: 'success'});
    });
    let link = {projectId, canvasId: 'c'.repeat(32), side: 'front'};
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => {}, redraw: () => {}, getProjectLink: () => link
    });
    harness.api.restore({reference: validReference});

    findByText(harness.host, 'button', '프로젝트에 등록').click();
    link = {...link, canvasId: 'd'.repeat(32), side: 'back'};
    harness.api.render();
    assert.equal(calls[0].options.signal.aborted, false);
    getSettings.resolve(jsonResponse({status: 'success', settings: {
        revision: 4, style: {}, prompts: {}, inpaintSettings: {}
    }}));
    await flushAsync();

    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, 'PUT');
    assert.equal(calls[1].url, `/api/daki/projects/${projectId}/canvas-settings`);
});

test('sidebar reference width text describes request inclusion and clear disables it', () => {
    const harness = createHarness();
    harness.api.configure({
        getContext: () => ({canvasWidth: 512, canvasHeight: 512}),
        save: () => {},
        redraw: () => {},
        getProjectLink: () => null
    });
    harness.api.restore({reference: validReference, showArea: true, include: true});
    assert.ok(findByText(harness.host, 'p', '참고 폭 320px · 전체 요청 폭에 포함'));
    harness.api.restore({reference: validReference, showArea: false, include: false});
    assert.ok(findByText(harness.host, 'p', '참고 폭 320px · 포함 해제됨'));
    harness.api.restore({reference: validReference, showArea: true, include: true});
    findByText(harness.host, 'button', '참고 해제').click();

    assertJsonEqual(harness.api.snapshot(), {reference: null, showArea: false, include: false});
    assertJsonEqual(harness.api.request(256, 192), {width: 256, height: 192, reference: null});
});
