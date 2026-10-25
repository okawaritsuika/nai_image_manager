const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const flush = () => new Promise(resolve => setImmediate(resolve));
const categories = [{id: 'all', label: '전체 태그', count: 2, sections: []},
    {id: 'face', label: '얼굴', count: 1, sections: [{id: 'face.hair', label: '머리카락', count: 1}]}];
const tags = [{tag: 'synthetic_hair', label_ko: '합성 머리', description_ko: '설명', thumbnail: '/api/daki/tag-catalog/example?tag=synthetic_hair'},
    {tag: 'synthetic_paint', label_ko: 'synthetic_paint', description_ko: '설명'}];
const detail = tag => ({...tags.find(item => item.tag === tag), categories: ['합성 분류'], examples: [], related: [], notes: []});

function fixture() {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.value = ''; this.text = ''; this.open = false; this.isConnected = false; }
        appendChild(child) { this.children.push(child); child.parent = this; child.isConnected = this.isConnected; return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => child.parent = null); this.children = []; this.text = ''; this.append(...children); }
        set textContent(value) { this.children = []; this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
        fire(name, event = {}) { for (const callback of this.listeners[name] || []) callback(event); }
        showModal() { this.open = true; }
        close() { this.open = false; this.fire('close'); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; this.isConnected = false; }
        focus() {}
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const body = new Element('body'); body.isConnected = true;
    const requests = [], inserted = [], timers = new Map(); let timerId = 0, closed = 0;
    const root = {document: {body, createElement: tag => new Element(tag)},
        fetch(url) { return new Promise(resolve => requests.push({url, resolve})); },
        setTimeout(callback) { timers.set(++timerId, callback); return timerId; }, clearTimeout(id) { timers.delete(id); }};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_tag_browser.js'), 'utf8'), {window: root, URLSearchParams});
    const all = () => body.descendants();
    return {root, body, requests, inserted, all, closed: () => closed,
        open(label = '베이스') { root.DakiTagBrowser.open({targetLabel: label, onInsert: tag => inserted.push(tag), onClose: () => closed++}); },
        button(text) { return all().find(item => item.tagName === 'BUTTON' && item.textContent === text); },
        field(label) { return all().find(item => item.attributes['aria-label'] === label); },
        card(tag) { return all().find(item => item.dataset.tag === tag); },
        reply(data, status = 200, matching = '') {
            const index = requests.findIndex(request => request.url.includes(matching)); assert.ok(index >= 0, 'Pending request missing');
            const request = requests.splice(index, 1)[0]; request.resolve({ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})});
        },
        runTimers() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); },
    };
}
async function loaded(f) {
    f.open(); f.reply({categories}); await flush();
    f.reply({items: tags, page: 1, pages: 2, total: 42}); await flush();
}

test('loads categories and pages, inserts the original English tag, and keeps the dictionary open', async () => {
    const f = fixture(); await loaded(f);
    assert.equal(f.field('세부 분류').disabled, true);
    assert.equal(f.button('베이스에 추가').disabled, true);
    f.card('synthetic_hair').onclick(); f.reply({tag: detail('synthetic_hair')}); await flush();
    f.button('베이스에 추가').onclick();
    assert.deepEqual(f.inserted, ['synthetic_hair']);
    assert.equal(f.body.children.length, 1); assert.equal(f.closed(), 0);
    assert.match(f.body.textContent, /합성 머리 추가됨/);
    f.field('다음 태그 페이지').onclick();
    assert.match(f.requests[0].url, /page=2/); assert.equal(f.button('베이스에 추가').disabled, true);
});

test('example actions retain the selected tag, refresh after saving, and close with the dictionary', async () => {
    const f = fixture(), opened = []; let closed = 0;
    f.root.DakiTagExamples = {open: options => opened.push(options), close: () => closed++};
    await loaded(f);
    f.card('synthetic_hair').onclick(); f.reply({tag: detail('synthetic_hair')}); await flush();
    f.button('기존 그림에서 추가').onclick();
    assert.equal(opened[0].mode, 'existing'); assert.equal(opened[0].tag.tag, 'synthetic_hair');
    const refreshed = opened[0].onSaved();
    f.reply({tag: {...detail('synthetic_hair'), examples: [{tag: 'synthetic_hair',
        thumbnail: '/api/daki/tag-catalog/example?tag=synthetic_hair&id=example',
        image: '/api/daki/tag-catalog/example?tag=synthetic_hair&id=example&full=1'}]}});
    await refreshed;
    assert.ok(f.field('합성 머리 예시 그림 확대'));
    f.button('새로 생성').onclick(); assert.equal(opened[1].mode, 'generate');
    f.root.DakiTagBrowser.close(); assert.equal(closed, 1);
    await opened[1].onSaved(); assert.equal(f.requests.length, 0); assert.equal(f.body.children.length, 0);
});

