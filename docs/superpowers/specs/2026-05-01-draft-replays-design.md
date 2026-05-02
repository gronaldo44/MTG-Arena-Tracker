# Draft Replays — Design Spec

**Date:** 2026-05-01
**Status:** Approved, ready for implementation plan

## Goal

Persist every pack view and pick from each MTG Arena draft to a per-draft record on disk, then use that record to power a **live wheel-correlation feature**: when the player wheels a pack (pick 9+ of any pack), show the cards that were taken from that pack since they last saw it, ranked by 17Lands GIH WR, beneath the live pack list.

The persistence layer is also designed to support a post-hoc draft replay viewer, but that viewer is **out of scope** for this iteration. We constrain the data model so it works for both consumers without rework.

## Constraints

- **MVP scope is the live wheel-correlation overlay.** Replay viewer comes later.
- **Premier and Traditional Draft only** for the user-facing feature. Quick Draft/Sealed are not priorities.
- **Persistence is unfiltered.** All drafts the parser observes are saved; we don't tag, gate, or filter at write time. Bootstrap mode (current user count: 2, target: 10).
- **No ephemeral data.** Every pack the player sees is persisted permanently.
- **Real drafts cost ~$5 each.** End-to-end tests must give us enough confidence that one real draft is final acceptance, not iteration #1.

## Architecture

```
[Player.log]
   │
   ▼
[logParserV5.js]   emits DRAFT_UPDATE on Draft.Notify and EventPlayerDraftMakePick
   │              (NO CHANGES to the parser — it already emits the right shape)
   ▼
[main.js handleGameEvent('DRAFT_UPDATE')]
   ├─ dataStore.upsertDraft(event.data)        — idempotent persist
   ├─ persisted = dataStore.getDraft(draftId)  — canonical state
   ├─ removedGrpIds = draftCorrelation.missingCardsForPick(persisted, pack, pick)
   ├─ resolveCards + draftAssistant.rankPack on both lists
   ├─ fillMissingPickPlaceholders(persisted)   — gap detection for renderer
   └─ webContents.send('draft-update', { ..., removedCards, picks })
   │
   ▼
[renderer.js draft-update handler]
   ├─ renderCurrentPack(currentPack)            — existing
   ├─ renderRemovedSection(removedCards)        — NEW: greyed list, sorted by GIH WR
   └─ renderPickHistory(picks)                  — existing; now sourced from persisted store
                                                  with `missing: true` placeholders shown
```

**Single source of truth.** The persisted `dataStore` is canonical. The parser's in-memory state is a feeder; the renderer consumes only the dataStore-derived payload. This unifies the existing My Picks panel with the new persistence layer (free side benefit: My Picks survives Arena restarts mid-draft).

## Components

### 1. `logParserV5.js`
**No changes.** The parser already emits DRAFT_UPDATE events with `{ draftId, picks: [{pack, pick, picked, options}], currentPack: {pack, pick, options} }` — the full shape we need.

