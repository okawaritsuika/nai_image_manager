const test = require('node:test');
const assert = require('node:assert/strict');
const CanvasStyleLink = require('../static/canvas_style_link.js');

const clone = (value) => JSON.parse(JSON.stringify(value));
const style = (overrides = {}) => ({
    id: 'shared-one',
    library: 'shared',
    name: 'Synthetic artist',
    positive: 'artist:sample, ink',
    negative: 'blurry, low quality',
    ...overrides,
});
const response = (styles, ok = true, message = '') => ({
    ok,
    async json() {
        return { status: ok ? 'success' : 'error', styles, message };
    },
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('selecting only whitespace inside a tag does not create a style range', () => {
    assert.equal(CanvasStyleLink.selectPromptRange('blue hair, ink', 4, 5), null);
});

class Element {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this.className = '';
        this.textContent = '';
        this.value = '';
        this.hidden = false;
        this.disabled = false;
        this.parentNode = null;
        this.scrollLeft = 0;
        this.scrollTop = 0;
        this.classList = {
            add: (value) => {
                const names = new Set(this.className.split(/\s+/).filter(Boolean));
                names.add(value);
                this.className = Array.from(names).join(' ');
            },
        };
    }
    appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    append(...children) {
        children.forEach((child) => this.appendChild(child));
    }
    replaceChildren(...children) {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = [];
        this.textContent = '';
        this.append(...children);
    }
    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
        }
        this.parentNode = null;
    }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }
    getAttribute(name) {
        return this.attributes[name] ?? null;
    }
    descendants() {
        return this.children.flatMap((child) => [child, ...child.descendants()]);
    }
    matches(selector) {
        if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
        return this.descendants().filter((child) => selector.split(',').some((item) => child.matches(item.trim())));
    }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
    focus() {
        this.focused = true;
    }
    getBoundingClientRect() {
        return this.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    setPointerCapture(pointerId) {
        this.capturedPointerId = pointerId;
    }
    releasePointerCapture(pointerId) {
        if (this.capturedPointerId === pointerId) this.capturedPointerId = null;
        this.releasedPointerId = pointerId;
    }
}

function domFixture() {
    const doc = { createElement: (tag) => new Element(tag) };
    doc.body = new Element('body');
    doc.getElementById = (id) => doc.body.descendants().find((item) => item.id === id) || null;
    const modal = new Element('div');
    modal.id = 'canvasStyleLinkModal';
    modal.style.display = 'none';
    const dialog = new Element('div');
    dialog.className = 'canvas-style-dialog';
    modal.appendChild(dialog);
    doc.body.appendChild(modal);
    return { doc, modal, dialog };
}

function deferredFetch() {
    const requests = [];
    const fetch = (url, options) => new Promise((resolve, reject) => {
        requests.push({ url, options, resolve, reject });
    });
    function reply(urlPart, styles, ok = true, message = '') {
        const index = requests.findIndex((item) => item.url.includes(urlPart));
        assert.notEqual(index, -1, 'Expected pending request for ' + urlPart);
        const [request] = requests.splice(index, 1);
        request.resolve(response(styles, ok, message));
        return request;
    }
    return { fetch, requests, reply };
}

async function openStyleReview(promptInfo, catalogStyle) {
    const pending = deferredFetch();
    const { doc, modal } = domFixture();
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    pending.reply('shared-styles', [catalogStyle]);
    pending.reply('personal-styles', []);
    await flush();
    const result = doc.body.querySelector('.canvas-style-link-item');
    assert.ok(result);
    result.onclick();
    return { controller, doc, modal, result };
}

function setElementRect(element, left, top, width, height) {
    element.rect = { left, top, right: left + width, bottom: top + height, width, height };
}

function setReviewGrid(doc, fieldId, left, top, width, height, positions) {
    const pane = doc.body.descendants().find((node) => node.className === 'canvas-style-link-review-pane');
    const surface = doc.body.descendants().find((node) => node.id === fieldId);
    setElementRect(pane, 0, 0, 600, 500);
    setElementRect(surface, left, top, width, height);
    surface.clientWidth = width;
    surface.clientHeight = height;
    const buttons = surface.children;
    positions.forEach(([x, y, buttonWidth = 50, buttonHeight = 24], index) => {
        if (buttons[index]) setElementRect(buttons[index], x, y, buttonWidth, buttonHeight);
    });
    return surface;
}

test('tokenKey follows canvas weight stripping and normalizes emphasis, case, spaces, and underscores', () => {
    assert.equal(CanvasStyleLink.tokenKey('2::[{Artist: Sample}]::'), 'artist:_sample');
    assert.equal(CanvasStyleLink.tokenKey(' artist__sample '), 'artist_sample');
    assert.equal(CanvasStyleLink.tokenKey('-0.5::INK::'), 'ink');
    assert.equal(CanvasStyleLink.tokenKey('{.5::INK::}'), 'ink');
    assert.equal(CanvasStyleLink.tokenKey('{1.25::[INK]::}'), 'ink');
    assert.equal(CanvasStyleLink.tokenKey('artist:1.2::ink'), 'artist:1.2::ink');
    assert.equal(CanvasStyleLink.tokenKey(''), '');
});

test('selectPromptRange selects whole overlapping comma tags and rejects whitespace, commas, carets, and invalid offsets', () => {
    const prompt = ',  solo, , 2::artist, ink  ,';
    const soloAt = prompt.indexOf('solo');
    assert.deepEqual(CanvasStyleLink.selectPromptRange(prompt, soloAt + 1, soloAt + 3), {
        text: 'solo', start: 0, end: 1, tokens: ['solo'],
    });
    const artistAt = prompt.indexOf('artist');
    assert.deepEqual(CanvasStyleLink.selectPromptRange(prompt, artistAt + 2, artistAt + 3), {
        text: '2::artist', start: 1, end: 2, tokens: ['2::artist'],
    });
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, prompt.indexOf(','), prompt.indexOf(',') + 1), null);
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, prompt.indexOf('  solo') + 1, prompt.indexOf('  solo') + 2), null);
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, 2, 2), null);
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, -1, 1), null);
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, 1, prompt.length + 1), null);
    assert.equal(CanvasStyleLink.selectPromptRange(prompt, '1', 2), null);
    assert.equal(CanvasStyleLink.selectPromptRange('x'.repeat(100001), 0, 1), null);
});

test('selectPromptRange excludes empty comma fields from saved logical indexes', () => {
    const prompt = ', solo, ,, ink,, ';
    const start = prompt.indexOf('ink') + 1;
    assert.deepEqual(CanvasStyleLink.selectPromptRange(prompt, start, start + 1), {
        text: 'ink', start: 1, end: 2, tokens: ['ink'],
    });
});

test('buildPromptSelection deduplicates valid indexes and stores source-order token occurrences', () => {
    assert.deepEqual(CanvasStyleLink.buildPromptSelection(
        '1.2::ink::, solo, {INK}, watercolor',
        [2, 0, 2, 1, 99, -1, 1.5]
    ), [
        { token: '1.2::ink::', occurrence: 0 },
        { token: 'solo', occurrence: 0 },
        { token: '{INK}', occurrence: 1 },
    ]);
    assert.deepEqual(CanvasStyleLink.buildPromptSelection('a, b', []), []);
    assert.deepEqual(CanvasStyleLink.buildPromptSelection('a, b', [10, -1]), []);
});

