const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const compositeSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_composite.js'), 'utf8');
const queueSource = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_pending_import.js'), 'utf8');
const start = source.indexOf('function cloneCanvasLayersForState(');
const end = source.indexOf('\nfunction collectClipInpaintMaskRefs(', start);
const clearStart = source.indexOf('function clearClipInpaintMask(');
const clearEnd = source.indexOf('\nfunction restoreCanvasState(', clearStart);

function importHarness({current = null, target = null, leave = true, connectError = false} = {}) {
    const calls = [];
    let link = current;
    const context = {
        CanvasPendingImport: {same: (a, b) => a === b, isHead: () => true, withHead: (item, action) => action(),
            acknowledge: () => calls.push(['ack'])},
        consumePendingCanvasImport() {},
        loadImageInfo: async () => ({width: 320, height: 240}),
        canvasInpaintHasGenerationSettings: info => Boolean(info?.steps),
        isCurrentCanvasAlreadySaved: () => false,
        saveCurrentCanvasSetupSilently: async () => calls.push(['backup']),
        resetCanvasForPendingImport: async () => { calls.push(['reset']); link = null; return true; },
        closePendingCanvasImportModal: () => calls.push(['close']),
        importImageLayer: async payload => calls.push(['import', payload]),
        showToast: message => calls.push(['toast', message]),
        CanvasProject: {
            prepareImageImport: async value => { calls.push(['prepare', value]); return target; },
            localLink: () => link,
            leave: async () => { calls.push(['leave']); if (leave) link = null; return leave; },
            connectImportedImage: async (value, payload) => {
                calls.push(['connect', value, payload]);
                if (connectError) throw new Error('synthetic connection failure');
            }
        }
    };
    context.window = context;
    vm.createContext(context);
    const importStart = source.indexOf('let pendingCanvasImageImportBusy = false;');
    const importEnd = source.indexOf('\nfunction loadImageInfo(', importStart);
    assert(importStart >= 0 && importEnd > importStart);
    vm.runInContext(source.slice(importStart, importEnd), context);
    return {context, calls};
}

test('project import switches only after backing up and flushing the old project', async () => {
    const target = {projectId: 'new-project', side: 'back'};
    const h = importHarness({current: {projectId: 'old-project'}, target});
    const payload = {src: '/synthetic.png', projectContext: target};
    assert.equal(await h.context.importPendingCanvasImage(payload, {saveCurrent: true}), true);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'backup', 'leave', 'import', 'connect', 'ack', 'close']);
    assert.equal(h.calls[4][1], target);
    assert.equal(h.calls[4][2], payload);
});

test('canceling project confirmation preserves the image request and canvas without reset or backup', async () => {
    const h = importHarness({current: {projectId: 'old-project'}, target: false});
    assert.equal(await h.context.importPendingCanvasImage({src: '/synthetic.png'}, {reset: true, saveCurrent: true}), false);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare']);
});

test('failed old-project flush prevents importing or connecting', async () => {
    const h = importHarness({current: {projectId: 'old-project'}, target: {projectId: 'new-project'}, leave: false});
    assert.equal(await h.context.importPendingCanvasImage({src: '/synthetic.png'}), false);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'leave']);
});

test('project save conflict preserves the pending image for both append and reset until recovery', async () => {
    const target = {projectId: 'old-project', side: 'front'};
    const h = importHarness({current: target, target});
    let conflict = true;
    h.context.CanvasProject.hasSaveConflict = () => conflict;
    const payload = {src: '/synthetic.png', projectContext: target};

    assert.equal(await h.context.importPendingCanvasImage(payload), false);
    assert.equal(await h.context.importPendingCanvasImage(payload, {reset: true, saveCurrent: true}), false);
    assert.deepEqual(h.calls, []);
    conflict = false;
    assert.equal(await h.context.importPendingCanvasImage(payload, {reset: true}), true);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'reset', 'import', 'connect', 'ack', 'close']);
});

test('same project or keeping the old project imports into the existing linked canvas', async () => {
    const target = {projectId: 'old-project', side: 'front'};
    const h = importHarness({current: target, target});
    await h.context.importPendingCanvasImage({src: '/synthetic.png'});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'import', 'connect', 'ack', 'close']);
});

