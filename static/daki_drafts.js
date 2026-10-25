/* Draft folders keep generated results together; project assignment and deletion remain explicit. */
(function (root) {
    'use strict';
    const doc = root.document, endpoint = '/api/daki/drafts', foldersEndpoint = '/api/daki/draft-folders';
    let revision = 0, timer, editor, filters, settingsTransfer, onDraftsChanged, createDialog;
    const byId = id => doc.getElementById(id);
    const node = (tag, className, text) => {
        const item = doc.createElement(tag); if (className) item.className = className;
        if (text !== undefined) item.textContent = text; return item;
    };
    function button(label, action, className = 'nav-btn') {
        const item = node('button', className, label); item.type = 'button'; item.onclick = action; return item;
    }
    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {method, headers: {'Content-Type': 'application/json'}, cache: 'no-store',
            ...(body === undefined ? {} : {body: JSON.stringify(body)})});
        const data = await response.json();
        if (!response.ok || data.status !== 'success') {
            const error = new Error(data.message || '시안을 불러오지 못했습니다.'); error.httpStatus = response.status; error.data = data; throw error;
        }
        return data;
    }
    function current(token) { return token === revision && root.Daki.isActive(); }
    function folderUrl(id) { return foldersEndpoint + '/' + encodeURIComponent(id); }
    function href(projectId, folderId, edit = false) {
        return '#daki&library=drafts' + (projectId ? '&project=' + encodeURIComponent(projectId) : '') +
            (folderId ? '&folder=' + encodeURIComponent(folderId) : '') + (edit ? '&edit=1' : '');
    }
    function closeCreateDialog() {
        if (!createDialog) return; const dialog = createDialog; createDialog = null;
        if (dialog.open) dialog.close(); dialog.remove?.();
    }
    function leave() {
        revision++; root.clearTimeout(timer); timer = null;
        if (onDraftsChanged) root.removeEventListener('daki-drafts-changed', onDraftsChanged);
        onDraftsChanged = null; editor?.dispose(); editor = null; filters?.dispose(); filters = null;
        root.DakiDraftFolderActions?.close(false);
        closeCreateDialog(); doc.body?.classList?.remove('daki-draft-editing');
        root.DakiTagBrowser?.close(); root.DakiDraftFraming?.close();
    }
    function setHeading(title, subtitle, backHref, backLabel) {
        byId('dakiTitle').textContent = title; byId('dakiSubtitle').textContent = subtitle;
        const back = byId('dakiBack'); back.hidden = false; back.href = backHref; back.textContent = backLabel;
    }
    function render(params, container) {
        leave(); const token = revision;
        const targetFolderId = params.get('folder');
        if (settingsTransfer && (settingsTransfer.folderId !== targetFolderId || params.get('edit') !== '1')) settingsTransfer = null;
        byId('dakiTitle').textContent = '프로젝트 시안';
        byId('dakiSubtitle').textContent = '시안은 프로젝트 폴더 안에서 만들고 이어서 편집합니다.';
        byId('dakiBack').hidden = false; byId('dakiBack').href = '#daki'; byId('dakiBack').textContent = '← daki 프로젝트';
        const pageStatus = byId('dakiPageStatus'); pageStatus.textContent = '';
        const projectId = params.get('project') || '';
        const open = async () => {
            const folderId = params.get('folder');
            if (!projectId && !folderId) {
                setHeading('프로젝트를 선택하세요', '시안 폴더는 프로젝트 안에서만 만들 수 있습니다.', '#daki', '← daki 프로젝트');
                container.appendChild(node('p', 'daki-draft-project-required', '프로젝트를 연 뒤 ‘시안 만들기’를 선택해 주세요.'));
                const back = node('a', 'nav-btn', '프로젝트 목록'); back.href = '#daki'; container.appendChild(back);
                return;
            }
            let project = null;
            if (projectId) {
                pageStatus.textContent = '프로젝트를 불러오는 중…';
                try {
                    const data = await api('/api/daki/projects/' + encodeURIComponent(projectId));
                    if (!current(token)) return;
                    if (data.project.id !== projectId) throw new Error('선택한 프로젝트를 확인할 수 없습니다.');
                    project = data.project; pageStatus.textContent = '';
                } catch (error) { if (current(token)) pageStatus.textContent = error.message; return; }
            }
            if (folderId) await renderFolder(params, container, token, folderId, projectId, project);
            else await renderFolders(container, token, project, params.get('new') === '1');
        };
        return open();
    }
    async function renderFolders(container, token, project, autoCreate) {
        const projectId = project.id;
        setHeading(project.name + ' · 시안 폴더', '폴더를 열면 이전 시안과 설정을 이어서 쓸 수 있습니다.',
            '#project=' + encodeURIComponent(project.id), '← ' + project.name);
        const toolbar = node('div', 'daki-draft-folder-toolbar');
        const create = button('새 시안 만들기', () => openCreateDialog(token, projectId), 'nav-btn daki-primary'); toolbar.appendChild(create);
        const status = node('p', 'daki-draft-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const grid = root.Daki.createGrid('daki-draft-folder-grid', [], false);
        const empty = node('p', 'daki-empty', '시안 폴더가 없습니다. 새 폴더를 만들어 첫 시안을 생성해 보세요.');
        container.append(toolbar, status, grid, empty);
        let requestRevision = 0;
        async function refresh() {
            const request = ++requestRevision; status.textContent = '시안 폴더를 불러오는 중…'; create.disabled = true;
            try {
                const url = foldersEndpoint + '?project=' + encodeURIComponent(projectId);
                const data = await api(url); if (!current(token) || request !== requestRevision) return;
                const cards = (data.folders || []).filter(folder => folder.project_id === projectId && !folder.legacy && folder.id !== 'legacy').map(folder => {
                    const cardHref = href(projectId, folder.id);
                    const actions = {
                        href: cardHref,
                        isCurrent: () => current(token),
                        onDeleted: async result => {
                            if (!current(token)) return;
                            await refresh();
                            if (current(token) && result.warning) status.textContent = result.warning;
                        },
                        onError: message => { if (current(token)) status.textContent = message; },
                    };
                    if (root.DakiDraftFolderActions?.createCard) return root.DakiDraftFolderActions.createCard(folder, actions);
                    const count = Number(folder.count || 0), selected = Number(folder.selected_count || 0);
                    return root.Daki.folderCard(folder.name, cardHref, count,
                        `시안 · ${count}장 · ${selected}장 선택됨`, folder.src);
                });
                grid.setItems(cards); empty.hidden = cards.length > 0; status.textContent = '';
            } catch (error) { if (current(token) && request === requestRevision) status.textContent = error.message; }
            finally { if (current(token) && request === requestRevision) create.disabled = false; }
        }
        onDraftsChanged = () => { if (current(token)) refresh(); }; root.addEventListener('daki-drafts-changed', onDraftsChanged);
        await refresh();
        if (autoCreate && current(token)) openCreateDialog(token, projectId);
    }
    function openCreateDialog(token, projectId) {
        if (createDialog || !projectId || !current(token)) return;
        const dialog = createDialog = node('dialog', 'daki-dialog daki-draft-create-dialog');
        dialog.setAttribute('aria-labelledby', 'dakiDraftCreateTitle');
        const header = node('header', 'daki-draft-dialog-header'), heading = node('h2', '', '새 시안 폴더');
        heading.id = 'dakiDraftCreateTitle'; header.append(heading, button('닫기', () => dialog.close()));
        const form = node('form', 'daki-draft-create-form'), label = node('label', 'daki-draft-name-label');
        label.appendChild(node('span', '', '폴더 이름 (선택)'));
        const input = node('input'); input.type = 'text'; input.name = 'name'; input.required = false; input.maxLength = 120;
        input.placeholder = '비워 두면 시안1, 시안2…';
        input.setAttribute('aria-label', '폴더 이름'); label.appendChild(input);
        const status = node('p', 'daki-draft-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const actions = node('div', 'daki-dialog-actions'), cancel = button('취소', () => dialog.close());
        const submit = node('button', 'daki-primary', '폴더 만들기'); submit.type = 'submit'; actions.append(cancel, submit);
        form.append(label, status, actions); dialog.append(header, form);
        dialog.addEventListener('close', () => { dialog.remove(); if (createDialog === dialog) createDialog = null; });
        form.onsubmit = async event => {
            event.preventDefault(); if (!current(token) || submit.disabled) return;
            const name = input.value.trim();
            if (name.length > 120) { status.textContent = '폴더 이름은 120자 이내로 입력해 주세요.'; return; }
            submit.disabled = true; cancel.disabled = true; status.textContent = '폴더를 만들고 있습니다…';
            try {
                const data = await api(foldersEndpoint, 'POST', {name, ...(projectId ? {project_id: projectId} : {}), settings: {}});
                if (!current(token)) return;
                if (!data.folder?.id) throw new Error('새 폴더 정보를 확인할 수 없습니다.');
                dialog.close(); root.location.hash = href(projectId, data.folder.id, true);
            } catch (error) {
                if (current(token)) { status.textContent = error.message; submit.disabled = false; cancel.disabled = false; }
            }
        };
        doc.body.appendChild(dialog); dialog.showModal(); input.focus();
    }
    async function renderFolder(params, container, token, folderId, requestedProjectId, project) {
        const status = byId('dakiPageStatus'); status.textContent = '시안 폴더를 불러오는 중…';
        try {
            const data = await api(folderUrl(folderId)); if (!current(token)) return;
            const folder = data.folder; if (!folder?.id) throw new Error('시안 폴더 정보를 확인할 수 없습니다.');
            if (folder.id === 'legacy' && requestedProjectId && !folder.project_id)
                throw new Error('기존 시안 폴더는 프로젝트에 연결되어 있지 않습니다.');
            if (folder.id !== 'legacy' && !folder.project_id)
                throw new Error('이 시안 폴더의 프로젝트를 확인할 수 없습니다.');
            if (requestedProjectId && folder.project_id && folder.project_id !== requestedProjectId)
                throw new Error('이 시안 폴더는 선택한 프로젝트에 속하지 않습니다.');
            const projectId = folder.project_id || '';
            if (!projectId && folder.id !== 'legacy') throw new Error('이 시안 폴더의 프로젝트를 확인할 수 없습니다.');
            if (projectId && !project) {
                status.textContent = '프로젝트를 확인하는 중…';
                const projectData = await api('/api/daki/projects/' + encodeURIComponent(projectId));
                if (!current(token)) return;
                if (projectData.project.id !== projectId) throw new Error('시안 폴더의 프로젝트를 확인할 수 없습니다.');
                project = projectData.project;
            }
            const projectName = project?.name || '';
            status.textContent = '';
            if (params.get('edit') === '1') await renderGenerator(container, token, folder, data.drafts || [], projectId, projectName);
            else renderGallery(container, token, folder, data.drafts || [], projectId, projectName);
        } catch (error) { if (current(token)) status.textContent = error.message; }
    }
    const completed = record => record.status === 'completed' && !!record.src;
    const isRunning = records => records.some(record => ['pending', 'running'].includes(record.status));
    function label(record) {
        const date = new Date(record.created_at), time = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR');
        return [record.settings?.style?.name || '직접 입력', time].filter(Boolean).join(' · ');
    }
    const formatSize = record => `${record.width || '—'} × ${record.height || '—'}${record.seed == null ? '' : ' · Seed ' + record.seed}`;
    const formatDimensions = record => `${record.width || '—'} × ${record.height || '—'}`;
    function shortTime(value) {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ko-KR', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
    }
    function fullImageSrc(record) { return endpoint + '/' + encodeURIComponent(record.id) + '/image?full=1'; }
    function renderGallery(container, token, initialFolder, initialRecords, projectId, projectName) {
        let folder = initialFolder, records = initialRecords, requestRevision = 0, busy = false, loaded = true;
        setHeading(folder.name, `${projectName ? projectName + ' · ' : ''}${records.length}장 · ${records.filter(record => record.selected).length}장 선택됨`,
            projectId ? '#project=' + encodeURIComponent(projectId) : '#daki', projectName ? '← ' + projectName : '← daki 프로젝트');
        const toolbar = node('div', 'daki-draft-folder-toolbar daki-draft-gallery-toolbar');
        const status = node('p', 'daki-draft-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        const edit = node('a', 'nav-btn daki-primary', '시안 수정'); edit.href = href(projectId, folder.id, true);
        const summary = node('p', 'daki-draft-selection-summary'); summary.setAttribute('role', 'status');
        const filterLabel = node('label', 'daki-draft-filter-selected'), onlySelected = node('input');
        onlySelected.type = 'checkbox'; onlySelected.setAttribute('aria-label', '선택한 시안만 보기');
        filterLabel.append(onlySelected, node('span', '', '선택한 결과만 보기'));
        const deleteSelected = button('선택 외 삭제', deleteUnselected); deleteSelected.classList?.add('daki-draft-danger');
        toolbar.append(edit, summary, filterLabel, deleteSelected);
        const deleteFolder = root.DakiDraftFolderActions?.createDeleteButton?.(folder, {
            isCurrent: () => current(token),
            onDeleted: result => {
                if (!current(token)) return;
                if (result.warning) root.showToast?.(result.warning);
                root.location.hash = projectId ? '#project=' + encodeURIComponent(projectId) : '#daki';
            },
            onError: message => { if (current(token)) status.textContent = message; },
        });
        if (deleteFolder) toolbar.appendChild(deleteFolder);
        const heading = node('div', 'daki-draft-history-heading'); heading.appendChild(node('h2', '', '폴더의 시안'));
        const grid = root.Daki.createGrid('daki-draft-grid'), empty = node('p', 'daki-empty', '아직 생성한 시안이 없습니다.');
        container.append(toolbar, status, heading, root.Daki.createImageTools());
        filters = root.DakiGalleryFilters?.create({galleryKey: 'draft-folder-' + folder.id, title: '폴더의 시안', onChange: refreshGallery});
        if (filters) container.appendChild(filters.element);
        if (root.DakiWorldCup) heading.appendChild(button('태그 그림 이상형 월드컵', () => root.DakiWorldCup.open(
            visible().filter(completed).map(record => ({path: record.path, src: record.src, name: label(record)})), '폴더의 시안', 'drafts')));
        container.append(grid, empty); onlySelected.onchange = refreshGallery;
        function visible() {
            const subset = onlySelected.checked ? records.filter(record => record.selected) : records;
            return filters ? filters.apply(subset, record => completed(record) ? record.path : '') : subset;
        }
        function controls() {
            const selected = records.filter(record => record.selected).length, unselected = records.filter(record => !record.selected).length;
            summary.textContent = `${records.length}장 · ${selected}장 선택됨 · 선택하지 않은 그림도 삭제 전까지 보관됩니다.`;
            deleteSelected.disabled = busy || isRunning(records) || selected === 0 || unselected === 0 || !loaded;
            edit.setAttribute('aria-disabled', String(busy));
        }
        function refreshGallery() {
            if (!current(token)) return;
            const items = visible().map(makeGalleryCard).filter(Boolean); grid.setItems(items); empty.hidden = items.length > 0;
            empty.textContent = records.length ? '필터에 맞는 시안이 없습니다.' : '아직 생성한 시안이 없습니다.';
            filters?.setResultCount?.(items.length, records.length); controls();
        }
        function makeGalleryCard(record) {
            const card = node('article', 'item-box daki-draft-card');
            if (completed(record)) {
                const fitAction = node('div', 'daki-draft-fit-action'), fit = button('5:16 맞추기 (선택)', () => openFraming(record));
                fit.title = '미리보기에서 확인한 뒤 별도 사본으로 저장합니다.'; fitAction.appendChild(fit);
                const image = node('img', 'zoomable'); image.src = record.src; image.alt = label(record); image.loading = 'lazy';
                card.appendChild(image); root.Daki.bindImage(card, image, record.path);
                card.appendChild(fitAction);
            } else card.appendChild(node('div', 'daki-test-placeholder', record.status === 'failed' ? '생성 실패' : '생성 중…'));
            const info = node('div', 'gallery-card-actions daki-image-actions');
            const title = node('strong', '', label(record)); title.title = label(record);
            info.append(title, node('span', '', formatSize(record)));
            if (record.framing) info.appendChild(node('span', '', record.framing.mode === 'pad' ? '투명 여백을 붙인 사본' : '확대·잘라 맞춘 사본'));
            if (record.error) info.appendChild(node('p', 'daki-warning', record.error));
            if (completed(record)) {
                const keep = node('label', 'daki-draft-selection'), checkbox = node('input');
                checkbox.type = 'checkbox'; checkbox.checked = !!record.selected; checkbox.disabled = busy;
                checkbox.setAttribute('aria-label', '결과로 선택'); checkbox.onchange = () => setSelection(record.id, checkbox.checked);
                keep.append(checkbox, node('span', '', '결과로 선택')); info.appendChild(keep);
            }
            const actions = node('div', 'daki-draft-card-actions');
            if (completed(record)) {
                const restore = node('a', 'nav-btn', '설정 불러오기'); restore.href = edit.href;
                restore.onclick = () => { settingsTransfer = {folderId: folder.id, settings: record.settings, recordId: record.id}; };
                actions.appendChild(restore);
                actions.appendChild(button('프로젝트에 추가', () => root.Daki.openAdd({path: record.path, imgSrc: '/image/' + record.path,
                    ...(projectId ? {projectId} : {})})));
            } else if (record.status === 'failed') {
                const retry = node('a', 'nav-btn', '생성창에서 다시 시도'); retry.href = edit.href;
                retry.onclick = () => { settingsTransfer = {folderId: folder.id, settings: record.settings, recordId: record.id}; };
                actions.appendChild(retry);
            }
            const remove = button('삭제', () => deleteOne(record)); remove.classList?.add('daki-draft-danger');
            remove.disabled = busy || ['pending', 'running'].includes(record.status); actions.appendChild(remove);
            info.appendChild(actions); card.appendChild(info); return card;
        }
        function openFraming(record) {
            root.DakiDraftFraming?.open({record, onSaved(draft) {
                if (!current(token)) return;
                requestRevision++; records = [draft, ...records.filter(item => item.id !== draft.id)]; refreshGallery();
                status.textContent = '크기·비율을 맞춘 사본을 저장했습니다.'; schedule();
            }});
        }
        async function refresh() {
            const request = ++requestRevision;
            try {
                const data = await api(folderUrl(folder.id));
                if (!current(token) || request !== requestRevision) return;
                folder = data.folder; records = data.drafts || []; loaded = true; refreshGallery();
                status.textContent = isRunning(records) ? '생성 중입니다. 완료된 그림은 폴더에 표시됩니다.' : '';
            } catch (error) { if (current(token) && request === requestRevision) status.textContent = error.message; }
            finally { if (current(token) && request === requestRevision) schedule(); }
        }
        function schedule() {
            root.clearTimeout(timer); timer = null;
            if (current(token) && isRunning(records)) timer = root.setTimeout(refresh, 1000);
        }
        function confirmDelete(ids) {
            return root.confirm(`${folder.name}에서 시안 ${ids.length}장을 삭제하시겠습니까? 삭제한 시안은 복구할 수 없습니다.`);
        }
        async function deleteItems(ids, preserveSelected) {
            if (busy || !loaded || !ids.length || !current(token) || !confirmDelete(ids)) return;
            busy = true; requestRevision++; root.clearTimeout(timer); status.textContent = '선택한 시안을 삭제하는 중…'; refreshGallery();
            const payload = {ids: [...ids], preserve_selected: !!preserveSelected};
            try {
                const reply = await root.Daki.deleteRequest(folderUrl(folder.id) + '/delete-drafts', payload);
                if (!current(token)) return;
                if (reply.cancelled) { status.textContent = '삭제를 취소했습니다.'; return; }
                if (!reply.response.ok || reply.result.status !== 'success') throw new Error(reply.result.message || '시안을 삭제하지 못했습니다.');
                requestRevision++;
                folder = reply.result.folder || folder;
                records = reply.result.drafts || records.filter(record => !reply.result.deleted_ids?.includes(record.id)); loaded = true;
                refreshGallery();
                const failed = reply.result.failed_ids?.length || 0, skipped = reply.result.skipped_ids?.length || 0;
                const message = failed || skipped ? `삭제 ${reply.result.deleted_ids?.length || 0}장 · 실패 ${failed}장 · 보호되어 건너뜀 ${skipped}장`
                    : `시안 ${reply.result.deleted_ids?.length || 0}장을 삭제했습니다.`;
                if (failed || skipped) await refresh();
                if (current(token)) status.textContent = message;
            } catch (error) { if (current(token)) { status.textContent = error.message; refreshGallery(); } }
            finally { busy = false; if (current(token)) { controls(); refreshGallery(); schedule(); } }
        }
        function deleteOne(record) { if (!['pending', 'running'].includes(record.status)) return deleteItems([record.id], false); }
        function deleteUnselected() {
            const ids = records.filter(record => !record.selected && !['pending', 'running'].includes(record.status)).map(record => record.id);
            return deleteItems(ids, true);
        }
        async function setSelection(id, selected) {
            if (busy || !loaded || !current(token)) { refreshGallery(); return; }
            const record = records.find(item => item.id === id); if (!record || !completed(record) || !!record.selected === !!selected) return;
            busy = true; requestRevision++; root.clearTimeout(timer); status.textContent = '선택 상태를 저장하는 중…'; refreshGallery();
            try {
                const data = await api(endpoint + '/' + encodeURIComponent(id) + '/selection', 'PUT', {selected: !!selected});
                if (!current(token)) return;
                requestRevision++;
                records = records.map(item => item.id === id ? data.draft : item); refreshGallery(); status.textContent = '';
            } catch (error) { if (current(token)) { status.textContent = error.message; refreshGallery(); } }
            finally { busy = false; if (current(token)) { controls(); refreshGallery(); schedule(); } }
        }
        deleteSelected.onclick = deleteUnselected;
        onDraftsChanged = () => { if (current(token)) refresh(); }; root.addEventListener('daki-drafts-changed', onDraftsChanged);
        refreshGallery(); schedule();
    }
    async function renderGenerator(container, token, initialFolder, initialRecords, projectId, projectName) {
        let folder = initialFolder, records = initialRecords, loaded = true, busy = false, localEditor;
        const transfer = settingsTransfer?.folderId === folder.id ? settingsTransfer : null; settingsTransfer = null;
        let requestRevision = 0, activeId = transfer?.recordId || null, manualPreview = false;
        const settings = transfer?.settings || folder.settings || records.find(record => record.settings)?.settings || {};
        doc.body?.classList?.add('daki-draft-editing');
        setHeading(folder.name + ' · 시안 수정', `${projectName ? projectName + ' · ' : ''}같은 폴더에 시안을 더 생성하고, 결과를 직접 골라 보관합니다.`,
            href(projectId, folder.id), '← 시안 폴더');
        const workspace = node('div', 'daki-draft-workspace'), settingsPane = node('section', 'daki-draft-settings');
        settingsPane.appendChild(node('h2', '', '프롬프트와 설정'));
        const form = node('form', 'daki-draft-form'); form.noValidate = true;
        const fields = node('fieldset', 'daki-draft-fields'); fields.disabled = true;
        const editorStatus = node('p', 'daki-draft-editor-loading', '생성 설정을 불러오는 중…'); fields.appendChild(editorStatus);
        const actions = node('div', 'daki-draft-actions');
        const create = node('button', 'nav-btn daki-primary', '시안 한 장 생성'); create.type = 'submit'; create.disabled = true;
        const save = button('설정 저장', saveSettings); save.disabled = folder.id === 'legacy' || !!folder.legacy;
        save.title = save.disabled ? '기존 시안 폴더는 폴더 설정을 저장할 수 없습니다.' : '';
        const reload = button('폴더 다시 불러오기', refresh); reload.hidden = true; actions.append(create, save, reload);
        const status = node('p', 'daki-draft-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
        form.append(fields, actions, status); settingsPane.appendChild(form);
        const resultPane = node('section', 'daki-draft-result'), resultHeading = node('div', 'daki-draft-result-heading');
        resultHeading.append(node('h2', '', '결과 미리보기'), node('span', 'daki-draft-result-position', '')); resultPane.appendChild(resultHeading);
        const stage = node('div', 'daki-draft-result-stage'); stage.setAttribute('aria-live', 'polite');
        const resultCaption = node('div', 'daki-draft-result-caption'), resultActions = node('div', 'daki-draft-result-actions');
        resultPane.append(stage, resultCaption, resultActions);
        const history = node('aside', 'daki-draft-history'), historyHeading = node('div', 'daki-draft-history-heading');
        historyHeading.append(node('h2', '', '생성 기록'), node('span', 'daki-draft-history-count', '0장'));
        const historyList = node('div', 'daki-draft-history-list'), historyFooter = node('div', 'daki-draft-history-footer');
        const bulk = button('선택 외 삭제', deleteUnselected); bulk.classList?.add('daki-draft-danger');
        historyFooter.append(node('p', 'daki-draft-retention-note', '선택하지 않은 그림도 삭제 전까지 보관됩니다.'), bulk);
        history.append(historyHeading, historyList, historyFooter); workspace.append(settingsPane, resultPane, history); container.appendChild(workspace);
        const running = () => isRunning(records);
        function activeRecord() { return records.find(record => record.id === activeId) || null; }
        function controls() {
            const disabled = busy || running() || !loaded; fields.disabled = disabled || !localEditor;
            create.disabled = disabled || !localEditor; create.textContent = running() ? '시안 생성 중…' : busy ? '요청하는 중…' : '시안 한 장 생성';
            save.disabled = disabled || folder.id === 'legacy' || !!folder.legacy; reload.hidden = loaded;
            const selected = records.filter(record => record.selected).length;
            const unselected = records.filter(record => !record.selected && !['pending', 'running'].includes(record.status)).length;
            bulk.disabled = busy || running() || selected === 0 || unselected === 0 || !loaded;
            historyHeading.children[1].textContent = `${records.length}장 · ${selected}장 선택됨`;
        }
        function renderStage() {
            const record = activeRecord(); stage.replaceChildren(); resultCaption.replaceChildren(); resultActions.replaceChildren();
            resultHeading.children[1].textContent = record ? `${records.findIndex(item => item.id === record.id) + 1} / ${records.length}` : '';
            if (!record) { stage.appendChild(node('p', 'daki-draft-empty-stage', '첫 시안을 생성하면 큰 미리보기가 여기에 표시됩니다.')); return; }
            if (completed(record)) {
                const image = node('img', 'daki-draft-preview-image'); image.src = fullImageSrc(record); image.alt = label(record); image.loading = 'eager';
                stage.appendChild(image); root.Daki.bindImage(stage, image, record.path);
            } else stage.appendChild(node('div', 'daki-draft-stage-placeholder', record.status === 'failed' ? '생성 실패' : '시안 생성 중…'));
            resultCaption.append(node('strong', '', label(record)), node('span', '', formatSize(record)));
            if (record.framing) resultCaption.appendChild(node('span', '', record.framing.mode === 'pad' ? '투명 여백을 붙인 사본' : '확대·잘라 맞춘 사본'));
            if (record.error) resultCaption.appendChild(node('p', 'daki-warning', record.error));
            if (!completed(record)) {
                if (record.status === 'failed') {
                    const retry = button('다시 생성', () => command(endpoint + '/' + encodeURIComponent(record.id) + '/retry', {}, record.settings));
                    retry.disabled = busy || running(); resultActions.appendChild(retry);
                }
                return;
            }
            const keepLabel = node('label', 'daki-draft-selection daki-draft-preview-selection'), keep = node('input');
            keep.type = 'checkbox'; keep.checked = !!record.selected; keep.disabled = busy; keep.setAttribute('aria-label', '결과로 선택');
            keep.onchange = () => setSelection(record.id, keep.checked); keepLabel.append(keep, node('span', '', '결과로 선택')); resultActions.appendChild(keepLabel);
            const restore = button('설정 불러오기', () => restoreSettings(record)); restore.disabled = busy || running();
            resultActions.appendChild(restore);
            if (projectId) resultActions.appendChild(button('프로젝트에 추가', () => root.Daki.openAdd({path: record.path, imgSrc: '/image/' + record.path, projectId})));
            const fit = button('5:16 맞추기 (선택)', () => openFraming(record)); fit.title = '미리보기에서 확인한 뒤 별도 사본으로 저장합니다.'; resultActions.appendChild(fit);
            resultActions.appendChild(button('삭제', () => deleteOne(record), 'nav-btn daki-draft-danger'));
        }
        function restoreSettings(record) {
            if (busy || running() || !localEditor) return;
            localEditor.setSettings(record.settings);
            status.textContent = '시안의 설정을 불러왔습니다. 수정한 뒤 같은 폴더에 새 시안을 생성할 수 있습니다.';
        }
        function renderHistory() {
            const scrollTop = historyList.scrollTop;
            historyList.replaceChildren();
            records.forEach((record, index) => {
                const card = node('article', 'daki-draft-history-card' + (record.id === activeId ? ' is-active' : ''));
                const preview = button('', () => { activeId = record.id; manualPreview = true; renderRecords(); });
                preview.className = 'daki-draft-history-preview'; preview.setAttribute('aria-pressed', String(record.id === activeId));
                preview.setAttribute('aria-label', `${label(record)} 미리보기`);
                if (completed(record)) { const image = node('img'); image.src = record.src; image.alt = ''; image.loading = 'lazy'; preview.appendChild(image); }
                else preview.appendChild(node('span', 'daki-draft-history-placeholder', record.status === 'failed' ? '실패' : '생성 중'));
                const details = node('div', 'daki-draft-history-details');
                const heading = node('strong', '', record.settings?.style?.name || `시안 ${records.length - index}`);
                heading.title = label(record);
                const secondary = [formatDimensions(record), shortTime(record.created_at)].filter(Boolean).join(' · ');
                details.append(heading, node('span', '', secondary));
                if (record.error) details.appendChild(node('span', 'daki-warning', record.error));
                const top = node('div', 'daki-draft-history-row'); top.append(preview, details); card.appendChild(top);
                const actions = node('div', 'daki-draft-history-actions');
                if (completed(record)) {
                    const keepLabel = node('label', 'daki-draft-selection'), keep = node('input'); keep.type = 'checkbox'; keep.checked = !!record.selected;
                    keep.disabled = busy; keep.setAttribute('aria-label', '결과로 선택'); keep.onchange = () => setSelection(record.id, keep.checked);
                    keepLabel.append(keep, node('span', '', '선택')); actions.appendChild(keepLabel);
                } else if (record.status === 'failed') {
                    const retry = button('다시 생성', () => command(endpoint + '/' + encodeURIComponent(record.id) + '/retry', {}, record.settings));
                    retry.disabled = busy || running(); actions.appendChild(retry);
                }
                const remove = button('삭제', () => deleteOne(record), 'nav-btn daki-draft-danger');
                remove.disabled = busy || ['pending', 'running'].includes(record.status); actions.appendChild(remove);
                card.appendChild(actions); historyList.appendChild(card);
            });
            historyList.scrollTop = scrollTop;
        }
        function renderRecords() { controls(); renderStage(); renderHistory(); }
        function updateRecords(values, activateId) {
            if (!current(token)) return;
            const previous = new Map(records.map(record => [record.id, record])), wasRunning = running(); records = values || [];
            if (activateId) { activeId = activateId; manualPreview = false; }
            else if (!records.some(record => record.id === activeId)) { activeId = records.find(completed)?.id || records[0]?.id || null; manualPreview = false; }
            else if (!manualPreview && records.some(record => completed(record) && previous.get(record.id)?.status !== 'completed'))
                activeId = records.find(completed)?.id || activeId;
            else if (!manualPreview && records[0] && !previous.has(records[0].id)) activeId = records[0].id;
            if (wasRunning && !running()) root.NovelAIAccount?.refresh(true); renderRecords();
        }
        async function refresh() {
            const request = ++requestRevision;
            try {
                const data = await api(folderUrl(folder.id)); if (!current(token) || request !== requestRevision) return;
                folder = data.folder; loaded = true; updateRecords(data.drafts || []);
                status.textContent = running() ? '생성 중입니다. 완료되면 새 결과가 기록에 추가됩니다.' : '';
            } catch (error) {
                if (!current(token) || request !== requestRevision) return;
                loaded = false; status.textContent = error.message; reload.hidden = false;
            } finally { if (current(token) && request === requestRevision) { controls(); schedule(); } }
        }
        function schedule() {
            root.clearTimeout(timer); timer = null; if (current(token) && running()) timer = root.setTimeout(refresh, 1000);
        }
        async function command(url, values, retrySettings) {
            if (busy || running() || !loaded || !current(token)) return;
            const body = {...JSON.parse(JSON.stringify(values)), allow_anlas: false}; if (url === endpoint) body.folder_id = folder.id;
            const recipe = retrySettings || body, steps = recipe.model === 'nai-diffusion-5-full-medium' ? 14 : recipe.options?.steps ?? 28;
            let sent = false; busy = true; requestRevision++; root.clearTimeout(timer); controls(); renderRecords(); status.textContent = '생성을 요청하는 중…';
            try {
                if (root.requiresAnlasCost(recipe.width, recipe.height, steps)) {
                    status.textContent = 'Anlas 사용을 확인해 주세요.';
                    const approved = await root.showAnlasWarningModal({width: recipe.width, height: recipe.height, steps,
                        title: '시안 생성 Anlas 사용 경고', detail: retrySettings
                            ? '실패한 시안에 저장된 설정으로 다시 생성합니다. Anlas가 소모될 수 있습니다.'
                            : '현재 설정으로 시안 한 장을 생성합니다. Anlas가 소모될 수 있습니다.'});
                    if (!current(token)) return;
                    if (!approved) { status.textContent = '생성을 취소했습니다.'; return; }
                    body.allow_anlas = true;
                }
                status.textContent = '생성을 요청하는 중…'; sent = true;
                const data = await api(url, 'POST', body); if (!current(token)) return;
                requestRevision++;
                updateRecords([data.draft, ...records.filter(record => record.id !== data.draft.id)], data.draft.id);
                status.textContent = data.draft.status === 'completed' ? '생성한 시안을 저장했습니다.' : '생성 중입니다. 완료되면 기록에 표시됩니다.';
            } catch (error) {
                if (current(token)) {
                    if (sent && !error.httpStatus) { loaded = false; requestRevision++; }
                    status.textContent = !sent || error.httpStatus ? error.message : '요청 결과를 확인하지 못했습니다. 폴더를 다시 불러와 생성 여부를 확인해 주세요.';
                    reload.hidden = !sent;
                }
            } finally { busy = false; if (current(token)) { controls(); renderRecords(); schedule(); } }
        }
        async function saveSettings() {
            if (busy || running() || !loaded || !localEditor || folder.id === 'legacy' || folder.legacy || !current(token)) return;
            const values = localEditor.read(); if (!values) return;
            busy = true; requestRevision++; controls(); renderRecords(); status.textContent = '폴더 설정을 저장하는 중…';
            try {
                const data = await api(folderUrl(folder.id), 'PUT', {name: folder.name, settings: values});
                if (!current(token)) return;
                requestRevision++;
                folder = data.folder || {...folder, settings: values}; status.textContent = '폴더 설정을 저장했습니다.';
            } catch (error) { if (current(token)) status.textContent = error.message; }
            finally { busy = false; if (current(token)) { controls(); renderRecords(); schedule(); } }
        }
        async function setSelection(id, selected) {
            if (busy || !loaded || !current(token)) { renderRecords(); return; }
            const record = records.find(item => item.id === id); if (!record || !completed(record) || !!record.selected === !!selected) return;
            busy = true; requestRevision++; root.clearTimeout(timer); controls(); renderRecords(); status.textContent = '선택 상태를 저장하는 중…';
            try {
                const data = await api(endpoint + '/' + encodeURIComponent(id) + '/selection', 'PUT', {selected: !!selected});
                if (!current(token)) return;
                requestRevision++;
                updateRecords(records.map(item => item.id === id ? data.draft : item)); status.textContent = '';
            } catch (error) { if (current(token)) { status.textContent = error.message; renderRecords(); } }
            finally { busy = false; if (current(token)) { controls(); renderRecords(); schedule(); } }
        }
        function openFraming(record) {
            root.DakiDraftFraming?.open({record, onSaved(draft) {
                if (!current(token)) return;
                requestRevision++; updateRecords([draft, ...records.filter(item => item.id !== draft.id)], draft.id);
                status.textContent = '크기·비율을 맞춘 사본을 저장했습니다.'; schedule();
            }});
        }
        async function deleteItems(ids, preserveSelected) {
            if (busy || !loaded || !ids.length || !current(token)) return;
            if (!root.confirm(`${folder.name}에서 시안 ${ids.length}장을 삭제하시겠습니까? 삭제한 시안은 복구할 수 없습니다.`)) return;
            busy = true; requestRevision++; root.clearTimeout(timer); controls(); renderRecords(); status.textContent = '선택한 시안을 삭제하는 중…';
            const payload = {ids: [...ids], preserve_selected: !!preserveSelected};
            try {
                const reply = await root.Daki.deleteRequest(folderUrl(folder.id) + '/delete-drafts', payload);
                if (!current(token)) return;
                if (reply.cancelled) { status.textContent = '삭제를 취소했습니다.'; return; }
                if (!reply.response.ok || reply.result.status !== 'success') throw new Error(reply.result.message || '시안을 삭제하지 못했습니다.');
                requestRevision++;
                folder = reply.result.folder || folder;
                updateRecords(reply.result.drafts || records.filter(record => !reply.result.deleted_ids?.includes(record.id)));
                const failed = reply.result.failed_ids?.length || 0, skipped = reply.result.skipped_ids?.length || 0;
                const message = failed || skipped ? `삭제 ${reply.result.deleted_ids?.length || 0}장 · 실패 ${failed}장 · 보호되어 건너뜀 ${skipped}장`
                    : `시안 ${reply.result.deleted_ids?.length || 0}장을 삭제했습니다.`;
                if (failed || skipped) await refresh();
                if (current(token)) status.textContent = message;
            } catch (error) { if (current(token)) { status.textContent = error.message; renderRecords(); } }
            finally { busy = false; if (current(token)) { controls(); renderRecords(); schedule(); } }
        }
        function deleteOne(record) { if (!['pending', 'running'].includes(record.status)) return deleteItems([record.id], false); }
        function deleteUnselected() {
            const ids = records.filter(record => !record.selected && !['pending', 'running'].includes(record.status)).map(record => record.id);
            return deleteItems(ids, true);
        }
        form.onsubmit = event => {
            event.preventDefault(); if (busy || running() || !localEditor || !loaded) return;
            const values = localEditor.read(); if (!values) return; return command(endpoint, values);
        };
        bulk.onclick = deleteUnselected;
        onDraftsChanged = () => { if (current(token)) refresh(); }; root.addEventListener('daki-drafts-changed', onDraftsChanged);
        updateRecords(records);
        try {
            const result = await root.DakiDraftEditor.create({settings});
            if (!current(token)) { result.dispose(); return; }
            editor = localEditor = result; fields.replaceChildren(result.element); controls();
        } catch (error) { if (current(token)) editorStatus.textContent = '생성 설정을 불러오지 못했습니다: ' + error.message; }
        schedule();
    }
    root.DakiDrafts = {render, leave};
})(typeof window === 'undefined' ? globalThis : window);
