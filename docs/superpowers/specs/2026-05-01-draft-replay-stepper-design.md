# Draft Replay Stepper — Design Spec

**Date:** 2026-05-01
**Status:** Approved, ready for implementation plan
**Builds on:** `2026-05-01-draft-replays-design.md` (persistence + live wheel-correlation overlay)

## Goal

Let the player step backward and forward through any persisted draft, one pick at a time, using the keyboard arrow keys. The view at each `(pack, pick)` is reconstructed to match what the player would have seen at that moment — same ranked pack list, same "Removed since pick N-8" wheel section, plus an in-app My Picks sidebar that subtly de-emphasizes picks made *after* the one being viewed.

A dropdown above the draft pack panel selects which draft to view. The active draft (if one is in progress) auto-selects when its first DRAFT_UPDATE arrives, and any subsequent DRAFT_UPDATE snaps the view back to live regardless of where the user had wandered.

## Constraints

- **Works on both live and past drafts from day one.** The stepper is coordinate-driven and source-agnostic.
- **No new persisted data.** Everything new is computed on demand from the existing `DraftRecord` shape and the current 17Lands CSV. Past drafts re-rank automatically when the CSV updates.
- **Snap-to-live always.** If the user is browsing history (any draft, any coord) and a `DRAFT_UPDATE` event arrives, the view jumps to the live coord of the live draft. This protects against a user missing a pick because they were looking at history.
- **Arrow keys only on the draft page.** No global capture; ignored when an input/textarea/select has focus so dropdown keyboard navigation still works.
- **Forward beyond live is unsupported (silent no-op).** A separate planned feature will handle prediction; out of scope here.

## Architecture

```
[dataStore.drafts (unchanged on disk)]
            │
            ▼
[draftPipeline]
   ├─ buildDraftUpdatePayload(state, ...)        — live path, used by DRAFT_UPDATE handler
   └─ buildViewerBundle(record, ...)             — past-draft path, used by IPC handler
            │   (both produce the same ViewerBundle shape)
            ▼
[main.js IPC]
   ├─ event 'draft-update'                       — pushed on every DRAFT_UPDATE (existing)
   ├─ ipcMain.handle('list-drafts', ...)         — NEW: dropdown metadata
   └─ ipcMain.handle('view-draft-record', id)    — NEW: load a past record
            │
            ▼
[renderer.js]
   state: { bundle, draftList, viewingCoord }
   triggers:
     - 'draft-update' → replace bundle, snap viewingCoord = bundle.liveCoord
     - dropdown change → invoke('view-draft-record', draftId), replace bundle
     - ArrowLeft / ArrowRight → mutate viewingCoord, re-render from cached bundle
   render:
     - getViewingPick() = bundle.picks.find(p => p.pack === viewingCoord.pack && p.pick === viewingCoord.pick)
     - renderCurrentPack(viewingPick.options)
     - renderRemovedSection(viewingPick.removedCards)
     - renderPickHistory(bundle.picks, viewingCoord)   — with .viewing / .future CSS states
```

**Single source of truth for "what to render":** `bundle.picks[viewingCoord]`. The renderer never branches on live vs. past — it just renders the entry at the current coord. Live mode is the special case where `viewingCoord === bundle.liveCoord`.

## Components

| File | Change |
|------|--------|
| `draftPipeline.js` | Refactor enrichment into a per-pick helper. Output shape changes: `picks[]` carries fully enriched entries (ranked `options`, ranked `removedCards`, `picked`, `missing`); top-level `currentPack`/`removedCards` go away in favor of `liveCoord: {pack, pick}` pointing into `picks[]`. New exported function `buildViewerBundle(record, draftAssistant, resolveCards, resolveCard)` for past records. |
| `main.js` | Register two `ipcMain.handle` callbacks: `list-drafts` and `view-draft-record`. The DRAFT_UPDATE case still uses `buildDraftUpdatePayload`, but its emitted payload now uses the new bundle shape. |
| `dataStore.js` | Add `getDraftSummaries()` → `[{draftId, startedAt, pickCount}]` sorted by `startedAt` desc. |
| `renderer.js` | Add viewing-coord state, arrow-key handler, dropdown wiring, snap-to-live on incoming draft-update. Refactor `renderDraftPage` to read from `picks[viewingCoord]`. `renderPickHistory` gains a `viewingCoord` parameter for `.viewing` / `.future` styling. Export new pure helpers `prevCoord(picks, coord)` / `nextCoord(picks, coord)` for testability. |
| `index.html` | Dropdown above the draft pack panel; CSS for `.draft-pick-item.viewing` (highlight) and `.draft-pick-item.future` (muted). |
| `draftCorrelation.js`, `logParserV5.js` | Unchanged. |

