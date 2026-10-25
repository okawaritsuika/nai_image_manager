const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_opposite_reference.js'), 'utf8');
const PROJECT_ID = 'a'.repeat(32);
const OTHER_PROJECT_ID = 'd'.repeat(32);
const FRONT_CANVAS_ID = 'b'.repeat(32);
const BACK_CANVAS_ID = 'c'.repeat(32);
const FRONT_CANDIDATE_ID = 'e'.repeat(32);
const BACK_CANDIDATE_ID = 'f'.repeat(32);
const SECOND_BACK_CANDIDATE_ID = '1'.repeat(32);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}

function makeDocument() {
    const ids = new Map();
    class Element {
        constructor(tagName) {
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.parentElement = null;
            this.attributes = {};
            this.dataset = {};
            this.style = {};
            this.hidden = false;
            this.disabled = false;
            this.checked = false;
            this.open = false;
            this.listeners = new Map();
            this._id = '';
            this._className = '';
            this._text = '';
            this.classList = {
                add: (...names) => { const values = new Set(this._className.split(/\s+/).filter(Boolean)); names.forEach(name => values.add(name)); this._className = [...values].join(' '); },
                remove: (...names) => { const remove = new Set(names); this._className = this._className.split(/\s+/).filter(name => name && !remove.has(name)).join(' '); },
                contains: name => this._className.split(/\s+/).includes(name),
                toggle: (name, force) => {
                    const has = this.classList.contains(name);
                    const add = force === undefined ? !has : Boolean(force);
                    if (add) this.classList.add(name); else this.classList.remove(name);
                    return add;
                }
            };
        }
        get id() { return this._id; }
        set id(value) { this._id = String(value); if (this._id) ids.set(this._id, this); }
        get className() { return this._className; }
        set className(value) { this._className = String(value || ''); }
        get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
        set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = String(value ?? ''); }
        get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
        appendChild(node) { node.parentElement = this; this.children.push(node); return node; }
        replaceChildren(...nodes) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...nodes); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(type, handler) { const handlers = this.listeners.get(type) || []; handlers.push(handler); this.listeners.set(type, handlers); }
        setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
        hasPointerCapture(pointerId) { return this.capturedPointerId === pointerId; }
        releasePointerCapture(pointerId) { if (this.capturedPointerId === pointerId) this.capturedPointerId = null; }
        getBoundingClientRect() { return {width: 0, height: Number(this.rectHeight) || 0}; }
        dispatch(type, extra = {}) {
            const event = {type, target: this, currentTarget: this,
                preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra};
            (this.listeners.get(type) || []).forEach(handler => handler(event));
            return event;
        }
        click() { if (!this.disabled) this.dispatch('click'); }
        focus() { document.activeElement = this; }
        showModal() { this.open = true; }
        close() { this.open = false; this.dispatch('close'); }
    }
    const document = {
        activeElement: null,
        createElement(tag) { return new Element(tag); },
        getElementById(id) { return ids.get(id) || null; },
        body: null
    };
    document.body = new Element('body');

    const stage = new Element('div'); stage.id = 'canvasStage';
    const surface = new Element('div'); surface.id = 'canvasSurface'; surface.rectHeight = 640; stage.appendChild(surface);
    document.body.appendChild(stage);
    const controls = new Element('div'); controls.id = 'canvasOppositeControls'; controls.hidden = true;
    const title = new Element('span'); title.id = 'canvasOppositeTitle';
    const choose = new Element('button'); choose.id = 'canvasOppositeChoose';
    const visible = new Element('input'); visible.id = 'canvasOppositeVisible';
    const status = new Element('span'); status.id = 'canvasOppositeStatus';
    const retry = new Element('button'); retry.id = 'canvasOppositeRetry'; retry.hidden = true;
    controls.append(title, choose, visible, status, retry);
    document.body.appendChild(controls);
    return {document, Element, stage, surface, controls, title, choose, visible, status, retry};
}

