(function (root) {
  function mount(host, options = {}) {
    if (!host || typeof host.querySelector !== 'function') return { dispose() {} };
    if (host.__dakiDictionaryDownloadMount) return host.__dakiDictionaryDownloadMount;
    const downloadButton = host.querySelector('#dictionaryDownloadImages');
    const statusLine = host.querySelector('#dictionaryImagePackStatus');
    const stopButton = host.querySelector('#dictionaryStopImagePack');
    const statusRow = host.querySelector('.image-pack-status-row');
    if (!downloadButton || !statusLine || !stopButton || !statusRow) return { dispose() {} };

    const endpoint = '/api/daki/dictionary/image-pack';
    const listeners = [];
    const completedJobs = new Set();
    let disposed = false;
    let available = null;
    let loaded = false;
    let job = null;
    let requestError = '';
    let starting = false;
    let stopping = false;
    let requestGeneration = 0;
    let readController = null;
    let pollTimer = null;

    const isVisible = () => root.document?.visibilityState !== 'hidden';
    const listen = (target, type, handler) => {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    };
    const number = value => Math.max(0, Number(value) || 0).toLocaleString('ko-KR');
    const numeric = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;

    function formatBytes(value) {
      const megabytes = (numeric(value) || 0) / (1024 * 1024);
      return `${megabytes.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}MB`;
    }

    function progressText(currentJob) {
      const phase = String(currentJob?.phase || '').toLowerCase();
      const current = numeric(currentJob?.phase_current);
      const total = numeric(currentJob?.phase_total);
      if (phase.includes('download') || phase.includes('다운로드')) {
        if (current !== null && total !== null && total > 0) {
          const percent = Math.min(100, current / total * 100);
          return `다운로드 ${formatBytes(current)} / ${formatBytes(total)} (${percent.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%)`;
        }
        if (current !== null) return `다운로드 ${formatBytes(current)}`;
      }
      if (phase.includes('extract') || phase.includes('압축') || phase.includes('해제')) {
        if (current !== null && total !== null && total > 0) return `이미지 압축 해제 ${number(current)} / ${number(total)}장`;
        if (current !== null) return `이미지 압축 해제 ${number(current)}장`;
      }
      return String(currentJob?.message || '예시 이미지를 준비하고 있습니다.');
    }

    function jobId(currentJob) {
      const value = currentJob?.id;
      return value === null || value === undefined || value === '' ? null : String(value);
    }

    function showInstalled(currentJob) {
      if (currentJob?.status !== 'completed') return;
      const id = jobId(currentJob);
      if (!id || completedJobs.has(id)) return;
      completedJobs.add(id);
      options.onInstalled?.(currentJob);
    }

    function render() {
      if (disposed) return;
      const status = String(job?.status || 'idle');
      const busy = starting || stopping || status === 'running' || status === 'stopping';
      const connected = available === false;
      downloadButton.disabled = !loaded || starting || stopping || status === 'running' || status === 'stopping' || connected;
      downloadButton.textContent = starting ? '다운로드 시작 중…'
        : !loaded ? '다운로드 준비 중…'
          : connected ? '이미지 연결됨' : '예시 이미지 다운로드';
      downloadButton.title = connected ? '사용 중인 이미지가 있어 예시 이미지를 자동 연결하지 않습니다.' : '';

      const showStatus = Boolean(requestError || status === 'running' || status === 'stopping'
        || status === 'completed' || status === 'failed' || status === 'stopped');
      statusRow.hidden = !showStatus;
      statusLine.setAttribute?.('aria-busy', String(busy));
      stopButton.hidden = status !== 'running' && status !== 'stopping';
      stopButton.disabled = stopping || status === 'stopping';
      stopButton.textContent = stopping || status === 'stopping' ? '중지 중…' : '다운로드 중지';

      if (requestError) {
        statusLine.textContent = requestError;
        return;
      }
      if (status === 'running' || status === 'stopping') {
        const progress = progressText(job);
        statusLine.textContent = job?.message && progress !== job.message ? `${progress} · ${job.message}` : progress;
      } else if (status === 'completed') {
        statusLine.textContent = `예시 이미지 연결 완료 · ${number(job?.installed)}장`;
      } else if (status === 'failed') {
        statusLine.textContent = String(job?.message || '예시 이미지 다운로드에 실패했습니다. 다시 시도해 주세요.');
      } else if (status === 'stopped') {
        statusLine.textContent = String(job?.message || '예시 이미지 다운로드를 중지했습니다.');
      } else {
        statusLine.textContent = '';
      }
    }

    function clearPoll() {
      if (pollTimer !== null) root.clearTimeout(pollTimer);
      pollTimer = null;
    }

    function abortRead() {
      readController?.abort();
      readController = null;
    }

    function schedulePoll() {
      clearPoll();
      if (disposed || !isVisible() || !['running', 'stopping'].includes(job?.status)) return;
      pollTimer = root.setTimeout(() => {
        pollTimer = null;
        refresh();
      }, 1000);
    }

    async function fetchJson(path, method = 'GET', signal) {
      const response = await root.fetch(path, {
        method,
        ...(signal ? { signal } : {}),
        headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || '예시 이미지 작업을 처리하지 못했습니다. 다시 시도해 주세요.');
        error.job = data.job;
        throw error;
      }
      return data;
    }

    function applySnapshot(data) {
      if (typeof data?.available === 'boolean') available = data.available;
      if (data?.job && typeof data.job === 'object') job = data.job;
      else if (!job) job = { status: 'idle' };
      loaded = true;
      requestError = '';
      showInstalled(job);
      render();
      schedulePoll();
    }

    async function refresh() {
      if (disposed || !isVisible()) return;
      const generation = requestGeneration;
      abortRead();
      const controller = new AbortController();
      readController = controller;
      try {
        const data = await fetchJson(endpoint, 'GET', controller.signal);
        if (disposed || generation !== requestGeneration || readController !== controller) return;
        if (typeof data?.available !== 'boolean') throw new Error('예시 이미지 사용 가능 여부를 확인하지 못했습니다.');
        applySnapshot(data);
      } catch (error) {
        if (disposed || error.name === 'AbortError' || generation !== requestGeneration) return;
        if (error.job && generation === requestGeneration) job = error.job;
        loaded = true;
        requestError = `예시 이미지 상태를 확인하지 못했습니다. ${error.message}`;
        render();
        schedulePoll();
      } finally {
        if (readController === controller) readController = null;
      }
    }

    async function startDownload() {
      if (disposed || starting || stopping || !loaded || available === false
        || ['running', 'stopping'].includes(job?.status)) return;
      starting = true;
      const generation = ++requestGeneration;
      abortRead();
      clearPoll();
      requestError = '';
      render();
      try {
        const data = await fetchJson(endpoint, 'POST');
        if (disposed || generation !== requestGeneration) return;
        starting = false;
        requestGeneration += 1;
        abortRead();
        applySnapshot(data);
      } catch (error) {
        if (disposed || generation !== requestGeneration) return;
        starting = false;
        requestGeneration += 1;
        abortRead();
        if (error.job) job = error.job;
        requestError = error.message;
        loaded = true;
        render();
        schedulePoll();
      }
    }

    async function stopDownload() {
      if (disposed || starting || stopping || job?.status !== 'running') return;
      stopping = true;
      const generation = ++requestGeneration;
      abortRead();
      clearPoll();
      requestError = '';
      render();
      try {
        const data = await fetchJson(`${endpoint}/stop`, 'POST');
        if (disposed || generation !== requestGeneration) return;
        stopping = false;
        requestGeneration += 1;
        abortRead();
        applySnapshot(data);
      } catch (error) {
        if (disposed || generation !== requestGeneration) return;
        stopping = false;
        requestGeneration += 1;
        abortRead();
        if (error.job) job = error.job;
        requestError = error.message;
        render();
        schedulePoll();
      }
    }

    listen(downloadButton, 'click', startDownload);
    listen(stopButton, 'click', stopDownload);
    listen(root.document, 'visibilitychange', () => {
      if (root.document?.visibilityState === 'hidden') {
        clearPoll();
        abortRead();
      } else refresh();
    });

    const handle = {
      dispose() {
        if (disposed) return;
        disposed = true;
        requestGeneration += 1;
        clearPoll();
        abortRead();
        for (const remove of listeners.splice(0)) remove();
        if (host.__dakiDictionaryDownloadMount === handle) delete host.__dakiDictionaryDownloadMount;
      },
    };
    host.__dakiDictionaryDownloadMount = handle;
    downloadButton.disabled = true;
    downloadButton.textContent = '다운로드 준비 중…';
    statusRow.hidden = true;
    stopButton.hidden = true;
    refresh();
    return handle;
  }

  root.DakiDictionaryDownload = { mount };
})(window);
