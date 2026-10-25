const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function fixture(text = '') {
    class Element {
        constructor(tag) {
            this.tagName = tag.toUpperCase(); this.className = ''; this.children = []; this.attributes = {};
            this.parentNode = null; this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false;
            this.selectionStart = 0; this.selectionEnd = 0;
        }
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
        append(...items) { items.forEach(item => this.appendChild(item)); }
        replaceChildren(...items) { this.children.forEach(item => { item.parentNode = null; }); this.children = []; this.append(...items); }
        remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
        setAttribute(key, value) { this.attributes[key] = String(value); }
        getAttribute(key) { return this.attributes[key] ?? null; }
        setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
        focus() { this.onfocus?.(); }
        get isConnected() { return !!this.parentNode?.isConnected; }
        get textContent() { return this._text || this.children.map(item => item.textContent).join(''); }
        set textContent(value) { this.replaceChildren(); this._text = String(value); }
        matches(selector) {
            if (selector === ':disabled') return this.disabled || !!this.parentNode?.matches(':disabled');
            if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
            return this.tagName === selector.toUpperCase();
        }
        descendants() { return this.children.flatMap(item => [item, ...item.descendants()]); }
        querySelectorAll(selector) {
            const choices = selector.split(',').map(item => item.trim());
            return this.descendants().filter(item => choices.some(choice => item.matches(choice)));
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }
    const document = {createElement: tag => new Element(tag)};
    const window = {document};
    const context = vm.createContext({window});
    vm.runInContext(fs.readFileSync(require.resolve('../static/daki_prompt_groups.js'), 'utf8'), context);
    const fieldset = document.createElement('fieldset'), panel = document.createElement('div');
    const wrapper = document.createElement('label'), input = document.createElement('textarea');
    input.value = text; input.setAttribute('aria-label', 'Base 프롬프트');
    document.body = document.createElement('body'); document.body.appendChild(fieldset); fieldset.appendChild(panel);
    panel.appendChild(wrapper); wrapper.appendChild(input);
    const changes = [], focuses = [];
    const controller = window.DakiPromptGroups.create({input, label: 'Base 프롬프트', onChange: () => changes.push(input.value), onFocus: item => focuses.push(item)});
    return {document, fieldset, panel, input, wrapper, controller, changes, focuses,
        name: () => controller.element.querySelector('.daki-prompt-group-name'),
        groupButton: () => controller.element.querySelector('.daki-prompt-group-create'),
        viewButton: () => controller.element.querySelector('.daki-prompt-group-view-toggle'),
        groups: () => controller.element.querySelectorAll('.daki-prompt-group'),
        segments: () => controller.element.querySelectorAll('.daki-prompt-text-segment'),
        summaries: () => controller.element.querySelectorAll('.daki-prompt-group-summary')};
}

test('selection creates an exact temporary group and identical text elsewhere stays separate', () => {
    const f = fixture('same, middle, same'), start = f.input.value.lastIndexOf('same');
    f.name().value = '마지막'; f.input.setSelectionRange(start, start + 4); f.groupButton().onclick();
    assert.equal(f.controller.flush(), 'same, middle, same');
    assert.deepEqual(f.summaries().map(item => item.textContent), ['마지막']);
    assert.equal(f.groups()[0].querySelector('textarea').value, 'same');
    assert.deepEqual(f.segments().map(item => item.value), ['same, middle, ', '']);
    assert.equal(f.wrapper.hidden, true);
});

test('empty, nested, and overlapping selections show feedback without changing prompt content', () => {
    const f = fixture('alpha, beta, gamma');
    f.groupButton().onclick();
    assert.match(f.controller.element.querySelector('.daki-prompt-groups-status').textContent, /범위를 먼저 선택/);
    f.input.setSelectionRange(7, 11); f.groupButton().onclick();
    const grouped = f.input.value;
    f.groups()[0].open = true;
    const inside = f.groups()[0].querySelector('textarea'); inside.focus(); inside.setSelectionRange(0, inside.value.length);
    f.groupButton().onclick();
    assert.equal(f.input.value, grouped);
    assert.match(f.controller.element.querySelector('.daki-prompt-groups-status').textContent, /기존 묶음 안에서는/);
    f.viewButton().onclick(); f.input.setSelectionRange(0, 11); f.groupButton().onclick();
    assert.equal(f.input.value, grouped);
    assert.equal(f.groups().length, 1);
    assert.match(f.controller.element.querySelector('.daki-prompt-groups-status').textContent, /겹치지 않는 텍스트/);
});

test('raw mode selection ignores stale segment focus and supports a second disjoint group', () => {
    const f = fixture('alpha, beta, gamma');
    f.input.setSelectionRange(7, 11); f.name().value = 'Beta'; f.groupButton().onclick();
    f.viewButton().onclick();
    const start = f.input.value.indexOf('gamma'); f.input.setSelectionRange(start, start + 5);
    f.name().value = 'Gamma'; f.groupButton().onclick();
    assert.equal(f.input.value, 'alpha, beta, gamma');
    assert.deepEqual(f.summaries().map(item => item.textContent), ['Beta', 'Gamma']);
});

test('multiple non-overlapping groups can be edited and ungrouped without changing surrounding bytes', () => {
    const f = fixture('A, B, C');
    f.name().value = 'B'; f.input.setSelectionRange(3, 4); f.groupButton().onclick();
    const tail = f.segments()[1]; tail.focus(); tail.setSelectionRange(2, 3);
    f.name().value = 'C'; f.groupButton().onclick();
    assert.equal(f.input.value, 'A, B, C');
    assert.deepEqual(f.summaries().map(item => item.textContent), ['B', 'C']);
    const first = f.groups()[0].querySelector('textarea'); first.value = '1.2::B::'; first.oninput();
    assert.equal(f.controller.flush(), 'A, 1.2::B::, C');
    f.groups()[1].querySelector('.daki-prompt-group-remove').onclick();
    assert.equal(f.controller.flush(), 'A, 1.2::B::, C');
    f.groups()[0].querySelector('.daki-prompt-group-remove').onclick();
    assert.equal(f.input.value, 'A, 1.2::B::, C');
    assert.equal(f.wrapper.hidden, false);
    assert.equal(f.controller.element.querySelectorAll('.daki-prompt-group').length, 0);
});

test('expanded text edits, direct writes, and reset retain the exact canonical string', () => {
    const f = fixture('1::ink::\n, soft lines');
    assert.equal(f.controller.groupPrefix('1::ink::', 'Style'), true);
    assert.equal(f.controller.flush(), '1::ink::\n, soft lines');
    assert.equal(f.groups()[0].open, false);
    f.groups()[0].open = true;
    const groupText = f.groups()[0].querySelector('textarea'); groupText.value = '1.1::ink::'; groupText.oninput();
    assert.equal(f.controller.flush(), '1.1::ink::\n, soft lines');
    const segment = f.segments()[1]; segment.value = ', soft lines, blue';
    assert.equal(f.controller.flush(), '1.1::ink::, soft lines, blue');
    f.input.value = 'external replacement';
    assert.equal(f.controller.flush(), 'external replacement');
    assert.equal(f.groups().length, 0); assert.equal(f.wrapper.hidden, false);
    assert.match(f.controller.element.querySelector('.daki-prompt-groups-status').textContent, /묶음을 해제했습니다/);
    f.input.setSelectionRange(9, 20); f.name().value = 'Replacement'; f.groupButton().onclick();
    assert.equal(f.controller.flush(), 'external replacement');
    assert.equal(f.summaries()[0].textContent, 'Replacement');
    f.controller.reset(); assert.equal(f.input.value, 'external replacement');
});

test('prefix folding requires an exact delimiter boundary and respects disabled fields and disposal', () => {
    const f = fixture('painted subject');
    assert.equal(f.controller.groupPrefix('paint', 'Style'), false);
    assert.equal(f.groups().length, 0);
    f.input.value = 'paint, subject'; f.controller.reset(); f.fieldset.disabled = true; f.controller.refresh();
    assert.equal(f.controller.groupPrefix('paint', 'Style'), true);
    const group = f.groups()[0];
    assert.equal(group.querySelector('textarea').disabled, true);
    assert.equal(group.querySelector('.daki-prompt-group-remove').disabled, true);
    assert.equal(f.groupButton().disabled, true); assert.equal(f.name().disabled, true);
    f.controller.dispose(); assert.equal(f.controller.element.isConnected, false);
});
