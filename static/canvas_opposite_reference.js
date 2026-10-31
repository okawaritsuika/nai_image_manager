/* Opposite-side previews stay outside the editable layer tree and canvas snapshot. */
(function (root) {
    'use strict';

    const doc = root.document;
    const ID_RE = /^[a-f0-9]{32}$/;
    const sideNames = {front: '앞면', back: '뒷면'};
    const DEFAULT_VIEW_WIDTH = 160;
    const MIN_VIEW_SIZE = 32;
    const MAX_VIEW_SIZE = 10000;
    let selection = null;
    let activeLink = null;
    let operationVersion = 0;
    let operationController = null;
    let pickerVersion = 0;
    let pickerController = null;
    let picker = null;
    let pickerOpener = null;
    let pickerConsumer = null;
    let closingPicker = false;
    let preview = null;
    let statusText = '반대쪽 그림을 선택하세요.';
    let hasError = false;
    let panel = null;

    const byId = id => doc.getElementById(id);
    const validId = value => typeof value === 'string' && ID_RE.test(value);

    function normalizeSnapshot(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !validId(value.projectId) || !['candidate', 'canvas'].includes(value.kind)
            || !validId(value.id) || typeof value.visible !== 'boolean') return null;
        const result = {projectId: value.projectId, kind: value.kind, id: value.id, visible: value.visible};
        const view = normalizeView(value.view);
        if (view) result.view = view;
        return result;
    }

    function normalizeView(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const {x, y, width, height} = value;
        if (![x, y, width, height].every(Number.isFinite)
            || x < -10000 || x > 10000 || y < -10000 || y > 10000
            || width < MIN_VIEW_SIZE || width > MAX_VIEW_SIZE
            || height < MIN_VIEW_SIZE || height > MAX_VIEW_SIZE) return null;
        return {x, y, width, height,
            ...(value.fitToCanvasHeight === true ? {fitToCanvasHeight: true} : {})};
    }

    function readLink() {
        const value = root.CanvasProject?.localLink?.();
        if (!value || !validId(value.projectId) || !validId(value.canvasId)
            || !Object.hasOwn(sideNames, value.side)) return null;
        return {projectId: value.projectId, canvasId: value.canvasId, side: value.side};
    }

    function linkKey(value) {
        return value ? JSON.stringify([value.projectId, value.canvasId, value.side]) : '';
    }

    function selectionKey(value = selection) {
        return value ? JSON.stringify([value.projectId, value.kind, value.id]) : '';
    }

    function oppositeSide(link = activeLink) {
        return link?.side === 'front' ? 'back' : link?.side === 'back' ? 'front' : null;
    }

    function candidateName(path) {
        const parts = String(path || '').replaceAll('\\', '/').split('/');
        return parts.at(-1) || '후보 그림';
    }

    function cancelOperation() {
        operationVersion += 1;
        operationController?.abort();
        operationController = null;
    }

    function cancelPickerRequest() {
        pickerVersion += 1;
        pickerController?.abort();
        pickerController = null;
    }

    function setStatus(message, error = false) {
        statusText = message;
        hasError = error;
        const label = byId('canvasOppositeStatus');
        if (label) label.textContent = message;
        const retry = byId('canvasOppositeRetry');
        if (retry) retry.hidden = !error;
    }

    function saveUserChange() {
        if (typeof root.saveCanvasState === 'function') root.saveCanvasState();
    }

    async function api(url, signal) {
        const response = await root.fetch(url, {method: 'GET', signal});
        const result = await response.json();
        if (!response.ok || result?.status !== 'success') {
            throw new Error(result?.message || '반대쪽 그림 정보를 불러오지 못했습니다.');
        }
        return result;
    }

    function projectEndpoint(projectId) {
        return '/api/daki/projects/' + encodeURIComponent(projectId);
    }

    function canvasEndpoint(projectId, canvasId) {
        return projectEndpoint(projectId) + '/canvases/' + encodeURIComponent(canvasId);
    }

    function matchesOperation(version, link, chosen) {
        const latestLink = readLink();
        return version === operationVersion && selectionKey() === selectionKey(chosen)
            && selection?.visible === true && linkKey(latestLink) === linkKey(link);
    }

    function preloadImage(source, signal) {
        return new Promise((resolve, reject) => {
            if (typeof root.Image !== 'function') {
                reject(new Error('이미지를 미리 볼 수 없습니다.'));
                return;
            }
            const image = new root.Image();
            let settled = false;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                if (error) reject(error);
                else resolve({width: image.naturalWidth, height: image.naturalHeight});
            };
            const onAbort = () => {
                image.onload = image.onerror = null;
                try { image.src = ''; } catch (_) { /* The generation guard still discards late loads. */ }
                finish(new Error('요청이 취소되었습니다.'));
            };
            image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0
                ? null : new Error('선택한 그림의 크기를 확인하지 못했습니다.'));
            image.onerror = () => finish(new Error('선택한 그림을 표시하지 못했습니다.'));
            signal?.addEventListener('abort', onAbort, {once: true});
            if (signal?.aborted) {
                onAbort();
                return;
            }
            image.src = source;
            if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) finish();
        });
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function sizeForWidth(width, ratio) {
        const minWidth = Math.max(MIN_VIEW_SIZE, MIN_VIEW_SIZE * ratio);
        const maxWidth = Math.min(MAX_VIEW_SIZE, MAX_VIEW_SIZE * ratio);
        const boundedWidth = minWidth <= maxWidth ? clamp(width, minWidth, maxWidth) : width;
        return {width: boundedWidth, height: boundedWidth / ratio};
    }

    function ensureSelectionView(ratio) {
        if (!selection) return null;
        const current = selection.view || {x: 0, y: 0, width: DEFAULT_VIEW_WIDTH};
        const width = current.fitToCanvasHeight && canFitToCanvas()
            ? Number(byId('canvasSurface').getBoundingClientRect().height) * ratio : current.width;
        const size = sizeForWidth(width, ratio);
        selection.view = {x: current.x, y: current.y, ...size,
            ...(current.fitToCanvasHeight === true ? {fitToCanvasHeight: true} : {})};
        return selection.view;
    }

    function viewRatio() {
        return preview?.naturalWidth > 0 && preview?.naturalHeight > 0
            ? preview.naturalWidth / preview.naturalHeight : 0;
    }

    function canFitToCanvas() {
        const ratio = viewRatio();
        const surface = byId('canvasSurface');
        if (!ratio || !surface?.getBoundingClientRect) return false;
        const height = Number(surface.getBoundingClientRect().height);
        const width = height * ratio;
        return Number.isFinite(height) && height >= MIN_VIEW_SIZE && height <= MAX_VIEW_SIZE
            && Number.isFinite(width) && width >= MIN_VIEW_SIZE && width <= MAX_VIEW_SIZE;
    }

    function fitToCanvasHeight() {
        if (!selection || !preview || !canFitToCanvas()) return;
        const ratio = viewRatio();
        const height = Number(byId('canvasSurface').getBoundingClientRect().height);
        const current = ensureSelectionView(ratio);
        selection.view = {...current, width: height * ratio, height, fitToCanvasHeight: true};
        render();
        saveUserChange();
    }

    function finishViewDrag(event, cancelled = false) {
        const drag = activeViewDrag;
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        activeViewDrag = null;
        drag.target.classList?.remove('is-dragging');
        if (cancelled || selectionKey() !== drag.selectionKey) {
            if (selectionKey() === drag.selectionKey && selection) selection.view = {...drag.startView};
            render();
        } else if (drag.changed) {
            saveUserChange();
        }
        try {
            if (drag.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
        } catch (_) { /* Pointer capture may already have been released by the browser. */ }
    }

    let activeViewDrag = null;

    function cancelViewDrag() {
        if (activeViewDrag) finishViewDrag({pointerId: activeViewDrag.pointerId}, true);
    }

    function startViewDrag(event, mode) {
        if (event.button !== 0 || !selection || !preview || !viewRatio() || activeViewDrag) return;
        const target = event.currentTarget;
        const view = ensureSelectionView(viewRatio());
        event.preventDefault();
        event.stopPropagation();
        activeViewDrag = {mode, target, pointerId: event.pointerId, selectionKey: selectionKey(),
            startX: event.clientX, startY: event.clientY, startView: {...view}, changed: false};
        target.classList?.add('is-dragging');
        target.setPointerCapture(event.pointerId);
    }

    function moveViewDrag(event) {
        const drag = activeViewDrag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!selection || selectionKey() !== drag.selectionKey || !preview) {
            finishViewDrag(event, true);
            return;
        }
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (drag.mode === 'move') {
            selection.view = {...drag.startView,
                x: clamp(drag.startView.x + dx, -10000, 10000),
                y: clamp(drag.startView.y + dy, -10000, 10000)};
        } else {
            const ratio = viewRatio();
            const widthDelta = Math.abs(dx) >= Math.abs(dy * ratio) ? dx : dy * ratio;
            const size = sizeForWidth(drag.startView.width + widthDelta, ratio);
            selection.view = {x: drag.startView.x, y: drag.startView.y, ...size,
                ...(!dx && !dy && drag.startView.fitToCanvasHeight ? {fitToCanvasHeight: true} : {})};
        }
        drag.changed = drag.changed || selection.view.x !== drag.startView.x
            || selection.view.y !== drag.startView.y || selection.view.width !== drag.startView.width
            || selection.view.height !== drag.startView.height
            || selection.view.fitToCanvasHeight !== drag.startView.fitToCanvasHeight;
        render();
    }

    function bindViewDragTarget(target, mode) {
        target.addEventListener('pointerdown', event => startViewDrag(event, mode));
        target.addEventListener('pointermove', moveViewDrag);
        target.addEventListener('pointerup', event => finishViewDrag(event));
        target.addEventListener('pointercancel', event => finishViewDrag(event, true));
        target.addEventListener('lostpointercapture', event => finishViewDrag(event, true));
    }

    function findOppositeRecord(project, link, chosen) {
        const side = oppositeSide(link);
        if (!project || project.id !== link.projectId || !side) return null;
        const collection = chosen.kind === 'candidate' ? project.candidates : project.canvases;
        const items = collection?.[side];
        if (!Array.isArray(items)) return null;
        return items.find(item => item && item.id === chosen.id
            && (!item.side || item.side === side)) || null;
    }

    async function loadSelected() {
        const link = readLink();
        if (!link || !selection || !selection.visible || selection.projectId !== link.projectId) return;
        cancelViewDrag();
        cancelOperation();
        const version = operationVersion;
        const chosen = {...selection};
        const controller = new root.AbortController();
        operationController = controller;
        const signal = controller.signal;
        preview = null;
        setStatus('반대쪽 그림 미리보기를 불러오는 중…');
        render();

        try {
            const result = await api(projectEndpoint(link.projectId), signal);
            if (!matchesOperation(version, link, chosen)) return;
            const record = findOppositeRecord(result.project, link, chosen);
            if (!record) throw new Error('선택한 반대쪽 그림을 프로젝트에서 찾을 수 없습니다.');

            let source;
            let title;
            if (chosen.kind === 'candidate') {
                if (record.missing || typeof record.src !== 'string' || !record.src.trim()) {
                    throw new Error('선택한 후보 그림 파일을 찾을 수 없습니다.');
                }
                source = record.src;
                title = record.name || candidateName(record.path);
            } else {
                const canvasResult = await api(canvasEndpoint(link.projectId, chosen.id), signal);
                if (!matchesOperation(version, link, chosen)) return;
                const canvas = canvasResult.canvas;
                if (!canvas || canvas.id !== chosen.id || canvas.side !== oppositeSide(link)
                    || canvasResult.project?.id !== link.projectId || !canvas.state) {
                    throw new Error('선택한 반대쪽 캔버스를 불러오지 못했습니다.');
                }
                if (typeof root.renderMergedCanvasToDataUrl !== 'function') {
                    throw new Error('캔버스 미리보기 기능을 사용할 수 없습니다.');
                }
                source = await root.renderMergedCanvasToDataUrl({state: canvas.state, maxDimension: 1600});
                if (!matchesOperation(version, link, chosen)) return;
                if (typeof source !== 'string' || !source.startsWith('data:image/')) {
                    throw new Error('캔버스 미리보기를 만들지 못했습니다.');
                }
                title = canvas.name || '저장된 캔버스';
            }

            const dimensions = await preloadImage(source, signal);
            if (!matchesOperation(version, link, chosen)) return;
            preview = {key: linkKey(link) + '|' + selectionKey(chosen), renderId: version, source, title,
                detailTitle: chosen.kind === 'candidate' ? (record.name || record.path || title) : title,
                alt: `${sideNames[oppositeSide(link)]} · ${title}`,
                naturalWidth: dimensions.width, naturalHeight: dimensions.height};
            ensureSelectionView(dimensions.width / dimensions.height);
            setStatus('반대쪽 그림 미리보기가 표시 중입니다.');
            render();
        } catch (error) {
            if (!matchesOperation(version, link, chosen) || signal.aborted) return;
            preview = null;
            setStatus(error?.message || '반대쪽 그림 미리보기를 불러오지 못했습니다.', true);
            render();
        } finally {
            if (operationController === controller) operationController = null;
        }
    }

    function ensurePanel() {
        if (panel) return panel;
        panel = byId('canvasOppositePreview');
        if (panel) return panel;
        const stage = byId('canvasStage');
        if (!stage) return null;

        panel = doc.createElement('aside');
        panel.id = 'canvasOppositePreview';
        panel.className = 'canvas-opposite-preview';
        panel.hidden = true;
        panel.setAttribute('aria-label', '반대쪽 그림 미리보기');
        const header = doc.createElement('div');
        header.className = 'canvas-opposite-preview-header';
        const title = doc.createElement('strong');
        title.id = 'canvasOppositePreviewTitle';
        title.className = 'canvas-opposite-preview-title';
        title.title = '드래그해서 미리보기 이동';
        const hide = doc.createElement('button');
        hide.type = 'button';
        hide.className = 'canvas-opposite-preview-hide';
        hide.textContent = '×';
        hide.title = '미리보기 숨기기';
        hide.setAttribute('aria-label', '반대쪽 그림 미리보기 숨기기');
        hide.addEventListener('click', () => setVisible(false));
        const fit = doc.createElement('button');
        fit.id = 'canvasOppositePreviewFit';
        fit.type = 'button';
        fit.className = 'canvas-opposite-preview-fit';
        fit.textContent = '높이 맞춤';
        fit.title = '현재 캔버스와 같은 높이로 맞추기';
        fit.setAttribute('aria-label', '현재 캔버스와 같은 높이로 맞추기');
        fit.disabled = true;
        fit.addEventListener('click', fitToCanvasHeight);
        const image = doc.createElement('img');
        image.id = 'canvasOppositePreviewImage';
        image.alt = '';
        image.draggable = false;
        const picture = doc.createElement('div');
        picture.id = 'canvasOppositePreviewPicture';
        picture.className = 'canvas-opposite-preview-picture';
        const resize = doc.createElement('button');
        resize.id = 'canvasOppositePreviewResize';
        resize.type = 'button';
        resize.className = 'canvas-opposite-preview-resize';
        resize.textContent = '↘';
        resize.title = '드래그해서 비율 유지 크기 조절';
        resize.setAttribute('aria-label', '반대쪽 그림 크기 조절');
        header.append(title, fit, hide);
        picture.append(image, resize);
        panel.append(picture, header);
        bindViewDragTarget(title, 'move');
        bindViewDragTarget(resize, 'resize');
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click']) {
            panel.addEventListener(type, event => event.stopPropagation());
        }
        stage.appendChild(panel);
        return panel;
    }

    function render() {
        const controls = byId('canvasOppositeControls');
        const link = activeLink;
        const usable = Boolean(link);
        const linkedSelection = selection?.projectId === link?.projectId ? selection : null;
        if (controls) controls.hidden = !usable;

        const title = byId('canvasOppositeTitle');
        if (title) title.textContent = link ? `${sideNames[oppositeSide(link)]} 미리보기` : '반대쪽 미리보기';
        const choose = byId('canvasOppositeChoose');
        if (choose) choose.disabled = !usable;
        const visible = byId('canvasOppositeVisible');
        if (visible) {
            visible.checked = Boolean(linkedSelection?.visible);
            visible.disabled = !linkedSelection;
        }
        const status = byId('canvasOppositeStatus');
        const renderedStatus = usable && selection && !linkedSelection
            ? '선택한 그림은 현재 프로젝트에 연결되어 있지 않습니다.' : statusText;
        if (status && status.textContent !== renderedStatus) status.textContent = renderedStatus;
        const retry = byId('canvasOppositeRetry');
        if (retry) retry.hidden = !hasError || !linkedSelection;

        const stage = byId('canvasStage');
        const previewPanel = ensurePanel();
        const activeKey = link && linkedSelection ? linkKey(link) + '|' + selectionKey(linkedSelection) : '';
        const showPreview = Boolean(usable && linkedSelection?.visible && preview && preview.key === activeKey);
        if (previewPanel) {
            previewPanel.hidden = !showPreview;
            if (showPreview) {
                const panelTitle = byId('canvasOppositePreviewTitle');
                const image = byId('canvasOppositePreviewImage');
                const picture = byId('canvasOppositePreviewPicture');
                const fit = byId('canvasOppositePreviewFit');
                const resize = byId('canvasOppositePreviewResize');
                const view = ensureSelectionView(viewRatio());
                previewPanel.style.width = `${view.width}px`;
                if (picture) picture.style.height = `${view.height}px`;
                previewPanel.style.transform = `translate(${view.x}px, ${view.y}px)`;
                if (fit) fit.disabled = !canFitToCanvas();
                if (resize) resize.disabled = !viewRatio();
                if (panelTitle) panelTitle.textContent = `${sideNames[oppositeSide(link)]} 참고`;
                if (panelTitle) panelTitle.title = preview.detailTitle;
                if (image) {
                    if (image.dataset.previewRenderId !== String(preview.renderId)) {
                        image.src = preview.source;
                        image.dataset.previewRenderId = String(preview.renderId);
                    }
                    image.alt = preview.alt;
                    image.title = preview.detailTitle;
                }
            }
        }
        stage?.classList?.toggle('has-opposite-reference', showPreview);
    }

    function pickerElement(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function ensurePicker() {
        if (picker) return picker;
        const dialog = doc.createElement('dialog');
        dialog.id = 'canvasOppositeDialog';
        dialog.className = 'canvas-opposite-dialog';
        dialog.setAttribute('aria-labelledby', 'canvasOppositeDialogTitle');

        const header = pickerElement('header', 'canvas-opposite-dialog-header');
        const title = pickerElement('h2', '', '반대쪽 그림 선택');
        title.id = 'canvasOppositeDialogTitle';
        const headerClose = pickerElement('button', 'canvas-opposite-dialog-close', '×');
        headerClose.type = 'button';
        headerClose.setAttribute('aria-label', '선택 창 닫기');
        headerClose.addEventListener('click', () => closePicker());
        header.append(title, headerClose);

        const body = pickerElement('div', 'canvas-opposite-dialog-body');
        const message = pickerElement('p', 'canvas-opposite-dialog-status', '프로젝트의 반대쪽 그림을 불러오는 중…');
        message.setAttribute('role', 'status');
        message.setAttribute('aria-live', 'polite');
        body.appendChild(message);

        const footer = pickerElement('footer', 'canvas-opposite-dialog-footer');
        const retry = pickerElement('button', 'secondary', '새로고침');
        retry.type = 'button';
        retry.addEventListener('click', () => loadPickerCatalog());
        const close = pickerElement('button', '', '닫기');
        close.type = 'button';
        close.addEventListener('click', () => closePicker());
        footer.append(retry, close);

        dialog.append(header, body, footer);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            closePicker();
        });
        dialog.addEventListener('close', () => {
            if (!closingPicker) {
                pickerConsumer = null;
                cancelPickerRequest();
                if (pickerOpener?.isConnected) pickerOpener.focus();
                pickerOpener = null;
            }
        });
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            dialog.addEventListener(type, event => event.stopPropagation());
        }
        doc.body.appendChild(dialog);
        picker = {dialog, body, message, retry};
        return picker;
    }

    function closePicker(restoreFocus = true) {
        pickerConsumer = null;
        cancelPickerRequest();
        if (picker?.dialog.open) {
            closingPicker = true;
            picker.dialog.close();
            closingPicker = false;
        }
        if (restoreFocus && pickerOpener?.isConnected) pickerOpener.focus();
        pickerOpener = null;
    }

    function showPickerMessage(message, error = false) {
        if (!picker) return;
        picker.body.replaceChildren();
        picker.message.textContent = message;
        picker.message.className = 'canvas-opposite-dialog-status' + (error ? ' is-error' : '');
        picker.body.appendChild(picker.message);
    }

    function addSection(project, side, kind) {
        const property = kind === 'candidate' ? 'candidates' : 'canvases';
        const entries = project?.[property]?.[side];
        const section = pickerElement('section', 'canvas-opposite-choice-section');
        const heading = pickerElement('h3', '', kind === 'candidate' ? '후보 그림' : '저장된 캔버스');
        section.appendChild(heading);
        const grid = pickerElement('div', 'canvas-opposite-choice-grid');
        section.appendChild(grid);
        const validEntries = Array.isArray(entries) ? entries.filter(item => item
            && validId(item.id) && (!item.side || item.side === side)) : [];
        if (!validEntries.length) {
            const empty = pickerElement('p', 'canvas-opposite-empty', kind === 'candidate'
                ? `등록된 ${sideNames[side]} 후보 그림이 없습니다.`
                : `저장된 ${sideNames[side]} 캔버스가 없습니다.`);
            section.appendChild(empty);
            return section;
        }
        for (const item of validEntries) {
            const button = pickerElement('button', 'canvas-opposite-choice');
            button.type = 'button';
            button.dataset.kind = kind;
            button.dataset.id = item.id;
            const isSelected = !pickerConsumer && selection?.kind === kind && selection.id === item.id
                && selection.projectId === activeLink.projectId;
            if (isSelected) button.classList.add('is-selected');

            if (kind === 'candidate') {
                const image = pickerElement('img', 'canvas-opposite-choice-image');
                image.alt = '';
                image.loading = 'lazy';
                const hasImage = !item.missing && typeof item.src === 'string' && item.src.trim();
                if (hasImage) image.src = item.src;
                else image.classList.add('is-missing');
                button.appendChild(image);
                const name = pickerElement('span', 'canvas-opposite-choice-name', item.name || candidateName(item.path));
                name.title = item.path || '';
                button.appendChild(name);
                button.disabled = !hasImage;
                if (!hasImage) button.title = '파일을 찾을 수 없어 선택할 수 없습니다.';
            } else {
                const icon = pickerElement('span', 'canvas-opposite-choice-canvas-icon', '▧');
                icon.setAttribute('aria-hidden', 'true');
                const name = pickerElement('strong', 'canvas-opposite-choice-name', item.name || '이름 없는 캔버스');
                const details = pickerElement('small', 'canvas-opposite-choice-details',
                    `${Number(item.width) || 0} × ${Number(item.height) || 0} · 레이어 ${Number(item.layerCount) || 0}개`);
                button.append(icon, name, details);
            }

            button.addEventListener('click', () => chooseRecord({
                projectId: activeLink.projectId, kind, id: item.id
            }));
            grid.appendChild(button);
        }
        return section;
    }

    async function loadPickerCatalog() {
        const current = ensurePicker();
        const link = readLink();
        if (!link) {
            showPickerMessage('프로젝트 캔버스를 연결한 뒤 사용할 수 있습니다.', true);
            return;
        }
        cancelPickerRequest();
        const version = pickerVersion;
        const controller = new root.AbortController();
        pickerController = controller;
        showPickerMessage('프로젝트의 반대쪽 그림을 불러오는 중…');
        try {
            const result = await api(projectEndpoint(link.projectId), controller.signal);
            if (version !== pickerVersion || controller.signal.aborted || !current.dialog.open
                || linkKey(readLink()) !== linkKey(link)) return;
            const project = result.project;
            if (!project || project.id !== link.projectId) throw new Error('프로젝트 정보를 확인할 수 없습니다.');
            const side = oppositeSide(link);
            current.body.replaceChildren();
            current.message.textContent = pickerConsumer
                ? `${sideNames[side]}에서 인페인팅 참고 이미지를 고르세요.`
                : `${sideNames[side]}에서 미리 볼 그림을 고르세요.`;
            current.message.className = 'canvas-opposite-dialog-status';
            current.body.appendChild(current.message);
            current.body.append(addSection(project, side, 'candidate'), addSection(project, side, 'canvas'));
            const candidates = Array.isArray(project.candidates?.[side]) ? project.candidates[side]
                .filter(item => item && validId(item.id) && !item.missing && item.src).length : 0;
            const canvases = Array.isArray(project.canvases?.[side]) ? project.canvases[side]
                .filter(item => item && validId(item.id) && (!item.side || item.side === side)).length : 0;
            if (!candidates && !canvases) {
                current.message.textContent = `등록된 ${sideNames[side]} 그림이 없습니다.`;
            }
        } catch (error) {
            if (version !== pickerVersion || controller.signal.aborted || !current.dialog.open) return;
            showPickerMessage(`프로젝트 그림 목록을 불러오지 못했습니다. ${error?.message || ''}`.trim(), true);
        } finally {
            if (pickerController === controller) pickerController = null;
        }
    }

    function chooseRecord(value) {
        const chosen = normalizeSnapshot({...value, visible: true});
        if (!chosen || !activeLink || chosen.projectId !== activeLink.projectId) return;
        const consumer = pickerConsumer;
        closePicker();
        if (consumer) {
            consumer(chosen);
            return;
        }
        cancelViewDrag();
        cancelOperation();
        selection = chosen;
        preview = null;
        setStatus('반대쪽 그림 미리보기를 불러오는 중…');
        render();
        saveUserChange();
        loadSelected();
    }

    function open(options = {}) {
        const link = readLink();
        if (!link || link.projectId !== activeLink?.projectId) {
            setStatus('프로젝트 캔버스를 연결한 뒤 사용할 수 있습니다.', true);
            render();
            return;
        }
        const current = ensurePicker();
        pickerConsumer = typeof options.onChoose === 'function' ? options.onChoose : null;
        pickerOpener = doc.activeElement;
        cancelPickerRequest();
        if (!current.dialog.open) current.dialog.showModal();
        return loadPickerCatalog();
    }

    function setVisible(value) {
        if (!selection || typeof value !== 'boolean' || selection.visible === value) {
            render();
            return;
        }
        selection.visible = value;
        if (!value) {
            cancelViewDrag();
            cancelOperation();
            setStatus('반대쪽 그림 미리보기를 숨겼습니다.');
        } else if (preview && activeLink
            && preview.key === linkKey(activeLink) + '|' + selectionKey()) {
            setStatus('반대쪽 그림 미리보기가 표시 중입니다.');
        } else {
            setStatus('반대쪽 그림 미리보기를 불러오는 중…');
        }
        render();
        saveUserChange();
        if (value && !(preview && activeLink
            && preview.key === linkKey(activeLink) + '|' + selectionKey())) loadSelected();
    }

    function refresh() {
        if (!selection) return open();
        cancelOperation();
        preview = null;
        setStatus('반대쪽 그림 미리보기를 다시 불러오는 중…');
        render();
        return loadSelected();
    }

    function linkChanged() {
        const next = readLink();
        const previousKey = linkKey(activeLink);
        const nextKey = linkKey(next);
        if (previousKey === nextKey) {
            render();
            return;
        }

        closePicker(false);
        cancelViewDrag();
        cancelOperation();
        if (!next) {
            preview = null;
            activeLink = null;
            render();
            return;
        }

        if (selection && selection.projectId !== next.projectId) {
            selection = null;
            setStatus('반대쪽 그림을 선택하세요.');
        }
        activeLink = next;
        preview = null;
        render();
        if (selection?.visible && selection.projectId === next.projectId) loadSelected();
    }

    function restore(value) {
        cancelViewDrag();
        closePicker(false);
        cancelOperation();
        preview = null;
        selection = normalizeSnapshot(value);
        setStatus(selection ? (selection.visible ? '반대쪽 그림 미리보기를 불러오는 중…'
            : '반대쪽 그림 미리보기가 숨겨져 있습니다.') : '반대쪽 그림을 선택하세요.');
        render();
        if (selection?.visible && activeLink?.projectId === selection.projectId) loadSelected();
    }

    function snapshot() {
        if (!selection) return null;
        const result = {projectId: selection.projectId, kind: selection.kind,
            id: selection.id, visible: selection.visible === true};
        const view = normalizeView(selection.view);
        if (view) result.view = view;
        return result;
    }

    root.CanvasOppositeReference = {snapshot, restore, linkChanged, render, open, setVisible, refresh};
})(window);
