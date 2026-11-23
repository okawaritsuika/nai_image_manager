const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvasAutosave, writeCanvasAutosaveSnapshot, readCanvasPlacementBackup} = require('../static/canvas_autosave');
const referenceCodec = require('../static/canvas_inpaint_reference');
function harness() {
    const tasks = new Map(), writes = [], states = [];
    let value = {layers: [], legacy: {keep: true}}, snapshots = 0, fail = false, id = 0;
    const save = createCanvasAutosave({snapshot: () => { snapshots++; return value; },
        write: text => { if (fail) throw new Error('quota'); writes.push(text); },
        status: state => states.push(state), setTimer: fn => { tasks.set(++id, fn); return id; },
        clearTimer: id => tasks.delete(id)});
    return {save, tasks, writes, states, snapshots: () => snapshots,
        value: v => { value = v; }, fail: v => { fail = v; }};
}
test('100 changes serialize once, keep the latest state and retain unknown legacy fields', () => {
    const h = harness();
    for (let i = 0; i < 100; i++) { h.value({layers: [i], legacy: {keep: true}}); h.save.schedule(); }
    assert.equal(h.snapshots(), 0); assert.equal(h.tasks.size, 1);
    assert.deepEqual(h.states, ['pending']);
    [...h.tasks.values()][0]();
    assert.equal(h.snapshots(), 1);
    assert.deepEqual(JSON.parse(h.writes[0]), {layers: [99], legacy: {keep: true}});
    assert.equal(h.states.at(-1), 'saved');
});
test('failed writes retain the previous saved value, report failure and retry the latest state', () => {
    const h = harness(); h.save.schedule(true); const original = h.writes[0];
    h.fail(true); h.value({layers: [2]}); assert.equal(h.save.schedule(true), false);
    assert.equal(h.states.at(-1), 'error'); assert.deepEqual(h.writes, [original]);
    h.fail(false); h.value({layers: [3]}); assert.equal(h.save.schedule(true), true);
    assert.deepEqual(JSON.parse(h.writes.at(-1)), {layers: [3]});
});
test('leaving flushes pending edits and explicit reset cancels old scheduled writes', () => {
    const h = harness(); h.save.schedule(); assert.equal(h.save.flush(), true);
    assert.equal(h.tasks.size, 0); assert.equal(h.writes.length, 1);
    h.save.schedule(); h.save.reset(); assert.equal(h.tasks.size, 0);
    h.save.flush(); assert.equal(h.writes.length, 1);
});
test('snapshot serialization errors are also visible and recoverable', () => {
    const h = harness(); const cyclic = {}; cyclic.self = cyclic; h.value(cyclic);
    assert.equal(h.save.schedule(true), false); assert.equal(h.states.at(-1), 'error');
    h.value({layers: []}); assert.equal(h.save.schedule(true), true);
});

test('the browser backup reports the failure type without repeating an unchanged error', () => {
    const statuses = [];
    let error = Object.assign(new Error('synthetic quota failure'), {name: 'QuotaExceededError'});
    const save = createCanvasAutosave({
        snapshot: () => ({layers: []}),
        write: () => { if (error) throw error; },
        status: (status, reason) => statuses.push([status, reason])
    });
    assert.equal(save.schedule(true), false);
    assert.equal(save.schedule(true), false);
    error = Object.assign(new Error('synthetic storage restriction'), {name: 'SecurityError'});
    assert.equal(save.schedule(true), false);
    error = null;
    assert.equal(save.schedule(true), true);
    assert.deepEqual(statuses, [
        ['pending', undefined],
        ['error', 'QuotaExceededError'],
        ['error', 'SecurityError'],
        ['saved', undefined]
    ]);
});

