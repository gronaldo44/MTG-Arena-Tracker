# Draft Replay Stepper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player step backward and forward through any persisted draft, one pick at a time, using the keyboard arrow keys; switch between drafts via a dropdown above the pack panel; auto-snap to live whenever a `DRAFT_UPDATE` event arrives.

**Architecture:** The renderer consumes a single `ViewerBundle` whose `picks[]` is the authoritative source for "what to render at coord (pack, pick)." Both the live `'draft-update'` event and a new `view-draft-record` IPC return the same `ViewerBundle` shape. The renderer never branches on live vs. past — it just renders `picks[viewingCoord]`. Live mode is the special case where `viewingCoord === bundle.liveCoord`.

**Tech Stack:** Node.js + Electron + Jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-01-draft-replay-stepper-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `draftPipeline.js` (modify) | Owns the per-pick enrichment helper (`enrichPick`) and both bundle builders (`buildViewerBundle` for past records, `buildDraftUpdatePayload` thin wrapper for the live path). Sole producer of the `ViewerBundle` shape. |
| `dataStore.js` (modify) | Add `getDraftSummaries()` returning `[{draftId, startedAt, pickCount}]` sorted by `startedAt` desc. |
| `main.js` (modify) | Add two `ipcMain.handle` callbacks: `'list-drafts'` and `'view-draft-record'`. Existing `DRAFT_UPDATE` case still routes through `buildDraftUpdatePayload`, but its emitted payload is now the new bundle shape. |
| `renderer.js` (modify) | Replace `currentDraftState` with `bundle` + `viewingCoord` + `draftList` state. Add dropdown wiring, arrow-key handler, snap-to-live logic, pure helpers `prevCoord` / `nextCoord` (exported for tests), and `.viewing` / `.future` styling on My Picks. Refactor `renderDraftPage` to read from `bundle.picks[viewingCoord]`. |
| `index.html` (modify) | Add the draft dropdown markup above `.draft-layout`; add CSS for `.draft-pick-item.viewing`, `.draft-pick-item.future`, and the dropdown chrome. |
| `tests/test_draftPipeline.js` (modify) | Update existing tests for the new `ViewerBundle` shape. Add tests for `buildViewerBundle` on past records (full draft, empty, missing-pick coord, no-CSV-loaded). |
| `tests/test_dataStore.js` (modify) | Add tests for `getDraftSummaries`. |
| `tests/test_main.js` (modify) | Add tests for `'list-drafts'` and `'view-draft-record'` handlers. Extend the mocked `dataStore` so it supports the new methods. |
| `tests/test_renderer.js` (modify) | Add tests for `prevCoord` / `nextCoord` pure helpers. |

---

## Task 1: Pipeline refactor — bundle-shaped live payload

Refactor `buildDraftUpdatePayload` to return the new `ViewerBundle` shape. Extract a per-pick enrichment helper. The past-record `buildViewerBundle` export comes in Task 2; this task limits the change to the live path so the test suite has a small, reviewable diff.

**Files:**
- Modify: `draftPipeline.js`
- Test: `tests/test_draftPipeline.js`

---

- [ ] **Step 1.1: Update existing tests to assert on the new bundle shape**

Open `tests/test_draftPipeline.js` and replace the `describe('draftPipeline.buildDraftUpdatePayload', ...)` block's tests (keeping the `beforeEach`/`afterEach` and helpers) with the version below. Existing tests that asserted on `payload.currentPack`, `payload.removedCards`, or filtered-out pending picks need to be rewritten because:

- `currentPack` is removed; the live coord is in `bundle.liveCoord`.
- `removedCards` is now per-pick, inside `picks[i].removedCards`.
- The pending pack-view is now INCLUDED in `picks[]` as a `{picked: null, !missing}` entry — the renderer is responsible for filtering it out of the My Picks list.
- Picks now carry `picked: number | null` (raw grpId) plus optional `pickedCard: ResolvedCard`. Old shape stored the resolved card directly under `picked`.

```javascript
describe('draftPipeline.buildDraftUpdatePayload', () => {
  let ds;
  let assistant;

  beforeEach(() => {
    _resetWarnedGaps();
    MOCK_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-pipe-'));
    ds = new DataStore();
    assistant = fakeAssistant();
  });

  afterEach(() => {
    fs.rmSync(MOCK_USERDATA, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('full synthetic draft: every (pack, pick) ends with a non-null picked in storage', () => {
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

  test('bundle at pack 1 pick 9: picks[(1,9)].removedCards = expected wheel diff; liveCoord points there', () => {
    const { events, expectedRemovedAtP1Pick9 } = buildFullDraft();
    let bundleAtP1P9 = null;
    for (const ev of events) {
      const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (bundle.liveCoord && bundle.liveCoord.pack === 1 && bundle.liveCoord.pick === 9) {
        bundleAtP1P9 = bundle;
      }
    }
    expect(bundleAtP1P9).not.toBeNull();
    const p19 = bundleAtP1P9.picks.find(p => p.pack === 1 && p.pick === 9);
    expect(p19).toBeDefined();
    const removedIds = p19.removedCards.map(c => c.arena_id).sort((a, b) => a - b);
    expect(removedIds).toEqual(expectedRemovedAtP1Pick9);
  });

  test('bundle at pack 1 pick 1: picks[(1,1)].removedCards = []', () => {
    const { events } = buildFullDraft();
    let firstBundle = null;
    for (const ev of events) {
      const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (firstBundle === null && bundle.liveCoord && bundle.liveCoord.pick === 1) {
        firstBundle = bundle;
        break;
      }
    }
    const p11 = firstBundle.picks.find(p => p.pack === 1 && p.pick === 1);
    expect(p11.removedCards).toEqual([]);
  });

  test('replaying the entire event stream produces an identical final record (idempotent end-to-end)', () => {
    const { events } = buildFullDraft();
    for (const ev of events) buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    const snapshot1 = JSON.stringify(ds.getDraft('synthetic-1'));
    for (const ev of events) buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    const snapshot2 = JSON.stringify(ds.getDraft('synthetic-1'));
    expect(snapshot2).toBe(snapshot1);
  });

  test('missing pick injection: picks[] includes a missing: true placeholder for the dropped coord', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { events } = buildFullDraft();
    const filtered = events
      .filter(ev => !(ev.data.currentPack && ev.data.currentPack.pack === 2 && ev.data.currentPack.pick === 4))
      .map(ev => ({
        ...ev,
        data: {
          ...ev.data,
          picks: ev.data.picks.filter(p => !(p.pack === 2 && p.pick === 4)),
        },
      }));

    let bundleAtP2P5 = null;
    for (const ev of filtered) {
      const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
      if (bundle.liveCoord && bundle.liveCoord.pack === 2 && bundle.liveCoord.pick === 5) {
        bundleAtP2P5 = bundle;
      }
    }
    expect(bundleAtP2P5).not.toBeNull();
    const missingEntry = bundleAtP2P5.picks.find(p => p.pack === 2 && p.pick === 4);
    expect(missingEntry).toBeDefined();
    expect(missingEntry.missing).toBe(true);
    expect(missingEntry.options).toEqual([]);
    expect(missingEntry.removedCards).toEqual([]);
  });

  test('bundle picks INCLUDE the pending pack-view as a {picked: null, !missing} entry', () => {
    const ev = {
      type: 'DRAFT_UPDATE',
      data: {
        draftId: 'p1',
        picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
        currentPack: { pack: 1, pick: 2, options: [20, 21] },
      },
    };
    const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    expect(bundle.liveCoord).toEqual({ pack: 1, pick: 2 });
    const pending = bundle.picks.find(p => p.pack === 1 && p.pick === 2);
    expect(pending).toBeDefined();
    expect(pending.picked).toBeNull();
    expect(pending.missing).toBeUndefined();
    expect(pending.pickedCard).toBeUndefined();
    expect(pending.options).toHaveLength(2);
    const completed = bundle.picks.find(p => p.pack === 1 && p.pick === 1);
    expect(completed.picked).toBe(10);
    expect(completed.pickedCard).toEqual(expect.objectContaining({ arena_id: 10, name: 'Card 10' }));
  });

  test('completed picks carry picked (raw grpId) AND pickedCard (resolved object)', () => {
    const ev = {
      type: 'DRAFT_UPDATE',
      data: {
        draftId: 'p2',
        picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 11 }],
        currentPack: null,
      },
    };
    const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    const p11 = bundle.picks.find(p => p.pack === 1 && p.pick === 1);
    expect(p11.picked).toBe(11);
    expect(p11.pickedCard).toEqual(expect.objectContaining({ arena_id: 11, name: 'Card 11' }));
  });

  test('bundle.picks is sorted by (pack, pick)', () => {
    const { events } = buildFullDraft();
    let lastBundle = null;
    for (const ev of events) {
      lastBundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    }
    for (let i = 1; i < lastBundle.picks.length; i++) {
      const a = lastBundle.picks[i - 1];
      const b = lastBundle.picks[i];
      const aRank = a.pack * 100 + a.pick;
      const bRank = b.pack * 100 + b.pick;
      expect(bRank).toBeGreaterThan(aRank);
    }
  });

  test('17Lands not loaded: every pick has options/removedCards with gihWr: null, lowSample: true', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unloadedAssistant = {
      isLoaded: () => false,
      rankPack: jest.fn(),
      getCardStats: () => null,
      getCardTier: () => 'none',
      getStatus: () => ({ loaded: false, cardCount: 0, setName: null, csvPath: null }),
    };
    const fullPack = Array.from({length: 14}, (_, i) => 700 + i);
    const wheelView = fullPack.slice(8);

    buildDraftUpdatePayload(
      { draftId: 'u1', picks: [{ pack: 1, pick: 1, options: fullPack, picked: 700 }], currentPack: null },
      ds, unloadedAssistant, resolveCards, resolveCard
    );
    const bundle = buildDraftUpdatePayload(
      { draftId: 'u1', picks: [{ pack: 1, pick: 1, options: fullPack, picked: 700 }], currentPack: { pack: 1, pick: 9, options: wheelView } },
      ds, unloadedAssistant, resolveCards, resolveCard
    );

    expect(unloadedAssistant.rankPack).not.toHaveBeenCalled();
    expect(bundle.assistantLoaded).toBe(false);
    const live = bundle.picks.find(p => p.pack === 1 && p.pick === 9);
    expect(live.options.every(c => c.gihWr === null && c.lowSample === true)).toBe(true);
    expect(live.removedCards.length).toBeGreaterThan(0);
    expect(live.removedCards.every(c => c.gihWr === null && c.lowSample === true)).toBe(true);
  });

  test('bundle exposes assistantLoaded and assistantStatus', () => {
    const ev = {
      type: 'DRAFT_UPDATE',
      data: {
        draftId: 'p3',
        picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
        currentPack: null,
      },
    };
    const bundle = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    expect(bundle.assistantLoaded).toBe(true);
    expect(bundle.assistantStatus).toEqual(expect.objectContaining({ loaded: true, setName: 'mock' }));
    expect(bundle.draftId).toBe('p3');
    expect(typeof bundle.startedAt).toBe('number');
  });
});
```

