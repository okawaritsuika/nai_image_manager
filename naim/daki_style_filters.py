"""Validated import filters for positive source prompts, independent of storage."""
from naim._shared_style_syntax import key, parse
from naim._shared_style_review import reviewed_edit
from naim.gallery.query import parse_gallery_prompt_search_query, gallery_prompt_search_matches
from naim.storage.daki_shared_styles import excluded_style


def normalize_style_filters(value=None):
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise ValueError('가져오기 태그 필터는 객체여야 합니다.')
    exclude_realistic = value.get('exclude_realistic', True)
    mode = value.get('include_mode', 'any')
    if type(exclude_realistic) is not bool or mode not in ('any', 'all'):
        raise ValueError('실사 제외 여부와 포함 조건을 확인해 주세요.')
    result = {'exclude_realistic': exclude_realistic, 'include_mode': mode}
    if 'low_recommendation_limit' in value:
        limit = value['low_recommendation_limit']
        if limit is not None and (type(limit) is not int or not 0 <= limit <= 9007199254740991):
            raise ValueError('추천수 기준은 0 이상의 정수로 입력해 주세요.')
        result['low_recommendation_limit'] = limit
    for field in ('include_tags', 'exclude_tags'):
        tags = value.get(field, [])
        if not isinstance(tags, list) or len(tags) > 100:
            raise ValueError('포함·제외 태그는 각각 100개 이내로 입력해 주세요.')
        normalized = []
        for tag in tags:
            if (not isinstance(tag, str) or not 0 < len(tag) <= 200
                    or any(ord(char) < 32 or ord(char) == 127 or char == ',' for char in tag)):
                raise ValueError('각 필터 태그는 쉼표와 줄바꿈 없이 200자 이내로 입력해 주세요.')
            tag = key(tag)
            if not tag:
                raise ValueError('빈 필터 태그는 사용할 수 없습니다.')
            if tag not in normalized:
                normalized.append(tag)
        result[field] = normalized
    # Legacy tag arrays keep their matching rules; the new field opts into the
    # same expression syntax used by gallery searches and virtual folders.
    if 'include_query' in value:
        query = value['include_query']
        if (not isinstance(query, str) or len(query) > 20000
                or any((ord(char) < 32 and char not in '\t\r\n') or ord(char) == 127 for char in query)):
            raise ValueError('포함 조건은 20,000자 이내의 검색식으로 입력해 주세요.')
        query = query.strip()
        terms = [term for group in parse_gallery_prompt_search_query(query) for term in group]
        if (query and not terms) or len(terms) > 100 or any(len(term['text']) > 200 for term in terms):
            raise ValueError('포함 조건에는 200자 이내의 검색어를 100개까지 입력해 주세요.')
        result['include_query'] = query
    return result


def matches_style_filters(positive, filters):
    if filters['exclude_realistic'] and excluded_style(positive):
        return False
    included, excluded = filters['include_tags'], filters['exclude_tags']
    query = filters.get('include_query')
    has_include = bool(query) if query is not None else bool(included)
    if not excluded and not has_include:
        return True
    if excluded or query is None:
        try:
            terms = parse(positive)
        except ValueError:
            terms, _, _ = reviewed_edit(positive)
        tags = {key(term.text) for term in terms}
        if any(tag in tags for tag in excluded):
            return False
    if query is not None:
        return not query or gallery_prompt_search_matches(positive, query)
    if not included:
        return True
    match = all if filters['include_mode'] == 'all' else any
    return match(tag in tags for tag in included)
