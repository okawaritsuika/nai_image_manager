const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const WorkspaceState = require('../static/canvas_workspace_state.js');
const RetouchState = require('../static/canvas_retouch_state.js');

const STATE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_workspace_state.js'), 'utf8');
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_workspace.js'), 'utf8');
const WORKSPACE_CSS = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_workspace.css'), 'utf8');
const WORKSPACE_ID = 'a'.repeat(32);
const PANE_ID = 'b'.repeat(32);
const SECOND_PANE_ID = 'c'.repeat(32);
const PROJECT_ID = 'd'.repeat(32);
const CANVAS_ID = 'e'.repeat(32);
const OTHER_CANVAS_ID = 'f'.repeat(32);
const CHANNEL = 'naim-canvas-workspace';

class Element {
    constructor(tag, created) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.className = '';
        this.parentNode = null;
        this.style = {};
        this.hidden = false;
        this.inert = false;
        this.disabled = false;
        this.open = false;
        this.clientWidth = 1280;
        this.clientHeight = 700;
        this.scrollLeft = 0;
        this.scrollTop = 0;
        this.value = '';
        this.naturalWidth = 0;
        this.naturalHeight = 0;
        this.complete = false;
        this._textContent = '';
        this._innerHTMLWriteCount = 0;
        this.listeners = new Map();
        if (this.tagName === 'IFRAME') {
            this.contentWindow = {
                sent: [],
                focus() { this.focused = true; },
                postMessage(data, targetOrigin) { this.sent.push({data, targetOrigin}); },
            };
        }
        created.push(this);
        this.classList = {
            add: (...names) => names.forEach(name => this.toggleClass(name, true)),
            remove: (...names) => names.forEach(name => this.toggleClass(name, false)),
            contains: name => this.className.split(/\s+/).includes(name),
            toggle: (name, force) => {
                const next = force === undefined ? !this.classList.contains(name) : Boolean(force);
                this.toggleClass(name, next);
                return next;
            },
        };
    }
    toggleClass(name, enabled) {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = Array.from(names).join(' ');
    }
    get textContent() { return this._textContent; }
    set textContent(value) {
        this._textContent = String(value);
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
    }
    get innerHTML() { return ''; }
    set innerHTML(value) {
        this._innerHTMLWriteCount += 1;
        this._innerHTMLValue = String(value);
    }
    appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    insertBefore(child, reference) {
        child.remove();
        const index = this.children.indexOf(reference);
        if (index < 0) return this.appendChild(child);
        this.children.splice(index, 0, child); child.parentNode = this; return child;
    }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._textContent = '';
        this.append(...children);
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter(child => child !== this);
            this.parentNode = null;
        }
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }
    removeEventListener(type, callback) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== callback));
    }
    scrollIntoView() { this.scrolledIntoView = true; }
    dispatch(type, event = {}) {
        for (const callback of this.listeners.get(type) || []) callback({currentTarget: this, ...event});
    }
    getBoundingClientRect() { return this.rect || {left: 0, top: 0, width: 400, height: 48}; }
    setPointerCapture() { this.pointerCaptured = true; }
    hasPointerCapture() { return Boolean(this.pointerCaptured); }
    releasePointerCapture() { this.pointerCaptured = false; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    matches(selector) {
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        if (selector.startsWith('[') && selector.endsWith(']')) {
            const attribute = selector.slice(1, -1);
            if (attribute.startsWith('data-')) {
                const key = attribute.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
                return Object.hasOwn(this.dataset, key);
            }
            return Object.hasOwn(this.attributes, attribute);
        }
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map(value => value.trim());
        return this.descendants().filter(child => selectors.some(value => child.matches(value)));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeStorage {
    constructor(values = new Map()) {
        this.values = values;
        this.setAttempts = [];
        this.failKey = null;
    }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) {
        this.setAttempts.push([key, String(value)]);
        if (key === this.failKey) {
            this.failKey = null;
            throw new Error('synthetic storage write failure');
        }
        this.values.set(key, String(value));
    }
    removeItem(key) { this.values.delete(key); }
    key(index) { return Array.from(this.values.keys())[index] ?? null; }
    get length() { return this.values.size; }
    failNextSetFor(key) { this.failKey = key; }
}

function pane(id, name, overrides = {}) {
    return {id, name, closed: false, retouch: false, ...overrides};
}

function harness({panes = [pane(PANE_ID, 'Original')], activeId = PANE_ID,
    workspaceId = WORKSPACE_ID, inlinePaneId = PANE_ID} = {}) {
    const manifestKey = WorkspaceState.manifestKey(workspaceId);
    const manifest = WorkspaceState.normalize({version: 1, panes, activeId, layout: 'row'});
    const storage = new FakeStorage(new Map([[manifestKey, JSON.stringify(manifest)]]));
    const created = [];
    const listeners = new Map();
    const timers = new Map();
    const attachCalls = [];
    const readyCalls = [];
    const bridgeCommands = [];
    const snapshotCalls = [];
    const assignedUrls = [];
    let nextId = 1;
    let nextTimer = 1;
    const document = {
        readyState: 'complete',
        createElement(tag) {
            const value = new Element(tag, created);
            if (value.tagName === 'IFRAME') {
                const editorWorkspace = new Element('div', created);
                editorWorkspace.className = 'canvas-workspace';
                const editorControlsSlot = new Element('div', created);
                editorControlsSlot.id = 'canvasWorkspaceControls';
                const editorSurface = new Element('div', created);
                editorSurface.id = 'canvasSurface'; editorSurface.rect = {left: 0, top: 0, width: 400, height: 600};
                editorWorkspace.append(editorControlsSlot, editorSurface);
                value.editorWorkspace = editorWorkspace;
                value.editorControlsSlot = editorControlsSlot;
                value.contentDocument = {
                    querySelector(selector) {
                        if (selector === '.canvas-workspace') return editorWorkspace;
                        if (selector === '#canvasWorkspaceControls') return editorControlsSlot;
                        if (selector === '#canvasSurface') return editorSurface;
                        return null;
                    },
                };
            }
            return value;
        },
        addEventListener() {},
        querySelector(selector) {
            if (selector === '.canvas-workspace') return rootWorkspace;
            return this.body.querySelector(selector);
        },
    };
    document.body = new Element('body', created);
    const rootWorkspace = new Element('main', created);
    rootWorkspace.className = 'canvas-workspace';
    rootWorkspace.id = 'canvasWorkspace';
    const rootControlsSlot = new Element('div', created);
    rootControlsSlot.id = 'canvasWorkspaceControls';
    const rootSurface = new Element('div', created);
    rootSurface.id = 'canvasSurface'; rootSurface.rect = {left: 0, top: 0, width: 400, height: 600};
    rootWorkspace.append(rootControlsSlot, rootSurface, new Element('section', created));
    document.body.append(rootWorkspace);
    const window = {
        CanvasWorkspaceState: WorkspaceState,
        CanvasRetouchState: RetouchState,
        structuredClone,
        URLSearchParams,
        buildCanvasStateSnapshot(options) { snapshotCalls.push(options); return {layers: []}; },
        document,
        localStorage: storage,
        location: {
            search: '', origin: 'http://naim.test', pathname: '/canvas',
            assign(url) { assignedUrls.push(url); },
        },
        crypto: {randomUUID: () => (nextId++).toString(16).padStart(32, '0')},
        fetch: () => Promise.reject(new Error('network access is disabled in this fixture')),
        addEventListener(type, callback) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(callback);
        },
        setTimeout(callback, delay) {
            const timer = {id: nextTimer++, callback, delay};
            timers.set(timer.id, timer);
            return timer.id;
        },
        clearTimeout(id) { timers.delete(id); },
    };
    window.window = window;
    window.CanvasWorkspaceBridge = {
        attach(nextWorkspaceId, paneId) { attachCalls.push({workspaceId: nextWorkspaceId, paneId}); return true; },
        ready() {
            readyCalls.push(true);
            const localPane = panes.find(value => value.id === inlinePaneId);
            window.CanvasWorkspace.receive({channel: CHANNEL, type: 'ready', paneId: inlinePaneId,
                ready: true, status: 'saved', name: localPane?.name || 'Original',
                ...(localPane?.projectId && localPane?.canvasId ? {projectId: localPane.projectId, canvasId: localPane.canvasId} : {})}, window);
            return true;
        },
        execute(action, extra = {}) {
            bridgeCommands.push({action, extra});
            if (action === 'preview') return Promise.resolve({ok: true, preview: 'data:image/png;base64,inline'});
            return Promise.resolve({ok: true});
        },
    };
    const context = vm.createContext(window);
    vm.runInContext(STATE_SOURCE, context);
    vm.runInContext(SOURCE, context);

    function dispatchMessage({origin = window.location.origin, source, data}) {
        for (const callback of listeners.get('message') || []) callback({origin, source, data});
    }
    function frames() { return document.body.querySelectorAll('iframe'); }
    function frameFor(paneId) {
        return frames().find(frame => new URL(frame.src, window.location.origin).searchParams.get('pane') === paneId);
    }
    function referenceFor(paneId) {
        return created.find(element => element.classList.contains('canvas-multi-reference')
            && element.dataset.paneId === paneId);
    }
    function storedManifest() { return JSON.parse(storage.getItem(manifestKey)); }
    function start(options = {}) {
        window.__workspaceStartOptions = JSON.stringify({workspaceId, ...(inlinePaneId ? {paneId: inlinePaneId} : {}), ...options});
        return vm.runInContext('CanvasWorkspace.start(JSON.parse(__workspaceStartOptions))', context);
    }
    function ready(paneId, {name} = {}) {
        const frame = frameFor(paneId);
        const entry = storedManifest().panes.find(value => value.id === paneId);
        assert.ok(frame, 'expected an iframe for pane ' + paneId);
        dispatchMessage({source: frame.contentWindow, data: {
            channel: CHANNEL, type: 'ready', paneId, ready: true, status: 'saved',
            name: name || entry.name, retouch: entry.retouch,
            ...(entry.projectId ? {projectId: entry.projectId, canvasId: entry.canvasId} : {}),
        }});
        return frame;
    }
    function lastCommand(frame, action) {
        return frame.contentWindow.sent.map(item => item.data).filter(data => data.action === action).at(-1);
    }
    function sendResponse(frame, paneId, requestId, ok, error = '', preview) {
        dispatchMessage({source: frame.contentWindow, data: {
            channel: CHANNEL, type: 'response', paneId, requestId, ok, error, ...(preview !== undefined ? {preview} : {}),
        }});
    }
    const workspace = {
        add(input, snapshot) {
            window.__workspaceInputJson = JSON.stringify(input);
            window.__workspaceSnapshotJson = snapshot === undefined ? null : JSON.stringify(snapshot);
            return vm.runInContext(
                'CanvasWorkspace.add(JSON.parse(__workspaceInputJson), __workspaceSnapshotJson === null ? undefined : JSON.parse(__workspaceSnapshotJson))',
                context,
            );
        },
        select(paneId) {
            window.__workspacePaneId = paneId;
            return vm.runInContext('CanvasWorkspace.select(__workspacePaneId)', context);
        },
        toggle(paneId) {
            window.__workspacePaneId = paneId;
            return vm.runInContext('CanvasWorkspace.toggle(__workspacePaneId)', context);
        },
        close(paneId) {
            window.__workspacePaneId = paneId;
            return vm.runInContext('CanvasWorkspace.close(__workspacePaneId)', context);
        },
        openManager() { return vm.runInContext('CanvasWorkspace.openManager()', context); },
        openPicker() { return vm.runInContext('CanvasWorkspace.openPicker()', context); },
        readRetouchSettings(paneId, source) {
            window.__workspacePaneId = paneId;
            window.__workspaceSource = source;
            return vm.runInContext('CanvasWorkspace.readRetouchSettings(__workspacePaneId, __workspaceSource)', context);
        },
        writeRetouchSettings(paneId, source, value) {
            window.__workspacePaneId = paneId;
            window.__workspaceSource = source;
            window.__workspaceValue = value;
            return vm.runInContext('CanvasWorkspace.writeRetouchSettings(__workspacePaneId, __workspaceSource, __workspaceValue)', context);
        },
    };
    start();

    return {
        window, document, rootWorkspace, storage, created, timers, workspace, manifestKey,
        rootControlsSlot,
        dispatchMessage, frames, frameFor, referenceFor, storedManifest, ready, lastCommand, sendResponse,
        attachCalls, readyCalls, bridgeCommands, assignedUrls,
        snapshotCalls,
        get controls() { return created.find(element => element.classList.contains('canvas-multi-controls')); },
        get mainSelect() { return created.find(element => element.classList.contains('canvas-multi-main-select')); },
        get visibilityMenu() { return created.find(element => element.classList.contains('canvas-multi-visibility')); },
        get referenceContainer() { return created.find(element => element.classList.contains('canvas-multi-references')); },
    };
}

