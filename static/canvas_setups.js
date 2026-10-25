// Saved canvas state and legacy browser storage compatibility.
let savedCanvasSetupsSaveRevision = 0;
let savedCanvasSetupsLoadRevision = 0;
let savedCanvasSetupsLoadFailed = false;
let savedCanvasGalleryRevision = 0;
let savedCanvasGalleryLoading = false;
let savedCanvasGalleryPendingLoad = null;
let savedCanvasGalleryPreviewManager = null;
let savedCanvasGalleryDialogManager = null;
let savedCanvasGallerySearchTerm = '';

function normalizeSavedCanvasSetupItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (!item.state || typeof item.state !== 'object') return null;

    const setup = {
        ...item,
        id: String(item.id || `canvas_setup_${Date.now()}_${Math.random().toString(16).slice(2)}`),
        name: String(item.name || '이름 없는 캔버스').trim() || '이름 없는 캔버스',
        savedAt: Number(item.savedAt || Date.now()),
        width: Number(item.width || item.state?.width || 0),
        height: Number(item.height || item.state?.height || 0),
        layerCount: Number(item.layerCount || countLayersInSavedState(item.state) || 0),
        saveMode: String(item.saveMode || 'normal')
    };

    return setup;
}

function normalizeSavedCanvasSetupsList(list) {
    const result = [];
    const seen = new Set();

    (Array.isArray(list) ? list : []).forEach((item) => {
        const normalized = normalizeSavedCanvasSetupItem(item);
        if (!normalized) return;

        if (seen.has(normalized.id)) {
            normalized.id = `${normalized.id}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        }

        seen.add(normalized.id);
        result.push(normalized);
    });

    result.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return result;
}

function mergeSavedCanvasSetups(serverList, legacyList) {
    const merged = [];
    const seenIds = new Set();

    normalizeSavedCanvasSetupsList(serverList).forEach((item) => {
        seenIds.add(item.id);
        merged.push(item);
    });

    normalizeSavedCanvasSetupsList(legacyList).forEach((item) => {
        if (seenIds.has(item.id)) {
            const serverItem = merged.find((entry) => entry.id === item.id);
            const serverSavedAt = Number(serverItem?.savedAt || 0);
            const legacySavedAt = Number(item.savedAt || 0);

            // 같은 id인데 브라우저 저장본이 더 최신이면 덮어쓰기
            if (serverItem && legacySavedAt > serverSavedAt) {
                Object.assign(serverItem, item);
            }

            return;
        }

        seenIds.add(item.id);
        merged.push(item);
    });

    merged.sort((a, b) => Number(b.savedAt || 0) - Number(a.savedAt || 0));
    return merged;
}

function readLegacySavedCanvasSetups() {
    try {
        const raw = localStorage.getItem(CANVAS_SAVED_SETUPS_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return normalizeSavedCanvasSetupsList(list);
    } catch (error) {
        console.warn('Legacy saved canvas setups read failed:', error);
        return [];
    }
}

async function loadSavedCanvasSetupsFromServer(force = false) {
    if (!force && Array.isArray(cachedSavedCanvasSetups)) {
        return cachedSavedCanvasSetups;
    }

    if (!force && savedCanvasSetupsLoadPromise) {
        return savedCanvasSetupsLoadPromise;
    }

    const loadRevision = ++savedCanvasSetupsLoadRevision;
    savedCanvasSetupsLoadFailed = false;
    const loadPromise = (async () => {
        try {
            const res = await fetch('/api/canvas/setups');
            const data = await res.json();

            if (!res.ok || data.status !== 'success') {
                throw new Error(data.message || '캔버스 저장본을 불러오지 못했습니다.');
            }

            if (loadRevision !== savedCanvasSetupsLoadRevision) {
                return loadSavedCanvasSetups();
            }

            const serverList = normalizeSavedCanvasSetupsList(data.setups);
            const legacyList = data.allowLegacyMigration === false ? [] : readLegacySavedCanvasSetups();

            if (legacyList.length) {
                const merged = mergeSavedCanvasSetups(serverList, legacyList);
                const beforeCount = serverList.length;
                const migrationUpserts = merged.filter((item) => {
                    const serverItem = serverList.find((entry) => entry.id === item.id);
                    return !serverItem || Number(item.savedAt || 0) > Number(serverItem.savedAt || 0);
                });

                cachedSavedCanvasSetups = merged;
                const saveOk = migrationUpserts.length === 0 || await persistSavedCanvasSetups(merged, {
                    upserts: migrationUpserts,
                    removeIds: []
                });

                if (saveOk) {
                    const addedCount = Math.max(0, merged.length - beforeCount);
                    canvasLegacySetupMigrationMessage =
                        `브라우저에 남아 있던 캔버스 저장본 ${legacyList.length}개를 확인했고, 서버 저장본과 병합했습니다.` +
                        (addedCount ? ` 새로 복구된 저장본: ${addedCount}개.` : '');

                    // 기존 localStorage 데이터는 삭제하지 않는다.
                    // 사용자가 직접 확인할 수 있도록 남겨두되, 앞으로 저장은 서버 JSON에만 한다.
                }
            } else {
                cachedSavedCanvasSetups = serverList;
            }

            return cachedSavedCanvasSetups;
        } catch (error) {
            console.warn('Saved canvas setups server load failed:', error);
            if (loadRevision === savedCanvasSetupsLoadRevision) {
                savedCanvasSetupsLoadFailed = true;
                cachedSavedCanvasSetups = [];
            }
            return loadSavedCanvasSetups();
        } finally {
            if (savedCanvasSetupsLoadPromise === loadPromise) savedCanvasSetupsLoadPromise = null;
        }
    })();

    savedCanvasSetupsLoadPromise = loadPromise;
    return loadPromise;
}

function loadSavedCanvasSetups() {
    return Array.isArray(cachedSavedCanvasSetups) ? cachedSavedCanvasSetups : [];
}

function persistSavedCanvasSetups(list, patch = undefined) {
    cachedSavedCanvasSetups = normalizeSavedCanvasSetupsList(list);
    const revision = ++savedCanvasSetupsSaveRevision;
    // An earlier response must not replace the contents of a later queued save.
    const bodyData = patch === undefined
        ? {setups: cachedSavedCanvasSetups}
        : {
            upserts: normalizeSavedCanvasSetupsList(patch.upserts),
            removeIds: Array.isArray(patch.removeIds) ? patch.removeIds.slice() : []
        };
    const body = JSON.stringify(bodyData);

    savedCanvasSetupsSavePromise = savedCanvasSetupsSavePromise
        .catch(() => null)
        .then(async () => {
            // A distinct URL prevents old servers from treating a patch as an empty full list.
            const res = await fetch(patch === undefined ? '/api/canvas/setups' : '/api/canvas/setups/patch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body
            });

            if (patch !== undefined && res.status === 404) {
                throw new Error('NAIM을 종료 후 다시 실행해 주세요. 현재 캔버스는 유지됩니다.');
            }
            const data = await res.json();

            if (!res.ok || data.status !== 'success') {
                throw new Error(data.message || '캔버스 저장본 저장 실패');
            }

            if (revision === savedCanvasSetupsSaveRevision) {
                cachedSavedCanvasSetups = normalizeSavedCanvasSetupsList(data.setups || cachedSavedCanvasSetups);
            }
            return true;
        })
        .catch((error) => {
            console.warn('Saved canvas setups server save failed:', error);
            if (typeof showToast === 'function') {
                showToast(`⚠️ 캔버스 저장본 저장 실패: ${error.message || error}`);
            }
            return false;
        });

    return savedCanvasSetupsSavePromise;
}

function saveCurrentCanvasSetup() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('저장할 캔버스가 없습니다.');
        return;
    }

    const activeSavedItem = activeCanvasSetupId
        ? loadSavedCanvasSetups().find((item) => item.id === activeCanvasSetupId)
        : null;

    const defaultName = activeSavedItem?.name || window.CanvasProject?.localLink()?.name
        || `캔버스 ${currentCanvasWidth}×${currentCanvasHeight}`;
    const nameInput = el('canvasSaveNameInput');

    if (nameInput) {
        nameInput.value = defaultName;
        requestAnimationFrame(() => {
            nameInput.focus();
            nameInput.select();
        });
    }

    const normalOption = document.querySelector('input[name="canvasSaveMode"][value="normal"]');
    if (normalOption) normalOption.checked = true;

    const modal = el('canvasSaveOptionsModal');
    if (modal) {
        modal.style.display = 'flex';
    }
}

async function confirmSaveCurrentCanvasSetup() {
    if (!currentCanvasWidth || !currentCanvasHeight) {
        alert('저장할 캔버스가 없습니다.');
        return;
    }

    const name = String(el('canvasSaveNameInput')?.value || '').trim();
    if (!name) {
        alert('저장 이름을 입력해 주세요.');
        return;
    }

    const mode = getSelectedCanvasSaveMode();

    try {
        const snapshot = mode === 'imageOnly'
            ? await buildMergedOnlyCanvasStateSnapshot()
            : buildCanvasStateSnapshot();

        const saveOptions = {
            mode,
            layerCount: countLayersInSavedState(snapshot)
        };

        const activeSavedItem = activeCanvasSetupId
            ? loadSavedCanvasSetups().find((item) => item.id === activeCanvasSetupId)
            : null;

        const sameNameItem = findCanvasSetupByName(name);
        const overwriteTarget = activeSavedItem || sameNameItem || null;

        if (overwriteTarget) {
            const ok = confirm(
                `'${overwriteTarget.name}' 저장본을 덮어쓸까요?\n\n` +
                '취소하면 새 저장본으로 추가합니다.'
            );

            if (ok) {
                await updateCanvasSetupItem(overwriteTarget.id, name, snapshot, saveOptions);
            } else {
                await saveCanvasSetupItem(name, snapshot, saveOptions);
            }
        } else {
            await saveCanvasSetupItem(name, snapshot, saveOptions);
        }

        closeCanvasSaveOptionsModal();

        if (mode === 'mergeAfterSave') {
            await replaceCurrentCanvasWithMergedImage();
            alert(`'${name}' 저장 완료\n현재 캔버스는 통합 이미지 1장만 남겼습니다.`);
            return;
        }

        if (mode === 'resetAfterSave') {
            if (!await resetCurrentCanvasAfterSave()) return;
            alert(`'${name}' 저장 완료\n현재 캔버스를 초기화했습니다.`);
            return;
        }

        if (mode === 'imageOnly') {
            alert(`'${name}' 그림만 저장 완료`);
            return;
        }

        alert(`'${name}' 저장 완료`);

    } catch (error) {
        alert(`저장 실패: ${error.message || error}`);
    }
}

async function openSavedCanvasSetupsModal() {
    const modal = el('savedCanvasSetupsModal');
    if (!modal || !ensureSavedCanvasGalleryControls()) return;
    if (modal.style.display === 'flex' && !savedCanvasGalleryLoading) return;

    modal.style.display = 'flex';
    const revision = ++savedCanvasGalleryRevision;
    savedCanvasGalleryLoading = true;
    renderSavedCanvasSetupList();

    await loadSavedCanvasGallery(true);
    if (revision !== savedCanvasGalleryRevision || modal.style.display !== 'flex') return;
    savedCanvasGalleryLoading = false;
    renderSavedCanvasSetupList();
}

function closeSavedCanvasSetupsModal() {
    savedCanvasGalleryRevision++;
    savedCanvasGalleryLoading = false;
    savedCanvasGalleryPreviewManager?.dispose();
    savedCanvasGalleryPreviewManager = null;
    closeSavedCanvasSetupPreview();
    const modal = el('savedCanvasSetupsModal');
    if (modal) modal.style.display = 'none';
}

function loadSavedCanvasGallery(force = false) {
    if (savedCanvasGalleryPendingLoad) return savedCanvasGalleryPendingLoad;
    const currentLoad = savedCanvasSetupsLoadPromise;
    const request = currentLoad || loadSavedCanvasSetupsFromServer(force);
    const pending = Promise.resolve(request).finally(() => {
        if (savedCanvasGalleryPendingLoad === pending) savedCanvasGalleryPendingLoad = null;
    });
    savedCanvasGalleryPendingLoad = pending;
    return pending;
}

function retrySavedCanvasSetupsLoad() {
    const modal = el('savedCanvasSetupsModal');
    if (!modal || modal.style.display !== 'flex' || savedCanvasGalleryLoading) return;
    const revision = ++savedCanvasGalleryRevision;
    savedCanvasGalleryLoading = true;
    savedCanvasSetupsLoadFailed = false;
    renderSavedCanvasSetupList();
    loadSavedCanvasGallery(true).then(() => {
        if (revision !== savedCanvasGalleryRevision || modal.style.display !== 'flex') return;
        savedCanvasGalleryLoading = false;
        renderSavedCanvasSetupList();
    });
}

function ensureSavedCanvasGalleryControls() {
    const modal = el('savedCanvasSetupsModal');
    const content = modal?.querySelector('.saved-canvas-modal');
    const listEl = el('savedCanvasSetupList');
    if (!content || !listEl) return null;

    let toolbar = content.querySelector('.saved-canvas-toolbar');
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'saved-canvas-toolbar';

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'saved-canvas-search';
        search.placeholder = '이름으로 검색';
        search.setAttribute('aria-label', '저장한 캔버스 이름 검색');
        search.addEventListener('input', () => {
            savedCanvasGallerySearchTerm = search.value.trim().toLocaleLowerCase();
            renderSavedCanvasSetupList();
        });

        const count = document.createElement('span');
        count.className = 'saved-canvas-result-count';
        count.setAttribute('aria-live', 'polite');

        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'secondary saved-canvas-retry';
        retry.textContent = '다시 불러오기';
        retry.hidden = true;
        retry.addEventListener('click', retrySavedCanvasSetupsLoad);

        const notice = document.createElement('div');
        notice.className = 'saved-canvas-migration-notice';
        notice.hidden = true;
        notice.setAttribute('role', 'status');

        toolbar.append(search, count, retry, notice);
        content.insertBefore(toolbar, listEl);
    }

    let dialog = document.getElementById('savedCanvasPreviewDialog');
    if (!dialog) {
        dialog = document.createElement('dialog');
        dialog.id = 'savedCanvasPreviewDialog';
        dialog.className = 'saved-canvas-preview-dialog';
        dialog.setAttribute('aria-labelledby', 'savedCanvasPreviewTitle');

        const header = document.createElement('div');
        header.className = 'saved-canvas-preview-header';
        const title = document.createElement('h3');
        title.id = 'savedCanvasPreviewTitle';
        title.textContent = '캔버스 미리보기';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'icon-btn danger';
        close.setAttribute('aria-label', '미리보기 닫기');
        close.textContent = '×';
        close.addEventListener('click', () => dialog.close());
        header.append(title, close);

        const body = document.createElement('div');
        body.className = 'saved-canvas-preview-body';
        body.setAttribute('role', 'status');
        dialog.append(header, body);
        dialog.addEventListener('close', () => {
            if (!dialog.open) disposeSavedCanvasSetupPreviewManager();
        });
        document.body.appendChild(dialog);
    }

    return {
        listEl,
        search: toolbar.querySelector('.saved-canvas-search'),
        count: toolbar.querySelector('.saved-canvas-result-count'),
        retry: toolbar.querySelector('.saved-canvas-retry'),
        notice: toolbar.querySelector('.saved-canvas-migration-notice'),
        dialog,
        dialogTitle: dialog.querySelector('#savedCanvasPreviewTitle'),
        dialogBody: dialog.querySelector('.saved-canvas-preview-body'),
    };
}

function appendSavedCanvasGalleryMessage(listEl, message) {
    const empty = document.createElement('div');
    empty.className = 'saved-canvas-empty';
    empty.textContent = message;
    listEl.appendChild(empty);
}

function renderSavedCanvasSetupList() {
    const controls = ensureSavedCanvasGalleryControls();
    if (!controls) return;
    const {listEl, count, retry, notice} = controls;
    savedCanvasGalleryPreviewManager?.dispose();
    savedCanvasGalleryPreviewManager = null;
    listEl.replaceChildren();
    notice.textContent = canvasLegacySetupMigrationMessage || '';
    notice.hidden = !canvasLegacySetupMigrationMessage;

    if (savedCanvasGalleryLoading) {
        retry.hidden = true;
        count.textContent = '불러오는 중';
        appendSavedCanvasGalleryMessage(listEl, '저장한 캔버스를 불러오는 중…');
        return;
    }

    if (savedCanvasSetupsLoadFailed) {
        retry.hidden = false;
        count.textContent = '불러오지 못했습니다';
        appendSavedCanvasGalleryMessage(listEl, '저장한 캔버스를 불러오지 못했습니다. 다시 시도해 주세요.');
        return;
    }

    retry.hidden = true;
    const list = loadSavedCanvasSetups();
    const searchTerm = savedCanvasGallerySearchTerm;
    const filtered = searchTerm
        ? list.filter((item) => String(item.name || '').toLocaleLowerCase().includes(searchTerm))
        : list;
    count.textContent = searchTerm ? `${filtered.length} / ${list.length}개` : `${list.length}개`;

    if (!list.length) {
        appendSavedCanvasGalleryMessage(listEl, '저장된 캔버스가 없습니다.');
        return;
    }
    if (!filtered.length) {
        appendSavedCanvasGalleryMessage(listEl, '검색 결과가 없습니다.');
        return;
    }

    savedCanvasGalleryPreviewManager = window.DakiCanvasPreviews?.create?.() || null;
    filtered.forEach((item) => {
        const dateText = formatSavedCanvasDate(item.savedAt);
        const layerCount = item.layerCount ?? countLayersInSavedState(item.state);
        const modeLabel = getCanvasSaveModeLabel(item.saveMode);

        const row = document.createElement('div');
        row.className = 'saved-canvas-item';

        const thumbnail = document.createElement('button');
        thumbnail.type = 'button';
        thumbnail.className = 'saved-canvas-thumbnail';
        thumbnail.title = `${item.name || '이름 없는 캔버스'} 미리보기 크게 보기`;
        thumbnail.setAttribute('aria-label', thumbnail.title);
        const preview = document.createElement('div');
        preview.className = 'saved-canvas-thumbnail-preview';
        preview.setAttribute('aria-label', `${item.name || '이름 없는 캔버스'} 합성 미리보기`);
        thumbnail.appendChild(preview);
        thumbnail.addEventListener('click', () => openSavedCanvasSetupPreview(item));

        const info = document.createElement('div');
        info.className = 'saved-canvas-info';
        const name = document.createElement('div');
        name.className = 'saved-canvas-name';
        name.textContent = item.name || '이름 없는 캔버스';
        name.title = name.textContent;
        const meta = document.createElement('div');
        meta.className = 'saved-canvas-meta';
        meta.textContent = `${item.width || item.state?.width || '?'} × ${item.height || item.state?.height || '?'} · 레이어 ${layerCount}개 · ${dateText} · ${modeLabel}`;
        info.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'saved-canvas-actions';
        const addAction = (label, className, action) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = className;
            button.textContent = label;
            button.addEventListener('click', action);
            actions.appendChild(button);
        };
        addAction('불러오기', 'secondary', () => loadCanvasSetup(item.id));
        addAction('이름 변경', 'secondary', () => renameCanvasSetup(item.id));
        addAction('삭제', 'danger', () => deleteCanvasSetup(item.id));

        row.append(thumbnail, info, actions);
        listEl.appendChild(row);
        if (savedCanvasGalleryPreviewManager) {
            savedCanvasGalleryPreviewManager.observeState(preview, item);
        } else {
            preview.textContent = '미리보기를 사용할 수 없습니다.';
        }
    });
}

function openSavedCanvasSetupPreview(item) {
    const controls = ensureSavedCanvasGalleryControls();
    if (!controls) return;
    closeSavedCanvasSetupPreview();
    controls.dialogTitle.textContent = item.name || '이름 없는 캔버스';
    controls.dialogBody.replaceChildren();
    controls.dialogBody.textContent = '불러오는 중…';
    controls.dialog.showModal();
    savedCanvasGalleryDialogManager = window.DakiCanvasPreviews?.create?.() || null;
    if (savedCanvasGalleryDialogManager) {
        savedCanvasGalleryDialogManager.observeState(controls.dialogBody, item);
    } else {
        controls.dialogBody.textContent = '통합 그림을 표시할 수 없습니다.';
    }
}

function closeSavedCanvasSetupPreview() {
    disposeSavedCanvasSetupPreviewManager();
    const dialog = document.getElementById('savedCanvasPreviewDialog');
    if (dialog?.open) dialog.close();
}

function disposeSavedCanvasSetupPreviewManager() {
    savedCanvasGalleryDialogManager?.dispose();
    savedCanvasGalleryDialogManager = null;
}

function formatSavedCanvasDate(timestamp) {
    if (!timestamp) return '날짜 없음';

    const date = new Date(timestamp);

    if (Number.isNaN(date.getTime())) return '날짜 없음';

    return date.toLocaleString();
}

function countLayersInSavedState(state) {
    if (!state || !Array.isArray(state.layers)) return 0;

    const scan = (layers) => {
        return layers.reduce((count, layer) => {
            const children = Array.isArray(layer.children) ? scan(layer.children) : 0;
            return count + 1 + children;
        }, 0);
    };

    return scan(state.layers);
}

async function loadCanvasSetup(setupId) {
    const galleryRevision = savedCanvasGalleryRevision;
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item || !item.state) {
        alert('저장본을 찾을 수 없습니다.');
        return;
    }

    const ok = confirm(`'${item.name}' 캔버스를 불러올까요?\n현재 캔버스 작업 상태는 자동 저장 슬롯에서 덮어써집니다.`);
    if (!ok) return;

    if (window.CanvasProject && !await CanvasProject.leave()) return;
    applyCanvasStateSnapshot(item.state);
    activeCanvasSetupId = item.id;

    if (isSavedCanvasGalleryOpen(galleryRevision)) closeSavedCanvasSetupsModal();
}

async function renameCanvasSetup(setupId) {
    const galleryRevision = savedCanvasGalleryRevision;
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item) return;

    const nextName = prompt('새 이름을 입력하세요.', item.name || '');
    if (!nextName || !nextName.trim()) return;

    item.name = nextName.trim();
    item.savedAt = Date.now();

    const saved = await persistSavedCanvasSetups(list, {upserts: [item], removeIds: []});
    if (!saved) {
        if (isSavedCanvasGalleryOpen(galleryRevision)) alert('이름 변경 저장에 실패했습니다.');
        return;
    }
    if (isSavedCanvasGalleryOpen(galleryRevision)) renderSavedCanvasSetupList();
}

async function deleteCanvasSetup(setupId) {
    const galleryRevision = savedCanvasGalleryRevision;
    const list = loadSavedCanvasSetups();
    const item = list.find((entry) => entry.id === setupId);

    if (!item) return;

    const ok = confirm(`'${item.name}' 저장본을 삭제할까요?`);
    if (!ok) return;

    const detachedRefs = collectCanvasImportRefsFromLayer(item.state);
    const nextList = list.filter((entry) => entry.id !== setupId);
    const saved = await persistSavedCanvasSetups(nextList, {upserts: [], removeIds: [setupId]});
    if (!saved) {
        if (isSavedCanvasGalleryOpen(galleryRevision)) alert('캔버스 저장본 삭제에 실패했습니다.');
        return;
    }

    if (activeCanvasSetupId === setupId) {
        activeCanvasSetupId = null;
    }
    if (isSavedCanvasGalleryOpen(galleryRevision)) renderSavedCanvasSetupList();
    cleanupDetachedCanvasImportRefs(detachedRefs);
}

function isSavedCanvasGalleryOpen(revision) {
    const modal = el('savedCanvasSetupsModal');
    return revision === savedCanvasGalleryRevision && modal?.style.display === 'flex';
}

function applyCanvasStateSnapshot(state, options = {}) {
    if (!state || !state.width || !state.height) {
        alert('불러올 수 없는 캔버스 저장본입니다.');
        return;
    }

    currentCanvasWidth = parseInt(state.width, 10) || 0;
    currentCanvasHeight = parseInt(state.height, 10) || 0;
    canvasLayers = Array.isArray(state.layers) ? structuredClone(state.layers) : [];
    activeLayerId = state.activeLayerId || canvasLayers[0]?.id || null;
    layerIdSeq = parseInt(state.layerIdSeq, 10) || (canvasLayers.length + 1);
    if (typeof getCanvasStyleLink === 'function') getCanvasStyleLink()?.restore(state.styleLink);
    if (typeof CanvasProjectSettings !== 'undefined') CanvasProjectSettings.restore(state.projectSettingsLink);
    if (typeof CanvasDakiFocus !== 'undefined') CanvasDakiFocus.restore(state.dakiBodyMap);
    if (!options.fromHistory && typeof CanvasRetouch !== 'undefined') CanvasRetouch.restore(state.retouchDraft);
    if (!options.fromHistory && typeof CanvasOppositeReference !== 'undefined') CanvasOppositeReference.restore(state.oppositeReference);
    if (typeof CanvasInpaintReference !== 'undefined') CanvasInpaintReference.restore(state.inpaintReference);
    if (typeof CanvasInpaintSettings !== 'undefined') {
        CanvasInpaintSettings.restore(Object.prototype.hasOwnProperty.call(state, 'inpaintSettings')
            ? state.inpaintSettings
            : null);
    }
    const restoredClipPromptGroups = normalizeSharedPromptGroups(state.clipPromptGroups || []);
    if (restoredClipPromptGroups.length) {
        clipPromptGroups = mergePromptGroupLists(clipPromptGroups, restoredClipPromptGroups);
        saveSharedClipPromptGroups(true).catch((error) => {
            console.warn('캔버스 저장본의 프롬프트 그룹 공유 저장 실패:', error);
        });
    }

    sharedSelectionClipPromptInfo = state.sharedSelectionClipPromptInfo
        ? normalizePromptInfo(state.sharedSelectionClipPromptInfo)
        : null;

    sharedSelectionClipPromptControlGroups = Array.isArray(state.sharedSelectionClipPromptControlGroups)
        ? structuredClone(state.sharedSelectionClipPromptControlGroups)
        : [];

    isSelectionOverlayHidden = Boolean(state.isSelectionOverlayHidden);
    checkedSelectionId = state.checkedSelectionId || null;

    if (typeof canvasZoom !== 'undefined') {
        canvasZoom = Number(state.canvasZoom) || 1;
    }

    if (typeof clipPreviewZoom !== 'undefined') {
        clipPreviewZoom = Number(state.clipPreviewZoom) || 1;
    }

    isClipInpaintMergedSourceMode = Boolean(state.isClipInpaintMergedSourceMode);

    normalizeCanvasLayerTree(canvasLayers);

    const needsLegacyPromptMigration = Number(state.version || 0) < 2;

    if (needsLegacyPromptMigration) {
        if (typeof migratePromptOwnersAndControlGroups === 'function') {
            migratePromptOwnersAndControlGroups();
        }

        if (typeof forceSharePromptControlsByImageOwner === 'function') {
            forceSharePromptControlsByImageOwner();
        }
    }

    // 최신 구조에서는 clip → owner 병합 금지.
    // owner → clip 복사본 동기화만 수행.
    syncAllPromptCopiesFromOwners();

    // 선택 영역 클립들은 다시 공용 프롬프트 owner 하나를 공유하도록 강제
    migrateAllSelectionClipsToSharedPromptOwner();

    if (typeof syncClipPromptControlGroupSeqFromAllLayers === 'function') {
        syncClipPromptControlGroupSeqFromAllLayers();
    }

    if (typeof refreshPinnedReferenceStateFromLayers === 'function') {
        refreshPinnedReferenceStateFromLayers();
    }

    ensureCheckedSelectionId();
    updateSelectionOverlayToggleUI();

    if (currentCanvasWidth && currentCanvasHeight) {
        renderCanvas(currentCanvasWidth, currentCanvasHeight);
        renderLayerList();
    } else {
        renderLayerList();
    }

    updateCanvasRatioInfo();
    if (!options.fromHistory) {
        migrateCanvasLayerDataUrlsToServer();
        if (typeof resetCanvasEditHistory === 'function') resetCanvasEditHistory();
    }
}

