const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function setup({initialPlaceholder = false} = {}) {
    const elements = new Map();
    for (const id of ['content', 'galleryIndexModal', 'galleryIndexModalBody', 'galleryIndexBuildBtn', 'galleryIndexJobPanel', 'galleryIndexJobBody', 'galleryPromptIndexJobBody']) {
        elements.set(id, {innerHTML: '', hidden: true, style: {}, setAttribute() {}, querySelector: () => null});
    }
    if (initialPlaceholder) elements.set('galleryIndexProgress', {innerHTML: ''});
    elements.get('content').innerHTML = '<button>existing gallery folder</button>';
    const timers = [];
    let loads = 0;
    const context = vm.createContext({console, document: {getElementById: id => elements.get(id) || null},
        escapeHtml: value => String(value), showToast() {}, loadData: async () => {loads++;},
        setTimeout: (callback, delay) => {timers.push({callback, delay}); return timers.length;}, clearTimeout() {}});
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

test('first status network failure retries and initial index completion loads once', async () => {
    const {context, elements, timers, loads} = setup({initialPlaceholder: true});
    context.console = {warn() {}};
    let firstRequest = true;
    context.fetch = async () => {
        if (firstRequest) {
            firstRequest = false;
            throw new Error('synthetic offline');
        }
        return {ok: true, json: async () => ({running: false, done: true, full_index_built: true})};
    };

    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 2000);
    assert.match(elements.get('galleryIndexProgress').innerHTML, /다시 확인/);
    await timers[0].callback();
    assert.equal(loads(), 1);
    assert.match(elements.get('content').innerHTML, /existing gallery folder/);
});

test('idle initial index status keeps polling until it finishes', async () => {
    const {context, timers, loads} = setup({initialPlaceholder: true});
    const responses = [
        {running: false, done: false, full_index_built: false},
        {running: false, done: true, full_index_built: true}
    ];
    context.fetch = async () => ({ok: true, json: async () => responses.shift()});

    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 1000);
    await timers[0].callback();
    assert.equal(loads(), 1);
});

test('idle status and failure without an initial placeholder do not retry', async () => {
    const {context, timers} = setup();
    context.console = {warn() {}};
    context.fetch = async () => {throw new Error('synthetic offline');};

    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 0);

    context.fetch = async () => ({ok: true, json: async () => ({running: false, done: false, full_index_built: false})});
    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 0);
});

test('terminal job error stops status polling', async () => {
    const {context, elements, timers, loads} = setup({initialPlaceholder: true});
    context.fetch = async () => ({ok: true, json: async () => ({running: false, error: 'index build failed'})});

    await context.pollGalleryIndexStatus();
    assert.equal(timers.length, 0);
    assert.match(elements.get('galleryIndexProgress').innerHTML, /index build failed/);
    assert.equal(loads(), 0);
});

test('superseded status failure cannot schedule a retry', async () => {
    const {context, timers} = setup({initialPlaceholder: true});
    context.console = {warn() {}};
    let rejectFirst;
    let calls = 0;
    context.fetch = () => {
        calls++;
        if (calls === 1) return new Promise((_, reject) => {rejectFirst = reject;});
        return Promise.resolve({ok: true, json: async () => ({running: false, error: 'terminal'})});
    };

    const stalePoll = context.pollGalleryIndexStatus();
    await context.pollGalleryIndexStatus();
    rejectFirst(new Error('superseded offline'));
    await stalePoll;
    assert.equal(timers.length, 0);
});