- [ ] **Step 1.2: Run the updated tests; verify they fail**

Run: `npx jest tests/test_draftPipeline.js`

Expected: most tests FAIL because the current `buildDraftUpdatePayload` returns the old `{currentPack, removedCards, picks: [completed only]}` shape. Failures should reference `bundle.liveCoord`, `bundle.picks` not containing the pending entry, missing `pickedCard`, etc.

- [ ] **Step 1.3: Refactor draftPipeline.js to produce the new bundle shape**

Replace the contents of `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/draftPipeline.js` with:

```javascript
'use strict';

/**
 * draftPipeline
 *
 * Composes per-pick enrichment + the ViewerBundle shape.
 *
 * Two entry points produce the SAME bundle shape:
 *   - buildDraftUpdatePayload(eventData, dataStore, ...) — live path; upserts
 *     the event into the store first.
 *   - buildViewerBundle(record, ...)                     — past-draft path;
 *     consumes a stored DraftRecord directly.
 *
 * The bundle is the renderer's single source of truth: every (pack, pick)
 * coordinate the user can step to is a fully enriched entry in `picks[]`,
 * and `liveCoord` points to the most recent observed coordinate.
 */

const { missingCardsForPick } = require('./draftCorrelation');

const DEFAULT_PACK_SIZE = 14;

const _warnedGaps = new Set();

function fillMissingPickPlaceholders(record) {
  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return [];
  }

  const picksByPack = new Map();
  let maxPack = 0;
  for (const p of record.picks) {
    if (!picksByPack.has(p.pack)) picksByPack.set(p.pack, new Map());
    picksByPack.get(p.pack).set(p.pick, p);
    if (p.pack > maxPack) maxPack = p.pack;
  }

  const out = [];
  for (let pack = 1; pack <= maxPack; pack++) {
    const pickMap = picksByPack.get(pack);
    if (!pickMap) continue;

    let maxPick = 0;
    for (const k of pickMap.keys()) if (k > maxPick) maxPick = k;

    const firstPick = pickMap.get(1);
    const packSize = firstPick && Array.isArray(firstPick.options)
      ? firstPick.options.length
      : DEFAULT_PACK_SIZE;

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

function _rankOrFallback(resolved, draftAssistant, assistantLoaded) {
  return assistantLoaded
    ? draftAssistant.rankPack(resolved)
    : resolved.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));
}

/**
 * Build the enriched per-pick entry for the bundle. Pure aside from the
 * draftAssistant calls (which are pure if the assistant has loaded data).
 */
function enrichPick(rawPick, record, draftAssistant, resolveCards, resolveCard) {
  if (rawPick.missing) {
    return {
      pack: rawPick.pack,
      pick: rawPick.pick,
      missing: true,
      picked: null,
      options: [],
      removedCards: [],
    };
  }

  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();

  const resolvedOptions = resolveCards(rawPick.options);
  const rankedOptions = _rankOrFallback(resolvedOptions, draftAssistant, assistantLoaded);

  const removedGrpIds = missingCardsForPick(record, rawPick.pack, rawPick.pick);
  const resolvedRemoved = resolveCards(removedGrpIds);
  const rankedRemoved = _rankOrFallback(resolvedRemoved, draftAssistant, assistantLoaded);

  const out = {
    pack: rawPick.pack,
    pick: rawPick.pick,
    picked: rawPick.picked ?? null,
    options: rankedOptions,
    removedCards: rankedRemoved,
  };

  if (rawPick.picked != null) {
    const picked = resolveCard(rawPick.picked);
    if (assistantLoaded && picked.name) {
      const s = draftAssistant.getCardStats(picked.name);
      picked.gihWr     = s?.gihWr ?? null;
      picked.lowSample = s ? s.lowSample : true;
      picked.tier      = draftAssistant.getCardTier(picked.gihWr, picked.name, picked.lowSample);
    }
    out.pickedCard = picked;
  }

  return out;
}

/**
 * Build a ViewerBundle from a stored DraftRecord. Returns the same shape the
 * live 'draft-update' event emits, so the renderer never branches on source.
 */
function buildViewerBundle(record, draftAssistant, resolveCards, resolveCard) {
  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();
  const assistantStatus = draftAssistant.getStatus ? draftAssistant.getStatus() : null;

  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return {
      draftId:   record?.draftId   ?? null,
      startedAt: record?.startedAt ?? null,
      liveCoord: null,
      picks:     [],
      assistantLoaded,
      assistantStatus,
    };
  }

  const filled = fillMissingPickPlaceholders(record);
  const sorted = filled.slice().sort((a, b) =>
    a.pack !== b.pack ? a.pack - b.pack : a.pick - b.pick
  );

  const enrichedPicks = sorted.map(p =>
    enrichPick(p, record, draftAssistant, resolveCards, resolveCard)
  );

  const last = sorted[sorted.length - 1];

  return {
    draftId:   record.draftId,
    startedAt: record.startedAt,
    liveCoord: { pack: last.pack, pick: last.pick },
    picks:     enrichedPicks,
    assistantLoaded,
    assistantStatus,
  };
}

/**
 * Live path: upsert the event into the store, then build the bundle.
 */
function buildDraftUpdatePayload(eventData, dataStore, draftAssistant, resolveCards, resolveCard) {
  dataStore.upsertDraft(eventData);
  const persisted = dataStore.getDraft(eventData.draftId);
  return buildViewerBundle(persisted, draftAssistant, resolveCards, resolveCard);
}

function _resetWarnedGaps() {
  _warnedGaps.clear();
}

module.exports = {
  buildDraftUpdatePayload,
  buildViewerBundle,
  enrichPick,
  fillMissingPickPlaceholders,
  _resetWarnedGaps,
};
```

