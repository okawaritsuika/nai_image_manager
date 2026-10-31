const test = require('node:test');
const assert = require('node:assert/strict');
const Autocomplete = require('../static/prompt_autocomplete.js');

function token(value, caret) {
    return Autocomplete.findCurrentPromptToken(value, caret, caret);
}

test('replaces the complete comma-delimited token at the caret and preserves neighbors', () => {
    const value = '  first tag, red hai|r, last tag';
    const caret = value.indexOf('|');
    const result = Autocomplete.replaceCurrentPromptToken(value.replace('|', ''), 'blue_eyes', caret, caret);
    assert.equal(result.value, '  first tag, blue eyes, last tag');
    assert.equal(token('first, 빨간 머리, last', 11).query, '빨간 머리');
    assert.equal(Autocomplete.replaceCurrentPromptToken('first, 빨간 머리, last', 'blue_hair', 11).value,
        'first, blue hair, last');
});

test('preserves wrappers and literal parentheses in tags', () => {
    const cases = [
        ['{red hair}', 5, '{blue eyes}', 'red hair'],
        ['[red hair]', 5, '[blue eyes]', 'red hair'],
        ['{{[red hair]}}', 7, '{{[blue eyes]}}', 'red hair'],
        ['1.2::(red hair)::', 9, '1.2::(blue eyes)::', 'red hair'],
        ['-0.6::[red hair]::', 11, '-0.6::[blue eyes]::', 'red hair'],
        ['tag (qualifier)', 6, 'blue eyes', 'tag (qualifier)'],
        ['1.2::tag (qualifier)::', 8, '1.2::blue eyes::', 'tag (qualifier)']
    ];
    for (const [value, caret, expected, query] of cases) {
        assert.equal(token(value, caret).query, query, value);
        assert.equal(Autocomplete.replaceCurrentPromptToken(value, 'blue_eyes', caret).value, expected, value);
    }
    assert.equal(Autocomplete.replaceCurrentPromptToken('character', 'character_(series)', 4).value,
        'character (series)');
});

test('supports weighted comma groups, OR filters, and surrounding percent wildcards', () => {
    const weighted = 'before, 0.8::red hair, blue eyes::, after';
    const caret = weighted.indexOf('blue') + 2;
    assert.equal(token(weighted, caret).query, 'blue eyes');
    assert.equal(Autocomplete.replaceCurrentPromptToken(weighted, 'green_eyes', caret).value,
        'before, 0.8::red hair, green eyes::, after');

    const filter = 'red_hair || %blue eyes%';
    const filterCaret = filter.indexOf('blue') + 3;
    assert.equal(token(filter, filterCaret).query, 'blue eyes');
    assert.equal(Autocomplete.replaceCurrentPromptToken(filter, 'green_eyes', filterCaret).value,
        'red_hair || %green eyes%');
});

test('reads complete weighted tags at the closing delimiter and partial opening wrappers', () => {
    for (const value of ['-1::blue eyes::', '1.2::blue eyes, red hair::']) {
        assert.equal(token(value, value.length).query, value.includes(',') ? 'red hair' : 'blue eyes');
    }
    assert.equal(token('1.2::blu', 8).query, 'blu');
    assert.equal(token('{blu', 4).query, 'blu');
    assert.equal(Autocomplete.replaceCurrentPromptToken('1.2::blue eyes::', 'green_eyes', 16).value,
        '1.2::green eyes::');
});

test('handles a selection within one token, rejects delimiter-spanning selections, and respects maxLength', () => {
    const value = 'before, red hair, after';
    const result = Autocomplete.replaceCurrentPromptToken(value, 'blue_eyes', 10, 13);
    assert.equal(result.value, 'before, blue eyes, after');
    assert.equal(Autocomplete.replaceCurrentPromptToken(value, 'blue_eyes', 5, 12), null);
    assert.equal(Autocomplete.replaceCurrentPromptToken('red', 'blue_eyes', 3, 3, {maxLength: 6}), null);
});

test('adds comma-space only for a plain textarea end token', () => {
    assert.equal(Autocomplete.replaceCurrentPromptToken('red', 'blue_hair', 3, 3, {
        appendDelimiter: true, isTextarea: true
    }).value, 'blue hair, ');
    assert.equal(Autocomplete.replaceCurrentPromptToken('red', 'blue_hair', 3, 3, {
        appendDelimiter: true, isTextarea: false
    }).value, 'blue hair');
    assert.equal(Autocomplete.replaceCurrentPromptToken('1.2::(red)::', 'blue_hair', 8, 8, {
        appendDelimiter: true, isTextarea: true
    }).value, '1.2::(blue hair)::');
});

