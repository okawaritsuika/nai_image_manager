const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const Brush = require('../static/canvas_retouch_brush.js');

class PixelContext {
    constructor(width, height, pixels = null) {
        this.width = width;
        this.height = height;
        this.data = pixels ? new Uint8ClampedArray(pixels) : new Uint8ClampedArray(width * height * 4);
        this.drawCalls = 0;
    }
    getImageData(left, top, width, height) {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y += 1) {
            const sourceStart = ((top + y) * this.width + left) * 4;
            data.set(this.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
        }
        return {data, width, height};
    }
    putImageData(imageData, left, top) {
        for (let y = 0; y < imageData.height; y += 1) {
            const destinationStart = ((top + y) * this.width + left) * 4;
            this.data.set(imageData.data.subarray(y * imageData.width * 4, (y + 1) * imageData.width * 4), destinationStart);
        }
    }
    clearRect(left, top, width, height) {
        for (let y = top; y < top + height; y += 1) {
            const start = (y * this.width + left) * 4;
            this.data.fill(0, start, start + width * 4);
        }
    }
    drawImage(image, left, top, width, height) {
        this.drawCalls += 1;
        const source = image.data || image.pixels;
        for (let y = 0; y < height; y += 1) {
            const sourceY = Math.min(image.height - 1, Math.floor((y + .5) * image.height / height));
            for (let x = 0; x < width; x += 1) {
                const sourceX = Math.min(image.width - 1, Math.floor((x + .5) * image.width / width));
                const sourceIndex = (sourceY * image.width + sourceX) * 4;
                const targetIndex = ((top + y) * this.width + left + x) * 4;
                this.data.set(source.subarray(sourceIndex, sourceIndex + 4), targetIndex);
            }
        }
    }
}

function opaquePixels(width, height, rgb = [0, 0, 0]) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < pixels.length; index += 4) {
        pixels[index] = rgb[0];
        pixels[index + 1] = rgb[1];
        pixels[index + 2] = rgb[2];
        pixels[index + 3] = 255;
    }
    return pixels;
}

function makeStroke(overrides = {}) {
    return {
        points: [[20, 20]],
        radius: 12,
        hardness: .2,
        flow: .2,
        opacity: 1,
        color: '#ffffff',
        ...overrides
    };
}

function paint(stroke, width = 48, height = 48, documentWidth = width, documentHeight = height, options = {}, pixels = opaquePixels(width, height)) {
    const context = new PixelContext(width, height, pixels);
    const brush = Brush.create(stroke, width, height, documentWidth, documentHeight);
    brush.append(stroke.points);
    brush.paint(context, options);
    return context;
}

function referenceSingleDab(stroke, width, height, pixels, layerOpacity = 1) {
    const coverage = new Float32Array(width * height);
    const radius = stroke.radius;
    const [centerX, centerY] = stroke.points[0];
    const left = Math.max(0, Math.floor(centerX - radius - .5));
    const top = Math.max(0, Math.floor(centerY - radius - .5));
    const right = Math.min(width, Math.ceil(centerX + radius - .5) + 1);
    const bottom = Math.min(height, Math.ceil(centerY + radius - .5) + 1);
    const feather = Math.max(1 - stroke.hardness, 1e-6);
    const end = Math.exp(-4.5);
    const colorValue = parseInt(stroke.color.slice(1), 16);
    const color = [colorValue >> 16, (colorValue >> 8) & 255, colorValue & 255];
    for (let y = top; y < bottom; y += 1) {
        const dy = y + .5 - centerY;
        for (let x = left; x < right; x += 1) {
            const dx = x + .5 - centerX;
            const distance = Math.sqrt(dx * dx + dy * dy) / radius;
            if (distance >= 1) continue;
            const q = Math.max(0, Math.min(1, (distance - stroke.hardness) / feather));
            const falloff = q === 0 ? 1 : Math.max(0, (Math.exp(-4.5 * q * q) - end) / (1 - end));
            const index = y * width + x;
            coverage[index] += (1 - coverage[index]) * falloff * stroke.flow;
        }
    }
    const output = new Uint8ClampedArray(pixels);
    for (let index = 0; index < coverage.length; index += 1) {
        const coverageByte = Math.floor(coverage[index] * 255 + .5);
        const weight = coverageByte / 255 * stroke.opacity * layerOpacity;
        if (weight <= 0) continue;
        const offset = index * 4;
        for (let channel = 0; channel < 3; channel += 1) {
            output[offset + channel] = Math.floor(pixels[offset + channel] +
                (color[channel] - pixels[offset + channel]) * weight + .5);
        }
    }
    return output;
}