- [ ] **Step 1.4: Re-run tests; confirm they pass**

Run: `npx jest tests/test_draftPipeline.js`

Expected: PASS for all tests in the `describe('draftPipeline.buildDraftUpdatePayload', ...)` block.

- [ ] **Step 1.5: Run the full suite to surface any cross-file regressions**

Run: `npx jest`

Expected: PASS for `test_dataStore.js`, `test_draftCorrelation.js`, `test_draftAssistant.js`, `test_logParserV5.js`, `test_renderer.js`. `test_main.js` may still pass because it doesn't yet exercise the new IPC handlers; it should not regress.

- [ ] **Step 1.6: Commit**

```bash
git add draftPipeline.js tests/test_draftPipeline.js
git commit -m "$(cat <<'EOF'
refactor draftPipeline to ViewerBundle shape

picks[] now carries enriched per-pick options + removedCards + pickedCard;
liveCoord replaces top-level currentPack. Renderer adapts in a follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `buildViewerBundle` direct tests for past records

`buildViewerBundle` is already implemented in Task 1 (it's the building block under `buildDraftUpdatePayload`). This task adds tests that exercise it directly against persisted records — the path the new `view-draft-record` IPC handler will use.

**Files:**
- Test: `tests/test_draftPipeline.js`

---

- [ ] **Step 2.1: Add direct `buildViewerBundle` tests**

Append the following `describe` block to the bottom of `tests/test_draftPipeline.js`. Also extend the import on line 13 to include `buildViewerBundle`:

```javascript
const { buildDraftUpdatePayload, buildViewerBundle, _resetWarnedGaps } = require('../draftPipeline');
```

Add after the existing `describe('draftPipeline.buildDraftUpdatePayload', ...)` block:

```javascript
describe('draftPipeline.buildViewerBundle', () => {
  let ds;
  let assistant;

  beforeEach(() => {
    _resetWarnedGaps();
    MOCK_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-bundle-'));
    ds = new DataStore();
    assistant = fakeAssistant();
  });

  afterEach(() => {
    fs.rmSync(MOCK_USERDATA, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('null record → empty bundle with liveCoord: null', () => {
    const bundle = buildViewerBundle(null, assistant, resolveCards, resolveCard);
    expect(bundle).toEqual(expect.objectContaining({
      draftId: null,
      startedAt: null,
      liveCoord: null,
      picks: [],
    }));
    expect(bundle.assistantLoaded).toBe(true);
  });

  test('empty-picks record → empty bundle with liveCoord: null', () => {
    const record = { draftId: 'd1', startedAt: 1700000000000, picks: [] };
    const bundle = buildViewerBundle(record, assistant, resolveCards, resolveCard);
    expect(bundle.draftId).toBe('d1');
    expect(bundle.startedAt).toBe(1700000000000);
    expect(bundle.liveCoord).toBeNull();
    expect(bundle.picks).toEqual([]);
  });

  test('full synthetic record: picks > 8 in each pack carry non-empty removedCards', () => {
    const { events } = buildFullDraft();
    for (const ev of events) {
      buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    }
    const record = ds.getDraft('synthetic-1');
    const bundle = buildViewerBundle(record, assistant, resolveCards, resolveCard);

    expect(bundle.liveCoord).toEqual({ pack: 3, pick: 14 });
    for (const pick of bundle.picks) {
      expect(pick.options.length).toBeGreaterThan(0);
      if (pick.pick > 8) {
        expect(pick.removedCards.length).toBeGreaterThan(0);
      } else {
        expect(pick.removedCards).toEqual([]);
      }
    }
  });

  test('record with a missing-pick gap: bundle includes the missing placeholder', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const record = {
      draftId: 'g1',
      startedAt: 1700000000000,
      picks: [
        { pack: 1, pick: 1, options: [10, 11, 12], picked: 10 },
        { pack: 1, pick: 3, options: [12], picked: 12 },
      ],
    };
    const bundle = buildViewerBundle(record, assistant, resolveCards, resolveCard);
    const missing = bundle.picks.find(p => p.pack === 1 && p.pick === 2);
    expect(missing).toBeDefined();
    expect(missing.missing).toBe(true);
    expect(missing.options).toEqual([]);
    expect(missing.removedCards).toEqual([]);
    expect(bundle.liveCoord).toEqual({ pack: 1, pick: 3 });
  });

  test('17Lands not loaded: every options/removedCards entry has gihWr: null', () => {
    const unloadedAssistant = {
      isLoaded: () => false,
      rankPack: jest.fn(),
      getCardStats: () => null,
      getCardTier: () => 'none',
      getStatus: () => ({ loaded: false, cardCount: 0, setName: null, csvPath: null }),
    };
    const { events } = buildFullDraft();
    for (const ev of events) {
      buildDraftUpdatePayload(ev.data, ds, unloadedAssistant, resolveCards, resolveCard);
    }
    unloadedAssistant.rankPack.mockClear();
    const record = ds.getDraft('synthetic-1');
    const bundle = buildViewerBundle(record, unloadedAssistant, resolveCards, resolveCard);

    expect(unloadedAssistant.rankPack).not.toHaveBeenCalled();
    for (const pick of bundle.picks) {
      for (const c of pick.options)      expect(c.gihWr).toBeNull();
      for (const c of pick.removedCards) expect(c.gihWr).toBeNull();
    }
    expect(bundle.assistantLoaded).toBe(false);
  });

  test('bundle is identical to live-path output after replaying the event stream', () => {
    const { events } = buildFullDraft();
    let livePath = null;
    for (const ev of events) {
      livePath = buildDraftUpdatePayload(ev.data, ds, assistant, resolveCards, resolveCard);
    }
    const record = ds.getDraft('synthetic-1');
    const pastPath = buildViewerBundle(record, assistant, resolveCards, resolveCard);

    expect(JSON.stringify(pastPath)).toBe(JSON.stringify(livePath));
  });
});
```

- [ ] **Step 2.2: Run the new tests; confirm they pass**

Run: `npx jest tests/test_draftPipeline.js -t "buildViewerBundle"`

Expected: all PASS. (`buildViewerBundle` was already implemented in Task 1; these tests validate the past-record path directly.)

- [ ] **Step 2.3: Commit**

```bash
git add tests/test_draftPipeline.js
git commit -m "$(cat <<'EOF'
add direct tests for draftPipeline.buildViewerBundle

Exercises the past-draft path the view-draft-record IPC will use; verifies
parity with the live path on the synthetic fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `dataStore.getDraftSummaries`

**Files:**
- Modify: `dataStore.js`
- Test: `tests/test_dataStore.js`

---

- [ ] **Step 3.1: Write the failing tests**

Append to the bottom of the `describe('DataStore — drafts', () => { ... })` block in `tests/test_dataStore.js` (just before the closing `});` of that describe):

```javascript
  // ── getDraftSummaries ──────────────────────────────────────────────────

  test('getDraftSummaries: empty store → []', () => {
    expect(ds.getDraftSummaries()).toEqual([]);
  });

  test('getDraftSummaries returns {draftId, startedAt, pickCount} per record', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [
        { pack: 1, pick: 1, options: [10, 11], picked: 10 },
        { pack: 1, pick: 2, options: [11], picked: 11 },
      ],
      currentPack: null,
    });
    const all = ds.getDraftSummaries();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(expect.objectContaining({
      draftId: 'd1',
      pickCount: 2,
    }));
    expect(typeof all[0].startedAt).toBe('number');
  });

  test('getDraftSummaries: pickCount is the raw record.picks.length (includes pending picked: null entries)', () => {
    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10, 11], picked: 10 }],
      currentPack: { pack: 1, pick: 2, options: [20, 21] },
    });
    // Stored: 2 entries — the completed pick AND the pending pack-view.
    expect(ds.getDraftSummaries()[0].pickCount).toBe(2);
  });

  test('getDraftSummaries: sorted by startedAt descending', () => {
    // Insert d1 first, then d2 — d2 has a later startedAt.
    ds.upsertDraft({ draftId: 'd1', picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }], currentPack: null });
    // Force a small delay so startedAt differs.
    const r1 = ds.getDraft('d1');
    r1.startedAt = 1000;
    ds.upsertDraft({ draftId: 'd2', picks: [{ pack: 1, pick: 1, options: [20], picked: 20 }], currentPack: null });
    const r2 = ds.getDraft('d2');
    r2.startedAt = 2000;

    const all = ds.getDraftSummaries();
    expect(all.map(d => d.draftId)).toEqual(['d2', 'd1']);
  });
```

- [ ] **Step 3.2: Run the failing tests**

Run: `npx jest tests/test_dataStore.js -t "getDraftSummaries"`

Expected: FAIL — `ds.getDraftSummaries is not a function`.

- [ ] **Step 3.3: Implement `getDraftSummaries`**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/dataStore.js`. Add the method below immediately after the existing `getAllDrafts()` method (around line 740):

```javascript
  /**
   * Return [{draftId, startedAt, pickCount}] for every persisted draft,
   * sorted by startedAt descending. pickCount is the raw count of stored
   * picks entries — includes any pending `picked: null` pack-view entry,
   * but NOT gap-fill placeholders (those are computed in the pipeline,
   * not persisted).
   */
  getDraftSummaries() {
    return Object.values(this.drafts)
      .map(r => ({
        draftId:   r.draftId,
        startedAt: r.startedAt,
        pickCount: Array.isArray(r.picks) ? r.picks.length : 0,
      }))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
```

- [ ] **Step 3.4: Re-run tests; confirm they pass**

Run: `npx jest tests/test_dataStore.js`

Expected: all PASS.

- [ ] **Step 3.5: Commit**

```bash
git add dataStore.js tests/test_dataStore.js
git commit -m "$(cat <<'EOF'
add DataStore.getDraftSummaries for the draft dropdown

Returns {draftId, startedAt, pickCount} per record sorted newest-first.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: IPC handlers — `list-drafts` and `view-draft-record`

**Files:**
- Modify: `main.js`
- Test: `tests/test_main.js`

---

- [ ] **Step 4.1: Extend the mocked dataStore in test_main.js**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/tests/test_main.js`. The `jest.mock('../dataStore', ...)` factory at lines 103–131 needs three new methods so the new IPC handlers can do real work in isolation. Add the highlighted lines below to the existing mock object literal (insert immediately before the closing `}))`):

```javascript
jest.mock('../dataStore', () =>
  jest.fn(() => ({
    getMatches:    jest.fn(() => []),
    saveMatch:     jest.fn(),
    deleteMatch:   jest.fn(),
    getStats:      jest.fn(() => ({ total: 0, wins: 0, losses: 0, draws: 0, winRate: 0, formats: {}, decks: {} })),
    getSettings:   jest.fn(() => ({})),
    saveSettings:  jest.fn(),
    getDeck:       jest.fn(() => null),
    exportData:    jest.fn(() => '/mock/export.json'),
    importData:    jest.fn(() => true),
    clearData:     jest.fn(),
    reloadCards:   jest.fn(),
    getInventory:  jest.fn(() => null),
    getCardName:   jest.fn((cardId) => {
      const names = { '12345': 'Lightning Bolt', '67890': 'Forest' };
      return names[String(cardId)] || `Unknown (${cardId})`;
    }),
    getMatchFormat:         jest.fn(() => null),
    updateCardGameStats:    jest.fn(() => false),
    getAllCardGameStats:     jest.fn(() => ({})),
    getCardStatFormats:     jest.fn(() => []),
    clearCardStats:         jest.fn(),
    deleteMatchesByFormat:  jest.fn(),
    updateMatchColors:      jest.fn(),
    getMainDraftSets:       jest.fn(() => MOCK_DRAFT_SETS),
    getCardsBySet:          jest.fn((code) => MOCK_SET_CARDS[code] || []),
    getDraftSummaries:      jest.fn(() => MOCK_DRAFT_SUMMARIES),
    getDraft:               jest.fn((draftId) => MOCK_DRAFTS[draftId] ?? null),
    upsertDraft:            jest.fn(),
  }))
);
```

Then add the new fixture constants near the top of the file alongside `MOCK_DRAFT_SETS` and `MOCK_SET_CARDS` (around line 92):

```javascript
const MOCK_DRAFT_SUMMARIES = [
  { draftId: 'draft-newer', startedAt: 2000, pickCount: 3 },
  { draftId: 'draft-older', startedAt: 1000, pickCount: 1 },
];

