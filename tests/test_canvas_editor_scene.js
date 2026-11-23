const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SCENE_SOURCE = fs.readFileSync('static/canvas_editor_scene.js', 'utf8');
const WIDTH = 4000;
const HEIGHT = 4000;

class FakeCanvasContext {
    constructor(canvas) { this.canvas = canvas; this.draws = []; }
    setTransform() {}
    save() {}
    restore() {}
    translate() {}
    rotate() {}
    clearRect() {}
    drawImage(...args) { this.draws.push(args); }
}

class FakeNode {
    constructor(document, tagName) {
        this.ownerDocument = document;
        this.tagName = tagName;
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.parentNode = null;
        this.classList = {toggle() {}};
    }
    getContext() { return this.context ||= new FakeCanvasContext(this); }
    prepend(child) {
        if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(item => item !== child);
        this.children.unshift(child);
        child.parentNode = this;
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this);
        this.parentNode = null;
    }
    querySelector() { return this.image; }
}

class FakeDocument {
    createElement(tagName) { return new FakeNode(this, tagName); }
}

function makeImage(src) {
    return {
        complete: true,
        naturalWidth: WIDTH,
        naturalHeight: HEIGHT,
        src,
        getAttribute(name) { return name === 'src' ? this.src : null; },
        addEventListener() {},
    };
}

function makeLayer(index) {
    const id = String(index + 1);
    const src = `/image/tile-${index}.png`;
    return {id, type: 'image', src, x: 0, y: 0, layerWidth: WIDTH, layerHeight: HEIGHT,
        imageWidth: WIDTH, imageHeight: HEIGHT, rotation: 0, visible: true};
}

function makeEnvironment({sourceTiles = false, imageDecode, perf = performance} = {}) {
    const document = new FakeDocument();
    const surface = new FakeNode(document, 'surface');
    const workspace = new FakeNode(document, 'workspace');
    const state = {views: [], requests: []};
    const context = {
        CanvasEditorView: {
            create(options) {
                const view = {
                    tiles: options.tiles,
                    overview: options.overview,
                    paused: [],
                    clears: 0,
                    retained: 0,
                    retainDetail() { this.retained += 1; },
                    destroyed: false,
                    schedule() {},
                    present() {},
                    setPaused(value) { this.paused.push(value); },
                    clear() { this.clears += 1; },
                    destroy() { this.destroyed = true; },
                    stats() { return {bytes: 0, ownsDisplay: true}; },
                };
                state.views.push(view);
                return view;
            },
        },
        CanvasSourceTilesAvailable: sourceTiles,
        WebGL2RenderingContext: class FakeWebGL2RenderingContext {},
        ResizeObserver: class FakeResizeObserver {},
        document,
        performance: perf,
        AbortController,
        setTimeout,
        clearTimeout,
        fetch: async (_url, request) => {
            state.requests.push(JSON.parse(request.body));
            return {ok: true, blob: async () => ({size: 32})};
        },
    };
    context.createImageBitmap = async () => ({width: 514, height: 514 * 4, close() {}});
    vm.runInNewContext(SCENE_SOURCE, context, {filename: 'static/canvas_editor_scene.js'});
    return {
        scene: context.CanvasEditorScene,
        surface,
        workspace,
        state,
        attach(layers) {
            surface.nodes = layers.map(layer => {
                const node = new FakeNode(document, 'layer');
                node.dataset.layerId = layer.id;
                node.image = makeImage(layer.src);
                if (imageDecode) node.image.decode = imageDecode;
                return node;
            });
            surface.querySelectorAll = () => surface.nodes;
        },
        refresh(layers, options = {}) {
            this.attach(layers);
            this.scene.refresh({surface, workspace, width: WIDTH, height: HEIGHT, layers, paused: false, ...options});
            return state.views.at(-1);
        },
    };
}

function tileBox() { return {x: 0, y: 0, width: 16, height: 16}; }
function pause() { return new Promise(resolve => setImmediate(resolve)); }