test('exact matching ignores order, weights, case, and wrappers but rejects substring and duplicate shortages', () => {
    const exact = style({ id: 'exact' });
    const duplicate = style({ id: 'duplicate', positive: 'solo, solo' });
    const substring = style({ id: 'substring', positive: 'artist:sample' });
    const result = CanvasStyleLink.matchStyles(
        [duplicate, exact],
        { basePrompt: '2::INK::, solo, {artist:sample}' }
    );
    assert.deepEqual(result.exact.map((item) => [item.style.id, item.matched, item.total]), [['exact', 2, 2]]);
    assert.deepEqual(result.candidates.map((item) => [item.style.id, item.matched, item.total]), [['duplicate', 1, 2]]);
    assert.equal(CanvasStyleLink.matchStyles([substring], { basePrompt: 'artist:samplepiece' }).exact.length, 0);
});

test('most-specific exact records sort first and equal specificity keeps deterministic library/id ordering', () => {
    const records = [
        style({ id: 'z', library: 'personal', positive: 'solo' }),
        style({ id: 'short', positive: 'solo' }),
        style({ id: 'long', positive: 'solo, ink' }),
        style({ id: 'a', library: 'shared', positive: 'solo' }),
    ];
    const result = CanvasStyleLink.matchStyles(records, { basePrompt: 'solo, ink' });
    assert.deepEqual(result.exact.map((item) => item.style.id), ['long', 'z', 'a', 'short']);
    assert.equal(result.candidates.length, 0);
    assert.deepEqual(CanvasStyleLink.matchStyles([style({ positive: '' })], { basePrompt: 'solo' }).exact, []);
});

test('controller auto-links one most-specific exact recipe and leaves a specificity tie for manual choice', async () => {
    const promptInfo = { basePrompt: 'solo, ink, artist', negativePrompt: '' };
    const uniquePending = deferredFetch();
    const unique = CanvasStyleLink.create({ fetch: uniquePending.fetch, getPrompt: () => promptInfo });
    unique.refresh({ load: true });
    uniquePending.reply('shared-styles', [
        style({ id: 'short', positive: 'solo' }),
        style({ id: 'specific', positive: 'solo, ink' }),
    ]);
    uniquePending.reply('personal-styles', []);
    await flush();
    assert.equal(unique.snapshot().style.id, 'specific');
    unique.dispose();

    const tiedPending = deferredFetch();
    const tied = CanvasStyleLink.create({ fetch: tiedPending.fetch, getPrompt: () => promptInfo });
    tied.refresh({ load: true });
    tiedPending.reply('shared-styles', [style({ id: 'specific-a', positive: 'solo, ink' })]);
    tiedPending.reply('personal-styles', [
        style({ id: 'specific-b', library: 'personal', positive: 'solo, ink' }),
    ]);
    await flush();
    assert.equal(tied.snapshot().style, null);
    assert.equal(tied.snapshot().mode, 'auto');
    tied.dispose();
});

test('partial candidates rank by positive recipe coverage and matched occurrence count', () => {
    const result = CanvasStyleLink.matchStyles([
        style({ id: 'coverage', positive: 'a, b, missing, absent' }),
        style({ id: 'count', positive: 'a, b, c, missing, absent' }),
        style({ id: 'no-overlap', positive: 'other' }),
    ], { basePrompt: 'a, b, c' });
    assert.deepEqual(result.candidates.map((item) => item.style.id), ['count', 'coverage']);
    assert.equal(result.candidates[0].coverage, 3 / 5);
    assert.equal(result.candidates[0].matched, 3);
});

test('groupParts folds only non-contiguous matched occurrences and expanded mode preserves original order', () => {
    const original = [
        { token: '2::artist:sample::', index: 0 },
        { token: 'solo', index: 1 },
        { token: 'ink', index: 2 },
        { token: 'solo', index: 3 },
    ];
    const collapsed = CanvasStyleLink.groupParts(style(), 'base', original, false);
    assert.deepEqual(collapsed.map((part) => part.type), ['style', 'token', 'token']);
    assert.deepEqual(collapsed[0], {
        type: 'style',
        name: 'Synthetic artist',
        tokens: ['2::artist:sample::', 'ink'],
        indexes: [0, 2],
        expanded: false,
    });
    assert.deepEqual(collapsed.slice(1).map((part) => [part.token, part.index]), [['solo', 1], ['solo', 3]]);

    const expanded = CanvasStyleLink.groupParts(style(), 'base', original, true);
    assert.deepEqual(expanded.map((part) => part.type), ['style', 'token', 'token', 'token', 'token']);
    assert.deepEqual(expanded.slice(1).map((part) => [part.token, part.index]), original.map((part) => [part.token, part.index]));
    assert.deepEqual(original.map((part) => [part.token, part.index]), [
        ['2::artist:sample::', 0], ['solo', 1], ['ink', 2], ['solo', 3],
    ]);
});

test('groupParts selects duplicate recipe occurrences by count and keeps base and negative fields isolated', () => {
    const current = style({ positive: 'solo, solo', negative: 'blurry, blurry' });
    const base = [{ token: 'solo', index: 0 }, { token: 'solo', index: 1 }, { token: 'solo', index: 2 }];
    assert.deepEqual(CanvasStyleLink.groupParts(current, 'base', base, false)[0].indexes, [0, 1]);
    assert.deepEqual(CanvasStyleLink.groupParts(current, 'negative', base, false).map((part) => part.type), ['token', 'token', 'token']);
    const negative = [{ token: 'blurry', index: 0 }, { token: 'noise', index: 1 }, { token: 'blurry', index: 2 }];
    assert.deepEqual(CanvasStyleLink.groupParts(current, 'negative', negative, false)[0].indexes, [0, 2]);
    assert.deepEqual(CanvasStyleLink.groupParts(current, 'character', base, false).map((part) => part.type), ['token', 'token', 'token']);
});

test('library selection groups only chosen token indexes and retains original recipe and prompt order', () => {
    const selected = style({
        positive: 'artist, subject, ink',
        selection: {
            base: [{ token: 'artist', occurrence: 0 }, { token: 'ink', occurrence: 0 }],
            negative: [],
        },
    });
    const original = [
        { token: '2::artist::', index: 0 },
        { token: 'solo', index: 1 },
        { token: '1.2::INK::', index: 2 },
        { token: 'watercolor', index: 3 },
    ];
    const before = clone(original);
    const parts = CanvasStyleLink.groupParts(selected, 'base', original, false);
    const marker = parts.find((part) => part.type === 'style');
    assert.deepEqual(marker.indexes, [0, 2]);
    assert.deepEqual(marker.tokens, ['2::artist::', '1.2::INK::']);
    assert.deepEqual(parts.filter((part) => part.type === 'token').map((part) => [part.token, part.index]), [
        ['solo', 1], ['watercolor', 3],
    ]);
    assert.equal(selected.positive, 'artist, subject, ink');
    assert.deepEqual(original, before);
});