const MOCK_DRAFTS = {
  'draft-newer': {
    draftId: 'draft-newer',
    startedAt: 2000,
    picks: [
      { pack: 1, pick: 1, options: [10, 11, 12], picked: 10 },
      { pack: 1, pick: 2, options: [11, 12],     picked: 11 },
      { pack: 1, pick: 3, options: [12],         picked: 12 },
    ],
  },
  'draft-older': {
    draftId: 'draft-older',
    startedAt: 1000,
    picks: [
      { pack: 1, pick: 1, options: [20, 21], picked: 20 },
    ],
  },
};
```

- [ ] **Step 4.2: Add tests for the two new handlers**

Append to the bottom of the `describe('main.js', ...)` block in `tests/test_main.js` (just before the closing `});`):

```javascript
  // ── list-drafts ─────────────────────────────────────────────────────────

  describe('list-drafts handler', () => {
    test('returns the draft summaries from dataStore', async () => {
      const handler = registeredHandlers['list-drafts'];
      expect(handler).toBeDefined();
      const list = await handler(null);
      expect(list).toEqual([
        { draftId: 'draft-newer', startedAt: 2000, pickCount: 3 },
        { draftId: 'draft-older', startedAt: 1000, pickCount: 1 },
      ]);
    });
  });

  // ── view-draft-record ───────────────────────────────────────────────────

  describe('view-draft-record handler', () => {
    test('unknown draftId → null', async () => {
      const handler = registeredHandlers['view-draft-record'];
      expect(handler).toBeDefined();
      const bundle = await handler(null, 'no-such-draft');
      expect(bundle).toBeNull();
    });

    test('known draftId → ViewerBundle with matching liveCoord', async () => {
      const handler = registeredHandlers['view-draft-record'];
      const bundle = await handler(null, 'draft-newer');
      expect(bundle).not.toBeNull();
      expect(bundle.draftId).toBe('draft-newer');
      expect(bundle.startedAt).toBe(2000);
      expect(bundle.liveCoord).toEqual({ pack: 1, pick: 3 });
      expect(bundle.picks).toHaveLength(3);
      expect(bundle.assistantLoaded).toBe(false);
    });

    test('returned bundle picks include picked + pickedCard for completed picks', async () => {
      const handler = registeredHandlers['view-draft-record'];
      const bundle = await handler(null, 'draft-newer');
      const p11 = bundle.picks.find(p => p.pack === 1 && p.pick === 1);
      expect(p11.picked).toBe(10);
      expect(p11.pickedCard).toEqual(expect.objectContaining({ arena_id: 10 }));
    });
  });
