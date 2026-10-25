const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture(options = {}) {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.value = ''; this.text = ''; this.hidden = false; }
        appendChild(child) { this.children.push(child); return child; }
        append(...children) { this.children.push(...children); }
        replaceChildren(...children) { this.children = children; this.text = ''; }
        set textContent(value) { this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = value; }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        querySelectorAll(selector) { return this.descendants().filter(child => child.tagName === selector.toUpperCase()); }
    }
    const requests = [], pending = [], events = new Map();
    let definitions = [{id: 'keep', type: 'text', value: 'Keep'}, {id: 'maybe', type: 'image', value: '/synthetic/tag.png'}];
    const imageTags = {'a.png': 'keep', 'b.png': 'maybe', 'c.png': 'keep'};
    let tagModeEnabled = !!options.globalTagMode;
    let selectedTagId = options.selectedTagId || '';
    const assignmentSelections = [];
    let changes = 0;
    const win = {document: {createElement: tag => new Element(tag)},
        getGalleryTagState: () => ({enabled: tagModeEnabled, zoomEnabled: false, selectedTagId, definitions}),
        getGalleryImageTagId: path => imageTags[path] || '',
        selectGalleryTagForAssignment(tagId) { assignmentSelections.push(tagId); selectedTagId = tagId; },
        addEventListener(type, listener) { const listeners = events.get(type) || new Set(); listeners.add(listener); events.set(type, listeners); },
        removeEventListener(type, listener) { events.get(type)?.delete(listener); },
        fetch(url) { requests.push(url); return new Promise(resolve => pending.push({url, resolve})); },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_gallery_filters.js'), 'utf8'), {window: win});
    const filters = win.DakiGalleryFilters.create({galleryKey: 'test:sample', title: 'Sample gallery', onChange() { changes++; }, ...options});
    const tags = filters.element.querySelectorAll('div').find(node => node.className.includes('daki-filter-tags'));
    const ranking = filters.element.querySelectorAll('select').find(item => item.attributes['aria-label'].endsWith('정렬'));
    const minimum = filters.element.querySelectorAll('select').find(item => item.attributes['aria-label'].endsWith('추천수 기준'));
    return {win, filters, tags, ranking, minimum, requests, pending, events, imageTags, assignmentSelections,
        changes: () => changes,
        setDefinitions(value) { definitions = value; },
        setTagMode(enabled) { tagModeEnabled = enabled; },
        fire(type) { [...(events.get(type) || [])].forEach(listener => listener({type})); },
        selectTag(value) { tags.children.find(button => button.value === value).onclick(); },
        selectRecord(value) { ranking.value = value; return ranking.onchange(); },
        selectMinimum(value) { minimum.value = value; minimum.onchange(); },
        reply(data, status = 200, url) {
            const index = url ? pending.findIndex(item => item.url === url) : 0;
            assert.ok(index >= 0 && pending[index], 'Expected request'); const item = pending.splice(index, 1)[0];
            item.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        },
        retry() { return filters.element.querySelectorAll('button').find(button => button.className.includes('daki-filter-retry')).onclick(); },
    };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const summary = (id, extra = {}) => ({id, title: 'Portrait cup ' + id, gallery_key: 'test:sample', tag: {id: 'keep', label: 'Keep'},
    created_at: '2026-10-12T04:00:00Z', ...extra});
const participants = [{path: 'a.png', rank: 1}, {path: 'b.png', rank: 3}, {path: 'c.png', rank: 3}];
const input = Object.freeze([Object.freeze({path: 'c.png'}), Object.freeze({path: 'none.png'}), Object.freeze({path: 'a.png'}),
    Object.freeze({path: 'b.png'}), Object.freeze({name: 'Manual recipe without image'})]);
const paths = items => Array.from(items, item => item.path || '');
async function loaded(f, records = [summary('one'), summary('two')]) { f.reply({records}); await flush(); }

test('initial filters keep base order, do not synchronously notify, and never automatically choose a tournament', async () => {
    const f = fixture(); assert.equal(f.changes(), 0);
    assert.equal(f.requests[0], '/api/daki/worldcups?gallery_key=test%3Asample');
    const before = f.filters.apply(input); assert.notEqual(before, input); assert.deepEqual(paths(before), paths(input));
    await loaded(f); assert.equal(f.changes(), 0); assert.equal(f.ranking.value, ''); assert.equal(f.requests.length, 1);
    assert.match(f.ranking.children[1].textContent, /Portrait cup one · Keep/);
    const href = f.filters.element.querySelectorAll('a')[0].href;
    assert.equal(href, '#daki&library=worldcups&gallery_key=test%3Asample');
    assert.equal(require('../static/daki.js').isActive(new URL(href, 'http://localhost')), true);
});

test('all tagged and specific tag filters read the shared store without changing items or tags', async () => {
    const f = fixture(); await loaded(f);
    f.selectTag('tagged'); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png', 'b.png']);
    f.selectTag('tag:keep'); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png']);
    f.selectTag('tag:maybe'); assert.deepEqual(paths(f.filters.apply(input)), ['b.png']);
    assert.equal(f.tags.children[3].textContent, '그림 태그 2');
    assert.deepEqual(f.tags.children.filter(button => button.attributes['aria-pressed'] === 'true').map(button => button.value), ['tag:maybe']);
    assert.deepEqual(f.imageTags, {'a.png': 'keep', 'b.png': 'maybe', 'c.png': 'keep'});
    f.selectTag('all'); assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    const wrapped = input.map(image => ({image})); f.selectTag('tagged');
    assert.deepEqual(f.filters.apply(wrapped, item => item.image.path).map(item => item.image.path), ['c.png', 'a.png', 'b.png']);
});

test('opt-in shared tag row selects assignment tags and suspends then restores its previous filter', async () => {
    const f = fixture({shareTagAssignment: true});
    assert.equal(f.changes(), 0);
    assert.equal(f.tags.attributes['aria-label'], 'Sample gallery 태그 필터');
    await loaded(f);
    f.selectTag('tag:keep');
    assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png']);

    const beforeModeChange = f.changes();
    f.setTagMode(true); f.fire('gallery-tags-updated');
    assert.equal(f.changes(), beforeModeChange + 1);
    assert.equal(f.tags.attributes['aria-label'], 'Sample gallery 적용할 태그 선택');
    assert.deepEqual(f.tags.children.map(button => button.value), ['NONE', 'keep', 'maybe']);
    assert.equal(f.tags.children[0].textContent, '×');
    assert.deepEqual(f.tags.children.filter(button => button.attributes['aria-pressed'] === 'true').map(button => button.value), []);
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));

    const beforeSelection = f.changes();
    f.tags.children.find(button => button.value === 'maybe').onclick();
    assert.deepEqual(f.assignmentSelections, ['maybe']);
    assert.equal(f.tags.children.find(button => button.value === 'maybe').attributes['aria-pressed'], 'true');
    assert.match(f.tags.children.find(button => button.value === 'maybe').className, /gallery-tag-assignment-selected/);
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    assert.deepEqual(f.imageTags, {'a.png': 'keep', 'b.png': 'maybe', 'c.png': 'keep'});
    assert.equal(f.changes(), beforeSelection);

    f.tags.children.find(button => button.value === 'NONE').onclick();
    assert.deepEqual(f.assignmentSelections, ['maybe', 'NONE']);
    assert.equal(f.tags.children.find(button => button.value === 'NONE').attributes['aria-pressed'], 'true');
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    assert.deepEqual(f.imageTags, {'a.png': 'keep', 'b.png': 'maybe', 'c.png': 'keep'});
    assert.equal(f.changes(), beforeSelection);

    f.setTagMode(false); f.fire('gallery-tags-updated');
    assert.equal(f.tags.attributes['aria-label'], 'Sample gallery 태그 필터');
    assert.deepEqual(f.tags.children.map(button => button.value), ['all', 'tagged', 'tag:keep', 'tag:maybe']);
    assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png']);
});

