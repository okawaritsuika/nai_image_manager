const assert = require('node:assert/strict');
const {test} = require('node:test');
const Brush = require('../static/canvas_retouch_brush.js');
const Liquify = require('../static/canvas_retouch_liquify.js');
const Surface = require('../static/canvas_retouch_surface.js');

globalThis.CanvasRetouchBrush = Brush;
globalThis.CanvasRetouchLiquify = Liquify;

const SMALL_CANVAS_LIMIT = 131072;

class FakeContext {
    constructor(canvas) { this.canvas = canvas; this.drawCalls = 0; }
    ensurePixels() {
        const length = this.canvas.width * this.canvas.height * 4;
        if (!this.canvas._pixels && length <= SMALL_CANVAS_LIMIT) this.canvas._pixels = new Uint8ClampedArray(length);
        return this.canvas._pixels;
    }
    getImageData(left, top, width, height) {
        const data = new Uint8ClampedArray(width * height * 4);
        const source = this.ensurePixels();
        if (source) {
            for (let y = 0; y < height; y += 1) {
                const from = ((top + y) * this.canvas.width + left) * 4;
                data.set(source.subarray(from, from + width * 4), y * width * 4);
            }
        }
        return {data, width, height};
    }
    putImageData(imageData, left, top, dirtyLeft = 0, dirtyTop = 0,
            dirtyWidth = imageData.width, dirtyHeight = imageData.height) {
        const target = this.ensurePixels();
        if (!target) return;
        const source = imageData.data;
        for (let y = dirtyTop; y < dirtyTop + dirtyHeight; y += 1) {
            for (let x = dirtyLeft; x < dirtyLeft + dirtyWidth; x += 1) {
                const dx = left + x;
                const dy = top + y;
                if (dx < 0 || dy < 0 || dx >= this.canvas.width || dy >= this.canvas.height) continue;
                const from = (y * imageData.width + x) * 4;
                const to = (dy * this.canvas.width + dx) * 4;
                target.set(source.subarray(from, from + 4), to);
            }
        }
    }
    clearRect(left, top, width, height) {
        const target = this.ensurePixels();
        if (!target) return;
        for (let y = Math.max(0, top); y < Math.min(this.canvas.height, top + height); y += 1) {
            const x = Math.max(0, left);
            const end = Math.min(this.canvas.width, left + width);
            if (end > x) target.fill(0, (y * this.canvas.width + x) * 4, (y * this.canvas.width + end) * 4);
        }
    }
    drawImage(image, ...args) {
        this.drawCalls += 1;
        let sourceX = 0, sourceY = 0, sourceWidth = image.width, sourceHeight = image.height;
        let destX, destY, destWidth, destHeight;
        if (args.length === 8) {
            [sourceX, sourceY, sourceWidth, sourceHeight, destX, destY, destWidth, destHeight] = args;
        } else if (args.length === 4) {
            [destX, destY, destWidth, destHeight] = args;
        } else if (args.length === 2) {
            [destX, destY] = args;
            destWidth = image.width; destHeight = image.height;
        } else throw new Error('Unexpected fake drawImage signature: ' + args.length);
        const target = this.ensurePixels();
        const source = image._pixels || image.data || image.pixels || null;
        if (!target || !source) return;
        for (let y = 0; y < destHeight; y += 1) {
            const sy = Math.min(image.height - 1, sourceY + Math.floor((y + .5) * sourceHeight / destHeight));
            for (let x = 0; x < destWidth; x += 1) {
                const sx = Math.min(image.width - 1, sourceX + Math.floor((x + .5) * sourceWidth / destWidth));
                const dx = destX + x, dy = destY + y;
                if (dx < 0 || dy < 0 || dx >= this.canvas.width || dy >= this.canvas.height) continue;
                const from = (sy * image.width + sx) * 4;
                const to = (dy * this.canvas.width + dx) * 4;
                target.set(source.subarray(from, from + 4), to);
            }
        }
    }
}

