const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');
const {createProjectCanvasAutosave} = require('../static/canvas_project_autosave');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_project.js'), 'utf8');
const PROJECT_ID = 'a'.repeat(32);
const CANVAS_ID = 'b'.repeat(32);
const RECOVERED_CANVAS_ID = 'c'.repeat(32);
const OTHER_PROJECT_ID = 'd'.repeat(32);

function element(ownerDocument = null) {
    const handlers = new Map();
    const queryInputs = [];
    let html = '';
    const node = {ownerDocument, tagName: '', type: '', name: '', hidden: false, inert: false, dataset: {}, textContent: '', href: '',
        checked: false, disabled: false, value: '', open: false, isConnected: true,
        children: [], replaceChildren() { this.children = []; },
        setAttribute() {},
        addEventListener(type, callback) {
            if (!handlers.has(type)) handlers.set(type, []);
            handlers.get(type).push(callback);
        },
        dispatch(type, event = {}) {
            for (const callback of handlers.get(type) || []) callback(event);
            return event;
        },
        focus() { if (ownerDocument) ownerDocument.activeElement = this; },
        showModal() { this.open = true; },
        close() { if (!this.open) return; this.open = false; this.dispatch('close'); },
        appendChild(child) {
            this.children.push(child);
            child.isConnected = true;
            if (this.tagName === 'select' && !this.value) this.value = child.value;
            return child;
        },
        querySelectorAll(selector) {
            const match = selector.match(/^\[name=([^\]]+)\]$/);
            return match ? queryInputs.filter(input => input.name === match[1]) : [];
        },
        querySelector(selector) {
            const match = selector.match(/^\[name=([^\]]+)\]:checked$/);
            return match ? queryInputs.find(input => input.name === match[1] && input.checked) || null : null;
        },
        reset() {
            if (!ownerDocument) return;
            ownerDocument.getElementById('canvasProjectExisting').checked = true;
            ownerDocument.getElementById('canvasProjectNew').checked = false;
            const inputs = ownerDocument.templateInputs || queryInputs;
            inputs.filter(input => input.name === 'canvasProjectMode').forEach(input => {
                input.checked = input.id === 'canvasProjectExisting';
            });
            inputs.filter(input => input.name === 'canvasProjectSide').forEach(input => {
                input.checked = input.value === 'front';
            });
            ownerDocument.getElementById('canvasProjectName').value = '';
            ownerDocument.getElementById('canvasProjectCanvasName').value = '';
            const select = ownerDocument.getElementById('canvasProjectSelect');
            select.value = select.children[0]?.value || '';
        },
        click() { this.onclick?.({preventDefault() {}}); }};
    Object.defineProperty(node, 'innerHTML', {get: () => html, set(value) {
        html = value;
        queryInputs.length = 0;
        for (const match of html.matchAll(/<input\b([^>]*)>/g)) {
            const input = element(ownerDocument);
            input.tagName = 'input';
            const attributes = new Map(Array.from(match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g), item => [item[1], item[2] ?? true]));
            input.type = attributes.get('type') === true ? '' : attributes.get('type') || '';
            input.name = attributes.get('name') === true ? '' : attributes.get('name') || '';
            input.id = attributes.get('id') === true ? '' : attributes.get('id') || '';
            input.value = attributes.get('value') === true ? '' : attributes.get('value') || '';
            input.checked = attributes.has('checked');
            input.disabled = attributes.has('disabled');
            queryInputs.push(input);
            if (input.id && ownerDocument) ownerDocument.elements.set(input.id, input);
        }
        if (ownerDocument) ownerDocument.templateInputs = queryInputs;
        for (const match of html.matchAll(/<select\b([^>]*)>/g)) {
            const id = match[1].match(/\bid="([^"]+)"/)?.[1];
            if (id && ownerDocument) ownerDocument.getElementById(id).tagName = 'select';
        }
        for (const match of html.matchAll(/\bid="([^"]+)"/g)) ownerDocument?.getElementById(match[1]);
    }});
    return node;
}

function response(payload, {ok = true, status = 200} = {}) {
    return {ok, status, json: async () => payload};
}

function success(payload) {
    return response({status: 'success', ...payload});
}

