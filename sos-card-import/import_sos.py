"""
import_sos.py

Reads GrpIds for the Secrets of Strixhaven (SOS) draft pool from the MTGA
SQLite DB, matches them to Scryfall data by card name to get mana costs,
then merges the results into cards.json.

The "draft pool" includes three set codes:
  - SOS: the main set
  - SOA: the Mystical Archive-style bonus sheet that drafts alongside SOS
  - SPG (DigitalReleaseSet='SPG-SOS'): Special Guests for SOS

Usage:
    python import_sos.py <mtga_db_path> <scryfall_json_path> <cards_json_path>
"""

import json
import os
import sqlite3
import sys
import re
import gzip

try:
    import ijson
    _HAVE_IJSON = True
except ImportError:
    _HAVE_IJSON = False


def simplify_type(type_line):
    return type_line.split("—")[0].split("—")[0].strip()


_HTML_TAG_RE = re.compile(r"<[^>]+>")

def strip_html(text):
    return _HTML_TAG_RE.sub("", text).strip()


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


def load_mtga_sos_cards(db_path):
    con = sqlite3.connect(db_path)
    cur = con.cursor()
    cur.execute("""
        SELECT c.GrpId, en.Loc AS Name, et.Loc AS TypeText, c.IsToken, c.IsPrimaryCard,
               c.OldSchoolManaText, c.ExpansionCode, c.DigitalReleaseSet
        FROM Cards c
        LEFT JOIN Localizations_enUS en ON c.TitleId = en.LocId AND en.Formatted = 1
        LEFT JOIN Localizations_enUS et ON c.TypeTextId = et.LocId AND et.Formatted = 1
        WHERE c.ExpansionCode IN ('SOS', 'SOA')
           OR (c.ExpansionCode = 'SPG' AND c.DigitalReleaseSet = 'SPG-SOS')
    """)
    rows = cur.fetchall()
    con.close()
    return rows


# Threshold for "main draftable set" — bonus sheets like SOA/STA/MUL/FCA/OTP
# all sit at 63–76 primary cards, so 100 separates them from real sets.
MAIN_SET_MIN_CARDS = 100


def compute_main_draft_sets(db_path):
    """Return the list of "main" draftable sets ordered by recency.

    A main set has ≥100 primary, non-token cards with an empty
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
    """, (MAIN_SET_MIN_CARDS,))
    sets = [
        {"code": code, "primaryCount": n, "firstGrpId": first}
        for code, n, first in cur.fetchall()
    ]
    con.close()
    return sets


def _scryfall_available(scryfall_path):
    """Return True only if the path is non-empty, the file exists, and ijson is installed."""
    return bool(scryfall_path) and os.path.isfile(scryfall_path) and _HAVE_IJSON

def load_scryfall_maps(scryfall_path):
    """
    Single-pass loader:
    - Handles .json AND .gz automatically
    - sos_map: only SOS cards
    - all_map: best version of every card name
    """
    if not _scryfall_available(scryfall_path):
        return {}, {}

    sos_map = {}
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

                if card.get("set", "").upper() == "SOS":
                    sos_map[key] = entry

    except Exception as e:
        print(f"\n❌ Failed to parse Scryfall JSON: {e}")
        print("👉 Your file is likely corrupted or not actually JSON.")
        print("👉 Re-download from https://scryfall.com/docs/api/bulk-data")
        sys.exit(1)

    return sos_map, all_map