function response(payload, ok = true) {
    return {ok, json: async () => payload};
}

function projectRecord({projectId = PROJECT_ID, candidates, canvases} = {}) {
    return {id: projectId, name: 'Synthetic project',
        candidates: candidates || {front: [], back: []}, canvases: canvases || {front: [], back: []}};
}

function normalProject(projectId = PROJECT_ID) {
    return projectRecord({projectId,
        candidates: {
            front: [{id: FRONT_CANDIDATE_ID, path: 'front/one.png', src: '/image/front/one.png', missing: false}],
            back: [
                {id: BACK_CANDIDATE_ID, path: 'back/one.png', src: '/image/back/one.png', missing: false},
                {id: SECOND_BACK_CANDIDATE_ID, path: 'back/two.png', src: '/image/back/two.png', missing: false}
            ]
        },
        canvases: {
            front: [{id: FRONT_CANVAS_ID, name: 'Front edit', side: 'front', width: 700, height: 900, layerCount: 2}],
            back: [{id: BACK_CANVAS_ID, name: 'Back edit', side: 'back', width: 800, height: 1000, layerCount: 4}]
        }
    });
}

function find(node, predicate) {
    if (predicate(node)) return node;
    for (const child of node.children || []) {
        const match = find(child, predicate);
        if (match) return match;
    }
    return null;
}

function findAll(node, predicate, results = []) {
    if (predicate(node)) results.push(node);
    for (const child of node.children || []) findAll(child, predicate, results);
    return results;
}

async function tick() {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

function harness({link = {projectId: PROJECT_ID, canvasId: FRONT_CANVAS_ID, side: 'front'}, project = normalProject(), renderer} = {}) {
    const dom = makeDocument();
    const requests = [];
    const queues = new Map();
    const canvasState = {width: 800, height: 1000, layers: [{id: 10, src: '/synthetic-layer.png'}]};
    const renderCalls = [];
    let saveCount = 0;
    let currentLink = link ? {...link, revision: 1, unsaved: false} : null;
    const addResponse = (url, value) => {
        const queue = queues.get(url) || [];
        queue.push(value);
        queues.set(url, queue);
    };
    const fetch = (url, options = {}) => {
        requests.push({url, signal: options.signal});
        const queue = queues.get(url) || [];
        const queued = queue.shift();
        if (queue.length) queues.set(url, queue); else queues.delete(url);
        if (queued) return queued instanceof Promise ? queued : Promise.resolve(queued);
        if (url.endsWith('/canvases/' + BACK_CANVAS_ID)) {
            return Promise.resolve(response({status: 'success', project: {id: PROJECT_ID}, canvas: {
                id: BACK_CANVAS_ID, side: 'back', name: 'Back edit', state: structuredClone(canvasState)
            }}));
        }
        if (url.endsWith('/canvases/' + FRONT_CANVAS_ID)) {
            return Promise.resolve(response({status: 'success', project: {id: PROJECT_ID}, canvas: {
                id: FRONT_CANVAS_ID, side: 'front', name: 'Front edit', state: structuredClone(canvasState)
            }}));
        }
        return Promise.resolve(response({status: 'success', project: structuredClone(project)}));
    };
    const Image = class {
        constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
        set src(value) {
            this._src = value;
            queueMicrotask(() => {
                if (value.startsWith('bad:')) { this.onerror?.(new Error('bad image')); return; }
                this.complete = true;
                this.naturalWidth = 1200;
                this.naturalHeight = 1800;
                this.onload?.();
            });
        }
        get src() { return this._src; }
    };
    const context = {
        document: dom.document,
        fetch,
        AbortController,
        Image,
        CanvasProject: {localLink: () => currentLink && {...currentLink}},
        saveCanvasState() { saveCount += 1; },
        renderMergedCanvasToDataUrl: async options => {
            renderCalls.push(options);
            return renderer ? renderer(options) : 'data:image/png;base64,c3ludGhldGlj';
        }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, {filename: 'canvas_opposite_reference.js'});
    const api = context.CanvasOppositeReference;
    return {
        ...dom, context, api, requests, renderCalls, canvasState, addResponse,
        saveCount: () => saveCount,
        setLink(value) { currentLink = value ? {...value, revision: 1, unsaved: false} : null; },
        setProject(value) { project = value; },
        projectUrl(id = PROJECT_ID) { return `/api/daki/projects/${id}`; },
        canvasUrl(id = BACK_CANVAS_ID, projectId = PROJECT_ID) { return `/api/daki/projects/${projectId}/canvases/${id}`; }
    };
}

function chooseButton(h, kind, id) {
    return find(h.document.getElementById('canvasOppositeDialog'), node => node.dataset?.kind === kind && node.dataset?.id === id);
}

test('missing state defaults to no selection and hidden preview', () => {
    const h = harness({link: null});
    h.api.restore(undefined);
    h.api.linkChanged();
    assert.equal(h.api.snapshot(), null);
    assert.equal(h.controls.hidden, true);
    assert.equal(h.visible.disabled, true);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);
    assert.equal(h.requests.length, 0);
});

