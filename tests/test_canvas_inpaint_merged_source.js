const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {test} = require('node:test');

const source = fs.readFileSync(require.resolve('../static/canvas.js'), 'utf8').replace(/\r\n/g, '\n');

function extract(name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, `missing ${name}`);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

function makeHarness(render) {
    const base = {id: 2, type: 'clip', src: '/base.png', maskSrc: '/mask.png',
        imageWidth: 640, imageHeight: 512, layerWidth: 320, layerHeight: 256, rotation: 15, x: 25, y: 50};
    const results = Array.from({length: 24}, (_, index) => ({
        ...base, id: 10 + index, src: `/result-${index}.png`, visible: true, renderOnCanvas: true
    }));
    const selection = {id: 1, type: 'selection', x: 25, y: 50,
        children: [base, {id: 3, type: 'folder', visible: true, children: results}]};
    const requests = [];
    let renders = 0;
    const context = vm.createContext({
        renderMergedClipSourceToDataUrl() { return render(++renders); },
        getClipOutputTarget: () => ({selection, clip: base}),
        findCanvasLayer: id => ({layer: id === base.id ? base : selection}),
        findSelectionParentForLayerId: () => selection,
        renderClipOutputPanel() {}, buildEffectiveClipPromptInfo: () => ({}),
        showAnlasWarningModal: () => true, setClipInpaintProcessing() {},
        clipInpaintLoadingClipId: null, CANVAS_IMPORT_SESSION_ID: 'synthetic',
        alert() {},
        async fetch(url, options) {
            requests.push(JSON.parse(options.body));
            // Stop after the transport boundary. Result insertion has its own integration tests.
            return {ok: false, json: async () => ({status: 'error', message: 'synthetic'})};
        }
    });
    const start = source.indexOf('let isClipInpaintPreviewMode');
    const end = source.indexOf('let openClipMaskSizeTool', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
    vm.runInContext('isClipInpaintMergedSourceMode = true', context);
    for (const name of ['collectVisibleInpaintClipsForMergedSource', 'buildClipMergedSourcePreviewKey',
        'clearClipMergedSourcePreviewCache', 'getClipMergedSourceDataUrl',
        'ensureClipMergedSourcePreview', 'requestClipInpainting']) {
        vm.runInContext(extract(name), context);
    }
    return {context, base, results, selection, requests, count: () => renders,
        preview: () => context.ensureClipMergedSourcePreview(selection, base),
        submit: () => context.requestClipInpainting(base.id),
        merge: () => context.getClipMergedSourceDataUrl(selection, base)};
}

test('inpaint sends the completed preview of 24 result layers without a second merge', async () => {
    const h = makeHarness(async number => `composite-${number}`);
    await h.preview();
    await h.submit();
    assert.equal(h.count(), 1);
    assert.deepEqual(h.requests.map(body => body.image), ['composite-1']);
});

test('a click during preview shares the pending image', async () => {
    let finish;
    const image = new Promise(resolve => { finish = resolve; });
    const h = makeHarness(() => image);
    const preview = h.preview();
    const submit = h.submit();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.count(), 1);
    finish('shared-pixels');
    await Promise.all([preview, submit]);
    assert.deepEqual(h.requests.map(body => body.image), ['shared-pixels']);
});

test('an invalidated merge finishing last cannot replace the current image', async () => {
    let finishOld;
    const old = new Promise(resolve => { finishOld = resolve; });
    const h = makeHarness(number => number === 1 ? old : Promise.resolve('fresh'));
    const pending = h.preview();
    h.context.clearClipMergedSourcePreviewCache();
    assert.equal(await h.merge(), 'fresh');
    finishOld('outdated');
    await pending;
    assert.equal(await h.merge(), 'fresh');
    assert.equal(h.count(), 2);
});

test('a failed merge is retried on the next request', async () => {
    const h = makeHarness(async number => {
        if (number === 1) throw new Error('synthetic decode failure');
        return 'retried';
    });
    await assert.rejects(h.merge(), /synthetic decode failure/);
    assert.equal(await h.merge(), 'retried');
    assert.equal(h.count(), 2);
});

test('changed visibility, order and placement each produce a new composite', async () => {
    const h = makeHarness(async number => number);
    const layer = h.results[1];
    const edits = [
        () => { h.results[0].visible = false; },
        () => h.results.reverse(),
        () => { layer.x += 10; },
        () => { layer.rotation += 15; },
        () => { h.base.x += 20; },
        () => { h.base.y += 15; },
        () => { h.base.layerWidth *= 2; },
        () => { h.base.layerHeight *= 2; }
    ];
    assert.equal(await h.merge(), 1);
    for (const [index, edit] of edits.entries()) {
        edit();
        assert.equal(await h.merge(), index + 2, edit.toString());
        assert.equal(await h.merge(), index + 2, 'reuse unchanged pixels');
    }
});