def main():
    if len(sys.argv) not in (3, 4):
        print("Usage: python import_sos.py <mtga_db> <scryfall_json_or_empty> <cards_json>")
        print("       The scryfall_json argument is optional; pass '' to skip Scryfall lookups.")
        sys.exit(1)

    db_path = sys.argv[1]
    scryfall_path = sys.argv[2] if len(sys.argv) >= 3 else ""
    cards_json_path = sys.argv[3] if len(sys.argv) == 4 else sys.argv[2]

    print("Loading MTGA SOS draft-pool cards from DB (SOS + SOA + SPG-SOS)...")
    mtga_rows = load_mtga_sos_cards(db_path)
    print(f"  {len(mtga_rows)} rows found")

    if _scryfall_available(scryfall_path):
        print("Loading Scryfall data (single pass)...")
        scryfall, scryfall_all = load_scryfall_maps(scryfall_path)
        print(f"  {len(scryfall)} SOS-set cards found")
        print(f"  {len(scryfall_all)} unique card names indexed")
    else:
        print("No Scryfall JSON provided — using MTGA mana data for all cards")
        scryfall = {}
        scryfall_all = {}

    print("Loading existing cards.json...")
    with open(cards_json_path, "r", encoding="utf-8") as f:
        cards_data = json.load(f)
    cards = cards_data.get("cards", {})
    print(f"  {len(cards)} cards already in DB")

    matched = 0
    skipped_token = 0
    db_fallback = []
    by_set = {}

    for grp_id, name, type_text, is_token, is_primary, old_school_mana, exp_code, drs in mtga_rows:
        by_set[exp_code] = by_set.get(exp_code, 0) + 1
        if is_token:
            skipped_token += 1
            continue

        key = str(grp_id)

        # Always backfill set provenance — even on entries we already had,
        # since previous imports didn't write these fields.
        existing = cards.get(key)
        existing_has_cost = bool(existing and existing.get("manaCost"))

        if existing_has_cost:
            existing["set"] = exp_code
            existing["digitalReleaseSet"] = drs or ""
            matched += 1
            continue

        db_name = strip_html(name) if name else ""
        norm = normalize_name(name) if name else ""

        # Try SOS-set Scryfall first, then fall back to any set (for reprints)
        sf = scryfall.get(norm) or scryfall_all.get(norm)

        if sf:
            cards[key] = {
                "name": sf["name"],
                "manaCost": sf["mana_cost"],
                "type": simplify_type(sf["type_line"]),
                "set": exp_code,
                "digitalReleaseSet": drs or "",
            }
            matched += 1
        else:
            # Fall back to MTGA's own data: OldSchoolManaText is authoritative
            # for what the client displays, and is populated even when Scryfall
            # has not yet indexed a brand-new set.
            fallback_name = db_name or f"Unknown ({grp_id})"
            fallback_type = simplify_type(type_text) if type_text else ""
            fallback_cost = mtga_mana_to_scryfall(old_school_mana or "")
            cards[key] = {
                "name": fallback_name,
                "manaCost": fallback_cost,
                "type": fallback_type,
                "set": exp_code,
                "digitalReleaseSet": drs or "",
            }
            db_fallback.append((grp_id, db_name, fallback_cost))

    cards_data["cards"] = cards

    # Recompute the canonical main-set list every run so the renderer's
    # browse dropdown stays in sync as new sets release.
    print("Computing main draft sets index...")
    cards_data["mainDraftSets"] = compute_main_draft_sets(db_path)
    print(f"  {len(cards_data['mainDraftSets'])} main draftable sets indexed")

    print(f"Writing updated cards.json...")
    with open(cards_json_path, "w", encoding="utf-8") as f:
        json.dump(cards_data, f, indent=2, ensure_ascii=False)

    print(f"\nDone.")
    print(f"  Rows by set:          {', '.join(f'{k}={v}' for k, v in sorted(by_set.items()))}")
    print(f"  Matched via Scryfall: {matched}")
    print(f"  Tokens skipped:       {skipped_token}")
    if db_fallback:
        no_cost = [r for r in db_fallback if not r[2]]
        with_cost = [r for r in db_fallback if r[2]]
        print(f"  DB fallback (no Scryfall match): {len(db_fallback)}")
        if with_cost:
            print(f"    With mana cost from MTGA DB:  {len(with_cost)}")
            for grp_id, name, cost in with_cost:
                print(f"      GrpId {grp_id}: '{name}' {cost}")
        if no_cost:
            print(f"    Without mana cost (likely lands/etc): {len(no_cost)}")
            for grp_id, name, _ in no_cost:
                print(f"      GrpId {grp_id}: '{name}'")
    print(f"  Total cards now: {len(cards)}")


if __name__ == "__main__":
    main()