class FakeNode {
    constructor(ownerDocument, tagName = 'div') {
        this.ownerDocument = ownerDocument;
        this.tagName = tagName.toUpperCase();
        this.style = {};
        this.children = [];
        this.parentNode = null;
        this.hidden = false;
        this.className = '';
        this._width = 0;
        this._height = 0;
        this._pixels = null;
        this.context = tagName === 'canvas' ? new FakeContext(this) : null;
    }
    get width() { return this._width; }
    set width(value) { this._width = Number(value); this._resetPixels(); }
    get height() { return this._height; }
    set height(value) { this._height = Number(value); this._resetPixels(); }
    _resetPixels() {
        const length = this._width * this._height * 4;
        this._pixels = length <= SMALL_CANVAS_LIMIT ? new Uint8ClampedArray(length) : null;
    }
    getContext(kind) { return kind === '2d' ? this.context : null; }
    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        this.children.push(child); child.parentNode = this; return child;
    }
    removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null; return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

class FakeDocument {
    constructor() { this.canvases = []; }
    createElement(name) {
        const node = new FakeNode(this, name);
        if (name === 'canvas') this.canvases.push(node);
        return node;
    }
}

function host() {
    const doc = new FakeDocument();
    return new FakeNode(doc);
}

function source(width, height, pixels = null) {
    return {width, height, naturalWidth: width, naturalHeight: height,
        _pixels: pixels ? new Uint8ClampedArray(pixels) : (width * height * 4 <= SMALL_CANVAS_LIMIT ? new Uint8ClampedArray(width * height * 4) : null)};
}

function solidPixels(width, height, rgba = [0, 0, 0, 255]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) pixels.set(rgba, index);
    return pixels;
}

function patternPixels(width, height) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            pixels[index] = (x * 19 + y * 3) % 256;
            pixels[index + 1] = (x * 5 + y * 17) % 256;
            pixels[index + 2] = (x * 11 + y * 7) % 256;
            pixels[index + 3] = (x * 13 + y * 23) % 256;
        }
    }
    return pixels;
}

function paintLayer(overrides = {}) {
    return {type: 'paint', visible: true, opacity: .73, params: {mode: 'normal'},
        mask: {base: 1, strokes: []}, strokes: [], ...overrides};
}

function airbrush(points, overrides = {}) {
    return {tool: 'airbrush', brush: 'airbrush', points, radius: 9, hardness: .35,
        flow: .27, opacity: .8, color: '#e47789', ...overrides};
}

function wholeBrush(pixels, width, height, stroke, layer) {
    const canvas = new FakeNode(new FakeDocument(), 'canvas');
    canvas.width = width; canvas.height = height;
    canvas._pixels.set(pixels);
    const engine = Brush.create(stroke, width, height, width, height);
    engine.append(stroke.points);
    engine.paint(canvas.getContext('2d'), {mode: layer.params.mode, opacity: layer.opacity});
    return canvas._pixels;
}

function samplePixels(surface, width, height) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) pixels.set(surface.sampleAt([x, y]), (y * width + x) * 4);
    }
    return pixels;
}

test('native surface tiles a 5000 by 16000 source at exact 1:1 dimensions', () => {
    const parent = host();
    const native = source(5000, 16000);
    const surface = Surface.create({host: parent, width: 5000, height: 16000, source: native});
    const root = parent.children[0];
    assert.equal(root.className, 'canvas-retouch-native-surface');
    assert.equal(root.children.length, 80);
    assert.equal(root.style.pointerEvents, 'none');
    const tileAt = (x, y) => root.children.find(canvas => canvas.style.left === (x / 5000 * 100) + '%'
        && canvas.style.top === (y / 16000 * 100) + '%');
    assert.deepEqual([tileAt(0, 0).width, tileAt(0, 0).height], [1024, 1024]);
    assert.deepEqual([tileAt(0, 8192).width, tileAt(0, 8192).height], [1024, 1024]);
    assert.deepEqual([tileAt(0, 15360).width, tileAt(0, 15360).height], [1024, 640]);
    assert.deepEqual([tileAt(4096, 0).width, tileAt(4096, 0).height], [904, 1024]);
    assert.equal(surface.sampleAt([0, 0]).length, 4);
    surface.destroy();
    assert.equal(parent.children.length, 0);
});

