import json
import argparse
import ijson
import sys


def simplify_type(type_line):
    return type_line.split("—")[0].strip()


def main():
    parser = argparse.ArgumentParser(
        description="Trim Scryfall JSON with progress tracking."
    )
    parser.add_argument("input", help="Input JSON file")
    parser.add_argument("output", help="Output JSON file")

    args = parser.parse_args()

    result = {}

    # First pass: count total items (for progress)
    print("Counting total cards...")
    with open(args.input, "r", encoding="utf-8") as f:
        total = sum(1 for _ in ijson.items(f, "item"))

    print(f"Total cards: {total}")
    print("Processing...")

    # Second pass: process + progress
    processed = 0

    with open(args.input, "r", encoding="utf-8") as f:
        for card in ijson.items(f, "item"):
            processed += 1

            arena_id = card.get("arena_id")
            if arena_id:
                result[str(arena_id)] = {
                    "name": card.get("name", ""),
                    "manaCost": card.get("mana_cost", ""),
                    "type": simplify_type(card.get("type_line", ""))
                }

            # Update progress every N items (avoid slowing down)
            if processed % 1000 == 0 or processed == total:
                sys.stdout.write(f"\rProcessed: {processed}/{total}")
                sys.stdout.flush()

    print("\nWriting output...")

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"Done. Wrote {len(result)} cards.")


if __name__ == "__main__":
    main()