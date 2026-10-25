const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createProjectCanvasAutosave} = require('../static/canvas_project_autosave');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
}

function harness({send, onSaved, snapshot} = {}) {
    const timers = new Map();
    const calls = [];
    const states = [];
    const saved = [];
    let value = {content: 0};
    let timerId = 0;
    let snapshots = 0;
    let save;
    save = createProjectCanvasAutosave({
        snapshot: snapshot || (() => { snapshots++; return {...value}; }),
        send: send || (async (binding, state, revision) => {
            calls.push({binding, state, revision});
            return {revision: revision + 1};
        }),
        status: (state, error) => states.push({state, error}),
        onSaved: binding => {
            saved.push(binding);
            if (onSaved) onSaved(binding, save);
        },
        setTimer: (callback, delay) => {
            const id = ++timerId;
            timers.set(id, {callback, delay});
            return id;
        },
        clearTimer: id => timers.delete(id)
    });
    return {
        save, timers, calls, states, saved,
        snapshots: () => snapshots,
        setValue: next => { value = next; },
        runTimer: async id => {
            const task = timers.get(id);
            timers.delete(id);
            task.callback();
            return save.flush();
        }
    };
}

function binding(projectId = 'project-a', canvasId = 'front', revision = 1) {
    return {projectId, canvasId, revision, canvasName: 'Front'};
}

test('coalesces many edits into one snapshot and sends the latest full state', async () => {
    const h = harness();
    const sourceBinding = binding();
    h.save.connect(sourceBinding);
    sourceBinding.canvasName = 'mutated outside';

    for (let i = 1; i <= 100; i++) {
        h.setValue({content: i, extra: {preserved: true}});
        assert.equal(h.save.schedule(), true);
    }

    assert.equal(h.snapshots(), 0);
    assert.equal(h.timers.size, 1);
    assert.equal([...h.timers.values()][0].delay, 600);
    assert.equal(h.save.isUnsaved(), true);
    const timerId = [...h.timers.keys()][0];
    await h.runTimer(timerId);

    assert.equal(h.snapshots(), 1);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], {
        binding: binding(),
        state: {content: 100, extra: {preserved: true}},
        revision: 1
    });
    assert.equal(h.save.current().revision, 2);
    assert.equal(h.saved.length, 1);
    assert.equal(h.save.isUnsaved(), false);
    assert.equal(h.states.at(-1).state, 'saved');
});

test('edits during a request produce one trailing save with the newest state and committed revision', async () => {
    const firstRequest = deferred();
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        if (h.calls.length === 1) return firstRequest.promise;
        return {revision: revision + 1};
    }});
    h.save.connect(binding());
    h.setValue({content: 'first'});
    const firstFlush = h.save.schedule(true);

    h.setValue({content: 'middle'});
    h.save.schedule();
    h.setValue({content: 'latest'});
    h.save.schedule();
    assert.equal(h.timers.size, 0);
    assert.strictEqual(h.save.flush(), firstFlush);

    firstRequest.resolve({revision: 2});
    assert.equal(await firstFlush, true);
    assert.deepEqual(h.calls.map(call => [call.state, call.revision]), [
        [{content: 'first'}, 1],
        [{content: 'latest'}, 2]
    ]);
    assert.equal(h.save.current().revision, 3);
    assert.equal(h.save.isUnsaved(), false);
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0].revision, 3);
});

