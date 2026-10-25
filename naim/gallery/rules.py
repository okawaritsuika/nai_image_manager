"""Custom classification rule normalization and matching."""
import json
import re


def clean_route_prompt_text(value):
    text = str(value or "").strip()
    return re.sub(r"\s+", " ", text)


def route_prompt_dedupe_key(value):
    text = clean_route_prompt_text(value).lower().replace("_", " ")
    text = re.sub(r"\s+", " ", text).strip()
    compact = re.sub(r"[\s_]+", "", text)
    return compact or text


def dedupe_route_prompts(items):
    deduped = []
    seen = set()

    for item in items or []:
        text = clean_route_prompt_text(item)
        if not text:
            continue

        key = route_prompt_dedupe_key(text)
        if not key or key in seen:
            continue

        seen.add(key)
        deduped.append(text)

    return deduped


def parse_route_tags_single(raw):
    if isinstance(raw, str):
        items = re.split(r"[,\n]+", raw)
    elif isinstance(raw, list):
        items = raw
    else:
        items = []

    return dedupe_route_prompts(items)


def parse_route_tag_groups(raw):
    groups = []

    if isinstance(raw, str):
        for line in raw.splitlines():
            groups.append(re.split(r",+", line))
    elif isinstance(raw, list):
        for item in raw:
            if isinstance(item, list):
                groups.append(item)
            elif isinstance(item, str):
                groups.append(re.split(r",+", item))
            else:
                groups.append([item])

    normalized = []
    seen_groups = set()

    for group in groups:
        tags = dedupe_route_prompts(group)
        if not tags:
            continue

        group_key = tuple(route_prompt_dedupe_key(tag) for tag in tags)
        if group_key in seen_groups:
            continue

        seen_groups.add(group_key)
        normalized.append(tags)

    return normalized


def route_prompt_text_from_rule(rule, tags=None, tag_groups=None, prompt_mode="single"):
    raw = rule.get("prompt_text")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()

    if prompt_mode == "group" and tag_groups:
        return "\n".join(", ".join(group) for group in tag_groups if group)

    if tags:
        return "\n".join(tags)

    return ""


def normalize_custom_route_rules(rules, depth=0):
    if not isinstance(rules, list) or depth > 5:
        return []

    normalized = []

    for rule in rules:
        if not isinstance(rule, dict):
            continue

        rule_type = str(rule.get("type") or "custom").strip()

        if rule_type == "default":
            normalized.append({
                "type": "default",
                "folder": "Solo / Duo / Group"
            })
            continue

        folder = str(rule.get("folder") or "").strip()
        tags = parse_route_tags_single(rule.get("tags") or [])
        prompt_mode = "group" if rule.get("prompt_mode") == "group" else "single"
        tag_groups = parse_route_tag_groups(rule.get("tag_groups") or [])
        prompt_text = route_prompt_text_from_rule(rule, tags, tag_groups, prompt_mode)

        if prompt_text:
            tags_from_text = parse_route_tags_single(prompt_text)
            groups_from_text = parse_route_tag_groups(prompt_text)

            if tags_from_text:
                tags = tags_from_text
            if groups_from_text:
                tag_groups = groups_from_text

        if prompt_mode == "group" and not tag_groups and tags:
            tag_groups = [[tag] for tag in tags]

        if not folder or (not prompt_text and not tags and not tag_groups):
            continue

        condition = str(rule.get("condition") or "any").strip().lower()
        if condition not in ("any", "all"):
            condition = "any"

        try:
            match_count = int(rule.get("match_count") or 1)
        except Exception:
            match_count = 1

        match_count = max(1, match_count)

        children = (
            rule.get("children")
            or rule.get("sub_rules")
            or rule.get("rules")
            or []
        )

        normalized.append({
            "type": "custom",
            "folder": folder,
            "prompt_text": prompt_text,
            "tags": tags,
            "prompt_mode": prompt_mode,
            "tag_groups": tag_groups,
            "condition": condition,
            "match_count": match_count,
            "children": normalize_custom_route_rules(children, depth + 1)
        })

    return normalized


def route_test_clean_prompt_text(value):
    text = str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return re.sub(r"[ \t\f\v]+", " ", text)


