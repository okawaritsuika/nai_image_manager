const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../static/index.js'), 'utf8');
function deferred() { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; }
const response = job => ({ok: true, json: async () => ({status: 'success', job})});
const partial = {id: 'synthetic', done: true, running: false, cancelled: true, cancel_requested: true,
    processed: 2, total: 100, result: {image_paths: ['sample/match.png'], folder_counts: {sample: 1}, total_matches: 1, partial: true}};

function setup() {
    const elements = new Map(['galleryPromptSearchInput', 'galleryPromptSearchStatus', 'galleryPromptSearchRunBtn', 'galleryPromptSearchCancelBtn', 'galleryPromptAutocomplete'].map(id => [id, {value: 'hero', textContent: '', innerHTML: '', hidden: false}]));
    let renders = 0;
    const context = vm.createContext({console, Date, document: {getElementById: id => elements.get(id) || null},
        galleryPromptSearchRun: null, galleryPromptSearchText: '', galleryPromptSearchActive: false,
        galleryPromptSearchResult: {}, galleryPromptAutocompleteItems: [], galleryPromptAutocompleteActiveIndex: -1,
        getGalleryPromptSearchScopePaths: () => [], getGalleryPromptSearchMode: () => 'all',
        normalizeGalleryPathKey: value => value, renderView: () => {renders++;}, saveGallerySessionState() {}, showToast() {},
        setTimeout: callback => {queueMicrotask(callback); return 1;}});
    vm.runInContext(source.slice(source.indexOf('function resetGalleryPromptSearchResult('), source.indexOf('function getGalleryPromptMatchedFolderCount(')), context);
    vm.runInContext(source.slice(source.indexOf('async function runGalleryPromptSearch('), source.indexOf('async function refreshGalleryPromptIndexStatus(')), context);
    return {context, elements, renders: () => renders};
}

test('cancel before start response reaches server and shows partial matches', async () => {
    const {context, elements, renders} = setup();
    const started = deferred();
    const requests = [];
    context.fetch = async url => {
        requests.push(url);
        if (url.endsWith('/start')) return started.promise;
        if (url.includes('/cancel/')) return response(partial);
        return response(partial);
    };
    const running = context.runGalleryPromptSearch();
    await context.cancelGalleryPromptSearch();
    assert.equal(elements.get('galleryPromptSearchCancelBtn').disabled, true);
    started.resolve(response({id: 'synthetic', running: true}));
    await running;
    assert.equal(requests.filter(url => url.includes('/cancel/')).length, 1);
    assert.equal(context.galleryPromptSearchResult.totalMatches, 1);
    assert.match(elements.get('galleryPromptSearchStatus').textContent, /검색 취소.*2 \/ 100.*일부 결과/);
    assert.equal(elements.get('galleryPromptSearchCancelBtn').hidden, true);
    assert.equal(elements.get('galleryPromptSearchRunBtn').disabled, false);
    assert.equal(renders(), 1);
});

test('reset cancels work and prevents delayed matches from reappearing', async () => {
    const {context, elements, renders} = setup();
    const started = deferred();
    context.fetch = async url => url.endsWith('/start') ? started.promise : response(partial);
    const running = context.runGalleryPromptSearch();
    context.clearGalleryPromptSearch();
    started.resolve(response({id: 'synthetic', running: true}));
    await running;
    assert.equal(context.galleryPromptSearchActive, false);
    assert.equal(context.galleryPromptSearchResult.imagePaths.size, 0);
    assert.equal(elements.get('galleryPromptSearchStatus').textContent, '프롬프트 검색 대기 중');
    assert.equal(renders(), 1);
});

test('completed poll arriving during cancellation cannot replace partial result', async () => {
    const {context, elements} = setup();
    const poll = deferred();
    const pollStarted = deferred();
    let polls = 0;
    context.fetch = async url => {
        if (url.endsWith('/start')) return response({id: 'synthetic', running: true});
        if (url.includes('/cancel/')) return response({running: true, cancel_requested: true});
        if (++polls === 1) {pollStarted.resolve(); return poll.promise;}
        return response(partial);
    };
    const running = context.runGalleryPromptSearch();
    await pollStarted.promise;
    await context.cancelGalleryPromptSearch();
    poll.resolve(response({done: true, result: {total_matches: 99}}));
    await running;
    assert.equal(context.galleryPromptSearchResult.totalMatches, 1);
    assert.match(elements.get('galleryPromptSearchStatus').textContent, /일부 결과/);
});

test('duplicate start is prevented and failed cancellation can be retried', async () => {
    const {context, elements} = setup();
    const poll = deferred();
    const pollStarted = deferred();
    let starts = 0;
    let cancels = 0;
    context.fetch = async url => {
        if (url.endsWith('/start')) {starts++; return response({id: 'synthetic', running: true});}
        if (url.includes('/cancel/')) {
            if (++cancels === 1) throw new Error('synthetic network error');
            return response(partial);
        }
        pollStarted.resolve(); return poll.promise;
    };
    const running = context.runGalleryPromptSearch();
    await pollStarted.promise;
    await context.runGalleryPromptSearch();
    assert.equal(starts, 1);
    await context.cancelGalleryPromptSearch();
    assert.equal(elements.get('galleryPromptSearchCancelBtn').disabled, false);
    await context.cancelGalleryPromptSearch();
    poll.resolve(response(partial));
    await running;
    assert.equal(cancels, 2);
    assert.equal(context.galleryPromptSearchResult.totalMatches, 1);
});

test('temporary status failure preserves job identity and cancellation controls', async () => {
    const {context, elements} = setup();
    const retryStarted = deferred();
    const poll = deferred();
    let polls = 0;
    context.fetch = async url => {
        if (url.endsWith('/start')) return response({id: 'synthetic', running: true});
        if (url.includes('/cancel/')) return response(partial);
        if (++polls === 1) throw new Error('temporary disconnect');
        retryStarted.resolve();
        return poll.promise;
    };
    const running = context.runGalleryPromptSearch();
    await retryStarted.promise;
    assert.equal(context.galleryPromptSearchRun.jobId, 'synthetic');
    assert.equal(elements.get('galleryPromptSearchCancelBtn').hidden, false);
    assert.equal(elements.get('galleryPromptSearchRunBtn').disabled, true);
    await context.cancelGalleryPromptSearch();
    poll.resolve(response(partial));
    await running;
    assert.equal(context.galleryPromptSearchResult.totalMatches, 1);
});
