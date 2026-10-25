const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {summarizeLayers, buildPreviewModel} = require('../static/daki_project_details.js');

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = {contains: name => this.classes.has(name)};
        this.style = {};
        this.hidden = false;
        this.disabled = false;
        this.open = false;
        this.focusCount = 0;
        this._textContent = '';
    }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
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
        const actual = {target: this, ...event};
        return (this.listeners.get(name) || []).map(callback => callback(actual));
    }
    focus(options) {
        this.focusCount++;
        this.focusOptions = options;
        this.ownerDocument.activeElement = this;
    }
    showModal() { this.open = true; }
    close() { this.open = false; }
    getBoundingClientRect() { return this.rect || {left: 100, top: 100, right: 500, bottom: 500}; }
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
    const win = {
        document: doc,
        AbortController,
        URL,
        location: new URL('http://localhost/#project=sample'),
        fetch: fetchImpl,
    };
    const previewManagers = [];
    win.DakiCanvasPreviews = {
        create() {
            const manager = {
                disposed: false,
                observations: [],
                observeState(container, item) {
                    const copy = JSON.parse(JSON.stringify(item));
                    this.observations.push(copy);
                    const image = doc.createElement('img');
                    image.className = 'daki-canvas-preview-image';
                    image.alt = `${item.name} · synthetic preview`;
                    image.src = `data:image/png;base64,preview-${previewManagers.length}-${this.observations.length}`;
                    container.replaceChildren(image);
                    container.removeAttribute('role');
                    container.removeAttribute('aria-busy');
                },
                dispose() { this.disposed = true; },
            };
            previewManagers.push(manager);
            return manager;
        },
    };
    const module = {exports: {}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_project_details.js'), 'utf8'), {
        window: win,
        module,
        AbortController,
    });
    return {api: module.exports, doc, win, previewManagers};
}

function deferredFetchFixture() {
    const requests = [];
    const fetch = (url, options) => new Promise((resolve, reject) => {
        requests.push({url, options, resolve, reject});
    });
    return {...createFixture(fetch), requests};
}

function response(result, status = 200, jsonFailure = false) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
            if (jsonFailure) throw new SyntaxError('bad JSON');
            return result;
        },
    };
}

function descendants(node) {
    return [node, ...(node.children || []).flatMap(descendants)];
}

function withClass(root, className) {
    return descendants(root).filter(element => element.classList.contains(className));
}

function rowNamed(dialog, name) {
    return withClass(dialog, 'daki-project-details-row').find(row =>
        withClass(row, 'daki-project-details-layer-name')[0]?.textContent === name,
    );
}

function visibilityToggle(row) {
    return withClass(row, 'daki-project-details-visibility-toggle')[0];
}

function opener(doc, label = 'Canvas details') {
    const button = doc.createElement('button');
    button.textContent = label;
    doc.body.appendChild(button);
    return button;
}

function successfulCanvas(overrides = {}) {
    return {
        id: 'canvas/one',
        name: 'Saved canvas name',
        side: 'back',
        created_at: '2024-01-02T03:04:05.000+00:00',
        updated_at: '2024-02-03T04:05:06.000+00:00',
        state: {
            width: 640,
            height: 800,
            layers: [
                {id: 'folder', type: 'folder', name: 'Folder', visible: false, children: [
                    {id: 'clip', type: 'clip', name: 'Clip layer', src: '/image/clip.png', visible: true,
                        renderOnCanvas: true, x: 4, y: 6, layerWidth: 40, layerHeight: 50,
                        promptInfo: 'private clip metadata'},
                    {id: 'source-clip', type: 'clip', name: 'Original clip', src: '/image/source-clip.png',
                        visible: true, renderOnCanvas: false},
                ]},
                {id: 'plain', type: 'image', name: '<img src=x>', visible: true,
                    src: '/canvas-imports/plain.png?old=1', x: 8, y: 9, layerWidth: 20, layerHeight: 30,
                    imageWidth: 80, imageHeight: 90},
                {id: 'reference', type: 'image', name: 'Reference layer', visible: true,
                    pinnedReference: true, src: '/image/reference.png'},
                {id: 'selection', type: 'selection', name: 'Selection group', visible: true, children: [
                    {id: 'selected-image', type: 'image', name: 'Selected image', visible: false,
                        src: 'data:image/png;base64,synthetic'},
                ]},
                {id: 'base', type: 'canvas', name: 'Canvas base', visible: true},
            ],
            promptInfo: {prompt: 'private prompt that must not appear'},
            masks: [{src: 'private mask payload'}],
        },
        ...overrides,
    };
}

