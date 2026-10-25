"""Validate inpainting settings and apply shared model constraints."""
import math

V5_FULL_MEDIUM = 'nai-diffusion-5-full-medium'
V5_MEDIUM_FIXED_SETTINGS = {'steps': 14, 'sampler': 'k_euler_ancestral', 'noise_schedule': 'karras', 'cfg_rescale': 0}
MODELS = {f'nai-diffusion-{version}-{variant}' for version in ('5', '4-5') for variant in ('full', 'curated')} | {V5_FULL_MEDIUM}
SAMPLERS = {'k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde',
            'k_dpmpp_2s_ancestral', 'k_dpmpp_sde'}
NOISE_SCHEDULES = {'native', 'karras', 'exponential', 'polyexponential'}
# NovelAI's V5 Heavy UC preset, fixed for Medium effort (docs.novelai.net/en/image/effort/).
V5_HEAVY_UC = ('lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, '
               'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, '
               'screentone, multiple views, logo, too many watermarks, negative space, blank page')


def normalize_inpaint_settings(info):
    def value(key, default):
        result = info.get(key)
        return default if result is None or result == '' else result

    model = str(value('model', 'nai-diffusion-5-full')).removesuffix('-inpainting')
    if model == V5_FULL_MEDIUM:
        # Ignore stale High settings; these controls are unavailable for Medium.
        info = dict(info, **V5_MEDIUM_FIXED_SETTINGS)

    sampler = value('sampler', 'k_euler_ancestral')
    schedule = value('noise_schedule', 'native')
    if model not in MODELS:
        raise ValueError('Model에서 V5 또는 V4.5 모델을 선택해 주세요.')
    if sampler not in SAMPLERS:
        raise ValueError('지원되는 Sampler를 선택해 주세요.')
    if schedule not in NOISE_SCHEDULES:
        raise ValueError('지원되는 Noise Schedule을 선택해 주세요.')
    result = {'model': model + '-inpainting', 'sampler': sampler, 'noise_schedule': schedule}
    for key, default, low, high, integer, label in (
        ('steps', 28, 1, 50, True, 'Steps'),
        ('cfg', value('scale', 6), 1, 20, False, 'Prompt Guidance'),
        ('cfg_rescale', 0.4, 0, 1, False, 'Prompt Guidance Rescale'),
        ('seed', -1, -1, 4294967295, True, 'Seed'),
        ('strength', 1.0, 0.01, 1, False, 'Inpainting Strength'),
        ('noise', 0.2, 0, 1, False, 'Noise'),
    ):
        try:
            number = float(value(key, default))
            valid = math.isfinite(number) and low <= number <= high and (not integer or number.is_integer())
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise ValueError(f'{label}: {low}~{high} 범위의 올바른 값을 입력해 주세요.')
        result[key] = int(number) if integer else number
    if model == V5_FULL_MEDIUM:
        result['cfg_rescale'] = ''
    return result


def apply_model_constraints(payload):
    """Apply Medium's fixed settings to text generation and inpainting requests."""
    if payload['model'].removesuffix('-inpainting') != V5_FULL_MEDIUM:
        return
    parameters = payload['parameters']
    parameters.update(V5_MEDIUM_FIXED_SETTINGS)
    parameters.pop('cfg_rescale', None)
    parameters['params_version'] = 4
    negative = ('' if 'nsfw' in payload['input'].lower() else 'nsfw, ') + V5_HEAVY_UC
    parameters['negative_prompt'] = negative
    parameters['tag_hint_uc_preset'] = 2
    parameters['v4_negative_prompt']['caption'] = {
        'base_caption': negative,
        'char_captions': [dict(caption, char_caption='')
                          for caption in parameters['v4_prompt']['caption']['char_captions']],
    }


def apply_inpaint_model_constraints(payload, prompt_info):
    """Record Medium's effective negative prompt for inpainting metadata."""
    if payload['model'] != V5_FULL_MEDIUM + '-inpainting':
        return
    apply_model_constraints(payload)
    for key in ('negativePrompt', 'negative_prompt', 'uc'):
        prompt_info[key] = payload['parameters']['negative_prompt']
