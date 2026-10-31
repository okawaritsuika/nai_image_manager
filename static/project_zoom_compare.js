(function (root) {
    'use strict';

    const MIN_HEIGHT_RATIO = 0.05;
    const MAX_HEIGHT_RATIO = 8;
    const WHEEL_SPEED = 0.0015;
    const HEADER_HEIGHT = 32;
    const PICKER_PAGE_SIZE = 36;
    const doc = root.document;

    let config = null;
    let panes = [];
    let selectedPath = '';
    let active = false;
    let pickerOpen = false;
    let synchronized = false;
    let resizeObserver = null;
    let resizeBound = false;
    let stageEventsBound = false;
    let drag = null;

    function endDrag() {
        if (!drag) return;
        const previous = drag;
        drag = null;
        previous.pane.viewport.classList.remove('is-dragging');
        if (previous.pane.viewport.hasPointerCapture?.(previous.id)) {
            previous.pane.viewport.releasePointerCapture(previous.id);
        }
    }

    function startDrag(pane, event) {
        if (!active || !pane.loaded || event.button !== 0 || event.isPrimary === false
            || event.target.closest?.('button')) return;
        endDrag();
        selectPane(pane);
        event.preventDefault();
        drag = {pane, id: event.pointerId, x: event.clientX, y: event.clientY,
            panX: pane.panX, panY: pane.panY};
        pane.viewport.setPointerCapture?.(event.pointerId);
        pane.viewport.classList.add('is-dragging');
    }

    function moveDrag(event) {
        if (!drag || event.pointerId !== drag.id) return;
        event.preventDefault();
        const pane = drag.pane;
        pane.panX = drag.panX + event.clientX - drag.x;
        pane.panY = drag.panY + event.clientY - drag.y;
        pane.image.style.transform = `translate(${pane.panX}px, ${pane.panY}px)`;
    }
    let pickerPage = 0;
    let pickerItemNodes = new Map();

    const byId = id => doc.getElementById(id);
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    function layer() { return byId('zoomLayer'); }
    function controls() { return byId('projectZoomCompareControls'); }
    function stage() { return byId('projectZoomCompareStage'); }

    function normalizeImage(value) {
        if (!value || typeof value !== 'object') return null;
        const path = typeof value.path === 'string' ? value.path : '';
        const src = typeof value.src === 'string' ? value.src : '';
        if (!path || !src) return null;
        return {
            path,
            src,
            thumbnailSrc: typeof value.thumbnailSrc === 'string' ? value.thumbnailSrc : '',
            name: typeof value.name === 'string' && value.name ? value.name : path,
        };
    }

    function pickerThumbnailSrc(imageData) {
        if (imageData.thumbnailSrc) return imageData.thumbnailSrc;
        try {
            const base = root.location?.href || doc.baseURI || 'http://localhost/';
            const url = new URL(imageData.src, base);
            const baseUrl = new URL(base);
            if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/image/')) return imageData.src;
            url.searchParams.set('preview', '256');
            return `${url.pathname}${url.search}${url.hash}`;
        } catch {
            return imageData.src;
        }
    }

    function clearPane(pane) {
        if (drag?.pane === pane) endDrag();
        pane.image.onload = null;
        pane.image.onerror = null;
        pane.image.removeAttribute('src');
        pane.element.remove();
    }

    function clearPanes() {
        panes.forEach(clearPane);
        panes = [];
        const compareStage = stage();
        if (compareStage) compareStage.replaceChildren();
        selectedPath = '';
        updateColumns();
    }

    function dimensions() {
        const rect = stage()?.getBoundingClientRect?.();
        return {
            width: Math.max(0, Number(rect?.width) || 0),
            height: Math.max(0, Number(rect?.height) || 0),
        };
    }

    function updateColumns() {
        const compareStage = stage();
        if (!compareStage) return;
        compareStage.style.gridTemplateColumns = panes.length
            ? `repeat(${panes.length}, minmax(0, 1fr))` : '';
    }

    function displayedHeight(pane) {
        const {height} = dimensions();
        return height > 0 && Number.isFinite(pane.heightRatio) ? height * pane.heightRatio : 0;
    }

    function applyHeight(pane) {
        if (!pane.loaded || !panes.includes(pane) || !Number.isFinite(pane.heightRatio)) return;
        const height = displayedHeight(pane);
        if (height <= 0) return;
        pane.image.style.height = `${height}px`;
    }

    function applyHeights() {
        panes.forEach(pane => {
            if (Number.isFinite(pane.heightRatio)) applyHeight(pane);
            else fitPane(pane);
        });
    }

    function setRatio(pane, ratio) {
        pane.heightRatio = clamp(ratio, MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO);
        applyHeight(pane);
    }

    function matchSelectedHeight() {
        const selected = panes.find(pane => pane.path === selectedPath);
        if (!selected || !Number.isFinite(selected.heightRatio)) return;
        panes.forEach(pane => setRatio(pane, selected.heightRatio));
    }

    function dimensionsForFit(pane) {
        const {width, height} = dimensions();
        const paneWidth = panes.length ? width / panes.length : 0;
        const availableHeight = Math.max(0, height - HEADER_HEIGHT);
        return {paneWidth, availableHeight, stageHeight: height};
    }

    function fitPane(pane) {
        if (!pane.loaded || pane.naturalWidth <= 0 || pane.naturalHeight <= 0) return;
        const {paneWidth, availableHeight, stageHeight} = dimensionsForFit(pane);
        if (paneWidth <= 0 || availableHeight <= 0 || stageHeight <= 0) return;
        const aspect = pane.naturalWidth / pane.naturalHeight;
        const fitHeight = Math.min(availableHeight, paneWidth / aspect);
        setRatio(pane, fitHeight / stageHeight);
    }

    function refreshPaneSelection() {
        panes.forEach(pane => {
            const selected = pane.path === selectedPath;
            pane.element.classList.toggle('is-selected', selected);
            pane.element.setAttribute('aria-selected', String(selected));
            pane.selectedBadge.hidden = !selected;
            pane.removeButton.disabled = panes.length <= 1;
        });
    }

    function notifySelection() {
        const selected = panes.find(pane => pane.path === selectedPath);
        if (selected && config) {
            if (typeof config.onSelect === 'function') config.onSelect(selected.path);
        }
    }

    function selectPane(pane, notify = true) {
        if (!panes.includes(pane)) return;
        selectedPath = pane.path;
        if (synchronized) matchSelectedHeight();
        refreshPaneSelection();
        if (notify) notifySelection();
    }

    function setStatus(pane, message, failed = false) {
        pane.errorMessage.textContent = message;
        pane.errorMessage.hidden = !message;
        pane.retryButton.hidden = !failed;
        pane.image.hidden = Boolean(message);
    }

    function onImageLoad(pane) {
        if (!panes.includes(pane)) return;
        const width = Number(pane.image.naturalWidth);
        const height = Number(pane.image.naturalHeight);
        if (!(width > 0 && height > 0)) {
            onImageError(pane);
            return;
        }
        pane.loaded = true;
        pane.naturalWidth = width;
        pane.naturalHeight = height;
        setStatus(pane, '');
        if (!Number.isFinite(pane.heightRatio)) fitPane(pane);
        else applyHeight(pane);
        if (synchronized) matchSelectedHeight();
    }

    function onImageError(pane) {
        if (!panes.includes(pane)) return;
        pane.loaded = false;
        pane.heightRatio = null;
        pane.image.style.height = '';
        setStatus(pane, '이미지를 불러오지 못했습니다.', true);
    }

    function retryPane(pane) {
        if (!panes.includes(pane)) return;
        pane.loaded = false;
        pane.heightRatio = null;
        setStatus(pane, '불러오는 중…');
        pane.image.src = '';
        pane.image.src = pane.src;
    }

    function createPane(imageData) {
        const element = doc.createElement('section');
        element.className = 'project-zoom-compare-pane';
        element.tabIndex = 0;
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', imageData.name);

        const header = doc.createElement('div');
        header.className = 'project-zoom-compare-pane-header';
        const selectedBadge = doc.createElement('span');
        selectedBadge.className = 'project-zoom-compare-selected';
        selectedBadge.textContent = '선택';
        selectedBadge.hidden = true;
        const name = doc.createElement('span');
        name.className = 'project-zoom-compare-name';
        name.textContent = imageData.name;
        name.title = imageData.name;
        const removeButton = doc.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'project-zoom-compare-remove';
        removeButton.textContent = '×';
        removeButton.setAttribute('aria-label', `${imageData.name} 비교에서 제외`);
        removeButton.title = `${imageData.name} 비교에서 제외`;
        removeButton.addEventListener('click', event => {
            event.stopPropagation();
            removePane(pane);
        });
        header.append(selectedBadge, name, removeButton);

        const viewport = doc.createElement('div');
        viewport.className = 'project-zoom-compare-viewport';
        const image = doc.createElement('img');
        image.className = 'project-zoom-compare-image';
        image.alt = imageData.name;
        image.draggable = false;
        const errorMessage = doc.createElement('div');
        errorMessage.className = 'project-zoom-compare-error';
        errorMessage.hidden = true;
        const retryButton = doc.createElement('button');
        retryButton.type = 'button';
        retryButton.className = 'project-zoom-compare-retry';
        retryButton.textContent = '다시 불러오기';
        retryButton.hidden = true;
        retryButton.addEventListener('click', event => {
            event.stopPropagation();
            retryPane(pane);
        });
        viewport.append(image, errorMessage, retryButton);
        element.append(header, viewport);

        const pane = {
            path: imageData.path,
            src: imageData.src,
            name: imageData.name,
            element,
            image,
            viewport,
            panX: 0,
            panY: 0,
            selectedBadge,
            removeButton,
            errorMessage,
            retryButton,
            loaded: false,
            naturalWidth: 0,
            naturalHeight: 0,
            heightRatio: null,
        };
        setStatus(pane, '불러오는 중…');
        image.onload = () => onImageLoad(pane);
        image.onerror = () => onImageError(pane);
        viewport.addEventListener('pointerdown', event => startDrag(pane, event));
        viewport.addEventListener('pointermove', moveDrag);
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
            viewport.addEventListener(type, event => {
                if (drag?.id === event.pointerId) endDrag();
            });
        }
        element.addEventListener('click', event => {
            if (event.target.closest?.('button')) return;
            selectPane(pane);
        });
        element.addEventListener('keydown', event => {
            if (event.target.closest?.('button')) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectPane(pane);
            }
        });
        return pane;
    }

    function openPane(imageData, shouldSelect = true) {
        if (!config || panes.some(pane => pane.path === imageData.path)) return null;
        const compareStage = stage();
        if (!compareStage) return null;
        const pane = createPane(imageData);
        if (synchronized) {
            const selected = panes.find(item => item.path === selectedPath);
            if (selected && Number.isFinite(selected.heightRatio)) pane.heightRatio = selected.heightRatio;
        }
        panes.push(pane);
        compareStage.appendChild(pane.element);
        updateColumns();
        pane.image.src = pane.src;
        if (pane.image.complete && pane.image.naturalWidth > 0 && pane.image.naturalHeight > 0) {
            onImageLoad(pane);
        }
        if (shouldSelect) selectPane(pane);
        renderPicker();
        return pane;
    }

    function removePane(pane) {
        if (panes.length <= 1 || !panes.includes(pane)) return;
        const index = panes.indexOf(pane);
        const wasSelected = pane.path === selectedPath;
        panes.splice(index, 1);
        clearPane(pane);
        updateColumns();
        if (wasSelected) selectedPath = panes[Math.min(index, panes.length - 1)].path;
        refreshPaneSelection();
        renderPicker();
        notifySelection();
        applyHeights();
    }

    function createButton(label, className, onClick) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    function renderPicker() {
        const picker = controls()?.querySelector('.project-zoom-compare-picker');
        if (!picker) return;
        if (!pickerOpen || !config) {
            if (picker.open && typeof picker.close === 'function') picker.close();
            else picker.open = false;
            return;
        }
        if (!picker.open && typeof picker.showModal === 'function') picker.showModal();
        else if (!picker.open) picker.open = true;

        const list = picker.querySelector('.project-zoom-compare-picker-list');
        const status = picker.querySelector('.project-zoom-compare-picker-status');
        const previous = picker.querySelector('.project-zoom-compare-picker-previous');
        const next = picker.querySelector('.project-zoom-compare-picker-next');
        if (!list || !status || !previous || !next) return;

        const available = config.images.filter(image => !panes.some(pane => pane.path === image.path));
        const pageCount = Math.max(1, Math.ceil(available.length / PICKER_PAGE_SIZE));
        pickerPage = clamp(pickerPage, 0, pageCount - 1);
        const pageImages = available.slice(pickerPage * PICKER_PAGE_SIZE, (pickerPage + 1) * PICKER_PAGE_SIZE);
        list.replaceChildren();
        if (pageImages.length) {
            pageImages.forEach(imageData => {
                let button = pickerItemNodes.get(imageData.path);
                if (!button) {
                    button = doc.createElement('button');
                    button.type = 'button';
                    button.className = 'project-zoom-compare-picker-item';
                    button.title = imageData.name;
                    const thumbnail = doc.createElement('img');
                    thumbnail.alt = imageData.name;
                    thumbnail.loading = 'lazy';
                    thumbnail.decoding = 'async';
                    thumbnail.width = 160;
                    thumbnail.height = 160;
                    thumbnail.src = pickerThumbnailSrc(imageData);
                    const name = doc.createElement('span');
                    name.textContent = imageData.name;
                    button.append(thumbnail, name);
                    button.addEventListener('click', () => openPane(imageData));
                    pickerItemNodes.set(imageData.path, button);
                }
                list.appendChild(button);
            });
        } else {
            const empty = doc.createElement('p');
            empty.className = 'project-zoom-compare-picker-empty';
            empty.textContent = config.images.length ? '비교 중인 그림은 모두 추가했습니다.' : '현재 프로젝트에 추가할 그림이 없습니다.';
            list.appendChild(empty);
        }
        status.textContent = `비교 중 ${panes.length} · 추가 가능 ${available.length} · ${pickerPage + 1} / ${pageCount}`;
        previous.disabled = pickerPage === 0;
        next.disabled = pickerPage >= pageCount - 1;
    }

    function togglePicker() {
        if (pickerOpen) {
            closePicker();
            return;
        }
        pickerOpen = true;
        pickerPage = 0;
        renderPicker();
        controls()?.querySelector('.project-zoom-compare-picker-close')?.focus?.();
    }

    function ensureControls() {
        const container = controls();
        if (!container) return;
        container.replaceChildren();
        const actions = doc.createElement('div');
        actions.className = 'project-zoom-compare-actions';
        const addButton = createButton('그림 추가', 'project-zoom-compare-add', () => {
            togglePicker();
        });
        const syncButton = createButton('', 'project-zoom-compare-sync', () => {
            synchronized = !synchronized;
            if (synchronized) matchSelectedHeight();
            refreshControlState();
        });
        const fitButton = createButton('높이 맞춤', 'project-zoom-compare-fit', () => matchSelectedHeight());
        actions.append(addButton, syncButton, fitButton);
        const picker = doc.createElement('dialog');
        picker.className = 'project-zoom-compare-picker';
        picker.addEventListener('cancel', event => {
            event.preventDefault();
            closePicker();
        });
        picker.addEventListener('click', event => event.stopPropagation());
        const pickerHeader = doc.createElement('div');
        pickerHeader.className = 'project-zoom-compare-picker-header';
        const title = doc.createElement('strong');
        title.textContent = '현재 프로젝트 그림';
        const closeButton = createButton('닫기', 'project-zoom-compare-picker-close', () => closePicker());
        closeButton.setAttribute('autofocus', '');
        pickerHeader.append(title, closeButton);
        const list = doc.createElement('div');
        list.className = 'project-zoom-compare-picker-list';
        const footer = doc.createElement('div');
        footer.className = 'project-zoom-compare-picker-footer';
        const status = doc.createElement('span');
        status.className = 'project-zoom-compare-picker-status';
        status.setAttribute('aria-live', 'polite');
        const previous = createButton('이전', 'project-zoom-compare-picker-previous', () => {
            pickerPage -= 1;
            renderPicker();
        });
        const next = createButton('다음', 'project-zoom-compare-picker-next', () => {
            pickerPage += 1;
            renderPicker();
        });
        footer.append(status, previous, next);
        picker.append(pickerHeader, list, footer);
        container.append(actions, picker);
        container._compareSyncButton = syncButton;
        container._compareAddButton = addButton;
        pickerItemNodes = new Map();
        refreshControlState();
    }

    function refreshControlState() {
        const syncButton = controls()?._compareSyncButton;
        if (!syncButton) return;
        syncButton.textContent = synchronized ? '동시 확대' : '개별 확대';
        syncButton.title = synchronized ? '동기 확대 끄기' : '동기 확대 켜기';
        syncButton.setAttribute('aria-pressed', String(synchronized));
    }

    function onWheel(event) {
        if (!active || !layer() || layer().hidden || !panes.length) return;
        const selected = panes.find(pane => pane.path === selectedPath);
        if (!selected?.loaded || !Number.isFinite(selected.heightRatio)) return;
        let delta = Number.isFinite(event.deltaY) ? event.deltaY : 0;
        const {height} = dimensions();
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= Math.max(1, height);
        delta = clamp(delta, -1000, 1000);
        if (!delta) return;
        event.preventDefault();
        const next = clamp(selected.heightRatio * Math.exp(-delta * WHEEL_SPEED), MIN_HEIGHT_RATIO, MAX_HEIGHT_RATIO);
        const targets = synchronized ? panes : [selected];
        targets.forEach(pane => setRatio(pane, next));
    }

    function observeStage() {
        const compareStage = stage();
        if (!compareStage) return;
        if (!stageEventsBound) {
            compareStage.addEventListener('wheel', onWheel, {passive: false});
            stageEventsBound = true;
        }
        if (resizeBound) return;
        if (typeof root.ResizeObserver === 'function') {
            resizeObserver = new root.ResizeObserver(applyHeights);
            resizeObserver.observe(compareStage);
        }
        root.addEventListener?.('resize', applyHeights);
        resizeBound = true;
    }

    function activate() {
        const compareLayer = layer();
        const container = controls();
        const compareStage = stage();
        if (!config || !panes.length || !compareLayer || !container || !compareStage) return false;
        active = true;
        compareLayer.classList.add('project-zoom-comparing');
        container.hidden = false;
        compareStage.hidden = false;
        observeStage();
        applyHeights();
        return true;
    }

    function deactivate() {
        endDrag();
        active = false;
        if (pickerOpen) closePicker(false);
        layer()?.classList.remove('project-zoom-comparing');
        if (controls()) controls().hidden = true;
        if (stage()) stage().hidden = true;
    }

    function prepare(options) {
        deactivate();
        pickerItemNodes.clear();
        clearPanes();
        pickerOpen = false;
        synchronized = false;
        config = null;

        const current = normalizeImage(options?.current);
        if (!current || typeof options?.onSelect !== 'function') {
            if (controls()) controls().replaceChildren();
            return false;
        }
        const imagesByPath = new Map();
        (Array.isArray(options.images) ? options.images : []).forEach(value => {
            const image = normalizeImage(value);
            if (image && !imagesByPath.has(image.path)) imagesByPath.set(image.path, image);
        });
        if (!imagesByPath.has(current.path)) imagesByPath.set(current.path, current);
        config = {images: Array.from(imagesByPath.values()), onSelect: options.onSelect};
        ensureControls();
        selectedPath = current.path;
        openPane(current, false);
        refreshPaneSelection();
        refreshControlState();
        return true;
    }

    function setPinned(value) {
        if (value) return activate();
        deactivate();
        return true;
    }

    function closePicker(restoreFocus = true) {
        pickerOpen = false;
        renderPicker();
        if (restoreFocus) controls()?._compareAddButton?.focus?.();
    }

    function close() {
        deactivate();
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (resizeBound) {
            root.removeEventListener?.('resize', applyHeights);
            resizeBound = false;
        }
        clearPanes();
        config = null;
        pickerOpen = false;
        pickerItemNodes.clear();
        synchronized = false;
        if (controls()) controls().replaceChildren();
    }

    root.ProjectZoomCompare = {
        prepare,
        setPinned,
        isActive: () => active,
        isPicking: () => active && pickerOpen,
        closePicker,
        close,
        getSelectedPath: () => selectedPath,
    };
})(window);
