const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/inpaint_grid_brush.js'), 'utf8'), context);
const brush = vm.runInContext('InpaintGridBrush', context);

function mask(width, height) {
    const pixels = new Uint8Array(width * height);
    const ctx = {
        canvas: {width, height}, save() {}, restore() {},
        fillRect(x, y, w, h) {
            assert.equal(x % 8, 0);
            assert.equal(y % 8, 0);
            assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
            assert.ok(x + w <= width && (w % 8 === 0 || x + w === width));
            assert.ok(y + h <= height && (h % 8 === 0 || y + h === height));
            for (let row = y; row < y + h; row++) {
                pixels.fill(this.globalCompositeOperation === 'destination-out' ? 0 : 1,
                    row * width + x, row * width + x + w);
            }
        }
    };
    return {pixels, paint: (from, to, diameter, erase = false) =>
        brush.paint(ctx, from, to, diameter, '#ffffff', erase)};
}

test('an 8-pixel dot covers one tile at its center and both tiles across an edge', () => {
    for (const [x, right] of [[4, 8], [8, 16]]) {
        const result = mask(32, 24);
        const point = {x, y: 4};
        assert.deepEqual({...result.paint(point, point, 8)}, {left: 0, top: 0, right, bottom: 8});
        for (let i = 0; i < result.pixels.length; i++) {
            assert.equal(result.pixels[i], Number(i % 32 < right && i < 32 * 8));
        }
    }
});

test('a circular footprint includes touched tiles, skips distant corners, and erases the same pixels', () => {
    const result = mask(40, 40);
    const center = {x: 20, y: 20};
    result.paint(center, center, 32);
    for (let y = 0; y < 40; y++) {
        for (let x = 0; x < 40; x++) {
            const cornerTile = (x < 8 || x >= 32) && (y < 8 || y >= 32);
            assert.equal(result.pixels[y * 40 + x], Number(!cornerTile));
        }
    }
    result.paint(center, center, 32, true);
    assert.ok(result.pixels.every(pixel => pixel === 0));
});

test('a fast diagonal stroke matches its subdivisions and reaches the clipped last tile', () => {
    const whole = mask(43, 29), split = mask(43, 29);
    const from = {x: 1, y: 1}, middle = {x: 21, y: 14}, to = {x: 41, y: 27};
    const bounds = whole.paint(from, to, 8);
    split.paint(from, middle, 8);
    split.paint(middle, to, 8);
    assert.deepEqual(whole.pixels, split.pixels);
    assert.deepEqual({...bounds}, {left: 0, top: 0, right: 43, bottom: 29});
    for (let step = 0; step <= 40; step++) {
        assert.equal(whole.pixels[Math.floor(1 + step * 26 / 40) * 43 + 1 + step], 1);
    }
    assert.equal(whole.pixels.at(-1), 1);
    assert.equal(whole.pixels[42], 0);
    const outside = {x: 60, y: 32};
    assert.equal(whole.paint(outside, outside, 8), null);
    const edge = mask(19, 11);
    const missesLastTile = {x: 24, y: 4};
    assert.equal(edge.paint(missesLastTile, missesLastTile, 8), null);
    assert.ok(edge.pixels.every(pixel => pixel === 0));
});

test('the hover outline follows the painted tile at image scale, including a clipped edge', () => {
    const overlay = {width: 19, height: 11, style: {left: '7px', top: '3px', width: '95px', height: '55px'}};
    const attributes = {}, path = {}, classes = {};
    const cursor = {
        style: {}, setAttribute(name, value) { attributes[name] = value; },
        firstElementChild: {setAttribute(name, value) { path[name] = value; }},
        classList: {toggle(name, enabled) { classes[name] = enabled; }}
    };
    for (const [point, diameter, erase] of [[{x: 4, y: 4}, 8, false], [{x: 18, y: 10}, 2, true]]) {
        const painted = mask(overlay.width, overlay.height).paint(point, point, diameter);
        brush.showCursor(cursor, overlay, point, diameter, erase);
        assert.equal(attributes.viewBox, '0 0 19 11');
        assert.equal(cursor.style.display, 'block');
        for (const name of ['left', 'top', 'width', 'height']) assert.equal(cursor.style[name], overlay.style[name]);
        assert.equal(classes.eraser, erase);
        const {left, top, right, bottom} = painted;
        assert.equal(path.d, `M${left} ${top}H${right}V${bottom}H${left}V${top}Z`);
    }
    brush.showCursor(cursor, overlay, {x: 24, y: 4}, 8, false);
    assert.equal(cursor.style.display, 'none');
});
