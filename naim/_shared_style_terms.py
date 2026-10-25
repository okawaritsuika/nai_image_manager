# Adapted from existing dakiMaker style-catalog research helpers and
# NAImakeArtistGroup board-analysis vocabulary; local catalog compatibility.
"""Reviewed rendering vocabulary for separating styles from depicted content.

This is intentionally an allowlist. Source subjects, actions and backgrounds
must never be copied wholesale into the common catalog portrait.
"""
import re
from naim._shared_style_syntax import key

STYLE_TAGS = {
    "medium": {
        "pixel art", "anime screencap", "game cg", "official art", "faux traditional media",
        "watercolor (medium)", "colored pencil (medium)", "ink (medium)", "marker (medium)",
        "ligne claire", "watercolor", "colored pencil", "ink", "marker",
    },
    "line": {
        "lineart", "no lineart", "jaggy lines", "sketch", "thick lineart", "colored lineart",
        "outline", "color trace", "gradient lineart", "vector trace",
    },
    "color": {
        "flat color", "anime coloring", "pastel colors", "muted color", "colorful",
        "limited palette", "pale color", "monochrome", "greyscale", "spot color", "sepia",
    },
    "painting": {"painterly", "oil painting", "digital painting", "traditional media"},
    "shading": {"depthness", "high contrast", "cel shading", "cel rendering", "soft shading"},
    "rendering": {"realistic", "photorealistic", "halftone", "dithering"},
    "style": {"meta:novel era", "meta:golden era", "visual novel art"},
}

STYLE_TAG_BLOCKS = {tag: block for block, tags in STYLE_TAGS.items() for tag in tags}

COMPLEXITY_TAGS = {"low complexity", "medium complexity", "high complexity", "ultra complexity", "depthness"}

YEAR_PATTERN = re.compile(r"^year\s+(?:19|20)\d{2}$")

QUALITY_TAG_ALIASES = {
    "quality": "quality",
    "masterpiece": "masterpiece",
    "best quality": "best quality",
    "amazing quality": "amazing quality",
    "high quality": "high quality",
    "very aesthetic": "very aesthetic",
    "great aesthetic": "great aesthetic",
    "aesthetic": "aesthetic",
    "highres": "highres",
    "hires": "highres",
    "high res": "highres",
    "absurdres": "absurdres",
    "incredibly absurdres": "incredibly absurdres",
    "newest": "newest",
    "detailed": "detailed",
    "highly detailed": "highly detailed",
    "ultra detailed": "ultra detailed",
    "very detailed": "very detailed",
    "extremely detailed": "extremely detailed",
    "high detail": "high detail",
    "hyper detail": "hyper detail",
    "best illustration": "best illustration",
    "novel illustration": "novel illustration",
    "simple illustration": "simple illustration",
    "commission": "commission",
}

def _classify_tag(tag, names):
    match = re.match(r'^(?:artist|artists)\s*:\s*(.+)$', tag.strip(), re.I)
    value = key(tag)
    if match and match.group(1).strip():
        return 'artist', 'artist:' + key(match.group(1))
    if value in names:
        return 'artist', 'artist:' + value
    quality = QUALITY_TAG_ALIASES.get(' '.join(tag.casefold().split()), '')
    if quality:
        return 'quality', quality
    if YEAR_PATTERN.fullmatch(value):
        return 'year', value
    if value in {'2d', '3d'}:
        return value, value
    if value in COMPLEXITY_TAGS:
        return 'complexity', value
    category = STYLE_TAG_BLOCKS.get(value)
    return (category, value) if category else ('', '')