function plain(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canvasState(content, savedAt, width = 720, height = 960) {
    return {content, savedAt, width, height, layers: [{id: 'synthetic-layer', visible: true}]};
}

function projectRecord({id = PROJECT_ID, name = 'Synthetic Project'} = {}) {
    return {id, name};
}

function canvasRecord({id = CANVAS_ID, name = 'Front canvas', side = 'front', revision = 4,
    state = canvasState('server state', 400)} = {}) {
    return {id, name, side, revision, state};
}

function link({projectId = PROJECT_ID, projectName = 'Synthetic Project', canvasId = CANVAS_ID,
    name = 'Front canvas', side = 'front', revision = 4, unsaved = false} = {}) {
    return {projectId, canvasId, projectName, name, side, revision, unsaved};
}

function harness({search = '', confirm = true, state = canvasState('initial state', 100),
    width = state.width, height = state.height} = {}) {
    const requests = [];
    const responses = [];
    const applied = [];
    const snapshots = [];
    const toasts = [];
    const confirms = [];
    const listeners = new Map();
    const elements = new Map();
    const header = element();
    const workspace = element();
    let document;
    elements.set('canvasProjectStatus', element());
    elements.set('canvasProjectMessage', element());
    elements.set('canvasProjectLocation', element());
    elements.set('canvasProjectRetry', element());
    elements.set('canvasProjectRecover', element());
    elements.set('canvasWorkspace', workspace);
    let currentState = state;
    let context;
    document = {
        activeElement: null,
        body: null,
        elements,
        createElement(tag) { const node = element(document); node.tagName = tag; return node; },
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, element(document));
            return elements.get(id);
        },
        querySelector(selector) { return selector === '.main-header' ? header : null; }
    };
    document.body = element(document);
    document.activeElement = element(document);
    context = {
        document,
        URLSearchParams,
        location: {search, pathname: '/canvas', hash: ''},
        history: {replaceState(_state, _title, url) {
            const parsed = new URL(url, 'http://localhost');
            context.location.search = parsed.search;
            context.location.hash = parsed.hash;
        }},
        currentCanvasWidth: width,
        currentCanvasHeight: height,
        activeCanvasSetupId: 'synthetic-setup',
        createProjectCanvasAutosave,
        buildCanvasStateSnapshot: options => {
            snapshots.push(options);
            return currentState;
        },
        applyCanvasStateSnapshot: next => {
            applied.push(next);
            currentState = next;
            context.currentCanvasWidth = next.width;
            context.currentCanvasHeight = next.height;
        },
        getCanvasAutosave: () => ({
            schedule(immediate) {
                snapshots.push({local: true, immediate});
                const projectLink = context.CanvasProject?.localLink();
                snapshots.push({localLink: plain(projectLink), width: context.currentCanvasWidth,
                    height: context.currentCanvasHeight, search: context.location.search});
            }
        }),
        fetch: async (url, options = {}) => {
            const request = {url, method: options.method || 'GET',
                body: options.body === undefined ? undefined : JSON.parse(options.body)};
            requests.push(request);
            if (!responses.length) throw new Error('Unexpected synthetic fetch: ' + request.method + ' ' + url);
            const next = responses.shift();
            return typeof next === 'function' ? next(request) : next;
        },
        confirm: message => { confirms.push(message); return confirm; },
        showToast: message => toasts.push(message),
        addEventListener: (type, callback) => listeners.set(type, callback),
        crypto: {randomUUID: () => 'cccccccc-cccc-cccc-cccc-cccccccccccc'}
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context, {filename: 'canvas_project.js'});
    return {
        context, requests, applied, snapshots, toasts, confirms, listeners, header, workspace,
        enqueue: item => responses.push(item),
        setState(next) {
            currentState = next;
            context.currentCanvasWidth = next.width;
            context.currentCanvasHeight = next.height;
        },
        currentState: () => currentState,
        status: () => elements.get('canvasProjectStatus'),
        message: () => elements.get('canvasProjectMessage'),
        recoverButton: () => elements.get('canvasProjectRecover'),
        element: id => elements.get(id),
        dialog: () => document.body.children.at(-1)
    };
}

function initializeResponse({projectId = PROJECT_ID, projectName = 'Synthetic Project',
    state = canvasState('server state', 400), revision = 4, side = 'front', name = 'Front canvas'} = {}) {
    return success({project: projectRecord({id: projectId, name: projectName}),
        canvas: canvasRecord({state, revision, side, name})});
}

function projectUrl() {
    return `?project=${PROJECT_ID}&canvas=${CANVAS_ID}`;
}

async function connectExistingCanvas(h, {projectId = OTHER_PROJECT_ID, projectName = 'Current Project',
    side = 'back'} = {}) {
    h.context.CanvasProject.restoreLocalLink(link({projectId, projectName, side}));
    h.enqueue(initializeResponse({projectId, projectName, side}));
    await h.context.CanvasProject.initialize();
}

async function conflictedCanvas({name = 'Back master', side = 'back'} = {}) {
    const original = canvasState('original project state', 100);
    const localState = canvasState('unresolved local edits', 900, 840, 1120);
    const h = harness({search: projectUrl(), state: canvasState('before open', 1)});
    h.enqueue(initializeResponse({state: original, revision: 11, side, name}));
    await h.context.CanvasProject.initialize();
    h.setState(localState);
    h.enqueue(response({status: 'error', message: 'revision changed'}, {ok: false, status: 409}));
    h.context.CanvasProject.schedule(true);
    assert.equal(await h.context.CanvasProject.flush(), false);
    assert.equal(h.status().dataset.state, 'conflict');
    return {h, localState};
}

test('suggestCanvasName uses the next number independently for each project side and stays within 120 characters', () => {
    const project = projectRecord({name: '합성Project'});
    project.canvases = {
        front: [
            {name: '합성Project_앞면_캔버스1'},
            {name: '합성Project_앞면_캔버스3'},
            {name: '합성Project_앞면_캔버스-not-a-number'},
        ],
        back: [{name: '합성Project_뒷면_캔버스1'}],
    };
    assert.equal(harness().context.CanvasProject.suggestCanvasName(project, 'front'), '합성Project_앞면_캔버스4');
    assert.equal(harness().context.CanvasProject.suggestCanvasName(project, 'back'), '합성Project_뒷면_캔버스2');

    const longSuggestion = harness().context.CanvasProject.suggestCanvasName({name: '한글'.repeat(120)}, 'front');
    assert.ok(longSuggestion.length <= 120);
    assert.ok(longSuggestion.endsWith('_앞면_캔버스1'));
});

