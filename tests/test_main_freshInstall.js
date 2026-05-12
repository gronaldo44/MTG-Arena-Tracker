'use strict';

/**
 * test_main_freshInstall.js
 *
 * Integration test for the startup sequence on a fresh install.
 *
 * The specific bug this guards against: on first launch, loadCards() ran
 * before cardUpdater.update() completed, and was never called again after the
 * download finished. Cards stayed empty for the whole session, so card names
 * never resolved until the user restarted the app.
 *
 * Setup:
 *   - fs.readFileSync for cards.json throws ENOENT on the first call
 *     (no file before download) and returns populated data on the second call.
 *   - cardUpdater.update() returns true (download happened).
 *
 * Expected: loadCards() is called a second time after the download, so
 * cards downloaded in this session are resolvable without restarting.
 */

// ─── Mocks ───────────────────────────────────────────────────────────────────

const appListeners       = {};
const registeredHandlers = {};

jest.mock('electron', () => ({
  app: {
    on:                        jest.fn((event, cb) => { appListeners[event] = cb; }),
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
    handle: jest.fn((channel, handler) => { registeredHandlers[channel] = handler; }),
    on:     jest.fn(),
  },
  BrowserWindow: jest.fn(() => ({
    loadFile:    jest.fn(),
    on:          jest.fn(),
    once:        jest.fn(),
    show:        jest.fn(),
    hide:        jest.fn(),
    isDestroyed: jest.fn(() => false),
    webContents: { send: jest.fn(), openDevTools: jest.fn() },
  })),
  Tray: jest.fn(() => ({
    setContextMenu: jest.fn(),
    setToolTip:     jest.fn(),
    on:             jest.fn(),
    destroy:        jest.fn(),
  })),
  Menu: {
    buildFromTemplate:  jest.fn(() => ({})),
    setApplicationMenu: jest.fn(),
  },
  dialog: {
    showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showSaveDialog: jest.fn(() => Promise.resolve({ canceled: true })),
  },
  shell: { openExternal: jest.fn() },
}));

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({ on: jest.fn().mockReturnThis(), close: jest.fn() })),
}));

jest.mock('../logParserV5', () => jest.fn(() => ({ parse: jest.fn(() => []) })));

// Draft with pick.picked = 10 so we can verify resolveCard() against the
// cards global after the download.
const MOCK_DRAFT = {
  draftId: 'draft-a',
  startedAt: 1000,
  picks: [
    { pack: 1, pick: 1, options: [10, 11, 12], picked: 10 },
  ],
};

jest.mock('../dataStore', () =>
  jest.fn(() => ({
    getMatches:            jest.fn(() => []),
    saveMatch:             jest.fn(),
    deleteMatch:           jest.fn(),
    getStats:              jest.fn(() => ({ total: 0, wins: 0, losses: 0, draws: 0, winRate: 0, formats: {}, decks: {} })),
    getSettings:           jest.fn(() => ({})),
    saveSettings:          jest.fn(),
    getDeck:               jest.fn(() => null),
    exportData:            jest.fn(() => '/mock/export.json'),
    importData:            jest.fn(() => true),
    clearData:             jest.fn(),
    reloadCards:           jest.fn(),
    getInventory:          jest.fn(() => null),
    getCardName:           jest.fn(() => null),
    getMatchFormat:        jest.fn(() => null),
    updateCardGameStats:   jest.fn(() => false),
    getAllCardGameStats:    jest.fn(() => ({})),
    getCardStatFormats:    jest.fn(() => []),
    clearCardStats:        jest.fn(),
    deleteMatchesByFormat: jest.fn(),
    updateMatchColors:     jest.fn(),
    getMainDraftSets:      jest.fn(() => []),
    getCardsBySet:         jest.fn(() => []),
    getDraftSummaries:     jest.fn(() => [{ draftId: 'draft-a', startedAt: 1000, pickCount: 1 }]),
    getDraft:              jest.fn((id) => id === 'draft-a' ? MOCK_DRAFT : null),
    upsertDraft:           jest.fn(),
  }))
);

