const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {performance} = require('node:perf_hooks');
const {test} = require('node:test');

const VIEW_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'static', 'canvas_editor_view.js'), 'utf8');
const WIDTH = 1000;
const HEIGHT = 1000;

class FakeNode {
    constructor(ownerDocument, tagName = 'div') {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.children = [];
        this.parentNode = null;
        this.listeners = new Map();
        this.attributes = new Map();
        this.className = '';
        this.hidden = false;
        this.width = 0;
        this.height = 0;
    }
    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type, event = {}) {
        for (const callback of [...(this.listeners.get(type) || [])]) callback({type, ...event});
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

function makeEnvironment() {
    const events = [];
    const sprites = [];
    const modeChanges = [];
    const observers = [];
    const rafQueue = new Map();
    let nextRaf = 1;
    let nextSprite = 1;
    let currentScale = 1;
    let activeApp;
    const fallback = [];

    class FakeDocument {
        createElement(tagName) { return new FakeNode(this, tagName); }
    }
    const document = new FakeDocument();
    const host = new FakeNode(document);
    const workspace = new FakeNode(document);
    const rect = () => {
        const size = WIDTH * currentScale;
        return {left: 0, top: 0, right: size, bottom: size, width: size, height: size};
    };
    host.getBoundingClientRect = rect;
    workspace.getBoundingClientRect = rect;
    Object.defineProperties(workspace, {
        clientWidth: {get: () => WIDTH * currentScale},
        clientHeight: {get: () => HEIGHT * currentScale},
    });
    workspace.clientLeft = 0;
    workspace.clientTop = 0;

    class FakeWebGL2RenderingContext {}
    class FakeResizeObserver {
        constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
        observe(target) { this.targets.push(target); }
        disconnect() { this.disconnected = true; }
    }
    class Container {
        constructor() {
            this.children = [];
            this.parent = null;
            this.position = {set: (x, y) => { this.x = x; this.y = y; }};
            this.scale = {set: (x, y) => { this.scaleX = x; this.scaleY = y; }};
        }
        addChild(child) {
            if (child.parent) child.parent.removeChild(child);
            this.children.push(child);
            child.parent = this;
            return child;
        }
        removeChild(child) {
            const index = this.children.indexOf(child);
            if (index >= 0) this.children.splice(index, 1);
            child.parent = null;
            return child;
        }
        removeChildren() {
            const children = this.children.splice(0);
            for (const child of children) child.parent = null;
            return children;
        }
    }
    class CanvasSource {
        constructor({resource}) {
            this.resource = resource;
            resource._source = this;
            this._scaleMode = undefined;
        }
        get scaleMode() { return this._scaleMode; }
        set scaleMode(value) {
            if (value !== this._scaleMode) {
                this._scaleMode = value;
                const change = {key: this.resource._debugKey, value};
                modeChanges.push(change);
                events.push({type: 'scaleMode', ...change});
            }
        }
        update() { events.push({type: 'upload', resource: this.resource}); }
    }
    class Texture {
        constructor({source, frame}) { this.source = source; this.frame = frame; }
    }
    class Rectangle {
        constructor(x, y, width, height) { Object.assign(this, {x, y, width, height}); }
    }
    class Sprite {
        constructor({texture}) {
            this.texture = texture;
            this.parent = null;
            this.position = {set: (x, y) => { this.x = x; this.y = y; }};
            this.id = nextSprite++;
            this.destroyed = false;
            sprites.push(this);
        }
        destroy(options) {
            if (this.destroyed) return;
            this.destroyed = true;
            this.destroyOptions = options;
            if (this.parent) this.parent.removeChild(this);
            events.push({type: 'spriteDestroy', sprite: this, options});
        }
    }
    class Application {
        constructor() {
            this.stage = new Container();
            this.canvas = document.createElement('canvas');
            this.renderer = null;
            this.renderCount = 0;
            activeApp = this;
        }
        async init() {
            this.renderer = {
                gl: new FakeWebGL2RenderingContext(),
                resize: (width, height, resolution) => events.push({type: 'resize', width, height, resolution}),
            };
        }
        render() {
            this.renderCount += 1;
            events.push({type: 'render', app: this});
        }
        destroy(options = {}, rendererOptions = {}) {
            events.push({type: 'appDestroy', options, rendererOptions});
            this.stage.removeChildren();
            if (options.removeView) this.canvas.remove();
            this.renderer = null;
        }
    }

    const PIXI = {Application, Container, CanvasSource, Texture, Rectangle, Sprite};
    const context = {
        document,
        PIXI,
        WebGL2RenderingContext: FakeWebGL2RenderingContext,
        ResizeObserver: FakeResizeObserver,
        devicePixelRatio: 1,
        performance,
        requestAnimationFrame(callback) {
            const id = nextRaf++;
            rafQueue.set(id, callback);
            return id;
        },
        cancelAnimationFrame(id) { rafQueue.delete(id); events.push({type: 'rafCancel', id}); },
    };
    vm.runInNewContext(VIEW_SOURCE, context, {filename: 'static/canvas_editor_view.js'});

    return {
        events, sprites, modeChanges, observers, rafQueue, fallback, host, workspace,
        get app() { return activeApp; },
        CanvasEditorView: context.CanvasEditorView,
        setScale(scale) { currentScale = scale; },
        flushOne() {
            const next = rafQueue.entries().next().value;
            assert.ok(next, 'an animation frame was scheduled');
            const [id, callback] = next;
            rafQueue.delete(id);
            callback(0);
        },
    };
}

function makeTile(env, {key, x = 0, y = 0, width = WIDTH, height = HEIGHT, lod = 1,
    revision = 1, overview = false}) {
    const canvas = env.host.ownerDocument.createElement('canvas');
    canvas.width = Math.ceil(width / lod);
    canvas.height = Math.ceil(height / lod);
    canvas._debugKey = key;
    const tile = {key, x, y, width, height, lod, revision, canvas};
    canvas._tile = tile;
    if (overview) {
        tile.fillTexture = (resource, requestedLod) => {
            env.events.push({type: 'overviewFill', resource, requestedLod, tile});
        };
    }
    return tile;
}

function fourTiles(env, lod, revision = 1) {
    return [
        makeTile(env, {key: `lod-${lod}-tl`, x: 0, y: 0, width: 500, height: 500, lod, revision}),
        makeTile(env, {key: `lod-${lod}-tr`, x: 500, y: 0, width: 500, height: 500, lod, revision}),
        makeTile(env, {key: `lod-${lod}-bl`, x: 0, y: 500, width: 500, height: 500, lod, revision}),
        makeTile(env, {key: `lod-${lod}-br`, x: 500, y: 500, width: 500, height: 500, lod, revision}),
    ];
}

function assertFullCoverage(tiles, width = WIDTH, height = HEIGHT) {
    const cells = tiles.map(({x, y, width: tileWidth, height: tileHeight}) => ({x, y, width: tileWidth, height: tileHeight}));
    assert.equal(cells.reduce((area, tile) => area + tile.width * tile.height, 0), width * height,
        'the selected tiles cover the full document area');
    for (const y of [0, 499, 500, 999]) {
        for (const x of [0, 499, 500, 999]) {
            assert.equal(cells.filter(tile => x >= tile.x && x < tile.x + tile.width
                && y >= tile.y && y < tile.y + tile.height).length, 1,
            `document point ${x},${y} has exactly one covering tile`);
        }
    }
}

test('a missing tile at the current LOD leaves existing native sprites intact', async () => {
    const env = makeEnvironment();
    const coarse = {...makeTile(env, {key: 'scene/overview', lod: 4}), overview: true};
    const full = fourTiles(env, 1);
    let incomplete = false;
    const view = env.CanvasEditorView.create({host: env.host, workspace: env.workspace,
        width: WIDTH, height: HEIGHT, overview: () => coarse,
        tiles: () => incomplete ? {partial: full.slice(0, 3), bounds: full} : full,
        setFallback: value => env.fallback.push(value)});
    await settleInitialization(env, view);
    const original = env.app.stage.children[0].children.slice();
    incomplete = true;
    view.present();
    const current = env.app.stage.children[0].children.slice();
    assert.deepEqual(current.slice(0, 3), original.slice(0, 3));
    assert.equal(current[3].texture.source.resource, coarse.canvas);
    assert.equal(current[3].x, 500);
    assert.equal(current[3].y, 500);
    assert.equal(view.stats().displayedLod, 1);
    assert.equal(view.stats().lodChanges, 0);
    assert.equal(view.stats().partialFrames, 1);
    assert.deepEqual(env.fallback, [false]);
    view.destroy();
});

async function settleInitialization(env, view) {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(env.rafQueue.size, 'Pixi initialization schedules its first frame');
    env.flushOne();
    assert.ok(view.stats().frames > 0, 'the first frame was submitted to the renderer');
}

test('a revised visible tile uploads its brush patch in the same presented frame', async () => {
    const env = makeEnvironment();
    const tile = makeTile(env, {key: 'brush-patch', revision: 1});
    const view = env.CanvasEditorView.create({host: env.host, workspace: env.workspace,
        width: WIDTH, height: HEIGHT, tiles: () => [tile], setFallback() {}});
    await settleInitialization(env, view);
    const initialFrames = view.stats().frames;
    const initialUploads = view.stats().uploads;
    const source = env.app.stage.children[0].children[0].texture.source;
    const start = env.events.length;

    tile.revision = 2;
    tile.damage = {from: 1, x: 4, y: 8, width: 16, height: 16};
    view.present();

    const update = env.events.slice(start);
    const uploadIndex = update.findIndex(event => event.type === 'upload');
    const renderIndex = update.findIndex(event => event.type === 'render');
    assert.ok(uploadIndex >= 0 && renderIndex > uploadIndex,
        'the updated tile source reaches the renderer before the next visible frame');
    assert.equal(view.stats().frames, initialFrames + 1,
        'present submits exactly one frame with the revised tile');
    assert.equal(view.stats().uploads, initialUploads + 1);
    assert.equal(env.app.stage.children[0].children[0].texture.source, source,
        'the existing GPU texture stays attached while the brush patch updates');
    assert.equal(source.resource, tile.canvas);
    view.destroy();
});

test('pending LOD swaps keep complete old coverage or the full overview presented, then retire GPU textures after render', async () => {
    const env = makeEnvironment();
    const calls = [];
    const oldTileResults = [];
    const targetTileResults = [];
    const state = {targetReady: false, oldReady: false};
    const overview = makeTile(env, {key: 'full-overview', lod: 4, overview: true});
    const view = env.CanvasEditorView.create({
        host: env.host,
        workspace: env.workspace,
        width: WIDTH,
        height: HEIGHT,
        tiles(box, lod, options) {
            calls.push({box: {...box}, lod, ...options});
            if (lod === 1 && state.targetReady) {
                const result = fourTiles(env, 1);
                targetTileResults.push(result);
                return result;
            }
            if (lod === 1) return null;
            if (lod === 4 && options.cachedOnly && state.oldReady) {
                const result = fourTiles(env, 4);
                oldTileResults.push(result);
                return result;
            }
            return null;
        },
        overview: () => overview,
        setFallback(value) { env.fallback.push(value); },
    });

    await settleInitialization(env, view);
    const canvas = env.host.children.find(node => node.className === 'canvas-editor-gpu-view');
    assert.ok(canvas);
    assert.equal(canvas.hidden, false);
    assert.equal(view.stats().displayedLod, 4);
    assert.equal(view.stats().overviewFrames, 1);
    assert.deepEqual(env.fallback, [false]);
    assert.ok(env.events.some(event => event.type === 'overviewFill' && event.tile === overview),
        'overview returns and uploads its complete tile object');
    assert.ok(calls.some(call => call.lod === 1 && call.cachedOnly === false));
    const overviewSprite = env.app.stage.children[0].children[0];

    const framesBeforePresent = view.stats().frames;
    view.present();
    assert.equal(view.stats().frames, framesBeforePresent + 1,
        'present immediately submits the currently available fallback while target tiles are pending');
    assert.equal(view.stats().displayedLod, 4);
    assert.equal(canvas.hidden, false);
    assert.ok(view.stats().waitingFrames >= 2);
    assert.ok(view.stats().overviewFrames >= 2);
    assert.ok(calls.some(call => call.lod === 1 && call.cachedOnly === true),
        'present asks for cached target tiles without blocking the current presentation');
    assert.equal(env.app.stage.children[0].children[0], overviewSprite,
        'the full overview sprite remains presented while both target and cached old-LOD tiles are unavailable');

    state.oldReady = true;
    view.schedule();
    env.flushOne();
    const oldCoverage = env.app.stage.children[0].children.slice();
    const oldTiles = oldTileResults.at(-1);
    assert.equal(oldCoverage.length, 4);
    assertFullCoverage(oldTiles);
    assert.equal(view.stats().displayedLod, 4);
    assert.equal(canvas.hidden, false);
    assert.deepEqual(env.fallback, [false], 'a complete cached old-LOD frame keeps GPU presentation owned');
    assert.ok(calls.some(call => call.lod === 4 && call.cachedOnly === true),
        'the pending target transition requests a cached-only complete frame at the displayed LOD');

    // Replacing same-key tile data while its sprites are displayed must defer texture destruction
    // until after the renderer has submitted the replacement frame.
    const replacementStart = env.events.length;
    view.schedule();
    env.flushOne();
    const replacementEvents = env.events.slice(replacementStart);
    const renderIndex = replacementEvents.findIndex(event => event.type === 'render');
    assert.ok(renderIndex >= 0, 'replacement is rendered');
    for (const oldSprite of oldCoverage) {
        const destroyedAt = replacementEvents.findIndex(event => event.type === 'spriteDestroy' && event.sprite === oldSprite);
        assert.ok(destroyedAt > renderIndex,
            `old sprite ${oldSprite.id} is destroyed only after app.render submits its replacement`);
    }
    assert.equal(view.stats().displayedLod, 4);
    assert.equal(canvas.hidden, false);

    state.targetReady = true;
    view.schedule();
    env.flushOne();
    const targetCoverage = targetTileResults.at(-1);
    assertFullCoverage(targetCoverage);
    assert.equal(env.app.stage.children[0].children.length, 4);
    assert.equal(view.stats().displayedLod, 1);
    assert.equal(view.stats().lodChanges, 1);
    assert.equal(canvas.hidden, false);
    assert.deepEqual(env.fallback, [false], 'the target frame replaces the old one without revealing fallback');

    view.setPaused(true);
    assert.equal(canvas.hidden, true);
    assert.deepEqual(env.fallback, [false, true], 'explicit pause yields presentation to the fallback');
    view.setPaused(false);
    assert.ok(env.rafQueue.size, 'unpausing schedules a fresh GPU frame');
    canvas.dispatch('webglcontextlost');
    assert.equal(env.rafQueue.size, 0, 'context loss cancels a queued frame');
    assert.equal(env.host.children.length, 0, 'destroy removes the GPU canvas from the host');
    assert.equal(env.app.renderer, null);
    assert.ok(env.events.some(event => event.type === 'appDestroy'));
    assert.ok(env.observers.every(observer => observer.disconnected));
    assert.equal(env.workspace.listeners.get('scroll')?.size || 0, 0);
    assert.equal(view.stats().bytes, 0);
    assert.ok(env.sprites.every(sprite => sprite.destroyed), 'destroy releases every cached and retired sprite');
    assert.equal(env.app.stage.children.length, 0);
    assert.equal(env.fallback.at(-1), true, 'context loss restores the fallback');
    view.schedule();
    assert.equal(env.rafQueue.size, 0, 'closed views cannot schedule more work');
});

test('LOD and sampling hysteresis keep the presented cache stable around their thresholds', async () => {
    const env = makeEnvironment();
    const tilesByLod = new Map();
    const view = env.CanvasEditorView.create({
        host: env.host,
        workspace: env.workspace,
        width: WIDTH,
        height: HEIGHT,
        tiles(_box, lod) {
            if (!tilesByLod.has(lod)) tilesByLod.set(lod, makeTile(env, {key: `stable-${lod}`, lod}));
            return [tilesByLod.get(lod)];
        },
        setFallback() {},
    });

    env.setScale(.51);
    await settleInitialization(env, view);
    assert.equal(view.stats().displayedLod, 1);
    for (const scale of [.49, .47, .49, .47]) {
        env.setScale(scale);
        view.schedule();
        env.flushOne();
        assert.equal(view.stats().displayedLod, 1, `scale ${scale} remains within the LOD-1 hysteresis band`);
    }
    assert.equal(view.stats().lodChanges, 0);

    env.setScale(.45);
    view.schedule();
    env.flushOne();
    assert.equal(view.stats().displayedLod, 2, 'the LOD changes only after crossing the lower hysteresis threshold');
    for (const scale of [.47, .53, .52, .47, .53]) {
        env.setScale(scale);
        view.schedule();
        env.flushOne();
        assert.equal(view.stats().displayedLod, 2, `scale ${scale} remains within the LOD-2 hysteresis band`);
    }
    assert.equal(view.stats().lodChanges, 1);

    env.setScale(.55);
    view.schedule();
    env.flushOne();
    assert.equal(view.stats().displayedLod, 1, 'LOD returns after crossing the upper threshold');
    for (const scale of [.53, .47, .53, .47]) {
        env.setScale(scale);
        view.schedule();
        env.flushOne();
        assert.equal(view.stats().displayedLod, 1, `scale ${scale} does not trigger a repeated LOD swap`);
    }
    assert.equal(view.stats().lodChanges, 2, 'small zoom oscillations cause only the two intentional LOD changes');

    // At document scale, linear sampling remains selected while scale jitters around 1.0.
    const lod1Source = tilesByLod.get(1).canvas._source;
    for (const scale of [.99, 1, 1.03, 1.07, 1.02]) {
        env.setScale(scale);
        view.schedule();
        env.flushOne();
        assert.equal(lod1Source.scaleMode, 'linear');
    }
    assert.deepEqual(env.modeChanges.filter(change => change.key === 'stable-1').map(change => change.value), ['linear'],
        'frames near 100% do not repeatedly toggle the sampling filter');

    env.setScale(1.08);
    view.schedule();
    env.flushOne();
    assert.deepEqual(env.modeChanges.filter(change => change.key === 'stable-1').map(change => change.value), ['linear', 'nearest'],
        'nearest filtering begins after the zoom-in threshold');
    for (const scale of [1.02, .99, .93]) {
        env.setScale(scale);
        view.schedule();
        env.flushOne();
        assert.equal(lod1Source.scaleMode, 'nearest', `scale ${scale} remains inside the nearest-filter hysteresis band`);
    }
    env.setScale(.91);
    view.schedule();
    env.flushOne();
    assert.deepEqual(env.modeChanges.filter(change => change.key === 'stable-1').map(change => change.value),
        ['linear', 'nearest', 'linear'], 'linear filtering resumes after crossing the zoom-out threshold');

    const spritesBeforeClear = env.sprites.slice();
    view.clear();
    assert.equal(view.stats().bytes, 0);
    assert.equal(view.stats().displayedLod, undefined);
    assert.equal(env.app.stage.children[0].children.length, 0);
    assert.ok(spritesBeforeClear.every(sprite => sprite.destroyed), 'clear releases sprites from every cached LOD');
    const framesBeforeReschedule = view.stats().frames;
    view.schedule();
    env.flushOne();
    assert.equal(view.stats().frames, framesBeforeReschedule + 1, 'schedule repopulates a cleared view');
    assert.ok(view.stats().bytes > 0);
    view.destroy();
    assert.equal(env.host.children.length, 0);
    assert.equal(view.stats().bytes, 0);
    assert.ok(env.observers.every(observer => observer.disconnected));
});
