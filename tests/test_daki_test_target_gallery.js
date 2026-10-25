const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const catalog = {library: 'shared', styles: [
    {id: 'style_a', name: 'Style A', src: '/synthetic/a.webp'},
    {id: 'style_b', name: 'A very long style name without any spaces-'.repeat(5), src: '/synthetic/b.webp'},
    {id: 'style_c', name: 'Style C', src: '/synthetic/c.webp'},
]};
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({input = catalog, selectedIds = [], fetch} = {}) {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.listeners = new Map();
            this.text = ''; this.value = ''; this.className = ''; this.disabled = false; this.hidden = false;
            this.style = {}; this.validity = {}; this.capturedPointers = new Set();
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; children.forEach(child => this.appendChild(child)); }
        set textContent(value) { this.replaceChildren(); this.text = String(value); }
        get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        addEventListener(type, listener) { const group = this.listeners.get(type) || []; group.push(listener); this.listeners.set(type, group); }
        removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener)); }
        dispatch(type, event = {}) { (this.listeners.get(type) || []).forEach(listener => listener({preventDefault() {}, ...event})); }
        getBoundingClientRect() { return this.rect || {left: 0, top: 0, width: 0, height: 0}; }
        setPointerCapture(pointerId) { this.capturedPointers.add(pointerId); }
        hasPointerCapture(pointerId) { return this.capturedPointers.has(pointerId); }
        releasePointerCapture(pointerId) { this.capturedPointers.delete(pointerId); }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
        remove() { this.removed = true; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); }
        showModal() { this.open = true; }
        close() { this.open = false; this.dispatch('close'); }
    }
    const body = new Element('body');
    const requests = [];
    const win = {document: {body, createElement: tag => new Element(tag)}, fetch: fetch || ((url, options) => {
        const entry = {url, options}; requests.push(entry); return Promise.reject(new Error('Unexpected network request'));
    })};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_test_target_gallery.js'), 'utf8'), {window: win});
    const applied = [];
    const picker = win.DakiTestTargetGallery.open({catalog: input, selectedIds, onApply: ids => applied.push(ids)});
    const all = () => body.descendants();
    const button = label => all().find(item => item.tagName === 'BUTTON' && item.textContent === label);
    const field = label => all().find(item => item.attributes['aria-label'] === label);
    const grid = () => all().find(item => item.className === 'daki-test-target-gallery-grid' || item.className === 'daki-test-target-gallery-grid is-selecting');
    const card = id => grid().children.find(item => item.attributes['data-style-id'] === id);
    const cardSelected = id => card(id)?.attributes['aria-pressed'] === 'true';
    const clickCard = (id, detail = 1) => card(id).onclick({detail, preventDefault() {}, stopPropagation() {}});
    const keyCard = (id, key) => {
        let prevented = false;
        card(id).onkeydown({key, preventDefault() { prevented = true; }});
        return prevented;
    };
    const cardIds = () => grid().children.filter(item => item.tagName === 'ARTICLE').map(item => item.attributes['data-style-id']);
    return {win, body, requests, applied, picker, all, button, field, grid, card, cardSelected, clickCard, keyCard, cardIds};
}
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}
function response(data, status = 200) {
    return {ok: status < 400, json: async () => ({status: status < 400 ? 'success' : 'error', ...data})};
}

test('opens with all active catalog cards, performs no request, and bulk selection supports individual deselection', () => {
    const f = fixture();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.grid().children.map(card => card.children[1].children[0].textContent), catalog.styles.map(style => style.name));
    assert.equal(f.grid().descendants().some(item => item.tagName === 'INPUT'), false);
    assert.equal(f.card('style_a').attributes.role, 'button');
    assert.equal(f.cardSelected('style_a'), false);
    assert.equal(f.all().find(item => item.tagName === 'DIALOG').attributes['aria-labelledby'], 'dakiTestTargetGalleryTitle');

    f.button('표시된 그림체 모두 선택').onclick();
    f.clickCard('style_b');
    assert.equal(f.cardSelected('style_b'), false);
    assert.equal(f.all().find(item => item.className === 'daki-test-target-gallery-counts').textContent, '표시 3개 / 현재 그림체 3개 · 전체 선택 2개');
    f.button('선택한 그림체 적용').onclick();
    assert.deepEqual(f.applied.map(ids => [...ids]), [['style_a', 'style_c']]);
    assert.equal(f.picker.closed, true);
});

