(function (root) {
    const doc = root.document;
    const titleText = '프로젝트를 삭제할까요?';
    let modal = null;
    let active = null;
    let revision = 0;

    function make(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function arrayCount(value) {
        return Array.isArray(value) ? value.length : 0;
    }

    function isCurrent(session) {
        if (active !== session || session.revision !== revision || !modal?.dialog.open) return false;
        try { return session.isCurrent(); }
        catch (_) { return false; }
    }

    function finish(restoreFocus = true) {
        const session = active;
        active = null;
        revision++;
        if (modal?.dialog.open) modal.dialog.close();
        if (restoreFocus && session?.opener?.isConnected) session.opener.focus({preventScroll: true});
    }

    function clearReferenceWarning() {
        if (!modal) return;
        modal.referenceWarning.hidden = true;
        modal.referenceList.replaceChildren();
        modal.referenceCount.textContent = '';
        modal.referenceCheckbox.checked = false;
        modal.referenceRequired = false;
        updateConfirmState();
    }

    function updateConfirmState() {
        if (!modal || !active) return;
        modal.confirm.disabled = modal.busy
            || (modal.referenceRequired && !modal.referenceCheckbox.checked);
        modal.confirm.classList.toggle('daki-project-removal-confirm-delete', selectedAction() === 'delete');
    }

    function selectedAction() {
        return modal.deleteRadio.checked ? 'delete' : 'archive';
    }

    function setBusy(busy) {
        if (!modal) return;
        modal.busy = busy;
        modal.archiveRadio.disabled = busy;
        modal.deleteRadio.disabled = busy;
        modal.cancel.disabled = busy;
        modal.close.disabled = busy;
        modal.confirmLabel.textContent = selectedAction() === 'archive' ? '보관하고 삭제' : '그림까지 삭제';
        modal.status.textContent = busy ? '그림과 프로젝트를 정리하는 중…' : modal.status.textContent;
        updateConfirmState();
    }

    function referenceLabel(reference) {
        if (!reference || typeof reference !== 'object') return '';
        const projectName = typeof reference.project_name === 'string' ? reference.project_name : '';
        const side = reference.side === 'front' ? '앞면' : reference.side === 'back' ? '뒷면'
            : typeof reference.side === 'string' ? reference.side : '';
        const path = typeof reference.path === 'string' ? reference.path : '';
        const label = [projectName, side, path].filter(Boolean).join(' · ');
        return label.length > 180 ? `${label.slice(0, 177)}…` : label;
    }

    function showReferenceWarning(data) {
        const references = Array.isArray(data.references) ? data.references : [];
        modal.referenceWarning.hidden = false;
        modal.referenceRequired = true;
        modal.referenceCheckbox.checked = false;
        modal.referenceList.replaceChildren();
        references.slice(0, 10).forEach(reference => {
            const label = referenceLabel(reference);
            if (label) modal.referenceList.appendChild(make('li', '', label));
        });
        const remaining = Math.max(0, references.length - 10);
        modal.referenceCount.textContent = remaining ? `외 ${remaining}개 연결` : '';
        modal.referenceCheckboxLabel.textContent = '다른 항목의 연결이 끊길 수 있음을 확인했습니다.';
        updateConfirmState();
    }

    function ensureDialog() {
        if (modal) return modal;

        const dialog = make('dialog', 'daki-dialog daki-project-removal-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiProjectRemovalTitle');
        dialog.setAttribute('aria-describedby', 'dakiProjectRemovalDescription');

        const header = make('header', 'daki-project-removal-header');
        const title = make('h2', 'daki-project-removal-title', titleText);
        title.id = 'dakiProjectRemovalTitle';
        const close = make('button', 'daki-project-removal-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '닫기');
        header.append(title, close);

        const body = make('div', 'daki-project-removal-body');
        const name = make('p', 'daki-project-removal-name');
        const stats = make('div', 'daki-project-removal-stats');
        const imageCount = make('span', 'daki-project-removal-stat');
        const canvasCount = make('span', 'daki-project-removal-stat');
        stats.append(imageCount, canvasCount);
        const linkedDraftNote = make('p', 'daki-project-removal-note', '연결된 시안 폴더의 미채택 그림도 포함됩니다.');

        const fieldset = make('fieldset', 'daki-project-removal-options');
        const legend = make('legend', '', '그림 처리 방법');
        const archiveLabel = make('label', 'daki-project-removal-option');
        const archiveRadio = make('input');
        archiveRadio.type = 'radio';
        archiveRadio.name = 'dakiProjectRemovalAction';
        archiveRadio.value = 'archive';
        archiveRadio.checked = true;
        const archiveCopy = make('span', 'daki-project-removal-option-copy');
        archiveCopy.append(
            make('strong', '', '그림 보관 후 삭제'),
            make('span', '', '그림을 갤러리의 프로젝트 보관 폴더로 옮깁니다.'),
        );
        archiveLabel.append(archiveRadio, archiveCopy);

        const deleteLabel = make('label', 'daki-project-removal-option');
        const deleteRadio = make('input');
        deleteRadio.type = 'radio';
        deleteRadio.name = 'dakiProjectRemovalAction';
        deleteRadio.value = 'delete';
        const deleteCopy = make('span', 'daki-project-removal-option-copy');
        deleteCopy.append(
            make('strong', '', '그림까지 삭제'),
            make('span', '', '원본 그림과 연결된 시안을 영구 삭제합니다.'),
        );
        deleteLabel.append(deleteRadio, deleteCopy);
        fieldset.append(legend, archiveLabel, deleteLabel);

        const settingsNote = make('p', 'daki-project-removal-settings-note', '프로젝트 설정과 편집 캔버스는 삭제됩니다. 공유·개인 그림체 라이브러리 원본은 유지됩니다.');
        settingsNote.id = 'dakiProjectRemovalDescription';
        const referenceWarning = make('section', 'daki-project-removal-reference-warning');
        referenceWarning.hidden = true;
        referenceWarning.setAttribute('aria-live', 'polite');
        referenceWarning.appendChild(make('p', 'daki-project-removal-reference-intro', '다른 항목에서 이 프로젝트의 그림을 사용하고 있습니다.'));
        const referenceList = make('ul', 'daki-project-removal-reference-list');
        const referenceCount = make('p', 'daki-project-removal-reference-count');
        const referenceCheckboxLabel = make('label', 'daki-project-removal-reference-confirm');
        const referenceCheckbox = make('input');
        referenceCheckbox.type = 'checkbox';
        referenceCheckboxLabel.append(referenceCheckbox, make('span', '', ''));
        referenceWarning.append(referenceList, referenceCount, referenceCheckboxLabel);

        const status = make('p', 'daki-project-removal-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        body.append(name, stats, linkedDraftNote, fieldset, settingsNote, referenceWarning, status);

        const footer = make('footer', 'daki-project-removal-actions');
        const cancel = make('button', 'daki-project-removal-cancel', '취소');
        cancel.type = 'button';
        const confirm = make('button', 'daki-primary daki-project-removal-confirm');
        confirm.type = 'button';
        const confirmLabel = make('span', '', '보관하고 삭제');
        confirm.appendChild(confirmLabel);
        footer.append(cancel, confirm);
        dialog.append(header, body, footer);
        doc.body.appendChild(dialog);

        const created = {
            dialog, title, close, name, imageCount, canvasCount, archiveRadio, deleteRadio,
            archiveLabel, deleteLabel, referenceWarning, referenceList, referenceCount,
            referenceCheckbox, referenceCheckboxLabel: referenceCheckboxLabel.querySelector
                ? referenceCheckboxLabel.querySelector('span') : referenceCheckboxLabel.children[1],
            status, cancel, confirm, confirmLabel, busy: false, referenceRequired: false,
        };
        // A close event can also come from native dialog APIs. Ignore queued closes after a reopen.
        dialog.addEventListener('close', () => {
            if (dialog.open || !active) return;
            finish(true);
        });
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            event.stopPropagation();
            if (!created.busy) finish(true);
        });
        dialog.addEventListener('keydown', event => event.stopPropagation());
        ['paste', 'copy', 'cut'].forEach(type => dialog.addEventListener(type, event => event.stopPropagation()));
        dialog.addEventListener('click', event => {
            if (event.target !== dialog || created.busy) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right
                || event.clientY < bounds.top || event.clientY > bounds.bottom) finish(true);
        });

        const changeAction = () => {
            created.archiveLabel.classList.toggle('is-selected', created.archiveRadio.checked);
            created.deleteLabel.classList.toggle('is-selected', created.deleteRadio.checked);
            created.confirmLabel.textContent = selectedAction() === 'archive' ? '보관하고 삭제' : '그림까지 삭제';
            created.status.textContent = '';
            if (selectedAction() === 'archive' && created.referenceRequired) clearReferenceWarning();
            else if (created.referenceRequired) created.referenceCheckbox.checked = false;
            updateConfirmState();
        };
        created.archiveRadio.addEventListener('change', changeAction);
        created.deleteRadio.addEventListener('change', changeAction);
        created.referenceCheckbox.addEventListener('change', updateConfirmState);
        created.close.onclick = () => { if (!created.busy) finish(true); };
        created.cancel.onclick = () => { if (!created.busy) finish(true); };
        created.confirm.onclick = submit;
        created.archiveLabel.classList.add('is-selected');
        modal = created;
        return created;
    }

    async function submit(event) {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const currentModal = modal;
        const session = active;
        if (!session || !currentModal || currentModal.busy || !currentModal.dialog.open) return;
        if (!isCurrent(session)) {
            finish(false);
            return;
        }
        if (currentModal.referenceRequired && !currentModal.referenceCheckbox.checked) return;

        const action = selectedAction();
        currentModal.status.textContent = '';
        setBusy(true);
        try {
            const response = await root.fetch(
                `/api/daki/projects/${encodeURIComponent(String(session.project.id))}/delete`,
                {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({action, confirm_daki: Boolean(currentModal.referenceRequired && currentModal.referenceCheckbox.checked)}),
                },
            );
            const data = await response.json();
            if (session.revision !== revision || active !== session || !currentModal.dialog.open) return;
            if (!isCurrent(session)) {
                finish(false);
                return;
            }
            if (response.status === 409 && data?.code === 'daki_references') {
                setBusy(false);
                currentModal.status.textContent = data.message || '다른 항목에서 연결된 그림이 있습니다.';
                showReferenceWarning(data);
                return;
            }
            if (!response.ok || data?.status !== 'success') {
                setBusy(false);
                currentModal.status.textContent = data?.message
                    || (data?.code === 'project_busy'
                        ? '프로젝트 작업이 진행 중입니다. 완료된 뒤 다시 시도해 주세요.'
                        : '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
                return;
            }
            if (!isCurrent(session)) {
                finish(false);
                return;
            }
            const callback = session.onDeleted;
            finish(false);
            await callback?.(data);
        } catch (error) {
            if (session.revision !== revision || active !== session || !currentModal.dialog.open) return;
            if (!isCurrent(session)) {
                finish(false);
                return;
            }
            setBusy(false);
            currentModal.status.textContent = error?.name === 'TypeError'
                ? '요청을 전송하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.'
                : (error?.message || '요청을 처리하지 못했습니다. 다시 시도해 주세요.');
        } finally {
            if (session.revision === revision && active === session && currentModal.dialog.open) setBusy(false);
        }
    }

    function open(opener, options) {
        if (typeof options.isCurrent === 'function' && !options.isCurrent()) return;
        const currentModal = ensureDialog();
        if (active) finish(false);
        const session = {
            project: options.project,
            isCurrent: typeof options.isCurrent === 'function' ? options.isCurrent : () => true,
            onDeleted: typeof options.onDeleted === 'function' ? options.onDeleted : null,
            opener,
            revision: ++revision,
        };
        active = session;
        currentModal.title.textContent = titleText;
        currentModal.name.textContent = typeof session.project.name === 'string' ? session.project.name : '';
        const candidates = session.project.candidates || {};
        const canvases = session.project.canvases || {};
        currentModal.imageCount.textContent = `등록 그림 ${arrayCount(candidates.front) + arrayCount(candidates.back)}`;
        currentModal.canvasCount.textContent = `편집 캔버스 ${arrayCount(canvases.front) + arrayCount(canvases.back)}`;
        currentModal.archiveRadio.checked = true;
        currentModal.deleteRadio.checked = false;
        currentModal.archiveRadio.disabled = false;
        currentModal.deleteRadio.disabled = false;
        currentModal.archiveLabel.classList.add('is-selected');
        currentModal.deleteLabel.classList.remove('is-selected');
        currentModal.status.textContent = '';
        clearReferenceWarning();
        setBusy(false);
        if (!currentModal.dialog.open) currentModal.dialog.showModal();
        currentModal.cancel.focus({preventScroll: true});
    }

    function createButton({project, isCurrent, onDeleted} = {}) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'daki-project-remove-button';
        button.textContent = '프로젝트 삭제';
        button.setAttribute('aria-label', '프로젝트 삭제');
        button.onclick = event => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            if (!project || project.id === undefined || typeof isCurrent === 'function' && !isCurrent()) return;
            open(button, {project, isCurrent, onDeleted});
        };
        return button;
    }

    const api = {
        createButton,
        close(restoreFocus = true) { finish(restoreFocus); },
    };
    root.DakiProjectRemoval = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