test('opening the link dialog updates automatic names on project and side changes while preserving manual input', async () => {
    const h = harness();
    const firstProject = projectRecord({name: '합성Project'});
    firstProject.canvases = {
        front: [{name: '합성Project_앞면_캔버스1'}, {name: '합성Project_앞면_캔버스3'}],
        back: [{name: '합성Project_뒷면_캔버스1'}],
    };
    const secondProject = projectRecord({id: OTHER_PROJECT_ID, name: '다른Project'});
    secondProject.canvases = {
        front: [{name: '다른Project_앞면_캔버스1'}],
        back: [{name: '다른Project_뒷면_캔버스1'}],
    };
    h.enqueue(success({enabled: true}));
    h.enqueue(success({projects: [firstProject, secondProject]}));

    await h.context.CanvasProject.open();
    const dialog = h.dialog();
    const canvasName = h.element('canvasProjectCanvasName');
    const sideRadios = dialog.querySelectorAll('[name=canvasProjectSide]');
    const front = sideRadios.find(input => input.value === 'front');
    const back = sideRadios.find(input => input.value === 'back');
    assert.equal(canvasName.value, '합성Project_앞면_캔버스4');

    front.checked = false;
    back.checked = true;
    back.dispatch('change');
    assert.equal(canvasName.value, '합성Project_뒷면_캔버스2');

    const projectSelect = h.element('canvasProjectSelect');
    projectSelect.value = OTHER_PROJECT_ID;
    projectSelect.dispatch('change');
    assert.equal(canvasName.value, '다른Project_뒷면_캔버스2');

    canvasName.value = '사용자가 직접 입력한 캔버스명';
    canvasName.dispatch('input');
    front.checked = true;
    back.checked = false;
    front.dispatch('change');
    projectSelect.value = PROJECT_ID;
    projectSelect.dispatch('change');
    assert.equal(canvasName.value, '사용자가 직접 입력한 캔버스명');

    canvasName.value = '';
    canvasName.dispatch('input');
    back.checked = true;
    front.checked = false;
    back.dispatch('change');
    assert.equal(canvasName.value, '합성Project_뒷면_캔버스2');

    const existingMode = h.element('canvasProjectExisting');
    const newMode = h.element('canvasProjectNew');
    existingMode.checked = false;
    newMode.checked = true;
    newMode.dispatch('change');
    const projectName = h.element('canvasProjectName');
    projectName.value = '새 합성Project';
    projectName.dispatch('input');
    assert.equal(canvasName.value, '새 합성Project_뒷면_캔버스1');
});

test('URL initialization fetches and applies the project canvas, then stores a clean link', async () => {
    const serverState = canvasState('loaded from project', 501, 900, 1200);
    const h = harness({search: projectUrl(), state: canvasState('old local canvas', 100), width: 640, height: 480});
    h.enqueue(initializeResponse({state: serverState, revision: 7, side: 'back', name: 'Back study'}));

    await h.context.CanvasProject.initialize();

    assert.deepEqual(h.confirms, ['프로젝트의 캔버스를 열까요? 현재 화면의 캔버스가 바뀝니다.']);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].method, 'GET');
    assert.equal(h.requests[0].url, `/api/daki/projects/${PROJECT_ID}/canvases/${CANVAS_ID}`);
    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.applied[0], serverState);
    assert.equal(h.context.activeCanvasSetupId, null);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), {
        projectId: PROJECT_ID, canvasId: CANVAS_ID, revision: 7,
        projectName: 'Synthetic Project', name: 'Back study', side: 'back', unsaved: false
    });
    assert.deepEqual(plain(h.snapshots.at(-1)), {localLink: plain(h.context.CanvasProject.localLink()),
        width: 900, height: 1200, search: projectUrl()});
    assert.equal(h.status().dataset.state, 'saved');
    assert.equal(h.workspace.inert, false);
    assert.equal(h.header.inert, false);
});

test('failed URL initialization preserves the current canvas and shows an error toast', async () => {
    const original = canvasState('keep current state', 11, 640, 480);
    const h = harness({search: projectUrl(), state: original, confirm: true});
    h.enqueue(response({status: 'error', message: 'synthetic unavailable'}, {ok: false, status: 503}));

    await h.context.CanvasProject.initialize();

    assert.equal(h.requests.length, 1);
    assert.equal(h.applied.length, 0);
    assert.equal(h.currentState(), original);
    assert.equal(h.context.currentCanvasWidth, 640);
    assert.equal(h.context.currentCanvasHeight, 480);
    assert.match(h.toasts[0], /synthetic unavailable/);
    assert.equal(h.context.CanvasProject.localLink(), null);
});

test('declining the URL replacement prompt leaves the canvas untouched and makes no request', async () => {
    const original = canvasState('leave untouched', 12, 640, 480);
    const h = harness({search: projectUrl(), state: original, confirm: false});

    await h.context.CanvasProject.initialize();

    assert.equal(h.confirms.length, 1);
    assert.equal(h.requests.length, 0);
    assert.equal(h.applied.length, 0);
    assert.equal(h.currentState(), original);
    assert.equal(h.context.CanvasProject.localLink(), null);
});

