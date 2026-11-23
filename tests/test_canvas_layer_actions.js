const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const canvasSource = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8');

function extractFunction(source, name) {
    let start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `expected ${name} in static/canvas.js`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    const end = source.indexOf('\n}', source.indexOf('{', start));
    assert.notEqual(end, -1, `expected closing brace for ${name}`);
    return source.slice(start, end + 2);
}

test('dropping a selection into a folder moves its entire subtree in order', () => {
    const original = {id: 3, type: 'clip'};
    const result = {id: 5, type: 'clip'};
    const results = {id: 4, type: 'folder', children: [result]};
    const selection = {id: 2, type: 'selection', children: [results, original]};
    const image = {id: 6, type: 'image'};
    const folder = {id: 1, type: 'folder', expanded: false, children: [image]};
    const other = {id: 7, type: 'selection', children: []};
    const layers = [selection, other, folder];
    let saves = 0;
    const context = vm.createContext({
        canvasLayers: layers, draggedLayerId: selection.id, activeLayerId: null,
        clearLayerDropMarkers() {}, renderLayerList() {}, renderCanvasLayersOnSurface() {},
        saveCanvasState() { saves++; }
    });
    for (const name of ['findCanvasLayer', 'layerTreeContainsLayerId', 'canDropLayerOnTarget',
        'removeCanvasLayerById', 'moveDraggedLayerToTarget']) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    assert.equal(context.canDropLayerOnTarget(selection.id, results.id, 'inside'), false);
    assert.equal(context.canDropLayerOnTarget(selection.id, other.id, 'inside'), false);
    assert.equal(context.canDropLayerOnTarget(results.id, folder.id, 'inside'), false);

    context.moveDraggedLayerToTarget({preventDefault() {}, stopPropagation() {}}, folder.id, 'inside');
    assert.deepEqual(layers, [other, folder]);
    assert.deepEqual(folder.children, [selection, image]);
    assert.deepEqual(selection.children, [results, original]);
    assert.deepEqual(results.children, [result]);
    assert.equal(folder.expanded, true);
    assert.equal(context.activeLayerId, selection.id);
    assert.equal(saves, 1);
});

function createHarness() {
    const deleted = [];
    const toasts = [];
    const context = vm.createContext({
        deleteCanvasLayer(layerId, event) { deleted.push({layerId, event}); },
        showToast(message) { toasts.push(message); }
    });
    vm.runInContext('let canvasLayerDeletePointerId = null; let canvasLayerDeletePressedId = null;', context);
    for (const name of ['getCanvasLayerDeletePointerTarget', 'handleCanvasLayerDeleteClick']) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    return {context, deleted, toasts};
}

function setDeleteIds(context, pointerId, pressedId) {
    vm.runInContext(`canvasLayerDeletePointerId = ${pointerId}; canvasLayerDeletePressedId = ${pressedId};`, context);
}

function makeClickEvent(detail) {
    let stopped = 0;
    return {
        detail,
        stopPropagation() { stopped++; },
        get stopped() { return stopped; }
    };
}

test('delete pointer target resolves the enclosing layer id only from the delete button', () => {
    const h = createHarness();
    const row = {dataset: {layerId: '27'}};
    const button = {closest(selector) {
        assert.equal(selector, '.layer-item');
        return row;
    }};
    const target = {closest(selector) {
        assert.equal(selector, '.layer-delete-btn');
        return button;
    }};

    assert.equal(h.context.getCanvasLayerDeletePointerTarget({target}), 27);
    assert.equal(h.context.getCanvasLayerDeletePointerTarget({target: {closest: () => null}}), null);
});