def route_test_match_keys(value):
    text = route_test_clean_prompt_text(value).lower()
    if not text:
        return set()

    space_text = re.sub(r"\s+", " ", text.replace("_", " ")).strip()
    underscore_text = re.sub(r"\s+", "_", space_text)
    compact_text = re.sub(r"[\s_]+", "", space_text)
    return {key for key in (text, space_text, underscore_text, compact_text) if key}


def route_test_prompt_tokens_from_text(text):
    tokens = []
    seen = set()

    for item in re.split(r"[,\n]+", str(text or "")):
        token = route_test_clean_prompt_text(item)
        if not token:
            continue
        key = next(iter(sorted(route_test_match_keys(token))), "")
        if not key or key in seen:
            continue
        seen.add(key)
        tokens.append(token)

    return tokens


def route_test_prompt_tokens_from_prompt_info(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    for key in (
        "basePrompt", "baseCaption", "prompt", "base_prompt",
        "negativePrompt", "negative_prompt", "uc",
        "charPrompt", "characterPrompt"
    ):
        value = prompt_info.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value)

    for key in ("charPrompts", "char_prompts"):
        value = prompt_info.get(key)
        if isinstance(value, list):
            parts.extend(str(item) for item in value if str(item or "").strip())
        elif isinstance(value, str) and value.strip():
            parts.append(value)

    return route_test_prompt_tokens_from_text("\n".join(parts))


def route_test_build_key_set(tokens):
    key_set = set()
    for token in tokens or []:
        key_set.update(route_test_match_keys(token))
    return key_set

def route_test_build_match_context(tokens):
    token_keys = route_test_build_key_set(tokens)
    full_prompt_text = route_test_clean_prompt_text(" ".join(str(token or "") for token in (tokens or [])))
    full_keys = route_test_match_keys(full_prompt_text)

    return {
        "token_keys": token_keys,
        "full_keys": full_keys
    }


def route_test_is_like_prompt(pattern):
    text = route_test_clean_prompt_text(pattern)
    return len(text) >= 3 and text.startswith("%") and text.endswith("%")


def route_test_like_prompt_inner(pattern):
    return route_test_clean_prompt_text(pattern)[1:-1].strip()

def route_test_rule_prompt_matches(prompt, match_context):
    if not isinstance(match_context, dict):
        match_context = {
            "token_keys": match_context or set(),
            "full_keys": set()
        }

    if route_test_is_like_prompt(prompt):
        needle = route_test_like_prompt_inner(prompt)
        if not needle:
            return False

        needle_keys = route_test_match_keys(needle)
        full_keys = match_context.get("full_keys") or set()

        return any(
            needle_key in full_key
            for needle_key in needle_keys
            for full_key in full_keys
        )

    token_keys = match_context.get("token_keys") or set()
    return any(key in token_keys for key in route_test_match_keys(prompt))


def route_test_unique_prompts(items):
    prompts = []
    seen = set()
    for item in items or []:
        prompt = route_test_clean_prompt_text(item)
        if not prompt:
            continue
        key = next(iter(sorted(route_test_match_keys(prompt))), "")
        if not key or key in seen:
            continue
        seen.add(key)
        prompts.append(prompt)
    return prompts


