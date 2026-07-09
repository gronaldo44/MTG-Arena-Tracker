"""
generate_enrichment_data.py  —  Developer tool only.

Reads card data for the given set spec from the MTGA SQLite DB and writes
enrichment-data.json to the project root. That JSON file ships with the
installer; end users never need Python or the MTGA DB — setEnricher.js
merges it into their cards.json at boot.

Existing enrichment-data.json content is preserved and merged with (not
replaced by) whatever this run adds, so bridging a new set never regresses
an older one that Scryfall hasn't fully caught up on yet.

Run this whenever a new MTGA set needs bridging, then commit the updated
enrichment-data.json.

Usage:
    python generate_enrichment_data.py <set_specs> [<mtga_db_path>]

<set_specs> is a comma-separated list of "CODE" or "CODE:DIGITAL_RELEASE_SET"
tokens — see set_import_lib.py for the format. Example, for the Marvel Super
Heroes release (MSH main set, MSC Commander precons, and the MAR-MSH slice of
the reused MAR Special-Guests-style pool):

    python generate_enrichment_data.py "MSH,MSC,MAR:MAR-MSH"

If <mtga_db_path> is omitted, the script searches this directory for a
bundled Raw_CardDatabase_*.mtga file.
"""

import json
import os
import sys

from set_import_lib import (
    strip_html,
    simplify_type,
    mtga_mana_to_scryfall,
    parse_set_specs,
    load_mtga_cards,
    compute_main_draft_sets,
)

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(SCRIPT_DIR, '..', 'enrichment-data.json')
OUTPUT_FILE = os.path.normpath(OUTPUT_FILE)


def find_bundled_db():
    for name in sorted(os.listdir(SCRIPT_DIR)):
        if name.startswith('Raw_CardDatabase_') and name.endswith('.mtga'):
            return os.path.join(SCRIPT_DIR, name)
    return None


def load_existing_bundle():
    if not os.path.isfile(OUTPUT_FILE):
        return {'setCodes': [], 'cards': {}, 'mainDraftSets': []}
    try:
        with open(OUTPUT_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return {
            'setCodes': data.get('setCodes', []),
            'cards': data.get('cards', {}),
            'mainDraftSets': data.get('mainDraftSets', []),
        }
    except (OSError, json.JSONDecodeError) as e:
        print(f'WARNING: Could not read existing {OUTPUT_FILE} ({e}); starting fresh')
        return {'setCodes': [], 'cards': {}, 'mainDraftSets': []}


def main():
    if len(sys.argv) not in (2, 3):
        print('Usage: python generate_enrichment_data.py <set_specs> [<mtga_db_path>]')
        print('       Example: python generate_enrichment_data.py "MSH,MSC,MAR:MAR-MSH"')
        sys.exit(1)

    set_specs = sys.argv[1]
    full_codes, guest_filters = parse_set_specs(set_specs)

    if len(sys.argv) >= 3:
        db_path = sys.argv[2]
    else:
        db_path = find_bundled_db()
        if not db_path:
            print('ERROR: No MTGA DB found. Pass the path as an argument or place')
            print('       a Raw_CardDatabase_*.mtga file in this directory.')
            sys.exit(1)

    if not os.path.isfile(db_path):
        print(f'ERROR: File not found: {db_path}')
        sys.exit(1)

    print(f'Reading MTGA DB: {os.path.basename(db_path)}')
    print(f'Set spec: {set_specs}')

    card_rows = load_mtga_cards(db_path, full_codes, guest_filters)
    main_sets = compute_main_draft_sets(db_path)

    cards = {}
    skipped_tokens = 0
    for grp_id, name, type_text, is_token, is_primary, old_school_mana, exp_code, drs in card_rows:
        if is_token:
            skipped_tokens += 1
            continue
        cards[str(grp_id)] = {
            'name':               strip_html(name) or f'Unknown ({grp_id})',
            'manaCost':           mtga_mana_to_scryfall(old_school_mana),
            'type':               simplify_type(strip_html(type_text)),
            'set':                exp_code,
            'digitalReleaseSet':  drs or '',
        }

    # Merge with whatever is already in enrichment-data.json so bridging a
    # new set never drops a previously-bridged one. Reused/shared pools
    # (guest_filters, e.g. SPG, MAR) are intentionally excluded from
    # setCodes — they don't fully belong to this release, so they shouldn't
    # mark themselves "done" for enrichedSets bookkeeping.
    existing = load_existing_bundle()
    merged_cards = {**existing['cards'], **cards}
    merged_set_codes = list(dict.fromkeys([*existing['setCodes'], *full_codes]))

    data = {
        'setCodes':      merged_set_codes,
        'cards':         merged_cards,
        'mainDraftSets': main_sets,
    }

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f'Cards added this run: {len(cards)}  ({skipped_tokens} tokens skipped)')
    print(f'Cards total in bundle: {len(merged_cards)}')
    print(f'Set codes in bundle:   {", ".join(merged_set_codes)}')
    print(f'Draft sets:            {len(main_sets)}')
    print(f'Output:                {OUTPUT_FILE}')


if __name__ == '__main__':
    main()