test('quota fallback keeps a project restore record only after confirmed server save', () => {
    const key = 'synthetic-canvas';
    const records = new Map([['other-canvas', 'keep'], [key, 'earlier backup']]);
    const quota = Object.assign(new Error('synthetic quota failure'), {name: 'QuotaExceededError'});
    const storage = {setItem(name, value) {
        if (value.length > 400) throw quota;
        records.set(name, value);
    }};
    const projectLink = {projectId: 'synthetic-project', canvasId: 'synthetic-canvas', revision: 7, unsaved: false};
    const state = {savedAt: 12, width: 720, height: 960, layers: ['x'.repeat(401)], projectLink, workspaceSetupId: 'setup'};
    assert.throws(() => writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(state), state, false), error => error === quota);
    assert.equal(records.get(key), 'earlier backup');
    const pending = {...state, projectLink: {...projectLink, unsaved: true}};
    assert.throws(() => writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(pending), pending, true), error => error === quota);
    assert.equal(records.get(key), 'earlier backup');

    const states = [];
    const save = createCanvasAutosave({
        snapshot: () => state,
        write: (text, snapshot) => writeCanvasAutosaveSnapshot(storage, key, text, snapshot, true),
        status: value => states.push(value)
    });
    assert.equal(save.schedule(true), true);
    assert.equal(states.at(-1), 'project');
    assert.deepEqual(JSON.parse(records.get(key)), {
        projectRestoreOnly: true, savedAt: 12, width: 720, height: 960, projectLink, workspaceSetupId: 'setup'
    });
    assert.equal(records.get('other-canvas'), 'keep');
});

test('older saves can rewrite the whole slot without losing its reference placement or borrowing another canvas placement', () => {
    const records = new Map(), backupWrites = [];
    const key = 'slot-a';
    const storage = {
        getItem: name => records.get(name) ?? null,
        setItem(name, value) {
            records.set(name, value);
            if (name.endsWith(':inpaint-placement')) backupWrites.push(name);
        },
        removeItem: name => records.delete(name)
    };
    const basic = {src: '/canvas-imports/synthetic.png', x: 0.25, y: 0.75, zoom: 3};
    const ref = {...basic, scale: 2, panX: 0};
    const state = {workspaceSetupId: 'first', width: 720, height: 960, layers: [],
        inpaintReference: {reference: ref, include: true}};
    for (let i = 0; i < 100; i++) writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(state), state, false, referenceCodec);
    assert.equal(backupWrites.length, 1);
    const old = {...state, inpaintReference: {reference: basic, include: true}};
    storage.setItem(key, JSON.stringify(old));
    assert.deepEqual(referenceCodec.restorePlacement(old.inpaintReference, [], readCanvasPlacementBackup(storage, key, old)).reference, ref);
    assert.equal(readCanvasPlacementBackup(storage, key, {...old, workspaceSetupId: 'other'}), null);
    assert.equal(readCanvasPlacementBackup(storage, 'slot-b', old), null);
    writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(old), old, false, referenceCodec);
    assert.equal(readCanvasPlacementBackup(storage, key, old).scale, undefined);
    const removed = {...old, inpaintReference: {reference: null, include: false}};
    writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(removed), removed, false, referenceCodec);
    assert.equal(readCanvasPlacementBackup(storage, key, old), null);

    const anonymous = {...state, workspaceSetupId: null, layers: [{id: 1, type: 'canvas'}]};
    writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(anonymous), anonymous, false, referenceCodec);
    const unrelated = {width: state.width, height: state.height, layers: [{id: 1, type: 'canvas'}]};
    assert.equal(readCanvasPlacementBackup(storage, key, unrelated), null);
    const blank = {...anonymous, layers: []};
    writeCanvasAutosaveSnapshot(storage, key, JSON.stringify(blank), blank, false, referenceCodec);
    assert.equal(readCanvasPlacementBackup(storage, key, {...unrelated, layers: []}).scale, 2);
    assert.equal(readCanvasPlacementBackup(storage, key, {...unrelated, layers: [], width: 512}), null);
});
