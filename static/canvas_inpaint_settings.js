(function (root) {
    let settings = null;
    let revision = 0;
    let dialogToken = 0;
    let opener = null;
    let formDirty = false;

    const doc = root.document;

    function generationSettingsFrom(value) {
        const normalized = normalizePromptInfo(value || {});
        let effective = normalized;
        if (doc?.getElementById('inpaintGenerationSettings')
            && typeof setGenerationSettings === 'function'
            && typeof readGenerationSettings === 'function') {
            setGenerationSettings('inpaint', normalized);
            effective = readGenerationSettings('inpaint') || normalized;
        }
        return Object.fromEntries(NAI_GENERATION_FIELDS.map(field => [field.key, effective[field.key]]));
    }

    function apply(promptInfo) {
        return {
            ...normalizePromptInfo(promptInfo || {}),
            ...(settings ? {...settings} : {})
        };
    }

    function snapshot() {
        return settings ? {...settings} : null;
    }

    function restore(value) {
        settings = value && typeof value === 'object' ? generationSettingsFrom(value) : null;
        revision += 1;
        syncOpenClipEditor();
    }

    function hasGenerationSettings(value) {
        if (!value || typeof value !== 'object') return false;
        if (Object.prototype.hasOwnProperty.call(value, '__hasGenerationSettings')) {
            return value.__hasGenerationSettings === true;
        }
        return NAI_GENERATION_FIELDS.some(field => Object.prototype.hasOwnProperty.call(value, field.key))
            || Object.prototype.hasOwnProperty.call(value, 'scale');
    }

    function seed(promptInfo) {
        if (settings || !hasGenerationSettings(promptInfo)) return false;
        settings = generationSettingsFrom(promptInfo);
        revision += 1;
        syncOpenClipEditor();
        return true;
    }

    function update(value) {
        settings = generationSettingsFrom(value);
        revision += 1;
        syncOpenClipEditor();
        return snapshot();
    }

    function syncOpenClipEditor() {
        const modal = doc?.getElementById('clipPromptModalOverlay');
        if (!modal?.classList?.contains('open') || typeof setGenerationSettings !== 'function') return;
        setGenerationSettings('clip', apply({}));
    }

    function hasCanvas() {
        return Number(typeof currentCanvasWidth === 'undefined' ? 0 : currentCanvasWidth) > 0
            && Number(typeof currentCanvasHeight === 'undefined' ? 0 : currentCanvasHeight) > 0;
    }

    function getDialog() {
        return doc?.getElementById('canvasInpaintSettingsDialog') || null;
    }

    function focusOpener() {
        const target = opener;
        opener = null;
        if (target?.isConnected && !target.disabled && typeof target.focus === 'function') target.focus();
    }

    function close() {
        dialogToken += 1;
        const dialog = getDialog();
        if (dialog?.open) dialog.close();
        focusOpener();
    }

    function markFormDirty() {
        formDirty = true;
    }

    async function refreshFallbackSettings(token, startRevision) {
        if (typeof getCanvasExportPromptInfoAsync !== 'function') return;
        try {
            const info = await getCanvasExportPromptInfoAsync();
            const dialog = getDialog();
            if (!dialog?.open || token !== dialogToken || startRevision !== revision || formDirty) return;
            setGenerationSettings('inpaint', apply(info));
        } catch (error) {
            console.warn('Canvas inpainting settings recovery failed:', error);
        }
    }

    function open() {
        if (!hasCanvas()) {
            root.showToast?.('먼저 캔버스를 만들어 주세요.');
            return;
        }
        const dialog = getDialog();
        if (!dialog || dialog.open) return;
        opener = doc.activeElement;
        formDirty = false;
        const token = ++dialogToken;
        const startRevision = revision;
        setGenerationSettings('inpaint', apply(typeof getCanvasExportPromptInfo === 'function'
            ? getCanvasExportPromptInfo()
            : {}));
        dialog.showModal();
        doc.getElementById('inpaintModel')?.focus();
        if (!settings) void refreshFallbackSettings(token, startRevision);
    }

    function save(event) {
        event?.preventDefault();
        const values = readGenerationSettings('inpaint');
        if (!values) return;
        update(values);
        if (typeof saveCanvasState === 'function') saveCanvasState();
        close();
        root.showToast?.('캔버스 인페인팅 설정을 저장했습니다.');
    }

    function bindDialog() {
        const dialog = getDialog();
        const form = doc?.getElementById('canvasInpaintSettingsForm');
        if (!dialog || !form) return;
        form.addEventListener('submit', save);
        form.addEventListener('input', markFormDirty);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            close();
        });
        for (const type of ['keydown', 'paste', 'copy', 'cut']) {
            dialog.addEventListener(type, event => event.stopPropagation());
        }
        doc.getElementById('canvasInpaintSettingsClose')?.addEventListener('click', close);
        doc.getElementById('canvasInpaintSettingsCancel')?.addEventListener('click', close);
        doc.getElementById('canvasInpaintSettingsBtn')?.addEventListener('click', open);
    }

    root.CanvasInpaintSettings = {apply, update, snapshot, restore, seed, hasGenerationSettings, open, close};
    bindDialog();
})(window);
