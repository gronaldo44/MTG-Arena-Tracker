"""
generate_enrichment_data.py  —  Developer tool only.

Reads SOS/SOA/SPG-SOS card data from the MTGA SQLite DB and writes
sos-card-data.json to the project root. That JSON file ships with the
installer; end users never need Python or the MTGA DB.

Run this whenever the bundled MTGA DB is updated or a new unmapped set
needs enrichment, then commit the updated sos-card-data.json.

Usage:
    python generate_enrichment_data.py [<mtga_db_path>]

If <mtga_db_path> is omitted, the script searches the sos-card-import
directory for a bundled Raw_CardDatabase_*.mtga file.
"""

import json
import os
import re
import sqlite3
import sys

SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(SCRIPT_DIR, '..', 'sos-card-data.json')
OUTPUT_FILE = os.path.normpath(OUTPUT_FILE)

SET_CODES          = ['SOS', 'SOA']
MAIN_SET_MIN_CARDS = 100

_HTML_TAG_RE  = re.compile(r'<[^>]+>')
_MANA_TOKEN_RE = re.compile(r'o(\([^)]+\)|\d+|[A-Z])')


def strip_html(text):
    return _HTML_TAG_RE.sub('', text or '').strip()


def simplify_type(type_line):
    return (type_line or '').split('—')[0].split('—')[0].strip()


def mtga_mana_to_scryfall(text):
    if not text:
        return ''
    parts = []
    for sym in _MANA_TOKEN_RE.findall(text):
        if sym.startswith('(') and sym.endswith(')'):
            sym = sym[1:-1]
        parts.append('{' + sym + '}')
    return ''.join(parts)


def find_bundled_db():
    for name in sorted(os.listdir(SCRIPT_DIR)):
        if name.startswith('Raw_CardDatabase_') and name.endswith('.mtga'):
            return os.path.join(SCRIPT_DIR, name)
    return None


def main():
    if len(sys.argv) >= 2:
        db_path = sys.argv[1]
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

    con = sqlite3.connect(db_path)
    cur = con.cursor()

    cur.execute("""
        SELECT c.GrpId, en.Loc AS Name, et.Loc AS TypeText, c.IsToken,
               c.OldSchoolManaText, c.ExpansionCode, c.DigitalReleaseSet
        FROM Cards c
        LEFT JOIN Localizations_enUS en
               ON c.TitleId = en.LocId AND en.Formatted = 1
        LEFT JOIN Localizations_enUS et
               ON c.TypeTextId = et.LocId AND et.Formatted = 1
        WHERE c.ExpansionCode IN ('SOS', 'SOA')
           OR (c.ExpansionCode = 'SPG' AND c.DigitalReleaseSet = 'SPG-SOS')
    """)
    card_rows = cur.fetchall()

    cur.execute("""
        SELECT ExpansionCode, COUNT(*) AS cnt, MIN(GrpId) AS first_grp_id
        FROM Cards
        WHERE IsToken = 0 AND IsPrimaryCard = 1
          AND (DigitalReleaseSet IS NULL OR DigitalReleaseSet = '')
        GROUP BY ExpansionCode
        HAVING cnt >= ?
        ORDER BY first_grp_id DESC
    """, (MAIN_SET_MIN_CARDS,))
    main_sets = [
        {'code': code, 'primaryCount': cnt, 'firstGrpId': first}
        for code, cnt, first in cur.fetchall()
    ]

    con.close()

    cards = {}
    skipped_tokens = 0
    for grp_id, name, type_text, is_token, old_school_mana, exp_code, drs in card_rows:
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

    data = {
        'setCodes':      SET_CODES,
        'cards':         cards,
        'mainDraftSets': main_sets,
    }

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f'Cards written:   {len(cards)}  ({skipped_tokens} tokens skipped)')
    print(f'Draft sets:      {len(main_sets)}')
    print(f'Output:          {OUTPUT_FILE}')


if __name__ == '__main__':
    main()
