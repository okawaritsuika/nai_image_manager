/* Fit a completed draft into a new image without changing its saved original. */
(function (root) {
    'use strict';
    const doc = root.document, endpoint = '/api/daki/drafts';
    let current;
    const node = (tag, className, text) => {
        const item = doc.createElement(tag);
        if (className) item.className = className;
        if (text !== undefined) item.textContent = text;
        return item;
    };
    function button(label, action, className) {
        const item = node('button', className, label); item.type = 'button'; item.onclick = action; return item;
    }
    async function api(url, body) {
        const response = await root.fetch(url, {method: body ? 'POST' : 'GET', cache: 'no-store',
            ...(body ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : {})});
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== 'success') throw new Error(data.message || '크기 맞추기를 저장하지 못했습니다.');
        return data;
    }
    function close() {
        if (!current) return;
        const state = current;
        if (state.dialog.open) state.dialog.close();
        state.finish();
    }
    function open({record, onSaved}) {
        close();
        const sourceWidth = Number(record.width), sourceHeight = Number(record.height);
        const originalFocus = doc.activeElement;
        const dialog = node('dialog', 'daki-dialog daki-draft-framing');
        dialog.setAttribute('aria-labelledby', 'dakiDraftFramingTitle');
        const heading = node('header', 'daki-draft-framing-header'), title = node('h2', '', '5:16 맞추기 (선택)');
        title.id = 'dakiDraftFramingTitle';
        heading.append(title, button('닫기', close));
        const source = node('p', '', '원본 ' + root.formatGenerationSize(sourceWidth, sourceHeight));
        const form = node('form'); form.noValidate = true;
        const layout = node('div', 'daki-draft-framing-layout');
        const controls = node('fieldset', 'daki-draft-framing-controls'); controls.disabled = true;
        const modes = node('div', 'daki-draft-framing-modes');
        modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', '맞추기 방식');
        const modeInputs = {};
        for (const [value, label, detail] of [
            ['pad', '투명 여백 · 중앙 정렬', '원본 픽셀 크기를 유지하고 가운데에 놓습니다.'],
            ['cover', '확대·잘라 맞추기 · 중앙 정렬', '비율을 유지해 확대·축소하고 가운데를 기준으로 자릅니다.'],
        ]) {
            const choice = node('label', 'daki-draft-framing-mode');
            const input = node('input'); input.type = 'radio'; input.name = 'framing_mode'; input.value = value;
            input.checked = value === 'pad'; input.setAttribute('aria-label', label); modeInputs[value] = input;
            const text = node('span'); text.append(node('strong', '', label), node('small', '', detail)); choice.append(input, text); modes.appendChild(choice);
            input.onchange = () => { modeInputs.pad.checked = value === 'pad'; modeInputs.cover.checked = value === 'cover'; update(); };
        }
        const dimensions = node('div', 'daki-draft-framing-dimensions'), inputs = {};
        for (const [key, label] of [['width', '최종 너비'], ['height', '최종 높이']]) {
            const field = node('label', '', label), input = node('input');
            input.type = 'number'; input.name = key; input.step = 1; input.required = true;
            input.setAttribute('aria-label', label); input.oninput = update; inputs[key] = input; field.appendChild(input); dimensions.appendChild(field);
        }
        const presets = node('div', 'daki-draft-framing-presets');
        presets.append(button('5:16 맞추기', () => { exactDakiSize(); update(); }), button('원본 크기', () => {
            inputs.width.value = sourceWidth; inputs.height.value = sourceHeight; update();
        }));
        const size = node('p', 'daki-draft-framing-size'); size.setAttribute('aria-label', '최종 크기와 비율');
        const summary = node('p', 'daki-draft-framing-summary'); summary.setAttribute('aria-label', '크기 맞추기 내역');
        const note = node('p', '', '맞추는 방식을 선택하고 미리보기를 확인한 뒤 별도 저장을 누르세요. 원본을 유지하고 새 PNG 사본을 추가합니다.');
        controls.append(modes, dimensions, presets, size, summary, note);
        const previewColumn = node('div', 'daki-draft-framing-preview-column');
        const preview = node('div', 'daki-draft-framing-preview'), frame = node('div', 'daki-draft-framing-frame');
        const image = node('img'); image.alt = '가운데 배치한 결과 미리보기';
        image.src = endpoint + '/' + encodeURIComponent(record.id) + '/image?full=1';
        frame.appendChild(image); preview.appendChild(frame);
        previewColumn.append(preview, node('p', '', '체크무늬는 투명한 여백입니다.'));
        layout.append(controls, previewColumn);
        const status = node('p', 'daki-draft-framing-status', '저장 가능한 크기를 확인하는 중…'); status.setAttribute('role', 'status');
        const actions = node('div', 'daki-dialog-actions');
        const save = node('button', 'daki-primary', '별도 저장'); save.type = 'submit'; save.disabled = true;
        actions.append(button('취소', close), save); form.append(layout, status, actions); dialog.append(heading, source, form);
        const state = {dialog, closed: false, saving: false, limits: null, previewError: false}; current = state;
        const live = () => current === state && !state.closed && dialog.open;
        state.finish = () => {
            if (state.closed) return;
            state.closed = true; if (current === state) current = null;
            dialog.remove();
            if (originalFocus?.isConnected) originalFocus.focus({preventScroll: true});
        };
        dialog.addEventListener('close', state.finish);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        image.onerror = () => { state.previewError = true; update(); };
        image.onload = () => { state.previewError = false; update(); };
        doc.body.appendChild(dialog); dialog.showModal(); exactDakiSize(); update();

        function exactDakiSize() {
            const factor = Math.max(Math.ceil(sourceWidth / 5), Math.ceil(sourceHeight / 16));
            inputs.width.value = factor * 5; inputs.height.value = factor * 16;
        }
        function dimensionsError(width, height) {
            if (!Number.isSafeInteger(sourceWidth) || sourceWidth < 1 || !Number.isSafeInteger(sourceHeight) || sourceHeight < 1) return '원본 그림의 크기를 확인할 수 없습니다.';
            if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return '최종 크기는 1 이상의 정수로 입력하세요.';
            if (state.limits) {
                const {min, max, max_pixels: pixels} = state.limits;
                if (width < min || height < min || width > max || height > max) return `너비와 높이는 ${min}~${max} px 범위로 입력하세요.`;
                if (width * height > pixels) return `최종 크기는 ${pixels.toLocaleString()} 픽셀 이하여야 합니다.`;
            }
            if (modeInputs.pad.checked && (width < sourceWidth || height < sourceHeight)) return '투명 여백은 원본보다 작게 만들 수 없습니다. 크기를 늘리거나 잘라 맞추기를 선택하세요.';
            return '';
        }
        function update() {
            if (!live()) return;
            const width = Number(inputs.width.value), height = Number(inputs.height.value);
            const error = dimensionsError(width, height);
            save.disabled = !state.limits || state.saving || !!error;
            frame.hidden = !!error || state.previewError;
            size.textContent = error ? '' : root.formatGenerationSize(width, height);
            summary.textContent = '';
            if (!state.saving) status.textContent = error || (state.limits ? (state.previewError ? '미리보기 그림을 불러오지 못했습니다. 저장 시 원본을 다시 확인합니다.' : '') : '저장 가능한 크기를 확인하는 중…');
            if (error) return;
            const pad = modeInputs.pad.checked, scale = pad ? 1 : Math.max(width / sourceWidth, height / sourceHeight);
            const renderedWidth = sourceWidth * scale, renderedHeight = sourceHeight * scale;
            const gapX = Math.abs(width - renderedWidth), gapY = Math.abs(height - renderedHeight);
            const left = pad ? Math.floor(gapX / 2) : gapX / 2, top = pad ? Math.floor(gapY / 2) : gapY / 2;
            const right = gapX - left, bottom = gapY - top;
            frame.style.width = `min(100%, ${50 * width / height}vh)`; frame.style.aspectRatio = `${width} / ${height}`;
            image.style.width = `${renderedWidth / width * 100}%`; image.style.height = `${renderedHeight / height * 100}%`;
            image.style.left = `${(pad ? left : -left) / width * 100}%`; image.style.top = `${(pad ? top : -top) / height * 100}%`;
            const pixels = value => pad ? value : (value / scale).toFixed(2);
            summary.textContent = `${pad ? '원본 크기 유지' : '크기 조절'} · ${(scale * 100).toFixed(2)}%\n${pad ? '투명 여백' : '잘리는 원본'} · 왼쪽 ${pixels(left)} / 오른쪽 ${pixels(right)} / 위 ${pixels(top)} / 아래 ${pixels(bottom)} px`;
        }
        form.onsubmit = async event => {
            event.preventDefault();
            if (!live() || state.saving || !state.limits) return;
            const width = Number(inputs.width.value), height = Number(inputs.height.value);
            if (dimensionsError(width, height)) { update(); return; }
            state.saving = true; controls.disabled = true; save.disabled = true; save.textContent = '저장 중…';
            status.textContent = '별도 PNG로 저장 중입니다. 창을 닫아도 저장한 결과는 시안 목록에 남습니다.';
            let result;
            try {
                result = await api(endpoint + '/' + encodeURIComponent(record.id) + '/frame', {width, height, mode: modeInputs.pad.checked ? 'pad' : 'cover'});
            } catch (error) {
                state.saving = false;
                if (live()) { controls.disabled = false; update(); save.textContent = '별도 저장'; status.textContent = error.message; }
                return;
            }
            if (live()) close();
            // A completed save remains a new gallery result even if this dialog was closed meanwhile.
            if (typeof onSaved === 'function') await onSaved(result.draft);
        };
        api(endpoint + '/framing-options').then(data => {
            if (!live()) return;
            const limits = data.limits;
            if (!limits || !['min', 'max', 'max_pixels'].every(key => Number.isSafeInteger(limits[key]) && limits[key] > 0) || limits.min > limits.max) throw new Error('저장 가능한 크기를 확인하지 못했습니다. 창을 다시 열어 주세요.');
            state.limits = limits; controls.disabled = false;
            for (const input of Object.values(inputs)) { input.min = limits.min; input.max = limits.max; }
            update();
        }).catch(error => { if (live()) status.textContent = error.message; });
        return dialog;
    }
    root.DakiDraftFraming = {open, close};
})(typeof window === 'undefined' ? globalThis : window);
