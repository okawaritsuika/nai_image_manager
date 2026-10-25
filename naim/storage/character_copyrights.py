"""Local persistence for character-to-copyright relationships."""
import re


_COPYRIGHT_SUFFIX_RE = re.compile(r"_\((.+?)\)$")


def _normalize_tag(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("tag must be a non-empty string")
    return value.strip().lower()


def match_copyright_suffix(character_tag, copyright_names):
    """Return the known copyright matching a character tag's final suffix."""
    character_tag = _normalize_tag(character_tag)
    match = _COPYRIGHT_SUFFIX_RE.search(character_tag)
    if not match:
        return None

    suffix = (
        match.group(1)
        .replace("idolm@ster", "idolmaster")
        .replace("the_idolm@ster", "idolmaster")
    )
    if suffix in copyright_names:
        return suffix

    series_suffix = f"{suffix}_(series)"
    if series_suffix in copyright_names:
        return series_suffix
    return None


class CharacterCopyrightDictionary:
    def __init__(self, connection):
        self.connection = connection
        self.connection.execute(
            """
            CREATE TABLE IF NOT EXISTS character_copyright_relations (
                character_tag TEXT PRIMARY KEY,
                copyright_tag TEXT NOT NULL,
                source TEXT NOT NULL
            )
            """
        )

    def lookup(self, character_tag):
        character_tag = _normalize_tag(character_tag)
        row = self.connection.execute(
            "SELECT copyright_tag FROM character_copyright_relations WHERE character_tag = ?",
            (character_tag,),
        ).fetchone()
        return row[0] if row else None

    def remember(self, character_tag, copyright_tag):
        character_tag = _normalize_tag(character_tag)
        copyright_tag = _normalize_tag(copyright_tag)
        self.connection.execute(
            """
            INSERT INTO character_copyright_relations (character_tag, copyright_tag, source)
            VALUES (?, ?, 'online')
            ON CONFLICT(character_tag) DO UPDATE SET
                copyright_tag = excluded.copyright_tag,
                source = excluded.source
            """,
            (character_tag, copyright_tag),
        )

    def seed_from_local(self, local_cursor, additional_characters=()):
        copyright_names = {
            row[0].strip().lower()
            for row in local_cursor.execute("SELECT name FROM copyrights").fetchall()
            if isinstance(row[0], str) and row[0].strip()
        }
        character_names = {
            row[0].strip().lower()
            for row in local_cursor.execute("SELECT name FROM characters").fetchall()
            if isinstance(row[0], str) and row[0].strip()
        }
        character_names.update(
            _normalize_tag(character_tag) for character_tag in additional_characters
        )

        direct_relations = {}
        implication_rows = local_cursor.execute(
            """
            SELECT characters.name, copyrights.name
            FROM tag_implications
            JOIN characters ON characters.name = tag_implications.antecedent
            JOIN copyrights ON copyrights.name = tag_implications.consequent
            """
        ).fetchall()
        for character_tag, copyright_tag in implication_rows:
            if not isinstance(character_tag, str) or not isinstance(copyright_tag, str):
                continue
            character_tag = character_tag.strip().lower()
            copyright_tag = copyright_tag.strip().lower()
            if character_tag and copyright_tag:
                direct_relations.setdefault(character_tag, set()).add(copyright_tag)

        prepared = []
        for character_tag in sorted(character_names):
            direct_copyrights = direct_relations.get(character_tag, set())
            if len(direct_copyrights) > 1:
                continue
            if direct_copyrights:
                copyright_tag = next(iter(direct_copyrights))
                source = "tag_implication"
            else:
                copyright_tag = match_copyright_suffix(character_tag, copyright_names)
                if not copyright_tag:
                    continue
                source = "tag_name"
            prepared.append((character_tag, copyright_tag, source))

        with self.connection:
            self.connection.executemany(
                """
                INSERT INTO character_copyright_relations
                    (character_tag, copyright_tag, source)
                VALUES (?, ?, ?)
                ON CONFLICT(character_tag) DO UPDATE SET
                    copyright_tag = excluded.copyright_tag,
                    source = excluded.source
                WHERE character_copyright_relations.source != 'online'
                  AND (character_copyright_relations.source != 'tag_implication'
                       OR excluded.source = 'tag_implication')
                """,
                prepared,
            )
        return len(prepared)
