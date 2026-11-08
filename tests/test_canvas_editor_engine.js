const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

test('a superseded update aborts without advancing the worker source or blocking the next preview', async () => {
    const commands = [];
    let worker;
    class MockWorker {
        constructor() {worker = this;}
        postMessage(message) {commands.push(message);}
        reply(message) {this.onmessage({data: message});}
        terminate() {}
    }
    const context = vm.createContext({Worker: MockWorker, WebAssembly, ImageData: class {}, DOMException});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/canvas_editor_engine.js'), 'utf8'), context);
    const engine = context.CanvasEditorEngine.create();
    const warm = commands.shift();
    worker.reply({id: warm.id, done: true});
    await engine.ready;

    const body = {source: '/image/source.png', baseRevision: 1, layers: []};
    const update = engine.update(body);
    const previous = commands.shift();
    const rejected = assert.rejects(update, {name: 'AbortError'});
    engine.cancelUpdate();
    const cancel = commands.shift();
    assert.equal(cancel.kind, 'cancel');
    assert.equal(cancel.id, previous.id);
    worker.reply({id: previous.id, cancelled: true});
    await rejected;

    const preview = engine.preview({...body, viewport: [0, 0, 40, 40]});
    const latest = commands.shift();
    assert.equal(latest.kind, 'viewport');
    assert.equal(latest.body.source, body.source);
    worker.reply({id: latest.id, done: true});
    assert.equal((await preview).patches.length, 0);
    engine.destroy();
});

test('preloading the source omits it from later viewport commands and stale viewports can be cancelled', async () => {
    const sent = [];
    let worker;
    class MockWorker {
        constructor() {worker = this;}
        postMessage(message) {sent.push(message);}
        reply(message) {this.onmessage({data: message});}
        terminate() {}
    }
    const context = vm.createContext({Worker: MockWorker, WebAssembly, ImageData: class {}, DOMException});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/canvas_editor_engine.js'), 'utf8'), context);
    const engine = context.CanvasEditorEngine.create();
    worker.reply({id: sent.shift().id, done: true});
    const body = {source: '/image/source.png', width: 5000, height: 16000};
    const prepared = engine.prepare(body);
    const prime = sent.shift();
    assert.equal(prime.kind, 'prepare');
    assert.equal(prime.body.source, body.source);
    worker.reply({id: prime.id, done: true});
    await prepared;

    const preview = engine.preview({...body, layers: [], viewport: [0, 0, 40, 40]});
    const obsolete = sent.shift();
    assert.equal(obsolete.body.source, undefined);
    engine.cancelUpdate();
    engine.cancelUpdate();
    assert.deepEqual(sent.map(({id, kind}) => [id, kind]), [[obsolete.id, 'cancel']]);
    worker.reply({id: obsolete.id, cancelled: true});
    await assert.rejects(preview, {name: 'AbortError'});
    engine.destroy();
});
