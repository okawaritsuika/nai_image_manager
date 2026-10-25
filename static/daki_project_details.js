/* Read-only detail view for the layer structure saved in a Daki project canvas. */
(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (root) root.DakiProjectDetails = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const labels = Object.freeze({
        folder: '폴더',
        selection: '선택 영역',
        clip: '클립 이미지',
        image: '이미지 레이어',
        canvas: '캔버스',
    });
    const fallbackType = '기타 레이어';
    const previewFields = [
        'type', 'src', 'x', 'y', 'layerWidth', 'layerHeight', 'imageWidth', 'imageHeight',
        'pinnedReference', 'renderOnCanvas', 'name',
    ];
    let modal = null;
    let active = null;
    let revision = 0;

    function layerType(layer) {
        return typeof layer.type === 'string'
            && Object.prototype.hasOwnProperty.call(labels, layer.type)
            ? labels[layer.type]
            : fallbackType;
    }

    function copyPreviewFields(source, target) {
        target.visible = Boolean(source.visible);
        for (const field of previewFields) {
            if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
            const value = source[field];
            if (field === 'name') {
                if (typeof value === 'string') target.name = value;
            } else if (field === 'type' || field === 'src') {
                if (typeof value === 'string') target[field] = value;
            } else if (field === 'pinnedReference' || field === 'renderOnCanvas') {
                target[field] = Boolean(value);
            } else if (typeof value === 'number' || typeof value === 'string') {
                target[field] = value;
            }
        }
    }

    function clonePreviewTree(layers, forceRootVisible = false) {
        const copies = new Array(layers.length);
        const rows = [];
        const stack = [];
        for (let index = layers.length - 1; index >= 0; index--) {
            const copy = {};
            copies[index] = copy;
            stack.push({source: layers[index], target: copy, depth: 0, parentIndex: null});
        }

        while (stack.length) {
            const item = stack.pop();
            const source = item.source && typeof item.source === 'object' && !Array.isArray(item.source)
                ? item.source
                : {};
            copyPreviewFields(source, item.target);
            if (item.depth === 0 && forceRootVisible) item.target.visible = true;
            const type = layerType(item.target);
            const parentHidden = item.parentIndex !== null && rows[item.parentIndex].effectiveHidden;
            const ownHidden = item.target.visible === false;
            const rowIndex = rows.length;
            rows.push({
                node: item.target,
                index: rowIndex,
                parentIndex: item.parentIndex,
                name: typeof item.target.name === 'string' && item.target.name.trim() ? item.target.name : type,
                type,
                depth: item.depth,
                originalVisible: item.target.visible,
                effectiveHidden: parentHidden || ownHidden,
                visibility: ownHidden ? '숨김' : parentHidden ? '상위 레이어 숨김' : '',
            });

            if (Array.isArray(source.children)) {
                item.target.children = new Array(source.children.length);
                for (let index = source.children.length - 1; index >= 0; index--) {
                    const child = {};
                    item.target.children[index] = child;
                    stack.push({
                        source: source.children[index],
                        target: child,
                        depth: item.depth + 1,
                        parentIndex: rowIndex,
                    });
                }
            }
        }
        return {layers: copies, rows, total: rows.length};
    }

    function buildPreviewModel(state) {
        const input = state && typeof state === 'object' ? state : {};
        const tree = clonePreviewTree(Array.isArray(input.layers) ? input.layers : []);
        return {width: input.width, height: input.height, layers: tree.layers, rows: tree.rows, total: tree.total};
    }

    function clonePreviewNode(node, forceVisible = false) {
        return clonePreviewTree([node], forceVisible).layers[0];
    }

    function summarizeLayers(layers) {
        const model = buildPreviewModel({layers});
        return {
            total: model.total,
            rows: model.rows.map(row => ({
                name: row.name,
                type: row.type,
                depth: row.depth,
                visibility: row.visibility,
            })),
        };
    }

    function makeElement(tag, className, text) {
        const element = root.document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function createMetadataCell(label, value) {
        const cell = makeElement('div', 'daki-project-details-cell');
        const term = makeElement('dt', '', label);
        const detail = makeElement('dd', '', value);
        cell.append(term, detail);
        return {cell, detail};
    }

    function ensureModal() {
        if (modal) return modal;
        const dialog = makeElement('dialog', 'daki-dialog daki-project-details-dialog');
        dialog.id = 'dakiProjectDetailsDialog';
        dialog.setAttribute('aria-labelledby', 'dakiProjectDetailsTitle');

        const header = makeElement('header', 'daki-project-details-header');
        const title = makeElement('h2', '', '캔버스 상세 정보');
        title.id = 'dakiProjectDetailsTitle';
        const topClose = makeElement('button', 'daki-project-details-close', '×');
        topClose.type = 'button';
        topClose.setAttribute('aria-label', '닫기');
        header.append(title, topClose);

        const body = makeElement('div', 'daki-project-details-body');
        const summary = makeElement('section', 'daki-project-details-summary');
        const side = makeElement('span', 'daki-project-details-side');
        const name = makeElement('strong', 'daki-project-details-name');
        summary.append(side, name);

        const metadata = makeElement('dl', 'daki-project-details-metadata');
        const size = createMetadataCell('크기', '알 수 없음');
        const layerCount = createMetadataCell('레이어', '알 수 없음');
        const created = createMetadataCell('생성일', '알 수 없음');
        const updated = createMetadataCell('수정일', '알 수 없음');
        metadata.append(size.cell, layerCount.cell, created.cell, updated.cell);

        const workspace = makeElement('div', 'daki-project-details-workspace');
        const previewSection = makeElement('section', 'daki-project-details-preview-section');
        const previewTitle = makeElement('h3', '', '합성 미리보기');
        const preview = makeElement('div', 'daki-project-details-preview', '불러오는 중…');
        preview.setAttribute('aria-label', '캔버스 합성 미리보기');
        preview.setAttribute('role', 'status');
        const previewHelp = makeElement('p', 'daki-project-details-preview-help', '표시·숨김은 이 미리보기에만 적용됩니다.');
        const reset = makeElement('button', 'daki-project-details-reset', '저장 상태로');
        reset.type = 'button';
        reset.hidden = true;
        previewSection.append(previewTitle, preview, previewHelp, reset);

        const layerSection = makeElement('section', 'daki-project-details-layers');
        const layerTitle = makeElement('h3', '', '레이어 구성');
        const status = makeElement('p', 'daki-project-details-status', '레이어 정보를 불러오는 중…');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const list = makeElement('ul', 'daki-project-details-list');
        list.hidden = true;
        const retry = makeElement('button', 'daki-project-details-retry', '다시 불러오기');
        retry.type = 'button';
        retry.hidden = true;
        layerSection.append(layerTitle, status, list, retry);
        workspace.append(previewSection, layerSection);

        body.append(summary, metadata, workspace);
        const footer = makeElement('footer', 'daki-project-details-footer');
        const footerClose = makeElement('button', 'daki-project-details-footer-close', '닫기');
        footerClose.type = 'button';
        footer.append(footerClose);
        dialog.append(header, body, footer);
        root.document.body.appendChild(dialog);

        topClose.addEventListener('click', () => close(true));
        footerClose.addEventListener('click', () => close(true));
        retry.addEventListener('click', () => active && startRequest(active));
        reset.addEventListener('click', () => active && resetVisibility(active));
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            close(true);
        });
        dialog.addEventListener('close', () => {
            if (!dialog.open && active) close(true);
        });
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') event.stopPropagation();
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) close(true);
        });

        modal = {dialog, body, side, name, size: size.detail, layerCount: layerCount.detail,
            created: created.detail, updated: updated.detail, preview, reset, status, list, retry, footerClose};
        return modal;
    }

    function safeIsCurrent(context) {
        if (typeof context.isCurrent !== 'function') return true;
        try {
            return context.isCurrent() !== false;
        } catch (_) {
            return false;
        }
    }

    function isActiveRequest(context, token) {
        return active === context && context.token === token && revision === token
            && modal && modal.dialog.open && safeIsCurrent(context);
    }

    function formatDate(context, value) {
        if (typeof context.formatDate !== 'function') return value || '알 수 없음';
        try {
            const formatted = context.formatDate(value);
            return typeof formatted === 'string' && formatted ? formatted : '알 수 없음';
        } catch (_) {
            return '알 수 없음';
        }
    }

    function displayNumber(value) {
        return typeof value === 'number' && Number.isFinite(value) ? String(value) : '알 수 없음';
    }

    function updateSummary(context, canvas) {
        const width = displayNumber(canvas.width);
        const height = displayNumber(canvas.height);
        const count = displayNumber(canvas.layerCount);
        modal.side.textContent = canvas.side === 'front' ? '앞면'
            : canvas.side === 'back' ? '뒷면' : '알 수 없음';
        modal.name.textContent = typeof canvas.name === 'string' ? canvas.name : '이름 없음';
        modal.size.textContent = width === '알 수 없음' || height === '알 수 없음'
            ? '알 수 없음' : `${width} × ${height} px`;
        modal.layerCount.textContent = count === '알 수 없음' ? count : `${count}개`;
        modal.created.textContent = formatDate(context, canvas.created_at);
        modal.updated.textContent = formatDate(context, canvas.updated_at);
    }

    function layerExclusion(node) {
        if (node.type === 'image' && node.pinnedReference) return '참고 이미지 · 합성 제외';
        if (node.type === 'clip' && !node.renderOnCanvas) return '원본 클립 · 합성 제외';
        return '';
    }

    function safeThumbnailSource(source) {
        if (typeof source !== 'string' || !source) return '';
        if (/^data:image\/[a-z0-9.+-]+(?:;|,)/i.test(source)) return source;
        if (!root.URL || !root.location || !root.location.href) return '';
        try {
            const url = new root.URL(source, root.location.href);
            if (url.origin !== root.location.origin
                || !(url.pathname.startsWith('/image/') || url.pathname.startsWith('/canvas-imports/'))) return '';
            url.searchParams.set('preview', '256');
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function setThumbnailPlaceholder(container, text = '미리보기 없음') {
        container.replaceChildren(makeElement('span', 'daki-project-details-thumbnail-placeholder', text));
    }

    function makeLayerThumbnail(row) {
        const container = makeElement('div', 'daki-project-details-thumbnail');
        container.setAttribute('aria-label', `${row.name} 미리보기`);
        if (row.node.type === 'folder' || row.node.type === 'selection') {
            container.textContent = '불러오는 중…';
            row.previewContainer = container;
            return container;
        }
        const source = (row.node.type === 'image' || row.node.type === 'clip')
            ? safeThumbnailSource(row.node.src) : '';
        if (!source) {
            setThumbnailPlaceholder(container);
            return container;
        }
        const image = makeElement('img', 'daki-project-details-layer-thumbnail');
        image.alt = '';
        image.loading = 'lazy';
        image.onerror = () => setThumbnailPlaceholder(container);
        image.src = source;
        container.appendChild(image);
        return container;
    }

    function refreshLayerVisibility(model) {
        for (const row of model.rows) {
            const parentHidden = row.parentIndex !== null && model.rows[row.parentIndex].effectiveHidden;
            const ownHidden = row.node.visible === false;
            row.effectiveHidden = parentHidden || ownHidden;
            row.visibility = ownHidden ? '숨김' : parentHidden ? '상위 레이어 숨김' : '';
            if (row.visibilityNode) row.visibilityNode.textContent = row.visibility;
            if (row.checkbox) row.checkbox.checked = row.node.visible;
        }
    }

    function disposePreviews(context) {
        context.previewManager?.dispose();
        context.groupManager?.dispose();
        context.previewManager = null;
        context.groupManager = null;
    }

    function releaseContext(context) {
        if (!context) return;
        if (context.controller) context.controller.abort();
        disposePreviews(context);
        context.model = null;
    }

    function previewState(context) {
        return {
            width: context.model.width,
            height: context.model.height,
            layers: clonePreviewTree(context.model.layers).layers,
        };
    }

    function unavailablePreview(container) {
        container.textContent = '미리보기를 불러올 수 없습니다.';
        container.setAttribute('role', 'status');
        container.removeAttribute('aria-busy');
    }

    function renderCompositePreviews(context) {
        disposePreviews(context);
        const previewApi = root.DakiCanvasPreviews;
        if (!previewApi || typeof previewApi.create !== 'function') {
            unavailablePreview(modal.preview);
            for (const row of context.model.rows) {
                if (row.previewContainer) unavailablePreview(row.previewContainer);
            }
            return;
        }

        const savedAt = `${context.token}:${++context.previewRevision}`;
        try {
            context.previewManager = previewApi.create();
            modal.preview.textContent = '불러오는 중…';
            context.previewManager.observeState(modal.preview, {
                id: String(context.canvas.id),
                name: context.canvas.name || '캔버스',
                savedAt,
                state: previewState(context),
            });
        } catch (_) {
            context.previewManager?.dispose();
            context.previewManager = null;
            unavailablePreview(modal.preview);
        }

        const groups = context.model.rows.filter(row => row.previewContainer);
        if (!groups.length) return;
        try {
            context.groupManager = previewApi.create();
            for (const row of groups) {
                row.previewContainer.textContent = '불러오는 중…';
                row.previewContainer.setAttribute('aria-label', `${row.name} 합성 미리보기`);
                row.previewContainer.setAttribute('role', 'status');
                context.groupManager.observeState(row.previewContainer, {
                    id: `${context.canvas.id}:layer:${row.index}`,
                    name: row.name,
                    savedAt,
                    state: {
                        width: context.model.width,
                        height: context.model.height,
                        layers: [clonePreviewNode(row.node, true)],
                    },
                });
            }
        } catch (_) {
            context.groupManager?.dispose();
            context.groupManager = null;
            for (const row of groups) unavailablePreview(row.previewContainer);
        }
    }

    function renderRows(context) {
        const rows = context.model.rows;
        modal.list.replaceChildren();
        for (const [index, row] of rows.entries()) {
            const item = makeElement('li', 'daki-project-details-row');
            item.style.paddingLeft = `${8 + Math.min(row.depth, 2) * 12}px`;
            const thumbnail = makeLayerThumbnail(row);
            const information = makeElement('div', 'daki-project-details-layer-info');
            const name = makeElement('span', 'daki-project-details-layer-name', row.name);
            const metadata = makeElement('span', 'daki-project-details-layer-meta');
            metadata.append(makeElement('span', 'daki-project-details-layer-type', row.type));
            const visibility = makeElement('span', 'daki-project-details-layer-visibility', row.visibility);
            row.visibilityNode = visibility;
            metadata.appendChild(visibility);
            const exclusion = layerExclusion(row.node);
            if (exclusion) metadata.append(makeElement('span', 'daki-project-details-layer-exclusion', exclusion));
            information.append(name, metadata);

            const label = makeElement('label', 'daki-project-details-visibility-control');
            const checkbox = makeElement('input', 'daki-project-details-visibility-toggle');
            checkbox.type = 'checkbox';
            checkbox.checked = row.node.visible;
            checkbox.setAttribute('aria-label', `${row.name} 표시`);
            checkbox.disabled = Boolean(exclusion);
            const labelText = makeElement('span', '', '표시');
            label.append(checkbox, labelText);
            row.checkbox = checkbox;
            checkbox.addEventListener('change', () => setLayerVisibility(context, index, checkbox.checked));
            item.append(thumbnail, information, label);
            modal.list.appendChild(item);
        }
        modal.list.hidden = rows.length === 0;
        modal.reset.hidden = rows.length === 0;
        refreshLayerVisibility(context.model);
    }

    function setLayerVisibility(context, index, visible) {
        if (active !== context || !context.model || !modal || !modal.dialog.open || !safeIsCurrent(context)) return;
        const row = context.model.rows[index];
        if (!row || !row.checkbox || row.checkbox.disabled) return;
        row.node.visible = Boolean(visible);
        refreshLayerVisibility(context.model);
        renderCompositePreviews(context);
    }

    function resetVisibility(context) {
        if (active !== context || !context.model || !modal || !modal.dialog.open || !safeIsCurrent(context)) return;
        for (const row of context.model.rows) row.node.visible = row.originalVisible;
        refreshLayerVisibility(context.model);
        renderCompositePreviews(context);
    }

    function showLoading(context) {
        disposePreviews(context);
        context.model = null;
        modal.preview.textContent = '불러오는 중…';
        modal.preview.setAttribute('role', 'status');
        modal.preview.setAttribute('aria-busy', 'true');
        modal.reset.hidden = true;
        modal.status.textContent = '레이어 정보를 불러오는 중…';
        modal.retry.hidden = true;
        modal.retry.disabled = true;
        modal.list.hidden = true;
        modal.list.replaceChildren();
    }

    function showFailure(context, message) {
        disposePreviews(context);
        context.model = null;
        modal.preview.textContent = '미리보기를 불러올 수 없습니다.';
        modal.preview.setAttribute('role', 'status');
        modal.preview.removeAttribute('aria-busy');
        modal.reset.hidden = true;
        const detail = typeof message === 'string' ? message.trim() : '';
        modal.status.textContent = detail
            ? `레이어 정보를 불러오지 못했습니다. ${detail}`
            : '레이어 정보를 불러오지 못했습니다.';
        modal.list.hidden = true;
        modal.list.replaceChildren();
        modal.retry.hidden = false;
        modal.retry.disabled = false;
    }

    async function loadLayers(context, token, controller) {
        showLoading(context);
        try {
            const url = `/api/daki/projects/${encodeURIComponent(context.projectId)}`
                + `/canvases/${encodeURIComponent(context.canvas.id)}`;
            const response = await root.fetch(url, {method: 'GET', signal: controller.signal});
            let result;
            try {
                result = await response.json();
            } catch (_) {
                result = null;
            }
            if (!isActiveRequest(context, token)) {
                releaseContext(context);
                return false;
            }
            if (!response.ok || !result || result.status !== 'success') {
                showFailure(context, result && typeof result.message === 'string' ? result.message : '');
                return false;
            }
            const saved = result.canvas;
            const state = saved && saved.state;
            if (!saved || !state || !Array.isArray(state.layers)) {
                showFailure(context, '응답 형식을 확인해 주세요.');
                return false;
            }

            const model = buildPreviewModel(state);
            const summary = {
                ...context.canvas,
                id: saved.id,
                name: saved.name,
                side: saved.side,
                created_at: saved.created_at,
                updated_at: saved.updated_at,
                width: state.width,
                height: state.height,
                layerCount: model.total,
            };
            context.canvas = {...context.canvas, ...summary};
            context.model = model;
            updateSummary(context, summary);
            renderRows(context);
            renderCompositePreviews(context);
            modal.status.textContent = model.total
                ? `총 ${model.total}개 레이어`
                : '저장된 레이어가 없습니다.';
            modal.retry.hidden = true;
            modal.retry.disabled = true;
            return true;
        } catch (_) {
            if (!isActiveRequest(context, token)) {
                releaseContext(context);
                return false;
            }
            showFailure(context, '');
            return false;
        }
    }

    function startRequest(context) {
        if (active !== context || !modal || !modal.dialog.open || !safeIsCurrent(context)) {
            return Promise.resolve(false);
        }
        if (context.loading) return context.promise;
        if (context.controller) context.controller.abort();
        const token = ++revision;
        context.token = token;
        context.controller = new root.AbortController();
        context.loading = true;
        context.promise = loadLayers(context, token, context.controller).finally(() => {
            if (context.token === token) context.loading = false;
        });
        return context.promise;
    }

    function open(options) {
        const settings = options || {};
        if (typeof settings.projectId !== 'string' || !settings.projectId
            || !settings.canvas || typeof settings.canvas.id !== 'string' || !settings.canvas.id) {
            throw new TypeError('projectId와 canvas.id가 필요합니다.');
        }
        const context = {
            projectId: settings.projectId,
            canvas: {...settings.canvas},
            opener: settings.opener || null,
            isCurrent: settings.isCurrent,
            formatDate: settings.formatDate,
            controller: null,
            model: null,
            previewManager: null,
            groupManager: null,
            previewRevision: 0,
            loading: false,
            promise: null,
            token: 0,
        };
        if (!safeIsCurrent(context)) return Promise.resolve(false);
        if (active) releaseContext(active);
        active = context;
        const instance = ensureModal();
        instance.body.scrollTop = 0;
        updateSummary(context, context.canvas);
        showLoading(context);
        if (!instance.dialog.open) instance.dialog.showModal();
        instance.footerClose.focus({preventScroll: true});
        return startRequest(context);
    }

    function close(restoreFocus = true) {
        const context = active;
        active = null;
        revision++;
        releaseContext(context);
        const wasOpen = Boolean(modal && modal.dialog.open);
        if (modal && modal.dialog.open) modal.dialog.close();
        if (modal) {
            modal.preview.textContent = '';
            modal.preview.removeAttribute('aria-busy');
            modal.preview.removeAttribute('role');
            modal.list.replaceChildren();
            modal.list.hidden = true;
            modal.reset.hidden = true;
            modal.retry.hidden = true;
        }
        if (restoreFocus && context && context.opener && context.opener.isConnected
            && typeof context.opener.focus === 'function') {
            context.opener.focus({preventScroll: true});
        }
        return Boolean(context || wasOpen);
    }

    return {open, close, summarizeLayers, buildPreviewModel};
});
