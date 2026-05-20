'use strict';

/**
 * test_draftScan.js
 *
 * Safety tests for the draft scan/store pipeline in main.js.
 *
 * Guarantees verified:
 *   1. DRAFT_UPDATE events are routed to dataStore.upsertDraft(), never to
 *      handleGameEvent() — so scanning historical log data cannot clobber the
 *      live Draft tab or trigger the expensive enrichment pipeline.
 *   2. Multiple DRAFT_UPDATE events for the same draftId are deduplicated:
 *      each unique draft counts as exactly one stored record.
 *   3. draftsProcessed in the refresh-log response accurately reflects the
 *      number of unique drafts found.
 *   4. A DRAFT_UPDATE with null data or no draftId is silently skipped —
 *      no crash, no corrupt record stored.
 *   5. Non-draft events (MATCH_END, INVENTORY_UPDATE) are unaffected by the
 *      new interception logic.
 *   6. A re-scan of the same log is safe: upsertDraft's merge semantics
 *      (tested in test_dataStore.js) prevent double-counting picks.
 */

// ─── Capture IPC registrations ────────────────────────────────────────────────

const registeredHandlers = {};

// ─── Electron mock ────────────────────────────────────────────────────────────

jest.mock('electron', () => ({
  app: {
    on:                        jest.fn(),
    quit:                      jest.fn(),
    getVersion:                jest.fn(() => '1.0.0'),
    getPath:                   jest.fn(() => '/mock/userdata'),
    getName:                   jest.fn(() => 'MTG Arena Tracker'),
    setName:                   jest.fn(),
    isPackaged:                false,
    whenReady:                 jest.fn(() => Promise.resolve()),
    requestSingleInstanceLock: jest.fn(() => true),
  },
  ipcMain: {
    handle: jest.fn((channel, fn) => { registeredHandlers[channel] = fn; }),
    on:     jest.fn(),
  },
  BrowserWindow: jest.fn(() => ({
    loadFile:    jest.fn(),
    on:          jest.fn(),
    once:        jest.fn(),
    show:        jest.fn(),
    hide:        jest.fn(),
    isDestroyed: jest.fn(() => false),
    isMinimized: jest.fn(() => false),
    isVisible:   jest.fn(() => true),
    isMaximized: jest.fn(() => false),
    restore:     jest.fn(),
    focus:       jest.fn(),
    webContents: { send: jest.fn(), openDevTools: jest.fn(), on: jest.fn(), toggleDevTools: jest.fn() },
  })),
  Tray: jest.fn(() => ({
    setContextMenu: jest.fn(),
    setToolTip:     jest.fn(),
    on:             jest.fn(),
    displayBalloon: jest.fn(),
  })),
  Menu:         { buildFromTemplate: jest.fn(() => ({})), setApplicationMenu: jest.fn() },
  dialog:       {
    showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showSaveDialog: jest.fn(() => Promise.resolve({ canceled: true })),
  },
  shell:        { openExternal: jest.fn() },
  Notification: jest.fn(() => ({ show: jest.fn() })),
}));

// ─── chokidar mock ────────────────────────────────────────────────────────────

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({ on: jest.fn().mockReturnThis(), close: jest.fn() })),
}));

// ─── Controllable LogParserV5 mock ────────────────────────────────────────────

// Each test sets mockEvents to control what parse() returns.
let mockEvents = [];
jest.mock('../logParserV5', () =>
  jest.fn(() => ({ parse: jest.fn(() => mockEvents) }))
);

// GREParser: always returns empty (no card-stat events in these tests)
jest.mock('../parser/greParser', () =>
  jest.fn(() => ({ parse: jest.fn(() => []) }))
);

// ─── DataStore mock with spy on upsertDraft ───────────────────────────────────

const mockUpsertDraft = jest.fn();
const mockAddMatch    = jest.fn();

