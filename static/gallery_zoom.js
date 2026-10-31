let galleryZoomImages = [];
let galleryZoomIndex = -1;
let galleryZoomReturnFocus = null;
let galleryZoomDeleteEnabled = false;
let galleryZoomTagEnabled = false;
let galleryZoomActionBusy = false;
let galleryZoomSession = 0;
let galleryZoomNeedsRefresh = false;
let galleryZoomStatus = '키보드 ← →로 그림을 넘기세요.';

function toggleGalleryZoomActionMode(action) {
    if (action === 'delete') {
        galleryZoomDeleteEnabled = !galleryZoomDeleteEnabled;
        if (!galleryZoomDeleteEnabled && isGalleryTagAssignmentMode && !galleryZoomTagEnabled) {
            isGalleryTagAssignmentMode = false;
            selectedGalleryAssignmentTagId = '';
        }
    } else {
        galleryZoomTagEnabled = !galleryZoomTagEnabled;
        if (!galleryZoomTagEnabled && isGalleryBulkDeleteMode && !galleryZoomDeleteEnabled) {
            isGalleryBulkDeleteMode = false;
            clearGalleryBulkDeleteSelection(false);
        }
    }
    cancelGalleryBulkDeleteBoxSelection();
    updateGalleryBulkDeleteModeUi();
    updateGalleryTagAssignmentModeUi();
}

function updateGalleryZoomModeUi() {
    for (const [id, enabled, label] of [
        ['galleryZoomDeleteModeBtn', galleryZoomDeleteEnabled, '↓ 화살표 삭제'],
        ['galleryZoomTagModeBtn', galleryZoomTagEnabled, '↑ 화살표 태그']
    ]) {
        const button = document.getElementById(id);
        if (!button) continue;
        button.textContent = `${label} ${enabled ? 'ON' : 'OFF'}`;
        button.setAttribute('aria-pressed', String(enabled));
        button.classList.toggle('active', enabled);
    }
    if (galleryZoomDeleteEnabled || galleryZoomTagEnabled) {
        const count = document.getElementById('galleryBulkDeleteCountText');
        if (count && isGalleryBulkDeleteMode) count.textContent = galleryZoomDeleteEnabled
            ? '그림 클릭 → 확대 보기 · ↓ 휴지통으로 보내고 다음'
            : '그림 클릭 → 확대 보기 · 화살표 삭제를 켜면 ↓로 휴지통 이동';
    }
    updateGalleryZoomUi();
}

