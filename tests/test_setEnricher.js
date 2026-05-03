'use strict';

const path = require('path');
const { EventEmitter } = require('events');

jest.mock('fs');
jest.mock('child_process');

const fs = require('fs');
const childProcess = require('child_process');

// Paths that setEnricher.js computes internally via path.join(__dirname, ...)
const ENRICHER_DIR  = path.resolve(__dirname, '..');
const CARDS_FILE    = path.join(ENRICHER_DIR, 'cards.json');
const BUNDLED_DIR   = path.join(ENRICHER_DIR, 'sos-card-import');
const SCRIPT_PATH   = path.join(BUNDLED_DIR, 'import_sos.py');
const BUNDLED_DB    = path.join(BUNDLED_DIR, 'Raw_CardDatabase_abc.mtga');

const { needsEnrichment, enrich } = require('../setEnricher');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCardsJson(overrides = {}) {
  const base = {
    cards: {},
    mainDraftSets: [{ code: 'SOS', primaryCount: 150 }],
    enrichedSets: ['SOS', 'SOA'],
  };
  const merged = { ...base, ...overrides };
  // Omit keys explicitly set to undefined so the "missing field" tests work
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  return JSON.stringify(merged);
}

// fs defaults: MTGA not installed, bundled DB present, import script present
function setupFsWithBundledDb(cardsJsonStr) {
  fs.existsSync.mockImplementation(p => {
    return p === BUNDLED_DIR || p === CARDS_FILE || p === SCRIPT_PATH;
  });
  fs.readdirSync.mockImplementation(dir => {
    if (dir === BUNDLED_DIR) return ['Raw_CardDatabase_abc.mtga', 'import_sos.py'];
    return [];
  });
  fs.readFileSync.mockImplementation(() => cardsJsonStr ?? makeCardsJson());
  fs.writeFileSync.mockImplementation(() => {});
  fs.renameSync.mockImplementation(() => {});
}

function mockSpawnSuccess() {
  childProcess.spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', 0));
    return proc;
  });
}

function mockSpawnFailure(code = 1) {
  childProcess.spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', code));
    return proc;
  });
}

beforeEach(() => jest.clearAllMocks());

// ── needsEnrichment ────────────────────────────────────────────────────────

describe('needsEnrichment', () => {
  test('returns false when both SOS and SOA are in enrichedSets and mainDraftSets is non-empty', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson());
    expect(needsEnrichment()).toBe(false);
  });

  test('returns true when enrichedSets is absent', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: undefined }));
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when mainDraftSets is empty', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson({ mainDraftSets: [] }));
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when mainDraftSets is absent', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson({ mainDraftSets: undefined }));
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when SOS is missing from enrichedSets', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: ['SOA'] }));
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when SOA is missing from enrichedSets', () => {
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: ['SOS'] }));
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json cannot be read', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json contains invalid JSON', () => {
    fs.readFileSync.mockReturnValue('not-valid-json{{');
    expect(needsEnrichment()).toBe(true);
  });
});

// ── enrich — skip when up to date ─────────────────────────────────────────