test('layer summary preserves nested traversal, type labels, fallback names, and visibility without mutating data', () => {
    const layers = [
        {type: 'folder', name: 'Folder', visible: false, children: [
            {type: 'selection', name: 'Mask', visible: true, children: [
                {type: 'clip', name: 'Clip'},
            ]},
        ]},
        {type: 'image', name: 'Flat image', visible: true},
        {type: 'canvas'},
        {type: 'unknown', name: 'Unknown type'},
        {type: 'image', name: '   '},
        null,
    ];
    const before = JSON.stringify(layers);

    const summary = summarizeLayers(layers);

    assert.equal(summary.total, 8);
    assert.deepEqual(summary.rows.map(row => [row.name, row.type, row.depth, row.visibility]), [
        ['Folder', '폴더', 0, '숨김'],
        ['Mask', '선택 영역', 1, '상위 레이어 숨김'],
        ['Clip', '클립 이미지', 2, '숨김'],
        ['Flat image', '이미지 레이어', 0, ''],
        ['캔버스', '캔버스', 0, '숨김'],
        ['Unknown type', '기타 레이어', 0, '숨김'],
        ['이미지 레이어', '이미지 레이어', 0, '숨김'],
        ['기타 레이어', '기타 레이어', 0, '숨김'],
    ]);
    assert.equal(JSON.stringify(layers), before);
});

test('preview model keeps only drawable layer fields and preserves geometry without mutating saved state', () => {
    const saved = {
        width: 321,
        height: 654,
        layers: [{
            id: 'private-id', type: 'folder', name: 'Synthetic folder', visible: true,
            promptInfo: {prompt: 'secret prompt'}, masks: [{pixels: 'secret mask'}],
            children: [{
                type: 'image', name: 'Synthetic image', visible: false,
                src: '/image/synthetic.png', x: 11, y: 12,
                layerWidth: 13, layerHeight: 14, imageWidth: 15, imageHeight: 16,
                pinnedReference: true, renderOnCanvas: false,
                hiddenEditorField: 'do not retain',
            }],
        }],
    };
    const before = JSON.stringify(saved);

    const model = buildPreviewModel(saved);

    assert.equal(model.width, 321);
    assert.equal(model.height, 654);
    assert.equal(model.total, 2);
    assert.deepEqual(Object.keys(model.layers[0]).sort(), ['children', 'name', 'type', 'visible']);
    assert.deepEqual(Object.keys(model.layers[0].children[0]).sort(), [
        'imageHeight', 'imageWidth', 'layerHeight', 'layerWidth', 'name', 'pinnedReference',
        'renderOnCanvas', 'src', 'type', 'visible', 'x', 'y',
    ]);
    assert.deepEqual([model.layers[0].children[0].x, model.layers[0].children[0].y,
        model.layers[0].children[0].layerWidth, model.layers[0].children[0].layerHeight], [11, 12, 13, 14]);
    assert.equal(model.rows[0].parentIndex, null);
    assert.equal(model.rows[1].parentIndex, 0);
    assert.equal(model.rows[1].node, model.layers[0].children[0]);
    assert.equal(JSON.stringify(saved), before);
});