test('reset retains the chosen target so the imported canvas can be reconnected', async () => {
    const target = {projectId: 'old-project', side: 'back'};
    const h = importHarness({current: target, target});
    await h.context.importPendingCanvasImage({src: '/synthetic.png'}, {reset: true});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'reset', 'import', 'connect', 'ack', 'close']);
    assert.equal(h.calls[3][1], target);
});

test('ordinary gallery import uses the existing import flow without project creation', async () => {
    const h = importHarness();
    await h.context.importPendingCanvasImage({src: '/synthetic.png'});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'import', 'ack', 'close']);
});

test('append shows and saves the image before the optional prompt response arrives', async () => {
    const {context, calls} = importHarness();
    const original = {id: 1, type: 'image', src: '/original.png'};
    const twoCharacters = {charPrompts: ['blue eyes', 'green eyes']};
    let returnPrompt;
    const promptResponse = new Promise(resolve => { returnPrompt = resolve; });
    Object.assign(context, {
        currentCanvasWidth: 800,
        currentCanvasHeight: 1000,
        canvasLayers: [original],
        layerIdSeq: 2,
        normalizePromptInfo: value => value || {},
        hasAnyPromptText: value => Boolean(value?.charPrompts?.length),
        fetchPromptInfoByPath: () => promptResponse,
        findCanvasLayer: id => ({layer: context.canvasLayers.find(layer => layer.id === id)}),
        renderCanvas: () => calls.push(['render']),
        renderLayerList: () => {},
        saveCanvasState: options => calls.push(['save', options?.syncProject || false])
    });
    const geometryEnd = compositeSource.indexOf('\nfunction normalizeImageLayerGeometry(');
    vm.runInContext(compositeSource.slice(0, geometryEnd), context);
    const layerStart = source.indexOf('async function importImageLayer(');
    const layerEnd = source.indexOf('\nfunction renderCanvasLayersOnSurface(', layerStart);
    vm.runInContext(source.slice(layerStart, layerEnd), context);

    const importing = context.importPendingCanvasImage({
        src: '/new.png', path: 'new.png', width: 400, height: 500
    });
    await new Promise(resolve => setImmediate(resolve));
    const [added, existing] = context.canvasLayers;
    returnPrompt(twoCharacters);
    assert.equal(added?.src, '/new.png');
    assert.equal(existing, original);
    assert.deepEqual(calls.filter(([action]) => ['render', 'save'].includes(action)), [['render'], ['save', false]]);
    await importing;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(added.promptInfo.charPrompts, twoCharacters.charPrompts);
    assert.deepEqual(calls.at(-1), ['save', true]);

    const saveCount = calls.filter(([action]) => action === 'save').length;
    added.promptInfo = {};
    const lateRefresh = context.loadImportedImagePrompt(added);
    const manualEdit = {charPrompts: ['edited prompt']};
    added.promptInfo = manualEdit;
    await lateRefresh;
    assert.equal(added.promptInfo, manualEdit);
    assert.equal(calls.filter(([action]) => action === 'save').length, saveCount);
});

