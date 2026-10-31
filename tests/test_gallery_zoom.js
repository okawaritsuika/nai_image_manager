const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const indexSource = fs.readFileSync(path.join(root, 'static/index.js'), 'utf8');

test('project comparison gathers both project sides and keeps the selected image when unpinned', () => {
    const f = gallery([{path: 'sample/a.png'}], '#project=sample');
    let prepared;
    f.context.ProjectZoomCompare = {close() {}, prepare(config) { prepared = config; }, isActive: () => false};
    f.context.document.querySelectorAll = selector => selector === '#dakiContent .flex-masonry'
        ? [{galleryZoomImages: [{path: 'sample/a.png'}]},
            {galleryZoomImages: [{path: 'sample/b.png'}, {path: 'sample/a.png'}]}]
        : [];
    f.context.openZoom('/image/sample/a.png');
    assert.deepEqual(Array.from(prepared.images, item => item.path), ['sample/a.png', 'sample/b.png']);
    prepared.onSelect('sample/b.png');
    assert.equal(f.img.src, '/image/sample/b.png');
    f.press('ArrowLeft');
    assert.equal(f.img.src, '/image/sample/a.png');
    assert.equal(prepared.current.path, 'sample/a.png', 'navigation refreshes the next comparison baseline');
});

test('comparison blocks image navigation and destructive shortcuts and Escape closes the picker first', async () => {
    const f = gallery([{path: 'sample/a.png'}, {path: 'sample/b.png'}], '#project=sample');
    let picking = true;
    let closed = false;
    f.context.ProjectZoomCompare = {
        close() { closed = true; }, prepare() {}, isActive: () => true,
        isPicking: () => picking, closePicker() { picking = false; },
    };
    f.context.openZoom('/image/sample/a.png');
    closed = false;
    f.press('ArrowRight');
    f.press('ArrowDown');
    await f.context.runGalleryZoomAction('delete');
    assert.equal(f.img.src, '/image/sample/a.png');
    f.press('Escape');
    assert.equal(picking, false);
    assert.equal(f.layer.style.display, 'flex');
    f.press('Escape');
    assert.equal(closed, true);
    assert.equal(f.layer.style.display, 'none');
});

test('ordinary gallery enlargement does not prepare project comparison', () => {
    const f = gallery([{path: 'sample/a.png'}]);
    f.context.ProjectZoomCompare = {close() {}, prepare() { throw new Error('project only'); }, isActive: () => false};
    f.context.openZoom('/image/sample/a.png');
    assert.equal(f.img.src, '/image/sample/a.png');
});

function ordered(images, order = 'newest', isComic = false) {
    const context = vm.createContext({images, galleryImageOrder: order, parentNode: {is_comic: isComic}, g: {}});
    const sort = indexSource.slice(indexSource.indexOf('    const orderedImages ='),
        indexSource.indexOf('    const appendImageBatch ='));
    vm.runInContext(sort, context);
    return Array.from(context.g.galleryZoomImages);
}

function gallery(images, hash = '#gallery') {
    const img = {src: ''};
    const origin = {isConnected: true, focused: false, focus() { this.focused = true; }};
    const layer = {style: {display: 'none'}, focus() { document.activeElement = this; }};
    const document = {
        readyState: 'loading',
        activeElement: origin,
        getElementById: id => ({zoomImg: img, zoomLayer: layer}[id] || null),
        querySelectorAll: selector => selector.includes('.flex-masonry') ? [{galleryZoomImages: images}] : [],
        addEventListener: () => {},
    };
    const context = vm.createContext({document, addEventListener: () => {},
        confirm: () => { throw new Error('Unexpected confirmation'); },
        console, URLSearchParams, location: new URL(hash, 'http://localhost/'), localStorage: {getItem: () => null}});
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(root, 'static/daki.js'), 'utf8'), context);
    vm.runInContext(indexSource, context);
    vm.runInContext(fs.readFileSync(path.join(root, 'static/gallery_zoom.js'), 'utf8'), context);
    vm.runInContext(fs.readFileSync(path.join(root, 'static/gallery_selection.js'), 'utf8'), context);
    context.loadData = async () => {};
    context.showToast = () => {};
    function press(key, options = {}) {
        const event = {key, target: layer, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; },
            stopImmediatePropagation() { this.stopped = true; }, ...options};
        return context.handleGalleryZoomKeydown(event) || event;
    }
    return {context, img, layer, origin, press};
}