function plain(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function optionFor(select, paneId) { return select.children.find(option => option.value === paneId); }
function pickerCardFor(document, name) {
    return document.body.querySelectorAll('.canvas-multi-picker-card')
        .find(card => card.querySelector('strong')?.textContent === name);
}
function checkboxFor(controls, paneId) {
    return controls.querySelectorAll('input').find(input => input.dataset.paneId === paneId);
}

test('start keeps the original editor inline and rejects forged frame messages', () => {
    const h = harness({panes: [pane(PANE_ID, 'Original'), pane(SECOND_PANE_ID, 'Reference')], activeId: PANE_ID});
    const originalWorkspace = h.rootWorkspace;
    const referenceFrame = h.frameFor(SECOND_PANE_ID);
    const fake = {channel: CHANNEL, type: 'ready', paneId: SECOND_PANE_ID, ready: true,
        status: 'saved', name: '<b>forged</b>'};

    assert.equal(h.frameFor(PANE_ID), undefined, 'the original canvas has no iframe');
    assert.ok(referenceFrame);
    assert.equal(referenceFrame.hidden, true);
    assert.equal(referenceFrame.inert, true);
    assert.equal(h.referenceFor(SECOND_PANE_ID).style.top, '56px', 'the default reference clears the body-map HUD');
    assert.deepEqual(h.attachCalls, [{workspaceId: WORKSPACE_ID, paneId: PANE_ID}]);
    assert.deepEqual(h.readyCalls, [true]);
    assert.strictEqual(h.rootWorkspace, originalWorkspace);
    assert.deepEqual(h.assignedUrls, []);
    assert.deepEqual(h.snapshotCalls, [], 'starting the workspace keeps the original in-memory canvas state');
    assert.equal(h.window.location.search, '');

    h.dispatchMessage({origin: 'http://attacker.test', source: referenceFrame.contentWindow, data: fake});
    h.dispatchMessage({source: {postMessage() {}}, data: fake});
    assert.equal(h.storedManifest().panes[1].name, 'Reference');
    assert.equal(h.referenceFor(SECOND_PANE_ID).querySelector('.canvas-multi-reference-title').textContent, 'Reference');
});

test('selection waits for readiness and swaps reference slots while preserving both editor contexts', () => {
    const firstReference = {visible: true, x: 24, y: 35, width: 180, height: 210};
    const secondReference = {visible: true, x: 240, y: 95, width: 230, height: 260};
    const h = harness({panes: [pane(PANE_ID, 'Front', {reference: firstReference}),
        pane(SECOND_PANE_ID, 'Back', {reference: secondReference})], activeId: PANE_ID});
    const frame = h.frameFor(SECOND_PANE_ID), childWindow = frame.contentWindow;

    assert.equal(h.workspace.select(SECOND_PANE_ID), false);
    assert.equal(h.storedManifest().activeId, PANE_ID);
    assert.equal(frame.hidden, true);
    assert.equal(h.window.document.body.classList.contains('canvas-workspace-root-inactive'), false);

    h.ready(SECOND_PANE_ID);
    assert.equal(h.workspace.select(SECOND_PANE_ID), true);
    let stored = h.storedManifest();
    assert.equal(stored.activeId, SECOND_PANE_ID);
    assert.deepEqual(stored.panes.find(value => value.id === PANE_ID).reference, secondReference);
    assert.deepEqual(stored.panes.find(value => value.id === SECOND_PANE_ID).reference, firstReference);
    assert.equal(frame.hidden, false);
    assert.equal(frame.inert, false);
    assert.strictEqual(frame.contentWindow, childWindow);
    assert.equal(h.window.document.body.classList.contains('canvas-workspace-root-inactive'), true);
    assert.equal(h.referenceFor(SECOND_PANE_ID).hidden, true, 'the active pane has no duplicate reference card');
    assert.strictEqual(h.referenceContainer.parentNode, frame.editorWorkspace);
    assert.equal(h.referenceFor(PANE_ID).parentNode, h.referenceContainer);
    assert.equal(h.referenceFor(PANE_ID).hidden, false);
    assert.ok(h.bridgeCommands.some(command => command.action === 'preview'),
        'the former main gets a picture preview after switching away');

    assert.equal(h.workspace.select(PANE_ID), true);
    stored = h.storedManifest();
    assert.equal(stored.activeId, PANE_ID);
    assert.deepEqual(stored.panes.find(value => value.id === PANE_ID).reference, firstReference);
    assert.deepEqual(stored.panes.find(value => value.id === SECOND_PANE_ID).reference, secondReference);
    assert.equal(frame.hidden, true);
    assert.equal(frame.inert, true);
    assert.strictEqual(frame.contentWindow, childWindow);
    assert.equal(h.window.document.body.classList.contains('canvas-workspace-root-inactive'), false);
    assert.strictEqual(h.referenceContainer.parentNode, h.rootWorkspace);
});

test('main selector follows the active editor, waits for readiness, and renders names as text', () => {
    const h = harness({panes: [pane(PANE_ID, 'Front'), pane(SECOND_PANE_ID, 'Back')], activeId: PANE_ID});
    const controls = h.controls, select = h.mainSelect;
    const frame = h.frameFor(SECOND_PANE_ID);

    assert.strictEqual(controls.parentNode, h.rootControlsSlot);
    assert.equal(select.value, PANE_ID);
    assert.equal(optionFor(select, SECOND_PANE_ID).disabled, true);
    select.value = SECOND_PANE_ID;
    select.onchange();
    assert.equal(select.value, PANE_ID, 'an unready option cannot replace the active pane');

    h.ready(SECOND_PANE_ID);
    assert.equal(optionFor(select, SECOND_PANE_ID).disabled, false);
    select.value = SECOND_PANE_ID;
    select.onchange();
    assert.equal(h.storedManifest().activeId, SECOND_PANE_ID);
    assert.strictEqual(controls.parentNode, frame.editorControlsSlot);
    assert.strictEqual(h.controls, controls, 'the same controls move into the active editor');

    const unsafeLongName = '한글'.repeat(50) + '<script>alert(1)</script>';
    h.dispatchMessage({source: frame.contentWindow, data: {
        channel: CHANNEL, type: 'status', paneId: SECOND_PANE_ID, ready: true, status: 'saved', name: unsafeLongName,
    }});
    assert.equal(optionFor(select, SECOND_PANE_ID).textContent, unsafeLongName);
    assert.equal(select.title, unsafeLongName);
    assert.equal(checkboxFor(controls, SECOND_PANE_ID).parentNode.querySelector('span').textContent, unsafeLongName);
    assert.equal(h.created.some(element => element.tagName === 'SCRIPT'), false);
    assert.equal(h.created.some(element => element._innerHTMLWriteCount > 0), false);

    assert.equal(h.workspace.select(PANE_ID), true);
    assert.strictEqual(controls.parentNode, h.rootControlsSlot, 'controls return to the root editor');
});

test('visibility checkboxes toggle references, stay open, and restore their state after storage failure', () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Reference')], activeId: PANE_ID});
    h.ready(SECOND_PANE_ID);
    const menu = h.visibilityMenu;
    menu.open = true;

    const activeCheckbox = checkboxFor(h.controls, PANE_ID);
    assert.equal(activeCheckbox.checked, true);
    assert.equal(activeCheckbox.disabled, true);
    const referenceCheckbox = checkboxFor(h.controls, SECOND_PANE_ID);
    assert.equal(referenceCheckbox.checked, true);
    referenceCheckbox.checked = false;
    referenceCheckbox.onchange();
    assert.equal(h.storedManifest().panes[1].reference.visible, false);
    assert.equal(menu.open, true);
    assert.equal(checkboxFor(h.controls, SECOND_PANE_ID).checked, false);

    h.storage.failNextSetFor(h.manifestKey);
    const failedCheckbox = checkboxFor(h.controls, SECOND_PANE_ID);
    failedCheckbox.checked = true;
    failedCheckbox.onchange();
    assert.equal(h.storedManifest().panes[1].reference.visible, false);
    assert.equal(failedCheckbox.checked, false, 'a rejected save restores the previous checkbox state');
    assert.equal(menu.open, true);
});