```

- [ ] **Step 4.3: Run the failing tests**

Run: `npx jest tests/test_main.js -t "list-drafts|view-draft-record"`

Expected: FAIL — `handler` is undefined for both channels.

- [ ] **Step 4.4: Wire the two handlers in main.js**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/main.js`. Add the two handlers immediately after the existing `ipcMain.handle('get-main-draft-sets', ...)` block (around line 607):

```javascript
// Draft replay viewer: dropdown metadata and on-demand bundle for past records.
ipcMain.handle('list-drafts', async () => {
  if (!dataStore) return [];
  return dataStore.getDraftSummaries();
});

ipcMain.handle('view-draft-record', async (event, draftId) => {
  if (!dataStore || !draftId) return null;
  const record = dataStore.getDraft(draftId);
  if (!record) return null;
  return draftPipeline.buildViewerBundle(
    record,
    draftAssistant,
    resolveCards,
    resolveCard,
  );
});
```

- [ ] **Step 4.5: Re-run tests; confirm they pass**

Run: `npx jest tests/test_main.js`

Expected: all PASS.

- [ ] **Step 4.6: Run the full suite**

Run: `npx jest`

Expected: all suites PASS.

- [ ] **Step 4.7: Commit**

```bash
git add main.js tests/test_main.js
git commit -m "$(cat <<'EOF'
add list-drafts and view-draft-record IPC handlers

Powers the draft dropdown and on-demand past-record loading in the
upcoming stepper UI.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Renderer pure helpers — `prevCoord` / `nextCoord`

These are tiny pure functions that walk the sorted `picks[]` array. They're separated into their own task because they're the only renderer logic with unit-test coverage; the rest of the renderer changes ride on manual validation.

**Files:**
- Modify: `renderer.js`
- Test: `tests/test_renderer.js`

---

- [ ] **Step 5.1: Write the failing tests**

Append to the bottom of `tests/test_renderer.js`:

```javascript
// ─── prevCoord / nextCoord ────────────────────────────────────────────────────

const { prevCoord, nextCoord } = require('../renderer');