def route_test_rule_matches(rule, match_context):
    if not isinstance(rule, dict) or rule.get("type") == "default":
        return {"matched": False, "mode": "default", "matched_tags": [], "missing_tags": [], "message": "기본 분류 규칙은 직접 매칭하지 않습니다."}

    prompt_mode = "group" if rule.get("prompt_mode") == "group" else "single"

    if prompt_mode == "group":
        tag_groups = parse_route_tag_groups(rule.get("tag_groups") or [])
        tags = route_test_unique_prompts(rule.get("tags") or [])
        if not tag_groups and tags:
            tag_groups = [[tag] for tag in tags]

        group_details = []
        for index, group in enumerate(tag_groups):
            needed = route_test_unique_prompts(group)
            found = [tag for tag in needed if route_test_rule_prompt_matches(tag, match_context)]
            missing = [tag for tag in needed if tag not in found]
            passed = bool(needed) and not missing
            group_details.append({
                "group_index": index + 1,
                "needed_tags": needed,
                "matched_tags": found,
                "missing_tags": missing,
                "matched": passed
            })
            if passed:
                return {
                    "matched": True,
                    "mode": "group",
                    "matched_tags": found,
                    "missing_tags": [],
                    "passed_group_index": index + 1,
                    "groups": group_details,
                    "message": f"묶음 조건 {index + 1}번이 통과했습니다."
                }

        missing_all = []
        for detail in group_details:
            missing_all.extend(detail.get("missing_tags", []))
        return {
            "matched": False,
            "mode": "group",
            "matched_tags": [],
            "missing_tags": route_test_unique_prompts(missing_all),
            "passed_group_index": None,
            "groups": group_details,
            "message": "통과한 묶음 조건이 없습니다."
        }

    tags = route_test_unique_prompts(rule.get("tags") or [])
    condition = "all" if rule.get("condition") == "all" else "any"
    try:
        match_count = int(rule.get("match_count") or 1)
    except Exception:
        match_count = 1
    match_count = max(1, match_count)

    matched_tags = [tag for tag in tags if route_test_rule_prompt_matches(tag, match_context)]
    missing_tags = [tag for tag in tags if tag not in matched_tags]
    required_count = len(tags) if condition == "all" else min(match_count, len(tags))
    matched = bool(tags) and (not missing_tags if condition == "all" else len(matched_tags) >= match_count)

    return {
        "matched": matched,
        "mode": "single",
        "condition": condition,
        "match_count": match_count,
        "required_count": required_count,
        "matched_tags": matched_tags,
        "missing_tags": missing_tags,
        "message": "개별 조건이 통과했습니다." if matched else f"필요한 {required_count}개 중 {len(matched_tags)}개만 찾았습니다."
    }


def route_test_get_rule_by_path(rules, path):
    current = rules
    rule = None
    try:
        for raw_index in path or []:
            index = int(raw_index)
            if not isinstance(current, list) or index < 0 or index >= len(current):
                return None
            rule = current[index]
            current = rule.get("children") or []
        return rule if isinstance(rule, dict) else None
    except Exception:
        return None


def route_test_get_rule_paths(data):
    raw_paths = data.get("rule_paths")
    if isinstance(raw_paths, str):
        try:
            raw_paths = json.loads(raw_paths)
        except Exception:
            raw_paths = []

    if isinstance(raw_paths, list) and raw_paths and all(isinstance(p, list) for p in raw_paths):
        return raw_paths

    one = data.get("rule_path")
    if isinstance(one, str):
        try:
            one = json.loads(one)
        except Exception:
            one = []

    return [one] if isinstance(one, list) and one else []


def route_test_path_key(path):
    return json.dumps(path or [], ensure_ascii=False)


def route_test_is_ancestor_path(parent, child):
    return (
        isinstance(parent, list) and
        isinstance(child, list) and
        len(parent) < len(child) and
        child[:len(parent)] == parent
    )


def route_test_selected_path_jobs(rule_paths):
    paths = [path for path in rule_paths if isinstance(path, list)]
    unique = []
    seen = set()

    for path in paths:
        key = route_test_path_key(path)
        if key in seen:
            continue
        unique.append(path)
        seen.add(key)

    jobs = []

    for path in unique:
        selected_ancestors = [
            other for other in unique
            if route_test_is_ancestor_path(other, path)
        ]
        selected_descendants = [
            other for other in unique
            if route_test_is_ancestor_path(path, other)
        ]

        if selected_ancestors:
            ancestor = max(selected_ancestors, key=len)
            jobs.append({"type": "chain", "paths": [ancestor, path]})
            continue

        if selected_descendants:
            continue

        jobs.append({"type": "single", "paths": [path]})

    return jobs


def route_test_rule_label_by_path(rules, path):
    labels = []
    current = rules
    try:
        for raw_index in path or []:
            index = int(raw_index)
            if not isinstance(current, list) or index < 0 or index >= len(current):
                return "알 수 없는 규칙"
            rule = current[index]
            labels.append(str(rule.get("folder") or "(폴더명 없음)").strip() or "(폴더명 없음)")
            current = rule.get("children") or []
    except Exception:
        return "알 수 없는 규칙"

    return " > ".join(labels) if labels else "알 수 없는 규칙"


