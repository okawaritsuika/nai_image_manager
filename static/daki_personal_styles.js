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
    let confirmedPicker = null;
    let personalDeleteDialog = null;
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
        if (confirmedPicker) closeConfirmedPicker(confirmedPicker, false);
        if (personalDeleteDialog) closePersonalDeleteDialog(personalDeleteDialog, false, true);
        if (editor?.open) editor.close();
        root.DakiWorldCup?.leave?.();
    }
    function current(token) { return token === revision && root.Daki.isActive(); }
    function imageFor(style) {
        if (!style.source_path) return null;
        return {path: `__daki_personal__/${style.id}.png`, name: style.name,
            src: style.src || `${endpoint}/${encodeURIComponent(style.id)}/preview`};
    }
    function styleCard(style, activeView) {
        const card = node('article', 'item-box daki-style-card daki-personal-card');
        const image = imageFor(style);
        if (image) {
            const img = node('img', 'zoomable'); img.src = image.src; img.alt = style.name; img.loading = 'lazy';
            img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', style.name + ' 크게 보기');
            card.appendChild(img); root.Daki.bindImage(card, img, image.path);
        } else card.appendChild(node('div', 'daki-personal-placeholder', '🖼️ 대표 그림 없음'));
        const actions = node('div', 'gallery-card-actions daki-image-actions');
        const remove = button('그림체 삭제', () => openPersonalDeleteDialog(style, remove, activeView),
            'gallery-card-action-btn daki-personal-delete');
        remove.setAttribute('aria-label', style.name + ' 그림체 삭제');
        actions.append(node('span', '', style.name), button('그림체 수정', () => openEditor({id: style.id}), 'gallery-card-action-btn'), remove);
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
            toolbar.append(button('＋ 개인 그림체', () => openEditor()),
                button('확정 그림체 가져오기', openConfirmedPicker), createTest);
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
            const cards = styles.map(style => ({style, card: styleCard(style, view)}));
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
            const input = field(key, label + ' 프롬프트', 'textarea', '', panel); input.setAttribute('data-prompt-autocomplete', ''); input.rows = 8; input.maxLength = 30000;
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
        const advanced = node('details', 'daki-personal-advanced'); advanced.appendChild(node('summary', '', '생성 설정')); body.appendChild(advanced);
        const settings = node('div', 'daki-personal-settings'); advanced.appendChild(settings);
        for (const [key, label, min, max, step] of [['steps', '스텝', 1, 50, 1], ['cfg', 'CFG', 1, 20, .1], ['cfg_rescale', 'CFG Rescale', 0, 1, .01]]) {
            const input = field(key, label, 'input', 'number', settings); Object.assign(input, {min, max, step, required: true});
        }
        for (const [key, label, values] of [
            ['sampler', '샘플러', ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde']],
            ['noise_schedule', '노이즈 스케줄', ['native', 'karras', 'exponential', 'polyexponential']]]) {
            const input = field(key, label, 'select', '', settings);
            values.forEach(value => { const option = node('option', '', value); option.value = value; input.appendChild(option); });
        }
        advanced.appendChild(node('p', '', '가져온 나머지 생성 설정은 그대로 보관됩니다.'));
        const trial = node('section', 'daki-personal-trial'); body.appendChild(trial);
        trial.append(node('h3', '', '시안용 프롬프트'), node('p', '', '그림체 Base · Nega 뒤에 각각 추가됩니다. 시안용 프롬프트와 크기는 저장하지 않습니다.'));
        for (const [key, label] of [['prompt', '시안용 Base'], ['negative_prompt', '시안용 Nega']]) {
            const input = field(key, label, 'textarea', '', trial);
            input.rows = 3; input.maxLength = 30000; input.setAttribute('data-prompt-autocomplete', '');
        }
        const trialSize = node('div', 'daki-personal-settings'); trial.appendChild(trialSize);
        for (const [key, label, value] of [['width', '시안 너비', 832], ['height', '시안 높이', 1216]]) {
            Object.assign(field(key, label, 'input', 'number', trialSize), {min: 64, max: 2048, step: 64, value});
        }
        trial.appendChild(node('p', '', '크기는 64의 배수로 지정합니다. 그림체 적용 크기에는 영향을 주지 않습니다.'));
        const resultPanel = node('section', 'daki-personal-trial-result'); resultPanel.hidden = true;
        const resultImage = node('img'); resultImage.alt = '생성한 개인 그림체 시안';
        const useResult = button('대표 그림으로 사용', () => {
            selectedImage = generatedImage; selectedSource = source.value.trim();
            status.textContent = '대표 그림으로 선택했습니다. 그림체 저장을 누르면 반영됩니다.';
        });
        resultPanel.append(resultImage, useResult); trial.appendChild(resultPanel);
        let generatedImage = null, selectedImage = null, selectedSource = '';
        const status = node('p', 'daki-personal-status'); status.id = 'dakiPersonalStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); body.appendChild(status);
        const actions = node('div', 'daki-dialog-actions daki-personal-actions');
        const cancel = button('취소', () => { if (!busy) dialog.close(); });
        const save = button('그림체 저장', null, 'daki-primary'); save.type = 'submit';
        const generate = button('시안 생성', generateTrial); actions.append(cancel, generate, save); form.appendChild(actions);
        dialog.appendChild(form); doc.body.appendChild(dialog);
        let busy = false, editorReady = !id;
        let draft = {model: 'nai-diffusion-5-full', preview: {width: 832, height: 1216},
            options: {steps: 28, cfg: 5, cfg_rescale: 0, sampler: 'k_euler_ancestral', noise_schedule: 'karras'}};
        function live() { return token === editorRevision && dialog.open; }
        function setBusy(value) {
            busy = value; form.querySelectorAll('input, select, textarea, button').forEach(input => { input.disabled = value; });
            save.disabled = value || !editorReady;
        }
        function populate(style) {
            selectedImage = null; generatedImage = null; resultPanel.hidden = true;
            draft = {...style, options: {...style.options}, preview: {...style.preview}};
            for (const key of ['name', 'positive', 'negative', 'source_path']) fields[key].value = style[key] || '';
            if (!Object.keys(models).includes(style.model)) {
                const option = node('option', '', style.model); option.value = style.model; model.appendChild(option);
            }
            model.value = style.model;
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
        function recipe() {
            const request = {name: name.value.trim(), positive: fields.positive.value, negative: fields.negative.value,
                model: model.value, source_path: source.value.trim(),
                preview: {...draft.preview},
                options: {...draft.options}};
            for (const key of ['steps', 'cfg', 'cfg_rescale']) request.options[key] = Number(fields[key].value);
            for (const key of ['sampler', 'noise_schedule']) request.options[key] = fields[key].value;
            if (selectedImage && selectedSource === source.value.trim()) request.representative_image = selectedImage;
            return request;
        }
        async function generateTrial() {
            if (busy) return;
            const request = {...recipe(), width: Number(fields.width.value), height: Number(fields.height.value),
                prompt: fields.prompt.value, negative_prompt: fields.negative_prompt.value};
            delete request.representative_image;
            if (!request.positive.trim()) { status.textContent = 'Base 프롬프트를 입력해 주세요.'; return; }
            if (![request.width, request.height].every(value => Number.isInteger(value) && value >= 64 && value <= 2048 && value % 64 === 0)) {
                status.textContent = '시안 크기는 64~2048 사이의 64 배수로 입력해 주세요.'; return;
            }
            setBusy(true);
            try {
                const paid = request.width * request.height > 1048576 || request.options.steps > 28;
                if (paid) {
                    if (!root.showAnlasWarningModal) throw new Error('Anlas 안내를 불러오지 못했습니다. 페이지를 새로 열어 주세요.');
                    const allowed = await root.showAnlasWarningModal({width: request.width, height: request.height,
                        steps: request.options.steps, parent: dialog});
                    if (!allowed || !live()) return;
                    request.allow_anlas = true;
                }
                status.textContent = '시안을 생성하는 중…';
                const result = await api(endpoint + '/generate', 'POST', request);
                if (!live()) return;
                generatedImage = result.image; resultImage.src = generatedImage; resultPanel.hidden = false;
                status.textContent = '시안을 확인한 뒤 대표 그림으로 사용할지 선택하세요.';
                resultPanel.scrollIntoView?.({block: 'nearest'});
            } catch (error) { if (live()) status.textContent = error.message; }
            finally { if (live()) setBusy(false); }
        }
        form.onsubmit = async event => {
            event.preventDefault(); if (busy || !editorReady) return;
            const request = recipe();
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
            setBusy(true); status.textContent = '그림체를 불러오는 중…';
            try { const result = await api(endpoint + '/' + encodeURIComponent(id)); if (live()) { populate(result.style); status.textContent = ''; editorReady = true; } }
            catch (error) {
                if (live()) {
                    status.textContent = error.message;
                    status.appendChild(button('다시 불러오기', () => openEditor({id, onSaved})));
                }
            }
            finally { if (live()) setBusy(false); }
        } else if (path) { source.value = path; await importSource(); }
    }

    function openPersonalDeleteDialog(style, opener, activeView) {
        if (!activeView || activeView !== view || !current(activeView.token) || !opener.isConnected) return;
        if (personalDeleteDialog?.busy) return;
        if (personalDeleteDialog) closePersonalDeleteDialog(personalDeleteDialog, false);
        const dialog = node('dialog', 'daki-dialog daki-project-delete-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiPersonalDeleteTitle');
        dialog.setAttribute('aria-describedby', 'dakiPersonalDeleteDescription');
        const title = node('h2', 'daki-project-delete-title', '개인 그림체를 삭제할까요?');
        title.id = 'dakiPersonalDeleteTitle';
        const close = button('×', null, 'daki-project-delete-close');
        close.setAttribute('aria-label', '닫기');
        const header = node('header', 'daki-project-delete-header'); header.append(title, close);
        const body = node('div', 'daki-project-delete-body');
        const selection = node('div', 'daki-project-delete-selection');
        selection.append(node('span', 'daki-project-delete-side', '개인 그림체'),
            node('strong', 'daki-project-delete-name', style.name));
        const description = node('p', 'daki-project-delete-description',
            '등록한 그림체와 앱에 복사한 대표 그림을 삭제합니다. 가져온 확정 그림체 원본·갤러리 원본과 기존 테스트 결과는 유지됩니다.');
        description.id = 'dakiPersonalDeleteDescription';
        const status = node('p', 'daki-personal-status');
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        body.append(selection, description, status);
        const actions = node('footer', 'daki-project-delete-actions');
        const cancel = button('취소', null, 'daki-project-delete-cancel');
        const confirm = button('개인 그림체 삭제', null, 'daki-primary daki-project-delete-confirm');
        actions.append(cancel, confirm); dialog.append(header, body, actions); doc.body.appendChild(dialog);
        const state = {dialog, opener, activeView, token: activeView.token, busy: false, closed: false};
        personalDeleteDialog = state;

        function live() {
            return personalDeleteDialog === state && !state.closed && dialog.open
                && activeView === view && current(state.token) && opener.isConnected;
        }
        function setBusy(value) {
            state.busy = value;
            close.disabled = cancel.disabled = confirm.disabled = value;
            dialog.setAttribute('aria-busy', String(value));
        }
        async function removeStyle() {
            if (state.busy || !live()) return;
            setBusy(true); status.textContent = '개인 그림체를 삭제하는 중…';
            try {
                await api(endpoint + '/' + encodeURIComponent(style.id), 'DELETE');
                if (!live()) return;
                closePersonalDeleteDialog(state, false);
                root.showToast?.('개인 그림체를 삭제했습니다.');
                if (activeView === view && current(state.token)) {
                    activeView.container.replaceChildren();
                    await render(activeView.params, activeView.container);
                }
            } catch (error) {
                if (live()) { status.textContent = error.message; setBusy(false); confirm.focus({preventScroll: true}); }
            }
        }
        close.onclick = () => closePersonalDeleteDialog(state, true);
        cancel.onclick = () => closePersonalDeleteDialog(state, true);
        confirm.onclick = removeStyle;
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            if (!state.busy) closePersonalDeleteDialog(state, true);
        });
        dialog.addEventListener('close', () => {
            if (!state.closed) closePersonalDeleteDialog(state, true, true);
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog || state.busy) return;
            const bounds = dialog.getBoundingClientRect?.();
            if (bounds && (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
                closePersonalDeleteDialog(state, true);
            }
        });
        dialog.showModal(); cancel.focus({preventScroll: true});
        return state;
    }

    function closePersonalDeleteDialog(state, restoreFocus = true, force = false) {
        if (!state || state.closed || (state.busy && !force)) return;
        state.closed = true;
        if (personalDeleteDialog === state) personalDeleteDialog = null;
        if (state.dialog.open) state.dialog.close();
        state.dialog.remove();
        if (restoreFocus && state.opener.isConnected && state.activeView === view && current(state.token)) {
            state.opener.focus({preventScroll: true});
        }
    }

    function openConfirmedPicker() {
        const activeView = view;
        if (!activeView || !current(activeView.token)) return;
        if (confirmedPicker) closeConfirmedPicker(confirmedPicker, false);
        const opener = doc.activeElement;
        const dialog = node('dialog', 'daki-dialog daki-personal-dialog daki-personal-picker-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiPersonalPickerTitle');
        dialog.setAttribute('aria-describedby', 'dakiPersonalPickerDescription');
        const header = node('header', 'daki-personal-header');
        const title = node('h2', '', '확정 그림체 가져오기'); title.id = 'dakiPersonalPickerTitle';
        const description = node('p', '', '확정 그림체를 선택해 개인 그림체로 복사합니다. 복사본은 원본과 독립적으로 관리됩니다.');
        description.id = 'dakiPersonalPickerDescription'; header.append(title, description);
        const body = node('div', 'daki-personal-body daki-personal-picker-body');
        const searchLabel = node('label', 'daki-personal-field', '확정 그림체 검색');
        const search = node('input'); search.type = 'search'; search.placeholder = '이름 또는 모델 검색';
        search.setAttribute('aria-label', '확정 그림체 이름 또는 모델 검색'); searchLabel.appendChild(search);
        const list = node('div', 'daki-personal-picker-grid');
        const more = node('p', 'daki-personal-picker-more');
        const moreButton = button('더 보기', () => {
            if (!live() || state.loading || state.copying) return;
            state.limit += 60; updateChoices();
        }, 'nav-btn');
        moreButton.hidden = true;
        const status = node('p', 'daki-personal-status');
        status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        body.append(searchLabel, list, more, moreButton, status);
        const actions = node('footer', 'daki-dialog-actions daki-personal-actions');
        const cancel = button('취소', null);
        const copy = button('개인 그림체로 복사', null, 'daki-primary'); copy.disabled = true;
        actions.append(cancel, copy); dialog.append(header, body, actions); doc.body.appendChild(dialog);
        const state = {dialog, opener, activeView, token: activeView.token, styles: [], selected: null,
            loading: false, copying: false, closed: false, choices: [], limit: 60};
        confirmedPicker = state;

        function live() {
            return confirmedPicker === state && !state.closed && dialog.open
                && activeView === view && current(state.token);
        }
        function dismiss(restoreFocus = true) { closeConfirmedPicker(state, restoreFocus); }
        function updateChoices() {
            const query = search.value.trim().toLowerCase();
            const matches = state.styles.filter(style => `${style.name || ''} ${style.model || ''}`.toLowerCase().includes(query));
            const shown = matches.slice(0, state.limit);
            if (state.selected && !shown.includes(state.selected)) state.selected = null;
            state.choices = [];
            list.replaceChildren();
            shown.forEach(style => {
                const name = String(style.name || '이름 없는 그림체');
                const modelKey = style.model == null ? '' : String(style.model);
                const model = Object.prototype.hasOwnProperty.call(models, modelKey)
                    ? models[modelKey] : modelKey || '모델 정보 없음';
                const choice = button('', () => {
                    if (!live() || state.loading || state.copying) return;
                    state.selected = style;
                    state.choices.forEach(entry => {
                        const selected = entry.style === style;
                        entry.button.setAttribute('aria-pressed', String(selected));
                        entry.button.className = `daki-personal-picker-choice${selected ? ' is-selected' : ''}`;
                    });
                    copy.disabled = false;
                    status.textContent = '';
                }, `daki-personal-picker-choice${state.selected === style ? ' is-selected' : ''}`);
                choice.setAttribute('aria-pressed', String(state.selected === style));
                choice.setAttribute('aria-label', `${name}, ${model}`);
                if (style.src) {
                    const image = node('img'); image.src = style.src; image.alt = `${name} 대표 그림`; image.loading = 'lazy';
                    choice.appendChild(image);
                } else choice.appendChild(node('span', 'daki-personal-picker-placeholder', '대표 그림 없음'));
                const details = node('span', 'daki-personal-picker-choice-text');
                details.append(node('strong', '', name), node('span', '', model));
                choice.appendChild(details); state.choices.push({style, button: choice}); list.appendChild(choice);
            });
            copy.disabled = state.loading || state.copying || !state.selected;
            more.textContent = matches.length > shown.length ? `${matches.length}개 검색 결과 중 ${shown.length}개를 표시합니다.` : '';
            moreButton.hidden = matches.length <= shown.length;
            moreButton.disabled = state.loading || state.copying;
            if (!state.loading && !state.styles.length) status.textContent = '가져올 확정 그림체가 없습니다.';
            else if (!state.loading && !shown.length) status.textContent = '검색 결과가 없습니다.';
            else if (status.textContent === '검색 결과가 없습니다.' || status.textContent === '가져올 확정 그림체가 없습니다.') status.textContent = '';
        }
        async function loadStyles() {
            if (state.loading || state.copying || !live()) return;
            state.loading = true; search.disabled = true; copy.disabled = true; moreButton.disabled = true;
            list.replaceChildren(); more.textContent = ''; status.textContent = '확정 그림체를 불러오는 중…';
            try {
                const result = await api('/api/daki/confirmed-styles');
                if (!live()) return;
                if (!Array.isArray(result.styles)) throw new Error('확정 그림체 목록을 불러오지 못했습니다.');
                state.styles = result.styles; state.loading = false; status.textContent = ''; updateChoices();
            } catch (error) {
                if (live()) {
                    status.textContent = error.message;
                    status.appendChild(button('다시 불러오기', loadStyles));
                }
            } finally {
                state.loading = false;
                if (live()) { search.disabled = false; copy.disabled = !state.selected; moreButton.disabled = state.copying; }
            }
        }
        async function copyStyle() {
            if (state.copying || state.loading || !state.selected || !live()) return;
            const selected = state.selected;
            state.copying = true; search.disabled = true; moreButton.disabled = true;
            state.choices.forEach(entry => { entry.button.disabled = true; });
            copy.disabled = true; status.textContent = '개인 그림체로 복사하는 중…';
            try {
                await api('/api/daki/personal-styles/import-confirmed', 'POST', {style_id: selected.id});
                if (!live()) return;
                closeConfirmedPicker(state, false);
                root.showToast?.('개인 그림체로 복사했습니다.');
                if (activeView === view && current(state.token)) {
                    activeView.container.replaceChildren();
                    await render(activeView.params, activeView.container);
                }
            } catch (error) {
                if (live()) {
                    status.textContent = error.message;
                    state.copying = false; search.disabled = false; moreButton.disabled = false;
                    state.choices.forEach(entry => { entry.button.disabled = false; });
                    copy.disabled = !state.selected; copy.focus({preventScroll: true});
                }
            }
        }
        search.oninput = () => {
            if (live() && !state.loading && !state.copying) { state.limit = 60; updateChoices(); }
        };
        cancel.onclick = () => dismiss(true);
        copy.onclick = copyStyle;
        dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(true); });
        dialog.addEventListener('close', () => {
            if (!state.closed) closeConfirmedPicker(state, true);
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect?.();
            if (bounds && (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom)) dismiss(true);
        });
        dialog.showModal(); search.focus({preventScroll: true});
        loadStyles();
        return state;
    }

    function closeConfirmedPicker(state, restoreFocus = true) {
        if (!state || state.closed) return;
        state.closed = true;
        if (confirmedPicker === state) confirmedPicker = null;
        if (state.dialog.open) state.dialog.close();
        state.dialog.remove();
        if (restoreFocus && state.opener?.isConnected && state.activeView === view && current(state.token)) {
            state.opener.focus({preventScroll: true});
        }
    }

    root.DakiPersonalStyles = {render, leave, openEditor};
})(typeof window !== 'undefined' ? window : globalThis);
