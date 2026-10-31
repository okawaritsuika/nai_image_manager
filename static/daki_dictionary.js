/* Native dictionary tool inside the existing Daki shell. */
(function (root) {
    'use strict';
    let current = null;
    const doc = root.document;

    function fit(state) {
        if (current !== state || !state.host?.isConnected) return;
        const top = Math.max(0, state.host.getBoundingClientRect().top);
        const height = Math.max(360, Math.floor(root.innerHeight - top - 12));
        state.host.style.setProperty('--daki-dictionary-height', height + 'px');
    }

    function leave() {
        const state = current;
        current = null;
        if (state) {
            state.controller.abort();
            state.workbench?.dispose();
            state.observer?.disconnect();
            root.removeEventListener('resize', state.resize);
            state.host?.remove();
        }
        doc.body.classList.remove('daki-dictionary-active');
        doc.body.classList.remove('daki-dictionary-header-collapsed');
        doc.getElementById('openDakiDictionary')?.removeAttribute('aria-current');
    }

    async function render(params, container) {
        leave();
        const state = {controller: new AbortController(), host: null, workbench: null, observer: null};
        current = state;
        state.resize = () => fit(state);
        doc.body.classList.add('daki-dictionary-active');
        doc.getElementById('openDakiDictionary')?.setAttribute('aria-current', 'page');
        doc.getElementById('dakiTitle').textContent = '태그 사전';
        doc.getElementById('dakiPageStatus').textContent = '';
        root.scrollTo?.(0, 0);
        container.replaceChildren();
        const loading = doc.createElement('section');
        loading.className = 'daki-dictionary-loading';
        const back = doc.createElement('a');
        back.href = '#daki'; back.textContent = '← 프로젝트 목록';
        const gallery = doc.createElement('a');
        gallery.href = '#gallery'; gallery.textContent = '갤러리로';
        const message = doc.createElement('p');
        message.setAttribute('role', 'status'); message.textContent = '태그 사전 작업 공간을 준비하고 있습니다…';
        loading.append(back, gallery, message);
        container.appendChild(loading);
        try {
            const response = await root.fetch('/daki/dictionary', {signal: state.controller.signal});
            if (!response.ok) throw new Error('태그 사전 화면을 불러오지 못했습니다.');
            const source = await response.text();
            if (current !== state || state.controller.signal.aborted) return;
            const template = new root.DOMParser().parseFromString(source, 'text/html')
                .querySelector('.daki-dictionary-tool');
            if (!template || !root.DakiDictionaryWorkbench) throw new Error('태그 사전 도구를 준비하지 못했습니다. 새로고침해 주세요.');
            const host = state.host = doc.importNode(template, true);
            container.replaceChildren(host);
            fit(state);
            state.workbench = root.DakiDictionaryWorkbench.mount(host, {
                onHeaderChange(collapsed) {
                    if (current !== state) return;
                    doc.body.classList.toggle('daki-dictionary-header-collapsed', Boolean(collapsed));
                    fit(state);
                },
            });
            root.addEventListener('resize', state.resize);
            if (root.ResizeObserver) {
                state.observer = new root.ResizeObserver(state.resize);
                state.observer.observe(container);
                const header = doc.getElementById('galleryWorkspaceHeader');
                if (header) state.observer.observe(header);
            }
        } catch (error) {
            if (current !== state || state.controller.signal.aborted) return;
            state.workbench?.dispose();
            state.host?.remove();
            state.host = null;
            doc.body.classList.remove('daki-dictionary-header-collapsed');
            container.replaceChildren(loading);
            message.textContent = error.message || '태그 사전을 불러오지 못했습니다.';
            const retry = doc.createElement('button');
            retry.type = 'button'; retry.textContent = '다시 불러오기';
            retry.onclick = () => render(params, container);
            loading.appendChild(retry);
        }
    }

    root.DakiDictionary = {render, leave};
})(window);
