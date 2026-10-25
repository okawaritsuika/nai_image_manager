const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const canvasSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const exportStart = canvasSource.indexOf('let canvasExportBusy = false;');
const exportEnd = canvasSource.indexOf('\nfunction openTagTranslationModal', exportStart);
assert.notEqual(exportStart, -1, 'canvas export busy state should exist');
assert.notEqual(exportEnd, -1, 'canvas export should end before tag translation helpers');
const exportSource = canvasSource.slice(exportStart, exportEnd);
const PROJECT_ID = 'a'.repeat(32);
const CANVAS_ID = 'b'.repeat(32);

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

function harness({link = null, destination = {destination: 'gallery'}, responseData = null} = {}) {
    const requests = [];
    const toasts = [];
    const alerts = [];
    const calls = {choose: [], prompt: 0, render: 0};
    const button = {disabled: false, isConnected: true};
    const body = {};
    const document = {body, activeElement: body,
        getElementById(id) { return id === 'canvasExportMergedBtn' ? button : null; }};
    button.focus = () => { if (!button.disabled) document.activeElement = button; };
    let currentLink = link;
    let nextDestination = destination;
    let nextResponse = responseData || {status: 'success', path: 'Synthetic/folder/image.png', index_updated: true};
    const context = {
        currentCanvasWidth: 720,
        currentCanvasHeight: 960,
        document,
        CanvasProject: {
            localLink() { return currentLink; },
            async chooseExportDestination(value) { calls.choose.push({...value}); return nextDestination; }
        },
        alert(message) { alerts.push(message); },
        async getCanvasExportPromptInfoAsync() { calls.prompt += 1; return {basePrompt: 'synthetic prompt'}; },
        isCurrentCanvasDakimakuraLike() { return false; },
        async renderMergedCanvasToDataUrl() { calls.render += 1; return 'data:image/png;base64,c3ludGhldGlj'; },
        async fetch(url, options) {
            requests.push({url, method: options.method, headers: options.headers, body: JSON.parse(options.body)});
            return {ok: true, json: async () => nextResponse};
        },
        showToast(message) { toasts.push(message); }
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(exportSource + '\nglobalThis.runExport = exportMergedCanvasToClassified;', context,
        {filename: 'canvas_export_fragment.js'});
    return {
        context, requests, toasts, alerts, calls, button,
        setLink(value) { currentLink = value; },
        setDestination(value) { nextDestination = value; },
        setResponse(value) { nextResponse = value; }
    };
}

function projectLink(side = 'front') {
    return {projectId: PROJECT_ID, canvasId: CANVAS_ID, projectName: 'Synthetic Project',
        name: 'Synthetic canvas', side, revision: 2, unsaved: false};
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test('unlinked integrated export keeps the existing gallery request and success feedback', async () => {
    const h = harness();
    await h.context.runExport();

    assert.equal(h.calls.choose.length, 0);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(plain(h.requests[0].body), {
        image: 'data:image/png;base64,c3ludGhldGlj', width: 720, height: 960,
        promptInfo: {basePrompt: 'synthetic prompt'}, isDakimakura: false, source: 'canvas'
    });
    assert.deepEqual(h.toasts, ['통합 내보내기 완료: Synthetic/folder/image.png']);
    assert.equal(h.button.disabled, false);
});

test('linked gallery export omits project fields and preserves gallery feedback', async () => {
    const h = harness({link: projectLink(), destination: {destination: 'gallery'},
        responseData: {status: 'success', path: 'Synthetic/gallery.png', index_rebuild_started: true}});
    await h.context.runExport();

    assert.equal(h.calls.choose.length, 1);
    assert.equal(h.calls.choose[0].projectId, PROJECT_ID);
    assert.deepEqual(plain(h.requests[0].body), {
        image: 'data:image/png;base64,c3ludGhldGlj', width: 720, height: 960,
        promptInfo: {basePrompt: 'synthetic prompt'}, isDakimakura: false, source: 'canvas'
    });
    assert.deepEqual(h.toasts, ['통합 내보내기 완료: 갤러리 인덱스를 갱신 중입니다.']);
});

test('linked project export sends its canvas identity and confirms the project side', async () => {
    const h = harness({link: projectLink('back'), destination: {destination: 'project',
        projectId: PROJECT_ID, canvasId: CANVAS_ID}, responseData: {status: 'success',
        destination: 'project', path: '__daki_projects/SyntheticProject/canvases/back.png',
        src: '/image/SyntheticProject/back.png', projectId: PROJECT_ID,
        projectName: 'Synthetic Project', side: 'back', sidecar_saved: true, embedded_metadata_saved: true}});
    await h.context.runExport();

    assert.deepEqual(plain(h.requests[0].body), {
        image: 'data:image/png;base64,c3ludGhldGlj', width: 720, height: 960,
        promptInfo: {basePrompt: 'synthetic prompt'}, isDakimakura: false, source: 'canvas',
        destination: 'project', projectId: PROJECT_ID, canvasId: CANVAS_ID
    });
    assert.deepEqual(h.toasts, ['Synthetic Project · 뒷면에 그림을 추가했습니다.']);
});

test('cancel has no prompt, render, or network side effects and repeated calls stay busy', async () => {
    const choice = deferred();
    const h = harness({link: projectLink()});
    let choiceCount = 0;
    h.context.CanvasProject.chooseExportDestination = () => { choiceCount += 1; return choice.promise; };
    const first = h.context.runExport();
    await Promise.resolve();
    assert.equal(h.button.disabled, false);
    assert.equal(choiceCount, 1);
    await h.context.runExport();
    choice.resolve(null);
    await first;

    assert.equal(h.calls.prompt, 0);
    assert.equal(h.calls.render, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.button.disabled, false);
});

test('cancel restores focus while the export opener stays enabled', async () => {
    const choice = deferred();
    const h = harness({link: projectLink()});
    h.context.document.activeElement = h.button;
    h.context.CanvasProject.chooseExportDestination = () => {
        assert.equal(h.button.disabled, false);
        return choice.promise.then(value => {
            if (value === null && !h.button.disabled) h.context.document.activeElement = h.button;
            return value;
        });
    };
    const pending = h.context.runExport();
    await Promise.resolve();
    assert.equal(h.button.disabled, false);
    choice.resolve(null);
    await pending;

    assert.equal(h.button.disabled, false);
    assert.equal(h.context.document.activeElement, h.button);
});

test('export completion preserves focus moved elsewhere during the request', async () => {
    const network = deferred();
    const fetchStarted = deferred();
    const h = harness({link: projectLink(), destination: {destination: 'gallery'}});
    h.context.fetch = async (url, options) => {
        h.requests.push({url, method: options.method, headers: options.headers, body: JSON.parse(options.body)});
        fetchStarted.resolve();
        return network.promise;
    };
    const pending = h.context.runExport();
    await fetchStarted.promise;
    assert.equal(h.requests.length, 1);
    assert.equal(h.button.disabled, true);
    const otherControl = {};
    h.context.document.activeElement = otherControl;
    network.resolve({ok: true, json: async () => ({status: 'success', path: 'Synthetic/gallery.png', index_updated: true})});
    await pending;

    assert.equal(h.context.document.activeElement, otherControl);
});

test('a changed project link aborts before prompt recovery, render, and request', async () => {
    const choice = deferred();
    const h = harness({link: projectLink()});
    h.context.CanvasProject.chooseExportDestination = () => choice.promise;
    const pending = h.context.runExport();
    await Promise.resolve();
    h.setLink(projectLink('back'));
    choice.resolve({destination: 'project', projectId: PROJECT_ID, canvasId: CANVAS_ID});
    await pending;

    assert.equal(h.calls.prompt, 0);
    assert.equal(h.calls.render, 0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.button.disabled, false);
});

test('a project link change during render aborts before the export request', async () => {
    const render = deferred();
    const started = deferred();
    const h = harness({link: projectLink(), destination: {destination: 'project',
        projectId: PROJECT_ID, canvasId: CANVAS_ID}});
    h.context.renderMergedCanvasToDataUrl = () => { started.resolve(); return render.promise; };
    const pending = h.context.runExport();
    await started.promise;
    h.setLink(projectLink('back'));
    render.resolve('data:image/png;base64,c3ludGhldGlj');
    await pending;

    assert.equal(h.requests.length, 0);
    assert.equal(h.alerts.length, 0);
    assert.equal(h.button.disabled, false);
});

test('failed export alerts and reenables the export button', async () => {
    const h = harness({responseData: {status: 'error', message: 'synthetic failure'}});
    await h.context.runExport();

    assert.deepEqual(h.alerts, ['통합 내보내기 실패: synthetic failure']);
    assert.equal(h.button.disabled, false);
});