test('cards toggle with Enter and Space and keep their pressed state in sync', () => {
    const f = fixture();
    assert.equal(f.keyCard('style_a', 'Enter'), true);
    assert.equal(f.cardSelected('style_a'), true);
    assert.equal(f.keyCard('style_b', ' '), true);
    assert.equal(f.cardSelected('style_b'), true);
    assert.equal(f.keyCard('style_b', ' '), true);
    assert.equal(f.cardSelected('style_b'), false);
    assert.equal(f.all().find(item => item.className === 'daki-test-target-gallery-counts').textContent,
        '표시 3개 / 현재 그림체 3개 · 전체 선택 1개');
    f.button('선택한 그림체 적용').onclick();
    assert.deepEqual(f.applied.map(ids => [...ids]), [['style_a']]);
});

test('filter request sends only positive include and exclude fields, intersects active IDs, and keeps selection across result changes', async () => {
    const requests = [];
    const f = fixture({selectedIds: ['style_c'], fetch(url, options) {
        const pending = deferred(); requests.push({url, options, ...pending}); return pending.promise;
    }});
    f.field('포함 태그').value = ' watercolor, sketch || lineart% ';
    f.field('제외 태그').value = ' monochrome\n bad_tag ,, ';
    f.field('포함 태그').oninput();
    assert.equal(f.button('표시된 그림체 모두 선택').disabled, true);
    assert.equal(f.button('선택한 그림체 적용').disabled, true);
    f.button('필터 적용').onclick();
    assert.equal(requests[0].url, '/api/daki/style-tests/targets/filter');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        library: 'shared', include_query: 'watercolor, sketch || lineart%', exclude_tags: ['monochrome', 'bad_tag'],
    });
    requests[0].resolve(response({style_ids: ['style_b', 'unknown', 'style_c', 'style_b']})); await flush();
    assert.deepEqual(f.grid().children.map(card => card.children[1].children[0].textContent), [catalog.styles[1].name, 'Style C']);
    assert.equal(f.cardSelected('style_c'), true);
    f.button('표시된 그림체 모두 선택').onclick();
    assert.equal(f.all().find(item => item.className === 'daki-test-target-gallery-counts').textContent, '표시 2개 / 현재 그림체 3개 · 전체 선택 2개');
    f.button('선택한 그림체 적용').onclick();
    assert.deepEqual(f.applied.map(ids => [...ids]), [['style_b', 'style_c']]);
});

test('pending latest request wins and edits invalidate old results until the next filter is applied', async () => {
    const requests = [];
    const f = fixture({fetch(url, options) { const pending = deferred(); requests.push({url, options, ...pending}); return pending.promise; }});
    f.field('포함 태그').value = 'first'; f.field('포함 태그').oninput(); f.button('필터 적용').onclick();
    f.field('포함 태그').value = 'second'; f.field('포함 태그').oninput();
    assert.equal(f.button('필터 적용').disabled, false);
    assert.equal(f.button('표시된 그림체 모두 선택').disabled, true);
    f.button('필터 적용').onclick();
    requests[1].resolve(response({style_ids: ['style_b']})); await flush();
    requests[0].resolve(response({style_ids: ['style_a']})); await flush();
    assert.deepEqual(f.grid().children.map(card => card.children[1].children[0].textContent), [catalog.styles[1].name]);
    assert.equal(f.button('선택한 그림체 적용').disabled, false);
    f.field('포함 태그').value = ''; f.field('포함 태그').oninput();
    assert.equal(f.grid().children.length, 0);
    assert.equal(f.button('선택한 그림체 적용').disabled, true);
    f.button('선택한 그림체 적용').onclick();
    assert.equal(f.applied.length, 0);
});

test('request errors block stale bulk selection and apply, and cancel leaves the parent target untouched', async () => {
    const requests = [];
    const f = fixture({fetch(url, options) { const pending = deferred(); requests.push({url, options, ...pending}); return pending.promise; }});
    f.field('제외 태그').value = 'bad'; f.field('제외 태그').oninput(); f.button('필터 적용').onclick();
    requests[0].resolve(response({message: 'Synthetic filter failure'}, 400)); await flush();
    assert.match(f.all().find(item => item.className.includes('daki-test-target-gallery-status')).textContent, /Synthetic filter failure/);
    assert.equal(f.button('표시된 그림체 모두 선택').disabled, true);
    assert.equal(f.button('선택한 그림체 적용').disabled, true);
    f.button('취소').onclick();
    assert.deepEqual(f.applied, []);
    assert.equal(f.picker.closed, true);
});

