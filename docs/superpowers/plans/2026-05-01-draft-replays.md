# Draft Replays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every pack-view and pick from each MTGA draft to disk and use that record to power a live wheel-correlation overlay (cards taken from the pack since the player last saw it, ranked by GIH WR, shown beneath the live pack list).

**Architecture:** A new pure module `draftCorrelation.js` computes missing-card diffs. The existing `dataStore.js` gains an idempotent `upsertDraft` API backed by a new `drafts.json` file (atomic-rename writes). A new `draftPipeline.js` module composes persist→read→correlate→rank→gap-fill into a single payload-builder that `main.js` calls from its DRAFT_UPDATE handler. The renderer adds a greyed "Removed since pick N" section beneath the live pack list and renders `missing: true` placeholder rows in the My Picks panel.

**Tech Stack:** Node 16+, Electron 40, Jest 30 (test files match `tests/test_*.js`), vanilla JS in renderer, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-01-draft-replays-design.md`

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `draftCorrelation.js` | Create | Pure: `missingCardsForPick(record, pack, pick) → grpId[]` |
| `tests/test_draftCorrelation.js` | Create | Layer-1 unit tests for correlation |
| `dataStore.js` | Modify | Add `loadDrafts`, `upsertDraft`, `getDraft`, `getAllDrafts`, `_atomicWrite` |
| `tests/test_dataStore.js` | Create | Layer-2 unit tests for the new draft methods |
| `draftPipeline.js` | Create | Composes persist→read→correlate→rank→gap-fill into a payload builder |
| `tests/test_draftPipeline.js` | Create | Layer-3 pseudo-integration test driving the full pipeline |
| `tests/fixtures/draft-synthetic.js` | Create | Programmatic generator for a synthetic 45-pick draft event sequence |
| `main.js` | Modify | DRAFT_UPDATE case delegates to `draftPipeline.buildDraftUpdatePayload` |
| `renderer.js` | Modify | Render "Removed since pick N" section + filter/render `missing: true` rows |
| `index.html` | Modify | Add DOM container for the removed section + CSS for `.removed` row state |

**Why this split:**
- `draftCorrelation.js` is pure, no I/O, easiest unit. Lives at root next to `draftAssistant.js` — same convention.
- `draftPipeline.js` keeps DRAFT_UPDATE composition out of `main.js`, where it'd be harder to test. `main.js` shrinks; pipeline grows independently testable.
- `tests/test_dataStore.js` is new (no prior dataStore tests); scope is intentionally narrow to draft methods so the file can grow as other parts of dataStore eventually get tested.

---

## Task 1: Create `draftCorrelation.js` with the wheel-diff primitive

**Files:**
- Create: `draftCorrelation.js`
- Create: `tests/test_draftCorrelation.js`

The primitive is a pure function: given a `DraftRecord` and a `(pack, pick)` coordinate, return the grpIds that were taken from this physical pack between the player's last view and this view. Lookup target is always `(pack, pick - 8)` because after 8 picks any pack returns to whoever held it last (the cycle length is the player count, regardless of pass direction).

- [ ] **Step 1.1: Write the failing test file**

Create `tests/test_draftCorrelation.js`:

```js
'use strict';

const { missingCardsForPick } = require('../draftCorrelation');

// Helper: build a DraftRecord from a flat array of pick descriptors.
function record(...picks) {
  return { draftId: 'd1', startedAt: 0, picks };
}

describe('missingCardsForPick', () => {
  test('returns [] for picks <= 8 (no wheel possible)', () => {
    const r = record(
      { pack: 1, pick: 1, options: [10, 11, 12], picked: 10 },
      { pack: 1, pick: 8, options: [20, 21],     picked: 20 },
    );
    expect(missingCardsForPick(r, 1, 1)).toEqual([]);
    expect(missingCardsForPick(r, 1, 8)).toEqual([]);
  });

  test('standard wheel: pick 9 against pick 1, excludes own pick', () => {
    const r = record(
      // Pick 1: opened 14 cards, took id 100
      { pack: 1, pick: 1, options: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113], picked: 100 },
      // Pick 9: 6 cards remain (8 taken: us + 7 left-neighbors)
      { pack: 1, pick: 9, options: [108, 109, 110, 111, 112, 113], picked: null },
    );
    const result = missingCardsForPick(r, 1, 9);
    // Expected: 101..107 (the 7 cards taken by other players), NOT 100 (our own pick).
    expect(result.sort()).toEqual([101, 102, 103, 104, 105, 106, 107]);
  });

  test('returns [] when prior pick is missing from record', () => {
    const r = record(
      { pack: 1, pick: 9, options: [108], picked: null },
    );
    expect(missingCardsForPick(r, 1, 9)).toEqual([]);
  });

  test('returns [] when current pick is missing from record', () => {
    const r = record(
      { pack: 1, pick: 1, options: [100, 101], picked: 100 },
    );
    expect(missingCardsForPick(r, 1, 9)).toEqual([]);
  });

  test('prior pick has picked: null (auto-pick gap) — full diff with no card excluded', () => {
    const r = record(
      { pack: 1, pick: 1, options: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113], picked: null },
      { pack: 1, pick: 9, options: [108, 109, 110, 111, 112, 113], picked: null },
    );
    const result = missingCardsForPick(r, 1, 9);
    // 8 cards missing including the one whose picker we don't know.
    expect(result.sort()).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  });

  test('15-card pack still works (wheel stays at pick - 8)', () => {
    const opts = Array.from({length: 15}, (_, i) => 200 + i); // 200..214
    const r = record(
      { pack: 1, pick: 1, options: opts,             picked: 200 },
      { pack: 1, pick: 9, options: opts.slice(8),    picked: null }, // 7 cards remain after 8 picks
    );
    const result = missingCardsForPick(r, 1, 9);
    // 8 cards missing total, minus our own pick (200) = 7 cards
    expect(result.sort()).toEqual([201, 202, 203, 204, 205, 206, 207]);
  });

  test('pack 2 (right-pass) returns the same shape as pack 1', () => {
    const r = record(
      { pack: 2, pick: 1, options: [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313], picked: 300 },
      { pack: 2, pick: 9, options: [308, 309, 310, 311, 312, 313], picked: null },
    );
    const result = missingCardsForPick(r, 2, 9);
    expect(result.sort()).toEqual([301, 302, 303, 304, 305, 306, 307]);
  });

  test('wheel at pick 14 against pick 6', () => {
    const r = record(
      { pack: 1, pick: 6,  options: [400, 401, 402, 403, 404, 405, 406, 407, 408], picked: 400 },
      { pack: 1, pick: 14, options: [408],                                          picked: null },
    );
    const result = missingCardsForPick(r, 1, 14);
    // 8 cards in earlier view, 1 remains, 1 was our own pick. Missing = 6 (excludes our own pick).
    expect(result.sort()).toEqual([401, 402, 403, 404, 405, 406, 407]);
  });
});
```

- [ ] **Step 1.2: Run test, verify failure**

Run: `npx jest tests/test_draftCorrelation.js`
Expected: FAIL with "Cannot find module '../draftCorrelation'".

- [ ] **Step 1.3: Implement `draftCorrelation.js`**

Create `draftCorrelation.js`:

```js
'use strict';

