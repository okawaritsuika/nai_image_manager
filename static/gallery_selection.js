// Gallery feature functions; shared state is declared in index.js.
function updateGalleryMultiFolderSelectionUi() {
    const count = galleryMultiFolderSelection.size;
    const imageCount = [...galleryMultiFolderSelection.values()].reduce((sum, folder) => {
        const value = Number(folder?.total_images);
        return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
    document.body.classList.toggle('gallery-multi-folder-selection-mode', count > 0);

    const countText = document.getElementById('galleryMultiFolderSelectionCount');
    if (countText) countText.innerText = `${count}개 폴더 · 그림 ${imageCount}장 선택됨`;

    document.querySelectorAll('.gallery-multi-folder-selectable').forEach((card) => {
        const key = normalizeGalleryPathKey(card.dataset.multiFolderPath || '');
        card.classList.toggle('multi-folder-selected', galleryMultiFolderSelection.has(key));
    });
}

function clearGalleryMultiFolderSelection(updateUi = true) {
    if (galleryFolderOpenTimer) {
        clearTimeout(galleryFolderOpenTimer);
        galleryFolderOpenTimer = null;
    }

    galleryMultiFolderSelection.clear();
    cancelGalleryMultiFolderBoxSelection();
    closeGalleryMultiFolderContextMenu();

    if (updateUi) updateGalleryMultiFolderSelectionUi();
    else document.body.classList.remove('gallery-multi-folder-selection-mode');
}

function toggleGalleryMultiFolder(folder, element = null) {
    const key = getGalleryMultiFolderKey(folder);
    if (!key) return;

    if (galleryMultiFolderSelection.has(key)) {
        galleryMultiFolderSelection.delete(key);
    } else {
        galleryMultiFolderSelection.set(key, folder);
    }

    if (element) {
        element.classList.toggle('multi-folder-selected', galleryMultiFolderSelection.has(key));
    }

    closeGalleryMultiFolderContextMenu();
    updateGalleryMultiFolderSelectionUi();
}

function selectGalleryMultiFolderElement(node) {
    const key = normalizeGalleryPathKey(node?.dataset?.multiFolderPath || '');
    if (!key || galleryMultiFolderSelection.has(key)) return;

    const currentNode = currentPath[currentPath.length - 1];
    const folder = node?.galleryMultiFolderNode ||
        (currentNode?.folders || []).find((item) => getGalleryMultiFolderKey(item) === key);
    if (!folder) return;

    galleryMultiFolderSelection.set(key, folder);
    node.classList.add('multi-folder-selected');
}

function selectAllGalleryMultiFolderElements() {
    if (!galleryDesignSettings.multiFolderSelectionEnabled || isGalleryBulkDeleteMode || isGalleryTagAssignmentMode) return;

    const nodes = document.querySelectorAll('.gallery-multi-folder-selectable');
    if (!nodes.length) return;

    nodes.forEach((node) => selectGalleryMultiFolderElement(node));
    updateGalleryMultiFolderSelectionUi();
}

function beginGalleryMultiFolderBoxSelection(event) {
    if (!galleryDesignSettings.multiFolderSelectionEnabled || isGalleryBulkDeleteMode || isGalleryTagAssignmentMode) return;
    if (event.button !== 0 || !event.target.closest?.('#content')) return;
    if (!document.querySelector('.gallery-multi-folder-selectable')) return;
    if (event.target.closest('button, input, select, textarea, a, .gallery-multi-folder-selection-bar')) return;

    galleryMultiFolderSelectionBoxState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        moved: false,
        box: null
    };
}

function updateGalleryMultiFolderBoxSelection(event) {
    const state = galleryMultiFolderSelectionBoxState;
    if (!state || state.pointerId !== event.pointerId) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.moved && Math.hypot(dx, dy) < 6) return;

    if (!state.box) {
        state.box = document.createElement('div');
        state.box.className = 'gallery-multi-folder-selection-box';
        document.body.appendChild(state.box);
    }

    state.moved = true;
    state.currentX = event.clientX;
    state.currentY = event.clientY;

    const left = Math.min(state.startX, state.currentX);
    const top = Math.min(state.startY, state.currentY);
    const width = Math.abs(state.currentX - state.startX);
    const height = Math.abs(state.currentY - state.startY);

    state.box.style.left = `${left}px`;
    state.box.style.top = `${top}px`;
    state.box.style.width = `${width}px`;
    state.box.style.height = `${height}px`;

    const boxRect = state.box.getBoundingClientRect();
    document.querySelectorAll('.gallery-multi-folder-selectable').forEach((node) => {
        const rect = node.getBoundingClientRect();
        const hit = !(
            rect.right < boxRect.left ||
            rect.left > boxRect.right ||
            rect.bottom < boxRect.top ||
            rect.top > boxRect.bottom
        );

        if (hit) selectGalleryMultiFolderElement(node);
    });

    updateGalleryMultiFolderSelectionUi();
    event.preventDefault();
}