test('snapshot normalization rejects malformed identifiers and never stores preview bytes', () => {
    const h = harness();
    h.api.restore({projectId: PROJECT_ID.toUpperCase(), kind: 'candidate', id: BACK_CANDIDATE_ID, visible: true});
    assert.equal(h.api.snapshot(), null);
    h.api.restore({projectId: PROJECT_ID, kind: 'other', id: BACK_CANDIDATE_ID, visible: true});
    assert.equal(h.api.snapshot(), null);
    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: 'true'});
    assert.equal(h.api.snapshot(), null);
    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false,
        src: '/private/path.png', dataUrl: 'data:image/png;base64,private'});
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot())), {
        projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false
    });
});

test('front editing offers only back candidates and canvases; selection saves, hides, and reopens', async () => {
    const h = harness();
    const beforeLayers = structuredClone(h.canvasState.layers);
    h.api.linkChanged();
    h.api.open();
    await tick();
    const dialog = h.document.getElementById('canvasOppositeDialog');
    assert.equal(dialog.open, true);
    assert.ok(chooseButton(h, 'candidate', BACK_CANDIDATE_ID));
    assert.ok(chooseButton(h, 'canvas', BACK_CANVAS_ID));
    assert.equal(chooseButton(h, 'candidate', FRONT_CANDIDATE_ID), null);
    assert.equal(chooseButton(h, 'canvas', FRONT_CANVAS_ID), null);
    const candidateCard = chooseButton(h, 'candidate', BACK_CANDIDATE_ID);
    assert.equal(candidateCard.children[0].loading, 'lazy');
    assert.equal(candidateCard.children[1].textContent, 'one.png');
    assert.equal(candidateCard.children[1].title, 'back/one.png');

    candidateCard.click();
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot())), {
        projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: true,
        view: {x: 0, y: 0, width: 160, height: 240}
    });
    assert.equal(h.saveCount(), 1);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, false);
    assert.deepEqual(h.canvasState.layers, beforeLayers);

    h.api.setVisible(false);
    assert.equal(h.api.snapshot().visible, false);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);
    h.api.setVisible(true);
    assert.equal(h.api.snapshot().visible, true);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, false);
    assert.equal(h.saveCount(), 3);
    assert.equal(h.requests.length, 2, 'showing a successfully loaded selection reuses its preview');
});

