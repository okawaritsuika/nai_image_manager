(function (root) {
    'use strict';

    const drafts = new WeakMap();
    const step = 64;
    const cell = 8; // InpaintGridBrush and the server use 8px cells relative to the request.
    const block = 128;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    function boundedSize(value, limit) {
        return clamp(Math.round(value / step) * step, step, Math.floor(limit / step) * step);
    }

    function initialRect(anchor, canvasWidth, canvasHeight) {
        const bounds = root.CanvasSelectionRotation.bounds(anchor);
        const width = boundedSize(Math.ceil(bounds.width / step) * step + 2 * step, canvasWidth);
        const height = boundedSize(Math.ceil(bounds.height / step) * step + 2 * step, canvasHeight);
        return {
            x: clamp(Math.round(bounds.x + (bounds.width - width) / 2), 0, canvasWidth - width),
            y: clamp(Math.round(bounds.y + (bounds.height - height) / 2), 0, canvasHeight - height),
            width, height
        };
    }

    function adjustRect(start, handle, dx, dy, canvasWidth, canvasHeight) {
        if (handle === 'move') return {
            ...start,
            x: clamp(Math.round(start.x + dx), 0, canvasWidth - start.width),
            y: clamp(Math.round(start.y + dy), 0, canvasHeight - start.height)
        };
        const left = handle.endsWith('w');
        const top = handle.startsWith('n');
        const right = start.x + start.width;
        const bottom = start.y + start.height;
        const width = boundedSize(start.width + (left ? -dx : dx), left ? right : canvasWidth - start.x);
        const height = boundedSize(start.height + (top ? -dy : dy), top ? bottom : canvasHeight - start.y);
        return {x: left ? right - width : start.x, y: top ? bottom - height : start.y, width, height};
    }

    function canvasOf(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    function current(clip) {
        const state = drafts.get(clip);
        return state && state.draft === clip.boundaryDraft ? state : null;
    }

    function get(clip) {
        const state = current(clip);
        return state?.enabled && !state.loading ? state : null;
    }

    function makeState(clip, anchor, canvasWidth, canvasHeight) {
        const state = {anchor, canvasWidth, canvasHeight, rect: initialRect(anchor, canvasWidth, canvasHeight),
            enabled: true, adjusting: true, plane: null, stamp: null, draft: clip.boundaryDraft};
        drafts.set(clip, state);
        return state;
    }

    function commit(clip, state, maskChanged = false) {
        if (current(clip) !== state || state.loading) return;
        const draft = {enabled: state.enabled, anchorId: state.anchor.id, rect: {...state.rect},
            canvasWidth: state.canvasWidth, canvasHeight: state.canvasHeight};
        if (state.plane) {
            draft.maskX = state.plane.x;
            draft.maskY = state.plane.y;
            draft.maskDataUrl = maskChanged || state.dirty || !state.draft?.maskDataUrl
                ? state.plane.canvas.toDataURL('image/png') : state.draft.maskDataUrl;
            if (!draft.maskDataUrl.startsWith('data:image/png;base64,')) {
                throw new Error('확장 마스크를 PNG로 저장할 수 없습니다.');
            }
        }
        clip.boundaryDraft = draft;
        state.draft = draft;
        state.dirty = false;
    }

    function toggle(clip, anchor, canvasWidth, canvasHeight) {
        if (!clip || !anchor || !Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) ||
            canvasWidth < step || canvasHeight < step) return null;
        let state = current(clip);
        if (state?.loading) return null;
        if (state?.decodeFailed && state.draft.anchorId === anchor.id) {
            drafts.delete(clip); // Allow the next panel render to retry without overwriting the saved mask.
            return null;
        }
        if (state?.enabled) {
            state.enabled = false;
        } else if (state?.anchor === anchor && state.canvasWidth === canvasWidth && state.canvasHeight === canvasHeight) {
            state.enabled = true;
            state.adjusting = true;
        } else {
            state = makeState(clip, anchor, canvasWidth, canvasHeight);
        }
        commit(clip, state);
        return state.enabled ? state : null;
    }

    function needsRestore(clip) {
        return Boolean(clip?.boundaryDraft && !current(clip));
    }

    function validRect(rect, width, height) {
        return rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) &&
            rect.x >= 0 && rect.y >= 0 && rect.width >= step && rect.height >= step &&
            rect.width % step === 0 && rect.height % step === 0 &&
            rect.x + rect.width <= width && rect.y + rect.height <= height;
    }

    async function restore(clip, anchor, canvasWidth, canvasHeight) {
        if (!needsRestore(clip)) return get(clip);
        const draft = clip.boundaryDraft;
        if (!anchor || draft.anchorId !== anchor.id || draft.canvasWidth !== canvasWidth ||
            draft.canvasHeight !== canvasHeight || !validRect(draft.rect, canvasWidth, canvasHeight)) {
            drafts.set(clip, {draft, enabled: false});
            return null;
        }
        const state = makeState(clip, anchor, canvasWidth, canvasHeight);
        state.enabled = draft.enabled === true;
        state.rect = {...draft.rect};
        if (draft.maskDataUrl) {
            state.loading = true;
            try {
                if (typeof draft.maskDataUrl !== 'string' || !draft.maskDataUrl.startsWith('data:image/png;base64,'))
                    throw new Error('저장된 확장 마스크 형식이 올바르지 않습니다.');
                const image = await loadImageElementForClip(draft.maskDataUrl);
                if (current(clip) !== state) return null;
                const width = image.naturalWidth, height = image.naturalHeight;
                if (![draft.maskX, draft.maskY, width, height].every(Number.isInteger) ||
                    draft.maskX < 0 || draft.maskY < 0 || width <= 0 || height <= 0 ||
                    draft.maskX + width > canvasWidth || draft.maskY + height > canvasHeight)
                    throw new Error('저장된 확장 마스크가 캔버스 범위를 벗어납니다.');
                const canvas = canvasOf(width, height);
                canvas.getContext('2d').drawImage(image, 0, 0);
                state.plane = {canvas, x: draft.maskX, y: draft.maskY};
            } catch (error) {
                if (current(clip) !== state) return null;
                // Keep the saved bitmap intact if its decoding failed.
                drafts.set(clip, {draft, enabled: false, decodeFailed: true});
                throw error;
            } finally {
                state.loading = false;
            }
        }
        return get(clip);
    }

    function intersection(a, b) {
        const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
        const width = Math.min(a.x + a.width, b.x + b.width) - x;
        const height = Math.min(a.y + a.height, b.y + b.height) - y;
        return width > 0 && height > 0 ? {x, y, width, height} : null;
    }

    function planeBounds(plane) {
        return {x: plane.x, y: plane.y, width: plane.canvas.width, height: plane.canvas.height};
    }

    // Allocate only the edited world region, growing in blocks instead of on every pointer sample.
    function ensurePlane(state, area) {
        const old = state.plane;
        if (old && area.x >= old.x && area.y >= old.y &&
            area.x + area.width <= old.x + old.canvas.width && area.y + area.height <= old.y + old.canvas.height)
            return old;
        const x = Math.floor(Math.min(area.x, old?.x ?? area.x) / block) * block;
        const y = Math.floor(Math.min(area.y, old?.y ?? area.y) / block) * block;
        const right = Math.max(area.x + area.width, old ? old.x + old.canvas.width : 0);
        const bottom = Math.max(area.y + area.height, old ? old.y + old.canvas.height : 0);
        const canvas = canvasOf(Math.min(state.canvasWidth, Math.ceil(right / block) * block) - x,
            Math.min(state.canvasHeight, Math.ceil(bottom / block) * block) - y);
        if (old) canvas.getContext('2d').drawImage(old.canvas, old.x - x, old.y - y);
        return state.plane = {x, y, canvas};
    }

    function paint(state, from, to, diameter, erase = false) {
        if (!state || !from || !to || !Number.isFinite(diameter) || diameter <= 0 || (erase && !state.plane)) return false;
        const crop = state.rect, radius = diameter / 2;
        // A crop can move one pixel at a time. Quantize strokes on its own grid before compositing into world space.
        const x = Math.max(0, Math.floor((Math.min(from.x, to.x) - radius - crop.x) / cell) * cell);
        const y = Math.max(0, Math.floor((Math.min(from.y, to.y) - radius - crop.y) / cell) * cell);
        const right = Math.min(crop.width, Math.ceil((Math.max(from.x, to.x) + radius - crop.x) / cell) * cell);
        const bottom = Math.min(crop.height, Math.ceil((Math.max(from.y, to.y) + radius - crop.y) / cell) * cell);
        const width = right - x, height = bottom - y;
        if (width <= 0 || height <= 0) return false;
        const area = {x: crop.x + x, y: crop.y + y, width, height};
        if (erase && !intersection(area, planeBounds(state.plane))) return false;
        let stamp = state.stamp;
        if (!stamp || stamp.width < width || stamp.height < height) {
            stamp = state.stamp = canvasOf(Math.ceil(width / cell) * cell, Math.ceil(height / cell) * cell);
        }
        const brushCtx = stamp.getContext('2d');
        brushCtx.clearRect(0, 0, width, height);
        const applied = root.InpaintGridBrush.paint(brushCtx,
            {x: from.x - area.x, y: from.y - area.y}, {x: to.x - area.x, y: to.y - area.y}, diameter, '#fff', false);
        if (!applied) return false;
        const plane = erase ? state.plane : ensurePlane(state, area);
        const ctx = plane.canvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
        ctx.drawImage(stamp, 0, 0, width, height, area.x - plane.x, area.y - plane.y, width, height);
        ctx.restore();
        state.dirty = true;
        return true;
    }

    function replaceMask(state, maskCanvas) {
        const {x, y, width, height} = state.rect;
        const plane = maskCanvas ? ensurePlane(state, state.rect) : state.plane;
        if (!plane) return;
        const ctx = plane.canvas.getContext('2d');
        ctx.clearRect(x - plane.x, y - plane.y, width, height);
        if (maskCanvas) ctx.drawImage(maskCanvas, x - plane.x, y - plane.y, width, height);
        state.dirty = true;
    }

    function displayMask(state) {
        return state?.plane || null;
    }

    function finishPass(clip, state, rect, submittedDraft) {
        if (get(clip) !== state || state.draft !== submittedDraft || state.dirty) return;
        const plane = state.plane;
        if (plane) {
            plane.canvas.getContext('2d').clearRect(rect.x - plane.x, rect.y - plane.y, rect.width, rect.height);
            if (rect.x <= plane.x && rect.y <= plane.y && rect.x + rect.width >= plane.x + plane.canvas.width &&
                rect.y + rect.height >= plane.y + plane.canvas.height) state.plane = null;
        }
        state.adjusting = true;
        commit(clip, state, true);
    }

    function snapshotMask(state) {
        const plane = displayMask(state);
        if (!plane) return null;
        const overlap = intersection(state.rect, planeBounds(plane));
        if (!overlap) return null;
        const ctx = plane.canvas.getContext('2d');
        // A user may have erased the entire crop while retaining painted pixels elsewhere.
        const {data} = ctx.getImageData(overlap.x - plane.x, overlap.y - plane.y, overlap.width, overlap.height);
        let index = 3;
        while (index < data.length && data[index] === 0) index += 4;
        if (index >= data.length) return null;
        const result = canvasOf(state.rect.width, state.rect.height);
        result.getContext('2d').drawImage(plane.canvas, plane.x - state.rect.x, plane.y - state.rect.y);
        return result;
    }

    const api = {get, toggle, commit, restore, needsRestore, isRestoring: clip => Boolean(current(clip)?.loading),
        adjustRect, paint, displayMask, snapshotMask, replaceMask, finishPass};
    root.CanvasClipBoundary = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
