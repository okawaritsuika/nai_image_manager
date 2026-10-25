// Presentation only: both layouts use the same controls, image nodes and state.
function createGalleryLayoutController(doc, win) {
    const storageKey = 'naia_gallery_layout_v1';
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
    let currentMode = 'legacy';
    let movedNodes = [];
    let initialized = false;
    let scrollRestoreRevision = 0;
    let sidebarInitialized = false;

    function showStorageMessage(message) {
        const status = doc.getElementById('galleryLayoutSaveStatus');
        if (!status) return;
        status.textContent = message;
        status.hidden = !message;
    }

    function updateSwitchHeight() {
        const bar = doc.getElementById('galleryLayoutSwitch');
        if (!bar) return;
        const height = Math.ceil(bar.getBoundingClientRect().height);
        doc.documentElement.style.setProperty('--gallery-layout-switch-height', `${height}px`);
    }

    function captureScrollAnchor() {
        const viewportHeight = win.innerHeight || 0;
        if (!viewportHeight) return null;
        const switchBottom = doc.getElementById('galleryLayoutSwitch')?.getBoundingClientRect().bottom || 0;
        const headerBottom = doc.querySelector('.header-main')?.getBoundingClientRect().bottom || 0;
        const visibleTop = Math.max(0, switchBottom, headerBottom);
        let anchor = null;
        for (const node of doc.querySelectorAll('#content .item-box, #content .card, #content .section-header, #content .section-title')) {
            const rect = node.getBoundingClientRect();
            if (rect.bottom <= visibleTop || rect.top >= viewportHeight || rect.right <= 0 || rect.left >= win.innerWidth) continue;
            const visibleStart = Math.max(visibleTop, rect.top);
            if (!anchor || visibleStart < anchor.visibleStart || (visibleStart === anchor.visibleStart && rect.left < anchor.left)) {
                anchor = {node, top: rect.top, visibleStart, left: rect.left};
            }
        }
        return anchor;
    }

    function setMode(value, persist = true) {
        const nextMode = value === 'modern' ? 'modern' : 'legacy';
        const layout = doc.getElementById('galleryModernLayout');
        if (!layout) return;
        const scrollX = win.scrollX || 0;
        const scrollY = win.scrollY || 0;
        const focused = doc.activeElement;
        const anchor = nextMode !== currentMode ? captureScrollAnchor() : null;

        if (nextMode !== currentMode) {
            if (nextMode === 'modern') {
                if (!sidebarInitialized) {
                    if (typeof win.matchMedia === 'function' && win.matchMedia('(max-width: 760px)').matches) {
                        for (const id of ['galleryModernNavSection', 'galleryModernFilterSection']) {
                            const section = doc.getElementById(id);
                            if (section) section.open = false;
                        }
                    }
                    sidebarInitialized = true;
                }
                for (const [selector, targetId] of destinations) {
                    const node = doc.querySelector(selector);
                    const target = doc.getElementById(targetId);
                    if (!node || !target || !node.parentNode) continue;
                    const marker = doc.createComment(`gallery-layout:${selector}`);
                    node.parentNode.insertBefore(marker, node);
                    movedNodes.push({node, marker});
                    target.appendChild(node);
                }
            } else {
                for (const {node, marker} of movedNodes.slice().reverse()) {
                    if (marker.parentNode) marker.parentNode.replaceChild(node, marker);
                }
                movedNodes = [];
            }
            currentMode = nextMode;
        }

        doc.body.classList.toggle('gallery-layout-modern', currentMode === 'modern');
        layout.hidden = currentMode !== 'modern';
        for (const button of doc.querySelectorAll('[data-gallery-layout]')) {
            button.setAttribute('aria-pressed', String(button.dataset.galleryLayout === currentMode));
        }

        if (persist) {
            try {
                win.localStorage.setItem(storageKey, currentMode);
                showStorageMessage('');
            } catch (error) {
                showStorageMessage('화면은 전환했지만 설정을 저장하지 못했습니다. 다음 실행 때 다시 선택해 주세요.');
            }
        }
        updateSwitchHeight();

        // A narrower image grid changes document height. Follow the same visible
        // card/section instead of a scrollY that may now point to a different image.
        const revision = ++scrollRestoreRevision;
        let restoreFrames = 0;
        const restoreScroll = () => {
            if (revision !== scrollRestoreRevision) return;
            if (!restoreFrames && focused?.isConnected && typeof focused.focus === 'function') {
                focused.focus({preventScroll: true});
            }
            let targetY = scrollY;
            const hasAnchor = anchor?.node.isConnected;
            if (hasAnchor) {
                // Reading geometry can flush layout and adjust native scroll anchoring.
                // Read scrollY afterwards so both coordinates describe the same layout.
                const top = anchor.node.getBoundingClientRect().top;
                targetY = Math.max(0, (win.scrollY || 0) + top - anchor.top);
            }
            win.scrollTo(scrollX, targetY);
            // content-visibility may settle newly visible card heights next frame.
            // Recheck only this node, for at most three frames, then release scrolling.
            if (hasAnchor && ++restoreFrames < 3) {
                win.requestAnimationFrame(restoreScroll);
                return;
            }
            if (typeof win.scheduleGalleryScrollNavigationUpdate === 'function') {
                win.scheduleGalleryScrollNavigationUpdate();
            }
        };
        win.requestAnimationFrame(restoreScroll);
    }

    function initialize() {
        if (initialized || !doc.getElementById('galleryLayoutSwitch')) return;
        initialized = true;
        for (const button of doc.querySelectorAll('[data-gallery-layout]')) {
            button.addEventListener('click', () => setMode(button.dataset.galleryLayout));
        }
        let savedMode = 'legacy';
        try {
            savedMode = win.localStorage.getItem(storageKey) || 'legacy';
        } catch (error) {
            showStorageMessage('저장한 화면 설정을 읽지 못했습니다. 현재 화면에서 다시 선택할 수 있습니다.');
        }
        setMode(savedMode, false);
        if (typeof win.ResizeObserver === 'function') {
            const observer = new win.ResizeObserver(updateSwitchHeight);
            observer.observe(doc.getElementById('galleryLayoutSwitch'));
        } else {
            win.addEventListener('resize', updateSwitchHeight);
        }
    }

    return {initialize, setMode, getMode: () => currentMode};
}

if (typeof module === 'object' && module.exports) {
    module.exports = {createGalleryLayoutController};
}
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        createGalleryLayoutController(document, window).initialize();
    });
}
