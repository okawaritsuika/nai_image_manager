import os
import sqlite3
import requests
import time
import re
from collections import Counter

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(CURRENT_DIR, "TOTAL_CLASSIFIED", "naia_history.db")
LOCAL_CHAR_DB_PATH = os.path.join(CURRENT_DIR, "danbooru_tags.db")
DANBOORU_POSTS_API = "https://danbooru.donmai.us/posts.json"
DANBOORU_TAGS_API = "https://danbooru.donmai.us/tags.json"
HEADERS = {"User-Agent": "NaiaSyncBot/5.2"}

SYNCED_BRANDS = set()
RECLASSIFY_ALL_BRANDS_ONCE = False
ANCHOR_NOISE_MIN_POST_COUNT = 1000
ANCHOR_NOISE_MIN_RATIO = 0.02
BRAND_POST_QUERY_LIMIT = 100

IDOLMASTER_ROOT_COPYRIGHTS = {
    "idolmaster",
    "idolm@ster",
    "the_idolm@ster",
}

IDOLMASTER_CLASSIC_COPYRIGHTS = {
    "idolmaster_(classic)",
    "the_idolm@ster_(classic)",
}

IDOLMASTER_CLASSIC_CHILD_RE = re.compile(r"^(?:the_)?idolmaster_\d+$")

# 캐릭터별 브랜드를 강제로 지정할 때 사용하는 예외 목록.
# 예: "illyasviel_von_einzbern": "fate/kaleid_liner_prisma_illya"
FORCED_CHARACTER_BRANDS = {
}


def to_brand_display_name(tag):
    return str(tag or "").replace("_", " ").title()


def get_local_copyright_post_count(tag, local_cursor):
    if not local_cursor or not tag:
        return 0
    try:
        local_cursor.execute("SELECT post_count FROM copyrights WHERE name = ?", (str(tag).lower(),))
        row = local_cursor.fetchone()
        return int(row[0] or 0) if row else 0
    except Exception:
        return 0


def get_copyright_parents(tag, local_cursor):
    if not local_cursor or not tag:
        return []

    try:
        local_cursor.execute("""
            SELECT consequent
            FROM tag_implications
            WHERE antecedent = ?
        """, (str(tag).lower(),))
        return [str(row[0] or "").lower() for row in local_cursor.fetchall() if row[0]]
    except Exception:
        return []


def get_known_copyright_parents(tag, local_cursor):
    """tag_implications의 consequent 중 로컬 copyrights 테이블에 있는 copyright만 반환한다."""
    parents = get_copyright_parents(tag, local_cursor)
    if not parents or not local_cursor:
        return []

    result = []
    for parent in parents:
        if get_local_copyright_post_count(parent, local_cursor) > 0:
            result.append(str(parent).lower())

    return result


def get_copyright_ancestors(tag, local_cursor, seen=None):
    tag = str(tag or "").lower().strip()
    if not tag or not local_cursor:
        return set()

    if seen is None:
        seen = set()
    if tag in seen:
        return set()
    seen.add(tag)

    ancestors = set()
    for parent in get_copyright_parents(tag, local_cursor):
        ancestors.add(parent)
        ancestors.update(get_copyright_ancestors(parent, local_cursor, seen))

    return ancestors


def get_character_copyright_anchors(search_name, local_cursor):
    if not local_cursor or not search_name:
        return set()

    try:
        local_cursor.execute("""
            SELECT c.name
            FROM tag_implications t
            JOIN copyrights c ON LOWER(t.consequent) = LOWER(c.name)
            WHERE LOWER(t.antecedent) = LOWER(?)
        """, (str(search_name or "").lower().strip(),))
        anchors = {str(row[0] or "").lower() for row in local_cursor.fetchall() if row[0]}
    except Exception:
        return set()

    anchors = reduce_to_leaf_copyrights(anchors, local_cursor)
    return filter_minor_copyright_anchors(anchors, local_cursor)

def reduce_to_leaf_copyrights(tags, local_cursor):
    """
    copyright 후보 중 다른 후보의 상위/부모인 항목을 제거하고 leaf만 남긴다.
    예: fate + fate/stay_night가 있으면 fate/stay_night만 남긴다.
    """
    tag_set = {str(tag or "").lower().strip() for tag in tags if tag}

    if not tag_set or not local_cursor:
        return tag_set

    result = set()

    for tag in tag_set:
        is_parent_of_other = False

        for other in tag_set:
            if other == tag:
                continue

            other_ancestors = get_copyright_ancestors(other, local_cursor)
            if tag in other_ancestors:
                is_parent_of_other = True
                break

        if not is_parent_of_other:
            result.add(tag)

    return result