jest.mock('../dataStore', () =>
  jest.fn(() => ({
    getMatches:            jest.fn(() => []),
    addMatch:              mockAddMatch,
    deleteMatch:           jest.fn(),
    getStats:              jest.fn(() => ({ total: 0, wins: 0, losses: 0, draws: 0, winRate: 0, formats: {}, decks: {} })),
    getSettings:           jest.fn(() => ({})),
    saveSettings:          jest.fn(),
    getDeck:               jest.fn(() => null),
    getDecks:              jest.fn(() => []),
    addDeck:               jest.fn(),
    exportToFile:          jest.fn(),
    importFromFile:        jest.fn(() => true),
    clearAll:              jest.fn(),
    reloadCards:           jest.fn(),
    getInventory:          jest.fn(() => null),
    updateInventory:       jest.fn(),
    getCardName:           jest.fn((id) => `Card(${id})`),
    getMatchFormat:        jest.fn(() => null),
    updateCardGameStats:   jest.fn(() => false),
    getAllCardGameStats:    jest.fn(() => ({})),
    getCardStatFormats:    jest.fn(() => []),
    clearCardStats:        jest.fn(),
    deleteMatchesByFormat: jest.fn(),
    updateMatchColors:     jest.fn(),
    getMainDraftSets:      jest.fn(() => []),
    getCardsBySet:         jest.fn(() => []),
    upsertDraft:           mockUpsertDraft,
    getDraft:              jest.fn(() => null),
    getAllDrafts:           jest.fn(() => []),
  }))
);

jest.mock('../cardUpdater', () =>
  jest.fn(() => ({
    update:    jest.fn(() => Promise.resolve(false)),
    cardsData: { cards: {} },
  }))
);

jest.mock('../draftAssistant', () =>
  jest.fn(() => ({
    isLoaded:       jest.fn(() => false),
    loadCSV:        jest.fn(() => ({ cardCount: 0, setName: 'mock' })),
    getStatus:      jest.fn(() => ({ loaded: false, cardCount: 0, setName: null, csvPath: null })),
    getCardStats:   jest.fn(() => null),
    getAllCardStats: jest.fn(() => []),
  }))
);

jest.mock('../draftPipeline', () => ({
  buildDraftUpdatePayload: jest.fn(() => ({})),
}));

jest.mock('../setEnricher', () => ({
  init:            jest.fn(),
  needsEnrichment: jest.fn(() => false),
  enrich:          jest.fn(() => Promise.resolve(false)),
}));

// ─── fs mock ─────────────────────────────────────────────────────────────────

const fs = require('fs');
jest.spyOn(fs, 'existsSync').mockReturnValue(true);
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
  if (String(filePath).endsWith('cards.json')) return JSON.stringify({ cards: {} });
  return 'mock-log-data';
});
jest.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
jest.spyOn(fs, 'statSync').mockReturnValue({ size: 100 });
jest.spyOn(fs, 'readdirSync').mockReturnValue([]);

// ─── Load main.js ─────────────────────────────────────────────────────────────

jest.useFakeTimers();
require('../main');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a DRAFT_UPDATE event matching the shape emitted by LogParserV5.
 * picksCount controls how many completed picks are included.
 * currentPack simulates an open pack (null = no current pack / draft complete).
 */
function draftUpdate(draftId, picksCount = 0, currentPack = null) {
  const picks = Array.from({ length: picksCount }, (_, i) => ({
    pack: Math.floor(i / 15) + 1,
    pick: (i % 15) + 1,
    options: [100 + i, 200 + i, 300 + i],
    picked: 100 + i,
  }));
  return { type: 'DRAFT_UPDATE', data: { draftId, picks, currentPack } };
}

