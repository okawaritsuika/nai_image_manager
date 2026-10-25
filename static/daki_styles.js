/* Shared style comparisons and generation/output settings inside the gallery. */
(function (root) {
    'use strict';
    const doc = root.document;
    const baseHash = '#daki&library=shared';
    const mediumModel = 'nai-diffusion-5-full-medium';
    const models = {'nai-diffusion-5-full': 'NovelAI V5 Full', [mediumModel]: 'NovelAI V5 Full Medium',
        'nai-diffusion-4-5-full': 'NovelAI V4.5 Full'};
    const mediumNote = 'Medium: 14 스텝 · Euler Ancestral · Karras 고정. CFG Rescale과 그림체·공통·캐릭터 네거티브는 적용되지 않으며 모델의 고정 네거티브를 사용합니다.';
    let revision = 0;
    let pollTimer;
    let settingsDialog;
    let viewFilters;
    let draft = {model: 'nai-diffusion-5-full', output_format: 'webp', prompt: '', negative_prompt: '', char_prompts: []};
    const byId = id => doc.getElementById(id);
    const node = (tag, className, text) => {
        const el = doc.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '요청을 처리하지 못했습니다.');
        return result;
    }
    function leave() {
        revision++; root.clearTimeout(pollTimer);
        viewFilters?.dispose(); viewFilters = null;
        if (settingsDialog?.open) settingsDialog.close();
        root.DakiTestLibrary?.leave(); root.DakiTestPacks?.leave(); root.DakiWorldCup?.leave?.(); root.DakiStyleSync?.leave();
    }
    function current(token) { return token === revision && root.Daki.isActive(); }
    function heading(title, subtitle, backHref, backText) {
        byId('dakiTitle').textContent = title;
        byId('dakiSubtitle').textContent = subtitle;
        const back = byId('dakiBack');
        back.hidden = false; back.href = backHref; back.textContent = backText;
    }
    function sharedStyleSubtitle(category, count) {
        const detail = category === 'upper' ? '실사 표현이 있는 그림체 제외' : 'V5 원본 공유 그림체';
        return `${count}개 그림체 · ${detail}`;
    }
    function button(text, action) {
        const el = node('button', 'nav-btn', text);
        el.type = 'button'; el.onclick = action;
        return el;
    }
    function picture(src, name, full = src + '?full=1') {
        const img = node('img', 'zoomable'); img.src = src; img.alt = name; img.loading = 'lazy';
        img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', name + ' 크게 보기');
        img.onclick = event => {
            if (event.defaultPrevented || root.consumeGalleryRadialTagClick?.(event)) return;
            event.preventDefault(); root.openZoom?.(full);
        };
        img.onkeydown = event => { if (['Enter', ' '].includes(event.key)) img.onclick(event); };
        return img;
    }
    function sourceLink(style) {
        try {
            const url = new URL(style.source_url);
            const post = url.pathname.match(/^\/b\/([A-Za-z0-9_-]+)\/(\d+)\/?$/);
            if (url.protocol === 'https:' && url.hostname === 'arca.live' && !url.username && !url.password && post) {
                const link = node('a', 'daki-style-source', `아카라이브 · ${post[1]} #${post[2]} ↗`);
                link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
                link.title = url.href;
                link.setAttribute('aria-label', `${style.name} 출처: 아카라이브 ${post[1]} 글 ${post[2]} (새 탭)`);
                return link;
            }
        } catch (_) { /* Older catalogs may not have a source URL. */ }
        return node('span', 'daki-style-source', '출처 정보 없음');
    }
    function recommendationCount(style) {
        const value = style.recommendation_count;
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    function sourceInfo(style) {
        const origin = node('div', 'daki-style-origin');
        const count = recommendationCount(style);
        const votes = node('span', 'daki-style-votes', count === null ? '추천수 정보 없음' : `👍 추천 ${count.toLocaleString('ko-KR')}`);
        const collected = new Date(style.recommendation_collected_at || '');
        votes.title = count === null ? '수집된 추천수가 없습니다.' : '수집 당시 추천수' +
            (Number.isNaN(collected.getTime()) ? '' : ` · ${collected.toLocaleString('ko-KR')}`);
        origin.append(sourceLink(style), votes);
        return origin;
    }
    function styleCard(style) {
        const card = node('article', 'item-box daki-style-card');
        const label = node('div', 'gallery-card-actions daki-image-actions');
        const settings = button('원본 설정', () => showStyle(style.id)); settings.className = 'gallery-card-action-btn';
        label.append(node('span', '', style.name), settings, sourceInfo(style));
        const img = picture(style.src, style.name);
        card.append(img, label);
        root.Daki.bindImage(card, img, `__daki_shared__/${style.id}.png`);
        return card;
    }
    async function showStyle(id) {
        const dialog = node('dialog', 'daki-dialog daki-style-detail');
        dialog.setAttribute('aria-labelledby', 'dakiStyleTitle');
        const header = node('header', 'daki-style-detail-header');
        const identity = node('div');
        const title = node('h2', '', '그림체 원본 설정');
        title.id = 'dakiStyleTitle';
        identity.append(node('span', 'daki-style-eyebrow', '그림체 원본 설정'), title);
        header.append(identity, button('닫기', () => dialog.close()));
        const status = node('p', '', '불러오는 중…');
        status.setAttribute('role', 'status');
        dialog.append(header, status);
        dialog.addEventListener('close', () => dialog.remove(), {once: true});
        doc.body.appendChild(dialog); dialog.showModal();
        try {
            const {style} = await api('/api/daki/shared-styles/' + encodeURIComponent(id));
            if (!dialog.open) return;
            title.textContent = style.name;
            status.remove();
            identity.appendChild(sourceInfo(style));
            const options = style.options || {};
            const samplers = {'k_euler_ancestral': 'Euler Ancestral', 'k_euler': 'Euler',
                'k_dpmpp_2s_ancestral': 'DPM++ 2S Ancestral', 'k_dpmpp_2m': 'DPM++ 2M', 'k_dpmpp_sde': 'DPM++ SDE'};
            const valueText = value => value === true ? '켜짐' : value === false ? '꺼짐' : value == null ? '정보 없음' : String(value);
            function settingGrid(entries, className) {
                const list = node('dl', className);
                entries.forEach(([name, value]) => {
                    const cell = node('div'); cell.append(node('dt', '', name), node('dd', '', valueText(value))); list.appendChild(cell);
                });
                return list;
            }
            dialog.appendChild(settingGrid([
                ['모델', models[style.model] || style.model], ['크기', `${style.preview.width} × ${style.preview.height}`],
                ['스텝', options.steps], ['CFG', options.cfg], ['샘플러', samplers[options.sampler] || options.sampler],
                ['노이즈 스케줄', options.noise_schedule],
            ], 'daki-style-summary'));
            const prompts = node('section', 'daki-style-prompts');
            const tablist = node('div', 'daki-style-tabs');
            tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', '프롬프트 종류');
            const tabs = [['base', 'Base', style.positive], ['nega', 'Nega', style.negative]].map(([key, label, value], index) => {
                const tab = button(label, () => activate(index));
                tab.id = 'dakiStyleTab-' + key; tab.setAttribute('role', 'tab');
                const panel = node('div', 'daki-style-prompt-panel');
                panel.id = 'dakiStylePanel-' + key; panel.tabIndex = 0;
                panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
                tab.setAttribute('aria-controls', panel.id);
                panel.appendChild(node('pre', '', value || '입력된 프롬프트가 없습니다.'));
                tab.onkeydown = event => {
                    const target = ({ArrowLeft: (index + 1) % 2, ArrowRight: (index + 1) % 2, Home: 0, End: 1})[event.key];
                    if (target === undefined) return;
                    event.preventDefault(); activate(target); tabs[target].tab.focus();
                };
                tablist.appendChild(tab); return {tab, panel};
            });
            function activate(index) {
                tabs.forEach(({tab, panel}, i) => {
                    tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1;
                    panel.hidden = i !== index;
                });
            }
            prompts.append(tablist, ...tabs.map(item => item.panel)); activate(0); dialog.appendChild(prompts);
            const advanced = node('details', 'daki-style-advanced');
            advanced.appendChild(node('summary', '', '세부 설정'));
            const labels = {cfg_rescale: 'CFG Rescale', deliberate_euler_ancestral_bug: 'Euler Ancestral 호환 모드',
                prefer_brownian: 'Brownian 노이즈', dynamic_thresholding: '동적 임계값',
                legacy_v3_extend: 'V3 레거시 확장', strength: '강도', noise: '노이즈'};
            const extra = Object.entries(options).filter(([key]) => !['steps', 'cfg', 'sampler', 'noise_schedule'].includes(key))
                .map(([key, value]) => [labels[key] || key, value]);
            extra.push(['원본 이미지 시드', style.seed]);
            advanced.append(settingGrid(extra, 'daki-style-settings-grid'), node('p', '', '원본 이미지의 정보입니다. 새 테스트의 시드는 매번 무작위로 생성됩니다.'));
            dialog.appendChild(advanced);
        } catch (error) { if (dialog.open) status.textContent = error.message; }
    }
    function savedBatchCard(batch) {
        const href = '#daki&library=' + (batch.library === 'personal' ? 'personal' : 'shared');
        const card = root.Daki.folderCard(batchLabel(batch), href + '&batch=' + encodeURIComponent(batch.id), batch.completed,
            `${batch.completed}/${batch.total}장 완료 · ${statusLabel(batch.status)}`, batch.cover_src);
        card.classList.add('daki-test-record');
        return card;
    }
    function batchLabel(batch) {
        if (batch.name?.trim()) return batch.name;
        const date = new Date(batch.created_at);
        return Number.isNaN(date.getTime()) ? '그림체 테스트' : date.toLocaleString('ko-KR') + ' 테스트';
    }
    function statusLabel(status) {
        return ({ready:'준비됨', running:'생성 중', stopping:'현재 그림 완료 후 중지', converting:'WebP 변환 중', paused:'대기 중', completed:'완료', failed:'오류로 중지', pending:'대기 중'})[status] || status;
    }
    async function render(params, container) {
        leave();
        const token = revision;
        const status = byId('dakiPageStatus');
        try {
            if (params.get('batch')) {
                await renderBatch(params.get('batch'), container, token);
                return;
            }
            if (params.get('category') === 'upper') {
                status.textContent = '기존 상반신 결과를 테스트로 불러오는 중…';
                const {batch} = await api('/api/daki/style-tests/upper', 'POST', {});
                if (!current(token)) return;
                await renderBatch(batch.id, container, token, batch);
                return;
            }
            const catalog = await api('/api/daki/shared-styles');
            if (!current(token)) return;
            status.textContent = '';
            const category = params.get('category');
            if (!['all', 'upper', 'v5'].includes(category)) {
                heading('공유 그림체', '기본 폴더 · 공유 그림체 목록과 테스트', '#daki', '← daki 프로젝트');
                const toolbar = node('div', 'daki-style-toolbar');
                const sharedCatalog = {...catalog, styles: catalog.styles.filter(style => style.category === 'v5')};
                const create = button('전체 그림체로 테스트 만들기', () => openSettings(sharedCatalog));
                create.disabled = !sharedCatalog.styles.length;
                toolbar.appendChild(create);
                toolbar.appendChild(button('공유 테스트 다운로드', () => root.DakiTestPacks?.open({onComplete: async job => {
                    if (!current(token) || !job.installed) return;
                    try { await loadBatches(); }
                    catch (error) { if (current(token)) status.textContent = error.message; }
                }})));
                toolbar.appendChild(button('공유 그림체 최신화', () => root.DakiStyleSync.open({onComplete: async job => {
                    if (!current(token)) return;
                    container.replaceChildren();
                    const reloading = render(params, container), reloadToken = revision;
                    await reloading;
                    if (!current(reloadToken)) return;
                    if (job.source === 'huggingface') {
                        if (job.published === true) {
                            const prefix = job.status === 'failed' ? '공유 그림체 최신화 실패 · 카탈로그 반영'
                                : job.status === 'stopped' ? '공유 그림체 최신화 중지 · 카탈로그 반영' : '공유 그림체 최신화';
                            const updates = job.updated > 0 ? ` · 갱신 ${job.updated}` : '';
                            status.textContent = `${prefix} · 추가 ${job.added || 0}${updates} · 필터 제외 ${job.filtered || 0} · 건너뜀 ${job.skipped || 0}`;
                        } else if (job.published === false && (job.status === 'failed' || job.status === 'stopped')) {
                            status.textContent = `공유 그림체 최신화 ${job.status === 'failed' ? '실패' : '중지'} · 기존 목록 유지`;
                        } else if (job.status === 'failed' || job.status === 'stopped') {
                            status.textContent = `공유 그림체 최신화 ${job.status === 'failed' ? '실패' : '중지'} · 반영 여부 확인 불가`;
                        } else if (job.published === false) {
                            status.textContent = '공유 그림체 최신화 · 기존 목록 유지';
                        } else {
                            status.textContent = '공유 그림체 최신화 · 반영 여부 확인 불가';
                        }
                    } else {
                        const filtered = job.filtered !== undefined ? ` · 필터 제외 ${job.filtered || 0}` : '';
                        status.textContent = `공유 그림체 최신화 · 추가 ${job.added || 0}${filtered} · 건너뜀 ${job.skipped || 0}`;
                    }
                    if (job.post_limited > 0) status.textContent += ` · 게시물 제한 ${job.post_limited}`;
                }})));
                container.appendChild(toolbar);
                const folders = [['all', '그림체 일람'], ['upper', '상반신']].map(([id, name]) => {
                    const styles = id === 'all' ? catalog.styles.filter(style => (style.category || 'upper') === 'v5')
                        : catalog.styles.filter(style => (style.category || 'upper') === id);
                    return id === 'all' || styles.length ? root.Daki.folderCard(name, baseHash + '&category=' + id, styles.length,
                        id === 'all' ? '원본 공유 그림체 · 대표 그림 보기 · 선택 삭제' : '', styles[0]?.src) : null;
                }).filter(Boolean);
                const grid = root.Daki.createGrid('daki-project-grid', folders, false);
                container.appendChild(grid);
                async function loadBatches() {
                    const {batches} = await api('/api/daki/style-tests');
                    if (!current(token)) return;
                    const sourceFolders = batches.some(batch => batch.origin === 'shared_upper')
                        ? folders.filter(folder => !folder.href.endsWith(baseHash + '&category=upper')) : folders;
                    grid.setItems([...sourceFolders, ...batches.filter(batch => batch.library !== 'personal').map(savedBatchCard)]);
                }
                try {
                    await loadBatches();
                } catch (error) { if (current(token)) status.textContent = error.message; }
                return;
            }
            const overview = category === 'all';
            const styles = overview ? catalog.styles.filter(style => (style.category || 'upper') === 'v5')
                : catalog.styles.filter(style => (style.category || 'upper') === category);
            const title = `공유 그림체 · ${overview ? '그림체 일람' : category === 'v5' ? 'V5 그림체' : '상반신'}`;
            heading(title, sharedStyleSubtitle(category, styles.length), baseHash, '← 공유 그림체');
            const toolbar = node('div', 'daki-style-toolbar');
            const search = node('input', 'filter-select'); search.type = 'search'; search.placeholder = '그림체 이름 검색'; search.setAttribute('aria-label', '그림체 이름 검색');
            toolbar.append(search);
            let cards = styles.map(style => ({id: style.id, name: style.name.toLowerCase(), style, card: styleCard(style)}));
            const galleryKey = 'shared:' + category;
            const filters = viewFilters = root.DakiGalleryFilters?.create({galleryKey, title,
                shareTagAssignment: true,
                recommendationOf: item => recommendationCount(item.style), dateOf: item => item.style.sort_date,
                onChange: () => { if (current(token)) refresh(); }});
            const imageTools = root.Daki.createImageTools?.({tagChoices: !filters});
            const libraryControls = node('div', 'daki-library-controls');
            libraryControls.appendChild(toolbar);
            if (imageTools) libraryControls.appendChild(imageTools);
            if (filters) libraryControls.appendChild(filters.element);
            container.appendChild(libraryControls);
            toolbar.appendChild(button('태그 그림 이상형 월드컵', () => {
                const ids = new Set(visibleCards().map(item => item.id));
                root.DakiWorldCup.open(styles.filter(style => ids.has(style.id)).map(style => ({
                    path: `__daki_shared__/${style.id}.png`, src: style.src, name: style.name,
                })), title, galleryKey);
            }));
            const selected = new Set();
            let busy = false;
            const visibleCards = () => {
                const q = search.value.trim().toLowerCase();
                const found = cards.filter(item => item.name.includes(q));
                return filters ? filters.apply(found, item => `__daki_shared__/${item.id}.png`) : found;
            };
            const selectAll = button('표시된 그림체 모두 선택', () => {
                if (busy) return;
                visibleCards().forEach(item => selected.add(item.id)); updateSelection();
            });
            const clear = button('선택 해제', () => { if (!busy) { selected.clear(); updateSelection(); } });
            const remove = button('선택한 그림체 삭제 (0)', async () => {
                if (busy || !selected.size) return;
                const ids = [...selected];
                busy = true; updateSelection(); status.textContent = '선택한 그림체를 삭제하는 중…';
                try {
                    await api('/api/daki/shared-styles/remove', 'POST', {style_ids: ids});
                    if (!current(token)) return;
                    cards = cards.filter(item => !selected.has(item.id)); selected.clear();
                    heading(title, sharedStyleSubtitle(category, cards.length), baseHash, '← 공유 그림체');
                    status.textContent = `${ids.length}개 그림체를 삭제했습니다. 새 전체 테스트에서 제외됩니다.`;
                    refresh();
                } catch (error) { if (current(token)) status.textContent = error.message; }
                finally { busy = false; if (current(token)) updateSelection(); }
            });
            function updateSelection() {
                selectAll.disabled = busy || !visibleCards().some(item => !selected.has(item.id));
                clear.disabled = remove.disabled = busy || !selected.size;
                remove.textContent = `선택한 그림체 삭제 (${selected.size})`;
                cards.forEach(item => {
                    if (!item.checkbox) return;
                    item.checkbox.checked = selected.has(item.id); item.checkbox.disabled = busy;
                    item.card.setAttribute('data-style-selected', String(item.checkbox.checked));
                });
            }
            if (overview) {
                toolbar.append(selectAll, clear, remove);
                container.appendChild(node('p', 'daki-test-note', '대표 그림을 보고 삭제할 그림체를 선택하세요. 삭제한 그림체는 새 전체 테스트에서 제외되며, 원본 그림과 기존 테스트는 유지됩니다.'));
                cards.forEach(item => {
                    const name = item.card.querySelector('.daki-image-actions').children[0];
                    const label = node('label', 'daki-style-select');
                    const checkbox = item.checkbox = node('input'); checkbox.type = 'checkbox';
                    checkbox.setAttribute('aria-label', name.textContent + ' 선택');
                    checkbox.onchange = () => {
                        if (busy) return;
                        if (checkbox.checked) selected.add(item.id); else selected.delete(item.id);
                        updateSelection();
                    };
                    label.append(checkbox, node('span', '', name.textContent)); name.replaceWith(label);
                });
            }
            const grid = root.Daki.createGrid('daki-style-grid'); container.appendChild(grid);
            const empty = node('p', 'daki-empty', '표시할 그림체가 없습니다.'); container.appendChild(empty);
            function refresh() {
                const visible = visibleCards(); grid.setItems(visible.map(item => item.card));
                filters?.setResultCount?.(visible.length, cards.length);
                empty.hidden = !!visible.length; updateSelection();
            }
            search.oninput = refresh; refresh();
        } catch (error) {
            if (!current(token)) return;
            status.textContent = error.message;
            heading('공유 그림체', '원본 폴더의 연결 상태를 확인해 주세요.', '#daki', '← daki 프로젝트');
            container.appendChild(button('다시 불러오기', () => { container.replaceChildren(); render(params, container); }));
        }
    }
    async function openSettings(catalog, batch = null, onSaved = null) {
        if (settingsDialog?.open) return;
        settingsDialog?.remove();
        const initial = batch || draft;
        const dialog = settingsDialog = node('dialog', 'daki-dialog daki-test-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiTestDialogTitle');
        dialog.innerHTML = `<form id="dakiTestForm">
            <header class="daki-test-dialog-header"><span class="daki-style-eyebrow">그림체 · 생성 설정</span>
                <h2 id="dakiTestDialogTitle"></h2><p id="dakiTestScope"></p></header>
            <div class="daki-test-form-body">
                <label id="dakiTestNameField">테스트 이름<input type="text" name="name" maxlength="120" placeholder="예: 가을 교복 테스트"></label>
                <fieldset id="dakiTestTargetFields" class="daki-test-target-fields"></fieldset>
                <section class="daki-test-settings-section">
                    <div class="daki-test-section-heading"><h3>모델과 크기</h3><p>모든 대기 그림체에 적용할 설정</p></div>
                    <div class="daki-test-basics">
                        <label>모델<select name="model" aria-describedby="dakiTestModelNote"></select></label>
                        <label>크기 프리셋<select name="size_preset"><option value="original">그림체별 원본 크기 유지</option><option value="custom">직접 입력</option></select></label>
                        <label>저장 형식<select name="output_format"><option value="webp">WebP (품질 90)</option><option value="png">PNG</option></select></label>
                    </div>
                    <div class="daki-test-size-inputs">
                        <label>가로<input name="width" type="number" min="64" max="2048" step="64" required aria-describedby="dakiTestSizeHelp"></label>
                        <button id="dakiTestSwapSize" type="button" aria-label="가로 세로 바꾸기">↔</button>
                        <label>세로<input name="height" type="number" min="64" max="2048" step="64" required aria-describedby="dakiTestSizeHelp"></label>
                    </div>
                    <p id="dakiTestSizeHelp" class="daki-test-size-help" role="status"></p>
                    <p id="dakiTestModelNote" class="daki-test-note" role="status" hidden></p>
                    <p class="daki-test-size-help">WebP를 선택하면 품질 90으로 자동 변환합니다. 변환 중에도 다음 그림체 생성이 이어지고, 프롬프트는 보존됩니다. 변환 실패 시 PNG를 유지합니다.</p>
                </section>
                <section class="daki-test-settings-section">
                    <div class="daki-test-section-heading"><h3>공통 프롬프트</h3><p>각 그림체의 고유 프롬프트에 더해집니다</p></div>
                    <div class="daki-style-tabs daki-test-prompt-tabs" role="tablist" aria-label="공통 프롬프트 종류">
                        <button id="dakiTestBaseTab" type="button" role="tab" aria-controls="dakiTestBasePanel">Base</button>
                        <button id="dakiTestNegaTab" type="button" role="tab" aria-controls="dakiTestNegaPanel">Nega</button>
                    </div>
                    <div id="dakiTestBasePanel" class="daki-test-prompt-editor" role="tabpanel" aria-labelledby="dakiTestBaseTab">
                        <textarea name="prompt" aria-label="공통 프롬프트" rows="6" maxlength="20000" placeholder="모든 그림체에 적용할 구도·배경·표현"></textarea></div>
                    <div id="dakiTestNegaPanel" class="daki-test-prompt-editor" role="tabpanel" aria-labelledby="dakiTestNegaTab" hidden>
                        <textarea name="negative_prompt" aria-label="공통 네거티브" rows="6" maxlength="20000" placeholder="모든 그림체에서 제외할 표현"></textarea></div>
                </section>
                <section class="daki-test-settings-section daki-test-characters">
                    <div class="daki-test-section-heading"><h3>캐릭터 프롬프트</h3><button id="dakiTestAddCharacter" type="button">＋ 캐릭터 추가</button></div>
                    <div id="dakiTestCharacters"></div>
                </section>
                <p id="dakiTestPreservedSettings"></p>
                <label id="dakiTestKeyField" hidden>NovelAI API Key<input name="key" type="password" autocomplete="off" placeholder="NAIM에 저장할 키"></label>
                <p id="dakiTestSettingsStatus" role="status"></p>
            </div>
            <div class="daki-dialog-actions daki-test-dialog-actions"><button id="dakiTestCancel" type="button">취소</button><button class="daki-primary" type="submit"></button></div>
        </form>`;
        doc.body.appendChild(dialog);
        const form = byId('dakiTestForm');
        const submit = form.querySelector('[type=submit]');
        const status = byId('dakiTestSettingsStatus');
        const scope = byId('dakiTestScope');
        const targetFields = byId('dakiTestTargetFields');
        let limits, targets;
        let busy = false;
        targetFields.hidden = !!batch;
        function refreshTargets() {
            const selection = targets?.selection();
            submit.disabled = busy || !limits || !!selection?.error;
            if (!batch) scope.textContent = `${selection?.count ?? catalog.styles.length}개 그림체가 대상입니다. 준비 후 한 장씩 또는 남은 전체를 생성할 수 있습니다.`;
        }
        if (!batch && root.DakiTestTargets) {
            targets = root.DakiTestTargets.create({catalog, onChange: () => { if (dialog.open) refreshTargets(); }});
            targetFields.appendChild(targets.element);
        }
        dialog.addEventListener('close', () => targets?.dispose(), {once: true});
        byId('dakiTestNameField').hidden = !!batch;
        const nameInput = form.elements.namedItem('name');
        nameInput.required = !batch; nameInput.value = batch?.name || draft.name || '';
        byId('dakiTestDialogTitle').textContent = batch ? '테스트 설정 수정' : '전체 그림체로 테스트 만들기';
        submit.textContent = batch ? '남은 그림에 적용' : '테스트 준비'; submit.disabled = true;
        scope.textContent = batch
            ? `남은 ${batch.pending}개 그림체에 적용합니다. 완성된 그림과 실패한 항목은 그대로 유지합니다.`
            : `${catalog.styles.length}개 전체 그림체가 대상입니다. 준비 후 한 장씩 또는 남은 전체를 생성할 수 있습니다.`;
        const model = form.elements.namedItem('model');
        const outputFormat = form.elements.namedItem('output_format');
        outputFormat.value = initial.output_format === 'png' ? 'png' : initial.output_format === 'webp' ? 'webp' : batch ? 'png' : 'webp';
        for (const [value, label] of Object.entries(models)) {
            const option = node('option', '', label); option.value = value; model.appendChild(option);
        }
        for (const key of ['model', 'prompt', 'negative_prompt']) form.elements.namedItem(key).value = initial[key] || '';
        const size = form.elements.namedItem('size_preset');
        const width = form.elements.namedItem('width');
        const height = form.elements.namedItem('height');
        width.value = String(initial.width || 832); height.value = String(initial.height || 1216);
        size.value = initial.width && initial.height ? 'custom' : 'original';
        function matchSize() {
            const value = width.value + 'x' + height.value;
            size.value = [...size.querySelectorAll('option')].some(option => option.value === value) ? value : 'custom';
        }
        function updateSize() {
            const original = size.value === 'original';
            width.disabled = height.disabled = byId('dakiTestSwapSize').disabled = original;
            byId('dakiTestSizeHelp').textContent = original ? '각 그림체의 원본 가로·세로를 그대로 사용합니다.'
                : `${width.value} × ${height.value} px · 64 단위로 입력하세요.`
                    + (limits ? ` 최대 ${limits.max_pixels.toLocaleString('ko-KR')}픽셀까지 지원합니다.` : '');
        }
        size.onchange = () => {
            if (!['original', 'custom'].includes(size.value)) [width.value, height.value] = size.value.split('x');
            updateSize();
        };
        width.oninput = height.oninput = () => { matchSize(); updateSize(); };
        byId('dakiTestSwapSize').onclick = () => { [width.value, height.value] = [height.value, width.value]; matchSize(); updateSize(); };
        updateSize();
        const tabs = [byId('dakiTestBaseTab'), byId('dakiTestNegaTab')];
        const panels = [byId('dakiTestBasePanel'), byId('dakiTestNegaPanel')];
        function activate(index) {
            tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index; });
        }
        tabs.forEach((tab, i) => {
            tab.onclick = () => activate(i);
            tab.onkeydown = event => {
                const index = ({ArrowLeft: 1 - i, ArrowRight: 1 - i, Home: 0, End: 1})[event.key];
                if (index === undefined) return;
                event.preventDefault(); activate(index); tabs[index].focus();
            };
        }); activate(0);
        const characters = byId('dakiTestCharacters');
        function addCharacter(value = {}) {
            const row = node('fieldset', 'daki-test-character');
            const positive = node('textarea'); positive.rows = 2; positive.maxLength = 20000; positive.value = value.prompt || ''; positive.setAttribute('aria-label', '캐릭터 프롬프트');
            const negative = node('textarea'); negative.rows = 2; negative.maxLength = 20000; negative.value = value.negative_prompt || ''; negative.setAttribute('aria-label', '캐릭터 네거티브');
            negative.disabled = model.value === mediumModel; negative.setAttribute('aria-describedby', 'dakiTestModelNote');
            const baseLabel = node('label', '', 'Base'); baseLabel.appendChild(positive);
            const negaLabel = node('label', '', 'Nega'); negaLabel.appendChild(negative);
            row.append(node('legend', '', '캐릭터'), baseLabel, negaLabel, button('제거', () => { row.remove(); byId('dakiTestAddCharacter').disabled = characters.children.length >= 6; }));
            characters.appendChild(row); byId('dakiTestAddCharacter').disabled = characters.children.length >= 6;
        }
        (initial.char_prompts || []).forEach(addCharacter);
        byId('dakiTestAddCharacter').onclick = () => { if (characters.children.length < 6) addCharacter(); };
        function updateModel() {
            const medium = model.value === mediumModel;
            const note = byId('dakiTestModelNote'); note.hidden = !medium; note.textContent = mediumNote;
            form.elements.namedItem('negative_prompt').disabled = medium;
            form.elements.namedItem('negative_prompt').setAttribute('aria-describedby', note.id);
            characters.querySelectorAll('[aria-label="캐릭터 네거티브"]').forEach(input => { input.disabled = medium; });
            byId('dakiTestPreservedSettings').textContent = (medium ? 'CFG 등은 그림체별 원본 값을 유지하며 Medium 고정 설정을 적용합니다. '
                : '스텝·CFG·샘플러 등은 그림체별 원본 값을 유지합니다. ') + '시드는 매번 무작위로 생성합니다.';
        }
        model.onchange = updateModel; updateModel();
        function readSettings() {
            const value = Object.fromEntries(['model','prompt','negative_prompt'].map(key => [key, form.elements.namedItem(key).value.trim()]));
            value.output_format = outputFormat.value;
            value.width = size.value === 'original' ? null : Number(width.value);
            value.height = size.value === 'original' ? null : Number(height.value);
            value.char_prompts = [...characters.children].map(row => {
                const inputs = row.querySelectorAll('textarea');
                return {prompt: inputs[0].value.trim(), negative_prompt: inputs[1].value.trim()};
            }).filter(item => item.prompt || item.negative_prompt);
            return value;
        }
        function saveDraft() { if (!batch) draft = {...readSettings(), name: nameInput.value.trim()}; }
        byId('dakiTestCancel').onclick = () => { if (!busy) { saveDraft(); dialog.close(); } };
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); else saveDraft(); });
        form.onsubmit = async event => {
            event.preventDefault(); if (busy || !limits) return;
            const selection = targets?.selection();
            if (selection?.error) { status.textContent = selection.error; refreshTargets(); return; }
            const styleIds = selection?.styleIds == null ? null : [...selection.styleIds];
            const value = readSettings();
            if (!batch && !nameInput.value.trim()) { status.textContent = '테스트 이름을 입력해 주세요.'; nameInput.focus(); return; }
            if (value.width !== null && (![value.width, value.height].every(n => Number.isInteger(n) && n >= limits.min && n <= limits.max && n % limits.step === 0)
                || value.width * value.height > limits.max_pixels)) {
                status.textContent = `가로·세로는 ${limits.min}~${limits.max}px 사이의 ${limits.step} 배수이며, 전체 크기는 ${limits.max_pixels.toLocaleString('ko-KR')}픽셀 이하여야 합니다.`;
                return;
            }
            saveDraft(); busy = true; submit.disabled = true; targetFields.disabled = true; byId('dakiTestCancel').disabled = true;
            status.textContent = batch ? '설정을 저장하는 중…' : '테스트를 준비하는 중…';
            try {
                const key = form.elements.namedItem('key').value.trim();
                if (key) await api('/api/lab/config', 'POST', {key});
                const request = value.model === mediumModel ? {...value, negative_prompt: '',
                    char_prompts: value.char_prompts.map(character => ({...character, negative_prompt: ''}))} : value;
                if (!batch) {
                    request.name = nameInput.value.trim(); request.library = catalog.library || 'shared';
                    if (styleIds !== null) request.style_ids = styleIds;
                    else if (request.library === 'shared') request.style_ids = catalog.styles.map(style => style.id);
                }
                const endpoint = '/api/daki/style-tests' + (batch ? '/' + encodeURIComponent(batch.id) + '/settings' : '');
                const result = await api(endpoint, 'POST', request);
                form.elements.namedItem('key').value = ''; dialog.close();
                if (onSaved) onSaved(result.batch);
                else root.location.hash = '#daki&library=' + (result.batch.library === 'personal' ? 'personal' : 'shared') + '&batch=' + encodeURIComponent(result.batch.id);
            } catch (error) { status.textContent = error.message; }
            finally { busy = false; targetFields.disabled = false; refreshTargets(); byId('dakiTestCancel').disabled = false; }
        };
        status.textContent = '크기 프리셋을 불러오는 중…';
        dialog.showModal(); (batch ? form.elements.namedItem('prompt') : nameInput).focus({preventScroll: true});
        try {
            const options = await api('/api/daki/style-tests/options');
            if (!dialog.open) return;
            limits = options.size_limits;
            for (const preset of options.size_presets) {
                const group = node('optgroup'); group.label = preset.label;
                for (const [w, h] of preset.sizes) {
                    const option = node('option', '', root.formatGenerationSize(w, h, limits)); option.value = `${w}x${h}`; group.appendChild(option);
                }
                size.appendChild(group);
            }
            if (size.value !== 'original') matchSize();
            for (const input of [width, height]) { input.min = limits.min; input.max = limits.max; input.step = limits.step; }
            updateSize();
            byId('dakiTestKeyField').hidden = options.configured;
            form.elements.namedItem('key').required = !options.configured;
            status.textContent = ''; refreshTargets();
        } catch (error) { if (dialog.open) status.textContent = '설정 정보를 불러오지 못했습니다: ' + error.message; }
    }
    async function renderBatch(id, container, token, initialBatch = null) {
        let batch = initialBatch || (await api('/api/daki/style-tests/' + encodeURIComponent(id))).batch;
        if (!current(token)) return;
        byId('dakiPageStatus').textContent = '';
        const personal = batch.library === 'personal';
        const backHref = personal ? '#daki&library=personal' : baseHash;
        const galleryTools = node('div', 'daki-style-toolbar');
        const rename = button('이름 변경', () => root.DakiTestLibrary?.rename(batch, update));
        const append = button('그림체 추가', () => root.DakiTestLibrary?.append(batch, updated => {
            if (!current(token)) return;
            update(updated); generation.open = true;
        }));
        const appendShared = button('새 공유 그림체 확인 중…', () => {
            if (personal || !Array.isArray(batch.missing_shared_style_ids) || !batch.missing_shared_style_ids.length) return;
            return command('styles', {style_ids: [...batch.missing_shared_style_ids]});
        });
        appendShared.title = '현재 공유 그림체 중 이 테스트에 없는 그림체를 현재 설정의 대기 목록에 추가합니다.';
        const worldcup = button('태그 그림 이상형 월드컵', () => root.DakiWorldCup.open(
            visibleItems().filter(item => item.status === 'completed' && item.src).map(item => ({
                path: `__daki_tests__/${batch.id}/${item.style_id}.png`, src: item.src, name: item.name,
            })), batchLabel(batch), 'test:' + batch.id));
        galleryTools.append(rename, append);
        if (!personal) galleryTools.appendChild(appendShared);
        galleryTools.appendChild(worldcup);
        const filters = viewFilters = root.DakiGalleryFilters?.create({galleryKey: 'test:' + batch.id, title: batchLabel(batch),
            shareTagAssignment: true,
            recommendationOf: recommendationCount, dateOf: item => item.sort_date,
            onChange: () => { if (current(token)) refreshGallery(); }});
        const imageTools = root.Daki.createImageTools?.({tagChoices: !filters});
        const libraryControls = node('div', 'daki-library-controls');
        libraryControls.appendChild(galleryTools);
        if (imageTools) libraryControls.appendChild(imageTools);
        if (filters) libraryControls.appendChild(filters.element);
        container.appendChild(libraryControls);
        const generation = node('details', 'daki-test-generation');
        generation.open = batch.status !== 'completed';
        const generationSummary = node('summary'); generation.appendChild(generationSummary); container.appendChild(generation);
        const controls = node('section', 'daki-test-controls'); generation.appendChild(controls);
        const summary = node('dl', 'daki-test-summary');
        const summaryValues = ['모델', '크기', '남은 그림체'].map(label => {
            const cell = node('div'); const value = node('dd'); cell.append(node('dt', '', label), value); summary.appendChild(cell); return value;
        });
        controls.appendChild(summary);
        const toolbar = node('div', 'daki-style-toolbar');
        const progress = node('p', 'daki-test-progress'); progress.setAttribute('role', 'status');
        const progressTrack = node('div', 'daki-test-progress-track'); progressTrack.setAttribute('role', 'progressbar');
        progressTrack.setAttribute('aria-label', '그림체 생성 진행률');
        const progressFill = node('div', 'daki-test-progress-fill'); progressTrack.appendChild(progressFill);
        const next = button('다음 그림체 한 장 생성', () => run('next'));
        const all = button('남은 그림체 모두 생성', () => run('remaining'));
        const retry = button('실패한 그림 다시 생성', () => run('retry_failed'));
        const stop = button('중지', () => command('stop'));
        const edit = button('설정 수정', () => openSettings(null, batch, updated => {
            if (!current(token)) return;
            update(updated);
            byId('dakiPageStatus').textContent = '남은 그림체의 설정을 수정했습니다. 완성된 그림은 유지됩니다.';
        }));
        toolbar.append(next, all, retry, stop, edit); controls.append(toolbar, progress, progressTrack);
        const costLabel = node('p', 'daki-test-anlas', 'Anlas가 필요한 요청은 생성 전에 경고 창에서 확인합니다.'); controls.appendChild(costLabel);
        const note = node('p', 'daki-test-note', '중지하면 현재 한 장까지 저장하고 멈춥니다. 대기 중에는 설정을 수정할 수 있으며, 완성된 그림은 유지됩니다. NAI 구독과 설정에 따라 사용량·Anlas가 소모될 수 있습니다.'); controls.appendChild(note);
        const retryNote = node('p', 'daki-test-note', '실패한 그림은 각 항목에 저장된 설정으로 다시 생성하며, 시드는 새로 뽑습니다.'); controls.appendChild(retryNote);
        const prompts = node('details', 'daki-test-history');
        let settingsSignature;
        controls.appendChild(prompts);
        const grid = root.Daki.createGrid('daki-style-grid'); container.appendChild(grid);
        const cards = new Map();
        let visibleSignature;
        const empty = node('p', 'daki-empty', '필터에 맞는 그림이 없습니다.'); empty.hidden = true; container.appendChild(empty);
        let busy = false;
        const endpoint = '/api/daki/style-tests/' + encodeURIComponent(id);
        function visibleItems() {
            return filters ? filters.apply(batch.items, item => item.status === 'completed' && item.src
                ? `__daki_tests__/${batch.id}/${item.style_id}.png` : '') : batch.items;
        }
        function refreshGallery() {
            const shown = visibleItems().map(item => cards.get(item.style_id)).filter(Boolean);
            filters?.setResultCount?.(shown.length, batch.items.length);
            const signature = shown.map(entry => entry.id).join('|');
            if (signature !== visibleSignature) {
                visibleSignature = signature; grid.setItems(shown.map(entry => entry.card));
            } else grid.galleryZoomImages = shown.filter(entry => entry.card.dataset?.path).map(entry => ({path: entry.card.dataset.path}));
            empty.hidden = !!shown.length;
        }
        function update(value) {
            if (!current(token)) return;
            if (batch.updated_at && value.updated_at && value.updated_at < batch.updated_at) return;
            batch = value;
            const running = ['running', 'stopping'].includes(batch.status);
            heading(batchLabel(batch), `${batch.completed}장 · ${personal ? '개인' : '공유'} 그림체 테스트`, backHref, personal ? '← 개인 그림체' : '← 공유 그림체');
            append.disabled = busy || running;
            const missingShared = batch.missing_shared_style_ids;
            appendShared.textContent = !Array.isArray(missingShared) ? '새 공유 그림체 확인 불가'
                : missingShared.length ? `새 공유 그림체 ${missingShared.length}개 추가` : '새 공유 그림체 없음';
            appendShared.disabled = busy || running || !Array.isArray(missingShared) || !missingShared.length;
            rename.disabled = busy;
            generationSummary.textContent = `생성 관리 · ${batch.completed}/${batch.total}장 완료 · ${statusLabel(batch.status)}`;
            next.disabled = busy || running || !batch.pending;
            all.disabled = busy || running || !batch.pending;
            retry.disabled = busy || running || !batch.failed;
            retry.hidden = !batch.failed;
            retry.textContent = `실패한 그림 다시 생성 (${batch.failed || 0})`;
            retryNote.hidden = !batch.failed;
            stop.disabled = busy || batch.status !== 'running';
            edit.disabled = busy || running || !batch.pending;
            summaryValues[0].textContent = models[batch.model] || batch.model;
            summaryValues[1].textContent = batch.width && batch.height ? `${batch.width} × ${batch.height}` : '그림체별 원본 크기';
            summaryValues[2].textContent = `${batch.pending} / ${batch.total}개`;
            const signature = JSON.stringify([batch.model, batch.output_format, batch.prompt, batch.negative_prompt, batch.char_prompts, batch.width, batch.height]);
            if (settingsSignature !== signature) {
                settingsSignature = signature;
                prompts.replaceChildren(node('summary', '', '현재 프롬프트와 모델 보기'));
                const medium = batch.model === mediumModel;
                const negativeText = value => medium ? '(Medium에서 적용되지 않음)' : value;
                const outputFormatLabel = batch.output_format === 'webp' ? 'WebP (품질 90)' : 'PNG';
                if (medium) prompts.appendChild(node('p', 'daki-test-note', mediumNote));
                for (const [label, value] of [['모델', models[batch.model] || batch.model], ['크기', summaryValues[1].textContent], ['저장 형식', outputFormatLabel], ['공통 프롬프트', batch.prompt], ['공통 네거티브', negativeText(batch.negative_prompt)], ...(batch.char_prompts || []).flatMap((c, i) => [[`캐릭터 ${i + 1}`, c.prompt], [`캐릭터 ${i + 1} 네거티브`, negativeText(c.negative_prompt)]])]) prompts.append(node('b', '', label), node('pre', '', value || '(없음)'));
                prompts.appendChild(node('p', 'daki-test-note', '수정한 설정은 남은 그림부터 적용됩니다. 완성된 그림의 실제 설정은 해당 그림의 프롬프트 정보에서 확인할 수 있습니다.'));
            }
            costLabel.hidden = !batch.items.some(item => ['pending', 'failed'].includes(item.status) && item.requires_anlas);
            const converting = Number.isInteger(batch.converting) && batch.converting > 0 ? ` · ${batch.converting}장 WebP 변환 중` : '';
            progress.textContent = `${batch.completed}/${batch.total}장 완료 · ${batch.pending}장 대기${batch.failed ? ` · ${batch.failed}장 실패` : ''}${converting} · ${statusLabel(batch.status)}`;
            progressTrack.setAttribute('aria-valuemin', '0'); progressTrack.setAttribute('aria-valuemax', String(batch.total));
            progressTrack.setAttribute('aria-valuenow', String(batch.completed));
            progressFill.style.width = `${batch.total ? batch.completed / batch.total * 100 : 0}%`;
            for (const item of batch.items) {
                let entry = cards.get(item.style_id);
                if (!entry) {
                    const card = node('article', 'item-box daki-style-card');
                    const preview = node('div');
                    const label = node('div', 'gallery-card-actions daki-image-actions');
                    const state = node('span'); label.append(node('strong', '', item.name), state);
                    card.append(preview, label);
                    entry = {id: item.style_id, card, preview, state, label, origin: null, signature: null}; cards.set(item.style_id, entry);
                }
                const originSignature = JSON.stringify([item.name, item.source_url, item.recommendation_count, item.recommendation_collected_at]);
                if (entry.originSignature !== originSignature) {
                    entry.originSignature = originSignature;
                    entry.origin?.remove(); entry.origin = sourceInfo(item); entry.label.appendChild(entry.origin);
                }
                const signature = [item.status, item.src, item.error, item.conversion_error, item.model, item.width, item.height].join('|');
                if (entry.signature === signature) continue;
                entry.signature = signature;
                const warning = item.conversion_error ? `${item.conversion_error} · ` : '';
                entry.state.textContent = item.error || `${warning}${statusLabel(item.status)} · ${(models[item.model] || item.model || '').replace('NovelAI ', '')} · ${item.width} × ${item.height}`;
                let preview;
                if (item.src) preview = picture(item.src, item.name);
                else {
                    const placeholder = node('div', 'daki-test-placeholder');
                    if (item.source_src) { const img = node('img'); img.src = item.source_src; img.alt = item.name + ' 원본'; img.loading = 'lazy'; placeholder.appendChild(img); }
                    placeholder.appendChild(node('span', '', item.status === 'running' ? '생성 중…' : item.status === 'converting' ? 'WebP 변환 중…' : item.status === 'failed' ? '생성 실패' : '생성 대기'));
                    preview = placeholder;
                }
                entry.card.replaceChild(preview, entry.preview); entry.preview = preview;
                if (item.src) root.Daki.bindImage(entry.card, preview, `__daki_tests__/${batch.id}/${item.style_id}.png`);
            }
            refreshGallery();
        }
        async function command(action, body) {
            if (busy || !current(token) || (['run', 'styles'].includes(action) && ['running', 'stopping'].includes(batch.status))) return;
            busy = true; update(batch);
            try {
                if (action === 'run') {
                    let selected = batch.items.filter(item => item.status === (body.mode === 'retry_failed' ? 'failed' : 'pending'));
                    if (body.mode === 'next') selected = selected.slice(0, 1);
                    if (!selected.length) return;
                    const requests = selected.map(item => ({width: item.width, height: item.height,
                        steps: (item.model || batch.model) === mediumModel ? 14 : item.options?.steps ?? 28}));
                    const paid = requests.filter(item => root.requiresAnlasCost(item.width, item.height, item.steps));
                    body = {...body, allow_anlas: false};
                    if (paid.length) {
                        const approved = await root.showAnlasWarningModal({requests,
                            title: '그림체 테스트 Anlas 사용 경고',
                            detail: `선택한 ${selected.length}장 중 ${paid.length}장은 Anlas가 소모될 수 있습니다. 표시된 예상 비용은 이번 요청 전체의 합계이며, 실제 차감량은 달라질 수 있습니다.`});
                        if (!current(token)) return;
                        if (!approved) { byId('dakiPageStatus').textContent = '생성을 취소했습니다.'; return; }
                        body.allow_anlas = true;
                    }
                }
                const result = await api(endpoint + '/' + action, 'POST', body || {});
                if (!current(token)) return;
                byId('dakiPageStatus').textContent = ''; update(result.batch);
                if (action === 'styles') {
                    generation.open = true;
                    byId('dakiPageStatus').textContent = '새 공유 그림체를 대기 목록에 추가했습니다. ‘남은 그림체 모두 생성’으로 이어서 생성하세요.';
                }
            } catch (error) { if (current(token)) byId('dakiPageStatus').textContent = error.message; }
            finally {
                busy = false;
                if (current(token)) { update(batch); schedule(); }
            }
        }
        function run(mode) { return command('run', {mode}); }
        function schedule() {
            root.clearTimeout(pollTimer);
            if (current(token) && ['running', 'stopping'].includes(batch.status)) pollTimer = root.setTimeout(refresh, 1000);
        }
        async function refresh() {
            try {
                const result = await api(endpoint);
                if (!current(token)) return;
                byId('dakiPageStatus').textContent = '';
                update(result.batch);
            } catch (error) { if (current(token)) byId('dakiPageStatus').textContent = '진행 상태 확인 실패: ' + error.message; }
            schedule();
        }
        update(batch); schedule();
    }
    root.DakiStyles = {render, leave, openSettings, savedBatchCard};
})(typeof window === 'undefined' ? globalThis : window);