test('library selection preserves duplicate occurrences and never substitutes a missing occurrence', () => {
    const selectedSecondInk = style({
        positive: 'ink',
        selection: { base: [{ token: 'ink', occurrence: 1 }], negative: [] },
    });
    const repeated = ['ink', 'solo', '2::INK::', 'watercolor'].map((token, index) => ({ token, index }));
    assert.deepEqual(
        CanvasStyleLink.groupParts(selectedSecondInk, 'base', repeated, false)
            .find((part) => part.type === 'style').indexes,
        [2]
    );
    const shifted = ['other', 'ink', 'solo', 'INK'].map((token, index) => ({ token, index }));
    assert.deepEqual(
        CanvasStyleLink.groupParts(selectedSecondInk, 'base', shifted, false)
            .find((part) => part.type === 'style').indexes,
        [3]
    );
    const missing = style({
        positive: 'ink',
        selection: { base: [{ token: 'ink', occurrence: 2 }], negative: [] },
    });
    assert.deepEqual(CanvasStyleLink.groupParts(missing, 'base', [
        { token: 'ink', index: 0 }, { token: 'ink', index: 1 },
    ], false).map((part) => part.type), ['token', 'token']);
});

test('library selection keeps base and negative occurrences isolated and expanded token order intact', () => {
    const selected = style({
        positive: 'artist, ink',
        negative: 'blurry',
        selection: {
            base: [{ token: 'ink', occurrence: 0 }],
            negative: [{ token: 'blurry', occurrence: 0 }],
        },
    });
    const base = [{ token: 'artist', index: 0 }, { token: 'ink', index: 1 }, { token: 'solo', index: 2 }];
    const negative = [{ token: 'noise', index: 0 }, { token: 'blurry', index: 1 }, { token: 'tail', index: 2 }];
    const baseMarker = CanvasStyleLink.groupParts(selected, 'base', base, false).find((part) => part.type === 'style');
    const negativeMarker = CanvasStyleLink.groupParts(selected, 'negative', negative, false).find((part) => part.type === 'style');
    assert.deepEqual(baseMarker.indexes, [1]);
    assert.deepEqual(negativeMarker.indexes, [1]);
    const expanded = CanvasStyleLink.groupParts(selected, 'base', base, true);
    assert.deepEqual(expanded.filter((part) => part.type === 'token').map((part) => [part.token, part.index]),
        base.map((part) => [part.token, part.index]));
    assert.equal(expanded[1].expanded, true);
});

test('custom snapshots validate range starts and deep-clone their saved selection position', () => {
    const custom = {
        id: 'canvas-custom', library: 'custom', name: 'Pinned section',
        positive: 'solo, ink', negative: '', rangeStarts: { base: 2, negative: null },
    };
    assert.deepEqual(CanvasStyleLink.normalizeState({ mode: 'manual', style: custom }).style, custom);
    assert.equal(CanvasStyleLink.normalizeState({ mode: 'manual', style: { ...custom, rangeStarts: { base: null, negative: null } } }).style, null);
    assert.equal(CanvasStyleLink.normalizeState({ mode: 'manual', style: { ...custom, rangeStarts: { base: 0, negative: 0 } } }).style, null);
    assert.equal(CanvasStyleLink.normalizeState({ mode: 'manual', style: { ...custom, positive: '', rangeStarts: { base: null, negative: null } } }).style, null);

    const controller = CanvasStyleLink.create({ getPrompt: () => ({ basePrompt: 'solo, ink, solo, ink' }) });
    controller.restore({ mode: 'manual', style: custom });
    const detached = controller.snapshot();
    detached.style.rangeStarts.base = 0;
    assert.equal(controller.snapshot().style.rangeStarts.base, 2);
    controller.dispose();
});

test('custom grouping honors the saved duplicate occurrence and only falls back to one unique contiguous range', () => {
    const custom = {
        id: 'canvas-custom', library: 'custom', name: 'Pinned section',
        positive: 'solo, ink', negative: '', rangeStarts: { base: 2, negative: null },
    };
    const repeated = ['solo', 'ink', 'solo', 'ink'].map((token, index) => ({ token, index }));
    const repeatedParts = CanvasStyleLink.groupParts(custom, 'base', repeated, false);
    assert.deepEqual(repeatedParts.find((part) => part.type === 'style').indexes, [2, 3]);

    const shifted = ['other', 'solo', 'ink', 'tail'].map((token, index) => ({ token, index }));
    const fallback = CanvasStyleLink.groupParts(custom, 'base', shifted, false);
    assert.deepEqual(fallback[1].indexes, [1, 2]);
    assert.equal(fallback[0].type, 'token');

    const ambiguous = ['solo', 'ink', 'other', 'solo', 'ink'].map((token, index) => ({ token, index }));
    assert.deepEqual(CanvasStyleLink.groupParts(custom, 'base', ambiguous, false),
        ambiguous.map((item) => ({ type: 'token', ...item })));
});

test('custom negative-only recipes group only negative tokens and preserve weighted raw strings and order', () => {
    const custom = {
        id: 'canvas-custom', library: 'custom', name: 'Negatives',
        positive: '', negative: 'blurry, ugly', rangeStarts: { base: null, negative: 1 },
    };
    const base = [{ token: 'blurry', index: 0 }, { token: 'ugly', index: 1 }];
    assert.deepEqual(CanvasStyleLink.groupParts(custom, 'base', base, false),
        base.map((item) => ({ type: 'token', ...item })));
    const negative = [
        { token: 'solo', index: 0 },
        { token: '1.2::blurry::', index: 1 },
        { token: '2::UGLY::', index: 2 },
        { token: 'tail', index: 3 },
    ];
    const collapsed = CanvasStyleLink.groupParts(custom, 'negative', negative, false);
    assert.deepEqual(collapsed[1], {
        type: 'style', name: 'Negatives', tokens: ['1.2::blurry::', '2::UGLY::'], indexes: [1, 2], expanded: false,
    });
    const expanded = CanvasStyleLink.groupParts(custom, 'negative', negative, true);
    assert.deepEqual(expanded.filter((part) => part.type === 'token').map((part) => [part.token, part.index]),
        negative.map((item) => [item.token, item.index]));
    assert.deepEqual(negative.map((item) => item.token), ['solo', '1.2::blurry::', '2::UGLY::', 'tail']);
});

test('normalizeState defaults legacy data, validates style fields, and returns detached snapshots', () => {
    assert.deepEqual(CanvasStyleLink.normalizeState(null), {
        mode: 'auto', style: null, expanded: { base: false, negative: false },
    });
    const accepted = CanvasStyleLink.normalizeState({
        mode: 'manual',
        style: style(),
        expanded: { base: true, negative: 'true' },
    });
    assert.deepEqual(accepted.expanded, { base: true, negative: false });
    assert.deepEqual(accepted.style, style());
    assert.equal(CanvasStyleLink.normalizeState({ mode: 'manual', style: { ...style(), id: '' } }).style, null);
    assert.equal(CanvasStyleLink.normalizeState({ mode: 'off', style: style() }).style, null);

    let promptInfo = { basePrompt: 'artist:sample, ink', negativePrompt: '' };
    const changes = [];
    const controller = CanvasStyleLink.create({
        getPrompt: () => promptInfo,
        onChange: (value) => changes.push(value),
    });
    controller.restore(accepted);
    const first = controller.snapshot();
    first.style.name = 'mutated';
    first.expanded.base = false;
    assert.equal(controller.snapshot().style.name, 'Synthetic artist');
    assert.equal(controller.snapshot().expanded.base, true);
    assert.equal(changes.length, 0);
    controller.dispose();
});

