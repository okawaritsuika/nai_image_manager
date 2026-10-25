/* Reusable project-folder cards and confirmed folder deletion. */
(function (root) {
    'use strict';

    const doc = root.document;
    let modal = null;
    let pending = null;
    let ignoredCloseEvents = 0;

    function node(tag, className, text) {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    }

    function safeIsCurrent(action) {
        if (!action?.opener?.isConnected) return false;
        if (typeof action.isCurrent !== 'function') return true;
        try { return action.isCurrent() !== false; }
        catch (_) { return false; }
    }

    function ensureModal() {
        if (modal) return modal;
        const dialog = node('dialog', 'daki-dialog daki-draft-folder-delete-dialog');
        dialog.id = 'dakiDraftFolderDeleteDialog';
        dialog.setAttribute('aria-labelledby', 'dakiDraftFolderDeleteTitle');
        dialog.setAttribute('aria-describedby', 'dakiDraftFolderDeleteDescription');

        const header = node('header', 'daki-draft-folder-delete-header');
        const title = node('h2', 'daki-draft-folder-delete-title', '시안 폴더를 삭제할까요?');
        title.id = 'dakiDraftFolderDeleteTitle';
        const close = node('button', 'daki-draft-folder-delete-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '닫기');
        header.append(title, close);

        const body = node('div', 'daki-draft-folder-delete-body');
        const selection = node('div', 'daki-draft-folder-delete-selection');
        const name = node('strong', 'daki-draft-folder-delete-name');
        const count = node('span', 'daki-draft-folder-delete-count');
        selection.append(name, count);
        const description = node('p', 'daki-draft-folder-delete-description');
        description.id = 'dakiDraftFolderDeleteDescription';
        body.append(selection, description);

        const footer = node('footer', 'daki-draft-folder-delete-footer');
        const cancel = node('button', 'daki-draft-folder-delete-cancel', '취소');
        cancel.type = 'button';
        const confirm = node('button', 'daki-primary daki-draft-folder-delete-confirm', '폴더 삭제');
        confirm.type = 'button';
        footer.append(cancel, confirm);
        dialog.append(header, body, footer);
        doc.body.appendChild(dialog);

        function settle(accepted, {restoreFocus = true, closeDialog = true} = {}) {
            const active = pending;
            if (!active) return false;
            pending = null;
            const result = !!accepted && safeIsCurrent(active);
            if (closeDialog && dialog.open) {
                ignoredCloseEvents++;
                dialog.close();
            }
            if (restoreFocus && active.opener.isConnected) active.opener.focus({preventScroll: true});
            active.resolve(result);
            return true;
        }

        close.onclick = () => settle(false);
        cancel.onclick = () => settle(false);
        confirm.onclick = event => {
            if (event.defaultPrevented) return;
            if (!dialog.open || !pending || !safeIsCurrent(pending)) {
                event.preventDefault();
                settle(false);
                return;
            }
            settle(true);
        };
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            settle(false);
        });
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') event.stopPropagation();
        });
        dialog.addEventListener('click', event => {
            if (event.target !== dialog) return;
            const rect = dialog.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom) settle(false);
        });
        dialog.addEventListener('close', () => {
            if (dialog.open) {
                if (ignoredCloseEvents) ignoredCloseEvents--;
                return;
            }
            if (ignoredCloseEvents) {
                ignoredCloseEvents--;
                return;
            }
            settle(false, {closeDialog: false});
        });

        modal = {dialog, title, name, count, description, cancel, confirm, settle};
        return modal;
    }

    function showDeleteConfirmation(folder, opener, options, warningMessage = '') {
        const instance = ensureModal();
        if (pending) instance.settle(false, {restoreFocus: false});
        return new Promise(resolve => {
            const item = folder || {};
            const name = typeof item.name === 'string' ? item.name : String(item.name ?? '');
            const count = item.count !== undefined && item.count !== null && item.count !== ''
                && Number.isFinite(Number(item.count)) ? `시안 ${Number(item.count)}장` : '';
            pending = {opener, isCurrent: options?.isCurrent, resolve};
            instance.title.textContent = warningMessage ? '사용 중인 시안도 삭제할까요?' : '시안 폴더를 삭제할까요?';
            instance.name.textContent = name;
            instance.count.textContent = count;
            instance.count.hidden = !count;
            instance.description.textContent = warningMessage || '폴더 안의 모든 시안(선택한 결과 포함)과 저장된 생성 설정을 영구 삭제합니다. 되돌릴 수 없습니다.';
            instance.description.classList.toggle('daki-draft-folder-delete-warning', !!warningMessage);
            instance.confirm.textContent = warningMessage ? '그래도 삭제' : '폴더 삭제';
            if (!instance.dialog.open) instance.dialog.showModal();
            instance.cancel.focus({preventScroll: true});
        });
    }

    function close(restoreFocus = true) {
        if (modal?.settle && pending) modal.settle(false, {restoreFocus});
        else if (modal?.dialog.open) {
            ignoredCloseEvents++;
            modal.dialog.close();
        }
    }

    function createDeleteButton(folder, options = {}) {
        if (!folder || folder.legacy || folder.id === 'legacy' || folder.id === undefined || folder.id === null || String(folder.id) === '') return null;
        const itemId = String(folder.id);
        const button = node('button', 'daki-draft-folder-delete-button', '폴더 삭제');
        button.replaceChildren(node('span', 'daki-card-action-label', '폴더 삭제'));
        button.dataset.compactIcon = '🗑';
        button.title = '폴더 삭제: 내부 시안과 저장된 생성 설정을 함께 삭제합니다.';
        button.setAttribute('aria-label', '폴더 삭제');
        button.type = 'button';
        button.onclick = async () => {
            if (button.busy || !safeIsCurrent({opener: button, isCurrent: options.isCurrent})) return;
            button.busy = true;
            const current = () => safeIsCurrent({opener: button, isCurrent: options.isCurrent});
            try {
                const accepted = await showDeleteConfirmation(folder, button, options);
                if (!accepted || !current()) return;
                button.disabled = true;
                const url = `/api/daki/draft-folders/${encodeURIComponent(itemId)}/delete`;
                const reply = await root.Daki.deleteRequest(url, {}, root.fetch.bind(root), async message => {
                    if (!current()) return false;
                    button.disabled = false;
                    const confirmed = await showDeleteConfirmation(folder, button, options, message);
                    const stillCurrent = current();
                    if (confirmed && stillCurrent) button.disabled = true;
                    return confirmed && stillCurrent;
                });
                if (reply.cancelled) return;
                if (!reply.response.ok || reply.result.status !== 'success') {
                    throw new Error(reply.result.message || '시안 폴더를 삭제하지 못했습니다.');
                }
                if (current()) await options.onDeleted?.(reply.result);
            } catch (error) {
                if (current()) options.onError?.(error.message || '시안 폴더를 삭제하지 못했습니다.');
            } finally {
                button.busy = false;
                if (button.isConnected) button.disabled = false;
            }
        };
        return button;
    }

    function createCard(folder, options = {}) {
        if (!folder || !root.Daki?.folderCard) return null;
        const count = folder.count;
        const selected = Number(folder.selected_count || 0);
        const subtitle = count === undefined ? '' : `시안 · ${Number(count) || 0}장 · ${selected}장 선택됨`;
        const link = root.Daki.folderCard(folder.name, options.href || '#daki', count, subtitle, folder.src);
        link.classList.remove('card');
        link.classList.add('daki-project-card', 'daki-draft-folder-link');
        const wrapper = node('div', 'card daki-project-card daki-draft-folder-card');
        wrapper.appendChild(link);
        const remove = createDeleteButton(folder, options);
        if (remove) {
            const footer = node('div', 'daki-draft-folder-actions');
            footer.appendChild(remove);
            wrapper.appendChild(footer);
        }
        return wrapper;
    }

    const api = {createCard, createDeleteButton, close};
    root.DakiDraftFolderActions = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