function updateGalleryZoomUi() {
    const toolbar = document.getElementById('galleryZoomToolbar');
    if (!toolbar) return;
    const pinButton = document.getElementById('galleryZoomPinBtn');
    if (pinButton) pinButton.disabled = galleryZoomActionBusy;
    const item = galleryZoomImages[galleryZoomIndex];
    const path = normalizeGalleryPathKey(item?.path || '');
    const projectView = window.Daki?.isProjectView?.();
    const comparing = Boolean(window.ProjectZoomCompare?.isActive());
    const validTag = selectedGalleryAssignmentTagId === 'NONE' || Boolean(getGalleryTagDef(selectedGalleryAssignmentTagId));
    const canTag = Boolean(!projectView && galleryZoomTagEnabled && item && validTag);
    const referencedStyle = /^__daki_(shared|tests|personal)__\//.test(path);
    const canDelete = Boolean(galleryZoomDeleteEnabled && item && !path.startsWith('_TRASH/') && !referencedStyle);
    const tag = getGalleryTagDef(selectedGalleryAssignmentTagId);

    let dakiTagMode = document.getElementById('galleryZoomDakiTagModeBtn');
    if (!dakiTagMode && !projectView && (referencedStyle || window.Daki?.isActive())) {
        dakiTagMode = document.createElement('button');
        dakiTagMode.id = 'galleryZoomDakiTagModeBtn';
        dakiTagMode.type = 'button';
        dakiTagMode.onclick = () => {
            if (!isGalleryTagAssignmentMode) toggleGalleryTagAssignmentMode();
            toggleGalleryZoomActionMode('tag');
            document.getElementById('zoomLayer').focus({preventScroll: true});
        };
        toolbar.querySelector('.gallery-zoom-heading').appendChild(dakiTagMode);
    }
    if (dakiTagMode) {
        dakiTagMode.hidden = projectView || (!referencedStyle && !window.Daki?.isActive());
        dakiTagMode.textContent = `🏷️ 확대 태그 ${galleryZoomTagEnabled ? 'ON' : 'OFF'}`;
        dakiTagMode.setAttribute('aria-pressed', String(galleryZoomTagEnabled));
    }

    document.getElementById('galleryZoomPosition').textContent = item ? `${galleryZoomIndex + 1} / ${galleryZoomImages.length}` : '미리보기';
    document.getElementById('galleryZoomFileName').textContent = item ? getImageFileName(path) : '';
    document.getElementById('galleryZoomTagPicker').hidden = projectView || !galleryZoomTagEnabled;
    const select = document.getElementById('galleryZoomTagSelect');
    select.innerHTML = '<option value="">태그를 선택하세요</option><option value="NONE">태그 제거</option>' +
        galleryTagDefs.map((definition, index) => `<option value="${escapeHtml(definition.id)}">${escapeHtml(definition.type === 'text' ? definition.value : `그림 태그 ${index + 1}`)}</option>`).join('');
    select.value = selectedGalleryAssignmentTagId;
    select.disabled = galleryZoomActionBusy;
    document.getElementById('galleryZoomTagPreview').innerHTML = tag ? renderGalleryTagIcon(tag) : '';

    const tagAction = document.getElementById('galleryZoomTagAction');
    tagAction.hidden = !!projectView;
    tagAction.disabled = !canTag || galleryZoomActionBusy;
    tagAction.querySelector('span').textContent = !galleryZoomTagEnabled ? '화살표 태그 꺼짐' :
        !validTag ? '먼저 태그를 선택하세요' :
        `${getGalleryTagAssignmentLabel(selectedGalleryAssignmentTagId)} · 적용 후 다음`;
    const deleteAction = document.getElementById('galleryZoomDeleteAction');
    deleteAction.disabled = !canDelete || galleryZoomActionBusy;
    deleteAction.querySelector('span').textContent = !galleryZoomDeleteEnabled ? '화살표 삭제 꺼짐' :
        referencedStyle ? '그림체 원본 보관' : path.startsWith('_TRASH/') ? '이미 휴지통에 있는 그림' : '휴지통으로 보내고 다음';
    if (comparing) {
        tagAction.disabled = true;
        deleteAction.disabled = true;
    }
    document.getElementById('galleryZoomActionStatus').textContent = comparing
        ? '그림 클릭으로 선택 · 드래그로 이동 · 휠로 확대·축소' : galleryZoomStatus;
}

function prepareGalleryProjectZoom(src) {
    if (!window.ProjectZoomCompare || !window.Daki?.isProjectView?.()) return;
    const path = normalizeGalleryPathKey(src);
    const images = [];
    const seen = new Set();
    for (const grid of document.querySelectorAll('#dakiContent .flex-masonry')) {
        const thumbnails = new Map();
        for (const image of grid.querySelectorAll?.('img.zoomable') || []) {
            const key = normalizeGalleryPathKey(image.closest('[data-path]')?.dataset.path || '');
            const thumbnailSrc = image.currentSrc || image.src;
            if (key && /[?&]preview=/.test(thumbnailSrc)) thumbnails.set(key, thumbnailSrc);
        }
        for (const item of grid.galleryZoomImages || []) {
            const key = normalizeGalleryPathKey(item.path);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            images.push({path: key, src: getGalleryImageSrc(key), name: getImageFileName(key),
                thumbnailSrc: thumbnails.get(key)});
        }
    }
    const current = {path, src, name: getImageFileName(path)};
    if (!seen.has(path)) images.push(current);
    window.ProjectZoomCompare.prepare({
        images,
        current,
        onSelect: selectedPath => {
            galleryZoomImages = images;
            galleryZoomIndex = images.findIndex(item => item.path === selectedPath);
            document.getElementById('zoomImg').src = getGalleryImageSrc(selectedPath);
            updateGalleryZoomUi();
        },
    });
}

