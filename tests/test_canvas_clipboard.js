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

function clipOutputState() {
    const baseClip = {id: 2, type: 'clip', src: '/synthetic/base.png',
        x: 17.25, y: 0, layerWidth: 256, layerHeight: 192,
        imageWidth: 512, imageHeight: 384, promptInfo: {basePrompt: 'synthetic'}};
    const displayClip = {...baseClip, id: 3, src: '/synthetic/previous-result.png',
        x: 20.25, y: 3, layerWidth: 258, layerHeight: 194};
    return {selection: {id: 1, type: 'selection', x: 17, y: 0,
        layerWidth: 256, layerHeight: 192}, baseClip, displayClip, displaySrc: displayClip.src};
}

function clipPayloadContext(extra = {}) {
    const context = vm.createContext({
        CanvasSelectionRotation: require('../static/canvas_selection_rotation.js'),
        normalizePromptInfo: value => value,
        structuredClone,
        ...extra
    });
    vm.runInContext([
        functionSource('clonePromptControlGroupsForClipboard'),
        functionSource('buildClipboardPayloadFromClipOutputState'),
        functionSource('buildExternalClipboardPayloadForClipOutput')
    ].join('\n'), context);
    return context;
}

test('external clipboard image uses the original clip position even when a moved result is previewed', () => {
    const state = clipOutputState();
    const context = clipPayloadContext();
    const payload = context.buildExternalClipboardPayloadForClipOutput('data:image/png;base64,synthetic', state);
    for (const key of ['x', 'y', 'layerWidth', 'layerHeight', 'imageWidth', 'imageHeight']) {
        assert.equal(payload[key], state.baseClip[key], key);
    }
    assert.equal(payload.src, 'data:image/png;base64,synthetic');
});

test('copying a displayed result still retains that result geometry in the internal clipboard', () => {
    const state = clipOutputState();
    const payload = clipPayloadContext().buildClipboardPayloadFromClipOutputState(state);
    assert.equal(payload.src, state.displayClip.src);
    assert.equal(payload.x, state.displayClip.x);
    assert.equal(payload.y, state.displayClip.y);
    assert.equal(payload.layerWidth, state.displayClip.layerWidth);
});

test('clip clipboard payloads preserve the angle of their corresponding source', () => {
    const state = clipOutputState();
    state.baseClip.rotation = 45;
    state.displayClip.rotation = -90;
    const context = clipPayloadContext();
    assert.equal(context.buildExternalClipboardPayloadForClipOutput('synthetic', state).rotation, 45);
    assert.equal(context.buildClipboardPayloadFromClipOutputState(state).rotation, -90);
});

test('external paste imports the entire image without a mask at the original clip coordinates', async () => {
    const state = clipOutputState();
    const folder = {children: []};
    const saved = [];
    let stateSaves = 0;
    const image = 'data:image/png;base64,whole-synthetic-image';
    const context = clipPayloadContext({
        clipOutputInternalClipboard: null,
        layerIdSeq: 10,
        clipMergedSourcePreviewSeq: 0,
        closeClipOutputClipboardContextMenu() {},
        getCurrentClipOutputDisplayState: () => state,
        normalizeSelectionAreaGeometry() {},
        blobToDataUrl: async () => image,
        async saveClipDataUrlToServer(...args) { saved.push(args); return '/synthetic/imported.png'; },
        getOrCreateSelectionInpaintFolder: () => folder,
        clearClipMergedSourcePreviewCache() {},
        migrateAllSelectionClipsToSharedPromptOwner() {},
        renderLayerList() {}, renderCanvasLayersOnSurface() {}, renderClipOutputPanel() {},
        saveCanvasState() { stateSaves++; },
        alert(message) { assert.fail(message); }
    });
    vm.runInContext('async ' + functionSource('pasteInternalClipboardToClipInpaintResults'), context);
    assert.equal(await context.pasteInternalClipboardToClipInpaintResults({
        externalImageFile: new File(['synthetic'], 'image.png', {type: 'image/png'})
    }), true);
    assert.deepEqual(saved.map(args => Array.from(args)), [[image]]);
    assert.equal(folder.children.length, 1);
    const result = folder.children[0];
    assert.equal(result.src, '/synthetic/imported.png');
    for (const key of ['x', 'y', 'layerWidth', 'layerHeight', 'imageWidth', 'imageHeight']) {
        assert.equal(result[key], state.baseClip[key], key);
    }
    assert.equal(stateSaves, 1);
});

