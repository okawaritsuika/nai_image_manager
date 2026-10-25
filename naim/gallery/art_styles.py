"""Artist and weighted style prompt conversion."""
import re
import time


def format_artist_style_prompt_for_daki(artist_name):
    text = str(artist_name or '').strip()

    if not text:
        return ""

    # 이미 가중치 문법이면 그대로 사용
    if "::" in text:
        return text

    # 이미 artist: 형식이면 그대로 가중치 문법으로 감싼다.
    if text.startswith("artist:"):
        return f"1.0::{text}::"

    # DB의 artist 원본 키를 NovelAI 가중치 문법으로 변환
    return f"1.0::artist:{text}::"

def is_weighted_order_style_prompt(text):
    text = str(text or "").strip()
    if not text:
        return False

    # ART STYLE MANAGER의 그림체 값을 다키 프롬프트에 맞게 변환
    if text.startswith("[가중치]"):
        return True

    # 0.30::artist:xxx:: 같은 NovelAI 가중치 문법 포함
    if "::artist:" in text or re.search(r'\d+(?:\.\d+)?::\s*artist:', text):
        return True

    return False


def cleanup_weighted_order_style_prompt(text):
    text = str(text or "").strip()

    # 표시용 접두어 제거
    text = re.sub(r'^\[가중치]\s*', '', text).strip()

    return text

def normalize_style_lab_artist_name_from_manager(value):
    text = str(value or "").strip()
    text = text.replace("\\\\n", " ").replace("\\n", " ").replace("\n", " ")
    text = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', text).strip()
    text = re.sub(r'^[-+]?\d+(?:\.\d+)?::\s*', '', text).strip()

    if text.lower().startswith("artist:"):
        text = text[7:].strip()

    text = re.sub(r'\s*::$', '', text).strip()
    text = text.strip(" ,[]{}()")
    text = re.sub(r'\s+', '_', text)

    blocked = {
        "",
        "1",
        "3",
        "none",
        "collaboration",
        "artist_collaboration",
        "artist:collaboration",
        "multiple_artists",
        "solo_artist",
        "artist_request",
    }

    if text.lower() in blocked:
        return ""

    return text


def parse_art_style_manager_prompt_to_style_tags(raw_text):
    text = str(raw_text or "").strip()
    text = text.replace("\\\\n", "\n").replace("\\n", "\n")
    text = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', text).strip()

    result = []
    seen = set()

    def add_artist(name, weight=1.0):
        name = normalize_style_lab_artist_name_from_manager(name)
        if not name:
            return

        key = name.lower()
        if key in seen:
            return

        seen.add(key)
        result.append({
            "weight": float(weight),
            "name": name
        })

    # 1. 가중치 artist 토큰 먼저 수집
    # 예: 1.25::artist:foo::, -0.2::artist:bar::
    weighted_pattern = re.compile(
        r'([-+]?\d+(?:\.\d+)?)::\s*artist:\s*(.*?)(?=::)',
        re.IGNORECASE | re.DOTALL
    )

    weighted_spans = []

    for match in weighted_pattern.finditer(text):
        try:
            weight = float(match.group(1))
        except Exception:
            weight = 1.0

        add_artist(match.group(2), weight)
        weighted_spans.append(match.span())

    # 2. 가중치 토큰을 공백으로 지운 뒤, 남은 일반 artist 태그도 수집
    # 예: artist:foo, artist:bar
    remainder_parts = []
    last = 0

    for start, end in weighted_spans:
        remainder_parts.append(text[last:start])
        remainder_parts.append(" ")
        last = end

    remainder_parts.append(text[last:])
    remainder = "".join(remainder_parts)

    plain_artist_pattern = re.compile(
        r'artist:\s*([^,\]\}\|\n\r\t\\:]+)',
        re.IGNORECASE
    )

    for match in plain_artist_pattern.finditer(remainder):
        add_artist(match.group(1), 1.0)

    # 3. artist: 없이 단일 작가명만 저장된 오래된 항목 폴백
    if not result and "artist:" not in text.lower() and "," not in text:
        add_artist(text, 1.0)

    return result

def make_unique_style_lab_style_name(base_name, styles_data, artists_data):
    base_name = str(base_name or "").strip()
    base_name = base_name.replace("\\\\n", " ").replace("\\n", " ").replace("\n", " ")
    base_name = re.sub(r'^\[(?:가중치|조합형)\]\s*', '', base_name).strip()
    base_name = re.sub(r'\s+', ' ', base_name).strip()

    if len(base_name) > 80:
        base_name = base_name[:77].rstrip() + "..."

    if not base_name:
        base_name = "ART STYLE MANAGER"

    used = set(styles_data.keys()) | set(artists_data.keys())

    if base_name not in used:
        return base_name

    for index in range(2, 10000):
        candidate = f"{base_name} ({index})"
        if candidate not in used:
            return candidate

    return f"{base_name} {int(time.time())}"