test('personal cards use current personal thumbnails and label missing representative images', () => {
    const personal = {library: 'personal', styles: [
        {id: 'personal_' + 'a'.repeat(32), name: 'Has image', source_path: 'synthetic/a.png', src: '/synthetic/personal.webp'},
        {id: 'personal_' + 'b'.repeat(32), name: 'No image', source_path: ''},
    ]};
    const f = fixture({input: personal});
    const cards = f.grid().children;
    assert.equal(cards[0].children[0].src, '/synthetic/personal.webp');
    assert.equal(cards[0].children[0].loading, 'lazy');
    assert.equal(cards[1].children[0].textContent, '대표 그림 없음');
    f.button('취소').onclick();
});

test('sort modes order known values both ways, keep ties stable, and leave missing metadata last', () => {
    const input = {library: 'shared', styles: [
        {id: 'unknown', name: 'Unknown', src: '/synthetic/unknown.webp', recommendation_count: null, sort_date: null},
        {id: 'zero', name: 'Cero', src: '/synthetic/zero.webp', recommendation_count: 0, sort_date: '2025-02-01T00:00:00Z'},
        {id: 'ten_a', name: 'Beta', src: '/synthetic/ten-a.webp', recommendation_count: 10, sort_date: '2025-02-03T00:00:00Z'},
        {id: 'ten_b', name: 'Beta', src: '/synthetic/ten-b.webp', recommendation_count: 10, sort_date: '2025-02-03T00:00:00Z'},
        {id: 'two', name: 'Alpha', src: '/synthetic/two.webp', recommendation_count: 2, sort_date: '2025-02-03T00:00:00Z'},
    ]};
    const f = fixture({input});
    const sort = f.field('그림체 정렬');
    assert.deepEqual(f.cardIds(), ['unknown', 'zero', 'ten_a', 'ten_b', 'two']);
    sort.value = 'recommendation:desc'; sort.onchange();
    assert.deepEqual(f.cardIds(), ['ten_a', 'ten_b', 'two', 'zero', 'unknown']);
    sort.value = 'recommendation:asc'; sort.onchange();
    assert.deepEqual(f.cardIds(), ['zero', 'two', 'ten_a', 'ten_b', 'unknown']);
    sort.value = 'date:desc'; sort.onchange();
    assert.deepEqual(f.cardIds(), ['ten_a', 'ten_b', 'two', 'zero', 'unknown']);
    sort.value = 'date:asc'; sort.onchange();
    assert.deepEqual(f.cardIds(), ['zero', 'ten_a', 'ten_b', 'two', 'unknown']);
    sort.value = 'name'; sort.onchange();
    assert.deepEqual(f.cardIds(), ['two', 'ten_a', 'ten_b', 'zero', 'unknown']);
    const recommendations = f.grid().children.map(card => card.children[2].textContent);
    assert.deepEqual(recommendations, ['추천 2개', '추천 10개', '추천 10개', '추천 0개', '추천 수 확인 불가']);
    sort.value = ''; sort.onchange();
    assert.deepEqual(f.cardIds(), ['unknown', 'zero', 'ten_a', 'ten_b', 'two']);
    f.button('취소').onclick();
});

