// Keep measured spaces in each existing column while releasing offscreen cards.
function createGalleryCardRecycler({render, fixed = false, groupSize = 16}) {
    const groups = new Set();
    const tails = new Map();
    let disposed = false;
    const observer = new IntersectionObserver(entries => {
        if (disposed) return;
        for (const entry of entries) {
            const group = entry.target;
            if (entry.isIntersecting) mount(group);
            else release(group);
        }
    }, {rootMargin: '1200px'});
    function mount(group) {
        if (group.mounted || disposed) return;
        group.mounted = true;
        group.style.height = '';
        for (const index of group.indices) render(index, group);
    }
    function release(group) {
        if (!group.mounted || group.contains(document.activeElement)) return;
        const rect = group.getBoundingClientRect();
        if (!rect.height) return;
        group.savedWidth = rect.width;
        group.savedHeight = rect.height;
        group.style.height = `${rect.height}px`;
        group.replaceChildren();
        group.mounted = false;
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
        for (const entry of entries) {
            const group = entry.target;
            const width = entry.contentRect.width;
            if (!group.mounted && group.savedWidth > 0 && width > 0) {
                group.style.height = `${group.savedHeight * width / group.savedWidth}px`;
            }
        }
    });
    function seal(group) {
        if (group.sealed) return;
        group.sealed = true;
        observer.observe(group);
        resize?.observe(group);
    }
    return {
        append(index, card, host) {
            let group = tails.get(host);
            if (!group || group.indices.length >= group.limit) {
                group = document.createElement('div');
                group.className = 'gallery-recycled-group';
                group.style.cssText = fixed
                    ? 'display:grid;grid-template-columns:inherit;grid-column:1 / -1;gap:inherit;min-width:0'
                    : 'display:flex;flex-direction:column;gap:inherit;min-width:0';
                group.indices = [];
                const columns = fixed ? Math.max(1, getComputedStyle(host).gridTemplateColumns.split(' ').length) : 1;
                group.limit = columns * Math.max(1, Math.floor(groupSize / columns));
                group.mounted = true;
                host.appendChild(group);
                groups.add(group);
                tails.set(host, group);
            }
            group.indices.push(index);
            group.appendChild(card);
            if (group.indices.length === group.limit) seal(group);
        },
        finish() { for (const group of groups) seal(group); },
        cleanup() {
            disposed = true;
            observer.disconnect();
            resize?.disconnect();
            groups.clear();
            tails.clear();
        }
    };
}
if (typeof module === 'object' && module.exports) module.exports = {createGalleryCardRecycler};
