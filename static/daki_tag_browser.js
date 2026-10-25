(function (root) {
    'use strict';
    const doc = root.document, base = '/api/daki/tag-catalog/';
    let current = null;

    function node(tag, text, className) {
        const element = doc.createElement(tag);
        if (text !== undefined && text !== null) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function button(text, action, className) {
        const element = node('button', text, className);
        element.type = 'button'; element.onclick = action;
        return element;
    }
    function field(label, control) {
        const element = node('label', label); element.appendChild(control);
        control.setAttribute('aria-label', label); return element;
    }
    async function api(path) {
        const response = await root.fetch(base + path);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== 'success') throw new Error(data.message || '태그사전을 불러오지 못했습니다.');
        return data;
    }
    function imageUrl(value) { return typeof value === 'string' && value.startsWith(base + 'example?') ? value : ''; }

    function close() {
        if (!current) return;
        const state = current;
        if (state.dialog.open) state.dialog.close();
        state.finish();
    }

    function open({targetLabel = '프롬프트', onInsert, onClose} = {}) {
        close();
        const canInsert = typeof onInsert === 'function';
        const idleStatus = canInsert ? targetLabel + '에 추가' : '태그사전 둘러보기';
        const originalFocus = doc.activeElement;
        const dialog = node('dialog', null, 'daki-dialog daki-tag-browser');
        dialog.setAttribute('aria-labelledby', 'dakiTagBrowserTitle');
        const header = node('header', null, 'daki-tag-browser-header');
        const heading = node('div'), title = node('h2', '태그사전'); title.id = 'dakiTagBrowserTitle';
        heading.append(title, node('p', canInsert ? '카테고리와 예시를 살펴보고 영어 원문 태그를 추가하세요.' : '카테고리와 예시를 살펴보고 태그의 뜻을 확인하세요.'));
        header.append(heading, button('닫기', close));
        const controls = node('div', null, 'daki-tag-browser-controls');
        const search = node('input'); search.type = 'text'; search.placeholder = '한글·영어 태그 검색'; search.maxLength = 1000;
        const category = node('select'), section = node('select'), examples = node('input'); examples.type = 'checkbox';
        const examplesLabel = field('예시 그림 있는 태그만', examples); examplesLabel.className = 'daki-tag-browser-check';
        controls.append(field('태그 검색', search), field('카테고리', category), field('세부 분류', section), examplesLabel);
        const content = node('div', null, 'daki-tag-browser-content');
        const listColumn = node('section', null, 'daki-tag-browser-list-column');
        const count = node('p', '태그사전을 불러오는 중…'); count.setAttribute('role', 'status');
        const list = node('div', null, 'daki-tag-browser-list'); list.setAttribute('aria-label', '태그 목록');
        const pages = node('div', null, 'daki-tag-browser-pages'), pageNumber = node('span');
        const previous = button('이전', () => loadList(state.page - 1)), next = button('다음', () => loadList(state.page + 1));
        previous.setAttribute('aria-label', '이전 태그 페이지'); next.setAttribute('aria-label', '다음 태그 페이지');
        previous.disabled = next.disabled = true; pages.append(previous, pageNumber, next);
        listColumn.append(count, list, pages);
        const detail = node('section', null, 'daki-tag-browser-detail'); detail.setAttribute('aria-label', '태그 상세');
        detail.appendChild(node('p', '태그를 골라 설명과 예시를 확인하세요.'));
        content.append(listColumn, detail);
        const footer = node('footer', null, 'daki-tag-browser-footer');
        const status = node('span', idleStatus); status.setAttribute('role', 'status');
        const insert = canInsert ? button(targetLabel + '에 추가', () => {
            if (!live() || !state.selected || typeof onInsert !== 'function') return;
            try {
                onInsert(state.selected.tag);
                if (live()) status.textContent = (state.selected.label_ko || state.selected.tag) + ' 추가됨 · ' + targetLabel;
            } catch (error) { if (live()) status.textContent = error.message || '태그를 추가하지 못했습니다.'; }
        }, 'daki-primary') : null;
        footer.appendChild(status);
        if (insert) { insert.disabled = true; footer.appendChild(insert); }
        dialog.append(header, controls, content, footer);
        const state = {dialog, selected: null, categories: [], listToken: 0, detailToken: 0, page: 1, timer: null, preview: null, closed: false};
        current = state;
        function live() { return current === state && !state.closed && dialog.open; }
        function closePreview() {
            if (!state.preview) return;
            const preview = state.preview; state.preview = null;
            if (preview.open) preview.close(); preview.remove();
        }
        state.finish = () => {
            if (state.closed) return;
            state.closed = true; state.listToken++; state.detailToken++;
            root.clearTimeout(state.timer); closePreview();
            root.DakiTagExamples?.close();
            if (current === state) current = null;
            dialog.remove();
            if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
            onClose?.();
        };
        dialog.addEventListener('close', state.finish);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        function resetSelection() {
            state.selected = null; state.detailToken++;
            if (insert) insert.disabled = true;
            status.textContent = idleStatus;
            detail.replaceChildren(node('p', '태그를 골라 설명과 예시를 확인하세요.'));
        }
        function option(text, value) { const item = node('option', text); item.value = value; return item; }
        function sections() {
            section.replaceChildren(option('세부 분류 전체', ''));
            for (const item of state.categories.find(c => c.id === category.value)?.sections || []) {
                section.appendChild(option(item.label + ' · ' + item.count.toLocaleString(), item.id));
            }
            section.value = ''; section.disabled = section.children.length === 1;
        }
        function examplePreview(tag, example) {
            if (!live()) return;
            closePreview();
            const preview = state.preview = node('dialog', null, 'daki-dialog daki-tag-example');
            preview.setAttribute('aria-label', '태그 예시 크게 보기');
            const top = node('header'); top.append(node('h2', (tag.label_ko || tag.tag) + ' · 예시'), button('닫기', closePreview));
            const image = node('img'); image.src = imageUrl(example.image); image.alt = (tag.label_ko || tag.tag) + ' 예시';
            const note = node('p', [example.reference_note, example.review_note].filter(Boolean).join(' '));
            image.onerror = () => { if (state.preview === preview) { image.hidden = true; note.textContent = '예시 그림 원본을 불러오지 못했습니다.'; } };
            preview.append(top, image, note);
            preview.addEventListener('close', () => { if (state.preview === preview) state.preview = null; preview.remove(); });
            doc.body.appendChild(preview); preview.showModal();
        }
        async function showDetail(tag) {
            resetSelection();
            const token = state.detailToken;
            detail.replaceChildren(node('p', '설명을 불러오는 중…'));
            for (const item of list.children) item.setAttribute('aria-pressed', item.dataset.tag === tag ? 'true' : 'false');
            try {
                const data = await api('detail?' + new URLSearchParams({tag}));
                if (!live() || token !== state.detailToken) return;
                const item = data.tag;
                if (!item || item.tag !== tag) throw new Error('태그 응답이 일치하지 않습니다. 다시 선택해 주세요.');
                state.selected = item;
                detail.replaceChildren(node('h3', item.label_ko || item.tag), node('code', item.tag),
                    node('p', (item.categories || []).join(' · '), 'daki-tag-browser-muted'),
                    node('p', item.description_ko || '등록된 설명이 없습니다.', 'daki-tag-browser-description'));
                if (item.description_status === 'meaning_unresolved' || item.description_review) {
                    detail.appendChild(node('p', item.ambiguity_note_ko || '설명 보완·의미 구분이 필요한 태그입니다.'));
                }
                if (root.DakiTagExamples) {
                    const actions = node('div', null, 'daki-tag-example-actions');
                    for (const [mode, label] of [['existing', '기존 그림에서 추가'], ['generate', '새로 생성']]) {
                        actions.appendChild(button(label, () => root.DakiTagExamples.open({tag: item, mode,
                            onSaved() { if (live() && state.selected?.tag === tag) return showDetail(tag); }})));
                    }
                    detail.appendChild(actions);
                }
                for (const example of item.examples || []) {
                    const figure = node('figure'), expand = button('', () => examplePreview(item, example));
                    expand.setAttribute('aria-label', (item.label_ko || item.tag) + ' 예시 그림 확대');
                    const image = node('img'); image.src = imageUrl(example.thumbnail); image.alt = (item.label_ko || item.tag) + ' 예시'; image.loading = 'lazy';
                    image.onerror = () => { expand.replaceChildren(node('span', '예시 그림을 불러오지 못했습니다.')); expand.disabled = true; };
                    expand.appendChild(image);
                    figure.append(node('b', example.relation === 'base_reference' ? '기본형 참고 · ' + example.tag : '특징 예시'), expand,
                        node('figcaption', [example.reference_note, example.review_note].filter(Boolean).join(' ')));
                    detail.appendChild(figure);
                }
                if (!item.examples?.length) detail.appendChild(node('p', '등록된 예시 그림이 없습니다. 설명을 참고해 주세요.'));
                for (const note of [item.auto_insert_disabled, ...(item.notes || []), item.required_attires?.length ? '복장 조건: ' + item.required_attires.join(', ') : ''].filter(Boolean)) detail.appendChild(node('p', note));
                if (item.related?.length) {
                    const related = node('div', null, 'daki-tag-browser-related'); related.appendChild(node('b', '관련 태그'));
                    for (const item of data.tag.related) related.appendChild(button(item.label_ko || item.tag, () => showDetail(item.tag)));
                    detail.appendChild(related);
                }
                const sources = (item.description_references || []).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url));
                if (sources.length || item.description_source_license || item.description_original_en) {
                    const source = node('details'); source.appendChild(node('summary', '설명 출처·원문'));
                    if (item.description_original_en) source.appendChild(node('p', item.description_original_en));
                    if (item.description_source_license) source.appendChild(node('p', item.description_source_license));
                    for (const [i, url] of sources.entries()) {
                        const link = node('a', '출처 ' + (i + 1) + ' ↗'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; source.appendChild(link);
                    }
                    detail.appendChild(source);
                }
                detail.scrollTop = 0;
                if (insert) insert.disabled = false;
                status.textContent = (item.label_ko || item.tag) + ' · ' + (canInsert ? targetLabel + '에 추가' : '설명·예시 보기');
            } catch (error) {
                if (live() && token === state.detailToken) detail.replaceChildren(node('p', error.message), button('다시 불러오기', () => showDetail(tag)));
            }
        }
        async function loadList(page = 1) {
            root.clearTimeout(state.timer);
            const token = ++state.listToken; resetSelection();
            previous.disabled = next.disabled = true; count.textContent = '태그를 불러오는 중…';
            list.replaceChildren(); pageNumber.textContent = '';
            try {
                const query = new URLSearchParams({category: category.value || 'all', section: section.value, q: search.value, examples: examples.checked ? '1' : '0', page});
                const data = await api('browse?' + query);
                if (!live() || token !== state.listToken) return;
                state.page = data.page; count.textContent = data.total.toLocaleString() + '개 태그'; pageNumber.textContent = data.page + ' / ' + data.pages;
                previous.disabled = data.page <= 1; next.disabled = data.page >= data.pages;
                for (const item of data.items) {
                    const card = button('', () => showDetail(item.tag), 'daki-tag-browser-item'); card.dataset.tag = item.tag; card.setAttribute('aria-pressed', 'false');
                    if (imageUrl(item.thumbnail)) {
                        const image = node('img'); image.src = imageUrl(item.thumbnail); image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.hidden = true; card.appendChild(image);
                    }
                    const text = node('span'); text.append(node('b', item.label_ko || item.tag), node('small', item.tag), node('span', item.description_ko || '설명을 확인하세요.'));
                    if (item.thumbnail) text.appendChild(node('small', item.exampleKind === 'base_reference' ? '기본형 참고 그림' : '예시 그림 있음'));
                    card.appendChild(text); list.appendChild(card);
                }
                if (!data.items.length) list.appendChild(node('p', '조건에 맞는 태그가 없습니다. 검색어나 분류를 바꿔 주세요.'));
                list.scrollTop = 0;
            } catch (error) {
                if (live() && token === state.listToken) { count.textContent = '태그를 불러오지 못했습니다.'; list.replaceChildren(node('p', error.message), button('다시 불러오기', () => loadList(page))); }
            }
        }
        category.onchange = () => { sections(); loadList(); };
        section.onchange = examples.onchange = () => loadList();
        search.oninput = () => {
            root.clearTimeout(state.timer); state.listToken++; resetSelection();
            list.replaceChildren(); previous.disabled = next.disabled = true; count.textContent = '검색 중…';
            state.timer = root.setTimeout(() => { if (live()) loadList(); }, 220);
        };
        async function loadCategories() {
            category.disabled = section.disabled = true; search.disabled = examples.disabled = true;
            try {
                const data = await api('categories');
                if (!live()) return;
                state.categories = data.categories; category.replaceChildren();
                for (const item of data.categories) category.appendChild(option(item.label + ' · ' + item.count.toLocaleString(), item.id));
                category.value = 'all'; sections(); category.disabled = false; search.disabled = examples.disabled = false;
                await loadList();
            } catch (error) {
                if (live()) { count.textContent = '태그사전을 불러오지 못했습니다.'; list.replaceChildren(node('p', error.message), button('다시 불러오기', loadCategories)); }
            }
        }
        doc.body.appendChild(dialog); dialog.showModal(); loadCategories();
    }

    root.DakiTagBrowser = {open, close};
})(window);