test('image import keeps original pixels only when append is configured to do so', async () => {
    const {context} = importHarness();
    Object.assign(context, {
        pendingCanvasImportPayload: {src: '/synthetic.png', width: 1600, height: 1200},
        currentCanvasWidth: 800,
        currentCanvasHeight: 1000,
        canvasLayers: [{id: 1}],
        layerIdSeq: 2,
        el: id => id === 'pendingImportOriginalSize' ? {checked: true} : null,
        loadImageInfo: async () => ({width: 1600, height: 1200}),
        normalizePromptInfo: () => null,
        renderCanvas: () => {},
        renderLayerList: () => {},
        saveCanvasState: () => {},
    });
    const confirmStart = source.indexOf('async function confirmPendingCanvasImport(');
    const confirmEnd = source.indexOf('\nasync function cancelPendingCanvasImport(', confirmStart);
    const layerStart = source.indexOf('async function importImageLayer(');
    const layerEnd = source.indexOf('\nfunction renderCanvasLayersOnSurface(', layerStart);
    const geometryEnd = compositeSource.indexOf('\nfunction normalizeImageLayerGeometry(');
    vm.runInContext(compositeSource.slice(0, geometryEnd), context);
    vm.runInContext(source.slice(layerStart, layerEnd), context);
    vm.runInContext(source.slice(confirmStart, confirmEnd), context);

    await context.confirmPendingCanvasImport('append');
    const original = context.canvasLayers[0];
    assert.deepEqual([original.layerWidth, original.layerHeight, original.x, original.y], [1600, 1200, -400, -100]);
    assert.deepEqual([context.currentCanvasWidth, context.currentCanvasHeight], [800, 1000]);
    assert.equal(context.canvasLayers[1].id, 1);

    context.el = () => null;
    context.pendingCanvasImportPayload = {src: '/synthetic.png'};
    await context.confirmPendingCanvasImport('append');
    const fitted = context.canvasLayers[0];
    assert.deepEqual([fitted.layerWidth, fitted.layerHeight, fitted.x, fitted.y], [800, 600, 0, 200]);
});

test('connection failure keeps the imported image and explains how to reconnect', async () => {
    const h = importHarness({target: {projectId: 'new-project', side: 'front'}, connectError: true});
    assert.equal(await h.context.importPendingCanvasImage({src: '/synthetic.png'}), true);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'import', 'connect', 'toast', 'ack', 'close']);
    assert.match(h.calls[3][1], /그림은 가져왔지만 프로젝트 연결에 실패/);
});

test('duplicate import is ignored until the pending import finishes', async () => {
    const h = importHarness();
    let resolve;
    h.context.CanvasProject.prepareImageImport = () => new Promise(done => { resolve = done; });
    const first = h.context.importPendingCanvasImage({src: '/synthetic.png'});
    assert.equal(await h.context.importPendingCanvasImage({src: '/duplicate.png'}), false);
    resolve(null);
    assert.equal(await first, true);
    assert.equal(h.calls.filter(call => call[0] === 'import').length, 1);
});

function queuedImportHarness(entries = new Map()) {
    const {context, calls} = importHarness();
    const storage = {getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value),
        removeItem: key => entries.delete(key)};
    Object.assign(context, {localStorage: storage, pendingCanvasImportPayload: null, hasUsableCurrentCanvas: () => true,
        showPendingCanvasImportModal(payload) { calls.push(['show', payload.src]); context.pendingCanvasImportPayload = payload; },
        closePendingCanvasImportModal() { calls.push(['close']); context.pendingCanvasImportPayload = null; },
        alert: message => calls.push(['alert', message])});
    vm.runInContext(queueSource, context);
    vm.runInContext(source.slice(source.indexOf('async function queueLocalCanvasImport('),
        source.indexOf('let pendingCanvasImageImportBusy = false;')), context);
    vm.runInContext(source.slice(source.indexOf('async function cancelPendingCanvasImport('),
        source.indexOf('function formatCanvasImportSize(')), context);
    return {context, calls, entries, storage, queue: context.CanvasPendingImport};
}

test('a legacy head, a second gallery transfer and an external upload keep one dialog and advance in order', async () => {
    const {context, calls, storage, entries, queue} = queuedImportHarness();
    const original = {src: '/a.png', importedAt: 5};
    storage.setItem('naia_canvas_pending_import', JSON.stringify(original));
    await context.consumePendingCanvasImport();
    const first = context.pendingCanvasImportPayload;
    const second = await queue.enqueue({src: '/b.png', importedAt: 5});
    await context.queueLocalCanvasImport({src: '/c.png', importedAt: 5});
    await context.consumePendingCanvasImport();
    assert.equal(context.pendingCanvasImportPayload, first);
    assert.deepEqual(calls.filter(([k]) => k === 'show'), [['show', '/a.png']]);
    assert.equal(await queue.acknowledge(second), false);
    await context.importPendingCanvasImage(first);
    assert.equal(context.pendingCanvasImportPayload.transferId, second.transferId);
    await context.cancelPendingCanvasImport();
    const third = context.pendingCanvasImportPayload;
    assert.equal(third.src, '/c.png');
    assert.equal(third.chooseImportMode, true);
    assert.equal(await queue.acknowledge(original), false);
    await context.importPendingCanvasImage(third);
    assert.deepEqual(calls.filter(([k]) => k === 'import').map(([, item]) => item.src), ['/a.png', '/c.png']);
    assert.deepEqual(calls.filter(([k]) => k === 'show'), [['show', '/a.png'], ['show', '/b.png'], ['show', '/c.png']]);
    assert.equal(entries.size, 0);
});

