const assert = require('node:assert/strict');
const CanvasSelectionRotation = require('../static/canvas_selection_rotation.js');
const {test} = require('node:test');

function close(actual, expected, epsilon = 1e-9) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not close to ${expected}`);
}

test('snapAngle holds each quarter turn within five degrees and releases outside it', () => {
    for (const target of [-360, -270, -180, -90, 0, 90, 180, 270, 360, 450]) {
        for (const offset of [-5, -2, 0, 2, 5]) {
            assert.equal(CanvasSelectionRotation.snapAngle(target + offset), target);
        }
        for (const offset of [-5.01, 5.01, 30]) {
            assert.equal(CanvasSelectionRotation.snapAngle(target + offset), target + offset);
        }
    }
});

function closePoint(actual, expected) {
    close(actual.x, expected.x);
    close(actual.y, expected.y);
}

test('rotated hit tests use the visible rectangle, not its unrotated box or bounding box', () => {
    const rect = {x: 0, y: 0, layerWidth: 256, layerHeight: 128, rotation: 90};
    assert.equal(CanvasSelectionRotation.containsPoint(rect, {x: 128, y: -32}), true);
    assert.equal(CanvasSelectionRotation.containsPoint(rect, {x: 16, y: 64}), false);
    assert.equal(CanvasSelectionRotation.intersects(rect, {x: 120, y: -40, layerWidth: 16, layerHeight: 16}), true);
    assert.equal(CanvasSelectionRotation.intersects(rect, {x: 0, y: 40, layerWidth: 16, layerHeight: 16}), false);
    const diamond = {x: 0, y: 0, layerWidth: 100, layerHeight: 100, rotation: 45};
    assert.equal(CanvasSelectionRotation.intersects(diamond, {x: -20, y: -20, layerWidth: 5, layerHeight: 5}), false);
    assert.equal(CanvasSelectionRotation.intersects(diamond, {x: 45, y: -20, layerWidth: 10, layerHeight: 10}), true);
    assert.equal(CanvasSelectionRotation.intersects(rect, {x: 192, y: 0, layerWidth: 10, layerHeight: 10}), false);
    closePoint(CanvasSelectionRotation.localPoint(rect, {x: 128, y: -32}), {x: 32, y: 64});
});

function snap64(value) {
    return Math.max(64, Math.round(value / 64) * 64);
}

function namedCorners(selection) {
    const [tl, tr, br, bl] = CanvasSelectionRotation.corners(selection);
    return {tl, tr, br, bl};
}

function oppositeHandle(handle) {
    return `${handle.includes('t') ? 'b' : 't'}${handle.includes('l') ? 'r' : 'l'}`;
}

test('angle normalizes finite degrees to [-180, 180) and defaults invalid values to zero', () => {
    assert.equal(CanvasSelectionRotation.angle(180), -180);
    assert.equal(CanvasSelectionRotation.angle(-180), -180);
    assert.equal(CanvasSelectionRotation.angle(540), -180);
    assert.equal(CanvasSelectionRotation.angle(361.5), 1.5);
    assert.equal(CanvasSelectionRotation.angle(-181), 179);
    assert.equal(CanvasSelectionRotation.angle(undefined), 0);
    assert.equal(CanvasSelectionRotation.angle(Number.NaN), 0);
    assert.equal(CanvasSelectionRotation.angle(Number.POSITIVE_INFINITY), 0);
    assert.equal(CanvasSelectionRotation.angle('45'), 0);
});

test('corners preserve the rectangle at zero rotation and rotate clockwise in world coordinates', () => {
    const selection = {x: 0, y: 0, layerWidth: 256, layerHeight: 128};
    assert.deepEqual(CanvasSelectionRotation.corners(selection), [
        {x: 0, y: 0}, {x: 256, y: 0}, {x: 256, y: 128}, {x: 0, y: 128}
    ]);
    assert.deepEqual(CanvasSelectionRotation.corners({...selection, rotation: 90}), [
        {x: 192, y: -64}, {x: 192, y: 192}, {x: 64, y: 192}, {x: 64, y: -64}
    ]);
    assert.deepEqual(CanvasSelectionRotation.bounds({...selection, rotation: 90}), {
        x: 64, y: -64, width: 128, height: 256
    });
});

test('corners support 45-degree and negative rotations around the selection center', () => {
    const selection = {x: 0, y: 0, layerWidth: 256, layerHeight: 128};
    const diagonal = CanvasSelectionRotation.corners({...selection, rotation: 45});
    const rootHalf = Math.SQRT1_2;
    closePoint(diagonal[0], {x: 128 - 64 * rootHalf, y: 64 - 192 * rootHalf});
    closePoint(diagonal[1], {x: 128 + 192 * rootHalf, y: 64 + 64 * rootHalf});
    closePoint(diagonal[2], {x: 128 + 64 * rootHalf, y: 64 + 192 * rootHalf});
    closePoint(diagonal[3], {x: 128 - 192 * rootHalf, y: 64 - 64 * rootHalf});
    assert.deepEqual(CanvasSelectionRotation.bounds({...selection, rotation: 45}), {
        x: -8, y: -72, width: 272, height: 272
    });

    const negative = CanvasSelectionRotation.corners({...selection, x: 20, y: 30, rotation: -90});
    assert.deepEqual(negative, [
        {x: 84, y: 222}, {x: 84, y: -34}, {x: 212, y: -34}, {x: 212, y: 222}
    ]);
});

test('zero-rotation bounds retain rounded legacy geometry', () => {
    assert.deepEqual(CanvasSelectionRotation.bounds({
        x: 2.4, y: -3.6, layerWidth: 255.6, layerHeight: 127.6, rotation: 360
    }), {x: 2, y: -4, width: 256, height: 128});
});

test('resize preserves the opposite world corner at 45 and 90 degrees', () => {
    const start = {x: 37.25, y: -11.5, layerWidth: 256, layerHeight: 128};
    for (const {rotation, handle, localDx, localDy} of [
        {rotation: 45, handle: 'br', localDx: 80, localDy: 32},
        {rotation: 90, handle: 'tl', localDx: -64, localDy: -40}
    ]) {
        const original = {...start, rotation};
        const radians = rotation * Math.PI / 180;
        const dx = localDx * Math.cos(radians) - localDy * Math.sin(radians);
        const dy = localDx * Math.sin(radians) + localDy * Math.cos(radians);
        const originalAnchor = namedCorners(original)[oppositeHandle(handle)];
        const resized = CanvasSelectionRotation.resize(original, handle, dx, dy, snap64);
        const resizedAnchor = namedCorners({...original, ...resized})[oppositeHandle(handle)];
        closePoint(resizedAnchor, originalAnchor);
        assert.equal(resized.layerWidth, snap64(handle.includes('l') ? start.layerWidth - localDx : start.layerWidth + localDx));
        assert.equal(resized.layerHeight, snap64(handle.includes('t') ? start.layerHeight - localDy : start.layerHeight + localDy));
    }
});

test('resize snaps dimensions to the supplied minimum while retaining a nonzero world anchor', () => {
    const start = {x: 37, y: 29, layerWidth: 128, layerHeight: 128, rotation: 0};
    const originalAnchor = namedCorners(start).br;
    const resized = CanvasSelectionRotation.resize(start, 'tl', 100, 0, snap64);
    assert.equal(resized.layerWidth, 64);
    assert.equal(resized.layerHeight, 128);
    assert.equal(resized.x, 101);
    assert.equal(resized.y, 29);
    closePoint(namedCorners({...start, ...resized}).br, originalAnchor);
});