test('back editing offers only front-side items and renders a saved editable canvas copy', async () => {
    const h = harness({link: {projectId: PROJECT_ID, canvasId: BACK_CANVAS_ID, side: 'back'}});
    h.api.linkChanged();
    h.api.open();
    await tick();
    assert.ok(chooseButton(h, 'candidate', FRONT_CANDIDATE_ID));
    assert.ok(chooseButton(h, 'canvas', FRONT_CANVAS_ID));
    assert.equal(chooseButton(h, 'candidate', BACK_CANDIDATE_ID), null);
    assert.equal(chooseButton(h, 'canvas', BACK_CANVAS_ID), null);

    chooseButton(h, 'canvas', FRONT_CANVAS_ID).click();
    await tick();
    assert.equal(h.api.snapshot().kind, 'canvas');
    assert.equal(h.api.snapshot().id, FRONT_CANVAS_ID);
    assert.deepEqual(JSON.parse(JSON.stringify(h.renderCalls[0])), {
        state: h.canvasState, maxDimension: 1600
    });
    assert.match(h.document.getElementById('canvasOppositePreviewImage').src, /^data:image\/png/);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, false);
});

test('preview fits the displayed canvas height at the source aspect ratio and persists view-only state', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();

    const fit = h.document.getElementById('canvasOppositePreviewFit');
    const panel = h.document.getElementById('canvasOppositePreview');
    assert.equal(fit.disabled, false);
    assert.equal(panel.style.width, '160px');
    assert.equal(h.document.getElementById('canvasOppositePreviewPicture').style.height, '240px');
    const picture = h.document.getElementById('canvasOppositePreviewPicture');
    assert.equal(panel.children[0], picture);
    assert.equal(panel.children[1].className, 'canvas-opposite-preview-header');
    assert.equal(h.document.getElementById('canvasOppositePreviewImage').parentElement, picture);
    assert.equal(h.document.getElementById('canvasOppositePreviewResize').parentElement, picture);
    fit.click();

    const view = h.api.snapshot().view;
    assert.equal(view.height, 640);
    assert.ok(Math.abs(view.width - (640 * 2 / 3)) < 1e-9);
    assert.equal(h.document.getElementById('canvasOppositePreviewPicture').style.height, '640px');
    assert.equal(h.saveCount(), 2);
    assert.deepEqual(h.canvasState.layers, [{id: 10, src: '/synthetic-layer.png'}]);

    const saved = structuredClone(h.api.snapshot());
    assert.equal(saved.view.fitToCanvasHeight, true);
    h.api.restore(saved);
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot())), saved);
});

test('height fit follows canvas zoom on render, survives restore, and does not save on every redraw', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    const picture = h.document.getElementById('canvasOppositePreviewPicture');
    h.surface.rectHeight = 320;
    h.api.render();
    assert.equal(picture.style.height, '240px');
    h.document.getElementById('canvasOppositePreviewFit').click();
    for (const height of [160, 640, 320]) {
        h.surface.rectHeight = height;
        h.api.render();
        assert.equal(picture.style.height, `${height}px`);
        assert.ok(Math.abs(h.api.snapshot().view.width - height * 2 / 3) < 1e-9);
    }
    assert.equal(h.saveCount(), 2);
    const saved = structuredClone(h.api.snapshot());
    h.surface.rectHeight = 480;
    h.api.restore(saved);
    await tick();
    assert.equal(picture.style.height, '480px');
    assert.equal(h.api.snapshot().view.fitToCanvasHeight, true);
});

