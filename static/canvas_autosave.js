const canvasPlacementRecords = new WeakMap();

function clearCanvasPlacementBackup(storage, key) {
    storage.removeItem(key + ':inpaint-placement');
    canvasPlacementRecords.get(storage)?.delete(key);
}

function readCanvasPlacementBackup(storage, key, state) {
    try {
        const raw = storage.getItem(key + ':inpaint-placement');
        if (!raw) return null;
        const record = JSON.parse(raw);
        if (record.projectId !== (state.projectLink?.projectId ?? null) ||
            record.canvasId !== (state.projectLink?.canvasId ?? null) ||
            record.setupId !== (state.workspaceSetupId ?? null)) return null;
        // A pre-reference editor can replace an anonymous slot with an unrelated document.
        // A populated document keeps its own backup on a layer.
        if (state.inpaintReference === undefined && !record.canvasId && !record.setupId &&
            (state.layers?.length || record.emptyWidth !== state.width || record.emptyHeight !== state.height)) return null;
        return record.placement;
    } catch (_) { /* The full document and its layer backup are still available. */ }
    return null;
}

function writeCanvasPlacementBackup(storage, key, state, codec) {
    const placement = codec.backupFor(state.inpaintReference);
    const record = placement ? JSON.stringify({projectId: state.projectLink?.projectId ?? null,
        canvasId: state.projectLink?.canvasId ?? null, setupId: state.workspaceSetupId ?? null, placement,
        ...(!state.layers?.length ? {emptyWidth: state.width, emptyHeight: state.height} : {})}) : null;
    let records = canvasPlacementRecords.get(storage);
    if (!records) {
        records = new Map();
        canvasPlacementRecords.set(storage, records);
    }
    const backupKey = key + ':inpaint-placement';
    const previous = records.has(key) ? records.get(key) : storage.getItem(backupKey);
    if (record !== previous) {
        if (record === null) storage.removeItem(backupKey);
        else storage.setItem(backupKey, record);
    }
    records.set(key, record);
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
    const suffix = ':inpaint-placement';
    if (event.key?.endsWith(suffix) && event.storageArea) {
        canvasPlacementRecords.get(event.storageArea)?.delete(event.key.slice(0, -suffix.length));
    } else if (event.key === null && event.storageArea) canvasPlacementRecords.delete(event.storageArea);
});

// Keep full browser backups unless quota requires the confirmed project copy.
function writeCanvasAutosaveSnapshot(storage, key, text, state, canRestoreFromServer,
    referenceCodec = typeof CanvasInpaintReference === 'undefined' ? null : CanvasInpaintReference) {
    try {
        storage.setItem(key, text);
    } catch (error) {
        if (error?.name !== 'QuotaExceededError' || state.projectLink?.unsaved !== false ||
            !(typeof canRestoreFromServer === 'function' ? canRestoreFromServer() : canRestoreFromServer)) {
            throw error;
        }
        const {savedAt, width, height, projectLink, workspaceSetupId} = state;
        storage.setItem(key, JSON.stringify({projectRestoreOnly: true, savedAt, width, height, projectLink, workspaceSetupId}));
        return 'project';
    }
    if (referenceCodec?.backupFor) writeCanvasPlacementBackup(storage, key, state, referenceCodec);
}

function createCanvasAutosave({snapshot, write, status, canWrite = () => true, isProjectSavePending = () => false,
    setTimer = setTimeout, clearTimer = clearTimeout}) {
    let timer = null;
    let dirty = false;
    let failed = false;
    let lastStatus = null;
    let lastErrorName;
    function report(value, errorName) {
        if (value === lastStatus && errorName === lastErrorName) return;
        lastStatus = value;
        lastErrorName = errorName;
        status(value, errorName);
    }
    function flush() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        if (!dirty) return !failed;
        if (!canWrite()) { dirty = false; return true; }
        try {
            const state = snapshot();
            const storageMode = write(JSON.stringify(state), state);
            dirty = false;
            failed = false;
            report(storageMode === 'project' ? 'project' : 'saved');
            return true;
        } catch (error) {
            failed = true;
            if (error?.name === 'QuotaExceededError' && isProjectSavePending()) {
                report('project-pending');
            } else {
                report('error', error?.name);
            }
            return false;
        }
    }
    return {
        schedule(immediate = false) {
            if (!canWrite()) return true;
            dirty = true;
            if (!failed) report('pending');
            if (immediate) return flush();
            // A fixed window also saves during continuous edits; it cannot starve.
            if (timer === null) timer = setTimer(flush, 200);
            return !failed;
        },
        flush,
        reset() {
            if (timer !== null) clearTimer(timer);
            timer = null;
            dirty = failed = false;
            report('idle');
        }
    };
}
if (typeof module === 'object' && module.exports) module.exports = {createCanvasAutosave, writeCanvasAutosaveSnapshot, readCanvasPlacementBackup};