/**
 * draftCorrelation
 *
 * Pure functions that derive insights from a persisted DraftRecord.
 * No I/O; safe to import from any process.
 *
 * A DraftRecord has shape:
 *   { draftId, startedAt, picks: [{ pack, pick, options: number[], picked: number|null }] }
 *
 * The wheel correlation: for any pick (pack, pick) where pick > 8, the
 * "physical" pack we're seeing is the same one we saw at (pack, pick - 8).
 * After 8 picks any pack returns to whoever held it last — the cycle is
 * tied to the player count (8), not the pass direction. So the same
 * formula works for left-pass (packs 1, 3) and right-pass (pack 2) alike.
 */

/**
 * Return the grpIds that were taken from this pack between the player's
 * last view (at pick - 8) and the current view (at pick). Excludes the
 * card the player picked at the earlier view.
 *
 * Returns [] when correlation isn't possible (pick <= 8, prior pick or
 * current pick missing from record).
 */
function missingCardsForPick(draftRecord, pack, pick) {
  if (pick <= 8) return [];
  if (!draftRecord || !Array.isArray(draftRecord.picks)) return [];

  const earlier = draftRecord.picks.find(
    p => p.pack === pack && p.pick === pick - 8
  );
  if (!earlier) return [];

  const current = draftRecord.picks.find(
    p => p.pack === pack && p.pick === pick
  );
  if (!current) return [];

  const stillHere = new Set(current.options);
  const ownPick = earlier.picked != null ? earlier.picked : null;

  return earlier.options.filter(
    grpId => !stillHere.has(grpId) && grpId !== ownPick
  );
}

module.exports = { missingCardsForPick };
```

- [ ] **Step 1.4: Run test, verify pass**

Run: `npx jest tests/test_draftCorrelation.js`
Expected: PASS, 8/8 tests.

- [ ] **Step 1.5: Commit**

```bash
git add draftCorrelation.js tests/test_draftCorrelation.js
git commit -m "$(cat <<'EOF'
add draftCorrelation module with wheel-diff primitive

Pure function that computes the cards taken from a pack between the
player's last view and the current view. Foundation for the live
wheel-correlation feature.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `dataStore.js` with draft persistence

**Files:**
- Modify: `dataStore.js` (add init for `draftsFile`, new methods, atomic write helper)
- Create: `tests/test_dataStore.js`

The persistence path is **idempotent** because the parser rebuilds full draft state on every scan and emits cumulative DRAFT_UPDATE events. Writes use atomic-rename to avoid mid-write corruption.

- [ ] **Step 2.1: Write the failing test file**

Create `tests/test_dataStore.js`:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// dataStore reads `app.getPath('userData')` from electron at construction.
// Mock electron BEFORE requiring dataStore.
let MOCK_USERDATA;
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => MOCK_USERDATA) },
}));

const DataStore = require('../dataStore');

