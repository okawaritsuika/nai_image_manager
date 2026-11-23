(function (root) {
    'use strict';

    function mount(host) {
        const doc = host.ownerDocument;
        const figure = doc.createElement('figure');
        figure.className = 'inpaint-send-preview';
        const caption = doc.createElement('figcaption');
        const title = doc.createElement('strong');
        title.textContent = '전송 미리보기';
        const size = doc.createElement('span');
        caption.append(title, size);
        const image = doc.createElement('canvas');
        image.setAttribute('role', 'img');
        const frame = doc.createElement('div');
        frame.className = 'inpaint-send-preview-frame';
        frame.appendChild(image);
        const detail = doc.createElement('p');
        figure.append(caption, frame, detail);
        host.appendChild(figure);

        // Each panel retains just its current two sources. An old image completion
        // can trigger a redraw, but draw always reads the current sources.
        let source = null;
        let strip = null;
        let current = null;
        function imageFor(previous, src) {
            if (!src) return null;
            if (previous?.src === src) return previous;
            const item = {src, image: doc.createElement('img'), failed: false};
            item.image.onload = () => { if (source === item || strip === item) draw(); };
            item.image.onerror = () => {
                item.failed = true;
                if (source === item || strip === item) draw();
            };
            item.image.src = src;
            return item;
        }

        function draw() {
            const {width, height, stripWidth, scale, panX, panY, fitBox} = current;
            const total = width + stripWidth;
            const hasClip = width > 0 && height > 0;
            title.textContent = !hasClip && strip ? '등록한 참고 그림' : '전송 미리보기';
            size.textContent = hasClip ? total + ' × ' + height + ' px' : '';
            frame.hidden = !hasClip && !strip;
            image.hidden = true;
            if (!hasClip) {
                detail.textContent = '클립을 선택하면 전송할 이미지 배치를 확인할 수 있습니다.';
                if (!strip) return;
                if (strip.failed) {
                    detail.textContent = '참고 그림을 불러오지 못했습니다.';
                    return;
                }
                if (!strip.image.naturalWidth) {
                    detail.textContent = '참고 그림을 불러오는 중…';
                    return;
                }
                const {naturalWidth, naturalHeight} = strip.image;
                const ctx = prepareCanvas(naturalWidth, naturalHeight);
                ctx.drawImage(strip.image, 0, 0, naturalWidth, naturalHeight);
                size.textContent = '원본 ' + naturalWidth + ' × ' + naturalHeight + ' px';
                image.setAttribute('aria-label', '등록한 참고 그림');
                image.hidden = false;
                return;
            }
            if (source?.failed || strip?.failed) {
                detail.textContent = (source?.failed ? '클립' : '참고 그림') + '을 불러오지 못했습니다.';
                return;
            }
            if (!source?.image.naturalWidth || (stripWidth && !strip?.image.naturalWidth)) {
                detail.textContent = '전송 미리보기를 준비하는 중…';
                return;
            }

            const ctx = prepareCanvas(total, height);
            if (stripWidth) {
                const box = fitBox(strip.image.naturalWidth, strip.image.naturalHeight, stripWidth, height, scale, panX, panY);
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, stripWidth, height);
                ctx.clip();
                ctx.drawImage(strip.image, box.x, box.y, box.width, box.height);
                ctx.restore();
                detail.textContent = '왼쪽 참고 영역 ' + stripWidth + ' px · 그림 ' + box.width + ' × ' + box.height
                    + ' px · 오른쪽 클립 ' + width + ' × ' + height + ' px';
            } else {
                detail.textContent = '참고 이미지 제외 · 클립만 전송';
            }
            ctx.drawImage(source.image, stripWidth, 0, width, height);
            if (stripWidth) {
                ctx.fillStyle = '#74747d';
                ctx.fillRect(stripWidth, 0, Math.max(1, total / 320, height / 125), height);
            }
            image.setAttribute('aria-label', detail.textContent);
            image.hidden = false;
        }

        function prepareCanvas(width, height) {
            const ratio = Math.min(1, 800 / width, 250 / height);
            image.width = Math.max(1, Math.round(width * ratio));
            image.height = Math.max(1, Math.round(height * ratio));
            image.style.aspectRatio = width + ' / ' + height;
            const ctx = image.getContext('2d');
            ctx.setTransform(image.width / width, 0, 0, image.height / height, 0, 0);
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, width, height);
            return ctx;
        }

        function update(reference, clip, include, fitBox) {
            const width = clip?.imageWidth || clip?.layerWidth || 0;
            const height = clip?.imageHeight || clip?.layerHeight || 0;
            const stripWidth = include && reference ? reference.width : 0;
            const scale = reference?.scale ?? 1;
            const panX = reference?.panX ?? 0.5;
            const panY = reference?.panY ?? 0.5;
            const sourceSrc = width && height ? clip.src : null;
            const stripSrc = reference && (stripWidth || !width || !height) ? reference.src : null;
            if (current && current.width === width && current.height === height
                && current.stripWidth === stripWidth && current.scale === scale
                && current.panX === panX && current.panY === panY
                && current.fitBox === fitBox && (source?.src ?? null) === (sourceSrc ?? null)
                && (strip?.src ?? null) === stripSrc) return;
            current = {width, height, stripWidth, scale, panX, panY, fitBox};
            source = imageFor(source, sourceSrc);
            strip = imageFor(strip, stripSrc);
            draw();
        }
        return {update};
    }

    function mountStrip(host, onPan) {
        const doc = host.ownerDocument;
        const pane = doc.createElement('div');
        pane.className = 'inpaint-reference-strip-pane';
        pane.setAttribute('role', 'group');
        pane.setAttribute('aria-label', '참고 그림 위치. 드래그하거나 방향키로 이동');
        pane.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
        pane.title = '참고 그림 이동 · 드래그 또는 방향키';
        const status = doc.createElement('span');
        status.className = 'inpaint-reference-strip-status';
        pane.appendChild(status);
        host.appendChild(pane);
        let geometry = null;
        let current = null;
        let picture = null;
        let drag = null;

        function draw() {
            geometry = null;
            pane.tabIndex = -1;
            delete pane.dataset.movable;
            if (!current || !picture) return;
            if (!picture.naturalWidth || !picture.naturalHeight) return;
            const {width, height, scale, panX, panY, fitBox} = current;
            const box = fitBox(picture.naturalWidth, picture.naturalHeight, width, height, scale, panX, panY);
            geometry = {freeX: width - box.width, freeY: height - box.height};
            picture.style.left = (box.x * 100 / width) + '%';
            picture.style.top = (box.y * 100 / height) + '%';
            picture.style.width = (box.width * 100 / width) + '%';
            picture.style.height = (box.height * 100 / height) + '%';
            picture.hidden = false;
            status.hidden = true;
            if (geometry.freeX || geometry.freeY) {
                pane.tabIndex = 0;
                pane.dataset.movable = 'true';
            }
        }

        function update(reference, clip, include, fitBox) {
            const height = clip?.imageHeight || clip?.layerHeight || 0;
            const width = reference?.width || 0;
            const src = include && width && height ? reference?.src : null;
            const scale = reference?.scale ?? 1;
            if (!src || current?.src !== src || current?.width !== width
                || current?.height !== height || current?.scale !== scale || current?.clipId !== clip?.id) {
                release();
            }
            pane.hidden = !src;
            if (!src) {
                picture?.remove();
                current = picture = geometry = null;
                return;
            }
            const replace = current?.src !== src;
            current = {src, width, height, scale, clipId: clip?.id,
                panX: reference.panX ?? 0.5, panY: reference.panY ?? 0.5, fitBox};
            if (replace) {
                picture?.remove();
                const img = doc.createElement('img');
                picture = img;
                img.alt = '참고 그림';
                img.draggable = false;
                img.hidden = true;
                status.textContent = '불러오는 중…';
                status.hidden = false;
                img.onload = () => { if (picture === img) draw(); };
                img.onerror = () => {
                    if (picture === img) status.textContent = '참고 그림을 불러오지 못했습니다.';
                };
                pane.appendChild(img);
                img.src = src;
            }
            draw();
        }

        function release() {
            const previous = drag;
            drag = null;
            delete pane.dataset.dragging;
            if (previous && pane.hasPointerCapture(previous.id)) pane.releasePointerCapture(previous.id);
            return previous;
        }

        function position(x, y, commit) {
            const panX = Math.max(0, Math.min(1, x));
            const panY = Math.max(0, Math.min(1, y));
            current.panX = panX;
            current.panY = panY;
            draw();
            onPan(panX, panY, commit);
        }

        pane.addEventListener('pointerdown', event => {
            if (event.button !== 0 || drag || !geometry || (!geometry.freeX && !geometry.freeY)) return;
            const bounds = pane.getBoundingClientRect();
            if (!bounds.width || !bounds.height) return;
            drag = {id: event.pointerId, x: event.clientX, y: event.clientY,
                panX: current.panX, panY: current.panY,
                spanX: geometry.freeX * bounds.width / current.width,
                spanY: geometry.freeY * bounds.height / current.height};
            pane.dataset.dragging = 'true';
            pane.focus({preventScroll: true});
            pane.setPointerCapture(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        });
        function move(event, commit) {
            if (!drag || drag.id !== event.pointerId) return;
            const {panX, panY, spanX, spanY, x, y} = drag;
            if (commit) release();
            event.preventDefault();
            event.stopPropagation();
            position(panX + (spanX ? (event.clientX - x) / spanX : 0),
                panY + (spanY ? (event.clientY - y) / spanY : 0), commit);
        }
        pane.addEventListener('pointermove', event => move(event, false));
        pane.addEventListener('pointerup', event => move(event, true));
        function cancel(event) {
            if (!drag || event.pointerId !== drag.id) return;
            const previous = release();
            position(previous.panX, previous.panY, true);
        }
        pane.addEventListener('pointercancel', cancel);
        pane.addEventListener('lostpointercapture', cancel);
        pane.addEventListener('keydown', event => {
            if (drag || !geometry) return;
            const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
            if (!direction) return;
            event.preventDefault();
            event.stopPropagation();
            const dx = 0.05 * direction[0] * Math.sign(geometry.freeX);
            const dy = 0.05 * direction[1] * Math.sign(geometry.freeY);
            if (dx || dy) position(current.panX + dx, current.panY + dy, true);
        });
        return {update};
    }

    const api = {mount, mountStrip};
    root.CanvasInpaintReferencePreview = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