function drawingHarness() {
    const h = makeHarness();
    h.base.rotation = 0;
    h.results.forEach(layer => { layer.rotation = 0; });
    const loads = [], copies = [];
    let generated = 0;
    Object.assign(h.context, {
        document: {createElement() {
            const pixels = [];
            return {pixels, getContext: () => ({
                clearRect() {},
                drawImage(image, ...box) {
                    if (image.pixels) {
                        copies.push(image);
                        assert.deepEqual(box.slice(0, 2), [0, 0]);
                        if (box.length > 2) assert.deepEqual(box.slice(2), [image.width, image.height]);
                        pixels.push(...image.pixels);
                    } else {
                        pixels.push([image.src, ...box]);
                    }
                }
            }), toBlob: callback => callback(pixels)};
        }},
        loadImageElementForClip: async src => { loads.push(src); return {src}; },
        CanvasImageClipboard: {toDataUrl: async pixels => JSON.stringify(pixels)},
        CanvasSelectionRotation: require('../static/canvas_selection_rotation'),
        layerIdSeq: 100, checkedSelectionId: h.selection.id,
        normalizePromptInfo: info => info, getOrCreateSelectionInpaintFolder: () => h.selection.children[1],
        migrateAllSelectionClipsToSharedPromptOwner() {}, renderLayerList() {}, renderCanvasLayersOnSurface() {},
        animateClipInpaintResult() {}, saveCanvasState() {}, alert(message) { assert.fail(message); },
        async fetch(_, options) {
            h.requests.push(JSON.parse(options.body));
            return {ok: true, json: async () => ({status: 'success', src: `/new-${++generated}.png`})};
        }
    });
    vm.runInContext(extract('renderMergedClipSourceToDataUrl'), h.context);
    const visibleSources = () => [h.base.src, ...h.results.filter(layer => layer.visible).reverse().map(layer => layer.src)];
    return {...h, loads, copies, visibleSources};
}

test('consecutive successful merged inpaints draw only the newly added top result', async () => {
    const h = drawingHarness();
    const initialSources = h.visibleSources();
    await h.submit();
    assert.deepEqual(h.loads.splice(0), initialSources);
    assert.equal(h.results.length, 25);
    for (let number = 1; number <= 2; number++) {
        const sources = h.visibleSources();
        await h.submit();
        assert.deepEqual(h.loads.splice(0), [`/new-${number}.png`]);
        assert.equal(h.copies.length, number);
        assert.deepEqual(JSON.parse(h.requests.at(-1).image).map(([src]) => src), sources);
        assert.equal(h.results.length, 25 + number);
    }
});

test('editing the composited prefix rebuilds the visible layers in canvas order', async () => {
    const h = drawingHarness();
    await h.merge();
    for (const edit of [
        () => h.results.splice(8, 0, {...h.results[0], id: 88, src: '/middle.png'}),
        () => h.results.reverse(),
        () => { h.results[4].x += 10; },
        () => { h.base.layerWidth += 20; },
        () => h.results.splice(5, 1),
        () => { h.results[2].visible = false; },
        () => h.context.clearClipMergedSourcePreviewCache()
    ]) {
        h.loads.length = 0;
        edit();
        const image = await h.merge();
        assert.deepEqual(h.loads, h.visibleSources());
        assert.deepEqual(JSON.parse(image).map(([src]) => src), h.visibleSources());
    }
});

test('an expanded result at the canvas origin maps into the resized base clip in pixel coordinates', async () => {
    const h = drawingHarness();
    const layer = h.results[0];
    Object.assign(layer, {x: 0, y: 0, layerWidth: 128, layerHeight: 64});
    const overlay = JSON.parse(await h.merge()).find(([src]) => src === layer.src);
    assert.deepEqual(overlay, [layer.src, -50, -100, 256, 128]);
});

test('a superseded image load cannot replace the next reusable composite', async () => {
    const h = drawingHarness();
    await h.merge();
    let finishOld;
    const slow = new Promise(resolve => { finishOld = resolve; });
    const load = h.context.loadImageElementForClip;
    h.context.loadImageElementForClip = src => src === '/old.png' ? slow : load(src);
    h.results.unshift({...h.results[0], id: 90, src: '/old.png'});
    const pending = h.merge();
    h.results[0].src = '/current.png';
    const latest = await h.merge();
    finishOld({src: '/old.png'});
    await pending;
    assert.equal(await h.merge(), latest);
    h.loads.length = 0;
    h.results.unshift({...h.results[0], id: 91, src: '/next.png'});
    const next = await h.merge();
    assert.deepEqual(h.loads, ['/next.png']);
    assert.deepEqual(JSON.parse(next).map(([src]) => src), h.visibleSources());
});

