const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function context() {
    const ctx = vm.createContext({console, document: {addEventListener() {}, getElementById: () => ({style: {}})},
        window: {addEventListener() {}}, localStorage: {getItem: () => null}, confirm: () => true,
        fetch: async () => ({ok: true, json: async () => ({status: 'success', new_path: '_R-18/new.png'})})});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/index.js'), 'utf8'), ctx);
    return ctx;
}
test('virtual metadata preserves original character names without loading unrelated folders', async () => {
    const ctx = context();
    vm.runInContext(`rootTree = {folders:[{path:'2_Duo/Pair',char_names:['Alice','Bob'],
        _image_sources:['2_Duo/Pair'],images:[],folders:[]}]};
        galleryCatalogLoader = {loadPaths:async paths => paths.map(path => ({path,name:'one.png',ctime:123}))};`, ctx);
    const images = await ctx.galleryVirtualFindImagesByPaths(['2_Duo/Pair/one.png']);
    assert.deepEqual(Array.from(images[0].galleryParentCharNames), ['Alice', 'Bob']);
    assert.equal(images[0].ctime, 123);
    assert.equal(vm.runInContext('rootTree.folders[0].images.length', ctx), 0);
});
test('catalog scope fallback collects freshly hydrated nodes instead of the stale root snapshot', async () => {
    const ctx = context();
    vm.runInContext(`rootTree={images:[],folders:[{path:'1_Solo/A',images:[{path:'1_Solo/A/a.png',name:'a.png'}],folders:[]}]};
        galleryVirtualRootNode={virtualRootImages:[]}; galleryCatalogLoader={};`, ctx);
    assert.equal(ctx.getGalleryVirtualAllImages().length, 1);
});
test('successful restore and rating move refresh logical data so recycling cannot resurrect old paths', async () => {
    const ctx = context();
    let refreshes = 0; ctx.loadData = async () => { refreshes++; };
    await ctx.restoreItem('_TRASH/a.png', 'box-1');
    await ctx.instantToggleNsfw('1_Solo/a.png', {innerHTML: 'move'}, 'box-1');
    assert.equal(refreshes, 2);
});
