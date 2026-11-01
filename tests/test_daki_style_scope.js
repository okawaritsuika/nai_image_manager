const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
    class Element {
        constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.value = ''; this.className = ''; }
        appendChild(child) { this.children.push(child); return child; }
        append(...children) { children.forEach(child => this.appendChild(child)); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        set textContent(value) { this.text = String(value); this.children = []; }
        get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
        descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
    }
    const win = {document: {createElement: tag => new Element(tag)}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../static/daki_style_scope.js'), 'utf8'), {window: win});
    return win.DakiStyleScope;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('model families use explicit values first and recognize canonical V5 and V4.5 names', () => {
    const scope = fixture();
    assert.equal(scope.modelFamily({model_family: 'v4_5', model: 'nai-diffusion-5-full'}), 'v4_5');
    assert.equal(scope.modelFamily({model: 'nai-diffusion-5-full'}), 'v5');
    assert.equal(scope.modelFamily({model: 'naid5f'}), 'v5');
    assert.equal(scope.modelFamily({model: 'naid5fake'}), 'other');
    assert.equal(scope.modelFamily({model: 'V5 Full'}), 'v5');
    assert.equal(scope.modelFamily({model: 'V5 Full Medium'}), 'v5');
    assert.equal(scope.modelFamily({model: 'NovelAI Diffusion V5 curated'}), 'v5');
    assert.equal(scope.modelFamily({model: 'nai-diffusion-4-5-full'}), 'v4_5');
    assert.equal(scope.modelFamily({model: 'NovelAI Diffusion V4.5'}), 'v4_5');
    assert.equal(scope.modelFamily({model: 'V4.5'}), 'v4_5');
    assert.equal(scope.modelFamily({model: 'unrecognized-model'}), 'other');
});

test('source and original-model filters compose, with missing source defaulting to existing shared', () => {
    const scope = fixture();
    const styles = [
        {id: 'naim-v5', model: 'nai-diffusion-5-full'},
        {id: 'naim-v45', source_library: 'naim', model_family: 'v4_5'},
        {id: 'artist-v5', source_library: 'artist', model: 'NovelAI Diffusion V5'},
        {id: 'artist-other', source_library: 'artist', model: 'other'},
        {id: 'personal', source_library: 'personal', model: 'nai-diffusion-5-full'},
    ];
    assert.deepEqual(scope.create({source: 'naim', model: 'v5'}).apply(styles).map(item => item.id), ['naim-v5']);
    assert.deepEqual(scope.create({source: 'artist', model: 'all'}).apply(styles).map(item => item.id), ['artist-v5', 'artist-other']);
    assert.deepEqual(scope.create({source: 'all', model: 'v4_5'}).apply(styles).map(item => item.id), ['naim-v45']);
    assert.deepEqual(scope.create({source: 'personal', model: 'v5'}).apply(styles).map(item => item.id), ['personal']);
});

test('scope controls do not notify during construction and personal source is fixed', () => {
    const scope = fixture();
    let changes = 0;
    const shared = scope.create({source: 'artist', model: 'v4_5', onChange: () => changes++});
    const sharedSelects = shared.element.descendants().filter(item => item.tagName === 'SELECT');
    assert.deepEqual(sharedSelects.map(item => item.name), ['daki_scope_source', 'daki_scope_model']);
    assert.equal(sharedSelects[0].children.find(item => item.value === 'artist').textContent, '그림체 관리 공유');
    assert.equal(sharedSelects[0].title, '그림체 관리 공유 그림체');
    assert.deepEqual(plain(shared.values()), {source: 'artist', model: 'v4_5'});
    assert.equal(changes, 0);
    sharedSelects[1].value = 'other'; sharedSelects[1].onchange();
    assert.deepEqual(plain(shared.values()), {source: 'artist', model: 'other'});
    assert.equal(changes, 1);
    sharedSelects[0].value = 'naim'; sharedSelects[0].onchange();
    assert.equal(sharedSelects[0].title, '기존 공유 그림체');
    assert.equal(changes, 2);

    const personal = scope.create({personal: true, model: 'v5'});
    assert.deepEqual(personal.element.descendants().filter(item => item.tagName === 'SELECT').map(item => item.name), ['daki_scope_model']);
    assert.deepEqual(plain(personal.values()), {source: 'personal', model: 'v5'});
});