test('failed saves replay the exact request before saving the latest queued edits', async () => {
    const firstRequest = deferred();
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        if (h.calls.length === 1) return firstRequest.promise;
        return {revision: revision + 1};
    }});
    h.save.connect(binding());
    const originalState = {content: 'before failure', savedAt: 101};
    h.setValue(originalState);
    const firstFlush = h.save.schedule(true);
    h.setValue({content: 'edited during request', savedAt: 202});
    h.save.schedule();
    firstRequest.reject(Object.assign(new Error('temporary failure'), {status: 503}));
    assert.equal(await firstFlush, false);
    assert.equal(h.save.current().revision, 1);
    assert.equal(h.save.isUnsaved(), true);
    assert.equal(h.states.at(-1).state, 'error');
    assert.equal(h.saved.length, 0);

    const latestState = {content: 'latest after failure', savedAt: 303};
    h.setValue(latestState);
    assert.equal(h.save.schedule(), false);
    assert.equal(h.timers.size, 0);
    assert.equal(await h.save.retry(), true);
    assert.deepEqual(h.calls.map(call => [call.state, call.revision]), [
        [originalState, 1],
        [originalState, 1],
        [latestState, 2]
    ]);
    assert.equal(h.save.current().revision, 3);
    assert.equal(h.save.isUnsaved(), false);
    assert.equal(h.saved.length, 1);
});

test('a lost response retries the identical payload and revision without another snapshot', async () => {
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        if (h.calls.length === 1) {
            throw Object.assign(new Error('response lost after server commit'), {status: 503});
        }
        assert.deepEqual({state, revision}, {
            state: h.calls[0].state,
            revision: h.calls[0].revision
        });
        return {revision: revision + 1};
    }});
    h.save.connect(binding());
    h.setValue({content: 'committed once', savedAt: 123456});
    assert.equal(await h.save.schedule(true), false);
    assert.equal(h.snapshots(), 1);

    assert.equal(await h.save.retry(), true);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[1], h.calls[0]);
    assert.equal(h.snapshots(), 1);
    assert.equal(h.save.current().revision, 2);
    assert.equal(h.save.isUnsaved(), false);
});

test('a revision conflict stays latched and cannot be blindly retried', async () => {
    const h = harness({send: async (...args) => {
        h.calls.push(args);
        throw Object.assign(new Error('revision conflict'), {status: 409});
    }});
    h.save.connect(binding());
    h.save.schedule();
    assert.equal(await h.save.flush(), false);
    h.setValue({content: 'preserve local edit'});
    assert.equal(h.save.schedule(), false);
    assert.equal(await h.save.retry(), false);
    assert.equal(await h.save.flush(), false);
    assert.equal(h.calls.length, 1);
    assert.equal(h.save.current().revision, 1);
    assert.equal(h.save.isUnsaved(), true);
    assert.equal(h.states.at(-1).state, 'conflict');
    assert.equal(h.saved.length, 0);
});

test('disconnect waits for in-flight and trailing saves, then allows a fresh binding', async () => {
    const firstRequest = deferred();
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        if (h.calls.length === 1) return firstRequest.promise;
        return {revision: revision + 1};
    }});
    h.save.connect(binding());
    h.setValue({content: 'sent first'});
    const firstFlush = h.save.schedule(true);
    h.setValue({content: 'sent last'});
    h.save.schedule();
    const disconnect = h.save.disconnect();

    assert.deepEqual(h.save.current(), binding());
    firstRequest.resolve({revision: 2});
    assert.equal(await firstFlush, true);
    assert.equal(await disconnect, true);
    assert.equal(h.save.current(), null);
    assert.equal(h.save.isUnsaved(), false);
    assert.deepEqual(h.calls.map(call => [call.state, call.revision]), [
        [{content: 'sent first'}, 1],
        [{content: 'sent last'}, 2]
    ]);

    h.save.connect(binding('project-b', 'back', 8));
    assert.deepEqual(h.save.current(), binding('project-b', 'back', 8));
    h.setValue({content: 'new binding'});
    assert.equal(await h.save.schedule(true), true);
    assert.equal(h.calls.at(-1).binding.projectId, 'project-b');
    assert.equal(h.calls.at(-1).revision, 8);
    assert.equal(h.saved.at(-1).projectId, 'project-b');
});