test('without an insertion target, browsing supports search, related details and enlarged examples without adding tags', async () => {
    const f = fixture(); f.root.DakiTagBrowser.open();
    f.reply({categories}); await flush();
    f.reply({items: tags, page: 1, pages: 1, total: 2}); await flush();
    assert.match(f.body.textContent, /태그사전 둘러보기/);
    assert.doesNotMatch(f.body.textContent, /에 추가|태그를 추가/);
    const search = f.field('태그 검색'); search.value = 'synthetic_hair'; search.oninput(); f.runTimers();
    assert.match(f.requests[0].url, /q=synthetic_hair/);
    f.reply({items: [tags[0]], page: 1, pages: 1, total: 1}); await flush();
    f.card('synthetic_hair').onclick();
    f.reply({tag: {...detail('synthetic_hair'), related: [{tag: 'synthetic_paint', label_ko: '관련 그림체'}],
        examples: [{tag: 'synthetic_hair', thumbnail: '/api/daki/tag-catalog/example?tag=synthetic_hair', image: '/api/daki/tag-catalog/example?tag=synthetic_hair&full=1'}]}}); await flush();
    assert.match(f.field('태그 상세').textContent, /합성 머리/);
    assert.doesNotMatch(f.body.textContent, /에 추가|추가됨/);
    f.field('합성 머리 예시 그림 확대').onclick(); assert.equal(f.body.children.length, 2);
    f.body.children[1].close();
    f.button('관련 그림체').onclick(); f.reply({tag: detail('synthetic_paint')}); await flush();
    assert.match(f.field('태그 상세').textContent, /synthetic_paint/);
    assert.deepEqual(f.inserted, []); assert.equal(f.requests.length, 0);
    f.root.DakiTagBrowser.close(); assert.equal(f.body.children.length, 0);
});

test('reopening in browse mode removes the previous insertion target and ignores its pending detail', async () => {
    const f = fixture(); await loaded(f); f.card('synthetic_hair').onclick();
    f.root.DakiTagBrowser.open();
    f.reply({tag: detail('synthetic_hair')}, 200, 'detail?'); await flush();
    f.reply({categories}); await flush(); f.reply({items: tags, page: 1, pages: 1, total: 2}); await flush();
    f.card('synthetic_paint').onclick(); f.reply({tag: detail('synthetic_paint')}); await flush();
    assert.equal(f.closed(), 1); assert.equal(f.body.children.length, 1);
    assert.equal(f.button('베이스에 추가'), undefined); assert.equal(f.button('프롬프트에 추가'), undefined);
    assert.doesNotMatch(f.body.textContent, /에 추가|추가됨/); assert.deepEqual(f.inserted, []);
});

test('category, subsection and example filtering reset pagination and target selection', async () => {
    const f = fixture(); await loaded(f);
    const category = f.field('카테고리'); category.value = 'face'; category.onchange();
    assert.equal(f.field('세부 분류').disabled, false);
    assert.match(f.requests[0].url, /category=face/);
    f.reply({items: [], page: 1, pages: 1, total: 0}); await flush();
    const section = f.field('세부 분류'); section.value = 'face.hair'; section.onchange();
    assert.match(f.requests[0].url, /section=face.hair/);
    f.reply({items: [], page: 1, pages: 1, total: 0}); await flush();
    const examples = f.field('예시 그림 있는 태그만'); examples.checked = true; examples.onchange();
    assert.match(f.requests[0].url, /examples=1/); assert.match(f.requests[0].url, /page=1/);
});