describe('DataStore — drafts', () => {
  let ds;

  beforeEach(() => {
    MOCK_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-ds-'));
    ds = new DataStore();
  });

  afterEach(() => {
    fs.rmSync(MOCK_USERDATA, { recursive: true, force: true });
  });

  test('getAllDrafts returns [] when no drafts exist', () => {
    expect(ds.getAllDrafts()).toEqual([]);
  });

  test('getDraft returns null for unknown id', () => {
    expect(ds.getDraft('nope')).toBeNull();
  });

  test('upsertDraft creates a record on first call with startedAt set', () => {
    const before = Date.now();
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11, 12], picked: 10 }],
      currentPack: null,
    });
    const after = Date.now();

    const record = ds.getDraft('d1');
    expect(record).not.toBeNull();
    expect(record.draftId).toBe('d1');
    expect(record.startedAt).toBeGreaterThanOrEqual(before);
    expect(record.startedAt).toBeLessThanOrEqual(after);
    expect(record.picks).toEqual([{ pack: 1, pick: 1, options: [10, 11, 12], picked: 10 }]);
  });

  test('upsertDraft persists to drafts.json', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
      currentPack: null,
    });
    const draftsFile = path.join(MOCK_USERDATA, 'data', 'drafts.json');
    expect(fs.existsSync(draftsFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(draftsFile, 'utf8'));
    expect(parsed.drafts.d1.draftId).toBe('d1');
    expect(parsed.drafts.d1.picks).toHaveLength(1);
  });

  test('drafts persist across DataStore instances (load on construction)', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
      currentPack: null,
    });
    const ds2 = new DataStore();
    expect(ds2.getDraft('d1').picks).toEqual([
      { pack: 1, pick: 1, options: [10], picked: 10 },
    ]);
  });

  test('upsertDraft is idempotent: re-applying same state produces same record', () => {
    const state = {
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
      currentPack: null,
    };
    ds.upsertDraft(state);
    const startedAt1 = ds.getDraft('d1').startedAt;
    ds.upsertDraft(state);
    ds.upsertDraft(state);
    const after = ds.getDraft('d1');
    expect(after.startedAt).toBe(startedAt1);
    expect(after.picks).toEqual(state.picks);
  });

  test('upsertDraft merges currentPack as picked: null entry', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [],
      currentPack: { pack: 1, pick: 1, options: [10, 11, 12] },
    });
    expect(ds.getDraft('d1').picks).toEqual([
      { pack: 1, pick: 1, options: [10, 11, 12], picked: null },
    ]);
  });

  test('upsertDraft patches picked: null → grpId on subsequent pick event', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [],
      currentPack: { pack: 1, pick: 1, options: [10, 11, 12] },
    });
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11, 12], picked: 11 }],
      currentPack: null,
    });
    expect(ds.getDraft('d1').picks).toEqual([
      { pack: 1, pick: 1, options: [10, 11, 12], picked: 11 },
    ]);
  });

  test('upsertDraft does NOT overwrite a non-null picked', () => {
    // Initial pick recorded
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
      currentPack: null,
    });
    // Hostile re-application with a different picked value (shouldn't happen in practice,
    // but defensive: never overwrite). Verifies the contract.
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 99 }],
      currentPack: null,
    });
    expect(ds.getDraft('d1').picks[0].picked).toBe(10);
  });

  test('upsertDraft appends new (pack, pick) entries without duplicating existing ones', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
      currentPack: null,
    });
    ds.upsertDraft({
      draftId: 'd1',
      picks: [
        { pack: 1, pick: 1, options: [10],     picked: 10 },
        { pack: 1, pick: 2, options: [20, 21], picked: 20 },
      ],
      currentPack: null,
    });
    const picks = ds.getDraft('d1').picks;
    expect(picks).toHaveLength(2);
    expect(picks.find(p => p.pick === 1).picked).toBe(10);
    expect(picks.find(p => p.pick === 2).picked).toBe(20);
  });

  test('atomic write: drafts.json.tmp does not exist after successful write', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
      currentPack: null,
    });
    const draftsFile = path.join(MOCK_USERDATA, 'data', 'drafts.json');
    expect(fs.existsSync(draftsFile)).toBe(true);
    expect(fs.existsSync(draftsFile + '.tmp')).toBe(false);
  });

  test('getAllDrafts returns array of all stored drafts', () => {
    ds.upsertDraft({ draftId: 'd1', picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }], currentPack: null });
    ds.upsertDraft({ draftId: 'd2', picks: [{ pack: 1, pick: 1, options: [20], picked: 20 }], currentPack: null });
    const all = ds.getAllDrafts();
    expect(all).toHaveLength(2);
    expect(all.map(d => d.draftId).sort()).toEqual(['d1', 'd2']);
  });

  test('upsertDraft with empty picks and no currentPack still creates record', () => {
    ds.upsertDraft({ draftId: 'd1', picks: [], currentPack: null });
    expect(ds.getDraft('d1')).toMatchObject({ draftId: 'd1', picks: [] });
  });

  test('currentPack at (P,N) where (P,N) already has picked: grpId is a no-op', () => {
    // Realistic scenario: a re-scan emits both a Draft.Notify (currentPack) and
    // the EventPlayerDraftMakePick (picks[]) for the same coordinate.
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
      currentPack: { pack: 1, pick: 1, options: [10, 11] },
    });
    expect(ds.getDraft('d1').picks).toEqual([
      { pack: 1, pick: 1, options: [10, 11], picked: 10 },
    ]);
  });
});
```

- [ ] **Step 2.2: Run test, verify failure**

Run: `npx jest tests/test_dataStore.js`
Expected: FAIL — methods (`upsertDraft`, `getDraft`, `getAllDrafts`) do not exist on DataStore.

- [ ] **Step 2.3: Add `draftsFile` and `loadDrafts` to DataStore constructor**

In `dataStore.js`, locate the constructor (currently `dataStore.js:11-36`) and add `draftsFile` initialization plus a `loadDrafts()` call.

Find this block:
```js
    this.dataFile     = path.join(this.dataDir, 'matches.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.cardsFile    = path.join(__dirname, 'cards.json');
    this.cardStatsFile = path.join(this.dataDir, 'cardStats.json');
```

Replace with:
```js
    this.dataFile     = path.join(this.dataDir, 'matches.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.cardsFile    = path.join(__dirname, 'cards.json');
    this.cardStatsFile = path.join(this.dataDir, 'cardStats.json');
    this.draftsFile   = path.join(this.dataDir, 'drafts.json');
```

Find this block (currently `dataStore.js:32-35`):
```js
    // Load existing data
    this.data       = this.loadData();
    this.settings   = this.loadSettings();
    this.cards      = this.loadCards();
    this.cardStats  = this.loadCardStats();
```

Replace with:
```js
    // Load existing data
    this.data       = this.loadData();
    this.settings   = this.loadSettings();
    this.cards      = this.loadCards();
    this.cardStats  = this.loadCardStats();
    this.drafts     = this.loadDrafts();
```

- [ ] **Step 2.4: Implement `loadDrafts`, `upsertDraft`, `getDraft`, `getAllDrafts`, `_atomicWrite`, `saveDrafts`**

Append the following methods to the `DataStore` class in `dataStore.js`, **just before the `generateId()` method** at the end of the class. Locate `generateId() {` and insert this block above it:

```js
  /**
   * Load drafts from disk. Returns {} if file missing or unreadable.
   * Shape on disk: { drafts: { [draftId]: DraftRecord } }
   */
  loadDrafts() {
    try {
      if (fs.existsSync(this.draftsFile)) {
        const content = fs.readFileSync(this.draftsFile, 'utf8');
        const parsed = JSON.parse(content);
        return parsed.drafts || {};
      }
    } catch (e) {
      console.error('[DataStore] Error loading drafts:', e);
    }
    return {};
  }

  /**
   * Persist all drafts to disk via atomic-rename. Survives mid-write process kill.
   */
  saveDrafts() {
    try {
      this._atomicWrite(
        this.draftsFile,
        JSON.stringify({ drafts: this.drafts }, null, 2)
      );
    } catch (e) {
      console.error('[DataStore] Error saving drafts:', e);
    }
  }

  /**
   * Atomic write: write to .tmp, then rename. fs.renameSync is atomic on
   * POSIX and Windows for files on the same volume.
   */
  _atomicWrite(filePath, content) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Idempotently merge a draft state into the persisted store.
   *
   * @param {object} state - Parser's DRAFT_UPDATE shape:
   *   { draftId, picks: [{pack, pick, options, picked}], currentPack: {pack, pick, options} | null }
   *
   * Merge rules:
   *  - If no record exists for draftId → create with startedAt = Date.now().
   *  - For each picks[] entry, key by (pack, pick):
   *      • absent → append
   *      • present with picked: null and incoming picked set → patch picked
   *      • present with non-null picked → no-op (never overwrite)
   *  - If currentPack is set and (pack, pick) is not yet recorded → append as picked: null entry.
   */
  upsertDraft(state) {
    if (!state || !state.draftId) return;
    const { draftId, picks: incomingPicks = [], currentPack = null } = state;

    if (!this.drafts[draftId]) {
      this.drafts[draftId] = {
        draftId,
        startedAt: Date.now(),
        picks: [],
      };
    }
    const record = this.drafts[draftId];

    const findIdx = (pack, pick) =>
      record.picks.findIndex(p => p.pack === pack && p.pick === pick);

    const mergeEntry = (pack, pick, options, picked) => {
      const idx = findIdx(pack, pick);
      if (idx === -1) {
        record.picks.push({ pack, pick, options: [...options], picked: picked ?? null });
        return;
      }
      const existing = record.picks[idx];
      // Patch picked only if it's currently null and the incoming sets it.
      if (existing.picked === null && picked != null) {
        existing.picked = picked;
      }
      // options are stable for a given (pack, pick) — leave existing options as-is.
    };

    for (const p of incomingPicks) {
      mergeEntry(p.pack, p.pick, p.options || [], p.picked ?? null);
    }

    if (currentPack && currentPack.pack != null && currentPack.pick != null) {
      mergeEntry(currentPack.pack, currentPack.pick, currentPack.options || [], null);
    }

    this.saveDrafts();
  }

  /**
   * Return the DraftRecord for draftId, or null.
   */
  getDraft(draftId) {
    return this.drafts[draftId] || null;
  }

  /**
   * Return all DraftRecords as an array.
   */
  getAllDrafts() {
    return Object.values(this.drafts);
  }
```

- [ ] **Step 2.5: Run test, verify pass**

Run: `npx jest tests/test_dataStore.js`
Expected: PASS, all tests green.

- [ ] **Step 2.6: Sanity-check that existing tests still pass**

Run: `npx jest`
Expected: PASS — `test_dataStore.js`, `test_draftCorrelation.js`, plus all pre-existing tests (`test_draftAssistant.js`, `test_logParserV5.js`, `test_main.js`, `test_renderer.js`).

- [ ] **Step 2.7: Commit**

```bash
git add dataStore.js tests/test_dataStore.js
git commit -m "$(cat <<'EOF'
add idempotent draft persistence to dataStore

drafts.json holds per-draft pick records, written via atomic-rename to
survive mid-write process kills. upsertDraft is idempotent so the parser
rebuilding state on every scan is safe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `draftPipeline.js` with payload builder + gap-fill helper

**Files:**
- Create: `draftPipeline.js`
- Create: `tests/fixtures/draft-synthetic.js`
- Create: `tests/test_draftPipeline.js`

The pipeline composes: persist → read back → correlate → resolve+rank → fill placeholders → return payload. Extracting it to a module keeps `main.js` thin and gives Layer-3 tests a clean import surface.

The gap-fill helper detects missing `(pack, pick)` coordinates within the observed range and inserts `{ missing: true }` placeholders into the picks array sent to the renderer. It does **not** mutate the persisted record. Pack size is derived from `(P, 1).options.length`, falling back to 14.

- [ ] **Step 3.1: Create the fixture generator**

Create `tests/fixtures/draft-synthetic.js`:

```js
'use strict';

/**
 * Synthetic draft generator for pseudo-integration tests.
 *
 * Produces a sequence of DRAFT_UPDATE event payloads matching what the
 * parser emits during a real draft. The card universe is deterministic
 * (grpIds 1000..1999) so test assertions can compare exact arrays.
 *
 * Each pack starts with `packSize` distinct grpIds in a known range so
 * the wheel diff at pick 9 is exactly `[opener+1 .. opener+7]`.
 */

const PLAYER_COUNT = 8;

/**
 * Build a fully-played 3-pack draft with deterministic picks.
 *
 * @param {object} opts
 * @param {string} opts.draftId       — the draftId for the synthetic draft
 * @param {number} opts.packSize      — cards per pack (default 14)
 * @returns {{
 *   events: Array<{type: 'DRAFT_UPDATE', data: ParserDraftState}>,
 *   expectedRemovedAtP1Pick9: number[],   // sorted grpIds
 *   expectedFinalPickCount: number,
 * }}
 *
 * The parser's DRAFT_UPDATE state shape:
 *   { draftId, picks: [{pack, pick, options, picked}], currentPack: {pack, pick, options} | null }
 */
function buildFullDraft({ draftId = 'synthetic-1', packSize = 14 } = {}) {
  // Card pool: pack P starts at grpId base = 1000 + (P-1) * 1000
  // Card IDs in pack P range over [base, base + packSize - 1]
  const events = [];
  const cumulativePicks = [];

  for (let pack = 1; pack <= 3; pack++) {
    const base = 1000 + (pack - 1) * 1000;
    let remaining = Array.from({ length: packSize }, (_, i) => base + i);

    for (let pick = 1; pick <= packSize; pick++) {
      // Draft.Notify event: currentPack updated, picks unchanged
      const optionsAtThisPick = [...remaining];
      events.push({
        type: 'DRAFT_UPDATE',
        data: {
          draftId,
          picks: [...cumulativePicks],
          currentPack: { pack, pick, options: optionsAtThisPick },
        },
      });

      // Player picks the FIRST card in the visible options.
      // This means at pick 1 they take base+0, at pick 9 (the wheel) they take base+8, etc.
      // For pack 1 pick 1: options = [base+0..base+13], picked = base+0
      //   → 7 cards taken between pick 1 and pick 9 (by 7 left-neighbors) → simulated below.
      const picked = remaining[0];
      remaining = remaining.slice(1);

      // Simulate 7 other-player picks between our picks (they each take one card).
      // We model this by removing 7 cards from `remaining` AFTER our pick — except
      // we want the wheel of pick 1 to show specific cards missing. To keep
      // assertions exact we use a deterministic rule: between OUR pick at pick N
      // and OUR pick at pick N+1, the 7 next cards (in current `remaining` order)
      // are taken by left-neighbors. NB: this only applies before the wheel; after
      // pick 8 the pack returns to us with remaining as-is.
      if (pick < packSize) {
        const removeCount = Math.min(PLAYER_COUNT - 1, remaining.length - (packSize - pick));
        // After PLAYER_COUNT picks total in this pack rotation, we'd see the pack again.
        // Simpler model: after each of our picks (except after the last in the pack),
        // assume PLAYER_COUNT - 1 = 7 other picks happen, each consuming one card from
        // the front of `remaining`. Stop when remaining is exhausted.
        const taken = Math.max(0, Math.min(PLAYER_COUNT - 1, remaining.length));
        remaining = remaining.slice(taken);
      }

      // EventPlayerDraftMakePick event: picks[] grows
      cumulativePicks.push({ pack, pick, options: optionsAtThisPick, picked });
      events.push({
        type: 'DRAFT_UPDATE',
        data: {
          draftId,
          picks: [...cumulativePicks],
          currentPack: null,
        },
      });
    }
  }

  // Pack 1 pick 1 options: [1000..1013]; picked = 1000.
  // Pack 1 pick 9 options: at the time we wheeled the pack, 8 cards have been taken
  //   total (us at pick 1, plus 7 left-neighbors). So 6 remain.
  // The 7 cards taken by left-neighbors are 1001..1007.
  // Expected removed at P1 pick 9 = [1001..1007].
  const expectedRemovedAtP1Pick9 = [1001, 1002, 1003, 1004, 1005, 1006, 1007];

  return {
    events,
    expectedRemovedAtP1Pick9,
    expectedFinalPickCount: 3 * packSize,
  };
}

module.exports = { buildFullDraft };
```

- [ ] **Step 3.2: Write the failing pipeline test file**

Create `tests/test_draftPipeline.js`:

```js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let MOCK_USERDATA;
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => MOCK_USERDATA) },
}));

const DataStore = require('../dataStore');
const { buildDraftUpdatePayload } = require('../draftPipeline');
const { buildFullDraft } = require('./fixtures/draft-synthetic');

// A pass-through draftAssistant double that doesn't change array order.
function fakeAssistant() {
  return {
    isLoaded: () => true,
    rankPack: cards => cards.map(c => ({ ...c, gihWr: 0.5, lowSample: false, tier: 'silver', stats: null, gihCount: 500 })),
    getCardStats: () => null,
    getCardTier: () => 'none',
    getStatus: () => ({ loaded: true, cardCount: 0, setName: 'mock', csvPath: null }),
  };
}

// resolveCards/resolveCard doubles: convert grpId → minimal card object.
const resolveCards = ids => ids.map(id => ({ arena_id: id, name: `Card ${id}`, manaCost: '', type: 'Unknown' }));
const resolveCard  = id => ({ arena_id: id, name: `Card ${id}`, manaCost: '', type: 'Unknown' });

describe('draftPipeline.buildDraftUpdatePayload', () => {
  let ds;
  let assistant;

  beforeEach(() => {
    MOCK_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-pipe-'));
    ds = new DataStore();
    assistant = fakeAssistant();
  });

  afterEach(() => {
    fs.rmSync(MOCK_USERDATA, { recursive: true, force: true });
  });

  test('full synthetic draft: 90 events produce a complete record', () => {
    const { events, expectedFinalPickCount } = buildFullDraft();
    for (const ev of events) {
      buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    }
    const stored = ds.getDraft('synthetic-1');
    expect(stored.picks).toHaveLength(expectedFinalPickCount);
    for (const p of stored.picks) {
      expect(p.picked).not.toBeNull();
    }
  });

  test('payload at pack 1 pick 9 includes removedCards = expected wheel diff', () => {
    const { events, expectedRemovedAtP1Pick9 } = buildFullDraft();
    let payloadAtP1P9 = null;
    for (const ev of events) {
      const payload = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (
        payload.currentPack &&
        payload.currentPack.pack === 1 &&
        payload.currentPack.pick === 9
      ) {
        payloadAtP1P9 = payload;
      }
    }
    expect(payloadAtP1P9).not.toBeNull();
    const removedIds = payloadAtP1P9.removedCards.map(c => c.arena_id).sort((a, b) => a - b);
    expect(removedIds).toEqual(expectedRemovedAtP1Pick9);
  });

  test('payload at pack 1 pick 1 has removedCards = []', () => {
    const { events } = buildFullDraft();
    let firstPayload = null;
    for (const ev of events) {
      const payload = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (firstPayload === null && payload.currentPack && payload.currentPack.pick === 1) {
        firstPayload = payload;
        break;
      }
    }
    expect(firstPayload.removedCards).toEqual([]);
  });

  test('replaying the entire event stream produces an identical final record (idempotent end-to-end)', () => {
    const { events } = buildFullDraft();
    // First pass
    for (const ev of events) buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    const snapshot1 = JSON.stringify(ds.getDraft('synthetic-1'));
    // Second pass (simulates parser re-scan of the same log)
    for (const ev of events) buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    const snapshot2 = JSON.stringify(ds.getDraft('synthetic-1'));
    expect(snapshot2).toBe(snapshot1);
  });

  test('missing pick injection: skip the event for pack 2 pick 4 → payload picks include missing: true placeholder', () => {
    const { events } = buildFullDraft();
    // Filter out both DRAFT_UPDATE events for (pack=2, pick=4) — both the Draft.Notify
    // and the EventPlayerDraftMakePick. To do this cleanly, we drop the event whose
    // currentPack is (2, 4), AND we strip pick (2, 4) from any subsequent picks[] array.
    const filtered = events
      .filter(ev => !(ev.data.currentPack && ev.data.currentPack.pack === 2 && ev.data.currentPack.pick === 4))
      .map(ev => ({
        ...ev,
        data: {
          ...ev.data,
          picks: ev.data.picks.filter(p => !(p.pack === 2 && p.pick === 4)),
        },
      }));

    let payloadAtP2P5 = null;
    for (const ev of filtered) {
      const payload = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (payload.currentPack && payload.currentPack.pack === 2 && payload.currentPack.pick === 5) {
        payloadAtP2P5 = payload;
      }
    }
    expect(payloadAtP2P5).not.toBeNull();
    // The picks array sent to the renderer should include a missing placeholder for (2, 4).
    const missingEntry = payloadAtP2P5.picks.find(p => p.pack === 2 && p.pick === 4);
    expect(missingEntry).toBeDefined();
    expect(missingEntry.missing).toBe(true);
  });

  test('payload picks are filtered to only completed picks (excludes picked: null pending views, includes missing placeholders)', () => {
    // Set up a draft with one completed pick at (1,1), one pending currentPack at (1,2).
    const ev = {
      type: 'DRAFT_UPDATE',
      data: {
        draftId: 'p1',
        picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
        currentPack: { pack: 1, pick: 2, options: [20, 21] },
      },
    };
    const payload = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    // Renderer payload picks should NOT include the (1,2) pending view as a pick.
    const pickPicks = payload.picks.map(p => `${p.pack}.${p.pick}`);
    expect(pickPicks).toContain('1.1');
    expect(pickPicks).not.toContain('1.2');
  });

  test('17Lands not loaded: currentPack and removedCards are returned unranked', () => {
    const unloadedAssistant = {
      isLoaded: () => false,
      rankPack: jest.fn(),  // should not be called
      getCardStats: () => null,
      getCardTier: () => 'none',
      getStatus: () => ({ loaded: false, cardCount: 0, setName: null, csvPath: null }),
    };
    // Build a draft with a wheel scenario so removedCards is non-empty.
    const fullPack = Array.from({length: 14}, (_, i) => 700 + i);
    const wheelView = fullPack.slice(8); // 6 cards remain at pick 9

    // Pick 1
    buildDraftUpdatePayload(
      { draftId: 'u1', picks: [{ pack: 1, pick: 1, options: fullPack, picked: 700 }], currentPack: null },
      ds, unloadedAssistant, resolveCards, resolveCard
    );
    // Now the wheel — currentPack at (1, 9)
    const wheelPayload = buildDraftUpdatePayload(
      { draftId: 'u1', picks: [{ pack: 1, pick: 1, options: fullPack, picked: 700 }], currentPack: { pack: 1, pick: 9, options: wheelView } },
      ds, unloadedAssistant, resolveCards, resolveCard
    );

    expect(unloadedAssistant.rankPack).not.toHaveBeenCalled();
    expect(wheelPayload.assistantLoaded).toBe(false);
    expect(wheelPayload.currentPack.options.every(c => c.gihWr === null && c.lowSample === true)).toBe(true);
    expect(wheelPayload.removedCards.length).toBeGreaterThan(0);
    expect(wheelPayload.removedCards.every(c => c.gihWr === null && c.lowSample === true)).toBe(true);
  });
});
```

- [ ] **Step 3.3: Run test, verify failure**

Run: `npx jest tests/test_draftPipeline.js`
Expected: FAIL with "Cannot find module '../draftPipeline'".

- [ ] **Step 3.4: Implement `draftPipeline.js`**

Create `draftPipeline.js`:

```js
'use strict';

/**
 * draftPipeline
 *
 * Composes the per-event DRAFT_UPDATE pipeline:
 *   1. dataStore.upsertDraft(state)
 *   2. dataStore.getDraft(draftId)            ← canonical state
 *   3. draftCorrelation.missingCardsForPick   ← grpIds taken since last view
 *   4. draftAssistant.rankPack on both lists
 *   5. fillMissingPickPlaceholders            ← gap-fill for renderer's My Picks
 *   6. assemble IPC payload
 *
 * Side effects: writes to dataStore, logs warnings on detected gaps.
 * Returns: the IPC payload to send to the renderer (does NOT call webContents.send).
 */

const { missingCardsForPick } = require('./draftCorrelation');

const DEFAULT_PACK_SIZE = 14;

// One-shot per-process dedup for "missing pick" warnings.
// Keyed by `${draftId}:${pack}:${pick}`.
const _warnedGaps = new Set();

/**
 * Detect missing (pack, pick) coordinates within the OBSERVED range and
 * return a new picks array with `{ missing: true }` placeholders inserted
 * for each gap. Does not mutate the input.
 *
 * Pack size is derived from (P, 1).options.length when (P, 1) is present;
 * otherwise we fall back to DEFAULT_PACK_SIZE.
 */
function fillMissingPickPlaceholders(record) {
  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return [];
  }

  // Group picks by pack and find the max pick observed in each pack.
  const picksByPack = new Map(); // pack → Map<pick, entry>
  let maxPack = 0;
  for (const p of record.picks) {
    if (!picksByPack.has(p.pack)) picksByPack.set(p.pack, new Map());
    picksByPack.get(p.pack).set(p.pick, p);
    if (p.pack > maxPack) maxPack = p.pack;
  }

  const out = [];
  for (let pack = 1; pack <= maxPack; pack++) {
    const pickMap = picksByPack.get(pack);
    if (!pickMap) continue; // unobserved pack — don't fabricate

    let maxPick = 0;
    for (const k of pickMap.keys()) if (k > maxPick) maxPick = k;

    // Pack size: prefer (P, 1).options.length; fall back to DEFAULT_PACK_SIZE.
    const firstPick = pickMap.get(1);
    const packSize = firstPick && Array.isArray(firstPick.options)
      ? firstPick.options.length
      : DEFAULT_PACK_SIZE;

    // Fill 1..maxPick (the OBSERVED range only — don't extrapolate forward).
    const upper = Math.min(maxPick, packSize);
    for (let pick = 1; pick <= upper; pick++) {
      const entry = pickMap.get(pick);
      if (entry) {
        out.push(entry);
      } else {
        const key = `${record.draftId}:${pack}:${pick}`;
        if (!_warnedGaps.has(key)) {
          _warnedGaps.add(key);
          console.warn(`[DraftStore] Missing pick (pack=${pack}, pick=${pick}) for draft ${record.draftId} — likely auto-pick during disconnect`);
        }
        out.push({ pack, pick, options: [], picked: null, missing: true });
      }
    }
  }
  return out;
}

/**
 * Build the IPC payload for a single DRAFT_UPDATE event.
 *
 * @param {object}   eventData     - Parser DRAFT_UPDATE state: {draftId, picks, currentPack}
 * @param {object}   dataStore     - DataStore instance (must have upsertDraft, getDraft)
 * @param {object}   draftAssistant- DraftAssistant instance (must have isLoaded, rankPack, getCardStats, getCardTier, getStatus)
 * @param {Function} resolveCards  - (grpId[]) => card[]   (grpId → resolved card objects)
 * @param {Function} resolveCard   - (grpId)   => card     (single)
 * @returns {object} The IPC payload suitable for webContents.send('draft-update', ...).
 */
function buildDraftUpdatePayload(eventData, dataStore, draftAssistant, resolveCards, resolveCard) {
  dataStore.upsertDraft(eventData);
  const persisted = dataStore.getDraft(eventData.draftId);
  const currentPack = eventData.currentPack || null;

  // Compute removed cards for the live pack view.
  const removedGrpIds = currentPack
    ? missingCardsForPick(persisted, currentPack.pack, currentPack.pick)
    : [];

  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();

  // Resolve + rank the live pack options.
  const resolvedOptions = currentPack ? resolveCards(currentPack.options) : [];
  const rankedOptions = assistantLoaded
    ? draftAssistant.rankPack(resolvedOptions)
    : resolvedOptions.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));

  // Resolve + rank the removed cards (same rank-and-enrich treatment).
  const resolvedRemoved = resolveCards(removedGrpIds);
  const rankedRemoved = assistantLoaded
    ? draftAssistant.rankPack(resolvedRemoved)
    : resolvedRemoved.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));

  // Build the renderer-facing picks list:
  //   - start from gap-filled persisted picks
  //   - drop entries with picked: null and !missing (those are pending pack views, not yet a pick)
  //   - for missing: true entries, leave picked card resolution to renderer (it will show a placeholder row)
  //   - for completed picks, resolve and enrich the picked card the same way main.js used to.
  const filledPicks = fillMissingPickPlaceholders(persisted);
  const rendererPicks = filledPicks
    .filter(p => p.missing === true || p.picked !== null)
    .map(p => {
      if (p.missing) return { pack: p.pack, pick: p.pick, missing: true };
      const picked = resolveCard(p.picked);
      if (assistantLoaded && picked.name) {
        const s = draftAssistant.getCardStats(picked.name);
        picked.gihWr     = s?.gihWr ?? null;
        picked.lowSample = s ? s.lowSample : true;
        picked.tier      = draftAssistant.getCardTier(picked.gihWr, picked.name, picked.lowSample);
      }
      return {
        pack: p.pack,
        pick: p.pick,
        picked,
        options: resolveCards(p.options),
      };
    });

  return {
    draftId: eventData.draftId,
    currentPack: currentPack
      ? { ...currentPack, options: rankedOptions }
      : null,
    removedCards: rankedRemoved,
    picks: rendererPicks,
    assistantLoaded,
    assistantStatus: draftAssistant.getStatus ? draftAssistant.getStatus() : null,
  };
}

// Exposed for unit tests; not part of the public API.
function _resetWarnedGaps() {
  _warnedGaps.clear();
}

module.exports = {
  buildDraftUpdatePayload,
  fillMissingPickPlaceholders,
  _resetWarnedGaps,
};
```

- [ ] **Step 3.5: Run test, verify pass**

Run: `npx jest tests/test_draftPipeline.js`
Expected: PASS, all tests green.

- [ ] **Step 3.6: Run full suite, verify everything still passes**

Run: `npx jest`
Expected: PASS — all test files green.

- [ ] **Step 3.7: Commit**

```bash
git add draftPipeline.js tests/test_draftPipeline.js tests/fixtures/draft-synthetic.js
git commit -m "$(cat <<'EOF'
add draftPipeline module composing the DRAFT_UPDATE pipeline

Persist → read back → correlate → resolve+rank → gap-fill into a single
payload builder. Gap-fill detects missing (pack, pick) coordinates within
the observed range and emits {missing: true} placeholders for the renderer.
Pseudo-integration test drives a full synthetic 45-pick draft.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `main.js` DRAFT_UPDATE handler to `draftPipeline`

**Files:**
- Modify: `main.js` (DRAFT_UPDATE case in `handleGameEvent`, currently `main.js:436-466`)

The handler shrinks dramatically — its old responsibilities (resolve, rank, build IPC payload) move into `draftPipeline.buildDraftUpdatePayload`. We keep `lastDraftEventData` for the existing CSV-reload re-enrichment path.

- [ ] **Step 4.1: Add the require for `draftPipeline` near the top of `main.js`**

Find the existing requires near the top of `main.js` (around `main.js:1-10`). The file currently has:
```js
const DraftAssistant = require('./draftAssistant');
```

Just below that line, add:
```js
const draftPipeline = require('./draftPipeline');
```

- [ ] **Step 4.2: Replace the DRAFT_UPDATE case in `handleGameEvent`**

Locate `case 'DRAFT_UPDATE':` in `main.js` (around line 436). Replace the entire case block (everything from `case 'DRAFT_UPDATE':` up to but not including the next `case` or the closing `}` of the switch) with:

```js
    case 'DRAFT_UPDATE':
      if (mainWindow) {
        lastDraftEventData = event.data; // persist for re-enrichment when CSV is loaded later
        const payload = draftPipeline.buildDraftUpdatePayload(
          event.data,
          dataStore,
          draftAssistant,
          resolveCards,
          resolveCard
        );
        mainWindow.webContents.send('draft-update', payload);
      }
      break;
```

For reference, the OLD block looked like:
```js
    case 'DRAFT_UPDATE':
      if (mainWindow) {
        lastDraftEventData = event.data;
        const packData = event.data.currentPack;
        const resolvedOptions = packData ? resolveCards(packData.options) : [];
        const rankedOptions = draftAssistant.isLoaded()
          ? draftAssistant.rankPack(resolvedOptions)
          : resolvedOptions.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));
        mainWindow.webContents.send('draft-update', {
          draftId: event.data.draftId,
          currentPack: packData
            ? { ...packData, options: rankedOptions }
            : null,
          picks: event.data.picks.map(p => { /* ... */ }),
          assistantLoaded: draftAssistant.isLoaded(),
          assistantStatus: draftAssistant.getStatus(),
        });
      }
      break;