function finishGalleryMultiFolderBoxSelection(event) {
    const state = galleryMultiFolderSelectionBoxState;
    if (!state || state.pointerId !== event.pointerId) return;

    state.box?.remove();
    if (state.moved) {
        galleryMultiFolderSuppressNextClick = true;
        setTimeout(() => {
            galleryMultiFolderSuppressNextClick = false;
        }, 160);
    }

    galleryMultiFolderSelectionBoxState = null;
}

function cancelGalleryMultiFolderBoxSelection() {
    galleryMultiFolderSelectionBoxState?.box?.remove();
    galleryMultiFolderSelectionBoxState = null;
}

function openGalleryMultiFolderContextMenu(event) {
    event.preventDefault();
    event.stopPropagation();

    const menu = document.getElementById('galleryMultiFolderContextMenu');
    if (!menu || !galleryMultiFolderSelection.size) return;

    const button = document.getElementById('galleryMultiFolderOpenBtn');
    if (button) button.innerText = `📂 선택한 ${galleryMultiFolderSelection.size}개 폴더 열기`;

    menu.style.display = 'block';
    const margin = 12;
    const menuWidth = menu.offsetWidth || 240;
    const menuHeight = menu.offsetHeight || 48;
    menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin))}px`;
    menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin))}px`;
}

function closeGalleryMultiFolderContextMenu() {
    const menu = document.getElementById('galleryMultiFolderContextMenu');
    if (menu) menu.style.display = 'none';
}

function getGalleryBulkDeleteFolderKey(folder) {
    return normalizeGalleryPathKey(folder?.path || folder?.name || '');
}

function updateGalleryBulkDeleteModeUi() {
    document.body.classList.toggle('gallery-bulk-delete-mode', isGalleryBulkDeleteMode);

    const btn = document.getElementById('galleryBulkDeleteModeBtn');
    if (btn) {
        btn.classList.toggle('active', isGalleryBulkDeleteMode);
        btn.innerText = isGalleryBulkDeleteMode ? '삭제 모드 ON' : '삭제 모드';
    }

    updateGalleryBulkDeleteBar();
    refreshGalleryBulkDeleteSelectionStyles();
    updateCounter();
    updateGalleryZoomModeUi();
}

function toggleGalleryBulkDeleteMode() {
    isGalleryBulkDeleteMode = !isGalleryBulkDeleteMode;

    if (isGalleryBulkDeleteMode) {
        clearGalleryMultiFolderSelection();
    }

    if (isGalleryBulkDeleteMode && isGalleryTagAssignmentMode && !galleryZoomTagEnabled) {
        isGalleryTagAssignmentMode = false;
        selectedGalleryAssignmentTagId = '';
        updateGalleryTagAssignmentModeUi();
    }

    if (!isGalleryBulkDeleteMode) {
        galleryZoomDeleteEnabled = false;
        clearGalleryBulkDeleteSelection(false);
    }

    updateGalleryBulkDeleteModeUi();
}

function updateGalleryBulkDeleteBar() {
    const text = document.getElementById('galleryBulkDeleteCountText');
    if (!text) return;

    const folderCount = galleryBulkDeleteFolders.size;
    const imageCount = selDeletes.size;

    if (!folderCount && !imageCount) {
        text.innerText = '선택 없음';
        return;
    }

    text.innerText = `폴더 ${folderCount}개 / 이미지 ${imageCount}장 선택됨`;
}

