const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup() {
    const elements = new Map();
    for (const id of ['content', 'galleryIndexModal', 'galleryIndexModalBody', 'galleryIndexBuildBtn', 'galleryIndexJobPanel', 'galleryIndexJobBody', 'galleryPromptIndexJobBody']) {
        elements.set(id, {innerHTML: '', hidden: true, style: {}, setAttribute() {}, querySelector: () => null});
    }
    elements.get('content').innerHTML = '<button>existing gallery folder</button>';
    const timers = [];
    let loads = 0;
    const context = vm.createContext({console, document: {getElementById: id => elements.get(id) || null},
        escapeHtml: value => String(value), showToast() {}, loadData: async () => {loads++;},
        setTimeout: callback => {timers.push(callback); return timers.length;}, clearTimeout() {}});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/gallery_index_jobs.js'), 'utf8'), context);
    return {context, elements, timers, loads: () => loads};
}

test('index start, progress and completion preserve gallery until explicit refresh', async () => {
    const {context, elements, loads} = setup();
    const responses = [
        {running: true, total: 10, processed: 0},
        {running: true, total: 10, processed: 4},
        {running: false, done: true, total: 10, processed: 10, full_index_built: true}
    ];
    context.fetch = async () => ({ok: true, json: async () => responses.shift()});
    await context.startGalleryIndexRebuild();
    assert.equal(elements.get('content').innerHTML, '<button>existing gallery folder</button>');
    assert.equal(elements.get('galleryIndexJobPanel').hidden, false);
    assert.match(elements.get('galleryIndexJobBody').innerHTML, /40%/);
    assert.equal(elements.get('galleryIndexBuildBtn').disabled, true);
    await context.pollGalleryIndexStatus();
    assert.equal(loads(), 0);
    assert.match(elements.get('galleryIndexJobBody').innerHTML, /갤러리에 반영/);
    await context.applyGalleryIndexUpdate();
    assert.equal(loads(), 1);
    assert.equal(elements.get('galleryIndexJobPanel').hidden, true);
});

test('closing either modal leaves independent index progress visible', () => {
    const {context, elements} = setup();
    context.renderGalleryIndexActivity('gallery', {running: true, total: 20, processed: 3});
    context.renderGalleryIndexActivity('prompt', {running: true, total: 40, processed: 8});
    context.closeGalleryIndexModal();
    assert.equal(elements.get('galleryIndexJobBody').hidden, false);
    assert.equal(elements.get('galleryPromptIndexJobBody').hidden, false);
    context.dismissGalleryIndexActivity('gallery');
    assert.equal(elements.get('galleryIndexJobPanel').hidden, false);
});

test('initial index creation loads gallery when complete, old completions stay quiet', async () => {
    const {context, elements, loads} = setup();
    context.fetch = async () => ({ok: true, json: async () => ({done: true, full_index_built: true})});
    await context.pollGalleryIndexStatus();
    assert.equal(loads(), 0);
    assert.equal(elements.get('galleryIndexJobPanel').hidden, true);
    elements.set('galleryIndexProgress', {innerHTML: ''});
    await context.pollGalleryIndexStatus();
    assert.equal(loads(), 1);
});

test('dismissing index work preserves a visible shared-style activity', () => {
    const {context, elements} = setup();
    elements.set('dakiStyleSyncJobBody', {hidden: false});
    context.renderGalleryIndexActivity('gallery', {running: true, total: 10, processed: 2});
    context.dismissGalleryIndexActivity('gallery');
    assert.equal(elements.get('galleryIndexJobPanel').hidden, false);
    elements.get('dakiStyleSyncJobBody').hidden = true;
    context.refreshGalleryJobPanelVisibility();
    assert.equal(elements.get('galleryIndexJobPanel').hidden, true);
});

test('status failure retries without replacing gallery or losing running progress', async () => {
    const {context, elements, timers} = setup();
    context.renderGalleryIndexProgress({running: true, total: 10, processed: 2});
    context.console = {warn() {}};
    context.fetch = async () => {throw new Error('synthetic offline');};
    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 1);
    assert.match(elements.get('content').innerHTML, /existing gallery folder/);
    assert.match(elements.get('galleryIndexJobBody').innerHTML, /다시 확인/);
});
