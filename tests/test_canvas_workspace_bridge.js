const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const CanvasWorkspaceState = require('../static/canvas_workspace_state');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_workspace_bridge.js'), 'utf8');
const WORKSPACE_ID = 'a'.repeat(32);
const PANE_ID = 'b'.repeat(32);
const OTHER_PANE_ID = 'c'.repeat(32);

function classList() {
    const values = new Set();
    return {
        add(...names) { names.forEach(name => values.add(name)); },
        remove(...names) { names.forEach(name => values.delete(name)); },
        toggle(name, force) {
            const enabled = force === undefined ? !values.has(name) : Boolean(force);
            if (enabled) values.add(name);
            else values.delete(name);
            return enabled;
        },
        contains(name) { return values.has(name); },
    };
}

function harness({mode = 'pane', storageSet, storageSeed = [], projectLink = null, width = 640, height = 480,
    overlayCanvas = null} = {}) {
    const messages = [];
    const writes = [];
    const listeners = new Map();
    const toasts = [];
    const resizeEvents = [];
    const storage = new Map();
    const elements = new Map();
    const body = {classList: classList()};
    const workspace = {inert: false};
    const header = {inert: false};
    const loading = {classList: classList()};
    const retouchReadCalls = [];
    const retouchWriteCalls = [];
    const inlineStarts = [];
    const inlineReceived = [];
    const inlinePickerCalls = [];
    const previewDrawCalls = [];
    const historyCalls = [];
    let previewCanvas = null;
    const retouchValues = new Map([
        [PANE_ID, {id: 'pane-layer', type: 'image', src: 'pane-image'}],
        [OTHER_PANE_ID, {id: 'other-layer', type: 'image', src: 'other-image'}],
    ]);
    elements.set('canvasWorkspace', workspace);
    elements.set('referenceGenLoading', loading);
    elements.set('canvasAutosaveStatus', {dataset: {state: 'pending'}});
    elements.set('canvasProjectBar', {dataset: {state: 'saving'}});
    for (const [key, value] of storageSeed) storage.set(key, JSON.stringify(value));

    const parent = {
        postMessage(message, origin) { messages.push({message, origin}); },
        CanvasWorkspace: {
            openPicker() { inlinePickerCalls.push('parent'); },
            receive(message, sourceWindow) { inlineReceived.push({message, sourceWindow}); },
            readRetouchSettings(paneId, sourceWindow) {
                retouchReadCalls.push({paneId, sourceWindow});
                const value = retouchValues.get(paneId);
                return value ? structuredClone(value) : null;
            },
            writeRetouchSettings(paneId, sourceWindow, value) {
                retouchWriteCalls.push({paneId, sourceWindow, value});
                retouchValues.set(paneId, structuredClone(value));
                return true;
            },
        },
    };
    let uuid = 0;
    const context = {
        CanvasWorkspaceState,
        location: {
            search: mode === 'single' ? '' : mode === 'host'
                ? '?workspace=' + WORKSPACE_ID
                : '?workspace=' + WORKSPACE_ID + '&pane=' + PANE_ID,
            origin: 'http://localhost',
            assigned: [],
            assign(url) { this.assigned.push(url); },
        },
        history: {replaceState(_state, _title, url) { historyCalls.push(url); }},
        document: {
            body,
            getElementById(id) { return elements.get(id) || null; },
            querySelector(selector) {
                if (selector === '.main-header') return header;
                if (selector === '.canvas-retouch-surface-overlay canvas') return overlayCanvas;
                return null;
            },
            createElement(tag) {
                if (tag !== 'canvas') return {};
                previewCanvas = {
                    width: 0,
                    height: 0,
                    getContext(kind) {
                        if (kind !== '2d') return null;
                        return {drawImage(...args) { previewDrawCalls.push(args); }};
                    },
                    toDataURL(type) { return `data:${type};base64,overlay-preview`; },
                };
                return previewCanvas;
            },
        },
        parent,
        addEventListener(type, callback) { listeners.set(type, callback); },
        dispatchEvent(event) { resizeEvents.push(event.type); },
        Event: class Event { constructor(type) { this.type = type; } },
        crypto: {randomUUID() {
            uuid += 1;
            return (uuid === 1 ? 'd' : 'e').repeat(8) + '-' + 'f'.repeat(4) + '-4' + 'a'.repeat(3)
                + '-b' + 'c'.repeat(3) + '-' + String(uuid).padStart(12, '0');
        }},
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) {
                writes.push([key, value]);
                if (storageSet) storageSet(key, value, writes.length);
                storage.set(key, String(value));
            },
        },
        CanvasProject: {
            localLink: () => projectLink,
            flush: async () => true,
        },
        CanvasRetouch: {
            opens: 0,
            closes: 0,
            refreshes: 0,
            busy: false,
            open() {
                this.toolsWereHiddenAtOpen = !body.classList.contains('canvas-pane-tools');
                this.opens += 1;
            },
            close() { this.closes += 1; },
            refreshControls() { this.refreshes += 1; },
            isBusy() { return this.busy; },
            isOpen() { return this.opens > this.closes; },
        },
        getCanvasAutosave() { return {schedule: () => true}; },
        buildCanvasStateSnapshot(options) { context.snapshotOptions = options; return {layers: [{id: 1}]}; },
        renderMergedCanvasToDataUrl(options) {
            context.previewOptions = options;
            if (context.previewError) throw new Error(context.previewError);
            return Promise.resolve(context.previewResult || 'data:image/png;base64,merged-preview');
        },
        showToast(message) { toasts.push(message); },
        loadSavedCanvasSetups() { return [{id: 'saved-synthetic', name: '저장한 캔버스'}]; },
        openCanvasDialog() { context.newCalls = (context.newCalls || 0) + 1; },
        saveCurrentCanvasSetup() { context.saveCalls = (context.saveCalls || 0) + 1; },
    };
    context.window = context;
    context.previewResult = 'data:image/png;base64,merged-preview';
    context.previewError = '';
    context.CanvasWorkspace = {
        starts: inlineStarts,
        async start(options) {
            inlineStarts.push(options);
            const bridge = context.CanvasWorkspaceBridge;
            if (!bridge.attach(options.workspaceId, options.paneId)) throw new Error('synthetic attach failure');
            bridge.ready();
            await bridge.execute('active', {active: true});
            return true;
        },
        openPicker() { inlinePickerCalls.push('inline'); },
        receive(message, sourceWindow) { inlineReceived.push({message, sourceWindow}); },
        readRetouchSettings(paneId, sourceWindow) {
            retouchReadCalls.push({paneId, sourceWindow});
            const value = retouchValues.get(paneId);
            return value ? structuredClone(value) : null;
        },
        writeRetouchSettings(paneId, sourceWindow, value) {
            retouchWriteCalls.push({paneId, sourceWindow, value});
            retouchValues.set(paneId, structuredClone(value));
            return true;
        },
    };
    vm.createContext(context);
    vm.runInContext(`
        let currentCanvasWidth = ${width};
        let currentCanvasHeight = ${height};
        let activeCanvasSetupId = 'saved-synthetic';
        let savedCanvasSetupsSavePromise = Promise.resolve(true);
        let clipInpaintLoadingClipId = null;
        let externalCanvasImageImportBusy = false;
    `, context);
    vm.runInContext(source, context, {filename: 'canvas_workspace_bridge.js'});

    return {
        context, messages, writes, listeners, toasts, resizeEvents, storage, body, workspace, header, loading,
        retouchReadCalls, retouchWriteCalls, retouchValues, inlineStarts, inlineReceived,
        inlinePickerCalls, previewDrawCalls, historyCalls, get previewCanvas() { return previewCanvas; },
        dispatch(data, {origin = context.location.origin, source = parent} = {}) {
            listeners.get('message')?.({data, origin, source});
        },
        async settle() { await new Promise(resolve => setImmediate(resolve)); },
    };
}