test('minimum recommendation filter is local, includes the threshold, excludes unknowns, and preserves selections', () => {
    const input = {library: 'shared', styles: [
        {id: 'unknown', name: 'Unknown', src: '/synthetic/unknown.webp', recommendation_count: null},
        {id: 'zero', name: 'Zero', src: '/synthetic/zero.webp', recommendation_count: 0},
        {id: 'nineteen', name: 'Nineteen', src: '/synthetic/nineteen.webp', recommendation_count: 19},
        {id: 'twenty', name: 'Twenty', src: '/synthetic/twenty.webp', recommendation_count: 20},
        {id: 'twenty_four', name: 'Twenty four', src: '/synthetic/twenty-four.webp', recommendation_count: 24},
    ]};
    const f = fixture({input, selectedIds: ['unknown']});
    const minimum = f.field('최소 추천수');
    minimum.value = '0'; minimum.oninput();
    assert.deepEqual(f.cardIds(), ['zero', 'nineteen', 'twenty', 'twenty_four']);
    minimum.value = '20'; minimum.oninput();
    assert.deepEqual(f.cardIds(), ['twenty', 'twenty_four']);
    f.button('표시된 그림체 모두 선택').onclick();
    assert.equal(f.all().find(item => item.className === 'daki-test-target-gallery-counts').textContent,
        '표시 2개 / 현재 그림체 5개 · 전체 선택 3개');
    minimum.value = '24'; minimum.oninput();
    assert.deepEqual(f.cardIds(), ['twenty_four']);
    assert.equal(f.cardSelected('twenty_four'), true);
    assert.equal(f.card('unknown'), undefined);
    assert.equal(f.requests.length, 0);

    for (const invalid of ['-1', '1.5', '9007199254740992']) {
        minimum.value = invalid; minimum.validity.badInput = false; minimum.oninput();
        assert.match(f.all().find(item => item.className.includes('daki-test-target-gallery-recommendation-status')).textContent, /0 이상의 안전한 정수/);
        assert.equal(f.button('표시된 그림체 모두 선택').disabled, true);
        assert.equal(f.button('선택한 그림체 적용').disabled, true);
        f.button('선택한 그림체 적용').onclick();
        assert.deepEqual(f.applied, []);
    }
    minimum.value = ''; minimum.validity.badInput = true; minimum.oninput();
    assert.equal(f.button('선택한 그림체 적용').disabled, true);
    minimum.validity.badInput = false; minimum.oninput();
    assert.deepEqual(f.cardIds(), ['unknown', 'zero', 'nineteen', 'twenty', 'twenty_four']);
    assert.equal(f.all().find(item => item.className === 'daki-test-target-gallery-counts').textContent,
        '표시 5개 / 현재 그림체 5개 · 전체 선택 3개');
    f.button('선택한 그림체 적용').onclick();
    assert.deepEqual(f.applied.map(ids => [...ids]), [['unknown', 'twenty', 'twenty_four']]);
});

test('test preview source works for a personal preview without source_path', () => {
    const f = fixture({input: {library: 'personal', styles: [
        {id: 'preview_test', name: 'Current test preview', preview_kind: 'test', src: '/synthetic/test-preview.webp', source_path: ''},
    ]}});
    assert.equal(f.grid().children[0].children[0].src, '/synthetic/test-preview.webp');
    f.button('취소').onclick();
});

test('rectangle drag selects intersecting cards in reverse direction and adds to the initial selection', () => {
    const f = fixture({selectedIds: ['style_c']});
    const grid = f.grid(); grid.rect = {left: 100, top: 100, width: 500, height: 500};
    const [a, b, c] = grid.children;
    a.rect = {left: 110, top: 110, width: 100, height: 100};
    b.rect = {left: 220, top: 110, width: 100, height: 100};
    c.rect = {left: 350, top: 110, width: 100, height: 100};
    const scrollBody = f.all().find(item => item.className === 'daki-test-target-gallery-body');
    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 7, clientX: 325, clientY: 205, target: b.children[0]});
    grid.dispatch('pointermove', {pointerId: 7, clientX: 105, clientY: 105});
    assert.equal(grid.className, 'daki-test-target-gallery-grid is-selecting');
    assert.deepEqual(['style_a', 'style_b', 'style_c'].filter(id => f.cardSelected(id)), ['style_a', 'style_b', 'style_c']);
    assert.equal(grid.children.at(-1).className, 'daki-test-target-gallery-selection-box');
    assert.equal((scrollBody.listeners.get('scroll') || []).length, 1);
    assert.equal(grid.hasPointerCapture(7), true);
    grid.dispatch('pointerup', {pointerId: 7});
    assert.equal(grid.hasPointerCapture(7), false);
    assert.equal(grid.className, 'daki-test-target-gallery-grid');
    assert.equal(grid.children.length, 3);
    assert.equal((scrollBody.listeners.get('scroll') || []).length, 0);
    f.clickCard('style_b');
    assert.deepEqual(['style_a', 'style_b', 'style_c'].filter(id => f.cardSelected(id)), ['style_a', 'style_b', 'style_c']);
    grid.dispatch('pointerdown', {pointerType: 'touch', pointerId: 9, clientX: 325, clientY: 205, target: b.children[0]});
    f.clickCard('style_a');
    assert.deepEqual(['style_a', 'style_b', 'style_c'].filter(id => f.cardSelected(id)), ['style_b', 'style_c']);
    f.button('선택한 그림체 적용').onclick();
    assert.deepEqual(f.applied.map(ids => [...ids]), [['style_b', 'style_c']]);
});

