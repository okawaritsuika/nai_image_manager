(function () {
    const MIN_SCALE = 0.25;
    const MAX_SCALE = 8;
    const WHEEL_SPEED = 0.0015;
    let pinned = false;
    let panX = 0;
    let panY = 0;
    let scale = 1;
    let layer = null;
    let stage = null;
    let image = null;
    let pinButton = null;
    let hint = null;
    let attachedStage = null;
    let drag = null;

    function nodes() {
        if (!layer) layer = document.getElementById('zoomLayer');
        if (!stage && layer) stage = layer.querySelector('.gallery-zoom-image-stage');
        if (!image) image = document.getElementById('zoomImg');
        if (!pinButton) pinButton = document.getElementById('galleryZoomPinBtn');
        if (!hint) hint = document.getElementById('galleryZoomViewHint');
    }

    function visible() {
        nodes();
        return !!layer && !layer.hidden && layer.style.display !== 'none';
    }

    function render() {
        nodes();
        if (layer) layer.classList.toggle('gallery-zoom-pinned', pinned);
        if (stage) stage.classList.toggle('gallery-zoom-dragging', !!drag);
        if (image) {
            image.style.transformOrigin = 'center center';
            image.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        }
        if (pinButton) {
            pinButton.textContent = pinned ? '고정 해제' : '고정';
            pinButton.setAttribute('aria-pressed', String(pinned));
        }
        if (hint) hint.textContent = pinned ? '그림·빈 공간 드래그로 이동 · 휠로 확대·축소' : '';
    }

    function clearDrag(releaseCapture = true) {
        if (!drag) return;
        const pointerId = drag.pointerId;
        drag = null;
        if (releaseCapture && stage?.hasPointerCapture?.(pointerId)) {
            try { stage.releasePointerCapture(pointerId); } catch (_) { /* Capture may already be gone. */ }
        }
        if (stage) stage.classList.toggle('gallery-zoom-dragging', false);
    }

    function resetTransform() {
        panX = 0;
        panY = 0;
        scale = 1;
    }

    function finite(value, fallback = 0) {
        return Number.isFinite(value) ? value : fallback;
    }

    function onWheel(event) {
        if (!pinned || !visible()) return;
        let delta = finite(event.deltaY);
        const rect = stage.getBoundingClientRect();
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= Math.max(1, finite(rect.height, 1));
        delta = Math.max(-1000, Math.min(1000, delta));
        if (!delta) return;
        event.preventDefault();

        const width = finite(rect.width);
        const height = finite(rect.height);
        const centerX = finite(rect.left) + width / 2;
        const centerY = finite(rect.top) + height / 2;
        const cursorX = finite(event.clientX, centerX) - centerX;
        const cursorY = finite(event.clientY, centerY) - centerY;
        const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * Math.exp(-delta * WHEEL_SPEED)));
        panX = cursorX - (cursorX - panX) * nextScale / scale;
        panY = cursorY - (cursorY - panY) * nextScale / scale;
        scale = nextScale;
        render();
    }

    function onPointerDown(event) {
        if (!pinned || !visible() || event.button !== 0 || event.isPrimary === false) return;
        event.preventDefault();
        clearDrag();
        drag = {pointerId: event.pointerId, x: finite(event.clientX), y: finite(event.clientY), panX, panY};
        try { stage.setPointerCapture(event.pointerId); } catch (_) { /* Continue with stage-bound pointer events. */ }
        render();
    }

    function onPointerMove(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        if (!pinned || !visible()) {
            clearDrag();
            render();
            return;
        }
        event.preventDefault();
        panX = drag.panX + finite(event.clientX) - drag.x;
        panY = drag.panY + finite(event.clientY) - drag.y;
        render();
    }

    function onPointerEnd(event, lost = false) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        clearDrag(!lost);
        render();
    }

    function init() {
        nodes();
        if (stage && attachedStage !== stage) {
            stage.addEventListener('pointerdown', onPointerDown);
            stage.addEventListener('pointermove', onPointerMove);
            stage.addEventListener('pointerup', event => onPointerEnd(event));
            stage.addEventListener('pointercancel', event => onPointerEnd(event));
            stage.addEventListener('lostpointercapture', event => onPointerEnd(event, true));
            stage.addEventListener('wheel', onWheel, {passive: false});
            stage.addEventListener('dragstart', event => {
                if (pinned && visible() && event.target === image) event.preventDefault();
            });
            attachedStage = stage;
        }
        render();
    }

    function reset(unpin = false) {
        init();
        clearDrag();
        resetTransform();
        if (unpin) {
            pinned = false;
            window.ProjectZoomCompare?.setPinned(false);
        }
        render();
    }

    function toggle() {
        init();
        clearDrag();
        pinned = !pinned;
        resetTransform();
        render();
        window.ProjectZoomCompare?.setPinned(pinned);
        window.updateGalleryZoomUi?.();
    }

    window.GalleryZoomView = {
        init,
        reset,
        isPinned: () => pinned,
        toggle,
    };
})();