async function testLocalSceneCacheAndStaging() {
    const env = makeEnvironment();
    const layers = [makeLayer(0), makeLayer(1), makeLayer(2)];
    const view = env.refresh(layers);
    const original = view.tiles(tileBox(), 1)[0];
    assert.ok(original, 'the initial local composite builds its visible tile');
    const clearsBeforeToggle = view.clears;
    const pauseCountBeforeToggle = view.paused.length;

    env.refresh(layers.slice(1));
    assert.equal(view.clears, clearsBeforeToggle, 'hiding a layer keeps the displayed GPU frame during staging');
    assert.equal(view.paused.slice(pauseCountBeforeToggle).includes(true), false,
        'visibility changes do not yield ownership to the DOM fallback');
    const hidden = view.tiles(tileBox(), 1)[0];
    assert.ok(hidden && hidden !== original, 'the hidden-layer scene gets its own composite tile');

    env.refresh(layers);
    assert.equal(view.tiles(tileBox(), 1)[0], original,
        'showing the same layers again reuses their cached CPU tile object');
    assert.equal(view.clears, clearsBeforeToggle, 'showing a cached visibility scene does not clear the view');

    env.scene.refresh({surface: env.surface, workspace: env.workspace, width: WIDTH, height: HEIGHT,
        layers: [], paused: false});
    assert.equal(view.destroyed, true, 'an empty drawable scene immediately returns ownership to the DOM');
}

async function testSourceAtlasReuseForVisibilitySubset() {
    const env = makeEnvironment({sourceTiles: true});
    const layers = [0, 1, 2, 3].map(makeLayer);
    layers[1].type = 'clip';
    const view = env.refresh(layers);
    view.tiles(tileBox(), 1);
    await pause();
    await pause();
    const original = view.tiles(tileBox(), 1)[0];
    assert.ok(original, 'the source tile becomes available after its atlas response');
    assert.equal(env.state.requests.length, 1);
    const clearsBeforeToggle = view.clears;

    env.refresh(layers.filter(layer => layer.id !== '2'), {toggledClipId: 2});
    assert.equal(view.retained, 1, 'a full-size clip retains the sharp frame through remote compositing');
    assert.equal(view.clears, clearsBeforeToggle, 'a source-backed visibility change keeps the old frame staged');
    assert.equal(env.scene.usesTiledSource(layers[0]), true,
        'the current subset keeps source-tile DOM ownership for its visible layers');
    assert.equal(env.scene.usesTiledSource(layers[1]), false,
        'the hidden source is not marked as a visible DOM tile layer');
    assert.equal(env.scene.showsSourceThumbnail(layers[0]), true,
        'the first visible source remains the fallback thumbnail during staging');
    const hiddenImmediately = view.tiles(tileBox(), 1)[0];
    assert.ok(hiddenImmediately,
        'a decoded atlas replaces the old visibility composite synchronously in the GPU render pass');
    await pause();
    await pause();
    const hidden = view.tiles(tileBox(), 1)[0];
    assert.ok(hidden, 'the hidden-layer composite becomes available');
    assert.equal(env.state.requests.length, 1,
        'a visibility subset reuses the retained source atlas without another request');
    assert.deepEqual(hidden.canvas.getContext().draws.map(args => args[2]), [0, 1028, 1542],
        'the hidden source band is skipped while the remaining straight-RGBA bands composite in order');

    env.refresh(layers);
    assert.equal(view.tiles(tileBox(), 1)[0], original,
        'showing the prior visibility set reuses its exact source-composite tile');
    assert.equal(env.state.requests.length, 1, 'show and hide reuse the original source-tile atlas');
    assert.equal(view.clears, clearsBeforeToggle, 'the repeated toggle preserves view ownership and caches');
}

function testImageAndFolderVisibilityRetainDetail() {
    const layers = [0, 1, 2, 3].map(makeLayer);
    for (const sourceTiles of [false, true]) {
        const env = makeEnvironment({sourceTiles});
        const view = env.refresh(layers);
        // An image removes one drawable. A folder can remove several at once.
        for (const next of [layers.slice(1), layers, layers.slice(2), layers]) {
            env.refresh(next, {visibilityChanged: true});
        }
        assert.equal(view.retained, 4, 'eye toggles keep the sharp frame until the new stack is ready');
        env.refresh(layers.slice(1));
        assert.equal(view.retained, 4, 'ordinary stack edits do not request a sharp-frame hold');
    }
}

async function testDecodeRejectionUsesCanvasDrawPath() {
    const env = makeEnvironment({imageDecode: async () => {throw new Error('decode unavailable');}});
    const view = env.refresh([makeLayer(0)]);
    await pause();
    const tile = view.tiles(tileBox(), 1)[0];
    assert.ok(tile, 'a rejected decode falls back to the existing budgeted drawImage path');
    assert.equal(view.paused.at(-1), false, 'a decode rejection does not strand the GPU scene paused');
}