### 2. `dataStore.js` — new methods
- `upsertDraft(draftState)` — takes `{ draftId, picks, currentPack }` (the parser's emitted shape), idempotently merges into stored record.
- `getDraft(draftId)` — returns full DraftRecord or null.
- `getAllDrafts()` — returns array of all DraftRecords for future replay viewer.

Backed by new file `drafts.json` written via atomic-rename pattern (`drafts.json.tmp` → `fs.renameSync`) to survive process kills mid-write.

### 3. `draftCorrelation.js` — new module
Pure functions, no I/O.
```js
function missingCardsForPick(draftRecord, pack, pick) {
  if (pick <= 8) return [];
  const earlier = draftRecord.picks.find(p => p.pack === pack && p.pick === pick - 8);
  if (!earlier) return [];
  const current = draftRecord.picks.find(p => p.pack === pack && p.pick === pick);
  if (!current) return [];
  const stillHere = new Set(current.options);
  const taken = earlier.picked != null ? earlier.picked : null;
  return earlier.options.filter(grpId => !stillHere.has(grpId) && grpId !== taken);
}
```
The `pick - 8` lookup works for both pass-left and pass-right packs: after 8 picks any pack returns to whoever held it last, regardless of direction.

### 4. `main.js` — DRAFT_UPDATE handler rewrite
Flow:
1. `dataStore.upsertDraft(event.data)`
2. `persisted = dataStore.getDraft(draftId)`
3. `removedGrpIds = draftCorrelation.missingCardsForPick(persisted, currentPack.pack, currentPack.pick)`
4. Resolve and rank both `currentPack.options` and `removedGrpIds` via `draftAssistant.rankPack`.
5. Run gap-fill helper to insert `{missing: true}` placeholders into the picks array sent to the renderer (does NOT mutate stored record).
6. Send the IPC payload.

### 5. `renderer.js`
- New `renderRemovedSection(removedCards)`: same row template as the live pack list (rank, name, color pips, GIH WR), but with a `removed` modifier class for greyed-out styling. Sorted by GIH WR descending. Hidden when list is empty.
- My Picks panel: filter out `picked: null` entries (pending pack views) but render `missing: true` entries as a muted placeholder row ("⚠ pick missing from log (likely auto-pick)").

## Data Model

**`DraftRecord`** (one entry per draft in `drafts.json`):
```js
{
  draftId: string,
  startedAt: number,           // Date.now() captured on first persist of this draft
  picks: [
    {
      pack: number,            // 1, 2, or 3
      pick: number,            // 1..14 (or pack size)
      options: number[],       // grpIds visible at this pack-view
      picked: number | null    // grpId picked, or null if pack-view only
    },
    ...
  ]
}
```

**`drafts.json`**:
```js
{ drafts: { [draftId]: DraftRecord } }
```

**Why `picked: null` entries are first-class:**
- A `Draft.Notify` event represents a pack view *before* the pick is made. We persist it immediately so the data is durable even if the user closes Arena before picking.
- The matching `EventPlayerDraftMakePick` patches the entry's `picked` from `null` to the chosen grpId.
- Renderer filters `picked: null` out of My Picks (it's not yet a pick), but the entry still exists for correlation.

## Idempotency Contract

The parser rebuilds full draft state from scratch on each scan and emits cumulative DRAFT_UPDATE events. `upsertDraft` MUST be idempotent:

- Key incoming `picks[]` entries by `(pack, pick)`.
- If absent → append.
- If present with `picked: null` and incoming has `picked` set → patch in place.
- Never overwrite a non-null `picked`.
- `currentPack` from the incoming state is treated as a `picked: null` entry at `(currentPack.pack, currentPack.pick)` if no record for that key already exists.

Net effect: applying the same DRAFT_UPDATE state N times produces the same `drafts.json` as applying it once.

## Edge Cases

### Re-scan safety
Covered by idempotency contract above.

### Crash & restart
- *App restart, Arena log intact:* parser replays log, idempotent merges yield identical state. No special handling.
- *Arena restart mid-draft (log cleared):* parser sees only post-restart events. Our store retains pre-restart `picks[]`. New events merge in. Gaps in `picks[]` are tolerated by `missingCardsForPick` (returns `[]` when prior pick lookup fails).
- *Process killed mid-write to `drafts.json`:* atomic-rename pattern prevents corruption.

### Disconnect auto-picks
Arena auto-picks for the user during disconnects. We don't yet know how this surfaces in the log. **Defensive handling:**
- `dataStore` stores only observed events (no fabrication).
- A render-time helper detects gaps in `(pack, pick)` coverage and inserts `{ pack, pick, options: [], picked: null, missing: true }` placeholders into the renderer payload.
- Pack size is derived from `(P, 1).options.length`, falling back to 14 if `(P, 1)` wasn't observed.
- Each detected gap logs once: `[DraftStore] Missing pick (pack=2, pick=4) — likely auto-pick during disconnect`. Deduped by `(draftId, pack, pick)` to avoid spam during re-scans.
- Renderer shows a muted placeholder row in My Picks for each `missing: true` entry. The pack list itself is unaffected.
- Correlation degrades gracefully when a missing pick is the prior-pick lookup target.

**TODO carried forward:** during the first real draft validation, grep `Player.log` for strings like `AutoPick`, `DraftAutoPick`. If found, file a follow-up to extend the parser and convert placeholders into real records.

### Missing data fallbacks
- 17Lands CSV not loaded → `currentPack` and `removedCards` render unranked (name only). Existing fallback for the live list extends to the new section.
- grpId not in `cards.json` → "Card {grpId}" placeholder. Existing app-wide behavior.
- Correlation has no prior pick (joined mid-draft) → `removedCards: []`. Renderer hides the section when empty.

### Concurrency
DRAFT_UPDATE events fire serially during log scans (single-threaded Node). No locks needed. Multiple rapid writes during full re-scans are last-write-wins, which is correct because merges are idempotent.

## Testing Strategy

Goal: validate end-to-end behavior with **zero real drafts**. The single $5 draft is final acceptance, not iteration #1.

### Layer 1 — Pure unit tests (`tests/draftCorrelation.test.js`)
Target: `missingCardsForPick`. Pure function.
- Standard wheel: `(pack=1, pick=9)` returns 7 cards (excludes player's own pick).
- Pick ≤ 8 returns `[]`.
- Prior pick missing → `[]`.
- Current pick missing → `[]`.
- Prior pick has `picked: null` (auto-pick gap): full diff with no card excluded.
- 15-card pack: still works, returns 8 cards at pick 9.
- Pack 2 (right-pass): same shape as pack 1 — verifies bidirectional symmetry.

### Layer 2 — DataStore unit tests (`tests/dataStoreDrafts.test.js`)
Uses tmpdir for `drafts.json`.
- First write creates record with `startedAt` set.
- Re-applying the same DRAFT_UPDATE state: content-stable (no spurious changes).
- `currentPack` merged as `picked: null` entry at correct key.
- Subsequent pick patches `null → grpId` without reordering or duplicating.
- Re-applying a state that contains an already-completed pick does NOT overwrite a non-null `picked`.
- Atomic write: simulate failure mid-rename; assert original isn't corrupted.

### Layer 3 — Pseudo-integration (`tests/draftReplay.integration.test.js`)
Targets the full main.js DRAFT_UPDATE pipeline, with mocked `mainWindow.webContents.send` capturing payloads.

Setup: a fixture `tests/fixtures/draft-sos-full.json` containing the sequence of DRAFT_UPDATE event payloads matching what the parser would emit during a full draft. Generated by hand from a synthetic 40-card universe (no real cards needed).

Cases:
- After full sequence, `getDraft(draftId).picks.length === 45` with all `picked` set.
- At pick 9 of pack 1, IPC payload's `removedCards` matches the expected 7 grpIds.
- Re-running the entire sequence after simulated app restart produces identical final record.
- Inject a missing pick (skip event for pack 2 pick 4): renderer payload has `missing: true` placeholder; pack 2 pick 12 still produces a sensible diff.

### Layer 4 — Manual validation (the $5 draft)
Pre-flight:
- All Layer 1-3 tests passing.
- `drafts.json` doesn't exist yet (or is empty).
- App launched, draft page open and waiting.
- Side terminal tailing `Player.log` to capture for offline replay.

During draft:
- At pick 9 of pack 1, visually confirm the "Removed since pick 1" greyed section.
- After draft completes, confirm `drafts.json` has a single complete record with 45 picks.
- (If brave) restart Arena mid-draft; confirm My Picks panel still shows full history.

Post-flight:
- Save Player.log as `tests/fixtures/real-draft-{date}.log`.
- Grep for auto-pick strings to resolve open TODO.

## Implementation Phases

Each step is independently testable.

1. **`draftCorrelation.js`** + Layer-1 tests.
2. **`dataStore.js` extensions** + Layer-2 tests.
3. **`main.js` DRAFT_UPDATE handler rewrite** + gap-fill helper + Layer-3 tests.
4. **`renderer.js`** rendering of removed section + missing-pick placeholders.
5. **Manual validation** with the pre-/post-flight checklist.

## Out of Scope

- **Post-hoc replay viewer.** Data model accommodates it; UI lands in a follow-on.
- **Format detection / `eventName` capture.** Bootstrap mode, no consumer.
- **Quick Draft / Sealed support.** Quick Draft will likely "just work" because the 8-seat mechanic produces wheels and our correlation is format-agnostic, but it's not actively tested. Sealed has no pack-passing.
- **Auto-pick parser extension.** Defensive placeholders only.
- **Migration of `matches.json` to atomic-write.** New atomic-write path is for `drafts.json` only.
- **Linking drafts to subsequent matches/decks.** Stores stay independent.

## Open Questions / TODOs Carried Forward

- **Auto-pick log shape.** Inspect first captured Player.log for `AutoPick` / `DraftAutoPick` strings.
- **Pack-size assumption.** Re-confirm 14 is right once we have a real-draft fixture.
- **My Picks `picked: null` filtering.** Renderer must distinguish two null cases: pending pack views (filter out) vs. detected gaps with `missing: true` (render as placeholder).
