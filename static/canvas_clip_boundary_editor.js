globalThis.CanvasClipBoundaryEditor = (() => {
    const cameras = new WeakMap();
    const corners = {nw: '왼쪽 위', ne: '오른쪽 위', sw: '왼쪽 아래', se: '오른쪽 아래'};
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const inside = (point, rect) => point.x >= rect.x && point.x <= rect.x + rect.width &&
        point.y >= rect.y && point.y <= rect.y + rect.height;

    function mount(panel, state, options) {
        const wrap = panel.querySelector('.canvas-clip-output-image-wrap');
        const strip = wrap.querySelector('.clip-reference-strip');
        const readout = panel.querySelector('.clip-boundary-size');
        const zoomReadout = panel.querySelector('.clip-preview-zoom-readout');
        const view = document.createElement('div');
        view.className = 'clip-boundary-view';
        view.tabIndex = 0;
        view.setAttribute('role', 'group');
        view.setAttribute('aria-label', '경계 확장 편집. 휠로 확대하거나 축소하고 빈 곳을 드래그해 화면을 이동합니다.');
        view.title = '휠: 확대·축소 · 빈 곳 또는 휠 버튼 드래그: 화면 이동';
        const picture = document.createElement('canvas');
        picture.setAttribute('aria-label', '원래 클립 경계와 전송 범위');
        const status = document.createElement('span');
        status.className = 'clip-boundary-status';
        status.setAttribute('role', 'status');
        view.append(picture, status);
        const handles = Object.entries(corners).map(([corner, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'clip-boundary-handle';
            button.dataset.corner = corner;
            button.title = label + ' 모서리 크기 조절 · 방향키로 조절';
            button.setAttribute('aria-label', button.title);
            view.append(button);
            return button;
        });
        wrap.classList.add('clip-boundary-active');
        wrap.insertBefore(view, wrap.querySelector('.clip-inpaint-loading'));
        const model = CanvasClipBoundary;
        const ctx = picture.getContext('2d');
        const world = {width: state.canvasWidth, height: state.canvasHeight};
        const camera = cameras.get(state) || {
            x: state.rect.x + state.rect.width / 2, y: state.rect.y + state.rect.height / 2, zoom: 1,
            fitWidth: state.rect.width * 1.22, fitHeight: state.rect.height * 1.22
        };
        cameras.set(state, camera);
        const screen = {width: 0, height: 0, scale: 1, left: 0, top: 0, dpr: 1};
        let background = null;
        let requestedKey = '';
        let revision = 0;
        let timer = 0;
        let frame = 0;
        let disposed = false;
        let drag = null;
        let hover = null;
        let steps = options.getSteps();
        let requestEstimate;

        function refreshEstimate() {
            requestEstimate = options.getRequestEstimate(state.rect, steps);
            if (readout) {
                const {width, height, cost} = requestEstimate;
                readout.textContent = '전송 ' + width + ' × ' + height + ' px' + (cost ? ' · ' + cost + ' Anlas 예상' : '');
                readout.classList.toggle('clip-boundary-cost-warning', cost > 0);
            }
        }

        function settingsChanged() {
            steps = options.getSteps();
            refreshEstimate();
            queueDraw();
        }

        function localPoint(event) {
            const bounds = view.getBoundingClientRect();
            return {x: event.clientX - bounds.left, y: event.clientY - bounds.top};
        }

        function worldPoint(local) {
            return {x: screen.left + local.x / screen.scale, y: screen.top + local.y / screen.scale};
        }

        function screenPoint(worldPoint) {
            return {x: (worldPoint.x - screen.left) * screen.scale,
                y: (worldPoint.y - screen.top) * screen.scale};
        }

        function layoutCamera() {
            screen.width = view.clientWidth;
            screen.height = view.clientHeight;
            if (!screen.width || !screen.height) return;
            const width = Math.max(1, screen.width - 16), height = Math.max(1, screen.height - 16);
            const fit = Math.min(width / camera.fitWidth, height / camera.fitHeight);
            const minScale = Math.min(width / world.width, height / world.height);
            screen.scale = clamp(fit * camera.zoom, Math.min(fit, minScale), Math.max(fit, 8));
            camera.zoom = screen.scale / fit;
            const halfWidth = width / (2 * screen.scale), halfHeight = height / (2 * screen.scale);
            camera.x = halfWidth * 2 >= world.width ? world.width / 2 :
                clamp(camera.x, halfWidth, world.width - halfWidth);
            camera.y = halfHeight * 2 >= world.height ? world.height / 2 :
                clamp(camera.y, halfHeight, world.height - halfHeight);
            screen.left = camera.x - screen.width / (2 * screen.scale);
            screen.top = camera.y - screen.height / (2 * screen.scale);
            screen.dpr = Math.min(3, window.devicePixelRatio || 1);
            const pixelWidth = Math.round(screen.width * screen.dpr);
            const pixelHeight = Math.round(screen.height * screen.dpr);
            if (picture.width !== pixelWidth || picture.height !== pixelHeight) {
                picture.width = pixelWidth;
                picture.height = pixelHeight;
            }
            if (zoomReadout) zoomReadout.textContent = Math.round(camera.zoom * 100) + '%';
        }

        function requestBackground(immediate = false) {
            if (!screen.width || !screen.height) return;
            // Keep a margin around the viewport so small pans can reuse the decoded image.
            const width = screen.width / screen.scale, height = screen.height / screen.scale;
            const visibleStart = {x: Math.max(0, screen.left), y: Math.max(0, screen.top)};
            const visibleEnd = {x: Math.min(world.width, screen.left + width), y: Math.min(world.height, screen.top + height)};
            const x = Math.max(0, Math.floor(screen.left - width / 4));
            const y = Math.max(0, Math.floor(screen.top - height / 4));
            const rect = {x, y,
                width: Math.min(world.width, Math.ceil(screen.left + width * 1.25)) - x,
                height: Math.min(world.height, Math.ceil(screen.top + height * 1.25)) - y};
            const limit = Math.min(3072, Math.ceil(Math.max(rect.width, rect.height) * screen.scale * screen.dpr));
            const density = Math.min(1, limit / Math.max(rect.width, rect.height));
            if (background && background.density >= density * .98 &&
                inside(visibleStart, background.rect) && inside(visibleEnd, background.rect)) {
                clearTimeout(timer);
                requestedKey = '';
                revision++;
                status.hidden = true;
                return;
            }
            const key = [x, y, rect.width, rect.height, limit].join('/');
            if (requestedKey === key) return;
            requestedKey = key;
            const token = ++revision;
            clearTimeout(timer);
            async function load() {
                if (!background) {
                    status.hidden = false;
                    status.textContent = '주변 그림을 불러오는 중…';
                }
                try {
                    const canvas = await options.renderSource(rect, limit);
                    if (disposed || token !== revision) return;
                    background = camera.lastBackground = {canvas, rect, density};
                    status.hidden = true;
                    queueDraw();
                } catch (error) {
                    if (disposed || token !== revision) return;
                    requestedKey = '';
                    status.textContent = '주변 그림을 불러오지 못했습니다.';
                    status.hidden = false;
                    options.onError(error);
                }
            }
            if (immediate) load();
            else timer = setTimeout(load, 80);
        }

        function draw() {
            frame = 0;
            if (disposed || !screen.width || !screen.height) return;
            const {rect} = state;
            const {width, height, dpr, scale} = screen;
            const start = screenPoint(rect);
            const cropWidth = rect.width * scale, cropHeight = rect.height * scale;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const displayed = background || camera.lastBackground;
            if (displayed) {
                const at = screenPoint(displayed.rect);
                ctx.drawImage(displayed.canvas, at.x, at.y, displayed.rect.width * scale, displayed.rect.height * scale);
            }
            ctx.fillStyle = 'rgba(0, 0, 0, .25)';
            ctx.beginPath();
            ctx.rect(0, 0, width, height);
            ctx.rect(start.x, start.y, cropWidth, cropHeight);
            ctx.fill('evenodd');
            if (requestEstimate.cost > 0) {
                ctx.fillStyle = 'rgba(0, 184, 148, .27)';
                ctx.fillRect(start.x, start.y, cropWidth, cropHeight);
            }
            const mask = !options.previewOnly && model.displayMask(state);
            if (mask) {
                const at = screenPoint(mask);
                ctx.save();
                ctx.beginPath();
                ctx.rect(start.x, start.y, cropWidth, cropHeight);
                ctx.clip();
                ctx.globalAlpha = .58;
                ctx.filter = 'sepia(1) saturate(5) hue-rotate(165deg)';
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(mask.canvas, at.x, at.y, mask.canvas.width * scale, mask.canvas.height * scale);
                ctx.restore();
            }
            ctx.beginPath();
            CanvasSelectionRotation.corners(state.anchor).map(screenPoint).forEach((p, index) => {
                if (index === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
            });
            ctx.closePath();
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(0, 0, 0, .78)';
            ctx.stroke();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#fff';
            ctx.setLineDash([5, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.strokeStyle = '#67e8c3';
            ctx.strokeRect(start.x, start.y, cropWidth, cropHeight);
            if (state.adjusting && !options.previewOnly) {
                const cx = start.x + cropWidth / 2, cy = start.y + cropHeight / 2;
                ctx.beginPath();
                ctx.moveTo(cx - 6, cy);
                ctx.lineTo(cx + 6, cy);
                ctx.moveTo(cx, cy - 6);
                ctx.lineTo(cx, cy + 6);
                ctx.lineWidth = 3;
                ctx.strokeStyle = '#175f50';
                ctx.stroke();
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#eafff9';
                ctx.stroke();
            }
            if (hover && !options.previewOnly && !state.adjusting && options.getTool() !== 'auto' && inside(hover, rect)) {
                const point = screenPoint(hover);
                ctx.beginPath();
                ctx.arc(point.x, point.y, options.getBrushSize() * scale / 2, 0, Math.PI * 2);
                ctx.lineWidth = 3;
                ctx.strokeStyle = 'rgba(0, 0, 0, .7)';
                ctx.stroke();
                ctx.lineWidth = 1;
                ctx.strokeStyle = '#fff';
                ctx.stroke();
            }
            for (const button of handles) {
                button.hidden = !state.adjusting || options.previewOnly;
                const corner = button.dataset.corner;
                button.style.left = (start.x + (corner.endsWith('e') ? cropWidth : 0)) + 'px';
                button.style.top = (start.y + (corner.startsWith('s') ? cropHeight : 0)) + 'px';
            }
        }

        function queueDraw() {
            if (!disposed && !frame) frame = requestAnimationFrame(draw);
        }

        function layout(immediate = false) {
            if (disposed) return;
            refreshEstimate();
            if (strip && !strip.hidden) {
                const factor = Math.min(wrap.clientWidth / (state.rect.width + Number(strip.dataset.referenceWidth)),
                    wrap.clientHeight / state.rect.height);
                strip.style.width = Math.round(Number(strip.dataset.referenceWidth) * factor) + 'px';
                strip.style.height = Math.round(state.rect.height * factor) + 'px';
            }
            layoutCamera();
            requestBackground(immediate === true);
            queueDraw();
        }

        function adjust(initial, handle, dx, dy) {
            state.rect = model.adjustRect(initial, handle, dx, dy, world.width, world.height);
            refreshEstimate();
            queueDraw();
        }

        view.onpointerdown = event => {
            if (drag || event.button > 1 || !screen.width || !screen.height) return;
            const local = localPoint(event), p = worldPoint(local);
            const corner = state.adjusting && event.target.closest('[data-corner]')?.dataset.corner;
            const within = inside(p, state.rect);
            let kind = 'pan';
            if (!options.previewOnly && event.button === 0 && (corner || within)) {
                kind = state.adjusting ? (corner || 'move') : options.getTool();
            }
            event.preventDefault();
            event.stopPropagation();
            if (corner) event.target.focus({preventScroll: true});
            else view.focus({preventScroll: true});
            if (kind === 'auto') {
                Promise.resolve().then(() => options.autoMask(p)).then(queueDraw).catch(error => {
                    if (!disposed) options.onError(error);
                });
                return;
            }
            drag = {id: event.pointerId, kind, local, start: p, last: p, cameraX: camera.x, cameraY: camera.y,
                initial: {...state.rect}};
            view.setPointerCapture(event.pointerId);
            if (kind === 'brush' || kind === 'eraser') {
                drag.painted = model.paint(state, p, p, options.getBrushSize(), kind === 'eraser');
                hover = p;
            }
            view.style.cursor = kind === 'pan' ? 'grabbing' : '';
            queueDraw();
        };
        view.onpointermove = event => {
            if (drag && drag.id !== event.pointerId) return;
            const local = localPoint(event), p = worldPoint(local);
            hover = p;
            if (drag) {
                if (drag.kind === 'pan') {
                    camera.x = drag.cameraX + (drag.local.x - local.x) / screen.scale;
                    camera.y = drag.cameraY + (drag.local.y - local.y) / screen.scale;
                    layoutCamera();
                    requestBackground();
                } else if (drag.kind === 'brush' || drag.kind === 'eraser') {
                    if (model.paint(state, drag.last, p, options.getBrushSize(), drag.kind === 'eraser')) drag.painted = true;
                    drag.last = p;
                } else adjust(drag.initial, drag.kind, p.x - drag.start.x, p.y - drag.start.y);
            } else {
                view.style.cursor = options.previewOnly || !inside(p, state.rect) ? 'grab' : state.adjusting ? 'move' : 'crosshair';
            }
            queueDraw();
        };
        function finish(event) {
            if (drag?.id !== event.pointerId) return;
            const {kind, initial, painted} = drag;
            drag = null;
            if (view.hasPointerCapture(event.pointerId)) view.releasePointerCapture(event.pointerId);
            view.style.cursor = '';
            if (painted) options.onEdit(true);
            else if (kind !== 'pan' && Object.keys(initial).some(key => state.rect[key] !== initial[key])) options.onEdit(false);
            layout();
        }
        view.onpointerup = view.onpointercancel = view.onlostpointercapture = finish;
        view.onpointerleave = () => {hover = null; queueDraw();};
        view.onkeydown = event => {
            const direction = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[event.key];
            if (options.previewOnly || !state.adjusting || !direction) return;
            event.preventDefault();
            event.stopPropagation();
            const corner = event.target.dataset.corner;
            const step = corner ? SELECTION_SIZE_STEP : event.shiftKey ? 10 : 1;
            adjust(state.rect, corner || 'move', direction[0] * step, direction[1] * step);
            options.onEdit(false);
            layout();
        };
        view.addEventListener('wheel', event => {
            event.preventDefault();
            event.stopPropagation();
            if (drag) return;
            const local = localPoint(event), before = worldPoint(local);
            camera.zoom *= getWheelZoomFactor(event);
            layoutCamera();
            const after = worldPoint(local);
            camera.x += before.x - after.x;
            camera.y += before.y - after.y;
            layoutCamera();
            hover = worldPoint(local);
            requestBackground();
            queueDraw();
        }, {passive: false});
        const observer = new ResizeObserver(() => layout());
        observer.observe(wrap);
        window.addEventListener('canvas-inpaint-settings-changed', settingsChanged);
        wrap.addEventListener('clip-reference-layout', layout);
        panel.addEventListener('input', queueDraw);
        layout(true);
        return () => {
            disposed = true;
            clearTimeout(timer);
            if (frame) cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener('canvas-inpaint-settings-changed', settingsChanged);
            wrap.removeEventListener('clip-reference-layout', layout);
            panel.removeEventListener('input', queueDraw);
            const id = drag?.id;
            drag = null;
            if (id != null && view.hasPointerCapture(id)) view.releasePointerCapture(id);
            wrap.classList.remove('clip-boundary-active');
            view.remove();
        };
    }
    return {mount};
})();
