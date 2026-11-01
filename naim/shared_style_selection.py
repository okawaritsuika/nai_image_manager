"""Pure source and model filters for shared style selections."""
import re


_V5_MODEL = re.compile(
    r"\bnai-diffusion-5(?:-[a-z0-9]+)*\b|\bnaid5f\b|"
    r"\b(?:novelai\s+diffusion\s+)?v5(?:\s+full(?:[\s-]+medium)?)?\b"
)
_V4_5_MODEL = re.compile(
    r"\bnai-diffusion-4-5(?:-[a-z0-9]+)*\b|"
    r"\b(?:novelai\s+diffusion\s+)?v4\.5\b"
)


def model_family(value):
    """Return the generation family indicated by a model name."""
    text = str(value or "").strip().casefold()
    if _V5_MODEL.search(text):
        return "v5"
    if _V4_5_MODEL.search(text):
        return "v4_5"
    return "other"


def filter_styles(styles, source="all", model="all"):
    """Filter a style list by source and model without modifying its records."""
    if source not in {"all", "naim", "artist", "personal"}:
        raise ValueError("출처는 all, naim, artist, personal 중 하나여야 합니다.")
    if model not in {"all", "v5", "v4_5", "other"}:
        raise ValueError("모델은 all, v5, v4_5, other 중 하나여야 합니다.")

    selected = []
    for style in styles:
        style_source = style.get("source_library", "naim")
        style_model = style.get("model_family")
        if "model_family" not in style:
            style_model = model_family(style.get("model"))
        if source != "all" and style_source != source:
            continue
        if model != "all" and style_model != model:
            continue
        selected.append(style)
    return selected
