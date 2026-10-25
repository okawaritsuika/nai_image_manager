const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const testA = '1'.repeat(32), testB = '2'.repeat(32), cupA = 'a'.repeat(32), cupB = 'b'.repeat(32);
const personalA = 'personal_' + 'a'.repeat(32), personalB = 'personal_' + 'b'.repeat(32);
const catalog = Object.freeze({styles: Object.freeze(['a', 'b', 'c'].map(id => Object.freeze({id: 'style_' + id, name: 'Style ' + id})))});
const sharedPath = id => `__daki_shared__/${id}.png`;
const testPath = (batch, id) => `__daki_tests__/${batch}/${id}.png`;
const personalPath = id => `__daki_personal__/${id}.png`;
const record = (id = cupA, gallery_key = 'shared:all', participants = []) => ({id, title: 'Synthetic cup', gallery_key, participants,
    created_at: '2026-10-12T01:00:00Z', tag: {id: 'keep', label: 'Keep'}});
const batch = id => ({id, name: 'Same name', created_at: id === testA ? '2026-10-12T01:00:00Z' : '2026-10-12T02:00:00Z', items: []});
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(input = catalog) {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.text = ''; this.value = ''; this.hidden = false; this.disabled = false; }
        set value(value) { this._value = String(value); }
        get value() { return this._value; }
        appendChild(child) { this.children.push(child); return child; }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; this.text = ''; }
        set textContent(value) { this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = value; }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const requests = [], pending = [], listeners = new Map(), tags = {}, galleryOpens = [];
    let changes = 0, definitions = [{id: 'keep', type: 'text', value: 'Keep'}, {id: 'other', type: 'image', value: '/synthetic/star.png'}];
    const win = {document: {createElement: tag => new Element(tag)}, getGalleryImageTagId: path => tags[path] || '',
        getGalleryTagState: () => ({definitions}),
        renderGalleryTagIcon: tag => tag.type === 'text' ? `<span>${tag.value}</span>` : `<img src="${tag.value}" alt="">`,
        addEventListener(type, listener) { const group = listeners.get(type) || new Set(); group.add(listener); listeners.set(type, group); },
        removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
        fetch(url) { requests.push(url); return new Promise(resolve => pending.push({url, resolve})); },
        DakiTestTargetGallery: {open(options) {
            const picker = {closed: false, close() { this.closed = true; options.onClose?.(); }};
            galleryOpens.push({options, picker}); return picker;
        }}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_test_targets.js'), 'utf8'), {window: win});
    const target = win.DakiTestTargets.create({catalog: input, onChange: () => changes++});
    const field = suffix => target.element.descendants().find(item => item.name === 'daki_target_' + suffix);
    const tagButton = value => target.element.descendants().find(item => item.tagName === 'BUTTON' && item.value === value);
    return {target, tags, requests, pending, listeners, galleryOpens, field, tagButton,
        changes: () => changes,
        setDefinitions(value) { definitions = value; },
        change(suffix, value) { if (suffix === 'tag') return tagButton(value).onclick(); const input = field(suffix); input.value = value; (input.onchange || input.oninput)(); },
        fire(type) { [...(listeners.get(type) || [])].forEach(listener => listener()); },
        result: () => clone(target.selection()),
        reply(data, status = 200, url) {
            const index = url ? pending.findIndex(item => item.url === url) : 0; assert.ok(index >= 0 && pending[index], 'Expected API request');
            const request = pending.splice(index, 1)[0]; request.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        },
        retry() { return target.element.children.find(item => item.tagName === 'BUTTON').onclick(); },
    };
}
async function testsLoaded(f, values = [batch(testA), batch(testB)]) {
    f.change('mode', 'tag'); f.change('source', 'test'); f.reply({batches: values}); await flush();
}
async function cupsLoaded(f, values = [record()]) {
    f.change('mode', 'worldcup'); f.reply({records: values}); await flush();
}