def route_test_match_rule_chain(rules, match_context, paths):
    details = []
    labels = []
    all_matched = True

    for path in paths:
        rule = route_test_get_rule_by_path(rules, path)
        if not rule:
            all_matched = False
            details.append({
                "matched": False,
                "rule_path": path,
                "message": "선택한 규칙을 찾을 수 없습니다."
            })
            continue

        result = route_test_match_single_rule(rule, match_context)
        result["rule_path"] = path
        result["rule_label"] = route_test_rule_label_by_path(rules, path)
        labels.append(result["rule_label"])
        details.append(result)

        if not result.get("matched"):
            all_matched = False

    return {
        "matched": all_matched,
        "type": "chain",
        "rule_label": " > ".join([label.split(" > ")[-1] for label in labels if label]),
        "details": details,
        "message": "선택한 상위/하위 규칙 조합을 순서대로 검사했습니다."
    }


def route_test_match_selected_rules(rules, match_context, rule_paths):  
    jobs = route_test_selected_path_jobs(rule_paths)
    selected_results = []

    for job in jobs:
        paths = job.get("paths") or []

        if job.get("type") == "chain":
            selected_results.append(route_test_match_rule_chain(rules, match_context, paths))
            continue

        path = paths[0] if paths else []
        rule = route_test_get_rule_by_path(rules, path)

        if not rule:
            selected_results.append({
                "matched": False,
                "type": "single",
                "rule_path": path,
                "rule_label": "알 수 없는 규칙",
                "message": "선택한 규칙을 찾을 수 없습니다."
            })
            continue

        result = route_test_match_single_rule(rule, match_context)
        result["type"] = "single"
        result["rule_path"] = path
        result["rule_label"] = route_test_rule_label_by_path(rules, path)
        selected_results.append(result)

    return {
        "matched": any(item.get("matched") for item in selected_results),
        "scope": "single",
        "selected_rule_count": len([path for path in rule_paths if isinstance(path, list)]),
        "job_count": len(selected_results),
        "selected_results": selected_results,
        "message": "선택한 규칙을 검사했습니다."
    }


def route_test_flatten_rules(rules, parent_label="", parent_path=None):
    parent_path = parent_path or []
    flat = []

    for index, rule in enumerate(rules or []):
        if not isinstance(rule, dict) or rule.get("type") == "default":
            continue
        folder = str(rule.get("folder") or "").strip() or "(폴더명 없음)"
        label = f"{parent_label} > {folder}" if parent_label else folder
        path = parent_path + [index]
        flat.append({"path": path, "label": label, "folder": folder, "rule": rule})
        flat.extend(route_test_flatten_rules(rule.get("children") or [], label, path))

    return flat


def route_test_find_matching_route(rules, match_context):
    details = []

    def walk(rule_list, chain=None):
        chain = chain or []
        for rule in rule_list or []:
            if not isinstance(rule, dict):
                continue
            if rule.get("type") == "default":
                return {"matched": False, "default_reached": True, "final_folder": "Solo / Duo / Group", "rule_chain": chain, "details": details}

            folder = str(rule.get("folder") or "").strip()
            match_detail = route_test_rule_matches(rule, match_context)
            details.append({"folder": folder, "label": " > ".join(chain + [folder]) if folder else "", **match_detail})
            if not match_detail.get("matched"):
                continue

            next_chain = chain + ([folder] if folder else [])
            child_result = walk(rule.get("children") or [], next_chain)
            if child_result and child_result.get("matched"):
                return child_result
            return {"matched": True, "default_reached": False, "final_folder": "/".join(next_chain), "rule_chain": next_chain, "details": details}

        return {"matched": False, "default_reached": False, "final_folder": "", "rule_chain": chain, "details": details}

    return walk(rules)


