(function (root) {
  'use strict';

  const MIN_SCALE = 0.25;
  const MAX_SCALE = 8;
  const WHEEL_SPEED = 0.0015;

  function noopHandle() {
    return {reset() {}, dispose() {}};
  }

  function mount(overlay, image) {
    if (!overlay || !image || !overlay.classList || !image.style
        || typeof overlay.addEventListener !== 'function'
        || typeof overlay.removeEventListener !== 'function'
        || typeof overlay.getBoundingClientRect !== 'function'
        || typeof image.addEventListener !== 'function'
        || typeof image.removeEventListener !== 'function'
        || typeof root.addEventListener !== 'function'
        || typeof root.removeEventListener !== 'function') {
      return noopHandle();
    }

    let scale = 1;
    let panX = 0;
    let panY = 0;
    let drag = null;
    let disposed = false;
    const listeners = [];

    function listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      listeners.push([target, type, handler, options]);
    }

    function imageIsUsable() {
      const source = typeof image.getAttribute === 'function'
        ? image.getAttribute('src')
        : image.src;
      return Boolean(overlay.open && image.complete && image.naturalWidth > 0
        && typeof source === 'string' && source.length > 0);
    }

    function render() {
      image.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
    }

    function endDrag(pointerId, releaseCapture = true) {
      if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) return;
      const previous = drag;
      drag = null;
      overlay.classList.remove('is-dragging');
      if (!releaseCapture || typeof image.releasePointerCapture !== 'function') return;
      try {
        if (typeof image.hasPointerCapture !== 'function' || image.hasPointerCapture(previous.pointerId)) {
          image.releasePointerCapture(previous.pointerId);
        }
      } catch (_) {
        // The pointer may have been released by the browser while the drag was ending.
      }
    }

    function reset() {
      endDrag();
      scale = 1;
      panX = 0;
      panY = 0;
      image.style.transform = '';
    }

    function onPointerDown(event) {
      if (!imageIsUsable() || event.target !== image || event.button !== 0
          || event.isPrimary === false || !Number.isFinite(event.pointerId)
          || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      endDrag();
      event.preventDefault();
      drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX, panY};
      if (typeof image.setPointerCapture !== 'function') {
        drag = null;
        return;
      }
      try {
        image.setPointerCapture(event.pointerId);
      } catch (_) {
        drag = null;
        return;
      }
      overlay.classList.add('is-dragging');
    }

    function onPointerMove(event) {
      if (!drag || !imageIsUsable() || event.pointerId !== drag.pointerId
          || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      event.preventDefault();
      panX = drag.panX + event.clientX - drag.x;
      panY = drag.panY + event.clientY - drag.y;
      render();
    }

    function onPointerEnd(event) {
      endDrag(event.pointerId);
    }

    function onLostPointerCapture(event) {
      endDrag(event.pointerId, false);
    }

    function onWheel(event) {
      if (!imageIsUsable() || event.target?.closest?.('button')
          || event.target?.tagName === 'BUTTON' || !Number.isFinite(event.deltaY)
          || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) {
        const height = Number.isFinite(overlay.clientHeight) ? overlay.clientHeight : 1;
        delta *= Math.max(1, height);
      }
      delta = Math.min(1000, Math.max(-1000, delta));
      if (!delta) return;

      const rect = overlay.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return;

      event.preventDefault();
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
        scale * Math.exp(-delta * WHEEL_SPEED)));
      if (nextScale === scale) return;

      const ratio = nextScale / scale;
      const offsetX = event.clientX - centerX;
      const offsetY = event.clientY - centerY;
      panX = offsetX - (offsetX - panX) * ratio;
      panY = offsetY - (offsetY - panY) * ratio;
      scale = nextScale;
      if (drag) {
        drag.x = event.clientX;
        drag.y = event.clientY;
        drag.panX = panX;
        drag.panY = panY;
      }
      render();
    }

    function onClose() {
      if (!overlay.open) reset();
    }

    function onImageChange() {
      reset();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      reset();
      for (const [target, type, handler, options] of listeners) {
        target.removeEventListener(type, handler, options);
      }
      listeners.length = 0;
    }

    listen(image, 'pointerdown', onPointerDown);
    listen(image, 'pointermove', onPointerMove);
    listen(image, 'pointerup', onPointerEnd);
    listen(image, 'pointercancel', onPointerEnd);
    listen(image, 'lostpointercapture', onLostPointerCapture);
    listen(image, 'dragstart', event => event.preventDefault());
    listen(overlay, 'wheel', onWheel, {passive: false});
    listen(overlay, 'close', onClose);
    listen(image, 'load', onImageChange);
    listen(image, 'error', onImageChange);
    listen(root, 'blur', () => endDrag());

    return {reset, dispose};
  }

  root.DakiDictionaryPictureView = {mount};
})(typeof window !== 'undefined' ? window : globalThis);