function clipOutputDisplayHarness({
    mergedMode = false,
    previewMode = false,
    hasResult = true,
    hasMergedCache = false,
} = {}) {
    const selection = {id: 21, type: 'selection', x: 4, y: 8, layerWidth: 320, layerHeight: 240};
    const baseClip = {id: 22, type: 'clip', src: '/synthetic/base-display.png', imageWidth: 640, imageHeight: 480};
    const resultClip = {id: 23, type: 'clip', src: '/synthetic/inpaint-result.png', imageWidth: 640, imageHeight: 480};
    const mergedKey = 'synthetic-merged-key';
    const context = vm.createContext({
        getClipOutputTarget: () => ({selection, clip: baseClip}),
        getTopVisibleInpaintClipForSelection: () => hasResult ? resultClip : null,
        buildClipMergedSourcePreviewKey: () => mergedKey,
        isClipInpaintPreviewMode: previewMode,
        isClipInpaintMergedSourceMode: mergedMode,
        clipMergedSourcePreviewCache: {
            key: hasMergedCache ? mergedKey : '',
            dataUrl: hasMergedCache ? 'data:image/png;base64,merged-source' : ''
        }
    });
    vm.runInContext(functionSource('getCurrentClipOutputDisplayState'), context);
    return {context, selection, baseClip, resultClip};
}

test('clip output display prioritizes the inpaint result over merged-source mode', () => {
    for (const mergedMode of [false, true]) {
        for (const hasMergedCache of [false, true]) {
            const {context, resultClip} = clipOutputDisplayHarness({
                mergedMode,
                previewMode: true,
                hasResult: true,
                hasMergedCache
            });
            const state = context.getCurrentClipOutputDisplayState();
            assert.equal(state.displayClip, resultClip);
            assert.equal(state.displaySrc, resultClip.src);
            assert.equal(state.isMergedPreview, false);
        }
    }
});

test('clip output display uses a valid merged cache only when result preview is off', () => {
    const {context, baseClip} = clipOutputDisplayHarness({
        mergedMode: true,
        previewMode: false,
        hasResult: true,
        hasMergedCache: true
    });
    const state = context.getCurrentClipOutputDisplayState();
    assert.equal(state.displayClip, baseClip);
    assert.equal(state.displaySrc, 'data:image/png;base64,merged-source');
    assert.equal(state.isMergedPreview, true);
});

test('clip output display falls back to the base clip when merged preview is unavailable or off', () => {
    for (const options of [
        {mergedMode: true, previewMode: false, hasMergedCache: false},
        {mergedMode: false, previewMode: false, hasMergedCache: true}
    ]) {
        const {context, baseClip} = clipOutputDisplayHarness({...options, hasResult: true});
        const state = context.getCurrentClipOutputDisplayState();
        assert.equal(state.displayClip, baseClip);
        assert.equal(state.displaySrc, baseClip.src);
        assert.equal(state.isMergedPreview, false);
    }
});

test('clip output display does not show a missing inpaint result', () => {
    const {context, baseClip} = clipOutputDisplayHarness({
        mergedMode: false,
        previewMode: true,
        hasResult: false
    });
    const state = context.getCurrentClipOutputDisplayState();
    assert.equal(state.displayClip, baseClip);
    assert.equal(state.displaySrc, baseClip.src);
    assert.equal(state.isMergedPreview, false);
});

function clipInpaintPreviewToggleHarness({previewMode = false, hasResult = true} = {}) {
    const selection = {id: 31, type: 'selection'};
    const baseClip = {id: 32, type: 'clip'};
    let cursorDisplay = 'block';
    let renderCount = 0;
    const context = vm.createContext({
        getClipOutputTarget: () => ({selection, clip: baseClip}),
        getTopVisibleInpaintClipForSelection: () => hasResult ? {id: 33, type: 'clip'} : null,
        isClipInpaintPreviewMode: previewMode,
        el: () => ({style: {set display(value) { cursorDisplay = value; }}}),
        renderClipOutputPanel: () => { renderCount++; }
    });
    vm.runInContext(functionSource('toggleClipInpaintPreview'), context);
    return {
        context,
        get cursorDisplay() { return cursorDisplay; },
        get renderCount() { return renderCount; }
    };
}

test('clip inpaint result preview toggle turns on and off when a result exists', () => {
    const turningOn = clipInpaintPreviewToggleHarness({previewMode: false, hasResult: true});
    turningOn.context.toggleClipInpaintPreview();
    assert.equal(turningOn.context.isClipInpaintPreviewMode, true);
    assert.equal(turningOn.cursorDisplay, 'none');
    assert.equal(turningOn.renderCount, 1);

    const turningOff = clipInpaintPreviewToggleHarness({previewMode: true, hasResult: true});
    turningOff.context.toggleClipInpaintPreview();
    assert.equal(turningOff.context.isClipInpaintPreviewMode, false);
    assert.equal(turningOff.cursorDisplay, 'none');
    assert.equal(turningOff.renderCount, 1);
});

test('clip inpaint result preview cannot turn on without a result', () => {
    const harness = clipInpaintPreviewToggleHarness({previewMode: false, hasResult: false});
    harness.context.toggleClipInpaintPreview();
    assert.equal(harness.context.isClipInpaintPreviewMode, false);
    assert.equal(harness.cursorDisplay, 'block');
    assert.equal(harness.renderCount, 0);
});