function channel(context, x, y, index = 0) {
    return context.data[(y * context.width + x) * 4 + index];
}

function colorsEqual(left, right, tolerance = 0) {
    assert.equal(left.length, right.length);
    for (let index = 0; index < left.length; index += 1) {
        assert.ok(Math.abs(left[index] - right[index]) <= tolerance, `pixel ${index}: ${left[index]} != ${right[index]}`);
    }
}

test('airbrush falloff fades from its center and reaches zero outside the radius', () => {
    const output = paint(makeStroke());
    const center = channel(output, 19, 19);
    const middle = channel(output, 19, 25);
    const outside = channel(output, 19, 32);
    assert.ok(center > middle, `${center} should be stronger than ${middle}`);
    assert.ok(middle > 0, 'the feather should remain visible between center and edge');
    assert.equal(outside, 0);
});

test('incremental append produces the same preview as appending the full stroke once', () => {
    const points = [[8, 12], [17, 13], [29, 22]];
    const stroke = makeStroke({points, radius: 8, flow: .17});
    const incremental = Brush.create(stroke, 48, 48, 48, 48);
    const incrementalContext = new PixelContext(48, 48, opaquePixels(48, 48));
    incremental.append(points.slice(0, 1));
    incremental.append(points.slice(0, 2));
    incremental.append(points);
    incremental.paint(incrementalContext, {});

    const allAtOnce = Brush.create(stroke, 48, 48, 48, 48);
    const allAtOnceContext = new PixelContext(48, 48, opaquePixels(48, 48));
    allAtOnce.append(points);
    allAtOnce.paint(allAtOnceContext, {});
    assert.deepEqual(incrementalContext.data, allAtOnceContext.data);
});

test('arc-length sampling gives the same coverage for sparse and dense pointer events', () => {
    const sparsePoints = [[8, 20], [32, 20]];
    const densePoints = Array.from({length: 25}, (_, index) => [8 + index, 20]);
    const sparse = paint(makeStroke({points: sparsePoints, radius: 10, flow: .11}), 48, 48);
    const dense = paint(makeStroke({points: densePoints, radius: 10, flow: .11}), 48, 48);
    assert.deepEqual(sparse.data, dense.data);
});

test('a repeated point adds a dwell pulse and re-appending an unchanged list does not spray twice', () => {
    const once = Brush.create(makeStroke(), 48, 48, 48, 48);
    const onceContext = new PixelContext(48, 48, opaquePixels(48, 48));
    const points = [[20, 20]];
    once.append(points);
    once.append(points);
    once.paint(onceContext, {});

    const dwell = Brush.create(makeStroke(), 48, 48, 48, 48);
    const dwellContext = new PixelContext(48, 48, opaquePixels(48, 48));
    dwell.append([[20, 20], [20, 20]]);
    dwell.paint(dwellContext, {});
    assert.ok(channel(dwellContext, 19, 19) > channel(onceContext, 19, 19));
});

test('zero flow is a no-op and painting preserves alpha and pixels outside the tip', () => {
    const width = 48;
    const height = 48;
    const base = opaquePixels(width, height, [83, 104, 125]);
    base[3] = 0;
    const zeroFlow = paint(makeStroke({flow: 0}), width, height, width, height, {}, base);
    assert.deepEqual(zeroFlow.data, base);

    const output = paint(makeStroke({flow: .3}), width, height, width, height, {}, base);
    for (let pixel = 0; pixel < base.length; pixel += 4) assert.equal(output.data[pixel + 3], base[pixel + 3]);
    const outsideIndex = (0 * width + 0) * 4;
    colorsEqual(output.data.subarray(outsideIndex, outsideIndex + 4), base.subarray(outsideIndex, outsideIndex + 4));
});

