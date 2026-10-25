/* Project-owned canvas style and generation settings editor. */
(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (root) root.DakiProjectSettings = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const MAX_PROMPT_LENGTH = 100000;
    const MAX_CHARACTER_PROMPTS = 22;
    const GENERATION_PREFIX = 'projectLink';
    const CHANNEL_NAME = 'naim-project-canvas-settings';
    const IMPORTABLE_GENERATION_FIELDS = {
        model: 'string', sampler: 'string', steps: 'number', cfg: 'number', cfg_rescale: 'number',
        noise_schedule: 'string', seed: 'number', strength: 'number', noise: 'number',
    };
    let modal = null;
    let active = null;
    let openRevision = 0;

    function makeElement(tag, className, text) {
        const node = root.document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function addOption(select, value, label) {
        const option = makeElement('option', '', label);
        option.value = value;
        select.appendChild(option);
        return option;
    }

    function isRecord(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isId(value) {
        return (typeof value === 'string' && value.length > 0)
            || (typeof value === 'number' && Number.isFinite(value));
    }

    function copyStyle(style) {
        if (!style) return null;
        const result = {
            id: style.id,
            name: style.name,
            library: style.library,
            positive: style.positive,
            negative: style.negative,
        };
        if (Object.prototype.hasOwnProperty.call(style, 'sourceProjectId')) result.sourceProjectId = style.sourceProjectId;
        if (Object.prototype.hasOwnProperty.call(style, 'selection') && isRecord(style.selection)) {
            result.selection = {
                base: Array.isArray(style.selection.base) ? style.selection.base.map(item => ({...item})) : [],
                negative: Array.isArray(style.selection.negative) ? style.selection.negative.map(item => ({...item})) : [],
            };
        }
        return result;
    }

    function normalizeStyleSelection(selection) {
        if (!isRecord(selection)) return null;
        const result = {base: [], negative: []};
        const seen = {base: new Set(), negative: new Set()};
        let total = 0;
        for (const field of ['base', 'negative']) {
            if (!Array.isArray(selection[field]) || selection[field].length > MAX_PROMPT_LENGTH) return null;
            let characters = 0;
            for (const item of selection[field]) {
                if (!isRecord(item) || typeof item.token !== 'string' || !item.token.trim()
                    || item.token !== item.token.trim() || item.token.includes(',')
                    || item.token.length > MAX_PROMPT_LENGTH || !Number.isSafeInteger(item.occurrence)
                    || item.occurrence < 0) return null;
                characters += item.token.length;
                if (characters > MAX_PROMPT_LENGTH) return null;
                const key = JSON.stringify([item.token, item.occurrence]);
                if (seen[field].has(key)) return null;
                seen[field].add(key);
                result[field].push({token: item.token, occurrence: item.occurrence});
                total += 1;
            }
        }
        return total ? result : null;
    }

    function normalizeStyle(style) {
        if (style === null) return null;
        if (!isRecord(style) || !isId(style.id) || typeof style.name !== 'string'
            || !['shared', 'personal', 'project'].includes(style.library)
            || typeof style.positive !== 'string' || style.positive.length > MAX_PROMPT_LENGTH
            || typeof style.negative !== 'string' || style.negative.length > MAX_PROMPT_LENGTH) {
            throw new Error('저장된 그림체 설정 형식이 올바르지 않습니다.');
        }
        const result = {...copyStyle(style), id: String(style.id)};
        if (style.name.length > 500) throw new Error('저장된 그림체 설정 형식이 올바르지 않습니다.');
        if (Object.prototype.hasOwnProperty.call(style, 'selection')) {
            const selection = normalizeStyleSelection(style.selection);
            if (!selection) throw new Error('저장된 그림체 설정 형식이 올바르지 않습니다.');
            result.selection = selection;
        }
        if (style.library === 'project') {
            if (typeof style.id !== 'string' || style.id.length > 256
                || typeof style.sourceProjectId !== 'string' || !/^[0-9a-f]{32}$/.test(style.sourceProjectId)
                || !Object.prototype.hasOwnProperty.call(style, 'selection') || !result.selection) {
                throw new Error('저장된 그림체 설정 형식이 올바르지 않습니다.');
            }
            result.sourceProjectId = style.sourceProjectId;
        } else if (Object.prototype.hasOwnProperty.call(style, 'sourceProjectId')) {
            throw new Error('저장된 그림체 설정 형식이 올바르지 않습니다.');
        }
        return result;
    }

    function normalizeInpaintSettings(settings) {
        if (settings === null) return null;
        if (!isRecord(settings)) throw new Error('인페인트 설정 형식이 올바르지 않습니다.');
        const stringFields = ['model', 'sampler', 'noise_schedule'];
        const numberFields = ['steps', 'cfg', 'cfg_rescale', 'seed', 'strength', 'noise'];
        const result = {};
        for (const field of stringFields) {
            if (typeof settings[field] !== 'string') throw new Error('인페인트 설정 형식이 올바르지 않습니다.');
            result[field] = settings[field];
        }
        for (const field of numberFields) {
            if (typeof settings[field] !== 'number' || !Number.isFinite(settings[field])) {
                throw new Error('인페인트 설정 형식이 올바르지 않습니다.');
            }
            result[field] = settings[field];
        }
        return result;
    }

    function normalizeSettingsResponse(response) {
        if (!isRecord(response) || response.status !== 'success'
            || !Number.isSafeInteger(response.settings?.revision) || response.settings.revision < 0
            || !isRecord(response.settings)) {
            throw new Error('프로젝트 설정 응답 형식이 올바르지 않습니다.');
        }
        const settings = response.settings;
        if (!isRecord(settings.prompts)) throw new Error('그룹 프롬프트 설정 형식이 올바르지 않습니다.');
        const prompts = {};
        for (const side of ['front', 'back']) {
            const prompt = settings.prompts[side];
            if (!isRecord(prompt) || typeof prompt.basePrompt !== 'string'
                || typeof prompt.negativePrompt !== 'string') {
                throw new Error('그룹 프롬프트 설정 형식이 올바르지 않습니다.');
            }
            const charPrompts = prompt.charPrompts === undefined ? [] : prompt.charPrompts;
            if (!Array.isArray(charPrompts) || charPrompts.length > MAX_CHARACTER_PROMPTS
                || charPrompts.some(value => typeof value !== 'string' || value.length > MAX_PROMPT_LENGTH)) {
                throw new Error('캐릭터 프롬프트 설정 형식이 올바르지 않습니다.');
            }
            prompts[side] = {basePrompt: prompt.basePrompt, negativePrompt: prompt.negativePrompt, charPrompts: [...charPrompts]};
        }
        if (!Object.prototype.hasOwnProperty.call(settings, 'style')
            || !Object.prototype.hasOwnProperty.call(settings, 'inpaintSettings')) {
            throw new Error('프로젝트 설정 응답 형식이 올바르지 않습니다.');
        }
        return {
            revision: settings.revision,
            style: normalizeStyle(settings.style),
            prompts,
            inpaintSettings: normalizeInpaintSettings(settings.inpaintSettings),
        };
    }

    function normalizeCatalogStyles(response) {
        if (!isRecord(response) || response.status !== 'success' || !Array.isArray(response.styles)) {
            throw new Error('그림체 목록 응답 형식이 올바르지 않습니다.');
        }
        return response.styles.map(style => {
            if (!isRecord(style) || !isId(style.id) || typeof style.name !== 'string'
                || typeof style.positive !== 'string' || typeof style.negative !== 'string') {
                throw new Error('그림체 목록 응답 형식이 올바르지 않습니다.');
            }
            return {id: String(style.id), name: style.name, positive: style.positive, negative: style.negative};
        });
    }

    function createField(labelText, id, textarea = false, controlTag = null) {
        const wrapper = makeElement('div', 'daki-project-settings-field');
        const label = makeElement('label', '', labelText);
        label.htmlFor = id;
        const control = makeElement(controlTag || (textarea ? 'textarea' : 'input'));
        control.id = id;
        if (textarea) {
            control.maxLength = MAX_PROMPT_LENGTH;
            control.rows = 4;
        }
        wrapper.append(label, control);
        return {wrapper, control};
    }

    function createPromptField(side, field, labelText) {
        const id = `projectLink${side === 'front' ? 'Front' : 'Back'}${field === 'basePrompt' ? 'Base' : 'Negative'}Prompt`;
        const result = createField(labelText, id, true);
        result.control.setAttribute('maxlength', String(MAX_PROMPT_LENGTH));
        const help = makeElement('small', 'daki-project-settings-help',
            `${side === 'front' ? '앞면' : '뒷면'} 프롬프트에서 일치하는 태그만 그룹으로 표시합니다. 기존 프롬프트 내용은 유지됩니다.`);
        result.wrapper.appendChild(help);
        return result;
    }

    function createPromptSide(side) {
        const prefix = side === 'front' ? 'Front' : 'Back';
        const face = makeElement('fieldset', 'daki-project-settings-face');
        face.appendChild(makeElement('legend', '', side === 'front' ? '앞면' : '뒷면'));
        const tabs = makeElement('div', 'daki-project-settings-prompt-tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', `${side === 'front' ? '앞면' : '뒷면'} 프롬프트 종류`);
        const panels = {};
        const tabButtons = {};
        const controls = {};
        const panelList = [];
        for (const field of ['basePrompt', 'negativePrompt']) {
            const isBase = field === 'basePrompt';
            const tabId = `projectLink${prefix}${isBase ? 'Base' : 'Negative'}Tab`;
            const panelId = `projectLink${prefix}${isBase ? 'Base' : 'Negative'}Panel`;
            const label = isBase ? 'Base' : 'Negative';
            const tab = makeElement('button', 'daki-project-settings-prompt-tab', label);
            tab.type = 'button';
            tab.id = tabId;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-controls', panelId);
            tab.setAttribute('aria-selected', isBase ? 'true' : 'false');
            tab.setAttribute('tabindex', isBase ? '0' : '-1');
            tab.addEventListener('click', () => activatePromptTab(side, field, false));
            tab.addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const target = event.key === 'Home' ? 'basePrompt' : event.key === 'End' ? 'negativePrompt'
                    : field === 'basePrompt' ? 'negativePrompt' : 'basePrompt';
                activatePromptTab(side, target, true);
            });
            const panel = makeElement('div', 'daki-project-settings-prompt-panel');
            panel.id = panelId;
            panel.setAttribute('role', 'tabpanel');
            panel.setAttribute('aria-labelledby', tabId);
            panel.hidden = !isBase;
            const prompt = createPromptField(side, field, `${label} 그룹 프롬프트`);
            panel.appendChild(prompt.wrapper);
            tabs.appendChild(tab);
            panelList.push(panel);
            panels[field] = panel;
            tabButtons[field] = tab;
            controls[field] = prompt.control;
        }
        face.appendChild(tabs);
        panelList.forEach(panel => face.appendChild(panel));
        const characterSection = makeElement('section', 'daki-project-settings-characters');
        const characterHeading = makeElement('h4', '', '캐릭터 프롬프트');
        const characterRows = makeElement('div', 'daki-project-settings-character-rows');
        characterRows.id = `projectLink${prefix}CharacterRows`;
        const addCharacter = makeElement('button', 'daki-project-settings-secondary daki-project-settings-character-add', '+ 캐릭터 프롬프트');
        addCharacter.type = 'button';
        addCharacter.id = `projectLink${prefix}AddCharacterPrompt`;
        characterSection.append(characterHeading, characterRows, addCharacter);
        face.appendChild(characterSection);
        return {face, panels, tabButtons, controls, characterRows, addCharacter};
    }

    function activatePromptTab(side, field, focus) {
        if (!modal || !modal.promptPanels?.[side] || !modal.promptTabs?.[side]) return;
        for (const name of ['basePrompt', 'negativePrompt']) {
            const selected = name === field;
            modal.promptPanels[side][name].hidden = !selected;
            modal.promptTabs[side][name].setAttribute('aria-selected', selected ? 'true' : 'false');
            modal.promptTabs[side][name].setAttribute('tabindex', selected ? '0' : '-1');
            if (selected && focus) modal.promptTabs[side][name].focus({preventScroll: true});
        }
    }

    function characterValues(host) {
        return (host?._promptControls || []).map(control => control.value);
    }

    function renderCharacterPrompts(context, side, values) {
        const host = modal.characterRows[side];
        host.replaceChildren();
        host._promptControls = [];
        values.forEach((value, index) => {
            const row = makeElement('div', 'daki-project-settings-character-row');
            const label = makeElement('label', 'daki-project-settings-character-label', `Character ${index + 1}`);
            const id = `projectLink${side === 'front' ? 'Front' : 'Back'}CharacterPrompt${index + 1}`;
            label.htmlFor = id;
            const remove = makeElement('button', 'daki-project-settings-secondary daki-project-settings-character-remove', '삭제');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Character ${index + 1} 프롬프트 삭제`);
            const heading = makeElement('div', 'daki-project-settings-character-heading');
            heading.append(label, remove);
            const textarea = makeElement('textarea', 'daki-project-settings-character-textarea');
            textarea.id = id;
            textarea.rows = 3;
            textarea.maxLength = MAX_PROMPT_LENGTH;
            textarea.setAttribute('maxlength', String(MAX_PROMPT_LENGTH));
            textarea.setAttribute('aria-label', `Character ${index + 1} prompt`);
            textarea.value = value;
            row.append(heading, textarea);
            host.appendChild(row);
            host._promptControls.push(textarea);
            remove.addEventListener('click', () => {
                if (active !== context || context.settingsLoading || !context.settingsLoaded || context.saving) return;
                const next = characterValues(host);
                next.splice(index, 1);
                renderCharacterPrompts(context, side, next);
                updateInteraction(context);
            });
        });
    }

    function addCharacterPrompt(context, side) {
        if (active !== context || context.settingsLoading || !context.settingsLoaded || context.saving) return;
        const values = characterValues(modal.characterRows[side]);
        if (values.length >= MAX_CHARACTER_PROMPTS) return;
        values.push('');
        renderCharacterPrompts(context, side, values);
        updateInteraction(context);
    }

    function ensureModal() {
        if (modal) return modal;
        const dialog = makeElement('dialog', 'daki-project-settings-dialog');
        dialog.id = 'dakiProjectSettingsDialog';
        dialog.setAttribute('aria-labelledby', 'dakiProjectSettingsTitle');

        const header = makeElement('header', 'daki-project-settings-header');
        const title = makeElement('h2', '', '캔버스 연동 설정');
        title.id = 'dakiProjectSettingsTitle';
        const closeButton = makeElement('button', 'daki-project-settings-close', '×');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', '닫기');
        header.append(title, closeButton);

        const body = makeElement('div', 'daki-project-settings-body');
        const summary = makeElement('p', 'daki-project-settings-summary',
            '기존 프롬프트는 유지하고 일치하는 태그만 그룹으로 표시합니다. 프로젝트의 변경은 연결된 캔버스에 반영됩니다.');

        const styleSection = makeElement('section', 'daki-project-settings-section daki-project-settings-style');
        const styleHeading = makeElement('h3', '', '그림체 연결');
        const styleControls = makeElement('div', 'daki-project-settings-style-controls');
        const libraryField = createField('그림체 라이브러리', 'projectLinkStyleLibrary', false, 'select');
        addOption(libraryField.control, 'project', '프로젝트 그림');
        addOption(libraryField.control, 'shared', '공유 그림체');
        addOption(libraryField.control, 'personal', '개인 그림체');
        libraryField.control.id = 'projectLinkStyleLibrary';
        libraryField.control.setAttribute('aria-label', '그림체 라이브러리');
        const searchField = createField('그림체 이름 검색', 'projectLinkStyleSearch');
        searchField.control.type = 'search';
        searchField.control.placeholder = '그림체 이름 검색';
        searchField.control.setAttribute('aria-label', '그림체 이름 검색');
        const choiceField = createField('연결할 그림체', 'projectLinkStyleChoice', false, 'select');
        choiceField.control.setAttribute('aria-label', '연결할 그림체');
        styleControls.append(libraryField.wrapper, searchField.wrapper, choiceField.wrapper);

        const catalogStatus = makeElement('div', 'daki-project-settings-catalog-status');
        const sharedStatus = makeElement('p', 'daki-project-settings-status', '공유 그림체를 불러오는 중…');
        sharedStatus.id = 'projectLinkSharedStatus';
        sharedStatus.setAttribute('role', 'status');
        sharedStatus.setAttribute('aria-live', 'polite');
        const sharedRetry = makeElement('button', 'daki-project-settings-secondary', '공유 목록 다시 불러오기');
        sharedRetry.id = 'projectLinkSharedRetry';
        sharedRetry.type = 'button';
        sharedRetry.hidden = true;
        const personalStatus = makeElement('p', 'daki-project-settings-status', '개인 그림체를 불러오는 중…');
        personalStatus.id = 'projectLinkPersonalStatus';
        personalStatus.setAttribute('role', 'status');
        personalStatus.setAttribute('aria-live', 'polite');
        const personalRetry = makeElement('button', 'daki-project-settings-secondary', '개인 목록 다시 불러오기');
        personalRetry.id = 'projectLinkPersonalRetry';
        personalRetry.type = 'button';
        personalRetry.hidden = true;
        catalogStatus.append(sharedStatus, sharedRetry, personalStatus, personalRetry);

        const projectPickerHost = makeElement('div', 'daki-project-style-picker-host');
        projectPickerHost.id = 'projectLinkProjectStylePicker';
        projectPickerHost.hidden = true;
        const clearStyle = makeElement('button', 'daki-project-settings-secondary daki-project-settings-style-clear', '그림체 연결 해제');
        clearStyle.id = 'projectLinkClearStyle';
        clearStyle.type = 'button';
        clearStyle.hidden = true;

        const preview = makeElement('div', 'daki-project-settings-preview-grid');
        const basePreview = makeElement('section', 'daki-project-settings-preview');
        const baseTitle = makeElement('h4', '', 'Base 프롬프트');
        const baseText = makeElement('pre', 'daki-project-settings-preview-text', '그림체를 선택하면 프롬프트가 표시됩니다.');
        baseText.id = 'projectLinkStyleBasePreview';
        basePreview.append(baseTitle, baseText);
        const negativePreview = makeElement('section', 'daki-project-settings-preview');
        const negativeTitle = makeElement('h4', '', 'Negative 프롬프트');
        const negativeText = makeElement('pre', 'daki-project-settings-preview-text', '그림체를 선택하면 프롬프트가 표시됩니다.');
        negativeText.id = 'projectLinkStyleNegativePreview';
        negativePreview.append(negativeTitle, negativeText);
        preview.append(basePreview, negativePreview);
        styleSection.append(styleHeading, styleControls, catalogStatus, projectPickerHost, clearStyle, preview);

        const promptsSection = makeElement('section', 'daki-project-settings-section');
        const promptsHeading = makeElement('h3', '', '앞면/뒷면 그룹 프롬프트');
        const promptGrid = makeElement('div', 'daki-project-settings-prompt-grid');
        const front = createPromptSide('front');
        const back = createPromptSide('back');
        promptGrid.append(front.face, back.face);
        promptsSection.append(promptsHeading, promptGrid);

        const inpaintSection = makeElement('section', 'daki-project-settings-section daki-project-settings-inpaint');
        const inpaintHeading = makeElement('h3', '', '공통 인페인트 설정');
        const inpaintLabel = makeElement('label', 'daki-project-settings-checkbox');
        const inpaintToggle = makeElement('input');
        inpaintToggle.id = 'projectLinkInpaintEnabled';
        inpaintToggle.type = 'checkbox';
        const inpaintLabelText = makeElement('span', '', '공통 인페인트 설정 연동');
        inpaintLabel.append(inpaintToggle, inpaintLabelText);
        const inpaintHelp = makeElement('p', 'daki-project-settings-help', '사용하면 앞면과 뒷면 캔버스에 같은 생성 설정을 적용합니다.');
        const generationHost = makeElement('div', 'daki-project-settings-generation');
        generationHost.id = 'projectLinkGenerationSettings';
        inpaintSection.append(inpaintHeading, inpaintLabel, inpaintHelp, generationHost);

        const status = makeElement('p', 'daki-project-settings-status daki-project-settings-main-status');
        status.id = 'projectLinkStatus';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const retryLoad = makeElement('button', 'daki-project-settings-secondary', '다시 불러오기');
        retryLoad.id = 'projectLinkRetryLoad';
        retryLoad.type = 'button';
        retryLoad.hidden = true;
        const reloadLatest = makeElement('button', 'daki-project-settings-secondary', '최신 설정 다시 불러오기');
        reloadLatest.id = 'projectLinkReloadLatest';
        reloadLatest.type = 'button';
        reloadLatest.hidden = true;
        body.append(summary, styleSection, promptsSection, inpaintSection, status, retryLoad, reloadLatest);

        const footer = makeElement('footer', 'daki-project-settings-footer');
        const cancel = makeElement('button', 'daki-project-settings-secondary', '취소');
        cancel.id = 'projectLinkCancel';
        cancel.type = 'button';
        const save = makeElement('button', 'daki-project-settings-primary', '저장');
        save.id = 'projectLinkSave';
        save.type = 'button';
        footer.append(cancel, save);
        dialog.append(header, body, footer);
        root.document.body.appendChild(dialog);

        closeButton.addEventListener('click', () => closeActive(true));
        cancel.addEventListener('click', () => closeActive(true));
        save.addEventListener('click', () => active && saveSettings(active));
        retryLoad.addEventListener('click', () => active && loadSettings(active, false));
        reloadLatest.addEventListener('click', () => active && loadSettings(active, true));
        sharedRetry.addEventListener('click', () => active && loadCatalog(active, 'shared'));
        personalRetry.addEventListener('click', () => active && loadCatalog(active, 'personal'));
        libraryField.control.addEventListener('change', () => active && chooseStyleLibrary(active));
        searchField.control.addEventListener('input', () => active && renderStyleChoices(active));
        choiceField.control.addEventListener('change', () => active && chooseStyle(active));
        clearStyle.addEventListener('click', () => active && clearSelectedStyle(active));
        front.addCharacter.addEventListener('click', () => active && addCharacterPrompt(active, 'front'));
        back.addCharacter.addEventListener('click', () => active && addCharacterPrompt(active, 'back'));
        inpaintToggle.addEventListener('change', () => active && updateInteraction(active));
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            closeActive(true);
        });
        dialog.addEventListener('close', () => {
            if (active && !dialog.open && !active.saving) closeActive(true);
        });
        dialog.addEventListener('keydown', event => event.stopPropagation());
        dialog.addEventListener('paste', event => event.stopPropagation());
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) closeActive(true);
        });

        modal = {
            dialog, title, body, closeButton, cancel, save, status, retryLoad, reloadLatest,
            library: libraryField.control, search: searchField.control, choice: choiceField.control,
            searchWrapper: searchField.wrapper, choiceWrapper: choiceField.wrapper,
            sharedStatus, sharedRetry, personalStatus, personalRetry,
            catalogStatus, projectPickerHost, clearStyle,
            basePreview: baseText, negativePreview: negativeText,
            frontBase: front.controls.basePrompt, frontNegative: front.controls.negativePrompt,
            backBase: back.controls.basePrompt, backNegative: back.controls.negativePrompt,
            promptTabs: {front: front.tabButtons, back: back.tabButtons},
            promptPanels: {front: front.panels, back: back.panels},
            characterRows: {front: front.characterRows, back: back.characterRows},
            characterAdds: {front: front.addCharacter, back: back.addCharacter},
            inpaintToggle, generationHost,
        };
        return modal;
    }

    function current(context, token = context.token) {
        return active === context && context.token === token && openRevision === token
            && modal && modal.dialog.open;
    }

    function setStatus(message) {
        if (modal) modal.status.textContent = message || '';
    }

    function setGenerationDisabled(host, disabled) {
        const visit = node => {
            if (node !== host && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(node.tagName)) {
                node.disabled = disabled;
            }
            for (const child of node.children || []) visit(child);
        };
        visit(host);
    }

    function updateInteraction(context) {
        if (active !== context || !modal) return;
        const locked = !context.settingsLoaded || context.settingsLoading || context.saving;
        const controls = [modal.library, modal.search, modal.choice, modal.inpaintToggle,
            modal.frontBase, modal.frontNegative, modal.backBase, modal.backNegative,
            ...Object.values(modal.promptTabs).flatMap(tabs => Object.values(tabs))];
        controls.forEach(control => { control.disabled = locked; });
        for (const side of ['front', 'back']) {
            modal.characterAdds[side].disabled = locked || modal.characterRows[side]._promptControls.length >= MAX_CHARACTER_PROMPTS;
            modal.characterRows[side]._promptControls.forEach(control => { control.disabled = locked; });
            Array.from(modal.characterRows[side].children || []).forEach(row => {
                const remove = row.children?.[0]?.children?.[1];
                if (remove) remove.disabled = locked;
            });
        }
        modal.save.disabled = locked || context.imageSelectionPending;
        modal.cancel.disabled = context.saving;
        modal.closeButton.disabled = context.saving;
        modal.clearStyle.disabled = locked;
        if (context.projectPicker) context.projectPicker.setDisabled(locked);
        if (!locked && modal.library.value === 'project' && context.projectPicker) {
            context.projectPicker.open({projectId: context.projectId, style: context.draft.style});
        }
        modal.retryLoad.hidden = !(context.loadError && !context.settingsLoaded);
        modal.reloadLatest.hidden = !context.conflict;
        modal.reloadLatest.disabled = locked;
        modal.generationHost.hidden = !modal.inpaintToggle.checked;
        if (locked || !modal.inpaintToggle.checked) {
            setGenerationDisabled(modal.generationHost, true);
        } else {
            if (typeof root.applyGenerationModelConstraints === 'function') {
                root.applyGenerationModelConstraints(GENERATION_PREFIX);
            }
            setGenerationDisabled(modal.generationHost, false);
            if (typeof root.applyGenerationModelConstraints === 'function') {
                root.applyGenerationModelConstraints(GENERATION_PREFIX);
            }
        }
    }

    function renderSelectedStyle(context) {
        const style = context.draft.style;
        modal.choice.title = style?.name || '연동 안 함';
        modal.basePreview.textContent = style ? (style.positive || 'Base 프롬프트가 비어 있습니다.')
            : '그림체를 선택하면 프롬프트가 표시됩니다.';
        modal.negativePreview.textContent = style ? (style.negative || 'Negative 프롬프트가 비어 있습니다.')
            : '그림체를 선택하면 프롬프트가 표시됩니다.';
        modal.clearStyle.hidden = !style;
    }

    function normalizePickerImports(imports) {
        if (imports === undefined) return {side: 'front', charPrompts: [], inpaintSettings: null};
        if (!isRecord(imports) || !['front', 'back'].includes(imports.side)
            || !Array.isArray(imports.charPrompts) || imports.charPrompts.length > MAX_CHARACTER_PROMPTS
            || imports.charPrompts.some(value => typeof value !== 'string' || !value.trim() || value.length > MAX_PROMPT_LENGTH)) {
            return null;
        }
        let inpaintSettings = null;
        if (imports.inpaintSettings !== null) {
            if (!isRecord(imports.inpaintSettings) || !Object.keys(imports.inpaintSettings).length) return null;
            inpaintSettings = {};
            for (const [field, value] of Object.entries(imports.inpaintSettings)) {
                const type = IMPORTABLE_GENERATION_FIELDS[field];
                if (!type || (type === 'string' && (typeof value !== 'string' || !value.trim()))
                    || (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))) return null;
                inpaintSettings[field] = value;
            }
        }
        return {side: imports.side, charPrompts: [...imports.charPrompts], inpaintSettings};
    }

    function applyProjectPickerSelection(context, style, rawImports) {
        if (!current(context) || !context.settingsLoaded || context.settingsLoading || context.saving) {
            return '현재 프로젝트 설정을 적용할 수 없습니다. 다시 시도해 주세요.';
        }
        const imports = normalizePickerImports(rawImports);
        if (!imports) return '가져올 캐릭터 프롬프트와 생성 설정을 확인해 주세요.';
        const currentCharacters = characterValues(modal.characterRows[imports.side]);
        if (currentCharacters.length + imports.charPrompts.length > MAX_CHARACTER_PROMPTS) {
            const sideName = imports.side === 'front' ? '앞면' : '뒷면';
            return `${sideName} 캐릭터 프롬프트는 최대 ${MAX_CHARACTER_PROMPTS}개까지입니다. 현재 ${currentCharacters.length}개에 ${imports.charPrompts.length}개를 추가할 수 없습니다.`;
        }

        let mergedInpaintSettings = null;
        if (imports.inpaintSettings) {
            if (typeof root.readGenerationSettings !== 'function' || typeof root.setGenerationSettings !== 'function') {
                return '현재 생성 설정을 읽거나 적용할 수 없습니다.';
            }
            let currentSettings;
            try { currentSettings = root.readGenerationSettings(GENERATION_PREFIX); } catch (_) { currentSettings = null; }
            if (!isRecord(currentSettings)) return '현재 생성 설정을 읽지 못해 그림 설정을 적용하지 않았습니다.';
            mergedInpaintSettings = {...currentSettings, ...imports.inpaintSettings};
        }

        const nextStyle = style ? copyStyle(style) : null;
        if (style && !nextStyle) return '그림체 정보를 적용할 수 없습니다.';
        if (mergedInpaintSettings) {
            try { root.setGenerationSettings(GENERATION_PREFIX, mergedInpaintSettings); } catch (_) {
                return '생성 설정을 적용하지 못했습니다.';
            }
            context.draft.inpaintSettings = {...mergedInpaintSettings};
            modal.inpaintToggle.checked = true;
        }
        if (nextStyle) {
            context.draft.style = nextStyle;
            modal.library.value = 'project';
        }
        if (imports.charPrompts.length) {
            renderCharacterPrompts(context, imports.side, [...currentCharacters, ...imports.charPrompts]);
        }
        renderStyleChoices(context);
        updateInteraction(context);
        return undefined;
    }

    function renderStyleChoices(context) {
        if (active !== context || !modal) return;
        const library = modal.library.value === 'personal' ? 'personal' : 'shared';
        const projectMode = modal.library.value === 'project';
        modal.searchWrapper.hidden = projectMode;
        modal.choiceWrapper.hidden = projectMode;
        modal.catalogStatus.hidden = projectMode;
        modal.projectPickerHost.hidden = !projectMode;
        if (projectMode) {
            renderSelectedStyle(context);
            if (context.projectPicker) context.projectPicker.open({projectId: context.projectId, style: context.draft.style});
            return;
        }
        const styles = context.catalogs[library].styles;
        const query = modal.search.value.trim().toLocaleLowerCase();
        modal.choice.replaceChildren();
        addOption(modal.choice, '', '연동 안 함');
        if (context.draft.style) {
            const label = `${context.draft.style.name || '이름 없는 그림체'} · 저장된 그림체`;
            addOption(modal.choice, 'snapshot', label);
        }
        const matches = styles.map((style, index) => ({style, index})).filter(entry =>
            !query || entry.style.name.toLocaleLowerCase().includes(query));
        context.choiceStyles = new Map();
        for (const {style, index} of matches) {
            const value = `catalog-${index}`;
            addOption(modal.choice, value, style.name || '이름 없는 그림체');
            context.choiceStyles.set(value, {
                id: style.id,
                name: style.name,
                library,
                positive: style.positive,
                negative: style.negative,
            });
        }
        if (!styles.length && context.catalogs[library].state === 'loaded') {
            addOption(modal.choice, 'empty', '저장된 그림체가 없습니다.');
            modal.choice.lastChild.disabled = true;
        } else if (styles.length && query && !matches.length) {
            addOption(modal.choice, 'empty', '검색 결과가 없습니다.');
            modal.choice.lastChild.disabled = true;
        }
        modal.choice.value = context.draft.style ? 'snapshot' : '';
        renderSelectedStyle(context);
    }

    function chooseStyleLibrary(context) {
        if (active !== context || !modal) return;
        if (modal.library.value !== 'project') {
            context.projectPicker?.cancel();
            context.imageSelectionPending = false;
            updateInteraction(context);
        }
        renderStyleChoices(context);
    }

    function clearSelectedStyle(context) {
        if (active !== context || context.settingsLoading || !context.settingsLoaded || context.saving) return;
        context.projectPicker?.cancel();
        context.imageSelectionPending = false;
        context.draft.style = null;
        modal.library.value = 'project';
        renderStyleChoices(context);
        updateInteraction(context);
    }

    function chooseStyle(context) {
        if (active !== context) return;
        const selected = modal.choice.value;
        if (selected === 'snapshot') {
            context.draft.style = copyStyle(context.draft.style);
        } else if (selected === '') {
            context.draft.style = null;
        } else if (context.choiceStyles.has(selected)) {
            context.draft.style = copyStyle(context.choiceStyles.get(selected));
            modal.library.value = context.draft.style.library;
        }
        renderStyleChoices(context);
    }

    function renderSettings(context, settings) {
        context.revision = settings.revision;
        context.draft = {
            style: copyStyle(settings.style),
            prompts: {
                front: {...settings.prompts.front},
                back: {...settings.prompts.back},
            },
            inpaintSettings: settings.inpaintSettings ? {...settings.inpaintSettings} : null,
        };
        modal.frontBase.value = context.draft.prompts.front.basePrompt;
        modal.frontNegative.value = context.draft.prompts.front.negativePrompt;
        modal.backBase.value = context.draft.prompts.back.basePrompt;
        modal.backNegative.value = context.draft.prompts.back.negativePrompt;
        for (const side of ['front', 'back']) {
            const values = context.draft.prompts[side].charPrompts || [];
            renderCharacterPrompts(context, side, values);
            activatePromptTab(side, 'basePrompt', false);
        }
        modal.inpaintToggle.checked = context.draft.inpaintSettings !== null;
        modal.library.value = context.draft.style?.library || 'project';
        if (typeof root.setGenerationSettings === 'function') {
            root.setGenerationSettings(GENERATION_PREFIX, context.draft.inpaintSettings || {});
        }
        renderStyleChoices(context);
        updateInteraction(context);
    }

    async function requestJson(url, options) {
        const response = await root.fetch(url, options);
        let payload;
        try { payload = await response.json(); } catch (_) { payload = null; }
        if (!response.ok) {
            const error = new Error('요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
            error.status = response.status;
            error.code = payload && payload.code;
            throw error;
        }
        return payload;
    }

    function projectSettingsUrl(context) {
        return `/api/daki/projects/${encodeURIComponent(context.projectId)}/canvas-settings`;
    }

    function catalogUrl(library) {
        return `/api/daki/${library}-styles?include_prompts=1`;
    }

    async function loadSettings(context, explicitReload) {
        if (active !== context || context.saving) return false;
        if (context.settingsController) context.settingsController.abort();
        const token = context.token;
        const controller = new root.AbortController();
        context.settingsController = controller;
        context.settingsLoading = true;
        if (explicitReload) context.conflict = true;
        else if (!context.settingsLoaded) context.loadError = false;
        setStatus(explicitReload ? '최신 설정을 불러오는 중…' : '프로젝트 설정을 불러오는 중…');
        updateInteraction(context);
        try {
            const payload = await requestJson(projectSettingsUrl(context), {signal: controller.signal});
            const settings = normalizeSettingsResponse(payload);
            if (!current(context, token) || controller.signal.aborted) return false;
            renderSettings(context, settings);
            context.settingsLoaded = true;
            context.loadError = false;
            context.conflict = false;
            setStatus('');
            return true;
        } catch (error) {
            if (!current(context, token) || controller.signal.aborted) return false;
            if (!context.settingsLoaded) context.loadError = true;
            const message = explicitReload
                ? '최신 설정을 불러오지 못했습니다. 입력한 초안은 유지했습니다.'
                : '프로젝트 설정을 불러오지 못했습니다. 다시 시도해 주세요.';
            setStatus(message);
            return false;
        } finally {
            if (current(context, token) && context.settingsController === controller) {
                context.settingsLoading = false;
                updateInteraction(context);
            }
        }
    }

    async function loadCatalog(context, library) {
        if (active !== context || (library !== 'shared' && library !== 'personal')) return false;
        const entry = context.catalogs[library];
        if (entry.controller) entry.controller.abort();
        const token = context.token;
        const controller = new root.AbortController();
        entry.controller = controller;
        entry.state = 'loading';
        const status = library === 'shared' ? modal.sharedStatus : modal.personalStatus;
        const retry = library === 'shared' ? modal.sharedRetry : modal.personalRetry;
        retry.hidden = true;
        status.textContent = `${library === 'shared' ? '공유' : '개인'} 그림체를 불러오는 중…`;
        try {
            const payload = await requestJson(catalogUrl(library), {signal: controller.signal});
            const styles = normalizeCatalogStyles(payload);
            if (!current(context, token) || controller.signal.aborted || entry.controller !== controller) return false;
            entry.styles = styles;
            entry.state = 'loaded';
            status.textContent = styles.length ? `${styles.length}개 그림체를 불러왔습니다.`
                : `저장된 ${library === 'shared' ? '공유' : '개인'} 그림체가 없습니다.`;
            retry.hidden = true;
            renderStyleChoices(context);
            return true;
        } catch (_) {
            if (!current(context, token) || controller.signal.aborted || entry.controller !== controller) return false;
            entry.state = 'error';
            status.textContent = `${library === 'shared' ? '공유' : '개인'} 그림체를 불러오지 못했습니다. 저장된 선택은 유지됩니다.`;
            retry.hidden = false;
            renderStyleChoices(context);
            return false;
        }
    }

    function readDraft(context) {
        const inpaintSettings = modal.inpaintToggle.checked
            ? (typeof root.readGenerationSettings === 'function'
                ? root.readGenerationSettings(GENERATION_PREFIX) : null)
            : null;
        if (modal.inpaintToggle.checked && !inpaintSettings) return null;
        const characterPrompts = {};
        for (const side of ['front', 'back']) {
            const values = characterValues(modal.characterRows[side]);
            if (values.length > MAX_CHARACTER_PROMPTS || values.some(value => typeof value !== 'string' || value.length > MAX_PROMPT_LENGTH)) {
                context.validationError = '캐릭터 프롬프트는 면마다 22개, 항목마다 10만 자까지 입력할 수 있습니다.';
                return null;
            }
            characterPrompts[side] = values;
        }
        context.validationError = '';
        return {
            style: copyStyle(context.draft.style),
            prompts: {
                front: {basePrompt: modal.frontBase.value, negativePrompt: modal.frontNegative.value, charPrompts: characterPrompts.front},
                back: {basePrompt: modal.backBase.value, negativePrompt: modal.backNegative.value, charPrompts: characterPrompts.back},
            },
            inpaintSettings: inpaintSettings ? {...inpaintSettings} : null,
        };
    }

    function publishChange(projectId) {
        if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
            root.dispatchEvent(new root.CustomEvent('daki-project-settings-changed', {detail: {projectId}}));
        }
        if (typeof root.BroadcastChannel !== 'function') return;
        let channel;
        try {
            channel = new root.BroadcastChannel(CHANNEL_NAME);
            channel.postMessage({projectId});
        } catch (_) {
            // A browser may disable broadcast channels; the in-document event still covers the active page.
        } finally {
            if (channel && typeof channel.close === 'function') channel.close();
        }
    }

    async function saveSettings(context) {
        if (active !== context || !context.settingsLoaded || context.settingsLoading || context.saving || context.imageSelectionPending) return false;
        const settings = readDraft(context);
        if (!settings) {
            setStatus(context.validationError || '공통 인페인트 설정을 확인해 주세요.');
            return false;
        }
        context.saving = true;
        context.conflict = false;
        setStatus('저장 중…');
        updateInteraction(context);
        const token = context.token;
        const body = {revision: context.revision, settings};
        try {
            const payload = await requestJson(projectSettingsUrl(context), {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body),
            });
            normalizeSettingsResponse(payload);
            if (!current(context, token)) return false;
            const projectId = context.projectId;
            context.saving = false;
            closeActive(true);
            publishChange(projectId);
            return true;
        } catch (error) {
            if (!current(context, token)) return false;
            context.saving = false;
            if (error.status === 409 && error.code === 'project_settings_conflict') {
                context.conflict = true;
                setStatus('다른 변경 사항이 먼저 저장되었습니다. 초안은 유지됩니다. 최신 설정을 확인하려면 다시 불러오기를 선택하세요.');
            } else {
                setStatus('저장하지 못했습니다. 입력한 초안은 유지됩니다. 다시 저장해 주세요.');
            }
            updateInteraction(context);
            return false;
        }
    }

    function release(context) {
        if (!context) return;
        if (context.projectPicker) context.projectPicker.dispose();
        if (context.settingsController) context.settingsController.abort();
        for (const entry of Object.values(context.catalogs || {})) {
            if (entry.controller) entry.controller.abort();
        }
    }

    function closeActive(restoreFocus = true) {
        const context = active;
        if (context && context.saving) return false;
        active = null;
        openRevision++;
        release(context);
        const wasOpen = Boolean(modal && modal.dialog.open);
        if (wasOpen) modal.dialog.close();
        if (modal) {
            modal.status.textContent = '';
            modal.retryLoad.hidden = true;
            modal.reloadLatest.hidden = true;
            modal.sharedRetry.hidden = true;
            modal.personalRetry.hidden = true;
        }
        if (restoreFocus && context?.opener?.isConnected && typeof context.opener.focus === 'function') {
            context.opener.focus({preventScroll: true});
        }
        return Boolean(context || wasOpen);
    }

    async function open(options) {
        const settings = options || {};
        const projectId = typeof settings.projectId === 'string' || typeof settings.projectId === 'number'
            ? String(settings.projectId) : '';
        if (!projectId) throw new TypeError('projectId가 필요합니다.');
        if (active?.saving) return false;
        if (active) closeActive(false);
        const token = ++openRevision;
        const instance = ensureModal();
        const context = {
            token,
            projectId,
            projectName: typeof settings.projectName === 'string' ? settings.projectName : '프로젝트',
            opener: settings.opener || null,
            revision: null,
            settingsLoaded: false,
            settingsLoading: false,
            loadError: false,
            conflict: false,
            saving: false,
            imageSelectionPending: false,
            settingsController: null,
            draft: {style: null, prompts: {front: {basePrompt: '', negativePrompt: '', charPrompts: []}, back: {basePrompt: '', negativePrompt: '', charPrompts: []}}, inpaintSettings: null},
            catalogs: {
                shared: {styles: [], state: 'loading', controller: null},
                personal: {styles: [], state: 'loading', controller: null},
            },
            choiceStyles: new Map(),
        };
        active = context;
        instance.title.textContent = `${context.projectName} · 캔버스 연동 설정`;
        instance.body.scrollTop = 0;
        instance.library.value = 'project';
        instance.search.value = '';
        instance.inpaintToggle.checked = false;
        instance.frontBase.value = '';
        instance.frontNegative.value = '';
        instance.backBase.value = '';
        instance.backNegative.value = '';
        renderCharacterPrompts(context, 'front', []);
        renderCharacterPrompts(context, 'back', []);
        activatePromptTab('front', 'basePrompt', false);
        activatePromptTab('back', 'basePrompt', false);
        instance.basePreview.textContent = '그림체를 선택하면 프롬프트가 표시됩니다.';
        instance.negativePreview.textContent = '그림체를 선택하면 프롬프트가 표시됩니다.';
        instance.sharedStatus.textContent = '공유 그림체를 불러오는 중…';
        instance.personalStatus.textContent = '개인 그림체를 불러오는 중…';
        instance.status.textContent = '프로젝트 설정을 불러오는 중…';
        instance.retryLoad.hidden = true;
        instance.reloadLatest.hidden = true;
        instance.sharedRetry.hidden = true;
        instance.personalRetry.hidden = true;
        renderStyleChoices(context);
        if (!instance.dialog.open) instance.dialog.showModal();
        instance.closeButton.focus({preventScroll: true});
        // showModal() can restore focus to an input used in a previous opening.
        // Reset after both native focus restoration and our initial focus move.
        instance.body.scrollTop = 0;
        if (root.DakiProjectStylePicker && typeof root.DakiProjectStylePicker.create === 'function') {
            context.projectPicker = root.DakiProjectStylePicker.create({
                host: instance.projectPickerHost,
                onSelect: (style, imports) => applyProjectPickerSelection(context, style, imports),
                onPendingChange: pending => {
                    if (active !== context) return;
                    context.imageSelectionPending = pending;
                    updateInteraction(context);
                },
            });
        } else {
            instance.projectPickerHost.textContent = '프로젝트 그림체 선택을 사용할 수 없습니다.';
        }
        updateInteraction(context);
        await Promise.all([
            loadSettings(context, false),
            loadCatalog(context, 'shared'),
            loadCatalog(context, 'personal'),
        ]);
        return active === context;
    }

    function close() {
        return closeActive(true);
    }

    return {open, close};
});
