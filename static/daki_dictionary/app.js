(function (root) {
function mount(host, options = {}) {
  if (!host || typeof host.querySelector !== 'function' || (host.matches && !host.matches('.daki-dictionary-tool'))) return { dispose() {} };
  if (host.__dakiDictionaryMount) return host.__dakiDictionaryMount;
  const listenerDisposers = new Set();
  let disposed = false;
  let resizeObserver = null;
  const dictionaryDrafts = root.DakiDictionaryDrafts?.mount(host);
  const $ = id => host.querySelector(`#${id}`);
  function listen(target, type, handler, options) {
    if (!target?.addEventListener) return () => {};
    const guardedHandler = function (...args) {
      if (!disposed) return handler.apply(this, args);
    };
    target.addEventListener(type, guardedHandler, options);
    const disposeListener = () => {
      target.removeEventListener(type, guardedHandler, options);
      listenerDisposers.delete(disposeListener);
    };
    if (target === root || target === document) listenerDisposers.add(disposeListener);
    return disposeListener;
  }
const number = value => Number(value || 0).toLocaleString('ko-KR');
const state = { tags: [], categories: [], categoryLabels: new Map(), byTag: new Map(), category: '', selected: null,
  query: '', sort: 'count', filtered: [], shown: 0, sourceRows: null, comboOffset: 0, comboTotal: 0,
  comboLoading: false, comboLoadedTag: '', comboController: null, activeTab: 'images', busy: false };
let toastTimer;
let bootstrapController = null;
let pageActive = true;
const activeRequests = new Set();
const deferredTimers = new Set();
const pageSize = 100;
const images = { status: null, statusController: null, offset: 0, total: 0, loadedTag: '', loading: false,
  controller: null, detailController: null, detail: null, folderBusy: false, timer: null };
const related = { controller: null, loadedTag: '', loading: false, items: [], expanded: false };
const statistics = { controller: null, sort: 'combinations', offset: 0, total: 0, loading: false };
const percentLabel = value => `${Number(value || 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`;

function scheduleTimer(callback, delay) {
  const timer = setTimeout(() => { deferredTimers.delete(timer); callback(); }, delay);
  deferredTimers.add(timer);
  return timer;
}

function clearTrackedTimer(timer) {
  if (!timer) return;
  clearTimeout(timer);
  deferredTimers.delete(timer);
}

function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function tagHint(element, english) {
  element.dataset.helpTag = english;
  element.removeAttribute('title');
  return element;
}

function installTagHints() {
  const tooltip = node('div', 'tag-tooltip');
  tooltip.id = 'tagTooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  host.append(tooltip);
  let active = null;
  function hide() {
    active?.removeAttribute('aria-describedby');
    active = null;
    tooltip.hidden = true;
  }
  function position() {
    if (!active?.isConnected || tooltip.hidden) return;
    const anchor = active.getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > root.innerHeight) { hide(); return; }
    const bounds = tooltip.getBoundingClientRect();
  const left = Math.max(12, Math.min(anchor.left, root.innerWidth - bounds.width - 12));
    const below = anchor.bottom + 8;
  const top = below + bounds.height <= root.innerHeight - 12 ? below : Math.max(12, anchor.top - bounds.height - 8);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
  function show(element) {
    if (element?.matches('.tag-row.active, .used-tag.selected')) { hide(); return; }
    if (!element || active === element) return;
    const tag = state.byTag.get(element.dataset.helpTag);
    if (!tag) return;
    hide();
    active = element;
    tooltip.replaceChildren(node('strong', 'hint-ko', tag.ko), node('span', 'hint-en', tag.tag),
      node('p', 'hint-description', tag.description || '아직 등록된 설명이 없습니다.'));
    tooltip.hidden = false;
    element.setAttribute('aria-describedby', tooltip.id);
    position();
  }
  listen(document, 'pointerover', event => {
    if (host.contains(event.target)) show(event.target.closest?.('[data-help-tag]'));
  });
  listen(document, 'pointerout', event => {
    if (!host.contains(event.target)) return;
    if (active?.contains(event.target) && !active.contains(event.relatedTarget)) hide();
  });
  listen(document, 'focusin', event => {
    if (host.contains(event.target)) show(event.target.closest?.('[data-help-tag]'));
  });
  listen(document, 'focusout', event => { if (host.contains(event.target)) hide(); });
  listen(document, 'pointerdown', event => { if (host.contains(event.target)) hide(); }, true);
  listen(document, 'click', event => { if (host.contains(event.target)) hide(); }, true);
  listen(document, 'scroll', () => {
    if (active === document.activeElement) position();
    else hide();
  }, true);
  listen(window, 'resize', hide);
  listen(window, 'blur', hide);
  return { hide, remove: () => tooltip.remove() };
}

function positionPictureOverlay() {
  const overlay = $('pictureOverlay');
  if (!overlay.open) return;
  const bounds = host.querySelector('#imageViewer .image-view').getBoundingClientRect();
  if (!bounds.width || !bounds.height) { overlay.close(); return; }
  overlay.style.left = `${bounds.left}px`;
  overlay.style.width = `${bounds.width}px`;
  overlay.style.height = `${Math.max(100, Math.min(bounds.bottom, root.innerHeight - 4) - 4)}px`;
}

function openPictureOverlay() {
  const image = $('imageFull');
  if (!images.detail || !image.complete || !image.naturalWidth || !image.getAttribute('src')) return;
  const overlay = $('pictureOverlay');
  if (overlay.open) { overlay.close(); return; }
  $('pictureOverlayError').hidden = true;
  $('pictureOverlayImage').src = image.currentSrc || image.src;
  $('pictureOverlayImage').alt = image.alt;
  overlay.show();
  positionPictureOverlay();
  $('togglePicture').setAttribute('aria-expanded', 'true');
}

function setHeaderCollapsed(collapsed) {
  const isCollapsed = Boolean(collapsed);
  host.classList.toggle('headers-collapsed', isCollapsed);
  $('toggleDictionaryHeader').setAttribute('aria-expanded', String(!isCollapsed));
  $('toggleDictionaryHeader').textContent = isCollapsed ? '상단 펼치기' : '상단 접기';
  options.onHeaderChange?.(isCollapsed);
}

async function api(url, options = {}) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  activeRequests.add(controller);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal,
      headers: { 'Accept': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (disposed) throw new DOMException('Dictionary view was closed.', 'AbortError');
    if (!response.ok) throw new Error(data.error || data.detail || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return data;
  } finally {
    options.signal?.removeEventListener('abort', forwardAbort);
    activeRequests.delete(controller);
  }
}

function toast(message) {
  if (!pageActive) return;
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTrackedTimer(toastTimer);
  toastTimer = scheduleTimer(() => $('toast').classList.remove('visible'), 2600);
}

async function copy(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(text);
  } catch (_) {
    try {
      const area = node('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;top:0';
      host.append(area);
      try {
        area.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
      } finally { area.remove(); }
    } catch (_) { toast('복사하지 못했습니다. 텍스트를 선택해 직접 복사해 주세요.'); return false; }
  }
  toast('복사했습니다.');
  return true;
}

function labelFor(id) {
  return state.categoryLabels.get(id) || id;
}

function deriveCategories() {
  const counts = new Map();
  for (const tag of state.tags) for (const id of new Set(tag.categories || [])) counts.set(id, (counts.get(id) || 0) + 1);
  const known = new Map(state.categories.map(category => [category.id, category]));
  state.categories = [...counts].map(([id, count]) => ({ id, label: known.get(id)?.label || id, count }));
  state.categories.sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  state.categoryLabels = new Map(state.categories.map(category => [category.id, category.label]));
}

function renderCategories() {
  const query = $('categorySearch').value.trim().toLowerCase();
  const root = { children: new Map() };
  for (const category of state.categories) {
    const label = category.label || category.id;
    if (query && !`${label} ${category.id}`.toLowerCase().includes(query)) continue;
    const parts = label.split(/\s*[/>]\s*/).filter(Boolean);
    let branch = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      if (!branch.children.has(name)) branch.children.set(name, { name, path: parts.slice(0, i + 1).join('/'), children: new Map(), category: null });
      branch = branch.children.get(name);
    }
    branch.category = category;
  }
  const tree = $('categoryTree');
  const opened = new Set([...tree.querySelectorAll('details[open]')].map(el => el.dataset.path));
  tree.replaceChildren();
  $('categoryCount').textContent = number(state.categories.length);
  $('allCount').textContent = number(state.tags.length);
  $('allCategories').classList.toggle('active', !state.category);
  if (!root.children.size) { tree.append(node('p', 'loading-text', '해당하는 분류가 없습니다.')); return; }
  function measure(branch) {
    branch.categoryCount = branch.category ? 1 : 0;
    branch.activeInside = branch.category?.id === state.category;
    for (const child of branch.children.values()) {
      measure(child);
      branch.categoryCount += child.categoryCount;
      branch.activeInside ||= child.activeInside;
    }
  }
  function categoryButton(category, label) {
    const button = node('button', `category-item${category.id === state.category ? ' active' : ''}`);
    button.type = 'button';
    button.title = `${category.label} · ${number(category.count)}개 태그`;
    button.setAttribute('aria-current', category.id === state.category ? 'true' : 'false');
    button.append(node('span', '', label), node('span', '', number(category.count)));
    listen(button, 'click', () => selectCategory(category.id));
    return button;
  }
  function renderBranch(branch, depth) {
    if (!branch.children.size) return categoryButton(branch.category, branch.name);
    const details = node('details', `category-group${branch.activeInside ? ' has-selection' : ''}`);
    details.dataset.path = branch.path;
    details.dataset.depth = String(depth);
    details.open = Boolean(query || branch.activeInside || opened.has(branch.path));
    const heading = node('summary');
    const descendants = branch.categoryCount - (branch.category ? 1 : 0);
    heading.title = `${branch.path.replaceAll('/', ' › ')} · 하위 분류 ${number(descendants)}개`;
    const count = node('span', '', number(descendants));
    count.setAttribute('aria-label', `하위 분류 ${number(descendants)}개`);
    heading.append(node('span', 'category-branch-label', branch.name), count);
    const children = node('div', 'category-children');
    if (branch.category) children.append(categoryButton(branch.category, `${branch.name} 태그`));
    for (const child of branch.children.values()) children.append(renderBranch(child, depth + 1));
    details.append(heading, children);
    return details;
  }
  for (const branch of root.children.values()) { measure(branch); tree.append(renderBranch(branch, 0)); }
}

function selectCategory(id) {
  state.category = id;
  renderCategories();
  filterTags();
  setBrowserTab('tags');
}

function setBrowserTab(tab) {
  const isTags = tab === 'tags';
  $('tagsBrowserTab').classList.toggle('active', isTags);
  $('tagsBrowserTab').setAttribute('aria-selected', String(isTags));
  $('tagPane').hidden = !isTags;
  $('categoriesBrowserTab').classList.toggle('active', !isTags);
  $('categoriesBrowserTab').setAttribute('aria-selected', String(!isTags));
  $('categoryPane').hidden = isTags;
  if (isTags) $('tagSearch').focus({ preventScroll: true });
}

function setWorkbenchView(view) {
  const inspector = view === 'inspector';
  host.querySelector('.workspace').classList.toggle('view-inspector', inspector);
  $('showPreviewView').classList.toggle('active', !inspector);
  $('showPreviewView').setAttribute('aria-pressed', String(!inspector));
  $('showInspectorView').classList.toggle('active', inspector);
  $('showInspectorView').setAttribute('aria-pressed', String(inspector));
}

function isDesktopLayout() {
  return ['wide', 'large'].includes(host.dataset.layoutMode);
}

function updateLayoutMode() {
  if (disposed) return;
  const width = host.getBoundingClientRect().width;
  const mode = width >= 1440 ? 'large' : width >= 1100 ? 'wide' : width >= 800 ? 'medium' : 'narrow';
  const previous = host.dataset.layoutMode;
  host.dataset.layoutMode = mode;
  if (previous && previous !== mode) host.querySelector('.workspace').classList.remove('browse-open', 'browser-hidden');
  if (!['wide', 'large'].includes(mode)) host.querySelector('.workspace').classList.remove('browser-hidden');
  updateBrowseButton();
}

function updateBrowseButton() {
  const workspace = host.querySelector('.workspace');
  const desktop = isDesktopLayout();
  const wideHidden = desktop && workspace.classList.contains('browser-hidden');
  const drawerOpen = !desktop && workspace.classList.contains('browse-open');
  $('browseTagsMobile').setAttribute('aria-expanded', String(!wideHidden && (desktop || drawerOpen)));
  $('browseTagsMobile').textContent = wideHidden ? '태그 찾기' : desktop ? '탐색 숨기기' : drawerOpen ? '탐색 닫기' : '태그 찾기';
}

function toggleBrowser() {
  const workspace = host.querySelector('.workspace');
  if (isDesktopLayout()) workspace.classList.toggle('browser-hidden');
  else if (host.dataset.layoutMode === 'narrow') workspace.classList.toggle('browse-open');
  else {
    setBrowserTab('tags');
    $('tagSearch').focus({ preventScroll: true });
    return;
  }
  updateBrowseButton();
  const opened = isDesktopLayout()
    ? !workspace.classList.contains('browser-hidden')
    : workspace.classList.contains('browse-open');
  if (opened) $('tagSearch').focus({ preventScroll: true });
}

function filterTags() {
  const terms = state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  state.filtered = state.tags.filter(tag => {
    if (state.category && !(tag.categories || []).includes(state.category)) return false;
    const haystack = `${tag.tag} ${tag.ko} ${(tag.aliases || []).join(' ')} ${tag.description || ''} ${(tag.categories || []).map(labelFor).join(' ')}`.toLowerCase();
    return terms.every(term => haystack.includes(term));
  });
  state.filtered.sort((a, b) => {
    if (state.sort === 'ko') return (a.ko || a.tag).localeCompare(b.ko || b.tag, 'ko');
    if (state.sort === 'tag') return a.tag.localeCompare(b.tag, 'en');
    return Number(b.count || 0) - Number(a.count || 0) || a.tag.localeCompare(b.tag);
  });
  $('resultCount').textContent = number(state.filtered.length);
  $('activeCategory').textContent = state.category ? labelFor(state.category).split(/\s*[/>]\s*/).slice(-1)[0] : '모든 태그';
  $('activeCategory').title = state.category ? labelFor(state.category) : '모든 태그';
  $('clearCategory').hidden = !state.category;
  $('tagList').replaceChildren();
  $('tagList').scrollTop = 0;
  state.shown = 0;
  if (!state.filtered.length) {
    const empty = node('div', 'list-state');
    empty.append(node('strong', '', '아직 찾는 태그가 없나요?'), node('p', '', '검색어를 줄이거나 다른 분류를 선택해 보세요.'));
    const reset = node('button', 'button quiet', '검색과 분류 초기화');
    reset.type = 'button';
    reset.onclick = () => { state.query = ''; $('tagSearch').value = ''; selectCategory(''); };
    empty.append(reset);
    $('tagList').append(empty);
    $('loadMoreTags').hidden = true;
  } else appendTags();
}

function appendTags() {
  const fragment = document.createDocumentFragment();
  const until = Math.min(state.filtered.length, state.shown + pageSize);
  for (let i = state.shown; i < until; i++) {
    const tag = state.filtered[i];
    const button = node('button', `tag-row${tag.tag === state.selected?.tag ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.tag = tag.tag;
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(tag.tag === state.selected?.tag));
    tagHint(button, tag.tag);
    const body = node('span', 'row-body');
    body.append(node('span', 'row-ko', tag.ko || tag.tag));
    if (tag.ko && tag.ko !== tag.tag) body.append(node('span', 'row-en', tag.tag));
    button.append(node('span', 'row-index', String(i + 1).padStart(2, '0')), body,
      node('span', 'row-count', number(tag.count)), node('span', 'row-arrow', '↗'));
    button.onclick = () => selectTag(tag.tag);
    fragment.append(button);
  }
  $('tagList').append(fragment);
  state.shown = until;
  $('loadMoreTags').hidden = state.shown >= state.filtered.length;
  $('loadMoreTags').textContent = `더 보기 (${number(state.filtered.length - state.shown)})`;
}

function selectTag(english) {
  const tag = state.byTag.get(english);
  if (!tag) return;
  const changed = state.selected?.tag !== tag.tag;
  state.selected = tag;
  host.querySelector('.workspace').classList.remove('browse-open');
  for (const pill of $('imageMatchedTags').querySelectorAll('.used-tag')) {
    pill.classList.toggle('selected', pill.dataset.helpTag === tag.tag);
  }
  if (host.dataset.layoutMode === 'narrow') setWorkbenchView('preview');
  updateBrowseButton();
  $('detailEmpty').hidden = true;
  $('tagDetail').hidden = false;
  $('detailKo').textContent = tag.ko || tag.tag;
  $('detailTag').textContent = tag.tag;
  $('detailTag').hidden = tag.ko === tag.tag;
  $('selectedLabel').textContent = tag.ko || tag.tag;
  $('pictureTag').textContent = tag.tag;
  $('pictureTag').hidden = tag.ko === tag.tag;
  $('detailCount').textContent = number(tag.count);
  $('detailDescription').textContent = tag.description || '아직 설명이 없습니다. 번역·분류 편집에서 나만의 설명을 추가해 보세요.';
  $('comboTabCount').textContent = number(tag.count);
  $('translationSource').textContent = ['user', '사용자 수정'].includes(tag.translation_source) ? '직접 편집한 항목' : tag.ko === tag.tag && !tag.description ? '원문 유지' : '한국어 태그 사전';
  $('detailCategories').replaceChildren();
  for (const category of tag.categories || []) {
    const pill = node('button', 'category-pill', labelFor(category).replace(/\s*[/]\s*/g, ' › '));
    pill.type = 'button';
    pill.onclick = () => selectCategory(category);
    $('detailCategories').append(pill);
  }
  for (const row of $('tagList').querySelectorAll('.tag-row')) {
    const active = row.dataset.tag === tag.tag;
    row.classList.toggle('active', active);
    row.setAttribute('aria-selected', String(active));
  }
  if (changed) {
    loadStatistics();
    resetRelated();
    state.comboController?.abort();
    state.comboOffset = 0;
    state.comboLoadedTag = '';
    state.comboLoading = false;
    $('combinationsList').replaceChildren();
    $('loadMoreCombinations').hidden = true;
    if (state.activeTab === 'combinations') loadCombinations();
    resetImages({ preserve: imageMatchesSelected(images.detail) });
    loadImages();
  }
}

function resetRelated() {
  related.controller?.abort();
  related.loading = false;
  related.loadedTag = '';
  related.items = [];
  related.expanded = false;
  $('relatedBasis').textContent = '원본 조합 기준';
  $('relatedTags').replaceChildren();
  $('showMoreRelated').hidden = true;
  if ($('relatedSection').open) loadRelated();
}

function renderRelated() {
  const fragment = document.createDocumentFragment();
  for (const item of related.items.slice(0, related.expanded ? 12 : 6)) {
    const button = node('button', 'related-tag');
    button.type = 'button';
    const percent = Number(item.percent || 0).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
    tagHint(button, item.tag);
    const label = node('span', 'related-label');
    label.append(node('span', 'related-ko', state.byTag.get(item.tag)?.ko || item.ko || item.tag), node('span', 'related-en', item.tag));
    const frequency = node('span', 'related-frequency');
    frequency.append(node('span', 'related-count', `${number(item.count)}회`), node('strong', 'related-percent', `${percent}%`));
    button.append(label, frequency);
    listen(button, 'click', () => selectTag(item.tag));
    fragment.append(button);
  }
  $('relatedTags').replaceChildren(fragment);
  if (!related.items.length) $('relatedTags').append(node('p', 'related-message', '이 태그와 함께 쓰인 다른 태그가 없습니다.'));
  $('showMoreRelated').hidden = related.expanded || related.items.length <= 6;
  $('showMoreRelated').textContent = `더 보기 (${number(Math.min(related.items.length, 12) - 6)}개)`;
}

function statisticCard(label, value, help = '') {
  const card = node('div', 'overview-stat-card');
  card.append(node('span', '', label), node('strong', '', value));
  if (help) card.append(node('small', '', help));
  return card;
}

function renderStatistics(result, append) {
  const overview = result.overview || {};
  const selected = result.selected;
  $('statisticsOverview').replaceChildren(
    statisticCard('원본 조합', number(overview.source_rows), '개 조합'),
    statisticCard('사전 태그', number(overview.visible_tags), '현재 표시하는 태그'),
    statisticCard('연결 이미지', number(overview.total_images), '프롬프트가 있는 이미지'),
    statisticCard('그림이 있는 태그', number(overview.linked_tags), '개 태그'),
    statisticCard('그림이 없는 태그', number(overview.unlinked_tags), '개 태그'),
    statisticCard('태그 이미지 연결률', percentLabel(overview.coverage_percent), '사전 태그 중 그림이 있는 비율')
  );
  if (selected && selected.tag === state.selected?.tag) {
    $('statCombinationCount').textContent = number(selected.combination_count);
    $('statCombinationPercent').textContent = percentLabel(selected.combination_percent);
    $('statRank').textContent = `${number(selected.rank)}위`;
    $('statImageCount').textContent = number(selected.image_count);
    $('statImagePercent').textContent = Number(overview.total_images) ? percentLabel(selected.image_percent) : '연결된 이미지 없음';
  }
  const sourceRows = Number(overview.source_rows);
  if (Number.isFinite(sourceRows) && sourceRows >= 0) state.sourceRows = sourceRows;
  $('statisticsDenominator').textContent = state.sourceRows === null
    ? '조합 비율의 원본 조합 수를 확인할 수 없습니다.'
    : `조합 비율은 원본 ${number(state.sourceRows)}개 조합 중 비율이며, 이미지 비율은 프롬프트가 있는 연결 이미지 중 비율입니다.`;
  if (!append) $('statisticsRanking').replaceChildren();
  for (const item of result.ranking || []) {
    const row = node('tr', item.tag === state.selected?.tag ? 'statistics-selected-row' : '');
    const rank = node('td', 'statistics-rank', `${number(item.rank)}위`);
    const tagCell = node('td');
    const tagButton = node('button', 'statistics-tag');
    tagButton.type = 'button';
    tagHint(tagButton, item.tag);
    tagButton.append(node('strong', '', state.byTag.get(item.tag)?.ko || item.ko || item.tag), node('span', '', item.tag));
    listen(tagButton, 'click', () => {
      selectTag(item.tag);
      $('tagDetail').scrollTop = 0;
    });
    tagCell.append(tagButton);
    const combos = node('td', 'statistics-value');
    combos.append(node('strong', '', `${number(item.combination_count)}회`), node('span', '', percentLabel(item.combination_percent)));
    const imageCount = node('td', 'statistics-value');
    imageCount.append(node('strong', '', `${number(item.image_count)}개`), node('span', '', percentLabel(item.image_percent)));
    row.append(rank, tagCell, combos, imageCount);
    $('statisticsRanking').append(row);
  }
  if (!append && !(result.ranking || []).length) {
    const emptyRow = node('tr');
    const emptyCell = node('td', 'statistics-empty', '표시할 태그 사용 통계가 없습니다.');
    emptyCell.colSpan = 4;
    emptyRow.append(emptyCell);
    $('statisticsRanking').append(emptyRow);
  }
  statistics.total = Number(result.total || 0);
  statistics.offset = Number(result.offset || 0) + (result.ranking || []).length;
  $('statisticsTotal').textContent = `${number(statistics.total)}개 태그`;
  $('moreStatistics').hidden = statistics.offset >= statistics.total;
  $('selectedStatisticsError').hidden = true;
}

async function loadStatistics(append = false) {
  statistics.controller?.abort();
  const controller = new AbortController();
  statistics.controller = controller;
  statistics.loading = true;
  const selected = state.selected?.tag || '';
  const offset = append ? statistics.offset : 0;
  const query = new URLSearchParams({ sort: statistics.sort, offset: String(offset), limit: '15' });
  if (selected) query.set('tag', selected);
  $('statisticsError').textContent = '';
  $('statisticsTotal').textContent = '통계 확인 중…';
  $('moreStatistics').disabled = true;
  if (!append) {
    for (const id of ['statCombinationCount', 'statCombinationPercent', 'statRank', 'statImageCount']) $(id).textContent = '—';
    $('statImagePercent').textContent = '비율 확인 중';
  }
  try {
    const result = await api('/api/daki/dictionary/statistics?' + query, { signal: controller.signal });
    if (statistics.controller !== controller || selected !== (state.selected?.tag || '')) return;
    renderStatistics(result, append);
  } catch (error) {
    if (error.name === 'AbortError' || statistics.controller !== controller) return;
    const retry = node('button', 'text-button', '다시 불러오기');
    retry.type = 'button';
    listen(retry, 'click', () => loadStatistics(append));
    $('statisticsError').replaceChildren(node('span', '', error.message), retry);
    $('selectedStatisticsError').textContent = '사용 통계를 불러오지 못했습니다. 상단 통계에서 다시 확인해 주세요.';
    $('selectedStatisticsError').hidden = false;
    $('statImagePercent').textContent = '통계 확인 필요';
  } finally {
    if (statistics.controller === controller) { statistics.loading = false; $('moreStatistics').disabled = false; }
  }
}

async function toggleStatistics(show) {
  $('statisticsPanel').hidden = !show;
  $('openStatistics').setAttribute('aria-expanded', String(show));
  if (show) {
    const workspace = host.querySelector('.workspace');
    workspace.classList.remove('browser-hidden');
    if (host.dataset.layoutMode === 'narrow') workspace.classList.add('browse-open');
    updateBrowseButton();
    await loadStatistics();
    const panel = $('statisticsPanel');
    const detail = host.querySelector('.detail-information');
    if (disposed || panel.hidden || $('tagDetail').hidden || !panel.isConnected) return;
    const detailBounds = detail.getBoundingClientRect();
    const panelBounds = panel.getBoundingClientRect();
    if (panelBounds.top < detailBounds.top || panelBounds.bottom > detailBounds.bottom) {
      detail.scrollTop += panelBounds.top - detailBounds.top;
    }
  }
}

async function loadRelated() {
  if (!state.selected || related.loading || related.loadedTag === state.selected.tag) return;
  const selected = state.selected.tag;
  const controller = new AbortController();
  related.controller = controller;
  related.loading = true;
  $('relatedTags').replaceChildren(node('p', 'related-message', '함께 쓰인 태그를 찾고 있습니다…'));
  try {
    const query = new URLSearchParams({ tag: selected, limit: '12' });
    const result = await api('/api/daki/dictionary/related?' + query, { signal: controller.signal });
    if (related.controller !== controller || selected !== state.selected?.tag) return;
    related.items = result.items || [];
    related.loadedTag = selected;
    $('relatedBasis').textContent = `${number(result.source_count)}개 조합 중`;
    $('relatedBasis').title = `원본 ${number(result.total_combinations)}개 조합에서 계산했습니다.`;
    renderRelated();
  } catch (error) {
    if (error.name === 'AbortError' || selected !== state.selected?.tag || related.controller !== controller) return;
    const message = node('p', 'related-message', error.message);
    const retry = node('button', 'text-button', '다시 불러오기');
    retry.type = 'button';
    listen(retry, 'click', loadRelated);
    $('relatedTags').replaceChildren(message, retry);
  } finally { if (related.controller === controller) related.loading = false; }
}

function selectTab(tab) {
  state.activeTab = tab;
  $('imagesTab').classList.toggle('active', tab === 'images');
  $('imagesTab').setAttribute('aria-selected', String(tab === 'images'));
  $('combinationsTab').classList.toggle('active', tab === 'combinations');
  $('combinationsTab').setAttribute('aria-selected', String(tab === 'combinations'));
  $('combinationsPanel').hidden = tab !== 'combinations';
  if (state.selected && images.loadedTag !== state.selected.tag && !images.loading) loadImages();
  if (tab === 'combinations' && state.selected && state.comboLoadedTag !== state.selected.tag && !state.comboLoading) loadCombinations();
}

function resetImages({ preserve = false } = {}) {
  if (!preserve) clearImageStage(images.status?.folder ? '이 태그가 포함된 그림을 찾고 있습니다…' : '이미지 폴더를 연결하면 해당 태그의 그림이 표시됩니다.');
  images.controller?.abort();
  images.loading = false;
  images.offset = 0;
  images.total = 0;
  images.loadedTag = '';
  $('loadMoreImages').hidden = true;
  $('imageGallery').replaceChildren();
  if (!images.status?.folder) {
    $('imageGallery').append(node('p', 'thumbnail-empty', '아직 연결된 이미지 폴더가 없습니다.'));
  }
  $('imageTabCount').textContent = images.status?.folder ? '—' : '미연결';
  $('thumbnailCount').textContent = '';
}

async function loadImages() {
  if (!state.selected || !images.status?.folder || images.loading) return;
  const selected = state.selected.tag;
  const offset = images.offset;
  images.loading = true;
  const controller = new AbortController();
  images.controller = controller;
  $('loadMoreImages').hidden = true;
  if (!offset) {
    const message = node('div', 'gallery-state');
    message.append(node('span', 'spinner'), node('p', '', '이 태그가 포함된 그림을 찾고 있습니다…'));
    $('imageGallery').replaceChildren(message);
  }
  try {
    const query = new URLSearchParams({ tag: selected, offset: String(offset), limit: '24' });
    const result = await api('/api/daki/dictionary/images?' + query, { signal: controller.signal });
    if (selected !== state.selected?.tag || images.controller !== controller) return;
    if (!offset) $('imageGallery').replaceChildren();
    for (const image of result.items) {
      const card = node('button', 'image-card');
      card.type = 'button';
      card.dataset.imageId = String(image.id);
      card.title = `${image.name} · ${image.width} × ${image.height}`;
      const portrait = node('span', 'image-card-portrait');
      const thumbnail = node('img');
      thumbnail.src = `/api/daki/dictionary/images/${encodeURIComponent(image.id)}/thumbnail`;
      thumbnail.alt = image.name;
      thumbnail.loading = 'lazy';
      thumbnail.decoding = 'async';
      listen(thumbnail, 'error', () => {
        portrait.replaceChildren(node('span', 'image-unavailable', '이미지를 읽을 수 없습니다.'));
      }, { once: true });
      portrait.append(thumbnail);
      card.append(portrait, node('span', 'image-card-name', image.name),
        node('span', 'image-card-size', `${image.width} × ${image.height}`));
      listen(card, 'click', () => {
        showImage(image.id, { scroll: !isDesktopLayout() });
      });
      $('imageGallery').append(card);
    }
    images.total = result.total;
    images.offset = offset + result.items.length;
    images.loadedTag = selected;
    $('imageTabCount').textContent = number(result.total);
    $('thumbnailCount').textContent = `${number(result.total)}개`;
    $('loadMoreImages').hidden = images.offset >= result.total;
    if (!result.total) {
      clearImageStage('이 태그가 포함된 그림이 아직 없습니다.');
      const empty = node('div', 'gallery-state');
      empty.append(node('strong', '', '이 태그가 포함된 그림이 아직 없습니다.'),
        node('p', '', images.status.scanning ? '폴더를 읽는 중입니다. 잠시 후 자동으로 갱신됩니다.' : '프롬프트에 정확히 같은 태그가 기록된 그림만 표시합니다.'));
      $('imageGallery').append(empty);
    } else if (!offset && result.items.length) {
      const first = result.items[0];
      if (imageMatchesSelected(images.detail)) {
        // Verify a preserved image still exists, even if it is outside the first page.
        showImage(images.detail.id, { scroll: false, preserve: true, fallbackId: first.id });
      } else showImage(first.id, { scroll: false });
    }
  } catch (error) {
    if (error.name === 'AbortError' || selected !== state.selected?.tag || images.controller !== controller) return;
    if (!images.detail) clearImageStage('그림 목록을 불러오지 못했습니다. 다시 불러오기를 눌러 주세요.');
    const failure = node('div', 'gallery-state');
    failure.append(node('p', '', error.message));
    const retry = node('button', 'button quiet', '다시 불러오기');
    retry.type = 'button';
    listen(retry, 'click', loadImages);
    failure.append(retry);
    if (!offset) $('imageGallery').replaceChildren(failure);
    else $('imageGallery').append(failure);
  } finally {
    if (images.controller === controller) images.loading = false;
  }
}

function renderImageStatus() {
  const status = images.status;
  if (!status?.folder) {
    $('imageConnectionTitle').textContent = '이미지 폴더를 연결해 보세요.';
    $('imageConnectionDescription').textContent = '압축을 푼 PNG·WebP 폴더를 지정하면 그림 속 프롬프트를 읽어 태그와 연결합니다.';
    $('openImageFolder').textContent = '폴더 연결';
    $('imageScanStatus').hidden = true;
    return;
  }
  $('imageConnectionTitle').textContent = status.scanning ? '이미지와 프롬프트를 읽고 있습니다.' : '이미지 폴더가 연결되어 있습니다.';
  $('imageConnectionDescription').textContent = status.folder;
  $('imageConnectionDescription').title = status.folder;
  $('openImageFolder').textContent = '폴더 변경';
  const area = $('imageScanStatus');
  area.hidden = false;
  area.replaceChildren();
  const summary = node('div', 'scan-summary');
  if (status.scanning) summary.append(node('span', 'spinner small'));
  summary.append(node('span', '', `${number(status.total_files)}개 파일 · ${number(status.indexed_images)}개 확인 · ${number(status.matched_images)}개 태그 연결`));
  const rescan = node('button', 'text-button', status.scanning ? '확인 중…' : '지금 새로고침 ↻');
  rescan.type = 'button';
  rescan.disabled = Boolean(status.scanning);
  listen(rescan, 'click', async () => {
    rescan.disabled = true;
    try { await api('/api/daki/dictionary/images/scan', { method: 'POST' }); await refreshImageStatus(); }
    catch (error) { toast(error.message); }
    finally { rescan.disabled = Boolean(images.status?.scanning); }
  });
  summary.append(rescan);
  area.append(summary);
  if (status.no_prompt || status.unreadable) area.append(node('p', 'scan-help',
    `프롬프트 없음 ${number(status.no_prompt)}개${status.unreadable ? ` · 읽기 실패 ${number(status.unreadable)}개` : ''}. 프롬프트가 없는 그림은 태그에 임의로 연결하지 않습니다.`));
  if (status.error) area.append(node('p', 'form-error', status.error));
}

async function refreshImageStatus() {
  clearTimeout(images.timer);
  if (!pageActive || document.visibilityState !== 'visible') return;
  images.statusController?.abort();
  const controller = new AbortController();
  images.statusController = controller;
  try {
    const previous = images.status;
    const status = await api('/api/daki/dictionary/images/status', { signal: controller.signal });
    if (images.statusController !== controller || !pageActive || document.visibilityState !== 'visible') return;
    images.status = status;
    renderImageStatus();
    const changed = previous?.folder !== status.folder || previous?.revision !== status.revision;
    if (changed) {
      loadStatistics();
      resetImages({ preserve: previous?.folder === status.folder && imageMatchesSelected(images.detail) });
      loadImages();
    }
  } catch (error) {
    if (error.name === 'AbortError' || images.statusController !== controller) return;
    const area = $('imageScanStatus');
    area.hidden = false;
    const message = node('p', 'scan-help', `이미지 연결 상태를 확인하지 못했습니다. ${error.message}`);
    const retry = node('button', 'text-button', '다시 확인');
    retry.type = 'button';
    listen(retry, 'click', refreshImageStatus);
    area.replaceChildren(message, retry);
  } finally {
    if (images.statusController === controller) {
      images.statusController = null;
      if (pageActive && document.visibilityState === 'visible') images.timer = setTimeout(refreshImageStatus, 10000);
    }
  }
}

function openFolderDialog() {
  $('folderPath').value = images.status?.folder || '';
  $('folderError').textContent = '';
  $('folderDialog').showModal();
  $('folderPath').focus();
}

async function pickImageFolder() {
  if (images.folderBusy) return;
  images.folderBusy = true;
  const button = $('pickImageFolder');
  button.disabled = true;
  $('saveFolder').disabled = true;
  button.textContent = '선택 중…';
  $('folderError').textContent = '';
  try {
    const result = await api('/api/daki/dictionary/images/pick-folder', { method: 'POST' });
    if (result.folder) $('folderPath').value = result.folder;
  } catch (error) { $('folderError').textContent = error.message; }
  finally { images.folderBusy = false; button.disabled = false; $('saveFolder').disabled = false; button.textContent = '찾아보기'; }
}

async function connectImageFolder(event) {
  event.preventDefault();
  if (images.folderBusy) return;
  const folder = $('folderPath').value.trim();
  if (!folder) return;
  images.folderBusy = true;
  $('saveFolder').disabled = true;
  $('saveFolder').textContent = '연결 중…';
  $('folderError').textContent = '';
  try {
    await api('/api/daki/dictionary/images/folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
    $('folderDialog').close();
    resetImages();
    await refreshImageStatus();
    toast('폴더를 연결했습니다. 그림을 확인하고 있습니다.');
  } catch (error) { $('folderError').textContent = error.message; }
  finally { images.folderBusy = false; $('saveFolder').disabled = false; $('saveFolder').textContent = '연결하기'; }
}

function imageMatchesSelected(image) {
  return Boolean(image && state.selected && [...(image.matched_tags || []), ...(image.used_tags || [])].includes(state.selected.tag));
}

function selectUsedTag(english) {
  if (!state.byTag.has(english)) return;
  const workspace = host.querySelector('.workspace');
  workspace.classList.remove('browser-hidden');
  updateBrowseButton();
  if (!state.filtered.some(tag => tag.tag === english)) {
    state.query = '';
    $('tagSearch').value = '';
    state.category = '';
    renderCategories();
    filterTags();
  }
  setBrowserTab('tags');
  selectTag(english);
  if (host.dataset.layoutMode === 'narrow') {
    workspace.classList.add('browse-open');
    updateBrowseButton();
  }
  const index = state.filtered.findIndex(tag => tag.tag === english);
  while (index >= state.shown && state.shown < state.filtered.length) appendTags();
  const list = $('tagList');
  const row = [...list.querySelectorAll('.tag-row')].find(item => item.dataset.tag === english);
  if (row) {
    const listBounds = list.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.top < listBounds.top) list.scrollTop += rowBounds.top - listBounds.top;
    else if (rowBounds.bottom > listBounds.bottom) list.scrollTop += rowBounds.bottom - listBounds.bottom;
  }
  host.querySelector('.detail-information').scrollTop = 0;
  row?.focus({ preventScroll: true });
}

function clearImageStage(message) {
  $('pictureOverlay').close();
  images.detailController?.abort();
  images.detail = null;
  $('imageViewer').hidden = false;
  $('imageFull').removeAttribute('src');
  $('togglePicture').disabled = true;
  $('importDictionaryDraft').disabled = true;
  $('imageStageMessage').textContent = message;
  $('imageStageMessage').hidden = false;
  $('imageName').textContent = '';
  $('imageDimensions').textContent = '';
  $('imageMatchedTags').replaceChildren(node('p', 'scan-help', '그림을 선택하면 사용 태그가 표시됩니다.'));
  $('usedTagCount').textContent = '';
  $('copyUsedTags').disabled = true;
  $('imageDetailError').textContent = '';
}

async function showImage(id, { scroll = false, preserve = false, fallbackId = null } = {}) {
  images.detailController?.abort();
  const controller = new AbortController();
  images.detailController = controller;
  const selected = state.selected?.tag;
  if (!preserve) {
    $('pictureOverlay').close();
    images.detail = null;
    $('imageName').textContent = '이미지를 불러오는 중…';
    $('imageDimensions').textContent = '';
    $('imageMatchedTags').replaceChildren();
    $('usedTagCount').textContent = '';
    $('copyUsedTags').disabled = true;
    $('imageFull').removeAttribute('src');
    $('togglePicture').disabled = true;
    $('importDictionaryDraft').disabled = true;
    $('imageStageMessage').textContent = '그림을 불러오고 있습니다…';
    $('imageStageMessage').hidden = false;
  }
  $('imageDetailError').textContent = '';
  $('imageViewer').hidden = false;
  if (scroll) setWorkbenchView('preview');
  try {
    const image = await api(`/api/daki/dictionary/images/${encodeURIComponent(id)}`, { signal: controller.signal });
    if (images.detailController !== controller || selected !== state.selected?.tag) return;
    if (!imageMatchesSelected(image)) {
      if (fallbackId !== null && String(fallbackId) !== String(id)) return showImage(fallbackId, { scroll: false });
      clearImageStage('이 태그가 포함된 그림이 아직 없습니다.');
      return;
    }
    images.detail = image;
    $('imageName').textContent = image.name;
    $('imageName').title = image.name;
    $('imageDimensions').textContent = `${image.width} × ${image.height}`;
    const fullUrl = `/api/daki/dictionary/images/${encodeURIComponent(id)}/file`;
    if ($('imageFull').getAttribute('src') !== fullUrl) {
      $('imageFull').src = fullUrl;
      const imageView = host.querySelector('#imageViewer .image-view');
      imageView.scrollLeft = 0;
      imageView.scrollTop = 0;
    }
    $('imageFull').alt = image.name;
    $('imageStageMessage').hidden = true;
    const usedTags = cleanUsedTags(image.used_tags || image.matched_tags || []);
    images.detail.used_tags = usedTags;
    $('usedTagCount').textContent = number(usedTags.length);
    $('copyUsedTags').disabled = !usedTags.length;
    $('imageMatchedTags').replaceChildren();
    for (const english of usedTags) {
      const tag = state.byTag.get(english);
      const pill = node('button', `used-tag${english === state.selected?.tag ? ' selected' : ''}`);
      pill.append(node('span', 'used-tag-ko', tag?.ko || english), node('span', 'used-tag-en', english));
      tagHint(pill, english);
      pill.type = 'button';
      listen(pill, 'click', () => selectUsedTag(english));
      $('imageMatchedTags').append(pill);
    }
    if (!usedTags.length) $('imageMatchedTags').append(node('p', 'scan-help', '이 그림에서 신체 사전 태그를 찾지 못했습니다.'));
    for (const card of $('imageGallery').querySelectorAll('.image-card')) card.classList.toggle('selected', card.dataset.imageId === String(id));
  } catch (error) {
    if (error.name === 'AbortError' || images.detailController !== controller || selected !== state.selected?.tag) return;
    if (fallbackId !== null && String(fallbackId) !== String(id)) return showImage(fallbackId, { scroll: false });
    clearImageStage('그림을 읽지 못했습니다. 다른 그림을 선택해 주세요.');
    const retry = node('button', 'text-button', '다시 불러오기');
    retry.type = 'button';
    listen(retry, 'click', () => showImage(id, { scroll: false, fallbackId }));
    $('imageDetailError').replaceChildren(node('span', '', error.message), retry);
  }
}

function cleanUsedTags(tags) {
  const styleTags = new Set(['digital illustration', 'depthness', 'flat color', 'simple illustration', 'high complexity',
    'official art', 'official style', 'best quality', 'amazing quality', 'very aesthetic', 'highres', 'muted color',
    'white haze', 'fine lineart', 'color trace', 'detailed eyes']);
  return [...new Set(tags)].filter(tag => typeof tag === 'string' && state.byTag.has(tag) &&
    !styleTags.has(tag.toLowerCase()) && !/censor/i.test(tag) && !/^(?:artist\s*:|year\s*:|\d{4}$)/i.test(tag));
}

function closeImageViewer() {
  $('imageGallery').querySelector('.image-card')?.focus({ preventScroll: true });
}

function closeBrowsePanel(restoreFocus = true) {
  host.querySelector('.workspace').classList.remove('browse-open');
  updateBrowseButton();
  if (restoreFocus) $('browseTagsMobile').focus({ preventScroll: true });
}

async function loadCombinations() {
  if (!state.selected || state.comboLoading) return;
  const selected = state.selected.tag;
  const offset = state.comboOffset;
  state.comboLoading = true;
  const controller = new AbortController();
  state.comboController = controller;
  $('loadMoreCombinations').hidden = true;
  if (!offset) {
    const loading = node('div', 'list-state');
    loading.append(node('span', 'spinner'), node('p', '', '이 태그가 쓰인 조합을 찾고 있습니다…'));
    $('combinationsList').replaceChildren(loading);
  }
  try {
    const query = new URLSearchParams({ tag: selected, offset: String(offset), limit: '12' });
    const result = await api('/api/daki/dictionary/combinations?' + query, { signal: controller.signal });
    if (selected !== state.selected?.tag || state.comboController !== controller) return;
    if (!offset) $('combinationsList').replaceChildren();
    state.comboTotal = result.total;
    for (let i = 0; i < result.items.length; i++) {
      const item = result.items[i];
      const card = node('div', 'combo-card');
      const head = node('div', 'combo-card-head');
      const copyButton = node('button', 'text-button', '조합 복사 ↗');
      copyButton.type = 'button';
      copyButton.onclick = () => copy(item.general);
      head.append(node('span', '', 'COMBINATION ' + String(offset + i + 1).padStart(3, '0')), copyButton);
      const tagContainer = node('div', 'combo-tags');
      for (const english of item.general.split(',').map(s => s.trim()).filter(Boolean)) {
        const knownTag = state.byTag.get(english);
        const pill = node('button', `combo-tag${english === selected ? ' selected' : ''}`, english);
        pill.type = 'button';
        tagHint(pill, english);
        pill.onclick = () => selectTag(english);
        tagContainer.append(pill);
      }
      card.append(head, tagContainer);
      $('combinationsList').append(card);
    }
    state.comboOffset = offset + result.items.length;
    state.comboLoadedTag = selected;
    $('comboTabCount').textContent = number(result.total);
    $('loadMoreCombinations').hidden = state.comboOffset >= result.total;
    if (!result.total) $('combinationsList').append(node('div', 'list-state', '이 태그가 쓰인 조합이 없습니다.'));
  } catch (error) {
    if (error.name === 'AbortError' || state.comboController !== controller) return;
    if (selected !== state.selected?.tag) return;
    const failure = node('div', 'list-state');
    failure.append(node('p', '', error.message));
    const retry = node('button', 'button quiet', '다시 불러오기');
    retry.type = 'button';
    retry.onclick = loadCombinations;
    failure.append(retry);
    if (!offset) $('combinationsList').replaceChildren(failure);
    else $('combinationsList').append(failure);
  } finally {
    if (state.comboController === controller) state.comboLoading = false;
  }
}

function openEditor() {
  if (!state.selected) return;
  $('editEnglish').textContent = state.selected.tag;
  $('editKo').value = state.selected.ko || '';
  $('editDescription').value = state.selected.description || '';
  $('editCategories').value = (state.selected.categories || []).map(labelFor).join('\n');
  $('editError').textContent = '';
  $('editDialog').showModal();
  $('editKo').focus();
}

async function saveEntry(event) {
  event.preventDefault();
  if (state.busy || !state.selected) return;
  const tag = state.selected.tag;
  const originalCategories = new Map((state.selected.categories || []).map(id => [labelFor(id), id]));
  const categoryIds = $('editCategories').value.split('\n').map(value => value.trim()).filter(Boolean).map(value => {
    if (originalCategories.has(value)) return originalCategories.get(value);
    const matching = state.categories.filter(category => category.label === value);
    return matching.length === 1 ? matching[0].id : value;
  });
  const data = { tag, ko: $('editKo').value.trim(), description: $('editDescription').value.trim(),
    categories: [...new Set(categoryIds)] };
  if (!data.ko || !data.categories.length) { $('editError').textContent = '한국어 이름과 분류를 하나 이상 입력해 주세요.'; return; }
  state.busy = true;
  $('saveEdit').disabled = true;
  $('saveEdit').textContent = '저장 중…';
  $('editError').textContent = '';
  try {
    const result = await api('/api/daki/dictionary/tags', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const updated = result.tag && typeof result.tag === 'object' ? result.tag : result;
    const index = state.tags.findIndex(item => item.tag === tag);
    const merged = { ...state.tags[index], ...updated, tag, translation_source: updated.translation_source || '사용자 수정' };
    state.tags[index] = merged;
    state.byTag.set(tag, merged);
    deriveCategories();
    if (state.category && !state.categories.some(category => category.id === state.category)) state.category = '';
    renderCategories();
    filterTags();
    selectTag(tag);
    $('editDialog').close();
    toast('사전 항목을 저장했습니다.');
  } catch (error) { $('editError').textContent = error.message; }
  finally { state.busy = false; $('saveEdit').disabled = false; $('saveEdit').textContent = '변경 저장'; }
}

async function init() {
  bootstrapController?.abort();
  const controller = new AbortController();
  bootstrapController = controller;
  try {
    const dictionary = await api('/api/daki/dictionary/dictionary', { signal: controller.signal });
    if (bootstrapController !== controller) return;
    if (!Array.isArray(dictionary.tags) || !Array.isArray(dictionary.categories)) throw new Error('사전 파일을 읽지 못했습니다.');
    state.tags = dictionary.tags;
    state.categories = dictionary.categories;
    state.byTag = new Map(state.tags.map(tag => [tag.tag, tag]));
    deriveCategories();
    $('tagCount').textContent = number(state.tags.length);
    const sourceRows = dictionary.source?.rows ?? dictionary.source?.row_count;
    const parsedRows = Number(sourceRows);
    state.sourceRows = sourceRows !== undefined && sourceRows !== null && Number.isFinite(parsedRows) && parsedRows >= 0 ? parsedRows : null;
    $('combinationCount').textContent = state.sourceRows === null ? '—' : number(state.sourceRows);
    renderCategories();
    filterTags();
    if (state.filtered.length) selectTag(state.filtered[0].tag);
    refreshImageStatus();
  } catch (error) {
    if (error.name === 'AbortError' || bootstrapController !== controller) return;
    $('categoryTree').replaceChildren(node('p', 'loading-text', '사전을 불러오지 못했습니다.'));
    const message = node('div', 'list-state');
    message.append(node('strong', '', '사전 연결을 확인해 주세요.'), node('p', '', error.message));
    const retry = node('button', 'button quiet', '다시 불러오기');
    retry.type = 'button'; retry.onclick = init;
    message.append(retry);
    $('tagList').replaceChildren(message);
  } finally {
    if (bootstrapController === controller) bootstrapController = null;
  }
}

listen($('tagSearch'), 'input', event => { state.query = event.target.value; filterTags(); });
listen($('categorySearch'), 'input', renderCategories);
listen($('sortTags'), 'change', event => { state.sort = event.target.value; filterTags(); });
listen($('allCategories'), 'click', () => selectCategory(''));
listen($('clearCategory'), 'click', () => selectCategory(''));
listen($('loadMoreTags'), 'click', appendTags);
listen($('tagList'), 'scroll', event => {
  const el = event.target;
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && state.shown < state.filtered.length) appendTags();
});
listen($('copyTag'), 'click', () => state.selected && copy(state.selected.tag));
listen($('imagesTab'), 'click', () => selectTab('images'));
listen($('combinationsTab'), 'click', () => selectTab('combinations'));
listen($('loadMoreCombinations'), 'click', loadCombinations);
listen($('relatedSection'), 'toggle', () => { if ($('relatedSection').open) loadRelated(); });
listen($('openStatistics'), 'click', () => toggleStatistics($('statisticsPanel').hidden));
listen($('browseTagsMobile'), 'click', toggleBrowser);
listen($('tagsBrowserTab'), 'click', () => setBrowserTab('tags'));
listen($('categoriesBrowserTab'), 'click', () => setBrowserTab('categories'));
for (const [buttonId, bodyId, label] of [
  ['toggleDictionaryEntry', 'dictionaryEntryBody', '사전 항목'],
  ['toggleDictionaryCategories', 'dictionaryCategoryBody', '태그 분류'],
]) {
  listen($(buttonId), 'click', () => {
    const collapsed = !$(bodyId).hidden;
    $(bodyId).hidden = collapsed;
    $(buttonId).setAttribute('aria-expanded', String(!collapsed));
    $(buttonId).replaceChildren(document.createTextNode(label + ' '));
    const icon = node('span', '', collapsed ? '+' : '−');
    icon.setAttribute('aria-hidden', 'true'); $(buttonId).appendChild(icon);
    if (bodyId === 'dictionaryEntryBody') $('tagDetail').classList.toggle('entry-collapsed', collapsed);
  });
}
listen($('showPreviewView'), 'click', () => setWorkbenchView('preview'));
listen($('showInspectorView'), 'click', () => setWorkbenchView('inspector'));
listen($('closeBrowse'), 'click', () => {
  if (isDesktopLayout()) {
    host.querySelector('.workspace').classList.add('browser-hidden');
    updateBrowseButton();
    $('browseTagsMobile').focus({ preventScroll: true });
  } else closeBrowsePanel();
});
listen($('closeStatistics'), 'click', () => toggleStatistics(false));
listen($('statisticsSort'), 'change', event => { statistics.sort = event.target.value; loadStatistics(); });
listen($('moreStatistics'), 'click', () => { if (!statistics.loading) loadStatistics(true); });
listen($('showMoreRelated'), 'click', () => { related.expanded = true; renderRelated(); });
listen($('editTag'), 'click', openEditor);
listen($('closeEdit'), 'click', () => !state.busy && $('editDialog').close());
listen($('cancelEdit'), 'click', () => !state.busy && $('editDialog').close());
listen($('editForm'), 'submit', saveEntry);
listen($('editDialog'), 'cancel', event => { if (state.busy) event.preventDefault(); });
listen($('headerImageFolder'), 'click', openFolderDialog);
listen($('openImageFolder'), 'click', openFolderDialog);
listen($('pickImageFolder'), 'click', pickImageFolder);
listen($('folderForm'), 'submit', connectImageFolder);
listen($('closeFolder'), 'click', () => !images.folderBusy && $('folderDialog').close());
listen($('cancelFolder'), 'click', () => !images.folderBusy && $('folderDialog').close());
listen($('folderDialog'), 'cancel', event => { if (images.folderBusy) event.preventDefault(); });
listen($('loadMoreImages'), 'click', loadImages);
async function copyImageText(button, value) {
  if (!value) return;
  const copied = await copy(value);
  if (!pageActive || !button.isConnected) return;
  button.textContent = copied ? '복사 완료 ✓' : '복사 실패';
  scheduleTimer(() => { if (button.isConnected) button.textContent = '사용 태그 복사 ↗'; }, 1800);
}
listen($('copyUsedTags'), 'click', event => copyImageText(event.currentTarget, images.detail?.used_tags?.join(', ')));
function openDictionaryDraft(image) {
  const tag = state.selected?.tag;
  if (!image || !tag || !imageMatchesSelected(image)) return;
  $('pictureOverlay').close();
  dictionaryDrafts?.show({imageId: image.id, tag});
}
listen($('importDictionaryDraft'), 'click', () => openDictionaryDraft(images.detail));
listen($('importDictionaryDraftOverlay'), 'click', () => openDictionaryDraft(images.detail));
listen($('imageFull'), 'load', () => {
  $('togglePicture').disabled = !images.detail;
  $('importDictionaryDraft').disabled = !dictionaryDrafts || !images.detail;
});
listen($('imageFull'), 'error', () => {
  $('togglePicture').disabled = true;
  $('importDictionaryDraft').disabled = true;
  const current = images.detail;
  if (!current || !$('imageFull').getAttribute('src')) return;
  const retry = node('button', 'text-button', '다시 불러오기');
  retry.type = 'button';
  listen(retry, 'click', () => showImage(current.id, { scroll: false }));
  $('imageDetailError').replaceChildren(node('span', '', '원본 그림을 읽지 못했습니다. 이미지 폴더와 파일을 확인한 뒤 다시 시도해 주세요.'), retry);
});

function pauseBackgroundWork() {
  pageActive = false;
  clearTimeout(images.timer);
  images.statusController?.abort();
  for (const controller of [bootstrapController, statistics.controller, related.controller, state.comboController,
    images.controller, images.detailController]) controller?.abort();
  for (const controller of activeRequests) controller.abort();
  for (const timer of deferredTimers) clearTimeout(timer);
  deferredTimers.clear();
  $('toast').classList.remove('visible');
}

function resumeBackgroundWork() {
  if (document.visibilityState !== 'visible') return;
  pageActive = true;
  refreshImageStatus();
  if (state.selected) {
    if (!$('statisticsPanel').hidden) loadStatistics();
    if (images.loadedTag !== state.selected.tag) loadImages();
    if (state.activeTab === 'combinations' && state.comboLoadedTag !== state.selected.tag) loadCombinations();
  }
}

listen(document, 'visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearTimeout(images.timer);
    images.statusController?.abort();
  } else resumeBackgroundWork();
});
listen(root, 'pagehide', pauseBackgroundWork);
listen(root, 'pageshow', resumeBackgroundWork);
listen(document, 'keydown', event => {
  const target = event.target;
  if (!host.contains(target)) return;
  const workspace = host.querySelector('.workspace');
  if (event.key === 'Escape' && !host.querySelector('dialog[open]') && workspace.classList.contains('browse-open')) {
    event.preventDefault();
    closeBrowsePanel();
    return;
  }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) && !host.querySelector('dialog[open]')) {
    event.preventDefault();
    if (isDesktopLayout()) {
      workspace.classList.remove('browser-hidden');
      updateBrowseButton();
    } else {
      workspace.classList.add('browse-open');
      updateBrowseButton();
    }
    $('tagSearch').focus();
  }
});
listen($('togglePicture'), 'click', openPictureOverlay);
listen(root, 'resize', positionPictureOverlay);
listen(document, 'scroll', positionPictureOverlay, true);
listen(document, 'keydown', event => {
  if (event.key === 'Escape' && $('pictureOverlay').open) {
    event.preventDefault();
    $('pictureOverlay').close();
  }
});
listen($('closePictureOverlay'), 'click', () => $('pictureOverlay').close());
listen($('pictureOverlay'), 'click', event => {
  if (event.target === $('pictureOverlay')) $('pictureOverlay').close();
});
listen($('pictureOverlay'), 'close', () => {
  $('togglePicture').setAttribute('aria-expanded', 'false');
  $('pictureOverlayImage').removeAttribute('src');
});
listen($('pictureOverlayImage'), 'error', () => {
  if ($('pictureOverlay').open) $('pictureOverlayError').hidden = false;
});
listen($('toggleDictionaryHeader'), 'click', () => setHeaderCollapsed(!host.classList.contains('headers-collapsed')));
setHeaderCollapsed(false);

const tagHints = installTagHints();
if (typeof root.ResizeObserver === 'function') {
  resizeObserver = new root.ResizeObserver(() => { updateLayoutMode(); positionPictureOverlay(); });
  resizeObserver.observe(host);
} else listen(root, 'resize', updateLayoutMode);
updateLayoutMode();
init();
const dictionaryImagePack = root.DakiDictionaryDownload?.mount(host, { onInstalled: () => refreshImageStatus() });

const handle = {
  dispose() {
    if (disposed) return;
    disposed = true;
    pauseBackgroundWork();
    dictionaryImagePack?.dispose();
    dictionaryDrafts?.dispose();
    resizeObserver?.disconnect();
    tagHints.hide();
    tagHints.remove();
    for (const dialog of host.querySelectorAll('dialog[open]')) dialog.close();
    for (const disposeListener of [...listenerDisposers]) disposeListener();
    if (host.__dakiDictionaryMount === handle) delete host.__dakiDictionaryMount;
  }
};
host.__dakiDictionaryMount = handle;
return handle;
}

root.DakiDictionaryWorkbench = { mount };
const standaloneRoot = root.document?.body?.classList?.contains('daki-dictionary-standalone')
  ? root.document?.querySelector?.('.daki-dictionary-tool')
  : null;
if (standaloneRoot) root.DakiDictionaryWorkbench.mount(standaloneRoot);
})(window);
