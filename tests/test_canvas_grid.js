const {test} = require('node:test');
const assert = require('node:assert/strict');
const CanvasGrid = require('../static/canvas_grid');

function pixels(lines, size) {
    return lines.map((line) => (line.position * size) / 100);
}

function assertClose(actual, expected, tolerance = 1e-8) {
    assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' differs from ' + expected);
}

test('density defaults to eight and settings contain only the supported fields', () => {
    assert.deepEqual(CanvasGrid.DEFAULT_SETTINGS, {
        density: 8,
        center: false,
        thin: false,
        major: false
    });
    assert.deepEqual(CanvasGrid.normalizeSettings({density: 8, columns: 4, majorEvery: 2}), {
        density: 8,
        center: false,
        thin: false,
        major: false
    });
    assert.deepEqual(CanvasGrid.getSettings(), CanvasGrid.DEFAULT_SETTINGS);
});

test('density rounds and clamps finite values while invalid input keeps the last valid setting', () => {
    assert.deepEqual(CanvasGrid.normalizeSettings({
        density: 32.6,
        center: false,
        thin: true,
        major: true
    }), {
        density: 32,
        center: false,
        thin: true,
        major: true
    });
    assert.deepEqual(CanvasGrid.normalizeSettings({
        density: 2.6,
        center: true,
        thin: false,
        major: false
    }), {
        density: 3,
        center: true,
        thin: false,
        major: false
    });
    assert.deepEqual(CanvasGrid.normalizeSettings({
        density: '',
        center: false,
        thin: true,
        major: false
    }, {
        density: 12,
        center: true,
        thin: false,
        major: true
    }), {
        density: 12,
        center: false,
        thin: true,
        major: false
    });
    assert.deepEqual(CanvasGrid.normalizeSettings({
        density: Number.POSITIVE_INFINITY
    }, {
        density: 5,
        center: false,
        thin: true,
        major: true
    }), {
        density: 5,
        center: false,
        thin: true,
        major: true
    });
    assert.equal(CanvasGrid.normalizeSettings({density: null}, {density: 5}).density, 5);
    assert.equal(CanvasGrid.normalizeSettings({density: 0}).density, 1);
    assert.equal(CanvasGrid.normalizeSettings({density: 100}).density, 32);
});

test('grid and guide lines are all hidden by default', () => {
    assert.deepEqual(CanvasGrid.buildGridLines(CanvasGrid.DEFAULT_SETTINGS, 960, 3072), {
        thin: [],
        major: [],
        center: []
    });
});

test('density sets square pixel spacing from the shorter canvas side', () => {
    const lines = CanvasGrid.buildGridLines({
        density: 8,
        center: false,
        thin: true,
        major: false
    }, 960, 3072);
    const xPixels = pixels(lines.thin.filter((line) => line.axis === 'x'), 960);
    const yPixels = pixels(lines.thin.filter((line) => line.axis === 'y'), 3072);

    assert.deepEqual(xPixels, [120, 240, 360, 480, 600, 720, 840]);
    assert.equal(yPixels.length, 25);
    assertClose(yPixels[0], 96);
    assertClose(yPixels[yPixels.length - 1], 2976);
    for (let index = 1; index < yPixels.length; index += 1) {
        assertClose(yPixels[index] - yPixels[index - 1], 120);
    }
});

test('center stays at fifty percent for odd density and asymmetric canvas dimensions', () => {
    const lines = CanvasGrid.buildGridLines({
        density: 7,
        center: true,
        thin: false,
        major: false
    }, 1280, 800);

    assert.deepEqual(lines, {
        thin: [],
        major: [],
        center: [{axis: 'x', position: 50}, {axis: 'y', position: 50}]
    });
});

test('grid lines are centered symmetrically and major every fourth offset', () => {
    const lines = CanvasGrid.buildGridLines({
        density: 12,
        center: false,
        thin: true,
        major: true
    }, 960, 960);

    for (const axis of ['x', 'y']) {
        const major = lines.major.filter((line) => line.axis === axis).map((line) => line.position);
        const thin = lines.thin.filter((line) => line.axis === axis).map((line) => line.position);
        assert.equal(major.length, 3);
        assertClose(major[0], 100 * 160 / 960);
        assert.equal(major[1], 50);
        assertClose(major[2], 100 * 800 / 960);
        for (const position of thin) {
            assert.ok(thin.some((other) => Math.abs((position + other) - 100) < 1e-8));
        }
        assert.equal(major.some((position) => thin.some((other) => Math.abs(position - other) < 1e-8)), false);
    }
});

test('higher density produces more grid lines', () => {
    const settings = {center: false, thin: true, major: false};
    const sparse = CanvasGrid.buildGridLines({...settings, density: 4}, 1280, 720);
    const dense = CanvasGrid.buildGridLines({...settings, density: 16}, 1280, 720);

    assert.ok(dense.thin.length > sparse.thin.length);
});

test('extreme aspect ratios remain bounded and centered', () => {
    const lines = CanvasGrid.buildGridLines({
        density: 1,
        center: true,
        thin: true,
        major: true
    }, 1000000, 1);

    assert.ok(lines.thin.length + lines.major.length <= 1022);
    assert.equal(lines.center.length, 2);
    assert.ok(lines.thin.length + lines.major.length + lines.center.length <= 1024);
});

test('invalid canvas dimensions return no grid lines', () => {
    const settings = {density: 8, center: true, thin: true, major: true};
    for (const [width, height] of [[0, 10], [-1, 10], [10, 0], [10, Number.NaN], [Number.POSITIVE_INFINITY, 10]]) {
        assert.deepEqual(CanvasGrid.buildGridLines(settings, width, height), {
            thin: [],
            major: [],
            center: []
        });
    }
});

test('all toggles off produces no grid lines', () => {
    assert.deepEqual(CanvasGrid.buildGridLines({
        density: 8,
        center: false,
        thin: false,
        major: false
    }, 960, 3072), {thin: [], major: [], center: []});
});

test('the browser global exposes the CommonJS API', () => {
    assert.equal(globalThis.CanvasGrid, CanvasGrid);
});