test('creation time controls both orders even when modification order is opposite', () => {
    const images = [{path: 'sample/a.png', ctime: 300, mtime: 100},
        {path: 'sample/b.png', ctime: 100, mtime: 300}, {path: 'sample/c.png', ctime: 200, mtime: 200}];
    assert.deepEqual(ordered(images).map(item => item.path), ['sample/a.png', 'sample/c.png', 'sample/b.png']);
    assert.deepEqual(ordered(images, 'oldest').map(item => item.path), ['sample/b.png', 'sample/c.png', 'sample/a.png']);
    assert.equal(images[1].path, 'sample/b.png');
});

test('legacy timestamps and equal creation times have a stable fallback', () => {
    const images = [{path: 'b.png', mtime: 100}, {path: 'a.png', ctime: null, mtime: 100}, {path: 'c.png', mtime: 50}];
    assert.deepEqual(ordered(images).map(item => item.path), ['a.png', 'b.png', 'c.png']);
});

test('comics keep natural page order for both time orders', () => {
    const images = [10, 2, 1].map(number => ({name: `page_${number}.png`, path: `comic/page_${number}.png`, ctime: number}));
    for (const order of ['newest', 'oldest']) {
        assert.deepEqual(ordered(images, order, true).map(item => item.name), ['page_1.png', 'page_2.png', 'page_10.png']);
    }
});

test('arrow keys follow the filtered logical list through lazy batch boundaries and stop at the ends', () => {
    const images = Array.from({length: 1002}, (_, index) => ({path: `sample/${index}.png`}));
    const {context, img, press} = gallery(images);
    context.openZoom('/image/sample/999.png?t=1');
    const event = press('ArrowRight');
    assert.equal(img.src, '/image/sample/1000.png');
    assert.ok(event.prevented && event.stopped);
    press('ArrowRight');
    press('ArrowRight');
    assert.equal(img.src, '/image/sample/1001.png');
    context.openZoom('/image/sample/0.png');
    press('ArrowLeft');
    assert.equal(img.src, '/image/sample/0.png');
    press('ArrowRight');
    press('ArrowLeft');
    assert.equal(img.src, '/image/sample/0.png');
});

test('navigation uses the current image version and only the filtered images', () => {
    const {context, img, press} = gallery([{path: 'sample/a.png'}, {path: 'sample/c.png'}]);
    context.openZoom('/image/sample/a.png');
    vm.runInContext("galleryImageVersionMap.set('sample/c.png', 42)", context);
    press('ArrowRight');
    assert.equal(img.src, '/image/sample/c.png?t=42');
});

test('closed zoom, text editing and modified shortcuts are left alone; Escape closes and restores focus', () => {
    const {context, img, layer, origin, press} = gallery([{path: 'a.png'}, {path: 'b.png'}]);
    assert.equal(press('ArrowRight').prevented, false);
    context.openZoom('/image/a.png');
    for (const options of [{ctrlKey: true}, {altKey: true}, {metaKey: true}, {isComposing: true},
        {target: {isContentEditable: true}}, {target: {closest: () => ({})}}]) {
        assert.equal(press('ArrowRight', options).prevented, false);
        assert.equal(img.src, '/image/a.png');
    }
    press('Escape');
    assert.equal(layer.style.display, 'none');
    assert.equal(img.src, '');
    assert.ok(origin.focused);
});

test('standalone previews do not inherit the previous gallery sequence', () => {
    const {context, img, press} = gallery([{path: 'a.png'}, {path: 'b.png'}]);
    context.openZoom('/image/a.png');
    context.closeZoom();
    context.openZoom('/upscale-result/standalone.png');
    press('ArrowRight');
    assert.equal(img.src, '/upscale-result/standalone.png');
});

test('arrow delete sends only the displayed image and advances after success', async () => {
    const images = [{path: 'a.png'}, {path: 'b.png'}, {path: 'c.png'}];
    const {context, img, press} = gallery(images);
    vm.runInContext("galleryZoomDeleteEnabled = true; selDeletes.set('unrelated.png', {}); selThumbs.set('other', {path:'thumb.png'})", context);
    let request;
    context.fetch = async (url, options) => {
        request = {url, data: JSON.parse(options.body)};
        return {ok: true, json: async () => ({status: 'success'})};
    };
    context.openZoom('/image/b.png');
    await press('ArrowDown');
    assert.deepEqual(request, {url: '/api/gallery/trash_image', data: {path: 'b.png'}});
    assert.equal(img.src, '/image/c.png');
    assert.equal(images.length, 3, 'lazy grid sequence must not be mutated');
    assert.equal(vm.runInContext("selDeletes.has('unrelated.png') && selThumbs.has('other')", context), true);
    press('ArrowLeft');
    assert.equal(img.src, '/image/a.png');
});

