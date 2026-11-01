/* Only common generation defaults cross the application boundary. */
(() => {
  const fields = {generationModel:'model', generationWidth:'width', generationHeight:'height',
    generationSampler:'sampler', generationScheduler:'noise_schedule', generationSteps:'steps',
    generationScale:'scale', generationCfgRescale:'cfg_rescale'};
  let applying = false, dirty = {}, timer, busy = false, ready = false;
  async function exchange(method = 'GET', body) {
    const response = await fetch('/style-workspace/api/naim-shared-settings', {method,
      headers: {'Content-Type':'application/json', 'X-NAIM-Workspace':'1'},
      ...(body ? {body:JSON.stringify(body)} : {})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '공통 설정 연결을 확인해 주세요.');
    return data.defaults || {};
  }
  function apply(defaults) {
    if (typeof styleState === 'undefined' || !styleState.initialized) return;
    applying = true;
    try {
      for (const [id, key] of Object.entries(fields)) {
        const element = document.getElementById(id);
        if (!element || key in dirty || defaults[key] == null || document.activeElement === element) continue;
        // Medium's fixed controls keep their stored unconstrained values.
        if (element.mediumBackup) element.mediumBackup.value = String(defaults[key]);
        else element.value = String(defaults[key]);
      }
      for (const [id,key] of [['generationScaleRange','scale'],['generationCfgRescaleRange','cfg_rescale']]) {
        const element = document.getElementById(id);
        if (element && !(key in dirty) && defaults[key] != null) element.value = String(defaults[key]);
      }
      const preset = document.getElementById('generationResolutionPreset');
      if (preset && defaults.width != null && defaults.height != null && !('width' in dirty) && !('height' in dirty)) {
        const size = `${defaults.width}x${defaults.height}`;
        preset.value = [...preset.options].some(option => option.value === size) ? size : 'custom';
      }
      if (typeof syncGenerationMediumControls === 'function') syncGenerationMediumControls();
      ready = true;
    } finally { applying = false; }
  }
  async function sync() {
    if (busy || document.hidden) return;
    busy = true;
    const patch = dirty; dirty = {};
    try { apply(await exchange(Object.keys(patch).length ? 'PUT' : 'GET', Object.keys(patch).length ? patch : undefined)); }
    catch (error) {
      dirty = {...patch, ...dirty};
      if (typeof showStyleStatus === 'function') showStyleStatus(error.message, 'error');
    } finally { busy = false; }
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'generationResolutionPreset' && ready && !applying) {
      const settings = readGenerationSettings();
      dirty.width = settings.width; dirty.height = settings.height;
      clearTimeout(timer); timer = setTimeout(sync, 300);
      return;
    }
    const key = fields[event.target.id] || ({generationScaleRange:'scale',generationCfgRescaleRange:'cfg_rescale'})[event.target.id];
    if (!key || applying || !ready) return;
    const settings = readGenerationSettings();
    dirty[key] = key === 'noise_schedule' ? settings.scheduler : settings[key];
    clearTimeout(timer); timer = setTimeout(sync, 300);
  });
  const interval = setInterval(sync, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
  window.addEventListener('pagehide', () => { clearInterval(interval); clearTimeout(timer); });
  void sync();
})();