function command(paneId, action, extra = {}) {
    return {channel: 'naim-canvas-workspace', type: 'command', paneId, action, ...extra};
}

function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

test('selects pane-only storage and rejects messages from other origins, windows, and panes', async () => {
    const h = harness();
    assert.equal(h.context.CanvasWorkspaceBridge.isPane, true);
    assert.equal(h.context.CanvasWorkspaceBridge.stateKey,
        CanvasWorkspaceState.stateKey(WORKSPACE_ID, PANE_ID));
    assert.equal(h.body.classList.contains('canvas-workspace-pane'), true);
    assert.equal(h.body.classList.contains('canvas-pane-inactive'), true);

    h.context.CanvasWorkspaceBridge.ready();
    assert.equal(h.messages[0].message.type, 'ready');
    assert.equal(h.messages[0].message.paneId, PANE_ID);
    assert.equal(h.messages[0].origin, h.context.location.origin);

    h.dispatch(command(PANE_ID, 'retouch'), {origin: 'https://other.example'});
    h.dispatch(command(PANE_ID, 'retouch'), {source: {}});
    h.dispatch(command(OTHER_PANE_ID, 'retouch'));
    await h.settle();
    assert.equal(h.context.CanvasRetouch.opens, 0);
    assert.deepEqual(h.writes, []);
});

