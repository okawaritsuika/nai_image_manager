/* The two workspaces read one canonical library; source collection stays an archive. */
(() => {
  const doc = document;
  const tab = doc.querySelector('[data-tab="arca-style-collector"]');
  const view = doc.getElementById('arca-style-collector-tab');
  if (!tab || !view) return;
  const state = {styles: [], warnings: [], query: '', source: 'artist', family: 'all', model: 'all', limit: 60, loading: false, version: 0};
  let mounted = false, gallery, status, count, search, source, family, model, more, dialog, detailBody, previousFocus;
  const el = (tag, text, cls) => {
    const node = doc.createElement(tag);
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const button = (text, action, cls = '') => {
    const node = el('button', text, cls); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const proxy = (style, full = false) => '/style-workspace/api/naim-shared-library/' + encodeURIComponent(style.id) + '/preview' + (full ? '?full=1' : '');
  const validStyle = style => style && /^common-[a-f0-9]{24}$/.test(style.id);
  const modelFamilyOf = style => {
    const explicit = String(style?.model_family || '').trim().toLowerCase();
    if (['v5', 'v4_5', 'other'].includes(explicit)) return explicit;
    const value = String(style?.model || '');
    if (/\bnai-diffusion-4-5-/i.test(value) || /\bnovelai\s+diffusion\s+v4\.5\b/i.test(value) || /^v4\.5\b/i.test(value)) return 'v4_5';
    if (/\bnai-diffusion-5-/i.test(value) || /\bnovelai\s+diffusion\s+v5\b/i.test(value) || /^v5\b/i.test(value)) return 'v5';
    return 'other';
  };
  const sourceLibraryOf = style => style?.source_library || 'naim';
  const filteredStyles = (styles, query, selectedModel, selectedSource = 'all', selectedFamily = 'all') => {
    const needle = String(query || '').trim().toLocaleLowerCase();
    return styles.filter(style => validStyle(style) && (selectedModel === 'all' || style.model === selectedModel)
      && (selectedSource === 'all' || sourceLibraryOf(style) === selectedSource)
      && (selectedFamily === 'all' || modelFamilyOf(style) === selectedFamily)
      && (!needle || [style.name, style.positive, style.negative, style.source_url].some(value => String(value || '').toLocaleLowerCase().includes(needle))));
  };
  const modelsForFilters = (styles, selectedSource = 'all', selectedFamily = 'all') => [...new Set(
    filteredStyles(styles, '', 'all', selectedSource, selectedFamily)
      .map(style => style.model)
      .filter(value => typeof value === 'string' && value)
  )];
  async function request(url, options) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '공용 그림체를 불러오지 못했습니다.');
    return data;
  }
  function closeDetail() { dialog.close(); previousFocus?.focus(); }
  async function exclude(style) {
    closeDetail();
    const message = '이 그림체를 NAIM과 그림체 관리의 공용 목록에서 제외합니다. 원본 이미지와 저장된 테스트·월드컵은 보존합니다.';
    const confirmed = globalThis.appDialog?.confirm
      ? await globalThis.appDialog.confirm({title:'공용 목록에서 제외', message, confirmLabel:'목록에서 제외'})
      : window.confirm(message);
    if (!confirmed) return;
    try {
      await request('/style-workspace/api/naim-shared-library/exclude', {method:'POST', headers:{'Content-Type':'application/json', 'X-NAIM-Workspace':'1'}, body:JSON.stringify({style_ids:[style.id]})});
      await load(true);
    } catch (error) { status.textContent = error.message; }
  }
  function showDetail(style, trigger) {
    previousFocus = trigger;
    detailBody.replaceChildren();
    doc.getElementById('naimSharedDetailTitle').textContent = style.name || '공유 그림체';
    const image = el('img'); image.src = proxy(style, true); image.alt = style.name || '공유 그림체';
    image.addEventListener('error', () => { image.hidden = true; });
    detailBody.append(image);
    const information = el('div', null, 'naim-shared-detail-info');
    information.append(el('p', [style.model, style.preview?.width && style.preview?.height ? `${style.preview.width} × ${style.preview.height}` : ''].filter(Boolean).join(' · ')));
    const source = String(style.source_url || '');
    if (/^https?:\/\//i.test(source)) {
      const link = el('a', '원문 보기'); link.href = source; link.target = '_blank'; link.rel = 'noopener noreferrer'; information.append(link);
    }
    for (const [label, value] of [['그림체 프롬프트', style.positive], ['네거티브', style.negative]]) {
      information.append(el('h3', label), el('pre', value || '없음'));
    }
    const options = style.options || {};
    const settings = [['Steps', options.steps], ['CFG', options.cfg ?? options.scale], ['샘플러', options.sampler], ['스케줄러', options.noise_schedule], ['Rescale', options.cfg_rescale], ['원본 시드', style.seed]];
    information.append(el('h3', '생성 설정'), el('pre', settings.filter(([,value]) => value != null).map(([key,value]) => `${key}: ${value}`).join('\n') || '설정 없음'));
    information.append(button('공용 목록에서 제외', () => exclude(style), 'ghost'));
    detailBody.append(information);
    dialog.dataset.styleId=style.id; dialog.showModal();
  }
  function render() {
    const visible = filteredStyles(state.styles, state.query, state.model, state.source, state.family);
    count.textContent = `${visible.length.toLocaleString()}개 / 전체 ${state.styles.length.toLocaleString()}개`;
    gallery.replaceChildren();
    for (const style of visible.slice(0, state.limit)) {
      const card = button('', () => showDetail(style, card), 'naim-shared-card');
      const image = el('img'); image.alt = ''; image.loading = 'lazy';
      if (style.available === false) { image.hidden=true; card.classList.add('image-missing'); }
      else image.src = proxy(style);
      image.addEventListener('error', () => { image.hidden = true; card.classList.add('image-missing'); });
      card.append(image, el('strong', style.name || '공유 그림체'), el('small', style.model || '모델 미상'));
      gallery.append(card);
    }
    more.hidden = visible.length <= state.limit;
    const emptyMessage = visible.length ? '' : state.styles.length ? '검색 조건에 맞는 그림체가 없습니다.' : '아직 공유 그림체가 없습니다. 아래에서 수집하거나 설치해 주세요.';
    status.textContent = [emptyMessage,...state.warnings].filter(Boolean).join(' ');
  }
  function mount() {
    if (mounted) return;
    mounted = true;
    tab.textContent = '공유 그림체';
    view.classList.add('naim-common-library-view');
    const archive = el('details', null, 'naim-source-archive');
    archive.open = true;
    const archiveBody = el('div', null, 'naim-source-archive-content');
    archive.append(el('summary', '공유 그림체 수집 및 조회'));
    archive.append(el('p', '아래는 수집 원문과 이미지 설치를 관리하는 영역입니다. 공유 그림체는 위에서 출처별로 확인할 수 있습니다.', 'help-text'));
    while (view.firstChild) archiveBody.append(view.firstChild);
    archive.append(archiveBody);
    archive.addEventListener('toggle', () => { if (!archive.open) void load(true); });
    const head = el('div', null, 'naim-shared-head');
    const heading = el('div'); heading.append(el('h2','그림체 관리 공유 그림체'), el('p','출처와 원본 모델을 골라 확인하세요.'));
    count = el('span'); count.id = 'naimSharedCount';
    head.append(heading, button('새로고침', () => load(true)));
    const libraryPanel = el('details', null, 'naim-shared-library-panel');
    const librarySummary = el('summary');
    librarySummary.append(el('span', '공유 그림체 갤러리'), count);
    libraryPanel.append(librarySummary);
    const controls = el('div', null, 'naim-shared-controls');
    const searchLabel = el('label', '검색'); search = el('input'); search.type = 'search'; search.placeholder = '그림체 이름·작가·태그'; search.id='naimSharedSearch'; searchLabel.append(search);
    const sourceLabel = el('label', '출처'); source = el('select'); source.id='naimSharedSource';
    for (const [value, label] of [['all','전체 출처'], ['naim','기존 공유 그림체'], ['artist','그림체 관리 공유 그림체']]) {
      const option=el('option',label); option.value=value; source.append(option);
    }
    source.value=state.source; sourceLabel.append(source);
    const familyLabel = el('label', '원본 모델'); family = el('select'); family.id='naimSharedFamily';
    for (const [value, label] of [['all','전체 원본 모델'], ['v5','V5'], ['v4_5','V4.5'], ['other','기타·모델 미확인']]) {
      const option=el('option',label); option.value=value; family.append(option);
    }
    family.value=state.family; familyLabel.append(family);
    const modelLabel = el('label', '세부 모델'); model = el('select'); model.id = 'naimSharedModel'; modelLabel.append(model);
    search.addEventListener('input', () => { state.query=search.value; state.limit=60; render(); });
    const resetModelFilter = () => {
      state.model='all'; model.value='all'; updateModelOptions(); state.limit=60; render();
    };
    source.addEventListener('change', () => { state.source=source.value; resetModelFilter(); });
    family.addEventListener('change', () => { state.family=family.value; resetModelFilter(); });
    model.addEventListener('change', () => { state.model=model.value; state.limit=60; render(); });
    controls.append(searchLabel, sourceLabel, familyLabel, modelLabel);
    status = el('p', '', 'naim-shared-status'); status.setAttribute('role','status');
    gallery = el('div', null, 'naim-shared-gallery'); gallery.id='naimSharedGallery';
    more = button('더 보기', () => { state.limit+=60; render(); }); more.hidden=true;
    libraryPanel.append(controls, status, gallery, more);
    view.append(head, libraryPanel, archive);
    dialog = el('dialog', null, 'naim-shared-dialog'); dialog.id='naimSharedDetail'; dialog.setAttribute('aria-labelledby','naimSharedDetailTitle');
    const detailHead = el('header'); const title = el('h2'); title.id='naimSharedDetailTitle';
    detailHead.append(title, button('닫기', closeDetail)); detailBody=el('div', null,'naim-shared-detail-body');
    dialog.append(detailHead,detailBody); dialog.addEventListener('cancel', () => previousFocus?.focus()); doc.body.append(dialog);
  }
  function updateModelOptions() {
    if (!model) return;
    model.replaceChildren();
    for (const value of ['all', ...modelsForFilters(state.styles, state.source, state.family)]) {
      const option=el('option', value==='all'?'전체 모델':value); option.value=value; model.append(option);
    }
    if (![...model.options].some(option=>option.value===state.model)) state.model='all';
    model.value=state.model;
  }
  async function load(force=false, silent=false) {
    if (state.loading) return;
    state.loading=true;
    const version=++state.version;
    if (status && !silent) status.textContent='공용 그림체를 불러오는 중…';
    try {
      const data = await request('/style-workspace/api/naim-shared-library' + (force?'?refresh=1':''));
      if (data.enabled === false) return;
      mount();
      if (version !== state.version) return;
      const nextStyles=Array.isArray(data.styles)?data.styles.filter(validStyle):[];
      const nextWarnings=Array.isArray(data.warnings)?data.warnings.filter(value=>typeof value==='string'):[];
      if (silent && !state.failed && JSON.stringify([nextStyles,nextWarnings]) === JSON.stringify([state.styles,state.warnings])) return;
      state.failed=false;
      state.styles=nextStyles;
      if (dialog.open && !state.styles.some(style=>style.id===dialog.dataset.styleId)) closeDetail();
      state.warnings=Array.isArray(data.warnings)?data.warnings.filter(value=>typeof value==='string'):[];
      updateModelOptions(); render();
    } catch(error) {
      state.failed=true; mount(); status.textContent=error.message; if (!silent) { gallery.replaceChildren(); count.textContent='연결 확인 필요'; }
    } finally { state.loading=false; }
  }
  const refreshVisible = () => { if (!doc.hidden && view.classList.contains('active')) void load(true, true); };
  if (typeof window !== 'undefined') {
    const syncTimer = setInterval(refreshVisible, 2000);
    doc.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('pagehide', () => clearInterval(syncTimer));
  }
  tab.addEventListener('click', () => load(true));
  if (view.classList.contains('active')) void load();
  if (typeof module !== 'undefined') module.exports={filteredStyles, validStyle, modelFamilyOf, sourceLibraryOf, modelsForFilters};
})();