def filter_minor_copyright_anchors(anchors, local_cursor):
    anchors = {str(tag or "").lower().strip() for tag in anchors if tag}

    if len(anchors) <= 1 or not local_cursor:
        return anchors

    counts = {
        tag: get_local_copyright_post_count(tag, local_cursor)
        for tag in anchors
    }

    max_count = max(counts.values() or [0])

    if max_count <= 0:
        return anchors

    filtered = {
        tag for tag, count in counts.items()
        if count >= ANCHOR_NOISE_MIN_POST_COUNT
        or count >= max_count * ANCHOR_NOISE_MIN_RATIO
    }

    return filtered or anchors

def are_copyrights_related(a, b, local_cursor):
    """
    두 copyright가 같은 계열인지 확인한다.
    동일하거나 서로 조상/자식 관계이면 관련된 것으로 본다.
    """
    a = str(a or "").lower().strip()
    b = str(b or "").lower().strip()

    if not a or not b:
        return False

    if a == b:
        return True

    a_ancestors = get_copyright_ancestors(a, local_cursor)
    b_ancestors = get_copyright_ancestors(b, local_cursor)

    return a in b_ancestors or b in a_ancestors


def filter_copyrights_to_character_family(copyright_tags, character_anchors, local_cursor):
    """
    캐릭터 anchor와 관련 있는 copyright만 남긴다.
    anchor가 없으면 원래 copyright set을 그대로 반환한다.
    """
    tags = {str(tag or "").lower().strip() for tag in copyright_tags if tag}
    anchors = {str(tag or "").lower().strip() for tag in character_anchors if tag}

    if not tags:
        return set()

    if not anchors:
        return tags

    related = {
        tag for tag in tags
        if any(are_copyrights_related(tag, anchor, local_cursor) for anchor in anchors)
    }

    return related


def is_idolmaster_copyright_family(tag, local_cursor):
    tag = str(tag or "").lower().strip()
    if not tag:
        return False

    if tag in IDOLMASTER_ROOT_COPYRIGHTS or tag in IDOLMASTER_CLASSIC_COPYRIGHTS:
        return True

    if IDOLMASTER_CLASSIC_CHILD_RE.match(tag):
        return True

    ancestors = get_copyright_ancestors(tag, local_cursor)
    return bool(
        ancestors & IDOLMASTER_ROOT_COPYRIGHTS
        or ancestors & IDOLMASTER_CLASSIC_COPYRIGHTS
    )


def canonicalize_idolmaster_brand(tag, local_cursor, seen=None):
    tag = str(tag or "").lower().strip()
    if not tag:
        return None

    if IDOLMASTER_CLASSIC_CHILD_RE.match(tag):
        return "idolmaster_(classic)"

    if tag in IDOLMASTER_CLASSIC_COPYRIGHTS:
        return "idolmaster_(classic)"

    if tag in IDOLMASTER_ROOT_COPYRIGHTS:
        return None

    if seen is None:
        seen = set()
    if tag in seen:
        return None
    seen.add(tag)

    parents = get_known_copyright_parents(tag, local_cursor)
    if not parents:
        return tag

    if any(parent in IDOLMASTER_ROOT_COPYRIGHTS for parent in parents):
        return tag

    if any(parent in IDOLMASTER_CLASSIC_COPYRIGHTS for parent in parents):
        return "idolmaster_(classic)"

    candidates = []
    for parent in parents:
        candidate = canonicalize_idolmaster_brand(parent, local_cursor, seen.copy())
        if candidate:
            candidates.append(candidate)

    if not candidates:
        return None

    return max(
        candidates,
        key=lambda candidate: (
            get_local_copyright_post_count(candidate, local_cursor),
            candidate
        )
    )


def canonicalize_topmost_copyright_brand(tag, local_cursor, seen=None):
    tag = str(tag or "").lower().strip()
    if not tag:
        return None

    if seen is None:
        seen = set()
    if tag in seen:
        return tag
    seen.add(tag)

    parents = get_known_copyright_parents(tag, local_cursor)
    if not parents:
        return tag

    candidates = []
    for parent in parents:
        candidate = canonicalize_topmost_copyright_brand(parent, local_cursor, seen.copy())
        if candidate:
            candidates.append(candidate)

    if not candidates:
        return tag

    return max(
        candidates,
        key=lambda candidate: (
            get_local_copyright_post_count(candidate, local_cursor),
            candidate
        )
    )


def canonicalize_copyright_brand(tag, local_cursor, seen=None):
    tag = str(tag or "").lower().strip()
    if not tag:
        return None

    if is_idolmaster_copyright_family(tag, local_cursor):
        return canonicalize_idolmaster_brand(tag, local_cursor, seen)

    return canonicalize_topmost_copyright_brand(tag, local_cursor, seen)