test('moving preserves height fit, cancelled resizing restores it, and manual resizing disables it', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    h.document.getElementById('canvasOppositePreviewFit').click();
    const title = h.document.getElementById('canvasOppositePreviewTitle');
    title.dispatch('pointerdown', {button: 0, pointerId: 1, clientX: 0, clientY: 0});
    title.dispatch('pointermove', {pointerId: 1, clientX: 10, clientY: 20});
    title.dispatch('pointerup', {pointerId: 1});
    assert.equal(h.api.snapshot().view.fitToCanvasHeight, true);
    const resize = h.document.getElementById('canvasOppositePreviewResize');
    resize.dispatch('pointerdown', {button: 0, pointerId: 2, clientX: 0, clientY: 0});
    resize.dispatch('pointermove', {pointerId: 2, clientX: 40, clientY: 0});
    resize.dispatch('pointercancel', {pointerId: 2});
    assert.equal(h.api.snapshot().view.fitToCanvasHeight, true);
    assert.equal(h.saveCount(), 3);
    resize.dispatch('pointerdown', {button: 0, pointerId: 3, clientX: 0, clientY: 0});
    resize.dispatch('pointermove', {pointerId: 3, clientX: 40, clientY: 0});
    resize.dispatch('pointerup', {pointerId: 3});
    const manual = structuredClone(h.api.snapshot().view);
    assert.equal(manual.fitToCanvasHeight, undefined);
    h.surface.rectHeight = 320;
    h.api.render();
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), manual);
    assert.equal(h.saveCount(), 4);
});

test('view normalization drops only invalid view fields and legacy selection defaults on load', async () => {
    const h = harness();
    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false,
        view: {x: 10001, y: 0, width: 160, height: 240}});
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot())), {
        projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false
    });

    h.api.linkChanged();
    h.api.setVisible(true);
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 0, y: 0, width: 160, height: 240});
});

test('move and resize save on pointer release; pointer cancellation rolls back without saving', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();

    const title = h.document.getElementById('canvasOppositePreviewTitle');
    title.dispatch('pointerdown', {button: 0, pointerId: 1, clientX: 10, clientY: 20});
    title.dispatch('pointermove', {pointerId: 1, clientX: 35, clientY: 50});
    title.dispatch('pointerup', {pointerId: 1, clientX: 35, clientY: 50});
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 25, y: 30, width: 160, height: 240});
    assert.equal(h.saveCount(), 2);

    const resize = h.document.getElementById('canvasOppositePreviewResize');
    resize.dispatch('pointerdown', {button: 0, pointerId: 2, clientX: 0, clientY: 0});
    resize.dispatch('pointermove', {pointerId: 2, clientX: 40, clientY: 0});
    resize.dispatch('pointerup', {pointerId: 2, clientX: 40, clientY: 0});
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 25, y: 30, width: 200, height: 300});
    assert.equal(h.saveCount(), 3);

    title.dispatch('pointerdown', {button: 0, pointerId: 3, clientX: 0, clientY: 0});
    title.dispatch('pointermove', {pointerId: 3, clientX: 50, clientY: 60});
    title.dispatch('pointercancel', {pointerId: 3});
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 25, y: 30, width: 200, height: 300});
    assert.equal(h.saveCount(), 3);
});

test('hiding preserves view and selecting another image starts at the default view', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    h.api.restore({...h.api.snapshot(), view: {x: 45, y: -12, width: 160, height: 240}});
    await tick();
    h.api.setVisible(false);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 45, y: -12, width: 160, height: 240});
    h.api.setVisible(true);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 45, y: -12, width: 160, height: 240});

    h.api.open();
    await tick();
    chooseButton(h, 'candidate', SECOND_BACK_CANDIDATE_ID).click();
    await tick();
    assert.equal(h.api.snapshot().id, SECOND_BACK_CANDIDATE_ID);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 0, y: 0, width: 160, height: 240});
});

test('selection changes end an active drag and ignore its later pointer events', async () => {
    const h = harness();
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();

    const title = h.document.getElementById('canvasOppositePreviewTitle');
    title.dispatch('pointerdown', {button: 0, pointerId: 4, clientX: 0, clientY: 0});
    title.dispatch('pointermove', {pointerId: 4, clientX: 70, clientY: 80});
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', SECOND_BACK_CANDIDATE_ID).click();
    await tick();
    title.dispatch('pointermove', {pointerId: 4, clientX: 120, clientY: 130});
    title.dispatch('pointerup', {pointerId: 4});

    assert.equal(h.api.snapshot().id, SECOND_BACK_CANDIDATE_ID);
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot().view)), {x: 0, y: 0, width: 160, height: 240});
    assert.equal(h.saveCount(), 2, 'only the two image selections are saved');
});