test('duplicate add reveals its existing picture without selecting it; saved additions keep the current main', () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Project reference',
        {projectId: PROJECT_ID, canvasId: CANVAS_ID})], activeId: PANE_ID});
    const projectFrame = h.ready(SECOND_PANE_ID);
    const originalChild = projectFrame.contentWindow;
    h.workspace.toggle(SECOND_PANE_ID);
    assert.equal(h.referenceFor(SECOND_PANE_ID).hidden, true);

    assert.equal(h.workspace.add({name: 'Duplicate label', projectId: PROJECT_ID, canvasId: CANVAS_ID}), SECOND_PANE_ID);
    assert.equal(h.storedManifest().activeId, PANE_ID);
    assert.equal(h.storedManifest().panes.length, 2);
    assert.equal(h.storedManifest().panes[1].reference.visible, true);
    assert.equal(h.referenceFor(SECOND_PANE_ID).hidden, false);
    assert.strictEqual(h.frameFor(SECOND_PANE_ID), projectFrame);
    assert.strictEqual(projectFrame.contentWindow, originalChild);

    const snapshot = {version: 2, width: 64, height: 96, layers: [{id: 'synthetic'}]};
    const savedId = h.workspace.add({name: 'Saved setup', setupId: 'synthetic-setup'}, snapshot);
    assert.ok(savedId);
    assert.equal(h.storedManifest().activeId, PANE_ID);
    assert.equal(h.storedManifest().panes.length, 3);
    const savedStateKey = WorkspaceState.stateKey(WORKSPACE_ID, savedId);
    assert.deepEqual(JSON.parse(h.storage.getItem(savedStateKey)), {
        ...snapshot, projectLink: null, workspaceSetupId: 'synthetic-setup',
    });
    assert.equal(h.frameFor(savedId).hidden, true);
    assert.equal(h.referenceFor(savedId).hidden, false);
});