describe('prevCoord / nextCoord', () => {
  // Picks array as the bundle delivers it: sorted by (pack, pick), no gaps in
  // a complete draft, but may include missing-pick placeholders.
  const picks = [
    { pack: 1, pick: 1 },
    { pack: 1, pick: 2 },
    { pack: 1, pick: 13 },
    { pack: 1, pick: 14 },
    { pack: 2, pick: 1 },
    { pack: 2, pick: 2 },
  ];

  test('prevCoord at the absolute start returns the same coord (silent no-op signal)', () => {
    expect(prevCoord(picks, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
  });

  test('prevCoord walks one step backward within a pack', () => {
    expect(prevCoord(picks, { pack: 1, pick: 2 })).toEqual({ pack: 1, pick: 1 });
  });

  test('prevCoord crosses a pack boundary (P2p1 → P1p14)', () => {
    expect(prevCoord(picks, { pack: 2, pick: 1 })).toEqual({ pack: 1, pick: 14 });
  });

  test('nextCoord at the last entry returns the same coord (silent no-op signal)', () => {
    expect(nextCoord(picks, { pack: 2, pick: 2 })).toEqual({ pack: 2, pick: 2 });
  });

  test('nextCoord walks one step forward within a pack', () => {
    expect(nextCoord(picks, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 2 });
  });

  test('nextCoord crosses a pack boundary (P1p14 → P2p1)', () => {
    expect(nextCoord(picks, { pack: 1, pick: 14 })).toEqual({ pack: 2, pick: 1 });
  });

  test('prev/next traverse missing-pick placeholders, not skip them', () => {
    const withMissing = [
      { pack: 1, pick: 1 },
      { pack: 1, pick: 2, missing: true },
      { pack: 1, pick: 3 },
    ];
    expect(nextCoord(withMissing, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 2 });
    expect(prevCoord(withMissing, { pack: 1, pick: 3 })).toEqual({ pack: 1, pick: 2 });
  });

  test('coord not present in picks → return the same coord (defensive no-op)', () => {
    expect(prevCoord(picks, { pack: 5, pick: 7 })).toEqual({ pack: 5, pick: 7 });
    expect(nextCoord(picks, { pack: 5, pick: 7 })).toEqual({ pack: 5, pick: 7 });
  });

  test('empty picks array → return the same coord (defensive no-op)', () => {
    expect(prevCoord([], { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
    expect(nextCoord([], { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
  });
});
```

- [ ] **Step 5.2: Run the failing tests**

Run: `npx jest tests/test_renderer.js -t "prevCoord|nextCoord"`

Expected: FAIL — `prevCoord is not a function`.

- [ ] **Step 5.3: Implement and export the helpers**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/renderer.js`. Add the two functions immediately above the `// ─── Draft — rendering ────────...` section header (around line 706):

```javascript
// ─── Draft — coord stepping ───────────────────────────────────────────────────
//
// Pure helpers that walk a sorted picks[] array (as delivered by the bundle).
// They return the same coord when there's nowhere to go (start, end, or coord
// not in the array) so the caller can render a silent no-op without branching.

function prevCoord(picks, coord) {
  if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
  const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
  if (idx <= 0) return coord;
  const prev = picks[idx - 1];
  return { pack: prev.pack, pick: prev.pick };
}

function nextCoord(picks, coord) {
  if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
  const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
  if (idx === -1 || idx >= picks.length - 1) return coord;
  const next = picks[idx + 1];
  return { pack: next.pack, pick: next.pick };
}

```

Then update the Node.js exports block at the bottom of `renderer.js` (around line 1228) to include the new helpers:

```javascript
if (typeof window === 'undefined') {
    module.exports = {
        gihWrTierClass, colorPip, rarityGem, rarityLabel, rarityColor,
        extractScryfallImageUrl, cardEyeballHtml, _cardImageCache,
        prevCoord, nextCoord,
    };
}
```

- [ ] **Step 5.4: Re-run tests; confirm they pass**

Run: `npx jest tests/test_renderer.js`

Expected: all PASS.

- [ ] **Step 5.5: Commit**

```bash
git add renderer.js tests/test_renderer.js
git commit -m "$(cat <<'EOF'
add prevCoord / nextCoord pure helpers for draft stepping

Walks the sorted bundle picks[] one step in either direction, returning
the same coord at array boundaries so callers can no-op silently.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Renderer — adopt bundle shape + dropdown wiring

This task swaps `currentDraftState` for `bundle` + `viewingCoord` + `draftList`, refactors `renderDraftPage` to read from `bundle.picks[viewingCoord]`, and adds the dropdown HTML/CSS plus boot-time `list-drafts` population. Arrow-key stepping and `.viewing` / `.future` styling come in Task 7.

After this task, the user can:
- See the most recent past draft auto-loaded on app boot when no live draft is active.
- Switch between drafts via the dropdown.
- Watch the view snap to live when a `DRAFT_UPDATE` arrives.

**Files:**
- Modify: `renderer.js`
- Modify: `index.html`

---

- [ ] **Step 6.1: Add the dropdown markup**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/index.html`. Inside the existing `<div id="draft-active" style="display:none;">` block (line 1515), insert the dropdown immediately before `<div class="draft-layout">`:

```html
                <div id="draft-active" style="display:none;">
                    <div class="draft-selector">
                        <label for="draft-select">Viewing:</label>
                        <select id="draft-select" onchange="onDraftSelectChange(this.value)"></select>
                    </div>
                    <div class="draft-layout">
```

- [ ] **Step 6.2: Add CSS for the dropdown**

In `index.html`, find the `.draft-layout {` rule (around line 897) and insert the new `.draft-selector` rules immediately above it:

```css
        .draft-selector {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 14px;
            font-size: 13px;
            color: var(--text-muted);
        }

        .draft-selector select {
            background: var(--card);
            color: var(--text);
            border: 1px solid var(--border);
            border-radius: 6px;
            padding: 5px 9px;
            font-size: 13px;
            cursor: pointer;
        }

        .draft-selector select:disabled {
            opacity: 0.55;
            cursor: not-allowed;
        }

        .draft-layout {
```

- [ ] **Step 6.3: Replace the renderer's draft state and rendering**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/renderer.js`. Replace lines 9–13 (the `// ─── State ───` block) with:

```javascript
// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let bundle = null;              // ViewerBundle currently loaded; null until first draft seen
let draftList = [];             // [{draftId, startedAt, pickCount}] for the dropdown
let viewingCoord = null;        // {pack, pick} the user is currently viewing
let csvLoaded = false;          // whether 17Lands CSV is loaded in main process
let _currentPackOptions = [];   // cached options for detail drawer lookups
```

Replace the existing `renderDraftPage` (lines 706–724) and `renderCurrentPack` (lines 727–770) and `renderRemovedSection` (lines 776–821) and `renderPickHistory` (lines 825–858) with the version below.

This block also adds the new helpers `getViewingPick`, `ensureValidViewingCoord`, `renderMissingPickPanel`, `renderDraftDropdown`, and `onDraftSelectChange`. Place it where the old draft-rendering block lived (replacing it):

```javascript
// ─── Draft — rendering ────────────────────────────────────────────────────────

function getViewingPick() {
    if (!bundle || !viewingCoord) return null;
    return bundle.picks.find(p =>
        p.pack === viewingCoord.pack && p.pick === viewingCoord.pick
    ) || null;
}

function ensureValidViewingCoord() {
    if (!bundle || !Array.isArray(bundle.picks) || bundle.picks.length === 0) {
        viewingCoord = null;
        return;
    }
    const exists = bundle.picks.some(p =>
        p.pack === viewingCoord?.pack && p.pick === viewingCoord?.pick
    );
    if (!exists) viewingCoord = bundle.liveCoord;
}

function renderDraftPage() {
    const activeEl  = document.getElementById('draft-active');
    const waitingEl = document.getElementById('draft-waiting');

    if (!bundle || !Array.isArray(bundle.picks) || bundle.picks.length === 0) {
        activeEl.style.display = 'none';
        waitingEl.style.display = 'block';
        return;
    }

    activeEl.style.display = 'block';
    waitingEl.style.display = 'none';

    ensureValidViewingCoord();
    renderDraftDropdown();

    const viewingPick = getViewingPick();
    if (!viewingPick) return;

    if (viewingPick.missing) {
        renderMissingPickPanel(viewingPick);
    } else {
        renderCurrentPack(viewingPick);
    }
    renderRemovedSection(viewingPick.removedCards || [], viewingPick.pick);
    renderPickHistory(bundle.picks, viewingCoord);
}

/**
 * Render the dropdown showing all known drafts. The selection follows the
 * currently loaded bundle's draftId. Disabled when there are no drafts.
 */
function renderDraftDropdown() {
    const sel = document.getElementById('draft-select');
    if (!sel) return;
    if (!Array.isArray(draftList) || draftList.length === 0) {
        sel.innerHTML = '<option value="" disabled selected>No past drafts yet</option>';
        sel.disabled = true;
        return;
    }
    sel.disabled = false;
    sel.innerHTML = draftList.map(d => {
        const date = new Date(d.startedAt).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        return `<option value="${d.draftId}">${date} (${d.pickCount} picks)</option>`;
    }).join('');
    if (bundle?.draftId) sel.value = bundle.draftId;
}

async function onDraftSelectChange(draftId) {
    if (!draftId) return;
    const newBundle = await ipcRenderer.invoke('view-draft-record', draftId);
    if (!newBundle) {
        console.warn('[Draft] view-draft-record returned null for', draftId);
        return;
    }
    bundle = newBundle;
    viewingCoord = bundle.liveCoord;
    renderDraftPage();
}

/**
 * Render the placeholder shown in the pack panel when the viewing coord is
 * a missing-pick gap. Mirrors the My Picks missing-row styling so the user
 * knows they're not looking at empty data.
 */
function renderMissingPickPanel(pick) {
    document.getElementById('draft-pack-num').textContent  = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent  = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = '—';

    const listEl = document.getElementById('draft-card-list');
    listEl.innerHTML = `
        <div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-style:italic;">
            ⚠️ Pick missing from log (likely auto-pick during disconnect)
        </div>`;
}

/**
 * Render the current pack's ranked card list. `pick` is a bundle pick entry
 * (carries pack, pick, options[]). Each option may have .gihWr, .lowSample, .stats.
 */
function renderCurrentPack(pick) {
    document.getElementById('draft-pack-num').textContent   = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent   = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = `${pick.options.length} cards`;

    const listEl = document.getElementById('draft-card-list');
    if (!pick.options || pick.options.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No cards in pack</div>';
        return;
    }

    _currentPackOptions = pick.options;

    listEl.innerHTML = pick.options.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;
        const lowSample = card.lowSample;
        const stats = card.stats;

        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');

        const colorStr = stats?.color || '';
        const rarityStr = stats?.rarity || '';

        return `
            <div class="draft-card-row ${tierClass}" data-idx="${idx}" onclick="toggleCardDetail(${idx})">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${rarityGem(rarityStr)}
                    ${lowSample && gihWr !== null ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div style="font-size:11px;font-weight:600;color:${rarityColor(rarityStr)};text-align:right;">${rarityStr || ''}</div>
            </div>`;
    }).join('');
}

/**
 * Render the "Removed since pick N" greyed-out card list under the pack panel.
 * `currentPick` is the viewing coord's pick number.
 * Hidden when removedCards is empty.
 */
function renderRemovedSection(removedCards, currentPick) {
    const sectionEl = document.getElementById('draft-removed-section');
    const listEl    = document.getElementById('draft-removed-list');
    const headerEl  = document.getElementById('draft-removed-header');

    if (!removedCards || removedCards.length === 0) {
        sectionEl.style.display = 'none';
        return;
    }

    sectionEl.style.display = 'block';

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

/**
 * Render the picks history sidebar (My Picks). The viewingCoord parameter is
 * accepted but currently unused — Task 7 wires .viewing / .future state on
 * top of this skeleton.
 */
function renderPickHistory(picks, _viewingCoord) {
    // Filter out the pending pack-view (picked: null && !missing) — it's the
    // current live coord, not a completed pick.
    const completed = picks.filter(p => p.missing === true || p.picked !== null);
    document.getElementById('picks-count').textContent = completed.length;
    const listEl = document.getElementById('draft-picks-list');

    if (completed.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No picks yet</div>';
        return;
    }

    listEl.innerHTML = [...completed].reverse().map((pick) => {
        if (pick.missing) {
            return `
                <div class="draft-pick-item missing">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-name" title="Missing from log (likely auto-pick)">⚠️ pick missing from log (likely auto-pick)</div>
                    <div class="pick-wr">—</div>
                </div>`;
        }
        const card = pick.pickedCard;
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
}
```

- [ ] **Step 6.4: Update the `'draft-update'` IPC listener**

In `renderer.js`, replace the existing `ipcRenderer.on('draft-update', ...)` handler (around line 1033) with:

```javascript
ipcRenderer.on('draft-update', (event, data) => {
    console.log('[Draft] Update received:', data);
    bundle = data;
    viewingCoord = bundle.liveCoord;

    // Refresh the dropdown — if this is a new draft, refetch the list so it
    // appears as an option; otherwise just re-sync the selection.
    if (!draftList.some(d => d.draftId === bundle?.draftId)) {
        ipcRenderer.invoke('list-drafts').then(list => {
            draftList = list;
            renderDraftDropdown();
        });
    } else {
        renderDraftDropdown();
    }

    // Flash the Draft nav item if user is on a different page
    const navDraft = document.getElementById('nav-draft');
    if (navDraft && currentPage !== 'draft') {
        let badge = navDraft.querySelector('.draft-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'draft-badge';
            navDraft.appendChild(badge);
        }
        const liveEntry = bundle?.picks?.find(p =>
            p.pack === bundle.liveCoord?.pack && p.pick === bundle.liveCoord?.pick
        );
        const count = liveEntry?.options?.length ?? 0;
        badge.textContent = `${count}`;
    }

    if (currentPage === 'draft') renderDraftPage();
});
```

- [ ] **Step 6.5: Add boot-time draft initialization**

Replace the `DOMContentLoaded` listener at the bottom of `renderer.js` (around line 1221) with:

```javascript
document.addEventListener('DOMContentLoaded', async () => {
    await updateCsvStatusUI();
    loadDashboard();
    initDraftView();
});

/**
 * Populate the draft dropdown and, if no live draft has arrived yet,
 * auto-load the most recent past draft. The 'draft-update' handler may
 * race ahead and replace the bundle; that's the desired behavior — live
 * always wins.
 */
async function initDraftView() {
    try {
        draftList = await ipcRenderer.invoke('list-drafts');
    } catch (e) {
        console.warn('[Draft] list-drafts failed:', e);
        draftList = [];
    }
    renderDraftDropdown();
    if (!bundle && draftList.length > 0) {
        await onDraftSelectChange(draftList[0].draftId);
    } else if (bundle && currentPage === 'draft') {
        renderDraftPage();
    }
}
```

- [ ] **Step 6.6: Run the test suite to confirm no regressions**

Run: `npx jest`

Expected: all PASS. The test suite doesn't exercise the renderer's DOM code, so the bundle-shape changes here won't break anything tested. (Manual verification comes in Step 6.7.)

- [ ] **Step 6.7: Manual sanity check — boot loads most-recent draft**

```bash
npm start
```

In the running app:
1. Navigate to the Draft page.
2. **Expected:** the dropdown is populated with at least one entry (the existing $5-draft record). The most recent draft is auto-loaded; My Picks shows its picks. The pack panel shows the live coord (last entry) — pack/pick numbers from the dropdown's pickCount.
3. Open dev tools and confirm no console errors.
4. If a second draft is available in `drafts.json`, switch to it via the dropdown and confirm the panel re-renders.

If the dropdown is empty: confirm `%APPDATA%\mtg-arena-auto-tracker\data\drafts.json` exists and contains at least one record.

Close the app when satisfied.

- [ ] **Step 6.8: Commit**

```bash
git add renderer.js index.html
git commit -m "$(cat <<'EOF'
adopt ViewerBundle in renderer; wire draft dropdown

renderDraftPage now reads from bundle.picks[viewingCoord]. Dropdown above
the pack panel lists past drafts and auto-loads the most recent one when
no live draft is active. Arrow stepping comes next.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Renderer — arrow-key stepping + viewing/future visual states

This task adds the keyboard arrow stepping plus the My Picks `.viewing` / `.future` styling.

**Files:**
- Modify: `renderer.js`
- Modify: `index.html`

---

- [ ] **Step 7.1: Add CSS for `.viewing` and `.future`**

Open `/mnt/c/Users/Kyle/src/MTG-Arena-Tracker/index.html`. Find the existing `.draft-pick-item.missing { ... }` rules (around line 1008) and insert the new state rules immediately after them:

```css
        /* Pick-history visual states for the stepper (Q2C hybrid) */
        .draft-pick-item.viewing {
            background: rgba(93, 95, 239, 0.18);
            border-left: 3px solid var(--accent, #5d5fef);
            padding-left: 11px;
        }

        .draft-pick-item.future {
            opacity: 0.42;
        }

        .draft-pick-item.viewing.future {
            /* Defensive: the renderer never tags an item with both classes,
               but if it ever does, .viewing wins visually. */
            opacity: 1;
        }

```

If `--accent` is not yet defined in the CSS variables block (search for `--accent`), the rule still works because the rgba fallback in `background` provides the color. (The existing CSS already uses `rgba(93, 95, 239, ...)` for the pack header — the colors match.)

- [ ] **Step 7.2: Wire the visual states in `renderPickHistory`**

In `renderer.js`, replace the body of the `renderPickHistory` function (added in Task 6) so it actually consumes `viewingCoord`:

```javascript
function renderPickHistory(picks, viewingCoord) {
    const completed = picks.filter(p => p.missing === true || p.picked !== null);
    document.getElementById('picks-count').textContent = completed.length;
    const listEl = document.getElementById('draft-picks-list');

    if (completed.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No picks yet</div>';
        return;
    }

    listEl.innerHTML = [...completed].reverse().map((pick) => {
        const isViewing = !!viewingCoord
            && pick.pack === viewingCoord.pack
            && pick.pick === viewingCoord.pick;
        const isFuture = !isViewing && !!viewingCoord && (
            pick.pack > viewingCoord.pack ||
            (pick.pack === viewingCoord.pack && pick.pick > viewingCoord.pick)
        );
        const stateClass = isViewing ? 'viewing' : isFuture ? 'future' : '';

        if (pick.missing) {
            return `
                <div class="draft-pick-item missing ${stateClass}">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-name" title="Missing from log (likely auto-pick)">⚠️ pick missing from log (likely auto-pick)</div>
                    <div class="pick-wr">—</div>
                </div>`;
        }
        const card = pick.pickedCard;
        const name = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr = card?.gihWr ?? null;
        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');

        return `
            <div class="draft-pick-item ${stateClass}">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-name" title="${name}">${name}</div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
}
```

- [ ] **Step 7.3: Add the global arrow-key handler**

In `renderer.js`, add the keydown listener at the bottom of the file, just before the `if (typeof window === 'undefined')` exports block:

```javascript
// ─── Draft — keyboard stepping ────────────────────────────────────────────────
//
// Single delegated keydown handler bound at module load. Only fires when the
// draft page is the active page and no input/textarea/select has focus, so
// dropdown keyboard navigation still works. Silent no-op at boundaries.

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (currentPage !== 'draft') return;
        if (!bundle || !viewingCoord) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;

        const target = e.key === 'ArrowLeft'
            ? prevCoord(bundle.picks, viewingCoord)
            : nextCoord(bundle.picks, viewingCoord);

        if (target.pack === viewingCoord.pack && target.pick === viewingCoord.pick) {
            return; // boundary — silent no-op
        }
        viewingCoord = target;
        renderDraftPage();
    });
}

```

- [ ] **Step 7.4: Run the test suite to confirm no regressions**

Run: `npx jest`

Expected: all PASS. (`prevCoord` / `nextCoord` are already test-covered; the arrow handler is manually validated below.)

- [ ] **Step 7.5: Manual validation — arrow-key stepping**

```bash
npm start
```

With the most recent past draft auto-loaded:
1. **ArrowLeft from liveCoord:** the My Picks list updates — the previous pick is now highlighted (`.viewing`), the most recent pick is muted (`.future`). The pack panel rebuilds to show that earlier pick's options + (if pick > 8) the wheel-removed section.
2. **ArrowLeft repeatedly back to P1p1:** at P1p1 the keypress is a silent no-op. The pack panel shows P1p1 options.
3. **ArrowRight from P1p1 back to liveCoord:** stepping forward; at liveCoord, ArrowRight is a silent no-op.
4. **Cross-pack boundary:** at P1p14, ArrowRight should jump to P2p1.
5. **Focus inside the dropdown:** click the dropdown to give it focus, press Arrow keys — the dropdown's keyboard navigation works (arrow keys cycle options); the pack panel does NOT step. Click outside, then arrows step the pack panel again.
6. **Switch pages:** navigate to Stats. Press arrow keys — the pack panel does not change (handler gated to `currentPage === 'draft'`).

If any expectation fails, debug before committing.

- [ ] **Step 7.6: Commit**

```bash
git add renderer.js index.html
git commit -m "$(cat <<'EOF'
arrow-key stepping through draft picks

ArrowLeft/Right walk bundle.picks; .viewing highlights the active pick and
.future mutes picks made later. Gated to the draft page and ignores key
events targeting form controls so dropdown nav still works.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Manual end-to-end validation

This task is verification-only — no code changes, no commit at the end.

**Files:** None.

---

- [ ] **Step 8.1: Verify stepping on the persisted $5 draft**

```bash
npm start
```

1. Navigate to Draft. Confirm dropdown shows the $5 draft. The view loads at liveCoord (its final pick).
2. Press ArrowLeft until reaching P1p9. Confirm the **Removed since pick 1** section appears with the expected wheel content. Confirm `.viewing` is on the (1,9) pick row in My Picks; later picks are muted.
3. Press ArrowLeft until reaching P1p1. Confirm the section is hidden (no removed cards for picks ≤ 8). Confirm boundary no-op (further ArrowLeft does nothing).
4. Press ArrowRight back to liveCoord. Confirm right-side boundary no-op.

- [ ] **Step 8.2: Verify dropdown switching between drafts**

Pre-requisite: at least two persisted drafts. If only one exists:
- Replay a different `Player.log` against `dataStore` using `preflight-real-draft.js` against a second log file, OR
- Open a real Arena draft to capture a second record while the app is running, then close.

1. With ≥ 2 drafts on disk, restart the app.
2. Use the dropdown to switch between them. Confirm:
   - My Picks list rebuilds with the correct picks for the chosen draft.
   - Dropdown selection visibly changes.
   - viewingCoord resets to that draft's liveCoord (latest pick is highlighted).

- [ ] **Step 8.3: Verify snap-to-live during a live `DRAFT_UPDATE`**

This requires triggering a `DRAFT_UPDATE` event while the app is running and the user is browsing a non-live coord.

Approach (using the captured fixture):
1. With the app running and a past draft loaded, navigate to an early pick (e.g., P1p1) via the arrow keys.
2. In a second terminal, append a snippet of a captured draft log to the watched `Player.log` so chokidar fires a `change` event:
   ```bash
   # Adjust the source path to a captured fixture log that contains
   # at least one DRAFT_UPDATE-relevant line beyond what's already
   # been processed.
   tail -n 50 tests/fixtures/real-draft-codev.log >> "$USERPROFILE/AppData/LocalLow/Wizards Of The Coast/MTGA/Player.log"
   ```
   On WSL, use the appropriate Windows path translation (e.g., `/mnt/c/Users/<you>/AppData/LocalLow/Wizards Of The Coast/MTGA/Player.log`).
3. Watch the app. Within ~2 seconds:
   - The view should snap to the new live coord.
   - My Picks list should reflect the live draft's picks.
   - Dropdown selection should update to the live draftId.
   - No console errors.

If the snap doesn't happen, check the dev tools console for `[Draft] Update received:` log lines — the `'draft-update'` IPC handler should fire on every successful upsert.

- [ ] **Step 8.4: Verify edge cases**

1. **Empty state:** rename `drafts.json` aside, restart the app. Navigate to Draft. Expected: "No draft in progress" placeholder; dropdown shows disabled "No past drafts yet". Restore `drafts.json` afterwards.
2. **Missing-pick coord:** if any persisted draft has a missing-pick gap (warn lines in startup logs are a clue), step to that coord. Expected: pack panel shows "⚠️ Pick missing from log..." placeholder; My Picks row for that coord retains the existing missing styling AND the `.viewing` highlight.
3. **CSV not loaded:** unload the 17Lands CSV (delete `lastCsvPath` from `settings.json` and restart), navigate to Draft, step around. Expected: every card's WR shows "—"; no crashes; ranking falls back to insertion order.

- [ ] **Step 8.5: Verify no console errors during a full session**

Open dev tools, exercise:
- Boot → draft auto-loads
- Step left/right
- Switch drafts via dropdown
- Live `DRAFT_UPDATE` snap-to-live
- Navigate Draft → Stats → Draft

Console should be clean of errors and unhandled rejections.

---

## Self-Review Notes

- **Spec coverage:**
  - Goal (arrow-key stepping, dropdown, snap-to-live, no new persisted data) — Tasks 1, 4, 6, 7.
  - Constraint "works on live and past from day one" — `buildViewerBundle` covers both (Tasks 1 & 2).
  - Constraint "no new persisted data" — `getDraftSummaries` only reads `record.picks.length`; `view-draft-record` rebuilds bundles on demand; nothing is written.
  - Constraint "snap-to-live always" — Step 6.4's `'draft-update'` handler unconditionally sets `bundle = data; viewingCoord = bundle.liveCoord`.
  - Constraint "arrow keys only on draft page, ignored when input focused" — Step 7.3's handler checks `currentPage === 'draft'` and the focused element's tagName.
  - Constraint "forward beyond live is unsupported (silent no-op)" — `nextCoord` returns the same coord at the array end (Task 5).
  - Architecture diagram → Tasks 1, 4, 6, 7 implement each box.
  - Components table → every modified file has a corresponding task.
  - Data Model `ViewerBundle` shape → Task 1 produces it; Task 2 verifies parity for past records.
  - IPC contracts (`list-drafts`, `view-draft-record`, `'draft-update'` shape change) → Task 4.
  - Renderer state & interactions table → Tasks 6, 7.
  - Edge cases (empty/sparse, missing-pick coord, CSV reload, view-draft-record null) — covered in Step 6.7, 7.5, 8.4 manually; the defensive snap-to-live is in `ensureValidViewingCoord` (Task 6).
  - Testing strategy Layers 1–4 → Tasks 1, 2, 3, 4, 5; Layer 5 (manual) → Task 8.
  - Implementation phases 1–6 → Tasks 1+2, 3, 4, 5, 6+7, 8.

- **Type consistency:** `ViewerBundle` shape is identical between Task 1 (live builder), Task 2 (past builder), Task 4 (IPC handler return), Task 6 (renderer consumer). `picks[i]` fields (`pack`, `pick`, `picked: number|null`, optional `missing`, `options: RankedCard[]`, `removedCards: RankedCard[]`, optional `pickedCard: ResolvedCard`) match across all tasks. `liveCoord: {pack, pick} | null` is consistent.

- **Function-name consistency:** `prevCoord` / `nextCoord` (not `prevPick`), `getViewingPick` (not `currentViewingPick`), `renderDraftDropdown` (used in Task 6 and the `'draft-update'` handler), `ensureValidViewingCoord`, `onDraftSelectChange`, `initDraftView` — all defined in Task 6 and referenced consistently in Tasks 6 and 7.

- **No placeholders:** every TDD step shows the full code being added/replaced; no "TBD" or "implement similarly" — code is repeated where needed for ease of out-of-order reading.