function showGalleryZoomImage() {
    const item = galleryZoomImages[galleryZoomIndex];
    if (!item) return;
    window.GalleryZoomView?.reset();
    document.getElementById('zoomImg').src = getGalleryImageSrc(item.path);
    prepareGalleryProjectZoom(getGalleryImageSrc(item.path));
    if (window.GalleryZoomView?.isPinned()) window.ProjectZoomCompare?.setPinned(true);
    updateGalleryZoomUi();
}

function openZoom(src) {
    window.ProjectZoomCompare?.close();
    window.GalleryZoomView?.init();
    window.GalleryZoomView?.reset(true);
    galleryZoomSession += 1;
    galleryZoomStatus = window.Daki?.isProjectView?.() ? '← → 이동 · 켜진 기능은 ↓ 휴지통 · 처리 성공 후 다음 그림'
        : '← → 이동 · 켜진 기능은 ↑ 태그 / ↓ 휴지통 · 처리 성공 후 다음 그림';
    const path = normalizeGalleryPathKey(src);
    galleryZoomImages = [];
    galleryZoomIndex = -1;
    // DOM column order differs from image order in the masonry layout.
    for (const grid of [...document.querySelectorAll('#content .flex-masonry'), ...document.querySelectorAll('#dakiContent .flex-masonry')]) {
        const images = grid.galleryZoomImages || [];
        const index = images.findIndex(item => normalizeGalleryPathKey(item.path) === path);
        if (index < 0) continue;
        galleryZoomImages = images.slice();
        galleryZoomIndex = index;
        break;
    }
    const layer = document.getElementById('zoomLayer');
    if (layer.style.display !== 'flex') galleryZoomReturnFocus = document.activeElement;
    document.getElementById('zoomImg').src = src;
    layer.style.display = 'flex';
    document.body?.classList.add('gallery-zoom-open');
    prepareGalleryProjectZoom(src);
    updateGalleryZoomUi();
    layer.focus({preventScroll: true});
}

function closeZoom() {
    window.ProjectZoomCompare?.close();
    window.GalleryZoomView?.reset(true);
    galleryZoomSession += 1;
    document.getElementById('zoomLayer').style.display = 'none';
    document.getElementById('zoomImg').src = '';
    galleryZoomImages = [];
    galleryZoomIndex = -1;
    if (galleryZoomReturnFocus?.isConnected) galleryZoomReturnFocus.focus({preventScroll: true});
    galleryZoomReturnFocus = null;
    document.body?.classList.remove('gallery-zoom-open');
    if (galleryZoomNeedsRefresh) {
        galleryZoomNeedsRefresh = false;
        loadData();
    }
}