test('stale pointer target is rejected and the next matching hover and press deletes only its row', () => {
    const h = createHarness();
    setDeleteIds(h.context, 10, 10);
    const staleClick = makeClickEvent(1);
    h.context.handleCanvasLayerDeleteClick(11, staleClick);
    assert.deepEqual(h.deleted, []);
    assert.equal(h.toasts.length, 1);
    assert.equal(staleClick.stopped, 1);

    setDeleteIds(h.context, 11, 11);
    const validClick = makeClickEvent(1);
    h.context.handleCanvasLayerDeleteClick(11, validClick);
    assert.deepEqual(h.deleted.map(({layerId}) => layerId), [11]);
    assert.equal(h.toasts.length, 1);
    assert.equal(validClick.stopped, 1);
    assert.equal(vm.runInContext('canvasLayerDeletePressedId', h.context), null);

    const duplicateClick = makeClickEvent(1);
    h.context.handleCanvasLayerDeleteClick(11, duplicateClick);
    assert.deepEqual(h.deleted.map(({layerId}) => layerId), [11]);
    assert.equal(h.toasts.length, 2);
    assert.equal(duplicateClick.stopped, 1);
});

test('hover and pressed row mismatches block pointer deletion with feedback', () => {
    const h = createHarness();
    const hoverMismatch = makeClickEvent(1);
    setDeleteIds(h.context, 10, 11);
    h.context.handleCanvasLayerDeleteClick(11, hoverMismatch);
    assert.deepEqual(h.deleted, []);
    assert.equal(h.toasts.length, 1);
    assert.equal(hoverMismatch.stopped, 1);

    const pressedMismatch = makeClickEvent(1);
    setDeleteIds(h.context, 11, 10);
    h.context.handleCanvasLayerDeleteClick(11, pressedMismatch);
    assert.deepEqual(h.deleted, []);
    assert.equal(h.toasts.length, 2);
    assert.equal(pressedMismatch.stopped, 1);
});

test('keyboard activation deletes the focused row without pointer ids and clears pressed state', () => {
    const h = createHarness();
    setDeleteIds(h.context, 10, 10);
    const keyboardClick = makeClickEvent(0);
    h.context.handleCanvasLayerDeleteClick(22, keyboardClick);

    assert.deepEqual(h.deleted.map(({layerId}) => layerId), [22]);
    assert.equal(h.toasts.length, 0);
    assert.equal(keyboardClick.stopped, 1);
    assert.equal(vm.runInContext('canvasLayerDeletePressedId', h.context), null);
});

function deletionHarness() {
    const source = {id: 3, type: 'clip', src: '/canvas-imports/synthetic.png'};
    const selection = {id: 2, type: 'selection', children: [source]};
    const calls = {saved: 0, cleanup: 0, confirmed: 0, toasts: []};
    let resolveConfirm;
    const context = vm.createContext({
        canvasLayers: [selection, {id: 1, type: 'canvas'}],
        checkedSelectionId: 2, activeClipSelectionId: 2, activeLayerId: 3,
        selectedLayerIds: new Set([3]),
        CanvasLayerDelete: {
            countSourceClips: require('../static/canvas_layer_delete').countSourceClips,
            confirm() { calls.confirmed++; return new Promise(resolve => { resolveConfirm = resolve; }); }
        },
        getFirstCanvasLayerId: () => 1,
        ensureCheckedSelectionId() {}, renderLayerList() {}, renderCanvasLayersOnSurface() {},
        saveCanvasState() { calls.saved++; },
        collectCanvasImportRefsFromLayer: () => ['synthetic.png'],
        cleanupDetachedCanvasImportRefs() { calls.cleanup++; },
        showToast(message) { calls.toasts.push(message); },
        alert(message) { throw new Error(message); }
    });
    for (const name of ['findCanvasLayer', 'getAllCanvasLayerNodes', 'collectCanvasLayerIds', 'deleteCanvasLayer']) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    return {context, calls, selection, source, resolve: answer => resolveConfirm(answer)};
}

test('source cancellation preserves the layer and skips saving and cleanup', async () => {
    const h = deletionHarness();
    const pending = h.context.deleteCanvasLayer(3);
    assert.equal(h.calls.confirmed, 1);
    h.resolve(false); await pending;
    assert.equal(h.selection.children[0], h.source);
    assert.equal(h.calls.saved, 0); assert.equal(h.calls.cleanup, 0);
});

