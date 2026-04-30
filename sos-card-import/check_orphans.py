"""
check_orphans.py

Cross-checks a 17Lands card-ratings CSV against cards.json. Reports any
17Lands card name that does not resolve to a GrpId in cards.json — those
are the cards the draft assistant would silently drop when overlaying
17Lands stats onto your draft pool.

Run this after importing a new set and before drafting it.

Usage:
    python check_orphans.py <17lands_csv> <cards_json>
Exit code is 0 when there are no orphans, 1 otherwise (handy for CI).
"""

import csv
import json
import sys


def find_orphans(csv_path, cards_json_path):
    """Returns (orphan_names, total_csv_names, total_cards_json_names)."""
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if "Name" not in (reader.fieldnames or []):
            raise ValueError(f"{csv_path}: no 'Name' column found")
        csv_names = {(row.get("Name") or "").strip() for row in reader}
    csv_names.discard("")

    with open(cards_json_path, encoding="utf-8") as f:
        cards = json.load(f).get("cards", {})
    known = {(c.get("name") or "").strip().lower() for c in cards.values()}
    known.discard("")

    orphans = sorted(n for n in csv_names if n.lower() not in known)
    return orphans, len(csv_names), len(known)


def main():
    if len(sys.argv) != 3:
        print("Usage: python check_orphans.py <17lands_csv> <cards_json>")
        sys.exit(2)

    csv_path, cards_json_path = sys.argv[1], sys.argv[2]
    orphans, csv_count, known_count = find_orphans(csv_path, cards_json_path)

    print(f"17Lands CSV: {csv_count} unique card names")
    print(f"cards.json:  {known_count} unique card names")

    if not orphans:
        print(f"\nAll {csv_count} 17Lands cards resolve to a GrpId. No orphans.")
        sys.exit(0)

    print(f"\n{len(orphans)} orphan(s) — present in 17Lands CSV, missing from cards.json:")
    for n in orphans:
        print(f"  {n}")
    sys.exit(1)


if __name__ == "__main__":
    main()
