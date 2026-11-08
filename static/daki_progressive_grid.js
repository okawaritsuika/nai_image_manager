/* Progressive card rendering for large Daki style lists. */
(function (root) {
    'use strict';

    const DEFAULT_PAGE_SIZE = 80;

    function create({className, renderItem, pathOf, pageSize = DEFAULT_PAGE_SIZE}) {
        const doc = root.document;
        const size = Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_PAGE_SIZE;
        const wrapper = doc.createElement('div');
        wrapper.className = 'daki-progressive-grid';
        const grid = root.Daki.createGrid(className);
        const footer = doc.createElement('div');
        footer.className = 'daki-progressive-footer';
        const count = doc.createElement('span');
        count.className = 'daki-progressive-count';
        count.setAttribute('role', 'status');
        count.setAttribute('aria-live', 'polite');
        const more = doc.createElement('button');
        more.type = 'button';
        more.className = 'nav-btn daki-progressive-more';
        more.textContent = '더 보기';
        const sentinel = doc.createElement('span');
        sentinel.className = 'daki-progressive-sentinel';
        sentinel.setAttribute('aria-hidden', 'true');
        footer.append(count, more, sentinel);
        wrapper.append(grid, footer);

        let records = [];
        let cards = [];
        let reset = true;
        let limit = size;
        let frame = null;
        let disposed = false;
        let autoLoadArmed = true;
        let observer = null;

        function render() {
            frame = null;
            if (disposed) return;
            if (reset) {
                reset = false;
                cards = [];
                grid.galleryZoomImagesAll = pathOf
                    ? records.map(item => pathOf(item)).filter(Boolean).map(path => ({path}))
                    : [];
                grid.setItems([]);
            }
            const added = records.slice(cards.length, limit).map(item => renderItem(item));
            cards.push(...added);
            if (typeof grid.appendItems === 'function') grid.appendItems(added);
            else grid.setItems(cards);
            count.textContent = `전체 ${records.length.toLocaleString('ko-KR')}개 중 ${cards.length.toLocaleString('ko-KR')}개 표시`;
            more.disabled = cards.length >= records.length;
            sentinel.hidden = more.disabled;
        }

        function scheduleRender() {
            if (disposed || frame !== null) return;
            if (typeof root.requestAnimationFrame === 'function') frame = root.requestAnimationFrame(render);
            else render();
        }

        function loadMore() {
            if (disposed || limit >= records.length) return;
            limit = Math.min(limit + size, records.length);
            scheduleRender();
        }

        more.onclick = loadMore;
        if (typeof root.IntersectionObserver === 'function') {
            observer = new root.IntersectionObserver(entries => {
                if (disposed) return;
                for (const entry of entries) {
                    if (entry.target !== sentinel) continue;
                    if (!entry.isIntersecting) autoLoadArmed = true;
                    else if (autoLoadArmed) {
                        autoLoadArmed = false;
                        loadMore();
                    }
                }
            }, {rootMargin: '400px'});
            observer.observe(sentinel);
        }

        wrapper.setItems = value => {
            if (disposed) return;
            records = Array.from(value || []);
            reset = true;
            limit = size;
            autoLoadArmed = true;
            scheduleRender();
        };
        wrapper.dispose = () => {
            if (disposed) return;
            disposed = true;
            observer?.disconnect();
            observer = null;
            more.onclick = null;
            if (frame !== null && typeof root.cancelAnimationFrame === 'function') root.cancelAnimationFrame(frame);
            frame = null;
        };

        return wrapper;
    }

    root.DakiProgressiveGrid = {create};
})(typeof window === 'undefined' ? globalThis : window);