test('opt-in shared tag row reflects assignment mode present at creation without notifying synchronously', () => {
    const f = fixture({shareTagAssignment: true, globalTagMode: true, selectedTagId: 'keep'});
    assert.equal(f.changes(), 0);
    assert.equal(f.tags.attributes['aria-label'], 'Sample gallery 적용할 태그 선택');
    assert.deepEqual(f.tags.children.map(button => button.value), ['NONE', 'keep', 'maybe']);
    assert.equal(f.tags.children.find(button => button.value === 'keep').attributes['aria-pressed'], 'true');
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));
});

test('shared assignment row tolerates an absent global selection callback', () => {
    const f = fixture({shareTagAssignment: true, globalTagMode: true});
    f.win.selectGalleryTagForAssignment = undefined;
    assert.doesNotThrow(() => f.tags.children.find(button => button.value === 'keep').onclick());
    assert.equal(f.tags.children.find(button => button.value === 'keep').attributes['aria-pressed'], 'false');
    assert.equal(f.changes(), 0);
});

test('assignment-mode filtering preserves recommendation thresholds and selected date sort', async () => {
    const items = [
        {path: 'c.png', sort_date: '2026-04-01T00:00:00Z', recommendations: 12},
        {path: 'a.png', sort_date: '2026-04-03T00:00:00Z', recommendations: 0},
        {path: 'b.png', sort_date: '2026-04-02T00:00:00Z', recommendations: 12},
        {path: 'popular.png', sort_date: null, recommendations: 54},
    ];
    const f = fixture({shareTagAssignment: true, recommendationOf, dateOf: item => item.sort_date});
    await loaded(f);
    await f.selectRecord('date:desc'); f.selectMinimum('10'); f.selectTag('tag:keep');
    assert.deepEqual(paths(f.filters.apply(items)), ['c.png']);

    f.setTagMode(true); f.fire('gallery-tags-updated');
    assert.equal(f.ranking.value, 'date:desc'); assert.equal(f.minimum.value, '10');
    assert.deepEqual(paths(f.filters.apply(items)), ['b.png', 'c.png', 'popular.png']);

    f.setTagMode(false); f.fire('gallery-tags-updated');
    assert.equal(f.ranking.value, 'date:desc'); assert.equal(f.minimum.value, '10');
    assert.deepEqual(paths(f.filters.apply(items)), ['c.png']);

    await f.selectRecord('recommendation:desc'); f.selectTag('tag:keep');
    f.setTagMode(true); f.fire('gallery-tags-updated');
    assert.equal(f.ranking.value, 'recommendation:desc'); assert.equal(f.minimum.value, '10');
    assert.deepEqual(paths(f.filters.apply(items)), ['popular.png', 'c.png', 'b.png']);
    f.setTagMode(false); f.fire('gallery-tags-updated');
    assert.deepEqual(paths(f.filters.apply(items)), ['c.png']);

    const selectedCup = f.selectRecord('worldcup:one');
    f.reply({record: {...summary('one'), participants}}); await selectedCup;
    f.setTagMode(true); f.fire('gallery-tags-updated');
    assert.equal(f.ranking.value, 'worldcup:one'); assert.equal(f.minimum.value, '10');
    assert.deepEqual(paths(f.filters.apply(items)), ['c.png', 'b.png', 'popular.png']);
    f.setTagMode(false); f.fire('gallery-tags-updated');
    assert.deepEqual(paths(f.filters.apply(items)), ['c.png']);
});

