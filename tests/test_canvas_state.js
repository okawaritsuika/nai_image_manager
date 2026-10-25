const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas.js'), 'utf8');
const start = source.indexOf('function cloneCanvasLayersForState(');
const end = source.indexOf('\nfunction collectClipInpaintMaskRefs(', start);
const clearStart = source.indexOf('function clearClipInpaintMask(');
const clearEnd = source.indexOf('\nfunction restoreCanvasState(', clearStart);

function importHarness({current = null, target = null, leave = true, connectError = false} = {}) {
    const calls = [];
    let link = current;
    const context = {
        CANVAS_PENDING_IMPORT_KEY: 'synthetic-pending',
        localStorage: {removeItem: key => calls.push(['remove', key])},
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
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'backup', 'leave', 'remove', 'close', 'import', 'connect']);
    assert.equal(h.calls.at(-1)[1], target);
    assert.equal(h.calls.at(-1)[2], payload);
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

test('same project or keeping the old project imports into the existing linked canvas', async () => {
    const target = {projectId: 'old-project', side: 'front'};
    const h = importHarness({current: target, target});
    await h.context.importPendingCanvasImage({src: '/synthetic.png'});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'remove', 'close', 'import', 'connect']);
});

test('reset retains the chosen target so the imported canvas can be reconnected', async () => {
    const target = {projectId: 'old-project', side: 'back'};
    const h = importHarness({current: target, target});
    await h.context.importPendingCanvasImage({src: '/synthetic.png'}, {reset: true});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'reset', 'remove', 'close', 'import', 'connect']);
    assert.equal(h.calls.at(-1)[1], target);
});

test('ordinary gallery import uses the existing import flow without project creation', async () => {
    const h = importHarness();
    await h.context.importPendingCanvasImage({src: '/synthetic.png'});
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'remove', 'close', 'import']);
});

test('connection failure keeps the imported image and explains how to reconnect', async () => {
    const h = importHarness({target: {projectId: 'new-project', side: 'front'}, connectError: true});
    assert.equal(await h.context.importPendingCanvasImage({src: '/synthetic.png'}), true);
    assert.deepEqual(h.calls.map(call => call[0]), ['prepare', 'remove', 'close', 'import', 'connect', 'toast']);
    assert.match(h.calls.at(-1)[1], /그림은 가져왔지만 프로젝트 연결에 실패/);
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

test('an existing autosave switches to the inline pane key without overwriting the legacy snapshot', () => {
    const {createCanvasAutosave} = require('../static/canvas_autosave.js');
    const writes = new Map();
    const context = {createCanvasAutosave, CANVAS_STATE_KEY: 'naia_canvas_state_v1',
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
