const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../static/index.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function refreshGalleryPromptIndexStatus('),
    source.indexOf('\nfunction openGalleryPromptIndexModal('));

test('running polls reuse counts and completion refreshes the full status once', async () => {
    const requests = [];
    const responses = [
        {status: 'success', target_images: 100, indexed_images: 20, missing_images: 80, job: {running: true, total: 80, processed: 0}},
        {status: 'success', job: {running: true, total: 80, processed: 40}},
        {status: 'success', job: {running: false, total: 80, processed: 80, done: true}},
        {status: 'success', target_images: 100, indexed_images: 100, missing_images: 0, job: {running: false, total: 80, processed: 80, done: true}},
    ];
    const body = {innerHTML: ''};
    const timers = [];
    const context = vm.createContext({
        URLSearchParams, console,
        galleryPromptIndexStatusSnapshot: null,
        galleryPromptIndexStatusTimer: null,
        galleryPromptSearchActive: false,
        galleryPromptSearchRun: null,
        document: {getElementById: id => id === 'galleryPromptIndexModalBody' ? body : null},
        fetch: async url => {
            requests.push(url);
            return {ok: true, json: async () => responses.shift()};
        },
        setTimeout: callback => { timers.push(callback); return timers.length; },
        clearTimeout: () => {},
        escapeHtml: value => value,
        formatGalleryPromptIndexBytes: value => String(value || 0),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/gallery_index_jobs.js'), 'utf8'), context);
    vm.runInContext(functionSource, context);
    await context.refreshGalleryPromptIndexStatus();
    await context.refreshGalleryPromptIndexStatus(true);
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[0], 'http://localhost').searchParams.has('job_only'), false);
    assert.equal(new URL(requests[1], 'http://localhost').searchParams.get('job_only'), '1');
    assert.match(body.innerHTML.replace(/<[^>]*>/g, ''), /100장/);
    assert.match(body.innerHTML, /40 \/ 80/);
    await context.refreshGalleryPromptIndexStatus(true);
    assert.equal(requests.length, 4);
    assert.equal(new URL(requests[2], 'http://localhost').searchParams.get('job_only'), '1');
    assert.equal(new URL(requests[3], 'http://localhost').searchParams.has('job_only'), false);
    assert.equal(context.galleryPromptIndexStatusSnapshot.indexed_images, 100);
    assert.equal(context.galleryPromptIndexStatusTimer, null);
});