def remove_too_broad_anchor_parent_brands(brands, character_anchors, local_cursor):
    """
    너무 넓은 anchor 부모 브랜드를 제거한다.
    예: anchor가 idolmaster_cinderella_girls라면 idolmaster 같은 루트 브랜드는 제거한다.
    """
    if not brands or not character_anchors:
        return set(brands or [])

    result = set()

    for brand in brands:
        brand = str(brand or "").lower().strip()
        if not brand:
            continue

        is_too_broad = False
        for anchor in character_anchors:
            anchor = str(anchor or "").lower().strip()
            if not anchor or brand == anchor:
                continue

            anchor_ancestors = get_copyright_ancestors(anchor, local_cursor)
            if brand in anchor_ancestors:
                is_too_broad = True
                break

        if not is_too_broad:
            result.add(brand)

    return result


def get_post_character_tags(post):
    return [
        str(tag or "").lower()
        for tag in post.get("tag_string_character", "").strip().split()
        if tag
    ]


def is_solo_post(post):
    general_tags = {
        str(tag or "").lower()
        for tag in post.get("tag_string_general", "").strip().split()
        if tag
    }
    return "solo" in general_tags


def is_single_character_post(post, search_name):
    character_tags = get_post_character_tags(post)
    search_name = str(search_name or "").lower().strip()

    if not character_tags or search_name not in character_tags:
        return False

    if is_solo_post(post):
        return True

    return len(character_tags) == 1

def collect_canonical_brands_from_post(post, local_cursor, character_anchors=None):
    copyright_tags = [
        str(tag or "").lower()
        for tag in post.get("tag_string_copyright", "").strip().split()
        if tag
    ]

    if not copyright_tags:
        return set()

    character_anchors = character_anchors or set()

    copyright_tags = filter_copyrights_to_character_family(
        copyright_tags,
        character_anchors,
        local_cursor
    )

    if not copyright_tags:
        return set()

    brands = set()

    for tag in copyright_tags:
        brand = canonicalize_copyright_brand(tag, local_cursor)
        if brand:
            brands.add(brand)

    if not brands:
        return set()

    brands = reduce_to_leaf_copyrights(brands, local_cursor)
    narrowed = remove_too_broad_anchor_parent_brands(brands, character_anchors, local_cursor)

    if character_anchors:
        return narrowed

    if narrowed:
        return narrowed
    return brands

def choose_brand_from_character_posts(posts, search_name, local_cursor):
    forced = FORCED_CHARACTER_BRANDS.get(str(search_name or "").lower().strip())
    if forced:
        return forced

    brand_votes = Counter()
    fallback_votes = Counter()

    character_anchors = get_character_copyright_anchors(search_name, local_cursor)

    anchor_brands = {
        canonicalize_copyright_brand(anchor, local_cursor)
        for anchor in character_anchors
    }
    anchor_brands = {brand for brand in anchor_brands if brand}
    anchor_brands = reduce_to_leaf_copyrights(anchor_brands, local_cursor)

    for post in posts:
        if not is_single_character_post(post, search_name):
            continue

        per_post_brands = collect_canonical_brands_from_post(
            post,
            local_cursor,
            character_anchors
        )

        for brand in per_post_brands:
            brand_votes[brand] += 1

        if not character_anchors:
            fallback_brands = collect_canonical_brands_from_post(
                post,
                local_cursor,
                set()
            )

            for brand in fallback_brands:
                fallback_votes[brand] += 1

    if brand_votes:
        votes = brand_votes
    elif anchor_brands:
        votes = Counter({brand: 1 for brand in anchor_brands})
    else:
        votes = fallback_votes

    if not votes:
        return None

    return max(
        votes.keys(),
        key=lambda tag: (
            votes[tag],
            tag in anchor_brands,
            get_local_copyright_post_count(tag, local_cursor),
            tag
        )
    )


def fetch_brand_candidate_posts(session, search_name):
    queries = [
        f"{search_name} solo order:score",
        f"{search_name} solo",
        f"{search_name} order:score",
    ]

    posts = []
    seen_ids = set()

    for query in queries:
        try:
            res = session.get(
                DANBOORU_POSTS_API,
                params={
                    "tags": query,
                    "limit": BRAND_POST_QUERY_LIMIT
                },
                headers=HEADERS,
                timeout=10
            )

            if res.status_code != 200:
                continue

            for post in res.json() or []:
                post_id = post.get("id")
                if post_id in seen_ids:
                    continue

                seen_ids.add(post_id)
                posts.append(post)

        except Exception:
            continue

        if len(posts) >= BRAND_POST_QUERY_LIMIT:
            break

        time.sleep(0.2)

    return posts


