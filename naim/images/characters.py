"""Character alias matching; pure rules with no filesystem/AI dependencies."""
import re

# Character aliases are compiled once per classification run.  The old
# per-image exact lookup could only recognize a whole comma-separated token,
# so prose such as ``Ikuta Haruki is standing ...`` was missed.
_CHARACTER_PROMPT_BLACKLIST = (
    '(medium)', '(object)', '(clothes)', '(creature)', '(species)',
    '(item)', '(anatomy)', '(background)', '(cosplay)', '(style)',
    '(studio)', 'artist', 'uniform', 'reality_arc', 'must_include'
)
_CHARACTER_PROMPT_TOKEN_PATTERN = re.compile(r'(?<!\w)([^\W_]+)', re.UNICODE)
GENERIC_CHARACTER_TAGS = frozenset({
    'boy', 'boys', 'girl', 'girls', 'man', 'men', 'woman', 'women',
    'male', 'female', 'person', 'people', 'child', 'children', 'kid',
    'kids', 'solo', 'duo', 'trio', 'group', 'couple', 'comic',
    'unknown char', 'no metadata', 'character',
})
_CHARACTER_COUNT_TAG_PATTERN = re.compile(
    r'^[1-9]\d* ?(?:boy|boys|girl|girls|person|people)$'
)


def _clean_character_prompt_tag(raw_tag):
    """Keep the historic exact Danbooru-tag cleanup in one testable helper."""
    clean = str(raw_tag or '').strip().lower()
    if not clean:
        return ''

    clean = re.sub(r'^[-0-9.]+:+\s*', '', clean)
    clean = re.sub(r'\s*:+$', '', clean)
    clean = re.sub(r':[0-9.]+$', '', clean).strip()

    while clean.startswith('(') and clean.endswith(')'):
        clean = clean[1:-1].strip()
    while clean.startswith('[') and clean.endswith(']'):
        clean = clean[1:-1].strip()
    while clean.startswith('{') and clean.endswith('}'):
        clean = clean[1:-1].strip()

    return re.sub(r'\s+', '_', clean).strip()


def _character_alias_key(value):
    """Normalize spaces/underscores for alias grouping and boundary matching."""
    text = str(value or '').replace('_', ' ')
    text = re.sub(r'\s+', ' ', text).strip().casefold()
    return text


def normalize_generic_character_name(value):
    """Normalize a full character name for exact generic-tag filtering."""
    text = str(value or '').replace('_', ' ')
    return re.sub(r'\s+', ' ', text).strip().casefold()


def is_generic_character_name(value):
    """Return whether the complete normalized name is a generic count tag."""
    normalized = normalize_generic_character_name(value)
    return (
        normalized in GENERIC_CHARACTER_TAGS
        or bool(_CHARACTER_COUNT_TAG_PATTERN.fullmatch(normalized))
    )


def _character_alias_pattern(alias_key):
    parts = [part for part in alias_key.split(' ') if part]
    if not parts:
        return ''
    # Underscores are word characters, so explicit boundaries prevent
    # ``alice`` from matching either ``malice`` or ``alice_dakimakura``.
    body = r'[ _]+'.join(re.escape(part) for part in parts)
    return rf'(?<!\w){body}(?!\w)'


def _character_alias_first_token(alias_key):
    """Return the first searchable word used by the candidate index."""
    match = re.search(r'[^\W_]+', alias_key, flags=re.UNICODE)
    return match.group(0) if match else ''


def _is_simple_character_alias(alias_key):
    """Short ASCII single-token aliases are too ambiguous inside prose."""
    return bool(re.fullmatch(r'[a-z0-9]{1,4}', alias_key))


def _character_row_values(row):
    if isinstance(row, dict):
        return row.get('tag', ''), row.get('clean_name', row.get('clean', ''))
    try:
        return row[0], row[1]
    except (IndexError, KeyError, TypeError):
        return '', ''


