// Keyboard behavior only. Existing callbacks still own visibility and saved data.
const CANVAS_DIALOGS = [
    {id: 'canvasDetailPresetModal', focus: 'canvasDetailPresetTitle', close: 'closeCanvasDetailPresetManager'},
    {id: 'canvasStyleLinkModal', focus: 'canvasStyleLinkTitle', close: 'closeCanvasStyleLinkPicker'},
    {id: 'canvasCreateModal', focus: 'canvasWidthInput', close: 'closeCanvasDialog'},
    {id: 'clipPromptModalOverlay', focus: 'clipPromptTitle', close: 'closeClipPromptModal', portals: [
        {id: 'clipGroupSelectionPopover', close: 'hideClipGroupSelectionPopover'},
        {id: 'tagTranslationModal', close: 'closeTagTranslationModal'},
        {id: 'temporaryClipPromptGroupMenu', close: 'closeTemporaryClipPromptGroupMenu'}
    ]},
    {id: 'clipPromptGroupModal', focus: 'clipPromptGroupTitle', close: 'closeClipPromptGroupManager'},
    {id: 'savedCanvasSetupsModal', focus: 'savedCanvasSetupsTitle', close: 'closeSavedCanvasSetupsModal', portals: [
        {id: 'savedCanvasPreviewDialog', close: 'closeSavedCanvasSetupPreview'}
    ]},
    {id: 'canvasSaveOptionsModal', focus: 'canvasSaveNameInput', close: 'closeCanvasSaveOptionsModal'}
];

function closeCanvasDetailPresetManager() {
    if (typeof CanvasDetailPresets !== 'undefined') CanvasDetailPresets.closeManager();
}

function createCanvasDialogController(doc, win, registrations = CANVAS_DIALOGS) {
    const records = registrations.map(config => ({...config, node: doc.getElementById(config.id), open: false})).filter(item => item.node);
    const inertBefore = new Map();
    const boundRoots = new WeakSet();
    let stack = [];
    let initialized = false;
    let redirectingFocus = false;
    const topDialog = () => stack[stack.length - 1];
    const visible = node => Boolean(node?.isConnected && !node.hidden && win.getComputedStyle(node).display !== 'none');
    const usable = node => Boolean(visible(node) && !node.disabled && !node.closest('[inert]') && node.getClientRects().length && win.getComputedStyle(node).visibility !== 'hidden');
    const portals = record => (record.portals || []).map(config => ({...config, node: doc.getElementById(config.id)})).filter(item => item.node);
    const roots = record => {
        const openPortals = portals(record).filter(item => visible(item.node)).map(item => item.node);
        const nativeDialog = openPortals.find(node => node.tagName === 'DIALOG' && node.open);
        return nativeDialog ? [nativeDialog] : [record.node, ...openPortals];
    };
    const contains = (record, node) => roots(record).some(root => root.contains(node));

    function focusInitial(record) {
        const initial = doc.getElementById(record.focus);
        // Reopening a long, previously scrolled dialog must reveal its title.
        if (usable(initial)) initial.focus();
    }

    function bindRootEvents(record) {
        // A temporary group menu is recreated after initialization. Resolve only
        // the named roots while a dialog is active, without observing the body.
        for (const node of [record.node, ...portals(record).map(item => item.node)]) {
            if (boundRoots.has(node)) continue;
            boundRoots.add(node);
            for (const type of ['keydown', 'paste', 'copy', 'cut']) {
                node.addEventListener(type, event => {
                    if (topDialog() && contains(topDialog(), node)) event.stopPropagation();
                });
            }
        }
    }

    function updateInert(record) {
        for (const [node, original] of inertBefore) node.inert = original;
        inertBefore.clear();
        if (!record) return;
        // Only inspect direct body children on modal transitions, never the image tree.
        // Named portal roots stay available when their existing callbacks show them.
        const allowed = [record.node, ...portals(record).map(item => item.node)];
        for (const node of doc.body.children) {
            if (['SCRIPT', 'STYLE', 'LINK'].includes(node.tagName) || allowed.some(root => node === root || node.contains(root))) continue;
            inertBefore.set(node, node.inert);
            node.inert = true;
        }
    }

    function sync() {
        const previous = topDialog();
        for (const record of records) {
            const isOpen = visible(record.node);
            if (isOpen && !record.open) {
                record.opener = doc.activeElement;
                stack.push(record);
            } else if (!isOpen && record.open) {
                stack = stack.filter(item => item !== record);
            }
            record.open = isOpen;
        }
        const current = topDialog();
        if (current === previous) return;
        updateInert(current);
        if (previous && !previous.open) {
            const opener = previous.opener;
            if (usable(opener) && opener !== doc.body && (!current || contains(current, opener))) {
                opener.focus({preventScroll: true});
                return;
            }
        }
        if (current) focusInitial(current);
        else if (previous) doc.getElementById('canvasWorkspace')?.focus({preventScroll: true});
    }

    function tabbable(record) {
        const selector = 'button, input, select, textarea, summary, a[href], [tabindex], [contenteditable="true"]';
        const elements = roots(record).flatMap(root => [...root.querySelectorAll(selector)]).filter(node => usable(node) && node.tabIndex >= 0 && !node.matches(':disabled'));
        return elements.filter(node => {
            if (node.type !== 'radio' || !node.name) return true;
            const group = elements.filter(item => item.type === 'radio' && item.name === node.name);
            return node === (group.find(item => item.checked) || group[0]);
        });
    }

    function onKeyDown(event) {
        const record = topDialog();
        if (!record) return;
        bindRootEvents(record);
        if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') {
            // Token editors already use Escape to cancel their own inline edit.
            if (event.target?.matches('.prompt-token-edit')) return;
            const portal = portals(record).find(item => visible(item.node) && item.node.contains(event.target));
            const close = win[portal?.close || record.close];
            if (typeof close !== 'function') return;
            event.preventDefault();
            event.stopPropagation();
            close();
            if (portal) focusInitial(record);
            sync();
        } else if (event.key === 'Tab') {
            const elements = tabbable(record);
            const first = elements[0];
            const last = elements[elements.length - 1];
            const active = doc.activeElement;
            if (!first) {
                event.preventDefault();
                focusInitial(record);
            } else if (!elements.includes(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        }
    }

    function onFocusIn(event) {
        const record = topDialog();
        if (!record) return;
        bindRootEvents(record);
        if (redirectingFocus || contains(record, event.target)) return;
        redirectingFocus = true;
        focusInitial(record);
        redirectingFocus = false;
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        for (const record of records) {
            const observer = new win.MutationObserver(sync);
            observer.observe(record.node, {attributes: true, attributeFilter: ['style', 'class', 'hidden']});
            // Keep canvas-level shortcuts and image paste handlers out of dialogs;
            // native editing and handlers on the dialog's own children still run.
            bindRootEvents(record);
        }
        doc.addEventListener('keydown', onKeyDown, true);
        doc.addEventListener('focusin', onFocusIn);
        sync();
    }
    return {initialize, sync};
}

if (typeof module === 'object' && module.exports) module.exports = {createCanvasDialogController, CANVAS_DIALOGS};
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => createCanvasDialogController(document, window).initialize());
}
