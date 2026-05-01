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

  test('full synthetic draft: every (pack, pick) ends with a non-null picked', () => {
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
