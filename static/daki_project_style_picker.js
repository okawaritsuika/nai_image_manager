(function attachDakiProjectStylePicker(root, factory) {
    'use strict';
    const api = factory(root);
    if (root) root.DakiProjectStylePicker = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function createDakiProjectStylePicker(root) {
    'use strict';

    const MAX_PROMPT_LENGTH = 100000;
    const MAX_CHARACTER_PROMPTS = 22;
    const MAX_VISIBLE_CANDIDATES = 40;
    const GENERATION_FIELDS = [
        {key: 'model', label: '모델', type: 'string', fallback: ['modelName', 'model_name']},
        {key: 'sampler', label: '샘플러', type: 'string'},
        {key: 'steps', label: 'Steps', type: 'number'},
        {key: 'cfg', label: 'CFG', type: 'number', fallback: ['scale']},
        {key: 'cfg_rescale', label: 'Rescale', type: 'number'},
        {key: 'noise_schedule', label: '노이즈 스케줄', type: 'string'},
        {key: 'seed', label: '시드', type: 'number'},
        {key: 'strength', label: '변경 강도', type: 'number'},
        {key: 'noise', label: '추가 노이즈', type: 'number'},
    ];

    function element(tag, className, text) {
        const node = root.document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function cloneSelection(selection) {
        if (!selection || typeof selection !== 'object') return null;
        return {
            base: Array.isArray(selection.base) ? selection.base.map(item => ({token: item.token, occurrence: item.occurrence})) : [],
            negative: Array.isArray(selection.negative) ? selection.negative.map(item => ({token: item.token, occurrence: item.occurrence})) : [],
        };
    }

    function splitTokens(prompt) {
        return prompt.split(',').map(token => token.trim()).filter(Boolean);
    }

    function promptIndexes(prompt) {
        return splitTokens(prompt).map((_, index) => index);
    }

    function normalizeGenerationValue(value, type) {
        if (type === 'string') return typeof value === 'string' && value.trim() ? value : undefined;
        if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
        if (typeof value === 'string' && value.trim()) {
            const number = Number(value);
            return Number.isFinite(number) ? number : undefined;
        }
        return undefined;
    }

    function extractGenerationSettings(data) {
        const result = {};
        for (const field of GENERATION_FIELDS) {
            const sources = [field.key, ...(field.fallback || [])];
            for (const source of sources) {
                const value = normalizeGenerationValue(data[source], field.type);
                if (value === undefined) continue;
                result[field.key] = value;
                break;
            }
        }
        return result;
    }

    function fileName(path) {
        const parts = String(path || '').split(/[\\/]/).filter(Boolean);
        return parts[parts.length - 1] || '이름 없는 그림';
    }

    function validProjectId(value) {
        return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
    }

    function requestError() {
        return new Error('자료를 불러오지 못했습니다. 다시 시도해 주세요.');
    }

    function create(options) {
        const settings = options || {};
        const host = settings.host;
        if (!host || typeof settings.onSelect !== 'function') throw new TypeError('host와 onSelect가 필요합니다.');

        const onSelect = settings.onSelect;
        const onPendingChange = typeof settings.onPendingChange === 'function' ? settings.onPendingChange : () => {};
        const wrapper = element('div', 'daki-project-style-picker');
        const instructions = element('p', 'daki-project-style-picker-help', '프로젝트 그림을 선택하면 Base와 Negative 프롬프트를 불러옵니다. 내용을 수정하거나 지운 뒤 연동 설정에 적용하세요.');
        const projectStatus = element('p', 'daki-project-style-picker-status', '프로젝트 그림을 불러오는 중…');
        projectStatus.setAttribute('role', 'status');
        projectStatus.setAttribute('aria-live', 'polite');
        const projectRetry = element('button', 'daki-project-style-picker-button', '프로젝트 그림 다시 불러오기');
        projectRetry.type = 'button';
        projectRetry.hidden = true;
        const gallery = element('div', 'daki-project-style-picker-gallery');
        gallery.setAttribute('aria-label', '현재 프로젝트의 그림');
        const moreCandidates = element('button', 'daki-project-style-picker-button', '더 보기');
        moreCandidates.type = 'button';
        moreCandidates.hidden = true;

        const draftPanel = element('section', 'daki-project-style-picker-draft');
        draftPanel.hidden = true;
        const imageHeading = element('div', 'daki-project-style-picker-image-heading');
        const imagePreview = element('img', 'daki-project-style-picker-preview');
        imagePreview.alt = '';
        imagePreview.loading = 'lazy';
        const imageName = element('p', 'daki-project-style-picker-image-name');
        imageHeading.append(imagePreview, imageName);
        const fieldTabs = element('div', 'daki-project-style-picker-tabs');
        fieldTabs.setAttribute('role', 'tablist');
        fieldTabs.setAttribute('aria-label', '프롬프트 종류');
        const baseTab = element('button', 'daki-project-style-picker-tab', 'Base');
        baseTab.type = 'button';
        baseTab.id = 'dakiProjectStylePickerBaseTab';
        baseTab.setAttribute('role', 'tab');
        baseTab.setAttribute('aria-controls', 'dakiProjectStylePickerBasePanel');
        baseTab.setAttribute('aria-selected', 'true');
        baseTab.setAttribute('tabindex', '0');
        const negativeTab = element('button', 'daki-project-style-picker-tab', 'Negative');
        negativeTab.type = 'button';
        negativeTab.id = 'dakiProjectStylePickerNegativeTab';
        negativeTab.setAttribute('role', 'tab');
        negativeTab.setAttribute('aria-controls', 'dakiProjectStylePickerNegativePanel');
        negativeTab.setAttribute('aria-selected', 'false');
        negativeTab.setAttribute('tabindex', '-1');
        fieldTabs.append(baseTab, negativeTab);
        const panel = element('div', 'daki-project-style-picker-prompt-panel');
        panel.id = 'dakiProjectStylePickerBasePanel';
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', baseTab.id);
        const promptText = element('textarea', 'daki-project-style-picker-prompt');
        promptText.id = 'dakiProjectStylePickerPromptText';
        promptText.maxLength = MAX_PROMPT_LENGTH;
        promptText.rows = 8;
        promptText.setAttribute('aria-label', 'Base 프롬프트');
        panel.append(promptText);
        const characterImportSection = element('section', 'daki-project-style-picker-import-section');
        const characterImportHeading = element('h4', 'daki-project-style-picker-import-heading', '캐릭터 프롬프트 가져오기');
        const characterSideLabel = element('label', 'daki-project-style-picker-import-label', '캐릭터를 추가할 면');
        const characterSide = element('select', 'daki-project-style-picker-select');
        characterSide.id = 'dakiProjectStylePickerCharacterSide';
        characterSide.setAttribute('aria-label', '캐릭터를 추가할 면');
        const frontOption = element('option', '', '앞면');
        frontOption.value = 'front';
        const backOption = element('option', '', '뒷면');
        backOption.value = 'back';
        characterSide.append(frontOption, backOption);
        characterImportSection.append(characterImportHeading, characterSideLabel, characterSide);
        characterSideLabel.htmlFor = characterSide.id;
        const characterImportStatus = element('p', 'daki-project-style-picker-import-status', '이 그림에 캐릭터 프롬프트가 없습니다.');
        characterImportStatus.setAttribute('role', 'status');
        characterImportStatus.setAttribute('aria-live', 'polite');
        const characterRows = element('div', 'daki-project-style-picker-character-rows');
        characterImportSection.append(characterImportStatus, characterRows);

        const generationImportSection = element('section', 'daki-project-style-picker-import-section');
        const generationImportHeading = element('h4', 'daki-project-style-picker-import-heading', '생성 설정 가져오기');
        const generationImportLabel = element('label', 'daki-project-style-picker-import-checkbox');
        const generationImport = element('input');
        generationImport.id = 'dakiProjectStylePickerImportGeneration';
        generationImport.type = 'checkbox';
        const generationImportLabelText = element('span', '', '생성 설정 가져오기');
        generationImportLabel.append(generationImport, generationImportLabelText);
        const generationImportStatus = element('p', 'daki-project-style-picker-import-status', '이 그림에 생성 설정이 없습니다.');
        generationImportStatus.setAttribute('role', 'status');
        generationImportStatus.setAttribute('aria-live', 'polite');
        const generationPreview = element('div', 'daki-project-style-picker-generation-preview');
        generationImportSection.append(generationImportHeading, generationImportLabel, generationImportStatus, generationPreview);
        const metadataStatus = element('p', 'daki-project-style-picker-status');
        metadataStatus.setAttribute('role', 'status');
        metadataStatus.setAttribute('aria-live', 'polite');
        const metadataRetry = element('button', 'daki-project-style-picker-button', '프롬프트 다시 불러오기');
        metadataRetry.type = 'button';
        metadataRetry.hidden = true;
        const actions = element('div', 'daki-project-style-picker-actions');
        const cancelButton = element('button', 'daki-project-style-picker-button', '편집 취소');
        cancelButton.type = 'button';
        const applyButton = element('button', 'daki-project-style-picker-apply', '편집한 프롬프트로 연결');
        applyButton.type = 'button';
        applyButton.disabled = true;
        actions.append(cancelButton, applyButton);
        draftPanel.append(imageHeading, fieldTabs, panel, characterImportSection, generationImportSection,
            metadataStatus, metadataRetry, actions);
        wrapper.append(instructions, projectStatus, projectRetry, gallery, moreCandidates, draftPanel);
        host.replaceChildren(wrapper);

        let disposed = false;
        let disabled = false;
        let projectId = '';
        let projectRevision = 0;
        let imageRevision = 0;
        let projectController = null;
        let imageController = null;
        let candidates = [];
        let candidatesLoaded = false;
        let candidateError = false;
        let visibleCandidates = MAX_VISIBLE_CANDIDATES;
        let currentCandidate = null;
        let draftPrompts = {base: '', negative: ''};
        let activeField = 'base';
        let savedStyle = null;
        let characterDrafts = [];
        let charactersAvailable = false;
        let characterSourceStatus = '이 그림에 캐릭터 프롬프트가 없습니다.';
        let generationSettings = {};
        let generationAvailable = false;
        let pending = false;
        let metadataLoading = false;
        let metadataError = false;

        function characterMetadata(data) {
            if (!Object.prototype.hasOwnProperty.call(data, 'charPrompts') || data.charPrompts === undefined
                || (Array.isArray(data.charPrompts) && data.charPrompts.length === 0)) {
                return {available: false, values: [], message: '이 그림에 캐릭터 프롬프트가 없습니다.'};
            }
            if (!Array.isArray(data.charPrompts) || data.charPrompts.length > MAX_CHARACTER_PROMPTS
                || data.charPrompts.some(value => typeof value !== 'string' || value.length > MAX_PROMPT_LENGTH)) {
                return {available: false, values: [], message: '이 그림의 캐릭터 프롬프트를 가져올 수 없습니다.'};
            }
            return {available: true, values: data.charPrompts, message: ''};
        }

        function renderCharacterImports(values, available, message) {
            characterRows.replaceChildren();
            charactersAvailable = available;
            characterSourceStatus = message;
            characterDrafts = available ? values.map(value => ({value, checked: false})) : [];
            if (available) {
                characterDrafts.forEach((draft, index) => {
                    const row = element('div', 'daki-project-style-picker-character-row');
                    const label = element('label', 'daki-project-style-picker-import-checkbox');
                    const checkbox = element('input');
                    checkbox.type = 'checkbox';
                    checkbox.setAttribute('aria-label', `Character ${index + 1} 가져오기`);
                    const labelText = element('span', '', `Character ${index + 1} 가져오기`);
                    label.append(checkbox, labelText);
                    const textarea = element('textarea', 'daki-project-style-picker-prompt daki-project-style-picker-character-prompt');
                    textarea.id = `dakiProjectStylePickerCharacterPrompt${index + 1}`;
                    textarea.rows = 3;
                    textarea.maxLength = MAX_PROMPT_LENGTH;
                    textarea.setAttribute('maxlength', String(MAX_PROMPT_LENGTH));
                    textarea.setAttribute('aria-label', `Character ${index + 1} 가져올 프롬프트`);
                    textarea.value = draft.value;
                    checkbox.addEventListener('change', () => {
                        draft.checked = checkbox.checked;
                        updateButtons();
                    });
                    textarea.addEventListener('input', () => {
                        draft.value = textarea.value;
                        updateButtons();
                    });
                    row.append(label, textarea);
                    characterRows.appendChild(row);
                });
            }
            updateButtons();
        }

        function renderGenerationImport(settings) {
            generationSettings = settings;
            generationAvailable = Object.keys(settings).length > 0;
            generationImport.checked = generationAvailable;
            generationImportStatus.textContent = generationAvailable ? '' : '이 그림에 생성 설정이 없습니다.';
            generationPreview.replaceChildren();
            for (const field of GENERATION_FIELDS) {
                if (!Object.prototype.hasOwnProperty.call(settings, field.key)) continue;
                const row = element('div', 'daki-project-style-picker-generation-row');
                const label = element('span', 'daki-project-style-picker-generation-label', field.label);
                const value = element('span', 'daki-project-style-picker-generation-value', String(settings[field.key]));
                row.append(label, value);
                generationPreview.appendChild(row);
            }
            updateButtons();
        }

        function resetImports(side = 'front') {
            characterDrafts = [];
            charactersAvailable = false;
            characterSourceStatus = '프롬프트를 불러오는 중…';
            characterSide.value = side === 'back' ? 'back' : 'front';
            characterRows.replaceChildren();
            generationSettings = {};
            generationAvailable = false;
            generationImport.checked = false;
            generationPreview.replaceChildren();
            generationImportStatus.textContent = '생성 설정을 불러오는 중…';
        }

        function selectedCharacterImports() {
            const values = [];
            for (const draft of characterDrafts) {
                if (!draft.checked) continue;
                if (!draft.value.trim() || draft.value.length > MAX_PROMPT_LENGTH) {
                    return {values: [], error: '선택한 캐릭터 프롬프트는 비어 있을 수 없고 10만 자까지 입력할 수 있습니다.'};
                }
                values.push(draft.value);
            }
            return {values, error: ''};
        }

        function isCurrentProject(revision, id = projectId) {
            return !disposed && projectRevision === revision && projectId === id;
        }

        function isCurrentImage(revision, projectToken, candidateId) {
            return isCurrentProject(projectToken) && imageRevision === revision
                && String(currentCandidate?.id) === candidateId;
        }

        function setPending(value) {
            if (pending === value) return;
            pending = value;
            onPendingChange(value);
            updateButtons();
        }

        function updateButtons() {
            const locked = disabled || disposed;
            const importsLocked = locked || !pending || metadataLoading || metadataError;
            const selectedCharacters = selectedCharacterImports();
            projectRetry.disabled = locked;
            moreCandidates.disabled = locked;
            metadataRetry.disabled = locked;
            cancelButton.disabled = locked;
            baseTab.disabled = locked;
            negativeTab.disabled = locked;
            promptText.disabled = locked || !pending || metadataLoading || metadataError;
            characterSide.disabled = importsLocked || !charactersAvailable;
            Array.from(characterRows.children || []).forEach(row => {
                const checkbox = row.children?.[0]?.children?.[0];
                const textarea = row.children?.[1];
                if (checkbox) checkbox.disabled = importsLocked || !charactersAvailable;
                if (textarea) textarea.disabled = importsLocked || !charactersAvailable;
            });
            generationImport.disabled = importsLocked || !generationAvailable;
            characterImportStatus.textContent = selectedCharacters.error || characterSourceStatus;
            const hasStyle = canBuildStyle();
            const hasCharacters = selectedCharacters.values.length > 0;
            const hasGeneration = generationImport.checked && generationAvailable;
            applyButton.disabled = importsLocked || !promptsWithinLimit() || selectedCharacters.error !== ''
                || (!hasStyle && !hasCharacters && !hasGeneration);
            Array.from(gallery.children || []).forEach(card => { card.disabled = locked || card.dataset.missing === 'true'; });
        }

        function validPrompt(value) {
            return value.length <= MAX_PROMPT_LENGTH && splitTokens(value).length > 0;
        }

        function validDraft() {
            return promptsWithinLimit()
                && (validPrompt(draftPrompts.base) || validPrompt(draftPrompts.negative));
        }

        function promptsWithinLimit() {
            return draftPrompts.base.length <= MAX_PROMPT_LENGTH
                && draftPrompts.negative.length <= MAX_PROMPT_LENGTH;
        }

        function canBuildStyle() {
            return !!currentCandidate && validProjectId(projectId) && validDraft()
                && root.CanvasStyleLink && typeof root.CanvasStyleLink.buildPromptSelection === 'function';
        }

        function renderCandidates() {
            gallery.replaceChildren();
            const rows = candidates.slice(0, visibleCandidates);
            if (!rows.length && candidatesLoaded && !candidateError) {
                projectStatus.textContent = '이 프로젝트에 등록된 그림이 없습니다. 앞면이나 뒷면 그림을 먼저 추가해 주세요.';
            }
            rows.forEach(candidate => {
                const sideName = candidate.side === 'front' ? '앞면' : '뒷면';
                const label = `${sideName} · ${candidate.name}`;
                const card = element('button', 'daki-project-style-picker-card');
                card.type = 'button';
                card.dataset.candidateId = candidate.id;
                card.dataset.missing = candidate.missing ? 'true' : 'false';
                card.title = label;
                card.setAttribute('aria-label', candidate.missing ? `${label} · 파일 없음` : label);
                const image = element('img', 'daki-project-style-picker-thumbnail');
                image.alt = '';
                image.loading = 'lazy';
                if (candidate.src) image.src = candidate.src;
                const name = element('span', 'daki-project-style-picker-name', label);
                card.append(image, name);
                if (candidate.missing) {
                    card.disabled = true;
                    const missing = element('small', 'daki-project-style-picker-missing', '파일 없음');
                    card.appendChild(missing);
                } else {
                    card.addEventListener('click', () => selectCandidate(candidate));
                }
                gallery.appendChild(card);
            });
            moreCandidates.hidden = candidates.length <= visibleCandidates;
            updateButtons();
        }

        function normalizeCandidates(payload) {
            if (!payload || payload.status !== 'success' || !payload.project
                || !payload.project.candidates || typeof payload.project.candidates !== 'object') throw requestError();
            const result = [];
            for (const side of ['front', 'back']) {
                const rows = payload.project.candidates[side];
                if (!Array.isArray(rows)) throw requestError();
                rows.forEach(candidate => {
                    if (!candidate || (typeof candidate.id !== 'string' && typeof candidate.id !== 'number')
                        || typeof candidate.path !== 'string') return;
                    const id = String(candidate.id);
                    result.push({
                        id,
                        path: candidate.path,
                        src: typeof candidate.src === 'string' ? candidate.src : '',
                        name: typeof candidate.name === 'string' && candidate.name.trim()
                            ? candidate.name : fileName(candidate.path),
                        side,
                        missing: candidate.missing === true,
                    });
                });
            }
            return result;
        }

        async function responseJson(response) {
            let payload;
            try { payload = await response.json(); } catch (_) { throw requestError(); }
            if (!response.ok) throw requestError();
            return payload;
        }

        async function loadProject(retry = false) {
            if (disposed || !projectId || disabled) return false;
            if (projectController) projectController.abort();
            const id = projectId;
            const revision = ++projectRevision;
            const controller = new root.AbortController();
            projectController = controller;
            candidatesLoaded = false;
            candidateError = false;
            projectStatus.textContent = '프로젝트 그림을 불러오는 중…';
            projectRetry.hidden = true;
            gallery.replaceChildren();
            moreCandidates.hidden = true;
            try {
                const payload = await responseJson(await root.fetch(`/api/daki/projects/${encodeURIComponent(id)}`, {signal: controller.signal}));
                const items = normalizeCandidates(payload);
                if (!isCurrentProject(revision, id) || controller.signal.aborted) return false;
                candidates = items;
                candidatesLoaded = true;
                visibleCandidates = MAX_VISIBLE_CANDIDATES;
                projectStatus.textContent = items.length ? `${items.length}개 그림을 불러왔습니다.`
                    : '이 프로젝트에 등록된 그림이 없습니다. 앞면이나 뒷면 그림을 먼저 추가해 주세요.';
                renderCandidates();
                return true;
            } catch (_) {
                if (!isCurrentProject(revision, id) || controller.signal.aborted) return false;
                candidateError = true;
                projectStatus.textContent = '프로젝트 그림을 불러오지 못했습니다. 다시 시도해 주세요.';
                projectRetry.hidden = false;
                return false;
            } finally {
                if (isCurrentProject(revision, id) && projectController === controller) projectController = null;
                updateButtons();
            }
        }

        function renderField() {
            const isBase = activeField === 'base';
            const field = isBase ? 'base' : 'negative';
            panel.id = isBase ? 'dakiProjectStylePickerBasePanel' : 'dakiProjectStylePickerNegativePanel';
            panel.setAttribute('aria-labelledby', isBase ? baseTab.id : negativeTab.id);
            baseTab.setAttribute('aria-selected', isBase ? 'true' : 'false');
            baseTab.setAttribute('tabindex', isBase ? '0' : '-1');
            negativeTab.setAttribute('aria-selected', isBase ? 'false' : 'true');
            negativeTab.setAttribute('tabindex', isBase ? '-1' : '0');
            promptText.value = draftPrompts[field];
            promptText.setAttribute('aria-label', `${isBase ? 'Base' : 'Negative'} 프롬프트`);
            updateButtons();
        }

        async function loadMetadata(candidate, imageToken, projectToken) {
            if (imageController) imageController.abort();
            const controller = new root.AbortController();
            imageController = controller;
            metadataLoading = true;
            metadataError = false;
            draftPrompts = {base: '', negative: ''};
            resetImports(candidate.side);
            metadataStatus.textContent = '프롬프트를 불러오는 중…';
            metadataRetry.hidden = true;
            renderField();
            try {
                const payload = await responseJson(await root.fetch('/api/prompt_info', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({path: candidate.path}),
                    signal: controller.signal,
                }));
                const data = payload && payload.status === 'success' ? payload.data : null;
                if (!data || typeof data.negativePrompt !== 'string') throw requestError();
                const basePrompt = typeof data.basePrompt === 'string' ? data.basePrompt
                    : typeof data.baseCaption === 'string' ? data.baseCaption : '';
                if (basePrompt.length > MAX_PROMPT_LENGTH || data.negativePrompt.length > MAX_PROMPT_LENGTH) {
                    throw new Error('이 그림의 프롬프트가 허용된 10만 자를 넘었습니다.');
                }
                if (!isCurrentImage(imageToken, projectToken, candidate.id) || controller.signal.aborted) return false;
                const hasSavedStyle = savedStyle && savedStyle.library === 'project'
                    && String(savedStyle.id) === candidate.id
                    && validProjectId(savedStyle.sourceProjectId) && savedStyle.sourceProjectId === projectId;
                draftPrompts = {
                    base: hasSavedStyle && typeof savedStyle.positive === 'string' ? savedStyle.positive : basePrompt,
                    negative: hasSavedStyle && typeof savedStyle.negative === 'string' ? savedStyle.negative : data.negativePrompt,
                };
                const characters = characterMetadata(data);
                renderCharacterImports(characters.values, characters.available, characters.message);
                renderGenerationImport(extractGenerationSettings(data));
                metadataStatus.textContent = '';
                renderField();
                return true;
            } catch (error) {
                if (!isCurrentImage(imageToken, projectToken, candidate.id) || controller.signal.aborted) return false;
                metadataError = true;
                metadataStatus.textContent = error instanceof Error && error.message.includes('10만 자')
                    ? error.message : '그림 프롬프트를 불러오지 못했습니다. 다시 시도해 주세요.';
                characterSourceStatus = '메타데이터를 불러오지 못해 가져올 수 없습니다.';
                characterImportStatus.textContent = characterSourceStatus;
                generationImportStatus.textContent = '메타데이터를 불러오지 못해 가져올 수 없습니다.';
                metadataRetry.hidden = false;
                renderField();
                return false;
            } finally {
                if (isCurrentImage(imageToken, projectToken, candidate.id) && imageController === controller) {
                    metadataLoading = false;
                    imageController = null;
                    renderField();
                }
            }
        }

        async function selectCandidate(candidate) {
            if (disabled || disposed || candidate.missing) return false;
            imageRevision += 1;
            const imageToken = imageRevision;
            const projectToken = projectRevision;
            currentCandidate = candidate;
            draftPrompts = {base: '', negative: ''};
            resetImports(candidate.side);
            activeField = 'base';
            imagePreview.hidden = !candidate.src;
            if (candidate.src) imagePreview.src = candidate.src;
            imageName.textContent = `${candidate.side === 'front' ? '앞면' : '뒷면'} · ${candidate.name}`;
            imageName.title = imageName.textContent;
            draftPanel.hidden = false;
            metadataStatus.textContent = '프롬프트를 불러오는 중…';
            metadataRetry.hidden = true;
            metadataLoading = true;
            metadataError = false;
            renderField();
            setPending(true);
            return loadMetadata(candidate, imageToken, projectToken);
        }

        function setField(field, focus = false) {
            activeField = field;
            renderField();
            if (focus) (field === 'base' ? baseTab : negativeTab).focus({preventScroll: true});
        }

        function buildStyle() {
            if (!currentCandidate || !validProjectId(projectId) || !validDraft()) return null;
            const canvasStyleLink = root.CanvasStyleLink;
            if (!canvasStyleLink || typeof canvasStyleLink.buildPromptSelection !== 'function') return null;
            const hasSavedStyle = savedStyle && savedStyle.library === 'project'
                && String(savedStyle.id) === currentCandidate.id
                && validProjectId(savedStyle.sourceProjectId) && savedStyle.sourceProjectId === projectId;
            const selectionForField = (field, text) => {
                const savedText = field === 'base' ? savedStyle?.positive : savedStyle?.negative;
                if (hasSavedStyle && savedText === text && savedStyle.selection) {
                    return cloneSelection(savedStyle.selection)[field];
                }
                return canvasStyleLink.buildPromptSelection(text, promptIndexes(text));
            };
            const selection = {
                base: selectionForField('base', draftPrompts.base),
                negative: selectionForField('negative', draftPrompts.negative),
            };
            return {
                id: currentCandidate.id,
                library: 'project',
                sourceProjectId: projectId,
                name: currentCandidate.name || fileName(currentCandidate.path),
                positive: draftPrompts.base,
                negative: draftPrompts.negative,
                selection,
            };
        }

        function applySelection() {
            if (disabled || !pending || metadataLoading || metadataError || !promptsWithinLimit()) return false;
            const style = buildStyle();
            const selectedCharacters = selectedCharacterImports();
            const inpaintSettings = generationImport.checked && generationAvailable
                ? {...generationSettings} : null;
            if (selectedCharacters.error || (!style && !selectedCharacters.values.length && !inpaintSettings)) return false;
            const detached = style ? {...style, selection: cloneSelection(style.selection)} : null;
            const imports = {
                side: characterSide.value,
                charPrompts: [...selectedCharacters.values],
                inpaintSettings,
            };
            const result = onSelect(detached, imports);
            if (typeof result === 'string') {
                metadataStatus.textContent = result;
                return false;
            }
            if (detached) savedStyle = {...detached, selection: cloneSelection(detached.selection)};
            draftPanel.hidden = true;
            resetImports(currentCandidate?.side);
            currentCandidate = null;
            if (imageController) imageController.abort();
            imageController = null;
            imageRevision += 1;
            setPending(false);
            return true;
        }

        function cancel() {
            if (imageController) imageController.abort();
            imageController = null;
            imageRevision += 1;
            currentCandidate = null;
            metadataLoading = false;
            metadataError = false;
            draftPrompts = {base: '', negative: ''};
            resetImports();
            draftPanel.hidden = true;
            setPending(false);
            renderCandidates();
            return true;
        }

        projectRetry.addEventListener('click', () => !disabled ? loadProject(true) : false);
        moreCandidates.addEventListener('click', () => {
            if (disabled) return;
            visibleCandidates += MAX_VISIBLE_CANDIDATES;
            renderCandidates();
        });
        metadataRetry.addEventListener('click', () => {
            if (!disabled && currentCandidate) {
                const candidate = currentCandidate;
                const imageToken = imageRevision;
                const projectToken = projectRevision;
                metadataLoading = true;
                metadataError = false;
                return loadMetadata(candidate, imageToken, projectToken);
            }
            return false;
        });
        cancelButton.addEventListener('click', cancel);
        applyButton.addEventListener('click', applySelection);
        promptText.addEventListener('input', () => {
            draftPrompts[activeField] = promptText.value;
            updateButtons();
        });
        characterSide.addEventListener('change', updateButtons);
        generationImport.addEventListener('change', updateButtons);
        baseTab.addEventListener('click', () => setField('base'));
        negativeTab.addEventListener('click', () => setField('negative'));
        fieldTabs.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            if (event.key === 'Home') setField('base', true);
            else if (event.key === 'End') setField('negative', true);
            else setField(activeField === 'base' ? 'negative' : 'base', true);
        });

        async function open(openOptions) {
            if (disposed) return false;
            const nextProjectId = String(openOptions?.projectId ?? '');
            if (!validProjectId(nextProjectId)) {
                projectId = nextProjectId;
                projectStatus.textContent = '프로젝트 ID 형식이 올바르지 않습니다.';
                projectRetry.hidden = true;
                return false;
            }
            savedStyle = openOptions?.style && typeof openOptions.style === 'object'
                ? {...openOptions.style, selection: cloneSelection(openOptions.style.selection)} : null;
            if (projectId && projectId !== nextProjectId) {
                cancel();
                if (projectController) projectController.abort();
                projectController = null;
                candidates = [];
                candidatesLoaded = false;
                candidateError = false;
                visibleCandidates = MAX_VISIBLE_CANDIDATES;
            }
            projectId = nextProjectId;
            if (projectController && !candidatesLoaded) return true;
            if (candidatesLoaded && !candidateError) {
                renderCandidates();
                return true;
            }
            return loadProject(false);
        }

        function setDisabled(value) {
            disabled = Boolean(value);
            updateButtons();
        }

        function dispose() {
            if (disposed) return;
            disposed = true;
            projectRevision += 1;
            imageRevision += 1;
            if (projectController) projectController.abort();
            if (imageController) imageController.abort();
            projectController = null;
            imageController = null;
            host.replaceChildren();
        }

        updateButtons();
        return {open, cancel, setDisabled, dispose};
    }

    return {create};
});