```

The new block delegates all of that to `draftPipeline`.

- [ ] **Step 4.3: Run the existing main.js smoke test to ensure the require + wiring didn't break anything**

Run: `npx jest tests/test_main.js`
Expected: PASS — module loads without throwing, IPC handlers still register. The mocked dataStore in test_main.js doesn't have `upsertDraft`/`getDraft`, but that's fine because the test never fires DRAFT_UPDATE events.

- [ ] **Step 4.4: Run full suite, verify everything still passes**

Run: `npx jest`
Expected: PASS across all test files.

- [ ] **Step 4.5: Commit**

```bash
git add main.js
git commit -m "$(cat <<'EOF'
delegate DRAFT_UPDATE handling to draftPipeline

main.js's case shrinks to a single delegation. All resolve/rank/persist/
correlate logic now lives in draftPipeline where it's testable without
spinning up Electron.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Renderer — "Removed since pick N" section + missing-pick placeholder rows

**Files:**
- Modify: `index.html` (DOM container + CSS for the removed section and `.removed` row state)
- Modify: `renderer.js` (read `removedCards` and `missing` from payload, render UI)

UI affordance: greyed list with the same row template as the live pack list, sorted by GIH WR descending, hidden when empty. My Picks panel filters non-`missing` `picked: null` entries (already done by pipeline) and renders `missing: true` rows as a muted placeholder.