test('show and hide toggles preserve the inactive iframe and display a returned preview', async () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Reference')], activeId: PANE_ID});
    const frame = h.ready(SECOND_PANE_ID);
    const childWindow = frame.contentWindow;
    const card = h.referenceFor(SECOND_PANE_ID);

    h.workspace.toggle(SECOND_PANE_ID);
    assert.equal(card.hidden, true);
    assert.equal(h.storedManifest().panes[1].reference.visible, false);
    assert.strictEqual(h.frameFor(SECOND_PANE_ID), frame);
    assert.strictEqual(frame.contentWindow, childWindow);
    assert.equal(frame.hidden, true);

    h.workspace.toggle(SECOND_PANE_ID);
    const queuedPreview = h.lastCommand(frame, 'preview');
    assert.ok(queuedPreview?.requestId);
    assert.equal(card.hidden, false);
    assert.strictEqual(h.frameFor(SECOND_PANE_ID), frame);
    h.sendResponse(frame, SECOND_PANE_ID, queuedPreview.requestId, true, '', 'data:image/png;base64,stale');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.querySelector('img').src, undefined, 'a queued refresh discards the older render');
    const previewCommand = h.lastCommand(frame, 'preview');
    assert.notEqual(previewCommand.requestId, queuedPreview.requestId);
    h.sendResponse(frame, SECOND_PANE_ID, previewCommand.requestId, true, '', 'data:image/png;base64,reference');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.querySelector('img').src, 'data:image/png;base64,reference');
    assert.equal(card.querySelector('img').hidden, false);
});