test('removed tag filters fall back to all after shared assignment mode ends', () => {
    const f = fixture({shareTagAssignment: true});
    f.selectTag('tag:keep'); f.setTagMode(true); f.fire('gallery-tags-updated');
    f.setDefinitions([{id: 'maybe', type: 'image', value: '/synthetic/tag.png'}]);
    f.fire('gallery-tags-updated');
    f.setTagMode(false); f.fire('gallery-tags-updated');
    assert.equal(f.tags.children[0].attributes['aria-pressed'], 'true');
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));
});

test('tag-only controls filter the shared tags without rendering or loading tournament controls', () => {
    const f = fixture({tagOnly: true});
    assert.equal(f.changes(), 0);
    assert.deepEqual(f.requests, []);
    assert.equal(f.events.has('daki-worldcups-updated'), false);
    assert.equal(f.filters.element.querySelectorAll('select').length, 0);
    assert.equal(f.filters.element.querySelectorAll('a').length, 0);
    assert.equal(f.filters.element.querySelectorAll('p').length, 0);
    assert.deepEqual(f.filters.element.querySelectorAll('button'), f.tags.children);
    assert.deepEqual(f.tags.children.map(button => button.value), ['all', 'tagged', 'tag:keep', 'tag:maybe']);
    f.selectTag('tagged'); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png', 'b.png']);
    f.selectTag('tag:maybe'); assert.deepEqual(paths(f.filters.apply(input)), ['b.png']);
    f.selectTag('all'); assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    f.fire('daki-worldcups-updated'); assert.deepEqual(f.requests, []);
});

