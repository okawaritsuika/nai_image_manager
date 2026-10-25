(() => {
    const source = document.getElementById('archiveSource');
    const status = document.getElementById('archiveStatus');
    const items = document.getElementById('archiveItems');
    const previous = document.getElementById('previousPage');
    const next = document.getElementById('nextPage');
    const pageLabel = document.getElementById('pageLabel');
    let cursors = [''];
    let page = 0;
    let nextCursor = '';
    let requestId = 0;

    async function load() {
        const currentRequest = ++requestId;
        previous.disabled = true;
        next.disabled = true;
        status.textContent = '자료를 확인하고 있습니다.';
        items.replaceChildren();
        try {
            const query = new URLSearchParams({source: source.value, cursor: cursors[page], limit: '48'});
            const response = await fetch(`/api/legacy-generation/images?${query}`);
            const data = await response.json();
            if (currentRequest !== requestId) return;
            if (!response.ok) throw new Error(data.message || '자료를 불러오지 못했습니다.');
            const fragment = document.createDocumentFragment();
            data.items.forEach((item) => {
                const link = document.createElement('a');
                link.className = 'item';
                link.href = item.src;
                link.target = '_blank';
                link.rel = 'noopener';
                link.title = `${item.path} · 원본 열기`;
                const image = document.createElement('img');
                image.src = `${item.src}?preview=512`;
                image.alt = item.name;
                image.loading = 'lazy';
                image.decoding = 'async';
                const label = document.createElement('span');
                label.textContent = item.path;
                link.append(image, label);
                fragment.append(link);
            });
            items.append(fragment);
            nextCursor = data.next_cursor;
            previous.disabled = page === 0;
            next.disabled = !nextCursor;
            pageLabel.textContent = `${page + 1}페이지`;
            status.textContent = data.items.length ? `${data.items.length}개 이미지 · 선택하면 원본이 새 탭에서 열립니다.` : '이 위치에 보존된 이미지가 없습니다.';
        } catch (error) {
            if (currentRequest !== requestId) return;
            status.textContent = error.message;
            previous.disabled = page === 0;
        }
    }

    source.addEventListener('change', () => { cursors = ['']; page = 0; load(); });
    previous.addEventListener('click', () => { if (page > 0) { page--; load(); } });
    next.addEventListener('click', () => { if (nextCursor) { cursors[++page] = nextCursor; load(); } });
    load();
})();