def build_character_matcher(known_character_rows=None, danbooru_tags=None):
    """Precompile known-character aliases and retain exact Danbooru tags.

    The returned structure is intentionally plain data plus precompiled
    alias regexes, which keeps the hot image loop free of DB work and
    alias-table reconstruction.
    """
    canonical_names = {}
    alias_to_canonical = {}

    for row in known_character_rows or []:
        tag, clean_name = _character_row_values(row)
        display_name = str(clean_name or tag or '').strip()
        canonical_key = _character_alias_key(display_name)
        if not canonical_key:
            continue
        canonical_names.setdefault(canonical_key, display_name)

        for raw_alias in (tag, clean_name):
            alias_key = _character_alias_key(raw_alias)
            if alias_key and not is_generic_character_name(alias_key):
                # Duplicate DB rows/aliases resolve to one canonical name.
                alias_to_canonical.setdefault(alias_key, canonical_key)

    candidates_by_first_token = {}
    simple_exact_names = {}
    for alias_key, canonical_key in alias_to_canonical.items():
        display_name = canonical_names[canonical_key]
        if _is_simple_character_alias(alias_key):
            # Keep short aliases exact-only.  A name such as ``Ta`` occurs in
            # ordinary prose too often to be a safe boundary substring match.
            simple_exact_names.setdefault(alias_key.replace(' ', '_'), display_name)
            continue

        alias_pattern = _character_alias_pattern(alias_key)
        first_token = _character_alias_first_token(alias_key)
        if not alias_pattern or not first_token:
            continue

        candidates_by_first_token.setdefault(first_token, []).append({
            'alias': alias_key,
            'display_name': display_name,
            'pattern': re.compile(alias_pattern, re.IGNORECASE),
        })

    # Longest-first makes a single occurrence of ``Ann Lee`` win over the
    # shorter ``Ann`` alias when both are present.  No giant alternation is
    # built here; only candidates sharing the first token are tested later.
    for candidates in candidates_by_first_token.values():
        candidates.sort(key=lambda item: (-len(item['alias']), item['alias']))

    exact_aliases = {
        alias_key.replace(' ', '_')
        for alias_key in alias_to_canonical
    }

    exact_danbooru_tags = {
        _clean_character_prompt_tag(tag)
        for tag in (danbooru_tags or [])
    }
    exact_danbooru_tags.discard('')

    return {
        # Kept as an explicit None for callers that inspected the old shape;
        # matching now uses the bounded first-token candidate index below.
        'known_pattern': None,
        'known_candidates_by_first_token': {
            token: tuple(candidates)
            for token, candidates in candidates_by_first_token.items()
        },
        'known_simple_exact_names': dict(simple_exact_names),
        'known_exact_aliases': frozenset(exact_aliases),
        'danbooru_tags': frozenset(exact_danbooru_tags),
    }


def extract_character_names(char_tags=None, base_tags=None, matcher=None):
    """Return unique characters from character and base prompt tags.

    Known aliases use word-boundary matching inside natural-language tokens;
    official Danbooru tags not yet in ``known_characters`` retain exact-token
    matching. Repeated names count once, preserving first-match order.
    """
    if not matcher:
        return []

    prompt_tags = list(char_tags or []) + list(base_tags or [])
    candidates_by_first_token = matcher.get('known_candidates_by_first_token', {})
    simple_exact_names = matcher.get('known_simple_exact_names', {})
    exact_aliases = matcher.get('known_exact_aliases', ())
    danbooru_tags = matcher.get('danbooru_tags', ())
    found = []

    for raw_tag in prompt_tags:
        raw_text = str(raw_tag or '').strip()
        clean_tag = _clean_character_prompt_tag(raw_text)
        if not clean_tag:
            continue
        if is_generic_character_name(clean_tag):
            continue
        if len(clean_tag) < 2 and clean_tag not in simple_exact_names:
            continue
        is_blacklisted = any(
            blocked in clean_tag
            for blocked in _CHARACTER_PROMPT_BLACKLIST
        )

        # Scan word starts once, then inspect only aliases whose first word
        # is present at that position.  A consumed span prevents a shorter or
        # nested alias from counting the same occurrence a second time.
        consumed_end = -1
        for token_match in _CHARACTER_PROMPT_TOKEN_PATTERN.finditer(raw_text):
            token = token_match.group(1).casefold()
            candidates = candidates_by_first_token.get(token)
            if not candidates or token_match.start() < consumed_end:
                continue

            for candidate in candidates:
                alias_match = candidate['pattern'].match(raw_text, token_match.start())
                if not alias_match:
                    continue
                found.append(candidate['display_name'])
                consumed_end = alias_match.end()
                break

        # A known exact alias has already been emitted by the candidate or
        # simple-exact matcher.  Skipping it here prevents one occurrence
        # from being counted again when the same tag also exists in Danbooru.
        if clean_tag in simple_exact_names:
            found.append(simple_exact_names[clean_tag])

        if (
            not is_blacklisted
            and clean_tag in danbooru_tags
            and clean_tag not in exact_aliases
        ):
            found.append(clean_tag.title())

    unique_names = {}
    for name in found:
        unique_names.setdefault(_character_alias_key(name), name)
    return list(unique_names.values())