test('a clean restored link refreshes from the server before editing resumes', async () => {
    const h = harness({search: '', state: canvasState('stale local state', 50)});
    const latest = canvasState('newer server state', 900, 800, 1100);
    h.context.CanvasProject.restoreLocalLink(link({revision: 3}));
    h.enqueue(initializeResponse({state: latest, revision: 8, side: 'front', name: 'Front canvas'}));

    await h.context.CanvasProject.initialize();

    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].method, 'GET');
    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.applied[0], latest);
    assert.equal(h.currentState(), latest);
    assert.equal(h.context.CanvasProject.localLink().revision, 8);
    assert.equal(h.context.CanvasProject.localLink().unsaved, false);
    assert.equal(h.snapshots.at(-1).localLink.revision, 8);
    assert.equal(h.snapshots.at(-1).localLink.unsaved, false);
});

test('an unsaved restored link at the same URL keeps local state and PUTs it first', async () => {
    const localState = canvasState('unsaved local edits', 123456, 700, 1000);
    const h = harness({search: projectUrl(), state: localState});
    h.context.CanvasProject.restoreLocalLink(link({revision: 5, unsaved: true}));
    h.enqueue(success({canvas: {revision: 6}}));

    await h.context.CanvasProject.initialize();
    await h.context.CanvasProject.flush();

    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].method, 'PUT');
    assert.equal(h.requests[0].url, `/api/daki/projects/${PROJECT_ID}/canvases/${CANVAS_ID}`);
    assert.deepEqual(h.requests[0].body, {state: localState, revision: 5});
    assert.equal(h.applied.length, 0);
    assert.equal(h.currentState(), localState);
    assert.equal(h.context.CanvasProject.localLink().revision, 6);
    assert.equal(h.context.CanvasProject.localLink().unsaved, false);
    assert.equal(h.snapshots.at(-1).localLink.revision, 6);
    assert.equal(h.snapshots.at(-1).localLink.unsaved, false);
});

test('failed save keeps its binding through leave, then retry and successful leave clear it', async () => {
    const h = harness({search: projectUrl(), state: canvasState('old canvas', 1)});
    h.enqueue(initializeResponse({revision: 4}));
    await h.context.CanvasProject.initialize();
    const edited = canvasState('new edit', 777);
    h.setState(edited);
    h.enqueue(response({status: 'error', message: 'temporary write failure'}, {ok: false, status: 503}));

    h.context.CanvasProject.schedule(true);
    assert.equal(h.context.CanvasProject.localLink().unsaved, true);
    assert.equal(await h.context.CanvasProject.flush(), false);
    assert.equal(await h.context.CanvasProject.leave(), false);
    assert.equal(h.context.CanvasProject.localLink().revision, 4);
    assert.equal(h.context.CanvasProject.localLink().unsaved, true);
    assert.equal(h.status().dataset.state, 'error');

    h.enqueue(success({canvas: {revision: 5}}));
    assert.equal(await h.context.CanvasProject.retry(), true);
    assert.equal(h.context.CanvasProject.localLink().revision, 5);
    assert.equal(h.context.CanvasProject.localLink().unsaved, false);
    assert.equal(h.snapshots.at(-1).localLink.unsaved, false);

    assert.equal(await h.context.CanvasProject.leave(), true);
    assert.equal(h.context.CanvasProject.localLink(), null);
    assert.equal(h.snapshots.at(-1).localLink, null);
});

test('a failed clean startup refresh can retry loading without writing stale local state', async () => {
    const h = harness();
    h.context.CanvasProject.restoreLocalLink(link());
    h.enqueue(response({status: 'error', message: 'temporary outage'}, {ok: false, status: 503}));
    await h.context.CanvasProject.initialize();
    assert.equal(h.status().dataset.state, 'error');
    assert.equal(h.applied.length, 0);
    h.enqueue(initializeResponse({revision: 12}));
    await h.context.CanvasProject.retry();
    assert.deepEqual(h.requests.map(request => request.method), ['GET', 'GET']);
    assert.equal(h.applied.length, 1);
    assert.equal(h.context.CanvasProject.localLink().revision, 12);
    assert.equal(h.status().dataset.state, 'saved');
});

test('revision conflict preserves the editable local state and never blindly retries', async () => {
    const initial = canvasState('server canvas', 200);
    const edited = canvasState('local work after load', 201);
    const h = harness({search: projectUrl(), state: canvasState('before open', 100)});
    h.enqueue(initializeResponse({state: initial, revision: 9}));
    await h.context.CanvasProject.initialize();
    h.setState(edited);
    h.enqueue(response({status: 'error', message: 'revision changed'}, {ok: false, status: 409}));

    h.context.CanvasProject.schedule(true);
    assert.equal(await h.context.CanvasProject.flush(), false);
    assert.equal(h.status().dataset.state, 'conflict');
    assert.match(h.message().textContent, /충돌했습니다/);
    assert.equal(h.context.CanvasProject.localLink().revision, 9);
    assert.equal(h.context.CanvasProject.localLink().unsaved, true);
    assert.equal(h.currentState(), edited);
    assert.equal(h.applied.length, 1);
    assert.equal(await h.context.CanvasProject.retry(), false);
    assert.equal(await h.context.CanvasProject.flush(), false);
    assert.equal(h.requests.length, 2);
    assert.equal(h.currentState(), edited);
});