async function testLocalTileBuildProgressSurvivesFrames() {
    let clock = 0;
    const env = makeEnvironment({perf: {now() {clock += 5; return clock;}}});
    const layers = [0, 1, 2].map(makeLayer);
    const view = env.refresh(layers);
    let tile;
    for (let frame = 0; frame < 5 && !tile; frame += 1) tile = view.tiles(tileBox(), 1)[0];
    assert.ok(tile, 'the same CPU tile finishes across bounded render passes');
    assert.ok(env.scene.stats().cpu.buildYields >= 2,
        'the per-layer work remains cached between frames instead of restarting');
}

function testGeneratedClipAppend() {
    const env = makeEnvironment({perf: {now: () => 0}});
    const old = Array.from({length: 120}, (_, i) => makeLayer(i));
    const clip = {...makeLayer(120), type: 'clip', x: 100, y: 200, layerWidth: 96, layerHeight: 80, rotation: 15};
    const next = [...old, clip];
    const view = env.refresh(old);
    const complete = view.tiles(tileBox(), 1)[0];
    const coarse = view.overview();
    const distantBox = {...tileBox(), x: 3000};
    const distant = view.tiles(distantBox, 1)[0];
    const clears = view.clears;
    const pauseCount = view.paused.length;
    env.refresh(next, {appendedClipId: Number(clip.id)});
    assert.equal(view.clears, clears, 'the current GPU frame stays visible while its replacement is prepared');
    assert.equal(view.paused.slice(pauseCount).includes(true), false);
    const updated = view.tiles(tileBox(), 1)[0];
    const appendedImage = env.surface.nodes.at(-1).image;
    for (const [tile, base] of [[updated, complete], [view.overview(), coarse]]) {
        const draws = tile.canvas.getContext().draws;
        assert.deepEqual(draws[0], [base.canvas, 0, 0]);
        assert.deepEqual(draws[1], [appendedImage, -48, -40, 96, 80]);
        assert.equal(draws.length, 2);
        assert.equal(base.canvas.getContext().draws.length, old.length);
    }
    assert.equal(view.tiles(distantBox, 1)[0].canvas, distant.canvas);
    assert.equal(view.tiles({...tileBox(), y: 3000}, 1)[0].canvas.getContext().draws.length, old.length,
        'a missing seed tile draws every intersecting old layer');
    const second = {...clip, id: '122', src: '/image/second.png'};
    env.refresh([...next, second], {appendedClipId: second.id});
    assert.deepEqual(view.tiles(tileBox(), 1)[0].canvas.getContext().draws.map(draw => draw[0]),
        [updated.canvas, env.surface.nodes.at(-1).image]);
}

function testOnlyAnUnchangedLocalPrefixCanSeedAnAppend() {
    const old = [makeLayer(0), makeLayer(1)];
    const clip = {...makeLayer(2), type: 'clip'};
    for (const [label, next, id] of [
        ['reordered', [old[1], old[0], clip], clip.id],
        ['inserted between layers', [old[0], clip, old[1]], clip.id],
        ['moved', [{...old[0], x: 5}, old[1], clip], clip.id],
        ['replaced pixels', [{...old[0], src: '/image/edited.png'}, old[1], clip], clip.id],
        ['different result', [...old, clip], 999],
        ['missing generation hint', [...old, clip], undefined],
    ]) {
        const env = makeEnvironment({perf: {now: () => 0}});
        const view = env.refresh(old);
        view.tiles(tileBox(), 1);
        env.refresh(next, {appendedClipId: id});
        const draws = view.tiles(tileBox(), 1)[0].canvas.getContext().draws;
        assert.deepEqual(draws.map(args => args[0]), env.surface.nodes.map(node => node.image), label);
    }
}

function testClipVisibilityChangesOnlyIntersectingTiles() {
    const env = makeEnvironment({perf: {now: () => 0}});
    const base = makeLayer(0), upper = makeLayer(2);
    // Rotation extends into the first tile's one-pixel gutter, without covering its interior.
    const clip = {...makeLayer(1), type: 'clip', x: 1030.5, y: 20, layerWidth: 4, layerHeight: 16, rotation: 90};
    const layers = [base, clip, upper];
    const view = env.refresh(layers);
    const tileAt = x => view.tiles({...tileBox(), x}, 1)[0];
    const first = tileAt(0), middle = tileAt(1024), far = tileAt(2048);
    const bytes = env.scene.stats().cpu.bytes;
    env.refresh([base, upper], {toggledClipId: Number(clip.id)});
    assert.equal(tileAt(2048), far, 'unaffected CPU and GPU tiles keep their identity');
    assert.equal(env.scene.stats().cpu.bytes, bytes, 'moving a tile does not charge a second backing store');
    for (const [x, previous] of [[0, first], [1024, middle]]) {
        const tile = tileAt(x);
        assert.notEqual(tile, previous, 'the rotated clip and its sampling gutter are invalidated');
        assert.deepEqual(tile.canvas.getContext().draws.map(draw => draw[0].src), [base.src, upper.src]);
    }
    env.refresh(layers, {toggledClipId: clip.id});
    assert.equal(tileAt(2048), far);
    assert.equal(tileAt(0), first);
    assert.equal(tileAt(1024), middle);
    assert.equal(view.retained, 2);

    // Append after a transfer while the retained tile's original scene is not the lookup key.
    env.refresh([base, upper], {toggledClipId: clip.id});
    const extra = {...clip, id: '4'};
    const beforeAppend = env.scene.stats().cpu.bytes;
    env.refresh([base, upper, extra], {appendedClipId: extra.id});
    assert.equal(tileAt(2048).canvas, far.canvas);
    assert.equal(env.scene.stats().cpu.bytes, beforeAppend);
}

