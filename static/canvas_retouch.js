/* Whole-canvas retouch sessions. Final pixel processing stays in the local Python engine. */
(function (root) {
    'use strict';
    const doc = root.document;
    const byId = id => doc.getElementById(id);
    const model = () => root.CanvasRetouchState;
    const clone = value => structuredClone(value);
    let draft = null, session = null, copied = null, serial = 0;
    const API = '/api/canvas/retouch/';
    const CONFLICT_RETRIES = 20, CONFLICT_RETRY_DELAY = 300;
    const editableTools = new Set(['paint', 'airbrush', 'clone', 'liquify', 'maskAdd', 'maskErase', 'rect', 'ellipse']);

    function valid(s) {
        return session === s && s.serial === serial && s.layers === canvasLayers
            && s.width === currentCanvasWidth && s.height === currentCanvasHeight;
    }
    function copiedSettings() {
        return root.CanvasWorkspaceBridge?.isPane ? root.CanvasWorkspaceBridge.readRetouchSettings() : copied;
    }
    function view(s) {
        return {...s, doc: draft?.document, canUndo: s.history.canUndo, canRedo: s.history.canRedo,
            hasCopy: Boolean(copiedSettings()), otherAvailable: Boolean(byId('canvasOppositePreviewImage')?.src
                && !byId('canvasOppositePreview')?.hidden)};
    }
    function update(s = session) {
        if (s && valid(s)) s.panel?.update(view(s));
    }
    function message(text, error = false, s = session) {
        if (!s || !valid(s)) return;
        s.message = text; s.error = error; update(s);
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
        s.cloneSource = null; update(s); schedule(s);
    }
    function persist() {
        if (session && valid(session)) saveCanvasState();
    }
    function change(fn, coalesce = false, pixelsChanged = true) {
        const s = session;
        if (!s || s.busy || !draft || !valid(s)) return;
        const now = Date.now();
        if (!coalesce || now - s.lastChange > 400) s.history.push(draft.document);
        s.lastChange = now;
        fn(draft.document);
        syncSelection(s);
        persist(); update(s); if (pixelsChanged) schedule(s); else draw(s);
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
                change(value => {const layer = model().createLayer('paint'); layer.name = '에어브러시'; layer.params.mode = 'color';
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
            maskShow(value) { s.maskShow = value; update(s); schedule(s); },
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
        cancelPreview(s);
        stopAirbrush(s); cancelDraw(s); s.stroke = null; s.strokePreview = null; s.liquifyPreview = null; s.liveFeedback = null;
        draft.document = next;
        syncSelection(s);
        persist(); update(s); schedule(s);
    }
    async function request(path, body, signal, image = false) {
        const response = await fetch(API + path, {method: body ? 'POST' : 'GET', signal,
            headers: body ? {'Content-Type': 'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined});
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const failure = new Error(error.message || error.error || '보정을 처리하지 못했습니다.');
            failure.status = response.status; throw failure;
        }
        return image ? response.blob() : response.json();
    }
    function abortError() {
        const error = new Error('요청이 취소되었습니다.'); error.name = 'AbortError'; return error;
    }
    function waitForRetry(signal, canContinue) {
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
            }, CONFLICT_RETRY_DELAY);
        });
    }
    async function requestWithConflictRetry(path, body, signal, image, canContinue) {
        const snapshot = body === undefined ? undefined : clone(body);
        let retries = 0;
        while (true) {
            if (signal?.aborted || !canContinue()) throw abortError();
            try {
                return await request(path, snapshot, signal, image);
            } catch (error) {
                if (error.status !== 409 || retries >= CONFLICT_RETRIES) throw error;
                retries++;
                await waitForRetry(signal, canContinue);
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
        return s.stroke && (s.stroke.tool === 'airbrush' || s.stroke.tool === 'liquify');
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
        s.previewEpoch++; s.previewQueued = false;
        s.previewController?.abort(); s.previewController = null;
        s.viewport?.invalidate();
    }
    function armPreview(s, delay = 60) {
        if (s.timer != null || s.previewInFlight || s.busy || localStroke(s)) return;
        s.timer = setTimeout(() => {s.timer = null; refresh(s);}, delay);
    }
    function schedule(s) {
        s.previewVersion++;
        s.previewQueued = true;
        s.previewRetries = 0;
        s.viewport?.invalidate();
        armPreview(s);
    }
    async function refresh(s) {
        if (!valid(s) || !draft || s.busy || localStroke(s)) return;
        if (s.previewInFlight) {s.previewQueued = true; return;}
        s.previewInFlight = true; s.previewQueued = false;
        const epoch = s.previewEpoch, version = s.previewVersion;
        const controller = new AbortController(); s.previewController = controller;
        const body = previewPayload(s);
        const maskLayerId = s.selectedId, maskLayer = body.layers.find(layer => layer.id === maskLayerId);
        message('보정 미리보기를 갱신하는 중…', false, s);
        const images = [];
        let retryDelay = 60;
        try {
            const load = async (path, data) => {
                if (!valid(s) || epoch !== s.previewEpoch || controller.signal.aborted) throw abortError();
                const bitmap = await createImageBitmap(await request(path, data, controller.signal, true));
                images.push(bitmap); return bitmap;
            };
            const edited = await load('preview', body);
            const original = s.original || await load('preview', {...body, layers: []});
            const mask = maskLayer && (s.maskShow || maskLayer.type === 'paint' || maskLayer.type === 'liquify' && needsMask(maskLayer))
                ? await load('mask', {...body, layerId: maskLayerId}) : null;
            if (!valid(s) || epoch !== s.previewEpoch || controller.signal.aborted || localStroke(s)) {
                images.forEach(image => image.close()); return;
            }
            // Requests are serialized: show completed intermediate edits while the
            // latest input waits, rather than starving feedback during a long drag.
            s.edited?.close(); s.mask?.close();
            s.edited = edited; s.original = original; s.mask = mask; s.maskLayerId = maskLayerId;
            s.maskKey = maskLayer && JSON.stringify(maskLayer.mask);
            s.liveFeedback = null;
            message(version === s.previewVersion ? '보정 기록은 자동 저장돼요. 적용하면 결과가 캔버스 레이어에 추가됩니다.' : '최신 보정을 반영하는 중…', false, s);
            draw(s);
            root.CanvasWorkspaceBridge?.report();
        } catch (error) {
            images.forEach(image => image.close());
            if (valid(s) && epoch === s.previewEpoch && error.status === 409 && !s.busy && (s.previewRetries || 0) < 8) {
                s.previewRetries = (s.previewRetries || 0) + 1;
                s.previewQueued = true; retryDelay = 300; return;
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
        s.viewport?.setComparison(s.compare, s.compareSplit);
        const canvas = s.image, overlay = s.ink, d = draft.document;
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
            ctx.save(); ctx.beginPath(); ctx.rect(0, 0, x, canvas.height); ctx.clip(); ctx.drawImage(s.original, 0, 0); ctx.restore();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
        }
        const ink = overlay.getContext('2d'); ink.clearRect(0, 0, overlay.width, overlay.height);
        if (s.maskShow && s.mask) {
            ink.drawImage(s.mask, 0, 0); const pixels = ink.getImageData(0, 0, overlay.width, overlay.height);
            for (let i = 0; i < pixels.data.length; i += 4) {const alpha = (255 - pixels.data[i]) * .42;
                pixels.data[i] = 245; pixels.data[i + 1] = 90; pixels.data[i + 2] = 112; pixels.data[i + 3] = alpha;}
            ink.putImageData(pixels, 0, 0);
        }
        const sx = canvas.width / d.width, sy = canvas.height / d.height;
        if (s.guides) {
            const mx = canvas.width * d.print.safeMm / (d.print.widthCm * 10), my = canvas.height * d.print.safeMm / (d.print.heightCm * 10);
            ink.strokeStyle = '#f2cb70'; ink.lineWidth = 1; ink.setLineDash([5, 5]);
            ink.strokeRect(mx, my, canvas.width - 2 * mx, canvas.height - 2 * my);
            ink.beginPath(); ink.moveTo(canvas.width / 2, 0); ink.lineTo(canvas.width / 2, canvas.height); ink.stroke(); ink.setLineDash([]);
        }
        const stroke = s.stroke;
        if (stroke && stroke.brush !== 'airbrush' && !(stroke.tool === 'liquify' && s.liquifyPreview)) {
            ink.strokeStyle = stroke.tool === 'maskErase' ? '#ff7a8a' : '#92e6b1'; ink.fillStyle = '#92e6b133'; ink.lineWidth = 2;
            ink.beginPath();
            if (stroke.tool === 'rect' || stroke.tool === 'ellipse') {
                const a = stroke.points[0], b = stroke.points.at(-1), x = Math.min(a[0], b[0]) * sx, y = Math.min(a[1], b[1]) * sy;
                const w = Math.abs(a[0] - b[0]) * sx, h = Math.abs(a[1] - b[1]) * sy;
                if (stroke.tool === 'ellipse') ink.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
                else ink.rect(x, y, w, h);
                ink.fill();
            } else stroke.points.forEach(([x, y], i) => i ? ink.lineTo(x * sx, y * sy) : ink.moveTo(x * sx, y * sy));
            ink.stroke();
        }
        if (s.cursor && editableTools.has(s.tool)) {
            ink.strokeStyle = '#fff'; ink.lineWidth = 1; ink.beginPath();
            ink.ellipse(s.cursor[0] * sx, s.cursor[1] * sy, s.brush.size / 2 * sx, s.brush.size / 2 * sy, 0, 0, Math.PI * 2); ink.stroke();
        }
    }
    function point(event, surface = session.overlay, width = draft.document.width, height = draft.document.height) {
        const r = surface.getBoundingClientRect();
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
        s.drawFrame = root.requestAnimationFrame(() => {s.drawFrame = null; draw(s);});
    }
    function stopAirbrush(s) {clearTimeout(s.airbrushTimer); s.airbrushTimer = null;}
    function pulseAirbrush(s, stroke) {
        stopAirbrush(s);
        s.airbrushTimer = setTimeout(() => {
            if (!valid(s) || s.stroke !== stroke || stroke.points.length >= 1200) return;
            // A stationary pointer still deposits paint; elapsed time is not stored in the document.
            if (Date.now() - s.lastAirbrushMove >= 100) {stroke.points.push([...stroke.points.at(-1)]); draw(s);}
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
    function sample(s, image, p, width, height) {
        const c = doc.createElement('canvas'); c.width = image.width || image.naturalWidth; c.height = image.height || image.naturalHeight;
        const context = c.getContext('2d'); context.drawImage(image, 0, 0, c.width, c.height);
        const pixel = context.getImageData(Math.min(c.width - 1, Math.floor(p[0] / width * c.width)), Math.min(c.height - 1, Math.floor(p[1] / height * c.height)), 1, 1).data;
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
            event.preventDefault(); event.stopPropagation();
            if (s.tool === 'airbrush' && selected()?.type !== 'paint') tool('airbrush');
            if (s.tool === 'airbrush' && selected()?.type !== 'paint') return;
            if (s.tool === 'liquify' && selected()?.type !== 'liquify') tool('liquify');
            if (s.tool === 'liquify' && selected()?.type !== 'liquify') return;
            const p = point(event), d = draft.document, l = selected();
            if (s.tool === 'dropper') return sample(s, s.compare && p[0] / d.width < s.compareSplit / 100 ? s.original : s.edited, p, d.width, d.height);
            if (s.tool === 'inspect') {inspect(s, p); return;}
            if (s.tool === 'clone' && event.altKey) {s.cloneSource = p; message('원본 복제 기준점을 지정했어요.'); return;}
            if (!l) return message('보정 레이어를 먼저 추가해 주세요.', true);
            if (s.tool === 'clone' && !s.cloneSource) return message('Alt+클릭으로 복제 기준점을 먼저 지정하세요.', true);
            cancelPreview(s);
            s.stroke = {tool: s.tool, layerId: l.id, pointerId: event.pointerId, points: [p], radius: s.brush.size / 2,
                hardness: s.brush.hardness / 100, opacity: s.brush.flow / 100, color: s.brush.color,
                source: s.cloneSource ? [...s.cloneSource] : null, mode: l.params.mode || 'push', strength: l.params.strength || .35};
            if (s.tool === 'maskErase') s.stroke.layerIds = [...s.selectedIds];
            if (s.tool === 'airbrush') {
                Object.assign(s.stroke, {brush: 'airbrush', flow: s.brush.flow / 100, opacity: (s.brush.opacity ?? 100) / 100});
                s.strokePreview = root.CanvasRetouchBrush?.create(s.stroke, s.edited.width, s.edited.height, d.width, d.height);
                s.lastAirbrushMove = Date.now(); pulseAirbrush(s, s.stroke);
            }
            if (s.tool === 'liquify') beginLiquify(s, l);
            s.overlay.setPointerCapture(event.pointerId); draw(s);
            if (!localStroke(s)) schedule(s);
        });
        listen(s.overlay, 'pointermove', event => {
            if (!valid(s) || !draft) return; s.cursor = point(event);
            const stroke = s.stroke;
            let changed = false;
            if (stroke && stroke.pointerId === event.pointerId) {
                const p = s.cursor;
                if (stroke.tool === 'rect' || stroke.tool === 'ellipse') {stroke.points = [stroke.points[0], p]; changed = true;}
                else if (Math.hypot(p[0] - stroke.points.at(-1)[0], p[1] - stroke.points.at(-1)[1]) >= Math.max(1, stroke.radius * (stroke.brush === 'airbrush' ? .05 : .12)) && stroke.points.length < 1200) {
                    stroke.points.push(p); s.lastAirbrushMove = Date.now(); changed = true;
                }
            }
            if (changed && !localStroke(s)) schedule(s);
            if (s.tool === 'liquify') queueDraw(s); else draw(s);
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
            s.stroke = null; if (s.overlay.hasPointerCapture(event.pointerId)) s.overlay.releasePointerCapture(event.pointerId);
            const targets = strokeTargets(draft.document.layers, stroke);
            const count = draft.document.layers.reduce((n, l) => n + [...l.strokes, ...l.mask.strokes].reduce((total, item) => total + item.points.length, 0), 0);
            if (count + stroke.points.length * targets.length > model().LIMITS.maxPoints) {s.strokePreview = null; s.liquifyPreview = null;
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
            change(value => strokeTargets(value.layers, stroke).forEach(layer => recordStroke(layer, stroke))); draw(s);
        });
        const cancelStroke = () => {
            const hadStroke = Boolean(s.stroke);
            stopAirbrush(s); cancelDraw(s); s.stroke = null; s.strokePreview = null; s.liquifyPreview = null;
            if (hadStroke || s.liveFeedback) {cancelPreview(s); schedule(s);} draw(s);
        };
        listen(s.overlay, 'pointercancel', cancelStroke);
        listen(s.overlay, 'lostpointercapture', () => {if (s.stroke) cancelStroke();});
        listen(root, 'blur', cancelStroke);
        listen(s.overlay, 'pointerleave', () => {s.cursor = null; draw(s);});
        listen(s.overlay, 'wheel', event => {if (s.stroke) event.preventDefault(); else handleCanvasWheelZoom(event);}, {passive: false});
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
        cancelPreview(s);
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
            if (valid(s) && !s.busy) schedule(s);
        }, {once: true});
        closeButton.onclick = () => dialog.close();
        try {
            for (const [label, original] of [['원본', true], ['보정', false]]) {
                const figure = doc.createElement('figure'), caption = doc.createElement('figcaption'), image = doc.createElement('img');
                caption.textContent = label; image.alt = label + ' 실제 픽셀'; image.width = Math.min(512, d.width); image.height = Math.min(512, d.height);
                figure.append(caption, image); container.append(figure);
                const blob = await requestWithConflictRetry('detail', {...payload(d), x, y, original}, controller.signal, true,
                    () => valid(s) && dialog.open);
                if (!dialog.open) return; const url = URL.createObjectURL(blob); urls.push(url); image.src = url;
            }
        } catch (error) {if (error.name !== 'AbortError' && dialog.open) {const text = doc.createElement('p'); text.textContent = error.message; container.append(text);}}
    }
    async function apply(s, downloadOnly) {
        if (!valid(s) || s.busy || !draft) return;
        s.busy = true; s.downloadSrc = null;
        cancelPreview(s);
        message('원본 해상도로 보정하는 중…', false, s);
        const record = model().normalize(draft.document), targetId = draft.targetLayerId;
        const controller = new AbortController(); s.applyController = controller;
        try {
            if (!record) throw new Error('보정 기록을 확인해 주세요.');
            const created = await requestWithConflictRetry('apply', payload(record), controller.signal, false, () => valid(s));
            let job = created.job;
            while (job.status === 'running' || job.status === 'queued') {
                await new Promise(resolve => setTimeout(resolve, 750));
                if (!valid(s)) return;
                job = (await request('jobs/' + encodeURIComponent(job.id))).job;
                message(`${job.message || '원본 해상도로 보정하는 중…'} ${Math.round((job.progress || 0) * 100)}%`, false, s);
            }
            if (!valid(s)) return;
            if (job.status !== 'done' || !job.result?.src) throw new Error(job.message || '보정 결과를 저장하지 못했습니다.');
            const result = job.result;
            if (downloadOnly) {s.downloadSrc = result.src; download(result.src, 'NAIM-retouch.png'); message('원본 크기 sRGB PNG를 저장했어요.', false, s); return;}
            let target = targetId != null ? findCanvasLayer(targetId)?.layer : null;
            if (!target || target.type !== 'image') {
                target = {id: layerIdSeq++, type: 'image', name: '전체 보정', visible: true, x: 0, y: 0,
                    layerWidth: record.width, layerHeight: record.height, imageWidth: record.width, imageHeight: record.height};
                canvasLayers.unshift(target);
            }
            target.src = result.src; target.retouch = record;
            activeLayerId = target.id; selectedLayerIds.clear(); selectedLayerIds.add(target.id);
            draft = null; close(false); renderLayerList(); renderCanvasLayersOnSurface(); saveCanvasState();
            root.showToast?.('전체 보정을 적용했어요. 이 결과 레이어를 선택하고 보정을 열면 다시 수정할 수 있어요.');
        } catch (error) {message(error.message, true, s);}
        finally {if (s.applyController === controller) s.applyController = null; s.busy = false; update(s);}
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
        if (!valid(s) || s.busy) return;
        cancelPreview(s); s.busy = true; message('양면을 원본 크기로 출력하는 중…', false, s);
        const controller = new AbortController(); s.pairController = controller;
        const capturedPayload = payload(clone(draft.document));
        try {
            const other = await oppositeSource(); if (!valid(s)) return;
            const blob = await requestWithConflictRetry('export-pair', {...capturedPayload, otherSource: other.source, side: other.side},
                controller.signal, true, () => valid(s));
            if (!valid(s)) return;
            const url = URL.createObjectURL(blob); download(url, 'NAIM-daki-front-back.zip'); setTimeout(() => URL.revokeObjectURL(url), 60000);
            message('양면 ZIP을 저장했어요. 반대쪽은 선택한 후보 또는 저장된 캔버스 상태입니다.', false, s);
        } catch (error) {message(error.message, true, s);} finally {if (s.pairController === controller) s.pairController = null; s.busy = false; update(s);}
    }
    async function open() {
        if (session || !currentCanvasWidth || !currentCanvasHeight) return;
        root.CanvasDakiMapEditor?.close();
        if (typeof setCanvasLayerEraserEnabled === 'function') setCanvasLayerEraserEnabled(false);
        const host = byId('canvasRetouchPanel'), surface = byId('canvasSurface'), stage = byId('canvasStage');
        if (!host || !surface || !stage) return;
        const s = {serial: ++serial, layers: canvasLayers, width: currentCanvasWidth, height: currentCanvasHeight,
            listeners: [], details: new Set(), history: new (model().History)(), selectedId: null, selectedIds: [], tool: 'hand',
            brush: {size: 160, flow: 10, opacity: 100, hardness: 30, color: '#e6baa4'}, compare: false, compareSplit: 50,
            eraserBrush: null, brushBeforeEraser: null,
            liveFeedback: null, strokePreview: null, liquifyPreview: null, drawFrame: null,
            guides: false, maskShow: false, busy: true, message: '캔버스 전체 합성본을 준비하는 중…', error: false,
            previewVersion: 0, previewEpoch: 0, previewQueued: false, previewInFlight: false, timer: null,
            lastChange: 0, toolbar: doc.querySelector('.canvas-toolbar')};
        session = s; s.toolbarInert = s.toolbar?.inert; if (s.toolbar) s.toolbar.inert = true;
        doc.body.classList.add('canvas-retouch-editing'); host.hidden = false;
        s.panel = root.CanvasRetouchPanel.create(host, actions(s)); update(s);
        root.CanvasWorkspaceBridge?.report();
        try {
            if (!draft) {
                const selectedLayer = findCanvasLayer(activeLayerId)?.layer;
                const saved = selectedLayer?.type === 'image' && selectedLayer.x === 0 && selectedLayer.y === 0
                    && selectedLayer.layerWidth === s.width && selectedLayer.layerHeight === s.height ? model().normalize(selectedLayer.retouch) : null;
                if (saved && saved.width === s.width && saved.height === s.height) draft = {document: saved, targetLayerId: selectedLayer.id};
                else {
                    const merged = await renderMergedCanvasToDataUrl(); if (!valid(s)) return;
                    const source = await saveClipDataUrlToServer(merged, {category: 'retouch'}); if (!valid(s)) return;
                    draft = {document: model().normalize({version: 1, source, width: s.width, height: s.height, layers: []}), targetLayerId: null};
                }
            }
            if (!draft?.document || draft.document.width !== s.width || draft.document.height !== s.height) throw new Error('보정 기록과 캔버스 크기가 다릅니다. 기록이 저장된 원래 캔버스에서 열어 주세요.');
            s.selectedId = draft.document.layers.at(-1)?.id || null;
            syncSelection(s);
            const overlay = doc.createElement('div'); overlay.className = 'canvas-retouch-surface-overlay';
            const image = doc.createElement('canvas'), ink = doc.createElement('canvas'); image.setAttribute('aria-label', '캔버스 전체 보정 미리보기'); ink.className = 'canvas-retouch-brush-overlay';
            const originalBadge = doc.createElement('span'), editedBadge = doc.createElement('span'), compareHandle = doc.createElement('button');
            originalBadge.className = 'canvas-retouch-compare-badge canvas-retouch-compare-original'; originalBadge.textContent = '원본';
            editedBadge.className = 'canvas-retouch-compare-badge canvas-retouch-compare-edited'; editedBadge.textContent = '보정본';
            compareHandle.type = 'button'; compareHandle.className = 'canvas-retouch-compare-handle'; compareHandle.textContent = '↔'; compareHandle.tabIndex = 0;
            compareHandle.setAttribute('role', 'slider'); compareHandle.setAttribute('aria-label', '전후 비교 경계');
            compareHandle.setAttribute('aria-valuemin', '0'); compareHandle.setAttribute('aria-valuemax', '100');
            compareHandle.setAttribute('aria-orientation', 'horizontal');
            compareHandle.title = '드래그해 전후 비교 경계를 좌우로 이동';
            overlay.append(image, ink, originalBadge, editedBadge, compareHandle); stage.append(overlay);
            Object.assign(s, {overlay, image, ink, originalBadge, editedBadge, compareHandle, surface});
            const workspace = doc.querySelector('.canvas-workspace');
            if (workspace && root.CanvasRetouchViewport) s.viewport = root.CanvasRetouchViewport.create({
                host: overlay, workspace, documentWidth: s.width, documentHeight: s.height,
                getPayload: () => payload(),
                request: async (body, signal) => createImageBitmap(await request('viewport', body, signal, true)),
                canRequest: () => valid(s) && !s.busy && !s.stroke && !s.previewInFlight && !s.previewQueued && s.timer == null && Boolean(s.edited),
            });
            s.observer = new ResizeObserver(sync); s.observer.observe(surface); bind(s); sync(); s.busy = false; persist(); update(s); refresh(s);
        } catch (error) {if (valid(s)) {message(error.message, true, s); s.busy = false; update(s);}}
    }
    function sync() {
        const s = session; if (!s) return;
        if (!valid(s)) {restore(null); return;}
        if (!s.overlay) return;
        const surface = s.surface;
        Object.assign(s.overlay.style, {left: (surface.offsetLeft + surface.clientLeft) + 'px', top: (surface.offsetTop + surface.clientTop) + 'px',
            width: surface.clientWidth + 'px', height: surface.clientHeight + 'px'});
        updateCompareControls(s);
        s.viewport?.schedule();
    }
    function close(save = true) {
        const s = session; if (!s) return;
        stopAirbrush(s);
        cancelDraw(s); s.liquifyPreview = null; s.liveFeedback = null;
        cancelCompareDrag(s); s.viewport?.destroy();
        if (save) persist(); session = null; serial++;
        clearTimeout(s.timer); s.previewController?.abort(); s.applyController?.abort(); s.pairController?.abort(); s.observer?.disconnect();
        s.listeners.forEach(([target, event, callback, options]) => target.removeEventListener(event, callback, options));
        s.details.forEach(dialog => dialog.close()); s.panel?.destroy(); s.overlay?.remove();
        s.edited?.close(); s.original?.close(); s.mask?.close();
        if (s.toolbar) s.toolbar.inert = Boolean(s.toolbarInert);
        doc.body.classList.remove('canvas-retouch-editing'); byId('canvasRetouchPanel').hidden = true;
        root.CanvasDakiFocus?.refresh();
        root.CanvasWorkspaceBridge?.report();
    }
    function restore(value) {
        close(false);
        const normalized = model()?.normalize(value?.document);
        draft = normalized ? {document: normalized, targetLayerId: Number.isInteger(value.targetLayerId) ? value.targetLayerId : null} : null;
    }
    root.CanvasRetouch = {open, close, sync, restore, snapshot: () => draft ? clone(draft) : undefined,
        isOpen: () => Boolean(session), isBusy: () => Boolean(session?.busy || session?.stroke), refreshControls: () => update()};
})(window);
