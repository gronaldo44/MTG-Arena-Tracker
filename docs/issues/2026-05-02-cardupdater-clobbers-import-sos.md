# cardUpdater.js wipes import_sos.py merges on every daily Scryfall refresh

**Filed:** 2026-05-02
**Status:** Open
**Affected files:** `cardUpdater.js`, `cards.json`, `sos-card-import/import_sos.py`

## Problem

`cardUpdater.js` runs at every app boot and refreshes `cards.json` from Scryfall's `default_cards` bulk dataset. The current implementation **fully overwrites** `cards.json` rather than merging, which silently destroys any cards that were added by `sos-card-import/import_sos.py`.

`cardUpdater.js:119-130` (the relevant block):

```js
this.cardsData = {
  cards: cards,            // <-- only Scryfall-arena_id-mapped cards
  lastUpdated: new Date().toISOString(),
  source: 'scryfall',
  sourceUpdatedAt: defaultCards.updated_at
};

const tempFile = CARDS_FILE + '.tmp';
fs.writeFileSync(tempFile, JSON.stringify(this.cardsData, null, 2));
fs.renameSync(tempFile, CARDS_FILE);   // <-- atomic *replace*, not merge
```

Scryfall's `arena_id` field is manually curated by Scryfall maintainers and lags new MTGA sets by days/weeks. For any set Scryfall has not yet linked, the `arena_id` filter in `downloadAndProcessCards` (line 244, `if (card.arena_id) ...`) drops every card from that set on the floor, so the next overwrite removes all of them from `cards.json`.

## Symptom observed

- Live and past drafts of the SOS premium set rendered every card as `Unknown (<grpId>)`.
- The drafted GrpIds (102460–104125, 341 SOS primary cards verified against MTGA's SQLite) were entirely missing from `cards.json` — its IDs capped at 102111.
- `cards.json` had `lastUpdated: 2026-05-03T02:50:40Z` and `mainDraftSets: null`, confirming `cardUpdater.js` had run more recently than `import_sos.py`.
- Re-running `import_sos.py` against MTGA's DB restored the SOS entries; the next daily Scryfall refresh would clobber them again.

## Proposed fix

Make `downloadCards()` merge instead of replace. Load the existing `cards.json` first, layer Scryfall's fresh data on top (Scryfall wins on overlapping keys so updated names/types/manaCosts propagate), and preserve any entry Scryfall does not know about:

```js
let existingCards = {};
let existingMainDraftSets = null;
try {
  if (fs.existsSync(CARDS_FILE)) {
    const existing = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    existingCards = existing.cards || {};
    existingMainDraftSets = existing.mainDraftSets || null;
  }
} catch (e) {
  console.warn('[CardUpdater] Could not read existing cards.json, doing a full replace:', e.message);
}

const merged = { ...existingCards, ...cards };

this.cardsData = {
  cards: merged,
  lastUpdated: new Date().toISOString(),
  source: 'scryfall',
  sourceUpdatedAt: defaultCards.updated_at,
};

// Preserve mainDraftSets — populated by import_sos.py and consumed by the
// "Browse by set" dropdown. Scryfall's bulk feed cannot supply this.
if (existingMainDraftSets) {
  this.cardsData.mainDraftSets = existingMainDraftSets;
}
```

`mainDraftSets` (also stored at the top level of `cards.json` and written by `import_sos.py`) is currently dropped because the cardUpdater builds `cardsData` from scratch. The fix above also preserves it.

## Test plan

- [ ] Add a unit test (`tests/test_cardUpdater.js`) that seeds an existing `cards.json` with a stub SOS entry (e.g. GrpId `99999999`, a value Scryfall won't return), runs the merge logic against a fixture Scryfall stream that doesn't include it, and asserts the stub survives.
- [ ] Manual: with SOS data present, restart the app and confirm `cards.json` after the boot refresh still contains every SOS GrpId.
- [ ] Manual: confirm `mainDraftSets` is preserved across a Scryfall refresh.

## Out of scope for this issue

- The 24-hour Scryfall refresh cadence itself (separate question).
- Generalizing `import_sos.py` beyond the hard-coded SOS/SOA/SPG-SOS expansion codes (separate issue).