test('disconnect failure leaves the connection and unsaved content intact', async () => {
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        if (h.calls.length === 1) throw new Error('offline');
        return {revision: revision + 1};
    }});
    h.save.connect(binding());
    h.setValue({content: 'keep me'});
    assert.equal(await h.save.schedule(true), false);

    assert.equal(await h.save.disconnect(), false);
    assert.deepEqual(h.save.current(), binding());
    assert.equal(h.save.isUnsaved(), true);
    assert.equal(await h.save.retry(), true);
    assert.equal(await h.save.disconnect(), true);
    assert.equal(h.save.current(), null);
});

test('invalid response revisions are failures and do not commit metadata', async () => {
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        return {revision: Number.MAX_SAFE_INTEGER + 1};
    }});
    h.save.connect(binding());
    h.save.schedule();
    assert.equal(await h.save.flush(), false);
    assert.equal(h.save.current().revision, 1);
    assert.equal(h.saved.length, 0);
    assert.equal(h.save.isUnsaved(), true);
    assert.equal(h.states.at(-1).state, 'error');
});

test('invalid response revisions are replayed with the same payload and revision', async () => {
    const h = harness({send: async (target, state, revision) => {
        h.calls.push({binding: target, state, revision});
        return h.calls.length === 1
            ? {revision: Number.MAX_SAFE_INTEGER + 1}
            : {revision: revision + 1};
    }});
    h.save.connect(binding());
    const uncertainState = {content: 'possibly committed', savedAt: 456};
    h.setValue(uncertainState);
    assert.equal(await h.save.schedule(true), false);

    const latestState = {content: 'newer edit', savedAt: 789};
    h.setValue(latestState);
    assert.equal(h.save.schedule(), false);
    assert.equal(await h.save.retry(), true);

    assert.deepEqual(h.calls.map(call => [call.state, call.revision]), [
        [uncertainState, 1],
        [uncertainState, 1],
        [latestState, 2]
    ]);
    assert.equal(h.save.current().revision, 3);
    assert.equal(h.saved.length, 1);
});

test('snapshot exceptions retry by capturing a fresh state', async () => {
    let snapshotCount = 0;
    const h = harness({snapshot: () => {
        snapshotCount++;
        if (snapshotCount === 1) throw new Error('snapshot unavailable');
        return {content: 'fresh capture', savedAt: snapshotCount};
    }});
    h.save.connect(binding());
    h.save.schedule();
    assert.equal(await h.save.flush(), false);
    assert.equal(h.calls.length, 0);
    assert.equal(h.save.isUnsaved(), true);

    assert.equal(await h.save.retry(), true);
    assert.equal(snapshotCount, 2);
    assert.deepEqual(h.calls.map(call => [call.state, call.revision]), [
        [{content: 'fresh capture', savedAt: 2}, 1]
    ]);
    assert.equal(h.save.current().revision, 2);
});

test('onSaved runs after the successful drain and observes settled unsaved state', async () => {
    const observed = [];
    const h = harness({onSaved: (savedBinding, save) => {
        observed.push({binding: savedBinding, unsaved: save.isUnsaved()});
    }});
    h.save.connect(binding());
    h.setValue({content: 'committed'});

    assert.equal(await h.save.schedule(true), true);
    assert.deepEqual(observed, [{binding: binding('project-a', 'front', 2), unsaved: false}]);
    assert.equal(h.states.at(-1).state, 'saved');
});

test('connect requires a positive safe starting revision', () => {
    const h = harness();
    assert.throws(() => h.save.connect(binding('project-a', 'front', 0)), TypeError);
    assert.throws(() => h.save.connect(binding('project-a', 'front', Number.MAX_SAFE_INTEGER + 1)), TypeError);
});

test('unlinked canvases do not snapshot or send project writes', async () => {
    const h = harness();
    assert.equal(h.save.current(), null);
    assert.equal(h.save.schedule(), true);
    assert.equal(await h.save.schedule(true), true);
    assert.equal(await h.save.flush(), true);
    assert.equal(await h.save.disconnect(), true);
    assert.equal(h.snapshots(), 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.save.isUnsaved(), false);
});