test('external files and import manager items stay in their own canvas tab when storage is inaccessible', async () => {
    const entries = new Map([['naia_canvas_pending_import', JSON.stringify({src: '/gallery.png', importedAt: 1})]]);
    const first = queuedImportHarness(entries), second = queuedImportHarness(entries);
    let storageCalls = 0;
    for (const [index, tab] of [first, second].entries()) {
        const {context, storage} = tab;
        for (const method of ['getItem', 'setItem', 'removeItem']) {
            storage[method] = () => {storageCalls++; throw new Error('synthetic storage access denied');};
        }
        Object.assign(context, {
            CanvasWorkspaceBridge: {isPane: index === 0},
            CANVAS_IMPORT_SESSION_ID: 'session-' + index,
            externalCanvasImageImportBusy: false,
            el: () => null,
            isSupportedExternalCanvasImage: () => true,
            FormData: class extends Map { append(name, value) { this.set(name, value); } },
            fetch: async (url, {body}) => {
                assert.equal(url, '/api/canvas/upload_image');
                assert.equal(body.get('sessionId'), 'session-' + index);
                const src = '/' + body.get('file').name;
                return {ok: true, json: async () => ({src, width: 64, height: 64, status: 'success'})};
            }
        });
        vm.runInContext(source.slice(source.indexOf('async function importExternalCanvasImageFile('),
            source.indexOf('function getFirstSupportedImageFileFromList(')), context);
    }
    await Promise.all([first.context.importExternalCanvasImageFile({name: 'first.png'}),
        second.context.importExternalCanvasImageFile({name: 'second.png'})]);
    Object.assign(first.context, {canvasImportManagerItems: [{ref: 'third', src: '/manager.png', width: 64, height: 64}],
        closeCanvasImportManagerModal() {}});
    vm.runInContext(source.slice(source.indexOf('function importCanvasImportManagerItem('),
        source.indexOf('async function deleteCanvasImportManagerItem(')), first.context);
    await first.context.importCanvasImportManagerItem('third');
    assert.equal(first.context.pendingCanvasImportPayload.src, '/first.png');
    assert.equal(second.context.pendingCanvasImportPayload.src, '/second.png');
    await second.context.importPendingCanvasImage(second.context.pendingCanvasImportPayload);
    await first.context.importPendingCanvasImage(first.context.pendingCanvasImportPayload);
    assert.equal(first.context.pendingCanvasImportPayload.src, '/manager.png');
    await first.context.cancelPendingCanvasImport();
    assert.equal(second.context.pendingCanvasImportPayload, null);
    assert.equal(first.context.pendingCanvasImportPayload, null);
    assert.deepEqual(first.calls.filter(([k]) => k === 'import').map(([, item]) => item.src), ['/first.png']);
    assert.deepEqual(second.calls.filter(([k]) => k === 'import').map(([, item]) => item.src), ['/second.png']);
    assert.equal(storageCalls, 0);
    assert.equal(JSON.parse(entries.get('naia_canvas_pending_import')).src, '/gallery.png');
});