test('library selection snapshots validate both fields and deep-clone legacy-compatible state', () => {
    const valid = {
        base: [{ token: '2::ink::', occurrence: 1 }],
        negative: [{ token: 'blurry', occurrence: 0 }],
    };
    const normalized = CanvasStyleLink.normalizeState({ mode: 'manual', style: style({ selection: valid }) });
    assert.deepEqual(normalized.style.selection, valid);
    assert.deepEqual(CanvasStyleLink.normalizeState({ mode: 'manual', style: style() }).style, style());
    const invalidSelections = [
        null,
        { base: [], negative: [] },
        { base: [{ token: '', occurrence: 0 }], negative: [] },
        { base: [{ token: ' ink ', occurrence: 0 }], negative: [] },
        { base: [{ token: 'a,b', occurrence: 0 }], negative: [] },
        { base: [{ token: 'ink', occurrence: -1 }], negative: [] },
        { base: [{ token: 'ink', occurrence: Number.MAX_SAFE_INTEGER + 1 }], negative: [] },
        { base: [{ token: 'ink', occurrence: 0 }, { token: 'INK', occurrence: 0 }], negative: [] },
        { base: [{ token: 'x'.repeat(100001), occurrence: 0 }], negative: [] },
        { base: [
            { token: 'a'.repeat(60000), occurrence: 0 },
            { token: 'b'.repeat(60000), occurrence: 0 },
        ], negative: [] },
        { base: [{ token: 'ink', occurrence: 0 }] },
    ];
    invalidSelections.forEach((selection) => {
        assert.equal(CanvasStyleLink.normalizeState({ mode: 'manual', style: style({ selection }) }).style, null);
    });

    const controller = CanvasStyleLink.create();
    controller.restore({ mode: 'manual', style: style({ selection: valid }) });
    const detached = controller.snapshot();
    detached.style.selection.base[0].token = 'mutated';
    detached.style.selection.negative.push({ token: 'noise', occurrence: 0 });
    assert.deepEqual(controller.snapshot().style.selection, valid);
    controller.dispose();
});

test('delayed catalog load cannot replace a manual restore and recomputes against the latest prompt', async () => {
    const pending = deferredFetch();
    let promptInfo = { basePrompt: 'old, recipe', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.refresh({ load: true });
    assert.equal(pending.requests.length, 2);
    const manual = style({ id: 'saved', library: 'personal', name: 'Saved manual', positive: 'old, recipe' });
    controller.restore({ mode: 'manual', style: manual });
    promptInfo = { basePrompt: 'new, recipe', negativePrompt: '' };
    controller.refresh();
    pending.reply('shared-styles', [style({ positive: 'new, recipe' })]);
    pending.reply('personal-styles', [style({ id: 'saved', library: 'personal', name: 'Saved manual' })]);
    await flush();
    assert.equal(controller.snapshot().mode, 'manual');
    assert.equal(controller.snapshot().style.name, 'Saved manual');
    controller.dispose();

    const nextPending = deferredFetch();
    let latestPrompt = { basePrompt: 'first', negativePrompt: '' };
    const automatic = CanvasStyleLink.create({ fetch: nextPending.fetch, getPrompt: () => latestPrompt });
    automatic.refresh({ load: true });
    latestPrompt = { basePrompt: 'latest, ink', negativePrompt: '' };
    automatic.refresh();
    nextPending.reply('shared-styles', [style({ id: 'latest', positive: 'latest, ink' })]);
    nextPending.reply('personal-styles', []);
    await flush();
    assert.equal(automatic.snapshot().style.id, 'latest');
    automatic.dispose();
});

test('catalog requests deduplicate, failures require explicit retry, and retry preserves a successful library', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    let promptInfo = { basePrompt: 'artist:sample, ink', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    const host = new Element('div');
    doc.body.appendChild(host);
    controller.mount(host);
    controller.openPicker();
    controller.refresh({ load: true });
    controller.refresh({ load: true });
    assert.equal(pending.requests.length, 2);
    pending.reply('shared-styles', [style()]);
    pending.reply('personal-styles', [], false, 'Synthetic offline');
    await flush();
    assert.equal(controller.snapshot().style, null, 'one successful library cannot auto-link');
    const status = doc.body.querySelector('.canvas-style-link-modal-status');
    assert.match(status.textContent, /Synthetic offline/);

    const retry = doc.body.querySelectorAll('button').find((button) => button.textContent === '다시 불러오기');
    assert.ok(retry && !retry.hidden);
    retry.onclick();
    assert.equal(pending.requests.length, 2);
    pending.reply('shared-styles', [style()]);
    pending.reply('personal-styles', []);
    await flush();
    assert.equal(controller.snapshot().style.name, 'Synthetic artist');
    controller.dispose();
});

test('prompt changes invalidate an auto result even when the next library load fails', async () => {
    const pending = deferredFetch();
    let promptInfo = { basePrompt: 'artist:sample, ink', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'auto', style: style() });
    controller.refresh({ load: true });
    assert.equal(controller.snapshot().style.name, 'Synthetic artist');

    promptInfo = { basePrompt: 'different prompt', negativePrompt: '' };
    controller.refresh();
    assert.equal(controller.snapshot().style, null);
    pending.reply('shared-styles', [], false, 'Synthetic failure');
    pending.reply('personal-styles', [], false, 'Synthetic failure');
    await flush();
    assert.equal(controller.snapshot().style, null);
    controller.dispose();
});

test('dispose aborts in-flight requests and ignores late settlement and repaint', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    let renders = 0;
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => ({ basePrompt: 'artist:sample, ink', negativePrompt: '' }),
        onRender: () => { renders += 1; },
    });
    controller.refresh({ load: true });
    const signals = pending.requests.map((request) => request.options.signal);
    assert.equal(signals.length, 2);
    controller.dispose();
    assert.ok(signals.every((signal) => signal.aborted));
    const countAfterDispose = renders;
    pending.reply('shared-styles', [style()]);
    pending.reply('personal-styles', []);
    await flush();
    assert.equal(renders, countAfterDispose);
});

test('manual picker opens a comparison draft and only applies the user-selected area', async () => {
    const pending = deferredFetch();
    const { doc, modal } = domFixture();
    const host = new Element('div');
    doc.body.appendChild(host);
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => ({ basePrompt: 'artist:sample, ink', negativePrompt: '' }),
    });
    controller.mount(host);
    controller.openPicker();
    assert.equal(modal.style.display, 'flex');
    assert.equal(pending.requests.length, 2);
    const item = style({ id: 'unsafe', name: '<img src=x onerror=bad()>', positive: 'artist:sample, absent' });
    pending.reply('shared-styles', [item]);
    pending.reply('personal-styles', []);
    await flush();
    const result = doc.body.querySelectorAll('.canvas-style-link-item')[0];
    assert.ok(result);
    assert.equal(result.querySelector('.canvas-style-link-item-name').textContent, item.name);
    assert.equal(result.querySelector('img'), null);
    assert.equal(result.querySelector('.canvas-style-link-thumbnail-placeholder').textContent, '미리보기 없음');
    assert.equal(result.getAttribute('aria-pressed'), 'false');
    assert.equal(result.getAttribute('aria-label'), item.name + ' 비교');
    const before = controller.snapshot();
    result.onclick();
    assert.deepEqual(controller.snapshot(), before, 'opening a review does not commit the catalog style');
    assert.equal(modal.style.display, 'flex');
    const heading = doc.body.descendants().find((node) => node.className === 'canvas-style-review-heading');
    assert.equal(heading.textContent, item.name);
    const baseContainer = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    assert.equal(baseContainer.getAttribute('aria-label'), '기본 프롬프트 비교 영역');
    assert.deepEqual(baseContainer.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'false']);
    baseContainer.children[0].onclick();
    baseContainer.children[1].onclick();
    assert.deepEqual(controller.snapshot(), before, 'changing the draft does not persist before apply');
    const apply = doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정');
    assert.equal(apply.disabled, false);
    apply.onclick();
    assert.equal(controller.snapshot().mode, 'manual');
    assert.equal(controller.snapshot().style.name, item.name);
    assert.equal(controller.snapshot().style.positive, item.positive, 'the catalog recipe stays unchanged');
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [{ token: 'ink', occurrence: 0 }], negative: [],
    });
    assert.equal(modal.style.display, 'none');
    const detached = controller.snapshot();
    detached.style.name = 'changed';
    assert.equal(controller.snapshot().style.name, item.name);
    controller.dispose();
});