test('confirmed source deletion resolves the current index after a sibling is inserted', async () => {
    const h = deletionHarness();
    const pending = h.context.deleteCanvasLayer(3);
    h.selection.children.unshift({id: 4, type: 'clip', renderOnCanvas: true});
    h.resolve(true); await pending;
    assert.deepEqual(h.selection.children.map(layer => layer.id), [4]);
    assert.equal(h.calls.saved, 1); assert.equal(h.calls.cleanup, 1);
});

test('changed descendants or a replaced target invalidate a pending confirmation', async () => {
    for (const change of ['descendants', 'replacement']) {
        const h = deletionHarness();
        const pending = h.context.deleteCanvasLayer(change === 'descendants' ? 2 : 3);
        if (change === 'descendants') h.selection.children.unshift({id: 4, type: 'clip', renderOnCanvas: true});
        else h.selection.children[0] = {...h.source};
        h.resolve(true); await pending;
        assert.equal(h.calls.saved, 0); assert.equal(h.calls.cleanup, 0);
        assert.equal(h.calls.toasts.length, 1);
        assert.equal(h.context.canvasLayers[0], h.selection);
    }
});

test('generated results delete immediately without source confirmation', async () => {
    const h = deletionHarness();
    h.selection.children.unshift({id: 4, type: 'clip', renderOnCanvas: true});
    await h.context.deleteCanvasLayer(4);
    assert.equal(h.calls.confirmed, 0);
    assert.equal(h.selection.children.length, 1);
    assert.equal(h.calls.saved, 1);
});

test('processing feedback updates existing nodes and ignores an obsolete completion', () => {
    const state = {};
    const overlay = {classList: {toggle(name, value) { state.loading = value; }}, setAttribute() {}};
    const label = {};
    const button = {};
    const wrap = {setAttribute(name, value) { state.busy = value; }};
    const panel = {dataset: {clipId: '3'}, querySelector: selector => ({
        '.clip-inpaint-loading': overlay, '.clip-inpaint-loading-text': label,
        '.clip-inpaint-run-btn': button, '.canvas-clip-output-image-wrap': wrap
    })[selector]};
    const context = vm.createContext({clipInpaintLoadingClipId: null, clipInpaintLoadingMessage: '',
        el: () => ({querySelector: () => panel}),
        renderClipOutputPanel() { throw new Error('processing must not rebuild the mask editor'); }});
    for (const name of ['setClipInpaintProcessing', 'syncClipInpaintProcessing']) {
        vm.runInContext(extractFunction(canvasSource, name), context);
    }
    context.setClipInpaintProcessing(3, true, '합성 생성 중');
    assert.equal(state.loading, true); assert.equal(state.busy, 'true');
    assert.equal(button.disabled, true); assert.equal(label.textContent, '합성 생성 중');
    context.setClipInpaintProcessing(7, false);
    assert.equal(state.loading, true);
    context.setClipInpaintProcessing(3, false);
    assert.equal(state.loading, false); assert.equal(button.disabled, false);
});

function stackedResults() {
    const clips = Array.from({length: 40}, (_, i) => ({id: i + 10, type: 'clip', visible: true, renderOnCanvas: true}));
    const result = {...clips[0], id: 90};
    return {clips, result, folder: {id: 2, children: [result, ...clips]}, selection: {id: 1}};
}

