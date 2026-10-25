const assert = require('node:assert/strict');
const {test} = require('node:test');
const Liquify = require('../static/canvas_retouch_liquify.js');

function gradientImage(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            data[index] = (x * 7) % 256;
            data[index + 1] = (y * 9) % 256;
            data[index + 2] = (x * 3 + y * 5) % 256;
            data[index + 3] = (x * 13 + y * 17) % 256;
        }
    }
    return {width, height, data};
}

function copyImage(image) {
    return {width: image.width, height: image.height, data: new Uint8ClampedArray(image.data)};
}

function hasRGBChange(before, after, left = 0, top = 0, right = before.width, bottom = before.height) {
    for (let y = top; y < bottom; y += 1) {
        for (let x = left; x < right; x += 1) {
            const index = (y * before.width + x) * 4;
            if (before.data[index] !== after.data[index] || before.data[index + 1] !== after.data[index + 1] ||
                    before.data[index + 2] !== after.data[index + 2]) return true;
        }
    }
    return false;
}

test('each liquify mode changes the stroke interior and preserves exterior pixels and alpha', () => {
    const modes = ['push', 'expand', 'shrink', 'clockwise', 'counterclockwise'];
    for (const mode of modes) {
        const image = gradientImage(40, 40);
        const before = copyImage(image);
        const stroke = {mode, radius: 10, strength: .65, points: [[12, 20], [18, 20]]};
        const rect = Liquify.create(stroke, image, 40, 40).append(stroke.points);

        assert.ok(rect, `${mode} should report a dirty rectangle`);
        assert.ok(hasRGBChange(before, image, 9, 9, 23, 31), `${mode} should change pixels near the stroke`);
        assert.deepEqual(image.data.slice(0, 4), before.data.slice(0, 4), `${mode} should preserve a distant pixel`);
        for (let index = 3; index < image.data.length; index += 4) {
            assert.equal(image.data[index], before.data[index], `${mode} should preserve alpha at pixel ${Math.floor(index / 4)}`);
        }
    }
});

test('push moves the center sample against the pointer direction using bilinear sampling', () => {
    const image = gradientImage(20, 16);
    const stroke = {mode: 'push', radius: 8, strength: .35, points: [[10, 8], [11, 8]]};
    Liquify.create(stroke, image, 20, 16).append(stroke.points);

    const center = (8 * image.width + 11) * 4;
    assert.equal(image.data[center], 75);
    assert.equal(image.data[center + 3], (11 * 13 + 8 * 17) % 256);
});

test('a stationary first push dab is a no-op while a stationary expand dab deforms', () => {
    const pushImage = gradientImage(32, 32);
    const pushBefore = copyImage(pushImage);
    const points = [[15, 15]];
    const pushRect = Liquify.create({mode: 'push', radius: 8, points}, pushImage, 32, 32).append(points);
    assert.equal(pushRect, null);
    assert.deepEqual(pushImage.data, pushBefore.data);

    const expandImage = gradientImage(32, 32);
    const expandBefore = copyImage(expandImage);
    const expandRect = Liquify.create({mode: 'expand', radius: 8, points}, expandImage, 32, 32).append(points);
    assert.ok(expandRect);
    assert.ok(hasRGBChange(expandBefore, expandImage));
});

test('incremental appends match one full append across multiple segments', () => {
    const points = [[7, 11], [13, 14], [23, 18], [25, 27]];
    const stroke = {mode: 'push', radius: 9, strength: .7, points};
    const incrementalImage = gradientImage(40, 40);
    const incremental = Liquify.create(stroke, incrementalImage, 40, 40);
    incremental.append(points.slice(0, 1));
    incremental.append(points.slice(0, 2));
    incremental.append(points.slice(0, 3));
    incremental.append(points);

    const batchedImage = gradientImage(40, 40);
    Liquify.create(stroke, batchedImage, 40, 40).append(points);
    assert.deepEqual(incrementalImage.data, batchedImage.data);
});

test('re-appending an unchanged point list does not apply the stroke twice', () => {
    const image = gradientImage(32, 32);
    const points = [[9, 16], [15, 16]];
    const liquify = Liquify.create({mode: 'push', radius: 10, points}, image, 32, 32);
    const rect = liquify.append(points);
    const afterFirstAppend = new Uint8ClampedArray(image.data);

    assert.ok(rect);
    assert.equal(liquify.append(points), null);
    assert.deepEqual(image.data, afterFirstAppend);
});

