/* Rename project canvases and image files from project cards. */
(function (root, factory) {
    'use strict';
    const api = factory(root);
    if (root) root.DakiProjectNames = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const doc = root.document;
    const invalidFilenameCharacters = /[<>:"/\\|?*\u0000-\u001f]/;
    let dialog = null;
    let active = null;
    let revision = 0;

    function extension(name) {
        const basename = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
        const dot = basename.lastIndexOf('.');
        return dot > 0 ? basename.slice(dot) : '';
    }

    function hasIsolatedSurrogate(value) {
        for (let index = 0; index < value.length; index++) {
            const codeUnit = value.charCodeAt(index);
            if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
                index += 1;
            } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
        }
        return false;
    }

    function validateName(name, kind, currentName) {
        const maxLength = kind === 'image' ? 255 : 120;
        if (typeof name !== 'string' || !name.trim()) return '이름을 입력해 주세요.';
        if (name.length > maxLength) return `${kind === 'image' ? '그림 파일명' : '캔버스 이름'}은 ${maxLength}자 이하여야 합니다.`;
        if (hasIsolatedSurrogate(name)) return '짝이 맞지 않는 유니코드 문자는 사용할 수 없습니다.';
        if (invalidFilenameCharacters.test(name)) return '파일 이름에 사용할 수 없는 문자가 있습니다.';
        if (/[. ]$/.test(name)) return '이름은 점이나 공백으로 끝날 수 없습니다.';
        if (name === '.' || name === '..') return '이 이름은 사용할 수 없습니다.';
        const deviceName = name.split('.')[0].replace(/[ .]+$/, '').toUpperCase();
        if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9]|LPT[1-9]|COM[¹²³]|LPT[¹²³])$/.test(deviceName)) {
            return 'Windows에서 사용할 수 없는 이름입니다.';
        }
        if (kind === 'image' && extension(name).toLowerCase() !== extension(currentName).toLowerCase()) {
            const currentExtension = extension(currentName);
            return currentExtension
                ? `파일 확장자 ${currentExtension}을 그대로 유지해 주세요.`
                : '파일 확장자를 추가하거나 변경할 수 없습니다.';
        }
        return '';
    }

    function element(tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function ensureDialog() {
        if (dialog) return dialog;
        dialog = element('dialog', 'daki-project-name-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiProjectNameTitle');
        const header = element('header', 'daki-project-name-header');
        const title = element('h2', 'daki-project-name-title');
        title.id = 'dakiProjectNameTitle';
        const close = element('button', 'daki-project-name-close', '×');
        close.type = 'button';
        close.setAttribute('aria-label', '닫기');
        close.title = '닫기';
        header.append(title, close);

        const body = element('div', 'daki-project-name-body');
        const label = element('label', 'daki-project-name-label', '이름');
        label.htmlFor = 'dakiProjectNameInput';
        const input = element('input', 'daki-project-name-input');
        input.id = 'dakiProjectNameInput';
        input.type = 'text';
        input.autocomplete = 'off';
        const note = element('p', 'daki-project-name-note');
        const status = element('p', 'daki-project-name-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        body.append(label, input, note, status);

        const footer = element('footer', 'daki-project-name-footer');
        const cancel = element('button', 'secondary', '취소');
        cancel.type = 'button';
        const save = element('button', 'daki-project-name-save', '저장');
        save.type = 'button';
        footer.append(cancel, save);
        dialog.append(header, body, footer);
        doc.body.appendChild(dialog);

        const finish = force => {
            if (!active || (active.pending && !force)) return false;
            const previous = active;
            active = null;
            revision += 1;
            if (dialog.open) dialog.close();
            if (previous.opener?.isConnected && previous.isCurrent()) previous.opener.focus();
            return true;
        };
        close.onclick = () => finish(false);
        cancel.onclick = () => finish(false);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            finish(false);
        });
        input.addEventListener('input', () => {
            if (!active) return;
            status.textContent = '';
            status.classList.remove('is-error');
            input.removeAttribute('aria-invalid');
        });
        save.onclick = async () => {
            const session = active;
            if (!session || session.pending) return;
            const validationError = validateName(input.value, session.kind, session.name);
            if (validationError) {
                status.textContent = validationError;
                status.classList.add('is-error');
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            session.pending = true;
            save.disabled = close.disabled = cancel.disabled = true;
            status.classList.remove('is-error');
            status.textContent = '저장하는 중…';
            const endpointKind = session.kind === 'image' ? 'candidates' : 'canvases';
            const url = `/api/daki/projects/${encodeURIComponent(session.projectId)}/${endpointKind}/${encodeURIComponent(session.itemId)}`;
            try {
                const response = await root.fetch(url, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({name: input.value, expectedName: session.name}),
                });
                const result = await response.json();
                if (!response.ok || result.status !== 'success') {
                    throw new Error(result.message || '이름을 저장하지 못했습니다. 다시 시도해 주세요.');
                }
                if (active !== session || session.revision !== revision || !session.isCurrent()) return;
                if (!result.project) throw new Error('저장된 프로젝트 정보를 받지 못했습니다.');
                session.pending = false;
                save.disabled = close.disabled = cancel.disabled = false;
                finish(false);
                await session.onSaved?.(result.project, result);
            } catch (error) {
                if (active !== session || session.revision !== revision || !session.isCurrent()) return;
                session.pending = false;
                save.disabled = close.disabled = cancel.disabled = false;
                status.textContent = error.message || '이름을 저장하지 못했습니다. 다시 시도해 주세요.';
                status.classList.add('is-error');
            }
        };
        return dialog;
    }

    function createButton(options) {
        if (!doc || !options || !['canvas', 'image'].includes(options.kind)) return null;
        const button = element('button', 'daki-project-name-rename');
        button.type = 'button';
        button.dataset.compactIcon = '✎';
        button.title = `${options.kind === 'image' ? '그림' : '캔버스'} 이름 바꾸기`;
        button.setAttribute('aria-label', button.title);
        button.appendChild(element('span', 'daki-card-action-label', '이름 변경'));
        button.onclick = () => {
            if (typeof options.isCurrent === 'function' && !options.isCurrent()) return;
            const modal = ensureDialog();
            if (active) close(true);
            const input = doc.getElementById('dakiProjectNameInput');
            const title = doc.getElementById('dakiProjectNameTitle');
            const note = modal.querySelector('.daki-project-name-note');
            const status = modal.querySelector('.daki-project-name-status');
            const currentExtension = extension(options.name);
            active = {
                ...options,
                name: String(options.name || ''),
                opener: button,
                isCurrent: typeof options.isCurrent === 'function' ? options.isCurrent : () => true,
                pending: false,
                revision: ++revision,
            };
            input.value = active.name;
            input.removeAttribute('aria-invalid');
            title.textContent = `${options.kind === 'image' ? '그림' : '캔버스'} 이름 바꾸기`;
            note.textContent = options.kind === 'image'
                ? `실제 그림 파일 이름을 바꾸며, 같은 파일을 참조하는 항목도 계속 연결됩니다. 확장자 ${currentExtension || '(없음)'}은 그대로 유지해 주세요.`
                : '프로젝트 카드에 표시되는 캔버스 이름을 바꿉니다.';
            status.textContent = '';
            status.classList.remove('is-error');
            modal.showModal();
            input.focus();
            input.select?.();
        };
        return button;
    }

    function close(force = false) {
        if (!active) return false;
        if (active.pending && !force) return false;
        const previous = active;
        active = null;
        revision += 1;
        if (dialog?.open) dialog.close();
        if (!force && previous.opener?.isConnected && previous.isCurrent()) previous.opener.focus();
        return true;
    }

    return {createButton, close, extension, validateName};
});