test('conflict recovery creates a new same-side canvas and autosaves only to that canvas', async () => {
    const {h, localState} = await conflictedCanvas({name: 'Back master', side: 'back'});
    const newCanvas = canvasRecord({id: RECOVERED_CANVAS_ID, name: 'Back master (충돌 복구)',
        side: 'back', revision: 1, state: localState});
    h.enqueue(success({project: projectRecord(), canvas: newCanvas}));
    h.enqueue(success({canvas: {revision: 2}}));

    assert.equal(h.recoverButton().hidden, false);
    await h.context.CanvasProject.recoverConflict();
    await h.context.CanvasProject.flush();

    const oldUrl = `/api/daki/projects/${PROJECT_ID}/canvases/${CANVAS_ID}`;
    const newUrl = `/api/daki/projects/${PROJECT_ID}/canvases/${RECOVERED_CANVAS_ID}`;
    assert.deepEqual(h.requests.map(request => request.method), ['GET', 'PUT', 'POST', 'PUT']);
    assert.equal(h.requests[1].url, oldUrl);
    assert.equal(h.requests[2].url, `/api/daki/projects/${PROJECT_ID}/canvases`);
    assert.deepEqual(h.requests[2].body, {
        id: RECOVERED_CANVAS_ID, name: 'Back master (충돌 복구)', side: 'back', state: localState
    });
    assert.equal(h.requests[3].url, newUrl);
    assert.deepEqual(h.requests[3].body, {state: localState, revision: 1});
    assert.deepEqual(h.requests.filter(request => request.method === 'PUT').map(request => request.url),
        [oldUrl, newUrl]);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), {
        projectId: PROJECT_ID, canvasId: RECOVERED_CANVAS_ID, revision: 2,
        projectName: 'Synthetic Project', name: 'Back master (충돌 복구)', side: 'back', unsaved: false
    });
    assert.equal(h.currentState(), localState);
    assert.equal(h.recoverButton().hidden, true);
    assert.match(h.toasts.at(-1), /기존 캔버스도 그대로 유지됩니다/);
});

test('failed conflict copy retries the same ID and snapshot while retaining the original link', async () => {
    const {h, localState} = await conflictedCanvas({name: 'Front master', side: 'front'});
    const failedBody = response({status: 'error', message: 'copy temporarily unavailable'},
        {ok: false, status: 503});
    h.enqueue(failedBody);

    await h.context.CanvasProject.recoverConflict();

    const oldUrl = `/api/daki/projects/${PROJECT_ID}/canvases/${CANVAS_ID}`;
    const postUrl = `/api/daki/projects/${PROJECT_ID}/canvases`;
    const failedAttempt = h.requests.at(-1);
    assert.equal(failedAttempt.method, 'POST');
    assert.equal(failedAttempt.url, postUrl);
    assert.deepEqual(failedAttempt.body, {
        id: RECOVERED_CANVAS_ID, name: 'Front master (충돌 복구)', side: 'front', state: localState
    });
    assert.equal(h.context.CanvasProject.localLink().canvasId, CANVAS_ID);
    assert.equal(h.context.CanvasProject.localLink().unsaved, true);
    assert.equal(h.currentState(), localState);
    assert.equal(h.requests.filter(request => request.method === 'PUT' && request.url === oldUrl).length, 1);
    assert.equal(h.recoverButton().disabled, false);

    h.enqueue(success({project: projectRecord(), canvas: canvasRecord({id: RECOVERED_CANVAS_ID,
        name: 'Front master (충돌 복구)', side: 'front', revision: 1, state: localState})}));
    h.enqueue(success({canvas: {revision: 2}}));
    await h.context.CanvasProject.recoverConflict();
    await h.context.CanvasProject.flush();

    const attempts = h.requests.filter(request => request.method === 'POST' && request.url === postUrl);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1].body, attempts[0].body);
    assert.equal(attempts[1].body.id, RECOVERED_CANVAS_ID);
    assert.deepEqual(attempts.map(request => request.body.state), [localState, localState]);
    assert.deepEqual(h.requests.filter(request => request.method === 'PUT').map(request => request.url), [
        oldUrl, `/api/daki/projects/${PROJECT_ID}/canvases/${RECOVERED_CANVAS_ID}`
    ]);
    assert.equal(h.context.CanvasProject.localLink().canvasId, RECOVERED_CANVAS_ID);
    assert.equal(h.context.CanvasProject.localLink().unsaved, false);
    assert.equal(h.currentState(), localState);
    assert.equal(new URLSearchParams(h.context.location.search).get('canvas'), RECOVERED_CANVAS_ID);
    assert.equal(await h.context.CanvasProject.leave(), true);
    assert.equal(h.context.location.search, '');
});

test('integrated export chooser captures project and side using text content', async () => {
    const h = harness();
    const opener = h.context.document.activeElement;
    const projectName = '<img src=x onerror=alert(1)>' + 'Synthetic '.repeat(30);
    const pending = h.context.CanvasProject.chooseExportDestination({projectId: PROJECT_ID,
        canvasId: CANVAS_ID, projectName, side: 'back'});
    const dialog = h.dialog();

    assert.equal(dialog.open, true);
    assert.match(dialog.innerHTML, /통합 내보내기/);
    assert.equal(dialog.innerHTML.includes(projectName), false);
    assert.equal(h.element('canvasExportDestinationContext').textContent, `${projectName} · 뒷면`);
    h.element('canvasExportDestinationProject').click();

    assert.deepEqual(plain(await pending), {destination: 'project', projectId: PROJECT_ID, canvasId: CANVAS_ID});
    assert.equal(dialog.open, false);
    assert.equal(h.context.document.activeElement, opener);
});