test('tag assignment mode stays opt-in and tag-only controls remain pure filters', () => {
    const legacy = fixture({globalTagMode: true, selectedTagId: 'maybe'});
    assert.equal(legacy.tags.attributes['aria-label'], 'Sample gallery 태그 필터');
    assert.deepEqual(legacy.tags.children.map(button => button.value), ['all', 'tagged', 'tag:keep', 'tag:maybe']);
    legacy.selectTag('tag:keep'); assert.deepEqual(paths(legacy.filters.apply(input)), ['c.png', 'a.png']);

    const tagOnly = fixture({tagOnly: true, shareTagAssignment: true, globalTagMode: true, selectedTagId: 'maybe'});
    assert.equal(tagOnly.tags.attributes['aria-label'], 'Sample gallery 태그 필터');
    assert.deepEqual(tagOnly.tags.children.map(button => button.value), ['all', 'tagged', 'tag:keep', 'tag:maybe']);
    tagOnly.selectTag('tag:maybe'); assert.deepEqual(paths(tagOnly.filters.apply(input)), ['b.png']);
});

test('tag-only controls refresh shared tag changes and remove their listener on dispose', () => {
    const f = fixture({tagOnly: true});
    f.selectTag('tag:keep');
    f.imageTags['none.png'] = 'keep'; const beforeUpdate = f.changes();
    f.fire('gallery-tags-updated');
    assert.equal(f.changes(), beforeUpdate + 1);
    const wrapped = input.map(image => ({image}));
    assert.deepEqual(f.filters.apply(wrapped, item => item.image.path).map(item => item.image.path), ['c.png', 'none.png', 'a.png']);
    f.setDefinitions([]); f.fire('gallery-tags-updated');
    assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    const beforeDispose = f.changes(); f.filters.dispose();
    assert.equal(f.events.get('gallery-tags-updated').size, 0);
    f.fire('gallery-tags-updated');
    assert.equal(f.changes(), beforeDispose);
    assert.deepEqual(f.requests, []);
});

test('chosen tournament sorts ranks first, preserves ties in original order and leaves nonparticipants last', async () => {
    const f = fixture(); await loaded(f);
    const selected = f.selectRecord('one'); f.reply({record: {...summary('one'), participants}}); await selected;
    assert.deepEqual(paths(f.filters.apply(input)), ['a.png', 'c.png', 'b.png', 'none.png', '']);
    assert.match(f.filters.element.textContent, /Portrait cup one.*순위 적용 중/);
    f.selectTag('tag:keep'); assert.deepEqual(paths(f.filters.apply(input)), ['a.png', 'c.png']);
    await f.selectRecord(''); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png']);
    assert.deepEqual(paths(input), ['c.png', 'none.png', 'a.png', 'b.png', '']);
});

