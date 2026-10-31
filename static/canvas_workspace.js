/* One main editor, with in-stage picture previews of the other live canvases. */
(function (root) {
    'use strict';
    const state = root.CanvasWorkspaceState;
    const context = state?.context(root.location.search);
    if (!context || context.mode === 'pane') return;
    const doc = root.document, channel = 'naim-canvas-workspace';
    const frames = new Map(), pending = new Map();
    let workspaceId, key, manifest, shell, notice, picker, manager, references, frameHost, inlinePaneId;
    let pickerRevision = 0, retouchSettings = null, referenceHost = null, referenceStage = null, observer = null;
    let pickerPreviews = null, pickerSearch = null, pickerSelection = new Set(), pickerItems = [];
    let pickerFooterCount = null, pickerAddButton = null, pickerNoResults = null;
    let controls, mainSelect, visibilityMenu, visibilityList, visibilitySummary, controlsHost;
    let drag = null;
    const id = () => root.crypto.randomUUID().replaceAll('-', '');
    const node = (tag, className, text) => {
        const value = doc.createElement(tag);
        if (className) value.className = className;
        if (text !== undefined) value.textContent = text;
        return value;
    };
    function button(label, action, className = 'secondary') {
        const value = node('button', className, label);
        value.type = 'button'; value.onclick = action; return value;
    }
    function message(text = '', error = false) {
        notice.textContent = text; notice.hidden = !text; notice.classList.toggle('error', error);
    }
    function commit(next) {
        const normalized = state.normalize(next);
        if (!normalized) throw new Error('캔버스 작업 공간 형식이 올바르지 않습니다.');
        root.localStorage.setItem(key, JSON.stringify(normalized)); manifest = normalized;
    }
    const sourceOf = entry => entry?.local ? root : entry?.frame.contentWindow;
    function send(paneId, action, extra = {}) {
        const entry = frames.get(paneId);
        if (entry?.local) return root.CanvasWorkspaceBridge.execute(action, extra);
        sourceOf(entry)?.postMessage({channel, type: 'command', paneId, action, ...extra}, root.location.origin);
    }
    function request(paneId, action) {
        const entry = frames.get(paneId);
        if (!entry?.ready) return Promise.resolve({ok: false, error: '캔버스를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.'});
        if (entry.local) return root.CanvasWorkspaceBridge.execute(action);
        const requestId = id();
        return new Promise(resolve => {
            const timer = root.setTimeout(() => {
                pending.delete(requestId);
                resolve({ok: false, error: '캔버스의 응답이 늦어지고 있습니다. 다시 시도해 주세요.'});
            }, 30000);
            pending.set(requestId, {paneId, resolve, timer}); send(paneId, action, {requestId});
        });
    }
    function referenceOf(pane) {
        if (pane.reference) {
            const reference = pane.reference;
            if (reference.fitHeight && reference.fitRatio) {
                const footerHeight = frames.get(pane.id)?.footer?.getBoundingClientRect?.().height || 0;
                return {...reference,
                    width: Math.max(120, reference.fitHeight * reference.fitRatio + 2),
                    height: Math.max(120, reference.fitHeight + footerHeight + 8)};
            }
            return reference;
        }
        const visible = manifest.panes.filter(value => !value.closed && value.id !== manifest.activeId && value.reference?.visible !== false);
        const index = Math.max(0, visible.indexOf(pane));
        const height = Math.max(120, Math.min(300, ((referenceHost?.clientHeight || 700) - 64) / Math.max(1, visible.length) - 8));
        return {visible: true, x: 8, y: 56 + index * (height + 8), width: 160, height};
    }
    function visibleReferences() {
        return manifest.panes.filter(pane => !pane.closed && pane.id !== manifest.activeId && referenceOf(pane).visible);
    }
    function place(entry, bounds) {
        const ratio = bounds.fitHeight > 0 && bounds.fitRatio > 0
            ? bounds.fitRatio : entry.image.naturalWidth > 0 && entry.image.naturalHeight > 0
                ? entry.image.naturalWidth / entry.image.naturalHeight : 0;
        const width = Math.min(2000, Math.max(120, Number(bounds.fitHeight > 0 && ratio > 0
            ? bounds.fitHeight * ratio + 2 : bounds.width) || 160));
        entry.card.style.width = width + 'px';
        const footerHeight = entry.footer.getBoundingClientRect?.().height || 0;
        const imageHeight = bounds.fitHeight > 0 ? bounds.fitHeight
            : ratio > 0 ? width / ratio : Math.max(32, Number(bounds.height) - footerHeight - 8 || 32);
        const height = imageHeight + footerHeight + 8;
        entry.card.style.height = '';
        entry.pictureWrapper.style.width = width + 'px'; entry.pictureWrapper.style.height = imageHeight + 'px';
        entry.picture.style.width = '100%'; entry.picture.style.height = '100%';
        if (entry.fit) entry.fit.textContent = '높이 맞춤';
        return {...bounds, width, height, imageHeight, ratio};
    }
    function layoutReferences() {
        if (!referenceHost) return;
        referenceStage?.classList.toggle('has-multi-references', visibleReferences().length > 0);
        for (const pane of manifest.panes) {
            const entry = frames.get(pane.id); if (!entry) continue;
            const bounds = referenceOf(pane);
            entry.card.hidden = pane.id === manifest.activeId || !bounds.visible || pane.closed;
            if (!entry.card.hidden) place(entry, bounds);
        }
    }
    function attachReferences() {
        const active = frames.get(manifest.activeId);
        const editorDoc = active?.local ? doc : active?.frame.contentDocument;
        const host = active?.ready ? editorDoc?.querySelector('.canvas-workspace') : null;
        const stage = host?.querySelector('#canvasStage') || null;
        if (host !== referenceHost || stage !== referenceStage) {
            referenceStage?.classList.remove('has-multi-references');
            observer?.disconnect(); referenceHost = host; referenceStage = stage;
            if (stage) {
                stage.append(references);
                if (root.ResizeObserver) { observer = new root.ResizeObserver(layoutReferences); observer.observe(host); }
            } else {
                referenceHost = null; referenceStage = null; shell.append(references);
            }
        }
        references.hidden = !stage; layoutReferences();
    }
    function attachControls() {
        const active = frames.get(manifest.activeId);
        const editorDoc = active?.local ? doc : active?.frame.contentDocument;
        const host = active?.ready ? editorDoc?.querySelector('#canvasWorkspaceControls') : null;
        visibilityMenu.hidden = !host;
        if (host !== controlsHost) {
            if (visibilityMenu) visibilityMenu.open = false;
            controlsHost = host;
            (host || shell).append(controls);
            controls.classList.toggle('canvas-multi-controls-floating', !host);
        }
    }
    function renderControls() {
        if (!mainSelect) return;
        const panes = manifest.panes.filter(pane => !pane.closed);
        // Status reports must not rebuild the focused select or checkbox list.
        const revision = JSON.stringify(panes.map(pane => [pane.id, pane.name, pane.id === manifest.activeId,
            referenceOf(pane).visible, frames.get(pane.id)?.ready, frames.get(pane.id)?.status]));
        if (controls.dataset.revision === revision) return;
        controls.dataset.revision = revision;
        mainSelect.replaceChildren();
        for (const pane of panes) {
            const entry = frames.get(pane.id);
            const option = node('option', '', pane.name + (!entry.ready ? ' · 불러오는 중' : ''));
            option.value = pane.id; option.disabled = !entry.ready;
            mainSelect.append(option);
        }
        if (!panes.length) mainSelect.append(node('option', '', '열린 캔버스 없음'));
        mainSelect.value = manifest.activeId || '';
        mainSelect.disabled = !panes.length;
        mainSelect.title = panes.find(pane => pane.id === manifest.activeId)?.name || '메인 캔버스 선택';
        const shown = panes.filter(pane => pane.id !== manifest.activeId && referenceOf(pane).visible).length;
        visibilitySummary.textContent = `표시 ${shown}`;
        const focusedPane = visibilityList.ownerDocument?.activeElement?.dataset.paneId;
        visibilityList.replaceChildren();
        for (const pane of panes) {
            const active = pane.id === manifest.activeId, entry = frames.get(pane.id);
            const row = node('label', 'canvas-multi-visibility-row');
            const check = node('input'); check.type = 'checkbox'; check.dataset.paneId = pane.id;
            check.checked = active || referenceOf(pane).visible; check.disabled = active;
            check.setAttribute('aria-label', pane.name + ' 그림 표시');
            check.onchange = () => {
                toggle(pane.id);
                check.checked = referenceOf(manifest.panes.find(value => value.id === pane.id)).visible;
            };
            const text = node('span', '', pane.name); text.title = pane.name;
            const status = node('small', '', active ? '메인' : !entry.ready ? '불러오는 중'
                : ['error', 'conflict'].includes(entry.status) ? '저장 실패' : '');
            row.append(check, text, status); visibilityList.append(row);
            if (pane.id === focusedPane) check.focus?.();
        }
        if (!panes.length) visibilityList.append(node('p', '', '열린 캔버스가 없습니다.'));
    }
    function refreshSelection() {
        const active = frames.get(manifest.activeId);
        doc.body.classList.toggle('canvas-workspace-root-inactive', !active?.local);
        attachControls(); renderControls();
        for (const [paneId, entry] of frames) {
            const selected = paneId === manifest.activeId;
            if (entry.frame) { entry.frame.hidden = !selected; entry.frame.inert = !selected; }
            if (entry.ready) send(paneId, 'active', {active: selected});
        }
        shell.querySelector('.canvas-multi-empty').hidden = Boolean(active);
        attachReferences(); renderManager();
    }
    async function preview(paneId) {
        const entry = frames.get(paneId);
        const pane = manifest.panes.find(value => value.id === paneId);
        if (!entry?.ready || paneId === manifest.activeId || !referenceOf(pane).visible) return;
        if (entry.previewing) { entry.previewAgain = true; return; }
        entry.previewing = true;
        try {
            const result = await request(paneId, 'preview');
            if (frames.get(paneId) !== entry || entry.previewAgain) return;
            if (!result.ok) throw new Error(result.error);
            const src = typeof result.preview === 'string' && result.preview.startsWith('data:image/png') ? result.preview : '';
            entry.image.src = src; entry.image.hidden = !src;
            entry.fit.disabled = !src || !(entry.image.naturalWidth > 0 && entry.image.naturalHeight > 0);
            entry.placeholder.textContent = src ? '' : '빈 캔버스'; entry.placeholder.hidden = Boolean(src);
        } catch (error) {
            entry.placeholder.textContent = '그림 표시 실패 · 클릭하여 다시 시도'; entry.placeholder.hidden = false;
            entry.placeholder.title = error.message;
        } finally {
            entry.previewing = false;
            if (entry.previewAgain && frames.get(paneId) === entry) {entry.previewAgain = false; preview(paneId);}
        }
    }
    function select(paneId) {
        const next = frames.get(paneId);
        if (!next?.ready) { message('캔버스를 불러오는 중입니다. 잠시 후 다시 시도해 주세요.'); return false; }
        if (paneId === manifest.activeId) return true;
        try {
            const oldId = manifest.activeId, target = manifest.panes.find(pane => pane.id === paneId);
            const old = manifest.panes.find(pane => pane.id === oldId);
            const slotOf = pane => {
                const {fitHeight, fitRatio, ...slot} = referenceOf(pane);
                return slot;
            };
            const targetSlot = slotOf(target), oldSlot = old ? slotOf(old) : targetSlot;
            const fitFor = pane => pane?.reference?.fitHeight > 0 && pane?.reference?.fitRatio > 0
                ? {fitHeight: pane.reference.fitHeight, fitRatio: pane.reference.fitRatio} : {};
            commit({...manifest, activeId: paneId, panes: manifest.panes.map(pane => pane.id === oldId
                ? {...pane, reference: {...targetSlot, ...fitFor(old)}}
                : pane.id === paneId ? {...pane, reference: {...oldSlot, ...fitFor(target)}} : pane)});
            if (oldId) preview(oldId);
            refreshSelection(); sourceOf(next)?.focus?.(); message(); return true;
        } catch (error) { message('선택을 저장하지 못했습니다. ' + error.message, true); return false; }
    }
    function toggle(paneId) {
        const pane = manifest.panes.find(value => value.id === paneId);
        if (!pane || pane.closed || paneId === manifest.activeId) return;
        try {
            const reference = referenceOf(pane);
            commit({...manifest, panes: manifest.panes.map(value => value.id === paneId
                ? {...value, reference: {...reference, visible: !reference.visible}} : value)});
            layoutReferences(); renderControls(); renderManager();
            if (!reference.visible) preview(paneId);
        } catch (error) { message('표시 설정을 저장하지 못했습니다. ' + error.message, true); }
    }
    function startDrag(event, paneId, resize) {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const pane = manifest.panes.find(value => value.id === paneId), entry = frames.get(paneId);
        const bounds = place(entry, referenceOf(pane));
        drag = {paneId, pointerId: event.pointerId, target: event.currentTarget, x: event.clientX, y: event.clientY,
            bounds, ratio: bounds.ratio || bounds.width / Math.max(32, bounds.imageHeight),
            fit: bounds.fitHeight > 0 && bounds.fitRatio > 0, resize};
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    function moveDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.x, dy = event.clientY - drag.y, b = drag.bounds;
        if (!drag.resize || !(drag.ratio > 0)) return;
        const baseHeight = drag.fit ? b.fitHeight : b.imageHeight;
        const byWidth = baseHeight + dx / drag.ratio, byHeight = baseHeight + dy;
        const imageHeight = Math.max(32,
            Math.abs(byWidth - baseHeight) > Math.abs(byHeight - baseHeight) ? byWidth : byHeight);
        const width = Math.min(2000, Math.max(120, imageHeight * drag.ratio + 2));
        const footerHeight = frames.get(drag.paneId)?.footer?.getBoundingClientRect?.().height || 0;
        const bounds = {...b, width, height: imageHeight + footerHeight + 8};
        if (drag.fit) {bounds.fitHeight = imageHeight; bounds.fitRatio = drag.ratio;}
        else {delete bounds.fitHeight; delete bounds.fitRatio;}
        drag.next = place(frames.get(drag.paneId), bounds);
    }
    function stopDrag(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const finished = drag; drag = null;
        if (finished.target.hasPointerCapture?.(event.pointerId)) finished.target.releasePointerCapture(event.pointerId);
        if (finished.next && event.type !== 'pointercancel') {
            try {
                const {imageHeight, ratio, ...reference} = finished.next;
                commit({...manifest, panes: manifest.panes.map(pane => pane.id === finished.paneId
                    ? {...pane, reference} : pane)});
            }
            catch (error) { message('그림 위치를 저장하지 못했습니다. ' + error.message, true); }
        }
        layoutReferences();
    }
    function mount(pane, local = false) {
        if (frames.has(pane.id) || pane.closed) return;
        local = local || pane.id === inlinePaneId;
        const card = node('section', 'canvas-multi-reference'); card.dataset.paneId = pane.id;
        const footer = node('div', 'canvas-multi-reference-footer');
        const title = node('span', 'canvas-multi-reference-title', pane.name); title.title = pane.name;
        const choose = button('메인', () => select(pane.id)); choose.title = '이 캔버스를 메인과 교체';
        const fit = button('높이 맞춤', () => fitReference(pane.id), 'canvas-multi-reference-fit secondary');
        fit.title = '현재 캔버스와 같은 높이로 맞추기'; fit.disabled = true;
        fit.setAttribute('aria-label', pane.name + ' 그림을 현재 캔버스와 같은 높이로 맞추기');
        const hide = button('숨김', () => toggle(pane.id)); hide.setAttribute('aria-label', pane.name + ' 숨기기');
        footer.append(title, choose, fit, hide);
        const picture = button('', () => select(pane.id), 'canvas-multi-picture');
        picture.setAttribute('aria-label', pane.name + ' 메인으로 선택');
        const image = node('img'); image.alt = pane.name; image.draggable = false; image.hidden = true;
        const placeholder = node('span', '', '불러오는 중…'); picture.append(image, placeholder);
        const resize = button('↘', () => {}, 'canvas-multi-reference-resize'); resize.title = '드래그로 그림 크기 조절';
        resize.setAttribute('aria-label', pane.name + ' 표시 크기 조절');
        const pictureWrapper = node('div', 'canvas-multi-reference-picture');
        pictureWrapper.append(picture, resize);
        card.append(pictureWrapper, footer); references.append(card);
        for (const [target, resizing] of [[resize, true]]) {
            target.addEventListener('pointerdown', event => startDrag(event, pane.id, resizing));
            target.addEventListener('pointermove', moveDrag);
            target.addEventListener('pointerup', stopDrag); target.addEventListener('pointercancel', stopDrag);
        }
        resize.onclick = event => event.stopPropagation();
        placeholder.onclick = event => {event.stopPropagation(); preview(pane.id);};
        let frame = null;
        if (!local) {
            frame = node('iframe', 'canvas-multi-editor'); frame.title = pane.name;
            frame.src = state.frameUrl(workspaceId, pane); frame.hidden = true; frameHost.append(frame);
        }
        frames.set(pane.id, {card, frame, local, footer, title, image, picture, pictureWrapper, placeholder, choose, fit, hide, ready: local,
            status: local ? 'saved' : 'loading', closing: false, previewing: false});
        image.addEventListener('load', () => {
            fit.disabled = !(image.naturalWidth > 0 && image.naturalHeight > 0);
            layoutReferences();
        });
        image.addEventListener('error', () => {fit.disabled = true;});
    }
    function fitReference(paneId) {
        const pane = manifest.panes.find(value => value.id === paneId), entry = frames.get(paneId);
        const active = frames.get(manifest.activeId), editor = sourceOf(active);
        const surface = editor?.document?.querySelector?.('#canvasSurface');
        const height = surface?.getBoundingClientRect?.().height;
        const image = entry?.image, naturalWidth = Number(image?.naturalWidth), naturalHeight = Number(image?.naturalHeight);
        if (!pane || !entry?.ready || !active?.ready || !(height > 0)
            || !(naturalWidth > 0) || !(naturalHeight > 0)) {
            message('현재 캔버스와 그림 미리보기가 준비된 뒤 높이를 맞출 수 있습니다.', true);
            return false;
        }
        try {
            const prior = referenceOf(pane), ratio = naturalWidth / naturalHeight;
            const width = Math.min(2000, Math.max(120, height * ratio + 2));
            entry.card.style.width = width + 'px';
            const cardHeight = height + (entry.footer.getBoundingClientRect?.().height || 0) + 8;
            const reference = {...prior, fitHeight: height, fitRatio: ratio, width, height: cardHeight};
            commit({...manifest, panes: manifest.panes.map(value => value.id === paneId
                ? {...value, reference} : value)});
            layoutReferences(); message(); return true;
        } catch (error) {message('높이 맞춤을 저장하지 못했습니다. ' + error.message, true); return false;}
    }
    async function close(paneId) {
        const entry = frames.get(paneId);
        if (!entry || entry.closing) return false;
        entry.closing = true; renderManager();
        try {
            const result = await request(paneId, 'flush'); if (!result.ok) throw new Error(result.error);
            commit({...manifest, panes: manifest.panes.map(pane => pane.id === paneId ? {...pane, closed: true} : pane)});
            entry.card.remove();
            // The original editor remains alive so its pending callbacks and undo history stay isolated.
            if (entry.local) send(paneId, 'active', {active: false});
            else entry.frame.remove();
            frames.delete(paneId); refreshSelection(); message('작업을 보관했어요. 캔버스 추가에서 다시 열 수 있습니다.'); return true;
        } catch (error) {message(error.message, true); return false;}
        finally {entry.closing = false; renderManager();}
    }
    function add(input, snapshot) {
        try {
            const existing = manifest.panes.find(pane => input.projectId && pane.projectId === input.projectId && pane.canvasId === input.canvasId
                || input.setupId && pane.setupId === input.setupId || input.id && pane.id === input.id);
            if (existing) {
                commit({...manifest, panes: manifest.panes.map(pane => pane.id === existing.id
                    ? {...pane, closed: false, reference: {...referenceOf(pane), visible: true}} : pane)});
                mount(manifest.panes.find(pane => pane.id === existing.id)); refreshSelection(); preview(existing.id); return existing.id;
            }
            const pane = {...input, id: id(), name: input.name || '새 캔버스', closed: false};
            const normalized = state.normalize({version: 1, panes: [pane], activeId: pane.id});
            if (!normalized?.panes.length) throw new Error('캔버스 정보를 읽지 못했습니다.');
            if (snapshot) root.localStorage.setItem(state.stateKey(workspaceId, pane.id), JSON.stringify({...snapshot,
                projectLink: null, workspaceSetupId: pane.setupId || null}));
            const newCanvas = !snapshot && !pane.projectId;
            commit({...manifest, panes: [...manifest.panes, normalized.panes[0]], activeId: manifest.activeId || pane.id});
            mount(normalized.panes[0]); frames.get(pane.id).newCanvas = newCanvas; refreshSelection(); message(); return pane.id;
        } catch (error) {message('캔버스를 추가하지 못했습니다. ' + error.message, true); return null;}
    }
    function receive(data, source) {
        const entry = frames.get(data?.paneId);
        if (!entry || source !== sourceOf(entry) || data.channel !== channel) return;
        if (data.type === 'response') {
            const item = pending.get(data.requestId); if (!item || item.paneId !== data.paneId) return;
            root.clearTimeout(item.timer); pending.delete(data.requestId);
            item.resolve({ok: data.ok === true, error: typeof data.error === 'string' ? data.error : '', preview: data.preview}); return;
        }
        if (!['ready', 'status'].includes(data.type)) return;
        const pane = manifest.panes.find(value => value.id === data.paneId);
        const restoreRetouch = data.type === 'ready' && pane.retouch;
        entry.ready = data.ready === true; entry.status = data.status;
        const next = {...pane, retouch: restoreRetouch || data.retouch === true};
        if (typeof data.name === 'string' && data.name.trim()) next.name = data.name;
        if (/^[a-f0-9]{32}$/.test(data.projectId) && /^[a-f0-9]{32}$/.test(data.canvasId)) {
            next.projectId = data.projectId; next.canvasId = data.canvasId; delete next.setupId;
        } else if (entry.ready) {delete next.projectId; delete next.canvasId;}
        if (JSON.stringify(next) !== JSON.stringify(pane)) {
            try {commit({...manifest, panes: manifest.panes.map(value => value.id === pane.id ? next : value)});}
            catch (error) {message('작업 공간 자동 저장 실패: ' + error.message, true);}
        }
        entry.title.textContent = next.name; entry.title.title = next.name + ' · 드래그로 이동'; entry.image.alt = next.name;
        entry.fit.setAttribute('aria-label', next.name + ' 그림을 현재 캔버스와 같은 높이로 맞추기');
        if (entry.frame) entry.frame.title = next.name;
        if (data.type === 'ready') {
            refreshSelection();
            if (restoreRetouch) send(pane.id, 'restoreRetouch');
            if (entry.newCanvas) {entry.newCanvas = false; select(pane.id); send(pane.id, 'new');}
        }
        if (data.type === 'ready' || data.status === 'saved') preview(pane.id);
        renderControls(); renderManager();
    }
    function onMessage(event) {if (event.origin === root.location.origin) receive(event.data, event.source);}
    async function api(url) {
        const response = await root.fetch(url), result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || '목록을 불러오지 못했습니다.');
        return result;
    }
    function dialog(title) {
        const value = node('dialog', 'canvas-multi-picker');
        const heading = node('div', 'canvas-multi-picker-heading');
        const label = node('h2', '', title); label.id = 'canvasMultiDialog' + id(); value.setAttribute('aria-labelledby', label.id);
        heading.append(label, button('닫기', () => value.close())); value.append(heading, node('div', 'canvas-multi-picker-content'));
        for (const type of ['keydown', 'paste', 'copy', 'cut']) value.addEventListener(type, event => event.stopPropagation());
        doc.body.append(value); return value;
    }
    function renderManager() {
        if (!manager?.open) return;
        const content = manager.querySelector('.canvas-multi-picker-content'); content.replaceChildren();
        for (const pane of manifest.panes.filter(value => !value.closed)) {
            const entry = frames.get(pane.id), active = pane.id === manifest.activeId;
            const row = node('div', 'canvas-multi-manager-row'), name = node('strong', '', pane.name); name.title = pane.name;
            const status = node('span', '', active ? '메인 편집 중' : referenceOf(pane).visible ? '그림 표시 중' : '그림 숨김');
            if (['error', 'conflict'].includes(entry.status)) {status.textContent += ' · 저장 실패'; status.className = 'error';}
            const actions = node('div', 'canvas-multi-row-actions');
            const remove = button('작업 닫기', () => close(pane.id)); remove.disabled = entry.closing || !entry.ready;
            actions.append(remove); row.append(name, status, actions); content.append(row);
        }
        if (!frames.size) content.append(node('p', '', '열린 캔버스가 없습니다. 캔버스를 추가해 주세요.'));
    }
    function openManager() {manager ||= dialog('열린 캔버스'); manager.showModal(); renderManager();}
    async function leave() {
        const results = await Promise.all([...frames.keys()].map(paneId => request(paneId, 'flush')));
        const failed = results.find(result => !result.ok);
        if (failed) {message(failed.error, true); return false;}
        root.location.assign('/'); return true;
    }
    function togglePanel(name) {
        const editor = sourceOf(frames.get(manifest.activeId));
        if (!editor?.document) return;
        const body = editor.document.body, enabled = !body.classList.contains('canvas-multi-' + name + '-open');
        for (const panel of ['tools', 'layers']) body.classList.toggle('canvas-multi-' + panel + '-open', panel === name && enabled);
        editor.dispatchEvent(new editor.Event('resize'));
    }
    function disposePickerPreviews() {
        pickerPreviews?.dispose(); pickerPreviews = null;
        for (const item of pickerItems) {
            item.previewObserver?.disconnect?.();
        }
    }
    function resetPicker() {
        pickerRevision++;
        disposePickerPreviews(); pickerItems = []; pickerSelection.clear();
        pickerFooterCount = null; pickerAddButton = null; pickerNoResults = null; pickerSearch = null;
    }
    function closePicker() {
        if (picker?.open) picker.close();
        resetPicker();
    }
    function currentProjectContext() {
        const pane = manifest?.panes.find(value => value.id === manifest.activeId);
        let link = null;
        try {link = sourceOf(frames.get(manifest.activeId))?.CanvasProject?.localLink?.() || null;} catch (_) {}
        return {id: link?.projectId || pane?.projectId || '',
            name: link?.projectName || pane?.projectName || ''};
    }
    function updatePickerSelection() {
        if (pickerFooterCount) pickerFooterCount.textContent = `${pickerSelection.size}개 선택`;
        if (pickerAddButton) {
            pickerAddButton.textContent = `선택 ${pickerSelection.size}개 추가`;
            pickerAddButton.disabled = pickerSelection.size === 0;
        }
        for (const item of pickerItems) {
            if (item.checkbox) item.checkbox.checked = pickerSelection.has(item.key);
            if (item.errorNode) {
                item.errorNode.hidden = !item.error;
                item.errorNode.textContent = item.error || '';
            }
        }
    }
    function togglePickerSelection(item) {
        if (pickerSelection.has(item.key)) pickerSelection.delete(item.key);
        else pickerSelection.add(item.key);
        updatePickerSelection();
    }
    function filterPickerItems() {
        const query = String(pickerSearch?.value || '').trim().toLocaleLowerCase('ko-KR');
        const visibleGroups = new Map();
        const visibleSections = new Map();
        for (const item of pickerItems) {
            const visible = !query || item.searchText.includes(query);
            if (item.element) item.element.hidden = !visible;
            if (item.group && visible) visibleGroups.set(item.group, (visibleGroups.get(item.group) || 0) + 1);
            if (item.section && visible) visibleSections.set(item.section, (visibleSections.get(item.section) || 0) + 1);
        }
        for (const group of new Set(pickerItems.map(item => item.group).filter(Boolean)))
            group.hidden = !visibleGroups.has(group);
        for (const section of picker?.querySelectorAll('.canvas-multi-picker-section') || [])
            section.hidden = Boolean(query) && !visibleSections.has(section) && !section.querySelector('.error');
        const noResults = Boolean(query) && visibleGroups.size === 0;
        if (pickerNoResults) pickerNoResults.hidden = !noResults;
        if (pickerSearch) pickerSearch.dataset.noResults = String(noResults);
    }
    function addPickerItem(item, group, section) {
        const card = node('article', 'canvas-multi-picker-card');
        const select = node('label', 'canvas-multi-picker-card-select'), checkbox = node('input');
        checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', item.name + ' 선택');
        checkbox.onchange = () => {if (checkbox.checked) pickerSelection.add(item.key); else pickerSelection.delete(item.key); updatePickerSelection();};
        const name = node('span', '', item.name); name.title = item.name;
        const openPane = manifest.panes.some(pane => !pane.closed && (item.kind === 'project'
            ? pane.projectId === item.projectId && pane.canvasId === item.canvasId
            : item.kind === 'setup' && pane.setupId === item.input.setupId));
        if (openPane) select.append(checkbox, name, node('span', 'canvas-multi-picker-open-badge', '열림'));
        else select.append(checkbox, name);
        const toggle = button('', () => togglePickerSelection(item), 'canvas-multi-picker-card-toggle');
        const previewBox = node('div', 'canvas-multi-picker-card-preview', '미리보기를 불러오는 중…');
        const title = node('strong', '', item.name); title.title = item.name;
        const detail = node('span', '', item.detail); detail.title = item.detail;
        toggle.append(previewBox, title, detail);
        const error = node('p', 'canvas-multi-picker-card-error'); error.hidden = true;
        const retry = button('미리보기 다시 시도', () => retryPickerPreview(item), 'secondary canvas-multi-picker-preview-retry');
        retry.hidden = true;
        card.append(select, toggle, error, retry); group.append(card);
        item.element = card; item.group = group; item.section = section; item.checkbox = checkbox; item.errorNode = error;
        item.previewBox = previewBox; item.retryButton = retry;
        pickerItems.push(item);
        observePickerPreview(item, pickerPreviews);
        updatePickerSelection();
    }
    function removePickerItem(item) {
        item.element?.remove(); item.previewObserver?.disconnect?.();
        pickerSelection.delete(item.key);
        pickerItems = pickerItems.filter(value => value !== item);
    }
    function updatePickerRetryButtons() {
        for (const item of pickerItems) {
            const failed = item.previewBox?.classList.contains('daki-warning') === true;
            if (item.retryButton) item.retryButton.hidden = !failed;
        }
    }
    function observePickerPreview(item, previews) {
        if (!previews) {item.previewBox.textContent = '미리보기를 사용할 수 없습니다.'; return;}
        const observe = item.kind === 'project'
            ? () => previews.observe(item.previewBox, item.projectId, item.canvas)
            : () => previews.observeState(item.previewBox, item.setupPreview);
        try {observe();} catch (error) {
            item.previewBox.textContent = '미리보기를 불러오지 못했습니다.';
            item.previewBox.classList.add('daki-warning'); item.error = error.message;
        }
        if (typeof root.MutationObserver === 'function') {
            item.previewObserver = new root.MutationObserver(() => {
                updatePickerRetryButtons();
            });
            item.previewObserver.observe(item.previewBox, {attributes: true, childList: true, subtree: true});
        }
        updatePickerRetryButtons();
    }
    function retryPickerPreview(item) {
        const pending = pickerItems.filter(value => value.previewBox
            && value.previewBox.getAttribute('aria-busy') === 'true'
            && !value.previewBox.classList.contains('daki-warning')
            && !value.previewBox.querySelector('img'));
        pickerPreviews?.dispose?.();
        pickerPreviews = root.DakiCanvasPreviews?.create?.() || null;
        const restart = new Set([...pending, item]);
        for (const target of restart) {
            target.previewObserver?.disconnect?.(); target.previewObserver = null;
            target.retryButton.hidden = true; target.previewBox.classList.remove('daki-warning');
            target.previewBox.removeAttribute('role'); target.previewBox.setAttribute('aria-busy', 'true');
            target.previewBox.textContent = '불러오는 중…';
            observePickerPreview(target, pickerPreviews);
        }
    }
    function pickerItemForClosedPane(pane, group) {
        const item = {key: 'closed:' + pane.id, kind: 'closed', name: pane.name,
            detail: '보관한 편집 상태', input: pane,
            searchText: (pane.name + ' 보관한 편집 상태').toLocaleLowerCase('ko-KR')};
        const row = node('div', 'canvas-multi-picker-quick-item');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', pane.name + ' 선택');
        checkbox.onchange = () => {if (checkbox.checked) pickerSelection.add(item.key); else pickerSelection.delete(item.key); updatePickerSelection();};
        const choose = button(pane.name, () => togglePickerSelection(item), 'secondary'); choose.title = pane.name;
        const error = node('small', 'canvas-multi-picker-quick-error'); error.hidden = true;
        row.append(checkbox, choose, error); group.append(row);
        item.element = row; item.group = group; item.checkbox = checkbox; item.errorNode = error; pickerItems.push(item);
    }
    function pickerSection(content, title) {
        const section = node('section', 'canvas-multi-picker-section');
        section.append(node('h3', '', title)); content.append(section); return section;
    }
    function addProjectGroup(section, project, isCurrent) {
        const group = node('div', 'canvas-multi-picker-project-group');
        if (!isCurrent) group.append(node('h4', '', project.name || '이름 없는 프로젝트'));
        const grid = node('div', 'canvas-multi-picker-grid');
        let count = 0;
        for (const side of ['front', 'back']) {
            const canvases = project.canvases?.[side] || [];
            if (!canvases.length) continue;
            for (const canvas of canvases) {
                count++;
                const width = canvas.width || canvas.state?.width || '?';
                const height = canvas.height || canvas.state?.height || '?';
                addPickerItem({key: `project:${project.id}:${canvas.id}`, kind: 'project', name: canvas.name || '이름 없는 캔버스',
                    projectId: project.id, canvasId: canvas.id,
                    detail: `${project.name || '이름 없는 프로젝트'} · ${side === 'front' ? '앞면' : '뒷면'} · ${width} × ${height} px`,
                    canvas: {...canvas, side}, input: {name: canvas.name, projectId: project.id, canvasId: canvas.id},
                    searchText: `${canvas.name || ''} ${project.name || ''} ${side} ${width} ${height}`.toLocaleLowerCase('ko-KR')}, grid, section);
            }
        }
        if (count) {group.append(grid); section.append(group);}
        return count;
    }
    function renderPickerCatalog(content, quick, results, currentProject) {
        content.replaceChildren(quick);
        const projectsResult = results[0];
        const projects = projectsResult.status === 'fulfilled' ? projectsResult.value.projects || [] : [];
        const current = currentProject.id
            ? projects.find(project => String(project.id) === String(currentProject.id)) : null;
        const projectTitle = currentProject.id
            ? `현재 프로젝트 · ${current?.name || currentProject.name || '캔버스 프로젝트'}` : '프로젝트 캔버스';
        const projectSection = pickerSection(content, projectTitle);
        let projectCount = 0;
        if (projectsResult.status === 'rejected') {
            projectSection.append(node('p', 'error', '프로젝트 캔버스를 불러오지 못했습니다. ' + projectsResult.reason.message));
        } else {
            if (current) projectCount += addProjectGroup(projectSection, current, true);
            else if (currentProject.id) projectSection.append(node('p', '', '현재 프로젝트를 찾지 못했습니다. 다른 프로젝트 목록을 표시합니다.'));
            if (!currentProject.id) {
                for (const project of projects) projectCount += addProjectGroup(projectSection, project, false);
            } else {
                const others = projects.filter(project => String(project.id) !== String(currentProject.id));
                if (others.length) {
                    const otherSection = pickerSection(content, '다른 프로젝트');
                    for (const project of others) projectCount += addProjectGroup(otherSection, project, false);
                }
            }
            if (!projectCount && !currentProject.id) projectSection.append(node('p', '', '저장된 프로젝트 캔버스가 없습니다.'));
        }
        const setupSection = pickerSection(content, '저장한 캔버스');
        const setupsResult = results[1];
        if (setupsResult.status === 'rejected') {
            setupSection.append(node('p', 'error', '저장한 캔버스를 불러오지 못했습니다. ' + setupsResult.reason.message));
        } else {
            const setups = setupsResult.value.setups || [];
            if (setups.length) {
                const grid = node('div', 'canvas-multi-picker-grid'); setupSection.append(grid);
                for (const setup of setups) {
                    const savedAt = setup.savedAt ?? setup.updatedAt ?? setup.createdAt ?? setup.id;
                    addPickerItem({key: 'setup:' + setup.id, kind: 'setup', name: setup.name || '이름 없는 캔버스',
                        detail: `${setup.width || setup.state?.width || '?'} × ${setup.height || setup.state?.height || '?'} px`,
                        input: {name: setup.name, setupId: setup.id}, snapshot: setup.state,
                        setupPreview: {id: setup.id, name: setup.name, savedAt, state: setup.state},
                        searchText: `${setup.name || ''} ${setup.width || setup.state?.width || ''} ${setup.height || setup.state?.height || ''}`.toLocaleLowerCase('ko-KR')}, grid, setupSection);
                }
            } else setupSection.append(node('p', '', '저장한 캔버스가 없습니다.'));
        }
        pickerNoResults = node('p', 'canvas-multi-picker-no-results', '검색 결과가 없습니다.');
        pickerNoResults.hidden = true; content.append(pickerNoResults);
        filterPickerItems();
    }
    async function addSelectedPickerItems() {
        let failures = 0;
        for (const item of [...pickerItems]) {
            if (!pickerSelection.has(item.key)) continue;
            const paneId = item.kind === 'closed' ? add(item.input) : add(item.input, item.snapshot);
            if (paneId) {item.error = ''; removePickerItem(item);}
            else {item.error = '추가하지 못했습니다. 다시 시도해 주세요.'; failures++;}
        }
        updatePickerSelection(); filterPickerItems();
        if (!failures) closePicker();
    }
    function openPicker() {
        if (!picker) {
            picker = dialog('캔버스 추가');
            picker.addEventListener('close', () => {if (!picker.open) resetPicker();});
        }
        picker.classList.add('canvas-multi-picker-gallery');
        const closeButton = picker.querySelector('.canvas-multi-picker-heading')?.querySelector('button');
        if (closeButton) closeButton.onclick = closePicker;
        const revision = ++pickerRevision, content = picker.querySelector('.canvas-multi-picker-content');
        disposePickerPreviews(); pickerItems = []; pickerSelection.clear();
        picker.querySelectorAll('.canvas-multi-picker-search, .canvas-multi-picker-footer').forEach(element => element.remove());
        content.replaceChildren();
        const quick = node('div', 'canvas-multi-picker-quick');
        const newGroup = node('section', 'canvas-multi-picker-quick-group');
        newGroup.append(node('h3', '', '새 캔버스'));
        const newButton = button('+ 새 캔버스', () => {if (add({name: '새 캔버스'})) closePicker();});
        newButton.title = '크기를 정해 빈 캔버스를 엽니다.'; newGroup.append(newButton); quick.append(newGroup);
        const closed = manifest.panes.filter(pane => pane.closed);
        if (closed.length) {
            const closedGroup = node('section', 'canvas-multi-picker-quick-group');
            closedGroup.append(node('h3', '', '닫은 작업 다시 열기'));
            const closedList = node('div', 'canvas-multi-picker-quick-list'); closedGroup.append(closedList); quick.append(closedGroup);
            for (const pane of closed) pickerItemForClosedPane(pane, closedList);
        }
        const search = node('input', 'canvas-multi-picker-search'); search.type = 'search';
        search.placeholder = '캔버스 또는 프로젝트 검색'; search.setAttribute('aria-label', '캔버스 또는 프로젝트 검색');
        search.oninput = filterPickerItems;
        const status = node('p', 'canvas-multi-picker-loading');
        const currentProject = currentProjectContext();
        status.textContent = currentProject.id
            ? (currentProject.name ? `현재 프로젝트 · ${currentProject.name}의 캔버스를 먼저 불러오는 중…`
                : '현재 연결 프로젝트의 캔버스를 먼저 불러오는 중…')
            : '프로젝트와 저장한 캔버스를 불러오는 중…';
        const footer = node('div', 'canvas-multi-picker-footer');
        const count = node('span', '', '0개 선택');
        const submit = button('선택 0개 추가', addSelectedPickerItems); submit.disabled = true;
        submit.classList.add('primary');
        footer.append(count, submit);
        content.append(status, quick);
        picker.insertBefore(search, content); picker.append(footer);
        pickerSearch = search; pickerFooterCount = count; pickerAddButton = submit;
        if (!picker.open) picker.showModal();
        pickerPreviews = root.DakiCanvasPreviews?.create?.() || null;
        const resultsPromise = Promise.allSettled([api('/api/daki/projects'), api('/api/canvas/setups')]);
        return resultsPromise.then(results => {
            if (revision !== pickerRevision || !picker.open) return;
            renderPickerCatalog(content, quick, results, currentProject);
        });
    }
    function start(options = {}) {
        if (shell) {openManager(); return;}
        workspaceId = options.workspaceId || context.workspaceId; key = state.manifestKey(workspaceId);
        inlinePaneId = options.paneId;
        if (!key) throw new Error('캔버스 작업 공간 ID가 올바르지 않습니다.');
        shell = node('div', 'canvas-multi'); shell.id = 'canvasMulti';
        controls = node('div', 'canvas-multi-controls'); controls.setAttribute('aria-label', '여러 캔버스');
        const mainLabel = node('label', 'canvas-multi-main-label', '메인');
        mainSelect = node('select', 'canvas-multi-main-select'); mainSelect.setAttribute('aria-label', '메인 캔버스');
        mainSelect.onchange = () => {if (!select(mainSelect.value)) mainSelect.value = manifest.activeId || '';};
        mainLabel.append(mainSelect);
        visibilityMenu = node('details', 'canvas-header-menu canvas-multi-visibility');
        visibilitySummary = node('summary', '', '표시'); visibilitySummary.setAttribute('aria-label', '표시할 캔버스');
        const menuContent = node('div', 'canvas-header-menu-content canvas-multi-visibility-content');
        visibilityList = node('div', 'canvas-multi-visibility-list');
        menuContent.append(node('p', 'canvas-multi-visibility-help', '참고 그림으로 표시할 캔버스를 선택하세요.'), visibilityList,
            button('열린 작업 관리', openManager));
        visibilityMenu.append(visibilitySummary, menuContent);
        const addButton = button('+ 추가', openPicker); addButton.title = '프로젝트 또는 저장한 캔버스 추가';
        addButton.setAttribute('aria-label', '캔버스 추가');
        controls.append(mainLabel, visibilityMenu, addButton);
        for (const [name, label] of [['tools', '도구'], ['layers', '레이어']])
            controls.append(button(name === 'tools' ? '편집' : label, () => togglePanel(name), 'secondary canvas-multi-panel-toggle'));
        notice = node('p', 'canvas-multi-notice'); notice.hidden = true; notice.setAttribute('role', 'status'); controls.append(notice);
        frameHost = node('div', 'canvas-multi-editors');
        references = node('div', 'canvas-multi-references');
        const empty = node('div', 'canvas-multi-empty'); empty.append(node('p', '', '편집할 캔버스를 추가해 주세요.'), button('+ 캔버스 추가', openPicker));
        for (const surface of [references]) for (const type of ['pointerdown', 'keydown', 'wheel', 'paste', 'copy', 'cut'])
            surface.addEventListener(type, event => event.stopPropagation());
        shell.append(frameHost, empty, references, controls); doc.body.append(shell); doc.body.classList.add('canvas-workspace-enabled');
        try {manifest = state.normalize(JSON.parse(root.localStorage.getItem(key) || 'null'));
            if (!manifest) throw new Error('저장된 작업 공간을 찾지 못했습니다. 캔버스를 추가해 주세요.');
        } catch (error) {manifest = {version: 1, panes: [], activeId: null, layout: 'row'}; message(error.message, true);}
        root.addEventListener('message', onMessage); root.addEventListener('resize', layoutReferences);
        manifest.panes.forEach(pane => mount(pane, pane.id === options.paneId));
        if (options.paneId) {root.CanvasWorkspaceBridge.attach(workspaceId, options.paneId); root.CanvasWorkspaceBridge.ready();}
        refreshSelection();
    }
    function readRetouchSettings(paneId, source) {
        if (!frames.has(paneId) || sourceOf(frames.get(paneId)) !== source) return null;
        return retouchSettings ? root.structuredClone(retouchSettings) : null;
    }
    function writeRetouchSettings(paneId, source, value) {
        if (paneId !== manifest.activeId || sourceOf(frames.get(paneId)) !== source) return false;
        retouchSettings = root.CanvasRetouchState.copySettings(value); return true;
    }
    root.CanvasWorkspace = {start, receive, add, select, toggle, close, openPicker, openManager, leave, readRetouchSettings, writeRetouchSettings};
    if (context.mode === 'host') {
        if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => start(), {once: true}); else start();
    }
})(window);