## Data Model

**ViewerBundle** (returned by both the `'draft-update'` event and `view-draft-record` IPC):
```js
{
  draftId: string,
  startedAt: number,
  liveCoord: { pack: number, pick: number } | null,   // most-recent observed; null only for empty records
  picks: [
    {
      pack: number,
      pick: number,
      picked: number | null,                           // null = pending pack-view (live coord) OR missing
      missing?: true,                                  // gap-fill placeholder (existing behavior)
      options: RankedCard[],                           // pre-ranked, same shape as today's currentPack.options
      removedCards: RankedCard[],                      // [] for pick <= 8 or when correlation can't compute
      pickedCard?: ResolvedCard,                       // present when picked != null && !missing
    },
    ...
  ],
  assistantLoaded: boolean,
  assistantStatus: { loaded, cardCount, setName, csvPath },
}
```

`RankedCard` is what `draftAssistant.rankPack` already returns (`{arena_id, name, manaCost, gihWr, lowSample, tier, stats, ...}`). `ResolvedCard` is the same minus the rank fields.

**`picks[]` is sorted by `(pack, pick)` exactly once when the bundle is built.** Renderer assumes sorted order; prev/next lookups are by index in the sorted array.

## IPC Contracts

- `ipcMain.handle('list-drafts', ...)` → `Promise<[{draftId, startedAt, pickCount}]>`. Sorted by `startedAt` desc. Empty array if no drafts.
- `ipcMain.handle('view-draft-record', (_, draftId)) ` → `Promise<ViewerBundle | null>`. Null if `draftId` not found.
- Existing event `'draft-update'` — unchanged emission point, but the payload type changes to `ViewerBundle`.

## Renderer State & Interactions

```js
let bundle        = null;       // ViewerBundle currently loaded
let draftList     = [];         // [{draftId, startedAt, pickCount}] for the dropdown
let viewingCoord  = null;       // {pack, pick}
```

**Triggers:**

| Trigger | Behavior |
|---------|----------|
| App boot / draft page first opened | Call `list-drafts` to populate the dropdown. If a `'draft-update'` event arrives → that bundle wins. Else auto-load the most recent past draft via `view-draft-record(draftList[0].draftId)`. If both empty → "No draft in progress" placeholder. |
| New `'draft-update'` event | Replace `bundle`. Snap `viewingCoord = bundle.liveCoord`. Dropdown selection follows the new bundle's `draftId`. |
| Dropdown change | `view-draft-record(draftId)` → replace `bundle`, set `viewingCoord = bundle.liveCoord`. |
| ArrowLeft | If a previous pick exists in `bundle.picks` (sorted), set `viewingCoord` to it. At absolute start (P1p1), silent no-op. |
| ArrowRight | If a next pick exists, set `viewingCoord` to it. At `liveCoord`, silent no-op. |

**Arrow-key gating:**
- Only fires when `currentPage === 'draft'`.
- Ignored when focus is on an input/textarea/select.
- Single handler bound to `document` at DOMContentLoaded.

**My Picks pick-history visual states (the Q2C hybrid the user picked):**
- Picks before `viewingCoord`: normal style.
- Pick at `viewingCoord`: highlighted (`.viewing` class).
- Picks after `viewingCoord`: muted (`.future` class).
- The pending live pack-view (`picked: null && !missing`) is filtered out of the My Picks list, same as today.

**Edge feedback:** silent no-op at boundaries (P1p1 left, liveCoord right). A subtle CSS shake can be layered in later if it feels too unresponsive — kept out of v1.

## Edge Cases

**Empty / sparse states:**
- No drafts on disk and no live draft: existing "No draft in progress" placeholder; dropdown is shown with a single disabled "No past drafts yet" option.
- Draft with only a pending pack-view (just-opened P1p1, no picks yet): `picks[]` has one entry, `liveCoord = {1,1}`, My Picks list is empty, pack panel renders normally.
- Missing-pick coord as the viewing target: arrow keys navigate through it; pack panel shows the existing missing-placeholder UI.

**17Lands CSV reload:**
- Live bundle: existing `csv-reload` flow already re-enriches via `lastDraftEventData`. No change.
- Past-draft viewer bundles cached in the renderer go stale (their `gihWr` reflects the CSV at load time). Acceptable: re-selecting the draft from the dropdown re-fetches and re-enriches. Not auto-handled.

**Failures:**
- `view-draft-record` returns `null` (unknown draftId) or rejects: log a warn, leave the existing bundle in place — don't blank the screen.
- `viewingCoord` somehow points to a coord not in `picks[]` (defensive): snap to `liveCoord`.

