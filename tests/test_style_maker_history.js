const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deleteStyleHistoryItem,
  loadStyleHistory,
  renderStyleHistoryList,
  renderStyleHistorySelection,
  styleState,
} = require('../naim/style_manager/static/style_maker');

class ElementStub {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.loading = '';
    this.alt = '';
    this.title = '';
    this.type = '';
    this.scrollTop = 0;
    this.replaceChildrenCalls = 0;
    this._classes = new Set();
    this.classList = {
      add: (name) => this._classes.add(name),
      remove: (name) => this._classes.delete(name),
      contains: (name) => this._classes.has(name),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this._classes.has(name) : Boolean(force);
        if (enabled) this._classes.add(name);
        else this._classes.delete(name);
        return enabled;
      },
    };
  }

  set className(value) {
    this._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this._classes].join(' ');
  }

  append(...items) {
    items.forEach((item) => {
      if (item && typeof item === 'object') {
        item.parentNode?.removeChild?.(item);
        item.parentNode = this;
      }
      this.children.push(item);
    });
  }

  replaceChildren(...items) {
    this.replaceChildrenCalls += 1;
    this.children.forEach((child) => {
      if (child && typeof child === 'object') child.parentNode = null;
    });
    this.children = [];
    this.append(...items);
  }

  removeChild(item) {
    const index = this.children.indexOf(item);
    if (index >= 0) this.children.splice(index, 1);
    item.parentNode = null;
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  closest(selector) { return selector === '.style-history-scroll' ? this.scrollContainer || null : null; }
  contains(item) {
    if (item === this) return true;
    return this.children.some((child) => child === item || child?.contains?.(item));
  }

  click() {
    this.listeners.get('click')?.({
      preventDefault() {},
      stopPropagation() {},
    });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const classNames = selector.startsWith('.') ? selector.slice(1).split('.') : null;
    const matches = [];
    const visit = (element) => {
      if (!element || typeof element !== 'object') return;
      if ((classNames && classNames.every((name) => element.classList?.contains(name))) || (!classNames && String(element.tagName).toLowerCase() === selector.toLowerCase())) {
        matches.push(element);
      }
      (element.children || []).forEach(visit);
    };
    this.children.forEach(visit);
    return matches;
  }
}

function historyItem(id, overrides = {}) {
  return {
    id,
    image_url: `/synthetic/full-${id}.png`,
    thumbnail_url: `/synthetic/thumb-${id}.webp`,
    artists: [],
    ...overrides,
  };
}

function setupHarness() {
  const ids = ['styleHistoryList', 'styleHistoryDetail', 'styleHistoryStatus', 'latestStyleResult'];
  const elements = new Map(ids.map((id) => [id, new ElementStub()]));
  const list = elements.get('styleHistoryList');
  list.scrollContainer = new ElementStub('section');
  list.scrollContainer.className = 'style-history-scroll';
  global.document = {
    getElementById: (id) => elements.get(id) || null,
    createElement: (tagName) => new ElementStub(tagName),
  };
  const oldLoader = styleState.historyImageLoader;
  if (oldLoader) {
    oldLoader.onload = null;
    oldLoader.onerror = null;
  }
  styleState.historyItems = [];
  styleState.historySelectedId = null;
  styleState.historyDirty = true;
  styleState.historyRequestToken = 0;
  styleState.historyImageLoader = null;
  styleState.displayedStyleResult = null;
  styleState.generating = false;
  styleState.managerDirty = false;

  const imageLoads = [];
  global.Image = class DeferredImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this._src = '';
      imageLoads.push(this);
    }
    set src(value) { this._src = value; }
    get src() { return this._src; }
  };
  global.appDialog = { confirm: async () => true };
  global.apiFetch = async () => { throw new Error('Unexpected API request'); };
  return { elements, list, latest: elements.get('latestStyleResult'), imageLoads };
}

test.afterEach(() => {
  const loader = styleState.historyImageLoader;
  if (loader) {
    loader.onload = null;
    loader.onerror = null;
  }
  styleState.historyImageLoader = null;
  delete global.document;
  delete global.Image;
  delete global.appDialog;
  delete global.apiFetch;
});

test('history delete posts the generated image id to the generated delete route and reloads the list', async () => {
  const { list } = setupHarness();
  const deleted = historyItem(41);
  styleState.historyItems = [deleted];
  styleState.historySelectedId = 41;
  const calls = [];
  global.apiFetch = async (url, options) => {
    calls.push([url, options]);
    if (url === '/style-workspace/api/style-manager/generated/delete-batch') return {};
    if (url === '/style-workspace/api/style-manager/generated') return [historyItem(42)];
    throw new Error(`Unexpected request: ${url}`);
  };

  assert.equal(await deleteStyleHistoryItem(deleted), true);
  assert.deepEqual(calls, [
    ['/style-workspace/api/style-manager/generated/delete-batch', { method: 'POST', body: JSON.stringify({ image_ids: [41] }) }],
    ['/style-workspace/api/style-manager/generated', undefined],
  ]);
  assert.deepEqual(styleState.historyItems.map((item) => item.id), [42]);
  assert.equal(styleState.managerDirty, true);
  assert.equal(list.querySelectorAll('.style-history-card').length, 1);
});