test('open shows summary immediately and fetches only saved layer state on demand', async () => {
    const fixture = deferredFetchFixture();
    const trigger = opener(fixture.doc);
    const formatted = [];
    const loading = fixture.api.open({
        projectId: 'project one',
        canvas: {
            id: 'canvas/one', name: 'Card canvas', side: 'front', width: 10, height: 20,
            layerCount: 1, created_at: 'old-created', updated_at: 'old-updated',
        },
        opener: trigger,
        isCurrent: () => true,
        formatDate(value) { formatted.push(value); return value ? `date:${value}` : '알 수 없음'; },
    });
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');

    assert.ok(dialog);
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute('aria-labelledby'), 'dakiProjectDetailsTitle');
    assert.equal(fixture.doc.getElementById('dakiProjectDetailsTitle').textContent, '캔버스 상세 정보');
    assert.equal(fixture.doc.activeElement.className, 'daki-project-details-footer-close');
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'Card canvas');
    assert.equal(withClass(dialog, 'daki-project-details-status')[0].textContent, '레이어 정보를 불러오는 중…');
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].url, '/api/daki/projects/project%20one/canvases/canvas%2Fone');
    assert.equal(fixture.requests[0].options.method, 'GET');
    assert.ok(fixture.requests[0].options.signal);
    assert.equal(descendants(dialog).some(element => element.tagName === 'IMG'), false);

    fixture.requests[0].resolve(response({status: 'success', canvas: successfulCanvas()}));
    assert.equal(await loading, true);

    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'Saved canvas name');
    assert.equal(withClass(dialog, 'daki-project-details-side')[0].textContent, '뒷면');
    assert.equal(withClass(dialog, 'daki-project-details-cell')[0].children[1].textContent, '640 × 800 px');
    assert.equal(withClass(dialog, 'daki-project-details-cell')[1].children[1].textContent, '8개');
    assert.equal(withClass(dialog, 'daki-project-details-status')[0].textContent, '총 8개 레이어');
    const layerNames = withClass(dialog, 'daki-project-details-layer-name').map(element => element.textContent);
    assert.deepEqual(layerNames, [
        'Folder', 'Clip layer', 'Original clip', '<img src=x>',
        'Reference layer', 'Selection group', 'Selected image', 'Canvas base',
    ]);
    const serializedText = dialog.textContent;
    assert.equal(serializedText.includes('private prompt that must not appear'), false);
    assert.equal(serializedText.includes('private clip metadata'), false);
    assert.equal(serializedText.includes('private mask payload'), false);
    assert.equal(serializedText.includes('/image/clip.png'), false);
    assert.equal(descendants(dialog).some(element => element.tagName === 'IMG'), true);
    const thumbnails = withClass(dialog, 'daki-project-details-layer-thumbnail');
    assert.equal(thumbnails.length, 5);
    assert.ok(thumbnails.some(image => image.src === 'http://localhost/image/clip.png?preview=256'));
    assert.ok(thumbnails.some(image => image.src === 'http://localhost/canvas-imports/plain.png?old=1&preview=256'));
    assert.ok(thumbnails.some(image => image.src === 'data:image/png;base64,synthetic'));
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.method, 'GET');
    assert.equal(fixture.previewManagers.length, 2);
    const mainState = fixture.previewManagers[0].observations[0].state;
    assert.equal(mainState.width, 640);
    assert.equal(mainState.height, 800);
    assert.equal(mainState.layers[0].visible, false);
    assert.equal(mainState.layers[0].children[0].visible, true);
    assert.deepEqual(mainState.layers[0].children[0], {
        visible: true, type: 'clip', src: '/image/clip.png', x: 4, y: 6,
        layerWidth: 40, layerHeight: 50, renderOnCanvas: true, name: 'Clip layer',
    });
    const groupStates = fixture.previewManagers[1].observations.map(observation => observation.state);
    assert.equal(groupStates.length, 2);
    assert.equal(groupStates[0].layers.length, 1);
    assert.equal(groupStates[0].layers[0].visible, true);
    assert.equal(groupStates[0].layers[0].children[0].src, '/image/clip.png');
    assert.equal(groupStates[0].layers[0].children[1].src, '/image/source-clip.png');
    assert.equal(groupStates[0].layers[0].children.some(layer => layer.type === 'image'), false);
    assert.equal(groupStates[1].layers[0].type, 'selection');
    assert.equal(groupStates[1].layers[0].children[0].visible, false);
    assert.deepEqual(formatted, ['old-created', 'old-updated', '2024-01-02T03:04:05.000+00:00', '2024-02-03T04:05:06.000+00:00']);
});