test('active and hidden saved panes skip preview requests', () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Hidden',
        {reference: {visible: false, x: 30, y: 56, width: 160, height: 300}})], activeId: PANE_ID});
    const frame = h.ready(SECOND_PANE_ID);
    h.dispatchMessage({source: frame.contentWindow, data: {
        channel: CHANNEL, type: 'status', paneId: SECOND_PANE_ID, ready: true, status: 'saved', name: 'Hidden',
    }});
    h.window.CanvasWorkspace.receive({channel: CHANNEL, type: 'status', paneId: PANE_ID,
        ready: true, status: 'saved', name: 'Main'}, h.window);

    assert.equal(h.lastCommand(frame, 'preview'), undefined);
    assert.equal(h.bridgeCommands.some(command => command.action === 'preview'), false);
    assert.equal(h.referenceFor(SECOND_PANE_ID).hidden, true);
});

test('close waits for its matching flush and ignores a preview response arriving after removal', async () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Reference')], activeId: PANE_ID});
    const frame = h.ready(SECOND_PANE_ID);
    const card = h.referenceFor(SECOND_PANE_ID);
    const previewCommand = h.lastCommand(frame, 'preview');
    const closing = h.workspace.close(SECOND_PANE_ID);
    const flushCommand = h.lastCommand(frame, 'flush');
    assert.ok(flushCommand?.requestId);
    assert.equal(h.frames().length, 1);

    let settled = false;
    closing.then(() => { settled = true; });
    h.sendResponse(frame, SECOND_PANE_ID, 'wrong-request-id', true);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(h.storedManifest().panes[1].closed, false);

    h.sendResponse(frame, SECOND_PANE_ID, flushCommand.requestId, true);
    assert.equal(await closing, true);
    assert.equal(h.frames().length, 0);
    assert.equal(h.storedManifest().panes[1].closed, true);
    assert.equal(card.parentNode, null);
    assert.equal(optionFor(h.mainSelect, SECOND_PANE_ID), undefined);
    assert.equal(checkboxFor(h.controls, SECOND_PANE_ID), undefined);

    h.sendResponse(frame, SECOND_PANE_ID, previewCommand.requestId, true, '', 'data:image/png;base64,late');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(card.querySelector('img').src, undefined);
});

test('storage failures in add, select, and close preserve the main editor and mounted references', async () => {
    const adding = harness();
    adding.storage.failNextSetFor(adding.manifestKey);
    assert.equal(adding.workspace.add({name: 'Rejected'}, {width: 16, height: 16, layers: []}), null);
    assert.equal(adding.storedManifest().activeId, PANE_ID);
    assert.equal(adding.storedManifest().panes.length, 1);
    assert.equal(adding.frames().length, 0);
    assert.equal(adding.window.document.body.classList.contains('canvas-workspace-root-inactive'), false);

    const selecting = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Back')], activeId: PANE_ID});
    const frame = selecting.ready(SECOND_PANE_ID);
    const currentSelect = selecting.mainSelect;
    selecting.storage.failNextSetFor(selecting.manifestKey);
    currentSelect.value = SECOND_PANE_ID;
    currentSelect.onchange();
    assert.equal(selecting.storedManifest().activeId, PANE_ID);
    assert.equal(currentSelect.value, PANE_ID, 'the selector returns to the persisted main pane');
    assert.equal(frame.hidden, true);
    assert.equal(selecting.window.document.body.classList.contains('canvas-workspace-root-inactive'), false);
    assert.equal(selecting.frames().length, 1);

    const closing = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Back')], activeId: PANE_ID});
    const closeFrame = closing.ready(SECOND_PANE_ID);
    closing.storage.failNextSetFor(closing.manifestKey);
    const closeAttempt = closing.workspace.close(SECOND_PANE_ID);
    const flushCommand = closing.lastCommand(closeFrame, 'flush');
    closing.sendResponse(closeFrame, SECOND_PANE_ID, flushCommand.requestId, true);
    assert.equal(await closeAttempt, false);
    assert.equal(closing.storedManifest().panes[1].closed, false);
    assert.strictEqual(closing.frameFor(SECOND_PANE_ID), closeFrame);
    assert.equal(closing.frames().length, 1);
});