function testClipVisibilityHintsValidateTheRestOfTheStack() {
    const base = makeLayer(0), upper = makeLayer(2);
    const clip = {...makeLayer(1), type: 'clip', layerWidth: 100, layerHeight: 80};
    for (const [label, next, id] of [
        ['wrong ID', [base, upper], upper.id],
        ['changed order', [upper, base], clip.id],
        ['changed position', [base, {...upper, x: 10}], clip.id],
        ['changed source', [{...base, src: '/image/other.png'}, upper], clip.id],
        ['image instead of clip', [clip, upper], base.id],
    ]) {
        const env = makeEnvironment({perf: {now: () => 0}});
        const view = env.refresh([base, clip, upper]);
        const box = {...tileBox(), x: 2048};
        const original = view.tiles(box, 1)[0];
        env.refresh(next, {toggledClipId: id});
        assert.notEqual(view.tiles(box, 1)[0], original, label);
        assert.equal(view.retained, 0, label);
    }
}

function testPartialClipSwitchesBetweenLocalAndSourceTiles() {
    const env = makeEnvironment({sourceTiles: true});
    const base = [0, 1, 2, 3].map(makeLayer);
    const clip = {...makeLayer(4), type: 'clip', layerWidth: 100, layerHeight: 80};
    const view = env.refresh([...base, clip]);
    for (const layers of [base, [...base, clip]]) {
        env.refresh(layers, {toggledClipId: clip.id});
        assert.equal(Boolean(env.scene.usesTiledSource(base[0])), layers === base);
    }
    assert.equal(view.retained, 2, 'both source-plan changes keep the last sharp frame');
}

function testIncompleteAndPausedTilesAreNotSeeds() {
    const old = [makeLayer(0), makeLayer(1)];
    const clip = {...makeLayer(2), type: 'clip'};
    const layers = [...old, clip];
    let ticks = 0;
    const env = makeEnvironment({perf: {now() {ticks += 5; return ticks;}}});
    const view = env.refresh(old);
    assert.equal(view.tiles(tileBox(), 1).partial.length, 0);
    env.refresh(layers, {appendedClipId: clip.id});
    let tile;
    for (let i = 0; i < 6 && !tile; i++) tile = view.tiles(tileBox(), 1)[0];
    assert.deepEqual(tile.canvas.getContext().draws.map(args => args[0]), env.surface.nodes.map(node => node.image));

    env.scene.pause(true);
    const more = {...clip, id: '4'};
    env.refresh([...layers, more], {appendedClipId: more.id});
    let resumed;
    for (let i = 0; i < 6 && !resumed; i++) resumed = view.tiles(tileBox(), 1)[0];
    assert.deepEqual(resumed.canvas.getContext().draws.map(args => args[0]), env.surface.nodes.map(node => node.image));
}

(async () => {
    await testLocalSceneCacheAndStaging();
    await testSourceAtlasReuseForVisibilitySubset();
    testImageAndFolderVisibilityRetainDetail();
    await testDecodeRejectionUsesCanvasDrawPath();
    await testLocalTileBuildProgressSurvivesFrames();
    testGeneratedClipAppend();
    testClipVisibilityChangesOnlyIntersectingTiles();
    testClipVisibilityHintsValidateTheRestOfTheStack();
    testPartialClipSwitchesBetweenLocalAndSourceTiles();
    testOnlyAnUnchangedLocalPrefixCanSeedAnAppend();
    testIncompleteAndPausedTilesAreNotSeeds();
    process.stdout.write('canvas editor scene visibility cache tests passed\n');
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