test('integrated export chooser returns gallery and resolves cancel, Escape, and close as null', async () => {
    const h = harness();
    const linked = link();
    let pending = h.context.CanvasProject.chooseExportDestination(linked);
    h.element('canvasExportDestinationGallery').click();
    assert.deepEqual(plain(await pending), {destination: 'gallery'});

    pending = h.context.CanvasProject.chooseExportDestination(linked);
    h.element('canvasExportDestinationCancel').click();
    assert.equal(await pending, null);

    pending = h.context.CanvasProject.chooseExportDestination(linked);
    let prevented = false;
    h.dialog().dispatch('cancel', {preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(await pending, null);

    pending = h.context.CanvasProject.chooseExportDestination(linked);
    h.dialog().close();
    assert.equal(await pending, null);
});

test('opening integrated export chooser again resolves the previous choice as canceled', async () => {
    const h = harness();
    const first = h.context.CanvasProject.chooseExportDestination(link({side: 'front'}));
    const second = h.context.CanvasProject.chooseExportDestination(link({side: 'back'}));

    assert.equal(await first, null);
    assert.equal(h.dialog().open, true);
    assert.equal(h.element('canvasExportDestinationContext').textContent, 'Synthetic Project · 뒷면');
    h.element('canvasExportDestinationGallery').click();
    assert.deepEqual(plain(await second), {destination: 'gallery'});
});

test('image import preparation ignores invalid and general gallery contexts', async () => {
    const h = harness();
    assert.equal(await h.context.CanvasProject.prepareImageImport(null), null);
    assert.equal(await h.context.CanvasProject.prepareImageImport({projectId: 'bad', side: 'front'}), null);
    assert.equal(await h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'left'}), null);
    assert.equal(await h.context.CanvasProject.prepareImageImport({}), null);
    assert.equal(await h.context.CanvasProject.connectImportedImage(null, {name: 'Ignored'}), undefined);
    assert.deepEqual(plain(h.requests), []);
});

test('image import preparation returns the requested project when there is no link', async () => {
    const h = harness();
    assert.deepEqual(plain(await h.context.CanvasProject.prepareImageImport({
        projectId: PROJECT_ID, side: 'back'
    })), {projectId: PROJECT_ID, side: 'back'});
    assert.deepEqual(plain(h.requests), []);
});

test('same-project image import keeps the existing canvas even when the requested side differs', async () => {
    const h = harness();
    h.enqueue(initializeResponse({side: 'front', name: 'Existing front canvas'}));
    h.context.CanvasProject.restoreLocalLink(link({side: 'front', name: 'Existing front canvas'}));
    await h.context.CanvasProject.initialize();
    const before = plain(h.context.CanvasProject.localLink());
    const context = await h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'back'});
    await h.context.CanvasProject.connectImportedImage(context, {name: 'Imported layer'});

    assert.deepEqual(plain(context), {projectId: PROJECT_ID, side: 'back'});
    assert.equal(h.context.CanvasProject.localLink().canvasId, CANVAS_ID);
    assert.equal(h.context.CanvasProject.localLink().side, 'front');
    assert.equal(h.context.CanvasProject.localLink().name, 'Existing front canvas');
    assert.equal(h.requests.length, 1);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), before);
});

test('different-project import chooser safely displays both projects and returns the chosen connection', async () => {
    const h = harness();
    const currentName = '<img src=x onerror=alert(1)>Current';
    const targetName = '<svg onload=alert(2)>Target';
    await connectExistingCanvas(h, {side: 'back', projectName: currentName});
    h.enqueue(success({project: projectRecord({name: targetName})}));

    const opener = h.context.document.activeElement;
    const pending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    await new Promise(resolve => setImmediate(resolve));
    const dialog = h.dialog();
    assert.equal(dialog.open, true);
    assert.match(dialog.innerHTML, /기존 연결 유지/);
    assert.equal(dialog.innerHTML.includes(currentName), false);
    assert.equal(dialog.innerHTML.includes(targetName), false);
    assert.match(dialog.innerHTML, /새 편집 캔버스에 저장됩니다/);
    assert.equal(h.element('canvasProjectImportCurrent').textContent, `${currentName} · 뒷면`);
    assert.equal(h.element('canvasProjectImportTarget').textContent, `${targetName} · 앞면`);
    assert.equal(h.context.document.activeElement, h.element('canvasProjectImportKeep'));
    h.element('canvasProjectImportKeep').click();

    assert.deepEqual(plain(await pending), {projectId: OTHER_PROJECT_ID, side: 'back'});
    assert.equal(h.context.document.activeElement, opener);

    h.enqueue(success({project: projectRecord({name: targetName})}));
    const changePending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    await new Promise(resolve => setImmediate(resolve));
    h.element('canvasProjectImportChange').click();
    assert.deepEqual(plain(await changePending), {projectId: PROJECT_ID, side: 'front'});
});