def normalize_name(name):
    name = re.sub(r'_dakimakura|_\d+pcs', '', name, flags=re.IGNORECASE).strip()
    return name.lower().replace(' ', '_')


def get_local_brand(search_name, local_cursor):
    if not local_cursor:
        return None

    match = re.search(r'_\((.+?)\)$', search_name)
    if match:
        extracted = (
            match.group(1)
            .replace('idolm@ster', 'idolmaster')
            .replace('the_idolm@ster', 'idolmaster')
        )

        local_cursor.execute("""
            SELECT name FROM copyrights
            WHERE LOWER(name) IN (LOWER(?), LOWER(?))
            ORDER BY
                CASE WHEN LOWER(name) = LOWER(?) THEN 0 ELSE 1 END,
                post_count DESC
            LIMIT 1
        """, (extracted, f"{extracted}_(series)", extracted))

        row = local_cursor.fetchone()
        if row:
            return row[0].replace('_', ' ').title()

    return None


def get_most_specific_copyright(tags, session):
    if len(tags) == 1:
        return tags[0]
    imas_tags = [t for t in tags if 'idolm@ster' in t.lower()]
    if imas_tags:
        return sorted(imas_tags, key=len, reverse=True)[0]

    fallback_tag = sorted(tags, key=len, reverse=True)[0]
    try:
        res = session.get(DANBOORU_TAGS_API, params={'search[name_comma]': ','.join(tags)}, headers=HEADERS, timeout=10)
        if res.status_code == 200:
            tags_data = res.json()
            if tags_data:
                sorted_tags = sorted(tags_data, key=lambda x: (x.get('post_count', 9999999), -len(x.get('name', ''))))
                return sorted_tags[0]['name']
    except Exception:
        pass
    return fallback_tag


def sync_copyrights():
    if not os.path.exists(DB_PATH):
        return
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    session = requests.Session()

    has_local_db = os.path.exists(LOCAL_CHAR_DB_PATH)
    local_cursor = None
    if has_local_db:
        local_conn = sqlite3.connect(LOCAL_CHAR_DB_PATH)
        local_cursor = local_conn.cursor()

    if RECLASSIFY_ALL_BRANDS_ONCE:
        cursor.execute("UPDATE known_characters SET brand = NULL")
    else:
        cursor.execute("""
            UPDATE known_characters
            SET brand = NULL
            WHERE brand IN ('Unknown', 'Error', '')
        """)
    cursor.execute("SELECT tag FROM known_characters WHERE brand IS NULL")
    pending_tags = [row[0] for row in cursor.fetchall()]

    if not pending_tags:
        print("All character brands are already classified.")
        conn.close()
        if has_local_db:
            local_conn.close()
        return

    search_queue = {}
    for orig in pending_tags:
        norm = normalize_name(orig)
        if norm not in search_queue:
            search_queue[norm] = []
        search_queue[norm].append(orig)

    total_count = len(search_queue)
    print(f"Starting brand sync for {total_count} character(s).")

    for idx, search_name in enumerate(list(search_queue.keys()), 1):
        if search_name not in search_queue:
            continue

        brand_name = get_local_brand(search_name, local_cursor)

        if brand_name:
            print(f"[{idx}/{total_count}] '{search_name}': [{brand_name}] (local parenthesis match)")
            cursor.executemany(
                "UPDATE known_characters SET brand = ? WHERE tag = ?",
                [(brand_name, orig) for orig in search_queue[search_name]]
            )
            conn.commit()
            del search_queue[search_name]
            continue

        print(f"[{idx}/{total_count}] '{search_name}': checking Danbooru image votes...")
        try:
            posts = fetch_brand_candidate_posts(session, search_name)

            if posts:
                best_tag = choose_brand_from_character_posts(posts, search_name, local_cursor)

                if best_tag:
                    brand_name = to_brand_display_name(best_tag)
                    print(f"  -> [{brand_name}] (DB anchor + image vote)")

                    if search_name in search_queue:
                        cursor.executemany(
                            "UPDATE known_characters SET brand = ? WHERE tag = ?",
                            [(brand_name, orig) for orig in search_queue[search_name]]
                        )
                        conn.commit()
                        del search_queue[search_name]

                    time.sleep(0.5)
                    continue

            print("  unable to classify; marking Unknown")
            cursor.executemany(
                "UPDATE known_characters SET brand = 'Unknown' WHERE tag = ?",
                [(orig,) for orig in search_queue[search_name]]
            )
            conn.commit()
            del search_queue[search_name]

        except Exception as e:
            print(f"  API error: {e}")
            time.sleep(2)

        time.sleep(0.5)

    conn.close()
    if has_local_db:
        local_conn.close()
    print("\nBrand sync complete.")


if __name__ == "__main__":
    sync_copyrights()
