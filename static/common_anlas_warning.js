(function () {
    function getExpectedAnlasCost(width, height, steps = 28) {
        const w = Math.max(0, parseInt(width, 10) || 0);
        const h = Math.max(0, parseInt(height, 10) || 0);
        const s = Math.max(1, parseInt(steps, 10) || 28);

        if (!w || !h) {
            return 0;
        }

        if (w * h <= 1048576 && s <= 28) {
            return 0;
        }

        return Math.max(2, Math.ceil((w * h * s) / 1460000));
    }

    function requiresAnlasCost(width, height, steps = 28) {
        return getExpectedAnlasCost(width, height, steps) > 0;
    }

    function ensureAnlasWarningLayer() {
        let layer = document.getElementById('globalAnlasWarningLayer');

        if (layer) {
            return layer;
        }

        layer = document.createElement('div');
        layer.id = 'globalAnlasWarningLayer';
        layer.className = 'global-anlas-warning-layer';
        layer.innerHTML = `
            <div class="global-anlas-warning-card">
                <div class="global-anlas-warning-icon">⚠️</div>
                <div class="global-anlas-warning-title" id="globalAnlasWarningTitle">Anlas 사용 경고</div>
                <div class="global-anlas-warning-desc" id="globalAnlasWarningDesc"></div>

                <div class="global-anlas-warning-stats">
                    <div>
                        <span>해상도</span>
                        <b id="globalAnlasWarningSize">-</b>
                    </div>
                    <div>
                        <span>Steps</span>
                        <b id="globalAnlasWarningSteps">-</b>
                    </div>
                    <div>
                        <span>예상 비용</span>
                        <b id="globalAnlasWarningCost">-</b>
                    </div>
                </div>

                <div class="global-anlas-warning-note">
                    무료 범위를 벗어난 NovelAI 요청은 Anlas를 소모할 수 있습니다.
                </div>

                <div class="global-anlas-warning-actions">
                    <button type="button" class="secondary" id="globalAnlasWarningCancelBtn">취소</button>
                    <button type="button" class="danger" id="globalAnlasWarningOkBtn">계속 요청</button>
                </div>
            </div>
        `;

        document.body.appendChild(layer);
        return layer;
    }

    function showAnlasWarningModal({ width, height, steps = 28, title = 'Anlas 사용 경고', detail = '' } = {}) {
        const cost = getExpectedAnlasCost(width, height, steps);

        if (cost <= 0) {
            return Promise.resolve(true);
        }

        return new Promise((resolve) => {
            const layer = ensureAnlasWarningLayer();

            const titleEl = document.getElementById('globalAnlasWarningTitle');
            const descEl = document.getElementById('globalAnlasWarningDesc');
            const sizeEl = document.getElementById('globalAnlasWarningSize');
            const stepsEl = document.getElementById('globalAnlasWarningSteps');
            const costEl = document.getElementById('globalAnlasWarningCost');
            const cancelBtn = document.getElementById('globalAnlasWarningCancelBtn');
            const okBtn = document.getElementById('globalAnlasWarningOkBtn');

            const close = (ok) => {
                layer.style.display = 'none';
                layer.onclick = null;
                cancelBtn.onclick = null;
                okBtn.onclick = null;
                document.removeEventListener('keydown', onKeyDown);
                resolve(Boolean(ok));
            };

            const onKeyDown = (event) => {
                if (event.key === 'Escape') {
                    close(false);
                }
            };

            titleEl.innerText = title;
            descEl.innerText = detail || '이 요청은 무료 범위를 벗어나 Anlas가 소모될 수 있습니다. 계속 진행할까요?';
            sizeEl.innerText = `${width} × ${height}`;
            stepsEl.innerText = String(steps);
            costEl.innerText = `${cost} Anlas`;

            cancelBtn.onclick = () => close(false);
            okBtn.onclick = () => close(true);

            layer.onclick = (event) => {
                if (event.target === layer) {
                    close(false);
                }
            };

            document.addEventListener('keydown', onKeyDown);
            layer.style.display = 'flex';
        });
    }

    window.getExpectedAnlasCost = getExpectedAnlasCost;
    window.requiresAnlasCost = requiresAnlasCost;
    window.showAnlasWarningModal = showAnlasWarningModal;
})();