test('surface rejects invalid dimensions and mismatched decoded sources before attaching DOM', () => {
    const parent = host();
    assert.throws(() => Surface.create({host: parent, width: 0, height: 10, source: source(0, 10)}), /width/);
    assert.throws(() => Surface.create({host: parent, width: 11, height: 10, source: source(10, 10)}), /dimensions/);
    assert.equal(parent.children.length, 0);
});

test('GPU-backed surfaces hydrate visible tiles first and fill every tile for DOM fallback', () => {
    const previousView = globalThis.CanvasEditorView;
    let viewOptions;
    globalThis.CanvasEditorView = {create(options) {
        viewOptions = options;
        return {schedule() {}, present() {}, setPaused() {}, destroy() {}, stats() {return {};}};
    }};
    try {
        const parent = host();
        const surface = Surface.create({host: parent, width: 2050, height: 1050, source: source(2050, 1050),
            workspace: {}});
        const tiles = parent.children[0].children;
        assert.equal(tiles.length, 6);
        assert.ok(tiles.every(tile => tile.context.drawCalls === 0), 'opening does not copy offscreen source tiles');

        const visible = viewOptions.tiles({x: 0, y: 0, width: 16, height: 16}, 1, {nearest: true});
        assert.equal(visible.length, 1);
        assert.equal(tiles[0].context.drawCalls, 1);
        assert.ok(tiles.slice(1).every(tile => tile.context.drawCalls === 0));

        viewOptions.setFallback(true);
        assert.ok(tiles.every(tile => tile.context.drawCalls === 1), 'DOM fallback has complete source pixels');
        const tile = visible[0];
        tile.damage = null; // Simulate the view consuming the prior full-tile upload.
        const from = tile.revision;
        surface.replacePatch(source(2, 3), {x: 10, y: 11, width: 2, height: 3}, 0);
        surface.replacePatch(source(1, 2), {x: 30, y: 35, width: 1, height: 2}, 0);
        assert.deepEqual(tile.damage, {from, x: 10, y: 11, width: 21, height: 26},
            'pending pixel changes merge as tile-relative damage from the first revision');

        tile.damage = null;
        const brushFrom = tile.revision;
        assert.equal(surface.beginStroke(airbrush([[20, 16]], {radius: 9, hardness: 1, flow: 1, opacity: 1}),
            paintLayer({opacity: 1}), 3), true);
        assert.equal(tile.damage.from, brushFrom);
        assert.ok(tile.damage.width < tile.width && tile.damage.height < tile.height,
            'airbrush damage stays within the painted patch');
        surface.endStroke(false);
        surface.destroy();
    } finally {
        if (previousView === undefined) delete globalThis.CanvasEditorView;
        else globalThis.CanvasEditorView = previousView;
    }
});

test('native airbrush uses exact document points across the tile boundary and preserves alpha', () => {
    const width = 1036, height = 24;
    const base = patternPixels(width, height);
    const original = source(width, height, base);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: original});
    const layer = paintLayer({opacity: .63, params: {mode: 'multiply'}});
    const stroke = airbrush([[1015, 11], [1029, 13]], {radius: 11, flow: .23, opacity: .71});
    assert.equal(surface.beginStroke(stroke, layer, 1), true);
    const actual = samplePixels(surface, width, height);
    const expected = wholeBrush(base, width, height, stroke, layer);
    assert.deepEqual(actual, expected);
    for (let index = 3; index < actual.length; index += 4) assert.equal(actual[index], base[index]);
    surface.destroy();
});

