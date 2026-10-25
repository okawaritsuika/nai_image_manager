const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_setups.js'), 'utf8');

function harness() {
    const requests = [];
    const context = {
        cachedSavedCanvasSetups: [], savedCanvasSetupsSavePromise: Promise.resolve(),
        countLayersInSavedState: () => 1,
        console: {warn() {}},
        fetch: async (url, options) => {
            let finish;
            const response = new Promise(resolve => { finish = resolve; });
            requests.push({url, body: JSON.parse(options.body), finish});
            return response;
        },
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return {context, requests};
}

const setup = (id, savedAt) => ({id, name: id, savedAt, state: {layers: [], legacyUnknown: {keep: true}}});
const ready = () => new Promise(resolve => setImmediate(resolve));
const response = setups => ({ok: true, json: async () => ({status: 'success', setups})});

test('queued saves send their own snapshots and older responses cannot remove a newer setup', async () => {
    const {context, requests} = harness();
    const a = setup('synthetic-a', 1);
    const b = setup('synthetic-b', 2);
    const first = context.persistSavedCanvasSetups([a]);
    await ready();
    const second = context.persistSavedCanvasSetups([a, b]);
    requests[0].finish(response(requests[0].body.setups));
    assert.equal(await first, true);
    await ready();
    assert.deepEqual(requests[1].body.setups.map(item => item.id), ['synthetic-b', 'synthetic-a']);
    assert.deepEqual(Array.from(context.cachedSavedCanvasSetups, item => item.id), ['synthetic-b', 'synthetic-a']);
    requests[1].finish(response(requests[1].body.setups));
    assert.equal(await second, true);
    assert.deepEqual(Array.from(context.cachedSavedCanvasSetups, item => item.id), ['synthetic-b', 'synthetic-a']);
});

test('queued request preserves nested legacy fields as they were when saving', async () => {
    const {context, requests} = harness();
    const a = setup('synthetic-a', 1);
    const first = context.persistSavedCanvasSetups([a]);
    await ready();
    const second = context.persistSavedCanvasSetups([a]);
    a.state.legacyUnknown.keep = false;
    requests[0].finish(response(requests[0].body.setups));
    await first;
    await ready();
    assert.deepEqual(requests[1].body.setups[0].state.legacyUnknown, {keep: true});
    requests[1].finish(response(requests[1].body.setups));
    await second;
});

test('failed older save does not discard newer queued changes or stop their request', async () => {
    const {context, requests} = harness();
    const a = setup('synthetic-a', 1);
    const b = setup('synthetic-b', 2);
    const first = context.persistSavedCanvasSetups([a]);
    await ready();
    const second = context.persistSavedCanvasSetups([a, b]);
    requests[0].finish({ok: false, json: async () => ({status: 'error', message: 'synthetic failure'})});
    assert.equal(await first, false);
    await ready();
    assert.deepEqual(requests[1].body.setups.map(item => item.id), ['synthetic-b', 'synthetic-a']);
    requests[1].finish(response(requests[1].body.setups));
    assert.equal(await second, true);
});

test('queued patch requests freeze their own changes and cache the latest full server list', async () => {
    const {context, requests} = harness();
    const a = setup('synthetic-patch-a', 1);
    const first = context.persistSavedCanvasSetups([a], {upserts: [a], removeIds: []});
    a.state.legacyUnknown.keep = false;
    await ready();

    assert.equal(requests[0].url, '/api/canvas/setups/patch');
    assert.deepEqual(Object.keys(requests[0].body).sort(), ['removeIds', 'upserts']);
    assert.equal(requests[0].body.upserts[0].state.legacyUnknown.keep, true);

    const b = setup('synthetic-patch-b', 2);
    const second = context.persistSavedCanvasSetups([a, b], {upserts: [b], removeIds: ['synthetic-old']});
    b.name = 'mutated after queueing';
    b.state.legacyUnknown.keep = false;

    const serverOnly = setup('synthetic-server-only', 3);
    requests[0].finish(response([a, serverOnly]));
    assert.equal(await first, true);
    await ready();

    assert.deepEqual(Object.keys(requests[1].body).sort(), ['removeIds', 'upserts']);
    assert.deepEqual(requests[1].body.removeIds, ['synthetic-old']);
    assert.equal(requests[1].body.upserts[0].name, 'synthetic-patch-b');
    assert.equal(requests[1].body.upserts[0].state.legacyUnknown.keep, true);

    requests[1].finish(response([b, serverOnly, a]));
    assert.equal(await second, true);
    assert.deepEqual(Array.from(context.cachedSavedCanvasSetups, item => item.id), [
        'synthetic-server-only', 'synthetic-patch-b', 'synthetic-patch-a'
    ]);
});

test('old server 404 never falls back to replacing the whole saved list', async () => {
    const {context, requests} = harness();
    const a = setup('synthetic-patch', 1);
    const result = context.persistSavedCanvasSetups([a], {upserts: [a], removeIds: []});
    await ready();
    assert.equal(requests[0].url, '/api/canvas/setups/patch');
    requests[0].finish({ok: false, status: 404, json: async () => { throw new Error('legacy HTML response'); }});
    assert.equal(await result, false);
    assert.equal(requests.length, 1);
});