test('commands wait for readiness, inactive panes reject tools, and activation preserves retouch state', async () => {
    const h = harness();
    h.dispatch(command(PANE_ID, 'retouch', {requestId: 'before-ready'}));
    await h.settle();
    assert.deepEqual(plain(h.messages.at(-1).message), {
        channel: 'naim-canvas-workspace', type: 'response', paneId: PANE_ID,
        ok: false, error: '캔버스 초기화가 끝나지 않았습니다.', requestId: 'before-ready',
    });
    h.dispatch(command(PANE_ID, 'restoreRetouch', {requestId: 'restore-before-ready'}));
    await h.settle();
    assert.equal(h.messages.at(-1).message.ok, false);
    assert.equal(h.context.CanvasRetouch.opens, 0);

    h.context.CanvasWorkspaceBridge.ready();
    h.body.classList.add('canvas-pane-tools');
    h.dispatch(command(PANE_ID, 'retouch', {requestId: 'inactive'}));
    await h.settle();
    assert.equal(h.messages.at(-1).message.ok, false);
    assert.equal(h.context.CanvasRetouch.opens, 0);

    h.dispatch(command(PANE_ID, 'restoreRetouch'));
    await h.settle();
    assert.equal(h.context.CanvasRetouch.opens, 1);
    assert.equal(h.context.CanvasRetouch.toolsWereHiddenAtOpen, true);
    assert.equal(h.body.classList.contains('canvas-pane-tools'), false);

    h.dispatch(command(PANE_ID, 'active', {active: true}));
    await h.settle();
    assert.equal(h.workspace.inert, false);
    assert.equal(h.body.classList.contains('canvas-pane-inactive'), false);
    assert.equal(h.context.CanvasRetouch.refreshes, 1);
    h.body.classList.add('canvas-pane-tools');
    h.dispatch(command(PANE_ID, 'retouch'));
    await h.settle();
    assert.equal(h.context.CanvasRetouch.opens, 2);
    assert.equal(h.context.CanvasRetouch.toolsWereHiddenAtOpen, true);
    assert.equal(h.body.classList.contains('canvas-pane-tools'), false);
    h.dispatch(command(PANE_ID, 'active', {active: false}));
    await h.settle();
    assert.equal(h.workspace.inert, true);
    assert.equal(h.header.inert, true);
    assert.equal(h.body.classList.contains('canvas-pane-inactive'), true);
    assert.equal(h.context.CanvasRetouch.opens, 2);
    assert.equal(h.context.CanvasRetouch.closes, 0);
    assert.equal(h.context.CanvasRetouch.refreshes, 1);
    assert.deepEqual(h.resizeEvents, ['resize']);

    h.dispatch(command(PANE_ID, 'active', {active: true}));
    await h.settle();
    assert.equal(h.header.inert, false);
    assert.equal(h.context.CanvasRetouch.refreshes, 2);
    assert.deepEqual(h.resizeEvents, ['resize', 'resize']);
    h.dispatch(command(PANE_ID, 'tools'));
    await h.settle();
    assert.equal(h.context.CanvasRetouch.closes, 1);
    assert.equal(h.body.classList.contains('canvas-pane-tools'), true);
});