test('restore keeps hidden state quiet and fetches a visible selection once the link is active', async () => {
    const h = harness();
    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false});
    h.api.linkChanged();
    assert.equal(h.requests.length, 0);
    assert.equal(h.api.snapshot().visible, false);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);

    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: true});
    await tick();
    assert.equal(h.requests.length, 1);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, false);
});

test('same project, canvas, and side ignore revision and autosave status changes', () => {
    const h = harness();
    h.api.linkChanged();
    const requests = h.requests.length;
    h.context.CanvasProject.localLink = () => ({projectId: PROJECT_ID, canvasId: FRONT_CANVAS_ID,
        side: 'front', revision: 999, unsaved: true});
    h.api.linkChanged();
    assert.equal(h.requests.length, requests);
    assert.equal(h.controls.hidden, false);
});

test('missing candidate is disabled and empty opposite side gives a readable message', async () => {
    const missingProject = projectRecord({candidates: {
        front: [], back: [{id: BACK_CANDIDATE_ID, path: 'gone.png', src: '/image/gone.png', missing: true}]
    }});
    const h = harness({project: missingProject});
    h.api.linkChanged();
    h.api.open();
    await tick();
    assert.equal(chooseButton(h, 'candidate', BACK_CANDIDATE_ID).disabled, true);
    assert.match(h.document.getElementById('canvasOppositeDialog').textContent, /등록된 뒷면 그림이 없습니다/);
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    assert.equal(h.api.snapshot(), null);
    assert.equal(h.saveCount(), 0);
});

test('a vanished selected candidate keeps its saved ID, clears stale image, and can retry', async () => {
    const h = harness();
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), response({status: 'success', project: projectRecord({candidates: {
        front: [], back: [{id: BACK_CANDIDATE_ID, path: 'gone.png', src: '/image/gone.png', missing: true}]
    }})}));
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    assert.equal(h.api.snapshot().id, BACK_CANDIDATE_ID);
    assert.equal(h.api.snapshot().visible, true);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);
    assert.equal(h.retry.hidden, false);
    assert.match(h.status.textContent, /파일을 찾을 수 없습니다/);

    h.api.refresh();
    await tick();
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, false);
    assert.equal(h.retry.hidden, true);
    assert.equal(h.api.snapshot().id, BACK_CANDIDATE_ID);
});

test('an image decode failure keeps the selected ID and exposes retry without a stale preview', async () => {
    const h = harness();
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    const brokenImageProject = normalProject();
    brokenImageProject.candidates.back[0].src = 'bad:broken-image';
    h.addResponse(h.projectUrl(), response({status: 'success', project: brokenImageProject}));
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.snapshot())), {
        projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: true
    });
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);
    assert.equal(h.retry.hidden, false);
    assert.match(h.status.textContent, /표시하지 못했습니다/);
});

test('a late project response after a new choice cannot replace the newer preview', async () => {
    const h = harness();
    const oldChoice = deferred();
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), oldChoice.promise);
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    assert.equal(h.requests.length, 2);

    h.api.open();
    await tick();
    chooseButton(h, 'candidate', SECOND_BACK_CANDIDATE_ID).click();
    await tick();
    oldChoice.resolve(response({status: 'success', project: projectRecord({candidates: {
        front: [], back: [{id: BACK_CANDIDATE_ID, path: 'late.png', src: 'bad:late', missing: false}]
    }})}));
    await tick();
    assert.equal(h.api.snapshot().id, SECOND_BACK_CANDIDATE_ID);
    assert.equal(h.document.getElementById('canvasOppositePreviewImage').src, '/image/back/two.png');
});

