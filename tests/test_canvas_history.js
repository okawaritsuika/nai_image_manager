const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createCanvasHistory} = require('../static/canvas_history');

test('reset establishes the baseline without an undo step', () => {
    const history = createCanvasHistory();
    assert.equal(history.record({layers: [0]}), false);
    assert.deepEqual(history.states(), [{layers: [0]}]);
    assert.equal(history.canUndo, false);
    assert.equal(history.undo(), null);

    history.reset({layers: [1]});
    assert.deepEqual(history.states(), [{layers: [1]}]);
    assert.equal(history.canUndo, false);
});

test('three records undo in reverse order and return detached copies', () => {
    const history = createCanvasHistory();
    history.reset({layers: [0]});
    assert.equal(history.record({layers: [1]}), true);
    assert.equal(history.record({layers: [2]}), true);
    assert.equal(history.record({layers: [3]}), true);
    const states = history.states();
    states[0].layers[0] = 99;
    assert.deepEqual(history.undo(), {layers: [2]});
    assert.deepEqual(history.undo(), {layers: [1]});
    assert.deepEqual(history.undo(), {layers: [0]});
    assert.equal(history.undo(), null);
    assert.equal(history.canUndo, false);
});

test('recording after undo branches from the restored state', () => {
    const history = createCanvasHistory();
    history.reset({value: 0});
    history.record({value: 1});
    history.record({value: 2});
    assert.deepEqual(history.undo(), {value: 1});
    assert.equal(history.record({value: 9}), true);
    assert.deepEqual(history.undo(), {value: 1});
    assert.deepEqual(history.undo(), {value: 0});
    assert.equal(history.undo(), null);
});

test('an equal key updates the current snapshot without adding an undo step', () => {
    const history = createCanvasHistory();
    history.reset({layers: [1], activeLayer: 0}, 'document-1');
    assert.equal(history.record({layers: [1], activeLayer: 2}, 'document-1'), false);
    assert.deepEqual(history.states(), [{layers: [1], activeLayer: 2}]);
    assert.equal(history.canUndo, false);

    history.record({layers: [1, 2], activeLayer: 2}, 'document-2');
    assert.deepEqual(history.undo(), {layers: [1], activeLayer: 2});
});

test('snapshots are isolated from caller mutations and returned mutations', () => {
    const history = createCanvasHistory();
    const baseline = {layers: [{points: [1, 2]}]};
    history.reset(baseline);
    baseline.layers[0].points.push(3);
    history.record({layers: [{points: [4]}]});

    const undone = history.undo();
    undone.layers[0].points.push(5);
    assert.deepEqual(history.states(), [{layers: [{points: [1, 2] }]}]);
});

test('limit eviction discards the oldest snapshots first', () => {
    const history = createCanvasHistory({limit: 2});
    history.reset({value: 0});
    history.record({value: 1});
    history.record({value: 2});
    history.record({value: 3});
    assert.deepEqual(history.states(), [{value: 1}, {value: 2}, {value: 3}]);
    assert.deepEqual(history.undo(), {value: 2});
    assert.deepEqual(history.undo(), {value: 1});
    assert.equal(history.undo(), null);
});

test('byte eviction keeps the newest undo state and current state', () => {
    const first = {text: 'one'};
    const second = {text: 'two'};
    const smallBytes = JSON.stringify(first).length * 2;
    const history = createCanvasHistory({maxBytes: smallBytes * 2});
    history.reset({text: 'x'.repeat(100)});
    history.record(first);
    history.record(second);
    assert.deepEqual(history.states(), [first, second]);
    assert.deepEqual(history.undo(), first);
});

test('byte accounting includes large custom string keys without duplicating snapshot text', () => {
    const baseline = {value: 0};
    const next = {value: 1};
    const baselineText = JSON.stringify(baseline);
    const nextText = JSON.stringify(next);
    const smallLimit = (baselineText.length + nextText.length) * 2;
    const sameTextKey = createCanvasHistory({maxBytes: smallLimit});
    sameTextKey.reset(baseline, baselineText);
    sameTextKey.record(next, nextText);
    assert.equal(sameTextKey.canUndo, true);

    const history = createCanvasHistory({maxBytes: smallLimit});
    history.reset(baseline, 'baseline');
    history.record(next, 'signature'.repeat(20));
    assert.equal(history.canUndo, false);
    assert.deepEqual(history.states(), [next]);
});

test('an oversized current snapshot is kept while undo history is discarded', () => {
    const history = createCanvasHistory({maxBytes: 20});
    history.reset({value: 0});
    history.record({value: 'x'.repeat(100)});
    assert.deepEqual(history.states(), [{value: 'x'.repeat(100)}]);
    assert.equal(history.canUndo, false);
    assert.equal(history.undo(), null);
});