test('comparison draft toggles matches and adds Shift-click ranges without persisting before apply', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const promptInfo = { basePrompt: 'artist, subject, ink, ink, solo', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    const catalogStyle = style({ positive: 'artist, ink', negative: '' });
    pending.reply('shared-styles', [catalogStyle]);
    pending.reply('personal-styles', []);
    await flush();
    doc.body.querySelector('.canvas-style-link-item').onclick();
    const originalState = controller.snapshot();
    const field = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    assert.match(doc.body.querySelector('.canvas-style-review-count').textContent, /일치 2\/2 · 선택 2개/);
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'true', 'false', 'false']);
    field.children[0].onclick();
    field.children[1].onclick();
    field.children[4].onclick({ shiftKey: true });
    field.children[3].onclick();
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['false', 'true', 'true', 'false', 'true']);
    assert.deepEqual(controller.snapshot(), originalState);
    doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').onclick();
    assert.equal(controller.snapshot().style.positive, 'artist, ink');
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [
            { token: 'subject', occurrence: 0 },
            { token: 'ink', occurrence: 0 },
            { token: 'solo', occurrence: 0 },
        ],
        negative: [],
    });
    const marker = controller.groupParts('base', promptInfo.basePrompt.split(',').map((token, index) => ({ token: token.trim(), index })))
        .find((part) => part.type === 'style');
    assert.deepEqual(marker.indexes, [1, 2, 4]);
    assert.deepEqual(promptInfo, { basePrompt: 'artist, subject, ink, ink, solo', negativePrompt: '' });
    controller.dispose();
});

test('rectangle drag selects only overlapping grid tokens, preserves initial tags, and suppresses the generated click', async () => {
    const promptInfo = { basePrompt: 'a, b, c, d, e, f, g', negativePrompt: '' };
    const { controller, doc } = await openStyleReview(promptInfo, style({ positive: 'a', negative: '' }));
    const field = setReviewGrid(doc, 'canvasStyleReviewBaseTokens', 10, 10, 300, 100, [
        [20, 20], [100, 20], [180, 20],
        [20, 60], [100, 60], [180, 60], [320, 60],
    ]);
    const box = doc.getElementById('canvasStyleReviewSelectionBox');
    const before = controller.snapshot();
    const startButton = field.children[5];
    field.onpointerdown({ target: startButton, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 41, clientX: 205, clientY: 70 });
    assert.equal(startButton.capturedPointerId, 41, 'a token start captures on that button');
    field.onpointermove({ pointerId: 41, clientX: 225, clientY: 30 });
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'true', 'false', 'false', 'true', 'false']);
    assert.equal(box.hidden, false);
    field.onpointermove({ pointerId: 41, clientX: 225, clientY: 50 });
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'false', 'false', 'false', 'true', 'false'], 'shrinking the rectangle drops old hits');
    field.onpointermove({ pointerId: 41, clientX: 225, clientY: 30 });
    field.onpointerup({ pointerId: 41, clientX: 225, clientY: 30 });
    assert.equal(startButton.releasedPointerId, 41);
    assert.equal(box.hidden, true);
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'true', 'false', 'false', 'true', 'false'],
        'only the right column overlaps; the clipped seventh token is excluded');
    field.children[2].onclick({ detail: 1, pointerId: 41 });
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'true', 'false', 'false', 'true', 'false'], 'the drag-generated click does not toggle');
    assert.deepEqual(controller.snapshot(), before, 'dragging remains an uncommitted draft');

    const ordinaryButton = field.children[3];
    field.onpointerdown({ target: ordinaryButton, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 42, clientX: 45, clientY: 70 });
    field.onpointerup({ pointerId: 42, clientX: 45, clientY: 70 });
    ordinaryButton.onclick({ detail: 1, pointerId: 42 });
    assert.equal(ordinaryButton.getAttribute('aria-pressed'), 'true', 'a single mouse click still toggles');
    ordinaryButton.onclick({ detail: 0, pointerId: 42 });
    assert.equal(ordinaryButton.getAttribute('aria-pressed'), 'false', 'keyboard clicks keep their normal behavior');
    ordinaryButton.onclick();
    assert.equal(ordinaryButton.getAttribute('aria-pressed'), 'true', 'legacy synthetic clicks still work');
    ordinaryButton.onclick();

    doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').onclick();
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [
            { token: 'a', occurrence: 0 },
            { token: 'c', occurrence: 0 },
            { token: 'f', occurrence: 0 },
        ],
        negative: [],
    });
    assert.deepEqual(promptInfo, { basePrompt: 'a, b, c, d, e, f, g', negativePrompt: '' });
    controller.dispose();
});

test('empty-space rectangle drag clips to the visible pane and follows token-surface scrolling', async () => {
    const promptInfo = { basePrompt: 'a, b, c, d, e, f, g', negativePrompt: '' };
    const { controller, doc } = await openStyleReview(promptInfo, style({ positive: 'a', negative: '' }));
    const field = setReviewGrid(doc, 'canvasStyleReviewBaseTokens', 10, 10, 300, 100, [
        [20, 20], [100, 20], [180, 20],
        [20, 60], [100, 60], [180, 60], [320, 60],
    ]);
    const pane = doc.body.descendants().find((node) => node.className === 'canvas-style-link-review-pane');
    const box = doc.getElementById('canvasStyleReviewSelectionBox');
    const before = controller.snapshot();
    field.onpointerdown({ target: field, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 61, clientX: 90, clientY: 45 });
    assert.equal(field.capturedPointerId, 61, 'a blank-space start captures on the surface');
    field.onpointermove({ pointerId: 61, clientX: 340, clientY: 75 });
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')),
        ['true', 'false', 'false', 'false', 'true', 'true', 'false']);
    assert.equal(box.style.left, '90px');
    assert.equal(box.style.width, '220px', 'the surface right edge clips the marquee');

    field.clientWidth = 400;
    setElementRect(field, 10, 10, 400, 100);
    setElementRect(pane, 0, 0, 280, 500);
    field.onpointermove({ pointerId: 61, clientX: 340, clientY: 75 });
    assert.equal(box.style.width, '190px', 'the review pane also clips the visible marquee');
    assert.equal(field.children[6].getAttribute('aria-pressed'), 'false');

    setElementRect(pane, 0, 0, 600, 500);
    field.scrollLeft = 30;
    field.children.forEach((button) => {
        if (!button.rect) return;
        setElementRect(button, button.rect.left - 30, button.rect.top, button.rect.width, button.rect.height);
    });
    field.onscroll();
    assert.equal(box.style.left, '60px', 'scrolling keeps the origin attached to its content position');
    assert.equal(field.children[6].getAttribute('aria-pressed'), 'true', 'a newly visible token enters the rectangle');
    field.onpointerup({ pointerId: 61, clientX: 340, clientY: 75 });
    assert.equal(box.hidden, true);
    assert.deepEqual(controller.snapshot(), before);
    controller.closePicker();
    controller.dispose();
});