**No new persistence concerns:** every change is in-memory or computed.

## Testing Strategy

### Layer 1 — Pure pipeline (extend `tests/test_draftPipeline.js`)
- New per-pick enrichment helper: ranks options, computes `removedCards` for picks > 8, returns `[]` for picks ≤ 8.
- `buildViewerBundle(record, ...)` for the synthetic 45-pick fixture: every pick has ranked options; picks 9–14 of each pack have non-empty `removedCards`; `liveCoord` matches the last entry; `picks[]` sorted by `(pack, pick)`.
- 17Lands not loaded: every pick's options/removedCards have `gihWr: null, lowSample: true`.
- Empty record: returns `{picks: [], liveCoord: null}`.

### Layer 2 — DataStore (extend `tests/test_dataStore.js`)
- `getDraftSummaries()` returns `[{draftId, startedAt, pickCount}]` sorted by `startedAt` desc. `pickCount` is `record.picks.length` (raw entries — includes any pending `picked: null` entry but NOT gap-fill placeholders, which are computed in the pipeline rather than persisted). Empty store returns `[]`.

### Layer 3 — IPC handlers (extend `tests/test_main.js`)
- `view-draft-record(unknownId)` returns `null`.
- `view-draft-record(knownId)` returns a viewer bundle with the expected `liveCoord`.
- `list-drafts` returns draft summaries.

### Layer 4 — Renderer pure helpers (extend `tests/test_renderer.js`)
- Export `prevCoord(picks, coord)` / `nextCoord(picks, coord)`. Test:
  - `prev` at P1p1 → returns the same coord (silent no-op signal).
  - `next` at last entry → returns the same coord.
  - `prev` / `next` walk across pack boundaries (`P2p1 ↔ P1p14`).
  - Walking traverses missing-pick placeholders, doesn't skip them.
  - `picks[]` not sorted on input → handled defensively (sort inside, or document precondition that bundle is pre-sorted).

### Layer 5 — Manual validation
- Load the app with the persisted $5 draft. Step backward to P1p9, confirm wheel section appears. Step backward to P1p1, confirm boundary no-op.
- Switch dropdown to a different draft (requires a second persisted record — replay another preflight log against `dataStore`, or open a second real draft).
- Trigger a live DRAFT_UPDATE while viewing history (replay a Player.log via the preflight harness while the app is open), confirm snap-to-live yanks the view to the new live coord.

## Notes for Implementation

**Breaking changes from the existing `'draft-update'` payload shape** (Tasks 4 and 5 of the prior plan):
- Top-level `currentPack` and `removedCards` are removed. Renderer reads them via `bundle.picks[viewingCoord]`.
- Inside `picks[]`, the field formerly named `picked` (a *resolved card object* in the old shape) is now split: `picked: number | null` (raw grpId, matches the on-disk shape) and `pickedCard: ResolvedCard` (the resolved object). All renderer call sites that read `pick.picked.name` etc. need updating to `pick.pickedCard.name`.
- Inside `picks[]`, `options` is now `RankedCard[]` (ranked) for every pick, not just the live one. Old shape had `ResolvedCard[]` (unranked) for historical picks.

These are intentional — the new shape keeps the rendering logic uniform across live and historical picks. The existing `lastDraftEventData` re-enrichment path on CSV reload continues to work (it just builds a new bundle).

## Implementation Phases

Each step is independently testable.

1. **Pipeline refactor + new export:** restructure `draftPipeline.js` to per-pick enrichment; add `buildViewerBundle`. Update existing tests for the new payload shape.
2. **DataStore summaries:** add `getDraftSummaries()` + tests.
3. **IPC handlers:** wire `list-drafts` and `view-draft-record` in `main.js` + tests.
4. **Renderer pure helpers:** add and export `prevCoord` / `nextCoord` + tests.
5. **Renderer state + UI:** viewingCoord, arrow-key handler, dropdown, snap-to-live, My Picks `.viewing` / `.future` states. CSS in `index.html`.
6. **Manual validation:** dropdown switch, arrow stepping, snap-to-live behavior.

## Out of Scope

- **Forward-beyond-live prediction.** Separate planned feature.
- **Cross-draft arrow navigation** (e.g., "next draft" / "prev draft" via shift-arrow). Dropdown only for now.
- **Auto-refresh of past viewer bundles when the CSV reloads.** Manual re-select from the dropdown is sufficient.
- **Any persisted-state changes.** `drafts.json` shape is stable.

## Open Questions

None at spec time. Edge feedback (boundary shake) is deferred to post-v1 based on feel.