EXTRA = {key(x) for x in '''
artist collaboration|artist collarboration|solo artist|official style|offical style|offical art|
expert shading|film grain|faux retro artstyle|retro artstyle|glossy skin|shiny skin|
detailed eyes|clean illustration|digital illustration|thick outlines|blender (medium)|
detailed shading|saturated colors|soft gradient shading|vibrant colors|intricate details|
muted colors|smooth gradients|detailed pupils|realistic texture|warm highlights|soft bloom|
glossy shading|subtle texture|soft colors|line art|best lighting|perfect shadow|top aesthetic|
bloom|toon (style)|photoshop (medium)|microsoft paint (medium)|chibi|vivid colors|abusdres|
draw body like oda non|draw body like artist:kokemomo (makesound)|draw body like artist:taesi|
ultra details|glossy lips|ultra-detailed|soft light|warm lighting|full color|
black outline|rough lines|black lines|bold outline|clear lineart|pale colors|clean lineart|
clean anime lineart|bold outer lineart|thin inner lineart|smooth digital shading|
large detailed eyes|hatching shading|shiny shading|2000s (style)|oil painting (medium)|
white outline|fine details|super detail|rich colors|high-quality digital art|detailed skin texture|
light reflection|oil shiny|screen tone|clean line art|color depth|subtle gradients|perfect anatomy|
shadows|3d render|rough sketch|desaturated colors|delicate lineart|natural shadows|fine lineart|
thin lines|balanced contrast|hatching (texture)|anime shading|1990s (style)|precise facial features|
incredible detail|detailed incredibly absurdres|subtle bloom|color harmony|cinematic anime lighting|
visual novel cg style|refined details|line weight|detailed anatomy|
consistent fine detail across the entire body|precisely resolved small-scale bodily details|
detailed rendering|complex lighting|finely detail|unity (medium)|dramatic contrast|
highly detailed facial|realistic skin textures|shadow|realistic skin texture|cell shading|
cartoon rendering|detailed hair|refined rendering|watercolor pencil (medium)|
draw lineart like artist:jacknife|draw eyes like artist:jacknife|draw face like artist:lal!role|
skin coloring like artist:lal!role|soft coloring|draw hair without lineart|draw hair with only colors|
vivid color|colored|detailed skin|detailed lineart|medium-thick outer lines|fine inner lines|
varied line weight|detailed irises|defined shadows|hard shadows|two-tone shading|layered cel shading|
hard-edged hair highlights|small hard-edged skin highlights|polished anime illustration|
finely detailed beautiful eyes and detailed face|highly detailed eyes|high detail eyes|high detail pupils|
zenless zone zero style|soft outlines|thick draw lines|brush style like zygocactus|suitable texture|
soft painterly anime illustration|textured digital painting|realistic face|realistic nose|sketch line|
black lineart|subtle ambient shading|balanced body shading|soft hair highlights|subtle hair highlights|
soft contrast|gentle shading|soft shadows|diffused lighting|delicate light and shadow|
enhanced body contours through light and shadow|strong sense of depth and volume in a 2d illustration|
forms should feel solid and dimensional through perspective and spatial placement rather than a 3d rendered appearance|
clean lighting|screentone|extremely glossy skin|high detail texture|colored eyelashes|partially colored|
best shadow|channel (caststation) (style)|detail eyes|realistic lighting|pores|eye highlights|
one piece style|clear lines|black outlines|comic style|doujinshi style|absusdres|complexity middle|
complexity low|skin microtexture|high color contrast|controlled highlights|moderate saturation|
pastel(medium)|manga style|detailed face|best illustration quality|light novel cover illustration art style|
novel illustration quality|korean webtoon illustration art style|dungeon&fighter official illustration art style|
korean idol webtoon illustration art style|official art style|ultra highres|extremely highres|
delicate features|polished rendering|clean detailed surfaces|rich material detail|highly detailed digital illustration|
natural detailed textures|realistic shadows|natural lighting|physically plausible lighting|
physically plausible shadows|natural light direction|consistent shadow direction|natural light falloff|
soft contact shadows|natural reflected light|realistic depth and shading|three-dimensional form shading|
subtle bounce light|natural ambient lighting|soft reflected light|novel illustration|blue archive style|
pastel (medium)|blotchy painting|highly detailed illustration|vibrant color|comic shading|
high quality realistic skin|hyper detailed|finely detailed|textured skin|color shading|deep shadow|
1980s (style)|intricate linework|rich saturation|realistic textures|crisp outlines|bold lines|hatching|
soft lineart|visual novel cg|beautiful detailed eyes|high face detail|deep colors|fully rendered|
highly detailed skin|detailed long eyelashes|full color manga|think lineart|shading|high complextiy|
high-density skin texture|ink ouline|clean lines|sharp shadows|detailed body|hyper detail|
selective color|clean cel shading|thick line|variable line weight|rough ink lines|crosshatching|
scribbled shading|dry brush|solid black shadows|great quality|honkai: star rail style|
jinki-style restrained|rich color|sharp lines|textured shading|pencil drawing|detailed clothes|
detailed incredibly|saturated|bright color|color shadow|mushoku tensei anime style|mushoku tensei style|
ultra realistic 3d render|pastel color|detail coloring|face shadow|gradient skin|digital graphics|
smooth shading|glossy highlights|2000's style|detailed nose|linear hatching|high saturation|
realistic proportions|glossy clothes|bold line|rich color palette|rich midtones|strong color identity|
clean saturated colors|distinct color blocks|clear separation of colors|vivid character colors|
moderately saturated colors|controlled shading|soft and restrained shadows|natural color transitions|
paper texture|realistic 3d render|detailed reflections|delicate facial features|sharp features|
cross-hatching|expert textures|high detailed|manga coloring|oversaturation|spectacular shadow|
beautiful light|vivid and realistic eyes|sharp and detailed irises|reflective highlights in the eyes|
smooth and realistic eyelids|finely detailed beautiful eyes|soft lighting|cinematic lighting|
volumetric lighting|backlighting|overexposure|ultra high resolution|4k|8k resolution|highly finished|
shiny hair|glossy hair|smooth skin|clean text|animated|anime style|painting|oekaki|tegaki|
dot nose|thick upper eyelashes|soft line|clear line|low poly|low poligon|vector trace|
photorealism|hyperrealism|lifelike|colored shadow|anime colors|anime syle|
commission|commision|best quality masterpiece|high quality|low complexivity|letro graphic|
high contrast. high saturation|expressive facial detail
'''.split('|') if x.strip()}