test('all styles start without API calls or synchronous callbacks and use the null full-catalog contract', () => {
    const f = fixture(); assert.deepEqual(f.result(), {styleIds: null, count: 3, error: ''});
    assert.equal(f.requests.length, 0); assert.equal(f.changes(), 0); assert.equal(f.field('rank').disabled, true);
    assert.deepEqual(catalog.styles.map(style => style.id), ['style_a', 'style_b', 'style_c']);
});

test('manual gallery selection applies only active IDs, preserves selection on cancel, and ignores callbacks after disposal', () => {
    const f = fixture();
    const button = f.target.element.descendants().find(item => item.tagName === 'BUTTON' && item.textContent === '갤러리에서 선택');
    assert.ok(button);
    button.onclick();
    assert.equal(f.galleryOpens.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.galleryOpens[0].options.selectedIds)), []);
    assert.deepEqual(clone(f.galleryOpens[0].options.catalog), catalog);
    assert.deepEqual(f.result(), {styleIds: null, count: 3, error: ''});

    f.galleryOpens[0].options.onApply(['style_b', 'removed', 'style_b']);
    f.galleryOpens[0].picker.close();
    assert.equal(f.field('mode').value, 'manual');
    assert.deepEqual(f.result(), {styleIds: ['style_b'], count: 1, error: ''});

    button.onclick();
    assert.deepEqual(JSON.parse(JSON.stringify(f.galleryOpens[1].options.selectedIds)), ['style_b']);
    f.galleryOpens[1].picker.close();
    assert.deepEqual(f.result(), {styleIds: ['style_b'], count: 1, error: ''});

    button.onclick();
    const beforeDispose = f.result();
    f.target.dispose();
    assert.equal(f.galleryOpens[2].picker.closed, true);
    f.galleryOpens[2].options.onApply(['style_a']);
    assert.deepEqual(f.result(), beforeDispose);
});

test('gallery respects tagged scope, rejects outside IDs and preserves the base scope on reopening', () => {
    const f = fixture();
    const open = () => f.target.element.descendants().find(item => item.textContent === '갤러리에서 선택' && item.tagName === 'BUTTON').onclick();
    f.tags[sharedPath('style_b')] = f.tags[sharedPath('style_c')] = 'keep';
    f.change('mode', 'tag'); open();
    assert.deepEqual(clone(f.galleryOpens[0].options.catalog.styles).map(item => item.id), ['style_b', 'style_c']);
    f.galleryOpens[0].options.onApply(['style_b', 'style_a']); f.galleryOpens[0].picker.close();
    assert.deepEqual(f.result().styleIds, ['style_b']);
    open();
    assert.deepEqual(clone(f.galleryOpens[1].options.catalog.styles).map(item => item.id), ['style_b', 'style_c']);
    f.galleryOpens[1].picker.close();
    f.change('mode', 'all'); open();
    assert.equal(f.galleryOpens[2].options.catalog.styles.length, 3);
});

test('gallery uses completed test images for the chosen test and blocks loading or empty target criteria', async () => {
    const f = fixture();
    const button = () => f.target.element.descendants().find(item => item.textContent === '갤러리에서 선택' && item.tagName === 'BUTTON');
    f.change('mode', 'worldcup');
    assert.equal(button().disabled, true); button().onclick(); assert.equal(f.galleryOpens.length, 0);
    f.change('mode', 'tag'); f.change('source', 'test');
    f.reply({batches: [batch(testA)]}, 200, '/api/daki/style-tests'); await flush();
    f.change('test', testA);
    assert.equal(button().disabled, true); button().onclick(); assert.equal(f.galleryOpens.length, 0);
    f.tags[testPath(testA, 'style_b')] = 'keep';
    f.reply({batch: {...batch(testA), items: [{style_id: 'style_b', status: 'completed', src: '/synthetic/test-b.webp',
        recommendation_count: 18, sort_date: '2026-01-02'}]}}, 200, '/api/daki/style-tests/' + testA); await flush();
    assert.equal(button().disabled, false); button().onclick();
    const shown = clone(f.galleryOpens[0].options.catalog.styles);
    assert.equal(shown.length, 1); assert.equal(shown[0].src, '/synthetic/test-b.webp');
    assert.equal(shown[0].preview_kind, 'test'); assert.equal(shown[0].recommendation_count, 18);
    assert.equal(shown[0].sort_date, '2026-01-02');
});

