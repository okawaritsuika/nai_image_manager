const test = require('node:test');
const assert = require('node:assert/strict');

const {
    confirmedBasePrompt,
    confirmedGeneratedSourceValues,
    attachConfirmedStyleSuspects,
    filterStyleManagerItems,
    loadConfirmedPromptFields,
    readConfirmedStyleForm,
    setConfirmedPromptMode,
    styleState,
} = require('../naim/style_manager/static/style_maker');

function createElement(value = '') {
    const classes = new Set();
    const attributes = new Map();
    return {
        value: String(value),
        checked: false,
        textContent: '',
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            contains(name) { return classes.has(name); },
            toggle(name, force) {
                if (force === undefined) force = !classes.has(name);
                if (force) classes.add(name);
                else classes.delete(name);
                return force;
            },
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name) ?? null; },
    };
}

function setupForm() {
    const ids = {
        confirmedStylePromptMode: 'base',
        confirmedStyleBasePrompt: '',
        confirmedStyleArtistPrompt: '',
        confirmedStyleQualityPrompt: '',
        confirmedStyleFixedPrompt: '',
        confirmedStyleBaseSection: '',
        confirmedStyleSplitSection: '',
        confirmedStylePromptHint: '',
        confirmedStyleName: 'Synthetic style',
        confirmedStyleDescription: 'Synthetic description',
        confirmedStyleCharacterPrompts: 'character_a\n\ncharacter_b',
        confirmedStyleNegativePrompt: 'negative_a',
        confirmedStyleSampler: 'k_euler_ancestral',
        confirmedStyleScheduler: 'karras',
        confirmedStyleSteps: '28',
        confirmedStyleScale: '5.5',
        confirmedStyleCfgRescale: '0.2',
        confirmedStyleVariety: '1',
        confirmedStyleQualityToggle: '',
        confirmedStyleUcPreset: '3',
        confirmedStyleComplexity: 'high',
        confirmedStyleModel: 'nai-diffusion-5-full',
    };
    const elements = new Map(Object.entries(ids).map(([id, value]) => [id, createElement(value)]));
    elements.get('confirmedStyleQualityToggle').checked = true;
    global.document = { getElementById: (id) => elements.get(id) || null };
    styleState.confirmedPromptMode = 'base';
    styleState.confirmedPromptBaseline = '';
    styleState.confirmedModalOriginalQualityPrompt = '';
    styleState.confirmedModalExcludedTags = [];
    return elements;
}