QUALITY_UC = {key(x) for x in '''
worst quality|jpeg artifacts|very displeasing|lowres|bad quality|chromatic aberration|
scan artifacts|logo|artistic error|too many watermarks|blank page|negative space|signature|
unfinished|bad proportions|bad eyes|blurry|bad hands|watermark|text|bad anatomy|extra digits|
fewer digits|bad perspective|disfigured|fewer details|distorted composition|displeasing|
deformed|mutation|incomplete|bad face|amputee|no text|artist name|empty eyes|distorted|
bad hand structure|disorganized colors|dated|inadequate|deficient|subpar|unsatisfactory|
aliasing|bad illustration|bad portrait|bad arm|poor|bad leg|unnatural hair|digital dissolve|
bad limbs|one-hour drawing challenge|heavy film grain|long neck|username|upscaled|mob face|
extra leg|extra legs|extra limbs|duplicate|anatomical structure error|cloudy eyes|
imperfect fingers|extra fingers|extra eyes|cross-eyed|malformed hands|screentones|ugly|
blank eyes|fused fingers|asymmetrical eyes|poorly drawn hands|mutated|poorly drawn face|
lazy eye|cloned face|missing limbs|distorted face|distorted body|captions|subtitles|
wrong body proportions|unrealistic proportions|wrong head size|bad feet|error|messy details|
unrealistic colors|cheesy|distorted anatomy|extra hands|asymmetrical face|vertical banding|
vertical lines|animation error|amateur|extra arms|bad legs|text-only page|bad limb|
missing finger|low quality|bad posture|normal quality|missing|fewer|extra|scan|
mismatched pupils|artist logo|ai-generated|anatomical nonsense|awkward
'''.split('|') if x.strip()}

# Bare artist names can collide with descriptive words in a large dictionary.
AMBIGUOUS_BARE = set('original solo girl boy female male nude nsfw censored uncensored rating:explicit rating:general'.split())

# These strings occur among weighted artists in the source style blocks. Keep
# their literal spelling; their identification is contextual, not an external
# claim that the model recognizes or accurately reproduces the named artist.
SOURCE_STYLE_NAMES = {'daram (sahppydude)', 'ing9', 'sohn woyoung', 'granada (guranada)'}
EXTRA_V1 = EXTRA.copy()
EXTRA.update({'watercolors', 'line clare', 'photo-referenced', 'monochorme',
              'year2025', 'year2026', 'blender(medium)'})


def classify(text, names, version=1):
    value=key(text)
    if version>=2:
        spaced=re.sub(r'\s*\(\s*',' (',value)
        if value in SOURCE_STYLE_NAMES:
            return 'artist','artist:'+value
        if spaced in names and value not in AMBIGUOUS_BARE:
            return 'artist','artist:'+spaced
    if value in (EXTRA if version>=2 else EXTRA_V1):
        return 'rendering', value
    if value in AMBIGUOUS_BARE:
        return '', ''
    category, normalized=_classify_tag(text,names)
    if category:
        return category, normalized
    if re.fullmatch(r'(?:19|20)\d0s \(style\)',value):
        return 'style',value
    return '', ''