test('same full stroke points are idempotent while a repeated dwell point deposits more paint', () => {
    const width = 32, height = 24;
    const base = solidPixels(width, height, [0, 0, 0, 255]);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height, base)});
    const layer = paintLayer({opacity: 1});
    const stroke = airbrush([[15, 12]], {radius: 7, hardness: 1, flow: .4, opacity: 1, color: '#ffffff'});
    surface.beginStroke(stroke, layer, 1);
    const once = surface.sampleAt([15, 12]);
    assert.equal(surface.appendStroke([[15, 12]]), false);
    assert.deepEqual(surface.sampleAt([15, 12]), once);
    assert.equal(surface.appendStroke([[15, 12], [15, 12]]), true);
    assert.ok(surface.sampleAt([15, 12])[0] > once[0]);
    surface.endStroke(false);
    assert.deepEqual(surface.sampleAt([15, 12]), new Uint8ClampedArray([0, 0, 0, 255]));
    surface.destroy();
});

test('late patch rebases later strokes, and HTTP 204 acknowledgement leaves confirmed pixels unchanged', () => {
    const width = 40, height = 30;
    const base = solidPixels(width, height, [0, 0, 0, 255]);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height, base)});
    const layer = paintLayer({opacity: 1});
    const first = airbrush([[14, 14]], {radius: 8, color: '#ff0000', flow: .28});
    const second = airbrush([[18, 14]], {radius: 8, color: '#0000ff', flow: .24});
    surface.beginStroke(first, layer, 1);
    surface.endStroke(true);
    surface.beginStroke(second, layer, 2);
    surface.endStroke(true);

    const serverFirst = wholeBrush(base, width, height, first, layer);
    assert.equal(surface.replacePatch(source(width, height, serverFirst), {x: 0, y: 0, width, height}, 1), true);
    const expectedAfterPatch = wholeBrush(serverFirst, width, height, second, layer);
    assert.deepEqual(samplePixels(surface, width, height), expectedAfterPatch);

    assert.equal(surface.acknowledge(2), true);
    assert.deepEqual(samplePixels(surface, width, height), serverFirst,
        '204 retires the pending stroke and rebuilds from unchanged confirmed pixels');
    assert.equal(surface.acknowledge(2), false);
    surface.destroy();
});

test('cancel, undo recovery, and clearOptimistic restore touched pixels without changing other confirmed tiles', () => {
    const width = 1030, height = 16;
    const base = solidPixels(width, height, [10, 20, 30, 255]);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height, base)});
    const layer = paintLayer({opacity: 1});
    const patchPixels = solidPixels(2, 2, [222, 111, 33, 97]);
    surface.replacePatch(source(2, 2, patchPixels), {x: 1026, y: 4, width: 2, height: 2}, 0);
    surface.beginStroke(airbrush([[12, 8]], {radius: 6, color: '#ffffff'}), layer, 1);
    surface.endStroke(false);
    assert.deepEqual(surface.sampleAt([12, 8]), new Uint8ClampedArray([10, 20, 30, 255]));
    assert.deepEqual(surface.sampleAt([1026, 4]), new Uint8ClampedArray([222, 111, 33, 97]));

    surface.beginStroke(airbrush([[12, 8]], {radius: 6, color: '#ffffff'}), layer, 2);
    surface.endStroke(true);
    assert.notDeepEqual(surface.sampleAt([12, 8]), new Uint8ClampedArray([10, 20, 30, 255]));
    surface.clearOptimistic();
    assert.deepEqual(surface.sampleAt([12, 8]), new Uint8ClampedArray([10, 20, 30, 255]));
    assert.deepEqual(surface.sampleAt([1026, 4]), new Uint8ClampedArray([222, 111, 33, 97]));
    surface.destroy();
});

test('a fresh active airbrush reuses its confirmed tile as the cancel baseline', () => {
    const width = 48, height = 32;
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height)});
    const root = parent.children[0];
    const layer = paintLayer({opacity: 1});

    assert.equal(surface.beginStroke(airbrush([[20, 16]]), layer, 1), true);
    const detachedCanvases = parent.ownerDocument.canvases.filter(canvas => !root.children.includes(canvas));
    assert.equal(detachedCanvases.length, 1,
        'the confirmed copy doubles as the active-stroke baseline when no optimistic pixels exist');
    surface.endStroke(false);
    surface.destroy();
});

