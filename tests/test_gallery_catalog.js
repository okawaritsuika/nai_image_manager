const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createGalleryCatalogLoader} = require('../static/gallery_catalog');
const node = (name = 'a', count = 2) => ({name, images: [], folders: [], _images_pending: count, _image_sources: [name]});

test('virtual results request metadata only for matching paths in bounded deduplicated pages', async () => {
    const calls = [];
    const loader = createGalleryCatalogLoader(async page => {
        calls.push(page); return {images: page.paths.map(path => ({path, ctime: 123}))};
    });
    const paths = Array.from({length: 1200}, (_, i) => `synthetic/${i}`);
    const result = await loader.loadPaths([...paths, paths[0]]);
    assert.deepEqual(calls.map(p => p.paths.length), [512, 512, 176]);
    assert.equal(result.length, 1200);
    assert.ok(calls.every(p => !p.folders));
    loader.cancel(); await assert.rejects(loader.loadPaths(['late']));
});
test('opening one folder reads only that folder with bounded pages and preserves node identity', async () => {
    const a = node(), b = node('b'); const calls = [];
    const loader = createGalleryCatalogLoader(async page => { calls.push(page); return {
        images: [{path: page.after ? 'a/2' : 'a/1', name: page.after ? '2' : '1', mtime: page.after ? 2 : 1}],
        next_cursor: page.after ? null : 'a/1'}; });
    await loader.load(a);
    assert.equal(calls.length, 2); assert.ok(calls.every(p => p.limit === 512 && p.folders[0] === 'a'));
    assert.equal(a.images.length, 2); assert.equal(a.images[0].name, '2');
    assert.equal(b.images.length, 0); assert.equal(loader.pending(a), false);
    await loader.load(a); assert.equal(calls.length, 2);
});
test('recursive date/multi-folder loads all descendants and coalesces concurrent requests', async () => {
    const a = node('a', 1), b = node('b', 1); let calls = 0;
    const loader = createGalleryCatalogLoader(async page => { calls++; return {images: page.folders.map(folder => ({path: `${folder}/1`, name: folder}))}; });
    const root = {folders: [a, b], images: []};
    await Promise.all([loader.load(root, true), loader.load(root, true)]);
    assert.equal(calls, 1); assert.equal(loader.pending(root, true), false);
});

test('category/date loading batches small folders, limits concurrency and reuses loaded nodes', async () => {
    const folders = Array.from({length: 1000}, (_, i) => node(`synthetic/${i}`, 1));
    let calls = 0, active = 0, peak = 0;
    const loader = createGalleryCatalogLoader(async page => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        assert.ok(page.folders.length <= 128);
        return {images: page.folders.map(folder => ({path: `${folder}/1.png`, name: '1.png'}))};
    });
    const root = {folders, images: []};
    await Promise.all([loader.load(root, true), loader.load(folders[500])]);
    assert.equal(calls, 8);
    assert.ok(peak > 1 && peak <= 4);
    assert.ok(folders.every(folder => folder.images[0].path === `${folder.name}/1.png`));
    await loader.load(root, true);
    assert.equal(calls, 8);
});

test('batched merged rating sources keep comic order and failed batches can retry atomically', async () => {
    const comic = node('comic'); comic.is_comic = true;
    comic._image_sources = ['comic', '_R-18/comic'];
    const other = node('other', 1);
    let incomplete = true;
    const loader = createGalleryCatalogLoader(async () => ({images: [
        {path: '_R-18/comic/2.png', name: '2.png', mtime: 2},
        {path: 'comic/1.png', name: '1.png', mtime: 1},
        ...(incomplete ? [] : [{path: 'other/1.png', name: '1.png'}])
    ]}));
    const root = {folders: [comic, other]};
    await assert.rejects(loader.load(root, true));
    assert.deepEqual(comic.images, []);
    assert.deepEqual(other.images, []);
    incomplete = false;
    await loader.load(root, true);
    assert.deepEqual(comic.images.map(image => image.name), ['1.png', '2.png']);
    assert.equal(other.images.length, 1);
});

test('cancelling a category load stops queued batches and publishes no late responses', async () => {
    const folders = Array.from({length: 700}, (_, i) => node(`synthetic/${i}`, 1));
    const releases = [];
    let calls = 0;
    const loader = createGalleryCatalogLoader(async page => {
        calls++;
        await new Promise(resolve => releases.push(resolve));
        return {images: page.folders.map(folder => ({path: `${folder}/1.png`, name: '1.png'}))};
    });
    const request = loader.load({folders}, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 4);
    loader.cancel();
    releases.forEach(resolve => resolve());
    await assert.rejects(request);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 4);
    assert.ok(folders.every(folder => folder._images_pending === 1 && folder.images.length === 0));
});
test('failure, changed counts and cancellation never publish an incomplete folder', async () => {
    for (const kind of ['error', 'count', 'cancel']) {
        const a = node(); let loader;
        loader = createGalleryCatalogLoader(async () => {
            if (kind === 'error') throw new Error('offline');
            if (kind === 'cancel') loader.cancel();
            return {images: [{name: 'partial'}]};
        });
        await assert.rejects(loader.load(a)); assert.deepEqual(a.images, []); assert.equal(a._images_pending, 2);
    }
});

test('batched folders retain upscaled images in their indexed parent including merged ratings', async () => {
    const solo = node('1_Solo/A', 3), duo = node('2_Duo/B', 1);
    solo._image_sources.push('_R-18/1_Solo/A');
    const loader = createGalleryCatalogLoader(async () => ({images: [
        {path: '1_Solo/A/original.png', name: 'original.png', mtime: 1},
        {path: '1_Solo/A/_upscaled/large.png', name: 'large.png', mtime: 2},
        {path: '_R-18/1_Solo/A/_upscaled/rated.png', name: 'rated.png', mtime: 3},
        {path: '2_Duo/B/_upscaled/pair.png', name: 'pair.png', mtime: 4}
    ]}));
    await loader.load({folders: [solo, duo]}, true);
    assert.deepEqual(solo.images.map(image => image.name), ['rated.png', 'large.png', 'original.png']);
    assert.equal(duo.images[0].path, '2_Duo/B/_upscaled/pair.png');
    assert.equal(loader.pending(solo), false);
    assert.equal(loader.pending(duo), false);
});
