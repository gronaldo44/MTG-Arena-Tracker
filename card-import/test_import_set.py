"""Quick assertions for set_import_lib and check_orphans helpers.
Run: python test_import_set.py"""

import json
import os
import tempfile

from set_import_lib import mtga_mana_to_scryfall, strip_html, normalize_name, parse_set_specs
from check_orphans import find_orphans


def check(actual, expected, label):
    assert actual == expected, f"{label}: expected {expected!r}, got {actual!r}"


# Mana conversion — covers every symbol pattern observed in the SOS card pool
check(mtga_mana_to_scryfall(""), "", "empty")
check(mtga_mana_to_scryfall(None), "", "none")
check(mtga_mana_to_scryfall("oW"), "{W}", "single white")
check(mtga_mana_to_scryfall("o1oWoW"), "{1}{W}{W}", "Emeritus of Truce")
check(mtga_mana_to_scryfall("o3oW"), "{3}{W}", "three plus white")
check(mtga_mana_to_scryfall("o(2/G)o(2/G)"), "{2/G}{2/G}", "monocolor hybrid")
check(mtga_mana_to_scryfall("o(2/R)o(2/R)o(2/R)"), "{2/R}{2/R}{2/R}", "triple monocolor hybrid")
check(mtga_mana_to_scryfall("o(B/G)"), "{B/G}", "two-color hybrid")
check(mtga_mana_to_scryfall("o1o(W/B)"), "{1}{W/B}", "generic + hybrid")
check(mtga_mana_to_scryfall("oXoUoR"), "{X}{U}{R}", "X cost")
check(mtga_mana_to_scryfall("oXoXoUoU"), "{X}{X}{U}{U}", "double X")
check(mtga_mana_to_scryfall("o10"), "{10}", "two-digit generic")
check(mtga_mana_to_scryfall("o1oUoUoRoR"), "{1}{U}{U}{R}{R}", "long mixed")
check(mtga_mana_to_scryfall("oBo(B/G)oG"), "{B}{B/G}{G}", "color, hybrid, color")

# HTML/name normalization — Quill-Blade Laureate has a <nobr> tag in its title
check(strip_html("<nobr>Quill-Blade</nobr> Laureate"), "Quill-Blade Laureate", "strip nobr")
check(strip_html("Plain text"), "Plain text", "no html")
check(normalize_name("<nobr>Quill-Blade</nobr> Laureate"), "quill-blade laureate", "normalize tagged")
check(normalize_name("Jadzi’s Pact"), "jadzi's pact", "smart apostrophe")


# Set spec parsing — plain codes pull a whole ExpansionCode, "CODE:DRS" pulls
# only the slice of a reused/shared pool tagged with that DigitalReleaseSet
check(parse_set_specs("SOS,SOA"), (["SOS", "SOA"], []), "full codes only")
check(parse_set_specs("SPG:SPG-SOS"), ([], [("SPG", "SPG-SOS")]), "guest filter only")
check(
    parse_set_specs("MSH,MSC,MAR:MAR-MSH"),
    (["MSH", "MSC"], [("MAR", "MAR-MSH")]),
    "mixed full codes and guest filter",
)
check(parse_set_specs(" msh , mar:MAR-MSH "), (["MSH"], [("MAR", "MAR-MSH")]), "whitespace and case")


# Orphan detection — case-insensitive name matching, ignores BOM and whitespace
with tempfile.TemporaryDirectory() as d:
    csv_path = os.path.join(d, "ratings.csv")
    json_path = os.path.join(d, "cards.json")
    with open(csv_path, "w", encoding="utf-8") as f:
        f.write('"Name","GIH WR"\n"Force of Will","60%"\n" Sylvan Library ","58%"\n"Made-Up Card","50%"\n')
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"cards": {
            "1": {"name": "Force of Will"},
            "2": {"name": "sylvan library"},  # different case in cards.json
            "3": {"name": "Other Card"},
        }}, f)
    orphans, csv_count, known_count = find_orphans(csv_path, json_path)
    check(orphans, ["Made-Up Card"], "orphan detection")
    check(csv_count, 3, "csv count")
    check(known_count, 3, "known count")

print("All assertions passed.")