test('an active airbrush keeps a separate baseline when pending paint already covers the tile', () => {
    const width = 48, height = 32;
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height)});
    const layer = paintLayer({opacity: 1});
    const first = airbrush([[20, 16]], {radius: 8, hardness: 1, flow: 1, opacity: 1, color: '#ff0000'});
    const second = airbrush([[20, 16]], {radius: 8, hardness: 1, flow: 1, opacity: 1, color: '#00ff00'});

    surface.beginStroke(first, layer, 1);
    surface.endStroke(true);
    const before = surface.sampleAt([20, 16]);
    assert.equal(surface.beginStroke(second, layer, 2), true);
    const root = parent.children[0];
    const activeCopies = parent.ownerDocument.canvases.filter(canvas => !root.children.includes(canvas) && canvas.width > 0);
    assert.equal(activeCopies.length, 2,
        'pending pixels retain the confirmed base and require a separate current-pixels baseline');
    surface.endStroke(false);
    assert.deepEqual(surface.sampleAt([20, 16]), before);
    surface.destroy();
});

test('patch replaces transparent pixels, and comparison samples original pixels without changing edited pixels', () => {
    const width = 1030, height = 8;
    const base = solidPixels(width, height, [40, 80, 120, 255]);
    base.set([90, 100, 110, 37], (2 * width + 1) * 4);
    const original = source(width, height, base);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: original});
    const transparent = source(2, 1, new Uint8ClampedArray([11, 22, 33, 0, 44, 55, 66, 0]));
    surface.replacePatch(transparent, {x: 3, y: 2, width: 2, height: 1}, 0);
    assert.deepEqual(surface.sampleAt([3, 2]), new Uint8ClampedArray([11, 22, 33, 0]));
    assert.deepEqual(surface.sampleAt([2, 2]), new Uint8ClampedArray([40, 80, 120, 255]));

    const region = {x: 1023, y: 4, width: 2, height: 1};
    surface.replacePatch(source(1, 1, new Uint8ClampedArray([42, 43, 44, 95])),
        {x: 1024, y: 4, width: 1, height: 1}, 0);
    assert.deepEqual(surface.inspectRegion(region, false).data,
        new Uint8ClampedArray([40, 80, 120, 255, 42, 43, 44, 95]));
    assert.deepEqual(surface.inspectRegion(region, true).data,
        new Uint8ClampedArray([40, 80, 120, 255, 40, 80, 120, 255]));

    const layer = paintLayer({opacity: 1});
    surface.beginStroke(airbrush([[700, 4]], {radius: 5, hardness: 1, flow: 1, opacity: 1, color: '#ffffff'}), layer, 1);
    surface.endStroke(true);
    const editedRight = surface.sampleAt([700, 4]);
    const originalBeforeComparison = surface.sampleAt([1, 2], true);
    const displayNodes = parent.children[0].children.filter(node => node.className === 'canvas-retouch-native-tile');
    assert.equal(parent.children[0].children.find(node => node.className === 'canvas-retouch-native-original')?.hidden, true);
    surface.setComparison(true, 50);
    assert.deepEqual(surface.sampleAt([1, 2], true), new Uint8ClampedArray(base.subarray((2 * width + 1) * 4, (2 * width + 1) * 4 + 4)));
    assert.deepEqual(originalBeforeComparison, new Uint8ClampedArray(base.subarray((2 * width + 1) * 4, (2 * width + 1) * 4 + 4)));
    assert.deepEqual(surface.sampleAt([700, 4]), editedRight);
    const originals = parent.children[0].children.filter(node => node.className === 'canvas-retouch-native-original');
    assert.equal(originals.length, 1);
    assert.ok(originals[0].style.clipPath.startsWith('inset(0 '));
    assert.ok(displayNodes[0].style.clipPath.startsWith('inset(0 0 0 '), 'edited half must be clipped away under original alpha');
    surface.setComparison(false, 50);
    assert.equal(displayNodes[0].style.clipPath, 'none');
    assert.equal(displayNodes[0].hidden, false);
    assert.equal(originals[0].hidden, true);

    const displayCanvases = parent.children[0].children.filter(node => node.tagName === 'CANVAS');
    surface.destroy();
    assert.equal(parent.children.length, 0);
    assert.ok(displayCanvases.every(canvas => canvas.width === 0 && canvas.height === 0));
    assert.deepEqual(Array.from(original._pixels.subarray((2 * width + 1) * 4, (2 * width + 1) * 4 + 4)), [90, 100, 110, 37]);
});