test('color mode preserves luminance and keeps black and white pixels unchanged', () => {
    const base = [190, 140, 120, 255];
    const changed = Brush.blendPixels(base, '#e86a75', 1, 'color');
    const beforeLuma = base[0] * .3 + base[1] * .59 + base[2] * .11;
    const afterLuma = changed[0] * .3 + changed[1] * .59 + changed[2] * .11;
    assert.ok(Math.abs(afterLuma - beforeLuma) <= 1);
    assert.deepEqual(Array.from(Brush.blendPixels([0, 0, 0, 255], '#e86a75', 1, 'color')), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(Brush.blendPixels([255, 255, 255, 255], '#e86a75', 1, 'color')), [255, 255, 255, 255]);
});

test('soft-light uses its piecewise blend curve', () => {
    const output = Brush.blendPixels([102, 128, 153, 255], [204, 51, 128], 1, 'soft-light');
    assert.deepEqual(Array.from(output), [138, 90, 153, 255]);
});

test('multiply darkens, screen brightens, and both preserve source alpha', () => {
    const base = [100, 120, 140, 37];
    const multiplied = Brush.blendPixels(base, '#808080', 1, 'multiply');
    const screened = Brush.blendPixels(base, '#808080', 1, 'screen');
    for (let index = 0; index < 3; index += 1) {
        assert.ok(multiplied[index] < base[index]);
        assert.ok(screened[index] > base[index]);
    }
    assert.equal(multiplied[3], 37);
    assert.equal(screened[3], 37);
});

test('stroke opacity and layer opacity multiply, and zero opacity or mask is a no-op', () => {
    const stroke = makeStroke({points: [[8, 8]], radius: 4, hardness: 1, flow: 1, opacity: .5});
    const output = paint(stroke, 16, 16, 16, 16, {opacity: .5});
    assert.equal(channel(output, 7, 7), 64);

    const base = opaquePixels(16, 16);
    const opacityZero = paint(makeStroke({points: [[8, 8]], radius: 4, hardness: 1, flow: 1}), 16, 16, 16, 16, {opacity: 0}, base);
    assert.deepEqual(opacityZero.data, base);

    const oldDocument = global.document;
    let createdCanvas = 0;
    const maskCanvas = {
        width: 0,
        height: 0,
        context: null,
        getContext() { return this.context; }
    };
    maskCanvas.context = new PixelContext(16, 16);
    global.document = {createElement() { createdCanvas += 1; return maskCanvas; }};
    try {
        const zeroMask = {width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4)};
        const brush = Brush.create(makeStroke({points: [[8, 8]], radius: 4, hardness: 1, flow: 1}), 16, 16, 16, 16);
        brush.append([[8, 8]]);
        const masked = new PixelContext(16, 16, base);
        brush.paint(masked, {mask: zeroMask});
        assert.deepEqual(masked.data, base);
        brush.paint(masked, {mask: zeroMask});
        assert.equal(createdCanvas, 1);
        assert.equal(maskCanvas.context.drawCalls, 1);
    } finally {
        if (oldDocument === undefined) delete global.document;
        else global.document = oldDocument;
    }
});

test('scaled preview keeps the airbrush center stronger than its feather', () => {
    const output = paint(makeStroke({points: [[200, 200]], radius: 20, flow: .25}), 100, 100, 400, 400);
    const center = channel(output, 49, 49);
    const middle = channel(output, 52, 49);
    const outside = channel(output, 55, 49);
    assert.ok(center > middle);
    assert.ok(middle > 0);
    assert.equal(outside, 0);
});

