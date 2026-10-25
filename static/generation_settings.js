// Shared generation controls for canvas clips, references and gallery inpainting.
const NAI_GENERATION_FIELDS = [
    {key: 'model', id: 'Model', label: 'Model · 모델', value: 'nai-diffusion-5-full', options: [
        ['nai-diffusion-5-full', 'NovelAI Diffusion V5 Full'],
        ['nai-diffusion-5-full-medium', 'NovelAI Diffusion V5 Full Medium'],
        ['nai-diffusion-5-curated', 'NovelAI Diffusion V5 Curated'],
        ['nai-diffusion-4-5-full', 'NovelAI Diffusion V4.5 Full'],
        ['nai-diffusion-4-5-curated', 'NovelAI Diffusion V4.5 Curated']]},
    {key: 'sampler', id: 'Sampler', label: 'Sampler · 샘플러', value: 'k_euler_ancestral', options: [
        ['k_euler_ancestral', 'Euler Ancestral'], ['k_euler', 'Euler'],
        ['k_dpmpp_2m', 'DPM++ 2M'], ['k_dpmpp_2m_sde', 'DPM++ 2M SDE'],
        ['k_dpmpp_2s_ancestral', 'DPM++ 2S Ancestral'], ['k_dpmpp_sde', 'DPM++ SDE']]},
    {key: 'steps', id: 'Steps', label: 'Steps · 생성 단계', value: 28, min: 1, max: 50, step: 1},
    {key: 'cfg', id: 'Cfg', label: 'Prompt Guidance · 프롬프트 반영 강도', value: 6, min: 1, max: 20, step: 0.1,
        help: '높을수록 프롬프트를 강하게 반영합니다. 너무 높으면 색과 형태가 과해질 수 있습니다.'},
    {key: 'cfg_rescale', id: 'Rescale', label: 'Prompt Guidance Rescale · 강도 보정', value: 0.4, min: 0, max: 1, step: 0.01,
        help: '높은 Prompt Guidance에서 생기는 과도한 색 표현을 보정합니다. 0은 보정하지 않습니다.'},
    {key: 'noise_schedule', id: 'NoiseSchedule', label: 'Noise Schedule · 노이즈 스케줄', value: 'native', options: [
        ['native', 'Native'], ['karras', 'Karras'], ['exponential', 'Exponential'], ['polyexponential', 'Polyexponential']]},
    {key: 'seed', id: 'Seed', label: 'Seed · 시드 (-1: 무작위)', value: -1, min: -1, max: 4294967295, step: 1},
    {key: 'strength', id: 'Strength', label: 'Inpainting Strength · 변경 강도', value: 0.65, min: 0.01, max: 1, step: 0.01},
    {key: 'noise', id: 'Noise', label: 'Noise · 추가 노이즈', value: 0.2, min: 0, max: 1, step: 0.01}
];

const NAI_MEDIUM_FIXED_SETTINGS = {sampler: 'k_euler_ancestral', steps: 14, noise_schedule: 'karras'};

function formatGenerationSize(width, height, limits) {
    let divisor = width, remainder = height;
    while (remainder) [divisor, remainder] = [remainder, divisor % remainder];
    let label = `${width} × ${height} · ${width / divisor}:${height / divisor} (1:${(height / width).toFixed(2)})`;
    if (limits && width * 16 === height * 5) {
        const nextWidth = width + 5 * limits.step, nextHeight = height + 16 * limits.step;
        if (nextWidth > limits.max || nextHeight > limits.max || nextWidth * nextHeight > limits.max_pixels) label += ' · 5:16 최대';
    }
    if (limits && width * height === limits.max_pixels) label += ' · 최대 면적';
    return label;
}

function generationSettingId(prefix, field) {
    return prefix + field.id + (prefix === 'clip' ? 'Input' : '');
}

