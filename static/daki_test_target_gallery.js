/* Select a manual style-test target set from the active catalog. */
(function (root) {
    'use strict';
    const doc = root.document;
    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function open({catalog, selectedIds = [], onApply, onClose} = {}) {
        const styles = Array.isArray(catalog?.styles) ? catalog.styles : [];
        const library = catalog?.library === 'personal' ? 'personal' : 'shared';
        const active = new Map(styles.filter(style => style && typeof style.id === 'string').map(style => [style.id, style]));
        const selected = new Set((Array.isArray(selectedIds) ? selectedIds : []).filter(id => active.has(id)));
        const dialog = node('dialog', 'daki-dialog daki-test-target-gallery-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiTestTargetGalleryTitle');
        const shell = node('div', 'daki-test-target-gallery');
        const header = node('header', 'daki-test-target-gallery-header');
        const identity = node('div', 'daki-test-target-gallery-title');
        const title = node('h2', '', '테스트할 그림체 선택'); title.id = 'dakiTestTargetGalleryTitle';
        identity.append(node('span', 'daki-style-eyebrow', library === 'personal' ? '개인 그림체' : '공유 그림체'),
            title,
            node('p', '', '현재 그림체 목록을 기준으로 필터하고 선택하세요.'));
        const closeButton = node('button', 'nav-btn', '닫기'); closeButton.type = 'button';
        header.append(identity, closeButton);

        const body = node('div', 'daki-test-target-gallery-body');
        const filters = node('section', 'daki-test-target-gallery-filters');
        const includeLabel = node('label', '', '포함 태그');
        const includeInput = node('input'); includeInput.setAttribute('data-prompt-autocomplete', ''); includeInput.type = 'text'; includeInput.maxLength = 20000;
        includeInput.placeholder = '예: watercolor, sketch || oil_painting'; includeInput.setAttribute('aria-label', '포함 태그');
        includeLabel.appendChild(includeInput);
        const excludeLabel = node('label', '', '제외 태그');
        const excludeInput = node('textarea'); excludeInput.setAttribute('data-prompt-autocomplete', ''); excludeInput.rows = 2; excludeInput.maxLength = 20000;
        excludeInput.placeholder = '예: monochrome'; excludeInput.setAttribute('aria-label', '제외 태그');
        excludeLabel.appendChild(excludeInput);
        const filterButton = node('button', 'nav-btn', '필터 적용'); filterButton.type = 'button';
        const filterHelp = node('p', 'daki-test-target-gallery-help', '포함 태그는 쉼표로 모두 포함, ||로 하나 이상 포함을 뜻합니다. %는 부분 일치에 사용합니다. 제외 태그는 쉼표나 줄바꿈으로 나눕니다. 그림을 클릭해 선택·해제하거나 그림 위와 빈 공간을 드래그해 선택할 수 있습니다.');
        filters.append(includeLabel, excludeLabel, filterButton, filterHelp);

        const tools = node('div', 'daki-test-target-gallery-tools');
        const counts = node('p', 'daki-test-target-gallery-counts'); counts.setAttribute('aria-live', 'polite');
        const selectVisible = node('button', 'nav-btn', '표시된 그림체 모두 선택'); selectVisible.type = 'button';
        const clearSelection = node('button', 'nav-btn', '선택 해제'); clearSelection.type = 'button';
        const sortSelect = node('select', 'daki-test-target-gallery-sort');
        sortSelect.setAttribute('aria-label', '그림체 정렬');
        [
            ['', '기본 순서'],
            ['recommendation:desc', '추천 수 높은 순'],
            ['recommendation:asc', '추천 수 낮은 순'],
            ['date:desc', '날짜 최신 순'],
            ['date:asc', '날짜 오래된 순'],
            ['name', '이름 순'],
        ].forEach(([value, label]) => {
            const option = node('option', '', label); option.value = value; sortSelect.appendChild(option);
        });
        const minimumLabel = node('label', 'daki-test-target-gallery-minimum-label', '최소 추천수');
        const minimumInput = node('input', 'daki-test-target-gallery-minimum'); minimumInput.type = 'number';
        minimumInput.min = '0'; minimumInput.max = String(Number.MAX_SAFE_INTEGER); minimumInput.step = '1';
        minimumInput.setAttribute('aria-label', '최소 추천수');
        minimumLabel.appendChild(minimumInput);
        tools.append(counts, sortSelect, minimumLabel, selectVisible, clearSelection);
        const recommendationStatus = node('p', 'daki-test-target-gallery-recommendation-status');
        recommendationStatus.setAttribute('role', 'status'); recommendationStatus.setAttribute('aria-live', 'polite');
        const status = node('p', 'daki-test-target-gallery-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const grid = node('div', 'daki-test-target-gallery-grid'); grid.setAttribute('aria-label', '그림체 목록');
        const cardElements = new Map();
        body.append(filters, tools, recommendationStatus, status, grid);

        const footer = node('footer', 'daki-test-target-gallery-footer');
        const cancelButton = node('button', 'nav-btn', '취소'); cancelButton.type = 'button';
        const applyButton = node('button', 'daki-primary', '선택한 그림체 적용'); applyButton.type = 'button';
        footer.append(cancelButton, applyButton);
        shell.append(header, body, footer); dialog.appendChild(shell);

        let disposed = false, pending = false, error = false, resultValid = true, requestToken = 0;
        let visible = styles.filter(style => style && typeof style.id === 'string');
        let rectangleSelection = null;
        let suppressNextPointerClick = false;
        let minimumThreshold = null, recommendationError = '';
        
        const activePicker = {closed: false, close() { if (dialog.open) dialog.close(); cleanup(); }, isOpen() { return dialog.open; }};

        function normalizedFilters() {
            return {
                include_query: String(includeInput.value || '').trim(),
                exclude_tags: String(excludeInput.value || '').split(/[\r\n,]+/).map(tag => tag.trim()).filter(Boolean),
            };
        }
        function currentVisible() {
            return visible.filter(style => minimumThreshold === null ||
                (Number.isSafeInteger(style.recommendation_count) && style.recommendation_count >= minimumThreshold));
        }
        function updateMinimumRecommendation() {
            if (disposed) return;
            cancelRectangleSelection();
            const raw = String(minimumInput.value || '').trim();
            if (!raw && !minimumInput.validity?.badInput) {
                minimumThreshold = null; recommendationError = '';
            } else {
                const value = Number(raw);
                if (minimumInput.validity?.badInput || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0) {
                    recommendationError = '최소 추천수는 0 이상의 안전한 정수로 입력하세요.';
                } else {
                    minimumThreshold = value; recommendationError = '';
                }
            }
            recommendationStatus.textContent = recommendationError;
            recommendationStatus.className = 'daki-test-target-gallery-recommendation-status' + (recommendationError ? ' is-error' : '');
            render();
        }
        function sortVisible() {
            const direction = sortSelect.value;
            const indexed = currentVisible().map((style, index) => ({style, index}));
            if (direction === 'name') {
                indexed.sort((a, b) => String(a.style.name || a.style.id).localeCompare(String(b.style.name || b.style.id), 'ko') || a.index - b.index);
            } else if (direction.startsWith('recommendation:')) {
                const descending = direction.endsWith(':desc');
                indexed.sort((a, b) => {
                    const aCount = Number.isSafeInteger(a.style.recommendation_count) && a.style.recommendation_count >= 0 ? a.style.recommendation_count : null;
                    const bCount = Number.isSafeInteger(b.style.recommendation_count) && b.style.recommendation_count >= 0 ? b.style.recommendation_count : null;
                    if (aCount === null || bCount === null) return aCount === bCount ? a.index - b.index : aCount === null ? 1 : -1;
                    return (descending ? bCount - aCount : aCount - bCount) || a.index - b.index;
                });
            } else if (direction.startsWith('date:')) {
                const descending = direction.endsWith(':desc');
                indexed.sort((a, b) => {
                    const aDate = typeof a.style.sort_date === 'string' ? Date.parse(a.style.sort_date) : NaN;
                    const bDate = typeof b.style.sort_date === 'string' ? Date.parse(b.style.sort_date) : NaN;
                    const aKnown = Number.isFinite(aDate), bKnown = Number.isFinite(bDate);
                    if (!aKnown || !bKnown) return aKnown === bKnown ? a.index - b.index : aKnown ? -1 : 1;
                    return (descending ? bDate - aDate : aDate - bDate) || a.index - b.index;
                });
            }
            return indexed.map(item => item.style);
        }
        function syncCardSelection() {
            cardElements.forEach(({card}, id) => {
                const isSelected = selected.has(id);
                card.className = 'daki-test-target-gallery-card' + (isSelected ? ' is-selected' : '');
                card.setAttribute('aria-pressed', String(isSelected));
                card.setAttribute('aria-disabled', String(Boolean(pending || error || recommendationError || !resultValid)));
            });
        }
        function consumeSuppressedPointerClick(event) {
            if (!suppressNextPointerClick || event?.detail === 0) return false;
            suppressNextPointerClick = false;
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return true;
        }
        function toggleCardSelection(id) {
            if (disposed || pending || error || recommendationError || !resultValid) return;
            if (selected.has(id)) selected.delete(id); else selected.add(id);
            syncCardSelection(); updateControls();
        }
        function pointerPosition(event) {
            const rect = grid.getBoundingClientRect();
            const maxX = Math.max(rect.width, grid.scrollWidth || 0);
            const maxY = Math.max(rect.height, grid.scrollHeight || 0);
            return {
                x: Math.min(maxX, Math.max(0, event.clientX - rect.left + (grid.scrollLeft || 0))),
                y: Math.min(maxY, Math.max(0, event.clientY - rect.top + (grid.scrollTop || 0))),
            };
        }
        function releaseRectanglePointer() {
            if (!rectangleSelection) return;
            const {pointerId, onBodyScroll} = rectangleSelection;
            if (onBodyScroll) body.removeEventListener('scroll', onBodyScroll);
            if (grid.hasPointerCapture?.(pointerId)) grid.releasePointerCapture(pointerId);
        }
        function removeSelectionOverlay() {
            if (rectangleSelection?.overlay) rectangleSelection.overlay.remove();
            grid.className = 'daki-test-target-gallery-grid';
        }
        function cancelRectangleSelection(restore = true) {
            if (!rectangleSelection) return;
            const {snapshot, dragging} = rectangleSelection;
            if (dragging) suppressNextPointerClick = true;
            removeSelectionOverlay();
            releaseRectanglePointer();
            rectangleSelection = null;
            if (restore) {
                selected.clear(); snapshot.forEach(id => selected.add(id));
                syncCardSelection();
                updateControls();
            }
        }
        function updateRectangleSelection(event) {
            const state = rectangleSelection;
            if (!state || event.pointerId !== state.pointerId) return;
            state.lastClientX = event.clientX; state.lastClientY = event.clientY;
            const point = pointerPosition(event);
            if (!state.dragging && Math.hypot(point.x - state.start.x, point.y - state.start.y) < 6) return;
            if (!state.dragging) {
                state.dragging = true;
                grid.setPointerCapture?.(event.pointerId);
                state.overlay = node('div', 'daki-test-target-gallery-selection-box');
                state.overlay.setAttribute('aria-hidden', 'true');
                grid.appendChild(state.overlay);
                grid.className = 'daki-test-target-gallery-grid is-selecting';
            }
            const left = Math.min(state.start.x, point.x), top = Math.min(state.start.y, point.y);
            const right = Math.max(state.start.x, point.x), bottom = Math.max(state.start.y, point.y);
            state.overlay.style.left = `${left}px`; state.overlay.style.top = `${top}px`;
            state.overlay.style.width = `${right - left}px`; state.overlay.style.height = `${bottom - top}px`;
            selected.clear(); state.snapshot.forEach(id => selected.add(id));
            cardElements.forEach(({card}, id) => {
                const rect = card.getBoundingClientRect(), gridRect = grid.getBoundingClientRect();
                const cardLeft = rect.left - gridRect.left + (grid.scrollLeft || 0);
                const cardTop = rect.top - gridRect.top + (grid.scrollTop || 0);
                const cardRight = cardLeft + rect.width, cardBottom = cardTop + rect.height;
                if (cardRight >= left && cardLeft <= right && cardBottom >= top && cardTop <= bottom) selected.add(id);
            });
            syncCardSelection(); updateControls();
            event.preventDefault();
        }
        function startRectangleSelection(event) {
            suppressNextPointerClick = false;
            if (disposed || event.pointerType !== 'mouse' || event.button !== 0 || rectangleSelection) return;
            let target = event.target;
            while (target && target !== grid) {
                if (['BUTTON', 'INPUT', 'LABEL', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
                target = target.parentNode;
            }
            if (target !== grid) return;
            const start = pointerPosition(event);
            const state = {pointerId: event.pointerId, start, snapshot: new Set(selected), dragging: false, overlay: null,
                lastClientX: event.clientX, lastClientY: event.clientY};
            state.onBodyScroll = () => updateRectangleSelection({
                pointerId: state.pointerId, clientX: state.lastClientX, clientY: state.lastClientY, preventDefault() {},
            });
            rectangleSelection = state;
            body.addEventListener('scroll', state.onBodyScroll, {passive: true});
        }
        function render() {
            if (disposed) return;
            cancelRectangleSelection();
            cardElements.clear();
            grid.replaceChildren();
            if (resultValid) sortVisible().forEach(style => {
                const card = node('article', 'daki-test-target-gallery-card');
                card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0');
                card.setAttribute('aria-label', `${style.name || style.id} 선택`);
                card.setAttribute('data-style-id', style.id);
                const src = style.preview_kind === 'test' ? style.src || '' : library === 'personal'
                    ? style.source_path ? style.src || `/api/daki/personal-styles/${encodeURIComponent(style.id)}/preview` : ''
                    : style.src || '';
                if (src) {
                    const image = node('img', 'daki-test-target-gallery-thumb'); image.src = src; image.alt = style.name || '';
                    image.loading = 'lazy'; image.draggable = false;
                    card.appendChild(image);
                } else if (library === 'personal') {
                    card.appendChild(node('div', 'daki-test-target-gallery-missing', '대표 그림 없음'));
                } else {
                    card.appendChild(node('div', 'daki-test-target-gallery-missing', '그림 미리보기 없음'));
                }
                const choice = node('div', 'daki-test-target-gallery-choice');
                const name = node('span', '', style.name || style.id); name.title = style.name || style.id;
                choice.appendChild(name); card.appendChild(choice);
                const recommendationCount = Number.isSafeInteger(style.recommendation_count) && style.recommendation_count >= 0
                    ? style.recommendation_count.toLocaleString('ko-KR')
                    : null;
                card.appendChild(node('span', 'daki-test-target-gallery-recommendations', recommendationCount === null ? '추천 수 확인 불가' : `추천 ${recommendationCount}개`));
                card.onclick = event => {
                    if (consumeSuppressedPointerClick(event)) return;
                    toggleCardSelection(style.id);
                };
                card.onkeydown = event => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleCardSelection(style.id);
                };
                card.className = 'daki-test-target-gallery-card' + (selected.has(style.id) ? ' is-selected' : '');
                card.setAttribute('aria-pressed', String(selected.has(style.id)));
                card.setAttribute('aria-disabled', String(Boolean(pending || error || recommendationError || !resultValid)));
                cardElements.set(style.id, {card});
                grid.appendChild(card);
            });
            if (pending) status.textContent = '필터를 적용하는 중…';
            else if (error) status.textContent = error;
            else if (!resultValid) status.textContent = '필터를 수정했습니다. 결과를 보려면 필터 적용을 눌러 주세요.';
            else status.textContent = currentVisible().length ? '' : '조건에 맞는 현재 그림체가 없습니다.';
            status.className = 'daki-test-target-gallery-status' + (error ? ' is-error' : '');
            updateControls();
        }
        function updateControls() {
            const canUseResults = !pending && !error && !recommendationError && resultValid;
            counts.textContent = `표시 ${resultValid ? currentVisible().length : 0}개 / 현재 그림체 ${styles.length}개 · 전체 선택 ${selected.size}개`;
            selectVisible.disabled = !canUseResults || !currentVisible().length;
            applyButton.disabled = !canUseResults;
            clearSelection.disabled = !selected.size;
        }
        function invalidateEditedFilters() {
            if (disposed) return;
            cancelRectangleSelection();
            requestToken++;
            pending = false; error = false; resultValid = false; visible = [];
            render();
        }
        async function applyFilters() {
            if (disposed) return;
            cancelRectangleSelection();
            const filters = normalizedFilters();
            const token = ++requestToken;
            pending = true; error = false; resultValid = false; visible = [];
            render();
            try {
                const response = await root.fetch('/api/daki/style-tests/targets/filter', {
                    method: 'POST', cache: 'no-store', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({library, ...filters}),
                });
                const result = await response.json();
                if (!response.ok || result.status !== 'success') throw new Error(result.message || '필터를 적용하지 못했습니다.');
                if (!Array.isArray(result.style_ids)) throw new Error('필터 결과를 확인할 수 없습니다.');
                if (disposed || token !== requestToken) return;
                const matched = new Set(result.style_ids.filter(id => typeof id === 'string'));
                visible = styles.filter(style => style && typeof style.id === 'string' && matched.has(style.id));
                resultValid = true;
            } catch (reason) {
                if (disposed || token !== requestToken) return;
                visible = []; resultValid = false; error = reason?.message || '필터를 적용하지 못했습니다.';
            } finally {
                if (!disposed && token === requestToken) { pending = false; render(); }
            }
        }
        function cleanup() {
            if (disposed) return;
            cancelRectangleSelection();
            disposed = true; activePicker.closed = true; requestToken++;
            dialog.remove(); onClose?.();
        }
        selectVisible.onclick = () => {
            if (pending || error || recommendationError || !resultValid) return;
            currentVisible().forEach(style => selected.add(style.id)); render();
        };
        clearSelection.onclick = () => { selected.clear(); render(); };
        filterButton.onclick = applyFilters;
        sortSelect.onchange = () => { cancelRectangleSelection(); render(); };
        minimumInput.oninput = updateMinimumRecommendation;
        includeInput.oninput = excludeInput.oninput = invalidateEditedFilters;
        grid.addEventListener('pointerdown', startRectangleSelection);
        grid.addEventListener('pointermove', updateRectangleSelection);
        grid.addEventListener('pointerup', event => {
            if (!rectangleSelection || event.pointerId !== rectangleSelection.pointerId) return;
            cancelRectangleSelection(false);
            syncCardSelection(); updateControls();
        });
        grid.addEventListener('pointercancel', event => {
            if (rectangleSelection && event.pointerId === rectangleSelection.pointerId) cancelRectangleSelection(true);
        });
        grid.addEventListener('click', consumeSuppressedPointerClick, {capture: true});
        cancelButton.onclick = closeButton.onclick = () => activePicker.close();
        dialog.addEventListener('cancel', event => { event.preventDefault(); cleanup(); });
        applyButton.onclick = () => {
            if (pending || error || recommendationError || !resultValid) return;
            const ids = styles.map(style => style?.id).filter(id => typeof id === 'string' && selected.has(id));
            onApply?.(ids);
            activePicker.close();
        };
        dialog.addEventListener('close', cleanup, {once: true});
        doc.body.appendChild(dialog);
        dialog.showModal();
        render();
        return activePicker;
    }
    root.DakiTestTargetGallery = {open};
})(typeof window === 'undefined' ? globalThis : window);