test('native tile origin and scale preserve the whole-image airbrush result across a tile edge', () => {
    const width = 1036;
    const height = 24;
    const base = opaquePixels(width, height, [62, 103, 147]);
    for (let pixel = 0; pixel < base.length; pixel += 4) base[pixel + 3] = (pixel / 4) % 251;
    const stroke = makeStroke({points: [[1015, 11], [1029, 13]], radius: 11, flow: .23, opacity: .71});

    const whole = new PixelContext(width, height, base);
    const wholeBrush = Brush.create(stroke, width, height, width, height);
    wholeBrush.append(stroke.points);
    wholeBrush.paint(whole, {mode: 'multiply', opacity: .63});

    const tiled = new Uint8ClampedArray(base);
    for (const x of [0, 1024]) {
        const tileWidth = Math.min(1024, width - x);
        const tilePixels = new Uint8ClampedArray(tileWidth * height * 4);
        for (let y = 0; y < height; y += 1) {
            const start = (y * width + x) * 4;
            tilePixels.set(base.subarray(start, start + tileWidth * 4), y * tileWidth * 4);
        }
        const context = new PixelContext(tileWidth, height, tilePixels);
        const brush = Brush.create(stroke, tileWidth, height, tileWidth, height,
            {origin: [x, 0], scale: 1});
        brush.append(stroke.points);
        brush.paint(context, {mode: 'multiply', opacity: .63});
        for (let y = 0; y < height; y += 1) {
            const destination = (y * width + x) * 4;
            tiled.set(context.data.subarray(y * tileWidth * 4, (y + 1) * tileWidth * 4), destination);
        }
    }
    assert.deepEqual(tiled, whole.data);
});

test('large 120 and 800 pixel dabs preserve the full-square reference raster', () => {
    const width = 1024, height = 1024;
    const base = opaquePixels(width, height, [47, 113, 198]);
    for (const radius of [120, 800]) {
        const stroke = makeStroke({points: [[512, 512]], radius, hardness: .37, flow: .43,
            opacity: .61, color: '#fa4030'});
        const output = paint(stroke, width, height, width, height, {mode: 'normal', opacity: .72}, base);
        assert.deepEqual(output.data, referenceSingleDab(stroke, width, height, base, .72),
            `radius ${radius} must retain the existing pixel result`);
    }
});

test('native tile placement validates explicit origin and scale', () => {
    const stroke = makeStroke();
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {origin: [1]}), /origin/);
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {origin: [0, Infinity]}), /origin/);
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {origin: ['1', 0]}), /origin/);
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {scale: 0}), /scale/);
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {scale: 1.01}), /scale/);
    assert.throws(() => Brush.create(stroke, 16, 16, 16, 16, {scale: '1'}), /scale/);
});

