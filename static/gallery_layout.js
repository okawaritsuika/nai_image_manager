// Presentation only: the gallery uses the modern layout with the same nodes and state.
function createGalleryLayoutController(doc, win) {
    const destinations = [
        ['.header-main', 'galleryModernMain'],
        ['#nav-tabs', 'galleryModernNavigationBody'],
        ['.gallery-header-control-stack', 'galleryModernFiltersBody'],
        ['#brand-filter-bar', 'galleryModernFiltersBody'],
        ['#galleryTagFilterBar', 'galleryModernFiltersBody'],
        ['#char-chip-container', 'galleryModernCharactersBody'],
        ['#breadcrumb-path', 'galleryModernMain'],
        ['.search-wrapper', 'galleryModernMain'],
        ['#galleryPromptSearchPanel', 'galleryModernMain'],
        ['#galleryTagAssignmentModeStatus', 'galleryModernMain'],
        ['#content', 'galleryModernMain'],
        ['#dakiLibrary', 'galleryModernMain']
    ];
    let initialized = false;

    function initialize() {
        if (initialized) return;
        const layout = doc.getElementById('galleryModernLayout');
        if (!layout) return;

        initialized = true;
        doc.body.classList.toggle('gallery-layout-modern', true);
        layout.hidden = false;

        if (typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 760px)').matches) {
            for (const id of ['galleryModernNavSection', 'galleryModernFilterSection']) {
                const section = doc.getElementById(id);
                if (section) section.open = false;
            }
        }

        for (const [selector, targetId] of destinations) {
            const node = doc.querySelector(selector);
            const target = doc.getElementById(targetId);
            if (!node || !target || !node.parentNode || node === target) continue;
            target.appendChild(node);
        }
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
