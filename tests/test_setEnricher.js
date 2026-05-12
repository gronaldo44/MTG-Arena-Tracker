'use strict';

jest.mock('fs');

const fs   = require('fs');
const path = require('path');

const ENRICHMENT_FILE = path.resolve(__dirname, '..', 'sos-card-data.json');
const CARDS_FILE      = path.resolve(__dirname, '..', 'cards.json');

const { needsEnrichment, enrich } = require('../setEnricher');

// ── Helpers ────────────────────────────────────────────────────────────────

const ENRICHMENT_DATA = {
  setCodes: ['SOS', 'SOA'],
  cards: {
    '102460': { name: 'Opt',       manaCost: '{U}', type: 'Instant',  set: 'SOS', digitalReleaseSet: '' },
    '102461': { name: 'Lightning', manaCost: '{R}', type: 'Instant',  set: 'SOS', digitalReleaseSet: '' },
    '102462': { name: 'Archive',   manaCost: '{W}', type: 'Sorcery',  set: 'SOA', digitalReleaseSet: '' },
  },
  mainDraftSets: [
    { code: 'SOS', primaryCount: 281, firstGrpId: 102460 },
    { code: 'FDN', primaryCount: 272, firstGrpId: 90000  },
  ],
};

function makeCardsJson(overrides = {}) {
  const base = {
    cards: {},
    mainDraftSets: [{ code: 'SOS', primaryCount: 281, firstGrpId: 102460 }],
    enrichedSets:  ['SOS', 'SOA'],
  };
  const merged = { ...base, ...overrides };
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  return JSON.stringify(merged);
}

function setupFs({ cardsJson = makeCardsJson(), enrichmentJson = JSON.stringify(ENRICHMENT_DATA) } = {}) {
  fs.readFileSync.mockImplementation(filePath => {
    if (String(filePath) === ENRICHMENT_FILE) {
      if (enrichmentJson === null) throw new Error('ENOENT');
      return enrichmentJson;
    }
    if (String(filePath) === CARDS_FILE) {
      if (cardsJson === null) throw new Error('ENOENT');
      return cardsJson;
    }
    return '';
  });
  fs.writeFileSync.mockImplementation(() => {});
  fs.renameSync.mockImplementation(() => {});
}

beforeEach(() => jest.clearAllMocks());

// ── needsEnrichment ────────────────────────────────────────────────────────

describe('needsEnrichment', () => {
  test('returns false when enrichedSets contains all setCodes and mainDraftSets is non-empty', () => {
    setupFs();
    expect(needsEnrichment()).toBe(false);
  });

  test('returns true when enrichedSets is absent', () => {
    setupFs({ cardsJson: makeCardsJson({ enrichedSets: undefined }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when mainDraftSets is empty', () => {
    setupFs({ cardsJson: makeCardsJson({ mainDraftSets: [] }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when mainDraftSets is absent', () => {
    setupFs({ cardsJson: makeCardsJson({ mainDraftSets: undefined }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when SOS is missing from enrichedSets', () => {
    setupFs({ cardsJson: makeCardsJson({ enrichedSets: ['SOA'] }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when SOA is missing from enrichedSets', () => {
    setupFs({ cardsJson: makeCardsJson({ enrichedSets: ['SOS'] }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json cannot be read', () => {
    setupFs({ cardsJson: null });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json contains invalid JSON', () => {
    setupFs({ cardsJson: 'not-valid-json{{' });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns false (cannot enrich) when enrichment bundle is missing', () => {
    // If the bundle is gone we skip rather than crash.
    setupFs({ enrichmentJson: null });
    expect(needsEnrichment()).toBe(false);
  });
});

// ── needsEnrichment — empty card database ─────────────────────────────────

describe('needsEnrichment — empty card database', () => {
  test('returns true when cards.json has only an empty cards object', () => {
    setupFs({ cardsJson: JSON.stringify({ cards: {} }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json has cards but no mainDraftSets', () => {
    setupFs({ cardsJson: JSON.stringify({ cards: { 12345: { name: 'Lightning Bolt' } } }) });
    expect(needsEnrichment()).toBe(true);
  });

  test('returns true when cards.json has cards and mainDraftSets but no enrichedSets', () => {
    setupFs({ cardsJson: JSON.stringify({
      cards: { 12345: { name: 'Lightning Bolt' } },
      mainDraftSets: [{ code: 'SOS' }],
    }) });
    expect(needsEnrichment()).toBe(true);
  });
});

// ── enrich — skips when up to date ────────────────────────────────────────

describe('enrich — skips when already up to date', () => {
  test('returns false and does not write files', async () => {
    setupFs();
    expect(await enrich()).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ── enrich — merges enrichment data ───────────────────────────────────────

describe('enrich — merges enrichment bundle into cards.json', () => {
  beforeEach(() => {
    setupFs({ cardsJson: makeCardsJson({ enrichedSets: undefined, mainDraftSets: [] }) });
  });

  test('returns true', async () => {
    expect(await enrich()).toBe(true);
  });

  test('writes SOS and SOA to enrichedSets', async () => {
    await enrich();
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.enrichedSets).toContain('SOS');
    expect(written.enrichedSets).toContain('SOA');
  });

  test('adds new cards from the enrichment bundle', async () => {
    await enrich();
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.cards['102460']).toMatchObject({ name: 'Opt', manaCost: '{U}' });
    expect(written.cards['102461']).toMatchObject({ name: 'Lightning', manaCost: '{R}' });
    expect(written.cards['102462']).toMatchObject({ name: 'Archive', manaCost: '{W}' });
  });

  test('writes mainDraftSets from the enrichment bundle', async () => {
    await enrich();
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.mainDraftSets).toEqual(ENRICHMENT_DATA.mainDraftSets);
  });

  test('atomically renames the tmp file over cards.json', async () => {
    await enrich();
    const [from, to] = fs.renameSync.mock.calls[0];
    expect(from).toBe(CARDS_FILE + '.tmp');
    expect(to).toBe(CARDS_FILE);
  });

  test('preserves existing cards not in the enrichment bundle', async () => {
    setupFs({
      cardsJson: JSON.stringify({
        cards: { '99999': { name: 'Lightning Bolt', manaCost: '{R}', type: 'Instant' } },
        mainDraftSets: [],
      }),
    });
    await enrich();
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written.cards['99999']).toMatchObject({ name: 'Lightning Bolt' });
  });

  test('does not overwrite a card that already has a manaCost', async () => {
    setupFs({
      cardsJson: JSON.stringify({
        cards: { '102460': { name: 'Opt (Scryfall)', manaCost: '{U}', type: 'Instant' } },
        mainDraftSets: [],
      }),
    });
    await enrich();
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    // Name should be the pre-existing Scryfall value, not overwritten.
    expect(written.cards['102460'].name).toBe('Opt (Scryfall)');
  });
});

// ── enrich — force option ─────────────────────────────────────────────────

describe('enrich — force option bypasses needsEnrichment check', () => {
  test('runs even when already enriched', async () => {
    setupFs(); // looks fully enriched
    expect(await enrich({ force: true })).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });
});

// ── enrich — missing enrichment bundle ────────────────────────────────────

describe('enrich — missing enrichment bundle', () => {
  test('returns false without writing files', async () => {
    setupFs({ cardsJson: makeCardsJson({ enrichedSets: undefined }), enrichmentJson: null });
    expect(await enrich()).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
