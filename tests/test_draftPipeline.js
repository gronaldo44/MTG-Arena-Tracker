'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let MOCK_USERDATA;
jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => MOCK_USERDATA) },
}));

const DataStore = require('../dataStore');
const { buildDraftUpdatePayload, buildViewerBundle, fillMissingPickPlaceholders, _resetWarnedGaps } = require('../draftPipeline');
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
      for (const c of pick.options)      { expect(c.gihWr).toBeNull(); expect(c.lowSample).toBe(true); }
      for (const c of pick.removedCards) { expect(c.gihWr).toBeNull(); expect(c.lowSample).toBe(true); }
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

// ─── fillMissingPickPlaceholders edge cases ──────────────────────────────────

describe('fillMissingPickPlaceholders', () => {
  test('empty picks array → returns []', () => {
    expect(fillMissingPickPlaceholders({ draftId: 'd1', startedAt: 0, picks: [] })).toEqual([]);
  });

  test('null record → returns []', () => {
    expect(fillMissingPickPlaceholders(null)).toEqual([]);
  });

  test('record without picks array → returns []', () => {
    expect(fillMissingPickPlaceholders({ draftId: 'd1' })).toEqual([]);
  });
});