test('retouch settings wrappers scope calls to this pane and stay disabled outside panes', () => {
    const h = harness();
    const bridge = h.context.CanvasWorkspaceBridge;
    assert.deepEqual(plain(bridge.readRetouchSettings()), {
        id: 'pane-layer', type: 'image', src: 'pane-image',
    });
    assert.equal(h.retouchReadCalls.length, 1);
    assert.equal(h.retouchReadCalls[0].paneId, PANE_ID);
    assert.equal(h.retouchReadCalls[0].sourceWindow.CanvasWorkspaceBridge.isPane, true);

    const nextSettings = {id: 'updated-layer', type: 'image', src: 'updated-image'};
    assert.equal(bridge.writeRetouchSettings(nextSettings), true);
    assert.equal(h.retouchWriteCalls.length, 1);
    assert.equal(h.retouchWriteCalls[0].paneId, PANE_ID);
    assert.equal(h.retouchWriteCalls[0].sourceWindow.CanvasWorkspaceBridge.isPane, true);
    assert.deepEqual(plain(h.retouchValues.get(PANE_ID)), nextSettings);
    assert.deepEqual(plain(h.retouchValues.get(OTHER_PANE_ID)), {
        id: 'other-layer', type: 'image', src: 'other-image',
    });

    const single = harness({mode: 'single'});
    assert.equal(single.context.CanvasWorkspaceBridge.readRetouchSettings(), null);
    assert.equal(single.context.CanvasWorkspaceBridge.writeRetouchSettings(nextSettings), false);
    assert.equal(single.retouchReadCalls.length, 0);
    assert.equal(single.retouchWriteCalls.length, 0);

    const inline = harness({mode: 'single'});
    const inlineBridge = inline.context.CanvasWorkspaceBridge;
    assert.equal(inlineBridge.isPane, false);
    assert.equal(inlineBridge.stateKey, CanvasWorkspaceState.LEGACY_STATE_KEY);
    assert.equal(inlineBridge.ready(), true);
    assert.equal(inlineBridge.report(), null);
    assert.equal(inline.inlineReceived.length, 0);
    assert.equal(inlineBridge.attach(WORKSPACE_ID, PANE_ID), true);
    assert.equal(inlineBridge.ready(), true);
    assert.equal(inline.inlineReceived.at(-1).message.type, 'ready');
    assert.equal(inlineBridge.isPane, true);
    assert.equal(inlineBridge.stateKey, CanvasWorkspaceState.stateKey(WORKSPACE_ID, PANE_ID));
    assert.deepEqual(plain(inlineBridge.readRetouchSettings()), {
        id: 'pane-layer', type: 'image', src: 'pane-image',
    });
    assert.equal(inline.retouchReadCalls.at(-1).paneId, PANE_ID);
    assert.equal(inline.retouchReadCalls.at(-1).sourceWindow.CanvasWorkspaceBridge.isPane, true);
    assert.equal(inlineBridge.writeRetouchSettings(nextSettings), true);
    assert.equal(inline.retouchWriteCalls.at(-1).paneId, PANE_ID);
    assert.equal(inline.retouchWriteCalls.at(-1).sourceWindow.CanvasWorkspaceBridge.isPane, true);
    assert.equal(inlineBridge.attach(WORKSPACE_ID, OTHER_PANE_ID), false);
    assert.equal(inlineBridge.attach('bad', PANE_ID), false);
});

test('flush reports active work and project save failures instead of claiming success', async () => {
    const h = harness();
    h.context.CanvasWorkspaceBridge.ready();
    vm.runInContext('clipInpaintLoadingClipId = 7', h.context);
    assert.deepEqual(plain(await h.context.CanvasWorkspaceBridge.flush()), {
        ok: false, error: '클립 보정 작업이 끝난 뒤 닫아 주세요.',
    });
    vm.runInContext('clipInpaintLoadingClipId = null', h.context);
    h.loading.classList.add('show');
    assert.deepEqual(plain(await h.context.CanvasWorkspaceBridge.flush()), {
        ok: false, error: '생성·보정 작업이 끝난 뒤 닫아 주세요.',
    });
    h.loading.classList.remove('show');

    h.context.CanvasProject.flush = async () => { throw new Error('synthetic project failure'); };
    assert.deepEqual(plain(await h.context.CanvasWorkspaceBridge.flush()), {
        ok: false, error: 'synthetic project failure',
    });

    h.context.CanvasProject.flush = async () => false;
    assert.deepEqual(plain(await h.context.CanvasWorkspaceBridge.flush()), {
        ok: false, error: '프로젝트 캔버스 저장을 완료하지 못했습니다.',
    });

    h.context.CanvasProject.flush = async () => true;
    h.context.getCanvasAutosave = () => ({schedule: () => false});
    assert.deepEqual(plain(await h.context.CanvasWorkspaceBridge.flush()), {
        ok: false, error: '캔버스 자동 저장을 완료하지 못했습니다.',
    });
});