test('temporary visibility controls rebuild previews without changing saved state and reset on reopen', async () => {
    const fixture = deferredFetchFixture();
    const saved = successfulCanvas();
    const savedBefore = JSON.stringify(saved.state);
    const summary = {id: 'canvas/one', name: 'Card canvas', side: 'back', width: 640, height: 800, layerCount: 8};
    const opened = fixture.api.open({projectId: 'project', canvas: summary});
    fixture.requests[0].resolve(response({status: 'success', canvas: saved}));
    assert.equal(await opened, true);

    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');
    const list = withClass(dialog, 'daki-project-details-list')[0];
    const originalRows = [...list.children];
    const folder = rowNamed(dialog, 'Folder');
    const clip = rowNamed(dialog, 'Clip layer');
    const sourceClip = rowNamed(dialog, 'Original clip');
    const pinned = rowNamed(dialog, 'Reference layer');
    const folderToggle = visibilityToggle(folder);
    const clipToggle = visibilityToggle(clip);
    assert.equal(folderToggle.checked, false);
    assert.equal(clipToggle.checked, true);
    assert.equal(clipToggle.disabled, false);
    assert.equal(visibilityToggle(sourceClip).disabled, true);
    assert.equal(visibilityToggle(pinned).disabled, true);
    assert.ok(withClass(sourceClip, 'daki-project-details-layer-exclusion')[0].textContent.includes('합성 제외'));
    assert.ok(withClass(pinned, 'daki-project-details-layer-exclusion')[0].textContent.includes('합성 제외'));
    assert.equal(withClass(clip, 'daki-project-details-layer-visibility')[0].textContent, '상위 레이어 숨김');

    list.scrollTop = 211;
    clipToggle.checked = false;
    clipToggle.emit('change');
    assert.equal(withClass(clip, 'daki-project-details-layer-visibility')[0].textContent, '숨김');
    assert.equal(fixture.previewManagers[0].disposed, true);
    assert.equal(fixture.previewManagers[1].disposed, true);
    assert.equal(fixture.previewManagers[2].observations[0].state.layers[0].visible, false);
    assert.equal(fixture.previewManagers[2].observations[0].state.layers[0].children[0].visible, false);
    assert.deepEqual(list.children, originalRows);
    assert.equal(list.scrollTop, 211);

    folderToggle.checked = true;
    folderToggle.emit('change');
    assert.equal(withClass(clip, 'daki-project-details-layer-visibility')[0].textContent, '숨김');
    assert.equal(fixture.previewManagers[4].observations[0].state.layers[0].visible, true);
    assert.equal(fixture.previewManagers[4].observations[0].state.layers[0].children[0].visible, false);

    clipToggle.checked = true;
    clipToggle.emit('change');
    assert.equal(withClass(clip, 'daki-project-details-layer-visibility')[0].textContent, '');
    assert.equal(fixture.previewManagers[6].observations[0].state.layers[0].children[0].visible, true);
    assert.equal(fixture.previewManagers[6].observations[0].state.layers[0].children[0].promptInfo, undefined);
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.method, 'GET');
    assert.equal(JSON.stringify(saved.state), savedBefore);

    folderToggle.checked = false;
    folderToggle.emit('change');
    assert.equal(withClass(clip, 'daki-project-details-layer-visibility')[0].textContent, '상위 레이어 숨김');
    withClass(dialog, 'daki-project-details-reset')[0].emit('click');
    assert.equal(folderToggle.checked, false);
    assert.equal(clipToggle.checked, true);
    assert.equal(fixture.previewManagers[10].observations[0].state.layers[0].visible, false);
    assert.equal(fixture.previewManagers[10].observations[0].state.layers[0].children[0].visible, true);

    const lastManager = fixture.previewManagers.at(-1);
    fixture.api.close(false);
    assert.equal(dialog.open, false);
    assert.equal(lastManager.disposed, true);
    const reopened = fixture.api.open({projectId: 'project', canvas: summary});
    assert.equal(fixture.requests.length, 2);
    fixture.requests[1].resolve(response({status: 'success', canvas: saved}));
    assert.equal(await reopened, true);
    assert.equal(fixture.previewManagers.at(-2).observations[0].state.layers[0].visible, false);
    assert.equal(fixture.previewManagers.at(-2).observations[0].state.layers[0].children[0].visible, true);
});

