"""
import_set.py

Reads GrpIds for a newly-released MTGA set from the MTGA SQLite DB, matches
them to Scryfall data by card name to get mana costs, then merges the
results directly into a local cards.json. Useful for immediately unblocking
your own machine without waiting for a boot cycle / enrichment bundle
rebuild — see generate_enrichment_data.py for producing the redistributable
enrichment-data.json that ships with the installer.

Usage:
    python import_set.py <set_specs> <mtga_db_path> <scryfall_json_path> <cards_json_path>

<set_specs> is a comma-separated list of "CODE" or "CODE:DIGITAL_RELEASE_SET"
tokens — see set_import_lib.py for the format. Example, for the Marvel Super
Heroes release (MSH main set, MSC Commander precons, and the MAR-MSH slice of
the reused MAR Special-Guests-style pool):

    python import_set.py "MSH,MSC,MAR:MAR-MSH" mtga.db scryfall.json cards.json
"""

import json
import sys

# Card names routinely contain non-ASCII characters (accents, curly quotes,
# em dashes); Windows consoles often default to a codepage that can't encode
# them, which would otherwise crash the diagnostic printout below after the
# cards.json write has already succeeded.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from set_import_lib import (
    simplify_type,
    strip_html,
    mtga_mana_to_scryfall,
    normalize_name,
    parse_set_specs,
    load_mtga_cards,
    compute_main_draft_sets,
    load_scryfall_maps,
    _scryfall_available,
)


def main():
    if len(sys.argv) not in (4, 5):
        print("Usage: python import_set.py <set_specs> <mtga_db> <scryfall_json_or_empty> <cards_json>")
        print("       The scryfall_json argument is optional; pass '' to skip Scryfall lookups.")
        sys.exit(1)

    set_specs = sys.argv[1]
    db_path = sys.argv[2]
    scryfall_path = sys.argv[3] if len(sys.argv) >= 4 else ""
    cards_json_path = sys.argv[4] if len(sys.argv) == 5 else sys.argv[3]

    full_codes, guest_filters = parse_set_specs(set_specs)
    target_codes = set(full_codes) | {code for code, _ in guest_filters}

    print(f"Loading MTGA cards from DB ({set_specs})...")
    mtga_rows = load_mtga_cards(db_path, full_codes, guest_filters)
    print(f"  {len(mtga_rows)} rows found")

    if _scryfall_available(scryfall_path):
        print("Loading Scryfall data (single pass)...")
        scryfall, scryfall_all = load_scryfall_maps(scryfall_path, target_codes)
        print(f"  {len(scryfall)} target-set cards found")
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

        # Try the target set(s) in Scryfall first, then fall back to any set (for reprints)
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
