const assert = require('node:assert/strict');
const {test} = require('node:test');
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