test('reopening the original local pane reuses its bridge and never creates an iframe', async () => {
    const h = harness();
    const originalWorkspace = h.rootWorkspace;
    assert.equal(await h.workspace.close(PANE_ID), true);
    const closedPane = h.storedManifest().panes[0];
    assert.equal(closedPane.closed, true);
    assert.strictEqual(h.controls.parentNode, h.window.document.body.querySelector('#canvasMulti'),
        'controls fall back under the workspace shell when there is no active editor');
    assert.equal(h.mainSelect.disabled, true);
    assert.equal(h.mainSelect.children.length, 1);
    assert.equal(h.mainSelect.children[0].textContent, '열린 캔버스 없음');
    assert.equal(h.attachCalls.length, 1);

    assert.equal(h.workspace.add(closedPane), PANE_ID);
    assert.equal(h.workspace.select(PANE_ID), true);
    assert.equal(h.storedManifest().activeId, PANE_ID);
    assert.equal(h.storedManifest().panes[0].closed, false);
    assert.equal(h.frameFor(PANE_ID), undefined);
    assert.equal(h.frames().length, 0);
    assert.equal(h.attachCalls.length, 1);
    assert.strictEqual(h.rootWorkspace, originalWorkspace);
    assert.deepEqual(h.assignedUrls, []);
});

test('reopening a closed reference reuses its scoped snapshot without changing the main editor', () => {
    const closedPane = pane(SECOND_PANE_ID, 'Saved reference', {closed: true, setupId: 'synthetic-setup'});
    const h = harness({panes: [pane(PANE_ID, 'Main'), closedPane], activeId: PANE_ID});
    const paneStateKey = WorkspaceState.stateKey(WORKSPACE_ID, SECOND_PANE_ID);
    const snapshot = JSON.stringify({version: 2, width: 64, height: 96, layers: [{id: 'synthetic'}]});
    h.storage.values.set(paneStateKey, snapshot);

    assert.equal(h.frameFor(SECOND_PANE_ID), undefined);
    assert.equal(h.workspace.add(closedPane), SECOND_PANE_ID);
    assert.equal(h.storedManifest().activeId, PANE_ID);
    assert.equal(h.storedManifest().panes[1].closed, false);
    assert.equal(h.frameFor(SECOND_PANE_ID).src,
        `/canvas?workspace=${WORKSPACE_ID}&pane=${SECOND_PANE_ID}`);
    assert.equal(h.storage.getItem(paneStateKey), snapshot);
    assert.equal(h.storage.setAttempts.filter(([key]) => key === paneStateKey).length, 0);
});

test('manager names are text even when a canvas name contains markup', () => {
    const name = '<img src=x onerror=alert(1)><script>bad()</script>';
    const h = harness({panes: [pane(PANE_ID, name)], activeId: PANE_ID});
    h.workspace.openManager();
    const row = h.window.document.body.querySelector('.canvas-multi-picker-content').querySelector('.canvas-multi-manager-row');
    assert.equal(row.querySelector('strong').textContent, name);
    assert.equal(h.created.filter(element => element.tagName === 'IMG').length, 1, 'the reference picture uses one expected image element');
    assert.equal(h.created.some(element => element.tagName === 'SCRIPT'), false);
    assert.equal(h.created.some(element => element._innerHTMLWriteCount > 0), false);
});

test('gallery prioritizes the active project, searches names, and previews project and saved canvases', async () => {
    const otherProjectId = '1'.repeat(32), backCanvasId = '2'.repeat(32);
    const h = harness({panes: [pane(PANE_ID, 'Front view', {projectId: PROJECT_ID, canvasId: CANVAS_ID})], activeId: PANE_ID});
    h.window.CanvasProject = {localLink: () => ({projectId: PROJECT_ID, projectName: 'Alpha project'})};
    const previews = [];
    h.window.DakiCanvasPreviews = {create() {return {
        observe(container, projectId, canvas) {previews.push({kind: 'project', container, projectId, canvas});},
        observeState(container, item) {previews.push({kind: 'saved', container, item});},
        dispose() {previews.push({kind: 'dispose'});},
    };}};
    h.window.fetch = async url => ({ok: true, async json() {
        if (url === '/api/daki/projects') return {status: 'success', projects: [
            {id: otherProjectId, name: 'Beta project', canvases: {front: [{id: '3'.repeat(32), name: 'Other front', revision: 2}]}},
            {id: PROJECT_ID, name: 'Alpha project', canvases: {
                front: [{id: CANVAS_ID, name: 'Front view', revision: 5}],
                back: [{id: backCanvasId, name: 'Back view', revision: 6}],
            }},
        ]};
        return {status: 'success', setups: [{id: 'saved-setup', name: 'Saved study', savedAt: 123,
            width: 512, height: 256, state: {width: 512, height: 256, layers: []}}]};
    }});

    await h.workspace.openPicker();
    const dialog = h.document.body.querySelector('.canvas-multi-picker-gallery');
    const titles = dialog.querySelectorAll('h3').map(element => element.textContent);
    assert.ok(titles.includes('현재 프로젝트 · Alpha project'));
    assert.ok(titles.indexOf('다른 프로젝트') < titles.indexOf('저장한 캔버스'));
    assert.deepEqual(dialog.querySelectorAll('.canvas-multi-picker-card').map(card => card.querySelector('strong').textContent),
        ['Front view', 'Back view', 'Other front', 'Saved study']);
    assert.strictEqual(pickerCardFor(h.document, 'Front view').parentNode, pickerCardFor(h.document, 'Back view').parentNode,
        'the active project front and back canvases share one grid');
    assert.notStrictEqual(pickerCardFor(h.document, 'Other front').parentNode, pickerCardFor(h.document, 'Front view').parentNode,
        'other projects keep their own card grid');
    assert.equal(pickerCardFor(h.document, 'Front view').querySelector('.canvas-multi-picker-open-badge').textContent, '열림');
    assert.ok(previews.some(value => value.kind === 'project' && value.projectId === PROJECT_ID && value.canvas.side === 'front'));
    assert.ok(previews.some(value => value.kind === 'project' && value.projectId === PROJECT_ID && value.canvas.side === 'back'));
    assert.ok(previews.some(value => value.kind === 'saved' && value.item.id === 'saved-setup'
        && value.item.savedAt === 123 && Array.isArray(value.item.state.layers)));

    const search = dialog.querySelector('.canvas-multi-picker-search');
    search.value = 'back'; search.oninput();
    assert.equal(pickerCardFor(h.document, 'Back view').hidden, false);
    assert.equal(pickerCardFor(h.document, 'Front view').hidden, true);
    assert.equal(pickerCardFor(h.document, 'Other front').hidden, true);
    assert.equal(previews.filter(value => value.kind === 'dispose').length, 0,
        'search keeps the existing preview session and completed thumbnails usable');
    search.value = ''; search.oninput();
    const front = pickerCardFor(h.document, 'Front view'), saved = pickerCardFor(h.document, 'Saved study');
    front.querySelector('input').checked = true; front.querySelector('input').onchange();
    saved.querySelector('input').checked = true; saved.querySelector('input').onchange();
    const addSelected = dialog.querySelector('.canvas-multi-picker-footer').querySelector('button');
    assert.equal(addSelected.disabled, false);
    assert.equal(addSelected.textContent, '선택 2개 추가');
    await addSelected.onclick();
    const stored = h.storedManifest();
    assert.ok(stored.panes.some(value => value.projectId === PROJECT_ID && value.canvasId === CANVAS_ID));
    const savedPane = stored.panes.find(value => value.setupId === 'saved-setup');
    assert.ok(savedPane);
    assert.ok(h.storage.getItem(WorkspaceState.stateKey(WORKSPACE_ID, savedPane.id)));
    assert.equal(dialog.open, false);
    assert.ok(previews.some(value => value.kind === 'dispose'));
});