test('unsupported brush or masked layer leaves the native surface untouched', () => {
    const width = 20, height = 18;
    const base = solidPixels(width, height, [17, 23, 29, 255]);
    const parent = host();
    const surface = Surface.create({host: parent, width, height, source: source(width, height, base)});
    assert.equal(surface.beginStroke({tool: 'clone', points: [[5, 5]]}, paintLayer(), 1), false);
    assert.equal(surface.beginStroke(airbrush([[5, 5]]), paintLayer({mask: {base: 0, strokes: []}}), 1), false);
    assert.deepEqual(surface.sampleAt([5, 5]), new Uint8ClampedArray([17, 23, 29, 255]));
    surface.destroy();
});

test('native liquify writes across tile edges and cancel restores every touched tile', () => {
    const previousView = globalThis.CanvasEditorView;
    let viewOptions;
    globalThis.CanvasEditorView = {create(options) {
        viewOptions = options;
        return {schedule() {}, present() {}, setPaused() {}, destroy() {}, stats() {return {};}};
    }};
    try {
        const width = 1030, height = 24;
        const base = patternPixels(width, height);
        const parent = host();
        const surface = Surface.create({host: parent, width, height, source: source(width, height, base)});
        const tiles = viewOptions.tiles({x: 0, y: 0, width, height}, 1, {nearest: true});
        for (const tile of tiles) tile.damage = null;
        const tileRevisions = new Map(tiles.map(tile => [tile, tile.revision]));
        const writes = [];
        for (const tile of parent.children[0].children.filter(node => node.className === 'canvas-retouch-native-tile')) {
            const putImageData = tile.context.putImageData.bind(tile.context);
            tile.context.putImageData = (imageData, ...args) => {
                writes.push({imageWidth: imageData.width, imageHeight: imageData.height,
                    dirtyWidth: args[4], dirtyHeight: args[5]});
                return putImageData(imageData, ...args);
            };
        }
        const layer = {type: 'liquify', visible: true, opacity: .8, params: {}, mask: {base: 1, strokes: []}};
        const stroke = {tool: 'liquify', mode: 'expand', radius: 8, strength: .55, points: [[1021, 12], [1026, 12]]};
        assert.equal(surface.beginStroke(stroke, layer, 1), true);
        const edited = samplePixels(surface, width, height);
        assert.notDeepEqual(edited, base);
        assert.notDeepEqual(edited.subarray((10 * width + 1024) * 4, (10 * width + 1025) * 4),
            base.subarray((10 * width + 1024) * 4, (10 * width + 1025) * 4),
            'the right tile receives the cross-edge liquify write');
        assert.ok(writes.some(write => write.dirtyWidth < write.imageWidth || write.dirtyHeight < write.imageHeight),
            'native writes use the engine-reported changed bounds');
        assert.ok(tiles.every(tile => tile.damage && tile.damage.from === tileRevisions.get(tile)),
            'liquify reports tile-relative damage for each touched tile');
        assert.ok(tiles[0].damage.width < tiles[0].width);
        surface.endStroke(false);
        assert.deepEqual(samplePixels(surface, width, height), base);
        surface.destroy();
    } finally {
        if (previousView === undefined) delete globalThis.CanvasEditorView;
        else globalThis.CanvasEditorView = previousView;
    }
});