test('a pane consumes one gallery item per forwarded request and earlier local arrivals keep their order', async () => {
    const {context, queue, entries} = queuedImportHarness();
    context.CanvasWorkspaceBridge = {isPane: true};
    const a = await queue.enqueue({src: '/a.png', importedAt: 1});
    await context.consumePendingCanvasImport();
    await context.queueLocalCanvasImport({src: '/local.png', importedAt: 2});
    const b = await queue.enqueue({src: '/b.png', importedAt: 3});
    await context.consumePendingCanvasImport();
    const c = await queue.enqueue({src: '/other-pane.png', importedAt: 4});
    await context.importPendingCanvasImage(a);
    assert.equal(context.pendingCanvasImportPayload.src, '/local.png');
    await context.importPendingCanvasImage(context.pendingCanvasImportPayload);
    assert.equal(context.pendingCanvasImportPayload.transferId, b.transferId);
    await context.cancelPendingCanvasImport();
    assert.equal(context.pendingCanvasImportPayload, null);
    assert.equal((await queue.peek()).transferId, c.transferId);
    const other = queuedImportHarness(entries);
    other.context.CanvasWorkspaceBridge = {isPane: true};
    await other.context.consumePendingCanvasImport();
    await other.context.importPendingCanvasImage(other.context.pendingCanvasImportPayload);
    assert.equal(await queue.peek(), null);
});

test('size failure precedes backup, project leave and reset, keeps the head, and known dimensions avoid decoding', async () => {
    const {context, calls, queue} = queuedImportHarness();
    context.CanvasProject.localLink = () => ({projectId: 'old'});
    context.CanvasProject.prepareImageImport = async () => ({projectId: 'new'});
    let decodes = 0;
    context.loadImageInfo = async () => {decodes++; throw new Error('synthetic size failure');};
    const head = await queue.enqueue({src: '/unknown.png'});
    await context.consumePendingCanvasImport();
    await assert.rejects(context.importPendingCanvasImage(head, {reset: true, saveCurrent: true}), /size failure/);
    assert.equal((await queue.peek()).transferId, head.transferId);
    assert.deepEqual(calls.map(([k]) => k), ['show']);
    await context.cancelPendingCanvasImport();
    const valid = await queue.enqueue({src: '/known.png', width: 320, height: 640});
    await context.importPendingCanvasImage(valid, {reset: true, saveCurrent: true});
    assert.equal(decodes, 1);
    assert.equal(await queue.peek(), null);
});

test('failure after size validation can retry and an acknowledgement failure never inserts the layer twice', async () => {
    const {context, calls, queue, storage} = queuedImportHarness();
    const head = await queue.enqueue({src: '/a.png', width: 64, height: 64});
    await context.consumePendingCanvasImport();
    context.importImageLayer = async () => {throw new Error('synthetic insertion failure');};
    await assert.rejects(context.importPendingCanvasImage(head), /insertion/);
    assert.equal((await queue.peek()).transferId, head.transferId);
    context.importImageLayer = async () => {calls.push(['real insertion']);};
    const remove = storage.removeItem;
    storage.removeItem = () => {throw new Error('synthetic storage failure');};
    await assert.rejects(context.importPendingCanvasImage(head), /storage/);
    storage.removeItem = remove;
    assert.equal(await context.importPendingCanvasImage(head), true);
    assert.equal(calls.filter(([k]) => k === 'real insertion').length, 1);
    assert.equal(await queue.peek(), null);
});

test('a v1.3.5 reader can remove the plain head and the remaining queue recovers in FIFO order', async () => {
    const {queue, storage} = queuedImportHarness();
    const a = await queue.enqueue({src: '/same.png', importedAt: 7});
    const b = await queue.enqueue({src: '/same.png', importedAt: 7});
    assert.notEqual(a.transferId, b.transferId);
    storage.removeItem('naia_canvas_pending_import');
    const c = await queue.enqueue({src: '/c.png', importedAt: 8});
    assert.equal(JSON.parse(storage.getItem('naia_canvas_pending_import')).transferId, b.transferId);
    assert.equal(await queue.acknowledge(a), false);
    await queue.acknowledge(b);
    assert.equal((await queue.peek()).transferId, c.transferId);
    await queue.acknowledge(c);
    assert.equal(queue.hasPending(), false);
});

