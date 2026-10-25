/* Selection-local focus settings; the shared source prompt remains unchanged. */
(function (root) {
    'use strict';
    let bodyMap = null, epoch = 0, scheduled = false, timer = null, rendering = 0, linkKey = '';
    let hudExpanded = false, hudSide = 'left', mapEditing = null;
    const metadata = new Map();
    const expandedGroupsBySelection = new WeakMap();
    const settingsOpenBySelection = new WeakMap();
    const promptSectionOpenBySelection = new WeakMap();
    const byId = id => document.getElementById(id);
    const regions = () => root.CanvasDakiRegions;
    const rules = () => root.CanvasDakiPromptRules;
    const link = () => root.CanvasProject?.localLink();
    const catalog = () => regions().listRegions(bodyMap);
    const definition = id => catalog().find(item => item.id === id);
    const label = id => definition(id)?.label || '전체';
    const tagRegion = id => definition(id)?.baseRegion || id;
    const identity = item => item.field + '\u0000' + item.key;
    const node = (tag, className, text) => {
        const value = document.createElement(tag);
        if (className) value.className = className;
        if (text !== undefined) value.textContent = text;
        return value;
    };
    function button(text, action, className = 'secondary') {
        const value = node('button', className, text);
        value.type = 'button'; value.onclick = action; return value;
    }
    function context() {
        const value = link();
        return value && currentCanvasWidth > 0 && currentCanvasHeight > 0
            ? {projectId: value.projectId, canvasId: value.canvasId, side: value.side,
                layers: canvasLayers, epoch} : null;
    }
    function current(captured, selection) {
        const value = context();
        return value && captured && captured.epoch === epoch && value.layers === captured.layers
            && value.projectId === captured.projectId && value.canvasId === captured.canvasId
            && value.side === captured.side
            && (!selection || findCanvasLayer(selection.id)?.layer === selection);
    }
    function selected() {
        const modal = byId('clipPromptModalOverlay');
        const id = modal?.classList.contains('open') ? activeClipPromptId : activeLayerId;
        const layer = findCanvasLayer(id)?.layer;
        if (layer?.type === 'selection') return layer;
        return layer ? findSelectionParentForLayerId(layer.id) : null;
    }
    function settings(selection) {
        if (!selection.dakiFocus || typeof selection.dakiFocus !== 'object'
            || Array.isArray(selection.dakiFocus)) selection.dakiFocus = {};
        const state = selection.dakiFocus;
        if (!Array.isArray(state.keepKeys)) state.keepKeys = [];
        if (!state.enabledGroups || typeof state.enabledGroups !== 'object'
            || Array.isArray(state.enabledGroups)) state.enabledGroups = {};
        if (!Array.isArray(state.groups)) state.groups = [];
        return state;
    }
    function expandedGroups(selection) {
        let regions = expandedGroupsBySelection.get(selection);
        if (!regions) { regions = new Set(); expandedGroupsBySelection.set(selection, regions); }
        return regions;
    }
    function autoItemsId(selection, region, index) {
        const encode = value => Array.from(String(value ?? ''), char => char.codePointAt(0).toString(16)).join('_') || 'empty';
        return `canvas-daki-auto-items-${encode(selection.id)}-${encode(region)}-${index}`;
    }
    function focus(selection, captured = context()) {
        return regions().resolve(selection, currentCanvasWidth, currentCanvasHeight,
            bodyMap, captured?.side || 'front');
    }
    function selectionLabel(selection) {
        if (!context() || selection?.type !== 'selection') return '선택 영역';
        return focus(selection).regions.map(label).join(' / ');
    }
    function syncSelectionLabels() {
        byId('layerList')?.querySelectorAll?.('.layer-selection-region').forEach(element => {
            const selection = findCanvasLayer(Number(element.dataset.selectionId))?.layer;
            const text = selectionLabel(selection);
            element.textContent = text;
            element.title = text;
        });
    }
    function mutate(selection, change) {
        change(settings(selection));
        settings(selection).revision = (Number(settings(selection).revision) || 0) + 1;
        saveCanvasState(); refresh();
    }
    function source(selection) {
        if (byId('clipPromptModalOverlay')?.classList.contains('open')
            && findSelectionParentForLayerId(activeClipPromptId) === selection) {
            return {basePrompt: getClipPromptEditorValue('base'),
                charPrompts: getClipCharPromptValues(), negativePrompt: getClipPromptEditorValue('negative')};
        }
        const clip = getEditableClipForSelection(selection);
        return clip ? buildEffectiveClipPromptInfo(clip) : getSharedSelectionClipPromptInfo();
    }
    function protectedTokens(info) {
        const controller = typeof getCanvasStyleLink === 'function' ? getCanvasStyleLink() : null;
        if (!controller) return {};
        const tokens = parseClipPromptTokens(info.basePrompt).map((token, index) => ({token, index}));
        const styleText = controller.groupParts('base', tokens).filter(part => part.type === 'style')
            .flatMap(part => part.tokens || []).join(', ');
        const inspected = rules().inspect(styleText);
        // A selected style can span only part of a weighted scope. Preserve the base
        // field conservatively when that scope cannot be parsed independently.
        return {base: inspected.valid ? inspected.tokens : rules().inspect(info.basePrompt).tokens};
    }
    async function classifications(info) {
        const tokens = [...new Set([info.basePrompt, ...(info.charPrompts || [])]
            .flatMap(text => rules().inspect(text || '').tokens).filter(token => token.length <= 500))];
        const missing = tokens.filter(token => !metadata.has(token));
        while (missing.length) {
            const batch = []; let length = 0;
            while (missing.length && batch.length < 2000 && length + missing[0].length <= 50000) {
                const token = missing.shift(); batch.push(token); length += token.length;
            }
            const response = await fetch('/api/daki/tag-catalog/classify', {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tokens: batch})
            });
            const data = await response.json();
            if (!response.ok || data.status !== 'success' || !Array.isArray(data.items)
                || data.items.length !== batch.length) throw new Error(data.message || '부위별 태그 분류를 불러오지 못했습니다.');
            data.items.forEach((item, index) => {
                if (item.token !== batch[index]) throw new Error('태그 분류 응답이 일치하지 않습니다.');
                metadata.set(item.token, item);
            });
        }
        return tokens.map(token => metadata.get(token));
    }
    function candidates(info, records, resolved, protectedValues) {
        // Keep a tag if any included body region uses it.
        const lists = resolved.regions.map(region => rules().candidates(info, records, tagRegion(region), protectedValues));
        const sets = lists.map(list => new Set(list.flatMap(group => group.items.map(identity))));
        return (lists[0] || []).map(group => ({...group,
            items: group.items.filter(item => sets.every(set => set.has(identity(item))))
        })).filter(group => group.items.length);
    }
    function excluded(state) {
        if (!state || state.filterEnabled === false) return {};
        const kept = new Set(Array.isArray(state.keepKeys) ? state.keepKeys : []), result = {};
        const enabledGroups = state.enabledGroups && typeof state.enabledGroups === 'object'
            ? state.enabledGroups : {};
        for (const group of Array.isArray(state.groups) ? state.groups : []) {
            if (!group || enabledGroups[group.region]) continue;
            for (const item of group.items || []) {
                if (!kept.has(identity(item))) (result[item.field] ||= []).push(item.token);
            }
        }
        return result;
    }
    function excludedTokens(field) {
        if (!context() || !byId('clipPromptModalOverlay')?.classList.contains('open')) return [];
        const selection = selected();
        if (!selection || typeof field !== 'string' || field === 'negative') return [];
        const match = field === 'base' ? null : /^char-(\d+)$/.exec(field);
        if (field !== 'base' && !match) return [];
        const info = source(selection);
        const index = match ? Number(match[1]) : -1;
        if (match && (!Array.isArray(info.charPrompts) || index >= info.charPrompts.length)) return [];
        const fullText = field === 'base' ? info.basePrompt : info.charPrompts[index];
        if (typeof fullText !== 'string' || !rules().inspect(fullText).valid) return [];
        return excluded(selection.dakiFocus)[field] || [];
    }
    function focusPrompt(state, resolved) {
        if (state.usePrompt === false || resolved.primary === 'whole') return '';
        return typeof state.promptOverride === 'string' ? state.promptOverride.trim()
            : definition(resolved.primary)?.prompt || '';
    }
    function apply(info, state, resolved) {
        const exclusions = excluded(state);
        const prompt = rules().filter(info.basePrompt || '', exclusions.base || []);
        const added = focusPrompt(state, resolved);
        const charPrompts = (info.charPrompts || []).map((text, index) =>
            rules().filter(text, exclusions['char-' + index] || []));
        return {...info, basePrompt: [prompt, added].filter(Boolean).join(', '), charPrompts,
            charPrompt: buildLegacyCharPromptText(charPrompts)};
    }
    function previewText(info) {
        return ['Base\n' + info.basePrompt,
            ...info.charPrompts.map((text, index) => '캐릭터 ' + (index + 1) + '\n' + text)].join('\n\n');
    }
    async function classifySelection(selection, info, captured, resolved, isCurrent = () => true) {
        const state = settings(selection), revision = state.revision;
        const protectedValues = protectedTokens(info);
        const records = state.filterEnabled === false || resolved.regions.some(id => tagRegion(id) === 'whole')
            ? [] : await classifications(info);
        if (!isCurrent() || !current(captured, selection) || settings(selection) !== state || state.revision !== revision) return false;
        const groups = state.filterEnabled === false ? state.groups : candidates(info, records, resolved, protectedValues);
        if (JSON.stringify(groups) !== JSON.stringify(state.groups)) {
            state.groups = groups; saveCanvasState();
        }
        return true;
    }
    async function prepare(clip, info) {
        const captured = context();
        if (!captured) return {promptInfo: info, folderRegion: null};
        const selection = findSelectionParentForLayerId(clip.id);
        if (!selection) return {promptInfo: info, folderRegion: null};
        const resolved = focus(selection, captured);
        if (!await classifySelection(selection, info, captured, resolved)) {
            throw new Error('부위 설정 또는 캔버스가 바뀌었습니다. 현재 설정으로 다시 생성해 주세요.');
        }
        const region = definition(resolved.primary);
        return {promptInfo: apply(info, settings(selection), resolved), folderRegion: resolved.primary,
            ...(region?.custom ? {folderDefinition: {...region}} : {}),
            regions: [...resolved.regions], addedPrompt: focusPrompt(settings(selection), resolved)};
    }
    function field(parent, text, input) {
        const wrapper = node('label', 'canvas-daki-focus-field'); wrapper.append(node('span', '', text), input);
        parent.appendChild(wrapper); return input;
    }
    function checkbox(parent, text, checked, onChange) {
        const input = node('input'); input.type = 'checkbox'; input.checked = checked;
        input.onchange = () => onChange(input.checked); field(parent, text, input); return input;
    }
    function regionSelect(selection, resolved) {
        const state = settings(selection);
        const choices = node('select'); choices.setAttribute('aria-label', '선택 영역의 부위');
        const autoRegion = regions().resolve({...selection, dakiFocus: {mode: 'auto'}},
            currentCanvasWidth, currentCanvasHeight, bodyMap, context()?.side || 'front');
        const auto = node('option', '', '자동 · ' + label(autoRegion.primary)); auto.value = 'auto'; choices.appendChild(auto);
        for (const region of catalog()) {
            const option = node('option', '', region.label); option.value = region.id; choices.appendChild(option);
        }
        choices.value = state.mode === 'manual' ? resolved.primary : 'auto';
        choices.title = state.mode === 'manual' ? label(resolved.primary) : auto.textContent;
        choices.onchange = () => mutate(selection, value => {
            value.mode = choices.value === 'auto' ? 'auto' : 'manual';
            value.regions = choices.value === 'auto' ? [] : [choices.value];
        });
        return choices;
    }
    function selectionControls(host, selection, captured) {
        const rootHost = host;
        const state = settings(selection), resolved = focus(selection, captured);
        const choices = regionSelect(selection, resolved);
        field(host, '선택 부위', choices);
        host.appendChild(node('p', 'canvas-daki-focus-caption',
            `${selection.name} · ${resolved.regions.map(label).join(' / ')}`));
        const settingDetails = node('details', 'canvas-daki-focus-settings');
        settingDetails.open = settingsOpenBySelection.get(selection) === true;
        settingDetails.ontoggle = () => settingsOpenBySelection.set(selection, settingDetails.open);
        settingDetails.appendChild(node('summary', '', '부위·포커스 세부 설정'));
        const extra = node('details'); extra.appendChild(node('summary', '', '함께 포함할 부위'));
        const extraList = node('div', 'canvas-daki-focus-extra'); extra.appendChild(extraList);
        for (const region of catalog().filter(value => value.id !== 'whole')) {
            checkbox(extraList, region.label, resolved.regions.includes(region.id), checked => mutate(selection, value => {
                const next = new Set(resolved.regions.filter(id => id !== 'whole'));
                if (checked) next.add(region.id); else next.delete(region.id);
                value.mode = 'manual'; value.regions = next.size ? [...next] : ['whole'];
            }));
        }
        settingDetails.appendChild(extra);
        checkbox(settingDetails, '부위 밖 태그 자동 제외', state.filterEnabled !== false,
            value => mutate(selection, next => { next.filterEnabled = value; }));
        checkbox(settingDetails, '포커스 문구 추가', state.usePrompt !== false,
            value => mutate(selection, next => { next.usePrompt = value; }));
        const text = node('textarea'); text.rows = 2; text.maxLength = 2000;
        text.value = focusPrompt({...state, usePrompt: true}, resolved);
        text.disabled = state.usePrompt === false || resolved.primary === 'whole';
        text.setAttribute('aria-label', '추가할 포커스 프롬프트');
        const resetPrompt = button('부위 기본 문구', () =>
            mutate(selection, value => { delete value.promptOverride; }));
        resetPrompt.disabled = typeof state.promptOverride !== 'string';
        text.oninput = () => {
            const value = settings(selection);
            value.promptOverride = text.value;
            value.revision = (Number(value.revision) || 0) + 1;
            resetPrompt.disabled = false;
            saveCanvasState();
            const preview = rootHost.querySelector('.canvas-daki-focus-preview');
            if (preview) preview.textContent = previewText(apply(source(selection), value, focus(selection)));
        };
        field(settingDetails, '추가할 문구', text);
        settingDetails.appendChild(resetPrompt);
        settingDetails.appendChild(node('p', 'canvas-daki-focus-caption', '원본 프롬프트는 유지되며 이 선택 영역에만 적용됩니다.'));
        host.appendChild(settingDetails);
        return resolved;
    }
    function drawGroups(host, selection, info, resolved) {
        const state = settings(selection), kept = new Set(state.keepKeys), expanded = expandedGroups(selection);
        for (const [index, group] of state.groups.entries()) {
            const wrapper = node('div', 'clip-control-group canvas-daki-auto-group');
            const isEnabled = state.filterEnabled === false || Boolean(state.enabledGroups[group.region]);
            wrapper.classList.toggle('off', !isEnabled);
            const header = node('div', 'clip-control-group-header');
            const items = node('div', 'canvas-daki-auto-items');
            items.id = autoItemsId(selection, group.region, index);
            items.hidden = !expanded.has(group.region);
            const expand = button('', () => {
                const nextExpanded = !expanded.has(group.region);
                if (nextExpanded) expanded.add(group.region); else expanded.delete(group.region);
                items.hidden = !nextExpanded;
                expand.setAttribute('aria-expanded', String(nextExpanded));
                expand.setAttribute('aria-label', group.name + ' 태그 ' + (nextExpanded ? '접기' : '펼치기'));
                chevron.textContent = nextExpanded ? '⌃' : '⌄';
            }, 'secondary canvas-daki-auto-expand');
            expand.append(node('span', 'canvas-daki-auto-name', group.name),
                node('span', 'canvas-daki-auto-count', group.items.length + '개'));
            const chevron = node('span', 'canvas-daki-auto-chevron', expanded.has(group.region) ? '⌃' : '⌄');
            expand.appendChild(chevron);
            expand.setAttribute('aria-expanded', String(expanded.has(group.region)));
            expand.setAttribute('aria-controls', items.id);
            expand.setAttribute('aria-label', group.name + ' 태그 ' + (expanded.has(group.region) ? '접기' : '펼치기'));
            header.appendChild(expand);
            const toggle = button(isEnabled ? 'ON' : 'OFF', () => mutate(selection, next => {
                next.enabledGroups[group.region] = !Boolean(next.enabledGroups[group.region]);
            }), 'clip-control-toggle-btn' + (isEnabled ? ' on' : ''));
            toggle.disabled = state.filterEnabled === false;
            toggle.title = state.filterEnabled === false
                ? '자동 제외가 꺼져 있어 항상 포함됩니다. 세부 설정에서 자동 제외를 켜면 이 그룹을 조절할 수 있습니다.'
                : group.name + ' 태그를 프롬프트에 ' + (isEnabled ? '포함합니다.' : '포함하지 않습니다.');
            toggle.setAttribute('aria-label', group.name + ' 태그 프롬프트 포함');
            toggle.setAttribute('aria-pressed', String(isEnabled));
            header.appendChild(toggle);
            header.appendChild(node('span', 'canvas-daki-auto-state', state.filterEnabled === false
                ? '자동 제외 꺼짐 · 항상 사용' : isEnabled ? '사용 중' : '선택 부위 밖 · 제외'));
            wrapper.appendChild(header);
            for (const item of group.items) {
                const restored = kept.has(identity(item));
                const excludedItem = !isEnabled && !restored;
                const chip = node('span', 'clip-control-chip' + (excludedItem ? ' canvas-daki-excluded' : '')
                    + (restored ? ' canvas-daki-kept' : ''));
                chip.append(node('strong', '', item.field === 'base' ? 'BASE' : 'CHAR ' + (Number(item.field.slice(5)) + 1)),
                    node('span', '', item.token));
                const remove = button(restored ? '↩' : '×', () => mutate(selection, next => {
                    const keys = new Set(next.keepKeys);
                    if (restored) keys.delete(identity(item)); else keys.add(identity(item));
                    next.keepKeys = [...keys];
                }), 'clip-control-chip-remove');
                remove.title = restored ? '자동 제외 그룹으로 되돌리기' : '그룹에서 빼고 사용하기';
                remove.setAttribute('aria-label', item.token + ' ' + remove.title);
                if (restored) chip.appendChild(node('span', 'canvas-daki-keep-indicator', '사용'));
                chip.appendChild(remove); items.appendChild(chip);
            }
            wrapper.appendChild(items); host.appendChild(wrapper);
        }
        if (!state.groups.length) host.appendChild(node('p', 'canvas-daki-focus-caption', '자동으로 제외할 부위 태그가 없습니다.'));
        const malformed = [info.basePrompt, ...(info.charPrompts || [])].some(text => !rules().inspect(text || '').valid);
        if (malformed) host.appendChild(node('p', 'canvas-daki-focus-caption', '해석할 수 없는 가중치 문법이 있는 프롬프트는 자동으로 제외하지 않습니다.'));
        const preview = node('details'); preview.appendChild(node('summary', '', '부위 적용 프롬프트 미리 보기'));
        const effective = apply(info, state, resolved);
        preview.appendChild(node('pre', 'canvas-daki-focus-preview', previewText(effective)));
        host.appendChild(preview);
    }
    function renderHud(host, selection, captured) {
        host.replaceChildren();
        host.dataset.side = hudSide;
        const resolved = selection ? focus(selection, captured) : null;
        const summary = resolved ? resolved.regions.map(label).join(' / ') : '부위 지도';
        const toggle = button('', () => { hudExpanded = !hudExpanded; refresh(); }, 'secondary canvas-daki-hud-toggle');
        toggle.append(node('span', 'canvas-daki-hud-label', summary), node('span', '', hudExpanded ? '⌃' : '⌄'));
        toggle.title = selection ? `${selection.name} · ${summary} · ${settings(selection).mode === 'manual' ? '직접 지정' : '자동 판정'}` : '부위 지도 열기';
        toggle.setAttribute('aria-label', '부위 설정 ' + (hudExpanded ? '접기' : '펼치기') + ' · ' + summary);
        toggle.setAttribute('aria-expanded', String(hudExpanded));
        toggle.setAttribute('aria-controls', 'canvasDakiHudControls');
        const header = node('div', 'canvas-daki-hud-header');
        const move = button(hudSide === 'left' ? '→' : '←', () => {
            hudSide = hudSide === 'left' ? 'right' : 'left'; refresh();
        }, 'secondary canvas-daki-hud-move');
        move.title = hudSide === 'left' ? '오른쪽 위로 이동' : '왼쪽 위로 이동';
        move.setAttribute('aria-label', '부위 표시를 ' + (hudSide === 'left' ? '오른쪽' : '왼쪽') + ' 위로 이동');
        header.append(toggle, move); host.appendChild(header);
        const controls = node('div', 'canvas-daki-hud-controls');
        controls.id = 'canvasDakiHudControls'; controls.hidden = !hudExpanded;
        if (selection) controls.appendChild(regionSelect(selection, resolved));
        const mapButton = button('지도 편집', editMap);
        mapButton.setAttribute('aria-label', '부위 지도 편집'); controls.appendChild(mapButton);
        const clip = selection && getEditableClipForSelection(selection);
        if (clip) controls.appendChild(button('프롬프트', () => openClipPromptModal(clip.id)));
        host.appendChild(controls);
    }
    async function render() {
        syncSelectionLabels();
        syncEditor();
        const captured = context(), hud = byId('canvasDakiFocus'), modal = byId('canvasDakiPromptFocus');
        if (!hud || !modal || !regions() || !rules()) return;
        const version = ++rendering;
        hud.hidden = modal.hidden = !captured || Boolean(mapEditing);
        if (!captured || mapEditing) return;
        modal.replaceChildren();
        const selection = selected();
        renderHud(hud, selection, captured);
        modal.hidden = !byId('clipPromptModalOverlay')?.classList.contains('open') || !selection;
        if (modal.hidden) return;
        const host = modal;
        const section = node('details', 'canvas-daki-prompt-section');
        section.open = promptSectionOpenBySelection.has(selection)
            ? promptSectionOpenBySelection.get(selection) : true;
        section.ontoggle = () => promptSectionOpenBySelection.set(selection, section.open);
        section.appendChild(node('summary', '', '부위별 자동 제어'));
        const sectionBody = node('div', 'canvas-daki-prompt-section-body');
        section.appendChild(sectionBody);
        host.appendChild(section);
        const resolved = selectionControls(sectionBody, selection, captured);
        const groupsHost = node('div', 'canvas-daki-focus-groups'); sectionBody.appendChild(groupsHost);
        const info = source(selection);
        groupsHost.appendChild(node('p', 'canvas-daki-focus-caption', '부위별 태그를 확인하는 중…'));
        try {
            if (!await classifySelection(selection, info, captured, resolved, () => version === rendering)) return;
            groupsHost.replaceChildren(); drawGroups(groupsHost, selection, info, resolved);
            if (typeof getClipPromptFields === 'function' && typeof renderClipPromptTokens === 'function') {
                for (const field of getClipPromptFields()) renderClipPromptTokens(field.key);
            }
        } catch (error) {
            if (version !== rendering || !current(captured, selection)) return;
            groupsHost.replaceChildren(node('p', 'canvas-daki-focus-error', error.message), button('다시 확인', refresh));
        }
    }
    function refresh() {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; render(); });
    }
    function promptChanged() { clearTimeout(timer); timer = setTimeout(refresh, 180); }
    function setEditing(value) {
        mapEditing = value;
        document.body?.classList.toggle('canvas-daki-map-editing', Boolean(value));
        const panel = byId('canvasDakiMapPanel');
        if (panel) panel.hidden = !value;
        refresh();
    }
    function syncEditor() {
        if (!mapEditing) return;
        if (!current(mapEditing) || mapEditing.width !== currentCanvasWidth || mapEditing.height !== currentCanvasHeight) {
            root.CanvasDakiMapEditor.close();
            return;
        }
        root.CanvasDakiMapEditor.sync?.();
    }
    function zoomMap(direction) {
        canvasZoom = clampZoom(canvasZoom * (direction > 0 ? 1.25 : 0.8), CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
    }
    function focusMapRect(rect) {
        if (!rect) return;
        const workspace = document.querySelector('.canvas-workspace');
        const surface = byId('canvasSurface');
        if (!workspace || !surface) return;
        const targetScale = Math.min(Math.max(1, workspace.clientWidth - 96) / (rect.width * currentCanvasWidth),
            Math.max(1, workspace.clientHeight - 96) / (rect.height * currentCanvasHeight));
        canvasZoom = clampZoom(targetScale / getCanvasFitScale(currentCanvasWidth, currentCanvasHeight), CANVAS_ZOOM_MIN, CANVAS_ZOOM_MAX);
        canvasPanOffsetX = canvasPanOffsetY = 0;
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
        requestAnimationFrame(() => {
            if (!mapEditing) return;
            const image = surface.getBoundingClientRect(), view = workspace.getBoundingClientRect();
            workspace.scrollLeft += image.left + (rect.x + rect.width / 2) * image.width - view.left - workspace.clientWidth / 2;
            workspace.scrollTop += image.top + (rect.y + rect.height / 2) * image.height - view.top - workspace.clientHeight / 2;
        });
    }
    function editMap() {
        const captured = context(); if (!captured || mapEditing) return;
        const selection = selected();
        const region = selection ? focus(selection, captured).primary : undefined;
        try {
            const panelHost = byId('canvasDakiMapPanel'), canvasSurface = byId('canvasSurface'), overlayHost = byId('canvasStage');
            if (!panelHost || !canvasSurface || !overlayHost) throw new Error('캔버스 편집 영역을 찾을 수 없습니다.');
            setEditing({...captured, width: currentCanvasWidth, height: currentCanvasHeight});
            root.CanvasDakiMapEditor.open({map: regions().normalizeMap(bodyMap), side: captured.side, region,
                width: currentCanvasWidth, height: currentCanvasHeight, panelHost, canvasSurface, overlayHost,
                onZoom: zoomMap, onFocus: focusMapRect, onWheel: event => handleCanvasWheelZoom(event),
                onSave(map) {
                    if (!current(captured) || !mapEditing
                        || mapEditing.width !== currentCanvasWidth || mapEditing.height !== currentCanvasHeight) return;
                    bodyMap = regions().normalizeMap(map);
                    for (const selection of getAllSelectionLayers()) {
                        if (selection.dakiFocus) selection.dakiFocus.revision = (Number(selection.dakiFocus.revision) || 0) + 1;
                    }
                    saveCanvasState(); refresh();
                }, onClose: () => setEditing(null)});
        } catch (error) {
            root.CanvasDakiMapEditor?.close(); setEditing(null);
            root.showToast?.('부위 지도를 열지 못했습니다: ' + error.message);
        }
    }
    root.CanvasDakiFocus = {
        refresh, promptChanged, prepare, editMap, syncEditor, excludedTokens, selectionLabel,
        linkChanged() {
            const value = link();
            const key = value ? JSON.stringify([value.projectId, value.canvasId, value.side]) : '';
            if (key !== linkKey) { linkKey = key; refresh(); }
        },
        snapshot: () => bodyMap ? regions().normalizeMap(bodyMap) : undefined,
        restore(value) {
            if (mapEditing) root.CanvasDakiMapEditor.close();
            epoch++; rendering++; bodyMap = value ? regions().normalizeMap(value) : null; refresh();
        },
        selectionChanged(selection) {
            if (context() && selection?.type === 'selection') {
                const state = settings(selection); state.revision = (Number(state.revision) || 0) + 1;
                refresh();
            }
        },
        resultFolder(selection, prepared, makeId) {
            const region = prepared ? prepared.folderRegion : context() && focus(selection).primary;
            const map = prepared?.folderDefinition ? {customRegions: [prepared.folderDefinition]} : bodyMap;
            return region ? regions().ensureResultFolder(selection, region, makeId, map) : null;
        }
    };
    document.addEventListener('DOMContentLoaded', refresh);
})(window);