test('late list responses cannot replace a new search while its debounce is pending', async () => {
    const f = fixture(); await loaded(f);
    f.field('다음 태그 페이지').onclick();
    const search = f.field('태그 검색'); search.value = 'new query'; search.oninput();
    f.reply({items: [tags[0]], page: 2, pages: 2, total: 42}); await flush();
    assert.equal(f.card('synthetic_hair'), undefined);
    f.runTimers(); assert.match(f.requests[0].url, /q=new\+query/);
    f.reply({items: [tags[1]], page: 1, pages: 1, total: 1}); await flush();
    assert.ok(f.card('synthetic_paint')); assert.equal(f.card('synthetic_hair'), undefined);
});

test('late detail responses and mismatched tag details cannot change the current insertion', async () => {
    const f = fixture(); await loaded(f);
    f.card('synthetic_hair').onclick(); f.card('synthetic_paint').onclick();
    f.reply({tag: detail('synthetic_paint')}, 200, 'tag=synthetic_paint'); await flush();
    f.reply({tag: detail('synthetic_hair')}, 200, 'tag=synthetic_hair'); await flush();
    f.button('베이스에 추가').onclick(); assert.deepEqual(f.inserted, ['synthetic_paint']);
    f.card('synthetic_hair').onclick(); f.reply({tag: detail('synthetic_paint')}); await flush();
    assert.equal(f.button('베이스에 추가').disabled, true);
    assert.match(f.body.textContent, /응답이 일치하지/);
});

test('closing ignores pending requests, removes previews, and invokes the close callback once', async () => {
    const f = fixture(); await loaded(f);
    f.card('synthetic_hair').onclick();
    f.root.DakiTagBrowser.close(); f.root.DakiTagBrowser.close();
    f.reply({tag: detail('synthetic_hair')}); await flush();
    assert.equal(f.body.children.length, 0); assert.equal(f.closed(), 1); assert.deepEqual(f.inserted, []);
    f.open('네거티브'); f.root.DakiTagBrowser.close(); f.reply({categories}); await flush();
    assert.equal(f.body.children.length, 0); assert.equal(f.requests.length, 0);
});

test('reopening targets the new editor and never runs the previous target callback', async () => {
    const f = fixture(); await loaded(f);
    f.card('synthetic_hair').onclick();
    f.open('네거티브'); f.reply({tag: detail('synthetic_hair')}, 200, 'detail?'); await flush();
    f.reply({categories}); await flush(); f.reply({items: tags, page: 1, pages: 1, total: 2}); await flush();
    assert.equal(f.closed(), 1); assert.equal(f.body.children.length, 1);
    f.card('synthetic_paint').onclick(); f.reply({tag: detail('synthetic_paint')}); await flush();
    f.button('네거티브에 추가').onclick(); assert.deepEqual(f.inserted, ['synthetic_paint']);
});

test('source failures expose retry without enabling insertion', async () => {
    const f = fixture(); f.open(); f.reply({message: '합성 원본 없음'}, 404); await flush();
    assert.match(f.body.textContent, /합성 원본 없음/); assert.equal(f.button('베이스에 추가').disabled, true);
    f.button('다시 불러오기').onclick(); f.reply({categories}); await flush();
    f.reply({items: [], page: 1, pages: 1, total: 0}); await flush(); assert.match(f.body.textContent, /조건에 맞는 태그/);
});

test('detail includes attribution and related tags, expands local examples, and closes nested preview', async () => {
    const f = fixture(); await loaded(f); f.card('synthetic_hair').onclick();
    f.reply({tag: {...detail('synthetic_hair'), description_source_license: 'Synthetic license', description_original_en: 'Synthetic original',
        description_references: ['javascript:bad', 'https://example.invalid/source'], related: [{tag: 'synthetic_paint', label_ko: '그림체 관련'}],
        examples: [{tag: 'synthetic_hair', relation: 'base_reference', thumbnail: '/api/daki/tag-catalog/example?tag=synthetic_hair', image: '/api/daki/tag-catalog/example?tag=synthetic_hair&full=1', reference_note: '기본형 참고 설명'}]}}); await flush();
    const links = f.all().filter(item => item.tagName === 'A'); assert.equal(links.length, 1); assert.equal(links[0].href, 'https://example.invalid/source');
    assert.match(f.body.textContent, /Synthetic license/); assert.match(f.body.textContent, /기본형 참고 설명/);
    f.field('합성 머리 예시 그림 확대').onclick(); assert.equal(f.body.children.length, 2);
    f.root.DakiTagBrowser.close(); assert.equal(f.body.children.length, 0);
});