test('review rectangle drag isolates fields, ignores other pointers, restores on cancel, and releases on close', async () => {
    const promptInfo = { basePrompt: 'solo, other, ink', negativePrompt: 'bad, blurry' };
    const { controller, doc, modal } = await openStyleReview(promptInfo, style({
        positive: 'solo, ink', negative: 'blurry',
    }));
    const base = setReviewGrid(doc, 'canvasStyleReviewBaseTokens', 10, 10, 300, 100, [
        [20, 20], [100, 20], [180, 20],
    ]);
    const negative = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewNegativeTokens');
    setElementRect(negative, 10, 130, 300, 80);
    negative.clientWidth = 300;
    negative.clientHeight = 80;
    setElementRect(negative.children[0], 20, 140, 50, 24);
    setElementRect(negative.children[1], 100, 140, 50, 24);
    const before = controller.snapshot();
    const startButton = base.children[1];

    base.onpointerdown({ target: startButton, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 50, clientX: 110, clientY: 30 });
    base.onpointermove({ pointerId: 50, clientX: 120, clientY: 150 });
    assert.deepEqual(base.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'true', 'true']);
    assert.deepEqual(negative.children.map((button) => button.getAttribute('aria-pressed')), ['false', 'true'],
        'a base drag never inspects or changes negative tokens');
    base.onlostpointercapture({ pointerId: 50 });
    assert.deepEqual(base.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'false', 'true']);

    base.onpointerdown({ target: base, button: 2, isPrimary: true, pointerType: 'mouse', pointerId: 51, clientX: 100, clientY: 30 });
    base.onpointermove({ pointerId: 51, clientX: 180, clientY: 30 });
    base.onpointerdown({ target: base, button: 0, isPrimary: true, pointerType: 'touch', pointerId: 52, clientX: 100, clientY: 30 });
    base.onpointermove({ pointerId: 52, clientX: 180, clientY: 30 });
    assert.deepEqual(base.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'false', 'true'],
        'right buttons and touch pointers do not start a drag');

    base.onpointerdown({ target: startButton, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 54, clientX: 110, clientY: 30 });
    base.onpointerdown({ target: base, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 55, clientX: 160, clientY: 50 });
    base.onpointermove({ pointerId: 55, clientX: 180, clientY: 30 });
    base.onpointermove({ pointerId: 54, clientX: 180, clientY: 30 });
    assert.deepEqual(base.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'true', 'true']);
    base.onpointercancel({ pointerId: 54 });
    assert.deepEqual(base.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'false', 'true']);

    base.onpointerdown({ target: startButton, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 53, clientX: 110, clientY: 30 });
    base.onpointermove({ pointerId: 53, clientX: 180, clientY: 30 });
    const box = doc.getElementById('canvasStyleReviewSelectionBox');
    assert.equal(box.hidden, false);
    controller.closePicker();
    assert.equal(modal.style.display, 'none');
    assert.equal(startButton.releasedPointerId, 53);
    assert.equal(box.hidden, true);
    base.onpointermove({ pointerId: 53, clientX: 20, clientY: 30 });
    assert.deepEqual(controller.snapshot(), before);
    controller.dispose();
});

test('comparison permits direct selection when there is no catalog overlap and applies negative-only selection', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const promptInfo = { basePrompt: 'solo, watercolor', negativePrompt: 'bad, blurry' };
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    pending.reply('shared-styles', [style({ positive: 'artist', negative: 'blurry' })]);
    pending.reply('personal-styles', []);
    await flush();
    doc.body.querySelector('.canvas-style-link-item').onclick();
    const base = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    const negative = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewNegativeTokens');
    assert.equal(doc.body.querySelector('.canvas-style-review-no-match').hidden, false);
    assert.equal(base.children[0].getAttribute('aria-pressed'), 'false');
    assert.equal(negative.children[1].getAttribute('aria-pressed'), 'true');
    doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').onclick();
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [],
        negative: [{ token: 'blurry', occurrence: 0 }],
    });
    assert.equal(controller.snapshot().style.positive, 'artist');
    assert.equal(controller.snapshot().style.negative, 'blurry');
    controller.dispose();
});

test('review allows a manual token choice when catalog tags do not overlap', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => ({ basePrompt: 'solo, watercolor', negativePrompt: '' }),
    });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    pending.reply('shared-styles', [style({ positive: 'artist', negative: '' })]);
    pending.reply('personal-styles', []);
    await flush();
    doc.body.querySelector('.canvas-style-link-item').onclick();
    const base = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    const before = controller.snapshot();
    base.children[1].onclick();
    assert.deepEqual(controller.snapshot(), before);
    assert.equal(doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').disabled, false);
    doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').onclick();
    assert.equal(controller.snapshot().style.positive, 'artist');
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [{ token: 'watercolor', occurrence: 0 }], negative: [],
    });
    controller.dispose();
});

test('review apply rejects stale prompt source and closing the review discards only its draft', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    let promptInfo = { basePrompt: 'artist, solo', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    pending.reply('shared-styles', [style({ positive: 'artist' })]);
    pending.reply('personal-styles', []);
    await flush();
    const result = doc.body.querySelector('.canvas-style-link-item');
    const before = controller.snapshot();
    result.onclick();
    const originalTokens = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    originalTokens.children[1].onclick();
    assert.deepEqual(controller.snapshot(), before);
    promptInfo = { basePrompt: 'changed, source', negativePrompt: '' };
    doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정').onclick();
    assert.deepEqual(controller.snapshot(), before);
    assert.match(doc.body.querySelector('.canvas-style-link-review-error').textContent, /프롬프트가 변경되었습니다/);
    doc.body.querySelectorAll('button').find((button) => button.textContent === '다른 그림체 선택').onclick();
    assert.equal(doc.body.descendants().find((node) => node.id === 'canvasStyleLinkGalleryPane').hidden, false);
    assert.equal(doc.body.querySelectorAll('.canvas-style-review-token').length, 0);
    controller.dispose();
});

test('reopening the same catalog style restores the selected duplicate occurrence from state', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const promptInfo = { basePrompt: 'ink, solo, 1.2::INK::', negativePrompt: '' };
    const saved = style({ positive: 'ink', selection: {
        base: [{ token: 'INK', occurrence: 1 }], negative: [],
    } });
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.restore({ mode: 'manual', style: saved });
    controller.openPicker();
    pending.reply('shared-styles', [style({ positive: 'ink' })]);
    pending.reply('personal-styles', []);
    await flush();
    doc.body.querySelector('.canvas-style-link-item').onclick();
    const field = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')), ['false', 'false', 'true']);
    assert.deepEqual(controller.snapshot().style.selection, {
        base: [{ token: 'INK', occurrence: 1 }], negative: [],
    });
    controller.closePicker();
    assert.deepEqual(controller.snapshot().style.selection.base, [{ token: 'INK', occurrence: 1 }]);
    controller.dispose();
});

