const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvasAutosave} = require('../static/canvas_autosave');
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