test('failed tail trimming after promotion keeps each request until its matching acknowledgement', async () => {
    const {queue, storage} = queuedImportHarness();
    const a = await queue.enqueue({src: '/a.png'});
    const b = await queue.enqueue({src: '/b.png'});
    const c = await queue.enqueue({src: '/c.png'});
    const set = storage.setItem;
    storage.setItem = (key, value) => {
        if (key.endsWith('_queue')) throw new Error('synthetic storage failure');
        set(key, value);
    };
    await queue.acknowledge(a);
    assert.equal((await queue.peek()).transferId, b.transferId);
    storage.setItem = set;
    await queue.acknowledge(b);
    assert.equal((await queue.peek()).transferId, c.transferId);
    await queue.acknowledge(c);
    assert.equal(queue.hasPending(), false);
});

test('known generation-only metadata skips the request and asynchronously fetched generation-only values are retained', async () => {
    const {context, calls} = importHarness();
    const payload = {src: '/only-settings.png', path: 'only-settings.png', width: 64, height: 64,
        promptInfo: {steps: 12, seed: 123}};
    const layer = {id: 1, sourcePath: payload.path, promptInfo: payload.promptInfo};
    let reads = 0;
    Object.assign(context, {importImageLayer: async () => layer, hasAnyPromptText: () => false,
        findCanvasLayer: () => ({layer}), CanvasInpaintSettings: {seed: () => false},
        saveCanvasState: options => calls.push(['save-settings', options.syncProject]),
        fetchPromptInfoByPath: async () => {reads++; return {steps: 18, seed: 999};}});
    vm.runInContext(source.slice(source.indexOf('async function loadImportedImagePrompt('),
        source.indexOf('function renderCanvasLayersOnSurface(')), context);
    await context.importPendingCanvasImage(payload);
    assert.equal(reads, 0);
    assert.equal(layer.promptInfo.seed, 123);
    await context.importPendingCanvasImage({...payload, promptInfo: null});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 1);
    assert.equal(layer.promptInfo.seed, 999);
    assert.deepEqual(calls.filter(([key]) => key === 'save-settings'), [['save-settings', true]]);
});

function harness() {
    const clonedNodeCounts = [];
    const count = value => Array.isArray(value) ? value.reduce((sum, item) => sum + count(item), 0)
        : 1 + (Array.isArray(value.children) ? count(value.children) : 0);
    const context = {structuredClone(value) { clonedNodeCounts.push(count(value)); return structuredClone(value); }};
    vm.createContext(context);
    vm.runInContext(source.slice(start, end) + '\n' + source.slice(clearStart, clearEnd), context);
    return {context, clonedNodeCounts};
}

// The previous traversal is retained as a serialization compatibility oracle.
function legacyClone(layers, clearMask, clone = structuredClone) {
    return (Array.isArray(layers) ? layers : []).map(layer => {
        const copy = clone(layer);
        if (copy.type === 'clip') clearMask(copy);
        if ((copy.type === 'folder' || copy.type === 'selection') && Array.isArray(copy.children)) {
            copy.children = legacyClone(copy.children, clearMask, clone);
        }
        return copy;
    });
}

test('snapshot keeps legacy serialization and unknown fields while removing only clip masks', () => {
    const {context} = harness();
    const layers = [{id: 1, type: 'folder', unknown: {keep: [1, 2]}, children: [
        {id: 2, type: 'selection', x: -3, children: [
            {id: 3, type: 'clip', src: '/canvas-imports/synthetic.png', maskSrc: '/synthetic-mask.png',
                maskDataUrl: 'data:image/png;base64,synthetic', maskWidth: 32, maskHeight: 64,
                promptInfo: {legacyField: 'synthetic'}, customExtension: ['unchanged']},
            {id: 4, type: 'image', maskSrc: 'extension-preserved-on-non-clip', width: 1024}
        ]}
    ]}, {id: 5, type: 'canvas', width: 2048, height: 1024}];
    const unchanged = JSON.stringify(layers);
    const expected = legacyClone(layers, context.clearClipInpaintMask);
    const actual = context.cloneCanvasLayersForState(layers);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.equal(JSON.stringify(layers), unchanged);
    actual[0].unknown.keep.push(3);
    assert.equal(JSON.stringify(layers), unchanged);
});

