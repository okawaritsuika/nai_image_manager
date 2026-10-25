const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function gallery(now = () => 0) {
    let nextId = 0;
    const frames = new Map();
    const menu = {style: {}};
    const inpaintItem = {textContent: ''};
    const context = vm.createContext({
        console, performance: {now}, document: {getElementById: id => ({imageContextMenu: menu, galleryContextInpaint: inpaintItem}[id] || null), addEventListener() {}},
        window: {addEventListener() {}, innerWidth: 1280, innerHeight: 720},
        localStorage: {getItem: () => null},
        requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
        cancelAnimationFrame: id => frames.delete(id)
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/index.js'), 'utf8'), context);
    const flush = () => {
        let limit = 1000;
        while (frames.size && limit-- > 0) {
            const [id, callback] = frames.entries().next().value;
            frames.delete(id);
            callback();
        }
        assert.ok(limit > 0, 'rendering must settle');
    };
    return {context, frames, flush};
}

test('small image settings limit columns by the real grid width without changing saved scale', () => {
    const {context} = gallery();
    vm.runInContext('galleryDesignSettings = normalizeGalleryDesignSettings({imageScalePercent: 40});', context);
    let style = {paddingLeft: '40px', paddingRight: '40px', columnGap: '20px'};
    context.window.getComputedStyle = () => style;
    assert.equal(context.getGalleryColumnCountForScale(40), 8);
    assert.equal(context.getGalleryEffectiveColumnCount({clientWidth: 800}), 5);
    style = {paddingLeft: '0px', paddingRight: '0px', columnGap: '16px'};
    assert.equal(context.getGalleryEffectiveColumnCount({clientWidth: 504}), 3);
    assert.equal(context.getGalleryEffectiveColumnCount({clientWidth: 100}), 1);
    assert.equal(context.getGalleryEffectiveColumnCount({clientWidth: 0}), 8);
    assert.equal(context.getGalleryEffectiveColumnCount(), 8);
    vm.runInContext('galleryDesignSettings.fixedSizeMode = true;', context);
    const layout = context.getGalleryGridLayout({clientWidth: 504});
    assert.equal(layout.fixed, true);
    assert.equal(layout.columns, 3);
    assert.equal(vm.runInContext('galleryDesignSettings.imageScalePercent', context), 40);
});

test('configured batches retain order while limiting each DOM addition to 32 cards', async () => {
    const {context, frames, flush} = gallery();
    const ranges = [];
    let complete = 0;
    let batches = 0;
    const batcher = context.createGalleryRenderBatcher({total: 235, batchSize: 100,
        append: (start, end) => ranges.push([start, end]), onProgress() {},
        onComplete: () => complete++, onBatchComplete: () => batches++});
    batcher.next();
    assert.equal(batcher.count, 32);
    batcher.next(); // An observer event during rendering must not duplicate cards.
    assert.equal(frames.size, 1);
    flush();
    await batcher.firstBatchReady;
    assert.equal(batcher.count, 100);
    assert.equal(batches, 1); // Caller can reobserve a still-visible sentinel.
    batcher.next();
    flush();
    assert.equal(batcher.count, 200);
    batcher.next();
    flush();
    batcher.next();
    assert.equal(complete, 1);
    assert.equal(batcher.count, 235);
    assert.ok(ranges.every(([start, end]) => end - start <= 32));
    assert.deepEqual(ranges.flatMap(([start, end]) => Array.from({length: end - start}, (_, i) => start + i)),
        Array.from({length: 235}, (_, i) => i));
});

test('slow cards yield by elapsed time without losing the configured batch or order', () => {
    let elapsed = 0;
    const {context, flush} = gallery(() => elapsed);
    const rendered = [];
    const frames = [];
    let previous = 0;
    const batcher = context.createGalleryRenderBatcher({total: 120, batchSize: 100,
        append: start => { rendered.push(start); elapsed += 3; },
        onProgress: () => { frames.push(elapsed - previous); previous = elapsed; }, onComplete() {}});
    batcher.next();
    assert.equal(batcher.count, 3);
    flush();
    assert.equal(batcher.count, 100);
    assert.ok(frames.every(duration => duration <= 9));
    assert.deepEqual(rendered, Array.from({length: 100}, (_, i) => i));
    batcher.next();
    flush();
    assert.equal(batcher.count, 120);
});

test('cancelling a replaced view resolves its wait and never appends stale frames', async () => {
    const {context, frames, flush} = gallery();
    let appended = 0;
    let completed = 0;
    const batcher = context.createGalleryRenderBatcher({total: 2000, batchSize: 1000,
        append: (start, end) => { appended += end - start; }, onProgress() {},
        onComplete: () => completed++});
    batcher.next();
    const staleCallback = [...frames.values()][0];
    batcher.cancel();
    await batcher.firstBatchReady;
    staleCallback();
    batcher.next();
    flush();
    assert.equal(appended, 32);
    assert.equal(completed, 0);
    assert.equal(frames.size, 0);
});

test('empty image lists complete without leaving a pending scroll wait', async () => {
    const {context, frames} = gallery();
    let complete = false;
    const batcher = context.createGalleryRenderBatcher({total: 0, batchSize: 100,
        append() { assert.fail('nothing to render'); }, onProgress() {},
        onComplete: () => { complete = true; }});
    batcher.next();
    await batcher.firstBatchReady;
    assert.equal(complete, true);
    assert.equal(frames.size, 0);
});

test('display previews share overwrite versions while original image URLs stay full resolution', () => {
    const {context} = gallery();
    const name = 'samples/image #1.png';
    const original = '/image/samples/image%20%231.png';
    assert.equal(context.getGalleryImageSrc(name), original);
    assert.equal(context.getGalleryThumbnailSrc(name), `${original}?preview=768`);
    vm.runInContext(`galleryImageVersionMap.set(${JSON.stringify(name)}, 42)`, context);
    assert.equal(context.getGalleryImageSrc(name), `${original}?t=42`);
    assert.equal(context.getGalleryThumbnailSrc(name), `${original}?t=42&preview=768`);
});

test('thumbnail pixels are never sent to canvas as original dimensions', () => {
    const {context} = gallery();
    const open = dataset => {
        context.openImageContextMenu({preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5,
            currentTarget: {tagName: 'IMG', naturalWidth: 768, naturalHeight: 512, dataset}},
        'sample.png', '/image/sample.png');
        return vm.runInContext('activeImageContext', context);
    };
    const known = open({originalWidth: '6000', originalHeight: '4000'});
    // Even indexed dimensions can be unrotated EXIF dimensions. Canvas reads
    // the original when these are zero instead of trusting either estimate.
    assert.equal(known.width, 0);
    assert.equal(known.height, 0);
    const unknown = open({originalWidth: '0', originalHeight: '0'});
    assert.equal(unknown.width, 0);
    assert.equal(unknown.height, 0);
    assert.equal(unknown.imgSrc, '/image/sample.png');
});

test('recycled cards reserve the learned preview ratio without changing original dimensions', () => {
    const {context} = gallery();
    const item = {w: 0, h: 0};
    function preview(width = 0, height = 0) {
        return {style: {}, naturalWidth: width, naturalHeight: height, complete: width > 0,
            addEventListener(type, listener) { this[type] = listener; }};
    }
    const first = preview();
    context.preserveGalleryImageAspectRatio(first, item);
    first.naturalWidth = 320; first.naturalHeight = 960; first.load();
    const remounted = preview();
    context.preserveGalleryImageAspectRatio(remounted, item);
    assert.equal(remounted.style.aspectRatio, '320 / 960');
    assert.equal(item.w, 0); assert.equal(item.h, 0);
    remounted.load(); // A failed/unfinished image must not erase the learned size.
    assert.equal(remounted.style.aspectRatio, '320 / 960');
    const cached = preview(768, 512);
    context.preserveGalleryImageAspectRatio(cached, item);
    assert.equal(cached.style.aspectRatio, '768 / 512');
});
