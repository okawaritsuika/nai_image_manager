"""Gallery query grammar and incremental indexing rules; no database I/O."""
import os
import re

GALLERY_PROMPT_INDEX_SEMANTICS_VERSION = "positive-v1"

def select_gallery_prompt_index_paths(
    image_paths, indexed_mtimes, classified_dir, missing_only=False,
    mtime_getter=None
):
    """Select prompt-index files that are missing or have changed.

    ``mtime_getter`` is injectable so this selection rule can be tested
    without opening image files.  Exact float equality is intentional: the
    indexed value is written from the same ``getmtime`` result, and any
    representable change should trigger re-indexing.
    """
    if mtime_getter is None:
        mtime_getter = os.path.getmtime

    selected = []
    for full_path in image_paths:
        rel_path = os.path.relpath(full_path, classified_dir).replace("\\", "/")
        if rel_path not in indexed_mtimes:
            selected.append(full_path)
            continue

        if missing_only:
            continue

        try:
            current_mtime = mtime_getter(full_path)
        except Exception:
            # The record builder remains responsible for handling a path
            # that disappears between directory scan and worker submission.
            selected.append(full_path)
            continue

        if current_mtime != indexed_mtimes[rel_path]:
            selected.append(full_path)

    return selected

def normalize_gallery_prompt_search_text(value):
    """Normalize prompt text without changing the stored index schema.

    Prompt queries and indexed prompt text use the same representation so
    underscores remain equivalent to spaces and old index rows stay usable.
    Commas/newlines are separators in the query grammar, but are normalized
    to spaces when they occur inside a ``%...%`` partial term.
    """
    text = str(value or "").lower().replace("_", " ")
    text = re.sub(r"[\r\n,]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()

def _normalize_gallery_prompt_search_term(value, partial=None):
    """Return one normalized search term, or ``None`` when it is empty."""
    if isinstance(value, dict):
        if partial is None:
            partial = bool(value.get("partial"))
        value = value.get("text", value.get("term", value.get("value", "")))

    raw = str(value or "").strip()
    if partial is None:
        partial = len(raw) >= 2 and raw.startswith("%") and raw.endswith("%")
    if partial and len(raw) >= 2 and raw.startswith("%") and raw.endswith("%"):
        raw = raw[1:-1]

    text = normalize_gallery_prompt_search_text(raw)
    if not text:
        return None
    return {"text": text, "partial": bool(partial)}

def parse_gallery_prompt_search_query(query):
    """Parse the gallery prompt grammar into OR-of-AND term groups.

    The return value is a list of groups; each group is a list of
    ``{"text": ..., "partial": bool}`` dictionaries.  Separators are
    commas, whitespace, and ``||`` outside ``%...%``.  This shape is kept
    deliberately simple so DB-backed and filesystem fallback searches can
    share the exact same matcher.
    """
    raw_query = str(query or "")
    groups = []
    current_group = []
    token = []
    in_partial = False
    index = 0

    def flush_token():
        if not token:
            return
        raw_term = "".join(token).strip()
        token.clear()
        term = _normalize_gallery_prompt_search_term(raw_term)
        if term is not None:
            current_group.append(term)

    def flush_group():
        flush_token()
        if current_group:
            groups.append(list(current_group))
            current_group.clear()

    while index < len(raw_query):
        char = raw_query[index]
        if char == "%":
            in_partial = not in_partial
            token.append(char)
            index += 1
            continue

        if not in_partial and raw_query[index:index + 2] == "||":
            flush_group()
            index += 2
            continue

        if not in_partial and (char == "," or char.isspace()):
            flush_token()
            index += 1
            continue

        token.append(char)
        index += 1

    flush_group()
    return groups

def _coerce_gallery_prompt_search_groups(query_or_terms):
    """Accept parser output and the historic flat term-list contract."""
    if isinstance(query_or_terms, str) or query_or_terms is None:
        return parse_gallery_prompt_search_query(query_or_terms)

    if isinstance(query_or_terms, dict):
        raw_groups = query_or_terms.get("groups")
        if raw_groups is not None:
            query_or_terms = raw_groups
        else:
            query_or_terms = [query_or_terms]

    if not isinstance(query_or_terms, (list, tuple, set)):
        return parse_gallery_prompt_search_query(query_or_terms)

    values = list(query_or_terms)
    if not values:
        return []

    # Parsed output is nested.  A flat list remains a historic AND term list.
    nested = any(isinstance(value, (list, tuple, set)) for value in values)
    raw_groups = values if nested else [values]
    groups = []
    for raw_group in raw_groups:
        if isinstance(raw_group, dict):
            raw_group = [raw_group]
        if not isinstance(raw_group, (list, tuple, set)):
            raw_group = [raw_group]
        group = []
        for raw_term in raw_group:
            term = _normalize_gallery_prompt_search_term(raw_term)
            if term is not None:
                group.append(term)
        if group:
            groups.append(group)
    return groups

def gallery_prompt_search_matches(prompt_text, query_or_terms, normalized_text=None):
    """Return whether a prompt satisfies an OR-of-AND gallery query."""
    groups = _coerce_gallery_prompt_search_groups(query_or_terms)
    if not groups:
        return False

    source_text = normalized_text if normalized_text not in (None, "") else prompt_text
    normalized_prompt = normalize_gallery_prompt_search_text(source_text)
    if not normalized_prompt:
        return False

    for group in groups:
        if all(
            term["text"] in normalized_prompt
            if term["partial"]
            else re.search(
                r"(?<![A-Za-z0-9\uac00-\ud7a3])"
                + re.escape(term["text"])
                + r"(?![A-Za-z0-9\uac00-\ud7a3])",
                normalized_prompt,
            ) is not None
            for term in group
        ):
            return True
    return False

def _gallery_prompt_search_candidate_where(groups, column, fallback_column=None):
    """Build broad SQL candidates; final matching stays in Python.

    ``prompt_text`` is included as a fallback for rows created before the
    normalized index was populated.  For multi-word terms, token candidates
    avoid false negatives caused by raw commas/underscores; the shared matcher
    still enforces the phrase boundary or substring rule afterwards.
    """
    clauses = []
    params = []
    for group in groups:
        group_clauses = []
        for term in group:
            token_clauses = []
            for token in term["text"].split():
                token_clauses.append(f"{column} LIKE ?")
                params.append(f"%{token}%")
                if fallback_column:
                    token_clauses.append(f"{fallback_column} LIKE ?")
                    params.append(f"%{token}%")
            if token_clauses:
                group_clauses.append("(" + " OR ".join(token_clauses) + ")")
        if group_clauses:
            clauses.append("(" + " AND ".join(group_clauses) + ")")
    if not clauses:
        return "", []
    return "(" + " OR ".join(clauses) + ")", params