function matchEndEvent(matchId = 'M1') {
  return {
    type: 'MATCH_END',
    data: { matchId, result: 'win', timestamp: new Date().toISOString(), format: 'Draft', playerDeck: null },
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

beforeEach(() => {
  mockUpsertDraft.mockClear();
  mockAddMatch.mockClear();
  mockEvents = [];
});

// ─── 1. Routing: DRAFT_UPDATE → upsertDraft, not handleGameEvent ─────────────

describe('refresh-log — DRAFT_UPDATE routing', () => {
  test('DRAFT_UPDATE calls upsertDraft with the full event data', async () => {
    mockEvents = [draftUpdate('draft-1', 3)];
    await registeredHandlers['refresh-log'](null);

    expect(mockUpsertDraft).toHaveBeenCalledTimes(1);
    expect(mockUpsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: 'draft-1', picks: expect.any(Array) })
    );
  });

  test('DRAFT_UPDATE does not trigger a live draft-update IPC message to the renderer', async () => {
    mockEvents = [draftUpdate('draft-1', 3)];
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.mock.results[0]?.value;
    if (win) win.webContents.send.mockClear();

    await registeredHandlers['refresh-log'](null);

    if (win) {
      const liveUpdates = win.webContents.send.mock.calls.filter(([ch]) => ch === 'draft-update');
      expect(liveUpdates).toHaveLength(0);
    }
  });

  test('MATCH_END events still reach handleGameEvent (addMatch is called)', async () => {
    mockEvents = [matchEndEvent('M42')];
    await registeredHandlers['refresh-log'](null);
    expect(mockAddMatch).toHaveBeenCalledTimes(1);
    expect(mockAddMatch.mock.calls[0][0]).toMatchObject({ matchId: 'M42' });
  });

  test('DRAFT_UPDATE does not increment matchesProcessed', async () => {
    mockEvents = [draftUpdate('draft-1', 5)];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.matchesProcessed).toBe(0);
  });
});

// ─── 2. draftsProcessed count ─────────────────────────────────────────────────

describe('refresh-log — draftsProcessed count', () => {
  test('returns draftsProcessed: 0 when there are no DRAFT_UPDATE events', async () => {
    mockEvents = [];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.success).toBe(true);
    expect(result.draftsProcessed).toBe(0);
    expect(mockUpsertDraft).not.toHaveBeenCalled();
  });

  test('multiple DRAFT_UPDATE events for the same draftId count as 1 unique draft', async () => {
    // Realistic pattern: one notify + one pick = two DRAFT_UPDATE events per pick
    mockEvents = [
      draftUpdate('draft-A', 0, { pack: 1, pick: 1, options: [100, 200, 300] }), // Draft.Notify
      draftUpdate('draft-A', 1, { pack: 1, pick: 2, options: [400, 500, 600] }), // after pick 1
      draftUpdate('draft-A', 2, null),                                            // after pick 2
    ];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.draftsProcessed).toBe(1);
    expect(mockUpsertDraft).toHaveBeenCalledTimes(3); // called once per event
  });

  test('two distinct draftIds count as 2 unique drafts', async () => {
    mockEvents = [
      draftUpdate('draft-A', 5),
      draftUpdate('draft-B', 5),
    ];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.draftsProcessed).toBe(2);
    expect(mockUpsertDraft).toHaveBeenCalledTimes(2);
  });

  test('MATCH_END and INVENTORY_UPDATE events do not inflate draftsProcessed', async () => {
    mockEvents = [
      matchEndEvent('M1'),
      { type: 'INVENTORY_UPDATE', data: { gems: 100, gold: 1000, totalVaultProgress: 0 } },
      draftUpdate('draft-A', 2),
    ];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.draftsProcessed).toBe(1);
    expect(result.matchesProcessed).toBe(1);
  });

  test('45 DRAFT_UPDATE events across one completed draft count as 1', async () => {
    // Each pick generates two events: Draft.Notify + EventPlayerDraftMakePick
    const events = [];
    for (let i = 0; i < 45; i++) {
      events.push(draftUpdate('draft-complete', i,     { pack: Math.floor(i / 15) + 1, pick: (i % 15) + 1, options: [999] }));
      events.push(draftUpdate('draft-complete', i + 1, null));
    }
    mockEvents = events;
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.draftsProcessed).toBe(1);
    expect(mockUpsertDraft).toHaveBeenCalledTimes(90);
  });
});