test('late detail responses cannot overwrite a newer selection or restore ranking after base order is chosen', async () => {
    const f = fixture(); await loaded(f);
    const first = f.selectRecord('one'), second = f.selectRecord('two');
    f.reply({record: {...summary('two'), participants: [{path: 'b.png', rank: 1}]}}, 200, '/api/daki/worldcups/two'); await second;
    f.reply({record: {...summary('one'), participants}}); await first;
    assert.equal(f.filters.apply(input)[0].path, 'b.png');
    const late = f.selectRecord('one'); await f.selectRecord(''); f.reply({record: {...summary('one'), participants}}); await late;
    assert.deepEqual(paths(f.filters.apply(input)), paths(input)); assert.equal(f.ranking.value, '');
});

test('tag updates refresh filtering and removed definitions fall back to all pictures', async () => {
    const f = fixture(); await loaded(f); f.selectTag('tag:keep');
    f.imageTags['none.png'] = 'keep'; const prior = f.changes(); f.fire('gallery-tags-updated');
    assert.equal(f.changes(), prior + 1); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'none.png', 'a.png']);
    f.setDefinitions([]); f.fire('gallery-tags-updated');
    assert.equal(f.tags.children[0].attributes['aria-pressed'], 'true'); assert.deepEqual(paths(f.filters.apply(input)), paths(input));
});

test('record list and detail failures fall back to base order while tag filters stay usable', async () => {
    const f = fixture(); f.reply({message: 'Synthetic list failure'}, 500); await flush();
    assert.match(f.filters.element.textContent, /Synthetic list failure/);
    f.selectTag('tagged'); assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png', 'b.png']);
    const retry = f.retry(); await loaded(f); await retry;
    const selected = f.selectRecord('one'); f.reply({message: 'Record missing'}, 404); await selected;
    assert.equal(f.ranking.value, ''); assert.match(f.filters.element.textContent, /기본 순서로 표시/);
    assert.deepEqual(paths(f.filters.apply(input)), ['c.png', 'a.png', 'b.png']);
});

test('record updates retain an existing choice but fall back when that record disappears', async () => {
    const f = fixture(); await loaded(f);
    const selected = f.selectRecord('one'); f.reply({record: {...summary('one'), participants}}); await selected;
    f.fire('daki-worldcups-updated'); await loaded(f, [summary('three'), summary('one')]);
    assert.equal(f.ranking.value, 'one'); assert.equal(f.filters.apply(input)[0].path, 'a.png');
    f.fire('daki-worldcups-updated'); await loaded(f, [summary('three')]);
    assert.equal(f.ranking.value, ''); assert.deepEqual(paths(f.filters.apply(input)), paths(input));
    assert.match(f.filters.element.textContent, /선택한 월드컵 기록을 찾을 수 없어/);
});

test('records from other galleries are not offered or used for ranking', async () => {
    const f = fixture(); await loaded(f, [summary('one'), summary('other', {gallery_key: 'shared:upper'})]);
    assert.deepEqual(f.ranking.children.map(option => option.value), ['', 'one']);
    const selected = f.selectRecord('one'); f.reply({record: {...summary('one', {gallery_key: 'personal'}), participants}}); await selected;
    assert.equal(f.ranking.value, ''); assert.deepEqual(paths(f.filters.apply(input)), paths(input));
});

test('dispose removes both listeners and ignores outstanding responses and callbacks', async () => {
    const f = fixture(); f.filters.dispose(); await loaded(f);
    assert.equal(f.changes(), 0); assert.equal(f.ranking.children.length, 1);
    assert.equal(f.events.get('gallery-tags-updated').size, 0); assert.equal(f.events.get('daki-worldcups-updated').size, 0);
    f.fire('daki-worldcups-updated'); assert.equal(f.requests.length, 1);
    const other = fixture(); await loaded(other); const selected = other.selectRecord('one'); const prior = other.changes();
    other.filters.dispose(); other.reply({record: {...summary('one'), participants}}); await selected;
    assert.equal(other.changes(), prior); assert.deepEqual(paths(other.filters.apply(input)), paths(input));
});