test('an expanded result folder prepends only the new row and clears the previous active row', () => {
    const stack = stackedResults();
    const rows = stack.clips.map(clip => ({id: clip.id}));
    const original = [...rows];
    const meta = {};
    const active = original[0];
    const activeClasses = new Set(['active']);
    active.classList = {remove: name => activeClasses.delete(name)};
    const children = {
        classList: {contains: name => name === 'layer-children'},
        querySelector: () => null,
        prepend(fragment) { rows.unshift(...fragment); }
    };
    const folderRow = {nextElementSibling: children, style: {getPropertyValue: () => '2'},
        querySelector: selector => selector === '.layer-meta' ? meta : null};
    const list = {querySelector: selector => ({
        '.folder-item[data-layer-id="2"]': folderRow, '.layer-item.active': active
    })[selector]};
    const context = vm.createContext({
        document: {createDocumentFragment: () => []},
        renderLayerTree(layers, fragment, depth) {
            assert.equal(depth, 3);
            assert.equal(layers.length, 1);
            assert.equal(layers[0], stack.result);
            fragment.push({id: layers[0].id});
        }
    });
    vm.runInContext(extractFunction(canvasSource, 'insertInpaintResultRow'), context);
    assert.equal(context.insertInpaintResultRow(list, stack), true);
    assert.equal(rows.length, 41);
    assert.equal(rows[0].id, stack.result.id);
    assert.ok(original.every((row, i) => rows[i + 1] === row));
    assert.equal(activeClasses.has('active'), false);
    assert.equal(meta.textContent, '폴더 · 41개');

    folderRow.nextElementSibling = null;
    assert.equal(context.insertInpaintResultRow(list, stack), false);
    assert.equal(rows.length, 41);
});

test('a surface result goes above the highest visible sibling and below the next overlay', () => {
    const stack = stackedResults();
    stack.clips[0].visible = false;
    const original = stack.clips.slice(1).reverse().map(clip => ({id: clip.id}));
    const overlay = {};
    const nodes = [...original, overlay];
    const anchor = original.at(-1);
    anchor.after = fragment => nodes.splice(nodes.indexOf(anchor) + 1, 0, ...fragment);
    const surface = {querySelector: selector => selector === `.image-layer[data-layer-id="${anchor.id}"]` ? anchor : null};
    const context = vm.createContext({
        isImageResizeMode: false, isCanvasResizeMode: false, isLayerMoveMode: false,
        selectedLayerIds: new Set(), canvasLayerEraserEnabled: false, window: {},
        document: {createDocumentFragment: () => []},
        renderCanvasLayerStack(layers, fragment, scale, selection) {
            assert.equal(scale, 0.5);
            assert.equal(selection, stack.selection);
            assert.equal(layers.length, 1);
            assert.equal(layers[0], stack.result);
            fragment.push({id: layers[0].id});
        }
    });
    vm.runInContext(extractFunction(canvasSource, 'insertInpaintResultOnSurface'), context);
    assert.equal(context.insertInpaintResultOnSurface(surface, 0.5, stack), true);
    assert.ok(original.every((node, i) => nodes[i] === node));
    assert.equal(nodes.at(-2).id, stack.result.id);
    assert.equal(nodes.at(-1), overlay);

    assert.equal(context.insertInpaintResultOnSurface({querySelector: () => null}, 0.5, stack), false);
    context.isImageResizeMode = true;
    assert.equal(context.insertInpaintResultOnSurface(surface, 0.5, stack), false);
    assert.equal(nodes.length, original.length + 2);
});

test('switching a result keeps its image node and restores placement at the current zoom', () => {
    const clip = {id: 9, type: 'clip', renderOnCanvas: true, src: '/result', visible: false};
    const node = {style: {}, querySelector: () => ({classList: {remove() {}}})};
    const surface = {querySelector: selector => selector === '.image-layer[data-layer-id="9"]' ? node : null};
    const placements = [];
    const context = vm.createContext({
        isImageResizeMode: false, isCanvasResizeMode: false, isLayerMoveMode: false, window: {},
        selectedLayerIds: new Set(), canvasLayerEraserEnabled: false,
        updateCanvasLayerNodeGeometry(...args) { placements.push(args); }
    });
    vm.runInContext(extractFunction(canvasSource, 'updateInpaintResultVisibilityOnSurface'), context);
    assert.equal(context.updateInpaintResultVisibilityOnSurface(surface, 1, clip), true);
    assert.equal(node.style.display, 'none');
    clip.visible = true;
    assert.equal(context.updateInpaintResultVisibilityOnSurface(surface, 2, clip), true);
    assert.equal(node.style.display, '');
    assert.deepEqual(placements, [[clip, 2, node]]);
    context.canvasLayerEraserEnabled = true;
    assert.equal(context.updateInpaintResultVisibilityOnSurface(surface, 2, clip), false);
});