test('invalid recommendation and filter states block card clicks and keyboard selection', async () => {
    const requests = [];
    const f = fixture({fetch(url, options) {
        const pending = deferred(); requests.push({url, options, ...pending}); return pending.promise;
    }});
    const initialCard = f.card('style_a');
    const minimum = f.field('최소 추천수');
    minimum.value = '-1'; minimum.oninput();
    assert.equal(f.card('style_a').attributes['aria-disabled'], 'true');
    f.clickCard('style_a');
    assert.equal(f.keyCard('style_a', 'Enter'), true);
    assert.equal(f.cardSelected('style_a'), false);

    minimum.value = ''; minimum.oninput();
    f.field('포함 태그').value = 'pending'; f.field('포함 태그').oninput();
    initialCard.onclick({detail: 1, preventDefault() {}, stopPropagation() {}});
    assert.equal(f.cardSelected('style_a'), false);
    f.button('필터 적용').onclick();
    initialCard.onkeydown({key: ' ', preventDefault() {}});
    assert.equal(f.cardSelected('style_a'), false);
    requests[0].resolve(response({message: 'Synthetic filter failure'}, 400)); await flush();
    initialCard.onclick({detail: 1, preventDefault() {}, stopPropagation() {}});
    assert.equal(f.cardSelected('style_a'), false);
});

test('rectangle selection ignores the threshold, rejects interactive starts, restores on pointercancel, and cleans up on close', () => {
    const f = fixture({selectedIds: ['style_c']});
    const grid = f.grid(); grid.rect = {left: 100, top: 100, width: 500, height: 500};
    grid.children.forEach((card, index) => { card.rect = {left: 110 + index * 110, top: 110, width: 100, height: 100}; });
    const scrollBody = f.all().find(item => item.className === 'daki-test-target-gallery-body');
    const syntheticInput = {tagName: 'INPUT', parentNode: grid.children[0]};
    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 1, clientX: 120, clientY: 120, target: syntheticInput});
    assert.equal(grid.hasPointerCapture(1), false);
    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 2, clientX: 120, clientY: 120, target: grid.children[0].children[0]});
    grid.dispatch('pointermove', {pointerId: 2, clientX: 123, clientY: 122});
    assert.equal(grid.className, 'daki-test-target-gallery-grid');
    grid.dispatch('pointerup', {pointerId: 2});
    assert.deepEqual(['style_a', 'style_b', 'style_c'].filter(id => f.cardSelected(id)), ['style_c']);

    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 3, clientX: 120, clientY: 120, target: grid.children[0].children[0]});
    grid.dispatch('pointermove', {pointerId: 3, clientX: 320, clientY: 210});
    assert.equal(f.cardSelected('style_a'), true);
    assert.equal(f.cardSelected('style_b'), true);
    grid.dispatch('pointercancel', {pointerId: 3});
    assert.deepEqual(['style_a', 'style_b', 'style_c'].filter(id => f.cardSelected(id)), ['style_c']);
    assert.equal((scrollBody.listeners.get('scroll') || []).length, 0);

    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 4, clientX: 120, clientY: 120, target: grid.children[0].children[0]});
    grid.dispatch('pointermove', {pointerId: 4, clientX: 320, clientY: 210});
    f.picker.close();
    assert.equal((scrollBody.listeners.get('scroll') || []).length, 0);
    assert.equal(grid.children.some(item => item.className === 'daki-test-target-gallery-selection-box'), false);
});

test('rectangle drag recalculates card intersections when the scroll body moves under a stationary pointer', () => {
    const f = fixture();
    const grid = f.grid(); grid.rect = {left: 100, top: 100, width: 500, height: 700};
    const [a, b, c] = grid.children;
    a.rect = {left: 110, top: 110, width: 100, height: 100};
    b.rect = {left: 220, top: 300, width: 100, height: 100};
    c.rect = {left: 350, top: 500, width: 100, height: 100};
    const scrollBody = f.all().find(item => item.className === 'daki-test-target-gallery-body');
    grid.dispatch('pointerdown', {pointerType: 'mouse', button: 0, pointerId: 8, clientX: 120, clientY: 120, target: a.children[0]});
    grid.dispatch('pointermove', {pointerId: 8, clientX: 250, clientY: 210});
    assert.equal(f.cardSelected('style_a'), true);
    assert.equal(f.cardSelected('style_b'), false);
    grid.rect = {left: 100, top: -50, width: 500, height: 700};
    b.rect = {left: 220, top: 150, width: 100, height: 100};
    scrollBody.dispatch('scroll');
    assert.equal(f.cardSelected('style_b'), true);
    grid.dispatch('pointerup', {pointerId: 8});
    f.button('취소').onclick();
});