test('reset replaces history and clear returns to the uninitialized state', () => {
    const history = createCanvasHistory();
    history.reset({value: 0});
    history.record({value: 1});
    history.reset({value: 5});
    assert.deepEqual(history.states(), [{value: 5}]);
    assert.equal(history.canUndo, false);

    history.clear();
    assert.deepEqual(history.states(), []);
    assert.equal(history.canUndo, false);
    assert.equal(history.undo(), null);
    assert.equal(history.record({value: 6}), false);
    assert.deepEqual(history.states(), [{value: 6}]);
});

test('replaceCurrent refreshes the restored snapshot and keeps older undo states', () => {
    const history = createCanvasHistory();
    history.reset({value: 0}, 'zero');
    history.record({value: 1}, 'one');
    history.record({value: 2}, 'two');

    assert.deepEqual(history.undo(), {value: 1});
    history.replaceCurrent({value: 1, normalized: true}, 'one-normalized');

    assert.deepEqual(history.states(), [
        {value: 0},
        {value: 1, normalized: true}
    ]);
    assert.equal(history.canUndo, true);
    assert.deepEqual(history.undo(), {value: 0});
});

test('replaceCurrent updates byte accounting and trims oversized replacements', () => {
    const history = createCanvasHistory({maxBytes: 52});
    history.reset({value: 'a'});
    history.record({value: 'b'});
    assert.equal(history.canUndo, true);

    history.replaceCurrent({value: 'c'});
    assert.equal(history.canUndo, true);
    assert.deepEqual(history.undo(), {value: 'a'});

    const oversized = createCanvasHistory({maxBytes: 52});
    oversized.reset({value: 'a'});
    oversized.record({value: 'b'});
    const replacement = {value: 'x'.repeat(10)};
    oversized.replaceCurrent(replacement);

    assert.equal(oversized.canUndo, false);
    assert.deepEqual(oversized.states(), [replacement]);
});

test('import refs are collected once per entry, deduplicated, and returned as detached arrays', () => {
    let calls = 0;
    const history = createCanvasHistory({
        collectRefs(state) {
            calls++;
            return state.refs;
        }
    });
    const baseline = {refs: ['images/a.png', 'images/a.png']};
    history.reset(baseline, 'baseline');
    baseline.refs.push('images/caller-mutation.png');
    history.record({refs: ['images/b.png']}, 'next');
    history.record({refs: ['images/c.png', 'images/c.png']}, 'next');

    assert.equal(calls, 3);
    const refs = history.importRefs();
    assert.deepEqual(refs.sort(), ['images/a.png', 'images/c.png']);
    refs.push('images/returned-mutation.png');
    assert.deepEqual(history.importRefs().sort(), ['images/a.png', 'images/c.png']);
    assert.equal(calls, 3);
});

test('import refs follow reset, replaceCurrent, undo, and branch transitions', () => {
    const history = createCanvasHistory({collectRefs: state => state.refs});
    history.reset({refs: ['images/a.png']});
    history.record({refs: ['images/b.png']});
    assert.deepEqual(history.importRefs().sort(), ['images/a.png', 'images/b.png']);

    history.replaceCurrent({refs: ['images/normalized.png']});
    assert.deepEqual(history.importRefs().sort(), ['images/a.png', 'images/normalized.png']);
    assert.deepEqual(history.undo(), {refs: ['images/a.png']});
    assert.deepEqual(history.importRefs(), ['images/a.png']);

    history.record({refs: ['images/branch.png']});
    assert.deepEqual(history.importRefs().sort(), ['images/a.png', 'images/branch.png']);
    history.reset({refs: ['images/new-canvas.png']});
    assert.deepEqual(history.importRefs(), ['images/new-canvas.png']);
    history.clear();
    assert.deepEqual(history.importRefs(), []);
});

test('import refs follow limit and byte eviction', () => {
    const limited = createCanvasHistory({limit: 1, collectRefs: state => state.refs});
    limited.reset({refs: ['images/a.png']});
    limited.record({refs: ['images/b.png']});
    limited.record({refs: ['images/c.png']});
    assert.deepEqual(limited.importRefs().sort(), ['images/b.png', 'images/c.png']);

    const makeState = (value, ref) => ({value, refs: [ref]});
    const baseline = makeState(0, 'a'.repeat(40));
    const next = makeState(1, 'b'.repeat(40));
    const latest = makeState(2, 'c'.repeat(40));
    const entryBytes = state => JSON.stringify(state).length * 2 + state.refs[0].length * 2;
    const byBytes = createCanvasHistory({
        maxBytes: entryBytes(next) + entryBytes(latest),
        collectRefs: state => state.refs
    });
    byBytes.reset(baseline);
    byBytes.record(next);
    byBytes.record(latest);
    assert.deepEqual(byBytes.importRefs().sort(), [next.refs[0], latest.refs[0]].sort());
});

test('collectRefs errors propagate while creating an entry', () => {
    const history = createCanvasHistory({collectRefs() { throw new Error('synthetic ref failure'); }});
    assert.throws(() => history.reset({value: 1}), /synthetic ref failure/);
});

test('the browser global exposes the CommonJS API', () => {
    assert.equal(globalThis.CanvasHistory.createCanvasHistory, createCanvasHistory);
});