- [ ] **Step 5.1: Add a DOM container for the removed section to `index.html`**

Find the draft pack panel block in `index.html` (around line 1481-1494). The current markup is:
```html
<div class="draft-pack-panel">
    <div class="draft-pack-header">
        <h3>Current Pack</h3>
        <div class="draft-pack-info">
            <span id="draft-pack-num">Pack 1</span>
            <span id="draft-pick-num">Pick 1</span>
            <span id="draft-cards-left">0 cards</span>
        </div>
    </div>
    <div class="draft-card-list" id="draft-card-list"></div>
</div>
```

Replace with:
```html
<div class="draft-pack-panel">
    <div class="draft-pack-header">
        <h3>Current Pack</h3>
        <div class="draft-pack-info">
            <span id="draft-pack-num">Pack 1</span>
            <span id="draft-pick-num">Pick 1</span>
            <span id="draft-cards-left">0 cards</span>
        </div>
    </div>
    <div class="draft-card-list" id="draft-card-list"></div>

    <!-- Wheel correlation: cards taken from this pack since the player last saw it -->
    <div class="draft-removed-section" id="draft-removed-section" style="display:none;">
        <div class="draft-removed-header" id="draft-removed-header">Removed since pick 1</div>
        <div class="draft-card-list draft-card-list-removed" id="draft-removed-list"></div>
    </div>
</div>
```