test('captures scoped setup metadata before autosave can remove the hint', () => {
    const paneKey = CanvasWorkspaceState.stateKey(WORKSPACE_ID, PANE_ID);
    const h = harness({storageSeed: [[paneKey, {workspaceSetupId: 'saved-synthetic'}]]});
    h.storage.set(paneKey, JSON.stringify({layers: []}));
    vm.runInContext('activeCanvasSetupId = null', h.context);

    h.context.CanvasWorkspaceBridge.ready();
    assert.equal(vm.runInContext('activeCanvasSetupId', h.context), 'saved-synthetic');
    assert.equal(h.messages.at(-1).message.name, '저장한 캔버스');

    vm.runInContext('activeCanvasSetupId = "missing-setup"', h.context);
    assert.equal(h.context.CanvasWorkspaceBridge.report().name, '');
});

test('does not borrow a saved setup identity from the legacy key when scoped state is empty', () => {
    const paneKey = CanvasWorkspaceState.stateKey(WORKSPACE_ID, PANE_ID);
    const h = harness({storageSeed: [
        [paneKey, {layers: []}],
        [CanvasWorkspaceState.LEGACY_STATE_KEY, {workspaceSetupId: 'saved-synthetic'}],
    ]});
    vm.runInContext('activeCanvasSetupId = null', h.context);

    h.context.CanvasWorkspaceBridge.ready();
    assert.equal(vm.runInContext('activeCanvasSetupId', h.context), null);
    assert.equal(h.messages.at(-1).message.name, '');
});

test('launch stores the pane and manifest, then attaches the editor without navigating', async () => {
    const projectLink = {
        projectId: '1'.repeat(32), canvasId: '2'.repeat(32),
        projectName: '프로젝트 이름', name: '앞면', side: 'front',
    };
    const h = harness({mode: 'single', projectLink});
    const result = await h.context.CanvasWorkspaceBridge.launch();

    assert.equal(result.ok, true, JSON.stringify(plain(result)));
    assert.deepEqual(plain(h.context.snapshotOptions), {preserveMasks: true});
    assert.equal(h.writes.length, 2);
    assert.equal(h.writes.some(([key]) => key === CanvasWorkspaceState.LEGACY_STATE_KEY), false);
    const [paneWrite, manifestWrite] = h.writes;
    const workspaceId = result.workspaceId;
    const paneId = result.paneId;
    assert.match(workspaceId, /^[a-f0-9]{32}$/);
    assert.match(paneId, /^[a-f0-9]{32}$/);
    assert.equal(paneWrite[0], CanvasWorkspaceState.stateKey(workspaceId, paneId));
    assert.equal(manifestWrite[0], CanvasWorkspaceState.manifestKey(workspaceId));

    const snapshot = JSON.parse(paneWrite[1]);
    assert.deepEqual(plain(snapshot.projectLink), projectLink);
    assert.equal(snapshot.workspaceSetupId, 'saved-synthetic');
    const manifest = JSON.parse(manifestWrite[1]);
    assert.deepEqual(plain(manifest), {
        version: 1,
        panes: [{id: paneId, name: '앞면', closed: false,
            projectId: projectLink.projectId, canvasId: projectLink.canvasId, retouch: false}],
        activeId: paneId,
        layout: 'row',
    });
    assert.deepEqual(plain(h.inlineStarts), [{workspaceId, paneId}]);
    assert.deepEqual(h.context.location.assigned, []);
    assert.deepEqual(h.historyCalls, ['/canvas?workspace=' + workspaceId]);
    assert.equal(h.context.CanvasWorkspaceBridge.isPane, true);
    assert.equal(h.context.CanvasWorkspaceBridge.stateKey, paneWrite[0]);
    assert.equal(h.inlineReceived.at(-1).message.type, 'ready');
    assert.equal(h.inlineReceived.at(-1).sourceWindow.CanvasWorkspaceBridge.isPane, true);
});

