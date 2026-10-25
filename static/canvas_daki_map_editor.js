(function attachCanvasDakiMapEditor(root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasDakiMapEditor = api;
})(typeof window !== 'undefined' ? window : globalThis, function createCanvasDakiMapEditor(root) {
    'use strict';

    const MAX_RECTS = 8;
    const MIN_SIZE = 0.005;
    const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
    let activeSession = null;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function getRegionsApi() {
        const api = root.CanvasDakiRegions || (typeof globalThis !== 'undefined' && globalThis.CanvasDakiRegions);
        if (!api || !Array.isArray(api.REGIONS) || typeof api.defaultMap !== 'function'
            || typeof api.normalizeMap !== 'function') {
            throw new Error('CanvasDakiRegions must be loaded before opening the body-map editor.');
        }
        return api;
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function roundNormalized(value) {
        return Math.round(value * 1000000) / 1000000;
    }

    function roundedPercent(value) {
        return (value * 100).toFixed(1).replace(/\.0$/, '');
    }

    function open(options = {}) {
        const doc = root.document || globalThis.document;
        if (!doc || !doc.body) throw new Error('A document body is required to open the body-map editor.');
        const inline = Boolean(options.panelHost && options.canvasSurface && options.overlayHost);
        let opener = doc.activeElement;
        if (activeSession) {
            opener = activeSession.opener || opener;
            finish(activeSession, false);
        }

        const regionsApi = getRegionsApi();
        const regions = listRegions(regionsApi, options.map).filter(region => region && region.id !== 'whole');
        const source = regionsApi.normalizeMap(clone(options.map || regionsApi.defaultMap()));
        const map = clone(source || regionsApi.defaultMap());
        for (const side of ['front', 'back']) {
            if (!map[side] || typeof map[side] !== 'object' || Array.isArray(map[side])) map[side] = {};
            for (const region of regions) {
                if (!Array.isArray(map[side][region.id])) map[side][region.id] = [];
            }
        }

        const dialog = doc.createElement(inline ? 'section' : 'dialog');
        dialog.className = inline ? 'canvas-daki-map-editor canvas-daki-map-inline' : 'canvas-daki-map-dialog';
        dialog.setAttribute('aria-labelledby', 'canvas-daki-map-title');
        if (inline) dialog.setAttribute('aria-label', '부위 지도 편집');
        else dialog.setAttribute('aria-modal', 'true');
        const header = make(doc, 'header', 'canvas-daki-map-header');
        const title = make(doc, 'h2', '', '부위 지도 편집');
        title.id = 'canvas-daki-map-title';
        const closeButton = button(doc, '닫기', 'canvas-daki-map-close');
        closeButton.setAttribute('aria-label', '부위 지도 편집 닫기');
        header.append(title, closeButton);

        const body = make(doc, 'div', inline ? 'canvas-daki-map-inline-body' : 'canvas-daki-map-body');
        const previewSection = inline ? null : make(doc, 'section', 'canvas-daki-map-preview');
        const zoomToolbar = make(doc, 'div', 'canvas-daki-map-zoom-toolbar');
        const zoomOutButton = button(doc, '−', 'canvas-daki-map-zoom-out');
        zoomOutButton.setAttribute('aria-label', '축소');
        const zoomSelect = inline ? null : doc.createElement('select');
        if (zoomSelect) {
            zoomSelect.className = 'canvas-daki-map-zoom-select';
            zoomSelect.setAttribute('aria-label', '지도 확대 배율');
            zoomSelect.dataset.role = 'zoom';
            for (const [value, label] of [['1', '화면 맞춤'], ['1.5', '150%'], ['2', '200%'], ['3', '300%'], ['4', '400%']]) {
                addOption(doc, zoomSelect, value, label);
            }
        }
        const zoomInButton = button(doc, '+', 'canvas-daki-map-zoom-in');
        zoomInButton.setAttribute('aria-label', '확대');
        const focusSelectionButton = button(doc, '선택 부위 보기', 'canvas-daki-map-focus-selection');
        zoomToolbar.append(zoomOutButton);
        if (zoomSelect) zoomToolbar.append(zoomSelect);
        zoomToolbar.append(zoomInButton, focusSelectionButton);
        const stage = inline ? options.canvasSurface : make(doc, 'div', 'canvas-daki-map-stage');
        const space = inline ? null : make(doc, 'div', 'canvas-daki-map-space');
        const frame = inline ? options.canvasSurface : make(doc, 'div', 'canvas-daki-map-frame');
        const image = inline ? null : doc.createElement('img');
        const overlay = make(doc, 'div', inline ? 'canvas-daki-map-overlays canvas-daki-map-inline-overlay' : 'canvas-daki-map-overlays');
        if (!inline) {
            stage.setAttribute('aria-label', '부위 영역 미리보기');
            image.className = 'canvas-daki-map-image';
            image.alt = '현재 캔버스 부위 지도';
            image.draggable = false;
            if (typeof options.preview === 'string') image.src = options.preview;
            frame.append(image, overlay);
            space.append(frame);
            stage.append(space);
            previewSection.append(zoomToolbar, stage);
        } else {
            zoomOutButton.setAttribute('aria-label', '축소');
            zoomInButton.setAttribute('aria-label', '확대');
            body.append(zoomToolbar);
        }

        const controls = make(doc, 'section', 'canvas-daki-map-controls');
        const sideSelect = labeledSelect(doc, controls, '면', 'side');
        addOption(doc, sideSelect.select, 'front', '앞면');
        addOption(doc, sideSelect.select, 'back', '뒷면');
        if (inline) sideSelect.select.disabled = true;
        const partSelect = labeledSelect(doc, controls, '부위', 'part');
        regions.forEach(region => addRegionOption(doc, partSelect.select, region));
        const customRegionButton = button(doc, '+ 부위 추가', 'canvas-daki-map-add-custom');
        const customRegionForm = make(doc, 'form', 'canvas-daki-map-custom-form');
        customRegionForm.hidden = true;
        const customLabel = labeledTextInput(doc, customRegionForm, '새 부위 이름', 'custom-label', 60, '예: 허벅지, 종아리');
        const customBase = labeledSelect(doc, customRegionForm, '태그 기준 부위', 'custom-base');
        regionsApi.REGIONS.filter(region => region && region.id).forEach(region => {
            addOption(doc, customBase.select, region.id, region.id === 'whole' ? '자동 제외 안 함' : (region.label || region.id));
        });
        const customPrompt = labeledTextarea(doc, customRegionForm, '포커스 문구 (선택)', 'custom-prompt', 2000, 2, '예: close-up of the thighs');
        const customHelp = make(doc, 'p', 'canvas-daki-map-custom-help', '태그 제외는 선택한 기준 부위를 따릅니다.');
        const customError = make(doc, 'p', 'canvas-daki-map-custom-error', '');
        customError.setAttribute('role', 'alert');
        const customActions = make(doc, 'div', 'canvas-daki-map-actions');
        const customSubmit = button(doc, '추가', 'canvas-daki-map-custom-submit');
        customSubmit.type = 'submit';
        const customCancel = button(doc, '추가 취소', 'canvas-daki-map-custom-cancel');
        customActions.append(customSubmit, customCancel);
        customRegionForm.append(customHelp, customError, customActions);
        const rectSelect = labeledSelect(doc, controls, '영역', 'rect');
        const actionRow = make(doc, 'div', 'canvas-daki-map-actions');
        const addButton = button(doc, '영역 추가', 'canvas-daki-map-add');
        const removeButton = button(doc, '영역 삭제', 'canvas-daki-map-remove');
        actionRow.append(addButton, removeButton);

        const numberGrid = make(doc, 'div', 'canvas-daki-map-number-grid');
        const numberInputs = {};
        for (const [key, label] of [['x', 'X (%)'], ['y', 'Y (%)'], ['width', '너비 (%)'], ['height', '높이 (%)']]) {
            const field = labeledNumber(doc, numberGrid, label, key);
            numberInputs[key] = field.input;
        }
        const help = make(doc, 'p', 'canvas-daki-map-help', 'X/Y/너비/높이는 그림 크기의 0~100%입니다. 기본 위치를 그림에 맞게 이동하거나 모서리를 끌어 크기를 바꾸세요.');
        const resetButton = button(doc, '현재 부위 기본값', 'canvas-daki-map-reset');
        const note = make(doc, 'p', 'canvas-daki-map-note', '기본값은 선택한 면과 부위에만 적용됩니다.');
        const emptyRectsMessage = make(doc, 'p', 'canvas-daki-map-empty', '이 부위에 영역을 추가해 주세요.');
        controls.append(sideSelect.wrapper, partSelect.wrapper, customRegionButton, customRegionForm,
            emptyRectsMessage, rectSelect.wrapper, actionRow, numberGrid, help, resetButton, note);
        if (inline) body.append(controls);
        else body.append(previewSection, controls);

        const footer = make(doc, 'footer', 'canvas-daki-map-footer');
        const cancelButton = button(doc, '취소', 'canvas-daki-map-cancel');
        const applyButton = button(doc, '적용', 'canvas-daki-map-apply');
        footer.append(cancelButton, applyButton);
        dialog.append(header, body, footer);

        const side = options.side === 'back' ? 'back' : 'front';
        const requestedPart = typeof options.region === 'string' ? options.region : '';
        const initialPart = regions.some(region => region.id === requestedPart)
            ? requestedPart : (regions[0] && regions[0].id);
        const session = {
            doc, dialog, opener, regionsApi, regions, map, inline,
            side, part: initialPart, rectIndex: 0, width: Math.max(1, Number(options.width) || 1),
            height: Math.max(1, Number(options.height) || 1), frame, stage, space, overlay, image,
            zoom: 1, fitWidth: 1, fitHeight: 1, zoomSelect, zoomOutButton, zoomInButton,
            focusSelectionButton,
            sideSelect: sideSelect.select, partSelect: partSelect.select, rectSelect: rectSelect.select,
            addButton, removeButton, numberInputs, emptyRectsMessage, resetButton, note,
            customRegionButton, customRegionForm, customLabel, customBaseSelect: customBase.select,
            customPrompt, customError, listenerRecords: [], observer: null,
            drag: null, disposed: false, onSave: options.onSave, onClose: options.onClose,
            panelHost: inline ? options.panelHost : null, overlayHost: inline ? options.overlayHost : null,
            onZoom: options.onZoom, onFocus: options.onFocus, onWheel: options.onWheel,
        };
        activeSession = session;
        session.sideSelect.value = side;
        if (session.image) session.image.alt = '현재 캔버스 부위 지도';
        const listen = (target, eventName, callback, listenerOptions) => {
            target.addEventListener(eventName, callback, listenerOptions);
            session.listenerRecords.push([target, eventName, callback, listenerOptions]);
        };

        function currentRects() {
            return session.part ? session.map[session.side][session.part] : [];
        }

        function updateInputs() {
            const rect = currentRects()[session.rectIndex];
            for (const [key, input] of Object.entries(session.numberInputs)) {
                input.disabled = !rect;
                input.value = rect ? roundedPercent(rect[key]) : '';
            }
        }

        function syncSelectionClasses() {
            for (const node of session.overlay.children) {
                const selectedPart = node.dataset.regionId === session.part;
                const selectedRect = selectedPart && Number(node.dataset.rectIndex) === session.rectIndex;
                node.classList.toggle('is-selected-part', selectedPart);
                node.classList.toggle('is-selected-rect', selectedRect);
                node.style.zIndex = selectedRect ? '3' : (selectedPart ? '2' : '1');
                syncHandles(session, node, selectedRect);
            }
        }

        function syncRectPositions() {
            for (const node of session.overlay.children) {
                const rects = session.map[session.side][node.dataset.regionId] || [];
                const rect = rects[Number(node.dataset.rectIndex)];
                if (!rect) continue;
                node.style.left = `${rect.x * 100}%`;
                node.style.top = `${rect.y * 100}%`;
                node.style.width = `${rect.width * 100}%`;
                node.style.height = `${rect.height * 100}%`;
            }
        }

        function renderOverlay() {
            clearChildren(session.overlay);
            for (const region of session.regions.filter(item => item.id === session.part)) {
                const rects = session.map[session.side][region.id] || [];
                rects.forEach((rect, index) => {
                    const node = make(doc, 'div', 'canvas-daki-map-rect');
                    node.dataset.regionId = region.id;
                    node.dataset.rectIndex = String(index);
                    node.style.left = `${rect.x * 100}%`;
                    node.style.top = `${rect.y * 100}%`;
                    node.style.width = `${rect.width * 100}%`;
                    node.style.height = `${rect.height * 100}%`;
                    node.style.setProperty('--region-color', region.color || 'var(--accent-blue)');
                    node.style.zIndex = region.id === session.part && index === session.rectIndex ? '3'
                        : (region.id === session.part ? '2' : '1');
                    node.setAttribute('role', 'group');
                    node.setAttribute('tabindex', '0');
                    node.setAttribute('aria-label', `${region.label || region.id} 영역 ${index + 1}`);
                    if (region.id === session.part) node.classList.add('is-selected-part');
                    if (region.id === session.part && index === session.rectIndex) node.classList.add('is-selected-rect');
                    if (region.id === session.part && index === session.rectIndex) syncHandles(session, node, true);
                    session.overlay.append(node);
                });
            }
        }

        function refreshControls() {
            session.sideSelect.value = session.side;
            session.partSelect.value = session.part || '';
            const rects = currentRects();
            clearChildren(session.rectSelect);
            if (rects.length) {
                rects.forEach((_, index) => addOption(doc, session.rectSelect, String(index), `영역 ${index + 1}`));
                session.rectSelect.disabled = false;
                session.rectIndex = clamp(session.rectIndex, 0, rects.length - 1);
                session.rectSelect.value = String(session.rectIndex);
            } else {
                addOption(doc, session.rectSelect, '', '영역 없음');
                session.rectSelect.value = '';
                session.rectSelect.disabled = true;
                session.rectIndex = 0;
            }
            session.addButton.disabled = !session.part || rects.length >= MAX_RECTS;
            session.removeButton.disabled = rects.length === 0;
            session.emptyRectsMessage.hidden = rects.length > 0;
            const selectedRegion = session.regions.find(region => region.id === session.part);
            const custom = Boolean(selectedRegion && selectedRegion.custom);
            session.resetButton.disabled = custom;
            session.note.textContent = custom ? '직접 추가한 부위입니다.' : '기본값은 선택한 면과 부위에만 적용됩니다.';
            updateInputs();
        }

        function render() {
            refreshControls();
            renderOverlay();
            if (session.inline) syncInlineOverlayBounds(session);
            else syncFrameSize(session);
        }

        listen(closeButton, 'click', () => finish(session, false));
        listen(cancelButton, 'click', () => finish(session, false));
        listen(applyButton, 'click', () => {
            try {
                if (typeof session.onSave === 'function') session.onSave(clone(session.map));
            } finally {
                finish(session, true);
            }
        });
        listen(dialog, 'cancel', event => {
            event.preventDefault();
            finish(session, false);
        });
        listen(dialog, 'keydown', event => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                finish(session, false);
            }
        });
        for (const eventName of ['paste', 'copy', 'cut']) {
            listen(dialog, eventName, event => event.stopPropagation());
        }
        listen(dialog, 'close', () => finish(session, false));
        listen(session.sideSelect, 'change', () => {
            if (session.inline) return;
            session.side = session.sideSelect.value === 'back' ? 'back' : 'front';
            session.rectIndex = 0;
            if (session.image) session.image.alt = '현재 캔버스 부위 지도';
            render();
            if (session.zoom > 1) centerOnSelection(session);
        });
        listen(session.partSelect, 'change', () => {
            session.part = session.partSelect.value;
            session.rectIndex = 0;
            render();
            if (session.zoom > 1) centerOnSelection(session);
        });
        listen(session.rectSelect, 'change', () => {
            session.rectIndex = Math.max(0, Number(session.rectSelect.value) || 0);
            updateInputs();
            syncSelectionClasses();
            if (session.zoom > 1) centerOnSelection(session);
        });
        listen(zoomOutButton, 'click', () => session.inline ? callZoom(session, -1) : stepZoom(session, -1));
        listen(zoomInButton, 'click', () => session.inline ? callZoom(session, 1) : stepZoom(session, 1));
        if (zoomSelect) listen(zoomSelect, 'change', () => changeZoom(session, Number(zoomSelect.value)));
        listen(focusSelectionButton, 'click', () => {
            if (session.inline) {
                const rect = currentRects()[session.rectIndex] || null;
                if (typeof session.onFocus === 'function') session.onFocus(rect ? clone(rect) : null);
                return;
            }
            if (session.zoom < 2) changeZoom(session, 2, false);
            centerOnSelection(session);
        });
        listen(customRegionButton, 'click', () => {
            const current = session.regions.find(region => region.id === session.part);
            const baseRegion = current && current.custom ? current.baseRegion
                : (current && regionsApi.REGIONS.some(region => region.id === current.id) ? current.id : 'whole');
            session.customBaseSelect.value = regionsApi.REGIONS.some(region => region.id === baseRegion) ? baseRegion : 'whole';
            session.customError.textContent = '';
            session.customRegionForm.hidden = false;
            if (typeof session.customLabel.focus === 'function') session.customLabel.focus();
        });
        listen(customCancel, 'click', () => {
            session.customRegionForm.hidden = true;
            session.customError.textContent = '';
        });
        listen(customRegionForm, 'submit', event => {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            try {
                if (typeof regionsApi.addCustomRegion !== 'function') throw new Error('사용자 신체 부위를 추가할 수 없습니다.');
                const sourceRect = currentRects()[session.rectIndex];
                const created = regionsApi.addCustomRegion(session.map, {
                    label: session.customLabel.value,
                    baseRegion: session.customBaseSelect.value,
                    prompt: session.customPrompt.value,
                });
                session.map = created.map;
                session.regions = listRegions(regionsApi, session.map).filter(region => region && region.id !== 'whole');
                const id = created.region.id;
                session.map[session.side][id] = [sourceRect ? clone(sourceRect) : {x: 0.35, y: 0.35, width: 0.3, height: 0.3}];
                clearChildren(session.partSelect);
                session.regions.forEach(region => addRegionOption(doc, session.partSelect, region));
                session.part = id;
                session.rectIndex = 0;
                session.customLabel.value = '';
                session.customPrompt.value = '';
                session.customRegionForm.hidden = true;
                session.customError.textContent = '';
                render();
            } catch (error) {
                session.customError.textContent = error && error.message ? error.message : '부위를 추가하지 못했습니다.';
            }
        });
        listen(addButton, 'click', () => {
            const rects = currentRects();
            if (rects.length >= MAX_RECTS) return;
            rects.push({x: 0.3, y: 0.3, width: 0.3, height: 0.3});
            session.rectIndex = rects.length - 1;
            render();
        });
        listen(removeButton, 'click', () => {
            const rects = currentRects();
            if (!rects.length) return;
            rects.splice(session.rectIndex, 1);
            session.rectIndex = Math.min(session.rectIndex, rects.length - 1);
            render();
        });
        listen(resetButton, 'click', () => {
            if (!session.part) return;
            const defaults = regionsApi.normalizeMap(clone(regionsApi.defaultMap())) || regionsApi.defaultMap();
            const defaultRects = defaults[session.side] && defaults[session.side][session.part];
            session.map[session.side][session.part] = clone(Array.isArray(defaultRects) ? defaultRects : []);
            session.rectIndex = 0;
            render();
        });
        Object.entries(session.numberInputs).forEach(([key, input]) => {
            listen(input, 'input', () => updateFromInput(session, key, input.value, syncRectPositions));
            listen(input, 'change', () => updateFromInput(session, key, input.value, renderGeometry));
            listen(input, 'blur', () => updateInputs());
        });

        listen(overlay, 'pointerdown', event => {
            if (event.button != null && event.button !== 0) return;
            const target = rectNodeFor(event.target, overlay);
            if (!target) return;
            const regionId = target.dataset.regionId;
            const rectIndex = Number(target.dataset.rectIndex);
            const rect = session.map[session.side][regionId] && session.map[session.side][regionId][rectIndex];
            if (!rect) return;
            const corner = event.target && event.target.dataset && event.target.dataset.corner;
            session.part = regionId;
            session.rectIndex = rectIndex;
            const bounds = session.frame.getBoundingClientRect();
            session.drag = {
                pointerId: event.pointerId, side: session.side, regionId, rectIndex, corner: corner || null,
                startX: event.clientX, startY: event.clientY, frameWidth: Math.max(1, bounds.width),
                frameHeight: Math.max(1, bounds.height), initial: clone(rect),
            };
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (session.inline && typeof event.stopPropagation === 'function') event.stopPropagation();
            if (typeof event.target.setPointerCapture === 'function' && event.pointerId != null) {
                try { event.target.setPointerCapture(event.pointerId); } catch (_) { /* Capture can be unavailable in a detached preview. */ }
            }
            refreshControls();
            syncSelectionClasses();
            updateInputs();
        });
        listen(overlay, 'pointermove', event => {
            if (!session.drag || (session.drag.pointerId != null && event.pointerId !== session.drag.pointerId)) return;
            applyPointerDrag(session, event);
            renderGeometry();
        });
        listen(overlay, 'pointerup', event => {
            if (!session.drag || (session.drag.pointerId != null && event.pointerId !== session.drag.pointerId)) return;
            applyPointerDrag(session, event);
            session.drag = null;
            render();
        });
        listen(overlay, 'pointercancel', event => {
            if (!session.drag || (session.drag.pointerId != null && event.pointerId !== session.drag.pointerId)) return;
            const drag = session.drag;
            session.map[drag.side][drag.regionId][drag.rectIndex] = drag.initial;
            session.drag = null;
            render();
        });
        listen(overlay, 'keydown', event => {
            if (typeof event.stopPropagation === 'function') event.stopPropagation();
            if (event.key === 'Escape') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                finish(session, false);
                return;
            }
            const target = rectNodeFor(event.target, overlay);
            if (!target || !['Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            session.part = target.dataset.regionId;
            session.rectIndex = Number(target.dataset.rectIndex);
            refreshControls();
            syncSelectionClasses();
        });
        if (inline) {
            listen(overlay, 'wheel', event => {
                if (session.drag) {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    return;
                }
                if (typeof session.onWheel === 'function') session.onWheel(event);
            }, {passive: false});
            for (const eventName of ['mousedown', 'contextmenu']) {
                listen(overlay, eventName, event => {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                });
            }
            listen(doc, 'keydown', event => {
                if (isWithin(event.target, dialog) || isWithin(event.target, overlay)
                    || isInsideOtherDialog(event.target, dialog)) return;
                if (event.key === 'Escape') {
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                    finish(session, false);
                } else if (typeof event.stopPropagation === 'function') {
                    event.stopPropagation();
                }
            }, true);
            for (const eventName of ['paste', 'copy', 'cut']) {
                listen(doc, eventName, event => {
                    if (isWithin(event.target, dialog) || isInsideOtherDialog(event.target, dialog)) return;
                    if (typeof event.preventDefault === 'function') event.preventDefault();
                    if (typeof event.stopPropagation === 'function') event.stopPropagation();
                }, true);
            }
        }

        function renderGeometry() {
            syncRectPositions();
            updateInputs();
        }

        session.observer = typeof root.ResizeObserver === 'function'
            ? new root.ResizeObserver(() => resizeFrame(session))
            : (typeof ResizeObserver === 'function' ? new ResizeObserver(() => resizeFrame(session)) : null);
        if (session.observer) session.observer.observe(inline ? options.canvasSurface : stage);
        if (inline) {
            options.panelHost.append(dialog);
            options.overlayHost.append(overlay);
            syncInlineOverlayBounds(session);
        }
        render();
        if (!inline) {
            doc.body.append(dialog);
            if (typeof dialog.showModal === 'function') dialog.showModal();
            else dialog.setAttribute('open', '');
            resizeFrame(session);
        }
        syncZoomControls(session);
        const focusTarget = session.inline ? session.partSelect : session.sideSelect;
        if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
        return dialog;
    }

    function updateFromInput(session, key, rawValue, renderGeometry) {
        const value = Number(rawValue);
        if (rawValue === '' || !Number.isFinite(value)) return;
        const rect = session.map[session.side][session.part] && session.map[session.side][session.part][session.rectIndex];
        if (!rect) return;
        const normalized = roundNormalized(clamp(value / 100, 0, 1));
        if (key === 'x') rect.x = roundNormalized(clamp(normalized, 0, Math.max(0, 1 - rect.width)));
        else if (key === 'y') rect.y = roundNormalized(clamp(normalized, 0, Math.max(0, 1 - rect.height)));
        else if (key === 'width') rect.width = roundNormalized(clamp(normalized, MIN_SIZE, Math.max(MIN_SIZE, 1 - rect.x)));
        else if (key === 'height') rect.height = roundNormalized(clamp(normalized, MIN_SIZE, Math.max(MIN_SIZE, 1 - rect.y)));
        renderGeometry();
    }

    function applyPointerDrag(session, event) {
        const drag = session.drag;
        const rects = session.map[drag.side][drag.regionId];
        const rect = rects[drag.rectIndex];
        const dx = (event.clientX - drag.startX) / drag.frameWidth;
        const dy = (event.clientY - drag.startY) / drag.frameHeight;
        const initial = drag.initial;
        if (!drag.corner) {
            rect.x = roundNormalized(clamp(initial.x + dx, 0, 1 - initial.width));
            rect.y = roundNormalized(clamp(initial.y + dy, 0, 1 - initial.height));
            return;
        }
        let left = initial.x, top = initial.y, right = initial.x + initial.width, bottom = initial.y + initial.height;
        if (drag.corner.includes('w')) left = clamp(initial.x + dx, 0, right - MIN_SIZE);
        if (drag.corner.includes('e')) right = clamp(initial.x + initial.width + dx, left + MIN_SIZE, 1);
        if (drag.corner.includes('n')) top = clamp(initial.y + dy, 0, bottom - MIN_SIZE);
        if (drag.corner.includes('s')) bottom = clamp(initial.y + initial.height + dy, top + MIN_SIZE, 1);
        rect.x = roundNormalized(left);
        rect.y = roundNormalized(top);
        rect.width = roundNormalized(right - left);
        rect.height = roundNormalized(bottom - top);
    }

    function resizeFrame(session) {
        if (session.inline) {
            syncInlineOverlayBounds(session);
            return;
        }
        const stageBounds = session.stage.getBoundingClientRect();
        const availableWidth = Math.max(1, session.stage.clientWidth || stageBounds.width);
        const availableHeight = Math.max(1, session.stage.clientHeight || stageBounds.height);
        const aspect = session.width / session.height;
        let width = availableWidth;
        let height = width / aspect;
        if (height > availableHeight) {
            height = availableHeight;
            width = height * aspect;
        }
        session.fitWidth = width;
        session.fitHeight = height;
        syncFrameSize(session);
        if (session.zoom > 1) centerOnSelection(session);
    }

    function syncFrameSize(session) {
        const stageBounds = session.stage.getBoundingClientRect();
        const viewportWidth = Math.max(1, session.stage.clientWidth || stageBounds.width);
        const viewportHeight = Math.max(1, session.stage.clientHeight || stageBounds.height);
        const frameWidth = session.fitWidth * session.zoom;
        const frameHeight = session.fitHeight * session.zoom;
        const spaceWidth = Math.max(viewportWidth, frameWidth);
        const spaceHeight = Math.max(viewportHeight, frameHeight);
        session.space.style.width = `${spaceWidth}px`;
        session.space.style.height = `${spaceHeight}px`;
        session.frame.style.width = `${frameWidth}px`;
        session.frame.style.height = `${frameHeight}px`;
        syncZoomControls(session);
    }

    function syncZoomControls(session) {
        if (!session.zoomSelect) return;
        const index = ZOOM_LEVELS.indexOf(session.zoom);
        session.zoomSelect.value = String(session.zoom);
        session.zoomOutButton.disabled = index <= 0;
        session.zoomInButton.disabled = index >= ZOOM_LEVELS.length - 1;
    }

    function syncInlineOverlayBounds(session) {
        if (!session || !session.inline || !session.frame || !session.overlay) return;
        const surface = session.frame;
        const left = Number(surface.offsetLeft || 0) + Number(surface.clientLeft || 0);
        const top = Number(surface.offsetTop || 0) + Number(surface.clientTop || 0);
        const width = Number(surface.clientWidth || 0);
        const height = Number(surface.clientHeight || 0);
        session.overlay.style.position = 'absolute';
        session.overlay.style.left = `${left}px`;
        session.overlay.style.top = `${top}px`;
        session.overlay.style.width = `${Math.max(0, width)}px`;
        session.overlay.style.height = `${Math.max(0, height)}px`;
    }

    function callZoom(session, direction) {
        if (typeof session.onZoom === 'function') session.onZoom(direction > 0 ? 1 : -1);
    }

    function stepZoom(session, direction) {
        const currentIndex = ZOOM_LEVELS.indexOf(session.zoom);
        const nextIndex = clamp(currentIndex + direction, 0, ZOOM_LEVELS.length - 1);
        changeZoom(session, ZOOM_LEVELS[nextIndex]);
    }

    function changeZoom(session, requestedZoom, focus = true) {
        const zoom = Number(requestedZoom);
        if (!Number.isFinite(zoom)) return;
        session.zoom = ZOOM_LEVELS.reduce((closest, level) =>
            Math.abs(level - zoom) < Math.abs(closest - zoom) ? level : closest, ZOOM_LEVELS[0]);
        syncFrameSize(session);
        if (focus) centerOnSelection(session);
    }

    function centerOnSelection(session) {
        const stageBounds = session.stage.getBoundingClientRect();
        const viewportWidth = Math.max(1, session.stage.clientWidth || stageBounds.width);
        const viewportHeight = Math.max(1, session.stage.clientHeight || stageBounds.height);
        const frameWidth = session.fitWidth * session.zoom;
        const frameHeight = session.fitHeight * session.zoom;
        const spaceWidth = Math.max(viewportWidth, frameWidth);
        const spaceHeight = Math.max(viewportHeight, frameHeight);
        const rect = session.part && session.map[session.side][session.part]
            ? session.map[session.side][session.part][session.rectIndex] : null;
        const centerX = rect ? rect.x + rect.width / 2 : 0.5;
        const centerY = rect ? rect.y + rect.height / 2 : 0.5;
        const frameLeft = Math.max(0, (spaceWidth - frameWidth) / 2);
        const frameTop = Math.max(0, (spaceHeight - frameHeight) / 2);
        const targetX = frameLeft + centerX * frameWidth;
        const targetY = frameTop + centerY * frameHeight;
        session.stage.scrollLeft = clamp(targetX - viewportWidth / 2, 0, Math.max(0, spaceWidth - viewportWidth));
        session.stage.scrollTop = clamp(targetY - viewportHeight / 2, 0, Math.max(0, spaceHeight - viewportHeight));
    }

    function syncHandles(session, node, selected) {
        const oldHandles = Array.from(node.children).filter(child => child.dataset && child.dataset.corner);
        if (!selected) {
            oldHandles.forEach(handle => node.removeChild(handle));
            return;
        }
        if (oldHandles.length === 4) return;
        oldHandles.forEach(handle => node.removeChild(handle));
        for (const [corner, label] of [['nw', '왼쪽 위'], ['ne', '오른쪽 위'], ['sw', '왼쪽 아래'], ['se', '오른쪽 아래']]) {
            const handle = session.doc.createElement('button');
            handle.type = 'button';
            handle.className = `canvas-daki-map-handle handle-${corner}`;
            handle.dataset.corner = corner;
            handle.setAttribute('aria-label', `영역 ${Number(node.dataset.rectIndex) + 1} ${label} 모서리 크기 조절`);
            node.append(handle);
        }
    }

    function rectNodeFor(target, boundary) {
        let node = target;
        while (node && node !== boundary) {
            if (node.dataset && node.dataset.regionId != null && node.dataset.rectIndex != null) return node;
            node = node.parentNode;
        }
        return null;
    }

    function finish(session, applied) {
        if (!session || session.disposed) return;
        session.disposed = true;
        if (activeSession === session) activeSession = null;
        session.listenerRecords.forEach(([target, name, callback, options]) => target.removeEventListener(name, callback, options));
        session.listenerRecords.length = 0;
        if (session.observer) session.observer.disconnect();
        session.drag = null;
        if (!session.inline && session.dialog.open && typeof session.dialog.close === 'function') session.dialog.close();
        else if (session.dialog.removeAttribute) session.dialog.removeAttribute('open');
        if (session.dialog.parentNode) session.dialog.parentNode.removeChild(session.dialog);
        if (session.inline && session.overlay.parentNode) session.overlay.parentNode.removeChild(session.overlay);
        try {
            if (typeof session.onClose === 'function') session.onClose({applied: Boolean(applied)});
        } finally {
            if (session.opener && typeof session.opener.focus === 'function'
                && (session.opener.isConnected !== false)) session.opener.focus();
        }
    }

    function close() {
        if (activeSession) finish(activeSession, false);
    }

    function sync() {
        if (activeSession && activeSession.inline) syncInlineOverlayBounds(activeSession);
    }

    function isOpen() {
        return Boolean(activeSession);
    }

    function make(doc, tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(doc, text, className) {
        const node = make(doc, 'button', className, text);
        node.type = 'button';
        return node;
    }

    function labeledSelect(doc, parent, labelText, role) {
        const wrapper = make(doc, 'label', 'canvas-daki-map-field');
        const label = make(doc, 'span', '', labelText);
        const select = doc.createElement('select');
        select.dataset.role = role;
        wrapper.append(label, select);
        parent.append(wrapper);
        return {wrapper, select};
    }

    function labeledNumber(doc, parent, labelText, role) {
        const wrapper = make(doc, 'label', 'canvas-daki-map-number-field');
        const label = make(doc, 'span', '', labelText);
        const input = doc.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.max = '100';
        input.step = '0.1';
        input.inputMode = 'decimal';
        input.dataset.role = role;
        wrapper.append(label, input);
        parent.append(wrapper);
        return {wrapper, input};
    }

    function labeledTextInput(doc, parent, labelText, role, maxLength, placeholder) {
        const wrapper = make(doc, 'label', 'canvas-daki-map-custom-field');
        const label = make(doc, 'span', '', labelText);
        const input = doc.createElement('input');
        input.type = 'text';
        input.maxLength = maxLength;
        input.placeholder = placeholder;
        input.dataset.role = role;
        wrapper.append(label, input);
        parent.append(wrapper);
        return input;
    }

    function labeledTextarea(doc, parent, labelText, role, maxLength, rows, placeholder) {
        const wrapper = make(doc, 'label', 'canvas-daki-map-custom-field');
        const label = make(doc, 'span', '', labelText);
        const input = doc.createElement('textarea');
        input.maxLength = maxLength;
        input.rows = rows;
        input.placeholder = placeholder;
        input.dataset.role = role;
        wrapper.append(label, input);
        parent.append(wrapper);
        return input;
    }

    function addOption(doc, select, value, label) {
        const option = make(doc, 'option', '', label);
        option.value = value;
        select.append(option);
        return option;
    }

    function addRegionOption(doc, select, region) {
        const label = region.label || region.id;
        const option = addOption(doc, select, region.id, label);
        option.title = label;
        return option;
    }

    function listRegions(api, map) {
        const regions = typeof api.listRegions === 'function' ? api.listRegions(map) : api.REGIONS;
        return Array.isArray(regions) ? regions : [];
    }

    function isWithin(target, boundary) {
        let node = target;
        while (node) {
            if (node === boundary) return true;
            node = node.parentNode;
        }
        return false;
    }

    function isInsideOtherDialog(target, ownRoot) {
        let node = target;
        while (node) {
            if (node !== ownRoot && ((node.tagName === 'DIALOG' && node.open)
                || (node.getAttribute && node.getAttribute('role') === 'dialog'
                    && node.getAttribute('aria-modal') === 'true'))) return true;
            node = node.parentNode;
        }
        return false;
    }

    function clearChildren(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    return {open, close, sync, isOpen};
});
