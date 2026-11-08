// Presentation only: the gallery uses the modern layout with the same nodes and state.
function createGalleryLayoutController(doc, win) {
    const destinations = [
        ['.header-main', 'galleryModernMain'],
        ['#nav-tabs', 'galleryModernNavigationBody'],
        ['#brand-filter-bar', 'galleryModernFiltersBody'],
        ['.gallery-modern-character-section', 'galleryModernFiltersBody'],
        ['.gallery-header-control-stack', 'galleryModernFiltersBody'],
        ['#char-chip-container', 'galleryModernCharactersBody'],
        ['#breadcrumb-path', 'galleryModernMain'],
        ['.search-wrapper', 'galleryCompactSearch'],
        ['#galleryPromptSearchPanel', 'galleryModernMain'],
        ['#galleryPromptSearchToggle', 'galleryCompactPrompt'],
        ['#galleryTagFilterBar', 'galleryModernMain'],
        ['#galleryTagAssignmentModeStatus', 'galleryModernMain'],
        ['#content', 'galleryModernMain'],
        ['#dakiLibrary', 'galleryModernMain']
    ];
    let initialized = false;

    function getClosest(node, selector) {
        return typeof node?.closest === 'function' ? node.closest(selector) : null;
    }

    function setPopoverOpen(open, restoreFocus = false) {
        const popover = doc.getElementById('galleryFilterPopover');
        const toggle = doc.getElementById('galleryFilterToggle');
        if (!popover || !toggle) return;
        popover.hidden = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionPopover();
        else if (restoreFocus && typeof toggle.focus === 'function') toggle.focus();
    }

    function positionPopover() {
        const popover = doc.getElementById('galleryFilterPopover');
        const toggle = doc.getElementById('galleryFilterToggle');
        if (!popover || !toggle || popover.hidden || typeof toggle.getBoundingClientRect !== 'function') return;

        const rect = toggle.getBoundingClientRect();
        const viewportWidth = Number(win.innerWidth) || Number(doc.documentElement?.clientWidth) || 0;
        const viewportHeight = Number(win.innerHeight) || Number(doc.documentElement?.clientHeight) || 0;
        if (rect.bottom <= 0 || rect.top >= viewportHeight) {
            setPopoverOpen(false);
            return;
        }
        const margin = 16;
        const gap = 6;
        const width = Math.min(Number(popover.offsetWidth) || 380, Math.max(0, viewportWidth - margin * 2));
        const left = Math.max(margin, Math.min(rect.right - width, viewportWidth - width - margin));
        const top = rect.bottom + gap;
        const availableHeight = viewportHeight - top - margin;
        if (availableHeight < 96) {
            setPopoverOpen(false);
            return;
        }
        const maxHeight = Math.min(560, availableHeight);

        popover.style.position = 'fixed';
        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
        popover.style.maxHeight = `${maxHeight}px`;
        popover.style.maxWidth = `${Math.max(0, viewportWidth - margin * 2)}px`;
    }

    function handleCompactToolbar() {
        const toolbar = doc.getElementById('galleryCompactToolbar');
        if (!toolbar) return;

        const viewTarget = doc.getElementById('galleryCompactView');
        if (viewTarget && typeof doc.querySelectorAll === 'function') {
            const galleryViewInput = Array.from(doc.querySelectorAll('input[name="galleryViewMode"]'))[0];
            const galleryViewGroup = getClosest(galleryViewInput, '.gallery-date-control-group');
            if (galleryViewGroup?.parentNode) viewTarget.appendChild(galleryViewGroup);
        }

        const sortSelect = doc.getElementById('galleryCompactSort');
        const sortInputs = typeof doc.querySelectorAll === 'function'
            ? Array.from(doc.querySelectorAll('input[name="sortMode"]'))
            : [];
        const checkedSort = sortInputs.find(input => input.checked);
        if (sortSelect && checkedSort?.value) sortSelect.value = checkedSort.value;
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                const matching = sortInputs.find(input => input.value === sortSelect.value);
                if (!matching) return;
                matching.checked = true;
                if (typeof win.Event === 'function' && typeof matching.dispatchEvent === 'function') {
                    matching.dispatchEvent(new win.Event('change', {bubbles: true}));
                }
            });
        }

        const toggle = doc.getElementById('galleryFilterToggle');
        const popover = doc.getElementById('galleryFilterPopover');
        const closeButton = doc.getElementById('galleryFilterPopoverClose');
        if (!toggle || !popover || !closeButton) return;

        toggle.setAttribute('aria-haspopup', 'dialog');
        toggle.setAttribute('aria-controls', 'galleryFilterPopover');
        toggle.setAttribute('aria-expanded', 'false');
        popover.hidden = true;
        toggle.addEventListener('click', () => setPopoverOpen(popover.hidden));
        closeButton.addEventListener('click', () => setPopoverOpen(false, true));

        doc.addEventListener('click', event => {
            if (popover.hidden) return;
            const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
            if (path.includes(popover) || path.includes(toggle)) return;
            const target = event.target;
            if (popover.contains?.(target) || toggle.contains?.(target)) return;
            setPopoverOpen(false);
        }, true);
        doc.addEventListener('keydown', event => {
            if (!popover.hidden && event.key === 'Escape') {
                event.preventDefault?.();
                setPopoverOpen(false, true);
            }
        });
        win.addEventListener?.('resize', positionPopover);
        win.addEventListener?.('scroll', positionPopover, true);
        win.addEventListener?.('hashchange', () => {
            const hash = String(win.location?.hash || '').slice(1);
            let dakiRoute = false;
            try {
                const params = new URLSearchParams(hash);
                dakiRoute = !params.has('gallery') && (params.has('daki') || params.has('project'));
            } catch (_error) {
                dakiRoute = hash.startsWith('daki') || hash.startsWith('project');
            }
            if (dakiRoute) setPopoverOpen(false);
        });
    }

    function initialize() {
        if (initialized) return;
        const layout = doc.getElementById('galleryModernLayout');
        if (!layout) return;

        initialized = true;
        doc.body.classList.toggle('gallery-layout-modern', true);
        layout.hidden = false;

        if (typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 760px)').matches) {
            const section = doc.getElementById('galleryModernNavSection');
            if (section) section.open = false;
        }

        for (const [selector, targetId] of destinations) {
            const node = doc.querySelector(selector);
            const target = doc.getElementById(targetId);
            if (!node || !target || !node.parentNode || node === target) continue;
            target.appendChild(node);
            if (selector === '#breadcrumb-path') {
                const toolbar = doc.getElementById('galleryCompactToolbar');
                if (toolbar?.parentNode === target) target.appendChild(toolbar);
            }
        }
        handleCompactToolbar();
    }

    function setMode(_value, _persist = true) {
        initialize();
    }

    return {initialize, setMode, getMode: () => 'modern'};
}

if (typeof module === 'object' && module.exports) {
    module.exports = {createGalleryLayoutController};
}
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        createGalleryLayoutController(document, window).initialize();
    });
}