test('retrying a failed suffix never duplicates a layer that drew before the failure', async () => {
    const h = drawingHarness();
    await h.merge();
    h.results.unshift({...h.results[0], id: 93, src: '/last.png'}, {...h.results[0], id: 92, src: '/first.png'});
    const load = h.context.loadImageElementForClip;
    h.context.loadImageElementForClip = async src => {
        if (src === '/last.png') throw new Error('synthetic load failure');
        return load(src);
    };
    await assert.rejects(h.merge(), /synthetic load failure/);
    h.context.loadImageElementForClip = load;
    const retried = await h.merge();
    assert.deepEqual(JSON.parse(retried).map(([src]) => src), h.visibleSources());
});

test('boundary renders the working clip at the selection depth, under foreground layers', async () => {
    let nextId = 1;
    const image = (src, fields = {}) => ({id: nextId++, type: 'image', src, visible: true,
        x: 0, y: 0, imageWidth: 64, imageHeight: 64, layerWidth: 64, layerHeight: 64, ...fields});
    const base = image('base', {type: 'clip'});
    const result = id => image(id, {type: 'clip', renderOnCanvas: true});
    const original = result('old-result');
    const patch = {...result('transparent-patch'), boundaryBaseClipId: base.id, boundaryAnchorId: original.id};
    const next = {...result('next-patch'), boundaryBaseClipId: base.id, boundaryAnchorId: original.id, rotation: 90};
    const selection = {type: 'selection', visible: true, children: [
        // An original clip is normally absent from the stack, even after moving its row to the top.
        base, next, image('inside-front'), patch, original, result('another-result')
    ]};
    const group = {type: 'folder', visible: true, children: [selection, image('behind-group')]};
    const layers = [image('foreground'), image('reference', {pinnedReference: true}),
        image('outside', {x: 999}), image('hidden', {visible: false}), group, image('background')];
    const loads = [];
    const composite = vm.createContext({
        canvasLayers: layers, currentCanvasWidth: 1024, currentCanvasHeight: 512,
        CanvasSelectionRotation: require('../static/canvas_selection_rotation'),
        rectsIntersect: (x, y, w, h, a, b, c, d) => x < a + c && a < x + w && y < b + d && b < y + h,
        document: {createElement() {
            const draws = [], rotations = [];
            return {draws, rotations, getContext: () => ({scale() {}, translate() {}, save() {}, restore() {},
                rotate(radians) { rotations.push(radians); }, drawImage(img) { draws.push(img.src); }})};
        }}
    });
    vm.runInContext(fs.readFileSync(require.resolve('../static/canvas_composite.js'), 'utf8'), composite);
    composite.loadImageElementForClip = async src => { loads.push(src); return {src}; };
    const rect = {x: 0, y: 0, width: 64, height: 64};
    for (const [merged, anchor, middle] of [
        [true, base, ['base', 'another-result', 'old-result', 'transparent-patch', 'inside-front', 'next-patch']],
        [false, base, ['base', 'transparent-patch', 'inside-front', 'next-patch']],
        [false, original, ['old-result', 'transparent-patch', 'inside-front', 'next-patch']],
        [false, patch, ['old-result', 'transparent-patch', 'inside-front', 'next-patch']]
    ]) {
        const render = composite.createClipBoundarySource(selection, base, anchor, merged);
        const expected = ['background', 'behind-group', ...middle, 'foreground'];
        const preview = await render(rect, 32);
        assert.deepEqual(preview.draws, expected);
        assert.deepEqual(preview.rotations, [Math.PI / 2]);
        assert.deepEqual(loads.splice(0), expected);
        const request = await render(rect);
        assert.deepEqual(request.draws, expected);
        assert.deepEqual(loads, [], 'preview and crop share decoded sources');
    }
    // A remaining visible result can itself be the editable clip if its original was deleted.
    base.renderOnCanvas = true;
    const fallback = await composite.createClipBoundarySource(selection, base, base, true)(rect);
    assert.deepEqual(fallback.draws, ['background', 'behind-group', 'another-result', 'old-result',
        'transparent-patch', 'inside-front', 'next-patch', 'base', 'foreground']);
    group.visible = false;
    const hidden = await composite.createClipBoundarySource(selection, base, base, true)(rect);
    assert.deepEqual(hidden.draws, ['background', 'foreground']);
});