test('a nine-node nested canvas is cloned once instead of repeatedly cloning 45 nodes', () => {
    const {context, clonedNodeCounts} = harness();
    let layer = {id: 9, type: 'image', src: '/synthetic.png'};
    for (let id = 8; id >= 1; id--) layer = {id, type: 'folder', children: [layer]};
    const countNodes = item => 1 + (item.children || []).reduce((sum, child) => sum + countNodes(child), 0);
    const oldCounts = [];
    const expected = legacyClone([layer], context.clearClipInpaintMask, value => {
        oldCounts.push(countNodes(value));
        return structuredClone(value);
    });
    assert.equal(JSON.stringify(context.cloneCanvasLayersForState([layer])), JSON.stringify(expected));
    assert.equal(oldCounts.length, 9);
    assert.equal(oldCounts.reduce((sum, count) => sum + count, 0), 45);
    assert.deepEqual(clonedNodeCounts, [9]);
});

test('empty and non-array snapshot input retains the empty legacy result', () => {
    const {context} = harness();
    for (const input of [undefined, null, {}, []]) {
        assert.equal(JSON.stringify(context.cloneCanvasLayersForState(input)), '[]');
    }
});

test('project snapshots preserve editable masks without mutating current layers', () => {
    const {context} = harness();
    const layers = [{id: 1, type: 'selection', children: [{id: 2, type: 'clip',
        maskSrc: '/canvas-imports/canvas/synthetic/mask.png', maskWidth: 64, maskHeight: 32}]}];
    const saved = context.cloneCanvasLayersForState(layers, true);
    assert.equal(JSON.stringify(saved), JSON.stringify(layers));
    saved[0].children[0].maskWidth = 128;
    assert.equal(layers[0].children[0].maskWidth, 64);
});

test('named setups keep their painted boundary while ordinary legacy clip mask fields stay excluded', () => {
    const {context} = harness();
    const draft = {enabled: true, rect: {x: 1, y: 2, width: 64, height: 64},
        maskX: 0, maskY: 0, maskDataUrl: 'data:image/png;base64,synthetic'};
    const layer = {id: 1, type: 'clip', maskSrc: '/old-mask.png', boundaryDraft: draft};
    const [saved] = context.cloneCanvasLayersForState([layer], false, true);
    assert.equal(saved.maskSrc, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.boundaryDraft)), draft);
    assert.equal(layer.maskSrc, '/old-mask.png');
});

test('an existing autosave switches to the inline pane key without overwriting the legacy snapshot', () => {
    const {createCanvasAutosave, writeCanvasAutosaveSnapshot} = require('../static/canvas_autosave.js');
    const writes = new Map();
    const context = {createCanvasAutosave, writeCanvasAutosaveSnapshot, CANVAS_STATE_KEY: 'naia_canvas_state_v1',
        activeCanvasSetupId: 'synthetic-setup', setCanvasAutosaveStatus() {},
        localStorage: {setItem(key, value) {writes.set(key, value);}},
        CanvasWorkspaceBridge: {stateKey: 'naia_canvas_state_v1', isPane: false},
        buildCanvasStateSnapshot(options) {return {layers: [{id: 1}], preserveMasks: options.preserveMasks};}};
    context.window = context;
    vm.createContext(context);
    const from = source.indexOf('let canvasAutosave = null;');
    const to = source.indexOf('\nfunction setCanvasAutosaveStatus(', from);
    vm.runInContext(source.slice(from, to), context);
    const autosave = context.getCanvasAutosave();
    assert.equal(autosave.schedule(true), true);
    const legacy = writes.get('naia_canvas_state_v1');
    context.CanvasWorkspaceBridge.stateKey = 'naia_canvas_pane_v1:' + 'a'.repeat(32) + ':' + 'b'.repeat(32);
    context.CanvasWorkspaceBridge.isPane = true;
    assert.strictEqual(context.getCanvasAutosave(), autosave);
    assert.equal(autosave.schedule(true), true);
    assert.equal(writes.get('naia_canvas_state_v1'), legacy);
    const saved = JSON.parse(writes.get(context.CanvasWorkspaceBridge.stateKey));
    assert.equal(saved.preserveMasks, true);
    assert.equal(saved.workspaceSetupId, 'synthetic-setup');
});