const recommendedInput = Object.freeze([
    Object.freeze({path: 'c.png', recommendations: 12}),
    Object.freeze({path: 'none.png', recommendations: null}),
    Object.freeze({path: 'a.png', recommendations: 0}),
    Object.freeze({path: 'b.png', recommendations: 12}),
    Object.freeze({path: 'missing.png'}),
    Object.freeze({path: 'popular.png', recommendations: 54}),
]);
const recommendationOf = item => item.recommendations;

test('recommendation controls are optional and remain absent in tag-only pickers', () => {
    const basic = fixture(); assert.equal(basic.minimum, undefined);
    assert.deepEqual(basic.ranking.children.map(option => option.value), ['']);
    const tags = fixture({tagOnly: true, recommendationOf});
    assert.equal(tags.minimum, undefined); assert.equal(tags.ranking, undefined); assert.deepEqual(tags.requests, []);
    tags.selectTag('tagged'); assert.deepEqual(paths(tags.filters.apply(recommendedInput)), ['c.png', 'a.png', 'b.png']);
});

test('recommendation presets combine with tags and selecting all restores zero and unknown counts', async () => {
    const f = fixture({recommendationOf}); await loaded(f);
    assert.deepEqual(f.minimum.children.map(option => option.textContent), ['전체', '10 이상', '20 이상', '30 이상', '40 이상', '50 이상', '60 이상', '70 이상', '80 이상', '90 이상', '100 이상']);
    assert.equal(f.filters.element.querySelectorAll('input').length, 0);
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), paths(recommendedInput));
    f.selectMinimum('10'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    f.selectTag('tag:keep'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png']);
    f.selectMinimum('20'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), []);
    f.selectMinimum('10');
    f.selectTag('all'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    f.selectMinimum(''); assert.deepEqual(paths(f.filters.apply(recommendedInput)), paths(recommendedInput));
    const wrapped = recommendedInput.map(image => ({image}));
    const nested = fixture({recommendationOf: item => item.image.recommendations}); await loaded(nested);
    nested.selectMinimum('50');
    assert.deepEqual(nested.filters.apply(wrapped, item => item.image.path).map(item => item.image.path), ['popular.png']);
});

