const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {countSourceClips, confirm: confirmWithoutDocument} = require('../static/canvas_layer_delete.js');

const moduleSource = fs.readFileSync(require.resolve('../static/canvas_layer_delete.js'), 'utf8');

class FakeNode {
    constructor(doc, tagName) {
        this.doc = doc;
        this.tagName = tagName.toUpperCase();
        this.id = '';
        this.className = '';
        this.type = '';
        this.textContent = '';
        this.children = [];
        this.listeners = new Map();
        this.attributes = new Map();
        this.parentNode = null;
        this.open = false;
        this.showModalCalls = 0;
        this.focusCalls = 0;
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    dispatch(type, event = {}) {
        event.target ||= this;
        event.preventDefault ||= () => { event.defaultPrevented = true; };
        event.stopPropagation ||= () => { event.propagationStopped = true; };
        for (const listener of this.listeners.get(type) || []) listener(event);
        return event;
    }

    focus(options) {
        this.focusCalls++;
        this.doc.activeElement = this;
        this.focusOptions = options;
    }

    showModal() {
        this.open = true;
        this.showModalCalls++;
    }

    close() {
        if (!this.open) return;
        this.open = false;
        if (this.doc.deferCloseEvents) this.doc.closeEvents.push(() => this.dispatch('close'));
        else this.dispatch('close');
    }

    get isConnected() {
        for (let node = this; node; node = node.parentNode) {
            if (node === this.doc.body) return true;
        }
        return false;
    }
}

function createHarness({deferCloseEvents = false} = {}) {
    const doc = {
        activeElement: null,
        deferCloseEvents,
        closeEvents: [],
        createElement(tagName) { return new FakeNode(doc, tagName); },
        body: null,
        querySelectorAll(selector) {
            assert.equal(selector, 'dialog[open]');
            const found = [];
            const visit = node => {
                for (const child of node.children) {
                    if (child.tagName === 'DIALOG' && child.open) found.push(child);
                    visit(child);
                }
            };
            visit(doc.body);
            return found;
        }
    };
    doc.body = new FakeNode(doc, 'body');
    const window = {document: doc};
    const sandbox = {document: doc, window, module: {exports: {}}};
    vm.runInContext(moduleSource, vm.createContext(sandbox));
    return {doc, api: window.CanvasLayerDelete};
}

function findById(root, id) {
    if (root.id === id) return root;
    for (const child of root.children) {
        const found = findById(child, id);
        if (found) return found;
    }
    return null;
}

const clip = (renderOnCanvas = false) => ({type: 'clip', renderOnCanvas});

test('countSourceClips counts source clips under folders and selections, excluding generated results', async () => {
    const layer = {
        type: 'folder',
        children: [
            clip(),
            clip(true),
            {type: 'selection', children: [clip(), {type: 'folder', children: [clip(), clip(true)]}]},
            {type: 'image', children: [clip()]}
        ]
    };

    assert.equal(countSourceClips(layer), 3);
    assert.equal(countSourceClips(clip(true)), 0);
    assert.equal(countSourceClips({type: 'clip', renderOnCanvas: 'generated'}), 0);
    assert.equal(countSourceClips(null), 0);
    assert.equal(countSourceClips({type: 'selection'}), 0);
    assert.equal(await confirmWithoutDocument({type: 'clip'}), false);
});

test('confirm creates one accessible dialog, focuses cancel, safely displays names, and reuses it', async () => {
    const {doc, api} = createHarness();
    const opener = doc.body.appendChild(doc.createElement('button'));
    opener.focus();
    const unsafeName = '<img src=x onerror="run()">';
    const pending = api.confirm({name: unsafeName, type: 'folder', children: [clip(), clip(true)]});
    const dialog = findById(doc.body, 'canvasLayerDeleteDialog');
    const name = findById(dialog, 'canvasLayerDeleteName');
    const description = findById(dialog, 'canvasLayerDeleteDescription');
    const cancel = findById(dialog, 'canvasLayerDeleteCancel');
    const confirm = findById(dialog, 'canvasLayerDeleteConfirm');
    const close = findById(dialog, 'canvasLayerDeleteClose');

    assert.ok(dialog);
    assert.equal(dialog.getAttribute('aria-labelledby'), 'canvasLayerDeleteTitle');
    assert.equal(dialog.attributes.get('aria-labelledby'), 'canvasLayerDeleteTitle');
    assert.equal(dialog.attributes.get('aria-describedby'), 'canvasLayerDeleteDescription');
    assert.equal(dialog.showModalCalls, 1);
    assert.equal(doc.activeElement, cancel);
    assert.equal(name.textContent, unsafeName);
    assert.equal(name.innerHTML, undefined);
    assert.equal(description.textContent, '원본 클립 1개가 포함되어 있습니다. 삭제하면 마스크와 클립 설정도 함께 사라집니다. 계속 작업하려면 다시 클립하거나 실행 취소로 복원해야 합니다.');
    assert.equal(close.attributes.get('aria-label'), '삭제 확인 닫기');
    assert.equal(cancel.className, 'secondary');
    assert.equal(confirm.className, 'danger');

    for (const type of ['keydown', 'paste', 'copy', 'cut']) {
        const event = dialog.dispatch(type);
        assert.equal(event.propagationStopped, true, type);
    }
    cancel.dispatch('click');
    assert.equal(await pending, false);
    assert.equal(doc.activeElement, opener);

    const secondPending = api.confirm({name: 'second name', type: 'clip'});
    assert.equal(findById(doc.body, 'canvasLayerDeleteDialog'), dialog);
    assert.equal(doc.body.children.filter(child => child.id === 'canvasLayerDeleteDialog').length, 1);
    assert.equal(dialog.showModalCalls, 2);
    assert.equal(name.textContent, 'second name');
    confirm.dispatch('click');
    confirm.dispatch('click');
    assert.equal(await secondPending, true);
    assert.equal(doc.activeElement, opener);
});

test('Escape, close, and cancel resolve false; duplicate requests cannot replace the open target', async () => {
    const {doc, api} = createHarness();
    const opener = doc.body.appendChild(doc.createElement('button'));
    opener.focus();
    const pending = api.confirm({name: 'first target', type: 'clip'});
    const dialog = findById(doc.body, 'canvasLayerDeleteDialog');
    const name = findById(dialog, 'canvasLayerDeleteName');

    assert.equal(await api.confirm({name: 'replacement target', type: 'clip'}), false);
    assert.equal(name.textContent, 'first target');
    const escape = dialog.dispatch('cancel');
    assert.equal(escape.defaultPrevented, true);
    assert.equal(await pending, false);
    assert.equal(doc.activeElement, opener);
    dialog.dispatch('close');

    const closePending = api.confirm({name: 'close target', type: 'clip'});
    findById(dialog, 'canvasLayerDeleteClose').dispatch('click');
    assert.equal(await closePending, false);

    const externalClosePending = api.confirm({name: 'external close', type: 'clip'});
    dialog.close();
    assert.equal(await externalClosePending, false);
});

test('confirmation leaves focus restoration to the browser when another native dialog remains open', async () => {
    const {doc, api} = createHarness();
    const opener = doc.body.appendChild(doc.createElement('button'));
    opener.focus();
    const focusCallsBefore = opener.focusCalls;
    const siblingDialog = doc.body.appendChild(doc.createElement('dialog'));
    siblingDialog.open = true;

    const pending = api.confirm({name: 'nested opener', type: 'clip'});
    findById(doc.body, 'canvasLayerDeleteCancel').dispatch('click');
    assert.equal(await pending, false);
    assert.equal(opener.focusCalls, focusCallsBefore);
});

test('a delayed close event from a finished dialog cannot cancel the next confirmation', async () => {
    const {doc, api} = createHarness({deferCloseEvents: true});
    const firstPending = api.confirm({name: 'first', type: 'clip'});
    const dialog = findById(doc.body, 'canvasLayerDeleteDialog');
    findById(dialog, 'canvasLayerDeleteCancel').dispatch('click');
    assert.equal(await firstPending, false);

    const secondPending = api.confirm({name: 'second', type: 'clip'});
    doc.closeEvents.shift()();
    const secondResult = secondPending.then(value => value);
    const confirm = findById(dialog, 'canvasLayerDeleteConfirm');
    confirm.dispatch('click');
    assert.equal(await secondResult, true);
    doc.closeEvents.shift()();
});