// ─── 3. Incomplete and malformed DRAFT_UPDATE safety ─────────────────────────

describe('refresh-log — incomplete and malformed DRAFT_UPDATE events', () => {
  test('a notify-only event (0 picks, currentPack set) does not crash', async () => {
    mockEvents = [draftUpdate('draft-notify-only', 0, { pack: 1, pick: 1, options: [100, 200] })];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.success).toBe(true);
    expect(mockUpsertDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId:     'draft-notify-only',
        picks:       [],
        currentPack: { pack: 1, pick: 1, options: [100, 200] },
      })
    );
  });

  test('DRAFT_UPDATE with no draftId is skipped: upsertDraft not called, no crash', async () => {
    mockEvents = [{ type: 'DRAFT_UPDATE', data: { picks: [], currentPack: null } }]; // no draftId
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.success).toBe(true);
    expect(mockUpsertDraft).not.toHaveBeenCalled();
    expect(result.draftsProcessed).toBe(0);
  });

  test('DRAFT_UPDATE with null data does not crash the scan', async () => {
    mockEvents = [{ type: 'DRAFT_UPDATE', data: null }];
    await expect(registeredHandlers['refresh-log'](null)).resolves.toMatchObject({ success: true });
    expect(mockUpsertDraft).not.toHaveBeenCalled();
  });

  test('DRAFT_UPDATE with undefined data does not crash the scan', async () => {
    mockEvents = [{ type: 'DRAFT_UPDATE' }]; // data field absent
    await expect(registeredHandlers['refresh-log'](null)).resolves.toMatchObject({ success: true });
    expect(mockUpsertDraft).not.toHaveBeenCalled();
  });

  test('a draft with picks has each pick with a non-null picked value', async () => {
    mockEvents = [draftUpdate('draft-with-picks', 5)];
    await registeredHandlers['refresh-log'](null);
    const storedArg = mockUpsertDraft.mock.calls[0][0];
    expect(storedArg.picks).toHaveLength(5);
    expect(storedArg.picks.every(p => p.picked !== null)).toBe(true);
  });
});

// ─── 4. Re-scan safety (idempotence) ─────────────────────────────────────────

describe('refresh-log — re-scan safety', () => {
  test('scanning the same log twice calls upsertDraft the same number of times each scan', async () => {
    mockEvents = [
      draftUpdate('draft-A', 0, { pack: 1, pick: 1, options: [10, 20] }),
      draftUpdate('draft-A', 1, null),
    ];

    const result1 = await registeredHandlers['refresh-log'](null);
    const firstCallCount = mockUpsertDraft.mock.calls.length;
    mockUpsertDraft.mockClear();

    const result2 = await registeredHandlers['refresh-log'](null);
    const secondCallCount = mockUpsertDraft.mock.calls.length;

    // Same number of events processed each time — merge semantics in
    // upsertDraft (tested in test_dataStore.js) prevent data corruption.
    expect(firstCallCount).toBe(secondCallCount);
    expect(result1.draftsProcessed).toBe(result2.draftsProcessed);
  });

  test('a mix of a completed draft and a partial draft are both stored', async () => {
    mockEvents = [
      draftUpdate('draft-full',    45, null),  // all picks done
      draftUpdate('draft-partial', 7,  { pack: 1, pick: 8, options: [50, 60] }), // mid-draft
    ];
    const result = await registeredHandlers['refresh-log'](null);
    expect(result.draftsProcessed).toBe(2);

    const fullArgs    = mockUpsertDraft.mock.calls.find(([s]) => s.draftId === 'draft-full')[0];
    const partialArgs = mockUpsertDraft.mock.calls.find(([s]) => s.draftId === 'draft-partial')[0];
    expect(fullArgs.picks).toHaveLength(45);
    expect(partialArgs.picks).toHaveLength(7);
  });
});
