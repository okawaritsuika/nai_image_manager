/* Editable project canvases. Image candidates and named canvas backups stay separate. */
(function (root) {
    'use strict';
    const doc = root.document;
    const byId = id => doc.getElementById(id);
    const sides = {front: '앞면', back: '뒷면'};
    let autosave;
    let restoredLink = null;
    let restoredWrite = null;
    let compactRestore = null;
    let compactControlsBlocked = false;
    let suspendedLink = null;
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
    let confirmedState = null;
    let quotaSyncAttempted = false;
    let editLock = null;
    let readOnlyPreview = null;
    let readOnlyRequest = null;
    let readOnlyController = null;
    let leavingDocument = false;
    const editorChannel = typeof root.BroadcastChannel === 'function'
        ? new root.BroadcastChannel('naim-project-canvas-editor') : null;
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

    function truncateUtf16(value, maxUnits) {
        let result = '';
        for (const character of String(value)) {
            if (result.length + character.length > maxUnits) break;
            result += character;
        }
        return result;
    }

    function imageDisplayStem(value) {
        const basename = String(value || '').replace(/\\/g, '/').split('/').pop() || '';
        const dot = basename.lastIndexOf('.');
        const possibleExtension = dot >= 0 ? basename.slice(dot) : '';
        const extension = ['.png', '.jpg', '.jpeg', '.webp'].includes(possibleExtension.toLowerCase())
            ? possibleExtension : '';
        return basename.slice(0, basename.length - extension.length)
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
            .replace(/[. ]+$/, '').trim();
    }

    function suggestImageCanvasName(imageName, side, existingNames = []) {
        const stem = imageDisplayStem(imageName) || '캔버스';
        const suffix = ` · ${sides[side] || sides.front} 편집`;
        const existing = new Set((Array.isArray(existingNames) ? existingNames : [])
            .filter(name => typeof name === 'string').map(name => name.toLowerCase()));
        let duplicate = 1;
        while (true) {
            const duplicateSuffix = duplicate === 1 ? '' : ` ${duplicate}`;
            const maxPrefixUnits = Math.max(0, 120 - suffix.length - duplicateSuffix.length);
            const prefix = truncateUtf16(stem, maxPrefixUnits).replace(/[. ]+$/, '')
                || truncateUtf16('캔버스', maxPrefixUnits).replace(/[. ]+$/, '');
            const name = `${prefix}${suffix}${duplicateSuffix}`;
            if (!existing.has(name.toLowerCase())) return name;
            duplicate += 1;
        }
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

    async function api(url, method = 'GET', body, signal) {
        const headers = {'Content-Type': 'application/json'};
        if (method === 'PUT') headers['X-NAIM-Reference-Placement'] = '1';
        const response = await root.fetch(url, {
            method, headers,
            ...(signal ? {signal} : {}),
            ...(body === undefined ? {} : {body: JSON.stringify(body)})
        });
        const result = await response.json();
        if (!response.ok || result.status !== 'success') {
            const error = new Error(result.message || '프로젝트 캔버스를 저장하지 못했습니다.');
            error.status = response.status;
            error.code = result.code;
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

    function editorKey(link) {
        return 'naim-project-canvas:' + link.projectId + ':' + link.canvasId;
    }

    function acquireEditLock(link) {
        const key = editorKey(link);
        if (editLock?.key === key) return editLock;
        const uncoordinated = {key, release() {}};
        if (!root.navigator?.locks?.request) return uncoordinated;
        return new Promise(resolve => {
            root.navigator.locks.request(key, {ifAvailable: true}, lock => {
                if (!lock) {
                    resolve(null);
                    return;
                }
                return new Promise(release => resolve({key, release}));
            }).catch(() => resolve(uncoordinated));
        }).catch(() => uncoordinated);
    }

    function releaseEditLock() {
        editLock?.release();
        editLock = null;
    }

    function workspacePane() {
        if (root.CanvasWorkspaceBridge?.paneId) return root.CanvasWorkspaceBridge.paneId;
        const params = new URLSearchParams(root.location.search);
        return params.has('workspace') && root.parent !== root ? params.get('pane') : null;
    }

    function blocksLocalWrites() {
        return Boolean(readOnlyPreview || compactRestore || suspendedLink);
    }

    if (editorChannel) editorChannel.onmessage = async event => {
        const pendingImport = event.data?.type === 'pending-import';
        const key = pendingImport ? event.data.key : event.data;
        if (pendingImport && initializePromise) await initializePromise;
        if (!editLock || editLock.key !== key || blocksLocalWrites()) return;
        const pane = workspacePane();
        if (pane) (root.parent?.CanvasWorkspace || root.CanvasWorkspace)?.select(pane);
        root.focus?.();
        if (pendingImport) void root.consumePendingCanvasImport?.();
    };

    function forwardPendingImport() {
        if (!editorChannel || !readOnlyPreview) return false;
        editorChannel.postMessage({type: 'pending-import', key: editorKey(readOnlyPreview)});
        return true;
    }

    function loadLatestPreview(link, signal) {
        return api(endpoint(link) + '?preview=1', 'GET', undefined, signal).then(result => {
            if (result.project?.id !== link.projectId || result.canvas?.id !== link.canvasId) {
                throw new Error('캔버스 미리보기 응답을 확인할 수 없습니다.');
            }
            return result.canvas;
        });
    }

    function loadReadOnlyCanvas() {
        if (!readOnlyPreview) return Promise.reject(new Error('보기 전용 캔버스가 없습니다.'));
        if (!readOnlyRequest) {
            readOnlyController = root.AbortController ? new root.AbortController() : null;
            readOnlyRequest = loadLatestPreview(readOnlyPreview, readOnlyController?.signal).catch(error => {
                readOnlyRequest = null;
                throw error;
            });
        }
        return readOnlyRequest;
    }

    async function previewLatest(allowRecovery = true) {
        const link = localLink();
        if (!link) return;
        const result = await root.CanvasProjectPreview.open({
            title: '서버 최신본 미리보기',
            message: '서버에 마지막으로 저장된 캔버스입니다. 현재 편집 중인 작업은 그대로 유지됩니다.',
            load: signal => loadLatestPreview(link, signal),
            actions: allowRecovery && conflicted
                ? [{id: 'recover', label: '내 작업을 새 캔버스로 보관'}] : []
        });
        if (result === 'recover' && autosave?.current()?.canvasId === link.canvasId) await recoverConflict();
    }

    function viewDuplicate(link, keepEditor) {
        if (!keepEditor) readOnlyPreview = {...link};
        const actions = [{
            id: 'find-editor', label: '기존 편집 화면 찾기',
            run: () => {
                editorChannel?.postMessage(editorKey(link));
                return '편집 화면이 앞으로 오지 않으면 같은 캔버스가 열린 탭이나 작업 공간을 확인해 주세요.';
            }
        }];
        if (!keepEditor) actions.push({id: 'retry', label: '편집 화면 다시 열기'});
        const choice = root.CanvasProjectPreview.open({
            title: '이미 편집 중인 캔버스',
            message: '이 브라우저의 다른 화면에서 이 캔버스를 편집 중입니다. 여기서는 서버에 저장된 그림을 볼 수 있습니다.',
            load: keepEditor ? signal => loadLatestPreview(link, signal) : loadReadOnlyCanvas,
            actions
        });
        if (keepEditor) return choice.then(() => {
            if (!leavingDocument) syncLocation(autosave?.current());
        });
        void choice.then(action => {
            readOnlyController?.abort();
            if (leavingDocument) return;
            if (action === 'retry') root.location.reload();
            else if (workspacePane()) void root.parent.CanvasWorkspace?.close(workspacePane());
            else root.location.href = '/#project=' + encodeURIComponent(link.projectId);
        });
        return false;
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
        if (compactControlsBlocked !== Boolean(compactRestore)) {
            compactControlsBlocked = Boolean(compactRestore);
            for (const element of doc.querySelectorAll('.main-header .canvas-header-menu, #canvasProjectLinkBtn, ' +
                '#canvasWorkspaceLaunch, #canvasOppositeControls, .canvas-project-footer > button')) {
                element.inert = compactControlsBlocked;
            }
        }
        root.CanvasDakiFocus?.linkChanged();
        conflicted = state === 'conflict';
        const panel = byId('canvasProjectStatus');
        const label = byId('canvasProjectMessage');
        const link = autosave?.current() || compactRestore;
        root.CanvasOppositeReference?.linkChanged();
        root.CanvasProjectSettings?.linkChanged();
        root.CanvasDetailPresets?.linkChanged();
        root.CanvasInpaintReference?.render();
        if (!panel || !label) return;
        panel.hidden = !link;
        panel.dataset.state = state;
        byId('canvasProjectBar').dataset.state = link ? state : 'idle';
        byId('canvasProjectDisconnect').hidden = !link || Boolean(compactRestore);
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
            recovering: '저장 충돌이 발생해 현재 작업을 같은 프로젝트에 복구 사본으로 저장하고 있습니다.',
            conflict: '복구 사본을 저장하지 못했습니다. 현재 작업은 열려 있습니다. 사본 저장을 다시 시도해 주세요.'
        };
        label.textContent = compactRestore && state === 'error'
            ? '서버 저장본을 불러오지 못했습니다. 다시 시도해 주세요.' : messages[state] || '';
        if ((state === 'error' || state === 'conflict') && error?.message) label.textContent += ' ' + error.message;
        byId('canvasProjectSummaryState').textContent = {
            idle: '', pending: '저장 대기', saving: '저장 중', saved: '저장됨',
            recovering: '자동 복구 중', error: compactRestore ? '불러오기 실패' : '저장 실패', conflict: '복구 필요'
        }[state] || '';
        byId('canvasProjectSummary').title = link
            ? `${link.projectName} · ${sides[link.side]} · ${link.name}\n${label.textContent}` : '';
        byId('canvasProjectRetry').hidden = state !== 'error';
        byId('canvasProjectRetry').textContent = compactRestore ? '저장본 다시 불러오기' : '저장 다시 시도';
        byId('canvasProjectRecover').hidden = state !== 'conflict';
        const preview = byId('canvasProjectPreviewLatest');
        if (preview) preview.hidden = state !== 'conflict';
        root.CanvasWorkspaceBridge?.report();
    }

    function makeAutosave(firstWrite = null) {
        return createProjectCanvasAutosave({
            snapshot() {
                if (!firstWrite) return snapshot();
                const original = firstWrite;
                firstWrite = null;
                return original;
            },
            send: async (link, state, revision) => (await api(endpoint(link), 'PUT', {state, revision})).canvas,
            recover: createConflictCopy,
            onRecovered(link) {
                conflictCopyAttempt = null;
                confirmedState = null;
                quotaSyncAttempted = false;
                syncLocation(link);
                saveLocalLink();
                root.showToast('같은 프로젝트에 복구 사본을 만들었습니다. 이후 편집은 이 사본에 저장됩니다.');
            },
            status(state, error) {
                report(state, error);
                if (state === 'error' || state === 'conflict') getCanvasAutosave().flush();
            },
            onSaved(_link, state) {
                confirmedState = state;
                saveLocalLink();
            },
            onMissing: missingLinkRemoved
        });
    }

    function missingLinkRemoved() {
        compactRestore = null;
        conflictCopyAttempt = null;
        confirmedState = null;
        releaseEditLock();
        syncLocation(null);
        report('idle');
        saveLocalLink();
        root.showToast('연결된 프로젝트 또는 캔버스를 찾을 수 없어 연결을 해제했습니다. 현재 작업은 유지되며 일반 캔버스로 계속 편집·저장할 수 있습니다.');
    }

    async function connect(project, canvas, reservedLock, savedState = canvas.state) {
        let nextLock = reservedLock || acquireEditLock({projectId: project.id, canvasId: canvas.id});
        if (nextLock?.then) nextLock = await nextLock;
        if (!nextLock) throw new Error('이 캔버스는 다른 화면에서 이미 편집 중입니다.');
        if (nextLock !== editLock) releaseEditLock();
        editLock = nextLock;
        conflictCopyAttempt = null;
        confirmedState = savedState;
        quotaSyncAttempted = false;
        autosave = makeAutosave();
        autosave.connect({projectId: project.id, canvasId: canvas.id, revision: canvas.revision,
            projectName: project.name, name: canvas.name, side: canvas.side});
        syncLocation(autosave.current());
        report('saved');
        saveLocalLink();
    }

    async function leave() {
        if (busy || blocksLocalWrites()) return false;
        if (!autosave?.current()) return true;
        const saved = await autosave.disconnect();
        if (saved) {
            confirmedState = null;
            releaseEditLock();
            syncLocation(null);
            report('idle');
            saveLocalLink();
        }
        return saved;
    }

    async function createConflictCopy(link) {
        const owner = autosave;
        // Reuse the original POST body if the server committed the copy but its response was lost.
        if (!conflictCopyAttempt) conflictCopyAttempt = {
            id: root.crypto.randomUUID().replaceAll('-', ''),
            name: String(link.name).slice(0, 110) + ' (충돌 복구)', side: link.side, state: snapshot()
        };
        const attempt = conflictCopyAttempt;
        const {project, canvas} = await api('/api/daki/projects/' + encodeURIComponent(link.projectId) + '/canvases',
            'POST', attempt);
        const next = {projectId: project.id, projectName: project.name, canvasId: canvas.id,
            name: canvas.name, side: canvas.side, revision: canvas.revision};
        if (!validLink(next) || next.projectId !== link.projectId || next.side !== link.side ||
            next.canvasId !== attempt.id || next.canvasId === link.canvasId) {
            throw new Error('저장된 복구 사본의 정보를 확인할 수 없습니다.');
        }
        const lock = await acquireEditLock(next);
        if (!lock) throw new Error('복구 사본이 다른 화면에서 편집 중입니다.');
        if (autosave !== owner || owner.current()?.canvasId !== link.canvasId) {
            lock.release();
            throw new Error('프로젝트 캔버스 연결이 변경되었습니다.');
        }
        releaseEditLock();
        editLock = lock;
        return next;
    }

    function recoverConflict() {
        return autosave?.retryConflict() ?? false;
    }

    function localLink() {
        if (suspendedLink || readOnlyPreview) return null;
        if (compactRestore) return {...compactRestore, unsaved: false};
        const link = autosave?.current();
        return link ? {...link, unsaved: autosave.isUnsaved()} : null;
    }

    // These keys describe the browser slot or its independent zoom record.
    const localStateKeys = new Set(['savedAt', 'canvasZoom', 'clipPreviewZoom',
        'projectLink', 'workspaceSetupId', 'projectRestoreOnly']);
    const restoreDefaults = {checkedSelectionId: null, isSelectionOverlayHidden: false,
        isClipInpaintMergedSourceMode: false, sharedSelectionClipPromptInfo: null,
        sharedSelectionClipPromptControlGroups: [], inpaintSettings: null, oppositeReference: null,
        projectSettingsLink: null, inpaintReference: {reference: null, showArea: false, include: false}};

    function sameStateValue(left, right, top = false) {
        if (left === right) return true;
        if (!left || !right || typeof left !== 'object' || typeof right !== 'object' ||
            Array.isArray(left) !== Array.isArray(right)) return false;
        if (Array.isArray(left)) {
            return left.length === right.length && left.every((value, index) => sameStateValue(value, right[index]));
        }
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
            if (top && localStateKeys.has(key)) continue;
            const fallback = top && Object.hasOwn(restoreDefaults, key) ? restoreDefaults[key] : undefined;
            const a = Object.hasOwn(left, key) && left[key] !== undefined ? left[key] : fallback;
            const b = Object.hasOwn(right, key) && right[key] !== undefined ? right[key] : fallback;
            if (!sameStateValue(a, b)) return false;
        }
        return true;
    }

    function canRestoreFromServer(state) {
        if (!confirmedState || blocksLocalWrites() || !autosave?.current() || autosave.isUnsaved()) return false;
        if (state === undefined || sameStateValue(confirmedState, state, true)) return true;
        if (!quotaSyncAttempted) {
            quotaSyncAttempted = true;
            autosave.schedule();
        }
        return false;
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
        if (busy || importChoiceBusy || blocksLocalWrites()) return false;
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
        if (blocksLocalWrites()) throw new Error('프로젝트 캔버스를 편집할 수 없습니다.');
        if (!validImageImportContext(context)) throw new TypeError('Invalid project image import context');
        const current = autosave?.current();
        if (current?.projectId === context.projectId) return;
        if (current) throw new Error('기존 프로젝트 연결을 먼저 종료해 주세요.');

        const state = snapshot();
        const targetResult = await api('/api/daki/projects/' + encodeURIComponent(context.projectId));
        const sourceContext = payload?.projectContext;
        let sourceProject = targetResult.project;
        if (sourceContext && typeof sourceContext.projectId === 'string'
            && typeof sourceContext.candidateId === 'string'
            && sourceContext.projectId !== context.projectId) {
            sourceProject = (await api('/api/daki/projects/' + encodeURIComponent(sourceContext.projectId))).project;
        }
        let imageName = payload?.displayName || payload?.name || '';
        if (sourceContext && typeof sourceContext.candidateId === 'string') {
            const candidate = ['front', 'back'].flatMap(side => sourceProject?.candidates?.[side] || [])
                .find(item => item?.id === sourceContext.candidateId);
            if (candidate) imageName = candidate.name || String(candidate.path || '').replace(/\\/g, '/').split('/').pop() || imageName;
        }
        const existingNames = ['front', 'back'].flatMap(side =>
            (targetResult.project?.canvases?.[side] || []).map(item => item?.name));
        const name = suggestImageCanvasName(imageName, context.side, existingNames);
        const canvas = {
            id: root.crypto.randomUUID().replaceAll('-', ''),
            name,
            side: context.side,
            state
        };
        const result = await api('/api/daki/projects/' + encodeURIComponent(context.projectId) + '/canvases',
            'POST', canvas);
        await connect(result.project, result.canvas, null, state);
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

    async function loadProjectCanvas(link) {
        const result = await api(endpoint(link));
        const canvas = result.canvas;
        if (!canvas || result.project?.id !== link.projectId || canvas.id !== link.canvasId ||
            !validLink({projectId: result.project.id, canvasId: canvas.id, side: canvas.side, revision: canvas.revision}) ||
            !(canvas.state?.width > 0 && canvas.state?.height > 0) || !Array.isArray(canvas.state.layers)) {
            throw new Error('프로젝트 캔버스 저장본을 읽을 수 없습니다.');
        }
        return result;
    }

    async function restoreCompactCanvas(target) {
        const link = target || compactRestore;
        const lock = await acquireEditLock(link);
        if (!lock) return viewDuplicate(link, false);
        try {
            const result = await loadProjectCanvas(link);
            applyCanvasStateSnapshot(result.canvas.state, {deferMigration: true});
            activeCanvasSetupId = null;
            compactRestore = null;
            await connect(result.project, result.canvas, lock);
        } catch (error) {
            if (error.status === 404 && error.code === 'daki_not_found') {
                if (target && editorKey(target) !== editorKey(compactRestore)) {
                    syncLocation(compactRestore);
                    return restoreCompactCanvas(null);
                }
                missingLinkRemoved();
            } else report('error', error);
        } finally {
            if (editLock !== lock) lock.release();
        }
    }

    function suspendClosedPane() {
        if (suspendedLink || autosave?.isUnsaved()) return;
        suspendedLink = autosave?.current() || compactRestore;
        if (!suspendedLink) return;
        autosave = null;
        releaseEditLock();
        confirmedState = null;
    }

    async function resumeClosedPane() {
        const link = suspendedLink;
        if (!link) return true;
        const lock = await acquireEditLock(link);
        if (!lock) return false;
        try {
            const result = await loadProjectCanvas(link);
            const changed = Boolean(compactRestore) || result.canvas.revision !== link.revision;
            if (changed) applyCanvasStateSnapshot(result.canvas.state, {deferMigration: true});
            compactRestore = null;
            suspendedLink = null;
            await connect(result.project, result.canvas, lock);
            if (changed) void root.migrateCanvasLayerDataUrlsToServer?.();
            return true;
        } catch {
            return false;
        } finally {
            if (editLock !== lock) lock.release();
        }
    }

    async function initializeCanvas() {
        const params = new URLSearchParams(root.location.search);
        const targetProject = params.get('project');
        const targetCanvas = params.get('canvas');
        const target = targetProject && targetCanvas ? {projectId: targetProject, canvasId: targetCanvas} : null;
        if (compactRestore) return restoreCompactCanvas(target);
        const same = target && restoredLink?.projectId === targetProject && restoredLink?.canvasId === targetCanvas;
        if (restoredLink) {
            let restoredLock = acquireEditLock(restoredLink);
            if (restoredLock?.then) restoredLock = await restoredLock;
            if (restoredLock) {
                editLock = restoredLock;
                confirmedState = null;
                autosave = makeAutosave(restoredWrite);
                restoredWrite = null;
                autosave.connect(restoredLink);
                report('saved');
                if (restoredLink.unsaved) autosave.schedule(true);
            } else if (!target || same) {
                return viewDuplicate(restoredLink, false);
            }
        }
        if (target) {
            if (same && restoredLink.unsaved) return;
            const restoredElsewhere = restoredLink && !autosave?.current();
            let targetLock = acquireEditLock(target);
            if (targetLock?.then) targetLock = await targetLock;
            if (!targetLock) {
                const keepEditor = !restoredElsewhere && Boolean(currentCanvasWidth && currentCanvasHeight);
                return viewDuplicate(target, keepEditor);
            }
            try {
                if (!same && currentCanvasWidth && currentCanvasHeight && !await confirmCanvasReplacement()) {
                    if (restoredElsewhere) return viewDuplicate(restoredLink, false);
                    return;
                }
                if (!same && !await leave()) return;
                const result = await loadProjectCanvas(target);
                applyCanvasStateSnapshot(result.canvas.state, {deferMigration: true});
                activeCanvasSetupId = null;
                await connect(result.project, result.canvas, targetLock);
            } catch (error) {
                if (error.status === 404 && error.code === 'daki_not_found') {
                    if (!autosave?.disconnectMissing(error)) missingLinkRemoved();
                } else if (same) report('error', error);
                else root.showToast('프로젝트 캔버스를 열지 못했습니다: ' + error.message);
            } finally {
                if (targetLock !== editLock) targetLock.release();
            }
        } else if (restoredLink && !restoredLink.unsaved) {
            // Refresh the revision before edits; a second tab may have saved since this browser closed.
            try {
                const result = await loadProjectCanvas(restoredLink);
                applyCanvasStateSnapshot(result.canvas.state, {deferMigration: true});
                await connect(result.project, result.canvas, editLock);
            } catch (error) {
                if (!autosave.disconnectMissing(error)) report('error', error);
            }
        }
        restoredLink = null;
    }

    function initialize(retrying = false) {
        if (initializePromise) return initializePromise;
        const workspace = byId('canvasWorkspace');
        const wasCompact = Boolean(compactRestore);
        const surfaces = [workspace, doc.querySelector('.main-header')].filter(Boolean);
        const previous = surfaces.map(node => node.inert);
        surfaces.forEach(node => { node.inert = true; });
        let task;
        task = (async () => {
            try {
                const result = await initializeCanvas();
                if (retrying && !blocksLocalWrites()) {
                    if (confirmedState) void root.migrateCanvasLayerDataUrlsToServer?.();
                    if (wasCompact && !root.CanvasWorkspaceBridge?.isPane) void root.consumePendingCanvasImport?.();
                }
                return result;
            }
            finally {
                restoredLink = null;
                restoredWrite = null;
                surfaces.forEach((node, index) => {
                    const inactive = wasCompact && node === workspace
                        ? doc.body.classList?.contains('canvas-pane-inactive') : previous[index];
                    node.inert = Boolean(readOnlyPreview || inactive || (node === workspace && compactRestore));
                });
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
        if (blocksLocalWrites()) { root.showToast('프로젝트 캔버스 저장본을 먼저 열어 주세요.'); return; }
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
            await connect(result.project, saved);
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
        hasSaveConflict() { return conflicted; },
        blocksLocalWrites, forwardPendingImport, suspendClosedPane, resumeClosedPane, loadReadOnlyCanvas,
        isPaneSuspended() { return Boolean(suspendedLink); },
        isChangingConnection() { return Boolean(initializePromise || busy); },
        isSavePending() { return Boolean(autosave?.isSavePending?.()); },
        canRestoreFromServer,
        isReadOnlyPreview() { return Boolean(readOnlyPreview); },
        readOnlyPreviewLink() { return readOnlyPreview ? {...readOnlyPreview} : null; },
        previewLatest,
        prepareImageImport, connectImportedImage, suggestCanvasName, suggestDownloadName,
        suggestImageCanvasName,
        restoreLocalLink(value, backup) {
            restoredLink = validLink(value) ? {...value} : null;
            restoredWrite = null;
            compactRestore = backup?.projectRestoreOnly === true && restoredLink?.unsaved === false ? restoredLink : null;
            if (restoredLink?.unsaved && Array.isArray(backup?.layers)) {
                const {projectLink, workspaceSetupId, projectRestoreOnly, ...state} = backup;
                restoredWrite = state;
            }
        },
        schedule(immediate = false) {
            if (blocksLocalWrites() || !autosave?.current()) return;
            quotaSyncAttempted = false;
            autosave.schedule(immediate);
        },
        retry() {
            // A failed startup refresh has no pending PUT to retry.
            if (compactRestore && !suspendedLink && !readOnlyPreview) return initialize(true);
            if (autosave?.current() && !autosave.isUnsaved()) {
                restoredLink = autosave.current();
                return initialize(true);
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
    root.addEventListener('pagehide', () => {
        leavingDocument = true;
        finishOpenWarningChoice(false);
        readOnlyController?.abort();
    });
    root.addEventListener('pageshow', event => {
        leavingDocument = false;
        if (event?.persisted && readOnlyPreview) root.location.reload();
    });
})(window);
