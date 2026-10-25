(function (global) {
    'use strict';

    const TOOL_HELP = {
        hand: 'Space를 누른 채 드래그하거나 손 도구로 화면을 이동합니다.',
        paint: '보정 레이어에 적용할 곳을 칠합니다.',
        maskAdd: '지운 곳을 다시 칠해 보정을 복원합니다.',
        airbrush: '색을 직접 분사합니다. 누르고 있거나 여러 번 지나가면 진해집니다. 혼합 모드·분사량으로 강도를 조절하세요.',
        maskErase: '선택한 보정만 지웁니다. 경계 선명도 0%는 부드럽게, 100%는 또렷하게 지웁니다.',
        clone: 'Alt+클릭으로 복제 기준점을 찍고 고칠 부분을 칠합니다.',
        liquify: '드래그해 형태를 다듬습니다. 제외 마스크로 눈과 장식을 보호하세요.',
        dropper: '그림을 클릭해 색을 채취합니다. 반대쪽 그림도 참고할 수 있습니다.',
        rect: '드래그한 사각 영역 안에만 보정을 적용합니다.',
        ellipse: '드래그한 타원 영역 안에만 보정을 적용합니다.',
        inspect: '그림을 클릭해 원본과 보정 결과를 1:1 픽셀로 비교합니다.',
    };
    const TOOL_BUTTON_TEXT = {
        hand: '이동',
        paint: '브러시',
        maskErase: '지우개',
        airbrush: '에어브러시',
        clone: '복제',
        liquify: '유동화',
        dropper: '스포이드',
        rect: '사각형',
        ellipse: '타원',
        inspect: '픽셀 검사',
    };
    const MASK_TOOLS = [
        {id: 'maskAdd', label: '적용 칠하기', ariaLabel: '선택한 보정 적용 영역 칠하기 도구 선택'},
        {id: 'maskErase', label: '보정 지우개', ariaLabel: '레이어 설정에서 보정 지우개 도구 선택'},
    ];
    const COLOR_MODES = [
        ['normal', '일반 · 색 덮기'],
        ['color', '색상 · 음영 유지'],
        ['soft-light', '소프트 라이트 · 빛과 색'],
        ['multiply', '곱하기 · 음영'],
        ['screen', '스크린 · 밝은 빛'],
    ];
    const LIQUIFY_MODES = [
        ['push', '밀기'],
        ['expand', '팽창'],
        ['shrink', '수축'],
        ['clockwise', '시계 방향 회전'],
        ['counterclockwise', '반시계 방향 회전'],
    ];
    const NO_COPY_TYPES = new Set(['paint', 'clone', 'liquify']);

    function create(host, actions) {
        if (!host || !host.ownerDocument) throw new TypeError('CanvasRetouchPanel.create requires a DOM host');
        const doc = host.ownerDocument;
        const state = global.CanvasRetouchState || {};
        const names = state.NAMES || {};
        const checks = Array.isArray(state.CHECKS) ? state.CHECKS : [];
        const tools = Array.isArray(state.TOOLS) ? state.TOOLS : [];
        const presets = Array.isArray(state.PRESETS) ? state.PRESETS : [];
        const recipeSteps = Array.isArray(state.RECIPE_STEPS) ? state.RECIPE_STEPS : [];
        const presetGroups = Array.isArray(state.PRESET_GROUPS) && state.PRESET_GROUPS.length
            ? state.PRESET_GROUPS.filter(group => group && group.id)
            : [
                {id: 'global', label: '전체 분위기'},
                {id: 'skin', label: '피부 · 혈색'},
                {id: 'light', label: '음영 · 빛'},
            ];
        const paramsByType = state.PARAMS || {};
        const invoke = (name, ...args) => {
            if (actions && typeof actions[name] === 'function') return actions[name](...args);
            return undefined;
        };

        function node(tag, className, text) {
            const item = doc.createElement(tag);
            if (className) item.className = className;
            if (text !== undefined && text !== null) item.textContent = String(text);
            return item;
        }

        function button(text, ariaLabel, className, handler) {
            const item = node('button', className || '', text);
            item.type = 'button';
            item.setAttribute('aria-label', ariaLabel || String(text));
            if (text !== undefined && text !== null) item.title = String(text);
            item.addEventListener('click', handler || function () {});
            return item;
        }

        function setValue(control, value) {
            if (!control || doc.activeElement === control) return;
            const next = value === undefined || value === null ? '' : String(value);
            if (control.value !== next) control.value = next;
        }

        function setDisabled(control, disabled) {
            if (control) control.disabled = Boolean(disabled);
        }

        function labelledField(labelText, control, className) {
            const label = node('label', className || 'canvas-retouch-field');
            label.append(node('span', 'canvas-retouch-field-label', labelText), control);
            return label;
        }

        function section(title, className) {
            const wrap = node('section', 'canvas-retouch-section' + (className ? ' ' + className : ''));
            wrap.append(node('h3', 'canvas-retouch-section-title', title));
            return wrap;
        }

        const root = node('section', 'canvas-retouch-panel');
        root.setAttribute('aria-label', '캔버스 보정');

        const header = node('header', 'canvas-retouch-header');
        const headingBlock = node('div', 'canvas-retouch-heading');
        headingBlock.append(node('h2', 'canvas-retouch-title', '캔버스 보정'));
        const caption = node('p', 'canvas-retouch-caption', '전체 합성본 · 원본 레이어 보존');
        headingBlock.append(caption);
        headingBlock.append(node('p', 'canvas-retouch-caption', '닫아도 보정 기록은 캔버스에 보관됩니다.'));
        const closeButton = button('닫기', '캔버스 보정 닫기', 'canvas-retouch-close', () => invoke('close'));
        header.append(headingBlock, closeButton);

        const body = node('div', 'canvas-retouch-body');
        const loading = node('p', 'canvas-retouch-loading', '보정 정보를 불러오는 중입니다.');
        loading.setAttribute('role', 'status');
        const errorMessage = node('p', 'canvas-retouch-message is-error');
        errorMessage.setAttribute('role', 'alert');
        const statusMessage = node('p', 'canvas-retouch-message');
        statusMessage.setAttribute('role', 'status');
        const content = node('div', 'canvas-retouch-content');
        body.append(loading, errorMessage, statusMessage, content);

        const historySection = section('기록', 'canvas-retouch-history-section');
        const historyRow = node('div', 'canvas-retouch-button-row');
        const undoButton = button('↶ 실행 취소', '실행 취소', 'canvas-retouch-secondary', () => invoke('undo'));
        const redoButton = button('↷ 다시 실행', '다시 실행', 'canvas-retouch-secondary', () => invoke('redo'));
        historyRow.append(undoButton, redoButton);
        historySection.append(historyRow);

        const presetSection = section('보정 프리셋', 'canvas-retouch-preset-section');
        const presetCategoryRow = node('div', 'canvas-retouch-category-row');
        const presetGrid = node('div', 'canvas-retouch-card-grid');
        const presetHint = node('p', 'canvas-retouch-hint');
        const presetScopeHint = node('p', 'canvas-retouch-hint');
        const presetCapacityHint = node('p', 'canvas-retouch-hint canvas-retouch-capacity');
        const presetStrengthRow = node('div', 'canvas-retouch-strength-row');
        const presetAddButton = button('선택한 프리셋 추가', '선택한 프리셋 추가', 'canvas-retouch-primary canvas-retouch-preset-add', () => {
            const selectedPreset = presets.find(preset => preset && preset.id === selectedPresetId);
            if (selectedPreset) invoke('preset', selectedPreset.id, presetStrength);
        });
        const strengthOptions = [
            {value: 0.5, label: '은은하게'},
            {value: 1, label: '기본'},
            {value: 1.5, label: '또렷하게'},
        ];
        const presetCategoryButtons = new Map();
        const presetCards = new Map();
        let selectedPresetId = null;
        let selectedGroupId = 'global';
        let presetStrength = 1;
        let currentView = null;

        function updatePresetCategories() {
            for (const [id, control] of presetCategoryButtons) {
                const active = id === selectedGroupId;
                control.classList.toggle('is-active', active);
                control.setAttribute('aria-pressed', String(active));
                control.disabled = Boolean(currentView && currentView.busy)
                    || !Boolean(currentView && currentView.doc)
                    || !presetsInGroup(id).length;
            }
        }

        function getPresetGroup(preset) {
            return preset.group || (preset.scope === 'global' ? 'global' : 'skin');
        }

        function presetsInGroup(groupId) {
            return presets.filter(preset => preset && preset.id && getPresetGroup(preset) === groupId);
        }

        function presetLayerCount(preset) {
            const count = Number(preset && preset.layerCount);
            return Number.isInteger(count) && count > 0 ? count : 1;
        }

        const initialPreset = presets.find(preset => preset && preset.id === 'natural')
            || presetsInGroup('global')[0]
            || presets.find(preset => preset && preset.id)
            || null;
        if (initialPreset) {
            selectedPresetId = initialPreset.id;
            selectedGroupId = getPresetGroup(initialPreset);
        } else if (!presetGroups.some(group => group.id === selectedGroupId)) {
            selectedGroupId = (presetGroups[0] && presetGroups[0].id) || '';
        }

        function updatePresetPresentation() {
            const selectedPreset = presets.find(preset => preset && preset.id === selectedPresetId) || null;
            const controlsDisabled = !currentView || !currentView.doc || Boolean(currentView.busy);
            presetHint.textContent = selectedPreset ? selectedPreset.hint || '' : '';
            presetScopeHint.textContent = selectedPreset && selectedPreset.scope === 'global'
                ? '이미지 전체에 적용됩니다. 추가 후 각 레이어에서 강도를 조절할 수 있어요.'
                : '추가한 뒤 원하는 곳에 에어브러시로 칠하세요. 칠하지 않은 머리·옷은 그대로 유지됩니다.';
            for (const [id, card] of presetCards) {
                const active = id === selectedPresetId;
                card.classList.toggle('is-active', active);
                card.setAttribute('aria-pressed', String(active));
                card.disabled = controlsDisabled;
            }
            for (const [strength, control] of presetStrengthButtons) {
                const active = strength === presetStrength;
                control.classList.toggle('is-active', active);
                control.setAttribute('aria-pressed', String(active));
                control.disabled = controlsDisabled;
            }
            updatePresetCapacity();
        }

        function updatePresetCapacity() {
            const selectedPreset = presets.find(preset => preset && preset.id === selectedPresetId) || null;
            const layers = currentView && currentView.doc && Array.isArray(currentView.doc.layers)
                ? currentView.doc.layers
                : [];
            const count = selectedPreset ? presetLayerCount(selectedPreset) : 0;
            const overCapacity = Boolean(selectedPreset && currentView && currentView.doc && layers.length + count > 40);
            presetCapacityHint.hidden = !overCapacity;
            presetCapacityHint.textContent = overCapacity
                ? `보정 레이어가 ${count}개 필요해요. (현재 ${layers.length}/40)`
                : '';
            presetAddButton.disabled = !currentView || !currentView.doc || Boolean(currentView.busy)
                || !selectedPreset || overCapacity;
        }

        function renderPresetCards() {
            const available = presetsInGroup(selectedGroupId);
            if (!available.some(preset => preset.id === selectedPresetId)) {
                selectedPresetId = available.length ? available[0].id : null;
            }
            presetGrid.replaceChildren();
            presetCards.clear();
            for (const preset of available) {
                const label = preset.label || preset.id;
                const card = button('', `${label} 프리셋 선택`, 'canvas-retouch-preset-card', () => {
                    selectedPresetId = preset.id;
                    updatePresetPresentation();
                });
                const count = presetLayerCount(preset);
                const meta = preset.scope === 'global'
                    ? `전체 · ${count}개 레이어`
                    : '칠한 곳만';
                card.append(
                    node('span', 'canvas-retouch-preset-name', label.replace(/^전체\s*/, '')),
                    node('span', 'canvas-retouch-preset-meta', meta)
                );
                card.dataset.presetId = preset.id;
                presetCards.set(preset.id, card);
                presetGrid.append(card);
            }
            updatePresetPresentation();
        }

        for (const group of presetGroups) {
            const control = button(group.label || group.id, `${group.label || group.id} 프리셋 보기`, 'canvas-retouch-category', () => {
                selectedGroupId = group.id;
                updatePresetCategories();
                renderPresetCards();
            });
            presetCategoryButtons.set(group.id, control);
            presetCategoryRow.append(control);
        }
        updatePresetCategories();
        const presetStrengthButtons = new Map();
        for (const option of strengthOptions) {
            const control = button(option.label, `프리셋 강도 ${option.label}`, 'canvas-retouch-strength', () => {
                presetStrength = option.value;
                updatePresetPresentation();
            });
            presetStrengthButtons.set(option.value, control);
            presetStrengthRow.append(control);
        }
        presetSection.append(presetCategoryRow, presetGrid, presetHint, presetScopeHint,
            presetCapacityHint, presetStrengthRow, presetAddButton);
        renderPresetCards();

        const quickDetails = node('details', 'canvas-retouch-details canvas-retouch-quick');
        const quickSummary = node('summary', '', '8단계 골라 추가 · 설정 복사');
        const quickBody = node('div', 'canvas-retouch-details-body');
        const selectedRecipeIds = new Set(recipeSteps.map(step => step.id));
        const recipeCheckboxes = new Map();
        const recipeOptions = node('div', 'canvas-retouch-recipe-options');
        for (const [index, step] of recipeSteps.entries()) {
            const scopeLabel = step.scope === 'all' ? '전체' : '칠한 곳만';
            const optionLabel = `${index + 1}. ${step.label} · ${scopeLabel}`;
            const option = node('label', 'canvas-retouch-recipe-option');
            const checkbox = node('input', '');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.setAttribute('aria-label', optionLabel);
            checkbox.addEventListener('change', () => {
                if (!currentView || !currentView.doc || currentView.busy) {
                    checkbox.checked = selectedRecipeIds.has(step.id);
                    return;
                }
                if (checkbox.checked) selectedRecipeIds.add(step.id);
                else selectedRecipeIds.delete(step.id);
                updateRecipeControls();
            });
            option.append(checkbox, node('span', '', optionLabel));
            recipeCheckboxes.set(step.id, checkbox);
            recipeOptions.append(option);
        }
        const recipeSelectionRow = node('div', 'canvas-retouch-button-row');
        const recipeSelectAll = button('전체 선택', '8단계 모두 선택', 'canvas-retouch-secondary', () => {
            if (!currentView || !currentView.doc || currentView.busy) return;
            for (const step of recipeSteps) selectedRecipeIds.add(step.id);
            updateRecipeControls();
        });
        const recipeClearAll = button('전체 해제', '8단계 모두 해제', 'canvas-retouch-secondary', () => {
            if (!currentView || !currentView.doc || currentView.busy) return;
            selectedRecipeIds.clear();
            updateRecipeControls();
        });
        recipeSelectionRow.append(recipeSelectAll, recipeClearAll);
        const recipeCapacityHint = node('p', 'canvas-retouch-hint canvas-retouch-recipe-capacity');
        const recipeButton = button('선택한 8단계 추가', '선택한 8단계 보정 추가', 'canvas-retouch-primary', () => {
            if (recipeButton.disabled) return;
            invoke('recipe', recipeSteps.filter(step => selectedRecipeIds.has(step.id)).map(step => step.id));
        });
        const recipeHint = node('p', 'canvas-retouch-hint', '원하는 단계만 골라 추가하세요. “칠한 곳만” 단계는 추가한 뒤 원하는 영역을 칠해야 적용됩니다. 피부만 보정하려면 위의 부분 프리셋을 사용하세요.');
        const copyRow = node('div', 'canvas-retouch-button-row');
        const copyButton = button('설정 복사', '현재 보정 설정 복사', 'canvas-retouch-secondary', () => invoke('copy'));
        const pasteButton = button('설정 붙여넣기', '복사한 보정 설정 붙여넣기', 'canvas-retouch-secondary', () => invoke('paste'));
        copyRow.append(copyButton, pasteButton);
        function updateRecipeControls() {
            const hasDoc = Boolean(currentView && currentView.doc);
            const busy = Boolean(currentView && currentView.busy);
            const layers = hasDoc && Array.isArray(currentView.doc.layers) ? currentView.doc.layers : [];
            const selectedCount = selectedRecipeIds.size;
            const overCapacity = layers.length + selectedCount > 40;
            for (const step of recipeSteps) {
                const checkbox = recipeCheckboxes.get(step.id);
                checkbox.checked = selectedRecipeIds.has(step.id);
                checkbox.disabled = !hasDoc || busy;
            }
            recipeSelectAll.disabled = !hasDoc || busy;
            recipeClearAll.disabled = !hasDoc || busy;
            recipeButton.textContent = `선택한 ${selectedCount}단계 추가`;
            recipeButton.title = recipeButton.textContent;
            recipeButton.setAttribute('aria-label', `선택한 ${selectedCount}단계 보정 추가`);
            recipeButton.disabled = !hasDoc || busy || selectedCount === 0 || overCapacity;
            recipeCapacityHint.textContent = `선택한 단계 ${selectedCount}/8 · 보정 레이어 ${layers.length}/40${
                selectedCount === 0 ? ' · 추가할 단계를 선택하세요.' : overCapacity ? ' · 현재 선택한 단계를 모두 추가할 공간이 부족합니다.' : ''}`;
        }
        updateRecipeControls();
        quickBody.append(recipeHint, recipeOptions, recipeSelectionRow, recipeCapacityHint, recipeButton, copyRow);
        quickDetails.append(quickSummary, quickBody);

        const layerSection = section('보정 레이어', 'canvas-retouch-layer-section');
        const addRow = node('div', 'canvas-retouch-add-row');
        const addType = node('select', 'canvas-retouch-control');
        addType.setAttribute('aria-label', '새 보정 레이어 종류');
        for (const [type, label] of Object.entries(names)) {
            const option = node('option', '', label);
            option.value = type;
            addType.append(option);
        }
        if (addType.options && addType.options.length) addType.value = addType.options[0].value;
        const addButton = button('추가', '보정 레이어 추가', 'canvas-retouch-secondary', () => invoke('add', addType.value));
        addRow.append(addType, addButton);
        const layerList = node('div', 'canvas-retouch-layer-list');
        layerList.setAttribute('aria-label', '보정 레이어 목록');
        const layerEmpty = node('p', 'canvas-retouch-empty', '보정 레이어를 추가하세요.');
        layerList.append(layerEmpty);
        const selectionHint = node('p', 'canvas-retouch-hint canvas-retouch-selection-hint',
            'Shift+클릭으로 여러 보정을 선택합니다.');
        const layerActions = node('div', 'canvas-retouch-button-row canvas-retouch-layer-actions');
        const moveUp = button('위로', '선택한 레이어 위로 이동', 'canvas-retouch-secondary', () => invoke('move', 1));
        const moveDown = button('아래로', '선택한 레이어 아래로 이동', 'canvas-retouch-secondary', () => invoke('move', -1));
        const duplicateButton = button('복제', '선택한 레이어 복제', 'canvas-retouch-secondary', () => invoke('duplicate'));
        const removeButton = button('삭제', '선택한 레이어 삭제', 'canvas-retouch-danger', () => invoke('remove'));
        layerActions.append(moveUp, moveDown, duplicateButton, removeButton);
        const layerMaskActions = node('div', 'canvas-retouch-button-row canvas-retouch-layer-actions');
        const layerEraseButton = button('보정 지우개', '선택한 보정의 보정 지우개 선택', 'canvas-retouch-secondary', () => invoke('setTool', 'maskErase'));
        const layerRestoreButton = button('지운 곳 복원', '선택한 보정에서 지운 곳 복원 도구 선택', 'canvas-retouch-secondary', () => invoke('setTool', 'maskAdd'));
        layerMaskActions.append(layerEraseButton, layerRestoreButton);
        layerSection.append(addRow, layerList, selectionHint, layerActions, layerMaskActions);

        const settingsSection = section('레이어 설정', 'canvas-retouch-settings-section');
        const settings = node('div', 'canvas-retouch-settings');
        settingsSection.append(settings);
        let settingsKey = null;
        let settingsRefs = null;

        const toolSection = section('도구', 'canvas-retouch-tool-section');
        const toolGrid = node('div', 'canvas-retouch-tool-grid');
        const toolButtons = new Map();
        for (const tool of tools) {
            if (!tool || !tool.id) continue;
            const label = tool.label || tool.id;
            const control = button(TOOL_BUTTON_TEXT[tool.id] || label, label, 'canvas-retouch-tool', () => invoke('setTool', tool.id));
            control.title = label;
            control.dataset.tool = tool.id;
            toolButtons.set(tool.id, control);
            toolGrid.append(control);
        }
        toolSection.append(toolGrid);
        const toolHint = node('p', 'canvas-retouch-hint');
        toolHint.setAttribute('aria-live', 'polite');
        toolSection.append(toolHint);

        const brushDetails = node('details', 'canvas-retouch-details canvas-retouch-brush');
        brushDetails.open = true;
        const brushSummary = node('summary', '', '브러시');
        const brushBody = node('div', 'canvas-retouch-details-body canvas-retouch-brush-grid');
        const brushRefs = {};
        let flowLabel;
        const brushSpecs = [
            ['size', '크기', 1, 1600, 1, 'px'],
            ['flow', '불투명도', 1, 100, 1, '%'],
            ['hardness', '경계 선명도', 0, 100, 1, '%'],
            ['opacity', '한 획 최대 농도', 1, 100, 1, '%'],
        ];
        for (const [key, labelText, min, max, step, unit] of brushSpecs) {
            const wrap = node('label', 'canvas-retouch-range-field');
            if (key === 'opacity') wrap.classList.add('canvas-retouch-airbrush-only');
            const line = node('span', 'canvas-retouch-range-heading');
            const label = node('span', '', labelText);
            if (key === 'flow') flowLabel = label;
            const output = node('output', 'canvas-retouch-output');
            const range = node('input', 'canvas-retouch-range');
            range.type = 'range';
            range.min = String(min); range.max = String(max); range.step = String(step);
            range.setAttribute('aria-label', labelText);
            range.addEventListener('input', () => invoke('brush', key, Number(range.value)));
            line.append(label, output);
            wrap.append(line, range);
            brushBody.append(wrap);
            brushRefs[key] = {range, output, unit, label};
        }
        const brushColor = node('input', 'canvas-retouch-color-input');
        brushColor.type = 'color';
        brushColor.value = '#e6baa4';
        brushColor.setAttribute('aria-label', '브러시 칠할 색');
        brushColor.addEventListener('input', () => invoke('brush', 'color', brushColor.value));
        const brushColorLabel = labelledField('칠할 색', brushColor, 'canvas-retouch-color-field');
        brushBody.append(brushColorLabel);
        brushRefs.color = {input: brushColor};
        brushDetails.append(brushSummary, brushBody);

        const viewSection = section('미리보기', 'canvas-retouch-view-section');
        const compareRow = node('div', 'canvas-retouch-toggle-row');
        const compareToggle = node('input', ''); compareToggle.type = 'checkbox'; compareToggle.setAttribute('aria-label', '전후 비교');
        compareToggle.addEventListener('change', () => invoke('compare', compareToggle.checked));
        compareRow.append(compareToggle, node('span', '', '전후 비교'));
        const splitWrap = node('label', 'canvas-retouch-range-field canvas-retouch-compare-split');
        const splitLine = node('span', 'canvas-retouch-range-heading');
        const splitTitle = node('span', '', '왼쪽 원본 · 오른쪽 보정본');
        const splitOutput = node('output', 'canvas-retouch-output');
        const splitRange = node('input', 'canvas-retouch-range');
        splitRange.type = 'range'; splitRange.min = '0'; splitRange.max = '100'; splitRange.step = '1';
        splitRange.setAttribute('aria-label', '전후 비교 위치');
        splitRange.addEventListener('input', () => invoke('compareSplit', Number(splitRange.value)));
        splitLine.append(splitTitle, splitOutput); splitWrap.append(splitLine, splitRange);
        const guidesRow = node('label', 'canvas-retouch-toggle-row');
        const guidesToggle = node('input', ''); guidesToggle.type = 'checkbox'; guidesToggle.setAttribute('aria-label', '재단 가이드 표시');
        guidesToggle.addEventListener('change', () => invoke('guides', guidesToggle.checked));
        guidesRow.append(guidesToggle, node('span', '', '재단 가이드'));
        viewSection.append(compareRow, splitWrap, guidesRow);

        const printDetails = node('details', 'canvas-retouch-details canvas-retouch-print');
        const printSummary = node('summary', '', '인쇄 규격');
        const printBody = node('div', 'canvas-retouch-details-body');
        const printGrid = node('div', 'canvas-retouch-grid');
        const printRefs = {};
        const printSpecs = [
            ['widthCm', '제품 가로 (cm)', 1, 300],
            ['heightCm', '제품 세로 (cm)', 1, 400],
            ['safeMm', '안쪽 안전 여백 (mm)', 0, 100],
        ];
        for (const [key, labelText, min, max] of printSpecs) {
            const input = node('input', 'canvas-retouch-control');
            input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off';
            input.setAttribute('aria-label', labelText);
            input.dataset.min = String(min); input.dataset.max = String(max);
            input.addEventListener('change', () => {
                const number = Number(input.value);
                if (Number.isFinite(number) && number >= min && number <= max) invoke('print', key, number);
                else input.value = String(currentView?.doc?.print?.[key] ?? '');
            });
            printGrid.append(labelledField(labelText, input));
            printRefs[key] = input;
        }
        const dpiReadout = node('output', 'canvas-retouch-dpi');
        const pairDownload = button('양면 ZIP', '반대쪽 면까지 양면 ZIP 다운로드', 'canvas-retouch-secondary', () => invoke('downloadPair'));
        printBody.append(printGrid, dpiReadout, pairDownload);
        printDetails.append(printSummary, printBody);

        const finishDetails = node('details', 'canvas-retouch-details canvas-retouch-finish');
        const finishSummary = node('summary', '', '마무리 메모');
        const finishBody = node('div', 'canvas-retouch-details-body');
        const checksList = node('div', 'canvas-retouch-checks');
        const checkRefs = [];
        checks.forEach((labelText, index) => {
            const input = node('input', ''); input.type = 'checkbox'; input.setAttribute('aria-label', labelText);
            input.addEventListener('change', () => invoke('check', index, input.checked));
            const label = node('label', 'canvas-retouch-check');
            label.append(input, node('span', '', labelText));
            checksList.append(label);
            checkRefs.push(input);
        });
        const notes = node('textarea', 'canvas-retouch-notes');
        notes.rows = 3;
        notes.setAttribute('aria-label', '마무리 메모');
        notes.placeholder = '작업 메모를 남겨 주세요.';
        notes.addEventListener('input', () => invoke('notes', notes.value));
        finishBody.append(checksList, labelledField('작업 메모', notes));
        finishDetails.append(finishSummary, finishBody);

        const otherNote = node('p', 'canvas-retouch-other-note', '반대쪽 참고 그림에서 스포이드로 색을 채취할 수 있습니다. 설정은 이 면에만 적용됩니다.');

        content.append(historySection, presetSection, quickDetails, layerSection, settingsSection, toolSection,
            brushDetails, viewSection, printDetails, finishDetails, otherNote);

        const footer = node('footer', 'canvas-retouch-footer');
        const resultLink = node('a', 'canvas-retouch-result-link', 'PNG 받기');
        resultLink.hidden = true;
        resultLink.setAttribute('download', '캔버스 보정.png');
        const downloadButton = button('인쇄 PNG', '인쇄 PNG 다운로드', 'canvas-retouch-secondary', () => invoke('download'));
        const applyButton = button('보정 결과 적용', '보정 결과 적용', 'canvas-retouch-primary', () => invoke('apply'));
        footer.append(resultLink, downloadButton, applyButton);
        root.append(header, body, footer);
        host.append(root);

        const rowRefs = new Map();
        let layerSignature = null;
        let destroyed = false;

        function buildSettings(selected) {
            settings.replaceChildren();
            settingsRefs = null;
            if (!selected) {
                settings.append(node('p', 'canvas-retouch-empty', '보정 레이어를 선택해 주세요.'));
                return;
            }
            const refs = {name: null, opacity: null, opacityOutput: null, params: new Map(), mode: null, color: null, liquifyMode: null, seed: null, maskButtons: {}, maskShow: null, clearShape: null};
            const nameInput = node('input', 'canvas-retouch-control');
            nameInput.type = 'text'; nameInput.maxLength = 80; nameInput.setAttribute('aria-label', '레이어 이름');
            nameInput.addEventListener('input', () => invoke('change', {name: nameInput.value}));
            refs.name = nameInput;
            settings.append(labelledField('레이어 이름', nameInput));

            const opacityWrap = node('label', 'canvas-retouch-range-field');
            const opacityLine = node('span', 'canvas-retouch-range-heading');
            const opacityLabel = node('span', '', '레이어 불투명도');
            const opacityOutput = node('output', 'canvas-retouch-output');
            const opacityRange = node('input', 'canvas-retouch-range');
            opacityRange.type = 'range'; opacityRange.min = '0'; opacityRange.max = '1'; opacityRange.step = '0.01';
            opacityRange.setAttribute('aria-label', '레이어 불투명도');
            opacityRange.addEventListener('input', () => invoke('change', {opacity: Number(opacityRange.value)}));
            opacityLine.append(opacityLabel, opacityOutput); opacityWrap.append(opacityLine, opacityRange);
            settings.append(opacityWrap);
            refs.opacity = opacityRange; refs.opacityOutput = opacityOutput;

            if (selected.type === 'color' || selected.type === 'paint') {
                const mode = node('select', 'canvas-retouch-control');
                mode.setAttribute('aria-label', '합성 모드');
                for (const [value, labelText] of COLOR_MODES) {
                    const option = node('option', '', labelText); option.value = value; mode.append(option);
                }
                mode.addEventListener('change', () => invoke('change', {params: {mode: mode.value}}));
                settings.append(labelledField('합성 모드', mode));
                settings.append(node('p', 'canvas-retouch-hint', '색상 모드는 원본 밝기와 음영을 유지합니다. 일반은 색을 덮어 세부 묘사가 약해질 수 있습니다.'));
                refs.mode = mode;
                if (selected.type === 'color') {
                    const color = node('input', 'canvas-retouch-color-input');
                    color.type = 'color'; color.setAttribute('aria-label', '레이어 색');
                    color.addEventListener('input', () => invoke('change', {params: {color: color.value}}));
                    refs.color = color;
                    settings.append(labelledField('레이어 색', color, 'canvas-retouch-color-field'));
                }
            }

            if (selected.type === 'liquify') {
                const mode = node('select', 'canvas-retouch-control');
                mode.setAttribute('aria-label', '유동화 방식');
                for (const [value, labelText] of LIQUIFY_MODES) {
                    const option = node('option', '', labelText); option.value = value; mode.append(option);
                }
                mode.addEventListener('change', () => invoke('change', {params: {mode: mode.value}}));
                settings.append(labelledField('유동화 방식', mode));
                refs.liquifyMode = mode;
            }

            for (const spec of (Array.isArray(paramsByType[selected.type]) ? paramsByType[selected.type] : [])) {
                if (!spec || !spec.key) continue;
                const wrap = node('label', 'canvas-retouch-range-field');
                const line = node('span', 'canvas-retouch-range-heading');
                const fieldName = node('span', '', spec.label || spec.key);
                const output = node('output', 'canvas-retouch-output');
                const range = node('input', 'canvas-retouch-range');
                range.type = 'range'; range.min = String(spec.min); range.max = String(spec.max); range.step = String(spec.step || 1);
                range.setAttribute('aria-label', spec.label || spec.key);
                range.addEventListener('input', () => invoke('change', {params: {[spec.key]: Number(range.value)}}));
                line.append(fieldName, output); wrap.append(line, range);
                settings.append(wrap);
                refs.params.set(spec.key, {range, output, spec});
            }

            if (selected.type === 'texture') {
                const seed = button('질감 무늬 바꾸기', '질감 무늬 바꾸기', 'canvas-retouch-secondary', () => {
                    invoke('change', {params: {seed: Math.floor(Math.random() * 9999)}});
                });
                refs.seed = seed;
                settings.append(seed);
            }

            const mask = node('section', 'canvas-retouch-mask');
            const maskTitle = selected.type === 'liquify' ? '적용 / 보호 영역' : '적용 영역 · 마스크';
            mask.append(node('h4', 'canvas-retouch-subtitle', maskTitle));
            const maskBaseRow = node('div', 'canvas-retouch-button-row');
            const allMask = button('전체', '전체에 보정 적용', 'canvas-retouch-secondary', () => invoke('mask', 'all'));
            const paintedMask = button('칠한 곳만', '칠한 곳만', 'canvas-retouch-secondary', () => invoke('mask', 'painted'));
            refs.maskButtons.all = allMask; refs.maskButtons.painted = paintedMask;
            maskBaseRow.append(allMask, paintedMask);
            const maskToolRow = node('div', 'canvas-retouch-button-row');
            for (const tool of MASK_TOOLS) {
                const control = button(tool.label, tool.ariaLabel, 'canvas-retouch-secondary', () => invoke('setTool', tool.id));
                refs.maskButtons[tool.id] = control;
                maskToolRow.append(control);
            }
            const maskViewRow = node('div', 'canvas-retouch-button-row');
            const maskShow = button('마스크 보기', '마스크 표시 전환', 'canvas-retouch-secondary', () => invoke('maskShow', !(currentView && currentView.maskShow)));
            const clearShape = button('영역 선택 해제', '선택한 영역 해제', 'canvas-retouch-secondary', () => invoke('mask', 'clearShape'));
            refs.maskShow = maskShow; refs.clearShape = clearShape;
            maskViewRow.append(maskShow, clearShape);
            mask.append(maskBaseRow, maskToolRow, maskViewRow,
                node('p', 'canvas-retouch-hint', '붉은 표시 = 보정 제외 / 유동화 보호 영역'));
            settings.append(mask);
            settingsRefs = refs;
        }

        function updateSettings(view, selected, busy) {
            const nextKey = selected ? String(selected.id) + ':' + String(selected.type) : '';
            if (nextKey !== settingsKey) {
                settingsKey = nextKey;
                buildSettings(selected);
            }
            const refs = settingsRefs;
            if (!refs || !selected) return;
            const params = selected.params || {};
            setValue(refs.name, selected.name || '');
            setValue(refs.opacity, Number.isFinite(Number(selected.opacity)) ? selected.opacity : 1);
            refs.opacityOutput.textContent = Math.round((Number(selected.opacity) || 0) * 100) + '%';
            if (refs.mode) setValue(refs.mode, params.mode || 'normal');
            if (refs.color) setValue(refs.color, params.color || '#ffffff');
            if (refs.liquifyMode) setValue(refs.liquifyMode, params.mode || 'push');
            for (const [key, param] of refs.params) {
                const value = Number(params[key]);
                const shown = Number.isFinite(value) ? value : Number(param.spec.min) || 0;
                setValue(param.range, shown);
                param.output.textContent = String(shown);
                setDisabled(param.range, busy);
            }
            setDisabled(refs.name, busy); setDisabled(refs.opacity, busy);
            if (refs.mode) setDisabled(refs.mode, busy);
            if (refs.color) setDisabled(refs.color, busy);
            if (refs.liquifyMode) setDisabled(refs.liquifyMode, busy);
            if (refs.seed) setDisabled(refs.seed, busy);
            const mask = selected.mask || {};
            refs.maskButtons.all.classList.toggle('is-active', Number(mask.base) === 1 && !mask.shape && !(mask.strokes || []).length);
            refs.maskButtons.painted.classList.toggle('is-active', Number(mask.base) === 0);
            refs.maskButtons.maskAdd.classList.toggle('is-active', view.tool === 'maskAdd');
            refs.maskButtons.maskErase.classList.toggle('is-active', view.tool === 'maskErase');
            refs.maskButtons.maskAdd.setAttribute('aria-pressed', String(view.tool === 'maskAdd'));
            refs.maskButtons.maskErase.setAttribute('aria-pressed', String(view.tool === 'maskErase'));
            refs.maskShow.textContent = view.maskShow ? '마스크 숨기기' : '마스크 보기';
            refs.clearShape.hidden = !mask.shape;
            for (const control of Object.values(refs.maskButtons)) setDisabled(control, busy);
            setDisabled(refs.maskShow, false); setDisabled(refs.clearShape, busy || !mask.shape);
        }

        function getSelectedLayerIds(view, layers, selectedId) {
            const availableIds = new Set(layers.map(layer => String(layer.id)));
            const sourceIds = Array.isArray(view.selectedIds)
                ? view.selectedIds
                : selectedId === null || selectedId === undefined ? [] : [selectedId];
            return new Set(sourceIds.filter(id => id !== null && id !== undefined)
                .map(String).filter(id => availableIds.has(id)));
        }

        function renderLayers(view, layers, selectedId, busy) {
            const ids = layers.map(layer => String(layer.id));
            const signature = ids.join('\u001f');
            const selectedIds = getSelectedLayerIds(view, layers, selectedId);
            if (signature !== layerSignature) {
                layerList.replaceChildren();
                rowRefs.clear();
                layerSignature = signature;
                if (!layers.length) {
                    layerList.append(layerEmpty);
                } else {
                    for (const layer of layers.slice().reverse()) {
                        const row = node('div', 'canvas-retouch-layer-row');
                        row.dataset.layerId = String(layer.id);
                        const visible = button(layer.visible === false ? '○' : '◉', '레이어 표시 전환', 'canvas-retouch-visibility', () => invoke('toggle', layer.id));
                        const select = button('', '레이어 선택', 'canvas-retouch-layer-select', event =>
                            invoke('select', layer.id, {shiftKey: Boolean(event && event.shiftKey)}));
                        const name = node('span', 'canvas-retouch-layer-name');
                        const meta = node('span', 'canvas-retouch-layer-meta');
                        select.append(name, meta); row.append(visible, select); layerList.append(row);
                        rowRefs.set(String(layer.id), {row, visible, select, name, meta, layer});
                    }
                }
            }
            for (const layer of layers) {
                const refs = rowRefs.get(String(layer.id));
                if (!refs) continue;
                refs.layer = layer;
                refs.name.textContent = layer.name || names[layer.type] || layer.type || '보정 레이어';
                refs.meta.textContent = (names[layer.type] || layer.type || '') + ' · ' + Math.round((Number(layer.opacity) || 0) * 100) + '%';
                refs.select.setAttribute('aria-label', (layer.name || names[layer.type] || '보정') + ' 레이어 선택');
                refs.select.title = layer.name || names[layer.type] || '';
                refs.visible.textContent = layer.visible === false ? '○' : '◉';
                refs.visible.setAttribute('aria-label', (layer.name || '보정') + ' 표시 전환');
                refs.visible.setAttribute('aria-pressed', String(layer.visible !== false));
                refs.row.classList.toggle('is-active', String(layer.id) === String(selectedId));
                refs.row.classList.toggle('is-selected', selectedIds.has(String(layer.id)));
                refs.select.setAttribute('aria-pressed', String(selectedIds.has(String(layer.id))));
                refs.visible.disabled = busy;
                refs.select.disabled = busy;
            }
            selectionHint.textContent = selectedIds.size > 1
                ? `보정 ${selectedIds.size}개 선택 · 지우개는 모두에 적용됩니다. 다른 조작은 마지막으로 선택한 보정에 적용됩니다.`
                : 'Shift+클릭으로 여러 보정을 선택합니다.';
            const selectedIndex = layers.findIndex(layer => String(layer.id) === String(selectedId));
            const hasSelection = selectedIndex >= 0;
            setDisabled(moveUp, busy || !hasSelection || selectedIndex >= layers.length - 1);
            setDisabled(moveDown, busy || !hasSelection || selectedIndex <= 0);
            setDisabled(duplicateButton, busy || !hasSelection || layers.length >= 40);
            setDisabled(removeButton, busy || !hasSelection);
            setDisabled(addType, busy || !view.doc);
            setDisabled(addButton, busy || !view.doc || layers.length >= 40);
        }

        function update(view) {
            if (destroyed) return;
            const safeView = view && typeof view === 'object' ? view : {};
            currentView = safeView;
            const docView = safeView.doc || null;
            const hasDoc = Boolean(docView);
            const busy = Boolean(safeView.busy);
            const layers = docView && Array.isArray(docView.layers) ? docView.layers : [];
            const selected = layers.find(layer => String(layer.id) === String(safeView.selectedId)) || null;
            const selectedLayerCount = getSelectedLayerIds(safeView, layers, safeView.selectedId).size;

            updatePresetCategories();
            for (const control of presetCards.values()) control.disabled = busy || !hasDoc;
            for (const control of presetStrengthButtons.values()) control.disabled = busy || !hasDoc;
            updatePresetCapacity();
            updateRecipeControls();

            loading.hidden = hasDoc;
            content.hidden = !hasDoc;
            errorMessage.hidden = !safeView.error;
            statusMessage.hidden = !safeView.message || Boolean(safeView.error);
            errorMessage.textContent = safeView.error
                ? (typeof safeView.error === 'string' ? safeView.error : String(safeView.message || '보정 중 오류가 발생했습니다.'))
                : '';
            statusMessage.textContent = safeView.message && !safeView.error ? String(safeView.message) : '';

            undoButton.disabled = busy || !safeView.canUndo;
            redoButton.disabled = busy || !safeView.canRedo;
            copyButton.disabled = busy || !selected || NO_COPY_TYPES.has(selected.type);
            pasteButton.disabled = busy || !selected || !safeView.hasCopy;
            renderLayers(safeView, layers, safeView.selectedId, busy);
            updateSettings(safeView, selected, busy);
            for (const [control, id] of [[layerEraseButton, 'maskErase'], [layerRestoreButton, 'maskAdd']]) {
                const active = safeView.tool === id;
                control.classList.toggle('is-active', active);
                control.setAttribute('aria-pressed', String(active));
                control.disabled = busy || !selected;
            }

            for (const [id, control] of toolButtons) {
                control.classList.toggle('is-active', safeView.tool === id);
                control.setAttribute('aria-pressed', String(safeView.tool === id));
                control.disabled = busy || !hasDoc;
            }
            if (safeView.tool === 'paint') {
                toolHint.textContent = selected && selected.type === 'paint'
                    ? '색을 직접 칠합니다.'
                    : '선택한 보정의 적용 영역을 칠합니다. 색을 직접 칠하려면 에어브러시를 선택하세요.';
            } else if (safeView.tool === 'maskErase' && selectedLayerCount > 1) {
                toolHint.textContent = `선택한 보정 ${selectedLayerCount}개만 지웁니다. 경계 선명도 0%는 부드럽게, 100%는 또렷하게 지웁니다.`;
            } else {
                toolHint.textContent = TOOL_HELP[safeView.tool] || '캔버스 위에서 선택한 도구를 사용합니다.';
            }
            const isAirbrush = safeView.tool === 'airbrush';
            const isMaskEraser = safeView.tool === 'maskErase';
            brushSummary.textContent = isMaskEraser ? '지우개' : '브러시';
            brushColorLabel.hidden = isMaskEraser;
            if (flowLabel) {
                const flowText = isAirbrush ? '분사량' : isMaskEraser ? '지우는 강도' : '불투명도';
                flowLabel.textContent = flowText;
                brushRefs.flow.range.setAttribute('aria-label', flowText);
            }
            for (const [key, refs] of Object.entries(brushRefs)) {
                const value = safeView.brush && safeView.brush[key];
                if (key === 'opacity') refs.range.parentNode.hidden = !isAirbrush;
                if (key === 'color') {
                    setValue(refs.input, value || '#e6baa4');
                    refs.input.disabled = busy || !hasDoc;
                } else {
                    const shown = Number.isFinite(Number(value)) ? value : ({size: 160, flow: 10, hardness: 30, opacity: 100})[key];
                    setValue(refs.range, shown);
                    refs.output.textContent = String(shown) + refs.unit;
                    refs.range.disabled = busy || !hasDoc;
                }
            }
            if (doc.activeElement !== compareToggle) compareToggle.checked = Boolean(safeView.compare);
            setValue(splitRange, Number.isFinite(Number(safeView.compareSplit)) ? safeView.compareSplit : 50);
            splitOutput.textContent = String(Number.isFinite(Number(safeView.compareSplit)) ? safeView.compareSplit : 50) + '%';
            splitWrap.hidden = !safeView.compare;
            if (doc.activeElement !== guidesToggle) guidesToggle.checked = Boolean(safeView.guides);
            setDisabled(compareToggle, !hasDoc); setDisabled(splitRange, !hasDoc); setDisabled(guidesToggle, !hasDoc);

            const print = docView && docView.print ? docView.print : {};
            for (const [key, input] of Object.entries(printRefs)) {
                setValue(input, print[key] === undefined ? '' : print[key]);
                input.disabled = busy || !hasDoc;
            }
            const width = Number(docView && docView.width);
            const widthCm = Number(print.widthCm);
            const dpi = width > 0 && widthCm > 0 ? width / (widthCm / 2.54) : null;
            dpiReadout.textContent = dpi === null ? '제품 규격을 입력하면 DPI를 표시합니다.' : '가로 기준 ' + dpi.toFixed(1) + ' DPI';
            pairDownload.disabled = busy || !hasDoc || !safeView.otherAvailable;
            otherNote.hidden = !safeView.otherAvailable;

            const checked = Array.isArray(docView && docView.checks) ? docView.checks : [];
            checkRefs.forEach((input, index) => {
                if (doc.activeElement !== input) input.checked = checked.includes(index);
                input.disabled = busy || !hasDoc;
            });
            setValue(notes, docView && docView.notes ? docView.notes : '');
            notes.disabled = busy || !hasDoc;

            applyButton.disabled = busy || !hasDoc;
            downloadButton.disabled = busy || !hasDoc;
            const href = safeView.downloadSrc == null ? '' : String(safeView.downloadSrc);
            const validHref = href.startsWith('/') && !href.startsWith('//') && !/[\r\n]/.test(href);
            resultLink.hidden = !validHref;
            if (validHref) {
                resultLink.href = href;
                const filename = String(docView && docView.name || '캔버스 보정')
                    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80) || '캔버스 보정';
                resultLink.setAttribute('download', filename + '.png');
                resultLink.title = filename + '.png';
            } else {
                resultLink.removeAttribute('href');
            }
        }

        function destroy() {
            if (destroyed) return;
            destroyed = true;
            if (root.parentNode) root.parentNode.removeChild(root);
            rowRefs.clear();
            settingsRefs = null;
            currentView = null;
        }

        return {update, destroy};
    }

    global.CanvasRetouchPanel = {create};
})(typeof window !== 'undefined' ? window : globalThis);
