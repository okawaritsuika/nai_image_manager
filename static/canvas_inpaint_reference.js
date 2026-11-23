(function (root) {
    'use strict';

    const DEFAULT_WIDTH = 320;
    const MIN_WIDTH = 64;
    const MAX_WIDTH = 1024;
    const WIDTH_STEP = 64;
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 8;
    const MAX_IMAGE_SCALE = 32;
    const doc = root.document || null;

    let state = defaultSnapshot();
    let hooks = {};
    let sidebar = null;
    let sidebarParts = null;
    let fileInput = null;
    let currentStatus = '';
    let currentStatusIsError = false;
    let operationEpoch = 0;
    let pendingOperation = null;
    let lastContextKey = null;
    let lastProjectKey = null;
    let lastProjectIdKey = null;
    let imageCacheEntry = null;
    const actionMounts = new WeakMap();
    const sizeEditors = new WeakMap();
    let clipPreviewOpen = false;
    let clipStrip = null;

    function defaultSnapshot() {
        return {reference: null, showArea: false, include: false};
    }

    function clamp(value, minimum, maximum) {
        return Math.min(Math.max(value, minimum), maximum);
    }

    function finiteNumber(value, fallback, minimum, maximum) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
        return clamp(value, minimum, maximum);
    }

    function validImageSource(src) {
        if (typeof src !== 'string' || src.length > 4096
            || !src.startsWith('/canvas-imports/') || src.includes('?') || src.includes('#')
            || src.includes('\\') || src.includes('\u0000') || src.startsWith('//')) return false;
        let relative = src.slice('/canvas-imports/'.length);
        if (!relative) return false;
        for (;;) {
            if (relative.startsWith('/') || relative.includes('\\') || relative.includes('\u0000')
                || relative.split('/').includes('..')) return false;
            let decoded;
            try {
                decoded = decodeURIComponent(relative);
            } catch (_) {
                return false;
            }
            if (decoded === relative) return true;
            relative = decoded;
        }
    }

    function normalizeReference(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || !validImageSource(value.src)) return null;
        const name = value.name === undefined ? '참고 이미지' : value.name;
        const width = value.width === undefined ? DEFAULT_WIDTH : value.width;
        const x = value.x === undefined ? 0.5 : value.x;
        const y = value.y === undefined ? 0.5 : value.y;
        const zoom = value.zoom === undefined ? 1 : value.zoom;
        const scale = value.scale === undefined ? 1 : value.scale;
        const panX = value.panX === undefined ? 0.5 : value.panX;
        const panY = value.panY === undefined ? 0.5 : value.panY;
        if (!Number.isFinite(scale) || scale < 0.1 || scale > MAX_IMAGE_SCALE || typeof name !== 'string' || name.length > 500
            || !Number.isFinite(panX) || panX < 0 || panX > 1
            || !Number.isFinite(panY) || panY < 0 || panY > 1
            || !Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH || width % WIDTH_STEP
            || typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1
            || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y > 1
            || typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < MIN_ZOOM || zoom > MAX_ZOOM) {
            return null;
        }
        return {src: value.src, name, width, x, y, zoom, ...(scale === 1 ? {} : {scale}),
            ...(panX === 0.5 ? {} : {panX}), ...(panY === 0.5 ? {} : {panY})};
    }

    function normalizeSnapshot(value) {
        if (value === undefined) return defaultSnapshot();
        if (!value || typeof value !== 'object' || Array.isArray(value)) return defaultSnapshot();
        const include = value.include === true;
        return {
            reference: normalizeReference(value.reference),
            showArea: include,
            include
        };
    }

    function placementFor(refSnapshot) {
        if (!hasPlacementFields(refSnapshot?.reference)) return null;
        const ref = normalizeReference(refSnapshot?.reference);
        if (!ref || (ref.scale === undefined && ref.panX === undefined && ref.panY === undefined)) return null;
        const placement = {src: ref.src};
        if (ref.scale !== undefined) placement.scale = ref.scale;
        if (ref.panX !== undefined) placement.panX = ref.panX;
        if (ref.panY !== undefined) placement.panY = ref.panY;
        return placement;
    }

    function backupFor(refSnapshot) {
        const ref = normalizeReference(refSnapshot?.reference);
        return ref ? {...ref, include: refSnapshot.include === true} : null;
    }

    function storePlacement(layers, refSnapshot) {
        if (!Array.isArray(layers) || !layers.length) return layers;
        const bottom = layers[layers.length - 1];
        const carrier = bottom?.type === 'canvas' ? bottom : layers[0];
        if (!carrier || typeof carrier !== 'object' || Array.isArray(carrier)) return layers;
        const backup = backupFor(refSnapshot);
        if (backup) carrier.inpaintReferencePlacement = backup;
        else delete carrier.inpaintReferencePlacement;
        return layers;
    }

    function hasPlacementFields(ref) {
        return ref && ['scale', 'panX', 'panY'].some(key => Object.hasOwn(ref, key));
    }

    function restorePlacement(refSnapshot, layers, fallbackPlacement) {
        const ref = refSnapshot?.reference;
        const mayRestore = !hasPlacementFields(ref) && normalizeReference(ref);
        let restored = null;

        function take(candidate) {
            if (restored || !candidate) return;
            const full = typeof candidate.include === 'boolean' &&
                ['src', 'name', 'width', 'x', 'y', 'zoom'].every(key => Object.hasOwn(candidate, key));
            if (refSnapshot === undefined && full) {
                // v1.0 through v1.2 saved the layers but omitted the entire reference setting.
                const reference = normalizeReference(candidate);
                if (reference) restored = {reference, showArea: candidate.include, include: candidate.include};
            } else if (mayRestore && candidate.src === ref.src) {
                const placement = placementFor({reference: candidate});
                if (placement) restored = {...refSnapshot, reference: {...ref, ...placement}};
                else if (full && normalizeReference(candidate)) restored = refSnapshot;
            }
        }
        // An older editor may move or duplicate the carrier inside a folder.
        function clearLayers(items) {
            if (!Array.isArray(items)) return;
            for (const layer of items) {
                if (!layer || typeof layer !== 'object') continue;
                if (Object.hasOwn(layer, 'inpaintReferencePlacement')) {
                    take(layer.inpaintReferencePlacement);
                    delete layer.inpaintReferencePlacement;
                }
                if (Array.isArray(layer.children)) clearLayers(layer.children);
            }
        }
        clearLayers(layers);
        take(fallbackPlacement);
        return restored ?? refSnapshot;
    }

    function projectPlacementKey(projectId) {
        return typeof projectId === 'string' && /^[a-f0-9]{32}$/.test(projectId)
            ? 'naim:project-reference-placement:' + projectId : null;
    }

    function rememberProjectReference(projectId, sentReference, returnedSettings, supportsPlacement) {
        const key = projectPlacementKey(projectId);
        if (!key || !returnedSettings || typeof returnedSettings !== 'object') return;
        const saved = returnedSettings.inpaintReference;
        const sent = placementFor({reference: sentReference});
        const revision = returnedSettings.revision;
        const stripped = !supportsPlacement && sent && !hasPlacementFields(saved)
            && Number.isInteger(revision) && revision >= 0 && normalizeReference(saved)?.src === sent.src;
        try {
            const storage = root.localStorage;
            if (stripped) storage?.setItem(key, JSON.stringify({revision, placement: sent}));
            else if (storage?.getItem(key)) storage.removeItem(key);
        } catch (_) { /* Storage can be unavailable in a private browser. */ }
    }

    function readProjectReference(projectId, settings, supportsPlacement) {
        const ref = settings?.inpaintReference ?? null;
        const key = projectPlacementKey(projectId);
        if (!key) return ref;
        try {
            const storage = root.localStorage;
            const raw = storage?.getItem(key);
            if (raw) {
                const backup = JSON.parse(raw);
                // Immediately after upgrading the server, the old PUT may still be its exact latest revision.
                if (ref && !hasPlacementFields(ref) && (!supportsPlacement || backup?.revision === settings.revision)) {
                    const restored = restorePlacement({reference: ref}, null, backup?.placement).reference;
                    if (restored !== ref) return restored;
                }
                storage.removeItem(key);
            }
        } catch (_) { /* The reference from the server remains usable. */ }
        return ref;
    }

    function cloneReference(value) {
        const normalized = normalizeReference(value);
        return normalized ? {...normalized} : null;
    }

    function snapshot() {
        return {
            reference: cloneReference(state.reference),
            showArea: state.showArea === true,
            include: state.include === true
        };
    }

    function positiveInteger(value, label) {
        if (!Number.isInteger(value) || value <= 0) {
            throw new TypeError(label + ' 크기는 양의 정수여야 합니다.');
        }
        return value;
    }

    // Legacy helper retained for compatibility.
    function cropBox(sourceWidth, sourceHeight, targetWidth, targetHeight, reference) {
        positiveInteger(sourceWidth, '원본');
        positiveInteger(sourceHeight, '원본');
        positiveInteger(targetWidth, '대상');
        positiveInteger(targetHeight, '대상');
        const normalized = normalizeReference(reference);
        if (!normalized) throw new TypeError('참고 이미지 설정이 올바르지 않습니다.');
        const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight) * normalized.zoom;
        const width = targetWidth / scale;
        const height = targetHeight / scale;
        const x = clamp(normalized.x * sourceWidth - width / 2, 0, sourceWidth - width);
        const y = clamp(normalized.y * sourceHeight - height / 2, 0, sourceHeight - height);
        return {x, y, width, height};
    }

    function fitBox(sourceWidth, sourceHeight, targetWidth, targetHeight, imageScale = 1, panX = 0.5, panY = 0.5) {
        positiveInteger(sourceWidth, '원본');
        positiveInteger(sourceHeight, '원본');
        positiveInteger(targetWidth, '대상');
        positiveInteger(targetHeight, '대상');
        const scale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight) * imageScale;
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        return {
            x: Math.floor((targetWidth - width) * panX),
            y: Math.floor((targetHeight - height) * panY),
            width,
            height
        };
    }

    function request(width, height) {
        positiveInteger(width, '작업');
        positiveInteger(height, '작업');
        if (!state.include) return {width, height, reference: null};
        const reference = cloneReference(state.reference);
        if (!reference) throw new Error('인페인팅에 포함할 참고 이미지를 먼저 추가해 주세요.');
        return {width: width + reference.width, height, reference};
    }

    function safeContext(forPreview = false) {
        try {
            return typeof hooks.getContext === 'function' ? hooks.getContext(forPreview) : null;
        } catch (_) {
            return null;
        }
    }

    function contextKey() {
        const context = safeContext();
        if (!context || typeof context !== 'object') return '';
        const selection = context.selection || {};
        const clip = context.clip || {};
        return JSON.stringify([
            selection.id ?? null,
            clip.id ?? null, clip.imageWidth ?? null, clip.imageHeight ?? null,
            Number(context.canvasWidth) || 0, Number(context.canvasHeight) || 0
        ]);
    }

    function projectLink() {
        try {
            const value = typeof hooks.getProjectLink === 'function' ? hooks.getProjectLink() : null;
            if (!value || typeof value.projectId !== 'string'
                || !/^[a-f0-9]{32}$/.test(value.projectId)) return null;
            return {...value};
        } catch (_) {
            return null;
        }
    }

    function projectKey(link = projectLink()) {
        return link ? JSON.stringify([
            link.projectId || null,
            link.canvasId || null,
            link.side || null
        ]) : '';
    }

    function projectIdKey(link = projectLink()) {
        return link ? link.projectId : '';
    }

    function oppositeSide(link) {
        return link?.side === 'front' ? 'back' : link?.side === 'back' ? 'front' : null;
    }

    function validOppositeLink(link) {
        return Boolean(link && /^[a-f0-9]{32}$/.test(link.projectId)
            && /^[a-f0-9]{32}$/.test(link.canvasId) && oppositeSide(link));
    }

    function cancelPendingOperation() {
        operationEpoch += 1;
        const operation = pendingOperation;
        pendingOperation = null;
        if (operation?.controller && !operation.controller.signal.aborted) {
            operation.controller.abort();
        }
        syncControls();
        syncActionMounts();
    }

    function checkExternalChanges() {
        const nextContextKey = contextKey();
        const nextProjectKey = projectKey();
        const nextProjectIdKey = projectIdKey();
        const contextChanged = lastContextKey !== null && nextContextKey !== lastContextKey;
        const linkChanged = lastProjectKey !== null && nextProjectKey !== lastProjectKey;
        const projectChanged = lastProjectIdKey !== null && nextProjectIdKey !== lastProjectIdKey;
        if (contextChanged || (pendingOperation?.kind === 'opposite-load' ? linkChanged : projectChanged)) {
            cancelPendingOperation();
        }
        lastContextKey = nextContextKey;
        lastProjectKey = nextProjectKey;
        lastProjectIdKey = nextProjectIdKey;
    }

    function startOperation(kind, includeProject = false) {
        if (pendingOperation) return null;
        const Controller = root.AbortController || AbortController;
        const operation = {
            kind,
            epoch: operationEpoch,
            contextKey: contextKey(),
            projectKey: includeProject
                ? (kind === 'opposite-load' ? projectKey() : projectIdKey()) : '',
            controller: new Controller()
        };
        pendingOperation = operation;
        currentStatus = kind === 'upload'
            ? '이미지를 확인하고 가져오는 중…'
            : kind === 'project-save' ? '프로젝트에 등록하는 중…'
                : kind === 'opposite-load' ? '반대면 참고 이미지를 불러오는 중…'
                    : '프로젝트 참고 이미지를 불러오는 중…';
        currentStatusIsError = false;
        syncControls();
        syncActionMounts();
        return operation;
    }

    function operationIsCurrent(operation) {
        return Boolean(operation && pendingOperation === operation
            && operation.epoch === operationEpoch
            && !operation.controller.signal.aborted
            && operation.contextKey === contextKey()
            && (!operation.projectKey || operation.projectKey === (operation.kind === 'opposite-load'
                ? projectKey() : projectIdKey())));
    }

    function finishOperation(operation) {
        if (pendingOperation !== operation) return;
        pendingOperation = null;
        syncControls();
        syncActionMounts();
    }

    function setStatus(message, isError = false) {
        currentStatus = String(message || '');
        currentStatusIsError = isError === true;
        syncStatus();
    }

    function hasCanvas() {
        const context = safeContext();
        return Number(context?.canvasWidth) > 0 && Number(context?.canvasHeight) > 0;
    }

    function syncStatus() {
        const target = sidebarParts?.status;
        if (!target) return;
        const message = !hasCanvas() ? '캔버스를 만든 뒤 참고 이미지를 추가할 수 있습니다.' : currentStatus;
        target.textContent = message;
        target.hidden = !message;
        target.classList.toggle('is-error', Boolean(hasCanvas() && currentStatusIsError));
    }

    function referenceInfoText() {
        const reference = state.reference;
        if (!reference) return '선택 영역을 조절하면 요청 크기를 확인할 수 있습니다.';
        return state.include
            ? '참고 폭 ' + reference.width + 'px · 전체 요청 폭에 포함'
            : '참고 폭 ' + reference.width + 'px · 포함 해제됨';
    }

    function syncControls() {
        if (!sidebarParts) return;
        const hasRef = Boolean(state.reference);
        const canvasAvailable = hasCanvas();
        const link = projectLink();
        const busy = Boolean(pendingOperation);
        const oppositePickerAvailable = typeof root.CanvasOppositeReference?.open === 'function';
        sidebarParts.add.disabled = !canvasAvailable || busy;
        sidebarParts.oppositeLoad.disabled = !canvasAvailable || busy
            || !validOppositeLink(link) || !oppositePickerAvailable;
        syncSizeEditor(sidebarParts.sizing);
        sidebarParts.showArea.checked = state.showArea === true;
        sidebarParts.showArea.disabled = !hasRef || !canvasAvailable || busy;
        sidebarParts.clear.disabled = !hasRef || busy;
        sidebarParts.projectSave.disabled = !link || !hasRef || busy;
        sidebarParts.projectLoad.disabled = !link || busy;
        sidebarParts.info.textContent = referenceInfoText();
        const src = state.reference?.src || '';
        if (sidebarParts.thumbnail.dataset.src !== src) {
            sidebarParts.thumbnail.dataset.src = src;
            sidebarParts.thumbnail.hidden = !src;
            if (src) sidebarParts.thumbnail.src = src;
            else sidebarParts.thumbnail.removeAttribute?.('src');
        }
        sidebarParts.name.textContent = state.reference ? state.reference.name : '등록된 참고 이미지 없음';
        sidebarParts.name.title = state.reference ? state.reference.name : '';
        syncStatus();
    }

    function buildElement(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function createSizeEditor(inClip = false) {
        const box = buildElement('div', 'canvas-reference-sizing');
        const widthRow = buildElement('label', 'canvas-inpaint-reference-control');
        widthRow.appendChild(buildElement('span', '', '참고 영역 폭'));
        const widthInput = buildElement('input');
        widthInput.type = 'number';
        widthInput.min = String(MIN_WIDTH);
        widthInput.max = String(MAX_WIDTH);
        widthInput.step = String(WIDTH_STEP);
        widthInput.value = String(DEFAULT_WIDTH);
        widthInput.addEventListener('change', () => setReferenceWidth(widthInput));
        widthRow.append(widthInput, doc.createTextNode('px'));

        const scaleRow = buildElement('label', 'canvas-inpaint-reference-control');
        const scaleInput = buildElement('input');
        scaleInput.type = 'range';
        scaleInput.min = '10';
        scaleInput.max = String(MAX_IMAGE_SCALE * 100);
        scaleInput.step = '1';
        const percentage = buildElement('span', 'canvas-reference-percent');
        scaleRow.append(buildElement('span', '', '그림 크기'), scaleInput, percentage);
        const previewHost = buildElement('div');
        const preview = inClip ? null : root.CanvasInpaintReferencePreview?.mount(previewHost);
        const editor = {widthInput, scaleInput, percentage, preview, info: inClip ? previewHost : null};
        widthInput.addEventListener('input', () => {
            if (!state.reference || pendingOperation) return;
            const width = Number(widthInput.value);
            if (!Number.isInteger(width) || width < MIN_WIDTH || width > MAX_WIDTH || width % WIDTH_STEP) return;
            preview?.update({...state.reference, width}, editor.clip, state.include, fitBox);
            updateClipStrip({...state.reference, width});
        });
        scaleInput.addEventListener('input', () => {
            if (!state.reference || pendingOperation) return;
            const scale = Number(scaleInput.value) / 100;
            percentage.textContent = scaleInput.value + '%';
            preview?.update({...state.reference, scale}, editor.clip, state.include, fitBox);
            updateClipStrip({...state.reference, scale});
        });
        scaleInput.addEventListener('change', () => {
            if (!state.reference || pendingOperation) return;
            const scale = Number(scaleInput.value) / 100;
            if (scale === 1) delete state.reference.scale;
            else state.reference.scale = scale;
            persistAndRender(false);
        });
        box.append(previewHost, widthRow, scaleRow);
        sizeEditors.set(box, editor);
        return box;
    }

    function syncSizeEditor(box) {
        const editor = sizeEditors.get(box);
        if (!editor) return;
        const ref = state.reference;
        const disabled = !ref || !hasCanvas() || Boolean(pendingOperation);
        editor.widthInput.disabled = editor.scaleInput.disabled = disabled;
        editor.widthInput.value = String(ref?.width || DEFAULT_WIDTH);
        editor.scaleInput.value = String(Math.round((ref?.scale || 1) * 100));
        editor.percentage.textContent = editor.scaleInput.value + '%';
        if (editor.preview && sidebarParts?.disclosure.open) {
            editor.clip = safeContext(true)?.clip;
            editor.preview.update(ref, editor.clip, state.include, fitBox);
        }
        if (editor.info) {
            const clip = safeContext()?.clip;
            const width = clip?.imageWidth || clip?.layerWidth;
            const height = clip?.imageHeight || clip?.layerHeight;
            editor.info.textContent = state.include && ref && width && height
                ? `전송 ${width + ref.width} × ${height}px · 왼쪽 참고 그림을 끌어 위치 조절`
                : '참고 이미지를 포함하면 클립 왼쪽에 표시됩니다.';
        }
    }

    function ensureSidebar() {
        if (!doc) return;
        const host = doc.getElementById('canvasInpaintReferenceControls');
        if (!host) return;
        if (sidebar === host && sidebarParts) {
            syncControls();
            return;
        }
        sidebar = host;
        host.replaceChildren();
        host.classList.add('canvas-inpaint-reference-controls');

        const disclosure = buildElement('details', 'canvas-inpaint-reference-disclosure');
        disclosure.addEventListener('toggle', () => {
            if (disclosure.open) syncSizeEditor(sidebarParts.sizing);
        });
        const summary = buildElement('summary', 'canvas-inpaint-reference-summary');
        const title = buildElement('h3', 'canvas-inpaint-reference-title', '인페인팅 참고 이미지');
        summary.appendChild(title);
        const body = buildElement('div', 'canvas-inpaint-reference-body');
        const name = buildElement('p', 'canvas-inpaint-reference-name', '등록된 참고 이미지 없음');
        const identity = buildElement('div', 'canvas-inpaint-reference-file-row');
        const thumbnail = buildElement('img', 'canvas-inpaint-reference-thumbnail');
        thumbnail.alt = '등록한 참고 그림';
        identity.append(thumbnail, name);
        const status = buildElement('p', 'canvas-inpaint-reference-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');

        fileInput = buildElement('input', 'canvas-inpaint-reference-file');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.hidden = true;
        fileInput.addEventListener('change', () => {
            const file = fileInput.files?.[0] || null;
            fileInput.value = '';
            if (file) void uploadImage(file);
        });

        const imageActions = buildElement('div', 'canvas-inpaint-reference-row');
        const add = buildElement('button', 'secondary', '이미지 추가');
        add.type = 'button';
        add.addEventListener('click', openFilePicker);
        const oppositeLoad = buildElement('button', 'secondary', '반대면에서 가져오기');
        oppositeLoad.type = 'button';
        oppositeLoad.addEventListener('click', openOppositePicker);
        imageActions.append(add, oppositeLoad);

        const sizing = createSizeEditor();
        const showAreaLabel = buildElement('label', 'canvas-inpaint-reference-checkbox');
        const showArea = buildElement('input');
        showArea.type = 'checkbox';
        showArea.addEventListener('change', () => {
            setReferenceIncluded(showArea.checked);
        });
        showAreaLabel.append(showArea, doc.createTextNode('전송할 이미지에 참고 영역 포함'));

        const info = buildElement('p', 'canvas-inpaint-reference-info');
        const projectActions = buildElement('div', 'canvas-inpaint-reference-row');
        const projectSave = buildElement('button', 'secondary', '프로젝트에 등록');
        projectSave.type = 'button';
        projectSave.addEventListener('click', () => void saveProjectTemplate());
        const projectLoad = buildElement('button', 'secondary', '프로젝트에서 가져오기');
        projectLoad.type = 'button';
        projectLoad.addEventListener('click', () => void importProjectTemplate());
        projectActions.append(projectSave, projectLoad);

        const clear = buildElement('button', 'canvas-inpaint-reference-clear', '참고 해제');
        clear.type = 'button';
        clear.addEventListener('click', () => {
            state.reference = null;
            state.showArea = false;
            state.include = false;
            cachedImageFor(null);
            currentStatus = '참고 이미지를 해제했습니다.';
            currentStatusIsError = false;
            persistAndRender();
        });

        body.append(identity, imageActions, showAreaLabel, sizing, info, projectActions, clear, status, fileInput);
        disclosure.append(summary, body);
        host.appendChild(disclosure);
        sidebarParts = {disclosure, title, name, thumbnail, status, add, oppositeLoad, sizing, showArea, info,
            projectSave, projectLoad, clear};
        syncControls();
    }

    function openFilePicker() {
        if (!fileInput || pendingOperation || !hasCanvas()) return;
        fileInput.click();
    }

    function setReferenceWidth(input) {
        const value = input.value;
        if (!state.reference || pendingOperation) return;
        const numeric = typeof value === 'string' && value.trim() === '' ? Number.NaN : Number(value);
        if (!Number.isFinite(numeric)) {
            input.value = String(state.reference.width);
            render();
            return;
        }
        const width = clamp(Math.round(numeric / WIDTH_STEP) * WIDTH_STEP, MIN_WIDTH, MAX_WIDTH);
        if (width === state.reference.width) {
            input.value = String(state.reference.width);
            render();
            return;
        }
        state.reference.width = width;
        persistAndRender();
    }

    function persistAndRender(redrawCanvas = true) {
        syncControls();
        syncActionMounts();
        try {
            const result = typeof hooks.save === 'function' ? hooks.save() : undefined;
            if (result && typeof result.then === 'function') {
                result.catch(error => setStatus('참고 이미지 설정을 저장하지 못했습니다. ' + error.message, true));
            }
        } catch (error) {
            setStatus('참고 이미지 설정을 저장하지 못했습니다. ' + error.message, true);
        }
        try {
            if (redrawCanvas && typeof hooks.redraw === 'function') hooks.redraw();
        } catch (error) {
            setStatus('캔버스를 다시 그리지 못했습니다. ' + error.message, true);
        }
        render();
    }

    function cachedImageFor(src) {
        if (!src || imageCacheEntry?.src !== src) imageCacheEntry = null;
    }

    function loadImage(src) {
        if (imageCacheEntry?.src === src) return imageCacheEntry.promise;
        const ImageConstructor = root.Image || (typeof Image !== 'undefined' ? Image : null);
        if (!ImageConstructor) return Promise.reject(new Error('이미지를 미리 볼 수 없습니다.'));
        const entry = {src, image: new ImageConstructor(), promise: null};
        imageCacheEntry = entry;
        entry.promise = new Promise((resolve, reject) => {
            const finish = () => {
                if ((entry.image.naturalWidth || entry.image.width) > 0
                    && (entry.image.naturalHeight || entry.image.height) > 0) {
                    resolve(entry.image);
                } else {
                    reject(new Error('이미지 크기를 확인할 수 없습니다.'));
                }
            };
            entry.image.onload = finish;
            entry.image.onerror = () => reject(new Error('참고 이미지를 불러오지 못했습니다.'));
            entry.image.decoding = 'async';
            entry.image.src = src;
            if (entry.image.complete) finish();
        }).catch(error => {
            if (imageCacheEntry === entry) imageCacheEntry = null;
            throw error;
        });
        return entry.promise;
    }

    function parseResponse(response, payload) {
        if (response.status === 409) {
            throw new Error('프로젝트 설정이 다른 곳에서 변경되었습니다. 연결 설정을 새로고침한 뒤 다시 등록해 주세요.');
        }
        if (!response.ok || !payload || payload.status !== 'success') {
            throw new Error(payload?.message || '요청을 완료하지 못했습니다.');
        }
        return payload;
    }

    async function fetchJson(url, options) {
        const response = await root.fetch(url, options);
        let payload;
        try {
            payload = await response.json();
        } catch (_) {
            payload = null;
        }
        return {...parseResponse(response, payload),
            supportsPlacement: response.headers?.get('X-NAIM-Reference-Placement') === '1'};
    }

    function uploadedDescriptor(payload, file) {
        const descriptor = normalizeReference({
            src: payload.src || payload.path,
            name: payload.name || file.name || '참고 이미지',
            width: state.reference?.width || DEFAULT_WIDTH,
            scale: state.reference?.scale,
            x: 0.5, y: 0.5, zoom: 1
        });
        if (!descriptor) throw new Error('가져온 이미지 경로 또는 이름을 확인할 수 없습니다.');
        if (!(Number(payload.width) > 0) || !(Number(payload.height) > 0)) {
            throw new Error('이미지 크기를 확인할 수 없습니다.');
        }
        return descriptor;
    }

    async function uploadImage(file) {
        if (pendingOperation || !hasCanvas()) return;
        const type = String(file.type || '').toLowerCase();
        const ext = String(file.name || '').split('.').pop().toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)
            && !['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
            setStatus('PNG, JPEG, WebP 이미지만 추가할 수 있습니다.', true);
            return;
        }
        const operation = startOperation('upload');
        if (!operation) return;
        try {
            const form = new root.FormData();
            form.append('file', file);
            if (typeof hooks.sessionId === 'string' && hooks.sessionId) {
                form.append('sessionId', hooks.sessionId);
            }
            const response = await root.fetch('/api/canvas/upload_image', {
                method: 'POST', body: form, signal: operation.controller.signal
            });
            const payload = await response.json();
            parseResponse(response, payload);
            if (!operationIsCurrent(operation)) return;
            const descriptor = uploadedDescriptor(payload, file);
            await loadImage(descriptor.src);
            if (!operationIsCurrent(operation)) return;
            state.reference = descriptor;
            currentStatus = '참고 이미지를 추가했습니다.';
            currentStatusIsError = false;
            persistAndRender();
        } catch (error) {
            if (operationIsCurrent(operation)) setStatus('참고 이미지를 추가하지 못했습니다. ' + error.message, true);
        } finally {
            finishOperation(operation);
            syncControls();
        }
    }

    function projectEndpoint(projectId) {
        return '/api/daki/projects/' + encodeURIComponent(projectId) + '/canvas-settings';
    }

    async function saveProjectTemplate() {
        const reference = cloneReference(state.reference);
        const link = projectLink();
        if (!reference || !link || pendingOperation) return;
        const operation = startOperation('project-save', true);
        if (!operation) return;
        try {
            const endpoint = projectEndpoint(link.projectId);
            const result = await fetchJson(endpoint, {signal: operation.controller.signal});
            if (!operationIsCurrent(operation)) return;
            const existing = result.settings;
            if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
                throw new Error('프로젝트 캔버스 설정을 확인할 수 없습니다.');
            }
            const {revision, ...settings} = existing;
            const body = {revision, settings: {...settings, inpaintReference: reference}};
            if (!operationIsCurrent(operation)) return;
            const saved = await fetchJson(endpoint, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json', 'X-NAIM-Reference-Placement': '1'},
                body: JSON.stringify(body),
                signal: operation.controller.signal
            });
            if (!operationIsCurrent(operation)) return;
            rememberProjectReference(link.projectId, reference, saved.settings, saved.supportsPlacement);
            setStatus('참고 이미지를 프로젝트 설정에 등록했습니다.');
        } catch (error) {
            if (operationIsCurrent(operation)) setStatus(error.message, true);
        } finally {
            finishOperation(operation);
            syncControls();
        }
    }

    async function importProjectTemplate() {
        const link = projectLink();
        if (!link || pendingOperation) return;
        const operation = startOperation('project-load', true);
        if (!operation) return;
        try {
            const result = await fetchJson(projectEndpoint(link.projectId), {
                signal: operation.controller.signal
            });
            if (!operationIsCurrent(operation)) return;
            const reference = normalizeReference(readProjectReference(link.projectId, result.settings, result.supportsPlacement));
            if (!reference) throw new Error('프로젝트에 가져올 참고 이미지가 없습니다.');
            await loadImage(reference.src);
            if (!operationIsCurrent(operation)) return;
            state.reference = {...reference};
            currentStatus = '프로젝트 참고 이미지를 가져왔습니다. 참고 폭을 조정할 수 있습니다.';
            currentStatusIsError = false;
            persistAndRender();
        } catch (error) {
            if (operationIsCurrent(operation)) setStatus(error.message, true);
        } finally {
            finishOperation(operation);
            syncControls();
        }
    }

    function openOppositePicker() {
        const link = projectLink();
        const picker = root.CanvasOppositeReference;
        if (pendingOperation || !hasCanvas() || !validOppositeLink(link)
            || typeof picker?.open !== 'function') return;
        try {
            picker.open({onChoose: chosen => { void importOppositeReference(link, chosen); }});
        } catch (error) {
            setStatus('반대면 참고 이미지를 가져오지 못했습니다. ' + error.message, true);
        }
    }

    function oppositeChoiceIsValid(link, chosen) {
        return validOppositeLink(link) && chosen && typeof chosen === 'object'
            && chosen.projectId === link.projectId && chosen.visible === true
            && ['candidate', 'canvas'].includes(chosen.kind)
            && /^[a-f0-9]{32}$/.test(chosen.id);
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

    function validCandidateSource(source) {
        return typeof source === 'string' && source.trim() === source
            && source.startsWith('/') && !source.startsWith('//')
            && !source.includes('\\') && !source.includes('\u0000');
    }

    function oppositeTitle(value, side) {
        return typeof value === 'string' && value.trim() && value.length <= 500
            ? value : (side === 'front' ? '앞면 그림' : '뒷면 그림');
    }

    function imageFileExtension(type) {
        return ({'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'})[type] || '';
    }

    async function importOppositeReference(link, chosen) {
        if (pendingOperation || !hasCanvas() || !oppositeChoiceIsValid(link, chosen)
            || projectKey(link) !== projectKey(projectLink())) return;
        const operation = startOperation('opposite-load', true);
        if (!operation) return;
        try {
            const side = oppositeSide(link);
            const result = await fetchJson('/api/daki/projects/' + encodeURIComponent(link.projectId), {
                signal: operation.controller.signal
            });
            if (!operationIsCurrent(operation)) return;
            if (!result.project || result.project.id !== link.projectId) {
                throw new Error('프로젝트 정보를 확인할 수 없습니다.');
            }
            const record = findOppositeRecord(result.project, link, chosen);
            if (!record) throw new Error('선택한 반대면 그림을 프로젝트에서 찾을 수 없습니다.');

            let source;
            let title;
            if (chosen.kind === 'candidate') {
                if (record.missing || !validCandidateSource(record.src)) {
                    throw new Error('선택한 후보 그림 파일을 찾을 수 없습니다.');
                }
                source = record.src;
                title = oppositeTitle(record.name, side);
            } else {
                const canvasResult = await fetchJson('/api/daki/projects/'
                    + encodeURIComponent(link.projectId) + '/canvases/' + encodeURIComponent(chosen.id), {
                    signal: operation.controller.signal
                });
                if (!operationIsCurrent(operation)) return;
                const canvas = canvasResult.canvas;
                if (canvasResult.project?.id !== link.projectId || !canvas || canvas.id !== chosen.id
                    || canvas.side !== side || !canvas.state) {
                    throw new Error('선택한 반대면 캔버스를 불러오지 못했습니다.');
                }
                if (typeof root.renderMergedCanvasToDataUrl !== 'function') {
                    throw new Error('캔버스 미리보기 기능을 사용할 수 없습니다.');
                }
                source = await root.renderMergedCanvasToDataUrl({state: canvas.state, maxDimension: 1600});
                if (!operationIsCurrent(operation)) return;
                if (typeof source !== 'string' || !source.startsWith('data:image/')) {
                    throw new Error('캔버스 미리보기를 만들지 못했습니다.');
                }
                title = oppositeTitle(canvas.name, side);
            }

            const sourceResponse = await root.fetch(source, {signal: operation.controller.signal});
            if (!operationIsCurrent(operation)) return;
            if (!sourceResponse.ok) throw new Error('선택한 반대면 그림 파일을 불러오지 못했습니다.');
            const blob = await sourceResponse.blob();
            if (!operationIsCurrent(operation)) return;
            const extension = imageFileExtension(String(blob?.type || '').toLowerCase());
            if (!blob || !extension) throw new Error('선택한 그림의 형식을 확인할 수 없습니다.');

            const form = new root.FormData();
            form.append('file', blob, 'opposite-reference.' + extension);
            if (typeof hooks.sessionId === 'string' && hooks.sessionId) {
                form.append('sessionId', hooks.sessionId);
            }
            const uploadResponse = await root.fetch('/api/canvas/upload_image', {
                method: 'POST', body: form, signal: operation.controller.signal
            });
            if (!operationIsCurrent(operation)) return;
            let payload;
            try {
                payload = await uploadResponse.json();
            } catch (_) {
                payload = null;
            }
            if (!operationIsCurrent(operation)) return;
            parseResponse(uploadResponse, payload);
            let descriptor = uploadedDescriptor(payload, {name: title});
            descriptor.name = title;
            descriptor = normalizeReference(descriptor);
            if (!descriptor) throw new Error('가져온 이미지 이름 또는 경로를 확인할 수 없습니다.');
            await loadImage(descriptor.src);
            if (!operationIsCurrent(operation)) return;
            state.reference = descriptor;
            state.include = true;
            state.showArea = true;
            currentStatus = '반대면 참고 이미지를 가져왔습니다.';
            currentStatusIsError = false;
            persistAndRender();
        } catch (error) {
            if (operationIsCurrent(operation)) {
                setStatus('반대면 참고 이미지를 가져오지 못했습니다. ' + error.message, true);
            }
        } finally {
            finishOperation(operation);
            syncControls();
        }
    }

    function mountActions(container) {
        if (!container || !doc) return null;
        if (actionMounts.has(container)) {
            syncActionMounts();
            return actionMounts.get(container);
        }
        const existing = container.querySelector?.('.canvas-inpaint-reference-actions');
        if (existing) {
            actionMounts.set(container, existing);
            syncActionMounts();
            return existing;
        }
        const row = buildElement('div', 'canvas-inpaint-reference-actions');
        const label = buildElement('label', 'canvas-inpaint-reference-action-label');
        const checkbox = buildElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
            setReferenceIncluded(checkbox.checked);
        });
        label.append(checkbox, doc.createTextNode('참고 이미지 포함'));
        const disclosure = buildElement('details', 'canvas-reference-clip-disclosure');
        disclosure.open = clipPreviewOpen;
        disclosure.append(buildElement('summary', '', '전송 배치와 크기 조절'), createSizeEditor(true));
        disclosure.addEventListener('toggle', () => {
            if (disclosure.isConnected) clipPreviewOpen = disclosure.open;
        });
        row.append(label, disclosure);
        container.appendChild(row);
        actionMounts.set(container, row);
        syncActionMounts();
        return row;
    }

    function syncActionMounts() {
        if (!doc) return;
        updateClipStrip(state.reference);
        doc.querySelectorAll('.canvas-inpaint-reference-actions').forEach(row => {
            const sizing = row.querySelector('.canvas-reference-sizing');
            if (sizing) {
                sizing.parentElement.hidden = !state.reference;
                if (state.reference) syncSizeEditor(sizing);
            }
            const checkbox = row.querySelector('input[type="checkbox"]');
            if (checkbox) {
                checkbox.checked = state.include === true;
                checkbox.disabled = !state.reference || Boolean(pendingOperation);
            }
        });
    }

    function updateClipStrip(ref) {
        if (!clipStrip) return;
        const {host, view} = clipStrip;
        if (!host.isConnected) {
            clipStrip = null;
            return;
        }
        const hidden = !ref || !state.include;
        const width = String(ref?.width || 0);
        const layoutChanged = host.hidden !== hidden || host.dataset.referenceWidth !== width;
        host.hidden = hidden;
        host.inert = Boolean(pendingOperation);
        host.dataset.referenceWidth = width;
        view.update(ref, safeContext()?.clip, state.include, fitBox);
        if (layoutChanged) host.dispatchEvent(new Event('clip-reference-layout', {bubbles: true}));
    }

    function mountClipStrip(host) {
        if (!host || !root.CanvasInpaintReferencePreview?.mountStrip) return;
        if (clipStrip?.host !== host) {
            const view = root.CanvasInpaintReferencePreview.mountStrip(host, (panX, panY, commit) => {
                if (!state.reference || !state.include || pendingOperation || clipStrip?.host !== host) return;
                const ref = normalizeReference({...state.reference, panX, panY});
                if (!ref) return;
                const editor = sidebarParts && sizeEditors.get(sidebarParts.sizing);
                editor?.preview?.update(ref, editor.clip, true, fitBox);
                if (commit && (state.reference.panX !== ref.panX || state.reference.panY !== ref.panY)) {
                    state.reference = ref;
                    persistAndRender(false);
                }
            });
            clipStrip = {host, view};
        }
        updateClipStrip(state.reference);
    }

    function setReferenceIncluded(include) {
        state.showArea = include === true;
        state.include = include === true;
        persistAndRender();
    }

    function render() {
        checkExternalChanges();
        ensureSidebar();
        syncControls();
        syncActionMounts();
    }

    function configure(options = {}) {
        cancelPendingOperation();
        hooks = {
            getContext: typeof options.getContext === 'function' ? options.getContext : () => null,
            save: typeof options.save === 'function' ? options.save : () => {},
            redraw: typeof options.redraw === 'function' ? options.redraw : () => {},
            getProjectLink: typeof options.getProjectLink === 'function' ? options.getProjectLink : () => null,
            sessionId: typeof options.sessionId === 'string' ? options.sessionId : ''
        };
        lastContextKey = null;
        lastProjectKey = null;
        lastProjectIdKey = null;
        render();
    }

    function restore(value) {
        cancelPendingOperation();
        state = normalizeSnapshot(value);
        currentStatus = '';
        currentStatusIsError = false;
        cachedImageFor(state.reference?.src || null);
        render();
    }

    const api = {
        configure,
        snapshot,
        restore,
        normalizeSnapshot,
        normalizeReference,
        placementFor,
        backupFor,
        storePlacement,
        restorePlacement,
        rememberProjectReference,
        readProjectReference,
        fitBox,
        cropBox,
        request,
        mountActions,
        mountClipStrip,
        render
    };

    root.CanvasInpaintReference = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