function clearGalleryBulkDeleteSelection(updateUi = true) {
    galleryBulkDeleteFolders.clear();
    selDeletes.clear();

    if (updateUi) {
        updateGalleryBulkDeleteModeUi();
        refreshGrid();
    }
}

function toggleGalleryBulkDeleteFolder(folder, element = null) {
    const key = getGalleryBulkDeleteFolderKey(folder);
    if (!key) return;

    if (galleryBulkDeleteFolders.has(key)) {
        galleryBulkDeleteFolders.delete(key);
    } else {
        galleryBulkDeleteFolders.set(key, {
            path: key,
            name: folder?.name || key
        });
    }

    if (element) {
        element.classList.toggle('bulk-delete-selected', galleryBulkDeleteFolders.has(key));
    }

    updateGalleryBulkDeleteBar();
    updateCounter();
}

function toggleGalleryBulkDeleteImage(imagePath, folderId, folderKey, fileName, boxId) {
    const cleanPath = normalizeGalleryPathKey(imagePath);
    const box = document.getElementById(boxId);

    if (!cleanPath) return;

    if (selDeletes.has(cleanPath)) {
        selDeletes.delete(cleanPath);
        if (box) {
            box.classList.remove('selected');
            box.classList.remove('bulk-delete-selected');
        }
    } else {
        selDeletes.set(cleanPath, {
            folderId,
            folderKey,
            fileName
        });

        if (box) {
            box.classList.add('selected');
            box.classList.add('bulk-delete-selected');
        }
    }

    updateGalleryBulkDeleteBar();
    updateCounter();
}

function handleGalleryImageCardClick(event, imagePath, folderId, folderKey, fileName, boxId, imgSrc) {
    if (event.defaultPrevented || consumeGalleryRadialTagClick(event)) {
        return;
    }

    if (galleryZoomDeleteEnabled || galleryZoomTagEnabled) {
        if (galleryBulkDeleteSuppressNextClick) return;
        event.preventDefault();
        event.stopPropagation();
        openZoom(imgSrc);
        return;
    }

    if (isGalleryBulkDeleteMode) {
        event.preventDefault();
        event.stopPropagation();

        if (galleryBulkDeleteSuppressNextClick) {
            return;
        }

        toggleGalleryBulkDeleteImage(imagePath, folderId, folderKey, fileName, boxId);
        return;
    }

    if (isGalleryTagAssignmentMode) {
        event.preventDefault();
        event.stopPropagation();
        applySelectedGalleryTagToImage(imagePath);
        return;
    }

    openZoom(imgSrc);
}

function refreshGalleryBulkDeleteSelectionStyles() {
    document.querySelectorAll('.gallery-bulk-delete-selectable[data-bulk-delete-type]').forEach((node) => {
        const type = node.dataset.bulkDeleteType;
        const path = normalizeGalleryPathKey(node.dataset.bulkDeletePath || '');

        if (type === 'folder') {
            node.classList.toggle('bulk-delete-selected', galleryBulkDeleteFolders.has(path));
            return;
        }

        if (type === 'image') {
            const selected = selDeletes.has(path);
            node.classList.toggle('selected', selected);
            node.classList.toggle('bulk-delete-selected', selected);
        }
    });
}

function selectGalleryBulkDeleteElement(node) {
    if (!node || !node.dataset) return;

    const type = node.dataset.bulkDeleteType;
    const path = normalizeGalleryPathKey(node.dataset.bulkDeletePath || '');

    if (!path) return;

    if (type === 'folder') {
        galleryBulkDeleteFolders.set(path, {
            path,
            name: node.dataset.bulkDeleteName || path
        });
        node.classList.add('bulk-delete-selected');
        return;
    }

    if (type === 'image') {
        selDeletes.set(path, {
            folderId: node.dataset.bulkDeleteFolderId || '',
            folderKey: node.dataset.bulkDeleteFolderKey || '',
            fileName: node.dataset.bulkDeleteFileName || path.split('/').pop()
        });

        node.classList.add('selected');
        node.classList.add('bulk-delete-selected');
    }
}