- [ ] **Step 5.2: Add CSS for the removed section**

Find the existing `.draft-card-row.tier-brown` rule in `index.html` (around line 980). Insert the following CSS *after* the tier rules (before the `.draft-rank` block):

```css
/* Removed-since-last-view section (wheel correlation) */
.draft-removed-section {
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
.draft-removed-header {
    padding: 0 13px 6px 13px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
}
.draft-card-row.removed {
    opacity: 0.45;
    border-left-color: transparent !important;
    animation: none !important;
    background: transparent !important;
}
.draft-card-row.removed .draft-card-name span {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.35);
}

/* Missing-pick placeholder row in My Picks */
.draft-pick-item.missing {
    opacity: 0.55;
    font-style: italic;
}
.draft-pick-item.missing .pick-name {
    color: var(--text-muted);
}
```

- [ ] **Step 5.3: Update `renderer.js` to render the removed section**

Open `renderer.js`. Locate `function renderDraftPage()` (around line 708). Just after the `renderPickHistory(currentDraftState.picks || []);` line inside that function, add a call to a new render function:

Find:
```js
    renderCurrentPack(currentDraftState.currentPack);
    renderPickHistory(currentDraftState.picks || []);
}
```

Replace with:
```js
    renderCurrentPack(currentDraftState.currentPack);
    renderRemovedSection(currentDraftState.removedCards || []);
    renderPickHistory(currentDraftState.picks || []);
}
```