test('request errors stay inline and retry can display an empty saved layer list', async () => {
    const fixture = deferredFetchFixture();
    const opened = fixture.api.open({
        projectId: 'project',
        canvas: {id: 'canvas', name: 'Retry canvas', side: 'front'},
        isCurrent: () => true,
    });
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');
    fixture.requests[0].resolve(response({status: 'error', message: 'safe synthetic detail'}, 500));
    assert.equal(await opened, false);
    const status = withClass(dialog, 'daki-project-details-status')[0];
    const retry = withClass(dialog, 'daki-project-details-retry')[0];
    assert.equal(dialog.open, true);
    assert.match(status.textContent, /레이어 정보를 불러오지 못했습니다/);
    assert.match(status.textContent, /safe synthetic detail/);
    assert.equal(retry.hidden, false);

    const retryPromises = retry.emit('click');
    assert.equal(fixture.requests.length, 2);
    assert.equal(retry.hidden, true);
    assert.equal(retry.disabled, true);
    fixture.requests[1].resolve(response({
        status: 'success',
        canvas: {...successfulCanvas(), state: {width: 640, height: 800, layers: []}},
    }));
    assert.equal(await retryPromises[0], true);
    assert.equal(status.textContent, '저장된 레이어가 없습니다.');
    assert.equal(withClass(dialog, 'daki-project-details-list')[0].hidden, true);
    assert.equal(retry.hidden, true);
});

test('invalid and unparsable responses offer retry without dismissing the dialog', async () => {
    const fixture = deferredFetchFixture();
    const opened = fixture.api.open({
        projectId: 'project', canvas: {id: 'canvas', name: 'Invalid response', side: 'back'},
    });
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');
    fixture.requests[0].resolve(response({status: 'success', canvas: {state: {layers: 'bad'}}}));
    assert.equal(await opened, false);
    assert.match(withClass(dialog, 'daki-project-details-status')[0].textContent, /응답 형식을 확인해 주세요/);
    assert.equal(withClass(dialog, 'daki-project-details-retry')[0].hidden, false);

    const retryPromise = withClass(dialog, 'daki-project-details-retry')[0].emit('click')[0];
    fixture.requests[1].resolve(response(null, 200, true));
    assert.equal(await retryPromise, false);
    assert.equal(dialog.open, true);
    assert.equal(withClass(dialog, 'daki-project-details-retry')[0].hidden, false);
    assert.match(withClass(dialog, 'daki-project-details-status')[0].textContent, /레이어 정보를 불러오지 못했습니다/);
});

test('closing aborts requests, restores focus, and ignores a late reply after reopen', async () => {
    const fixture = deferredFetchFixture();
    const oldOpener = opener(fixture.doc, 'Old opener');
    const oldRequest = fixture.api.open({
        projectId: 'project', canvas: {id: 'old', name: 'Old canvas', side: 'front'}, opener: oldOpener,
    });
    const oldFetch = fixture.requests[0];
    const newOpener = opener(fixture.doc, 'New opener');
    const newRequest = fixture.api.open({
        projectId: 'project', canvas: {id: 'new', name: 'New canvas', side: 'back'}, opener: newOpener,
    });
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');

    assert.equal(oldFetch.options.signal.aborted, true);
    assert.equal(dialog.open, true);
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'New canvas');
    oldFetch.resolve(response({status: 'success', canvas: successfulCanvas({id: 'old', name: 'Stale result'})}));
    assert.equal(await oldRequest, false);
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'New canvas');
    assert.equal(withClass(dialog, 'daki-project-details-status')[0].textContent, '레이어 정보를 불러오는 중…');

    fixture.requests[1].resolve(response({status: 'success', canvas: successfulCanvas({id: 'new', name: 'Current result'})}));
    assert.equal(await newRequest, true);
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'Current result');
    fixture.api.close();
    assert.equal(dialog.open, false);
    assert.equal(fixture.requests[1].options.signal.aborted, true);
    assert.equal(fixture.doc.activeElement, newOpener);
    assert.equal(newOpener.focusOptions.preventScroll, true);
});