test('a late canvas renderer result is ignored after a candidate is selected', async () => {
    const renderResult = deferred();
    const h = harness({renderer: () => renderResult.promise});
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.canvasUrl(FRONT_CANVAS_ID), response({status: 'success', project: {id: PROJECT_ID}, canvas: {
        id: FRONT_CANVAS_ID, side: 'front', name: 'Front edit', state: structuredClone(harness().canvasState)
    }}));
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'canvas', BACK_CANVAS_ID).click();
    await tick();
    assert.equal(h.renderCalls.length, 1);

    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    renderResult.resolve('bad:stale-render');
    await tick();
    assert.equal(h.api.snapshot().kind, 'candidate');
    assert.equal(h.document.getElementById('canvasOppositePreviewImage').src, '/image/back/one.png');
});

test('leaving a project cancels work and hides controls without adding a canvas layer', async () => {
    const h = harness();
    const pending = deferred();
    h.addResponse(h.projectUrl(), response({status: 'success', project: normalProject()}));
    h.addResponse(h.projectUrl(), pending.promise);
    h.api.linkChanged();
    h.api.open();
    await tick();
    chooseButton(h, 'candidate', BACK_CANDIDATE_ID).click();
    await tick();
    const signal = h.requests.at(-1).signal;
    assert.equal(signal.aborted, false);
    h.setLink(null);
    h.api.linkChanged();
    assert.equal(signal.aborted, true);
    pending.resolve(response({status: 'success', project: normalProject()}));
    await tick();
    assert.equal(h.controls.hidden, true);
    assert.equal(h.document.getElementById('canvasOppositePreview').hidden, true);
    assert.equal(h.api.snapshot().id, BACK_CANDIDATE_ID);
    assert.deepEqual(h.canvasState.layers, [{id: 10, src: '/synthetic-layer.png'}]);
});

test('closing the picker cancels its pending catalog request and ignores the late result', async () => {
    const h = harness();
    const pending = deferred();
    h.addResponse(h.projectUrl(), pending.promise);
    h.api.linkChanged();
    h.api.open();
    await tick();
    const request = h.requests.at(-1);
    assert.equal(request.signal.aborted, false);
    const dialog = h.document.getElementById('canvasOppositeDialog');
    dialog.dispatch('cancel');
    assert.equal(request.signal.aborted, true);
    assert.equal(dialog.open, false);
    pending.resolve(response({status: 'success', project: normalProject()}));
    await tick();
    assert.equal(dialog.open, false);
    assert.equal(find(dialog, node => node.dataset?.kind === 'candidate' && node.dataset?.id === BACK_CANDIDATE_ID), null);
});

test('changing canvas side cancels a picker request tied to the old opposite side', async () => {
    const h = harness();
    const pending = deferred();
    h.addResponse(h.projectUrl(), pending.promise);
    h.api.linkChanged();
    h.api.open();
    await tick();
    const oldRequest = h.requests.at(-1);
    h.setLink({projectId: PROJECT_ID, canvasId: BACK_CANVAS_ID, side: 'back'});
    h.api.linkChanged();
    assert.equal(oldRequest.signal.aborted, true);
    assert.equal(h.document.getElementById('canvasOppositeDialog').open, false);
    pending.resolve(response({status: 'success', project: normalProject()}));
    await tick();
    assert.equal(chooseButton(h, 'candidate', BACK_CANDIDATE_ID), null);
});

test('switching projects clears the old project selection', async () => {
    const h = harness();
    h.api.restore({projectId: PROJECT_ID, kind: 'candidate', id: BACK_CANDIDATE_ID, visible: false});
    h.api.linkChanged();
    h.setLink({projectId: OTHER_PROJECT_ID, canvasId: FRONT_CANVAS_ID, side: 'front'});
    h.setProject(normalProject(OTHER_PROJECT_ID));
    h.api.linkChanged();
    assert.equal(h.api.snapshot(), null);
    assert.equal(h.controls.hidden, false);
    assert.equal(h.visible.disabled, true);
});