test('arrow tagging requires a valid selected tag, persists it and advances', async () => {
    const {context, img, press} = gallery([{path: 'a.png'}, {path: 'b.png'}, {path:'c.png'}]);
    const writes = [];
    context.updateGalleryImageTag = async (imagePath, tagId) => { writes.push([imagePath, tagId]); return true; };
    vm.runInContext("galleryZoomTagEnabled = true; galleryTagDefs = [{id:'keep', type:'text', value:'Keep'}]", context);
    context.openZoom('/image/a.png');
    await press('ArrowUp');
    vm.runInContext("selectedGalleryAssignmentTagId = 'unknown'", context);
    await press('ArrowUp');
    assert.equal(writes.length, 0);
    assert.equal(img.src, '/image/a.png');
    vm.runInContext("selectedGalleryAssignmentTagId = 'keep'", context);
    await press('ArrowUp');
    assert.deepEqual(writes, [['a.png', 'keep']]);
    assert.equal(img.src, '/image/b.png');
    vm.runInContext("selectedGalleryAssignmentTagId = 'NONE'", context);
    await press('ArrowUp');
    assert.deepEqual(writes[1], ['b.png', '']);
    assert.equal(img.src, '/image/c.png');
});

test('held keys, in-flight requests, disabled actions and trash previews cannot send extra deletes', async () => {
    const {context, img, press} = gallery([{path: 'a.png'}, {path: 'b.png'}, {path:'_TRASH/c.png'}]);
    let resolve;
    let writes = 0;
    context.fetch = async () => { writes++; return new Promise(done => { resolve = done; }); };
    context.openZoom('/image/a.png');
    await press('ArrowDown');
    assert.equal(writes, 0);
    vm.runInContext('galleryZoomDeleteEnabled = true', context);
    await press('ArrowDown', {repeat:true});
    assert.equal(writes, 0);
    const pending = press('ArrowDown');
    await press('ArrowDown');
    press('ArrowRight');
    assert.equal(writes, 1);
    assert.equal(img.src, '/image/a.png');
    resolve({ok:true, json:async()=>({status:'success'})});
    await pending;
    assert.equal(img.src, '/image/b.png');
    context.openZoom('/image/_TRASH/c.png');
    await press('ArrowDown');
    assert.equal(writes, 1);
});

test('failed delete or tag leaves the current image and sequence intact', async () => {
    const {context, img, press} = gallery([{path:'a.png'}, {path:'b.png'}]);
    vm.runInContext("galleryZoomDeleteEnabled = true; galleryZoomTagEnabled = true; selectedGalleryAssignmentTagId = 'NONE'", context);
    context.fetch = async () => ({ok:false, json:async()=>({status:'error', message:'Synthetic failure'})});
    context.updateGalleryImageTag = async () => false;
    context.openZoom('/image/a.png');
    await press('ArrowDown');
    assert.equal(img.src, '/image/a.png');
    await press('ArrowUp');
    assert.equal(img.src, '/image/a.png');
    press('ArrowRight');
    assert.equal(img.src, '/image/b.png');
});

test('tag changes remove images that no longer match the current filter', async () => {
    const {context, img, press} = gallery([{path:'a.png'}, {path:'b.png'}, {path:'c.png'}]);
    vm.runInContext("galleryZoomTagEnabled = true; selectedGalleryAssignmentTagId = 'keep'; galleryTagDefs = [{id:'keep'}]; currentGalleryTagFilter = 'NONE'", context);
    context.updateGalleryImageTag = async () => true;
    context.openZoom('/image/a.png');
    await press('ArrowUp');
    assert.equal(img.src, '/image/b.png');
    press('ArrowLeft');
    assert.equal(img.src, '/image/b.png');
});

test('deleting the last remaining image closes zoom and refreshes the gallery', async () => {
    const {context, layer, press} = gallery([{path:'a.png'}]);
    vm.runInContext('galleryZoomDeleteEnabled = true', context);
    let refreshes = 0;
    context.loadData = async () => { refreshes++; };
    context.fetch = async () => ({ok:true, json:async()=>({status:'success'})});
    context.openZoom('/image/a.png');
    await press('ArrowDown');
    assert.equal(layer.style.display, 'none');
    assert.equal(refreshes, 1);
});

test('late responses cannot advance a newly opened zoom session', async () => {
    const {context, img, press} = gallery([{path:'a.png'}, {path:'b.png'}, {path:'c.png'}]);
    vm.runInContext('galleryZoomDeleteEnabled = true', context);
    let resolve;
    context.fetch = async () => new Promise(done => { resolve = done; });
    context.openZoom('/image/a.png');
    const pending = press('ArrowDown');
    context.closeZoom();
    context.openZoom('/image/b.png');
    resolve({ok:true, json:async()=>({status:'success'})});
    await pending;
    assert.equal(img.src, '/image/b.png');
});

