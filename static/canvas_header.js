(function (root) {
    'use strict';

    const doc = root.document;
    const header = doc?.querySelector('.main-header');
    if (!header) return;

    const menuSelector = 'details.canvas-header-menu';
    const allOpenMenus = () => Array.from(header.querySelectorAll(`${menuSelector}[open]`));

    function closeMenu(menu, focusSummary = false) {
        if (!menu?.open) return;
        menu.open = false;
        if (focusSummary) menu.querySelector(':scope > summary')?.focus();
    }

    function positionMenu(menu) {
        if (!menu?.open || !header.contains(menu)) return;
        const summary = menu.querySelector(':scope > summary');
        const content = menu.querySelector(':scope > .canvas-header-menu-content');
        if (!summary || !content) return;

        const anchor = summary.getBoundingClientRect();
        const viewportWidth = root.innerWidth;
        const viewportHeight = root.innerHeight;
        content.style.maxHeight = `${Math.max(120, Math.min(420, viewportHeight - 150))}px`;
        content.style.left = '0px';
        content.style.top = '0px';
        const bounds = content.getBoundingClientRect();
        const left = Math.max(12, Math.min(anchor.left, viewportWidth - bounds.width - 12));
        let top = anchor.bottom + 6;
        if (top + bounds.height > viewportHeight - 12) top = anchor.top - bounds.height - 6;
        top = Math.max(12, Math.min(top, viewportHeight - bounds.height - 12));
        content.style.left = `${left}px`;
        content.style.top = `${top}px`;
    }

    function repositionOpenMenus() {
        allOpenMenus().forEach(positionMenu);
    }

    header.addEventListener('toggle', event => {
        const menu = event.target;
        if (menu?.nodeType !== 1 || typeof menu.matches !== 'function'
            || !menu.matches(menuSelector) || !menu.open) return;
        allOpenMenus().forEach(other => { if (other !== menu) closeMenu(other); });
        positionMenu(menu);
    }, true);

    header.addEventListener('click', event => {
        const target = event.target?.nodeType === 1 && typeof event.target.closest === 'function'
            ? event.target : null;
        const menu = target?.closest(menuSelector);
        if (!menu || !header.contains(menu)) return;

        const input = target.closest('input[type="checkbox"], input[type="radio"]');
        const label = target.closest('label');
        if (input || label?.querySelector('input[type="checkbox"], input[type="radio"]')) return;

        const action = target.closest('button, a[href], [role="button"]');
        if (action && menu.contains(action)) closeMenu(menu);
    });

    header.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            const target = event.target?.nodeType === 1 && typeof event.target.closest === 'function'
                ? event.target : null;
            const activeMenu = target?.closest('details.canvas-header-menu[open], #canvasProjectStatus[open]');
            const projectStatus = header.querySelector('#canvasProjectStatus[open]');
            const menu = activeMenu || allOpenMenus()[0] || projectStatus;
            if (menu) {
                closeMenu(menu, true);
                const project = header.querySelector('#canvasProjectStatus[open]');
                if (project) closeMenu(project, false);
                event.preventDefault();
            }
        }
        event.stopPropagation();
    });

    for (const type of ['copy', 'cut', 'paste']) {
        header.addEventListener(type, event => event.stopPropagation());
    }

    doc.addEventListener('click', event => {
        const target = event.target;
        allOpenMenus().forEach(menu => { if (!menu.contains(target)) closeMenu(menu); });
        const projectStatus = header.querySelector('#canvasProjectStatus[open]');
        if (projectStatus && !projectStatus.contains(target)) closeMenu(projectStatus);
    });

    root.addEventListener('resize', repositionOpenMenus);
    root.addEventListener('scroll', repositionOpenMenus, true);
})(window);