test('catalog retry arriving during review does not replace its snapshot or selection draft', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => ({ basePrompt: 'artist, solo', negativePrompt: '' }),
    });
    controller.restore({ mode: 'off' });
    controller.openPicker();
    pending.reply('shared-styles', [style({ id: 'review', name: 'Captured name', positive: 'artist' })]);
    pending.reply('personal-styles', []);
    await flush();
    doc.body.querySelector('.canvas-style-link-item').onclick();
    const token = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens').children[1];
    token.onclick();
    const retry = doc.body.querySelectorAll('button').find((button) => button.textContent === '다시 불러오기');
    retry.onclick();
    assert.equal(pending.requests.length, 2);
    pending.reply('shared-styles', [style({ id: 'review', name: 'Updated catalog name', positive: 'solo' })]);
    pending.reply('personal-styles', []);
    await flush();
    assert.equal(doc.body.querySelector('.canvas-style-review-heading').textContent, 'Captured name');
    const field = doc.body.descendants().find((node) => node.id === 'canvasStyleReviewBaseTokens');
    assert.deepEqual(field.children.map((button) => button.getAttribute('aria-pressed')), ['true', 'true']);
    assert.equal(controller.snapshot().mode, 'off');
    controller.dispose();
});

test('opening and cancelling the picker preserves auto, off, and manual snapshots', async () => {
    const examples = [
        { mode: 'auto', style: style() },
        { mode: 'off', style: null },
        { mode: 'manual', style: style({ id: 'saved-manual', library: 'personal' }) },
    ];
    for (const value of examples) {
        const pending = deferredFetch();
        const { doc, modal } = domFixture();
        const controller = CanvasStyleLink.create({
            document: doc,
            fetch: pending.fetch,
            getPrompt: () => ({ basePrompt: 'artist:sample, ink', negativePrompt: '' }),
        });
        controller.restore(value);
        controller.refresh();
        const before = controller.snapshot();
        assert.equal(controller.openPicker(), true);
        assert.equal(modal.style.display, 'flex');
        controller.closePicker();
        assert.deepEqual(controller.snapshot(), before);
        assert.equal(modal.style.display, 'none');
        controller.dispose();
    }
});

test('late auto-find cannot open a picker after restore switches to another auto canvas prompt', async () => {
    const pending = deferredFetch();
    const { doc, modal } = domFixture();
    const host = new Element('div');
    doc.body.appendChild(host);
    let promptInfo = { basePrompt: 'old, ink', negativePrompt: '' };
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => promptInfo,
    });
    controller.mount(host);
    controller.openPicker();
    const autoButton = doc.body.querySelectorAll('button').find((button) => button.textContent === '자동 찾기');
    autoButton.onclick();
    assert.equal(pending.requests.length, 2);

    promptInfo = { basePrompt: 'new, ink', negativePrompt: '' };
    controller.restore({ mode: 'auto', style: null });
    controller.refresh();
    pending.reply('shared-styles', [
        style({ id: 'old-canvas', name: 'Old canvas', positive: 'old, ink' }),
        style({ id: 'new-canvas', name: 'New canvas', positive: 'new, ink' }),
    ]);
    pending.reply('personal-styles', []);
    await flush();
    assert.equal(modal.style.display, 'none');
    assert.equal(controller.snapshot().mode, 'auto');
    assert.equal(controller.snapshot().style.id, 'new-canvas');
    controller.dispose();
});

test('empty prompt still loads the gallery but review cannot apply a selection', async () => {
    const pending = deferredFetch();
    const { doc, modal } = domFixture();
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: pending.fetch,
        getPrompt: () => ({ basePrompt: '', negativePrompt: '' }),
    });
    controller.openPicker();
    assert.equal(modal.style.display, 'flex');
    assert.equal(pending.requests.length, 2);
    assert.equal(doc.body.querySelector('.canvas-style-link-help').textContent,
        '현재 프롬프트는 바꾸지 않고 일치하는 태그만 묶습니다. 자동 판별은 태그 기준이며 순서와 가중치는 비교하지 않습니다.');
    const manual = style({ id: 'manual-empty-prompt', name: 'Manual without prompt' });
    pending.reply('shared-styles', [manual]);
    pending.reply('personal-styles', []);
    await flush();
    const result = doc.body.querySelector('.canvas-style-link-item');
    assert.ok(result, 'styles with no prompt overlap remain available in the full list');
    const before = controller.snapshot();
    result.onclick();
    const apply = doc.body.querySelectorAll('button').find((button) => button.textContent === '이 영역을 그림체로 지정');
    assert.equal(apply.disabled, true);
    assert.equal(modal.style.display, 'flex');
    assert.deepEqual(controller.snapshot(), before);
    controller.dispose();
});

test('direct picker selection applies selected full tags without mutating the source prompt', () => {
    const { doc, modal } = domFixture();
    const promptInfo = { basePrompt: 'solo, 2::artist:sample::, ink', negativePrompt: 'blurry, low quality' };
    const before = clone(promptInfo);
    const controller = CanvasStyleLink.create({ document: doc, getPrompt: () => promptInfo });
    controller.openPicker();
    const directTab = doc.body.querySelectorAll('button').find((button) => button.textContent === '프롬프트에서 직접 지정');
    directTab.onclick();
    const baseSource = doc.body.descendants().find((item) => item.getAttribute('aria-label') === '기본 프롬프트 구간 선택');
    const directPane = doc.body.descendants().find((item) => item.id === 'canvasStyleLinkDirectPane');
    const galleryPane = doc.body.descendants().find((item) => item.id === 'canvasStyleLinkGalleryPane');
    assert.equal(galleryPane.hidden, true);
    assert.equal(directPane.hidden, false);
    const selectedAt = promptInfo.basePrompt.indexOf('artist:sample') + 3;
    baseSource.selectionStart = selectedAt;
    baseSource.selectionEnd = selectedAt + 2;
    baseSource.onselect();
    const preview = doc.body.descendants().find((item) => item.className.includes('canvas-style-reference-preview'));
    assert.equal(preview.textContent, '2::artist:sample::');
    const apply = doc.body.querySelectorAll('button').find((button) => button.textContent === '선택 구간을 그림체로 연결');
    assert.equal(apply.disabled, false);
    apply.onclick();
    assert.equal(modal.style.display, 'none');
    assert.deepEqual(controller.snapshot(), {
        mode: 'manual',
        style: {
            id: 'canvas-custom', library: 'custom', name: '직접 지정',
            positive: '2::artist:sample::', negative: '',
            rangeStarts: { base: 1, negative: null },
        },
        expanded: { base: false, negative: false },
    });
    assert.deepEqual(promptInfo, before);
    controller.dispose();
});

