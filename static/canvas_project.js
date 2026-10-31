/* Editable project canvases. Image candidates and named canvas backups stay separate. */
(function (root) {
    'use strict';
    const doc = root.document;
    const byId = id => doc.getElementById(id);
    const sides = {front: '앞면', back: '뒷면'};
    let autosave;
    let restoredLink = null;
    let dialog;
    let dialogRevision = 0;
    let exportDialog;
    let exportChoiceResolver;
    let exportChoiceLink;
    let exportChoiceOpener;
    let openWarningDialog;
    let openWarningChoice;
    let openWarningIgnoreCloseEvents = 0;
    let pendingOpenWarningFocus;
    let initializePromise;
    let importDialog;
    let importChoiceResolver;
    let importChoiceLink;
    let importChoiceOpener;
    let importChoiceBusy = false;
    let busy = false;
    let opener;
    let createAttempt = null;
    let conflictCopyAttempt = null;
    let conflicted = false;
    let dialogProjects = [];
    let canvasNameEdited = false;

    function suggestCanvasName(project, side) {
        const now = new Date();
        const pad = value => String(value).padStart(2, '0');
        const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
        const suffix = `_${sides[side] || sides.front}_${timestamp}`;
        const projectName = String(project?.name || '프로젝트').trim();
        return projectName.slice(0, Math.max(0, 120 - suffix.length)) + suffix;
    }

    function updateSuggestedCanvasName() {
        if (canvasNameEdited) return;
        const project = byId('canvasProjectNew').checked ? {name: byId('canvasProjectName').value}
            : dialogProjects.find(item => item.id === byId('canvasProjectSelect').value);
        const side = dialog.querySelector('[name=canvasProjectSide]:checked')?.value || 'front';
        byId('canvasProjectCanvasName').value = suggestCanvasName(project, side);
    }

    async function suggestDownloadName() {
        const link = localLink();
        if (!link) return null;
        const result = await api(endpoint(link));
        const current = localLink();
        if (!current || current.projectId !== link.projectId || current.canvasId !== link.canvasId) {
            throw new Error('캔버스 연결이 변경되었습니다. 다시 내보내 주세요.');
        }
        const base = suggestCanvasName(result.project, result.canvas.side)
            .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_').replace(/[. ]+$/, '');
        return base + '.png';
    }

    async function api(url, method = 'GET', body) {
        const response = await root.fetch(url, {
            method, headers: {'Content-Type': 'application/json'},
            ...(body === undefined ? {} : {body: JSON.stringify(body)})
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') {
            const error = new Error(result.message || '프로젝트 캔버스를 저장하지 못했습니다.');
            error.status = response.status;
            throw error;
        }
        return result;
    }

    function endpoint(link) {
        return '/api/daki/projects/' + encodeURIComponent(link.projectId)
            + '/canvases/' + encodeURIComponent(link.canvasId);
    }

    function validLink(value) {
        return value && typeof value === 'object' && typeof value.projectId === 'string'
            && typeof value.canvasId === 'string' && /^[a-f0-9]{32}$/.test(value.projectId)
            && /^[a-f0-9]{32}$/.test(value.canvasId) && Number.isSafeInteger(value.revision)
            && value.revision > 0 && Object.hasOwn(sides, value.side);
    }

    function snapshot() {
        return buildCanvasStateSnapshot({preserveMasks: true});
    }

    function saveLocalLink() {
        getCanvasAutosave().schedule(true);
    }

    function syncLocation(link) {
        const params = new URLSearchParams(root.location.search);
        if (link) {
            params.set('project', link.projectId);
            params.set('canvas', link.canvasId);
        } else {
            params.delete('project');
            params.delete('canvas');
        }
        const query = params.toString();
        root.history.replaceState(null, '', root.location.pathname
            + (query ? '?' + query : '') + root.location.hash);
    }

    function report(state, error) {
        root.CanvasDakiFocus?.linkChanged();
        conflicted = state === 'conflict';
        const panel = byId('canvasProjectStatus');
        const label = byId('canvasProjectMessage');
        const link = autosave?.current();
        root.CanvasOppositeReference?.linkChanged();
        root.CanvasProjectSettings?.linkChanged();
        root.CanvasDetailPresets?.linkChanged();
        root.CanvasInpaintReference?.render();
        if (!panel || !label) return;
        panel.hidden = !link;
        panel.dataset.state = state;
        byId('canvasProjectBar').dataset.state = link ? state : 'idle';
        byId('canvasProjectDisconnect').hidden = !link;
        if (!link) panel.open = false;
        const title = byId('canvasProjectLocation');
        if (link) {
            title.textContent = link.projectName;
            title.title = link.projectName;
            title.href = '/#project=' + encodeURIComponent(link.projectId);
            byId('canvasProjectSide').textContent = sides[link.side];
            byId('canvasProjectCanvasLabel').textContent = link.name;
            byId('canvasProjectDetailSide').textContent = sides[link.side];
            byId('canvasProjectSummaryProject').textContent = link.projectName;
            byId('canvasProjectSummaryProject').title = link.projectName;
            byId('canvasProjectSummaryLabel').textContent = link.name;
            byId('canvasProjectSummaryLabel').title = link.name;
        }
        const messages = {
            idle: '', pending: '프로젝트 자동 저장 대기 중…', saving: '프로젝트에 저장하는 중…',
            saved: '프로젝트에 자동 저장됨',
            error: '프로젝트 저장 실패. 현재 작업은 유지됩니다. 다시 시도해 주세요.',
            conflict: '다른 탭에서 저장한 내용과 충돌했습니다. 내 작업을 새 캔버스로 보관하면 양쪽 작업을 모두 유지할 수 있습니다.'
        };
        label.textContent = messages[state] || '';
        if (state === 'error' && error?.message) label.textContent += ' ' + error.message;
        byId('canvasProjectSummaryState').textContent = {
            idle: '', pending: '저장 대기', saving: '저장 중', saved: '저장됨',
            error: '저장 실패', conflict: '충돌'
        }[state] || '';
        byId('canvasProjectSummary').title = link
            ? `${link.projectName} · ${sides[link.side]} · ${link.name}\n${label.textContent}` : '';
        byId('canvasProjectRetry').hidden = state !== 'error';
        byId('canvasProjectRecover').hidden = state !== 'conflict';
        root.CanvasWorkspaceBridge?.report();
    }

    function makeAutosave() {
        return createProjectCanvasAutosave({
            snapshot,
            send: async (link, state, revision) => (await api(endpoint(link), 'PUT', {state, revision})).canvas,
            status: report,
            onSaved: saveLocalLink
        });
    }

    function connect(project, canvas) {
        conflictCopyAttempt = null;
        autosave = makeAutosave();
        autosave.connect({projectId: project.id, canvasId: canvas.id, revision: canvas.revision,
            projectName: project.name, name: canvas.name, side: canvas.side});
        syncLocation(autosave.current());
        report('saved');
        saveLocalLink();
    }

    async function leave() {
        if (busy) return false;
        if (!autosave?.current()) return true;
        const saved = await autosave.disconnect();
        if (saved) {
            syncLocation(null);
            report('idle');
            saveLocalLink();
        }
        return saved;
    }

    async function recoverConflict() {
        const link = autosave?.current();
        if (busy || !conflicted || !link) return;
        busy = true;
        const button = byId('canvasProjectRecover');
        button.disabled = true;
        try {
            if (!conflictCopyAttempt) conflictCopyAttempt = {
                id: root.crypto.randomUUID().replaceAll('-', ''),
                name: String(link.name).slice(0, 110) + ' (충돌 복구)', side: link.side, state: snapshot()
            };
            const result = await api('/api/daki/projects/' + encodeURIComponent(link.projectId) + '/canvases',
                'POST', conflictCopyAttempt);
            connect(result.project, result.canvas);
            autosave.schedule(true);
            root.showToast('내 작업을 새 캔버스로 보관했습니다. 기존 캔버스도 그대로 유지됩니다.');
        } catch (error) {
            byId('canvasProjectMessage').textContent = '작업 사본을 저장하지 못했습니다. 현재 작업은 유지됩니다. ' + error.message;
        } finally { busy = false; button.disabled = false; }
    }

    function localLink() {
        const link = autosave?.current();
        return link ? {...link, unsaved: autosave.isUnsaved()} : null;
    }

    function validImageImportContext(context) {
        return context && typeof context.projectId === 'string'
            && /^[a-f0-9]{32}$/.test(context.projectId) && Object.hasOwn(sides, context.side);
    }

    function finishImportChoice(choice) {
        const resolve = importChoiceResolver;
        if (!resolve) return;
        importChoiceResolver = null;
        importChoiceLink = null;
        if (importDialog?.open) importDialog.close();
        const previousOpener = importChoiceOpener;
        importChoiceOpener = null;
        if (previousOpener?.isConnected) previousOpener.focus();
        resolve(choice);
    }

    function ensureImportDialog() {
        if (importDialog) return;
        importDialog = doc.createElement('dialog');
        importDialog.className = 'canvas-project-dialog canvas-project-import-dialog';
        importDialog.setAttribute('aria-labelledby', 'canvasProjectImportTitle');
        importDialog.setAttribute('aria-describedby', 'canvasProjectImportDescription');
        importDialog.innerHTML = `<div class="canvas-project-import-content">
            <h2 id="canvasProjectImportTitle">프로젝트 연결을 선택해 주세요</h2>
            <p id="canvasProjectImportDescription">기존 연결을 유지하거나, 가져온 그림의 프로젝트로 연결을 변경할 수 있습니다. 프로젝트를 변경하면 현재 작업과 가져온 그림이 새 편집 캔버스에 저장됩니다.</p>
            <div class="canvas-project-import-comparison">
                <section class="canvas-project-import-card">
                    <span class="canvas-project-import-label">현재 연결</span>
                    <strong id="canvasProjectImportCurrent"></strong>
                </section>
                <section class="canvas-project-import-card">
                    <span class="canvas-project-import-label">가져올 이미지의 프로젝트</span>
                    <strong id="canvasProjectImportTarget"></strong>
                </section>
            </div>
            <div class="canvas-project-actions canvas-project-import-actions">
                <button id="canvasProjectImportCancel" type="button" class="secondary">가져오기 취소</button>
                <button id="canvasProjectImportKeep" type="button" class="secondary">기존 연결 유지</button>
                <button id="canvasProjectImportChange" type="button">프로젝트 변경</button>
            </div>
        </div>`;
        doc.body.appendChild(importDialog);
        byId('canvasProjectImportCancel').onclick = () => finishImportChoice(false);
        byId('canvasProjectImportKeep').onclick = () => finishImportChoice(importChoiceLink?.current || false);
        byId('canvasProjectImportChange').onclick = () => finishImportChoice(importChoiceLink?.requested || false);
        importDialog.addEventListener('cancel', event => {
            event.preventDefault();
            finishImportChoice(false);
        });
        importDialog.addEventListener('close', () => {
            if (!importDialog.open) finishImportChoice(false);
        });
        // Canvas shortcuts must not consume keyboard or clipboard events in the native modal.
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            importDialog.addEventListener(type, event => event.stopPropagation());
        }
    }

    async function prepareImageImport(context) {
        if (busy || importChoiceBusy) return false;
        if (!validImageImportContext(context)) return null;
        const requested = {projectId: context.projectId, side: context.side};
        const current = autosave?.current();
        if (!current || current.projectId === requested.projectId) return requested;

        importChoiceBusy = true;
        busy = true;
        importChoiceOpener = doc.activeElement;
        try {
            const result = await api('/api/daki/projects/' + encodeURIComponent(requested.projectId));
            if (!result.project || typeof result.project.name !== 'string') {
                throw new Error('대상 프로젝트 정보를 불러오지 못했습니다.');
            }
            ensureImportDialog();
            importChoiceLink = {
                current: {projectId: current.projectId, side: current.side},
                requested
            };
            byId('canvasProjectImportCurrent').textContent = `${current.projectName} · ${sides[current.side]}`;
            byId('canvasProjectImportTarget').textContent = `${result.project.name} · ${sides[requested.side]}`;
            return await new Promise(resolve => {
                importChoiceResolver = resolve;
                importDialog.showModal();
                byId('canvasProjectImportKeep').focus();
            });
        } finally {
            importChoiceBusy = false;
            busy = false;
            if (!importChoiceResolver) importChoiceOpener = null;
        }
    }

    async function connectImportedImage(context, payload) {
        if (!context) return;
        if (!validImageImportContext(context)) throw new TypeError('Invalid project image import context');
        const current = autosave?.current();
        if (current?.projectId === context.projectId) return;
        if (current) throw new Error('기존 프로젝트 연결을 먼저 종료해 주세요.');

        const state = snapshot();
        let name = payload?.name;
        if (!name) {
            const result = await api('/api/daki/projects/' + encodeURIComponent(context.projectId));
            name = suggestCanvasName(result.project, context.side);
        }
        const canvas = {
            id: root.crypto.randomUUID().replaceAll('-', ''),
            name: String(name).slice(0, 120),
            side: context.side,
            state
        };
        const result = await api('/api/daki/projects/' + encodeURIComponent(context.projectId) + '/canvases',
            'POST', canvas);
        connect(result.project, result.canvas);
    }

    function finishExportChoice(choice) {
        const resolve = exportChoiceResolver;
        if (!resolve) return;
        exportChoiceResolver = null;
        exportChoiceLink = null;
        if (exportDialog?.open) exportDialog.close();
        const opener = exportChoiceOpener;
        exportChoiceOpener = null;
        if (opener?.isConnected) opener.focus();
        resolve(choice);
    }

    function ensureExportDialog() {
        if (exportDialog) return;
        exportDialog = doc.createElement('dialog');
        exportDialog.className = 'canvas-project-dialog';
        exportDialog.setAttribute('aria-labelledby', 'canvasExportDestinationTitle');
        exportDialog.innerHTML = `<div>
            <h2 id="canvasExportDestinationTitle">통합 내보내기</h2>
            <p id="canvasExportDestinationContext"></p>
            <p>프로젝트에 내보내면 해당 면의 그림으로 추가됩니다. 갤러리에는 표시되지 않습니다.</p>
            <div class="canvas-project-actions">
                <button id="canvasExportDestinationCancel" type="button" class="secondary">취소</button>
                <button id="canvasExportDestinationGallery" type="button">갤러리에 내보내기</button>
                <button id="canvasExportDestinationProject" type="button">프로젝트에 내보내기</button>
            </div>
        </div>`;
        doc.body.appendChild(exportDialog);
        byId('canvasExportDestinationCancel').onclick = () => finishExportChoice(null);
        byId('canvasExportDestinationGallery').onclick = () => finishExportChoice({destination: 'gallery'});
        byId('canvasExportDestinationProject').onclick = () => finishExportChoice({
            destination: 'project', projectId: exportChoiceLink.projectId, canvasId: exportChoiceLink.canvasId
        });
        exportDialog.addEventListener('cancel', event => {
            event.preventDefault();
            finishExportChoice(null);
        });
        exportDialog.addEventListener('close', () => {
            if (!exportDialog.open) finishExportChoice(null);
        });
        // Keep canvas shortcuts and clipboard handlers from consuming modal input.
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            exportDialog.addEventListener(type, event => event.stopPropagation());
        }
    }

    function chooseExportDestination(link) {
        if (!link) return Promise.resolve({destination: 'gallery'});
        ensureExportDialog();
        if (exportChoiceResolver) finishExportChoice(null);
        const capturedLink = {...link};
        exportChoiceLink = capturedLink;
        exportChoiceOpener = doc.activeElement;
        const sideLabel = sides[capturedLink.side] || capturedLink.side;
        byId('canvasExportDestinationContext').textContent = `${capturedLink.projectName} · ${sideLabel}`;
        return new Promise(resolve => {
            exportChoiceResolver = resolve;
            exportDialog.showModal();
            byId('canvasExportDestinationProject').focus();
        });
    }

    function finishOpenWarningChoice(shouldOpen) {
        const choice = openWarningChoice;
        if (!choice) return;
        openWarningChoice = null;
        pendingOpenWarningFocus = choice.opener;
        if (openWarningDialog?.open) {
            openWarningIgnoreCloseEvents += 1;
            openWarningDialog.close();
        }
        choice.resolve(Boolean(shouldOpen));
    }

    function ensureOpenWarningDialog() {
        if (openWarningDialog) return;
        openWarningDialog = doc.createElement('dialog');
        openWarningDialog.className = 'canvas-project-dialog canvas-project-open-warning';
        openWarningDialog.setAttribute('aria-labelledby', 'canvasProjectOpenWarningTitle');
        openWarningDialog.setAttribute('aria-describedby', 'canvasProjectOpenWarningDescription canvasProjectOpenWarningNotice');
        openWarningDialog.innerHTML = `<div class="canvas-project-open-warning-shell">
            <header class="canvas-project-open-warning-header">
                <span class="canvas-project-open-warning-icon" aria-hidden="true">!</span>
                <div class="canvas-project-open-warning-heading">
                    <h2 id="canvasProjectOpenWarningTitle">프로젝트 캔버스를 열까요?</h2>
                    <button id="canvasProjectOpenWarningClose" type="button" class="canvas-project-close" aria-label="닫기" title="닫기">×</button>
                </div>
            </header>
            <div class="canvas-project-open-warning-body">
                <p id="canvasProjectOpenWarningDescription">현재 화면의 캔버스가 선택한 프로젝트 캔버스로 바뀝니다.</p>
                <p id="canvasProjectOpenWarningDimensions" class="canvas-project-open-warning-dimensions" hidden></p>
                <p id="canvasProjectOpenWarningNotice" class="canvas-project-open-warning-notice">보관할 작업이 있다면 취소한 뒤 캔버스를 저장해 주세요.</p>
            </div>
            <footer class="canvas-project-open-warning-footer">
                <button id="canvasProjectOpenWarningCancel" type="button" class="secondary">현재 작업 유지</button>
                <button id="canvasProjectOpenWarningAccept" type="button">프로젝트 캔버스 열기</button>
            </footer>
        </div>`;
        doc.body.appendChild(openWarningDialog);
        byId('canvasProjectOpenWarningClose').onclick = () => finishOpenWarningChoice(false);
        byId('canvasProjectOpenWarningCancel').onclick = () => finishOpenWarningChoice(false);
        byId('canvasProjectOpenWarningAccept').onclick = () => finishOpenWarningChoice(true);
        openWarningDialog.addEventListener('cancel', event => {
            event.preventDefault();
            finishOpenWarningChoice(false);
        });
        openWarningDialog.addEventListener('close', () => {
            if (openWarningIgnoreCloseEvents) {
                openWarningIgnoreCloseEvents -= 1;
                return;
            }
            if (!openWarningDialog.open) finishOpenWarningChoice(false);
        });
        openWarningDialog.addEventListener('click', event => {
            if (event.target === openWarningDialog) finishOpenWarningChoice(false);
        });
        // Keep canvas shortcuts and clipboard handlers from consuming modal input.
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            openWarningDialog.addEventListener(type, event => event.stopPropagation());
        }
    }

    function confirmCanvasReplacement() {
        ensureOpenWarningDialog();
        const width = Number(currentCanvasWidth);
        const height = Number(currentCanvasHeight);
        const dimensions = byId('canvasProjectOpenWarningDimensions');
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            dimensions.textContent = `현재 캔버스 크기: ${width} × ${height} px`;
            dimensions.hidden = false;
        } else {
            dimensions.textContent = '';
            dimensions.hidden = true;
        }
        return new Promise(resolve => {
            openWarningChoice = {resolve, opener: doc.activeElement};
            openWarningDialog.showModal();
            byId('canvasProjectOpenWarningCancel').focus();
        });
    }

    async function initializeCanvas() {
        const params = new URLSearchParams(root.location.search);
        const targetProject = params.get('project');
        const targetCanvas = params.get('canvas');
        if (restoredLink) {
            autosave = makeAutosave();
            autosave.connect(restoredLink);
            report('saved');
            if (restoredLink.unsaved) autosave.schedule(true);
        }
        if (targetProject && targetCanvas) {
            const same = restoredLink?.projectId === targetProject && restoredLink?.canvasId === targetCanvas;
            if (same && restoredLink.unsaved) return;
            if (!same && currentCanvasWidth && currentCanvasHeight
                && !await confirmCanvasReplacement()) return;
            if (!await leave()) return;
            try {
                const result = await api(endpoint({projectId: targetProject, canvasId: targetCanvas}));
                applyCanvasStateSnapshot(result.canvas.state);
                activeCanvasSetupId = null;
                connect(result.project, result.canvas);
            } catch (error) {
                root.showToast('프로젝트 캔버스를 열지 못했습니다: ' + error.message);
            }
        } else if (restoredLink && !restoredLink.unsaved) {
            // Refresh the revision before edits; a second tab may have saved since this browser closed.
            try {
                const result = await api(endpoint(restoredLink));
                applyCanvasStateSnapshot(result.canvas.state);
                connect(result.project, result.canvas);
            } catch (error) {
                report('error', error);
            }
        }
        restoredLink = null;
    }

    function initialize() {
        if (initializePromise) return initializePromise;
        const surfaces = [byId('canvasWorkspace'), doc.querySelector('.main-header')].filter(Boolean);
        const previous = surfaces.map(node => node.inert);
        surfaces.forEach(node => { node.inert = true; });
        let task;
        task = (async () => {
            try { await initializeCanvas(); }
            finally {
                restoredLink = null;
                surfaces.forEach((node, index) => { node.inert = previous[index]; });
                const focusTarget = pendingOpenWarningFocus;
                pendingOpenWarningFocus = null;
                if (focusTarget?.isConnected) focusTarget.focus();
                if (initializePromise === task) initializePromise = null;
            }
        })();
        initializePromise = task;
        return task;
    }

    function syncMode() {
        const isNew = byId('canvasProjectNew').checked;
        byId('canvasProjectNameRow').hidden = !isNew;
        byId('canvasProjectName').disabled = !isNew;
        byId('canvasProjectExistingRow').hidden = isNew;
        byId('canvasProjectSelect').disabled = isNew;
        byId('canvasProjectSubmit').textContent = isNew ? '프로젝트 생성 및 연결' : '캔버스 연결';
        updateSuggestedCanvasName();
    }

    function close() {
        if (busy) return;
        dialogRevision += 1;
        dialog.close();
        createAttempt = null;
        if (opener?.isConnected) opener.focus();
    }

    function ensureDialog() {
        if (dialog) return;
        dialog = doc.createElement('dialog');
        dialog.className = 'canvas-project-dialog';
        dialog.setAttribute('aria-labelledby', 'canvasProjectDialogTitle');
        dialog.innerHTML = `<form id="canvasProjectForm">
            <h2 id="canvasProjectDialogTitle">현재 캔버스 연결</h2>
            <p>레이어와 편집 상태를 저장하고, 이후 편집 내용도 자동으로 반영합니다. 앞면과 뒷면에 여러 캔버스를 연결할 수 있습니다.</p>
            <fieldset><legend>연결할 프로젝트</legend>
                <label><input type="radio" name="canvasProjectMode" id="canvasProjectExisting" value="existing" checked>기존 프로젝트</label>
                <label><input type="radio" name="canvasProjectMode" id="canvasProjectNew" value="new">새 프로젝트</label>
            </fieldset>
            <label id="canvasProjectExistingRow">프로젝트<select id="canvasProjectSelect" required></select></label>
            <label id="canvasProjectNameRow" hidden>새 프로젝트 이름<input id="canvasProjectName" type="text" maxlength="120" required disabled></label>
            <fieldset><legend>연결할 면</legend>
                <label><input type="radio" name="canvasProjectSide" value="front" checked>앞면</label>
                <label><input type="radio" name="canvasProjectSide" value="back">뒷면</label>
            </fieldset>
            <label>캔버스 이름<input id="canvasProjectCanvasName" type="text" maxlength="120" autocomplete="off" required></label>
            <p id="canvasProjectDialogStatus" role="status" aria-live="polite"></p>
            <div class="canvas-project-actions"><button id="canvasProjectCancel" type="button" class="secondary">취소</button><button id="canvasProjectSubmit" type="submit">캔버스 연결</button></div>
        </form>`;
        doc.body.appendChild(dialog);
        byId('canvasProjectForm').addEventListener('submit', submit);
        dialog.querySelectorAll('[name=canvasProjectMode]').forEach(input => input.addEventListener('change', syncMode));
        dialog.querySelectorAll('[name=canvasProjectSide]').forEach(input => input.addEventListener('change', updateSuggestedCanvasName));
        byId('canvasProjectSelect').addEventListener('change', updateSuggestedCanvasName);
        byId('canvasProjectName').addEventListener('input', updateSuggestedCanvasName);
        byId('canvasProjectCanvasName').addEventListener('input', () => {
            canvasNameEdited = Boolean(byId('canvasProjectCanvasName').value.trim());
        });
        byId('canvasProjectCancel').onclick = close;
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        // Canvas shortcuts must not consume typing or clipboard events in the native modal.
        for (const type of ['keydown', 'paste', 'copy', 'cut']) dialog.addEventListener(type, event => event.stopPropagation());
    }

    async function open() {
        if (busy) return;
        byId('canvasProjectStatus').open = false;
        if (!currentCanvasWidth || !currentCanvasHeight) { root.showToast('먼저 캔버스를 만들어 주세요.'); return; }
        ensureDialog();
        opener = doc.activeElement;
        const revision = ++dialogRevision;
        createAttempt = null;
        byId('canvasProjectForm').reset();
        canvasNameEdited = false;
        dialogProjects = [];
        byId('canvasProjectSelect').replaceChildren();
        byId('canvasProjectSubmit').disabled = true;
        byId('canvasProjectExisting').disabled = true;
        byId('canvasProjectDialogStatus').textContent = '프로젝트를 불러오는 중…';
        syncMode();
        if (!dialog.open) dialog.showModal();
        try {
            const [settings, result] = await Promise.all([api('/api/daki/settings'), api('/api/daki/projects')]);
            if (revision !== dialogRevision || !dialog.open) return;
            if (!settings.enabled) throw new Error('갤러리의 도구 → 설정에서 daki 사용을 켜 주세요.');
            dialogProjects = result.projects;
            for (const project of result.projects) {
                const option = doc.createElement('option');
                option.value = project.id; option.textContent = project.name;
                byId('canvasProjectSelect').appendChild(option);
            }
            byId('canvasProjectExisting').disabled = !result.projects.length;
            if (!result.projects.length) byId('canvasProjectNew').checked = true;
            else if (autosave?.current()) byId('canvasProjectSelect').value = autosave.current().projectId;
            byId('canvasProjectDialogStatus').textContent = !result.projects.length ? '새 프로젝트를 만들어 연결하세요.'
                : autosave?.current() ? '현재 작업을 새 캔버스로 연결합니다. 이후 편집은 새 연결에 자동 저장됩니다.' : '';
            syncMode();
            byId('canvasProjectSubmit').disabled = false;
            (byId('canvasProjectNew').checked ? byId('canvasProjectName') : byId('canvasProjectCanvasName')).focus();
        } catch (error) {
            if (revision === dialogRevision && dialog.open) byId('canvasProjectDialogStatus').textContent = error.message + ' 창을 다시 열어 재시도할 수 있습니다.';
        }
    }

    async function submit(event) {
        event.preventDefault();
        if (busy) return;
        const isNew = byId('canvasProjectNew').checked;
        const name = byId('canvasProjectCanvasName').value.trim();
        const projectName = byId('canvasProjectName').value.trim();
        const projectId = byId('canvasProjectSelect').value;
        if (!name || (isNew ? !projectName : !projectId)) return;
        busy = true;
        byId('canvasProjectSubmit').disabled = byId('canvasProjectCancel').disabled = true;
        byId('canvasProjectDialogStatus').textContent = '현재 캔버스를 저장하고 연결하는 중…';
        try {
            if (autosave && !await autosave.flush()) throw new Error('기존 프로젝트의 자동 저장을 먼저 완료해 주세요.');
            const side = dialog.querySelector('[name=canvasProjectSide]:checked').value;
            const key = JSON.stringify([isNew, projectName, projectId, name, side]);
            // Keep the same ID and snapshot for retry after an uncertain network response.
            if (!createAttempt || createAttempt.key !== key) createAttempt = {key,
                canvas: {id: root.crypto.randomUUID().replaceAll('-', ''), name, side, state: snapshot()}};
            const canvas = createAttempt.canvas;
            const result = await api(isNew ? '/api/daki/projects' : '/api/daki/projects/' + encodeURIComponent(projectId) + '/canvases',
                'POST', isNew ? {name: projectName, canvas} : canvas);
            const saved = isNew ? result.project.canvases[side].find(item => item.id === canvas.id) : result.canvas;
            connect(result.project, saved);
            // Edits made before a retry must follow the original, idempotent creation snapshot.
            autosave.schedule(true);
            busy = false;
            close();
            root.showToast(`${result.project.name} · ${sides[side]}에 캔버스를 연결했습니다.`);
        } catch (error) {
            byId('canvasProjectDialogStatus').textContent = error.message;
        } finally {
            busy = false;
            byId('canvasProjectSubmit').disabled = byId('canvasProjectCancel').disabled = false;
        }
    }

    root.CanvasProject = {
        open, leave, initialize, localLink, recoverConflict, chooseExportDestination,
        prepareImageImport, connectImportedImage, suggestCanvasName, suggestDownloadName,
        restoreLocalLink(value) { restoredLink = validLink(value) ? {...value} : null; },
        schedule(immediate = false) { if (autosave?.current()) autosave.schedule(immediate); },
        retry() {
            // A failed startup refresh has no pending PUT to retry.
            if (autosave?.current() && !autosave.isUnsaved()) {
                restoredLink = autosave.current();
                return initialize();
            }
            return autosave?.retry();
        },
        isUnsaved() { return Boolean(autosave?.isUnsaved()); },
        flush() { return autosave?.flush(); }
    };
    root.addEventListener('beforeunload', event => {
        autosave?.flush();
        if (autosave?.isUnsaved()) { event.preventDefault(); event.returnValue = ''; }
    });
    root.addEventListener('pagehide', () => finishOpenWarningChoice(false));
})(window);
