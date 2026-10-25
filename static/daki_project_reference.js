(function (root) {
    'use strict';

    const DEFAULT_WIDTH = 320;
    const CHANGE_EVENT = 'daki-project-settings-changed';
    const CHANNEL_NAME = 'naim-project-canvas-settings';
    const INVALID_RESPONSE = '프로젝트 캔버스 설정 응답을 확인할 수 없습니다.';
    let nextViewerId = 0;

    function mount(options = {}) {
        const {container, projectId, isCurrent} = options;
        const doc = container?.ownerDocument || root.document;
        const normalizeReference = root.CanvasInpaintReference?.normalizeReference;
        if (!container || typeof container.appendChild !== 'function' || !doc) {
            throw new TypeError('프로젝트 참고 이미지 UI를 표시할 컨테이너가 필요합니다.');
        }
        if (typeof projectId !== 'string' || !projectId) {
            throw new TypeError('프로젝트 ID가 필요합니다.');
        }
        if (typeof normalizeReference !== 'function') {
            throw new Error('캔버스 참고 이미지 검증 모듈을 불러오지 못했습니다.');
        }

        const endpoint = '/api/daki/projects/' + encodeURIComponent(projectId) + '/canvas-settings';
        const section = createElement('section', 'daki-project-reference');
        section.setAttribute('aria-label', '인페인팅 참고 이미지');
        const heading = createElement('h3', 'daki-project-reference-title', '인페인팅 참고 이미지');
        const header = createElement('header', 'daki-project-reference-header');
        header.appendChild(heading);

        const content = createElement('div', 'daki-project-reference-content');
        const preview = createElement('div', 'daki-project-reference-preview');
        const previewImage = createElement('img', 'daki-project-reference-preview-image');
        previewImage.alt = '';
        previewImage.hidden = true;
        const previewEmpty = createElement('span', 'daki-project-reference-preview-empty', '등록된 이미지 없음');
        previewEmpty.hidden = false;
        const previewError = createElement('span', 'daki-project-reference-preview-error', '이미지를 불러오지 못했습니다.');
        previewError.hidden = true;
        preview.append(previewImage, previewEmpty, previewError);

        const info = createElement('div', 'daki-project-reference-info');
        const name = createElement('p', 'daki-project-reference-name', '프로젝트 참고 이미지를 불러오는 중…');
        const help = createElement('p', 'daki-project-reference-help',
            '프로젝트에 등록한 이미지는 캔버스의 인페인팅 참고 이미지에서 가져올 수 있습니다.');
        info.append(name, help);

        const controls = createElement('div', 'daki-project-reference-controls');
        const addButton = createButton('daki-project-reference-button daki-project-reference-primary', '이미지 추가');
        const viewButton = createButton('daki-project-reference-button', '크게 보기');
        const refreshButton = createButton('daki-project-reference-button', '새로고침');
        const fileInput = createElement('input', 'daki-project-reference-file');
        fileInput.type = 'file';
        fileInput.accept = 'image/png,image/jpeg,image/webp';
        fileInput.hidden = true;
        controls.append(addButton, viewButton, refreshButton, fileInput);

        const status = createElement('p', 'daki-project-reference-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        section.append(header, content, controls, status);
        content.append(preview, info);
        container.appendChild(section);

        const listenerRemovers = [];
        const viewer = createViewer(doc);
        const viewerTitle = viewer.title;
        const viewerImage = viewer.image;
        const viewerImageError = viewer.imageError;
        const viewerLink = viewer.link;
        const viewerClose = viewer.closeButton;
        let currentReference = null;
        let hasLoadedSettings = false;
        let busyOperation = null;
        let queuedRefresh = false;
        let disposed = false;
        let publishing = false;
        let previewVersion = 0;
        let viewerVersion = 0;
        let restoreFocusTo = null;
        let statusMessage = '프로젝트 참고 이미지를 불러오는 중…';
        let statusIsError = false;
        let channel = null;
        let channelMessageHandler = null;

        function externalCurrent() {
            if (typeof isCurrent !== 'function') return true;
            try {
                return isCurrent() !== false;
            } catch (_) {
                return false;
            }
        }

        function active() {
            if (disposed || !externalCurrent()) {
                if (busyOperation && !busyOperation.controller.signal.aborted) {
                    busyOperation.controller.abort();
                }
                return false;
            }
            return true;
        }

        function operationActive(operation) {
            return Boolean(active() && busyOperation === operation
                && !operation.controller.signal.aborted);
        }

        function setStatus(message, isError = false) {
            if (!active()) return;
            statusMessage = String(message || '');
            statusIsError = isError === true;
            status.textContent = statusMessage;
            status.classList.toggle('is-error', statusIsError);
        }

        function setBusy(operation, message) {
            busyOperation = operation;
            statusMessage = message;
            statusIsError = false;
            status.textContent = message;
            status.classList.remove('is-error');
            syncControls();
        }

        function syncControls() {
            if (!active()) return;
            const busy = Boolean(busyOperation);
            addButton.textContent = currentReference ? '이미지 교체' : '이미지 추가';
            addButton.disabled = busy;
            refreshButton.disabled = busy;
            fileInput.disabled = busy;
            viewButton.disabled = !currentReference;
            status.textContent = statusMessage;
            status.classList.toggle('is-error', statusIsError);
        }

        function applyReference(reference) {
            currentReference = reference ? {...reference} : null;
            const generation = ++previewVersion;
            previewImage.onerror = null;
            previewImage.onload = null;
            previewError.hidden = true;
            previewEmpty.hidden = Boolean(currentReference);
            previewImage.hidden = !currentReference;
            if (currentReference) {
                name.textContent = currentReference.name;
                name.title = currentReference.name;
                previewImage.onerror = () => {
                    if (!active() || generation !== previewVersion) return;
                    previewImage.hidden = true;
                    previewError.hidden = false;
                    setStatus('이미지를 불러오지 못했습니다.', true);
                };
                previewImage.onload = () => {
                    if (!active() || generation !== previewVersion) return;
                    previewImage.hidden = false;
                    previewError.hidden = true;
                    if (statusMessage === '이미지를 불러오지 못했습니다.') setStatus('');
                };
                previewImage.src = currentReference.src + '?preview=256';
            } else {
                name.textContent = '등록된 참고 이미지가 없습니다.';
                name.title = '';
                previewImage.removeAttribute('src');
            }
            if (viewer.dialog.open) syncViewer();
            syncControls();
        }

        function normalizeSettingsResponse(payload) {
            const settings = payload?.settings;
            if (!payload || payload.status !== 'success' || !settings
                || typeof settings !== 'object' || Array.isArray(settings)
                || !Number.isInteger(settings.revision) || settings.revision < 0
                || !Object.prototype.hasOwnProperty.call(settings, 'style')
                || !Object.prototype.hasOwnProperty.call(settings, 'prompts')
                || !Object.prototype.hasOwnProperty.call(settings, 'inpaintSettings')) {
                throw new Error(INVALID_RESPONSE);
            }
            let reference = null;
            if (settings.inpaintReference !== undefined && settings.inpaintReference !== null) {
                reference = normalizeReference(settings.inpaintReference);
                if (!reference) throw new Error('프로젝트 참고 이미지 설정을 확인할 수 없습니다.');
            }
            return {revision: settings.revision, settings, reference};
        }

        function responseError(response, payload) {
            if (response.status === 409) {
                const error = new Error('프로젝트 설정이 다른 곳에서 변경되었습니다. 새로고침한 뒤 다시 등록해 주세요.');
                error.status = 409;
                error.code = payload?.code;
                return error;
            }
            const error = new Error(payload?.message || '요청을 완료하지 못했습니다.');
            error.status = response.status;
            error.code = payload?.code;
            return error;
        }

        async function requestJson(url, options, operation) {
            if (!operationActive(operation)) return null;
            const response = await root.fetch(url, options);
            if (!operationActive(operation)) return null;
            let payload = null;
            try {
                payload = await response.json();
            } catch (_) {
                payload = null;
            }
            if (!operationActive(operation)) return null;
            if (!response.ok || !payload || payload.status !== 'success') {
                throw responseError(response, payload);
            }
            return payload;
        }

        function beginOperation(message) {
            if (busyOperation || !active()) return null;
            const Controller = root.AbortController || AbortController;
            const operation = {controller: new Controller()};
            setBusy(operation, message);
            return operation;
        }

        function finishOperation(operation) {
            if (busyOperation !== operation) return;
            busyOperation = null;
            syncControls();
            if (queuedRefresh && active()) {
                queuedRefresh = false;
                void refreshSettings(false);
            }
        }

        async function refreshSettings(explicit) {
            if (!active()) return;
            if (busyOperation) {
                queuedRefresh = true;
                return;
            }
            const operation = beginOperation(explicit
                ? '프로젝트 참고 이미지를 새로고침하는 중…'
                : '프로젝트 참고 이미지를 불러오는 중…');
            if (!operation) return;
            try {
                const payload = await requestJson(endpoint, {signal: operation.controller.signal}, operation);
                if (!operationActive(operation) || !payload) return;
                const normalized = normalizeSettingsResponse(payload);
                if (!operationActive(operation)) return;
                hasLoadedSettings = true;
                applyReference(normalized.reference);
                setStatus(normalized.reference ? '' : '등록된 참고 이미지가 없습니다.');
            } catch (error) {
                if (operationActive(operation)) {
                    if (!hasLoadedSettings && !currentReference) {
                        name.textContent = '프로젝트 참고 이미지 상태를 불러오지 못했습니다.';
                        name.title = '';
                    }
                    setStatus('프로젝트 참고 이미지를 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요. '
                        + error.message, true);
                }
            } finally {
                finishOperation(operation);
            }
        }

        function uploadFileAllowed(file) {
            const type = String(file?.type || '').toLowerCase();
            const extension = String(file?.name || '').split('.').pop().toLowerCase();
            return ['image/png', 'image/jpeg', 'image/webp'].includes(type)
                || ['png', 'jpg', 'jpeg', 'webp'].includes(extension);
        }

        function uploadedDescriptor(payload, file, width) {
            const descriptor = normalizeReference({
                src: payload?.src || payload?.path,
                name: payload?.name || file.name || '참고 이미지',
                width: width || DEFAULT_WIDTH,
                x: 0.5,
                y: 0.5,
                zoom: 1,
            });
            if (!descriptor) throw new Error('업로드한 이미지의 경로 또는 이름을 확인할 수 없습니다.');
            if (!(Number(payload?.width) > 0) || !(Number(payload?.height) > 0)) {
                throw new Error('업로드한 이미지 크기를 확인할 수 없습니다.');
            }
            return descriptor;
        }

        async function uploadAndSave(file) {
            if (!active() || busyOperation) return;
            if (!uploadFileAllowed(file)) {
                setStatus('PNG, JPEG, WebP 이미지만 추가할 수 있습니다.', true);
                return;
            }
            const operation = beginOperation('이미지를 업로드하는 중…');
            if (!operation) return;
            let stage = 'upload';
            try {
                const form = new root.FormData();
                form.append('file', file);
                const uploaded = await requestJson('/api/canvas/upload_image', {
                    method: 'POST',
                    body: form,
                    signal: operation.controller.signal,
                }, operation);
                if (!operationActive(operation) || !uploaded) return;

                stage = 'settings';
                statusMessage = '최신 프로젝트 설정을 확인하는 중…';
                status.textContent = statusMessage;
                const latestPayload = await requestJson(endpoint, {
                    signal: operation.controller.signal,
                }, operation);
                if (!operationActive(operation) || !latestPayload) return;
                const latest = normalizeSettingsResponse(latestPayload);
                if (!operationActive(operation)) return;
                const descriptor = uploadedDescriptor(uploaded, file,
                    latest.reference?.width || DEFAULT_WIDTH);

                stage = 'save';
                statusMessage = '프로젝트 설정에 이미지를 저장하는 중…';
                status.textContent = statusMessage;
                const {revision, ...settings} = latest.settings;
                const putPayload = await requestJson(endpoint, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        revision,
                        settings: {...settings, inpaintReference: descriptor},
                    }),
                    signal: operation.controller.signal,
                }, operation);
                if (!operationActive(operation) || !putPayload) return;
                const saved = normalizeSettingsResponse(putPayload);
                if (!operationActive(operation)) return;
                applyReference(saved.reference);
                setStatus('인페인팅 참고 이미지를 프로젝트에 등록했습니다.');
                publishChange();
            } catch (error) {
                if (!operationActive(operation)) return;
                if (error.status === 409) {
                    setStatus('프로젝트 설정이 다른 곳에서 변경되었습니다. 새로고침한 뒤 이미지를 다시 등록해 주세요.', true);
                } else if (stage === 'upload') {
                    setStatus('이미지를 업로드하지 못했습니다. ' + error.message, true);
                } else if (stage === 'settings') {
                    setStatus('이미지는 업로드했지만 최신 프로젝트 설정을 확인하지 못했습니다. '
                        + '새로고침한 뒤 다시 등록해 주세요. ' + error.message, true);
                } else {
                    setStatus('이미지는 업로드했지만 프로젝트에 저장하지 못했습니다. '
                        + '새로고침한 뒤 다시 등록해 주세요. ' + error.message, true);
                }
            } finally {
                finishOperation(operation);
            }
        }

        function openFilePicker() {
            if (!active() || busyOperation) return;
            fileInput.click();
        }

        function syncViewer() {
            if (!active()) return;
            const generation = ++viewerVersion;
            viewerTitle.textContent = currentReference?.name || '인페인팅 참고 이미지';
            viewerTitle.title = currentReference?.name || '';
            viewerImage.onerror = null;
            viewerImage.onload = null;
            viewerImageError.hidden = true;
            viewerImage.hidden = !currentReference;
            viewerLink.hidden = !currentReference;
            if (currentReference) {
                viewerImage.alt = currentReference.name;
                viewerImage.onerror = () => {
                    if (!active() || generation !== viewerVersion) return;
                    viewerImage.hidden = true;
                    viewerImageError.hidden = false;
                    viewerImageError.textContent = '이미지를 불러오지 못했습니다.';
                };
                viewerImage.onload = () => {
                    if (!active() || generation !== viewerVersion) return;
                    viewerImage.hidden = false;
                    viewerImageError.hidden = true;
                };
                viewerImage.src = currentReference.src;
                viewerLink.href = currentReference.src;
            } else {
                viewerImage.removeAttribute('src');
                viewerLink.removeAttribute('href');
            }
        }

        function clearViewerImage() {
            viewerVersion += 1;
            viewerImage.onerror = null;
            viewerImage.onload = null;
            viewerImage.removeAttribute('src');
            viewerImage.hidden = true;
            viewerImageError.hidden = true;
            viewerLink.removeAttribute('href');
            viewerLink.hidden = true;
        }

        function onViewerClosed() {
            if (disposed) return;
            clearViewerImage();
            if (!externalCurrent()) return;
            const target = restoreFocusTo;
            restoreFocusTo = null;
            if (target && target.isConnected !== false && typeof target.focus === 'function') {
                try { target.focus({preventScroll: true}); } catch (_) { target.focus(); }
            }
        }

        function openViewer() {
            if (!active() || !currentReference || viewer.dialog.open) return;
            syncViewer();
            restoreFocusTo = viewButton;
            try {
                viewer.dialog.showModal();
                viewerClose.focus({preventScroll: true});
            } catch (_) {
                restoreFocusTo = null;
                clearViewerImage();
                setStatus('이미지 크게 보기를 열지 못했습니다.', true);
            }
        }

        function notifySettingsChanged(event) {
            if (!active() || publishing || event?.projectId !== projectId) return;
            if (busyOperation) {
                queuedRefresh = true;
                return;
            }
            void refreshSettings(false);
        }

        function onDocumentChange(event) {
            notifySettingsChanged({projectId: event?.detail?.projectId});
        }

        function publishChange() {
            publishing = true;
            try {
                if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
                    root.dispatchEvent(new root.CustomEvent(CHANGE_EVENT, {detail: {projectId}}));
                }
                if (channel) channel.postMessage({projectId});
            } catch (_) {
                // Other project views still receive the same-document event when channels are unavailable.
            } finally {
                publishing = false;
            }
        }

        function addRemovableListener(target, type, handler) {
            target.addEventListener(type, handler);
            listenerRemovers.push(() => target.removeEventListener(type, handler));
        }

        addRemovableListener(addButton, 'click', openFilePicker);
        addRemovableListener(viewButton, 'click', openViewer);
        addRemovableListener(refreshButton, 'click', () => void refreshSettings(true));
        addRemovableListener(fileInput, 'change', () => {
            const file = fileInput.files?.[0] || null;
            fileInput.value = '';
            if (file) void uploadAndSave(file);
        });
        addRemovableListener(viewer.dialog, 'close', onViewerClosed);
        addRemovableListener(viewerClose, 'click', () => viewer.dialog.close());
        addRemovableListener(root, CHANGE_EVENT, onDocumentChange);

        try {
            if (typeof root.BroadcastChannel === 'function') {
                channel = new root.BroadcastChannel(CHANNEL_NAME);
                channelMessageHandler = event => notifySettingsChanged(event?.data);
                if (typeof channel.addEventListener === 'function') {
                    channel.addEventListener('message', channelMessageHandler);
                } else {
                    channel.onmessage = channelMessageHandler;
                }
            }
        } catch (_) {
            channel = null;
        }

        syncControls();
        void refreshSettings(false);

        return {
            dispose() {
                if (disposed) return;
                disposed = true;
                queuedRefresh = false;
                restoreFocusTo = null;
                if (busyOperation && !busyOperation.controller.signal.aborted) {
                    busyOperation.controller.abort();
                }
                busyOperation = null;
                previewImage.onerror = null;
                previewImage.onload = null;
                clearViewerImage();
                listenerRemovers.splice(0).forEach(remove => remove());
                if (channel) {
                    if (channelMessageHandler && typeof channel.removeEventListener === 'function') {
                        channel.removeEventListener('message', channelMessageHandler);
                    } else if (channel.onmessage === channelMessageHandler) {
                        channel.onmessage = null;
                    }
                    channel.close();
                    channel = null;
                }
                if (viewer.dialog.open) {
                    try { viewer.dialog.close(); } catch (_) { /* the dialog is removed below */ }
                }
                viewer.dialog.remove();
                section.remove();
            },
        };

        function createViewer(documentObject) {
            const dialog = createElement('dialog', 'daki-dialog daki-project-reference-dialog');
            const headerNode = createElement('header', 'daki-project-reference-dialog-header');
            const titleNode = createElement('h2', 'daki-project-reference-dialog-title', '인페인팅 참고 이미지');
            titleNode.id = 'daki-project-reference-dialog-title-' + (++nextViewerId);
            dialog.setAttribute('aria-labelledby', titleNode.id);
            const close = createButton('daki-project-reference-dialog-close', '닫기');
            headerNode.append(titleNode, close);
            const bodyNode = createElement('div', 'daki-project-reference-dialog-body');
            const imageNode = createElement('img', 'daki-project-reference-dialog-image');
            imageNode.hidden = true;
            const errorNode = createElement('p', 'daki-project-reference-dialog-error', '이미지를 불러오지 못했습니다.');
            errorNode.hidden = true;
            bodyNode.append(imageNode, errorNode);
            const footerNode = createElement('footer', 'daki-project-reference-dialog-footer');
            const linkNode = createElement('a', 'daki-project-reference-dialog-original', '원본 새 탭에서 열기');
            linkNode.target = '_blank';
            linkNode.rel = 'noopener';
            const footerClose = createButton('daki-project-reference-button daki-project-reference-primary', '닫기');
            footerNode.append(linkNode, footerClose);
            dialog.append(headerNode, bodyNode, footerNode);
            documentObject.body.appendChild(dialog);
            addRemovableListener(footerClose, 'click', () => dialog.close());
            return {dialog, title: titleNode, image: imageNode, imageError: errorNode, link: linkNode,
                closeButton: close, footerClose};
        }

        function createElement(tagName, className, text) {
            const element = doc.createElement(tagName);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }

        function createButton(className, text) {
            const button = createElement('button', className, text);
            button.type = 'button';
            return button;
        }
    }

    const api = {mount};
    root.DakiProjectReference = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
