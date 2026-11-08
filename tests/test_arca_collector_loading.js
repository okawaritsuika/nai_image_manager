const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.style = { setProperty: (name, value) => { this.style[name] = value; } };
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force === undefined ? !names.has(name) : Boolean(force);
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return enabled;
      },
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => name && !names.includes(name)).join(" "); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }

  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this[`on${name}`] = handler; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}

function fixture(fetcher, { abortController = AbortController, storage } = {}) {
  const elements = Object.fromEntries([
    "arcaStyleList", "arcaStyleListStatus", "arcaStyleSearch", "arcaMetadataFilter",
    "arcaModelFilter", "arcaRecommendationMinList", "arcaStyleSort", "arcaStylePageSize",
    "arcaStylePageSummary", "arcaStylePageInput", "arcaStylePrevPage", "arcaStyleNextPage",
  ].map(id => [id, new FakeElement()]));
  elements.arcaMetadataFilter.value = "all";
  elements.arcaModelFilter.value = "all";
  elements.arcaStyleSort.value = "posted_desc";
  elements.arcaStylePageSize.value = "50";
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tagName => new FakeElement(tagName),
    addEventListener() {},
  };
  const context = { document, fetch: fetcher, URLSearchParams, AbortController: abortController, localStorage: storage };
  vm.createContext(context);
  const source = fs.readFileSync(require.resolve("../naim/style_manager/static/arca_style_collector.js"), "utf8");
  vm.runInContext(`${source}\nglobalThis.__testApi = { loadArcaStyles, renderArcaCard, renderArcaStyleGroups, renderArcaStyleGroupsLegacy, createArcaStatisticsImageCard, restoreArcaCardLayout, applyArcaCardSize, applyArcaCardColumns, state: arcaState };`, context);
  return { ...context.__testApi, elements };
}

const response = body => ({ ok: true, status: 200, json: async () => body });

test("card size presets survive reopening the workspace", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  for (const preset of ["xsmall", "small", "medium", "large"]) {
    const original = fixture(null, { storage });
    original.elements.arcaStyleList.clientWidth = 768;
    original.applyArcaCardSize(preset);
    const reopened = fixture(null, { storage });
    reopened.elements.arcaStyleList.clientWidth = 768;
    reopened.restoreArcaCardLayout();
    reopened.applyArcaCardSize();
    assert.equal(reopened.state.cardSizePreset, preset);
    assert.equal(reopened.state.cardColumns, original.state.cardColumns);
  }
});

test("saved column count fits a narrow window without replacing the saved choice", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const original = fixture(null, { storage });
  original.elements.arcaStyleList.clientWidth = 768;
  original.applyArcaCardColumns(6);
  const saved = [...values.entries()];
  for (const [width, expected] of [[260, 2], [768, 6]]) {
    const reopened = fixture(null, { storage });
    reopened.elements.arcaStyleList.clientWidth = width;
    reopened.restoreArcaCardLayout();
    reopened.applyArcaCardSize();
    assert.equal(reopened.state.cardSizePreset, null);
    assert.equal(reopened.state.cardColumns, expected);
    assert.deepEqual([...values.entries()], saved);
  }
});

test("invalid saved card preferences keep the default layout", () => {
  for (const stored of [null, "{", "[]", '{"preset":"unknown"}', '{"preset":null,"columns":0}', '{"preset":null,"columns":"3"}']) {
    const f = fixture(null, { storage: { getItem: () => stored, setItem: () => assert.fail("loading must not write") } });
    f.elements.arcaStyleList.clientWidth = 768;
    f.restoreArcaCardLayout();
    f.applyArcaCardSize();
    assert.equal(f.state.cardSizePreset, "medium");
    assert.equal(f.state.cardColumns, 2);
  }
});

test("blocked browser storage still allows changing the card layout", () => {
  const f = fixture(null, { storage: {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
  } });
  f.elements.arcaStyleList.clientWidth = 768;
  f.restoreArcaCardLayout();
  f.applyArcaCardSize("small");
  assert.equal(f.state.cardSizePreset, "small");
  f.applyArcaCardColumns(4);
  assert.equal(f.state.cardColumns, 4);
});

test("collector small images prefer thumbnails and keep the original selected preview", () => {
  const f = fixture(async () => response({}));
  const card = f.renderArcaCard({ title: "합성 그림체", representative_thumbnail_url: "card-small.webp", representative_image_url: "card-original.png" });
  const cardImage = card.children[0].children[0];
  assert.equal(cardImage.src, "card-small.webp");
  assert.equal(cardImage.loading, "lazy");
  assert.equal(cardImage.decoding, "async");

  const fallbackCard = f.renderArcaCard({ representative_image_url: "fallback-original.png" });
  assert.equal(fallbackCard.children[0].children[0].src, "fallback-original.png");

  const group = { images: [
    { thumbnail_url: "choice-small.webp", image_url: "choice-original.png" },
    { image_url: "choice-fallback.png" },
  ] };
  const rendered = f.renderArcaStyleGroups([group]);
  const section = rendered.children[0];
  const thumbnails = section.children[1];
  const choiceImage = thumbnails.children[0].children[0];
  const fallbackChoice = thumbnails.children[1].children[0];
  assert.equal(choiceImage.src, "choice-small.webp");
  assert.equal(choiceImage.loading, "lazy");
  assert.equal(choiceImage.decoding, "async");
  assert.equal(fallbackChoice.src, "choice-fallback.png");
  assert.equal(section.children[2].children[0].children[0].src, "choice-original.png");

  const legacy = f.renderArcaStyleGroupsLegacy([{ images: [{ thumbnail_url: "legacy-small.webp", image_url: "legacy-original.png" }] }]);
  const legacyImage = legacy.children[0].children[1].children[0];
  assert.equal(legacyImage.src, "legacy-small.webp");
  assert.equal(legacyImage.loading, "lazy");
  assert.equal(legacyImage.decoding, "async");

  const statisticsCard = f.createArcaStatisticsImageCard({ thumbnail_url: "statistics-small.webp", image_url: "statistics-original.png" }, "합성 태그");
  const statisticsImage = statisticsCard.children[0].children[0];
  assert.equal(statisticsImage.src, "statistics-small.webp");
  assert.equal(statisticsImage.loading, "lazy");
  assert.equal(statisticsImage.decoding, "async");
});