def route_test_match_single_rule(rule, match_context):
    if not rule or rule.get("type") == "default":
        return {"matched": False, "final_folder": "", "rule_chain": [], "details": [], "message": "선택한 규칙을 찾을 수 없습니다."}

    detail = route_test_rule_matches(rule, match_context)
    folder = str(rule.get("folder") or "").strip()
    return {
        "matched": bool(detail.get("matched")),
        "default_reached": False,
        "final_folder": folder if detail.get("matched") else "",
        "rule_chain": [folder] if folder and detail.get("matched") else [],
        "details": [{"folder": folder, "label": folder, **detail}],
        "message": detail.get("message", "")
    }


def route_test_build_prompt_rule(data):
    text = str(data.get("prompt_rule_text") or "").strip()
    mode = "group" if data.get("prompt_rule_mode") == "group" else "single"

    if not text:
        return None

    return {
        "type": "custom",
        "folder": "임시 프롬프트 규칙",
        "prompt_text": text,
        "tags": parse_route_tags_single(text),
        "prompt_mode": mode,
        "tag_groups": parse_route_tag_groups(text),
        "condition": "any",
        "match_count": 1,
        "children": []
    }


def route_test_run_payload(data, tokens):
    rules = normalize_custom_route_rules(data.get("rules", []))
    match_context = route_test_build_match_context(tokens)

    target_mode = data.get("target_mode") or data.get("scope") or "all"

    if target_mode == "prompt":
        temp_rule = route_test_build_prompt_rule(data)
        if not temp_rule:
            return {
                "matched": False,
                "scope": "prompt",
                "rule_label": "임시 프롬프트 규칙",
                "message": "임시 감지 규칙이 비어 있습니다.",
                "details": []
            }

        result = route_test_match_single_rule(temp_rule, match_context)
        result["scope"] = "prompt"
        result["type"] = "single"
        result["rule_label"] = "임시 프롬프트 규칙"
        return result

    if target_mode == "single" or data.get("scope") == "single":
        return route_test_match_selected_rules(rules, match_context, route_test_get_rule_paths(data))

    return route_test_find_matching_route(rules, match_context)


def route_test_prompt_preview_from_tokens(tokens, limit=30):
    tokens = tokens or []
    preview = ", ".join(tokens[:limit])
    if len(tokens) > limit:
        preview += f" ... plus {len(tokens) - limit} more"
    return preview


def route_test_prompt_text_from_prompt_info(prompt_info):
    prompt_info = prompt_info or {}
    parts = []

    base_prompt = str(
        prompt_info.get("basePrompt")
        or prompt_info.get("baseCaption")
        or prompt_info.get("prompt")
        or prompt_info.get("base_prompt")
        or ""
    ).strip()

    char_prompts = prompt_info.get("charPrompts") or prompt_info.get("char_prompts") or []
    if not isinstance(char_prompts, list):
        char_prompts = []

    char_prompt = str(
        prompt_info.get("charPrompt")
        or prompt_info.get("characterPrompt")
        or ""
    ).strip()

    negative_prompt = str(
        prompt_info.get("negativePrompt")
        or prompt_info.get("negative_prompt")
        or prompt_info.get("uc")
        or ""
    ).strip()

    if base_prompt:
        parts.append("[Base Prompt]\n" + base_prompt)

    clean_char_prompts = [str(item or "").strip() for item in char_prompts if str(item or "").strip()]
    if char_prompt:
        clean_char_prompts.append(char_prompt)

    if clean_char_prompts:
        parts.append("[Character Prompt]\n" + "\n".join(clean_char_prompts))

    if negative_prompt:
        parts.append("[Negative Prompt]\n" + negative_prompt)

    return "\n\n".join(parts).strip()


def public_route_test_job(job):
    if not job:
        return None
    return {
        "job_id": job.get("job_id", ""),
        "state": job.get("state", "queued"),
        "processed_count": int(job.get("processed_count", 0) or 0),
        "total_count": int(job.get("total_count", 0) or 0),
        "matched_count": int(job.get("matched_count", 0) or 0),
        "unmatched_count": int(job.get("unmatched_count", 0) or 0),
        "error_count": int(job.get("error_count", 0) or 0),
        "message": job.get("message", ""),
        "results": job.get("results", []),
        "target_mode": job.get("target_mode", "all"),
        "warning": job.get("warning", "")
    }