function applyGenerationModelConstraints(prefix, initializing = false) {
    const model = document.getElementById(prefix + 'Model' + (prefix === 'clip' ? 'Input' : ''));
    const medium = model?.value === 'nai-diffusion-5-full-medium';
    for (const field of NAI_GENERATION_FIELDS) {
        const fixed = field.key in NAI_MEDIUM_FIXED_SETTINGS;
        if (!fixed && field.key !== 'cfg_rescale') continue;
        const input = document.getElementById(generationSettingId(prefix, field));
        if (!input) continue;
        if (medium && fixed) {
            if (input.dataset.unrestrictedValue === undefined) {
                // Reopened Medium settings contain effective values, not the previous model's settings.
                input.dataset.unrestrictedValue = String(initializing ? field.value : input.value);
            }
            input.value = NAI_MEDIUM_FIXED_SETTINGS[field.key];
        } else if (input.dataset.unrestrictedValue !== undefined) {
            input.value = input.dataset.unrestrictedValue;
            delete input.dataset.unrestrictedValue;
        }
        input.disabled = medium;
        if (prefix === 'clip') {
            const range = document.getElementById(prefix + field.id + 'Range');
            if (range) { range.value = input.value; range.disabled = medium; }
        }
    }
    const note = document.getElementById(prefix + 'GenerationModelNote');
    if (note) note.hidden = !medium;
}

function setGenerationSettings(prefix, info) {
    const host = document.getElementById(prefix + 'GenerationSettings');
    if (!host) return;
    for (const field of NAI_GENERATION_FIELDS) {
        const id = generationSettingId(prefix, field);
        let input = document.getElementById(id);
        if (!input) {
            const wrap = document.createElement('div');
            wrap.className = 'clip-prompt-field';
            const label = document.createElement('label');
            label.htmlFor = id;
            input = document.createElement(field.options ? 'select' : 'input');
            input.id = id;
            wrap.append(label, input);
            host.appendChild(wrap);
        }
        const wrap = input.closest('.clip-prompt-field') || input.parentElement;
        wrap.querySelector('label').textContent = field.label;
        wrap.querySelector('label').htmlFor = id;
        host.appendChild(wrap);
        if (field.options) {
            input.replaceChildren(...field.options.map(([value, label]) => new Option(label, value)));
        }
        if (!field.options) {
            input.type = 'number';
            input.min = field.min; input.max = field.max; input.step = field.step;
        }
        input.required = true;
        input.title = field.help || field.label;
        let value = info[field.key];
        if (field.key === 'cfg') value = value ?? info.scale;
        if (field.key === 'model') value = String(value || '').replace(/-inpainting$/, '');
        if (value === undefined || value === null || value === '') value = field.value;
        if (field.options && !field.options.some(([key]) => key === String(value))) {
            // Imported older settings remain visible until the user chooses a supported value.
            input.appendChild(new Option(`선택 필요: ${value}`, value));
        }
        input.value = value;
        delete input.dataset.unrestrictedValue;
        if (prefix === 'clip') {
            const range = document.getElementById(prefix + field.id + 'Range');
            if (range) { range.min = field.min; range.value = value; }
        }
    }
    let note = document.getElementById(prefix + 'GenerationModelNote');
    if (!note) {
        note = document.createElement('small');
        note.id = prefix + 'GenerationModelNote';
        note.style.gridColumn = '1 / -1';
        note.textContent = 'Medium: 14 Steps · Euler Ancestral · Karras 고정. 강도 보정과 사용자 Negative Prompt는 적용되지 않습니다.';
    }
    host.appendChild(note);
    const model = document.getElementById(prefix + 'Model' + (prefix === 'clip' ? 'Input' : ''));
    model.onchange = () => applyGenerationModelConstraints(prefix);
    applyGenerationModelConstraints(prefix, true);
}

function readGenerationSettings(prefix) {
    applyGenerationModelConstraints(prefix);
    const values = {};
    for (const field of NAI_GENERATION_FIELDS) {
        const input = document.getElementById(generationSettingId(prefix, field));
        if (!input) return null;
        input.setCustomValidity(field.options && !field.options.some(([value]) => value === input.value)
            ? '지원되는 항목을 선택해 주세요.' : '');
        if (!input.reportValidity()) return null;
        values[field.key] = field.options ? input.value : Number(input.value);
    }
    return values;
}
