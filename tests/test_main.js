'use strict';

/**
 * test_main.js
 *
 * main.js is an Electron process orchestrator — IPC handlers, file watchers,
 * app lifecycle — so comprehensive unit testing requires mocking the entire
 * Electron API surface.  These tests focus on:
 *   1. Smoke test: the module loads without throwing.
 *   2. IPC handlers: verify they are registered and return sensible shapes.
 *   3. Card resolution: the resolveCard / resolveCards logic (exercised via
 *      the 'get-card-name' handler).
 *
 * Things intentionally NOT tested here:
 *   - Window creation, tray icon, native dialog behaviour (Electron UI)
 *   - File watcher event handling (chokidar integration)
 *   - Log parsing details (covered in test_logParserV5.js)
 *   - Draft assistant stats (covered in test_draftAssistant.js)
 */

// ─── Mock all Electron APIs before requiring main.js ─────────────────────────

const registeredHandlers = {};  // ipcMain.handle channel → fn
const appListeners = {};        // app.on event → fn

jest.mock('electron', () => ({
  app: {
    on: jest.fn((event, cb) => {
      appListeners[event] = cb;
    }),
    quit:                     jest.fn(),
    getVersion:               jest.fn(() => '1.0.0'),
    getPath:                  jest.fn(() => '/mock/userdata'),
    getName:                  jest.fn(() => 'MTG Arena Tracker'),
    isPackaged:               false,
    whenReady:                jest.fn(() => Promise.resolve()),
    requestSingleInstanceLock: jest.fn(() => true),
  },
  ipcMain: {
    handle: jest.fn((channel, handler) => {
      registeredHandlers[channel] = handler;
    }),
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(() => ({
    loadFile:    jest.fn(),
    on:          jest.fn(),
    once:        jest.fn(),
    show:        jest.fn(),
    hide:        jest.fn(),
    isDestroyed: jest.fn(() => false),
    webContents: {
      send:          jest.fn(),
      openDevTools:  jest.fn(),
    },
  })),
  Tray: jest.fn(() => ({
    setContextMenu: jest.fn(),
    setToolTip:     jest.fn(),
    on:             jest.fn(),
    destroy:        jest.fn(),
  })),
  Menu: {
    buildFromTemplate: jest.fn(() => ({})),
    setApplicationMenu: jest.fn(),
  },
  dialog: {
    showOpenDialog: jest.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showSaveDialog: jest.fn(() => Promise.resolve({ canceled: true })),
  },
  shell:        { openExternal: jest.fn() },
  Notification: jest.fn(() => ({ show: jest.fn() })),
}));

// ─── Mock chokidar ───────────────────────────────────────────────────────────

jest.mock('chokidar', () => ({
  watch: jest.fn(() => ({
    on:    jest.fn().mockReturnThis(),
    close: jest.fn(),
  })),
}));

// ─── Mock local modules ──────────────────────────────────────────────────────

jest.mock('../logParserV5', () =>
  jest.fn(() => ({ parse: jest.fn(() => []) }))
);

// Shared fixture state for the mocked dataStore — exposed so individual tests
// can assert against the same data the IPC handlers see.
const MOCK_DRAFT_SETS = [
  { code: 'SOS', primaryCount: 281, firstGrpId: 102460 },
  { code: 'TMT', primaryCount: 205, firstGrpId: 100458 },
];
const MOCK_SET_CARDS = {
  SOS: [
    { grpId: '102471', name: 'Elite Interceptor',     manaCost: '{W}',     type: 'Creature', set: 'SOS', digitalReleaseSet: '' },
    { grpId: '102832', name: 'Sylvan Library',        manaCost: '{1}{G}',  type: 'Enchantment', set: 'SPG', digitalReleaseSet: 'SPG-SOS' },
  ],
};

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

jest.mock('../cardUpdater', () =>
  jest.fn(() => ({
    checkAndUpdate:  jest.fn(() => Promise.resolve({ updated: false, cardCount: 0 })),
    getStatus:       jest.fn(() => ({ exists: true, cardCount: 100, source: 'mock', lastUpdated: null })),
    update:          jest.fn(() => Promise.resolve(false)),
    cardsData:       { cards: {} },
  }))
);

jest.mock('../draftAssistant', () =>
  jest.fn(() => ({
    isLoaded:       jest.fn(() => false),
    loadCSV:        jest.fn(() => ({ cardCount: 0, setName: 'mock' })),
    getStatus:      jest.fn(() => ({ loaded: false, cardCount: 0, setName: null, csvPath: null })),
    rankPack:       jest.fn(cards => cards.map(c => ({ ...c, gihWr: null, lowSample: true, tier: 'none', stats: null, gihCount: 0 }))),
    getCardStats:   jest.fn(() => null),
    getCardTier:    jest.fn(() => 'none'),
    getAllCardStats: jest.fn(() => []),
  }))
);

// ─── Mock fs (cards.json read at startup) ────────────────────────────────────

const MOCK_CARDS = {
  cards: {
    '12345': { name: 'Lightning Bolt', manaCost: '{R}',    type: 'Instant'  },
    '67890': { name: 'Forest',         manaCost: '',        type: 'Basic Land' },
  },
};

const fs = require('fs');
jest.spyOn(fs, 'existsSync').mockReturnValue(true);
jest.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
  if (String(filePath).endsWith('cards.json')) {
    return JSON.stringify(MOCK_CARDS);
  }
  return '';
});
jest.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);

