/* Saved credentials stay on the server; only a masked hint reaches this UI. */
function createNovelAIAccount(doc, win) {
    const byId = id => doc.getElementById(id);
    let version = 0, pending = null, saving = false, last = null;
    const refreshButtons = ['naiAccountRefresh', 'naiSettingsRefresh'];
    const keyButtons = ['naiKeySave', 'naiKeyRemove'];

    function busy() {
        refreshButtons.forEach(id => { const button = byId(id); if (button) button.disabled = Boolean(pending) || saving; });
        keyButtons.forEach(id => { const button = byId(id); if (button) button.disabled = saving; });
        const keyInput = byId('naiApiKey');
        if (keyInput) keyInput.disabled = saving;
    }

    function render(data) {
        last = data;
        const valid = data.status === 'ok';
        const usage = valid ? data.usage : null;
        const quota = usage && Number.isFinite(usage.percent)
            ? `${usage.is_negative ? '−' : ''}${Math.abs(usage.percent)}%` : '—';
        const anlas = valid && Number.isFinite(data.anlas) ? data.anlas.toLocaleString('ko-KR') : '—';
        byId('naiQuotaLabel').textContent = !data.configured ? 'NovelAI 키 설정' : data.status === 'error' ? '할당량 조회 실패' : `할당량 ${quota}`;
        byId('naiAnlasLabel').textContent = `Anlas ${anlas}`;
        const settingsQuota = byId('naiSettingsQuota');
        const settingsAnlas = byId('naiSettingsAnlas');
        const keyHint = byId('naiKeyHint');
        const badge = byId('naiAccountBadge');
        if (settingsQuota) settingsQuota.textContent = quota;
        if (settingsAnlas) settingsAnlas.textContent = anlas;
        if (keyHint) keyHint.textContent = data.configured ? `저장됨 · ${data.key_hint || '••••'}` : '등록된 키 없음';
        if (badge?.parentNode) {
            badge.parentNode.dataset.state = data.status;
            badge.parentNode.dataset.negative = String(Boolean(usage?.is_negative));
        }
        const detail = [];
        if (!data.configured) detail.push('API 키를 저장하면 할당량과 Anlas를 확인할 수 있습니다.');
        else if (!valid) detail.push(data.message || '계정 정보를 조회하지 못했습니다. 다시 새로고침해 주세요.');
        else {
            if (!usage) detail.push('이 계정은 할당량 정보를 제공하지 않습니다.');
            if (usage?.is_negative) detail.push('할당량을 모두 사용했습니다.');
            if (usage && Number.isFinite(usage.seconds_until_next_percent) && usage.percent < 100 && usage.seconds_until_next_percent > 0) {
                detail.push(`다음 1% 회복까지 약 ${Math.ceil(usage.seconds_until_next_percent / 60)}분`);
            }
            if (data.subscription_active === false) detail.push('구독 비활성');
            if (data.checked_at) detail.push(`${new Date(data.checked_at * 1000).toLocaleTimeString('ko-KR', {hour: '2-digit', minute: '2-digit'})} 확인`);
            detail.push('화면을 보는 동안 1분마다 갱신됩니다.');
        }
        const accountDetail = byId('naiAccountDetail');
        if (accountDetail) accountDetail.textContent = detail.join(' · ');
        if (badge) {
            const action = byId('naiAccountSettings') ? '키와 잔액 설정 열기' : '잔액 새로고침';
            badge.title = `${detail.join(' · ')} — ${action}`;
        }
    }

    async function refresh(force = false) {
        if (saving) return;
        if (pending) return pending;
        const ticket = version;
        const task = (async () => {
            try {
                const response = await win.fetch('/api/novelai/account' + (force ? '?refresh=1' : ''), {cache: 'no-store'});
                if (!response.ok) throw new Error('조회 실패');
                const data = await response.json();
                if (ticket === version) render(data);
            } catch (_) {
                if (ticket === version) render({configured: last?.configured ?? true, key_hint: last?.key_hint, status: 'error', message: '계정 정보를 조회하지 못했습니다. 서버 연결을 확인하고 새로고침해 주세요.'});
            } finally {
                if (ticket === version) { pending = null; busy(); }
            }
        })();
        pending = task;
        busy();
        return task;
    }

    function clearDraft() {
        const keyInput = byId('naiApiKey');
        const keyReveal = byId('naiKeyReveal');
        const keyStatus = byId('naiKeyStatus');
        if (keyInput) {
            keyInput.value = '';
            keyInput.type = 'password';
        }
        if (keyReveal) {
            keyReveal.textContent = '표시';
            keyReveal.setAttribute('aria-pressed', 'false');
        }
        if (keyStatus) keyStatus.textContent = '';
    }

    async function saveKey(remove = false) {
        if (!byId('naiApiKey')) return;
        if (saving) return;
        const key = remove ? '' : byId('naiApiKey').value.trim();
        if (!remove && !key) {
            byId('naiKeyStatus').textContent = '저장할 API 키를 입력해 주세요.';
            byId('naiKeyStatus').dataset.error = 'true';
            return;
        }
        if (remove && !win.confirm('저장된 NovelAI API 키를 삭제할까요?')) return;
        saving = true;
        version += 1;
        pending = null;
        busy();
        byId('naiKeyStatus').textContent = '저장 중…';
        byId('naiKeyStatus').dataset.error = 'false';
        try {
            const response = await win.fetch('/api/novelai/key', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({key})});
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || '키를 저장하지 못했습니다.');
            clearDraft();
            render({...data, status: data.configured ? 'loading' : 'unconfigured', message: '저장한 키로 계정 정보를 확인하고 있습니다.'});
            byId('naiKeyStatus').textContent = remove ? '키를 삭제했습니다.' : '키를 저장했습니다. 다음 생성부터 적용됩니다.';
        } catch (_) {
            byId('naiKeyStatus').textContent = '키를 저장하지 못했습니다. 서버 연결과 입력값을 확인해 주세요.';
            byId('naiKeyStatus').dataset.error = 'true';
        } finally {
            saving = false;
            busy();
        }
        return refresh(true);
    }

    function openSettings() {
        if (!byId('naiAccountSettings') || !byId('naiApiKey')) return;
        win.openGalleryDesignSettings();
        byId('naiAccountSettings').scrollIntoView({block: 'start'});
        byId('naiApiKey').focus({preventScroll: true});
    }

    function initialize() {
        if (!byId('naiAccountBadge')) return;
        const badge = byId('naiAccountBadge');
        badge.addEventListener('click', () => byId('naiAccountSettings') ? openSettings() : refresh(true));
        refreshButtons.forEach(id => byId(id)?.addEventListener('click', () => refresh(true)));
        byId('naiKeyForm')?.addEventListener('submit', event => { event.preventDefault(); saveKey(); });
        byId('naiKeyRemove')?.addEventListener('click', () => saveKey(true));
        const keyReveal = byId('naiKeyReveal');
        const keyInput = byId('naiApiKey');
        if (keyReveal && keyInput) keyReveal.addEventListener('click', () => {
            const reveal = keyInput.type === 'password';
            keyInput.type = reveal ? 'text' : 'password';
            keyReveal.textContent = reveal ? '숨김' : '표시';
            keyReveal.setAttribute('aria-pressed', String(reveal));
        });
        doc.addEventListener('visibilitychange', () => { if (!doc.hidden) refresh(); });
        win.setInterval(() => { if (!doc.hidden && last?.configured) return refresh(); }, 60000);
        return refresh();
    }
    return {initialize, refresh, clearDraft, saveKey};
}

if (typeof module === 'object' && module.exports) module.exports = {createNovelAIAccount};
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        window.NovelAIAccount = createNovelAIAccount(document, window);
        window.NovelAIAccount.initialize();
    });
}