test('gallery preserves rank order when using worldcup targets', async () => {
    const f = fixture(); await cupsLoaded(f);
    f.change('worldcup', cupA); f.change('rank', '2');
    f.reply({record: record(cupA, 'shared:all', [{path: sharedPath('style_c'), rank: 1}, {path: sharedPath('style_a'), rank: 2}])}); await flush();
    f.target.element.descendants().find(item => item.textContent === '갤러리에서 선택' && item.tagName === 'BUTTON').onclick();
    assert.deepEqual(clone(f.galleryOpens[0].options.catalog.styles).map(item => item.id), ['style_c', 'style_a']);
});

test('representative tags use active shared styles, support a chosen tag and live changes without mutating the gallery', () => {
    const f = fixture(); Object.assign(f.tags, {[sharedPath('style_a')]: 'keep', [sharedPath('style_b')]: 'other', [sharedPath('removed')]: 'keep'});
    f.change('mode', 'tag'); assert.deepEqual(f.result(), {styleIds: ['style_a', 'style_b'], count: 2, error: ''});
    assert.match(f.tagButton('tag:other').innerHTML, /src="\/synthetic\/star.png"/);
    assert.equal(f.tagButton('tag:other').textContent, '');
    assert.equal(f.tagButton('tagged').attributes['aria-pressed'], 'true');
    f.change('tag', 'tag:keep'); assert.deepEqual(f.result().styleIds, ['style_a']);
    assert.equal(f.tagButton('tag:keep').attributes['aria-pressed'], 'true');
    assert.equal(f.tagButton('tagged').attributes['aria-pressed'], 'false');
    f.tags[sharedPath('style_c')] = 'keep'; f.fire('gallery-tags-updated'); assert.deepEqual(f.result().styleIds, ['style_a', 'style_c']);
    const result = f.target.selection(); result.styleIds.push('injected'); assert.deepEqual(f.result().styleIds, ['style_a', 'style_c']);
    assert.equal(f.requests.length, 0);
});

test('personal representative selection requires an original source path', () => {
    const f = fixture({library: 'personal', styles: [{id: personalA, name: 'With image', source_path: 'synthetic/a.png'},
        {id: personalB, name: 'Manual recipe', source_path: '', src: '/synthetic/unused.png'}]});
    f.tags[personalPath(personalA)] = f.tags[personalPath(personalB)] = 'keep'; f.change('mode', 'tag');
    assert.deepEqual(f.result(), {styleIds: [personalA], count: 1, error: ''});
});

test('existing tests from any library require an explicit choice and only completed image results become tagged targets', async () => {
    const f = fixture(); await testsLoaded(f, [{...batch(testA), library: 'personal'}, {...batch(testB), library: 'shared'}]);
    assert.equal(f.result().error, '기존 테스트를 선택해 주세요.'); assert.deepEqual(f.result().styleIds, []);
    assert.match(f.field('test').children[1].textContent, /Same name ·/);
    assert.notEqual(f.field('test').children[1].textContent, f.field('test').children[2].textContent);
    f.change('test', testA); assert.match(f.result().error, /불러오는 중/);
    for (const id of ['style_a', 'style_b', 'style_c', 'removed']) f.tags[testPath(testA, id)] = 'keep';
    f.reply({batch: {...batch(testA), items: [
        {style_id: 'style_a', status: 'completed', src: '/synthetic/a.png'}, {style_id: 'style_a', status: 'completed', src: '/synthetic/duplicate.png'},
        {style_id: 'style_b', status: 'completed'}, {style_id: 'style_c', status: 'failed', src: '/synthetic/c.png'},
        {style_id: 'removed', status: 'completed', src: '/synthetic/removed.png'},
    ]}}); await flush();
    assert.deepEqual(f.result(), {styleIds: ['style_a'], count: 1, error: ''});
});

