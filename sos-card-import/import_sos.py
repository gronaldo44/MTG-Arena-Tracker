"""
import_sos.py

Reads GrpIds for Secrets of Strixhaven (SOS) cards from the MTGA SQLite DB,
matches them to Scryfall data by card name to get mana costs, then merges the
results into cards.json.

Usage:
    python import_sos.py <mtga_db_path> <scryfall_json_path> <cards_json_path>
"""

import json
import sqlite3
import ijson
import sys
import re


def simplify_type(type_line):
    return type_line.split("—")[0].split("—")[0].strip()


_HTML_TAG_RE = re.compile(r"<[^>]+>")

def strip_html(text):
    return _HTML_TAG_RE.sub("", text).strip()


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
        SELECT c.GrpId, en.Loc AS Name, et.Loc AS TypeText, c.IsToken, c.IsPrimaryCard
        FROM Cards c
        LEFT JOIN Localizations_enUS en ON c.TitleId = en.LocId AND en.Formatted = 1
        LEFT JOIN Localizations_enUS et ON c.TypeTextId = et.LocId AND et.Formatted = 1
        WHERE c.ExpansionCode = 'SOS'
    """)
    rows = cur.fetchall()
    con.close()
    return rows


def load_scryfall_sos(scryfall_path):
    """Returns dict of normalized_name -> {name, mana_cost, type_line} for SOS cards."""
    result = {}
    with open(scryfall_path, "r", encoding="utf-8") as f:
        for card in ijson.items(f, "item"):
            if card.get("set", "").upper() != "SOS":
                continue
            name = card.get("name", "")
            result[normalize_name(name)] = {
                "name": name,
                "mana_cost": card.get("mana_cost", ""),
                "type_line": card.get("type_line", ""),
            }
    return result


def load_scryfall_all_by_name(scryfall_path):
    """Returns dict of normalized_name -> {name, mana_cost, type_line} across all sets.
    Later entries overwrite earlier ones (prefer non-promo, canonical prints).
    """
    result = {}
    with open(scryfall_path, "r", encoding="utf-8") as f:
        for card in ijson.items(f, "item"):
            name = card.get("name", "")
            if not name:
                continue
            key = normalize_name(name)
            # Prefer non-digital, non-promo cards for canonical data
            if key not in result or card.get("booster", False):
                result[key] = {
                    "name": name,
                    "mana_cost": card.get("mana_cost", ""),
                    "type_line": card.get("type_line", ""),
                }
    return result


def main():
    if len(sys.argv) != 4:
        print("Usage: python import_sos.py <mtga_db> <scryfall_json> <cards_json>")
        sys.exit(1)

    db_path, scryfall_path, cards_json_path = sys.argv[1], sys.argv[2], sys.argv[3]

    print("Loading MTGA SOS cards from DB...")
    mtga_rows = load_mtga_sos_cards(db_path)
    print(f"  {len(mtga_rows)} rows found")

    print("Loading Scryfall SOS cards...")
    scryfall = load_scryfall_sos(scryfall_path)
    print(f"  {len(scryfall)} SOS-set cards found")

    print("Loading Scryfall all-cards name index (for reprints)...")
    scryfall_all = load_scryfall_all_by_name(scryfall_path)
    print(f"  {len(scryfall_all)} unique card names indexed")

    print("Loading existing cards.json...")
    with open(cards_json_path, "r", encoding="utf-8") as f:
        cards_data = json.load(f)
    cards = cards_data.get("cards", {})
    print(f"  {len(cards)} cards already in DB")

    matched = 0
    skipped_token = 0
    unmatched = []

    for grp_id, name, type_text, is_token, is_primary in mtga_rows:
        if is_token:
            skipped_token += 1
            continue

        key = str(grp_id)

        # Skip if already present with mana cost data (don't overwrite good data)
        existing = cards.get(key)
        if existing and existing.get("manaCost") != "":
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
            }
            matched += 1
        else:
            # Fall back: use what we have from the DB (no mana cost)
            fallback_name = db_name or f"Unknown ({grp_id})"
            fallback_type = simplify_type(type_text) if type_text else ""
            cards[key] = {
                "name": fallback_name,
                "manaCost": "",
                "type": fallback_type,
            }
            unmatched.append((grp_id, db_name))

    cards_data["cards"] = cards

    print(f"Writing updated cards.json...")
    with open(cards_json_path, "w", encoding="utf-8") as f:
        json.dump(cards_data, f, indent=2, ensure_ascii=False)

    print(f"\nDone.")
    print(f"  Matched/added:   {matched}")
    print(f"  Tokens skipped:  {skipped_token}")
    if unmatched:
        print(f"  Unmatched (DB name used, no mana cost): {len(unmatched)}")
        for grp_id, name in unmatched:
            print(f"    GrpId {grp_id}: '{name}'")
    print(f"  Total cards now: {len(cards)}")


if __name__ == "__main__":
    main()