test('different-project import chooser resolves cancel, Escape, and close as false', async () => {
    const h = harness();
    await connectExistingCanvas(h);

    h.enqueue(success({project: projectRecord()}));
    let pending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    await new Promise(resolve => setImmediate(resolve));
    h.element('canvasProjectImportCancel').click();
    assert.equal(await pending, false);

    h.enqueue(success({project: projectRecord()}));
    pending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    await new Promise(resolve => setImmediate(resolve));
    let prevented = false;
    h.dialog().dispatch('cancel', {preventDefault() { prevented = true; }});
    assert.equal(prevented, true);
    assert.equal(await pending, false);

    h.enqueue(success({project: projectRecord()}));
    pending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    await new Promise(resolve => setImmediate(resolve));
    h.dialog().close();
    assert.equal(await pending, false);
});

test('image import chooser prevents a second request while a choice is pending', async () => {
    const h = harness();
    await connectExistingCanvas(h);
    let release;
    h.enqueue(() => new Promise(resolve => { release = resolve; }));
    const pending = h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'});
    const requestsWhileLookingUp = h.requests.length;
    assert.equal(await h.context.CanvasProject.leave(), false);
    await h.context.CanvasProject.open();
    assert.equal(h.context.document.body.children.length, 0);
    assert.equal(h.requests.length, requestsWhileLookingUp);

    release(success({project: projectRecord()}));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(h.dialog().open, true);
    assert.equal(await h.context.CanvasProject.leave(), false);
    await h.context.CanvasProject.open();
    assert.equal(h.context.document.body.children.length, 1);
    assert.equal(h.requests.length, requestsWhileLookingUp);
    assert.equal(await h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'}), false);
    assert.equal(h.requests.filter(request => request.url === `/api/daki/projects/${PROJECT_ID}`).length, 1);
    h.element('canvasProjectImportKeep').click();
    assert.deepEqual(plain(await pending), {projectId: OTHER_PROJECT_ID, side: 'back'});
});

test('failed target project lookup leaves the current canvas link and edit state untouched', async () => {
    const h = harness();
    await connectExistingCanvas(h);
    const beforeLink = plain(h.context.CanvasProject.localLink());
    const beforeState = h.currentState();
    h.enqueue(response({status: 'error', message: 'project lookup failed'}, {ok: false, status: 503}));

    await assert.rejects(h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'front'}),
        /project lookup failed/);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), beforeLink);
    assert.equal(h.currentState(), beforeState);
    assert.equal(h.dialog(), undefined);
});

test('creating an imported image canvas posts the current snapshot and connects without an extra PUT', async () => {
    const h = harness();
    const context = await h.context.CanvasProject.prepareImageImport({projectId: PROJECT_ID, side: 'back'});
    const importedState = canvasState('new image layer', 901, 840, 1120);
    h.setState(importedState);
    h.enqueue(success({project: projectRecord(), canvas: canvasRecord({id: RECOVERED_CANVAS_ID,
        name: 'Imported image', side: 'back', revision: 1, state: importedState})}));

    await h.context.CanvasProject.connectImportedImage(context, {name: 'Imported image'});

    assert.deepEqual(plain(h.requests), [{url: `/api/daki/projects/${PROJECT_ID}/canvases`, method: 'POST',
        body: {id: RECOVERED_CANVAS_ID, name: 'Imported image', side: 'back', state: importedState}}]);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), {
        projectId: PROJECT_ID, canvasId: RECOVERED_CANVAS_ID, revision: 1,
        projectName: 'Synthetic Project', name: 'Imported image', side: 'back', unsaved: false
    });
    assert.equal(new URLSearchParams(h.context.location.search).get('project'), PROJECT_ID);
    assert.equal(new URLSearchParams(h.context.location.search).get('canvas'), RECOVERED_CANVAS_ID);
});

test('unnamed imported image canvas uses the next project and side name; supplied names remain capped at 120', async () => {
    const h = harness();
    const targetProject = projectRecord({name: '합성Project'});
    targetProject.canvases = {
        front: [{name: '합성Project_앞면_캔버스1'}, {name: '합성Project_앞면_캔버스3'}],
        back: [{name: '합성Project_뒷면_캔버스1'}],
    };
    h.enqueue(success({project: targetProject}));
    h.enqueue(success({project: projectRecord(), canvas: canvasRecord({id: RECOVERED_CANVAS_ID,
        name: '합성Project_앞면_캔버스4', side: 'front', revision: 1})}));
    await h.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'front'}, {});
    assert.deepEqual(h.requests.map(request => ({url: request.url, method: request.method})), [
        {url: `/api/daki/projects/${PROJECT_ID}`, method: 'GET'},
        {url: `/api/daki/projects/${PROJECT_ID}/canvases`, method: 'POST'},
    ]);
    assert.equal(h.requests[1].body.name, '합성Project_앞면_캔버스4');
    assert.equal(h.requests[1].body.side, 'front');

    const h2 = harness();
    h2.enqueue(success({project: projectRecord(), canvas: canvasRecord({id: RECOVERED_CANVAS_ID,
        name: 'x'.repeat(120), side: 'front', revision: 1})}));
    await h2.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'front'}, {
        name: 'x'.repeat(121)
    });
    assert.equal(h2.requests[0].body.name, 'x'.repeat(120));
});

