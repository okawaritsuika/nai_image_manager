(function (root, createApi) {
    const api = createApi(root?.document);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.CanvasLayerDelete = api;
})(typeof window === 'object' && window ? window : (typeof globalThis === 'object' ? globalThis : this), function (doc) {
    'use strict';

    const dialogId = 'canvasLayerDeleteDialog';
    let dialog = null;
    let elements = null;
    let activeChoice = null;
    let ignoredCloseEvents = 0;

    function countSourceClips(layer) {
        if (!layer || typeof layer !== 'object') return 0;
        if (layer.type === 'clip') return layer.renderOnCanvas ? 0 : 1;
        if (layer.type !== 'folder' && layer.type !== 'selection') return 0;
        if (!Array.isArray(layer.children)) return 0;
        return layer.children.reduce((count, child) => count + countSourceClips(child), 0);
    }

    function element(tagName, id, className, text) {
        const node = doc.createElement(tagName);
        if (id) node.id = id;
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function ensureDialog() {
        if (dialog) return;

        dialog = element('dialog', dialogId, 'canvas-layer-delete-dialog');
        dialog.setAttribute('aria-labelledby', 'canvasLayerDeleteTitle');
        dialog.setAttribute('aria-describedby', 'canvasLayerDeleteDescription');

        const header = element('header', null, 'canvas-layer-delete-header');
        const title = element('h2', 'canvasLayerDeleteTitle', '', '원본 클립 삭제 확인');
        const closeButton = element('button', 'canvasLayerDeleteClose', 'canvas-layer-delete-close', '×');
        closeButton.type = 'button';
        closeButton.setAttribute('aria-label', '삭제 확인 닫기');
        header.appendChild(title);
        header.appendChild(closeButton);

        const body = element('div', null, 'canvas-layer-delete-body');
        const name = element('div', 'canvasLayerDeleteName', 'canvas-layer-delete-name');
        const description = element('p', 'canvasLayerDeleteDescription', 'canvas-layer-delete-description');
        body.appendChild(name);
        body.appendChild(description);

        const footer = element('footer', null, 'canvas-layer-delete-footer');
        const cancelButton = element('button', 'canvasLayerDeleteCancel', 'secondary', '취소');
        const deleteButton = element('button', 'canvasLayerDeleteConfirm', 'danger', '삭제');
        cancelButton.type = 'button';
        deleteButton.type = 'button';
        footer.appendChild(cancelButton);
        footer.appendChild(deleteButton);

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        doc.body.appendChild(dialog);

        closeButton.addEventListener('click', () => finish(false));
        cancelButton.addEventListener('click', () => finish(false));
        deleteButton.addEventListener('click', () => finish(true));
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            finish(false);
        });
        dialog.addEventListener('close', () => {
            if (ignoredCloseEvents > 0) {
                ignoredCloseEvents--;
                return;
            }
            finish(false);
        });
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            dialog.addEventListener(type, event => event.stopPropagation());
        }

        elements = {name, description, cancelButton};
    }

    function restoreOpener(opener) {
        if (!opener?.isConnected || typeof opener.focus !== 'function') return;
        const otherDialogOpen = Array.from(doc.querySelectorAll?.('dialog[open]') || [])
            .some(openDialog => openDialog !== dialog);
        if (!otherDialogOpen) opener.focus({preventScroll: true});
    }

    function finish(confirmed) {
        const choice = activeChoice;
        if (!choice) return;
        activeChoice = null;
        if (dialog.open) {
            ignoredCloseEvents++;
            dialog.close();
        }
        choice.resolve(Boolean(confirmed));
        restoreOpener(choice.opener);
    }

    function confirm(layer) {
        if (activeChoice) return Promise.resolve(false);
        const sourceClipCount = countSourceClips(layer);
        if (sourceClipCount === 0) return Promise.resolve(true);
        if (!doc?.body) return Promise.resolve(false);

        ensureDialog();
        elements.name.textContent = layer?.name == null ? '' : String(layer.name);
        elements.description.textContent = `원본 클립 ${sourceClipCount}개가 포함되어 있습니다. 삭제하면 마스크와 클립 설정도 함께 사라집니다. 계속 작업하려면 다시 클립하거나 실행 취소로 복원해야 합니다.`;

        return new Promise(resolve => {
            activeChoice = {opener: doc.activeElement, resolve};
            dialog.showModal();
            elements.cancelButton.focus();
        });
    }

    return {countSourceClips, confirm};
});
