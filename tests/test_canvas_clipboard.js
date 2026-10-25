const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../static/canvas.js'), 'utf8');
function functionSource(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `Missing ${name}`);
    const tail = source.slice(start);
    const next = tail.slice(1).search(/\n(?:async )?function /);
    return next < 0 ? tail : tail.slice(0, next + 1);
}

test('Ctrl+V allows the browser to deliver external clipboard data', () => {
    let prevented = false;
    let internalPastes = 0;
    const context = vm.createContext({
        isClipOutputKeyboardTargetActive: () => true,
        pasteInternalClipboardToClipInpaintResults: () => { internalPastes++; },
    });
    vm.runInContext(functionSource('handleClipOutputClipboardShortcut'), context);
    context.handleClipOutputClipboardShortcut({
        ctrlKey: true, key: 'v', preventDefault() { prevented = true; },
    });
    assert.equal(prevented, false);
    assert.equal(internalPastes, 0);
});

test('Ctrl+C retains the internal image copy shortcut', () => {
    let copied = false;
    const context = vm.createContext({
        isClipOutputKeyboardTargetActive: () => true,
        copyClipOutputToInternalClipboard: () => { copied = true; },
    });
    vm.runInContext(functionSource('handleClipOutputClipboardShortcut'), context);
    assert.equal(context.handleClipOutputClipboardShortcut({
        ctrlKey: true, key: 'c', preventDefault() {},
    }), true);
    assert.equal(copied, true);
});

function clipboardContext(clipboard = {}) {
    const context = vm.createContext({ navigator: { clipboard }, File });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/canvas_clipboard.js'), 'utf8')
        + '\nthis.clipboard = CanvasImageClipboard;', context);
    return context;
}

test('paste reads image items when the browser files list is empty', () => {
    const { clipboard } = clipboardContext();
    const file = new File(['synthetic'], 'image.png', { type: 'image/png' });
    assert.equal(clipboard.readEventFile({ files: [], items: [
        { kind: 'string', type: 'text/html' },
        { kind: 'file', getAsFile: () => file },
    ] }), file);
    assert.equal(clipboard.readEventFile({ items: [
        { kind: 'file', getAsFile: () => null },
    ] }), null);
});

test('clipboard permission refusal is recoverable', async () => {
    const { clipboard } = clipboardContext({ read: async () => { throw Error('denied'); } });
    assert.equal(await clipboard.readSystemFile(), null);
    assert.equal(await clipboardContext().clipboard.readSystemFile(), null);
});

test('system clipboard tries another image representation after decode failure', async () => {
    const { clipboard } = clipboardContext({ read: async () => [{
        types: ['text/html', 'image/jpeg', 'image/png'],
        async getType(type) {
            if (type === 'image/jpeg') throw Error('unavailable representation');
            return new Blob(['synthetic'], { type });
        },
    }] });
    const result = await clipboard.readSystemFile();
    assert.equal(result.type, 'image/png');
    assert.equal(await result.text(), 'synthetic');
});

function pasteHarness({ selected = false, editable = false } = {}) {
    const events = {};
    const calls = [];
    const { clipboard } = clipboardContext();
    const context = vm.createContext({
        document: {
            body: { dataset: {} }, querySelector: () => null,
            addEventListener(name, handler) { events[name] = handler; },
        },
        el: () => null,
        CanvasImageClipboard: clipboard,
        isEditablePasteTarget: () => editable,
        isClipOutputKeyboardTargetActive: () => selected,
        async pasteInternalClipboardToClipInpaintResults(options) { calls.push(['selection', options]); },
        async importExternalCanvasImageFile(file) { calls.push(['canvas', file]); },
        async readExternalCanvasImageFileFromSystemClipboard() { calls.push(['system']); return null; },
    });
    vm.runInContext(functionSource('bindExternalCanvasImageDropAndPaste'), context);
    context.bindExternalCanvasImageDropAndPaste();
    return { paste: events.paste, calls };
}

for (const selected of [false, true]) {
    test(`external website image goes to ${selected ? 'selection' : 'canvas'} once without read permission`, async () => {
        const { paste, calls } = pasteHarness({ selected });
        const file = new File(['synthetic'], 'image.png', { type: 'image/png' });
        let prevented = false;
        const pending = paste({
            clipboardData: { files: [file] },
            preventDefault() { prevented = true; },
        });
        assert.equal(prevented, true);
        await pending;
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], selected ? 'selection' : 'canvas');
        assert.equal(selected ? calls[0][1].externalImageFile : calls[0][1], file);
    });
}

test('pasting into a text field does not import an image or read the clipboard', async () => {
    const { paste, calls } = pasteHarness({ editable: true });
    await paste({ preventDefault() { assert.fail('must preserve text paste'); } });
    assert.equal(calls.length, 0);
});
