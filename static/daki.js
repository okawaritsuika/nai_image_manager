/* Daki library and gallery integration. Images remain in the gallery. */
(function (root) {
    'use strict';
    const sides = {front: '앞면', back: '뒷면'};
    const libraryCovers = {
        dictionary: `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M48 26c-9-7-21-9-34-6v53c13-3 25-1 34 6 9-7 21-9 34-6V20c-13-3-25-1-34 6Z" fill="currentColor" fill-opacity=".055"/><path d="M48 26v53M25 34c5 0 9 1 13 3M25 45c5 0 9 1 13 3M25 56c5 0 9 1 13 3M58 37c4-2 8-3 13-3M58 48c4-2 8-3 13-3M58 59c4-2 8-3 13-3"/></svg>`,
        shared: `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><rect x="16" y="18" width="45" height="54" rx="9" fill="currentColor" fill-opacity=".035" opacity=".6"/><rect x="16" y="18" width="45" height="54" rx="9" opacity=".55"/><rect x="31" y="27" width="49" height="55" rx="10" fill="currentColor" fill-opacity=".055"/><rect x="31" y="27" width="49" height="55" rx="10"/><circle cx="65" cy="42" r="4.5" fill="currentColor" fill-opacity=".24"/><path d="m38 70 11-14 9 10 8-11 8 15"/><path d="M39 71h34" opacity=".48"/></svg>`,
        personal: `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M48 17c-19 0-32 14-32 32s14 33 32 33c8 0 13-4 13-11 0-5-4-8-4-12 0-5 4-9 9-9h6c10 0 15-6 15-15 0-10-17-18-39-18Z" fill="currentColor" fill-opacity=".055"/><circle cx="35" cy="42" r="4.2" fill="currentColor" fill-opacity=".22"/><circle cx="49" cy="32" r="4.2" fill="currentColor" fill-opacity=".22"/><circle cx="65" cy="35" r="4.2" fill="currentColor" fill-opacity=".22"/><circle cx="40" cy="59" r="4.2" fill="currentColor" fill-opacity=".22"/><circle cx="57" cy="57" r="4.2" fill="currentColor" fill-opacity=".22"/></svg>`,
        worldcups: `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M32 22h32l-3 20c-1.4 9-6.5 15-13 16.5V68h10v8H38v-8h10V58.5C41.5 57 36.4 51 35 42l-3-20Z" fill="currentColor" fill-opacity=".07"/><path d="M32 29H22v7c0 8 5.5 13 14 14M64 29h10v7c0 8-5.5 13-14 14"/><path d="m48 31 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L48 31Z" fill="currentColor" fill-opacity=".32"/></svg>`,
    };
    let enabled = false;
    let loaded = false;
    let pageRevision = 0;
    let projectSortMode = 'original';
    let dialogRevision = 0;
    let dialog;
    let dialogSource = null;
    let dialogBusy = false;
    let returnFocus = null;
    let galleryScrollY = 0;
    let canvasPreviews = null;
    let projectReference = null;
    let canvasOpenModal = null;
    let pendingCanvasOpen = null;
    let projectDeleteModal = null;
    let pendingProjectDelete = null;
    const doc = root.document;
    const byId = id => doc.getElementById(id);

    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {
            method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
        return result;
    }

    function projectDateTimestamp(value) {
        if (typeof value !== 'string') return null;
        const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/i);
        if (!match) return null;
        const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
        const year = Number(yearText);
        const month = Number(monthText);
        const day = Number(dayText);
        const hour = hourText === undefined ? 0 : Number(hourText);
        const minute = minuteText === undefined ? 0 : Number(minuteText);
        const second = secondText === undefined ? 0 : Number(secondText);
        const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
            || hour > 23 || minute > 59 || second > 59) return null;
        if (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59)) return null;
        const timestamp = Date.parse(value);
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    function formatProjectDate(value) {
        const timestamp = projectDateTimestamp(value);
        if (timestamp === null) return '알 수 없음';
        const date = new Date(timestamp);
        const pad = number => String(number).padStart(2, '0');
        return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function sortProjectItems(items, mode) {
        const sort = {
            'updated-desc': {field: 'updated_at', direction: -1},
            'updated-asc': {field: 'updated_at', direction: 1},
            'created-desc': {field: 'created_at', direction: -1},
            'created-asc': {field: 'created_at', direction: 1},
        }[mode];
        if (!sort) return [...items];
        return items.map((item, index) => {
            return {item, index, timestamp: projectDateTimestamp(item[sort.field])};
        }).sort((a, b) => {
            if (a.timestamp === null) return b.timestamp === null ? a.index - b.index : 1;
            if (b.timestamp === null) return -1;
            return sort.direction * (a.timestamp - b.timestamp) || a.index - b.index;
        }).map(entry => entry.item);
    }

    function projectDateBlock(record) {
        const dates = element('div', 'daki-project-dates');
        dates.append(
            element('span', 'daki-project-date-label', '생성'),
            element('span', 'daki-project-date-value', formatProjectDate(record.created_at)),
            element('span', 'daki-project-date-label', '수정'),
            element('span', 'daki-project-date-value', formatProjectDate(record.updated_at)),
        );
        return dates;
    }

    function projectDeleteButton({projectId, itemId, itemName, side, kind}) {
        const isCanvas = kind === 'canvas';
        const button = element('button', 'gallery-card-action-btn daki-project-delete', isCanvas ? '캔버스 삭제' : '그림 삭제');
        button.replaceChildren(element('span', 'daki-card-action-label', button.textContent));
        button.dataset.compactIcon = '🗑';
        button.setAttribute('aria-label', isCanvas ? '캔버스 삭제' : '그림 삭제');
        const revision = pageRevision;
        let busy = false;
        button.type = 'button';
        button.title = isCanvas
            ? '캔버스 삭제: 저장된 레이어·마스크·프롬프트를 삭제합니다.'
            : '그림 삭제: 프로젝트에서 제거하고 원본 그림 파일과 저장된 메타데이터를 영구 삭제합니다.';
        const sameProjectView = () => isProjectView()
            && new URLSearchParams(root.location.hash.slice(1)).get('project') === String(projectId);
        const current = () => revision === pageRevision && button.isConnected && sameProjectView();
        button.onclick = async () => {
            if (busy || !current()) return;
            busy = true;
            const base = `/api/daki/projects/${encodeURIComponent(projectId)}`;
            let warning = '';
            try {
                const accepted = await showProjectDeleteModal({
                    opener: button, projectId, itemName, side, kind, current,
                });
                if (!accepted || !current()) return;
                button.disabled = true;
                if (isCanvas) {
                    await api(`${base}/canvases/${encodeURIComponent(itemId)}`, 'DELETE');
                } else {
                    const reply = await deleteRequest(
                        `${base}/candidates/${encodeURIComponent(itemId)}/delete`,
                        {},
                        root.fetch.bind(root),
                        async message => {
                            if (!current()) return false;
                            button.disabled = false;
                            const confirmed = await showProjectDeleteModal({
                                opener: button, projectId, itemName, side, kind,
                                warningMessage: message, current,
                            });
                            const stillCurrent = current();
                            if (confirmed && stillCurrent) button.disabled = true;
                            return confirmed && stillCurrent;
                        },
                    );
                    if (reply.cancelled) return;
                    if (!reply.response.ok || reply.result.status !== 'success') {
                        throw new Error(reply.result.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
                    }
                    warning = reply.result.warning || '';
                }
                if (current()) {
                    await renderPage();
                    if (warning && sameProjectView()) byId('dakiPageStatus').textContent = warning;
                }
            } catch (error) {
                if (current()) byId('dakiPageStatus').textContent = error.message;
            } finally {
                if (current()) {
                    busy = false;
                    button.disabled = false;
                }
            }
        };
        return button;
    }

    function ensureProjectDeleteModal() {
        if (projectDeleteModal) return projectDeleteModal;
        const dialog = element('dialog', 'daki-dialog daki-project-delete-dialog');
        dialog.id = 'dakiProjectDeleteDialog';
        dialog.setAttribute('aria-labelledby', 'dakiProjectDeleteTitle');
        dialog.setAttribute('aria-describedby', 'dakiProjectDeleteDescription');
        const header = element('header', 'daki-project-delete-header');
        const title = element('h2', 'daki-project-delete-title');
        title.id = 'dakiProjectDeleteTitle';
        const close = element('button', 'daki-project-delete-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '닫기');
        header.append(title, close);
        const body = element('div', 'daki-project-delete-body');
        const selection = element('div', 'daki-project-delete-selection');
        const side = element('span', 'daki-project-delete-side');
        const name = element('strong', 'daki-project-delete-name');
        selection.append(side, name);
        const description = element('p', 'daki-project-delete-description');
        description.id = 'dakiProjectDeleteDescription';
        body.append(selection, description);
        const actions = element('footer', 'daki-project-delete-actions');
        const cancel = element('button', 'daki-project-delete-cancel', '취소');
        cancel.type = 'button';
        const confirm = element('button', 'daki-primary daki-project-delete-confirm');
        confirm.type = 'button';
        actions.append(cancel, confirm);
        dialog.append(header, body, actions);
        doc.body.appendChild(dialog);

        confirm.onclick = event => {
            if (event.defaultPrevented) return;
            const pending = pendingProjectDelete;
            if (!dialog.open || !pending || pending.revision !== pageRevision
                || !pending.opener.isConnected || !pending.current()) {
                event.preventDefault();
                closeProjectDeleteModal(false);
                return;
            }
            closeProjectDeleteModal(true, false);
        };
        close.onclick = () => closeProjectDeleteModal(false);
        cancel.onclick = () => closeProjectDeleteModal(false);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            closeProjectDeleteModal(false);
        });
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') event.stopPropagation();
        });
        dialog.addEventListener('close', () => {
            if (dialog.open) return;
            if (pendingProjectDelete) closeProjectDeleteModal(false);
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) closeProjectDeleteModal(false);
        });
        projectDeleteModal = {dialog, title, side, name, description, cancel, confirm};
        return projectDeleteModal;
    }

    function showProjectDeleteModal({opener, projectId, itemName, side, kind, warningMessage, current}) {
        if (!current()) return Promise.resolve(false);
        if (pendingProjectDelete) closeProjectDeleteModal(false);
        const modal = ensureProjectDeleteModal();
        const isWarning = warningMessage !== undefined;
        modal.title.textContent = isWarning
            ? '사용 중인 그림을 삭제할까요?'
            : kind === 'canvas' ? '캔버스를 삭제할까요?' : '그림을 삭제할까요?';
        modal.side.textContent = sides[side] || side;
        modal.name.textContent = itemName;
        modal.description.textContent = warningMessage !== undefined
            ? warningMessage
            : kind === 'canvas'
                ? '저장된 레이어·마스크·프롬프트를 삭제합니다. 원본 그림과 이미 내보낸 결과는 유지됩니다.'
                : '프로젝트에서 제거하고 원본 그림 파일과 함께 저장된 메타데이터를 영구 삭제합니다. 되돌릴 수 없습니다. 다른 프로젝트나 캔버스에서 이 그림을 사용하는 경우 연결이 끊길 수 있습니다.';
        modal.description.classList.toggle('daki-project-delete-warning', isWarning);
        modal.confirm.textContent = isWarning ? '그래도 삭제' : kind === 'canvas' ? '캔버스 삭제' : '그림 삭제';
        return new Promise(resolve => {
            pendingProjectDelete = {opener, projectId, resolve, current, revision: pageRevision};
            if (!modal.dialog.open) modal.dialog.showModal();
            modal.cancel.focus({preventScroll: true});
        });
    }

    function closeProjectDeleteModal(accepted, restoreFocus = true) {
        const pending = pendingProjectDelete;
        pendingProjectDelete = null;
        if (projectDeleteModal?.dialog.open) projectDeleteModal.dialog.close();
        if (!pending) return;
        if (restoreFocus && pending.opener.isConnected) pending.opener.focus({preventScroll: true});
        pending.resolve(accepted);
    }

    function ensureCanvasOpenModal() {
        if (canvasOpenModal) return canvasOpenModal;
        const dialog = element('dialog', 'daki-dialog daki-canvas-open-dialog');
        dialog.id = 'dakiCanvasOpenDialog';
        dialog.setAttribute('aria-labelledby', 'dakiCanvasOpenTitle');
        dialog.setAttribute('aria-describedby', 'dakiCanvasOpenDescription');
        const header = element('header', 'daki-canvas-open-header');
        const title = element('h2', '', '캔버스를 열까요?');
        title.id = 'dakiCanvasOpenTitle';
        const close = element('button', 'daki-canvas-open-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '닫기');
        header.append(title, close);
        const body = element('div', 'daki-canvas-open-body');
        const selection = element('div', 'daki-canvas-open-selection');
        const side = element('span', 'daki-canvas-open-side');
        const name = element('strong', 'daki-canvas-open-name');
        selection.append(side, name);
        const description = element('p', 'daki-canvas-open-description', '선택한 캔버스를 새 창에서 엽니다.');
        description.id = 'dakiCanvasOpenDescription';
        body.append(selection, description);
        const actions = element('footer', 'daki-canvas-open-actions');
        const cancel = element('button', 'daki-canvas-open-cancel', '취소');
        cancel.type = 'button';
        const confirm = element('a', 'daki-primary daki-canvas-open-confirm', '캔버스 열기 ↗');
        confirm.target = '_blank';
        confirm.rel = 'noopener';
        actions.append(cancel, confirm);
        dialog.append(header, body, actions);
        doc.body.appendChild(dialog);

        function accept(event) {
            if (event.defaultPrevented) return;
            const pending = pendingCanvasOpen;
            const currentProject = new URLSearchParams(root.location.hash.slice(1)).get('project');
            if (!dialog.open || !pending || pending.revision !== pageRevision || !pending.opener.isConnected
                || !isProjectView() || currentProject !== pending.projectId) {
                event.preventDefault();
                closeCanvasOpenModal(false);
                return;
            }
            pendingCanvasOpen = null;
            if (dialog.open) dialog.close();
        }
        confirm.onclick = accept;
        confirm.onauxclick = event => { if (event.button === 1) accept(event); };
        close.onclick = () => closeCanvasOpenModal();
        cancel.onclick = () => closeCanvasOpenModal();
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            closeCanvasOpenModal();
        });
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') event.stopPropagation();
        });
        dialog.addEventListener('close', () => {
            if (dialog.open) return;
            const pending = pendingCanvasOpen;
            pendingCanvasOpen = null;
            if (pending?.opener.isConnected) pending.opener.focus({preventScroll: true});
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) closeCanvasOpenModal();
        });
        canvasOpenModal = {dialog, side, name, cancel, confirm};
        return canvasOpenModal;
    }

    function showCanvasOpenModal(link, canvasName, side) {
        const modal = ensureCanvasOpenModal();
        const projectId = new URLSearchParams(root.location.hash.slice(1)).get('project');
        pendingCanvasOpen = {opener: link, href: link.href, projectId, revision: pageRevision};
        modal.side.textContent = sides[side] || side;
        modal.name.textContent = canvasName;
        modal.confirm.href = pendingCanvasOpen.href;
        if (!modal.dialog.open) modal.dialog.showModal();
        modal.cancel.focus({preventScroll: true});
    }

    function closeCanvasOpenModal(restoreFocus = true) {
        const pending = pendingCanvasOpen;
        pendingCanvasOpen = null;
        if (canvasOpenModal?.dialog.open) canvasOpenModal.dialog.close();
        if (restoreFocus && pending?.opener.isConnected) pending.opener.focus({preventScroll: true});
    }

    function bindCanvasOpen(link, canvasName, side) {
        const open = event => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            showCanvasOpenModal(link, canvasName, side);
        };
        link.onclick = open;
        link.onauxclick = event => {
            if (event.button === 1) open(event);
        };
    }

    function deletionMessage(references) {
        const names = [...new Set(references.map(ref => `${ref.project_name} · ${sides[ref.side] || ref.side}`))];
        return `삭제할 그림이 Daki 후보 또는 개인 그림체의 대표 그림으로 연결되어 있습니다.\n\n${names.slice(0, 8).join('\n')}${names.length > 8 ? `\n외 ${names.length - 8}개` : ''}\n\n삭제하면 원본 연결이 끊길 수 있습니다. 그래도 삭제하시겠습니까?`;
    }

    async function deleteRequest(url, payload, fetcher = root.fetch.bind(root), ask = root.confirm.bind(root)) {
        const send = async body => {
            const response = await fetcher(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
            return {response, result: await response.json(), cancelled: false};
        };
        const reply = await send(payload);
        if (reply.response.status !== 409 || reply.result.code !== 'daki_references') return reply;
        if (!await ask(deletionMessage(reply.result.references || []))) return {...reply, cancelled: true};
        return send({...payload, confirm_daki: true});
    }

    function element(tag, className, text) {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }

    function imageSrc(candidate, preview = true) {
        const src = candidate.src || `/image/${candidate.path.split('/').map(encodeURIComponent).join('/')}`;
        return preview ? `${src}${src.includes('?') ? '&' : '?'}preview=768` : src;
    }

    function createGrid(className, items = [], imageGrid = true) {
        const grid = element('div', `flex-masonry ${className}`);
        grid.dakiLayout = () => {
            const layout = root.getGalleryGridLayout?.(grid) || {columns: 3, fixed: false};
            const fixed = imageGrid && layout.fixed;
            grid.galleryZoomImages = items.filter(item => !item.hidden && item.dataset?.path)
                .map(item => ({path: item.dataset.path}));
            grid.className = `flex-masonry ${className}${fixed ? ' gallery-fixed-size-grid' : ''}`;
            grid.replaceChildren();
            if (fixed) grid.append(...items);
            else {
                const columns = Array.from({length: layout.columns}, () => element('div', 'flex-masonry-col'));
                grid.append(...columns);
                items.filter(item => !item.hidden).forEach((item, index) => columns[index % columns.length].appendChild(item));
            }
        };
        grid.setItems = value => { items = value; grid.dakiLayout(); };
        grid.dakiLayout();
        return grid;
    }

    function bindImage(card, img, path, projectContext = null) {
        card.dataset.path = path;
        const full = '/image/' + path.split('/').map(encodeURIComponent).join('/');
        img.onclick = event => {
            if (event.defaultPrevented || root.consumeGalleryRadialTagClick?.(event)) return;
            event.preventDefault();
            const tags = root.getGalleryTagState?.();
            if (!projectContext && tags?.enabled && !tags.zoomEnabled) root.applySelectedGalleryTagToImage?.(path);
            else root.openZoom?.(full);
        };
        img.onkeydown = event => { if (['Enter', ' '].includes(event.key)) img.onclick(event); };
        img.oncontextmenu = event => root.openImageContextMenu?.(event, path, full, projectContext);
        if (!projectContext && root.renderGalleryImageTagButton && !card.querySelector('.gallery-image-tag-btn')) {
            const holder = element('div');
            holder.innerHTML = root.renderGalleryImageTagButton(path, root.getGalleryImageTagId(path));
            card.appendChild(holder.firstElementChild);
        }
        root.GalleryImageTools?.decorate(card, path);
    }

    function relayout() {
        byId('dakiContent')?.querySelectorAll('.flex-masonry').forEach(grid => grid.dakiLayout?.());
    }

    function refreshTags() {
        byId('dakiContent')?.querySelectorAll('.gallery-image-tag-btn').forEach(button => {
            const path = button.dataset.galleryTagPath;
            button.outerHTML = root.renderGalleryImageTagButton(path, root.getGalleryImageTagId(path));
        });
    }

    function refreshImageTools() {
        byId('dakiContent')?.querySelectorAll('.daki-image-tools').forEach(toolbar => toolbar.refreshTags?.());
    }

    function createImageTools({tagChoices = true} = {}) {
        const toolbar = element('div', 'daki-image-tools');
        const actions = element('div', 'gallery-tag-assignment-actions');
        const mode = element('button', 'secondary');
        const zoom = element('button', 'secondary');
        const manage = element('button', 'secondary', '태그 관리');
        for (const button of [mode, zoom, manage]) button.type = 'button';
        mode.onclick = () => root.toggleGalleryTagAssignmentMode?.();
        zoom.onclick = () => {
            if (!root.getGalleryTagState?.().enabled) root.toggleGalleryTagAssignmentMode?.();
            root.toggleGalleryZoomActionMode?.('tag');
        };
        manage.onclick = () => root.openGalleryTagManager?.();
        actions.append(mode, zoom, manage);
        const choices = element('div', 'daki-tag-choices');
        choices.setAttribute('aria-label', '적용할 태그 선택');
        const hint = element('p', 'daki-tag-hint');
        toolbar.appendChild(actions);
        if (tagChoices) toolbar.appendChild(choices);
        toolbar.appendChild(hint);
        toolbar.refreshTags = () => {
            const state = root.getGalleryTagState?.() || {enabled: false, zoomEnabled: false, selectedTagId: '', definitions: []};
            mode.textContent = `🏷️ 태그 모드${state.enabled ? ' ON' : ''}`;
            mode.setAttribute('aria-pressed', String(state.enabled));
            zoom.textContent = `확대하며 태그 ${state.zoomEnabled ? 'ON' : 'OFF'}`;
            zoom.setAttribute('aria-pressed', String(state.zoomEnabled));
            choices.replaceChildren();
            for (const [index, tag] of (tagChoices ? [{id: 'NONE', type: 'text', value: '태그 제거'}, ...state.definitions] : []).entries()) {
                const label = tag.type === 'text' ? tag.value : `그림 태그 ${index}`;
                const button = element('button', 'gallery-tag-filter-chip');
                button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
                button.setAttribute('aria-pressed', String(state.selectedTagId === tag.id));
                button.classList.toggle('gallery-tag-assignment-selected', state.selectedTagId === tag.id);
                if (tag.id === 'NONE') button.textContent = '×';
                else if (root.renderGalleryTagIcon) button.innerHTML = root.renderGalleryTagIcon(tag);
                else button.textContent = label;
                button.onclick = () => {
                    if (!root.getGalleryTagState?.().enabled) root.toggleGalleryTagAssignmentMode?.();
                    root.selectGalleryTagForAssignment?.(tag.id);
                };
                choices.appendChild(button);
            }
            hint.textContent = state.enabled
                ? state.zoomEnabled ? '그림을 확대하고 ↑ 또는 태그 적용 버튼으로 붙이세요. ← →로 넘길 수 있습니다.' : '태그를 선택한 뒤 그림을 클릭하면 적용됩니다. 크게 보려면 ‘확대하며 태그’를 켜세요.'
                : '짧게 눌러 확대 · 길게 눌러 태그 메뉴 · 태그 모드로 연속 지정';
            if (!tagChoices && state.enabled) hint.textContent += ' 태그 필터는 잠시 해제됩니다.';
        };
        toolbar.refreshTags();
        return toolbar;
    }

    function folderCard(name, href, count, subtitle, src, libraryKind) {
        const card = element('a', 'card daki-project-card'); card.href = href;
        const libraryCover = libraryKind && libraryCovers[libraryKind];
        const preview = element('div', 'card-body');
        if (libraryCover) {
            card.classList.add('daki-library-card');
            card.dataset.library = libraryKind;
            preview.classList.add('daki-library-cover');
            const emblem = element('span', 'daki-library-emblem');
            emblem.setAttribute('aria-hidden', 'true');
            emblem.innerHTML = libraryCover;
            preview.appendChild(emblem);
        } else if (src) {
            const img = element('img', 'card-main-img'); img.src = src; img.alt = name; img.loading = 'lazy';
            preview.appendChild(img);
        } else preview.appendChild(element('div', 'daki-folder-preview', '🗂️'));
        if (count !== undefined) {
            const badge = element('div', 'count-badge');
            badge.append(element('span', 'count-num', count), element('span', '', 'FILES')); preview.appendChild(badge);
        }
        const label = element('div', 'card-header');
        const row = element('div', 'char-row');
        if (libraryCover) {
            const dot = element('span', 'user-icon daki-library-dot');
            dot.setAttribute('aria-hidden', 'true');
            const title = element('span', 'char-name', name);
            const arrow = element('span', 'daki-library-arrow', '→');
            arrow.setAttribute('aria-hidden', 'true');
            row.append(dot, title, arrow);
        } else row.append(element('span', 'user-icon', '🗂️'), element('span', 'char-name', name));
        label.appendChild(row);
        if (subtitle) label.appendChild(element('div', 'gallery-virtual-folder-card-meta', subtitle));
        card.append(preview, label);
        return card;
    }

    function isActive(location = root.location) {
        const hash = new URLSearchParams((location?.hash || '').slice(1));
        if (hash.has('gallery')) return false;
        return hash.has('daki') || hash.has('project') || (!location?.hash && location?.pathname === '/daki');
    }

    function isProjectView(location = root.location) {
        const hash = new URLSearchParams((location?.hash || '').slice(1));
        return isActive(location) && !!hash.get('project') && !hash.has('library');
    }

    function syncLibraryView() {
        const library = byId('dakiLibrary');
        if (!library) return;
        const active = isActive();
        const galleryEntry = byId('openGalleryLink');
        if (galleryEntry) {
            if (active) galleryEntry.removeAttribute('aria-current');
            else galleryEntry.setAttribute('aria-current', 'page');
        }
        const wasActive = doc.body.classList.contains('gallery-daki-active');
        if (active && !wasActive) galleryScrollY = root.scrollY || 0;
        doc.body.classList.toggle('gallery-daki-active', active);
        library.hidden = !active;
        mountNavigation(byId('nav-tabs'));
        if (active !== wasActive) {
            root.scrollTo(0, active ? 0 : galleryScrollY);
            root.scheduleGalleryScrollNavigationUpdate?.();
        }
    }

    function mountNavigation(container) {
        if (!container) return;
        let link = container.querySelector('.daki-nav');
        if (!link) {
            link = element('a', 'nav-btn daki-nav', 'Daki');
            link.href = '#daki';
            container.appendChild(link);
        }
        link.hidden = !enabled;
        link.classList.toggle('active', isActive());
        if (isActive()) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }

    function syncEnabled() {
        mountNavigation(byId('nav-tabs'));
        const context = byId('dakiContextAdd');
        if (context) context.hidden = !enabled;
        const personalContext = byId('dakiPersonalStyleAdd');
        if (personalContext) personalContext.hidden = !enabled;
        const input = byId('dakiEnabledInput');
        if (input) { input.checked = enabled; input.disabled = !loaded; }
        const create = byId('dakiCreate');
        if (create) create.disabled = !enabled;
    }

    async function loadSettings() {
        try {
            const data = await api('/api/daki/settings');
            enabled = data.enabled;
            loaded = true;
            const status = byId('dakiSettingsStatus');
            if (status) status.textContent = '';
            syncEnabled();
            return true;
        } catch (error) {
            const status = byId('dakiSettingsStatus');
            if (status) {
                status.textContent = `Daki 설정을 불러오지 못했습니다. ${error.message} `;
                const retry = element('button', '', '다시 불러오기');
                retry.type = 'button';
                retry.onclick = async () => { if (await loadSettings()) renderPage(); };
                status.appendChild(retry);
            }
            return false;
        }
    }

    async function setEnabled(input) {
        const requested = input.checked;
        input.disabled = true;
        try {
            const data = await api('/api/daki/settings', 'PUT', {enabled: requested});
            enabled = data.enabled;
            byId('dakiSettingsStatus').textContent = enabled ? 'Daki 사용을 켰습니다.' : 'Daki 사용을 껐습니다. 프로젝트와 후보는 보관됩니다.';
            if (!enabled && dialog?.open && !dialogBusy) closeDialog();
            syncEnabled();
            renderPage();
        } catch (error) {
            input.checked = enabled;
            byId('dakiSettingsStatus').textContent = `설정 저장 실패: ${error.message}`;
        } finally { input.disabled = false; }
    }

    function ensureDialog() {
        if (dialog) return;
        dialog = element('dialog', 'daki-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiDialogTitle');
        dialog.innerHTML = `<form id="dakiAddForm">
            <h2 id="dakiDialogTitle">프로젝트에 추가</h2>
            <div id="dakiSourcePreview" class="daki-dialog-preview" hidden></div>
            <fieldset id="dakiModeField"><legend>프로젝트</legend>
                <label><input type="radio" name="dakiMode" value="new" checked> 새 프로젝트</label>
                <label><input id="dakiExistingMode" type="radio" name="dakiMode" value="existing"> 기존 프로젝트</label>
            </fieldset>
            <label id="dakiNameField">프로젝트명<input id="dakiProjectName" type="text" maxlength="120" autocomplete="off" required></label>
            <label id="dakiProjectField" hidden>기존 프로젝트<select id="dakiProjectSelect" disabled></select></label>
            <fieldset id="dakiSideField"><legend>후보를 넣을 면</legend>
                <label><input type="radio" name="dakiSide" value="front" checked> 앞면</label>
                <label><input type="radio" name="dakiSide" value="back"> 뒷면</label>
            </fieldset>
            <p id="dakiLinkNote">원본 위치에 연결합니다. 원본을 이동하거나 삭제하면 후보 연결이 끊길 수 있습니다.</p>
            <p id="dakiDialogStatus" role="status" aria-live="polite"></p>
            <div class="daki-dialog-actions"><button id="dakiCancel" type="button">취소</button><button id="dakiSubmit" class="daki-primary" type="submit">추가</button></div>
        </form>`;
        doc.body.appendChild(dialog);
        byId('dakiAddForm').addEventListener('submit', submitDialog);
        dialog.querySelectorAll('[name=dakiMode]').forEach(input => input.addEventListener('change', syncDialogMode));
        byId('dakiCancel').onclick = closeDialog;
        dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog();
        });
    }

    function syncDialogMode() {
        const isNew = dialog.querySelector('[name=dakiMode]:checked').value === 'new';
        byId('dakiNameField').hidden = !isNew;
        byId('dakiProjectName').disabled = !isNew;
        byId('dakiProjectField').hidden = isNew;
        byId('dakiProjectSelect').disabled = isNew;
        byId('dakiProjectSelect').required = !isNew;
        byId('dakiSubmit').textContent = isNew ? (dialogSource ? '프로젝트 생성 및 후보 추가' : '프로젝트 생성') : '후보 추가';
    }

    function closeDialog() {
        if (dialogBusy) return;
        dialogRevision++;
        dialog.close();
        if (returnFocus?.isConnected) returnFocus.focus();
    }

    async function openAdd(source = null) {
        if (!await loadSettings()) {
            if (typeof root.showToast === 'function') root.showToast('Daki 설정을 불러오지 못했습니다. 설정에서 다시 시도해 주세요.');
            return;
        }
        if (!enabled) return;
        ensureDialog();
        if (dialogBusy) return;
        dialogSource = source ? {path: source.path, imgSrc: source.imgSrc} : null;
        const revision = ++dialogRevision;
        returnFocus = doc.activeElement;
        byId('dakiAddForm').reset();
        byId('dakiProjectSelect').replaceChildren();
        byId('dakiExistingMode').disabled = true;
        byId('dakiDialogTitle').textContent = source ? '프로젝트에 추가 · Daki' : '프로젝트 추가';
        byId('dakiModeField').hidden = !source;
        byId('dakiSideField').hidden = !source;
        byId('dakiLinkNote').hidden = !source;
        const preview = byId('dakiSourcePreview');
        preview.replaceChildren();
        preview.hidden = !source;
        if (source) {
            const image = element('img');
            image.src = source.imgSrc || imageSrc(source);
            image.alt = '추가할 후보';
            preview.append(image, element('span', '', source.path.split('/').pop()));
        }
        byId('dakiDialogStatus').textContent = source ? '기존 프로젝트를 불러오는 중…' : '';
        if (source?.projectId) byId('dakiExistingMode').checked = true;
        syncDialogMode();
        if (source?.projectId) byId('dakiProjectSelect').disabled = true;
        if (!dialog.open) dialog.showModal();
        if (!source?.projectId) byId('dakiProjectName').focus();
        if (!source) return;
        try {
            const data = await api('/api/daki/projects');
            if (revision !== dialogRevision || !dialog.open) return;
            for (const project of data.projects) {
                const option = element('option', '', project.name);
                option.value = project.id;
                byId('dakiProjectSelect').appendChild(option);
            }
            byId('dakiExistingMode').disabled = !data.projects.length;
            byId('dakiDialogStatus').textContent = data.projects.length ? '' : '저장된 프로젝트가 없습니다. 새 프로젝트를 만들어 주세요.';
            if (source.projectId) {
                const preferred = data.projects.find(project => project.id === source.projectId);
                if (preferred) byId('dakiProjectSelect').value = preferred.id;
                else {
                    dialog.querySelector('[name=dakiMode][value=new]').checked = true;
                    byId('dakiDialogStatus').textContent = '시안을 시작한 프로젝트를 찾을 수 없습니다. 추가할 프로젝트를 직접 골라 주세요.';
                }
                syncDialogMode();
            }
        } catch (error) {
            if (revision === dialogRevision && dialog.open) byId('dakiDialogStatus').textContent = `기존 프로젝트를 불러오지 못했습니다. 창을 다시 열어 재시도해 주세요. ${error.message}`;
        }
    }

    async function submitDialog(event) {
        event.preventDefault();
        if (dialogBusy) return;
        const isNew = dialog.querySelector('[name=dakiMode]:checked').value === 'new';
        const payload = isNew ? {name: byId('dakiProjectName').value.trim()} : {};
        if (isNew && !payload.name) { byId('dakiDialogStatus').textContent = '프로젝트명을 입력해 주세요.'; byId('dakiProjectName').focus(); return; }
        if (dialogSource) Object.assign(payload, {path: dialogSource.path, side: dialog.querySelector('[name=dakiSide]:checked').value});
        const url = isNew ? '/api/daki/projects' : `/api/daki/projects/${encodeURIComponent(byId('dakiProjectSelect').value)}/candidates`;
        dialogBusy = true;
        byId('dakiSubmit').disabled = true;
        byId('dakiCancel').disabled = true;
        byId('dakiDialogStatus').textContent = '저장하는 중…';
        try {
            const result = await api(url, 'POST', payload);
            dialogBusy = false;
            closeDialog();
            if (isActive()) {
                const hash = `#project=${encodeURIComponent(result.project.id)}`;
                if (root.location.hash === hash) renderPage(); else root.location.hash = hash;
            } else if (typeof root.showToast === 'function') root.showToast(`${result.project.name} · ${sides[payload.side]} 후보에 추가했습니다.`);
        } catch (error) { byId('dakiDialogStatus').textContent = error.message; }
        finally { dialogBusy = false; byId('dakiSubmit').disabled = false; byId('dakiCancel').disabled = false; }
    }

    function previewCandidate(container, candidate, fallback) {
        if (!candidate || candidate.missing) { container.textContent = candidate?.missing ? '원본을 찾을 수 없음' : fallback; return; }
        const img = element('img');
        img.src = imageSrc(candidate);
        img.alt = fallback;
        img.loading = 'lazy';
        img.onerror = () => { container.textContent = '원본을 찾을 수 없음'; container.classList.add('daki-warning'); };
        container.appendChild(img);
    }

    function previewCanvas(container, projectId, canvas) {
        if (canvasPreviews) canvasPreviews.observe(container, projectId, canvas);
        else {
            container.textContent = '통합 그림을 표시할 수 없습니다.';
            container.classList.add('daki-warning');
            container.setAttribute('role', 'status');
            container.setAttribute('aria-busy', 'false');
        }
    }

    function projectKindBadge(kind, label) {
        const badge = element('span', 'daki-badge-neon daki-project-kind', label);
        badge.dataset.kind = kind;
        return badge;
    }

    function renderList(projects, container) {
        const revision = pageRevision;
        byId('dakiTitle').textContent = 'Daki 프로젝트';
        byId('dakiSubtitle').textContent = `${projects.length}개 프로젝트 · 갤러리 이미지 우클릭 → 프로젝트에 추가`;
        byId('dakiBack').hidden = true;
        const cards = [folderCard('공유 그림체', '#daki&library=shared', undefined, '기본 폴더', undefined, 'shared'),
            folderCard('개인 그림체', '#daki&library=personal', undefined, '직접 입력 · 그림에서 가져오기', undefined, 'personal'),
            folderCard('월드컵 기록', '#daki&library=worldcups', undefined, '저장한 결과 · 공동 순위 · 다시 하기', undefined, 'worldcups')];
        for (const project of projects) {
            const card = folderCard(project.name, `#project=${encodeURIComponent(project.id)}`, undefined,
                `후보 앞면 ${project.candidates.front.length}개 · 뒷면 ${project.candidates.back.length}개`
                + ` · 캔버스 ${(project.canvases?.front?.length || 0) + (project.canvases?.back?.length || 0)}개`);
            const preview = element('div', 'card-body daki-project-preview');
            for (const side of Object.keys(sides)) {
                const face = element('div', 'daki-project-preview-face daki-canvas-preview');
                const canvas = project.canvases?.[side]?.[0];
                if (canvas) previewCanvas(face, project.id, canvas);
                else previewCandidate(face, project.candidates[side][0], sides[side]);
                preview.appendChild(face);
            }
            card.replaceChild(preview, card.firstChild);
            const removal = root.DakiProjectRemoval?.createButton({
                project,
                isCurrent: () => revision === pageRevision && isActive()
                    && !new URLSearchParams(root.location.hash.slice(1)).has('project')
                    && !new URLSearchParams(root.location.hash.slice(1)).has('library'),
                onDeleted: async result => {
                    await renderPage();
                    if (isActive() && !new URLSearchParams(root.location.hash.slice(1)).has('project')
                        && !new URLSearchParams(root.location.hash.slice(1)).has('library')) {
                        byId('dakiPageStatus').textContent = result.warning || '프로젝트를 삭제했습니다.';
                    }
                    if (result.gallery_changed) root.loadData?.();
                },
            });
            if (removal) {
                const wrapper = element('div', 'card daki-project-card daki-project-list-card');
                card.classList.remove('card'); card.classList.add('daki-project-list-link');
                const actions = element('div', 'daki-project-list-actions'); actions.appendChild(removal);
                wrapper.append(card, actions); cards.push(wrapper);
            } else cards.push(card);
        }
        container.appendChild(createGrid('daki-project-grid', cards, false));
    }

    function renderProject(project, container) {
        const revision = pageRevision;
        doc.body.classList.add('daki-project-active');
        byId('dakiTitle').textContent = project.name;
        byId('dakiSubtitle').textContent = '캔버스의 「Daki 프로젝트 연결」에서 캔버스를 추가하세요.';
        byId('dakiBack').hidden = false;
        const sideLinks = element('div', 'daki-project-side-links');
        sideLinks.setAttribute('role', 'group');
        sideLinks.setAttribute('aria-label', '앞면·뒷면으로 이동');
        const generationLink = element('a', 'daki-project-generate-link', '시안 만들기');
        generationLink.href = '#daki&library=drafts&project=' + encodeURIComponent(project.id) + '&new=1';
        generationLink.title = '그림체와 프롬프트로 생성하고 앞면·뒷면 후보에 추가하세요.';
        const importButton = element('button', 'daki-project-generate-link daki-project-import-button', '그림 가져오기');
        importButton.type = 'button';
        importButton.onclick = () => root.DakiImageImport?.open({projectId: project.id, projectName: project.name});
        const sortLabel = element('label', 'daki-project-sort-label');
        sortLabel.appendChild(element('span', '', '정렬'));
        const sortSelect = element('select', 'daki-project-sort');
        sortSelect.setAttribute('aria-label', '프로젝트 카드 정렬');
        for (const [value, label] of [
            ['original', '기존 순서'],
            ['updated-desc', '수정일 최신순'],
            ['updated-asc', '수정일 오래된순'],
            ['created-desc', '생성일 최신순'],
            ['created-asc', '생성일 오래된순'],
        ]) {
            const option = element('option', '', label);
            option.value = value;
            sortSelect.appendChild(option);
        }
        sortSelect.value = projectSortMode;
        const controls = element('div', 'daki-project-controls');
        const linkedSettings = element('button', 'daki-project-generate-link daki-project-settings-button', '캔버스 연동 설정');
        linkedSettings.type = 'button';
        linkedSettings.onclick = () => root.DakiProjectSettings?.open({projectId: project.id, projectName: project.name, opener: linkedSettings});
        controls.append(sideLinks, generationLink, importButton, linkedSettings, sortLabel);
        const removal = root.DakiProjectRemoval?.createButton({
            project,
            isCurrent: () => revision === pageRevision && isProjectView()
                && new URLSearchParams(root.location.hash.slice(1)).get('project') === String(project.id),
            onDeleted: result => {
                root.location.hash = '#daki';
                root.showToast?.(result.warning || (result.action === 'archive'
                    ? `그림 ${result.archived_count}장을 갤러리에 보관하고 프로젝트를 삭제했습니다.`
                    : '프로젝트와 그림을 삭제했습니다.'));
                if (result.gallery_changed) root.loadData?.();
            },
        });
        if (removal) controls.appendChild(removal);
        sortLabel.appendChild(sortSelect);
        const sortProjectGrids = [];
        sortSelect.onchange = () => {
            const knownModes = ['original', 'updated-desc', 'updated-asc', 'created-desc', 'created-asc'];
            projectSortMode = knownModes.includes(sortSelect.value) ? sortSelect.value : 'original';
            sortSelect.value = projectSortMode;
            sortProjectGrids.forEach(applySort => applySort());
        };
        container.appendChild(controls);
        projectReference = root.DakiProjectReference?.mount({
            container, projectId: project.id,
            isCurrent: () => revision === pageRevision && isProjectView()
                && new URLSearchParams(root.location.hash.slice(1)).get('project') === String(project.id),
        }) || null;
        renderProjectDraftFolders(project, container);
        const panels = element('div', 'daki-sides');
        for (const [side, label] of Object.entries(sides)) {
            const panel = element('section', 'daki-side');
            const canvases = project.canvases?.[side] || [];
            const entries = [];
            for (const canvas of canvases) {
                const href = '/canvas?project=' + encodeURIComponent(project.id) + '&canvas=' + encodeURIComponent(canvas.id);
                const row = element('div', 'item-box daki-project-canvas');
                row.appendChild(projectKindBadge('canvas', '캔버스'));
                const preview = element('a', 'daki-canvas-preview');
                preview.href = href; preview.target = '_blank'; preview.rel = 'noopener';
                preview.setAttribute('aria-label', `${canvas.name} 캔버스 열기`);
                previewCanvas(preview, project.id, canvas);
                const info = element('div', 'daki-project-canvas-info');
                const canvasName = element('strong', '', canvas.name);
                canvasName.title = canvas.name;
                const heading = element('div', 'daki-project-canvas-heading');
                heading.appendChild(canvasName);
                const details = element('button', 'daki-project-canvas-details', '상세 정보');
                details.replaceChildren(element('span', 'daki-card-action-label', details.textContent));
                details.dataset.compactIcon = 'ⓘ';
                details.title = '캔버스 상세 정보';
                details.type = 'button';
                details.setAttribute('aria-label', `${canvas.name} 캔버스 상세 정보`);
                const isCurrentProjectView = () => revision === pageRevision
                    && details.isConnected
                    && isProjectView()
                    && new URLSearchParams(root.location.hash.slice(1)).get('project') === String(project.id);
                details.onclick = () => {
                    if (!isCurrentProjectView()) return;
                    root.DakiProjectDetails?.open?.({
                        projectId: project.id,
                        canvas,
                        opener: details,
                        isCurrent: isCurrentProjectView,
                        formatDate: formatProjectDate,
                    });
                };
                info.appendChild(heading);
                info.appendChild(element('span', '', `${canvas.width} × ${canvas.height} px · 레이어 ${canvas.layerCount}개`));
                info.appendChild(projectDateBlock(canvas));
                const actions = element('div', 'daki-project-card-actions daki-project-canvas-actions');
                const open = element('a', 'daki-project-canvas-open', '캔버스 열기 ↗');
                open.replaceChildren(element('span', 'daki-card-action-label', open.textContent));
                open.dataset.compactIcon = '↗';
                open.title = '캔버스 열기';
                open.setAttribute('aria-label', '캔버스 열기 ↗');
                open.href = href; open.target = '_blank'; open.rel = 'noopener';
                bindCanvasOpen(preview, canvas.name, side);
                bindCanvasOpen(open, canvas.name, side);
                const remove = projectDeleteButton({projectId: project.id, itemId: canvas.id, itemName: canvas.name, side, kind: 'canvas'});
                actions.append(details, open, remove);
                row.append(preview, info, actions);
                entries.push({card: row, name: canvas.name, created_at: canvas.created_at, updated_at: canvas.updated_at});
            }
            const candidates = project.candidates?.[side] || [];
            const title = element('h2', 'section-title', label);
            const count = entries.length + candidates.length;
            title.tabIndex = -1;
            title.appendChild(element('span', '', `${count}개`));
            const jump = element('button', 'nav-btn daki-project-side-jump', `${label} ${count}`);
            jump.type = 'button';
            jump.dataset.side = side;
            jump.setAttribute('aria-label', `${label} ${count}개로 이동`);
            jump.onclick = () => {
                title.scrollIntoView({block: 'start'});
                title.focus({preventScroll: true});
            };
            sideLinks.appendChild(jump);
            panel.appendChild(title);
            for (const candidate of candidates) {
                const card = element('figure', 'item-box daki-candidate');
                const upscaled = candidate.upscale?.is_upscaled === true;
                const kindBadge = projectKindBadge(upscaled ? 'upscale' : 'image', upscaled ? '⬆ UPSCALE' : '그림');
                if (upscaled) kindBadge.title = '업스케일 이미지';
                card.appendChild(kindBadge);
                if (candidate.missing) card.appendChild(element('div', 'daki-missing-image', '원본을 찾을 수 없음'));
                else {
                    const img = element('img', 'zoomable'); img.src = imageSrc(candidate); img.alt = candidate.name || candidate.path.split('/').pop(); img.loading = 'lazy';
                    img.tabIndex = 0; img.setAttribute('role', 'button');
                    bindImage(card, img, candidate.path, {
                        projectId: project.id,
                        side,
                        candidateId: candidate.id
                    });
                    card.appendChild(img);
                }
                const details = element('figcaption', 'gallery-card-actions daki-image-actions');
                const name = element('span', candidate.missing ? 'daki-warning' : '', candidate.name || candidate.path.split('/').pop());
                name.title = candidate.name || candidate.path;
                const remove = projectDeleteButton({
                    projectId: project.id,
                    itemId: candidate.id,
                    itemName: candidate.name || candidate.path.split('/').pop(),
                    side,
                    kind: 'image',
                });
                const actions = element('div', 'daki-project-card-actions');
                actions.appendChild(remove);
                const dimensions = Number.isSafeInteger(candidate.width) && candidate.width > 0
                    && Number.isSafeInteger(candidate.height) && candidate.height > 0 && !candidate.missing
                    ? `${candidate.width} × ${candidate.height} px` : '크기 확인 불가';
                details.append(name, element('span', 'daki-image-dimensions', dimensions), projectDateBlock(candidate), actions);
                card.appendChild(details);
                entries.push({
                    card,
                    name: candidate.name || candidate.path.split('/').pop(),
                    created_at: candidate.created_at,
                    updated_at: candidate.updated_at,
                });
            }
            const grid = createGrid('daki-project-items'); panel.appendChild(grid);
            const empty = element('div', 'daki-empty'); panel.appendChild(empty);
            const applySort = () => grid.setItems(sortProjectItems(entries, projectSortMode).map(entry => entry.card));
            sortProjectGrids.push(applySort);
            applySort();
            empty.hidden = !!entries.length;
            empty.textContent = `${label}에 캔버스나 그림이 아직 없습니다.`;
            panels.appendChild(panel);
        }
        container.appendChild(panels);
    }

    function renderProjectDraftFolders(project, container) {
        const token = pageRevision;
        const section = element('section', 'daki-project-draft-folders');
        const heading = element('h2', 'section-title', '시안 폴더');
        const status = element('p', 'daki-tag-hint', '시안 폴더를 불러오는 중…');
        status.setAttribute('role', 'status');
        const grid = createGrid('daki-project-grid', [], false);
        const reload = element('button', 'nav-btn', '시안 폴더 다시 불러오기');
        reload.type = 'button'; reload.hidden = true;
        section.append(heading, status, grid, reload); container.appendChild(section);
        const current = () => token === pageRevision && isProjectView();
        async function load() {
            reload.disabled = true;
            try {
                const data = await api('/api/daki/draft-folders?project=' + encodeURIComponent(project.id));
                if (!current()) return;
                const folders = data.folders.filter(folder => folder.project_id === project.id);
                grid.setItems(folders.map(folder => {
                    const href = '#daki&library=drafts&project=' + encodeURIComponent(project.id) + '&folder=' + encodeURIComponent(folder.id);
                    return root.DakiDraftFolderActions?.createCard(folder, {
                        href, isCurrent: current,
                        onDeleted: async result => { await load(); if (current() && result.warning) status.textContent = result.warning; },
                        onError: message => { if (current()) status.textContent = message; },
                    }) || folderCard(folder.name, href, folder.count,
                        `결과로 선택 ${folder.selected_count}장 · 시안 수정으로 이어서 생성`, folder.src);
                }));
                heading.textContent = '시안 폴더 · ' + folders.length;
                status.textContent = folders.length ? '' : '‘시안 만들기’로 이 프로젝트의 새 시안 폴더를 만드세요.';
                reload.hidden = true;
            } catch (error) {
                if (current()) { status.textContent = error.message; reload.hidden = false; }
            } finally { if (current()) reload.disabled = false; }
        }
        reload.onclick = load; load();
    }

    async function renderPage() {
        projectReference?.dispose();
        projectReference = null;
        closeCanvasOpenModal(false);
        closeProjectDeleteModal(false, false);
        root.DakiProjectRemoval?.close(false);
        root.DakiProjectDetails?.close(false);
        root.DakiDraftFolderActions?.close(false);
        doc.body.classList.remove('daki-project-active');
        canvasPreviews?.dispose();
        canvasPreviews = null;
        root.DakiStyles?.leave();
        root.DakiPersonalStyles?.leave?.();
        root.DakiWorldCup?.leave?.();
        root.DakiDrafts?.leave?.();
        root.DakiDictionary?.leave?.();
        syncLibraryView();
        const container = byId('dakiContent');
        const revision = ++pageRevision;
        if (!container || !isActive()) return;
        const create = byId('dakiCreate');
        if (create) create.hidden = false;
        byId('dakiBack').href = '#daki';
        byId('dakiBack').textContent = '← 프로젝트 목록';
        container.replaceChildren();
        const status = byId('dakiPageStatus');
        if (!loaded || !enabled) {
            status.textContent = !loaded ? 'Daki 설정을 불러오지 못했습니다. 도구 → 설정에서 다시 시도해 주세요.' : 'Daki 사용이 꺼져 있습니다. 도구 → 설정에서 켜면 보관된 프로젝트를 볼 수 있습니다.';
            return;
        }
        status.textContent = '불러오는 중…';
        try {
            const params = new URLSearchParams(root.location.hash.slice(1));
            if (params.get('library') === 'dictionary' && root.DakiDictionary) {
                if (create) create.hidden = true;
                await root.DakiDictionary.render(params, container);
                return;
            }
            if (params.get('library') === 'drafts' && root.DakiDrafts) {
                if (create) create.hidden = true;
                await root.DakiDrafts.render(params, container);
                return;
            }
            if (params.get('library') === 'shared' && root.DakiStyles) {
                if (create) create.hidden = true;
                await root.DakiStyles.render(params, container);
                return;
            }
            if (params.get('library') === 'personal' && root.DakiPersonalStyles) {
                if (create) create.hidden = true;
                await root.DakiPersonalStyles.render(params, container);
                return;
            }
            if (params.get('library') === 'worldcups' && root.DakiWorldCup) {
                if (create) create.hidden = true;
                await root.DakiWorldCup.render(params, container);
                return;
            }
            const id = params.get('project');
            const data = await api(id ? `/api/daki/projects/${encodeURIComponent(id)}` : '/api/daki/projects');
            if (revision !== pageRevision || !isActive()) return;
            status.textContent = '';
            canvasPreviews = root.DakiCanvasPreviews?.create?.() || null;
            if (id) renderProject(data.project, container); else renderList(data.projects, container);
            relayout();
        } catch (error) {
            if (revision !== pageRevision || !isActive()) return;
            status.textContent = error.message;
            const retry = element('button', '', '다시 불러오기');
            retry.onclick = renderPage;
            container.appendChild(retry);
            byId('dakiBack').hidden = false;
        }
    }

    async function refreshProject(projectId) {
        const params = new URLSearchParams(root.location.hash.slice(1));
        if (!projectId || params.get('project') !== String(projectId) || !isActive()) return false;
        await renderPage();
        return true;
    }

    async function initialize() {
        syncLibraryView();
        byId('dakiEnabledInput')?.addEventListener('change', event => setEnabled(event.target));
        byId('dakiCreate')?.addEventListener('click', () => openAdd());
        // The gallery rebuilds category buttons as data arrives; keep the container listener.
        byId('nav-tabs')?.addEventListener('click', event => {
            const category = event.target.closest('.nav-btn:not(.daki-nav)');
            if (category && isActive()) {
                root.location.hash = 'gallery';
                syncLibraryView();
            }
        }, true);
        root.addEventListener('hashchange', renderPage);
        root.addEventListener('resize', relayout);
        root.addEventListener('pagehide', () => {
            root.DakiDictionary?.leave?.();
            projectReference?.dispose();
            projectReference = null;
            closeCanvasOpenModal(false);
            closeProjectDeleteModal(false, false);
            root.DakiProjectRemoval?.close(false);
            root.DakiProjectDetails?.close(false);
            root.DakiDraftFolderActions?.close(false);
            canvasPreviews?.dispose();
            canvasPreviews = null;
        });
        root.addEventListener('pageshow', event => {
            if (event.persisted) return renderPage();
        });
        await loadSettings();
        renderPage();
    }

    root.Daki = {openAdd, mountNavigation, deleteRequest, loadSettings, isActive, isProjectView, createGrid, relayout, folderCard, bindImage, refreshTags, createImageTools, refreshImageTools, refreshProject};
    if (typeof module !== 'undefined' && module.exports) module.exports = {deleteRequest, deletionMessage, formatProjectDate, sortProjectItems, isActive, isProjectView};
    if (doc) {
        // This deferred script precedes the library modules; wait until they are all available.
        if (doc.readyState !== 'complete') doc.addEventListener('DOMContentLoaded', initialize);
        else initialize();
    }
})(typeof window === 'undefined' ? globalThis : window);
