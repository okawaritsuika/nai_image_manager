/* Keep native working pixels visible while the editor computes changed regions. */
(function (root) {
    'use strict';
    const doc = root.document;
    const byId = id => doc.getElementById(id);
    const model = () => root.CanvasRetouchState;
    const clone = value => structuredClone(value);
    let draft = null, savedDrafts = [], session = null, copied = null, serial = 0, draftSelectBound = false;
    let inputTrace = null, inputSerial = 0;
    const API = '/api/canvas/retouch/';
    const CONFLICT_RETRIES = 20, CONFLICT_RETRY_DELAY = 300, MAX_CONFLICT_RETRY_DELAY = 3000;
    const DETAIL_LOADING_MESSAGE = '확대 영역에 보정 결과를 반영하는 중…';
    const DETAIL_ERROR_MESSAGE = '확대 영역을 불러오지 못했습니다. 화면을 조금 이동해 다시 시도해 주세요.';
    const APPLY_FIRST_POLL_DELAY = 80, APPLY_POLL_DELAY = 250;
    const editableTools = new Set(['paint', 'airbrush', 'clone', 'liquify', 'maskAdd', 'maskErase', 'rect', 'ellipse']);

    const clock = () => root.performance.timeOrigin + root.performance.now();
    function trace(input, phase, time) {
        if (!input || !inputTrace) return;
        try {inputTrace({...input, phase, time: time ?? clock()});}
        catch (_) { /* Profiling must not affect the edit. */ }
    }
    function tracePointer(s, kind, started) {
        if (!inputTrace) return;
        s.inputSample = {id: ++inputSerial, tool: s.tool, kind};
        trace(s.inputSample, 'event', started);
        trace(s.inputSample, 'coordinates');
    }
    function presentNative(s, input) {
        trace(input, 'pixels-applied');
        const frames = input && s.nativeSurface.viewStats?.()?.frames;
        s.nativeSurface.presentView?.();
        if (frames !== undefined && s.nativeSurface.viewStats?.()?.frames > frames) trace(input, 'render-submitted');
    }

    function valid(s) {
        return session === s && s.serial === serial && s.layers === canvasLayers
            && s.width === currentCanvasWidth && s.height === currentCanvasHeight;
    }
    function copiedSettings() {
        return root.CanvasWorkspaceBridge?.isPane ? root.CanvasWorkspaceBridge.readRetouchSettings() : copied;
    }
    function readyMessage(s = session) {
        if (draft?.targetLayerId != null)
            return '보정 기록은 자동 저장돼요. 적용하면 선택한 기존 레이어를 업데이트합니다.';
        if (s?.resumingDraft)
            return '보정 기록은 자동 저장돼요. 초안의 합성본에서 이어서 보정하며, 적용하면 새 레이어를 추가합니다.';
        return '보정 기록은 자동 저장돼요. 적용하면 현재 합성본 위에 새 레이어를 추가합니다.';
    }
    function view(s) {
        return {...s, doc: s.entryPending ? null : draft?.document, editingExisting: !s.entryPending && draft?.targetLayerId != null,
            canUndo: s.history.canUndo, canRedo: s.history.canRedo,
            hasCopy: Boolean(copiedSettings()), otherAvailable: Boolean(byId('canvasOppositePreviewImage')?.src
                && !byId('canvasOppositePreview')?.hidden)};
    }
    function update(s = session) {
        if (s && valid(s)) s.panel?.update(view(s));
    }
    function message(text, error = false, s = session) {
        if (!s || !valid(s)) return;
        if (s.message === text && s.error === error) return;
        s.message = text; s.error = error; update(s);
    }
    function pendingDrafts() {
        return [...(draft ? [draft] : []), ...savedDrafts];
    }
    function refreshDraftControls() {
        const wrapper = byId('canvasRetouchDraftControls'), select = byId('canvasRetouchDraftSelect');
        if (!wrapper || !select) return;
        const items = pendingDrafts();
        wrapper.hidden = items.length === 0;
        while (select.children.length) select.removeChild(select.children[0]);
        const labels = items.map((item, index) => {
            const layers = Array.isArray(item.document?.layers) ? item.document.layers : [];
            const last = layers.at(-1);
            const description = `${index + 1}. ${item.targetLayerId != null ? '기존 레이어 편집' : '새 보정'} · ${last?.name || (last ? '보정 레이어' : '설정')} · 레이어 ${layers.length}개`;
            const option = doc.createElement('option');
            option.value = String(index); option.textContent = description; option.title = description;
            select.append(option);
            return description;
        });
        select.value = items.length ? '0' : '';
        select.title = labels[0] || '';
        if (!draftSelectBound && typeof select.addEventListener === 'function') {
            select.addEventListener('change', () => {
                const option = Array.from(select.options || select.children || []).find(item => item.value === select.value);
                select.title = option?.title || option?.textContent || '';
            });
            draftSelectBound = true;
        }
    }
    function normalizeDraft(value) {
        const document = model()?.normalize(value?.document);
        return document ? {document, targetLayerId: Number.isInteger(value?.targetLayerId) ? value.targetLayerId : null} : null;
    }
    function hasDraftWork(value) {
        if (!value?.document) return false;
        if (value.targetLayerId != null) return true;
        const document = value.document;
        const empty = model()?.normalize({version: 1, source: document.source, width: document.width,
            height: document.height, layers: []});
        return !empty || JSON.stringify(document) !== JSON.stringify(empty);
    }
    function selected() {
        return draft?.document.layers.find(item => item.id === session?.selectedId);
    }
    function syncSelection(s) {
        const layers = draft.document.layers, ids = new Set(layers.map(layer => layer.id));
        s.selectedIds = [...new Set(s.selectedIds)].filter(id => ids.has(id));
        if (!ids.has(s.selectedId)) s.selectedId = s.selectedIds.at(-1) || layers.at(-1)?.id || null;
        if (!s.selectedIds.includes(s.selectedId)) s.selectedIds = s.selectedId ? [s.selectedId] : [];
    }
    function selectLayer(s, id, multiple = false) {
        if (s.busy || s.stroke || !draft || !valid(s) || !draft.document.layers.some(layer => layer.id === id)) return;
        if (multiple) {
            const ids = new Set(s.selectedIds);
            if (ids.has(id)) {
                if (ids.size > 1) ids.delete(id);
                if (!ids.has(s.selectedId)) s.selectedId = [...ids].at(-1);
            } else {ids.add(id); s.selectedId = id;}
            s.selectedIds = [...ids];
        } else {s.selectedId = id; s.selectedIds = [id];}
        s.cloneSource = null; update(s); if (s.nativeSurface) {draw(s); refreshNativeMask(s);} else schedule(s);
    }
    function persist() {
        if (session && valid(session)) saveCanvasState();
    }
    function change(fn, coalesce = false, pixelsChanged = true, preserveNativeStroke = false) {
        const s = session;
        if (!s || s.busy || !draft || !valid(s)) return;
        const now = Date.now();
        if (!coalesce || now - s.lastChange > 400) s.history.push(draft.document);
        s.lastChange = now;
        fn(draft.document);
        if (pixelsChanged && !preserveNativeStroke) s.nativeSurface?.clearOptimistic(true);
        syncSelection(s);
        persist(); update(s); if (pixelsChanged) schedule(s, coalesce); else draw(s);
    }
    function tool(id) {
        const s = session; if (!s || s.busy) return;
        if (s.tool === 'airbrush' && id !== 'airbrush') s.airbrushBrush = {...s.brush};
        const leavingMaskEraser = s.tool === 'maskErase' && id !== 'maskErase';
        if (leavingMaskEraser) {
            s.eraserBrush = {size: s.brush.size, flow: s.brush.flow, hardness: s.brush.hardness};
            if (id !== 'airbrush' && s.brushBeforeEraser) Object.assign(s.brush, s.brushBeforeEraser);
            s.brushBeforeEraser = null;
        }
        if (id === 'airbrush') {
            if (s.tool !== 'airbrush' && s.airbrushBrush) Object.assign(s.brush, s.airbrushBrush);
            if (selected()?.type !== 'paint') {
                if (draft.document.layers.length >= 40) return message('보정 레이어는 40개까지 추가할 수 있어요.', true);
                change(value => {const layer = model().createLayer('paint'); layer.name = '에어브러시';
                    value.layers.push(layer); s.selectedId = layer.id;});
            }
            if (!s.airbrushConfigured) {
                const layer = selected(), last = layer?.strokes?.findLast(stroke => stroke.brush === 'airbrush');
                Object.assign(s.brush, {flow: 4, opacity: 100, hardness: 0, color: layer?.params.color || '#e47789'});
                if (last) Object.assign(s.brush, {size: last.radius * 2, flow: last.flow * 100,
                    opacity: last.opacity * 100, hardness: last.hardness * 100, color: last.color});
                s.airbrushConfigured = true;
            }
        }
        if (id === 'maskErase' && s.tool !== 'maskErase') {
            s.brushBeforeEraser = {...s.brush};
            if (!s.eraserBrush) s.eraserBrush = {size: s.brush.size, flow: 100, hardness: 0};
            Object.assign(s.brush, s.eraserBrush);
        }
        const kind = id === 'paint' ? 'paint' : id === 'clone' ? 'clone' : id === 'liquify' ? 'liquify' : null;
        if (kind && (!selected() || (kind !== 'paint' && selected().type !== kind))) add(kind);
        s.tool = id;
        if (id === 'maskAdd') s.brush.flow = 100;
        update(s); draw(s);
    }
    function add(type) {
        if (draft.document.layers.length >= 40) return message('보정 레이어는 40개까지 추가할 수 있어요.', true);
        change(value => {const layer = model().createLayer(type); value.layers.push(layer); session.selectedId = layer.id;});
    }
    function actions(s) {
        return {
            add(type) { add(type); const l = selected(); tool(type === 'liquify' || type === 'clone' || type === 'paint' ? type : l?.mask.base === 0 ? 'maskAdd' : 'hand'); },
            preset(id, strength = 1) {
                if (s.busy || !draft) return;
                const preset = model().createPreset(id, undefined, strength); if (!preset) return;
                const layers = preset.layers;
                if (draft.document.layers.length + layers.length > model().LIMITS.maxLayers)
                    return message(`이 프리셋에는 ${layers.length}개 레이어가 필요해요. 보정 레이어는 40개까지 추가할 수 있어요.`, true);
                if (preset.brush && s.tool === 'maskErase') tool('hand');
                if (preset.brush) {Object.assign(s.brush, preset.brush); s.airbrushBrush = {...s.brush}; s.airbrushConfigured = true;}
                change(value => {value.layers.push(...layers); s.selectedId = preset.layer.id;});
                tool(preset.tool); message(preset.hint);
            },
            recipe(selectedIds) {
                if (s.busy || !draft) return;
                const layers = model().recipe(undefined, selectedIds);
                if (!layers.length) return;
                if (draft.document.layers.length + layers.length > model().LIMITS.maxLayers)
                    return message(`선택한 ${layers.length}단계를 추가할 공간이 부족해요. 보정 레이어는 40개까지 사용할 수 있어요.`, true);
                change(value => {value.layers.push(...layers); s.selectedId = layers.at(-1).id;});
            },
            select(id, options = {}) { selectLayer(s, id, Boolean(options?.shiftKey)); },
            toggle(id) { change(value => {const l = value.layers.find(item => item.id === id); if (l) l.visible = !l.visible;}); },
            move(delta) { change(value => {const i = value.layers.findIndex(item => item.id === s.selectedId), next = i + delta;
                if (i >= 0 && next >= 0 && next < value.layers.length) [value.layers[i], value.layers[next]] = [value.layers[next], value.layers[i]];}); },
            duplicate() { if (!selected()) return; if (draft.document.layers.length >= 40) return message('보정 레이어는 40개까지 추가할 수 있어요.', true);
                change(value => {const l = clone(selected()); l.id = model().createLayer(l.type).id; l.name += ' 복사'; value.layers.push(l); s.selectedId = l.id;}); },
            remove() { change(value => {value.layers = value.layers.filter(item => item.id !== s.selectedId);}); },
            change(patch) { if (!selected()) return; change(() => {const l = selected(); if (patch.params) Object.assign(l.params, patch.params);
                for (const key of ['name', 'opacity']) if (key in patch) l[key] = patch[key];}, true); },
            mask(mode) { if (!selected()) return; change(() => {const l = selected();
                if (mode === 'clearShape') delete l.mask.shape; else l.mask = {base: mode === 'all' ? 1 : 0, strokes: []};});
                if (mode === 'painted') tool('maskAdd'); },
            setTool: tool,
            brush(key, value) { if (s.busy) return; s.brush[key] = key === 'color' ? value : Number(value); update(s); draw(s); },
            undo() { history(s, 'undo'); }, redo() { history(s, 'redo'); },
            compare(value) { s.compare = value; if (!value) cancelCompareDrag(s); update(s); draw(s); },
            compareSplit(value) { setCompareSplit(s, value); },
            guides(value) { s.guides = value; update(s); draw(s); },
            maskShow(value) { s.maskShow = value; update(s); if (s.nativeSurface) {draw(s); refreshNativeMask(s);} else schedule(s); },
            print(key, value) { change(valueDoc => {valueDoc.print[key] = Number(value);}, true, false); },
            copy() { copied = selected() && model().copySettings(selected());
                if (root.CanvasWorkspaceBridge?.isPane) root.CanvasWorkspaceBridge.writeRetouchSettings(copied);
                message(copied ? '색·강도 설정을 복사했어요. 다른 캔버스에서도 붙여넣을 수 있어요.' : '브러시·유동화는 좌표가 달라 설정 복사를 지원하지 않아요.'); },
            paste() { const settings = copiedSettings(); if (!settings) return; if (draft.document.layers.length >= 40) return message('보정 레이어는 40개까지 추가할 수 있어요.', true);
                change(value => {const l = model().copySettings(settings); value.layers.push(l); s.selectedId = l.id;}); },
            notes(value) { change(valueDoc => {valueDoc.notes = value;}, true, false); },
            check(index, checked) { change(valueDoc => {valueDoc.checks = checked ? [...new Set([...valueDoc.checks, index])] : valueDoc.checks.filter(x => x !== index);}, false, false); },
            apply() { apply(s, false); }, download() { apply(s, true); }, downloadPair() { downloadPair(s); },
            close() { close(); }
        };
    }
    function history(s, method) {
        if (s.busy) return;
        const next = s.history[method](draft.document); if (!next) return;
        if (!s.nativeSurface) cancelPreview(s);
        s.nativeSurface?.clearOptimistic(); s.nativeLocalStroke = false;
        stopAirbrush(s); cancelDraw(s); s.stroke = null; s.strokePreview = null; s.liquifyPreview = null; s.liveFeedback = null;
        draft.document = next;
        syncSelection(s);
        persist(); update(s); schedule(s);
    }
    function isMultipart(body) {
        return typeof FormData !== 'undefined' && body instanceof FormData;
    }
    async function request(path, body, signal, image = false) {
        const multipart = isMultipart(body);
        const response = await fetch(API + path, {method: body ? 'POST' : 'GET', signal,
            headers: body && !multipart ? {'Content-Type': 'application/json'} : undefined,
            body: multipart ? body : body ? JSON.stringify(body) : undefined});
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const failure = new Error(error.message || error.error || '보정을 처리하지 못했습니다.');
            failure.status = response.status; throw failure;
        }
        if (image === 'working') {
            const revision = Number(response.headers.get('X-Retouch-Revision'));
            if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('보정 응답을 확인할 수 없습니다.');
            if (response.status === 204) return {revision, image: null, region: null};
            const region = Object.fromEntries(['x', 'y', 'width', 'height'].map(key =>
                [key, Number(response.headers.get('X-Retouch-' + key[0].toUpperCase() + key.slice(1)))]));
            const bitmap = await createImageBitmap(await response.blob());
            return {revision, image: bitmap, region};
        }
        return image ? response.blob() : response.status === 204 ? null : response.json();
    }
    function abortError() {
        const error = new Error('요청이 취소되었습니다.'); error.name = 'AbortError'; return error;
    }
    function waitWhileActive(signal, canContinue, delay) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted || !canContinue()) return reject(abortError());
            let timer;
            const cleanup = () => signal?.removeEventListener('abort', onAbort);
            const onAbort = () => {clearTimeout(timer); cleanup(); reject(abortError());};
            signal?.addEventListener('abort', onAbort, {once: true});
            timer = setTimeout(() => {
                cleanup();
                if (signal?.aborted || !canContinue()) reject(abortError());
                else resolve();
            }, delay);
        });
    }
    function conflictRetryDelay(retry) {
        return Math.min(MAX_CONFLICT_RETRY_DELAY, CONFLICT_RETRY_DELAY * 2 ** retry);
    }
    async function requestWithConflictRetry(path, body, signal, image, canContinue) {
        const snapshot = body === undefined || isMultipart(body) ? body : clone(body);
        let retries = 0;
        while (true) {
            if (signal?.aborted || !canContinue()) throw abortError();
            try {
                return await request(path, snapshot, signal, image);
            } catch (error) {
                if (error.status !== 409 || retries >= CONFLICT_RETRIES) throw error;
                await waitWhileActive(signal, canContinue, conflictRetryDelay(retries++));
            }
        }
    }
    function payload(value = draft.document) {
        return {source: value.source, layers: value.layers, print: value.print};
    }
    function recordStroke(layer, stroke) {
        if (!layer) return;
        const {tool: used, layerId, layerIds, pointerId, ...record} = stroke;
        if (used === 'rect' || used === 'ellipse') {
            const [a, b] = [stroke.points[0], stroke.points.at(-1)];
            if (Math.abs(a[0] - b[0]) < 1 || Math.abs(a[1] - b[1]) < 1) return;
            layer.mask.shape = {kind: used, box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]};
        } else if (used === 'maskAdd' || used === 'maskErase' || used === 'paint' && layer.type !== 'paint') {
            layer.mask.strokes.push({...clone(record), erase: used === 'maskErase'});
        } else layer.strokes.push(record);
    }
    function strokeTargets(layers, stroke) {
        const ids = new Set(stroke.tool === 'maskErase' && stroke.layerIds ? stroke.layerIds : [stroke.layerId]);
        return layers.filter(layer => ids.has(layer.id));
    }
    function localStroke(s) {
        if (s.nativeSurface) return Boolean(s.stroke && s.nativeLocalStroke);
        return s.stroke && (s.stroke.tool === 'airbrush' || s.stroke.tool === 'liquify')
            && s.edited?.width === s.width && s.edited?.height === s.height;
    }
    function previewPayload(s) {
        const body = clone(payload());
        if (s.stroke && !localStroke(s)) {
            const targets = strokeTargets(body.layers, s.stroke);
            const count = body.layers.reduce((n, layer) => n + [...layer.strokes, ...layer.mask.strokes]
                .reduce((total, stroke) => total + stroke.points.length, 0), 0);
            if (count + s.stroke.points.length * targets.length <= model().LIMITS.maxPoints)
                targets.forEach(layer => recordStroke(layer, s.stroke));
        }
        return body;
    }
    function cancelPreview(s) {
        clearTimeout(s.timer); s.timer = null; s.previewVersion++;
        s.interactiveUntil = 0;
        s.previewEpoch++; s.previewQueued = false;
        s.previewController?.abort(); s.previewController = null;
        s.editorEngine?.cancelUpdate?.();
        s.viewport?.cancelPending();
    }
    function armPreview(s, delay = 0) {
        if (s.timer != null || s.previewInFlight || s.busy || localStroke(s)) return;
        if (!delay && s.stroke && s.editorEngine) {
            refresh(s);
            return;
        }
        s.delayedPreview = delay > 0;
        s.timer = setTimeout(() => {s.timer = null; s.delayedPreview = false; refresh(s);}, delay);
    }
    function schedule(s, interactive = false) {
        s.previewVersion++;
        s.previewQueued = true;
        s.previewRetries = 0;
        if (s.previewInFlight && !s.flushing) s.editorEngine?.cancelUpdate?.();
        s.interactiveUntil = interactive && s.editorEngine?.preview && nativeViewport(s) ? Date.now() + 140 : 0;
        if (s.delayedPreview) {clearTimeout(s.timer); s.timer = null; s.delayedPreview = false;}
        armPreview(s);
    }
    async function refreshNativeMask(s) {
        if (!valid(s) || !s.nativeSurface || !s.maskShow || !s.selectedId || s.stroke) return;
        const layerId = s.selectedId, layer = selected(), key = JSON.stringify(layer?.mask);
        if (s.mask && s.maskLayerId === layerId && s.maskKey === key) return;
        const version = s.previewVersion;
        try {
            const bitmap = s.editorEngine
                ? await nativeWorkerMask(s, layer)
                : await createImageBitmap(await request('mask', {...payload(), layerId}, undefined, true));
            if (!valid(s) || !s.maskShow || s.selectedId !== layerId || version !== s.previewVersion) {bitmap.close(); return;}
            s.mask?.close(); s.mask = bitmap; s.maskLayerId = layerId; s.maskKey = key; s.maskTint = null; draw(s);
        } catch (_) { /* Keep the image editable when an optional mask overlay is unavailable. */ }
    }
    async function nativeWorkerMask(s, layer) {
        const {patches} = await s.editorEngine.mask({layer, width: s.width, height: s.height});
        if (patches.length === 1) return createImageBitmap(patches[0].pixels);
        const canvas = doc.createElement('canvas');
        canvas.width = patches[0].region.width;
        canvas.height = patches.at(-1).region.y + patches.at(-1).region.height;
        const context = canvas.getContext('2d');
        for (const {pixels, region} of patches) context.putImageData(pixels, region.x, region.y);
        return createImageBitmap(canvas);
    }
    function nativeViewport(s) {
        if (s.width * s.height < 8_000_000 || !s.overlay) return null;
        const workspace = doc.querySelector('.canvas-workspace');
        if (!workspace) return null;
        const bounds = workspace.getBoundingClientRect(), image = s.overlay.getBoundingClientRect();
        if (!image.width || !image.height) return null;
        const sx = s.width / image.width, sy = s.height / image.height;
        const x = Math.max(0, Math.floor((bounds.left - image.left) * sx));
        const y = Math.max(0, Math.floor((bounds.top - image.top) * sy));
        const right = Math.min(s.width, Math.ceil((bounds.right - image.left) * sx));
        const bottom = Math.min(s.height, Math.ceil((bounds.bottom - image.top) * sy));
        if (right <= x || bottom <= y || (right - x) * (bottom - y) > 1_500_000) return null;
        return [x, y, right, bottom];
    }
    function brushViewport(s) {
        const stroke = s.stroke;
        if (!stroke || stroke.tool === 'rect' || stroke.tool === 'ellipse') return nativeViewport(s);
        const [x, y] = stroke.points.at(-1);
        const edge = Math.min(512, Math.ceil(2 * stroke.radius + 12));
        return [Math.max(0, Math.floor(x - edge)), Math.max(0, Math.floor(y - edge)),
            Math.min(s.width, Math.ceil(x + edge)), Math.min(s.height, Math.ceil(y + edge))];
    }
    async function renderNativePixels(s, body, signal, stillCurrent, version, input) {
        if (s.editorEngine) {
            try {
                trace(input, 'dispatch');
                return await s.editorEngine.update({...body, width: s.width, height: s.height,
                    profile: Boolean(input), viewport: s.viewportVersion === version ? null : brushViewport(s)}, (patches, timings) => {
                    if (stillCurrent() && !signal.aborted && version === s.previewVersion) {
                        for (const [phase, time] of Object.entries(timings || {})) trace(input, phase, time);
                        s.nativeSurface.showViewport(patches);
                        presentNative(s, input);
                    }
                });
            }
            catch (error) {
                if (error.name === 'AbortError' || signal.aborted || !stillCurrent()) throw abortError();
                console.warn('Canvas editor worker failed. Using the existing renderer.', error);
                s.editorEngine.destroy(); s.editorEngine = null;
            }
        }
        s.serverWorking = true;
        return requestWithConflictRetry('working', body, signal, 'working', stillCurrent);
    }
    async function refreshNative(s) {
        if (!valid(s) || s.busy && !s.flushing || localStroke(s)) return;
        if (s.previewInFlight) {s.previewQueued = true; return;}
        s.previewInFlight = true; s.previewQueued = false;
        const version = s.previewVersion, epoch = s.previewEpoch;
        const input = s.inputSample;
        s.inputSample = null;
        const controller = new AbortController(); s.previewController = controller;
        const body = {...previewPayload(s), workingId: s.workingId, baseRevision: s.workingRevision};
        s.nativeFailure = null;
        const viewport = !s.flushing && s.interactiveUntil > Date.now() && s.viewportVersion !== version && nativeViewport(s);
        const previewOnly = viewport && s.editorEngine?.preview;
        if (previewOnly) {
            const selectedId = s.selectedId;
            try {
                const {patches} = await s.editorEngine.preview({...body, width: s.width, height: s.height, viewport});
                if (valid(s) && epoch === s.previewEpoch && !controller.signal.aborted &&
                        version === s.previewVersion && s.interactiveUntil &&
                        selectedId === s.selectedId) {
                    if (patches.length) {
                        s.nativeSurface.showViewport(patches);
                        presentNative(s);
                        s.viewportVersion = version;
                    } else {
                        s.interactiveUntil = 0;
                    }
                }
            } catch (_) { /* Confirm the edit through the full rendering path. */ }
            finally {
                if (s.previewController === controller) s.previewController = null;
                s.previewInFlight = false;
                if (valid(s) && epoch === s.previewEpoch && !s.busy) {
                    const delay = s.previewQueued ? 0 : Math.max(0, s.interactiveUntil - Date.now());
                    s.previewQueued = true;
                    armPreview(s, delay);
                }
            }
            return;
        }
        s.interactiveUntil = 0;
        if (!s.nativeReady || !s.stroke) message(s.nativeReady ? '보정 중…' : '원본 크기의 작업 이미지를 준비하는 중…', false, s);
        let result;
        try {
            result = await renderNativePixels(s, body, controller.signal,
                () => valid(s) && epoch === s.previewEpoch, version, input);
            if (!valid(s) || epoch !== s.previewEpoch) return;
            if (s.interactiveUntil && version !== s.previewVersion) return;
            for (const [phase, time] of Object.entries(result.timings || {})) trace(input, phase, time);
            trace(input, 'received');
            // The surface reapplies strokes newer than this response over the confirmed pixels.
            if (result.image) s.nativeSurface.replacePatch(result.image, result.region, version);
            else if (result.patches?.length) s.nativeSurface.replacePatches(result.patches, version);
            else s.nativeSurface.acknowledge?.(version);
            s.workingRevision = result.revision;
            s.confirmedVersion = version;
            s.nativeReady = true;
            if ((s.stroke || input) && (result.image || result.patches?.length)) presentNative(s, input);
            if (!s.stroke) {
                message(readyMessage(s), false, s);
                draw(s); refreshNativeMask(s);
            }
        } catch (error) {
            if (valid(s) && epoch === s.previewEpoch && error.name !== 'AbortError') {
                s.nativeSurface.clearOptimistic();
                s.nativeFailure = error; message(error.message, true, s);
            }
        } finally {
            result?.image?.close();
            if (s.previewController === controller) s.previewController = null;
            s.previewInFlight = false;
            if (valid(s) && s.previewQueued && !s.busy) armPreview(s);
        }
    }
    async function refresh(s) {
        if (s.nativeSurface) {
            const pending = refreshNative(s); s.nativeRequest = pending;
            await pending; if (s.nativeRequest === pending) s.nativeRequest = null;
            return;
        }
        if (!valid(s) || !draft || s.busy || localStroke(s)) return;
        if (s.previewInFlight) {s.previewQueued = true; return;}
        s.previewInFlight = true; s.previewQueued = false;
        const epoch = s.previewEpoch, version = s.previewVersion;
        const controller = new AbortController(); s.previewController = controller;
        const body = {...previewPayload(s), native: true};
        if (s.displayEdge !== undefined) body.displayEdge = s.displayEdge;
        const maskLayerId = s.selectedId, maskLayer = body.layers.find(layer => layer.id === maskLayerId);
        if (!s.previewRetries) message('원본 해상도에서 보정을 계산하는 중…', false, s);
        const images = [];
        let retryDelay = 0;
        try {
            const stillCurrent = () => valid(s) && epoch === s.previewEpoch && !controller.signal.aborted
                && !localStroke(s);
            const load = async (path, data) => {
                if (!stillCurrent()) throw abortError();
                const bitmap = await createImageBitmap(await request(path, data, controller.signal, true));
                images.push(bitmap); return bitmap;
            };
            const tile = s.viewport?.renderEdit(body, controller.signal);
            let edited, original;
            if (tile) {
                const drawn = await tile;
                if (!stillCurrent()) throw abortError();
                if (!drawn) {s.previewQueued = true; return;}
                original = s.original || await load('preview', {...body, layers: []});
                edited = s.edited || original;
            } else {
                edited = await load('preview', body);
                original = s.original || (body.layers.length ? await load('preview', {...body, layers: []}) : edited);
            }
            let mask = null, maskKey = null;
            const canUseLocalMask = edited.width === s.width && edited.height === s.height
                && ['paint', 'liquify'].includes(maskLayer?.type) && needsMask(maskLayer);
            if (maskLayer && (s.maskShow || canUseLocalMask)) {
                maskKey = JSON.stringify(maskLayer.mask);
                const cached = s.mask && s.maskLayerId === maskLayerId && s.maskKey === maskKey
                    && s.mask.width === edited.width && s.mask.height === edited.height;
                mask = cached ? s.mask : await load('mask', {...body, layerId: maskLayerId});
            }
            if (!stillCurrent()) throw abortError();

            if (s.edited !== edited && s.edited !== s.original) s.edited?.close();
            if (s.original && s.original !== original && s.original !== edited) s.original.close();
            if (s.mask !== mask) {s.mask?.close(); s.maskTint = null;}
            s.edited = edited; s.original = original; s.mask = mask; s.maskLayerId = maskLayerId;
            s.maskKey = maskKey;
            s.baseDirty = Boolean(tile);
            s.previewRetries = 0;
            images.length = 0;
            s.liveFeedback = null;
            message(version === s.previewVersion ? readyMessage(s) : '최신 보정을 반영하는 중…', false, s);
            draw(s);
            if (!tile && s.stroke) s.viewport?.schedule();
            root.CanvasWorkspaceBridge?.report();
        } catch (error) {
            images.forEach(image => image.close());
            if (valid(s) && epoch === s.previewEpoch && error.status === 409 && !s.busy && s.previewRetries < CONFLICT_RETRIES) {
                retryDelay = conflictRetryDelay(s.previewRetries++);
                s.previewQueued = true;
                message('앞선 이미지 작업이 끝나면 최신 보정을 표시합니다…', false, s);
                return;
            }
            if (valid(s) && epoch === s.previewEpoch && error.name !== 'AbortError') message(error.message, true, s);
        } finally {
            if (s.previewController === controller) s.previewController = null;
            s.previewInFlight = false;
            if (valid(s) && !s.busy) {
                if (s.previewQueued) armPreview(s, retryDelay);
                else if (epoch === s.previewEpoch && !s.stroke) s.viewport?.schedule();
            }
        }
    }
    function draw(s = session) {
        if (!s || !valid(s) || !s.edited) return;
        cancelDraw(s);
        flushLiquify(s);
        updateCompareControls(s);
        if (s.nativeSurface) {
            s.nativeSurface.setComparison(s.compare, s.compareSplit);
            if (s.nativeLocalStroke && s.stroke) s.nativeSurface.appendStroke(s.stroke.points);
            if (s.ink.width !== s.edited.width || s.ink.height !== s.edited.height) {
                s.ink.width = s.edited.width; s.ink.height = s.edited.height;
            }
            drawBrushOverlay(s); positionBrushCursor(s); return;
        }
        s.viewport?.setComparison(s.compare, s.compareSplit);
        const canvas = s.image, overlay = s.ink;
        if (canvas.width !== s.edited.width || canvas.height !== s.edited.height) {
            canvas.width = overlay.width = s.edited.width; canvas.height = overlay.height = s.edited.height;
        }
        const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(s.liquifyPreview?.canvas || s.liveFeedback || s.edited, 0, 0);
        if (s.strokePreview && s.stroke) {
            s.strokePreview.append(s.stroke.points);
            paintAirbrushFeedback(s, ctx, {preview: s.strokePreview, layerId: s.stroke.layerId});
        }
        if (s.compare && s.original) {
            const x = canvas.width * s.compareSplit / 100;
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, x, canvas.height); ctx.clip();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(s.original, 0, 0, canvas.width, canvas.height); ctx.restore();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
        }
        drawBrushOverlay(s);
        positionBrushCursor(s);
    }
    function tintedMask(s) {
        if (s.maskTint) return s.maskTint;
        const canvas = doc.createElement('canvas');
        canvas.width = s.mask.width; canvas.height = s.mask.height;
        const context = canvas.getContext('2d');
        context.drawImage(s.mask, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 0; i < pixels.data.length; i += 4) {
            const alpha = (255 - pixels.data[i]) * .42;
            pixels.data[i] = 245; pixels.data[i + 1] = 90; pixels.data[i + 2] = 112; pixels.data[i + 3] = alpha;
        }
        context.putImageData(pixels, 0, 0);
        s.maskTint = canvas;
        return canvas;
    }
    function drawBrushOverlay(s) {
        const overlay = s.ink, d = draft.document;
        const ink = overlay.getContext('2d'); ink.clearRect(0, 0, overlay.width, overlay.height);
        // Paint remains visible under the cursor; restore optional mask tint on release.
        if (s.maskShow && s.mask && !s.stroke) ink.drawImage(tintedMask(s), 0, 0, overlay.width, overlay.height);
        const sx = overlay.width / d.width, sy = overlay.height / d.height;
        if (s.guides) {
            const mx = overlay.width * d.print.safeMm / (d.print.widthCm * 10), my = overlay.height * d.print.safeMm / (d.print.heightCm * 10);
            ink.strokeStyle = '#f2cb70'; ink.lineWidth = 1; ink.setLineDash([5, 5]);
            ink.strokeRect(mx, my, overlay.width - 2 * mx, overlay.height - 2 * my);
            ink.beginPath(); ink.moveTo(overlay.width / 2, 0); ink.lineTo(overlay.width / 2, overlay.height); ink.stroke(); ink.setLineDash([]);
        }
        const stroke = s.stroke;
        if (stroke && (stroke.tool === 'rect' || stroke.tool === 'ellipse')) {
            ink.strokeStyle = '#92e6b1'; ink.fillStyle = '#92e6b133'; ink.lineWidth = 2;
            ink.beginPath();
            if (stroke.tool === 'rect' || stroke.tool === 'ellipse') {
                const a = stroke.points[0], b = stroke.points.at(-1), x = Math.min(a[0], b[0]) * sx, y = Math.min(a[1], b[1]) * sy;
                const w = Math.abs(a[0] - b[0]) * sx, h = Math.abs(a[1] - b[1]) * sy;
                if (stroke.tool === 'ellipse') ink.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
                else ink.rect(x, y, w, h);
                ink.fill();
            }
            ink.stroke();
        }
    }
    function positionBrushCursor(s) {
        const cursor = s.brushCursor, point = s.cursor;
        cursor.hidden = !s.edited || !point || !editableTools.has(s.tool);
        if (cursor.hidden) return;
        const d = draft.document;
        const mode = s.tool === 'maskErase' ? 'erase' : 'paint';
        const active = String(Boolean(s.stroke));
        if (cursor.getAttribute('data-mode') !== mode) cursor.setAttribute('data-mode', mode);
        if (cursor.getAttribute('data-active') !== active) cursor.setAttribute('data-active', active);
        Object.assign(cursor.style, {
            left: `${point[0] / d.width * 100}%`, top: `${point[1] / d.height * 100}%`,
            width: `${s.brush.size / d.width * 100}%`, height: `${s.brush.size / d.height * 100}%`,
        });
    }
    function point(event, surface = session.overlay, width = draft.document.width, height = draft.document.height,
            r = surface.getBoundingClientRect()) {
        return [Math.max(0, Math.min(width, (event.clientX - r.left) / r.width * width)),
            Math.max(0, Math.min(height, (event.clientY - r.top) / r.height * height))];
    }
    function paintAirbrushFeedback(s, context, feedback) {
        const layer = draft.document.layers.find(item => item.id === feedback.layerId);
        if (!layer?.visible) return;
        const needsMask = layer.mask.base === 0 || layer.mask.strokes.length || layer.mask.shape;
        const mask = s.maskLayerId === layer.id ? s.mask : null;
        if (needsMask && !mask) return;
        feedback.preview.paint(context, {mode: layer.params.mode, opacity: layer.opacity, mask});
    }
    function needsMask(layer) {
        return layer.mask.base === 0 || layer.mask.strokes.length > 0 || Boolean(layer.mask.shape);
    }
    function beginLiquify(s, layer) {
        if (!root.CanvasRetouchLiquify || !layer.visible || layer.opacity <= 0) return;
        const masked = needsMask(layer);
        // Never deform frozen pixels using a missing mask or one from an older edit.
        if (masked && (!s.mask || s.maskLayerId !== layer.id || s.maskKey !== JSON.stringify(layer.mask))) return;
        const canvas = doc.createElement('canvas'); canvas.width = s.edited.width; canvas.height = s.edited.height;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        let mask = null;
        if (masked) {
            context.drawImage(s.mask, 0, 0);
            mask = context.getImageData(0, 0, canvas.width, canvas.height).data;
            context.clearRect(0, 0, canvas.width, canvas.height);
        }
        context.drawImage(s.liveFeedback || s.edited, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const engine = root.CanvasRetouchLiquify.create(s.stroke, pixels, draft.document.width, draft.document.height,
            {opacity: layer.opacity, mask});
        s.liquifyPreview = {canvas, context, pixels, engine};
    }
    function flushLiquify(s) {
        if (!s.liquifyPreview || s.stroke?.tool !== 'liquify') return;
        const {engine, pixels, context} = s.liquifyPreview;
        const bounds = engine.append(s.stroke.points);
        if (bounds) context.putImageData(pixels, 0, 0, bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
    }
    function cancelDraw(s) {
        if (s.drawFrame != null) root.cancelAnimationFrame(s.drawFrame);
        s.drawFrame = null;
    }
    function queueDraw(s) {
        if (s.drawFrame != null) return;
        s.drawFrame = root.requestAnimationFrame(() => {
            s.drawFrame = null;
            if (!s.nativeSurface || !s.stroke || !s.nativeLocalStroke) {draw(s); return;}
            const input = s.inputSample;
            s.inputSample = null;
            trace(input, 'local-compute-start');
            s.nativeSurface.appendStroke(s.stroke.points);
            presentNative(s, input);
        });
    }
    function stopAirbrush(s) {clearTimeout(s.airbrushTimer); s.airbrushTimer = null;}
    function pulseAirbrush(s, stroke) {
        stopAirbrush(s);
        s.airbrushTimer = setTimeout(() => {
            if (!valid(s) || s.stroke !== stroke || stroke.points.length >= 1200) return;
            // A stationary pointer still deposits paint; elapsed time is not stored in the document.
            if (Date.now() - s.lastAirbrushMove >= 100) {
                stroke.points.push([...stroke.points.at(-1)]);
                if (localStroke(s)) draw(s); else schedule(s);
            }
            pulseAirbrush(s, stroke);
        }, 100);
    }
    function setCompareSplit(s, value) {
        const split = Number(value);
        if (!Number.isFinite(split)) return;
        const next = Math.max(0, Math.min(100, Math.round(split)));
        if (s.compareSplit === next) return;
        s.compareSplit = next; update(s); draw(s);
    }
    function comparisonReady(s) {
        return Boolean(valid(s) && s.compare && s.edited && s.original);
    }
    function updateCompareControls(s) {
        if (!s.compareHandle || !s.originalBadge || !s.editedBadge) return;
        const ready = comparisonReady(s), bounds = s.overlay.getBoundingClientRect();
        const width = bounds.width || s.overlay.clientWidth || 0;
        const split = Math.max(0, Math.min(100, Number(s.compareSplit) || 0));
        const originalWidth = width * split / 100, editedWidth = width - originalWidth;
        s.compareHandle.hidden = !ready;
        s.originalBadge.hidden = !ready || originalWidth < 65;
        s.editedBadge.hidden = !ready || editedWidth < 65;
        s.compareHandle.style.left = `${Math.max(Math.min(20, width / 2), Math.min(width - Math.min(20, width / 2), originalWidth))}px`;
        s.compareHandle.setAttribute('aria-valuenow', String(split));
        s.compareHandle.setAttribute('aria-valuetext', `원본 ${split}% · 보정본 ${100 - split}%`);
    }
    function cancelCompareDrag(s) {
        const pointerId = s.compareDragId;
        if (pointerId === undefined || pointerId === null) return;
        s.compareDragId = null; s.compareDragStartX = null; s.compareDragMoved = false;
        if (s.compareHandle?.hasPointerCapture(pointerId)) s.compareHandle.releasePointerCapture(pointerId);
    }
    function moveCompareSplit(s, event) {
        const bounds = s.overlay.getBoundingClientRect();
        if (!bounds.width) return;
        setCompareSplit(s, (event.clientX - bounds.left) / bounds.width * 100);
    }
    function sample(s, image, p, width, height, pixel = null) {
        if (!pixel) {
            const c = doc.createElement('canvas'); c.width = image.width || image.naturalWidth; c.height = image.height || image.naturalHeight;
            const context = c.getContext('2d'); context.drawImage(image, 0, 0, c.width, c.height);
            pixel = context.getImageData(Math.min(c.width - 1, Math.floor(p[0] / width * c.width)),
                Math.min(c.height - 1, Math.floor(p[1] / height * c.height)), 1, 1).data;
        }
        const color = '#' + [...pixel.slice(0, 3)].map(value => value.toString(16).padStart(2, '0')).join('');
        s.brush.color = color;
        if (s.airbrushBrush) s.airbrushBrush.color = color;
        if (selected()?.type === 'color') change(() => {selected().params.color = color;});
        message('채취한 색 ' + color.toUpperCase());
    }
    function bind(s) {
        const listen = (target, event, callback, options) => {target.addEventListener(event, callback, options); s.listeners.push([target, event, callback, options]);};
        listen(s.compareHandle, 'pointerdown', event => {
            event.preventDefault(); event.stopPropagation();
            if (event.button !== 0 || event.isPrimary === false || !comparisonReady(s) || s.stroke || s.compareDragId !== null && s.compareDragId !== undefined) return;
            s.compareHandle.focus(); s.cursor = null; s.compareDragId = event.pointerId;
            s.compareDragStartX = event.clientX; s.compareDragMoved = false;
            s.compareHandle.setPointerCapture(event.pointerId);
            draw(s);
        });
        listen(s.compareHandle, 'pointermove', event => {
            event.preventDefault(); event.stopPropagation();
            if (s.compareDragId === event.pointerId && comparisonReady(s) && (s.compareDragMoved || event.clientX !== s.compareDragStartX)) {
                s.compareDragMoved = true; moveCompareSplit(s, event);
            }
        });
        listen(s.compareHandle, 'pointerup', event => {
            event.preventDefault(); event.stopPropagation();
            if (s.compareDragId !== event.pointerId) return;
            if ((s.compareDragMoved || event.clientX !== s.compareDragStartX) && comparisonReady(s)) moveCompareSplit(s, event);
            cancelCompareDrag(s);
        });
        listen(s.compareHandle, 'pointercancel', event => {
            event.preventDefault(); event.stopPropagation();
            if (s.compareDragId === event.pointerId) cancelCompareDrag(s);
        });
        listen(s.compareHandle, 'lostpointercapture', event => {
            if (s.compareDragId === event.pointerId) {
                s.compareDragId = null; s.compareDragStartX = null; s.compareDragMoved = false;
            }
        });
        listen(s.overlay, 'pointerdown', event => {
            if (event.button !== 0 || s.busy || s.stroke || !s.edited || s.space || s.tool === 'hand') return;
            const started = inputTrace ? clock() : null;
            event.preventDefault(); event.stopPropagation();
            s.overlay.focus({preventScroll: true});
            if (s.nativeSurface && !s.nativeReady) return message(s.nativeFailure?.message || '원본 크기의 작업 이미지를 준비하는 중입니다.', Boolean(s.nativeFailure), s);
            if (s.tool === 'airbrush' && selected()?.type !== 'paint') tool('airbrush');
            if (s.tool === 'airbrush' && selected()?.type !== 'paint') return;
            if (s.tool === 'liquify' && selected()?.type !== 'liquify') tool('liquify');
            if (s.tool === 'liquify' && selected()?.type !== 'liquify') return;
            const p = point(event), d = draft.document, l = selected();
            if (s.tool === 'dropper') return sample(s, s.compare && p[0] / d.width < s.compareSplit / 100 ? s.original : s.edited,
                p, d.width, d.height, s.nativeSurface?.sampleAt(p, s.compare && p[0] / d.width < s.compareSplit / 100) || s.viewport?.sampleAt(p));
            if (s.tool === 'inspect') {inspect(s, p); return;}
            if (s.tool === 'clone' && event.altKey) {s.cloneSource = p; message('원본 복제 기준점을 지정했어요.'); return;}
            if (!l) return message('보정 레이어를 먼저 추가해 주세요.', true);
            if (s.tool === 'clone' && !s.cloneSource) return message('Alt+클릭으로 복제 기준점을 먼저 지정하세요.', true);
            tracePointer(s, 'down', started);
            if (!s.nativeSurface) cancelPreview(s);
            s.cursor = p;
            s.stroke = {tool: s.tool, layerId: l.id, pointerId: event.pointerId, points: [p], radius: s.brush.size / 2,
                hardness: s.brush.hardness / 100, opacity: s.brush.flow / 100, color: s.brush.color,
                source: s.cloneSource ? [...s.cloneSource] : null, mode: l.params.mode || 'push', strength: l.params.strength || .35};
            if (s.tool === 'maskErase') s.stroke.layerIds = [...s.selectedIds];
            if (s.tool === 'airbrush') {
                Object.assign(s.stroke, {brush: 'airbrush', flow: s.brush.flow / 100, opacity: (s.brush.opacity ?? 100) / 100});
                if (s.nativeSurface) {
                    const above = d.layers.slice(d.layers.indexOf(l) + 1).some(layer => layer.visible && layer.opacity > 0);
                    trace(s.inputSample, 'local-compute-start');
                    s.nativeLocalStroke = !above && s.nativeSurface.beginStroke(s.stroke, l, s.previewVersion + 1);
                } else if (localStroke(s)) s.strokePreview = root.CanvasRetouchBrush?.create(s.stroke, s.edited.width, s.edited.height, d.width, d.height);
                s.lastAirbrushMove = Date.now(); pulseAirbrush(s, s.stroke);
            }
            if (s.nativeSurface && s.tool === 'liquify') {
                const above = d.layers.slice(d.layers.indexOf(l) + 1).some(layer => layer.visible && layer.opacity > 0);
                trace(s.inputSample, 'local-compute-start');
                s.nativeLocalStroke = !above && s.nativeSurface.beginStroke(s.stroke, l, s.previewVersion + 1);
            } else if (!s.nativeSurface && s.tool === 'liquify' && localStroke(s)) beginLiquify(s, l);
            s.overlay.setPointerCapture(event.pointerId);
            if (!localStroke(s)) schedule(s);
            draw(s);
            if (s.nativeLocalStroke) {
                presentNative(s, s.inputSample);
                s.inputSample = null;
            }
        });
        listen(s.overlay, 'pointermove', event => {
            if (!valid(s) || !draft) return;
            const stroke = s.stroke;
            const started = inputTrace && stroke ? clock() : null;
            const bounds = s.overlay.getBoundingClientRect();
            s.cursor = point(event, s.overlay, s.width, s.height, bounds);
            let changed = false;
            if (stroke && stroke.pointerId === event.pointerId) {
                const p = s.cursor;
                if (stroke.tool === 'rect' || stroke.tool === 'ellipse') {stroke.points = [stroke.points[0], p]; changed = true;}
                else {
                    const samples = event.getCoalescedEvents?.();
                    const spacing = Math.max(1, stroke.radius * (stroke.brush === 'airbrush' ? .05 : .12));
                    for (const sample of samples?.length ? samples : [event]) {
                        if (stroke.points.length >= 1200) break;
                        const next = samples?.length ? point(sample, s.overlay, s.width, s.height, bounds) : p;
                        const last = stroke.points.at(-1);
                        if (Math.hypot(next[0] - last[0], next[1] - last[1]) < spacing) continue;
                        stroke.points.push(next); changed = true;
                    }
                    if (changed) s.lastAirbrushMove = Date.now();
                }
            }
            positionBrushCursor(s);
            if (!changed) return;
            tracePointer(s, 'move', started);
            if (localStroke(s)) {
                if (s.nativeSurface || s.tool === 'liquify') queueDraw(s); else draw(s);
            } else {
                if (stroke.tool === 'rect' || stroke.tool === 'ellipse') drawBrushOverlay(s);
                schedule(s);
            }
        });
        listen(s.overlay, 'pointerup', event => {
            const stroke = s.stroke; if (!stroke || stroke.pointerId !== event.pointerId) return;
            stopAirbrush(s);
            if ((stroke.brush === 'airbrush' || stroke.tool === 'liquify') && stroke.points.length < 1200) {
                const last = point(event);
                if (Math.hypot(last[0] - stroke.points.at(-1)[0], last[1] - stroke.points.at(-1)[1]) >= 1) stroke.points.push(last);
                s.strokePreview?.append(stroke.points);
            }
            cancelDraw(s); flushLiquify(s);
            if (s.nativeLocalStroke) s.nativeSurface.appendStroke(stroke.points);
            s.stroke = null; if (s.overlay.hasPointerCapture(event.pointerId)) s.overlay.releasePointerCapture(event.pointerId);
            const targets = strokeTargets(draft.document.layers, stroke);
            const count = draft.document.layers.reduce((n, l) => n + [...l.strokes, ...l.mask.strokes].reduce((total, item) => total + item.points.length, 0), 0);
            if (count + stroke.points.length * targets.length > model().LIMITS.maxPoints) {s.strokePreview = null; s.liquifyPreview = null;
                s.nativeSurface?.endStroke(false); s.nativeLocalStroke = false;
                cancelPreview(s);
                schedule(s); message('브러시 기록 한도에 도달했어요. 보정 결과를 적용한 뒤 새 보정으로 이어 주세요.', true); draw(s); return;}
            if (s.strokePreview) {
                if (!s.liveFeedback) {
                    s.liveFeedback = doc.createElement('canvas');
                    s.liveFeedback.width = s.edited.width; s.liveFeedback.height = s.edited.height;
                    s.liveFeedback.getContext('2d').drawImage(s.edited, 0, 0);
                }
                paintAirbrushFeedback(s, s.liveFeedback.getContext('2d'), {preview: s.strokePreview, layerId: stroke.layerId});
                s.strokePreview = null;
            }
            if (s.liquifyPreview) {s.liveFeedback = s.liquifyPreview.canvas; s.liquifyPreview = null;}
            const nativeStroke = s.nativeLocalStroke;
            if (nativeStroke) s.nativeSurface.endStroke(true);
            s.nativeLocalStroke = false;
            change(value => strokeTargets(value.layers, stroke).forEach(layer => recordStroke(layer, stroke)), false, true, nativeStroke); draw(s);
        });
        const cancelStroke = () => {
            const hadStroke = Boolean(s.stroke);
            s.nativeSurface?.endStroke(false); s.nativeLocalStroke = false;
            stopAirbrush(s); cancelDraw(s); s.stroke = null; s.strokePreview = null; s.liquifyPreview = null;
            if (hadStroke || s.liveFeedback) {if (!s.nativeSurface) cancelPreview(s); schedule(s);} draw(s);
        };
        listen(s.overlay, 'pointercancel', cancelStroke);
        listen(s.overlay, 'lostpointercapture', () => {if (s.stroke) cancelStroke();});
        listen(root, 'blur', () => {s.space = false; cancelStroke();});
        listen(s.overlay, 'pointerleave', () => {s.cursor = null; positionBrushCursor(s);});
        listen(s.overlay, 'wheel', handleCanvasWheelZoom, {passive: false});
        listen(s.overlay, 'contextmenu', event => event.preventDefault());
        listen(byId('canvasStage'), 'pointerdown', event => {
            const image = byId('canvasOppositePreviewImage');
            if (event.target === image && s.tool === 'dropper' && !s.busy) {
                event.preventDefault(); event.stopPropagation();
                try {sample(s, image, point(event, image, image.naturalWidth, image.naturalHeight), image.naturalWidth, image.naturalHeight);}
                catch (error) {message('참고 그림의 색을 가져오지 못했습니다.', true);}
            }
        }, true);
        listen(doc, 'keydown', event => {
            if (event.target.closest?.('dialog[open], [role="dialog"][aria-modal="true"]')) return;
            if (event.target === s.compareHandle) {
                const step = event.shiftKey ? 10 : 1;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'Home' || event.key === 'End') {
                    event.preventDefault(); event.stopPropagation();
                    if (event.key === 'Home') setCompareSplit(s, 0);
                    else if (event.key === 'End') setCompareSplit(s, 100);
                    else setCompareSplit(s, s.compareSplit + (event.key === 'ArrowRight' ? step : -step));
                    return;
                }
            }
            const input = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
            event.stopPropagation(); if (input) return;
            if (event.key === ' ') {s.space = true; event.preventDefault();}
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {event.preventDefault(); history(s, event.shiftKey ? 'redo' : 'undo');}
            else if (event.key === 'Escape') {event.preventDefault(); close();}
            else if (!event.ctrlKey && !event.metaKey) {const next = {a: 'airbrush', b: 'paint', e: 'maskErase', i: 'dropper', l: 'liquify'}[event.key.toLowerCase()]; if (next) tool(next);}
        }, true);
        listen(doc, 'keyup', event => {if (event.key === ' ') s.space = false;}, true);
        for (const eventName of ['paste', 'copy', 'cut']) listen(doc, eventName, event => {
            if (event.target.closest?.('dialog[open], [role="dialog"][aria-modal="true"]')) return;
            event.stopPropagation(); if (!event.target.closest?.('input,textarea,[contenteditable="true"]')) event.preventDefault();
        }, true);
    }
    async function inspect(s, p) {
        if (!valid(s) || !draft) return;
        if (!s.nativeSurface) cancelPreview(s);
        const d = clone(draft.document), x = Math.max(0, Math.min(d.width - Math.min(512, d.width), Math.round(p[0] - 256)));
        const y = Math.max(0, Math.min(d.height - Math.min(512, d.height), Math.round(p[1] - 256)));
        const dialog = doc.createElement('dialog'); dialog.className = 'canvas-retouch-detail';
        const title = doc.createElement('h3'); title.textContent = `실제 픽셀 비교 · ${x}, ${y}`;
        const closeButton = doc.createElement('button'); closeButton.type = 'button'; closeButton.textContent = '닫기';
        const container = doc.createElement('div'); container.className = 'canvas-retouch-detail-images';
        dialog.append(title, closeButton, container); doc.body.append(dialog); dialog.showModal();
        const controller = new AbortController(), urls = []; s.details.add(dialog);
        dialog.addEventListener('close', () => {
            controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); s.details.delete(dialog); dialog.remove();
            if (!s.nativeSurface?.inspectRegion && valid(s) && !s.busy) schedule(s);
        }, {once: true});
        closeButton.onclick = () => dialog.close();
        try {
            for (const [label, original] of [['원본', true], ['보정', false]]) {
                const figure = doc.createElement('figure'), caption = doc.createElement('figcaption');
                if (s.nativeSurface?.inspectRegion) {
                    const width = Math.min(512, d.width), height = Math.min(512, d.height);
                    const image = doc.createElement('canvas');
                    image.width = width; image.height = height;
                    image.setAttribute('role', 'img'); image.setAttribute('aria-label', label + ' 실제 픽셀');
                    image.getContext('2d').putImageData(s.nativeSurface.inspectRegion({x, y, width, height}, original), 0, 0);
                    caption.textContent = label; figure.append(caption, image); container.append(figure);
                    continue;
                }
                const image = doc.createElement('img');
                caption.textContent = label; image.alt = label + ' 실제 픽셀'; image.width = Math.min(512, d.width); image.height = Math.min(512, d.height);
                figure.append(caption, image); container.append(figure);
                const blob = await requestWithConflictRetry('detail', {...payload(d), x, y, original}, controller.signal, true,
                    () => valid(s) && dialog.open);
                if (!dialog.open) return; const url = URL.createObjectURL(blob); urls.push(url); image.src = url;
            }
        } catch (error) {if (error.name !== 'AbortError' && dialog.open) {const text = doc.createElement('p'); text.textContent = error.message; container.append(text);}}
    }
    async function apply(s, downloadOnly) {
        if (!valid(s) || s.busy || s.applyController || s.entryPending || !draft) return;
        s.busy = true; s.downloadSrc = null;
        if (!s.nativeSurface) cancelPreview(s);
        message(s.nativeSurface ? '작업한 이미지를 저장하는 중…' : '원본 해상도로 보정하는 중…', false, s);
        const record = model().normalize(draft.document), targetId = draft.targetLayerId;
        const controller = new AbortController(); s.applyController = controller;
        let downloadedVersion = null;
        try {
            if (!record) throw new Error('보정 기록을 확인해 주세요.');
            if (s.nativeSurface) await flushNative(s);
            const manifest = {...payload(record), ...(s.nativeSurface ? {workingId: s.workingId} : {})};
            let body = manifest;
            if (s.editorEngine) {
                try {
                    const {png} = await s.editorEngine.exportImage({revision: s.workingRevision, layers: manifest.layers});
                    body = new FormData();
                    body.append('document', new Blob([JSON.stringify(manifest)], {type: 'application/json'}), 'document.json');
                    body.append('rendered', new Blob([png], {type: 'image/png'}), 'retouch.png');
                    if (downloadOnly && valid(s)) {
                        // Further edits cannot change the encoded PNG or its manifest.
                        downloadedVersion = s.previewVersion;
                        s.busy = false;
                        update(s);
                    }
                } catch (error) {
                    if (!valid(s) || controller.signal.aborted) throw abortError();
                    console.warn('Canvas editor export could not reuse local pixels.', error);
                }
            }
            const created = await requestWithConflictRetry('apply', body, controller.signal, false, () => valid(s));
            let job = created.job;
            let pollDelay = APPLY_FIRST_POLL_DELAY;
            while (job.status === 'running' || job.status === 'queued') {
                await waitWhileActive(controller.signal, () => valid(s), pollDelay);
                job = (await request('jobs/' + encodeURIComponent(job.id), undefined, controller.signal)).job;
                pollDelay = APPLY_POLL_DELAY;
                if (downloadedVersion === null || downloadedVersion === s.previewVersion)
                    message(`${job.message || '원본 해상도로 보정하는 중…'} ${Math.round((job.progress || 0) * 100)}%`, false, s);
            }
            if (!valid(s)) return;
            if (job.status !== 'done' || !job.result?.src) throw new Error(job.message || '보정 결과를 저장하지 못했습니다.');
            const result = job.result;
            if (downloadOnly) {
                s.downloadSrc = result.src; download(result.src, 'NAIM-retouch.png');
                if (downloadedVersion === null || downloadedVersion === s.previewVersion)
                    message('원본 크기 sRGB PNG를 저장했어요.', false, s);
                return;
            }
            let target = targetId != null ? findCanvasLayer(targetId)?.layer : null;
            if (!target || target.type !== 'image') {
                target = {id: layerIdSeq++, type: 'image', name: '전체 보정', visible: true, x: 0, y: 0,
                    layerWidth: record.width, layerHeight: record.height, imageWidth: record.width, imageHeight: record.height};
                canvasLayers.unshift(target);
            }
            target.src = result.src; target.retouch = record;
            activeLayerId = target.id; selectedLayerIds.clear(); selectedLayerIds.add(target.id);
            draft = null; close(false); renderLayerList(); renderCanvasLayersOnSurface(); saveCanvasState();
            root.showToast?.('전체 보정을 적용했어요. 전체 그림 보정을 다시 열면 현재 합성본에서 이어갈 수 있어요.');
        } catch (error) {message(error.message, true, s);}
        finally {if (s.applyController === controller) s.applyController = null; s.busy = false; update(s);}
    }
    async function flushNative(s) {
        clearTimeout(s.timer); s.timer = null; s.flushing = true;
        s.interactiveUntil = 0;
        try {
            await s.nativeRequest;
            if (!valid(s)) throw abortError();
            if (s.confirmedVersion !== s.previewVersion || !s.nativeReady) await refresh(s);
            if (s.nativeFailure) throw s.nativeFailure;
            if (!valid(s) || s.confirmedVersion !== s.previewVersion) throw abortError();
        } finally {s.flushing = false;}
    }
    function download(url, name) {
        const link = doc.createElement('a'); link.href = url; link.download = name; doc.body.append(link); link.click(); link.remove();
    }
    async function oppositeSource() {
        const chosen = root.CanvasOppositeReference?.snapshot(), link = root.CanvasProject?.localLink();
        if (!chosen || !link || chosen.projectId !== link.projectId) throw new Error('프로젝트 연결에서 반대쪽 참고 그림을 먼저 선택해 주세요.');
        const result = await fetch('/api/daki/projects/' + encodeURIComponent(link.projectId)).then(r => r.json());
        const otherSide = link.side === 'front' ? 'back' : 'front';
        if (chosen.kind === 'candidate') {
            const item = result.project?.candidates?.[otherSide]?.find(value => value.id === chosen.id);
            if (!item || item.missing || !item.src) throw new Error('반대쪽 후보 그림을 찾을 수 없습니다.');
            return {source: item.src, side: link.side};
        }
        const data = await fetch('/api/daki/projects/' + encodeURIComponent(link.projectId) + '/canvases/' + encodeURIComponent(chosen.id)).then(r => r.json());
        if (!data.canvas?.state || data.canvas.side !== otherSide) throw new Error('반대쪽 캔버스를 찾을 수 없습니다.');
        return {source: await renderMergedCanvasToDataUrl({state: data.canvas.state}), side: link.side};
    }
    async function downloadPair(s) {
        if (!valid(s) || s.busy || s.applyController) return;
        if (!s.nativeSurface) cancelPreview(s);
        s.busy = true; message('양면을 원본 크기로 출력하는 중…', false, s);
        const controller = new AbortController(); s.pairController = controller;
        const capturedPayload = {...payload(clone(draft.document)), ...(s.nativeSurface ? {workingId: s.workingId} : {})};
        try {
            if (s.nativeSurface) await flushNative(s);
            const other = await oppositeSource(); if (!valid(s)) return;
            const blob = await requestWithConflictRetry('export-pair', {...capturedPayload, otherSource: other.source, side: other.side},
                controller.signal, true, () => valid(s));
            if (!valid(s)) return;
            const url = URL.createObjectURL(blob); download(url, 'NAIM-daki-front-back.zip'); setTimeout(() => URL.revokeObjectURL(url), 60000);
            message('양면 ZIP을 저장했어요. 반대쪽은 선택한 후보 또는 저장된 캔버스 상태입니다.', false, s);
        } catch (error) {message(error.message, true, s);} finally {if (s.pairController === controller) s.pairController = null; s.busy = false; update(s);}
    }
    function canEditAppliedLayer(layer) {
        return layer?.type === 'image' && layer.x === 0 && layer.y === 0
            && layer.layerWidth === currentCanvasWidth && layer.layerHeight === currentCanvasHeight
            && layer.retouch?.width === currentCanvasWidth && layer.retouch?.height === currentCanvasHeight;
    }
    function captureBasePreview(s, source) {
        const preview = doc.createElement('canvas');
        const maxEdge = s.displayEdge ?? root.CanvasRetouchViewport?.BASE_PREVIEW_EDGE ?? 1600;
        const scale = Math.min(1, maxEdge / Math.max(s.width, s.height));
        preview.width = Math.max(1, Math.round(s.width * scale));
        preview.height = Math.max(1, Math.round(s.height * scale));
        const context = preview.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, preview.width, preview.height);
        return preview;
    }
    function loadNativeSource(s, source) {
        if (s.nativeSource) return Promise.resolve(s.nativeSource);
        if (!s.sourceImage) {
            const loading = loadImageElementForClip(source);
            s.sourceImage = loading;
            loading.catch(() => {
                if (s.sourceImage === loading) s.sourceImage = null;
            });
        }
        return s.sourceImage;
    }
    async function loadNativeUnderlay(s, source) {
        const image = await loadNativeSource(s, source);
        if (!valid(s) || s.edited || image.naturalWidth !== s.width || image.naturalHeight !== s.height) return image;
        try {
            // A visible source is enough to accept strokes while the first corrected crop waits.
            const bitmap = await createImageBitmap(captureBasePreview(s, image));
            if (!valid(s) || s.edited) bitmap.close();
            else {
                s.edited = s.original = bitmap;
                draw(s);
            }
        } catch (_) { /* The native image can still be displayed independently. */ }
        return image;
    }
    async function loadViewport(s, body, signal) {
        if ((!body.layers.length || body.original) && typeof loadImageElementForClip === 'function') {
            try {
                const source = await loadNativeSource(s, body.source);
                signal.throwIfAborted();
                const {x, y, width, height} = body.region;
                if (body.scale === 1) return await createImageBitmap(source, x, y, width, height);
                return await createImageBitmap(source, x, y, width, height, {
                    resizeWidth: Math.max(1, Math.round(width * body.scale)),
                    resizeHeight: Math.max(1, Math.round(height * body.scale)),
                    resizeQuality: 'high',
                });
            } catch (_) {
                signal.throwIfAborted();
            }
        }
        return createImageBitmap(await request('viewport', body, signal, true));
    }
    async function open({editLayerId = null, newSession = false} = {}) {
        if (session || !currentCanvasWidth || !currentCanvasHeight) return;
        if (newSession && editLayerId != null) {
            root.showToast?.('새 보정과 기존 레이어 편집을 함께 열 수 없습니다.');
            return;
        }
        if (!newSession && editLayerId != null && draft && draft.targetLayerId !== editLayerId) {
            root.showToast?.('진행 중인 보정 초안이 있어요. 초안 이어서 버튼에서 먼저 열어 주세요.');
            return;
        }
        root.CanvasDakiMapEditor?.close();
        if (typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
        const host = byId('canvasRetouchPanel'), surface = byId('canvasSurface'), stage = byId('canvasStage');
        if (!host || !surface || !stage) return;
        const s = {serial: ++serial, layers: canvasLayers, width: currentCanvasWidth, height: currentCanvasHeight,
            listeners: [], details: new Set(), history: new (model().History)(), selectedId: null, selectedIds: [], tool: 'hand',
            brush: {size: 160, flow: 10, opacity: 100, hardness: 30, color: '#e6baa4'}, compare: false, compareSplit: 50,
            eraserBrush: null, brushBeforeEraser: null,
            liveFeedback: null, strokePreview: null, liquifyPreview: null, drawFrame: null,
            guides: false, maskShow: false, busy: true, entryPending: Boolean(newSession),
            resumingDraft: Boolean(!newSession && draft),
            message: '캔버스 전체 합성본을 준비하는 중…', error: false,
            previewVersion: 0, previewEpoch: 0, previewRetries: 0, previewQueued: false, previewInFlight: false, timer: null, baseDirty: false,
            lastChange: 0, toolbar: doc.querySelector('.canvas-toolbar')};
        s.workingId = root.crypto?.randomUUID?.() || ('retouch-' + Date.now() + '-' + serial + '-' + Math.random().toString(36).slice(2));
        s.workingRevision = 0; s.nativeReady = false; s.nativeLocalStroke = false;
        if (root.CanvasRetouchSurface) {
            s.editorEngine = root.CanvasEditorEngine?.create();
            root.CanvasRetouchBrush?.prepareNative?.();
        }
        const canvasEdge = Math.max(s.width, s.height);
        const maxPreviewEdge = root.CanvasRetouchViewport?.BASE_PREVIEW_EDGE;
        const fitScale = Number(surface.dataset?.fitScale);
        if (canvasEdge > maxPreviewEdge && fitScale > 0) {
            s.displayEdge = Math.min(maxPreviewEdge, Math.max(1, Math.round(canvasEdge * fitScale * (root.devicePixelRatio || 1))));
        }
        session = s; s.toolbarInert = s.toolbar?.inert; if (s.toolbar) s.toolbar.inert = true;
        root.CanvasEditorScene?.pause(true);
        doc.body.classList.add('canvas-retouch-editing'); host.hidden = false;
        s.panel = root.CanvasRetouchPanel.create(host, actions(s)); update(s);
        root.CanvasWorkspaceBridge?.report();
        try {
            let basePreview = null;
            if (!newSession && !draft && editLayerId != null) {
                const layer = findCanvasLayer(editLayerId)?.layer;
                const saved = canEditAppliedLayer(layer) ? model().normalize(layer.retouch) : null;
                if (!saved) throw new Error('이 레이어의 보정 기록을 열 수 없습니다.');
                draft = {document: saved, targetLayerId: editLayerId};
            }
            if (newSession || !draft) {
                const merged = await renderMergedCanvasToDataUrl({onComposite(source) {
                    if (!valid(s)) return;
                    if (root.CanvasRetouchSurface) s.nativeSource = source;
                    try {basePreview = captureBasePreview(s, source);}
                    catch (_) { /* Use the renderer if browser preview creation fails. */ }
                }});
                if (!valid(s)) return;
                const source = await saveClipDataUrlToServer(merged, {category: 'retouch'}); if (!valid(s)) return;
                const document = model().normalize({version: 1, source, width: s.width, height: s.height, layers: []});
                if (!document) throw new Error('합성 원본을 보정 기록으로 준비하지 못했습니다.');
                if (newSession && hasDraftWork(draft)) savedDrafts.unshift(clone(draft));
                draft = {document, targetLayerId: null};
                s.entryPending = false;
                refreshDraftControls();
            }
            if (!draft?.document || draft.document.width !== s.width || draft.document.height !== s.height) throw new Error('보정 기록과 캔버스 크기가 다릅니다. 기록이 저장된 원래 캔버스에서 열어 주세요.');
            // Start fetching while the main thread prepares the native surface.
            s.editorEngine?.prepare?.({source: draft.document.source, width: s.width, height: s.height}).catch(() => {});
            if (root.CanvasRetouchSurface) {
                s.nativeSource = await loadNativeSource(s, draft.document.source);
                if (!valid(s)) return;
                basePreview ||= captureBasePreview(s, s.nativeSource);
            }
            if (!draft.document.layers.length) {
                try {
                    if (!basePreview && typeof loadImageElementForClip === 'function') {
                        const source = await loadNativeSource(s, draft.document.source);
                        if (!valid(s)) return;
                        basePreview = captureBasePreview(s, source);
                    }
                    if (basePreview) {
                        const bitmap = await createImageBitmap(basePreview);
                        if (!valid(s)) {bitmap.close(); return;}
                        s.edited = s.original = bitmap;
                    }
                } catch (_) {
                    if (!valid(s)) return;
                    s.sourceImage = null;
                    // Older saved sources can still be opened by the server.
                }
            }
            s.selectedId = draft.document.layers.at(-1)?.id || null;
            syncSelection(s);
            const overlay = doc.createElement('div'); overlay.className = 'canvas-retouch-surface-overlay';
            overlay.tabIndex = 0;
            const image = doc.createElement('canvas'), ink = doc.createElement('canvas'); image.setAttribute('aria-label', '캔버스 전체 보정 미리보기'); ink.className = 'canvas-retouch-brush-overlay';
            const brushCursor = doc.createElement('span'); brushCursor.className = 'canvas-retouch-brush-cursor'; brushCursor.hidden = true;
            brushCursor.setAttribute('aria-hidden', 'true');
            const originalBadge = doc.createElement('span'), editedBadge = doc.createElement('span'), compareHandle = doc.createElement('button');
            originalBadge.className = 'canvas-retouch-compare-badge canvas-retouch-compare-original'; originalBadge.textContent = '원본';
            editedBadge.className = 'canvas-retouch-compare-badge canvas-retouch-compare-edited'; editedBadge.textContent = '보정본';
            compareHandle.type = 'button'; compareHandle.className = 'canvas-retouch-compare-handle'; compareHandle.textContent = '↔'; compareHandle.tabIndex = 0;
            compareHandle.setAttribute('role', 'slider'); compareHandle.setAttribute('aria-label', '전후 비교 경계');
            compareHandle.setAttribute('aria-valuemin', '0'); compareHandle.setAttribute('aria-valuemax', '100');
            compareHandle.setAttribute('aria-orientation', 'horizontal');
            compareHandle.title = '드래그해 전후 비교 경계를 좌우로 이동';
            overlay.append(image, ink, brushCursor, originalBadge, editedBadge, compareHandle); stage.append(overlay);
            Object.assign(s, {overlay, image, ink, brushCursor, originalBadge, editedBadge, compareHandle, surface});
            if (root.CanvasRetouchSurface && s.nativeSource) {
                s.nativeSurface = root.CanvasRetouchSurface.create({host: overlay, width: s.width, height: s.height,
                    source: s.nativeSource, workspace: doc.querySelector('.canvas-workspace')});
                image.hidden = true;
                if (!s.edited) {
                    const bitmap = await createImageBitmap(basePreview);
                    if (!valid(s)) {bitmap.close(); s.nativeSurface.destroy(); return;}
                    s.edited = s.original = bitmap;
                }
                if (!valid(s)) {s.nativeSurface.destroy(); return;}
            }
            const workspace = doc.querySelector('.canvas-workspace');
            if (!s.nativeSurface && workspace && root.CanvasRetouchViewport) s.viewport = root.CanvasRetouchViewport.create({
                host: overlay, workspace, documentWidth: s.width, documentHeight: s.height,
                getPayload: () => ({...payload(), native: true}),
                getBaseScale: () => s.displayEdge / canvasEdge,
                loadNativeUnderlay: typeof loadImageElementForClip === 'function'
                    ? () => loadNativeUnderlay(s, draft.document.source) : undefined,
                request: (body, signal) => loadViewport(s, body, signal),
                getConflictRetryDelay: retry => retry < CONFLICT_RETRIES ? conflictRetryDelay(retry) : null,
                onDetailStatus: status => {
                    if (!valid(s) || s.busy || s.stroke || s.previewInFlight || s.previewQueued) return;
                    if (status === 'loading') message(DETAIL_LOADING_MESSAGE, false, s);
                    else if (status === 'error') message(DETAIL_ERROR_MESSAGE, true, s);
                    else if (s.message === DETAIL_LOADING_MESSAGE || s.message === DETAIL_ERROR_MESSAGE)
                        message(readyMessage(s), false, s);
                },
                canRequest: () => valid(s) && !s.busy && !s.stroke && !s.previewInFlight && !s.previewQueued && s.timer == null && Boolean(s.edited),
                onLeaveDetail: () => {
                    if (!s.baseDirty || !valid(s)) return false;
                    if (!s.busy && !s.previewInFlight && !s.previewQueued) schedule(s);
                    return true;
                },
            });
            s.observer = new ResizeObserver(sync); s.observer.observe(surface); bind(s); sync(); s.busy = false; persist();
            if (s.nativeSurface) {
                if (s.editorEngine && !draft.document.layers.length) {
                    s.nativeReady = true; s.confirmedVersion = s.previewVersion;
                    draw(s); message(readyMessage(s), false, s);
                } else {
                    draw(s); message('원본 크기의 작업 이미지를 준비하는 중…', false, s); await refresh(s);
                }
            } else if (s.edited) {
                message(readyMessage(s), false, s);
                draw(s);
                s.viewport?.schedule();
            } else {
                update(s);
                refresh(s);
            }
        } catch (error) {if (valid(s)) {message(error.message, true, s); s.busy = false; update(s);}}
    }
    function sync(options = {}) {
        const s = session; if (!s) return;
        if (!valid(s)) {restore(null); return;}
        if (options.baseZoomSkipped) s.baseZoomSkipped = true;
        if (!s.overlay) return;
        const surface = s.surface;
        Object.assign(s.overlay.style, {left: (surface.offsetLeft + surface.clientLeft) + 'px', top: (surface.offsetTop + surface.clientTop) + 'px',
            width: surface.clientWidth + 'px', height: surface.clientHeight + 'px'});
        updateCompareControls(s);
        s.nativeSurface?.scheduleView?.();
        s.viewport?.schedule();
    }
    function close(save = true) {
        const s = session; if (!s) {refreshDraftControls(); return;}
        const syncBase = Boolean(s.baseZoomSkipped && valid(s));
        s.sourceImage = null;
        s.nativeSource = null;
        s.editorEngine?.destroy();
        if (s.nativeSurface) {
            s.nativeSurface.destroy();
            if (s.serverWorking) request('working/close', {workingId: s.workingId}).catch(() => {});
        }
        stopAirbrush(s);
        cancelDraw(s); s.liquifyPreview = null; s.liveFeedback = null; s.maskTint = null;
        cancelCompareDrag(s); s.viewport?.destroy();
        if (save) persist(); session = null; serial++;
        root.CanvasEditorScene?.pause(false);
        clearTimeout(s.timer); s.previewController?.abort(); s.applyController?.abort(); s.pairController?.abort(); s.observer?.disconnect();
        s.listeners.forEach(([target, event, callback, options]) => target.removeEventListener(event, callback, options));
        s.details.forEach(dialog => dialog.close()); s.panel?.destroy(); s.overlay?.remove();
        if (s.edited !== s.original) s.edited?.close();
        s.original?.close(); s.mask?.close();
        if (s.toolbar) s.toolbar.inert = Boolean(s.toolbarInert);
        doc.body.classList.remove('canvas-retouch-editing'); byId('canvasRetouchPanel').hidden = true;
        if (syncBase) root.renderCanvasLayersOnSurface?.({zoomOnly: true});
        refreshDraftControls();
        root.CanvasDakiFocus?.refresh();
        root.CanvasWorkspaceBridge?.report();
    }
    function restore(value) {
        close(false);
        draft = normalizeDraft(value);
        savedDrafts = Array.isArray(value?.savedDrafts) ? value.savedDrafts.map(normalizeDraft).filter(Boolean) : [];
        refreshDraftControls();
    }
    function resume(index) {
        if (session || !currentCanvasWidth || !currentCanvasHeight || !byId('canvasRetouchPanel')
            || !byId('canvasSurface') || !byId('canvasStage')) return;
        const select = byId('canvasRetouchDraftSelect');
        const targetIndex = Number(index === undefined || index === null ? (select?.value || 0) : index);
        const items = pendingDrafts();
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= items.length) return;
        draft = clone(items[targetIndex]);
        savedDrafts = items.filter((_, itemIndex) => itemIndex !== targetIndex).map(clone);
        refreshDraftControls();
        return open();
    }
    function snapshot() {
        const archives = savedDrafts.map(clone);
        if (draft) return {...clone(draft), ...(archives.length ? {savedDrafts: archives} : {})};
        return archives.length ? {savedDrafts: archives} : undefined;
    }
    root.CanvasRetouch = {open, resume, canEditAppliedLayer, close, sync, restore, snapshot,
        isOpen: () => Boolean(session), isBusy: () => Boolean(session?.busy || session?.stroke),
        canPan: () => Boolean(session && !session.stroke && (session.tool === 'hand' || session.space)),
        scheduleView: () => session?.nativeSurface?.scheduleView?.(),
        presentView: () => session?.nativeSurface?.presentView?.(),
        viewStats: () => session?.nativeSurface?.viewStats?.(),
        traceInput: listener => {inputTrace = typeof listener === 'function' ? listener : null;},
        refreshControls: () => {update(); refreshDraftControls();}};
})(window);
