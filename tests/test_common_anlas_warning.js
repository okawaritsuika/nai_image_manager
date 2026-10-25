const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    const nodes = new Map(), listeners = new Map();
    const document = {
        getElementById: id => nodes.get(id),
        createElement: () => ({style: {}, set innerHTML(value) {
            for (const [, id] of value.matchAll(/id="([^"]+)"/g)) nodes.set(id, {style: {}});
        }}),
        body: {appendChild(node) { nodes.set(node.id, node); node.parentNode = this; }},
        addEventListener(type, callback) { listeners.set(type, callback); },
        removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type); },
    };
    const window = {};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/common_anlas_warning.js'), 'utf8'), {window, document});
    return {window, nodes, listeners, node: name => nodes.get('globalAnlasWarning' + name)};
}

test('free requests return immediately without creating a modal', async () => {
    const f = fixture();
    assert.equal(await f.window.showAnlasWarningModal({width: 1024, height: 1024, steps: 28}), true);
    assert.equal(await f.window.showAnlasWarningModal({requests: [{width: 512, height: 768, steps: 28}]}), true);
    assert.equal(f.nodes.size, 0);
});

test('the existing single-image modal confirms or cancels and removes key handlers', async () => {
    const f = fixture(), pending = f.window.showAnlasWarningModal({width: 640, height: 2048, steps: 28, title: 'Synthetic warning'});
    assert.equal(f.node('Title').innerText, 'Synthetic warning');
    assert.equal(f.node('Size').innerText, '640 × 2048');
    assert.equal(f.node('Steps').innerText, '28');
    assert.equal(f.node('Cost').innerText, '26 Anlas');
    f.node('OkBtn').onclick(); assert.equal(await pending, true);
    assert.equal(f.node('Layer').style.display, 'none'); assert.equal(f.listeners.size, 0);
    for (const cancel of [() => f.node('CancelBtn').onclick(), () => f.listeners.get('keydown')({key: 'Escape'}),
        () => f.node('Layer').onclick({target: f.node('Layer')})]) {
        const request = f.window.showAnlasWarningModal({width: 640, height: 2048});
        cancel(); assert.equal(await request, false); assert.equal(f.listeners.size, 0);
    }
});

test('batch warnings display the full selected count, varying settings and total estimated cost', async () => {
    const f = fixture(), pending = f.window.showAnlasWarningModal({requests: [
        {width: 640, height: 2048, steps: 28}, {width: 1024, height: 1024, steps: 35},
        {width: 512, height: 768, steps: 28}], detail: 'Synthetic batch'});
    assert.equal(f.node('Size').innerText, '여러 크기 · 3장');
    assert.equal(f.node('Steps').innerText, '28~35');
    assert.equal(f.node('Cost').innerText, '52 Anlas (합계)');
    assert.equal(f.node('Desc').innerText, 'Synthetic batch');
    f.node('OkBtn').onclick(); assert.equal(await pending, true);
});

test('a dialog warning stays in its top layer and closing the owner cancels and restores it', async () => {
    const f = fixture(), owner = {appendChild(node) { node.parentNode = this; }}, abort = new AbortController();
    const pending = f.window.showAnlasWarningModal({width: 960, height: 3072, parent: owner, signal: abort.signal});
    assert.equal(f.node('Layer').parentNode, owner);
    abort.abort();
    assert.equal(await pending, false);
    assert.notEqual(f.node('Layer').parentNode, owner);
    assert.equal(f.node('Layer').style.display, 'none');
    assert.equal(f.listeners.size, 0);
    assert.equal(await f.window.showAnlasWarningModal({width: 960, height: 3072, parent: owner, signal: abort.signal}), false);
    assert.notEqual(f.node('Layer').parentNode, owner);
});
