"""
set_import_lib.py

Shared helpers for importing a newly-released MTGA set's GrpIds before
Scryfall has linked its own `arena_id` field (which lags new set releases by
days to weeks). Used by both import_set.py (patches a local cards.json
directly) and generate_enrichment_data.py (produces the enrichment-data.json
bundle shipped with the installer).

A "set spec" describes which rows to pull from the MTGA SQLite DB's Cards
table, as a comma-separated list of tokens:
  - "CODE"           -> every row with that ExpansionCode (e.g. a main set
                        or a bonus sheet that fully belongs to one release,
                        like SOS, SOA, MSH, MSC).
  - "CODE:DRS_VALUE"  -> only rows where ExpansionCode=CODE AND
                        DigitalReleaseSet=DRS_VALUE. For pools that get reused
                        release after release (e.g. SPG "Special Guests", or
                        MAR carrying both MAR-SPM and MAR-MSH), this picks out
                        just the slice that belongs to the current release.

Example: "MSH,MSC,MAR:MAR-MSH"
  -> full_codes=['MSH', 'MSC'], guest_filters=[('MAR', 'MAR-MSH')]
"""

import re
import sqlite3
import sys
import gzip

try:
    import ijson
    _HAVE_IJSON = True
except ImportError:
    _HAVE_IJSON = False


def simplify_type(type_line):
    return (type_line or "").split("—")[0].split("—")[0].strip()


_HTML_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text):
    return _HTML_TAG_RE.sub("", text or "").strip()


# OldSchoolManaText tokens: 'o' followed by one of:
#   - a parenthesized hybrid like (2/G), (W/B)
#   - a digit run (1, 2, 10)
#   - a single uppercase letter (W, U, B, R, G, X, S, ...)
_MANA_TOKEN_RE = re.compile(r"o(\([^)]+\)|\d+|[A-Z])")


def mtga_mana_to_scryfall(text):
    """Convert MTGA OldSchoolManaText to Scryfall mana_cost format.

    Examples:
        'oW' -> '{W}'
        'o1oWoW' -> '{1}{W}{W}'
        'o(2/G)o(2/G)' -> '{2/G}{2/G}'
        'oXoUoR' -> '{X}{U}{R}'
    """
    if not text:
        return ""
    parts = []
    for sym in _MANA_TOKEN_RE.findall(text):
        if sym.startswith("(") and sym.endswith(")"):
            sym = sym[1:-1]
        parts.append("{" + sym + "}")
    return "".join(parts)


def normalize_name(name):
    """Lowercase, strip HTML tags, and normalize quotes for fuzzy matching."""
    name = strip_html(name)
    # Normalize typographic apostrophes/quotes to straight ones
    name = name.replace("’", "'").replace("‘", "'")
    name = name.replace("“", '"').replace("”", '"')
    return name.lower().strip()


def parse_set_specs(spec):
    """Parse a comma-separated set spec string into (full_codes, guest_filters).

    "MSH,MSC,MAR:MAR-MSH" -> (['MSH', 'MSC'], [('MAR', 'MAR-MSH')])
    """
    full_codes = []
    guest_filters = []
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        if ":" in token:
            code, drs = token.split(":", 1)
            guest_filters.append((code.strip().upper(), drs.strip()))
        else:
            full_codes.append(token.upper())
    return full_codes, guest_filters


def load_mtga_cards(db_path, full_codes, guest_filters):
    """Fetch card rows for the given set spec from the MTGA SQLite DB.

    Returns rows of (GrpId, Name, TypeText, IsToken, IsPrimaryCard,
    OldSchoolManaText, ExpansionCode, DigitalReleaseSet).
    """
    clauses = []
    params = []

    if full_codes:
        placeholders = ",".join("?" * len(full_codes))
        clauses.append(f"c.ExpansionCode IN ({placeholders})")
        params.extend(full_codes)

    for code, drs in guest_filters:
        clauses.append("(c.ExpansionCode = ? AND c.DigitalReleaseSet = ?)")
        params.extend([code, drs])

    if not clauses:
        raise ValueError("No set codes given — parse_set_specs() returned nothing to query")

    where = " OR ".join(clauses)

    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute(f"""
        SELECT c.GrpId, en.Loc AS Name, et.Loc AS TypeText, c.IsToken, c.IsPrimaryCard,
               c.OldSchoolManaText, c.ExpansionCode, c.DigitalReleaseSet
        FROM Cards c
        LEFT JOIN Localizations_enUS en ON c.TitleId = en.LocId AND en.Formatted = 1
        LEFT JOIN Localizations_enUS et ON c.TypeTextId = et.LocId AND et.Formatted = 1
        WHERE {where}
    """, params)
    rows = cur.fetchall()
    con.close()
    return rows


# Threshold for "main draftable set" — bonus sheets like SOA/STA/MUL/FCA/OTP
# all sit at 63–76 primary cards, so 100 separates them from real sets.
MAIN_SET_MIN_CARDS = 100


def compute_main_draft_sets(db_path, min_cards=MAIN_SET_MIN_CARDS):
    """Return the list of "main" draftable sets ordered by recency.

    A main set has >= min_cards primary, non-token cards with an empty
    DigitalReleaseSet (which excludes Special Guests, Alchemy supplements,
    and bonus packs). Recency is approximated by MIN(GrpId): unlike MAX,
    it isn't polluted by alt-art reprints retroactively added to old sets.
    """
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("""
        SELECT ExpansionCode,
               COUNT(*) AS primary_count,
               MIN(GrpId) AS first_grp_id
        FROM Cards
        WHERE IsToken = 0 AND IsPrimaryCard = 1
          AND (DigitalReleaseSet IS NULL OR DigitalReleaseSet = '')
        GROUP BY ExpansionCode
        HAVING primary_count >= ?
        ORDER BY first_grp_id DESC
    """, (min_cards,))
    sets = [
        {"code": code, "primaryCount": n, "firstGrpId": first}
        for code, n, first in cur.fetchall()
    ]
    con.close()
    return sets


def _scryfall_available(scryfall_path):
    """Return True only if the path is non-empty, the file exists, and ijson is installed."""
    import os
    return bool(scryfall_path) and os.path.isfile(scryfall_path) and _HAVE_IJSON


def load_scryfall_maps(scryfall_path, target_codes):
    """
    Single-pass loader:
    - Handles .json AND .gz automatically
    - target_map: only cards whose Scryfall `set` is in target_codes
    - all_map: best version of every card name
    """
    if not _scryfall_available(scryfall_path):
        return {}, {}

    target_codes = {c.upper() for c in target_codes}
    target_map = {}
    all_map = {}

    # --- Auto-detect gzip
    open_fn = gzip.open if scryfall_path.endswith(".gz") else open

    try:
        with open_fn(scryfall_path, "rb") as f:
            for card in ijson.items(f, "item"):
                name = card.get("name", "")
                if not name:
                    continue

                key = normalize_name(name)

                entry = {
                    "name": name,
                    "mana_cost": card.get("mana_cost", ""),
                    "type_line": card.get("type_line", ""),
                }

                # Prefer booster cards
                if key not in all_map or card.get("booster", False):
                    all_map[key] = entry

                if card.get("set", "").upper() in target_codes:
                    target_map[key] = entry

    except Exception as e:
        print(f"\n❌ Failed to parse Scryfall JSON: {e}")
        print("👉 Your file is likely corrupted or not actually JSON.")
        print("👉 Re-download from https://scryfall.com/docs/api/bulk-data")
        sys.exit(1)

    return target_map, all_map