test('recommendation sorting is stable, never mutates items, keeps unknowns last in both directions, and treats zero as valid', async () => {
    const f = fixture({recommendationOf}); await loaded(f);
    await f.selectRecord('recommendation:desc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['popular.png', 'c.png', 'b.png', 'a.png', 'none.png', 'missing.png']);
    await f.selectRecord('recommendation:asc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['a.png', 'c.png', 'b.png', 'popular.png', 'none.png', 'missing.png']);
    assert.deepEqual(paths(recommendedInput), ['c.png', 'none.png', 'a.png', 'b.png', 'missing.png', 'popular.png']);
    const malformed = [{path: 'null', recommendations: null}, {path: 'string', recommendations: '8'},
        {path: 'negative', recommendations: -1}, {path: 'fraction', recommendations: 2.5}, {path: 'zero', recommendations: 0}];
    assert.deepEqual(paths(f.filters.apply(malformed)), ['zero', 'null', 'string', 'negative', 'fraction']);
    f.selectMinimum('10'); assert.deepEqual(paths(f.filters.apply(malformed)), []);
});

test('result count reports the full gallery total and zero matches without late disposal updates', async () => {
    const f = fixture({recommendationOf}); await loaded(f);
    f.filters.setResultCount(3, 1234);
    assert.match(f.filters.element.textContent, /3장 남음 \/ 전체 1,234장/);
    f.filters.setResultCount(0, 1234);
    assert.match(f.filters.element.textContent, /0장 남음 \/ 전체 1,234장/);
    f.filters.dispose(); f.filters.setResultCount(99, 1234);
    assert.match(f.filters.element.textContent, /0장 남음 \/ 전체 1,234장/);
});

test('recommendations and worldcups use distinct sort values and switching discards pending or active ranking', async () => {
    const f = fixture({recommendationOf}); await loaded(f, [summary('recommendation:asc'), summary('two')]);
    assert.deepEqual(f.ranking.children.map(option => option.value), ['', 'recommendation:desc', 'recommendation:asc', 'worldcup:recommendation:asc', 'worldcup:two']);
    const pending = f.selectRecord('worldcup:recommendation:asc');
    assert.equal(f.requests.at(-1), '/api/daki/worldcups/recommendation%3Aasc');
    await f.selectRecord('recommendation:desc');
    f.reply({record: {...summary('recommendation:asc'), participants}}); await pending;
    assert.equal(f.filters.apply(recommendedInput)[0].path, 'popular.png');
    const selected = f.selectRecord('worldcup:two'); f.reply({record: {...summary('two'), participants}}); await selected;
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['a.png', 'c.png', 'b.png', 'none.png', 'missing.png', 'popular.png']);
    f.selectMinimum('10'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    await f.selectRecord('recommendation:desc'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['popular.png', 'c.png', 'b.png']);
    await f.selectRecord(''); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
});

test('worldcup list failures and reloads preserve recommendation sorting and the selected minimum', async () => {
    const f = fixture({recommendationOf});
    await f.selectRecord('recommendation:desc'); f.selectMinimum('10');
    f.reply({message: 'Synthetic list failure'}, 500); await flush();
    assert.equal(f.ranking.value, 'recommendation:desc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['popular.png', 'c.png', 'b.png']);
    assert.match(f.filters.element.textContent, /추천수 정렬·필터와 태그 필터를 사용할 수 있습니다/);
    await f.selectRecord('recommendation:asc'); assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    const retry = f.retry(); await loaded(f); await retry;
    assert.equal(f.ranking.value, 'recommendation:asc');
    f.fire('daki-worldcups-updated'); await loaded(f, []);
    assert.equal(f.ranking.value, 'recommendation:asc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    f.fire('daki-worldcups-updated'); f.reply({message: 'Reload failure'}, 500); await flush();
    assert.equal(f.ranking.value, 'recommendation:asc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
});

test('worldcup disappearance or detail failure preserves the minimum and leaves recommendation sorting usable', async () => {
    const f = fixture({recommendationOf}); await loaded(f); f.selectMinimum('10');
    const selected = f.selectRecord('worldcup:one'); f.reply({record: {...summary('one'), participants}}); await selected;
    f.fire('daki-worldcups-updated'); await loaded(f, [summary('two')]);
    assert.equal(f.ranking.value, '');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['c.png', 'b.png', 'popular.png']);
    const failed = f.selectRecord('worldcup:two'); f.reply({message: 'Missing'}, 404); await failed;
    await f.selectRecord('recommendation:desc');
    assert.deepEqual(paths(f.filters.apply(recommendedInput)), ['popular.png', 'c.png', 'b.png']);
});

const datedInput = Object.freeze([
    Object.freeze({path: 'c.png', sort_date: '2026-04-01T00:00:00Z'}),
    Object.freeze({path: 'none.png', sort_date: null}),
    Object.freeze({path: 'a.png', sort_date: '2026-04-03T00:00:00Z'}),
    Object.freeze({path: 'b.png', sort_date: '2026-04-03T00:00:00Z'}),
    Object.freeze({path: 'invalid.png', sort_date: 'not-a-date'}),
    Object.freeze({path: 'old.png', sort_date: '2025-04-01T00:00:00Z'}),
    Object.freeze({path: 'number.png', sort_date: 0}),
]);

test('date sorting is stable, preserves input, and leaves missing or invalid dates last in both directions', async () => {
    const f = fixture({dateOf: item => item.sort_date}); await loaded(f);
    assert.deepEqual(f.ranking.children.map(option => option.value), ['', 'date:desc', 'date:asc', 'worldcup:one', 'worldcup:two']);
    await f.selectRecord('date:desc');
    assert.deepEqual(paths(f.filters.apply(datedInput)), ['a.png', 'b.png', 'c.png', 'old.png', 'none.png', 'invalid.png', 'number.png']);
    assert.match(f.filters.element.textContent, /그림체 작성일·추가일 최신순.*날짜를 알 수 없는 항목은 마지막에 표시합니다/);
    await f.selectRecord('date:asc');
    assert.deepEqual(paths(f.filters.apply(datedInput)), ['old.png', 'c.png', 'a.png', 'b.png', 'none.png', 'invalid.png', 'number.png']);
    assert.deepEqual(paths(datedInput), ['c.png', 'none.png', 'a.png', 'b.png', 'invalid.png', 'old.png', 'number.png']);
    const tagOnly = fixture({tagOnly: true, dateOf: item => item.sort_date});
    assert.equal(tagOnly.ranking, undefined); assert.deepEqual(tagOnly.requests, []);
});

test('date sorting combines with tag and recommendation filters and can work without recommendation sorting', async () => {
    const withRecommendations = [
        {path: 'c.png', sort_date: '2026-04-01T00:00:00Z', recommendations: 12},
        {path: 'a.png', sort_date: '2026-04-03T00:00:00Z', recommendations: 0},
        {path: 'b.png', sort_date: '2026-04-02T00:00:00Z', recommendations: 12},
        {path: 'popular.png', sort_date: null, recommendations: 54},
    ];
    const f = fixture({dateOf: item => item.sort_date, recommendationOf}); await loaded(f);
    await f.selectRecord('date:desc'); f.selectMinimum('10');
    assert.deepEqual(paths(f.filters.apply(withRecommendations)), ['b.png', 'c.png', 'popular.png']);
    f.selectTag('tag:keep');
    assert.deepEqual(paths(f.filters.apply(withRecommendations)), ['c.png']);

    const dateOnly = fixture({dateOf: item => item.sort_date}); await loaded(dateOnly);
    assert.deepEqual(dateOnly.ranking.children.map(option => option.value), ['', 'date:desc', 'date:asc', 'worldcup:one', 'worldcup:two']);
    const requestCount = dateOnly.requests.length;
    await dateOnly.selectRecord('date:desc');
    assert.equal(dateOnly.requests.length, requestCount);
    const selected = dateOnly.selectRecord('worldcup:one');
    assert.equal(dateOnly.requests.at(-1), '/api/daki/worldcups/one');
    dateOnly.reply({record: {...summary('one'), participants}}); await selected;
    await dateOnly.selectRecord('date:asc');
    assert.equal(dateOnly.requests.length, requestCount + 1);
});

test('date sorting survives worldcup list failures, retries, and a pending detail response', async () => {
    const f = fixture({galleryKey: 'shared:all', dateOf: item => item.style.sort_date});
    await f.selectRecord('date:desc');
    f.reply({message: 'Synthetic list failure'}, 500); await flush();
    assert.equal(f.ranking.value, 'date:desc');
    assert.deepEqual(paths(f.filters.apply(datedInput.map(item => ({...item, style: {sort_date: item.sort_date}})))),
        ['a.png', 'b.png', 'c.png', 'old.png', 'none.png', 'invalid.png', 'number.png']);
    assert.match(f.filters.element.textContent, /그림체 작성일·추가일.*날짜를 알 수 없는 항목은 마지막에 표시합니다/);
    const retry = f.retry(); assert.equal(f.ranking.value, 'date:desc');
    assert.match(f.filters.element.textContent, /그림체 작성일·추가일 최신순.*기록을 불러오는 중/);
    await loaded(f); await retry; assert.equal(f.ranking.value, 'date:desc');

    const detail = f.selectRecord('worldcup:one');
    const requestCount = f.requests.length;
    await f.selectRecord('date:asc');
    assert.equal(f.requests.length, requestCount);
    f.reply({record: {...summary('one'), participants}}); await detail;
    const sharedInput = datedInput.map(item => ({...item, style: {sort_date: item.sort_date}}));
    assert.deepEqual(paths(f.filters.apply(sharedInput)), ['old.png', 'c.png', 'a.png', 'b.png', 'none.png', 'invalid.png', 'number.png']);
});