test('canceling a history delete makes no request and keeps the record', async () => {
  setupHarness();
  const item = historyItem(51);
  styleState.historyItems = [item];
  let requests = 0;
  global.appDialog.confirm = async () => false;
  global.apiFetch = async () => { requests += 1; };

  assert.equal(await deleteStyleHistoryItem(item), false);
  assert.equal(requests, 0);
  assert.deepEqual(styleState.historyItems, [item]);
});

test('a failed history delete keeps the record and displays the error', async () => {
  const { elements } = setupHarness();
  const item = historyItem(61);
  styleState.historyItems = [item];
  global.apiFetch = async () => { throw new Error('synthetic delete failure'); };

  assert.equal(await deleteStyleHistoryItem(item), false);
  assert.deepEqual(styleState.historyItems, [item]);
  assert.equal(elements.get('styleHistoryStatus').textContent, 'synthetic delete failure');
});

test('selecting a history card keeps card and thumbnail nodes, scroll position, and generation state', () => {
  const { list, latest } = setupHarness();
  styleState.historyItems = Array.from({ length: 250 }, (_, index) => historyItem(index + 1));
  styleState.historySelectedId = 1;
  styleState.generating = true;
  list.scrollContainer.scrollTop = 184;
  renderStyleHistoryList();
  const cards = list.querySelectorAll('.style-history-card');
  const cardImages = cards.map((card) => card.querySelector('img'));
  const previewUpdatesBefore = latest.replaceChildrenCalls;

  cards[1].querySelector('.style-history-card-select').click();

  const cardsAfter = list.querySelectorAll('.style-history-card');
  assert.equal(cardsAfter.length, 250);
  assert.equal(cardsAfter[0] === cards[0], true);
  assert.equal(cardsAfter[1] === cards[1], true);
  assert.equal(cardsAfter[0].querySelector('img') === cardImages[0], true);
  assert.equal(cardsAfter[1].querySelector('img') === cardImages[1], true);
  assert.equal(list.scrollContainer.scrollTop, 184);
  assert.equal(cardsAfter[0].classList.contains('selected'), false);
  assert.equal(cardsAfter[0].querySelector('.style-history-card-select').getAttribute('aria-pressed'), 'false');
  assert.equal(cardsAfter[1].classList.contains('selected'), true);
  assert.equal(cardsAfter[1].querySelector('.style-history-card-select').getAttribute('aria-pressed'), 'true');
  assert.equal(latest.replaceChildrenCalls, previewUpdatesBefore + 1);
  assert.equal(styleState.historySelectedId, 2);
  assert.equal(styleState.generating, true);
});

test('history preview shows thumbnails immediately, ignores stale full-image loads, and keeps thumbnails on failure', () => {
  const { latest, imageLoads } = setupHarness();
  const first = historyItem(71);
  renderStyleHistorySelection(first);
  assert.equal(latest.querySelector('img').src, first.thumbnail_url);
  assert.equal(imageLoads.length, 1);
  const staleLoad = imageLoads[0].onload;

  const second = historyItem(72);
  renderStyleHistorySelection(second);
  assert.equal(latest.querySelector('img').src, second.thumbnail_url);
  assert.equal(imageLoads.length, 2);
  assert.equal(imageLoads[0].onload, null);
  staleLoad?.();
  assert.equal(latest.querySelector('img').src, second.thumbnail_url);
  imageLoads[1].onload();
  assert.equal(latest.querySelector('img').src, second.image_url);

  const third = historyItem(73);
  renderStyleHistorySelection(third);
  assert.equal(latest.querySelector('img').src, third.thumbnail_url);
  imageLoads[2].onerror();
  assert.equal(latest.querySelector('img').src, third.thumbnail_url);

  const direct = historyItem(74, { thumbnail_url: '' });
  renderStyleHistorySelection(direct);
  assert.equal(latest.querySelector('img').src, direct.image_url);
  assert.equal(imageLoads.length, 3);

  const sameUrl = historyItem(76, { thumbnail_url: '/synthetic/full-76.png' });
  renderStyleHistorySelection(sameUrl);
  assert.equal(latest.querySelector('img').src, sameUrl.image_url);
  assert.equal(imageLoads.length, 3);

  const pending = historyItem(75);
  renderStyleHistorySelection(pending);
  const canceledLoader = imageLoads[3];
  const stalePendingLoad = canceledLoader.onload;
  renderStyleHistorySelection(null);
  stalePendingLoad?.();
  assert.equal(canceledLoader.onload, null);
  assert.equal(canceledLoader.onerror, null);
  assert.equal(canceledLoader.src, '');
  assert.equal(latest.querySelector('img'), null);
});

test('loading history renders the selected preview once', async () => {
  const { latest } = setupHarness();
  global.apiFetch = async (url) => {
    assert.equal(url, '/style-workspace/api/style-manager/generated');
    return [historyItem(81, { thumbnail_url: '' }), historyItem(82)];
  };

  await loadStyleHistory({ force: true });

  assert.equal(styleState.historySelectedId, 81);
  assert.equal(latest.replaceChildrenCalls, 1);
  assert.equal(latest.querySelector('img').src, '/synthetic/full-81.png');
});