test('launch storage failure keeps the current page open and shows the failure', async () => {
    const h = harness({mode: 'single', storageSet(key, _value, index) {
        if (index === 2) throw new Error('synthetic storage failure');
    }});
    const result = await h.context.CanvasWorkspaceBridge.launch();
    assert.equal(result.ok, false);
    assert.match(result.error, /synthetic storage failure/);
    assert.deepEqual(h.context.location.assigned, []);
    assert.deepEqual(h.historyCalls, []);
    assert.deepEqual(h.inlineStarts, []);
    assert.match(h.toasts[0], /synthetic storage failure/);
});

test('launch deduplicates concurrent starts and later opens the inline picker', async () => {
    const h = harness({mode: 'single'});
    const bridge = h.context.CanvasWorkspaceBridge;
    const first = bridge.launch();
    const second = bridge.launch();
    assert.equal(first, second);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(plain(firstResult), plain(secondResult));
    assert.equal(h.inlineStarts.length, 1);
    assert.equal(h.writes.length, 2);

    const repeat = await bridge.launch();
    assert.deepEqual(plain(repeat), {ok: true});
    assert.deepEqual(h.inlinePickerCalls, ['inline']);
    assert.equal(h.inlineStarts.length, 1);
    assert.equal(h.writes.length, 2);
    assert.equal(h.historyCalls.length, 1);
});

test('launch from a pane opens the host picker without creating another workspace', async () => {
    const h = harness();
    const result = await h.context.CanvasWorkspaceBridge.launch();
    assert.deepEqual(plain(result), {ok: true});
    assert.deepEqual(h.inlinePickerCalls, ['parent']);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.context.location.assigned, []);
});

test('preview captures a scaled merged canvas while inactive and returns it in command responses', async () => {
    const h = harness({mode: 'pane'});
    const bridge = h.context.CanvasWorkspaceBridge;
    bridge.ready();

    const result = await bridge.execute('preview');
    assert.deepEqual(plain(result), {ok: true, preview: 'data:image/png;base64,merged-preview'});
    assert.deepEqual(plain(h.context.snapshotOptions), {preserveMasks: true});
    assert.deepEqual(plain(h.context.previewOptions), {
        state: {layers: [{id: 1}]}, maxDimension: 1600,
    });

    h.dispatch(command(PANE_ID, 'preview', {requestId: 'preview-request'}));
    await h.settle();
    assert.deepEqual(plain(h.messages.at(-1).message), {
        channel: 'naim-canvas-workspace', type: 'response', paneId: PANE_ID, ok: true,
        preview: 'data:image/png;base64,merged-preview', requestId: 'preview-request',
    });
});

test('preview copies the visible retouch overlay at the opposite-reference limit of 1600', async () => {
    const overlay = {width: 2048, height: 1024};
    const h = harness({mode: 'pane', overlayCanvas: overlay});
    h.context.CanvasWorkspaceBridge.ready();
    const result = await h.context.CanvasWorkspaceBridge.execute('preview');

    assert.deepEqual(plain(result), {ok: true, preview: 'data:image/png;base64,overlay-preview'});
    assert.equal(h.previewCanvas.width, 1600);
    assert.equal(h.previewCanvas.height, 800);
    assert.equal(h.previewDrawCalls.length, 1);
    assert.deepEqual(h.previewDrawCalls[0], [overlay, 0, 0, 1600, 800]);
    assert.equal(h.context.previewOptions, undefined);
});

test('preview returns an empty image for blank canvases and reports render failures', async () => {
    const blank = harness({mode: 'pane', width: 0, height: 0});
    blank.context.CanvasWorkspaceBridge.ready();
    assert.deepEqual(plain(await blank.context.CanvasWorkspaceBridge.execute('preview')),
        {ok: true, preview: ''});
    assert.equal(blank.context.previewOptions, undefined);

    const failed = harness({mode: 'pane'});
    failed.context.CanvasWorkspaceBridge.ready();
    failed.context.previewError = 'synthetic preview failure';
    assert.deepEqual(plain(await failed.context.CanvasWorkspaceBridge.execute('preview')),
        {ok: false, error: 'synthetic preview failure'});
});