// ─── Load main.js (triggers module-level code and app.on registrations) ──────

// Use fake timers so the auto-scan setInterval in main.js doesn't outlive the tests.
jest.useFakeTimers();

// Trigger the 'ready' callback synchronously so IPC handlers are registered.
const { app } = require('electron');

// We must require main.js AFTER all mocks are in place.
require('../main');

// Fire the 'ready' callback that main.js registered, if any.
if (appListeners['ready']) {
  appListeners['ready']();
}
if (appListeners['activate']) {
  // don't auto-fire activate — it re-creates windows
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('main.js', () => {

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  // ── Smoke test ─────────────────────────────────────────────────────────

  describe('module load', () => {
    test('module loads without throwing', () => {
      // The require above would have thrown if loading failed.
      expect(true).toBe(true);
    });

    test('ipcMain.handle was called at least once', () => {
      const { ipcMain } = require('electron');
      expect(ipcMain.handle).toHaveBeenCalled();
    });

    test('key IPC channels are registered', () => {
      const expected = [
        'get-matches',
        'get-stats',
        'get-card-name',
        'get-settings',
        'save-settings',
        'get-draft-assistant-status',
        'get-main-draft-sets',
        'get-set-card-stats',
      ];
      for (const channel of expected) {
        expect(registeredHandlers).toHaveProperty(channel);
      }
    });
  });

  // ── get-main-draft-sets ────────────────────────────────────────────────

  describe('get-main-draft-sets handler', () => {
    test('returns the precomputed list, sorted by recency', async () => {
      const handler = registeredHandlers['get-main-draft-sets'];
      const sets = await handler(null);
      expect(Array.isArray(sets)).toBe(true);
      expect(sets[0]).toEqual(expect.objectContaining({
        code: 'SOS', primaryCount: 281, firstGrpId: 102460,
      }));
    });
  });

  // ── get-set-card-stats ─────────────────────────────────────────────────

  describe('get-set-card-stats handler', () => {
    test('returns one row per unique card name in the set + SPG pool', async () => {
      const handler = registeredHandlers['get-set-card-stats'];
      const rows = await handler(null, 'SOS');
      expect(rows).toHaveLength(2);
      const names = rows.map(r => r.name).sort();
      expect(names).toEqual(['Elite Interceptor', 'Sylvan Library']);
    });

    test('zeroes out personal stats and 17L when nothing is loaded', async () => {
      const handler = registeredHandlers['get-set-card-stats'];
      const rows = await handler(null, 'SOS');
      for (const r of rows) {
        expect(r.gamesInDeck).toBe(0);
        expect(r.gamesInHand).toBe(0);
        expect(r.gihWrPersonal).toBeNull();
        expect(r.gihWr17l).toBeNull();
        expect(r.delta).toBeNull();
      }
    });

    test('returns [] when the set is unknown', async () => {
      const handler = registeredHandlers['get-set-card-stats'];
      const rows = await handler(null, 'NOPE');
      expect(rows).toEqual([]);
    });

    test('returns [] when no setCode is supplied', async () => {
      const handler = registeredHandlers['get-set-card-stats'];
      expect(await handler(null, '')).toEqual([]);
      expect(await handler(null, null)).toEqual([]);
    });
  });

  // ── get-card-name (resolveCard) ─────────────────────────────────────────

  describe('get-card-name handler', () => {
    test('returns card name for a known GRP ID', async () => {
      const handler = registeredHandlers['get-card-name'];
      expect(handler).toBeDefined();

      const name = await handler(null, 12345);
      expect(name).toBe('Lightning Bolt');
    });

    test('returns "Unknown (grpId)" for an unrecognised GRP ID', async () => {
      const handler = registeredHandlers['get-card-name'];
      const name = await handler(null, 99999);
      expect(name).toMatch(/Unknown/);
      expect(name).toContain('99999');
    });

    test('handles string GRP IDs', async () => {
      const handler = registeredHandlers['get-card-name'];
      const name = await handler(null, '67890');
      expect(name).toBe('Forest');
    });
  });

  // ── get-matches ─────────────────────────────────────────────────────────

  describe('get-matches handler', () => {
    test('returns an array', async () => {
      const handler = registeredHandlers['get-matches'];
      expect(handler).toBeDefined();
      const result = await handler(null);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // ── get-stats ───────────────────────────────────────────────────────────

  describe('get-stats handler', () => {
    test('returns an object with total, wins, losses keys', async () => {
      const handler = registeredHandlers['get-stats'];
      const result = await handler(null);
      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('wins');
      expect(result).toHaveProperty('losses');
    });
  });

  // ── get-draft-assistant-status ──────────────────────────────────────────

  describe('get-draft-assistant-status handler', () => {
    test('returns a status object with a loaded boolean', async () => {
      const handler = registeredHandlers['get-draft-assistant-status'];
      expect(handler).toBeDefined();
      const status = await handler(null);
      expect(status).toHaveProperty('loaded');
      expect(typeof status.loaded).toBe('boolean');
    });
  });

  // ── get-settings ────────────────────────────────────────────────────────

  describe('get-settings handler', () => {
    test('returns an object', async () => {
      const handler = registeredHandlers['get-settings'];
      const result = await handler(null);
      expect(typeof result).toBe('object');
    });
  });

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
});