test('list and detail failures block subsets, retry independently, and never block all mode', async () => {
    const f = fixture(); f.change('mode', 'tag'); f.change('source', 'test');
    f.reply({message: 'Synthetic list failure'}, 500); await flush(); assert.match(f.result().error, /Synthetic list failure/);
    f.change('mode', 'all'); assert.deepEqual(f.result(), {styleIds: null, count: 3, error: ''});
    f.change('mode', 'tag'); f.reply({batches: [batch(testA)]}); await flush();
    f.change('test', testA); f.reply({message: 'Synthetic detail failure'}, 500); await flush();
    assert.match(f.result().error, /Synthetic detail failure/); assert.deepEqual(f.result().styleIds, []);
    f.tags[testPath(testA, 'style_a')] = 'keep'; const retry = f.retry();
    f.reply({batch: {...batch(testA), items: [{style_id: 'style_a', status: 'completed', src: '/synthetic/a.png'}]}}); await retry;
    assert.deepEqual(f.result().styleIds, ['style_a']);
});

test('worldcup selection offers current-library and mixed-test records, includes all tied ranks and deduplicates active styles', async () => {
    const f = fixture(); await cupsLoaded(f, [record(), record(cupB, 'test:' + testB), record('c'.repeat(32), 'personal'), record('d'.repeat(32), 'project:sample')]);
    assert.deepEqual(f.field('worldcup').children.map(item => item.value), ['', cupA, cupB]);
    assert.match(f.field('worldcup').children[1].textContent, /^대표 그림 ·/);
    assert.match(f.field('worldcup').children[2].textContent, /^기존 테스트 ·/);
    assert.match(f.result().error, /선택/); assert.equal(f.requests.length, 1);
    f.change('worldcup', cupB); f.change('rank', '3');
    f.reply({record: record(cupB, 'test:' + testB, [
        {path: testPath(testB, 'style_c'), rank: 3}, {path: sharedPath('style_a'), rank: 1},
        {path: testPath(testB, 'style_b'), rank: 3}, {path: sharedPath('style_c'), rank: 3},
        {path: sharedPath('removed'), rank: 2}, {path: sharedPath('style_b'), rank: 5},
    ])}); await flush();
    assert.deepEqual(f.result(), {styleIds: ['style_a', 'style_c', 'style_b'], count: 3, error: ''});
    f.change('rank', '1'); assert.deepEqual(f.result().styleIds, ['style_a']);
});

test('personal worldcup selection accepts personal and test references but excludes shared and project record sources', async () => {
    const f = fixture({library: 'personal', styles: [{id: personalA}, {id: personalB}]});
    await cupsLoaded(f, [record(cupA, 'personal'), record(cupB, 'test:' + testA), record('c'.repeat(32)), record('d'.repeat(32), 'project:sample')]);
    assert.deepEqual(f.field('worldcup').children.map(item => item.value), ['', cupA, cupB]);
    f.change('worldcup', cupA); f.change('rank', '2');
    f.reply({record: record(cupA, 'personal', [{path: personalPath(personalA), rank: 1}, {path: testPath(testA, personalB), rank: 2}])}); await flush();
    assert.deepEqual(f.result().styleIds, [personalA, personalB]);
});

test('invalid or empty rank values block rank mode but inactive number controls are disabled for native form validation', async () => {
    const f = fixture(); await cupsLoaded(f);
    for (const value of ['', '0', '1.5', '10001', '-1']) {
        f.change('rank', value); assert.match(f.result().error, /1~10000/); assert.deepEqual(f.result().styleIds, []);
    }
    assert.equal(f.field('rank').disabled, false); f.change('mode', 'all'); assert.equal(f.field('rank').disabled, true);
    assert.deepEqual(f.result(), {styleIds: null, count: 3, error: ''}); f.change('mode', 'tag'); assert.equal(f.field('rank').disabled, true);
});

