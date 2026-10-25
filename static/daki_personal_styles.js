/* Personal recipes share gallery image interactions and keep source references. */
(function (root) {
    'use strict';
    const doc = root.document;
    const endpoint = '/api/daki/personal-styles';
    const models = {'nai-diffusion-5-full': 'NovelAI V5 Full',
        'nai-diffusion-5-full-medium': 'NovelAI V5 Full Medium',
        'nai-diffusion-4-5-full': 'NovelAI V4.5 Full'};
    let revision = 0;
    let view = null;
    let editor = null;
    let editorRevision = 0;
    let viewFilters;
    const byId = id => doc.getElementById(id);
    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function button(text, action, className = 'nav-btn') {
        const item = node('button', className, text); item.type = 'button'; item.onclick = action; return item;
    }
    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '개인 그림체를 처리하지 못했습니다.');
        return result;
    }
    function leave() {
        revision++; view = null; editorRevision++;
        viewFilters?.dispose(); viewFilters = null;
        if (editor?.open) editor.close();
        root.DakiWorldCup?.leave?.();
    }
    function current(token) { return token === revision && root.Daki.isActive(); }
    function imageFor(style) {
        if (!style.source_path) return null;
        return {path: `__daki_personal__/${style.id}.png`, name: style.name,
            src: style.src || `${endpoint}/${encodeURIComponent(style.id)}/preview`};
    }
    function styleCard(style) {
        const card = node('article', 'item-box daki-style-card daki-personal-card');
        const image = imageFor(style);
        if (image) {
            const img = node('img', 'zoomable'); img.src = image.src; img.alt = style.name; img.loading = 'lazy';
            img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', style.name + ' 크게 보기');
            card.appendChild(img); root.Daki.bindImage(card, img, image.path);
        } else card.appendChild(node('div', 'daki-personal-placeholder', '🖼️ 대표 그림 없음'));
        const actions = node('div', 'gallery-card-actions daki-image-actions');
        actions.append(node('span', '', style.name), button('그림체 수정', () => openEditor({id: style.id}), 'gallery-card-action-btn'));
        card.appendChild(actions); return card;
    }
    async function render(params, container) {
        leave();
        const token = revision;
        if (params.get('batch')) return root.DakiStyles.render(params, container);
        view = {params: new URLSearchParams(params), container, token};
        byId('dakiTitle').textContent = '개인 그림체';
        byId('dakiSubtitle').textContent = '직접 입력하거나 갤러리 그림에서 그림체를 가져오세요.';
        const back = byId('dakiBack'); back.hidden = false; back.href = '#daki'; back.textContent = '← daki 프로젝트';
        const status = byId('dakiPageStatus'); status.textContent = '개인 그림체를 불러오는 중…';
        try {
            const {styles} = await api(endpoint);
            if (!current(token)) return;
            status.textContent = '';
            const toolbar = node('div', 'daki-style-toolbar');
            const createTest = button('전체 그림체로 테스트 만들기', () => root.DakiStyles.openSettings({styles, library: 'personal'}));
            createTest.disabled = !styles.length;
            toolbar.append(button('＋ 개인 그림체', () => openEditor()), createTest);
            const searchRow = node('div', 'daki-style-toolbar');
            const search = node('input', 'filter-select'); search.type = 'search'; search.placeholder = '그림체 이름 검색';
            search.setAttribute('aria-label', '개인 그림체 이름 검색'); searchRow.appendChild(search);
            const worldcup = button('태그 그림 이상형 월드컵', () => root.DakiWorldCup.open(
                visibleCards().map(item => imageFor(item.style)).filter(Boolean), '개인 그림체', 'personal'));
            worldcup.disabled = !styles.some(imageFor); searchRow.appendChild(worldcup);
            const filters = viewFilters = root.DakiGalleryFilters?.create({galleryKey: 'personal', title: '개인 그림체',
                shareTagAssignment: true,
                onChange: () => { if (current(token)) filter(); }});
            const tools = root.Daki.createImageTools?.({tagChoices: !filters});
            const libraryControls = node('div', 'daki-library-controls');
            libraryControls.append(toolbar, searchRow);
            if (tools) libraryControls.appendChild(tools);
            if (filters) libraryControls.appendChild(filters.element);
            container.appendChild(libraryControls);
            const cards = styles.map(style => ({style, card: styleCard(style)}));
            const grid = root.Daki.createGrid('daki-style-grid'); container.appendChild(grid);
            const empty = node('p', 'daki-empty', '개인 그림체가 없습니다. 직접 입력하거나 그림에서 가져와 추가하세요.');
            container.appendChild(empty);
            function visibleCards() {
                const query = search.value.trim().toLowerCase();
                const found = cards.filter(item => item.style.name.toLowerCase().includes(query));
                return filters ? filters.apply(found, item => imageFor(item.style)?.path || '') : found;
            }
            function filter() {
                const shown = visibleCards();
                grid.setItems(shown.map(item => item.card)); empty.hidden = !!shown.length;
                empty.textContent = styles.length ? '검색·필터에 맞는 그림체가 없습니다.' : '개인 그림체가 없습니다. 직접 입력하거나 그림에서 가져와 추가하세요.';
            }
            search.oninput = filter; filter();
            const history = node('section', 'daki-personal-history');
            history.appendChild(node('h2', 'section-title', '저장된 테스트')); container.appendChild(history);
            try {
                const {batches} = await api('/api/daki/style-tests');
                if (!current(token)) return;
                const personal = batches.filter(batch => batch.library === 'personal');
                if (personal.length) history.appendChild(root.Daki.createGrid('daki-project-grid',
                    personal.map(batch => root.DakiStyles.savedBatchCard(batch)), false));
                else history.appendChild(node('p', 'daki-empty', '아직 저장된 테스트가 없습니다.'));
            } catch (error) { if (current(token)) history.appendChild(node('p', 'daki-warning', error.message)); }
        } catch (error) {
            if (!current(token)) return;
            status.textContent = error.message;
            container.appendChild(button('다시 불러오기', () => { container.replaceChildren(); return render(params, container); }));
        }
    }

    async function openEditor({path, id, onSaved} = {}) {
        if (editor?.open) editor.close();
        const token = ++editorRevision;
        const originalFocus = doc.activeElement;
        const dialog = editor = node('dialog', 'daki-dialog daki-personal-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiPersonalTitle');
        const form = node('form'); form.id = 'dakiPersonalForm';
        const title = node('h2', '', id ? '개인 그림체 수정' : '개인 그림체 추가'); title.id = 'dakiPersonalTitle';
        const header = node('header', 'daki-personal-header');
        header.append(title, node('p', '', 'Base와 Nega, 생성 설정을 저장합니다. 시드는 생성할 때 새로 정해집니다.'));
        form.appendChild(header);
        const body = node('div', 'daki-personal-body'); form.appendChild(body);
        const fields = {};
        function field(key, label, tag = 'input', type = 'text', parent = body) {
            const wrapper = node('label', 'daki-personal-field', label);
            const input = fields[key] = node(tag); input.id = 'dakiPersonal-' + key; input.name = key;
            if (tag === 'input') input.type = type;
            wrapper.appendChild(input); parent.appendChild(wrapper); return input;
        }
        const name = field('name', '그림체 이름'); name.required = true; name.maxLength = 120; name.autocomplete = 'off';
        const source = field('source_path', '대표 그림 경로 (선택)'); source.placeholder = '갤러리 그림 우클릭 → 개인 그림체로 추가';
        const importButton = button('이 그림에서 가져오기', importSource);
        const sourceNote = node('p', 'daki-personal-source-note', '원본 위치에 연결합니다. 그림의 설정을 읽으려면 경로를 넣고 가져오기를 누르세요.');
        source.parentNode.append(importButton, sourceNote);
        const model = field('model', '원본 모델', 'select');
        body.insertBefore(model.parentNode, source.parentNode);
        Object.entries(models).forEach(([value, label]) => { const option = node('option', '', label); option.value = value; model.appendChild(option); });
        const prompts = node('section', 'daki-personal-prompts'); body.appendChild(prompts);
        const tabs = node('div', 'daki-style-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '프롬프트 종류'); prompts.appendChild(tabs);
        const panels = [];
        [['positive', 'Base'], ['negative', 'Nega']].forEach(([key, label], index) => {
            const tab = button(label, () => activate(index)); tab.id = 'dakiPersonalTab-' + key; tab.setAttribute('role', 'tab');
            const panel = node('div', 'daki-personal-prompt-panel'); panel.id = 'dakiPersonalPanel-' + key;
            panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
            const input = field(key, label + ' 프롬프트', 'textarea', '', panel); input.rows = 8; input.maxLength = 30000;
            tab.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
                activate(next); panels[next].tab.focus();
            };
            panels.push({tab, panel}); tabs.appendChild(tab); prompts.appendChild(panel);
        });
        function activate(index) {
            panels.forEach((entry, offset) => {
                entry.panel.hidden = offset !== index; entry.tab.tabIndex = offset === index ? 0 : -1;
                entry.tab.setAttribute('aria-selected', String(offset === index));
            });
        }
        activate(0);
        const advanced = node('details', 'daki-personal-advanced'); advanced.appendChild(node('summary', '', '크기 · 생성 설정')); body.appendChild(advanced);
        const settings = node('div', 'daki-personal-settings'); advanced.appendChild(settings);
        for (const [key, label, min, max, step] of [['width', '너비', 64, 2048, 64], ['height', '높이', 64, 2048, 64],
            ['steps', '스텝', 1, 50, 1], ['cfg', 'CFG', 1, 20, .1], ['cfg_rescale', 'CFG Rescale', 0, 1, .01]]) {
            const input = field(key, label, 'input', 'number', settings); Object.assign(input, {min, max, step, required: true});
        }
        for (const [key, label, values] of [
            ['sampler', '샘플러', ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde']],
            ['noise_schedule', '노이즈 스케줄', ['native', 'karras', 'exponential', 'polyexponential']]]) {
            const input = field(key, label, 'select', '', settings);
            values.forEach(value => { const option = node('option', '', value); option.value = value; input.appendChild(option); });
        }
        advanced.appendChild(node('p', '', '크기는 64의 배수로 지정합니다. 가져온 나머지 생성 설정은 그대로 보관됩니다.'));
        const status = node('p', 'daki-personal-status'); status.id = 'dakiPersonalStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); body.appendChild(status);
        const actions = node('div', 'daki-dialog-actions daki-personal-actions');
        const cancel = button('취소', () => { if (!busy) dialog.close(); });
        const save = button('그림체 저장', null, 'daki-primary'); save.type = 'submit'; actions.append(cancel, save); form.appendChild(actions);
        dialog.appendChild(form); doc.body.appendChild(dialog);
        let busy = false;
        let draft = {model: 'nai-diffusion-5-full', preview: {width: 832, height: 1216},
            options: {steps: 28, cfg: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras'}};
        function live() { return token === editorRevision && dialog.open; }
        function setBusy(value) {
            busy = value; form.querySelectorAll('input, select, textarea, button').forEach(input => { input.disabled = value; });
        }
        function populate(style) {
            draft = {...style, options: {...style.options}, preview: {...style.preview}};
            for (const key of ['name', 'positive', 'negative', 'source_path']) fields[key].value = style[key] || '';
            if (!Object.keys(models).includes(style.model)) {
                const option = node('option', '', style.model); option.value = style.model; model.appendChild(option);
            }
            model.value = style.model;
            for (const key of ['width', 'height']) fields[key].value = style.preview?.[key] ?? (key === 'width' ? 832 : 1216);
            for (const key of ['steps', 'cfg', 'cfg_rescale', 'sampler', 'noise_schedule']) fields[key].value = style.options?.[key] ?? draft.options[key] ?? '';
        }
        async function importSource() {
            if (busy) return;
            const sourcePath = source.value.trim();
            if (!sourcePath) { status.textContent = '가져올 갤러리 그림의 경로를 입력해 주세요.'; source.focus(); return; }
            setBusy(true); status.textContent = '그림의 프롬프트와 설정을 읽는 중…';
            try {
                const result = await api(endpoint + '/import', 'POST', {path: sourcePath});
                if (!live()) return;
                populate(result.style); status.textContent = '가져왔습니다. 내용을 확인하거나 수정한 뒤 저장하세요.';
            } catch (error) { if (live()) status.textContent = error.message; }
            finally { if (live()) setBusy(false); }
        }
        form.onsubmit = async event => {
            event.preventDefault(); if (busy) return;
            const request = {name: name.value.trim(), positive: fields.positive.value, negative: fields.negative.value,
                model: model.value, source_path: source.value.trim(),
                preview: {...draft.preview, width: Number(fields.width.value), height: Number(fields.height.value)},
                options: {...draft.options}};
            for (const key of ['steps', 'cfg', 'cfg_rescale']) request.options[key] = Number(fields[key].value);
            for (const key of ['sampler', 'noise_schedule']) request.options[key] = fields[key].value;
            const activeView = view;
            setBusy(true); status.textContent = '그림체를 저장하는 중…';
            try {
                const result = await api(id ? endpoint + '/' + encodeURIComponent(id) : endpoint, id ? 'PUT' : 'POST', request);
                if (!live()) return;
                dialog.close(); root.showToast?.('개인 그림체에 저장했습니다.');
                if (typeof onSaved === 'function') await onSaved(result.style);
                else if (activeView && activeView === view && current(activeView.token)) {
                    activeView.container.replaceChildren(); await render(activeView.params, activeView.container);
                }
            } catch (error) { if (live()) status.textContent = error.message; }
            finally { if (live()) setBusy(false); }
        };
        dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
        dialog.addEventListener('close', () => {
            if (editor === dialog) { editor = null; editorRevision++; }
            dialog.remove(); if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
        }, {once: true});
        populate(draft); dialog.showModal(); name.focus({preventScroll: true});
        if (id) {
            let loaded = false;
            setBusy(true); status.textContent = '그림체를 불러오는 중…';
            try { const result = await api(endpoint + '/' + encodeURIComponent(id)); if (live()) { populate(result.style); status.textContent = ''; loaded = true; } }
            catch (error) {
                if (live()) {
                    status.textContent = error.message;
                    status.appendChild(button('다시 불러오기', () => openEditor({id, onSaved})));
                }
            }
            finally { if (live()) { setBusy(false); save.disabled = !loaded; } }
        } else if (path) { source.value = path; await importSource(); }
    }
    root.DakiPersonalStyles = {render, leave, openEditor};
})(typeof window !== 'undefined' ? window : globalThis);