async function runGalleryZoomAction(action) {
    if (window.ProjectZoomCompare?.isActive()) return;
    if (action === 'tag' && window.Daki?.isProjectView?.()) return;
    if (galleryZoomActionBusy || document.getElementById('zoomLayer')?.style.display !== 'flex') return;
    const item = galleryZoomImages[galleryZoomIndex];
    if (!item) return;
    const path = normalizeGalleryPathKey(item.path);
    const tagId = selectedGalleryAssignmentTagId;
    if (action === 'tag' && (!galleryZoomTagEnabled || (tagId !== 'NONE' && !getGalleryTagDef(tagId)))) {
        galleryZoomStatus = galleryZoomTagEnabled ? '↑로 붙일 태그를 먼저 선택하세요.' : '태그 모드에서 ↑ 화살표 태그를 켜세요.';
        updateGalleryZoomUi();
        return;
    }
    if (action === 'delete' && (!galleryZoomDeleteEnabled || path.startsWith('_TRASH/') || /^__daki_(shared|tests|personal)__\//.test(path))) return;
    if (!['tag', 'delete'].includes(action)) return;

    const session = galleryZoomSession;
    galleryZoomActionBusy = true;
    galleryZoomStatus = action === 'delete' ? '휴지통으로 보내는 중…' : '태그를 적용하는 중…';
    updateGalleryZoomUi();
    try {
        if (action === 'delete') {
            const {response, result, cancelled} = await Daki.deleteRequest('/api/gallery/trash_image', {path});
            if (cancelled) {
                galleryZoomStatus = '삭제를 취소했습니다. 현재 그림을 유지합니다.';
                return;
            }
            if (!response.ok || result.status !== 'success') throw new Error(result.message || '휴지통 이동 실패');
            galleryZoomNeedsRefresh = true;
            selDeletes.delete(path);
            for (const [key, value] of selThumbs) {
                if (normalizeGalleryPathKey(value.path) === path) selThumbs.delete(key);
            }
        } else {
            const saved = await updateGalleryImageTag(path, tagId === 'NONE' ? '' : tagId);
            if (!saved) throw new Error('태그를 저장하지 못했습니다. 다시 시도하세요.');
            item.gallery_tag = tagId === 'NONE' ? '' : tagId;
            galleryZoomNeedsRefresh = true;
        }
        if (session !== galleryZoomSession) {
            if (galleryZoomNeedsRefresh && document.getElementById('zoomLayer').style.display !== 'flex') {
                galleryZoomNeedsRefresh = false;
                loadData();
            }
            return;
        }
        galleryZoomStatus = action === 'delete' ? '휴지통으로 보냈습니다.' : '태그를 적용했습니다.';
        if (action === 'delete' || (!window.Daki?.isActive() && !imageMatchesGalleryTagFilter(item))) {
            galleryZoomImages.splice(galleryZoomIndex, 1);
            galleryZoomIndex = Math.min(galleryZoomIndex, galleryZoomImages.length - 1);
        } else if (galleryZoomIndex < galleryZoomImages.length - 1) {
            galleryZoomIndex += 1;
        } else {
            galleryZoomStatus += ' 마지막 그림입니다.';
        }
        if (!galleryZoomImages.length) {
            closeZoom();
            showToast('모든 그림을 확인했습니다.');
        } else {
            showGalleryZoomImage();
        }
    } catch (error) {
        if (session === galleryZoomSession) galleryZoomStatus = `처리 실패: ${error.message || error} · 현재 그림을 유지합니다.`;
    } finally {
        galleryZoomActionBusy = false;
        updateGalleryZoomUi();
    }
}

function handleGalleryZoomKeydown(event) {
    if (document.getElementById('zoomLayer')?.style.display !== 'flex') return;
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target?.isContentEditable || event.target?.closest?.('input, textarea, select')) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
        if (window.ProjectZoomCompare?.isPicking()) {
            window.ProjectZoomCompare.closePicker();
            return;
        }
        closeZoom();
        return;
    }
    if (window.ProjectZoomCompare?.isActive()) return;
    if (galleryZoomActionBusy) return;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.repeat) return;
        return runGalleryZoomAction(event.key === 'ArrowUp' ? 'tag' : 'delete');
    }
    if (galleryZoomIndex < 0) return;
    const nextIndex = galleryZoomIndex + (event.key === 'ArrowRight' ? 1 : -1);
    if (nextIndex < 0 || nextIndex >= galleryZoomImages.length) return;
    galleryZoomIndex = nextIndex;
    galleryZoomStatus = window.Daki?.isProjectView?.() ? '← → 이동 · ↓ 휴지통' : '← → 이동 · ↑ 선택 태그 적용 · ↓ 휴지통';
    showGalleryZoomImage();
}

document.addEventListener('keydown', handleGalleryZoomKeydown, true);