test('confirmed style prompt modes preserve a full base and retain split fields across conversions', () => {
    const elements = setupForm();
    const fullBase = 'quality_a, 1.2::artist:synthetic_a::, fixed_a, quality_b';

    assert.equal(confirmedBasePrompt({ base_prompt: fullBase, artist_prompt: 'stale' }), fullBase);
    assert.equal(confirmedBasePrompt({ base_prompt: '', artist_prompt: 'ignored', quality_prompt: 'ignored' }), '');
    assert.equal(confirmedBasePrompt({ artist_prompt: 'artist_a', quality_prompt: 'quality_a', fixed_prompt: 'fixed_a' }), 'artist_a, quality_a, fixed_a');
    assert.equal(confirmedBasePrompt({ base_prompt: null, artist_prompt: 'artist_a', quality_prompt: 'quality_a', fixed_prompt: 'fixed_a' }), 'artist_a, quality_a, fixed_a');
    const groups = [{signature: 'artist:synthetic_a'}];
    const savedStyle = {artist_prompt: 'artist:stale', base_artist_prompt: 'artist:synthetic_a'};
    attachConfirmedStyleSuspects(groups, [savedStyle]);
    assert.deepEqual(groups[0].suspectedStyles, [savedStyle]);
    const searchable = {base_prompt: fullBase, artist_prompt: 'obsolete_artist', quality_prompt: 'obsolete_quality'};
    assert.deepEqual(filterStyleManagerItems([searchable], 'confirmed', {query:'obsolete_artist'}), []);
    assert.deepEqual(filterStyleManagerItems([searchable], 'confirmed', {query:'synthetic_a'}), [searchable]);

    loadConfirmedPromptFields({
        base_prompt: fullBase,
        artist_prompt: 'stale_artist',
        quality_prompt: 'stale_quality',
        fixed_prompt: 'stale_fixed',
    }, 'base');
    assert.equal(elements.get('confirmedStyleBasePrompt').value, fullBase);
    assert.equal(elements.get('confirmedStylePromptMode').value, 'base');
    assert.equal(elements.get('confirmedStyleBaseSection').classList.contains('hidden'), false);
    assert.equal(elements.get('confirmedStyleSplitSection').classList.contains('hidden'), true);

    let form = readConfirmedStyleForm();
    assert.equal(form.base_prompt, fullBase);
    assert.equal(form.artist_prompt, 'stale_artist');
    assert.equal(form.quality_prompt, 'stale_quality');
    assert.equal(form.fixed_prompt, 'stale_fixed');
    assert.deepEqual({
        name: form.name,
        character_prompts: form.character_prompts,
        negative_prompt: form.negative_prompt,
        sampler: form.sampler,
        noise_schedule: form.noise_schedule,
        steps: form.steps,
        scale: form.scale,
        cfg_rescale: form.cfg_rescale,
        variety_plus: form.variety_plus,
        quality_toggle: form.quality_toggle,
        uc_preset: form.uc_preset,
        complexity: form.complexity,
        model: form.model,
    }, {
        name: 'Synthetic style',
        character_prompts: ['character_a', 'character_b'],
        negative_prompt: 'negative_a',
        sampler: 'k_euler_ancestral',
        noise_schedule: 'karras',
        steps: 28,
        scale: 5.5,
        cfg_rescale: 0.2,
        variety_plus: true,
        quality_toggle: true,
        uc_preset: 3,
        complexity: 'high',
        model: 'nai-diffusion-5-full',
    });

    setConfirmedPromptMode('split');
    form = readConfirmedStyleForm();
    assert.equal(form.base_prompt, null);
    assert.equal(form.artist_prompt, 'stale_artist');
    assert.equal(form.quality_prompt, 'stale_quality');
    assert.equal(form.fixed_prompt, 'stale_fixed');

    setConfirmedPromptMode('base');
    assert.equal(elements.get('confirmedStyleBasePrompt').value, fullBase);
    setConfirmedPromptMode('split');

    elements.get('confirmedStyleArtistPrompt').value = '1.25::artist:synthetic_a::';
    elements.get('confirmedStyleQualityPrompt').value = '((quality:synthetic))';
    elements.get('confirmedStyleFixedPrompt').value = 'fixed_edit';
    setConfirmedPromptMode('base');
    assert.equal(elements.get('confirmedStyleBasePrompt').value, '1.25::artist:synthetic_a::, ((quality:synthetic)), fixed_edit');

    const editedBase = 'free_a, (free group), 1.2::artist:synthetic_a::';
    loadConfirmedPromptFields({
        base_prompt: fullBase,
        artist_prompt: 'old_artist',
        quality_prompt: 'old_quality',
        fixed_prompt: 'old_fixed',
    }, 'base');
    elements.get('confirmedStyleBasePrompt').value = editedBase;
    setConfirmedPromptMode('split');
    assert.equal(elements.get('confirmedStyleArtistPrompt').value, '');
    assert.equal(elements.get('confirmedStyleQualityPrompt').value, editedBase);
    assert.equal(elements.get('confirmedStyleFixedPrompt').value, '');
    assert.equal(elements.get('confirmedStylePromptHint').textContent.includes('옮겼습니다'), true);
    form = readConfirmedStyleForm();
    assert.equal(form.base_prompt, null);
    assert.equal(form.quality_prompt, editedBase);

    setConfirmedPromptMode('base');
    assert.equal(elements.get('confirmedStyleBasePrompt').value, editedBase);

    loadConfirmedPromptFields({
        artist_prompt: 'new_artist',
        quality_prompt: 'new_quality',
        fixed_prompt: 'new_fixed',
    }, 'split');
    assert.equal(elements.get('confirmedStylePromptMode').value, 'split');
    assert.equal(elements.get('confirmedStyleBasePrompt').value, 'new_artist, new_quality, new_fixed');
    assert.equal(elements.get('confirmedStyleArtistPrompt').value, 'new_artist');
    assert.equal(elements.get('confirmedStyleQualityPrompt').value, 'new_quality');
    assert.equal(elements.get('confirmedStyleFixedPrompt').value, 'new_fixed');
    assert.equal(readConfirmedStyleForm().base_prompt, null);

    loadConfirmedPromptFields({base_prompt: fullBase}, 'base');
    setConfirmedPromptMode('split');
    assert.equal(readConfirmedStyleForm().quality_prompt, fullBase);
    setConfirmedPromptMode('base');
    assert.equal(readConfirmedStyleForm().base_prompt, fullBase);

    const generatedWithCompleteBase = confirmedGeneratedSourceValues({
        id: 7,
        leading_prompt: 'leading_a',
        artist_prompt: 'artist_explicit',
        base_prompt: 'quality_complete, fixed_complete',
        quality_prompt: 'quality_duplicate',
        fixed_prompt: 'fixed_duplicate',
    });
    assert.equal(generatedWithCompleteBase.base_prompt, 'leading_a, artist_explicit, quality_complete, fixed_complete');

    const generatedWithoutBase = confirmedGeneratedSourceValues({
        id: 8,
        leading_prompt: 'leading_b',
        artists: [{ artist: 'synthetic_a', weight: 1.2 }],
        quality_prompt: '(quality_b)',
        fixed_prompt: 'fixed_b',
    });
    assert.equal(generatedWithoutBase.base_prompt, 'leading_b, 1.2::artist:synthetic a::, (quality_b), fixed_b');

    delete global.document;
});