test('gallery keeps failed selections for retry while adding successful selections and reopening closed panes by ID', async () => {
    const otherProjectId = '1'.repeat(32), thirdCanvasId = '2'.repeat(32);
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Closed work', {closed: true})], activeId: PANE_ID});
    h.window.fetch = async url => ({ok: true, async json() {
        if (url === '/api/daki/projects') return {status: 'success', projects: [{id: PROJECT_ID, name: 'Alpha', canvases: {
            front: [{id: CANVAS_ID, name: 'Front', revision: 1}], back: [{id: thirdCanvasId, name: 'Back', revision: 1}],
        }}]};
        return {status: 'success', setups: []};
    }});
    await h.workspace.openPicker();
    const dialog = h.document.body.querySelector('.canvas-multi-picker-gallery');
    const front = pickerCardFor(h.document, 'Front'), back = pickerCardFor(h.document, 'Back');
    front.querySelector('input').checked = true; front.querySelector('input').onchange();
    back.querySelector('input').checked = true; back.querySelector('input').onchange();
    h.storage.failNextSetFor(h.manifestKey);
    const submit = dialog.querySelector('.canvas-multi-picker-footer').querySelector('button');
    await submit.onclick();
    assert.equal(dialog.open, true);
    assert.equal(front.querySelector('.canvas-multi-picker-card-error').hidden, false);
    assert.equal(back.querySelector('.canvas-multi-picker-card-error').hidden, true);
    assert.equal(pickerCardFor(h.document, 'Back'), undefined, 'successful additions leave the picker list');
    assert.equal(dialog.querySelector('.canvas-multi-picker-footer').querySelector('span').textContent, '1개 선택');
    assert.ok(h.storedManifest().panes.some(value => value.canvasId === thirdCanvasId));
    await submit.onclick();
    assert.equal(dialog.open, false);
    assert.ok(h.storedManifest().panes.some(value => value.canvasId === CANVAS_ID));

    const closedHarness = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Closed work', {closed: true})], activeId: PANE_ID});
    closedHarness.window.fetch = async url => ({ok: true, async json() {
        return url === '/api/daki/projects' ? {status: 'success', projects: []} : {status: 'success', setups: []};
    }});
    await closedHarness.workspace.openPicker();
    const closedDialog = closedHarness.document.body.querySelector('.canvas-multi-picker-gallery');
    const closedRow = closedDialog.querySelector('.canvas-multi-picker-quick-item');
    closedRow.querySelector('input').checked = true; closedRow.querySelector('input').onchange();
    await closedDialog.querySelector('.canvas-multi-picker-footer').querySelector('button').onclick();
    assert.equal(closedHarness.storedManifest().panes.find(value => value.id === SECOND_PANE_ID).closed, false);
    assert.equal(closedHarness.frameFor(SECOND_PANE_ID).src,
        `/canvas?workspace=${WORKSPACE_ID}&pane=${SECOND_PANE_ID}`);
});

test('closing the picker ignores late list responses and disposes its previews', async () => {
    const h = harness();
    h.window.CanvasProject = {localLink: () => ({projectId: PROJECT_ID, projectName: 'Priority project'})};
    let resolveProjects, resolveSetups, disposed = 0;
    h.window.DakiCanvasPreviews = {create() {return {observe() {}, observeState() {}, dispose() {disposed++;}};}};
    h.window.fetch = url => new Promise(resolve => {
        if (url === '/api/daki/projects') resolveProjects = resolve;
        else resolveSetups = resolve;
    });
    const opening = h.workspace.openPicker();
    const dialog = h.document.body.querySelector('.canvas-multi-picker-gallery');
    assert.match(dialog.querySelector('.canvas-multi-picker-loading').textContent, /Priority project/);
    dialog.querySelector('.canvas-multi-picker-heading').querySelector('button').onclick();
    resolveProjects({ok: true, async json() {return {status: 'success', projects: []};}});
    resolveSetups({ok: true, async json() {return {status: 'success', setups: []};}});
    await opening;
    assert.equal(dialog.open, false);
    assert.equal(dialog.querySelectorAll('.canvas-multi-picker-card').length, 0);
    assert.equal(disposed, 1);
});