test('arrow modes coexist in either activation order while ordinary modes remain exclusive', () => {
    for (const first of ['delete', 'tag']) {
        const {context} = gallery([]);
        for (const name of ['updateGalleryBulkDeleteModeUi', 'updateGalleryTagAssignmentModeUi',
            'clearGalleryMultiFolderSelection', 'clearGalleryBulkDeleteSelection', 'closeGalleryTagPicker']) context[name] = () => {};
        const toggleFirst = first === 'delete' ? context.toggleGalleryBulkDeleteMode : context.toggleGalleryTagAssignmentMode;
        const toggleSecond = first === 'delete' ? context.toggleGalleryTagAssignmentMode : context.toggleGalleryBulkDeleteMode;
        toggleFirst();
        context.toggleGalleryZoomActionMode(first);
        toggleSecond();
        context.toggleGalleryZoomActionMode(first === 'delete' ? 'tag' : 'delete');
        assert.equal(vm.runInContext('isGalleryBulkDeleteMode && isGalleryTagAssignmentMode && galleryZoomDeleteEnabled && galleryZoomTagEnabled', context), true);
        toggleSecond();
        assert.equal(vm.runInContext(first === 'delete' ? 'galleryZoomDeleteEnabled && !galleryZoomTagEnabled' : 'galleryZoomTagEnabled && !galleryZoomDeleteEnabled', context), true);
    }
    const {context} = gallery([]);
    for (const name of ['updateGalleryBulkDeleteModeUi', 'updateGalleryTagAssignmentModeUi',
        'clearGalleryMultiFolderSelection', 'clearGalleryBulkDeleteSelection', 'closeGalleryTagPicker']) context[name] = () => {};
    context.toggleGalleryBulkDeleteMode();
    context.toggleGalleryTagAssignmentMode();
    assert.equal(vm.runInContext('isGalleryTagAssignmentMode && !isGalleryBulkDeleteMode', context), true);
});

test('all Daki style references keep originals when arrow delete is enabled', async () => {
    for (const library of ['shared', 'tests', 'personal']) {
        const path = `__daki_${library}__/sample.png`;
        const {context, img, press} = gallery([{path}], '#daki');
        context.fetch = async () => assert.fail('Style original must not be deleted');
        vm.runInContext('galleryZoomDeleteEnabled = true', context);
        context.openZoom(`/image/${path}`);
        await press('ArrowDown');
        assert.equal(img.src, `/image/${path}`);
    }
});

test('Daki zoom tags use the gallery store, notify listeners and ignore hidden gallery filters', async () => {
    const first = '__daki_tests__/batch/a.png';
    const second = '__daki_tests__/batch/b.png';
    const {context, img, press} = gallery([{path: first}, {path: second}], '#daki&library=shared&test=batch');
    const writes = [], events = [];
    context.CustomEvent = class { constructor(type) { this.type = type; } };
    context.dispatchEvent = event => events.push(event.type);
    context.fetch = async (url, options) => {
        writes.push({url, body: JSON.parse(options.body)});
        return {ok: true, json: async () => ({status: 'success', tag_id: 'keep', image_tags: {[first]: 'keep'}})};
    };
    vm.runInContext("galleryZoomTagEnabled = true; selectedGalleryAssignmentTagId = 'keep'; galleryTagDefs = [{id:'keep'}]; currentGalleryTagFilter = 'NONE'", context);
    context.openZoom(`/image/${first}`);
    await press('ArrowUp');
    assert.deepEqual(writes, [{url: '/api/gallery/image_tag', body: {path: first, tag_id: 'keep'}}]);
    assert.equal(context.getGalleryImageTagId(first), 'keep');
    assert.deepEqual(events, ['gallery-tags-updated']);
    assert.equal(img.src, `/image/${second}`);
    press('ArrowLeft');
    assert.equal(img.src, `/image/${first}`, 'Daki gallery does not inherit the ordinary gallery tag filter');
});

test('the gallery tag state exposes shared definitions without allowing callers to mutate them', () => {
    const {context} = gallery([]);
    vm.runInContext("isGalleryTagAssignmentMode = true; galleryZoomTagEnabled = true; selectedGalleryAssignmentTagId = 'keep'; galleryTagDefs = [{id:'keep', type:'text', value:'Keep'}]", context);
    const state = context.getGalleryTagState();
    assert.equal(state.enabled, true);
    assert.equal(state.zoomEnabled, true);
    assert.equal(state.selectedTagId, 'keep');
    state.definitions[0].value = 'Changed';
    assert.equal(context.getGalleryTagState().definitions[0].value, 'Keep');
});