test('worldcup participant paths must match one of the three exact reference forms', async () => {
    const f = fixture(); await cupsLoaded(f); f.change('worldcup', cupA);
    const invalid = ['/image/' + sharedPath('style_a'), sharedPath('style_a') + '\n', sharedPath('style_a') + '?full=1',
        '__daki_shared__/../style_a.png', '__daki_shared__/style_a.jpg', '__daki_tests__/short/style_a.png',
        '__daki_personal__/style_a.png', '__daki_shared__/%73tyle_a.png'];
    f.reply({record: record(cupA, 'shared:all', invalid.map(path => ({path, rank: 1})))}); await flush();
    assert.deepEqual(f.result().styleIds, []); assert.equal(f.result().count, 0); assert.match(f.result().error, /조건에 맞는/);
});

test('zero matches and deleted tag definitions stay blocked without broadening into all styles', () => {
    const f = fixture(); f.change('mode', 'tag'); assert.deepEqual(f.result().styleIds, []); assert.match(f.result().error, /조건에 맞는/);
    f.tags[sharedPath('style_a')] = 'keep'; f.change('tag', 'tag:keep'); assert.equal(f.result().count, 1);
    f.setDefinitions([]); f.fire('gallery-tags-updated');
    assert.equal(f.tagButton('tagged').attributes['aria-pressed'], 'false'); assert.match(f.result().error, /태그가 없어졌습니다/); assert.deepEqual(f.result().styleIds, []);
});

test('late test details cannot overwrite a newer selection or representative source', async () => {
    const f = fixture(); await testsLoaded(f);
    f.tags[testPath(testA, 'style_a')] = f.tags[testPath(testB, 'style_b')] = f.tags[sharedPath('style_c')] = 'keep';
    f.change('test', testA); f.change('test', testB);
    f.reply({batch: {...batch(testB), items: [{style_id: 'style_b', status: 'completed', src: '/synthetic/b.png'}]}}, 200, '/api/daki/style-tests/' + testB); await flush();
    f.reply({batch: {...batch(testA), items: [{style_id: 'style_a', status: 'completed', src: '/synthetic/a.png'}]}}); await flush();
    assert.deepEqual(f.result().styleIds, ['style_b']);
    f.change('test', testA); f.change('source', 'representative');
    f.reply({batch: {...batch(testA), items: [{style_id: 'style_a', status: 'completed', src: '/synthetic/a.png'}]}}); await flush();
    assert.deepEqual(f.result().styleIds, ['style_c']);
});

test('worldcup updates refresh choices and reject removed records without choosing a replacement', async () => {
    const f = fixture(); await cupsLoaded(f); f.change('worldcup', cupA);
    f.reply({record: record(cupA, 'shared:all', [{path: sharedPath('style_a'), rank: 1}])}); await flush(); assert.equal(f.result().count, 1);
    f.fire('daki-worldcups-updated'); assert.match(f.result().error, /불러오는 중/);
    f.reply({records: [record(cupB)]}); await flush();
    assert.equal(f.field('worldcup').value, cupA); assert.deepEqual(f.result().styleIds, []); assert.match(f.result().error, /찾을 수 없습니다/);
});

test('mismatched record responses cannot provide targets and disposal ignores outstanding requests and events', async () => {
    const f = fixture(); await cupsLoaded(f); f.change('worldcup', cupA);
    f.reply({record: record(cupB, 'shared:all', [{path: sharedPath('style_a'), rank: 1}])}); await flush();
    assert.match(f.result().error, /응답이 일치하지/); assert.deepEqual(f.result().styleIds, []);
    const late = f.retry(); const before = f.changes(); f.target.dispose();
    f.reply({record: record(cupA, 'shared:all', [{path: sharedPath('style_a'), rank: 1}])}); await late;
    assert.equal(f.changes(), before); assert.equal(f.listeners.get('gallery-tags-updated').size, 0);
    assert.equal(f.listeners.get('daki-worldcups-updated').size, 0);
});
