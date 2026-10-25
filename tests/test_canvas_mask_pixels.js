const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../static/canvas.js'), 'utf8');
const start = source.indexOf('function redrawMaskOverlay(');
const context = vm.createContext({});
vm.runInContext(source.slice(start, source.indexOf('\nasync function persistClipMask(', start)), context);

test('partial updates and erasing match a full redraw pixel for pixel, including edge clipping', () => {
    const width = 32, height = 24;
    const mask = new Uint8ClampedArray(width * height * 4), output = mask.slice();
    const reads = [];
    const maskCanvas = {width, height, getContext: () => ({getImageData(x, y, w, h) {
        reads.push([x, y, w, h]); const data = new Uint8ClampedArray(w * h * 4);
        for (let row = 0; row < h; row++) data.set(mask.subarray(((y + row) * width + x) * 4, ((y + row) * width + x + w) * 4), row * w * 4);
        return {data, width: w, height: h};
    }})};
    const overlay = {getContext: () => ({putImageData(image, x, y) {
        for (let row = 0; row < image.height; row++) output.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * width + x) * 4);
    }})};
    for (let round = 0; round < 20; round++) {
        const left = round % 7 - 2, top = round % 5 - 1, right = left + 9, bottom = top + 8;
        for (let y = Math.max(0, top); y < bottom; y++) for (let x = Math.max(0, left); x < right; x++) {
            const i = (y * width + x) * 4; mask.set([255, 255, 255, round % 3 ? (x * 17 + y * 9) % 256 : 0], i);
        }
        context.redrawMaskOverlay(maskCanvas, overlay, {left, top, right, bottom});
        const full = mask.slice();
        for (let i = 0; i < full.length; i += 4) if (full[i + 3]) full.set([72, 160, 255, Math.min(150, full[i + 3])], i);
        assert.deepEqual(output, full);
    }
    assert.ok(reads.every(([, , w, h]) => w * h <= 72));
});

test('a 100 by 100 brush region on a 4096 canvas reads 40000 bytes, with no full canvas allocation', () => {
    let bytes = 0;
    const canvas = {width: 4096, height: 4096, getContext: () => ({getImageData(x, y, w, h) {
        assert.deepEqual([x, y, w, h], [1998, 1998, 100, 100]);
        const data = new Uint8ClampedArray(w * h * 4); bytes = data.byteLength; return {data};
    }})};
    context.redrawMaskOverlay(canvas, {getContext: () => ({putImageData() {}})},
        {left: 1998, top: 1998, right: 2098, bottom: 2098});
    assert.equal(bytes, 40000);
});