test('a Daki zoom exposes its tag mode switch without requiring the hidden gallery mode bar', () => {
    const {context} = gallery([{path: '__daki_personal__/sample.png'}], '#daki&library=personal');
    const nodes = new Map();
    const element = () => ({children: [], attributes: {},
        classList: {toggle() {}, add() {}, remove() {}},
        setAttribute(name, value) { this.attributes[name] = value; },
        appendChild(child) { this.children.push(child); if (child.id) nodes.set(child.id, child); },
        querySelector() { return this.label || (this.label = element()); },
    });
    for (const id of ['galleryZoomToolbar', 'galleryZoomPosition', 'galleryZoomFileName', 'galleryZoomTagPicker',
        'galleryZoomTagSelect', 'galleryZoomTagPreview', 'galleryZoomTagAction', 'galleryZoomDeleteAction', 'galleryZoomActionStatus']) {
        nodes.set(id, element());
    }
    const get = context.document.getElementById;
    context.document.getElementById = id => nodes.get(id) || get(id);
    context.document.createElement = element;
    context.document.body = element();
    for (const name of ['updateGalleryBulkDeleteModeUi', 'clearGalleryMultiFolderSelection',
        'clearGalleryBulkDeleteSelection', 'cancelGalleryBulkDeleteBoxSelection']) context[name] = () => {};
    context.openZoom('/image/__daki_personal__/sample.png');
    const mode = nodes.get('galleryZoomDakiTagModeBtn');
    assert.ok(mode);
    assert.equal(mode.hidden, false);
    assert.equal(mode.attributes['aria-pressed'], 'false');
    mode.onclick();
    assert.equal(context.getGalleryTagState().enabled, true);
    assert.equal(context.getGalleryTagState().zoomEnabled, true);
    assert.equal(mode.attributes['aria-pressed'], 'true');
    assert.equal(nodes.get('galleryZoomTagPicker').hidden, false);
    context.location.hash = '#project=sample';
    context.updateGalleryZoomUi();
    assert.equal(mode.hidden, true);
    assert.equal(nodes.get('galleryZoomTagPicker').hidden, true);
    assert.equal(nodes.get('galleryZoomTagAction').hidden, true);
    context.location.hash = '#daki&library=personal';
    context.updateGalleryZoomUi();
    assert.equal(mode.hidden, false);
    assert.equal(nodes.get('galleryZoomTagPicker').hidden, false);
    assert.equal(nodes.get('galleryZoomTagAction').hidden, false);
});

test('project zoom and long presses ignore shared tag mode without changing it', async () => {
    const {context, img, press} = gallery([{path: 'a.png'}, {path: 'b.png'}], '#project=sample');
    context.updateGalleryImageTag = async () => assert.fail('Projects cannot write image tags');
    vm.runInContext("galleryZoomTagEnabled = true; selectedGalleryAssignmentTagId = 'keep'; galleryTagDefs = [{id:'keep'}]", context);
    context.openZoom('/image/a.png');
    await press('ArrowUp');
    assert.equal(img.src, '/image/a.png');
    assert.equal(context.getGalleryTagState().zoomEnabled, true);
    press('ArrowRight');
    assert.equal(img.src, '/image/b.png');
    const image = {tagName: 'IMG', closest: selector => selector === '.zoomable' ? image : null};
    const event = {pointerType: 'mouse', button: 0, target: image};
    assert.equal(context.isGalleryRadialTagPointerTarget(event), null);
    context.location.hash = '#daki&library=shared&batch=sample';
    assert.equal(context.isGalleryRadialTagPointerTarget(event), image);
});

test('real tag mode and selection actions notify shared Daki tag rows', () => {
    const {context} = gallery([]);
    context.document.body = {classList: {toggle() {}}};
    context.clearGalleryMultiFolderSelection = () => {};
    const events = [];
    let toolbarRefreshes = 0;
    context.Daki.refreshImageTools = () => { toolbarRefreshes++; };
    context.CustomEvent = class { constructor(type) { this.type = type; } };
    context.dispatchEvent = event => events.push(event.type);
    context.toggleGalleryTagAssignmentMode();
    context.selectGalleryTagForAssignment('keep');
    context.toggleGalleryTagAssignmentMode();
    assert.deepEqual(events, Array(3).fill('gallery-tags-updated'));
    assert.equal(toolbarRefreshes, 3);
});