class FakeEvent {
    constructor(type, props = {}) {
        this.type = type;
        this.bubbles = props.bubbles !== false;
        this.defaultPrevented = false;
        Object.assign(this, props);
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.propagationStopped = true; }
}

class FakeTextNode {
    constructor(text, doc) { this.nodeType = 3; this.textContent = String(text); this.ownerDocument = doc; this.parentNode = null; }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
}

class FakeNode {
    constructor(tagName, doc = null) {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = doc;
        this.children = [];
        this.parentNode = null;
        this.attributes = {};
        this.listeners = {};
        this.style = {};
        this.hidden = false;
        this.disabled = false;
        this.readOnly = false;
        this.value = '';
        this.type = 'text';
        this.maxLength = -1;
        this.selectionStart = 0;
        this.selectionEnd = 0;
        this._text = '';
        this.className = '';
    }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get isConnected() { return this.ownerDocument?.documentElement?.contains(this) || false; }
    get id() { return this.attributes.id || ''; }
    set id(value) { this.setAttribute('id', value); }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value ?? ''); }
    appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        child.ownerDocument ||= this.ownerDocument;
        return child;
    }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    replaceChildren(...children) {
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
        this._text = '';
        this.append(...children);
    }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); }
    dispatchEvent(event) {
        event.target ||= this;
        const path = [this];
        let node = this.parentNode;
        while (node) { path.push(node); node = node.parentNode; }
        if (this.ownerDocument && !path.includes(this.ownerDocument)) path.push(this.ownerDocument);
        for (const current of path) {
            event.currentTarget = current;
            for (const callback of current.listeners?.[event.type] || []) callback(event);
            if (event.propagationStopped || !event.bubbles) break;
        }
        return !event.defaultPrevented;
    }
    closest(selector) {
        for (let node = this; node; node = node.parentElement) {
            if (selector === '[hidden], [inert]' && (node.hidden || node.inert || node.hasAttribute('inert'))) return node;
        }
        return null;
    }
    matches(selector) { return selector === ':popover-open' ? false : false; }
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; }
    getBoundingClientRect() { return {left: 20, right: 220, top: 20, bottom: 50, width: 200, height: 30}; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    scrollIntoView() {}
}

class FakeDocument {
    constructor() {
        this.nodeType = 9;
        this.listeners = {};
        this.documentElement = new FakeNode('html', this);
        this.body = new FakeNode('body', this);
        this.documentElement.appendChild(this.body);
        this.activeElement = this.body;
    }
    createElement(tagName) { return new FakeNode(tagName, this); }
    createTextNode(text) { return new FakeTextNode(text, this); }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); }
    dispatchEvent(event) {
        event.target ||= this;
        event.currentTarget = this;
        for (const callback of this.listeners[event.type] || []) callback(event);
        return !event.defaultPrevented;
    }
}

function fixture(fetch) {
    const doc = new FakeDocument();
    const winListeners = {};
    const timers = new Map();
    let nextTimer = 1;
    const win = {
        document: doc, innerWidth: 800, innerHeight: 600, Event: FakeEvent,
        getComputedStyle: () => ({display: 'block', visibility: 'visible'}),
        addEventListener(type, callback) { (winListeners[type] ||= []).push(callback); },
        removeEventListener(type, callback) { winListeners[type] = (winListeners[type] || []).filter(item => item !== callback); },
        run(type, event) { event.target ||= doc.activeElement; for (const callback of winListeners[type] || []) callback(event); },
        schedule(callback) { const id = nextTimer++; timers.set(id, callback); return id; },
        clear(id) { timers.delete(id); },
        flushTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }
    };
    const input = doc.createElement('textarea');
    input.setAttribute('data-prompt-autocomplete', '');
    doc.body.appendChild(input);
    const controller = Autocomplete.installPromptAutocomplete(doc, win, {
        fetch, debounceMs: 0, setTimeout: callback => win.schedule(callback), clearTimeout: id => win.clear(id)
    });
    function focus() {
        doc.activeElement = input;
        input.dispatchEvent(new FakeEvent('focusin'));
    }
    function change(value, caret = value.length) {
        input.value = value;
        input.setSelectionRange(caret, caret);
        input.dispatchEvent(new FakeEvent('input'));
    }
    return {doc, win, input, controller, focus, change};
}