- [ ] **Step 5.4: Add `renderRemovedSection` to `renderer.js`**

Find `function renderPickHistory(picks) {` (around line 774). Insert the following function **immediately above** it:

```js
/**
 * Render the "Removed since pick N" greyed-out card list under the live pack.
 * Sorted by GIH WR descending (already done by main.js via rankPack).
 * Hidden when empty.
 */
function renderRemovedSection(removedCards) {
    const sectionEl = document.getElementById('draft-removed-section');
    const listEl    = document.getElementById('draft-removed-list');
    const headerEl  = document.getElementById('draft-removed-header');

    if (!removedCards || removedCards.length === 0) {
        sectionEl.style.display = 'none';
        return;
    }

    sectionEl.style.display = 'block';

    // Header text references the prior view: pick N - 8.
    const currentPick = currentDraftState?.currentPack?.pick;
    const priorPick = (typeof currentPick === 'number' && currentPick > 8)
        ? currentPick - 8
        : 1;
    headerEl.textContent = `Removed since pick ${priorPick}`;

    listEl.innerHTML = removedCards.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;
        const lowSample = card.lowSample;
        const stats = card.stats;
        const wrText = gihWr !== null && gihWr !== undefined ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');
        const colorStr = stats?.color || '';
        const rarityStr = stats?.rarity || '';

        return `
            <div class="draft-card-row removed ${tierClass}">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${rarityGem(rarityStr)}
                    ${lowSample && gihWr !== null && gihWr !== undefined ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div style="font-size:11px;font-weight:600;color:${rarityColor(rarityStr)};text-align:right;">${rarityStr || ''}</div>
            </div>`;
    }).join('');
}
```

- [ ] **Step 5.5: Update `renderPickHistory` to handle `missing: true` placeholders**

Find `function renderPickHistory(picks) {` and the `[...picks].reverse().map((pick, idx) => {` block inside it (around line 784). Replace the inner `.map` callback so it branches on `pick.missing`:

Find this block:
```js
    listEl.innerHTML = [...picks].reverse().map((pick, idx) => {
        const overallPick = picks.length - idx;
        const card = pick.picked;
        const name = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr = card?.gihWr ?? null;
        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');

        return `
            <div class="draft-pick-item">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-name" title="${name}">${name}</div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
```

Replace with:
```js
    listEl.innerHTML = [...picks].reverse().map((pick, idx) => {
        if (pick.missing) {
            return `
                <div class="draft-pick-item missing">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-name" title="Missing from log (likely auto-pick)">⚠ pick missing from log (likely auto-pick)</div>
                    <div class="pick-wr">—</div>
                </div>`;
        }
        const card = pick.picked;
        const name = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr = card?.gihWr ?? null;
        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');

        return `
            <div class="draft-pick-item">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-name" title="${name}">${name}</div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
```

- [ ] **Step 5.6: Verify renderer tests still pass**

Run: `npx jest tests/test_renderer.js`
Expected: PASS — these are existing tests; we haven't changed the contract.

If they fail because `renderRemovedSection` references DOM elements that don't exist in the test fixture, look at how `test_renderer.js` sets up its DOM and add the new element ids to the fixture. (If `test_renderer.js` doesn't exercise `renderDraftPage` at all, no fixture changes are needed.)

- [ ] **Step 5.7: Run full suite**

Run: `npx jest`
Expected: PASS — all tests green.

- [ ] **Step 5.8: Commit**

```bash
git add index.html renderer.js
git commit -m "$(cat <<'EOF'
render Removed-since-pick-N section and missing-pick placeholders

Greyed-out list beneath the live pack showing cards taken from this
physical pack since the player last saw it (pick - 8). My Picks panel
shows muted placeholder rows for picks missing from the log (likely
disconnect auto-picks).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manual validation (the $5 draft)

This is the only step not automated. Run before merging the feature branch.

**Files:** none (this is a checklist).

- [ ] **Step 6.1: Pre-flight verification**

Run: `npx jest`
Expected: All tests green across all files.

Run: `ls "$APPDATA/mtg-arena-auto-tracker/data/drafts.json" 2>/dev/null || echo "no drafts.json yet"`

(On Windows, `$APPDATA` resolves to `%APPDATA%`. The exact userData path comes from `app.getPath('userData')`.)
Expected: "no drafts.json yet" — clean slate for the test.

- [ ] **Step 6.2: Launch the app, open the draft page**

Run: `npm start`
- Confirm the app loads.
- Navigate to the Draft page.
- Confirm "No draft in progress" placeholder is visible.

- [ ] **Step 6.3: Tail the Player.log in a side terminal (for offline replay)**

This captures the log so the same draft can be replayed in tests forever, even if Arena rolls it later.

Run: `tail -f "%USERPROFILE%\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log" > /tmp/draft-capture-$(date +%Y%m%d-%H%M%S).log &`

(Adapt path syntax to your shell; on WSL use the corresponding `/mnt/c/...` path.)

- [ ] **Step 6.4: Open and play the draft**

Open MTGA, enter a Premier Draft (or Traditional Draft) lobby. Play through the entire draft.

**Live observations during the draft:**
- At pack 1 pick 1: live pack renders normally (14 ranked cards). No "Removed" section yet.
- At pack 1 pick 9: confirm a "Removed since pick 1" greyed section appears beneath the live pack list, showing ~7 cards sorted by GIH WR.
- At pack 2 pick 9: same — "Removed since pick 1" with ~7 cards from pack 2.
- At pack 1 pick 14 (last pick of the pack): "Removed since pick 6" should show ~7 cards.
- My Picks panel grows by one row per pick, no missing placeholders (assuming no disconnects).

- [ ] **Step 6.5: Post-draft verification**

After the 45th pick:
- Open the userData drafts.json and confirm a single record with 45 picks, all with `picked` set.
  - On Windows: `%APPDATA%\mtg-arena-auto-tracker\data\drafts.json`
- Restart the app (kill and `npm start` again). Navigate back to the Draft page.
- Confirm My Picks panel still shows all 45 picks.

- [ ] **Step 6.6: Save the captured log as a permanent fixture**

Move the tailed log to `tests/fixtures/`:
```bash
mv /tmp/draft-capture-*.log /mnt/c/Users/Kyle/src/MTG-Arena-Tracker/tests/fixtures/real-draft-$(date +%Y%m%d).log
```

- [ ] **Step 6.7: Resolve the auto-pick TODO**

Grep the captured log for auto-pick artifacts:
```bash
grep -iE "autopick|auto[_-]pick|automatedpick" tests/fixtures/real-draft-*.log
```

- If matches found: file a follow-up issue/PR to extend the parser. The placeholder rendering keeps the feature usable in the meantime.
- If no matches: the user disconnected zero times during the draft, so we have no data point. Leave the TODO open for the next captured log.

- [ ] **Step 6.8: Commit the fixture**

```bash
git add tests/fixtures/real-draft-*.log
git commit -m "$(cat <<'EOF'
add real-draft log fixture for offline regression testing

Captured during initial draft replays validation. Future test runs
can replay this log against logParserV5 to reproduce the synthetic
event stream.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** Each spec section maps to a task — correlation primitive (Task 1), persistence (Task 2), pipeline + gap-fill (Task 3), main.js wiring (Task 4), renderer (Task 5), manual validation (Task 6). The "no parser changes" decision from Section 1 is honored: the parser file is untouched.
- **Type consistency:** `DraftRecord` shape (`{draftId, startedAt, picks: [{pack, pick, options, picked}]}`) is identical between Tasks 1, 2, and 3. The IPC payload shape (`{draftId, currentPack, removedCards, picks, assistantLoaded, assistantStatus}`) is identical between Task 3 (the test asserts on it) and Task 5 (the renderer reads it).
- **No placeholders:** every step has concrete code, exact paths, and verifiable commands.
- **Parser untouched:** `logParserV5.js` does not appear in any task's "Modify" list, consistent with the spec.
