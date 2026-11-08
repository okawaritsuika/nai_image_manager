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
        refresh(layers) {
            this.attach(layers);
            this.scene.refresh({surface, workspace, width: WIDTH, height: HEIGHT, layers, paused: false});
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
    const view = env.refresh(layers);
    view.tiles(tileBox(), 1);
    await pause();
    await pause();
    const original = view.tiles(tileBox(), 1)[0];
    assert.ok(original, 'the source tile becomes available after its atlas response');
    assert.equal(env.state.requests.length, 1);
    const clearsBeforeToggle = view.clears;

    env.refresh(layers.filter(layer => layer.id !== '2'));
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

(async () => {
    await testLocalSceneCacheAndStaging();
    await testSourceAtlasReuseForVisibilitySubset();
    await testDecodeRejectionUsesCanvasDrawPath();
    await testLocalTileBuildProgressSurvivesFrames();
    process.stdout.write('canvas editor scene visibility cache tests passed\n');
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