function beginGalleryBulkDeleteBoxSelection(event) {
    if (window.Daki?.isActive()) return;
    if (!isGalleryBulkDeleteMode) return;
    if (galleryZoomDeleteEnabled || galleryZoomTagEnabled) return;
    if (event.target.closest('#zoomLayer')) return;
    if (event.button !== 0) return;

    if (
        event.target.closest('button, input, select, textarea, a') ||
        event.target.closest('.gallery-bulk-delete-bar') ||
        event.target.closest('.gallery-tag-picker') ||
        event.target.closest('.gallery-image-tag-btn')
    ) {
        return;
    }

    const selectable = event.target.closest('.gallery-bulk-delete-selectable');

    galleryBulkDeleteSelectionBoxState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        moved: false,
        box: null,
        startedOnSelectable: Boolean(selectable)
    };

    event.preventDefault();

    try {
        event.target.setPointerCapture?.(event.pointerId);
    } catch (e) {}
}

function updateGalleryBulkDeleteBoxSelection(event) {
    const state = galleryBulkDeleteSelectionBoxState;
    if (!state || state.pointerId !== event.pointerId) return;

    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;

    if (!state.moved && Math.hypot(dx, dy) < 6) {
        return;
    }

    if (!state.box) {
        const box = document.createElement('div');
        box.className = 'gallery-bulk-delete-selection-box';
        document.body.appendChild(box);
        state.box = box;
    }

    state.moved = true;
    state.currentX = event.clientX;
    state.currentY = event.clientY;

    const left = Math.min(state.startX, state.currentX);
    const top = Math.min(state.startY, state.currentY);
    const width = Math.abs(state.currentX - state.startX);
    const height = Math.abs(state.currentY - state.startY);

    state.box.style.left = `${left}px`;
    state.box.style.top = `${top}px`;
    state.box.style.width = `${width}px`;
    state.box.style.height = `${height}px`;

    const boxRect = state.box.getBoundingClientRect();

    document.querySelectorAll('.gallery-bulk-delete-selectable[data-bulk-delete-type]').forEach((node) => {
        const rect = node.getBoundingClientRect();

        const hit = !(
            rect.right < boxRect.left ||
            rect.left > boxRect.right ||
            rect.bottom < boxRect.top ||
            rect.top > boxRect.bottom
        );

        if (hit) {
            selectGalleryBulkDeleteElement(node);
        }
    });

    updateGalleryBulkDeleteBar();
    updateCounter();

    event.preventDefault();
}

function finishGalleryBulkDeleteBoxSelection(event) {
    const state = galleryBulkDeleteSelectionBoxState;
    if (!state || state.pointerId !== event.pointerId) return;

    if (state.box) {
        state.box.remove();
    }

    if (state.moved) {
        galleryBulkDeleteSuppressNextClick = true;
        setTimeout(() => {
            galleryBulkDeleteSuppressNextClick = false;
        }, 160);
    }

    galleryBulkDeleteSelectionBoxState = null;
}

function cancelGalleryBulkDeleteBoxSelection() {
    if (galleryBulkDeleteSelectionBoxState?.box) {
        galleryBulkDeleteSelectionBoxState.box.remove();
    }

    galleryBulkDeleteSelectionBoxState = null;
}

function openGalleryBulkDeleteConfirm() {
    const layer = document.getElementById('galleryBulkDeleteConfirmLayer');
    if (!layer) return;

    const folderCount = galleryBulkDeleteFolders.size;
    const imageCount = selDeletes.size;

    const folderCountEl = document.getElementById('galleryBulkDeleteConfirmFolderCount');
    const imageCountEl = document.getElementById('galleryBulkDeleteConfirmImageCount');

    if (folderCountEl) folderCountEl.innerText = String(folderCount);
    if (imageCountEl) imageCountEl.innerText = String(imageCount);

    layer.style.display = 'flex';
}

function closeGalleryBulkDeleteConfirm() {
    const layer = document.getElementById('galleryBulkDeleteConfirmLayer');
    if (layer) layer.style.display = 'none';
}

function confirmGalleryBulkDeleteSelection() {
    closeGalleryBulkDeleteConfirm();
    applyChanges();
}

function applyGalleryBulkDeleteSelection() {
    const folderCount = galleryBulkDeleteFolders.size;
    const imageCount = selDeletes.size;

    if (!folderCount && !imageCount) {
        showToast('선택된 항목이 없습니다.');
        return;
    }

    openGalleryBulkDeleteConfirm();
}