test('native close aborts the current request and delayed close events do not affect a reopened dialog', async () => {
    const fixture = deferredFetchFixture();
    const oldOpener = opener(fixture.doc, 'Old native opener');
    const oldRequest = fixture.api.open({
        projectId: 'project', canvas: {id: 'old', name: 'Native close', side: 'front'}, opener: oldOpener,
    });
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');
    dialog.close();
    dialog.emit('close');
    assert.equal(fixture.requests[0].options.signal.aborted, true);
    assert.equal(fixture.doc.activeElement, oldOpener);
    fixture.requests[0].resolve(response({status: 'success', canvas: successfulCanvas()}));
    assert.equal(await oldRequest, false);

    const delayed = fixture.api.open({
        projectId: 'project', canvas: {id: 'delayed', name: 'Delayed close', side: 'back'},
    });
    const oldFetch = fixture.requests[1];
    const body = withClass(dialog, 'daki-project-details-body')[0];
    body.scrollTop = 430;
    dialog.close();
    const reopened = fixture.api.open({
        projectId: 'project', canvas: {id: 'reopened', name: 'Reopened modal', side: 'front'},
    });
    const currentFetch = fixture.requests[2];
    assert.equal(oldFetch.options.signal.aborted, true);
    assert.equal(body.scrollTop, 0);
    dialog.emit('close');
    assert.equal(dialog.open, true);
    assert.equal(currentFetch.options.signal.aborted, false);
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'Reopened modal');

    oldFetch.resolve(response({status: 'success', canvas: successfulCanvas({id: 'delayed', name: 'Stale close result'})}));
    assert.equal(await delayed, false);
    currentFetch.resolve(response({status: 'success', canvas: successfulCanvas({id: 'reopened', name: 'Reopened result'})}));
    assert.equal(await reopened, true);
    assert.equal(withClass(dialog, 'daki-project-details-name')[0].textContent, 'Reopened result');
});

test('Escape, backdrop, close controls, and stale page guards close without fetching or restoring disconnected focus', async () => {
    const fixture = deferredFetchFixture();
    const stale = fixture.api.open({
        projectId: 'project', canvas: {id: 'canvas', name: 'Stale page', side: 'front'},
        isCurrent: () => false,
    });
    assert.equal(await stale, false);
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.doc.getElementById('dakiProjectDetailsDialog'), null);

    const trigger = opener(fixture.doc);
    fixture.api.open({projectId: 'project', canvas: {id: 'escape', name: 'Escape', side: 'front'}, opener: trigger});
    let stopped = false;
    const dialog = fixture.doc.getElementById('dakiProjectDetailsDialog');
    dialog.emit('keydown', {key: 'Escape', stopPropagation: () => { stopped = true; }});
    assert.equal(stopped, true);
    let prevented = false;
    dialog.emit('cancel', {preventDefault: () => { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(dialog.open, false);
    assert.equal(fixture.requests[0].options.signal.aborted, true);
    assert.equal(fixture.doc.activeElement, trigger);

    const disconnected = opener(fixture.doc, 'Disconnected opener');
    fixture.api.open({projectId: 'project', canvas: {id: 'backdrop', name: 'Backdrop', side: 'back'}, opener: disconnected});
    const topClose = withClass(dialog, 'daki-project-details-close')[0];
    assert.equal(topClose.getAttribute('aria-label'), '닫기');
    dialog.rect = {left: 20, top: 30, right: 600, bottom: 700};
    dialog.emit('click', {clientX: 40, clientY: 40});
    assert.equal(dialog.open, true);
    dialog.emit('click', {clientX: 10, clientY: 40});
    assert.equal(dialog.open, false);
    disconnected.parentNode.children.splice(disconnected.parentNode.children.indexOf(disconnected), 1);
    disconnected.parentNode = null;
    fixture.api.open({projectId: 'project', canvas: {id: 'close', name: 'Close', side: 'front'}, opener: disconnected});
    withClass(dialog, 'daki-project-details-footer-close')[0].emit('click');
    assert.equal(dialog.open, false);
    assert.notEqual(fixture.doc.activeElement, disconnected);
});