test('direct picker cancel preserves the prior snapshot and stale source blocks apply', () => {
    const { doc } = domFixture();
    let promptInfo = { basePrompt: 'solo, artist, ink', negativePrompt: '' };
    const existing = style({ id: 'keep', library: 'personal', name: 'Keep manual' });
    const controller = CanvasStyleLink.create({ document: doc, getPrompt: () => promptInfo });
    controller.restore({ mode: 'manual', style: existing });
    const before = controller.snapshot();
    controller.openPicker();
    doc.body.querySelectorAll('button').find((button) => button.textContent === '프롬프트에서 직접 지정').onclick();
    const baseSource = doc.body.descendants().find((item) => item.getAttribute('aria-label') === '기본 프롬프트 구간 선택');
    baseSource.selectionStart = 7;
    baseSource.selectionEnd = 9;
    baseSource.onselect();
    controller.closePicker();
    assert.deepEqual(controller.snapshot(), before);

    controller.openPicker();
    doc.body.querySelectorAll('button').find((button) => button.textContent === '프롬프트에서 직접 지정').onclick();
    const reopenedBase = doc.body.descendants().find((item) => item.getAttribute('aria-label') === '기본 프롬프트 구간 선택');
    reopenedBase.selectionStart = 7;
    reopenedBase.selectionEnd = 9;
    reopenedBase.onselect();
    promptInfo = { basePrompt: 'changed, prompt', negativePrompt: '' };
    doc.body.querySelectorAll('button').find((button) => button.textContent === '선택 구간을 그림체로 연결').onclick();
    assert.deepEqual(controller.snapshot(), before);
    const error = doc.body.querySelector('.canvas-style-link-direct-error');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /프롬프트가 변경되었습니다/);
    controller.dispose();
});

test('late catalog responses do not replace a directly selected custom snapshot', async () => {
    const pending = deferredFetch();
    const { doc } = domFixture();
    const promptInfo = { basePrompt: 'solo, artist, ink', negativePrompt: '' };
    const controller = CanvasStyleLink.create({ document: doc, fetch: pending.fetch, getPrompt: () => promptInfo });
    controller.openPicker();
    doc.body.querySelectorAll('button').find((button) => button.textContent === '프롬프트에서 직접 지정').onclick();
    const baseSource = doc.body.descendants().find((item) => item.getAttribute('aria-label') === '기본 프롬프트 구간 선택');
    baseSource.selectionStart = 7;
    baseSource.selectionEnd = 9;
    baseSource.onselect();
    doc.body.querySelectorAll('button').find((button) => button.textContent === '선택 구간을 그림체로 연결').onclick();
    const committed = controller.snapshot();
    pending.reply('shared-styles', [style()]);
    pending.reply('personal-styles', []);
    await flush();
    assert.deepEqual(controller.snapshot(), committed);
    assert.equal(controller.snapshot().style.library, 'custom');
    controller.dispose();
});

test('manual status reports match counts and says when no prompt tags overlap', async () => {
    const { doc } = domFixture();
    const host = new Element('div');
    doc.body.appendChild(host);
    const controller = CanvasStyleLink.create({
        document: doc,
        getPrompt: () => ({ basePrompt: 'unrelated', negativePrompt: '' }),
    });
    controller.mount(host);
    controller.restore({ mode: 'manual', style: style({ positive: 'artist:sample, ink' }) });
    controller.refresh();
    await flush();
    assert.match(host.querySelector('.canvas-style-launcher').title, /일치 0\/2/);
    assert.match(host.querySelector('.canvas-style-launcher').title, /현재 프롬프트에 일치하는 태그 없음/);
    controller.restore({
        mode: 'manual',
        style: style({ selection: { base: [{ token: 'unrelated', occurrence: 0 }], negative: [] } }),
    });
    controller.refresh();
    await flush();
    assert.match(host.querySelector('.canvas-style-launcher').title, /선택 영역 1\/1/);
    assert.doesNotMatch(host.querySelector('.canvas-style-launcher').title, / · 일치 1\/1/);
    controller.dispose();
});

test('custom launcher status counts only a range that groupParts can actually fold', async () => {
    const { doc } = domFixture();
    const host = new Element('div');
    doc.body.appendChild(host);
    const controller = CanvasStyleLink.create({
        document: doc,
        getPrompt: () => ({ basePrompt: 'solo, other, ink', negativePrompt: '' }),
    });
    controller.mount(host);
    controller.restore({
        mode: 'manual',
        style: {
            id: 'canvas-custom', library: 'custom', name: 'My selection',
            positive: 'solo, ink', negative: '', rangeStarts: { base: 0, negative: null },
        },
    });
    controller.refresh();
    await flush();
    const status = host.querySelector('.canvas-style-launcher').title;
    assert.match(status, /직접 지정: My selection · 현재 일치 0\/2/);
    assert.doesNotMatch(status, /라이브러리에서 찾을 수 없음/);
    controller.dispose();
});

test('project style snapshots require a valid source project and selected tokens and remain detached', () => {
    const projectStyle = {
        id: 'project-candidate', library: 'project', sourceProjectId: 'a'.repeat(32), name: 'Project image',
        positive: '', negative: 'bad anatomy',
        selection: {base: [], negative: [{token: 'bad anatomy', occurrence: 0}]},
    };
    const normalized = CanvasStyleLink.normalizeState({mode: 'manual', style: projectStyle});
    assert.deepEqual(normalized.style, projectStyle);

    const controller = CanvasStyleLink.create({getPrompt: () => ({basePrompt: '', negativePrompt: ''})});
    controller.restore({mode: 'manual', style: projectStyle});
    const detached = controller.snapshot();
    detached.style.selection.negative[0].token = 'changed';
    assert.deepEqual(controller.snapshot().style, projectStyle);
    assert.equal(controller.groupParts('base', [{token: 'solo', index: 0}]).some(part => part.type === 'style'), false);
    assert.deepEqual(controller.groupParts('negative', [{token: 'bad anatomy', index: 0}]).map(part => part.type), ['style']);

    const invalidStyles = [
        {...projectStyle, sourceProjectId: 'A'.repeat(32)},
        {...projectStyle, sourceProjectId: 'a'.repeat(31)},
        {...projectStyle, sourceProjectId: 7},
        {...projectStyle, selection: undefined},
        {...projectStyle, selection: {base: [], negative: []}},
    ];
    for (const invalid of invalidStyles) {
        assert.equal(CanvasStyleLink.normalizeState({mode: 'manual', style: invalid}).style, null);
    }
});

test('project style status shows current match counts without catalog provenance warnings', async () => {
    const {doc} = domFixture();
    const host = new Element('div');
    doc.body.appendChild(host);
    const controller = CanvasStyleLink.create({
        document: doc,
        fetch: async () => response([]),
        getPrompt: () => ({basePrompt: 'unrelated', negativePrompt: ''}),
    });
    controller.mount(host);
    controller.restore({mode: 'manual', style: {
        id: 'project-candidate', library: 'project', sourceProjectId: 'a'.repeat(32), name: 'Project image',
        positive: 'selected recipe', negative: '',
        selection: {base: [{token: 'selected recipe', occurrence: 0}], negative: []},
    }});
    controller.refresh();
    await flush();
    const status = host.querySelector('.canvas-style-launcher').title;
    assert.match(status, /프로젝트 그림: Project image · 선택 영역 0\/1/);
    assert.match(status, /현재 프롬프트에 일치하는 태그 없음/);
    assert.doesNotMatch(status, /라이브러리에서 찾을 수 없음|라이브러리 확인 실패/);
    controller.dispose();
});
