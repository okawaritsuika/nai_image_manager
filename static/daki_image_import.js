/* Import one existing image into a Daki project without generating a new image. */
(function (root) {
    'use strict';

    const doc = root.document;
    const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
    const allowedExtensions = new Set(['png', 'jpg', 'jpeg', 'webp']);
    let active = null;

    function node(tag, className, text) {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }

    function clone(value) {
        if (typeof root.structuredClone === 'function') return root.structuredClone(value);
        return JSON.parse(JSON.stringify(value));
    }

    function hasPromptText(info) {
        if (!info || typeof info !== 'object') return false;
        const chars = Array.isArray(info.charPrompts) ? info.charPrompts : [info.charPrompt];
        const regions = Array.isArray(info.promptRegions) ? info.promptRegions : [];
        return Boolean(String(info.basePrompt || '').trim()
            || String(info.negativePrompt || '').trim()
            || chars.some(value => String(typeof value === 'string' ? value : value?.prompt || '').trim())
            || regions.some(value => String(value?.prompt || '').trim()));
    }

    function fileExtension(file) {
        const parts = String(file?.name || '').toLowerCase().split('.');
        return parts.length > 1 ? parts.pop() : '';
    }

    function isSupported(file) {
        const extension = fileExtension(file);
        return Boolean(file && (allowedTypes.has(file.type) || (!file.type && allowedExtensions.has(extension)))
            && (!file.type || allowedTypes.has(file.type))
            && (!extension || allowedExtensions.has(extension)));
    }

    function apiError(result, fallback) {
        return new Error(typeof result?.message === 'string' && result.message.trim() ? result.message : fallback);
    }

    function promptChars(info) {
        const values = Array.isArray(info?.charPrompts) ? info.charPrompts : [];
        if (values.length) return values.map(value => typeof value === 'string' ? value : String(value?.prompt || ''));
        return typeof info?.charPrompt === 'string' && info.charPrompt ? [info.charPrompt] : [];
    }

    function makeLabel(text, control, hint) {
        const label = node('label', 'daki-image-import-field');
        label.append(node('span', 'daki-image-import-label', text), control);
        if (hint) label.appendChild(node('small', 'daki-image-import-hint', hint));
        return label;
    }

    function promptRegionOption(region) {
        const option = node('option', '', region.label || region.id);
        option.value = String(region.id || '');
        return option;
    }

    function makeRegionRow(state, value, originalIndex, onChange, characterIndex = value?.characterIndex) {
        const row = node('div', 'daki-image-import-region-row');
        const select = node('select', 'daki-image-import-select');
        select.dataset.regionSelect = 'true';
        const regions = [...state.regions];
        const regionId = String(value?.region || 'whole');
        if (!regions.some(region => String(region.id) === regionId)) {
            regions.push({id: regionId, label: regionId === 'whole' ? '전체' : regionId});
        }
        for (const region of regions) select.appendChild(promptRegionOption(region));
        select.value = regionId;
        select.setAttribute('aria-label', '프롬프트가 가리키는 부위');
        const textarea = node('textarea', 'daki-image-import-textarea'); textarea.setAttribute('data-prompt-autocomplete', '');
        textarea.rows = 2;
        textarea.maxLength = 30000;
        textarea.value = String(value?.prompt || '');
        textarea.dataset.regionPrompt = 'true';
        textarea.setAttribute('aria-label', '부위 프롬프트');
        const remove = node('button', 'daki-image-import-icon-button', '삭제');
        remove.type = 'button';
        remove.dataset.importControl = 'true';
        remove.setAttribute('aria-label', '부위별 프롬프트 삭제');
        remove.onclick = () => { row.remove(); onChange?.(); };
        row.dataset.originalIndex = originalIndex === null ? '' : String(originalIndex);
        if (Number.isInteger(characterIndex)) {
            row.dataset.characterIndex = String(characterIndex);
            const source = node('small', 'daki-image-import-region-source', `캐릭터 ${characterIndex + 1} · 자동 분류`);
            row.appendChild(source);
        }
        row.append(select, textarea, remove);
        select.addEventListener('change', () => onChange?.());
        textarea.addEventListener('input', () => onChange?.());
        return row;
    }

    function makeCharacterRow(value, index, onChange) {
        const row = node('div', 'daki-image-import-character-row');
        const textarea = node('textarea', 'daki-image-import-textarea'); textarea.setAttribute('data-prompt-autocomplete', '');
        textarea.rows = 2;
        textarea.maxLength = 30000;
        textarea.value = value;
        textarea.dataset.charPrompt = 'true';
        textarea.setAttribute('aria-label', `캐릭터 ${index + 1} 프롬프트`);
        const remove = node('button', 'daki-image-import-icon-button', '삭제');
        remove.type = 'button';
        remove.dataset.importControl = 'true';
        remove.setAttribute('aria-label', `캐릭터 ${index + 1} 프롬프트 삭제`);
        remove.onclick = () => { row.remove(); onChange?.(); };
        row.append(textarea, remove);
        textarea.addEventListener('input', () => onChange?.());
        return row;
    }

    function populateEditor(state, info) {
        state.promptEditor.replaceChildren();
        const source = info && typeof info === 'object' ? info : {};
        const base = node('textarea', 'daki-image-import-textarea'); base.setAttribute('data-prompt-autocomplete', '');
        base.rows = 4;
        base.maxLength = 30000;
        base.value = String(source.basePrompt || '');
        base.dataset.promptField = 'basePrompt';
        base.setAttribute('aria-label', '기본 프롬프트');
        state.promptEditor.appendChild(makeLabel('기본 프롬프트', base));
        const negative = node('textarea', 'daki-image-import-textarea'); negative.setAttribute('data-prompt-autocomplete', '');
        negative.rows = 3;
        negative.maxLength = 30000;
        negative.value = String(source.negativePrompt || '');
        negative.dataset.promptField = 'negativePrompt';
        negative.setAttribute('aria-label', '네거티브 프롬프트');
        state.promptEditor.appendChild(makeLabel('네거티브 프롬프트', negative));
        const chars = node('section', 'daki-image-import-prompt-group');
        chars.appendChild(node('h3', '', '캐릭터 프롬프트'));
        chars.appendChild(node('p', 'daki-image-import-hint', '각 캐릭터의 원문을 유지한 채 편집할 수 있습니다.'));
        const charRows = node('div', 'daki-image-import-character-list');
        const updateLimits = () => state.refreshControls?.();
        const onCharacterChange = () => {
            updateLimits();
            state.onCharacterChange?.();
        };
        for (const [index, value] of promptChars(source).entries()) charRows.appendChild(makeCharacterRow(value, index, onCharacterChange));
        const addCharacter = node('button', 'daki-image-import-secondary', '+ 캐릭터 프롬프트');
        addCharacter.type = 'button';
        addCharacter.dataset.importControl = 'true';
        addCharacter.dataset.limit = 'characters';
        addCharacter.onclick = () => {
            if (charRows.children.length >= 22) return;
            const row = makeCharacterRow('', charRows.children.length, onCharacterChange);
            charRows.appendChild(row);
            onCharacterChange();
            row.querySelector('textarea')?.focus();
        };
        chars.append(charRows, addCharacter);
        state.charRows = charRows;
        state.promptEditor.appendChild(chars);

        const regions = node('section', 'daki-image-import-prompt-group');
        regions.appendChild(node('h3', '', '부위별 프롬프트'));
        regions.appendChild(node('p', 'daki-image-import-hint', '캐릭터 원문은 유지하고 부위별 의미만 저장합니다. 직접 추가한 문구는 기본 프롬프트에 포함됩니다.'));
        const regionToolbar = node('div', 'daki-image-import-region-toolbar');
        const classificationStatus = node('p', 'daki-image-import-classification-status');
        classificationStatus.setAttribute('role', 'status');
        classificationStatus.setAttribute('aria-live', 'polite');
        const reclassify = node('button', 'daki-image-import-secondary', '캐릭터에서 다시 분류');
        reclassify.type = 'button';
        reclassify.dataset.importControl = 'true';
        reclassify.dataset.classificationRetry = 'true';
        regionToolbar.append(classificationStatus, reclassify);
        const regionRows = node('div', 'daki-image-import-region-list');
        const existing = Array.isArray(source.promptRegions) ? source.promptRegions : [];
        for (const [index, value] of existing.entries()) {
            if (value && typeof value === 'object') {
                regionRows.appendChild(makeRegionRow(state, value, index, () => {
                    state.onRegionEdit?.();
                    updateLimits();
                }));
            }
        }
        const addRegion = node('button', 'daki-image-import-secondary', '+ 부위별 프롬프트');
        addRegion.type = 'button';
        addRegion.dataset.importControl = 'true';
        addRegion.dataset.limit = 'regions';
        addRegion.onclick = () => {
            if (regionRows.children.length >= 64) return;
            const row = makeRegionRow(state, {region: 'whole', prompt: ''}, null, () => {
                state.onRegionEdit?.();
                updateLimits();
            });
            regionRows.appendChild(row);
            updateLimits();
            row.querySelector('textarea')?.focus();
        };
        regions.append(regionToolbar, regionRows, addRegion);
        state.regionRows = regionRows;
        state.classificationStatus = classificationStatus;
        state.reclassifyButton = reclassify;
        state.reclassifyButton.onclick = () => state.onManualReclassify?.();
        state.promptEditor.appendChild(regions);
        if (!state.hasPromptInfo) classificationStatus.textContent = '캐릭터 프롬프트를 입력하면 자동으로 분류합니다.';
    }

    function collectPromptInfo(state) {
        const info = state.originalPromptInfo && typeof state.originalPromptInfo === 'object'
            ? clone(state.originalPromptInfo) : {};
        const basePrompt = state.promptEditor.querySelector('[data-prompt-field="basePrompt"]')?.value || '';
        const negativePrompt = state.promptEditor.querySelector('[data-prompt-field="negativePrompt"]')?.value || '';
        info.basePrompt = basePrompt;
        // Keep extraction aliases in sync so normalization cannot revive cleared text.
        info.baseCaption = basePrompt;
        for (const key of ['prompt', 'base_prompt', 'base_caption']) {
            if (key in info) info[key] = basePrompt;
        }
        info.negativePrompt = negativePrompt;
        for (const key of ['negative_prompt', 'uc']) {
            if (key in info) info[key] = negativePrompt;
        }
        info.charPrompts = [...state.charRows.querySelectorAll('[data-char-prompt]')].map(field => field.value);
        info.charPrompt = info.charPrompts.join(', ');
        info.promptRegions = [...state.regionRows.children].map(row => {
            const sourceIndex = row.dataset.originalIndex === '' ? -1 : Number(row.dataset.originalIndex);
            const original = Array.isArray(state.originalPromptInfo?.promptRegions)
                ? state.originalPromptInfo.promptRegions[sourceIndex] : null;
            const item = original && typeof original === 'object' ? clone(original) : {};
            item.region = row.querySelector('[data-region-select]')?.value || 'whole';
            item.prompt = row.querySelector('[data-region-prompt]')?.value || '';
            if (row.dataset.characterIndex !== undefined && row.dataset.characterIndex !== '') {
                const characterIndex = Number(row.dataset.characterIndex);
                if (Number.isInteger(characterIndex)) item.characterIndex = characterIndex;
            }
            return item;
        }).filter(item => item.prompt.trim());
        return info;
    }

    function createDialog(options) {
        const trigger = doc.activeElement;
        const dialog = node('dialog', 'daki-dialog daki-image-import-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiImageImportTitle');
        dialog.setAttribute('aria-describedby', 'dakiImageImportDescription');
        const header = node('header', 'daki-image-import-header');
        const headingGroup = node('div', 'daki-image-import-heading');
        headingGroup.append(node('span', 'daki-image-import-eyebrow', 'PROJECT LIBRARY'), node('h2', '', '그림 가져오기'));
        const projectName = node('p', 'daki-image-import-project', options.projectName || '프로젝트');
        projectName.title = projectName.textContent;
        projectName.id = 'dakiImageImportDescription';
        const closeButton = node('button', 'daki-image-import-close', '×');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', '그림 가져오기 닫기');
        closeButton.dataset.importControl = 'true';
        header.append(headingGroup, projectName, closeButton);
        const title = headingGroup.querySelector('h2');
        title.id = 'dakiImageImportTitle';

        const body = node('div', 'daki-image-import-body');
        const filePanel = node('section', 'daki-image-import-file-panel');
        const fileHeading = node('h3', '', '이미지 파일');
        const dropZone = node('div', 'daki-image-import-dropzone');
        dropZone.setAttribute('role', 'group');
        dropZone.setAttribute('aria-label', '이미지를 놓거나 붙여넣으세요');
        const uploadIcon = node('span', 'daki-image-import-upload-icon', '＋');
        uploadIcon.setAttribute('aria-hidden', 'true');
        const dropTitle = node('strong', '', '이미지를 놓거나 붙여넣으세요');
        const dropHelp = node('span', 'daki-image-import-drop-help', 'PNG · JPG · WebP · Ctrl+V');
        const chooseFile = node('button', 'daki-image-import-secondary', '파일 선택');
        chooseFile.type = 'button';
        chooseFile.dataset.importControl = 'true';
        const fileInput = node('input', 'daki-image-import-file-input');
        fileInput.type = 'file';
        fileInput.accept = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
        fileInput.tabIndex = -1;
        fileInput.setAttribute('aria-label', '가져올 이미지 파일 선택');
        const previewCard = node('div', 'daki-image-import-preview-card');
        previewCard.hidden = true;
        const previewImage = node('img', 'daki-image-import-preview');
        previewImage.alt = '가져올 이미지 미리보기';
        const fileDetails = node('div', 'daki-image-import-file-details');
        const fileName = node('strong', 'daki-image-import-file-name');
        const fileInfo = node('span', 'daki-image-import-file-info');
        const replaceFile = node('button', 'daki-image-import-secondary', '다른 파일');
        replaceFile.type = 'button';
        replaceFile.dataset.importControl = 'true';
        fileDetails.append(fileName, fileInfo, replaceFile);
        previewCard.append(previewImage, fileDetails);
        dropZone.append(uploadIcon, dropTitle, dropHelp, chooseFile, fileInput);
        const message = node('p', 'daki-image-import-status');
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        filePanel.append(fileHeading, dropZone, previewCard, message);

        const settingsPanel = node('section', 'daki-image-import-settings');
        const settingsHeading = node('div', 'daki-image-import-settings-heading');
        settingsHeading.appendChild(node('h3', '', '프로젝트 후보'));
        const promptBadge = node('span', 'daki-image-import-prompt-badge', '파일 선택 후 프롬프트 확인');
        settingsHeading.appendChild(promptBadge);
        const sideField = node('fieldset', 'daki-image-import-side');
        sideField.appendChild(node('legend', '', '추가할 면'));
        const sides = [];
        for (const [value, label] of [['front', '앞면'], ['back', '뒷면']]) {
            const input = node('input');
            input.type = 'radio';
            input.name = 'dakiImageImportSide';
            input.value = value;
            input.dataset.importControl = 'true';
            const sideLabel = node('label', 'daki-image-import-side-option');
            sideLabel.append(input, node('span', '', label));
            sideField.appendChild(sideLabel);
            sides.push(input);
        }
        const missingPrompt = node('div', 'daki-image-import-missing-prompt');
        missingPrompt.hidden = true;
        missingPrompt.append(node('strong', '', 'NAI 프롬프트를 찾지 못했습니다.'),
            node('p', '', '프롬프트를 입력할까요, 아니면 그림만 가져올까요?'));
        const promptChoiceActions = node('div', 'daki-image-import-choice-actions');
        const enterPrompt = node('button', 'daki-image-import-secondary', '프롬프트 입력');
        enterPrompt.type = 'button';
        enterPrompt.dataset.importControl = 'true';
        const skipPrompt = node('button', 'daki-image-import-secondary', '그림만 가져오기');
        skipPrompt.type = 'button';
        skipPrompt.dataset.importControl = 'true';
        promptChoiceActions.append(enterPrompt, skipPrompt);
        missingPrompt.appendChild(promptChoiceActions);
        const promptEditor = node('div', 'daki-image-import-prompt-editor');
        promptEditor.hidden = true;
        settingsPanel.append(settingsHeading, sideField, missingPrompt, promptEditor);
        body.append(filePanel, settingsPanel);

        const footer = node('footer', 'daki-image-import-footer');
        const cancel = node('button', 'daki-image-import-secondary', '취소');
        cancel.type = 'button';
        cancel.dataset.importControl = 'true';
        const save = node('button', 'daki-image-import-primary', '후보에 추가');
        save.type = 'button';
        save.disabled = true;
        footer.append(cancel, save);
        dialog.append(header, body, footer);
        doc.body.appendChild(dialog);

        const state = {
            dialog, trigger, projectId: options.projectId, fileInput, dropZone, previewCard, previewImage,
            fileName, fileInfo, message, promptBadge, sideInputs: sides, missingPrompt,
            promptEditor, enterPrompt, skipPrompt, cancel, closeButton, save,
            originalPromptInfo: null, regions: [], file: null, objectUrl: null, inspectController: null,
            inspectRevision: 0, inspectReady: false, inspectError: false, hasPromptInfo: false, promptChoice: null,
            classifyController: null, classifyRevision: 0, classifyTimer: null, classifying: false,
            regionEditRevision: 0, classificationStatus: null, reclassifyButton: null,
            saving: false, navigationPending: false, disposed: false,
        };

        function showMessage(text, isError = false) {
            state.message.textContent = text || '';
            state.message.hidden = !text;
            state.message.classList.toggle('is-error', Boolean(isError));
            if (isError) state.message.setAttribute('role', 'alert');
            else state.message.setAttribute('role', 'status');
        }

        function refreshControls() {
            const busy = state.saving;
            const classificationBusy = state.classifying || state.classifyTimer !== null;
            for (const control of dialog.querySelectorAll('[data-import-control]')) {
                const count = control.dataset.limit === 'characters' ? state.charRows?.children.length
                    : control.dataset.limit === 'regions' ? state.regionRows?.children.length : 0;
                const limit = control.dataset.limit === 'characters' ? 22 : control.dataset.limit === 'regions' ? 64 : Infinity;
                control.disabled = busy || count >= limit
                    || (control.dataset.classificationRetry === 'true' && classificationBusy);
            }
            state.fileInput.disabled = busy;
            for (const control of dialog.querySelectorAll('textarea, select')) control.disabled = busy;
            const selectedSide = state.sideInputs.some(input => input.checked);
            const promptDecision = state.hasPromptInfo || state.promptChoice !== null;
            state.save.disabled = busy || classificationBusy || !state.file || !state.inspectReady || !selectedSide || !promptDecision;
            state.save.textContent = busy ? '추가하는 중…' : '후보에 추가';
            dialog.setAttribute('aria-busy', String(busy || Boolean(state.inspectController) || classificationBusy));
        }
        state.refreshControls = refreshControls;

        function setClassificationStatus(text) {
            if (state.classificationStatus?.isConnected) state.classificationStatus.textContent = text || '';
        }

        function removeAutomaticRegions() {
            if (!state.regionRows) return;
            for (const row of [...state.regionRows.children]) {
                const value = row.dataset.characterIndex;
                if (value !== undefined && value !== '' && Number.isInteger(Number(value))) row.remove();
            }
            refreshControls();
        }

        function cancelClassification() {
            state.classifyRevision += 1;
            if (state.classifyTimer !== null) root.clearTimeout(state.classifyTimer);
            state.classifyTimer = null;
            state.classifyController?.abort();
            state.classifyController = null;
            state.classifying = false;
            refreshControls();
        }

        function characterSnapshot() {
            return [...(state.charRows?.querySelectorAll('[data-char-prompt]') || [])].map(field => field.value);
        }

        function validClassificationGroup(group, characterCount) {
            return group && typeof group === 'object' && Number.isInteger(group.characterIndex)
                && group.characterIndex >= 0 && group.characterIndex < characterCount
                && typeof group.region === 'string' && group.region
                && typeof group.prompt === 'string' && group.prompt.trim();
        }

        function applyClassification(result) {
            const groups = Array.isArray(result?.groups)
                ? result.groups.filter(group => validClassificationGroup(group, characterSnapshot().length)) : [];
            const slots = Math.max(0, 64 - (state.regionRows?.children.length || 0));
            const visibleGroups = groups.slice(0, slots);
            const omittedCount = Math.max(0, groups.length - visibleGroups.length);
            for (const group of visibleGroups) {
                const row = makeRegionRow(state, group, null, () => {
                    state.onRegionEdit?.();
                    refreshControls();
                }, group.characterIndex);
                state.regionRows.appendChild(row);
            }
            const parts = [`자동 분류 ${visibleGroups.length}개`];
            if (Number(result?.unknownCount) > 0) parts.push(`미분류 태그 ${Number(result.unknownCount)}개`);
            if (Number(result?.invalidCharacters) > 0) parts.push(`분석되지 않은 캐릭터 ${Number(result.invalidCharacters)}개`);
            if (omittedCount) parts.push(`최대 64개 중 ${omittedCount}개 생략`);
            setClassificationStatus(parts.join(' · '));
            refreshControls();
        }

        async function runClassification(revision, file, inspectRevision, editRevision, characters) {
            if (revision !== state.classifyRevision || state.disposed || state.saving) return;
            const classifier = root.DakiImageImportClassification?.classify;
            if (typeof classifier !== 'function') {
                setClassificationStatus('자동 분류 모듈을 불러오지 못했습니다. 직접 지정하거나 다시 시도해 주세요.');
                refreshControls();
                return;
            }
            if (!characters.some(value => value.trim())) {
                setClassificationStatus('캐릭터 프롬프트가 없어 자동 분류하지 않았습니다.');
                refreshControls();
                return;
            }
            const controller = new root.AbortController();
            state.classifyController = controller;
            state.classifying = true;
            setClassificationStatus('캐릭터 프롬프트를 분류하고 있습니다…');
            refreshControls();
            try {
                const result = await classifier(characters, {signal: controller.signal});
                const currentCharacters = characterSnapshot();
                const current = revision === state.classifyRevision && !state.disposed && !state.saving
                    && state.file === file && state.inspectRevision === inspectRevision
                    && state.regionEditRevision === editRevision
                    && currentCharacters.length === characters.length
                    && currentCharacters.every((value, index) => value === characters[index]);
                if (!current) return;
                applyClassification(result);
            } catch (error) {
                if (revision !== state.classifyRevision || state.disposed || error?.name === 'AbortError') return;
                const detail = String(error?.message || '').trim();
                setClassificationStatus(`자동 분류를 불러오지 못했습니다${detail ? `: ${detail}` : ''}. 직접 지정하거나 다시 시도해 주세요.`);
            } finally {
                if (revision === state.classifyRevision) {
                    state.classifyController = null;
                    state.classifying = false;
                    refreshControls();
                }
            }
        }

        function scheduleClassification(delay = 600) {
            cancelClassification();
            removeAutomaticRegions();
            if (!state.charRows || !state.regionRows || state.saving) return;
            const characters = characterSnapshot();
            if (!characters.some(value => value.trim())) {
                setClassificationStatus('캐릭터 프롬프트가 없어 자동 분류하지 않았습니다.');
                refreshControls();
                return;
            }
            const revision = state.classifyRevision;
            const file = state.file;
            const inspectRevision = state.inspectRevision;
            const editRevision = state.regionEditRevision;
            if (delay > 0) {
                setClassificationStatus('캐릭터 프롬프트 분류를 준비하고 있습니다…');
                state.classifyTimer = root.setTimeout(() => {
                    state.classifyTimer = null;
                    refreshControls();
                    runClassification(revision, file, inspectRevision, editRevision, characterSnapshot());
                }, delay);
                refreshControls();
                return;
            }
            runClassification(revision, file, inspectRevision, editRevision, characters);
        }

        state.onCharacterChange = () => scheduleClassification();
        state.onManualReclassify = () => scheduleClassification(0);
        state.onRegionEdit = () => {
            state.regionEditRevision += 1;
            if (state.classifying || state.classifyTimer !== null) {
                cancelClassification();
                setClassificationStatus('부위별 입력이 바뀌어 자동 분류를 취소했습니다. 다시 시도해 주세요.');
            }
            refreshControls();
        };

        function updatePromptVisibility() {
            const hasFile = Boolean(state.file);
            const noPromptChoiceNeeded = hasFile && state.inspectReady && !state.hasPromptInfo;
            state.missingPrompt.hidden = !noPromptChoiceNeeded || state.promptChoice !== null;
            state.promptEditor.hidden = !(state.hasPromptInfo || state.promptChoice === 'manual');
            if (state.hasPromptInfo) state.promptBadge.textContent = '자동 프롬프트 확인';
            else if (state.promptChoice === 'manual') state.promptBadge.textContent = '직접 입력';
            else if (state.promptChoice === 'skip') state.promptBadge.textContent = '프롬프트 없이 가져오기';
            else if (state.inspectError) state.promptBadge.textContent = '확인 실패';
            else if (state.inspectReady) state.promptBadge.textContent = '프롬프트 없음';
            else if (state.inspectController) state.promptBadge.textContent = '프롬프트 확인 중';
            else state.promptBadge.textContent = '파일 선택 후 프롬프트 확인';
            refreshControls();
        }

        function releasePreview() {
            if (state.objectUrl) root.URL.revokeObjectURL(state.objectUrl);
            state.objectUrl = null;
            state.dropZone.classList.remove('has-file');
            state.previewImage.removeAttribute('src');
            state.previewCard.hidden = true;
            state.fileInfo.textContent = '';
        }

        async function inspect(file, revision) {
            const controller = new root.AbortController();
            state.inspectController = controller;
            const formData = new root.FormData();
            formData.append('file', file, file.name || 'pasted-image');
            updatePromptVisibility();
            showMessage('이미지와 프롬프트를 확인하고 있습니다.');
            try {
                const response = await root.fetch('/api/daki/image-import/inspect', {
                    method: 'POST', body: formData, signal: controller.signal,
                });
                let result;
                try { result = await response.json(); }
                catch (_) { throw new Error('이미지 정보를 읽지 못했습니다. 다른 파일을 선택해 주세요.'); }
                if (!response.ok || result.status !== 'success') throw apiError(result, '이미지를 확인하지 못했습니다. 다른 파일을 선택해 주세요.');
                if (state.disposed || revision !== state.inspectRevision) return;
                state.originalPromptInfo = result.promptInfo && typeof result.promptInfo === 'object' ? clone(result.promptInfo) : {};
                state.hasPromptInfo = Boolean(result.hasPromptInfo || hasPromptText(state.originalPromptInfo));
                state.regions = Array.isArray(result.regions) ? result.regions.filter(item => item && item.id).map(item => ({id: String(item.id), label: String(item.label || item.id)})) : [];
                if (!state.regions.some(region => region.id === 'whole')) state.regions.unshift({id: 'whole', label: '전체'});
                state.inspectReady = true;
                state.inspectError = false;
                if (state.hasPromptInfo) {
                    state.promptChoice = null;
                    populateEditor(state, state.originalPromptInfo);
                    scheduleClassification(0);
                } else {
                    cancelClassification();
                    state.promptChoice = null;
                    state.originalPromptInfo = {};
                    state.promptEditor.replaceChildren();
                    state.charRows = null;
                    state.regionRows = null;
                    state.classificationStatus = null;
                    state.reclassifyButton = null;
                }
                const dimensions = Number(result.width) > 0 && Number(result.height) > 0 ? ` · ${result.width} × ${result.height}` : '';
                showMessage(state.hasPromptInfo ? `NAI 프롬프트를 확인했습니다${dimensions}.` : `이미지를 확인했습니다${dimensions}.`);
                updatePromptVisibility();
            } catch (error) {
                if (state.disposed || revision !== state.inspectRevision || error.name === 'AbortError') return;
                state.inspectReady = false;
                state.inspectError = true;
                state.hasPromptInfo = false;
                state.promptChoice = null;
                state.originalPromptInfo = null;
                showMessage(error.message || '이미지를 확인하지 못했습니다. 다른 파일을 선택해 주세요.', true);
                state.promptBadge.textContent = '확인 필요';
                updatePromptVisibility();
            } finally {
                if (revision === state.inspectRevision) {
                    state.inspectController = null;
                    updatePromptVisibility();
                }
            }
        }

        function selectFile(file) {
            if (!file || state.saving) return;
            cancelClassification();
            state.inspectRevision += 1;
            state.inspectController?.abort();
            state.inspectController = null;
            state.inspectReady = false;
            state.inspectError = false;
            state.hasPromptInfo = false;
            state.promptChoice = null;
            state.originalPromptInfo = null;
            state.file = null;
            releasePreview();
            if (!isSupported(file)) {
                showMessage('PNG, JPG, WebP 이미지 한 장을 선택해 주세요.', true);
                updatePromptVisibility();
                return;
            }
            state.file = file;
            state.fileName.textContent = file.name || '클립보드 이미지';
            state.fileName.title = file.name || '클립보드 이미지';
            state.objectUrl = root.URL.createObjectURL(file);
            state.previewImage.src = state.objectUrl;
            state.previewCard.hidden = false;
            state.dropZone.classList.add('has-file');
            state.previewImage.onerror = () => {
                if (state.file === file) showMessage('이미지 미리보기를 열 수 없습니다. 파일을 다시 확인해 주세요.', true);
            };
            const size = file.size > 0 ? `${(file.size / 1024 / 1024).toFixed(file.size < 1024 * 1024 ? 0 : 1)} MB` : '';
            state.fileInfo.textContent = `${file.type || fileExtension(file).toUpperCase()}${size ? ` · ${size}` : ''}`;
            showMessage('이미지와 프롬프트를 확인하고 있습니다.');
            updatePromptVisibility();
            const revision = state.inspectRevision;
            inspect(file, revision);
        }

        function close() {
            if (state.saving || state.disposed) return false;
            state.disposed = true;
            cancelClassification();
            state.inspectRevision += 1;
            state.inspectController?.abort();
            state.inspectController = null;
            releasePreview();
            root.removeEventListener('hashchange', onHashChange);
            root.removeEventListener('pagehide', onPageHide);
            doc.removeEventListener('paste', onPaste, true);
            if (dialog.open) dialog.close();
            dialog.remove();
            if (state.trigger?.isConnected) state.trigger.focus({preventScroll: true});
            if (active === state) active = null;
            return true;
        }

        function onHashChange() {
            if (state.saving) {
                state.navigationPending = true;
                return;
            }
            close();
        }

        function onPageHide() {
            if (!state.saving) close();
        }

        function onPaste(event) {
            if (state.saving) return;
            const items = [...(event.clipboardData?.items || [])];
            const item = items.find(entry => entry.kind === 'file' && allowedTypes.has(entry.type));
            if (!item) return;
            const blob = item.getAsFile();
            if (!blob) return;
            event.preventDefault();
            const extension = blob.type === 'image/png' ? 'png' : blob.type === 'image/webp' ? 'webp' : 'jpg';
            const file = typeof root.File === 'function'
                ? new root.File([blob], `pasted-image.${extension}`, {type: blob.type}) : blob;
            if (!file.name) Object.defineProperty(file, 'name', {value: `pasted-image.${extension}`});
            selectFile(file);
        }

        async function saveImage() {
            if (state.save.disabled || state.saving) return;
            const side = state.sideInputs.find(input => input.checked)?.value;
            if (!side || !state.file || !state.inspectReady) return;
            const editedPromptInfo = state.hasPromptInfo || state.promptChoice === 'manual'
                ? collectPromptInfo(state) : null;
            if (editedPromptInfo) {
                const regions = editedPromptInfo.promptRegions || [];
                let combinedBase = String(editedPromptInfo.basePrompt || '').trim();
                for (const region of regions) {
                    if (Number.isInteger(region.characterIndex)) continue;
                    if (region.prompt && !combinedBase.includes(region.prompt)) {
                        combinedBase = [combinedBase, region.prompt.trim()].filter(Boolean).join(', ');
                    }
                }
                const promptFields = [editedPromptInfo.basePrompt, editedPromptInfo.negativePrompt,
                    ...(editedPromptInfo.charPrompts || []), ...regions.map(region => region.prompt)];
                if ((editedPromptInfo.charPrompts || []).length > 22 || regions.length > 64
                    || promptFields.some(value => String(value || '').length > 30000) || combinedBase.length > 30000) {
                    showMessage('프롬프트는 항목마다 3만 자 이하로 입력해 주세요. 캐릭터는 22개, 부위별 프롬프트는 64개까지 추가할 수 있습니다.', true);
                    return;
                }
            }
            state.saving = true;
            cancelClassification();
            refreshControls();
            showMessage('프로젝트에 그림을 추가하고 있습니다.');
            try {
                const formData = new root.FormData();
                formData.append('file', state.file, state.file.name || 'pasted-image');
                formData.append('side', side);
                formData.append('promptInfo', JSON.stringify(editedPromptInfo || {}));
                const response = await root.fetch(`/api/daki/projects/${encodeURIComponent(state.projectId)}/image-import`, {
                    method: 'POST', body: formData,
                });
                let result;
                try { result = await response.json(); }
                catch (_) { throw new Error('저장 결과를 확인하지 못했습니다. 프로젝트를 새로고침해 확인해 주세요.'); }
                if (!response.ok || result.status !== 'success') throw apiError(result, '그림을 프로젝트에 추가하지 못했습니다. 다시 시도해 주세요.');
                showMessage('프로젝트 후보에 그림을 추가했습니다.');
                const projectId = state.projectId;
                state.saving = false;
                close();
                try { await root.Daki?.refreshProject?.(projectId); }
                catch (_) { /* The import already succeeded; project rendering owns its own error state. */ }
            } catch (error) {
                state.saving = false;
                showMessage(error.message || '그림을 추가하지 못했습니다. 다시 시도해 주세요.', true);
                refreshControls();
                if (state.navigationPending) close();
            }
        }

        chooseFile.onclick = () => fileInput.click();
        replaceFile.onclick = () => fileInput.click();
        fileInput.onchange = () => {
            const file = fileInput.files?.[0];
            fileInput.value = '';
            if (file) selectFile(file);
        };
        dropZone.addEventListener('dragover', event => {
            event.preventDefault();
            if (!state.saving) dropZone.classList.add('is-dragging');
        });
        dropZone.addEventListener('dragleave', event => {
            if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-dragging');
        });
        dropZone.addEventListener('drop', event => {
            event.preventDefault();
            dropZone.classList.remove('is-dragging');
            const file = event.dataTransfer?.files?.[0];
            if (file) selectFile(file);
        });
        for (const input of sides) input.addEventListener('change', refreshControls);
        enterPrompt.onclick = () => {
            cancelClassification();
            state.promptChoice = 'manual';
            state.originalPromptInfo = {};
            populateEditor(state, {});
            showMessage('프롬프트를 직접 입력하거나 비워 둔 채 그림을 가져올 수 있습니다.');
            updatePromptVisibility();
            state.promptEditor.querySelector('textarea')?.focus();
        };
        skipPrompt.onclick = () => {
            cancelClassification();
            state.promptChoice = 'skip';
            state.promptEditor.replaceChildren();
            state.charRows = null;
            state.regionRows = null;
            state.classificationStatus = null;
            state.reclassifyButton = null;
            showMessage('프롬프트 없이 그림만 추가합니다.');
            updatePromptVisibility();
        };
        cancel.onclick = close;
        closeButton.onclick = close;
        save.onclick = saveImage;
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            close();
        });
        dialog.addEventListener('click', event => {
            if (event.target === dialog) close();
        });
        root.addEventListener('hashchange', onHashChange);
        root.addEventListener('pagehide', onPageHide);
        doc.addEventListener('paste', onPaste, true);
        dialog.showModal();
        active = state;
        chooseFile.focus({preventScroll: true});
        return state;
    }

    function open(options) {
        if (!doc || !options?.projectId) return null;
        if (active && !active.disposed) {
            active.dialog.focus();
            return active;
        }
        return createDialog(options);
    }

    root.DakiImageImport = {open};
    if (typeof module !== 'undefined' && module.exports) module.exports = {hasPromptText, isSupported, promptChars};
})(typeof window === 'undefined' ? globalThis : window);