test('zero opacity and a zero mask are no-ops; partial red mask blends the warp', () => {
    const points = [[10, 8], [11, 8]];
    const stroke = {mode: 'push', radius: 8, strength: .35, points};
    const base = gradientImage(20, 16);

    const opacityImage = copyImage(base);
    assert.equal(Liquify.create(stroke, opacityImage, 20, 16, {opacity: 0}).append(points), null);
    assert.deepEqual(opacityImage.data, base.data);

    const zeroMaskImage = copyImage(base);
    const zeroMask = new Uint8ClampedArray(base.data.length);
    assert.equal(Liquify.create(stroke, zeroMaskImage, 20, 16, {mask: zeroMask}).append(points), null);
    assert.deepEqual(zeroMaskImage.data, base.data);

    const partialMaskImage = copyImage(base);
    const partialMask = new Uint8ClampedArray(base.data.length);
    for (let index = 0; index < partialMask.length; index += 4) partialMask[index] = 128;
    Liquify.create(stroke, partialMaskImage, 20, 16, {mask: partialMask}).append(points);

    const fullMaskImage = copyImage(base);
    Liquify.create(stroke, fullMaskImage, 20, 16).append(points);
    const center = (8 * base.width + 11) * 4;
    assert.ok(partialMaskImage.data[center] < base.data[center]);
    assert.ok(partialMaskImage.data[center] > fullMaskImage.data[center]);
    for (let index = 3; index < partialMaskImage.data.length; index += 4) {
        assert.equal(partialMaskImage.data[index], base.data[index]);
    }
});

test('edge-overlapping dabs are clipped safely and fully outside dabs report no change', () => {
    const edgeImage = gradientImage(10, 10);
    const edgePoints = [[-1, 4], [0, 4]];
    const edgeRect = Liquify.create({mode: 'push', radius: 4, strength: .8, points: edgePoints}, edgeImage, 10, 10)
        .append(edgePoints);
    assert.ok(edgeRect);
    assert.ok(edgeRect.left >= 0);
    assert.ok(edgeRect.top >= 0);
    assert.ok(edgeRect.right <= edgeImage.width);
    assert.ok(edgeRect.bottom <= edgeImage.height);

    const outsideImage = gradientImage(10, 10);
    const outsidePoints = [[100, 100], [101, 100]];
    const outsideRect = Liquify.create({mode: 'push', radius: 4, points: outsidePoints}, outsideImage, 10, 10)
        .append(outsidePoints);
    assert.equal(outsideRect, null);
});

test('invalid new points are skipped without blocking later valid points', () => {
    const image = gradientImage(24, 24);
    const points = [[8, 12], [NaN, 13], null, [Symbol('invalid'), 12], [10, 12]];
    const rect = Liquify.create({mode: 'push', radius: 8, points}, image, 24, 24).append(points);
    assert.ok(rect);
    assert.ok(hasRGBChange(gradientImage(24, 24), image));
});

test('document scaling matches an equivalent preview-space stroke', () => {
    const scaledPoints = [[10, 10], [11, 10]];
    const scaledStroke = {mode: 'push', radius: 10, strength: .6, points: [[20, 20], [22, 20]]};
    const previewStroke = {mode: 'push', radius: 5, strength: .6, points: scaledPoints};
    const scaledImage = gradientImage(32, 32);
    const previewImage = gradientImage(32, 32);

    Liquify.create(scaledStroke, scaledImage, 3200, 1600).append(scaledStroke.points);
    Liquify.create(previewStroke, previewImage, 1600, 800).append(previewStroke.points);
    assert.deepEqual(scaledImage.data, previewImage.data);
});

test('invalid preview dimensions, pixel buffers, masks, and document dimensions throw RangeError', () => {
    const image = gradientImage(4, 4);
    assert.throws(() => Liquify.create({}, {width: 0, height: 4, data: image.data}, 4, 4), RangeError);
    assert.throws(() => Liquify.create({}, {width: 1601, height: 1, data: new Uint8ClampedArray(0)}, 1601, 1), RangeError);
    assert.throws(() => Liquify.create({}, {width: 4, height: 4, data: new Uint8ClampedArray(3)}, 4, 4), RangeError);
    assert.throws(() => Liquify.create({}, image, 0, 4), RangeError);
    assert.throws(() => Liquify.create({}, image, 4, Infinity), RangeError);
    assert.throws(() => Liquify.create({}, image, 4, 4, {mask: new Uint8ClampedArray(4)}), RangeError);
});

test('dirty rectangles are exclusive on their right and bottom edges', () => {
    const image = gradientImage(20, 16);
    const points = [[10, 8], [11, 8]];
    const rect = Liquify.create({mode: 'push', radius: 8, points}, image, 20, 16).append(points);
    assert.ok(rect);
    assert.ok(rect.left < rect.right);
    assert.ok(rect.top < rect.bottom);
    assert.ok(rect.right <= image.width);
    assert.ok(rect.bottom <= image.height);
});