test("collector list renders normal and empty responses", async () => {
  let nextBody = { items: [{ title: "합성 항목", representative_image_url: "fallback.png" }], page: 2, total_pages: 3, total: 101, per_page: 50 };
  const f = fixture(async () => response(nextBody));
  await f.loadArcaStyles();
  assert.equal(f.elements.arcaStyleList.children.length, 1);
  assert.equal(f.elements.arcaStyleList.children[0].children[0].children[0].src, "fallback.png");
  assert.equal(f.state.page, 2);
  assert.equal(f.state.totalPages, 3);
  assert.match(f.elements.arcaStyleListStatus.textContent, /전체 101개/);
  assert.equal(f.state.loaded, true);

  nextBody = { items: [], page: 1, total_pages: 1, total: 0, per_page: 50 };
  await f.loadArcaStyles();
  assert.equal(f.elements.arcaStyleList.children.length, 1);
  assert.equal(f.elements.arcaStyleList.children[0].textContent, "수집된 그림체가 없습니다.");
});

test("a newer search wins when responses finish in reverse order and aborts its predecessor", async () => {
  const pending = new Map();
  const requests = [];
  const f = fixture((url, options) => {
    const key = new URL(url, "http://local").searchParams.get("q");
    requests.push({ key, options });
    return new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
  });

  f.elements.arcaStyleSearch.value = "a";
  const older = f.loadArcaStyles();
  f.elements.arcaStyleSearch.value = "ab";
  const newer = f.loadArcaStyles();
  assert.equal(requests[0].options.signal.aborted, true);

  pending.get("ab").resolve(response({ items: [{ title: "최신 결과" }], page: 1, total_pages: 4, total: 160, per_page: 50 }));
  await newer;
  const latestStatus = f.elements.arcaStyleListStatus.textContent;
  pending.get("a").resolve(response({ items: [{ title: "오래된 결과" }], page: 1, total_pages: 1, total: 1, per_page: 50 }));
  await older;

  assert.equal(f.elements.arcaStyleList.children[0].children[1].children[0].textContent, "최신 결과");
  assert.equal(f.state.totalPages, 4);
  assert.equal(f.elements.arcaStyleListStatus.textContent, latestStatus);
  assert.equal(f.state.loaded, true);
});

test("an older failed search cannot replace the latest results or error status", async () => {
  const pending = new Map();
  const f = fixture((url, options) => {
    const key = new URL(url, "http://local").searchParams.get("q");
    return new Promise((resolve, reject) => pending.set(key, { resolve, reject, signal: options.signal }));
  });
  f.elements.arcaStyleSearch.value = "old";
  const older = f.loadArcaStyles();
  f.elements.arcaStyleSearch.value = "new";
  const newer = f.loadArcaStyles();
  pending.get("new").resolve(response({ items: [{ title: "유지할 최신 결과" }], page: 3, total_pages: 5, total: 220, per_page: 50 }));
  await newer;
  const state = { page: f.state.page, totalPages: f.state.totalPages, loaded: f.state.loaded, status: f.elements.arcaStyleListStatus.textContent };
  pending.get("old").reject(new Error("오래된 합성 오류"));
  await older;
  assert.equal(pending.get("old").signal.aborted, true);
  assert.deepEqual({ page: f.state.page, totalPages: f.state.totalPages, loaded: f.state.loaded, status: f.elements.arcaStyleListStatus.textContent }, state);
  assert.equal(f.elements.arcaStyleList.children[0].children[1].children[0].textContent, "유지할 최신 결과");
});

test("the latest network failure remains visible", async () => {
  const f = fixture(async () => { throw new Error("합성 네트워크 오류"); });
  await f.loadArcaStyles();
  assert.equal(f.elements.arcaStyleListStatus.textContent, "합성 네트워크 오류");
  assert.match(f.elements.arcaStyleListStatus.className, /error/);
  assert.equal(f.state.loaded, false);
});

test("revision guards still protect results when AbortController is unavailable", async () => {
  const pending = new Map();
  const f = fixture((url) => {
    const key = new URL(url, "http://local").searchParams.get("q");
    return new Promise((resolve, reject) => pending.set(key, { resolve, reject }));
  }, { abortController: undefined });
  f.elements.arcaStyleSearch.value = "old";
  const older = f.loadArcaStyles();
  f.elements.arcaStyleSearch.value = "new";
  const newer = f.loadArcaStyles();
  pending.get("new").resolve(response({ items: [{ title: "최신" }], page: 1, total_pages: 1, total: 1, per_page: 50 }));
  await newer;
  pending.get("old").resolve(response({ items: [{ title: "이전" }], page: 1, total_pages: 9, total: 400, per_page: 50 }));
  await older;
  assert.equal(f.elements.arcaStyleList.children[0].children[1].children[0].textContent, "최신");
  assert.equal(f.state.totalPages, 1);
});