test('fit matches the displayed canvas height, preserves its ratio, and keeps large cards scrollable', () => {
    const h = harness({panes: [pane(PANE_ID, 'Main'), pane(SECOND_PANE_ID, 'Reference')], activeId: PANE_ID});
    h.ready(SECOND_PANE_ID);
    const card = h.referenceFor(SECOND_PANE_ID), image = card.querySelector('img');
    const fit = card.querySelector('.canvas-multi-reference-fit');
    assert.equal(fit.disabled, true, 'fit stays disabled until preview dimensions are available');
    image.naturalWidth = 100; image.naturalHeight = 200; image.dispatch('load');
    assert.equal(fit.disabled, false);
    assert.equal(fit.onclick(), true);
    let reference = h.storedManifest().panes.find(value => value.id === SECOND_PANE_ID).reference;
    assert.equal(reference.fitHeight, 600);
    assert.equal(reference.fitRatio, 0.5);
    assert.equal(image.style.height, '600px');
    assert.equal(image.style.width, '300px');
    assert.equal(card.style.height, '650px', 'the card adds its header and borders outside the 600px image');
    assert.equal(h.storedManifest().activeId, PANE_ID, 'fitting does not replace the active editor');
    assert.deepEqual(h.snapshotCalls, [], 'fitting does not read or rewrite the canvas source state');
    assert.match(WORKSPACE_CSS, /\.canvas-multi-picture\s*\{[^}]*overflow:\s*auto/s,
        'a tall fitted image scrolls inside its picture while header and resize controls remain in the capped card');

    const resize = card.querySelector('.canvas-multi-reference-resize');
    resize.dispatch('pointerdown', {button: 0, pointerId: 9, clientX: 100, clientY: 100,
        preventDefault() {}, stopPropagation() {}});
    resize.dispatch('pointermove', {pointerId: 9, clientX: 100, clientY: 200});
    resize.dispatch('pointerup', {pointerId: 9, clientX: 100, clientY: 200, type: 'pointerup'});
    reference = h.storedManifest().panes.find(value => value.id === SECOND_PANE_ID).reference;
    assert.equal(reference.fitHeight, 700);
    assert.equal(reference.fitRatio, 0.5);
    assert.equal(image.style.height, '700px');
    assert.equal(image.style.width, '350px');
    assert.equal(card.style.height, '700px', 'the card stays within the host while its fitted image keeps the full height');
    assert.equal(h.workspace.select(SECOND_PANE_ID), true);
    let panes = h.storedManifest().panes;
    assert.equal(panes.find(value => value.id === PANE_ID).reference.fitHeight, undefined,
        'a fitted reference must not transfer its aspect ratio to the former main canvas');
    assert.equal(panes.find(value => value.id === SECOND_PANE_ID).reference.fitHeight, 700);
    assert.equal(h.workspace.select(PANE_ID), true);
    panes = h.storedManifest().panes;
    assert.equal(panes.find(value => value.id === SECOND_PANE_ID).reference.fitRatio, 0.5);
});

test('retouch settings remain source-checked and shared as sanitized independent copies', () => {
    const h = harness({panes: [pane(PANE_ID, 'Front'), pane(SECOND_PANE_ID, 'Back')], activeId: PANE_ID});
    const settings = RetouchState.createLayer('tone', () => 'tone-source');
    settings.params = {...settings.params, brightness: 23, contrast: -8, vibrance: 14};
    settings.strokes = [{brush: 'airbrush', points: [[1, 2], [3, 4]]}];
    settings.mask = {base: 0, strokes: [{tool: 'maskAdd', points: [[5, 6], [7, 8]]}],
        shape: {kind: 'polygon', points: [[1, 1], [2, 2], [3, 1]]}};

    assert.equal(h.workspace.writeRetouchSettings(PANE_ID, {}, settings), false, 'forged source is rejected');
    assert.equal(h.workspace.writeRetouchSettings(SECOND_PANE_ID, h.frameFor(SECOND_PANE_ID).contentWindow, settings), false,
        'an inactive pane cannot replace the shared copy');
    assert.equal(h.workspace.readRetouchSettings(PANE_ID, {}), null);
    assert.equal(h.workspace.writeRetouchSettings(PANE_ID, h.window, settings), true);

    const mainCopy = h.workspace.readRetouchSettings(PANE_ID, h.window);
    const referenceCopy = h.workspace.readRetouchSettings(SECOND_PANE_ID, h.frameFor(SECOND_PANE_ID).contentWindow);
    assert.deepEqual(mainCopy.params, settings.params);
    assert.equal(mainCopy.type, 'tone');
    assert.notEqual(mainCopy.id, settings.id);
    assert.deepEqual(mainCopy.strokes, []);
    assert.deepEqual(mainCopy.mask, {base: 0, strokes: []});
    assert.notStrictEqual(mainCopy, referenceCopy);

    mainCopy.params.brightness = -40;
    mainCopy.mask.strokes.push({should: 'not mutate shared copy'});
    assert.equal(h.workspace.readRetouchSettings(SECOND_PANE_ID, h.frameFor(SECOND_PANE_ID).contentWindow).params.brightness, 23);
    assert.deepEqual(h.workspace.readRetouchSettings(SECOND_PANE_ID, h.frameFor(SECOND_PANE_ID).contentWindow).mask,
        {base: 0, strokes: []});

    const unsupportedBrush = RetouchState.createLayer('paint', () => 'paint-source');
    assert.equal(RetouchState.copySettings(unsupportedBrush), null);
    assert.equal(h.workspace.writeRetouchSettings(PANE_ID, h.window, unsupportedBrush), true);
    assert.equal(h.workspace.readRetouchSettings(PANE_ID, h.window), null);
    assert.deepEqual(h.storage.setAttempts, [], 'retouch copies remain memory-only');
});