jest.mock('../draftAssistant', () =>
  jest.fn(() => ({
    isLoaded:       jest.fn(() => false),
    loadCSV:        jest.fn(),
    getStatus:      jest.fn(() => ({ loaded: false, cardCount: 0, setName: null, csvPath: null })),
    rankPack:       jest.fn(c => c),
    getCardStats:   jest.fn(() => null),
    getCardTier:    jest.fn(() => 'none'),
    getAllCardStats: jest.fn(() => []),
  }))
);

jest.mock('../setEnricher', () => ({
  init:            jest.fn(),
  enrich:          jest.fn(() => Promise.resolve(false)),
  needsEnrichment: jest.fn(() => false),
}));

// ─── CardUpdater — returns true to simulate a completed fresh download ────────

jest.mock('../cardUpdater', () =>
  jest.fn(() => ({
    update:    jest.fn(() => Promise.resolve(true)),
    cardsData: { cards: {} },
  }))
);

// ─── fs — cards.json missing before download, present after ──────────────────

const fs = require('fs');

// The downloaded cards contain grpId 10 so resolveCard(10) can be checked.
const DOWNLOADED_CARDS = {
  cards: {
    '10': { name: 'Opt', manaCost: '{U}', type: 'Instant' },
  },
  mainDraftSets: [{ code: 'SOS', primaryCount: 281, firstGrpId: 102460 }],
  enrichedSets:  ['SOS', 'SOA'],
};

let cardsJsonReadCount = 0;

jest.spyOn(fs, 'existsSync').mockReturnValue(true);
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
  if (String(filePath).endsWith('cards.json')) {
    cardsJsonReadCount++;
    if (cardsJsonReadCount === 1) {
      // Simulate no cards.json on disk before the download runs.
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }
    return JSON.stringify(DOWNLOADED_CARDS);
  }
  return '';
});
jest.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
jest.spyOn(fs, 'statSync').mockReturnValue({ size: 100 });
jest.spyOn(fs, 'readdirSync').mockReturnValue([]);
jest.spyOn(fs, 'copyFileSync').mockReturnValue(undefined);

// ─── Load main.js and flush the startup promise chain ────────────────────────

jest.useFakeTimers();
require('../main');

// Drain all microtask levels produced by the async startup chain:
// whenReady → loadCards (throws) → update (returns true) → loadCards (succeeds)
// → enrich check → initialLogScan → done.
const flushStartup = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('startup — fresh install (first-run Scryfall download)', () => {
  beforeAll(async () => {
    await flushStartup();
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('cardUpdater.update() is called during startup', () => {
    const CardUpdater = require('../cardUpdater');
    const instance = CardUpdater.mock.results[0]?.value;
    expect(instance.update).toHaveBeenCalledTimes(1);
  });

  test('cards.json is read from disk a second time after the download completes', () => {
    // First read throws (no file yet). Second read happens only if loadCards()
    // is called again after cardUpdater.update() returns true. If the bug is
    // present, this count stays at 1.
    expect(cardsJsonReadCount).toBeGreaterThanOrEqual(2);
  });

  test('cards downloaded this session resolve without a restart', async () => {
    // resolveCard() reads the `cards` global populated by loadCards().
    // view-draft-record passes resolveCard into draftPipeline.buildViewerBundle,
    // which stamps each pick with a pickedCard. If loadCards() was NOT called
    // after the download, cards is still {} and pickedCard.name is 'Unknown (10)'.
    const handler = registeredHandlers['view-draft-record'];
    expect(handler).toBeDefined();

    const bundle = await handler(null, 'draft-a');
    const pick = bundle.picks.find(p => p.pack === 1 && p.pick === 1);

    expect(pick.pickedCard.name).toBe('Opt');
  });
});
