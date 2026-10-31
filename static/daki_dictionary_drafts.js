(function (root) {
    'use strict';

    function mount(host) {
        if (!host || !root.document?.body) return {show() {}, dispose() {}};

        const dialog = root.document.createElement('dialog');
        dialog.className = 'daki-dictionary-draft-dialog';
        dialog.setAttribute('aria-labelledby', 'dakiDictionaryDraftTitle');
        const heading = root.document.createElement('header');
        heading.className = 'daki-dictionary-draft-heading';
        const title = root.document.createElement('h2');
        title.id = 'dakiDictionaryDraftTitle';
        title.textContent = '이 그림으로 새 시안 준비';
        heading.appendChild(title);
        const body = root.document.createElement('div');
        body.className = 'daki-dictionary-draft-body';
        const footer = root.document.createElement('footer');
        footer.className = 'daki-dictionary-draft-footer';
        const cancel = root.document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'daki-dictionary-draft-button daki-dictionary-draft-secondary';
        cancel.textContent = '취소';
        cancel.dataset.dakiDictionaryDraftAction = 'cancel';
        footer.appendChild(cancel);
        dialog.append(heading, body, footer);
        root.document.body.appendChild(dialog);

        let disposed = false;
        let submitting = false;
        let snapshot = null;
        let projectController = null;
        const listeners = [];

        function listen(target, type, handler) {
            target.addEventListener(type, handler);
            listeners.push(() => target.removeEventListener(type, handler));
        }

        function element(tag, className, text) {
            const node = root.document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = text;
            return node;
        }

        function setCancelDisabled(disabled) {
            cancel.disabled = disabled;
        }

        function close() {
            if (dialog.open && !submitting) dialog.close();
        }

        function description() {
            return element('p', 'daki-dictionary-draft-description',
                `${snapshot.tag} 자세와 선택한 그림을 새 시안에 연결합니다.`);
        }

        function showLoading() {
            body.replaceChildren(description(), element('p', 'daki-dictionary-draft-status', '프로젝트 목록을 불러오는 중…'));
        }

        function showProjectError(message) {
            body.replaceChildren(description());
            body.appendChild(element('p', 'daki-dictionary-draft-error', message));
            const retry = element('button', 'daki-dictionary-draft-button daki-dictionary-draft-primary', '다시 불러오기');
            retry.type = 'button';
            retry.dataset.dakiDictionaryDraftAction = 'retry-projects';
            retry.onclick = loadProjects;
            body.appendChild(retry);
        }

        function showEmptyProjects() {
            body.replaceChildren(description());
            body.appendChild(element('p', 'daki-dictionary-draft-status', '시안을 만들 프로젝트가 없습니다.'));
            const link = element('a', 'daki-dictionary-draft-link', '프로젝트 만들기');
            link.href = root.document.body.classList?.contains('daki-dictionary-standalone') ? '/#daki' : '#daki';
            link.onclick = () => {
                dialog.close();
                if (root.document.body.classList?.contains('daki-dictionary-standalone')) root.location.href = '/#daki';
                else root.location.hash = '#daki';
            };
            body.appendChild(link);
        }

        function showProjects(projects) {
            body.replaceChildren(description());
            const label = element('label', 'daki-dictionary-draft-label', '프로젝트 선택');
            const select = root.document.createElement('select');
            select.className = 'daki-dictionary-draft-select';
            select.dataset.dakiDictionaryDraftProject = 'true';
            select.setAttribute('aria-label', '프로젝트 선택');
            for (const project of projects) {
                if (!project || (typeof project.id !== 'string' && typeof project.id !== 'number') || !String(project.id)) continue;
                const option = root.document.createElement('option');
                option.value = String(project.id);
                option.textContent = typeof project.name === 'string' && project.name ? project.name : String(project.id);
                select.appendChild(option);
            }
            if (!select.children.length) {
                showEmptyProjects();
                return;
            }
            select.value = select.children[0].value;
            label.appendChild(select);
            const error = element('p', 'daki-dictionary-draft-error', '');
            error.hidden = true;
            error.setAttribute('role', 'alert');
            const create = element('button', 'daki-dictionary-draft-button daki-dictionary-draft-primary', '새 시안 폴더로 이동');
            create.type = 'button';
            create.dataset.dakiDictionaryDraftAction = 'create-folder';
            create.onclick = () => createFolder(select.value, create, select, error);
            body.append(label, error, create);
        }

        async function loadProjects() {
            if (disposed || submitting || projectController) return;
            const controller = new AbortController();
            projectController = controller;
            showLoading();
            try {
                const response = await root.fetch('/api/daki/projects', {
                    headers: {'Accept': 'application/json'},
                    signal: controller.signal,
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.status !== 'success' || !Array.isArray(data.projects)) {
                    throw new Error(data.error || data.message || '프로젝트 목록을 불러오지 못했습니다.');
                }
                if (disposed || !dialog.open || projectController !== controller) return;
                const projects = data.projects.filter(project => project &&
                    (typeof project.id === 'string' || typeof project.id === 'number') && String(project.id));
                if (!projects.length) showEmptyProjects();
                else showProjects(projects);
            } catch (error) {
                if (error.name === 'AbortError' || disposed || !dialog.open || projectController !== controller) return;
                showProjectError(error.message || '프로젝트 목록을 불러오지 못했습니다.');
            } finally {
                if (projectController === controller) projectController = null;
            }
        }

        async function createFolder(projectId, button, select, errorNode) {
            if (disposed || submitting || !snapshot || !projectId) return;
            submitting = true;
            button.disabled = true;
            select.disabled = true;
            setCancelDisabled(true);
            errorNode.hidden = true;
            const settings = {
                char_prompts: [{prompt: snapshot.tag, negative_prompt: '', x: 0.5, y: 0.5}],
                dictionary_reference: {image_id: snapshot.imageId, tag: snapshot.tag},
            };
            try {
                const response = await root.fetch('/api/daki/draft-folders', {
                    method: 'POST',
                    headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
                    body: JSON.stringify({project_id: projectId, name: '', settings}),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || data.status !== 'success' || !data.folder ||
                    data.folder.id === undefined || data.folder.id === null) {
                    throw new Error(data.error || data.message || '새 시안 폴더를 만들지 못했습니다.');
                }
                if (data.folder.project_id !== undefined && String(data.folder.project_id) !== projectId) {
                    throw new Error('선택한 프로젝트와 새 폴더의 프로젝트가 일치하지 않습니다.');
                }
                if (disposed || !dialog.open || !submitting) return;
                dialog.close();
                const hash = `#daki&library=drafts&project=${encodeURIComponent(projectId)}&folder=${encodeURIComponent(data.folder.id)}&edit=1`;
                if (root.document.body.classList?.contains('daki-dictionary-standalone')) root.location.href = `/${hash}`;
                else root.location.hash = hash;
            } catch (error) {
                if (disposed || !dialog.open) return;
                errorNode.textContent = error.message || '새 시안 폴더를 만들지 못했습니다.';
                errorNode.hidden = false;
                button.disabled = false;
                select.disabled = false;
                setCancelDisabled(false);
            } finally {
                submitting = false;
            }
        }

        listen(cancel, 'click', close);
        listen(dialog, 'cancel', event => {
            if (submitting) event.preventDefault();
        });
        listen(dialog, 'close', () => {
            if (dialog.open) return;
            projectController?.abort();
            projectController = null;
            snapshot = null;
            submitting = false;
        });

        return {
            show({imageId, tag} = {}) {
                const numericImageId = Number(imageId);
                if (disposed || dialog.open || submitting || !Number.isSafeInteger(numericImageId) || numericImageId <= 0 ||
                    typeof tag !== 'string' || !tag.trim()) return;
                snapshot = {imageId: numericImageId, tag};
                setCancelDisabled(false);
                dialog.showModal();
                loadProjects();
            },
            dispose() {
                if (disposed) return;
                disposed = true;
                projectController?.abort();
                projectController = null;
                if (dialog.open) dialog.close();
                for (const disposeListener of listeners) disposeListener();
                dialog.remove();
                snapshot = null;
            },
        };
    }

    root.DakiDictionaryDrafts = {mount};
})(window);