test('native airbrush keeps coverage in one reusable Wasm buffer and matches the JS preview', async t => {
    let wasmBytes;
    try {
        wasmBytes = await fs.readFile(path.join(__dirname, '../static/canvas_editor/brush.wasm'));
    } catch (error) {
        if (error.code === 'ENOENT') {t.skip('build the canvas brush Wasm asset to exercise the native kernel'); return;}
        throw error;
    }
    const original = {
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch,
        WebAssembly: globalThis.WebAssembly
    };
    const nativeWebAssembly = globalThis.WebAssembly;
    const dabCalls = [], blendCalls = [];
    const expectedExports = ['add_dab_region', 'blend_rgba_region'];
    const module = new nativeWebAssembly.Module(wasmBytes);
    const exports = new Set(nativeWebAssembly.Module.exports(module).map(item => item.name));
    assert.ok(expectedExports.every(name => exports.has(name)), 'the compiled Wasm exports the direct-region kernels');

    const stroke = makeStroke({points: [[24, 32], [38, 32]], radius: 10, hardness: .25,
        flow: .17, opacity: .62, color: '#d84868'});
    const expected = paint(stroke, 64, 64, 64, 64, {opacity: .73}).data;
    const blendModes = ['normal', 'soft-light', 'color', 'multiply', 'screen'].map(mode => {
        const modeStroke = makeStroke({points: [[24, 32], [38, 32]], radius: 10, hardness: .25,
            flow: .17, opacity: .62, color: '#d84868'});
        const baseline = paint(modeStroke, 64, 64, 64, 64, {mode, opacity: .73},
            opaquePixels(64, 64, [21, 95, 178])).data;
        return {mode, stroke: modeStroke, baseline};
    });
    globalThis.document = {};
    globalThis.location = {};
    globalThis.fetch = async url => {
        assert.match(url, /brush\.wasm\?v=5$/);
        return {ok: true, arrayBuffer: async () => wasmBytes.buffer.slice(wasmBytes.byteOffset,
            wasmBytes.byteOffset + wasmBytes.byteLength)};
    };
    globalThis.WebAssembly = Object.assign(Object.create(nativeWebAssembly), {
        instantiate: async bytes => {
            const result = await nativeWebAssembly.instantiate(bytes);
            const nativeExports = result.instance.exports;
            const instrumentedExports = {
                memory: nativeExports.memory,
                __heap_base: nativeExports.__heap_base,
                add_dab: nativeExports.add_dab,
                blend_rgba: nativeExports.blend_rgba,
                add_dab_region(...args) {
                    dabCalls.push({pointer: args[0], left: args[2], top: args[3], right: args[4], bottom: args[5]});
                    return nativeExports.add_dab_region(...args);
                },
                blend_rgba_region(...args) {
                    blendCalls.push({coveragePointer: args[1], left: args[3], top: args[4], width: args[6], height: args[7]});
                    return nativeExports.blend_rgba_region(...args);
                }
            };
            return {instance: {exports: instrumentedExports}};
        }
    });
    try {
        assert.equal(await Brush.prepareNative(), true);

        const context = new PixelContext(64, 64, opaquePixels(64, 64));
        const first = Brush.create(stroke, 64, 64, 64, 64);
        first.append(stroke.points);
        first.paint(context, {opacity: .73});
        assert.deepEqual(context.data, expected);
        assert.ok(dabCalls.length > 2);
        assert.equal(new Set(dabCalls.map(call => call.pointer)).size, 1,
            'every dab updates the persistent full-surface coverage buffer');
        assert.equal(blendCalls.length, 1);
        const coveragePointer = dabCalls[0].pointer;
        first.dispose();

        const second = Brush.create(stroke, 64, 64, 64, 64);
        second.append(stroke.points.slice(0, 1));
        assert.equal(dabCalls.at(-1).pointer, coveragePointer, 'disposed coverage storage returns to the pool');
        second.dispose();

        for (const {mode, stroke: modeStroke, baseline} of blendModes) {
            const modeContext = new PixelContext(64, 64, opaquePixels(64, 64, [21, 95, 178]));
            const modeBrush = Brush.create(modeStroke, 64, 64, 64, 64);
            modeBrush.append(modeStroke.points);
            modeBrush.paint(modeContext, {mode, opacity: .73});
            assert.deepEqual(modeContext.data, baseline, `${mode} retains the JS blend result`);
            modeBrush.dispose();
        }

        const largeBase = opaquePixels(1024, 1024, [47, 113, 198]);
        for (const radius of [120, 800]) {
            const largeStroke = makeStroke({points: [[512, 512]], radius, hardness: .37, flow: .43,
                opacity: .61, color: '#fa4030'});
            const largeExpected = referenceSingleDab(largeStroke, 1024, 1024, largeBase, .72);
            const largeContext = new PixelContext(1024, 1024, largeBase);
            const largeBrush = Brush.create(largeStroke, 1024, 1024, 1024, 1024);
            largeBrush.append(largeStroke.points);
            largeBrush.paint(largeContext, {mode: 'normal', opacity: .72});
            assert.deepEqual(largeContext.data, largeExpected, `radius ${radius} retains the reference raster`);
            largeBrush.dispose();
        }
    } finally {
        for (const key of ['document', 'location', 'fetch', 'WebAssembly']) {
            if (original[key] === undefined) delete globalThis[key];
            else globalThis[key] = original[key];
        }
    }
});
