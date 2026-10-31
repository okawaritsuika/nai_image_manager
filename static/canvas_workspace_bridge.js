(function (root) {
    'use strict';

    const state = root.CanvasWorkspaceState;
    const context = state && typeof state.context === 'function'
        ? state.context(root.location?.search || '')
        : {mode: 'single', workspaceId: null, paneId: null};
    const isHost = context.mode === 'host';
    const isPane = context.mode === 'pane';
    const paneStateKey = isPane ? state.stateKey(context.workspaceId, context.paneId) : null;
    const initialStateKey = isPane ? paneStateKey : (state?.LEGACY_STATE_KEY || 'naia_canvas_state_v1');
    const channel = 'naim-canvas-workspace';
    let ready = false;
    let capturedWorkspaceSetupId = null;
    let inlineContext = null;
    let pendingLaunch = null;

    if (isPane) {
        try {
            const raw = paneStateKey ? root.localStorage.getItem(paneStateKey) : null;
            const snapshot = typeof raw === 'string' ? JSON.parse(raw) : null;
            if (typeof snapshot?.workspaceSetupId === 'string') {
                capturedWorkspaceSetupId = snapshot.workspaceSetupId;
            }
        } catch (_) {
            // A missing or malformed scoped snapshot must not prevent editor initialization.
        }
    }

    if (root.document?.body?.classList) {
        if (isHost) root.document.body.classList.add('canvas-workspace-host');
        if (isPane) root.document.body.classList.add('canvas-workspace-pane', 'canvas-pane-inactive');
    }

    function localProjectLink() {
        try {
            return typeof root.CanvasProject?.localLink === 'function'
                ? root.CanvasProject.localLink() || null
                : null;
        } catch (_) {
            return null;
        }
    }

    function statusFields() {
        const link = localProjectLink();
        const projectBar = root.document?.getElementById('canvasProjectBar');
        const autosave = root.document?.getElementById('canvasAutosaveStatus');
        const retouch = root.CanvasRetouch;
        const fields = {
            ready,
            name: link && typeof link.name === 'string' ? link.name : activeSetupName(),
            status: link
                ? (projectBar?.dataset?.state || 'saved')
                : (autosave?.dataset?.state || 'saved'),
            retouch: Boolean(retouch && typeof retouch.isOpen === 'function' && retouch.isOpen()),
        };
        if (link) {
            if (typeof link.projectId === 'string') fields.projectId = link.projectId;
            if (typeof link.canvasId === 'string') fields.canvasId = link.canvasId;
            if (typeof link.side === 'string') fields.side = link.side;
        }
        return fields;
    }

    function post(type, fields, requestId) {
        if (!isPane && !inlineContext) return;
        const paneId = inlineContext?.paneId || context.paneId;
        const message = {channel, type, paneId, ...fields};
        if (requestId !== undefined) message.requestId = requestId;
        if (inlineContext) {
            const workspace = root.CanvasWorkspace;
            if (typeof workspace?.receive === 'function') workspace.receive(message, root);
            return;
        }
        if (root.parent && typeof root.parent.postMessage === 'function') {
            root.parent.postMessage(message, root.location.origin);
        }
    }

    function report() {
        if ((!isPane && !inlineContext) || !ready) return null;
        const fields = statusFields();
        post('status', fields);
        return fields;
    }

    function readRetouchSettings() {
        if (!isPane && !inlineContext) return null;
        try {
            const paneId = inlineContext?.paneId || context.paneId;
            const workspace = inlineContext ? root.CanvasWorkspace : root.parent?.CanvasWorkspace;
            return typeof workspace?.readRetouchSettings === 'function'
                ? workspace.readRetouchSettings(paneId, root) || null
                : null;
        } catch (_) {
            return null;
        }
    }

    function writeRetouchSettings(value) {
        if (!isPane && !inlineContext) return false;
        try {
            const paneId = inlineContext?.paneId || context.paneId;
            const workspace = inlineContext ? root.CanvasWorkspace : root.parent?.CanvasWorkspace;
            return typeof workspace?.writeRetouchSettings === 'function'
                && workspace.writeRetouchSettings(paneId, root, value) === true;
        } catch (_) {
            return false;
        }
    }

    function getBusyError() {
        try {
            if (root.CanvasRetouch && typeof root.CanvasRetouch.isBusy === 'function'
                && root.CanvasRetouch.isBusy()) return '보정 작업이 끝난 뒤 닫아 주세요.';
            if (typeof clipInpaintLoadingClipId !== 'undefined' && clipInpaintLoadingClipId !== null) {
                return '클립 보정 작업이 끝난 뒤 닫아 주세요.';
            }
            if (typeof externalCanvasImageImportBusy !== 'undefined' && externalCanvasImageImportBusy) {
                return '이미지 가져오기가 끝난 뒤 닫아 주세요.';
            }
        } catch (error) {
            return error?.message || String(error);
        }
        const loading = root.document?.getElementById('referenceGenLoading');
        if (loading?.classList?.contains('show')) return '생성·보정 작업이 끝난 뒤 닫아 주세요.';
        return '';
    }

    async function flush() {
        try {
            const busyError = getBusyError();
            if (busyError) return {ok: false, error: busyError};

            if (typeof savedCanvasSetupsSavePromise !== 'undefined' && savedCanvasSetupsSavePromise) {
                const saved = await savedCanvasSetupsSavePromise;
                if (saved === false) return {ok: false, error: '캔버스 저장본 저장을 완료하지 못했습니다.'};
            }

            if (typeof root.CanvasProject?.flush === 'function') {
                const saved = await root.CanvasProject.flush();
                if (saved === false) return {ok: false, error: '프로젝트 캔버스 저장을 완료하지 못했습니다.'};
            }

            const width = typeof currentCanvasWidth !== 'undefined' ? currentCanvasWidth : root.currentCanvasWidth;
            const height = typeof currentCanvasHeight !== 'undefined' ? currentCanvasHeight : root.currentCanvasHeight;
            if (Number(width) > 0 && Number(height) > 0) {
                if (typeof root.getCanvasAutosave !== 'function'
                    || root.getCanvasAutosave().schedule(true) !== true) {
                    return {ok: false, error: '캔버스 자동 저장을 완료하지 못했습니다.'};
                }
            }

            report();
            return {ok: true};
        } catch (error) {
            return {ok: false, error: error?.message || String(error)};
        }
    }

    function launchError(error) {
        const message = error?.message || String(error || '캔버스 작업 공간을 열지 못했습니다.');
        if (typeof root.showToast === 'function') root.showToast(message);
        return {ok: false, error: message};
    }

    function randomId() {
        const cryptoApi = root.crypto;
        if (!cryptoApi || typeof cryptoApi.randomUUID !== 'function') {
            throw new Error('이 브라우저에서는 안전한 캔버스 ID를 만들 수 없습니다.');
        }
        const id = cryptoApi.randomUUID().replace(/-/g, '').toLowerCase();
        if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('캔버스 ID를 만들지 못했습니다.');
        return id;
    }

    function cachedSetupName(setupId) {
        if (typeof setupId !== 'string' || !setupId) return '';
        try {
            let setups = [];
            if (typeof root.loadSavedCanvasSetups === 'function') setups = root.loadSavedCanvasSetups();
            else if (Array.isArray(root.cachedSavedCanvasSetups)) setups = root.cachedSavedCanvasSetups;
            const item = Array.isArray(setups) ? setups.find(entry => entry && entry.id === setupId) : null;
            return typeof item?.name === 'string' ? item.name.trim() : '';
        } catch (_) {
            return '';
        }
    }

    function activeSetupName() {
        const setupId = typeof activeCanvasSetupId === 'string'
            ? activeCanvasSetupId
            : (typeof root.activeCanvasSetupId === 'string' ? root.activeCanvasSetupId : null);
        return cachedSetupName(setupId);
    }

    async function launchOnce() {
        if (context.mode === 'pane') {
            try {
                const workspace = root.parent?.CanvasWorkspace;
                if (typeof workspace?.openPicker !== 'function') {
                    throw new Error('캔버스 추가 화면을 열 수 없습니다.');
                }
                await workspace.openPicker();
                return {ok: true};
            } catch (error) {
                return launchError(error);
            }
        }
        if (inlineContext) {
            try {
                const workspace = root.CanvasWorkspace;
                if (typeof workspace?.openPicker !== 'function') {
                    throw new Error('캔버스 추가 화면을 열 수 없습니다.');
                }
                await workspace.openPicker();
                return {ok: true};
            } catch (error) {
                return launchError(error);
            }
        }
        if (context.mode !== 'single') return launchError('단일 캔버스 화면에서만 작업 공간을 열 수 있습니다.');

        const workspace = root.CanvasWorkspace;
        if (typeof workspace?.start !== 'function') {
            return launchError('현재 화면에서 캔버스 작업 공간을 시작할 수 없습니다.');
        }

        const flushed = await flush();
        if (!flushed.ok) return launchError(flushed.error);

        try {
            if (typeof root.buildCanvasStateSnapshot !== 'function') {
                throw new Error('현재 캔버스 상태를 저장할 수 없습니다.');
            }
            const snapshot = root.buildCanvasStateSnapshot({preserveMasks: true});
            if (!snapshot || typeof snapshot !== 'object') throw new Error('캔버스 상태를 읽지 못했습니다.');

            const projectLink = localProjectLink();
            const setupId = typeof activeCanvasSetupId === 'string'
                ? activeCanvasSetupId
                : (typeof root.activeCanvasSetupId === 'string' ? root.activeCanvasSetupId : null);
            snapshot.projectLink = projectLink;
            if (setupId) snapshot.workspaceSetupId = setupId;

            const workspaceId = randomId();
            const paneId = randomId();
            const pane = {id: paneId, name: '', closed: false};
            if (projectLink && typeof projectLink.projectId === 'string'
                && typeof projectLink.canvasId === 'string') {
                pane.projectId = projectLink.projectId;
                pane.canvasId = projectLink.canvasId;
            } else if (setupId) {
                pane.setupId = setupId;
            }
            pane.retouch = Boolean(root.CanvasRetouch
                && typeof root.CanvasRetouch.isOpen === 'function'
                && root.CanvasRetouch.isOpen());
            pane.name = (projectLink && typeof projectLink.name === 'string' ? projectLink.name.trim() : '')
                || (projectLink && typeof projectLink.projectName === 'string' ? projectLink.projectName.trim() : '')
                || cachedSetupName(setupId) || '현재 캔버스';

            const paneKey = state.stateKey(workspaceId, paneId);
            const manifestKey = state.manifestKey(workspaceId);
            if (!paneKey || !manifestKey) throw new Error('캔버스 작업 공간 저장 키를 만들지 못했습니다.');

            root.localStorage.setItem(paneKey, JSON.stringify(snapshot));
            root.localStorage.setItem(manifestKey, JSON.stringify({
                version: 1,
                panes: [pane],
                activeId: paneId,
                layout: 'row',
            }));

            await workspace.start({workspaceId, paneId});
            if (typeof root.history?.replaceState === 'function') {
                root.history.replaceState(null, '', '/canvas?workspace=' + workspaceId);
            }
            return {ok: true, workspaceId, paneId};
        } catch (error) {
            return launchError(error);
        }
    }

    function launch() {
        if (pendingLaunch) return pendingLaunch;
        pendingLaunch = launchOnce().finally(() => { pendingLaunch = null; });
        return pendingLaunch;
    }

    function attach(workspaceId, paneId) {
        if (context.mode !== 'single' || inlineContext || typeof state?.stateKey !== 'function') return false;
        const key = state.stateKey(workspaceId, paneId);
        if (!key) return false;
        inlineContext = {workspaceId, paneId};
        root.document?.body?.classList?.add('canvas-workspace-pane', 'canvas-pane-inactive');
        return true;
    }

    function setActive(active) {
        const isActive = active === true;
        root.document?.body?.classList?.toggle('canvas-pane-inactive', !isActive);
        const workspace = root.document?.getElementById('canvasWorkspace');
        if (workspace) workspace.inert = !isActive;
        const header = root.document?.querySelector?.('.main-header');
        if (header) header.inert = !isActive;
        if (isActive && typeof root.dispatchEvent === 'function' && typeof root.Event === 'function') {
            root.dispatchEvent(new root.Event('resize'));
        }
        if (isActive) root.CanvasRetouch?.refreshControls?.();
    }

    function toggleClass(className) {
        if (!root.document?.body?.classList) throw new Error('캔버스 화면을 찾지 못했습니다.');
        root.document.body.classList.toggle(className);
    }

    async function handleCommand(data) {
        const action = data.action;
        if (action !== 'active' && action !== 'flush' && !ready) {
            return {ok: false, error: '캔버스 초기화가 끝나지 않았습니다.'};
        }
        if (action !== 'active' && action !== 'flush' && action !== 'restoreRetouch'
            && action !== 'preview'
            && root.document?.body?.classList?.contains('canvas-pane-inactive')) {
            return {ok: false, error: '비활성 캔버스는 조작할 수 없습니다.'};
        }

        if (action === 'active') {
            setActive(data.active);
            return {ok: true};
        }
        if (action === 'flush') return await flush();
        if (action === 'preview') return await capturePreview();
        if (action === 'retouch' || action === 'restoreRetouch') {
            root.document?.body?.classList?.remove('canvas-pane-tools');
            if (typeof root.CanvasRetouch?.open !== 'function') throw new Error('보정 도구를 열 수 없습니다.');
            root.CanvasRetouch.open();
            return {ok: true};
        }
        if (action === 'tools') {
            if (typeof root.CanvasRetouch?.close !== 'function') throw new Error('보정 도구를 닫을 수 없습니다.');
            root.CanvasRetouch.close();
            toggleClass('canvas-pane-tools');
            return {ok: true};
        }
        if (action === 'menu') {
            toggleClass('canvas-pane-menu');
            return {ok: true};
        }
        if (action === 'new') {
            if (typeof root.openCanvasDialog !== 'function') throw new Error('새 캔버스 대화상자를 열 수 없습니다.');
            root.openCanvasDialog();
            return {ok: true};
        }
        if (action === 'save') {
            if (typeof root.saveCurrentCanvasSetup !== 'function') throw new Error('캔버스 저장 대화상자를 열 수 없습니다.');
            root.saveCurrentCanvasSetup();
            return {ok: true};
        }
        return {ok: false, error: '지원하지 않는 캔버스 명령입니다.'};
    }

    async function capturePreview() {
        try {
            const overlay = root.document?.querySelector?.('.canvas-retouch-surface-overlay canvas');
            if (overlay && Number(overlay.width) > 0 && Number(overlay.height) > 0) {
                const scale = Math.min(1, 1600 / Math.max(overlay.width, overlay.height));
                const preview = root.document.createElement('canvas');
                preview.width = Math.max(1, Math.round(overlay.width * scale));
                preview.height = Math.max(1, Math.round(overlay.height * scale));
                const context2d = preview.getContext('2d');
                if (!context2d) throw new Error('캔버스 미리보기를 만들 수 없습니다.');
                context2d.drawImage(overlay, 0, 0, preview.width, preview.height);
                return {ok: true, preview: preview.toDataURL('image/png')};
            }

            const width = typeof currentCanvasWidth !== 'undefined' ? currentCanvasWidth : root.currentCanvasWidth;
            const height = typeof currentCanvasHeight !== 'undefined' ? currentCanvasHeight : root.currentCanvasHeight;
            if (!(Number(width) > 0) || !(Number(height) > 0)) return {ok: true, preview: ''};
            if (typeof root.renderMergedCanvasToDataUrl !== 'function'
                || typeof root.buildCanvasStateSnapshot !== 'function') {
                throw new Error('캔버스 미리보기 기능을 사용할 수 없습니다.');
            }
            const stateSnapshot = root.buildCanvasStateSnapshot({preserveMasks: true});
            const dataUrl = await root.renderMergedCanvasToDataUrl({state: stateSnapshot, maxDimension: 1600});
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
                throw new Error('캔버스 미리보기를 만들지 못했습니다.');
            }
            return {ok: true, preview: dataUrl};
        } catch (error) {
            return {ok: false, error: error?.message || String(error)};
        }
    }

    async function execute(action, extra = {}) {
        try {
            return await handleCommand({action, ...extra});
        } catch (error) {
            return {ok: false, error: error?.message || String(error)};
        }
    }

    function onMessage(event) {
        const data = event?.data;
        if (!isPane || event.origin !== root.location.origin || event.source !== root.parent
            || !data || data.channel !== channel || data.type !== 'command'
            || data.paneId !== context.paneId) return;

        Promise.resolve()
            .then(() => handleCommand(data))
            .then(result => {
                if (data.requestId !== undefined) {
                    post('response', {
                        ok: Boolean(result?.ok),
                        ...(result?.error ? {error: result.error} : {}),
                        ...(Object.prototype.hasOwnProperty.call(result || {}, 'preview') ? {preview: result.preview} : {}),
                    }, data.requestId);
                }
            })
            .catch(error => {
                if (data.requestId !== undefined) {
                    post('response', {ok: false, error: error?.message || String(error)}, data.requestId);
                }
            });
    }

    if (isPane && typeof root.addEventListener === 'function') root.addEventListener('message', onMessage);

    function markReady() {
        if (!isPane && !inlineContext) {
            if (context.mode !== 'single') return false;
            ready = true;
            return true;
        }
        if (!ready) {
            if (!localProjectLink() && capturedWorkspaceSetupId !== null
                && typeof activeCanvasSetupId !== 'string') {
                activeCanvasSetupId = capturedWorkspaceSetupId;
            }
            ready = true;
        }
        for (const selector of ['.main-header .header-nav > button:first-child', '.main-header .header-logo']) {
            const control = root.document?.querySelector?.(selector);
            if (control) control.onclick = () => {
                const workspace = inlineContext ? root.CanvasWorkspace : root.parent?.CanvasWorkspace;
                workspace?.leave?.();
            };
        }
        post('ready', statusFields());
        return true;
    }

    root.CanvasWorkspaceBridge = {
        isHost,
        get isPane() { return isPane || inlineContext !== null; },
        get stateKey() {
            return inlineContext ? state.stateKey(inlineContext.workspaceId, inlineContext.paneId) : initialStateKey;
        },
        attach,
        execute,
        ready: markReady,
        report,
        flush,
        launch,
        readRetouchSettings,
        writeRetouchSettings,
    };
}(typeof window === 'object' ? window : globalThis));
