/* Read-only preview of a project's saved canvas. */
(function (root) {
    'use strict';
    const doc = root.document;
    let closeActive = null;

    function open({title, message, load, actions = []}) {
        closeActive?.(null);
        const opener = doc.activeElement;
        const controller = new root.AbortController();
        const dialog = doc.createElement('dialog');
        dialog.className = 'canvas-project-dialog canvas-project-preview';
        dialog.setAttribute('aria-labelledby', 'canvasProjectPreviewTitle');
        dialog.setAttribute('aria-describedby', 'canvasProjectPreviewMessage');
        dialog.innerHTML = `
            <header class="canvas-project-preview-header">
                <h2 id="canvasProjectPreviewTitle"></h2>
            </header>
            <div class="canvas-project-preview-body">
                <p id="canvasProjectPreviewMessage"></p>
                <div class="canvas-project-preview-metadata" hidden>
                    <strong class="canvas-project-preview-name"></strong>
                    <span class="canvas-project-preview-revision"></span>
                </div>
                <div class="canvas-project-preview-image" role="status" aria-busy="true">저장한 그림을 불러오는 중…</div>
                <p class="canvas-project-preview-status" role="status" hidden></p>
            </div>
            <footer class="canvas-project-preview-footer">
                <button type="button" class="secondary canvas-project-preview-close">닫기</button>
            </footer>`;
        const find = (selector) => dialog.querySelector(selector);
        const preview = find('.canvas-project-preview-image');
        const footer = find('.canvas-project-preview-footer');
        const closeButton = find('.canvas-project-preview-close');
        const status = find('.canvas-project-preview-status');
        find('#canvasProjectPreviewTitle').textContent = title;
        find('#canvasProjectPreviewMessage').textContent = message;
        let renderer;

        return new Promise(resolve => {
            function finish(choice, restoreFocus = true) {
                if (closeActive !== finish) return;
                closeActive = null;
                controller.abort();
                renderer?.dispose();
                if (dialog.open) dialog.close();
                dialog.remove();
                if (restoreFocus && opener?.isConnected) opener.focus({preventScroll: true});
                resolve(choice);
            }
            closeActive = finish;

            closeButton.onclick = () => finish(null);
            dialog.addEventListener('cancel', event => {
                event.preventDefault();
                finish(null);
            });
            dialog.addEventListener('close', () => finish(null));
            for (const type of ['keydown', 'copy', 'cut', 'paste']) {
                dialog.addEventListener(type, event => event.stopPropagation());
            }
            for (const action of actions) {
                const button = doc.createElement('button');
                button.type = 'button';
                button.textContent = action.label;
                button.onclick = async () => {
                    if (!action.run) {
                        finish(action.id);
                        return;
                    }
                    button.disabled = true;
                    let result;
                    try {
                        result = await action.run();
                    } catch {
                        result = '편집 화면 요청에 실패했습니다.';
                    }
                    if (controller.signal.aborted) return;
                    status.textContent = result || '';
                    status.hidden = !result;
                    button.disabled = false;
                    if (doc.activeElement === doc.body) button.focus({preventScroll: true});
                };
                footer.append(button);
            }

            doc.body.append(dialog);
            dialog.showModal();
            closeButton.focus();
            Promise.resolve().then(() => {
                controller.signal.throwIfAborted();
                return load(controller.signal);
            }).then(canvas => {
                if (controller.signal.aborted) return;
                if (!canvas?.id || !Number.isSafeInteger(canvas.revision) || canvas.revision < 1
                    || !Array.isArray(canvas.state?.layers)) {
                    throw new Error('캔버스 미리보기 응답을 읽을 수 없습니다.');
                }
                const name = canvas.name || '이름 없는 캔버스';
                find('.canvas-project-preview-name').textContent = name;
                find('.canvas-project-preview-revision').textContent = `저장 버전 ${canvas.revision}`;
                find('.canvas-project-preview-metadata').hidden = false;
                renderer = root.DakiCanvasPreviews.create();
                renderer.observeState(preview, {id: canvas.id, name, savedAt: canvas.revision, state: canvas.state});
            }).catch(() => {
                if (controller.signal.aborted) return;
                preview.setAttribute('aria-busy', 'false');
                preview.textContent = '저장한 그림을 불러올 수 없습니다. 잠시 후 다시 열어 주세요.';
            });
        });
    }

    root.CanvasProjectPreview = {open};
    root.addEventListener('pagehide', () => closeActive?.(null, false));
})(window);