describe('enrich — skips when already up to date', () => {
  test('returns false and does not call spawn', async () => {
    fs.readFileSync.mockReturnValue(makeCardsJson());
    const result = await enrich();
    expect(result).toBe(false);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

// ── enrich — uses bundled DB ───────────────────────────────────────────────

describe('enrich — uses bundled DB when MTGA is not installed', () => {
  const needsEnrichmentJson = makeCardsJson({ enrichedSets: undefined, mainDraftSets: [] });

  beforeEach(() => {
    setupFsWithBundledDb(needsEnrichmentJson);
    mockSpawnSuccess();
  });

  test('returns true', async () => {
    expect(await enrich()).toBe(true);
  });

  test('passes the bundled DB path to the Python script', async () => {
    await enrich();
    const spawnArgs = childProcess.spawn.mock.calls[0][1];
    // args = [script, dbPath, scryfallPath, cardsJsonPath]
    expect(spawnArgs[1]).toBe(BUNDLED_DB);
  });

  test('records SOS and SOA in enrichedSets after success', async () => {
    await enrich();
    const [, jsonStr] = fs.writeFileSync.mock.calls[0];
    const written = JSON.parse(jsonStr);
    expect(written.enrichedSets).toContain('SOS');
    expect(written.enrichedSets).toContain('SOA');
  });

  test('atomically renames the tmp file over cards.json', async () => {
    await enrich();
    const [from, to] = fs.renameSync.mock.calls[0];
    expect(from).toBe(CARDS_FILE + '.tmp');
    expect(to).toBe(CARDS_FILE);
  });
});

// ── enrich — force option ──────────────────────────────────────────────────

describe('enrich — force option bypasses needsEnrichment check', () => {
  beforeEach(() => {
    setupFsWithBundledDb(makeCardsJson()); // looks fully enriched
    mockSpawnSuccess();
  });

  test('runs the import even when already enriched', async () => {
    const result = await enrich({ force: true });
    expect(result).toBe(true);
    expect(childProcess.spawn).toHaveBeenCalled();
  });
});

// ── enrich — opts.mtgaDbPath ───────────────────────────────────────────────

describe('enrich — respects opts.mtgaDbPath when provided', () => {
  const CUSTOM_DB = 'D:\\MyCustomPath\\Raw_CardDatabase_custom.mtga';

  beforeEach(() => {
    fs.existsSync.mockImplementation(p => {
      return p === CUSTOM_DB || p === CARDS_FILE || p === SCRIPT_PATH;
    });
    fs.readdirSync.mockReturnValue([]);
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: undefined }));
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    mockSpawnSuccess();
  });

  test('uses the user-configured DB path instead of auto-detected paths', async () => {
    await enrich({ mtgaDbPath: CUSTOM_DB });
    const spawnArgs = childProcess.spawn.mock.calls[0][1];
    expect(spawnArgs[1]).toBe(CUSTOM_DB);
  });
});

// ── enrich — prefers live MTGA DB over bundled fallback ───────────────────

describe('enrich — prefers live MTGA DB over bundled fallback', () => {
  const LIVE_DIR = 'C:\\Program Files\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw';
  const LIVE_DB  = path.join(LIVE_DIR, 'Raw_CardDatabase_live.mtga');

  beforeEach(() => {
    fs.existsSync.mockImplementation(p => {
      return p === LIVE_DIR || p === BUNDLED_DIR || p === CARDS_FILE || p === SCRIPT_PATH;
    });
    fs.readdirSync.mockImplementation(dir => {
      if (dir === LIVE_DIR)    return ['Raw_CardDatabase_live.mtga'];
      if (dir === BUNDLED_DIR) return ['Raw_CardDatabase_abc.mtga', 'import_sos.py'];
      return [];
    });
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: undefined }));
    fs.writeFileSync.mockImplementation(() => {});
    fs.renameSync.mockImplementation(() => {});
    mockSpawnSuccess();
  });

  test('uses the live MTGA DB, not the bundled fallback', async () => {
    await enrich();
    const spawnArgs = childProcess.spawn.mock.calls[0][1];
    expect(spawnArgs[1]).toBe(LIVE_DB);
  });
});

// ── enrich — no DB found ───────────────────────────────────────────────────

describe('enrich — no DB found anywhere', () => {
  test('returns false without calling spawn', async () => {
    fs.existsSync.mockReturnValue(false);
    fs.readdirSync.mockReturnValue([]);
    fs.readFileSync.mockReturnValue(makeCardsJson({ enrichedSets: undefined }));
    const result = await enrich();
    expect(result).toBe(false);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

// ── enrich — import script missing ────────────────────────────────────────

describe('enrich — import script missing', () => {
  test('returns false without calling spawn', async () => {
    setupFsWithBundledDb(makeCardsJson({ enrichedSets: undefined }));
    // Override: script does not exist
    fs.existsSync.mockImplementation(p => {
      return p === BUNDLED_DIR || p === CARDS_FILE; // SCRIPT_PATH excluded
    });
    const result = await enrich();
    expect(result).toBe(false);
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});

// ── enrich — Python exits with error ──────────────────────────────────────

describe('enrich — Python script exits with error', () => {
  beforeEach(() => {
    setupFsWithBundledDb(makeCardsJson({ enrichedSets: undefined }));
    mockSpawnFailure(1);
  });

  test('returns false', async () => {
    expect(await enrich()).toBe(false);
  });

  test('does not write enrichedSets to cards.json', async () => {
    await enrich();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