test('automatic image-import name lookup fails without posting or changing the canvas', async () => {
    const h = harness();
    const before = h.currentState();
    h.enqueue(response({status: 'error', message: 'project name lookup failed'}, {ok: false, status: 503}));

    await assert.rejects(h.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'back'}, {}),
        /project name lookup failed/);
    assert.deepEqual(h.requests.map(request => ({url: request.url, method: request.method})), [
        {url: `/api/daki/projects/${PROJECT_ID}`, method: 'GET'},
    ]);
    assert.equal(h.currentState(), before);
    assert.equal(h.context.CanvasProject.localLink(), null);
});

test('automatic image-import name lookup keeps the state snapshot from the call time', async () => {
    const h = harness();
    const before = h.currentState();
    const later = canvasState('changed while project name loads', 901, 800, 1100);
    let release;
    h.enqueue(() => new Promise(resolve => { release = resolve; }));
    h.enqueue(success({project: projectRecord({name: 'Synthetic Project'}), canvas: canvasRecord({
        id: RECOVERED_CANVAS_ID, name: 'Synthetic Project_뒷면_캔버스1', side: 'back', revision: 1,
    })}));

    const pending = h.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'back'}, {});
    await new Promise(resolve => setImmediate(resolve));
    h.setState(later);
    release(success({project: projectRecord({name: 'Synthetic Project'})}));
    await pending;

    assert.deepEqual(h.requests[1].body.state, before);
    assert.equal(h.requests[1].body.name, 'Synthetic Project_뒷면_캔버스1');
});

test('suggestDownloadName adds one project prefix and uses exportCount plus one', async () => {
    const h = harness();
    await connectExistingCanvas(h, {projectId: PROJECT_ID, projectName: '합성Project', side: 'front'});
    h.enqueue(success({
        project: projectRecord({id: PROJECT_ID, name: '합성Project'}),
        canvas: {...canvasRecord({id: CANVAS_ID, name: '합성Project_앞면_캔버스1', side: 'front'}), exportCount: 2},
    }));

    assert.equal(await h.context.CanvasProject.suggestDownloadName(), '합성Project_앞면_캔버스1_결과3.png');
    assert.equal(h.requests.at(-1).url, `/api/daki/projects/${PROJECT_ID}/canvases/${CANVAS_ID}`);

    h.enqueue(success({
        project: projectRecord({id: PROJECT_ID, name: '합성Project'}),
        canvas: {...canvasRecord({id: CANVAS_ID, name: '임의 이름:내보내기?', side: 'front'}), exportCount: 0},
    }));
    assert.equal(await h.context.CanvasProject.suggestDownloadName(), '합성Project_앞면_임의 이름_내보내기__결과1.png');
});

test('suggestDownloadName keeps the generated suffix within 200 characters and defaults a missing count to one', async () => {
    const h = harness();
    await connectExistingCanvas(h, {projectId: PROJECT_ID, projectName: '합성Project', side: 'back'});
    h.enqueue(success({
        project: projectRecord({id: PROJECT_ID, name: '합성Project'}),
        canvas: canvasRecord({id: CANVAS_ID, name: '한글'.repeat(120), side: 'back'}),
    }));

    const name = await h.context.CanvasProject.suggestDownloadName();
    assert.ok(name.length <= 200);
    assert.ok(name.endsWith('_결과1.png'));
});

test('suggestDownloadName returns null without fetching when unlinked and rejects a stale link', async () => {
    const unlinked = harness();
    assert.equal(await unlinked.context.CanvasProject.suggestDownloadName(), null);
    assert.deepEqual(plain(unlinked.requests), []);

    const h = harness();
    await connectExistingCanvas(h, {projectId: PROJECT_ID, projectName: '합성Project', side: 'front'});
    let release;
    h.enqueue(() => new Promise(resolve => { release = resolve; }));
    const pendingName = h.context.CanvasProject.suggestDownloadName();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await h.context.CanvasProject.leave(), true);
    release(success({
        project: projectRecord({id: PROJECT_ID, name: '합성Project'}),
        canvas: canvasRecord({id: CANVAS_ID, name: '합성Project_앞면_캔버스1', side: 'front'}),
    }));
    await assert.rejects(pendingName, /캔버스 연결이 변경되었습니다/);
});

test('imported image canvas creation rejects a lingering old project link', async () => {
    const h = harness();
    await connectExistingCanvas(h);
    const beforeLink = plain(h.context.CanvasProject.localLink());
    const beforeState = h.currentState();

    await assert.rejects(h.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'front'}, {
        name: 'Imported image'
    }), /기존 프로젝트 연결을 먼저 종료/);
    assert.deepEqual(plain(h.context.CanvasProject.localLink()), beforeLink);
    assert.equal(h.currentState(), beforeState);
    assert.equal(h.requests.length, 1);
});

test('failed imported image canvas creation preserves the current canvas state and does not connect', async () => {
    const h = harness();
    const importedState = canvasState('edited but not linked', 902, 800, 1100);
    h.setState(importedState);
    h.enqueue(response({status: 'error', message: 'canvas create failed'}, {ok: false, status: 503}));

    await assert.rejects(h.context.CanvasProject.connectImportedImage({projectId: PROJECT_ID, side: 'back'}, {
        name: 'Imported image'
    }), /canvas create failed/);
    assert.equal(h.currentState(), importedState);
    assert.equal(h.context.CanvasProject.localLink(), null);
    assert.equal(h.context.location.search, '');
    assert.deepEqual(h.requests.map(request => request.method), ['POST']);
});