const success = items => ({ok: true, async json() { return {status: 'success', items}; }});
const flushPromises = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('caret measurement falls back without layout metrics and removes a failing mirror', () => {
    const h = fixture(async () => success([]));
    const originalRect = h.input.getBoundingClientRect();
    assert.deepEqual(Autocomplete.measurePromptCaret(h.input, h.win, h.doc), originalRect);
    const originalChildren = h.doc.body.children.length;

    h.input.offsetWidth = 200;
    h.input.offsetHeight = 30;
    h.input.clientWidth = 198;
    h.input.clientHeight = 28;
    const createElement = h.doc.createElement.bind(h.doc);
    h.doc.createElement = tagName => {
        const element = createElement(tagName);
        if (tagName === 'span') element.getClientRects = () => { throw new Error('synthetic layout failure'); };
        return element;
    };
    assert.deepEqual(Autocomplete.measurePromptCaret(h.input, h.win, h.doc), originalRect);
    assert.equal(h.doc.body.children.length, originalChildren, 'the hidden mirror is removed after measurement fails');
    h.controller.dispose();
});

test('empty focus can type later; fetch sends only the current token and choices emit input/change', async () => {
    const calls = [];
    const h = fixture(async (url, options) => {
        calls.push({url, options});
        return success([{tag: 'blue_hair', ko: '파란 머리'}]);
    });
    h.focus();
    h.win.flushTimers();
    assert.equal(calls.length, 0);

    let inputEvents = 0, changeEvents = 0;
    h.input.addEventListener('input', () => { inputEvents += 1; });
    h.input.addEventListener('change', () => { changeEvents += 1; });
    h.change('first, red', 10);
    h.win.flushTimers();
    await flushPromises();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/prompt-tags/suggest?q=red&limit=12');
    assert.equal(h.input.getAttribute('aria-expanded'), 'true');
    inputEvents = 0;

    const key = new FakeEvent('keydown', {key: 'Enter'});
    h.win.run('keydown', key);
    assert.equal(key.defaultPrevented, true);
    assert.equal(h.input.value, 'first, blue hair, ');
    assert.equal(inputEvents, 1);
    assert.equal(changeEvents, 1);
    assert.equal(h.input.hasAttribute('aria-controls'), false);
    assert.equal(h.input.hasAttribute('aria-expanded'), false);
    h.controller.dispose();
});

test('Shift+Tab closes suggestions and preserves backward focus traversal', async () => {
    const h = fixture(async () => success([{tag: 'blue_hair'}]));
    h.focus();
    h.change('red', 3);
    h.win.flushTimers();
    await flushPromises();
    const event = new FakeEvent('keydown', {key: 'Tab', shiftKey: true});
    h.win.run('keydown', event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(h.input.value, 'red');
    assert.equal(h.input.hasAttribute('aria-expanded'), false);
    h.controller.dispose();
});

test('IME composition makes no request until compositionend', async () => {
    let calls = 0;
    const h = fixture(async () => { calls += 1; return success([{tag: 'red_hair'}]); });
    h.focus();
    h.change('빨간', 2);
    h.input.dispatchEvent(new FakeEvent('compositionstart'));
    h.win.flushTimers();
    await flushPromises();
    assert.equal(calls, 0);

    h.input.dispatchEvent(new FakeEvent('compositionend'));
    h.win.flushTimers();
    await flushPromises();
    assert.equal(calls, 1);
    h.controller.dispose();
});

test('does not send a long current token to the suggestion endpoint', () => {
    let calls = 0;
    const h = fixture(async () => { calls += 1; return success([]); });
    h.focus();
    h.change('x'.repeat(101), 101);
    h.win.flushTimers();
    assert.equal(calls, 0);
    h.controller.dispose();
});

test('late results are rejected after the caret moves, and failures show a concise status', async () => {
    let resolveRequest;
    const h = fixture(() => new Promise(resolve => { resolveRequest = resolve; }));
    h.focus();
    h.change('red hair', 8);
    h.win.flushTimers();
    await flushPromises();
    assert.equal(typeof resolveRequest, 'function');
    h.input.setSelectionRange(2, 2);
    h.doc.dispatchEvent(new FakeEvent('selectionchange'));
    resolveRequest(success([{tag: 'stale_result'}]));
    await flushPromises();
    assert.equal(h.input.getAttribute('aria-activedescendant'), null);
    h.controller.dispose();

    const failed = fixture(async () => ({ok: false, async json() { return {}; }}));
    failed.focus();
    failed.change('red', 3);
    failed.win.flushTimers();
    await flushPromises();
    const popup = failed.doc.body.children.find(child => child.className === 'prompt-autocomplete-popup');
    assert.equal(popup.children[0].textContent, '태그 추천을 불러오지 못했습니다.');
    failed.controller.dispose();
});
