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

  test('atomic write: stranded drafts.json.tmp from a prior crash is cleaned up on next write', () => {
    const dataDir = path.join(MOCK_USERDATA, 'data');
    const draftsFile = path.join(dataDir, 'drafts.json');
    const tmpFile = draftsFile + '.tmp';
    // Simulate a crash that left a stale .tmp behind.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tmpFile, 'garbage from a prior crash');
    expect(fs.existsSync(tmpFile)).toBe(true);

    ds.upsertDraft({
      draftId: 'd1',
      picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }],
      currentPack: null,
    });

    expect(fs.existsSync(draftsFile)).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  test('loadDrafts: corrupt drafts.json is treated as empty (returns {} → getAllDrafts is [])', () => {
    const dataDir = path.join(MOCK_USERDATA, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'drafts.json'), '{not valid json');
    // Suppress the expected error log so the test output stays clean.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ds2 = new DataStore();
    expect(ds2.getAllDrafts()).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
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

  test('getDraftSummaries — sorted by startedAt descending', () => {
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
});

// ── Helpers for importFromDirectory tests ─────────────────────────────────

function writeBackupFiles(backupDir, { matches, cardStats, drafts, settings } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });

  if (matches !== undefined)
    fs.writeFileSync(path.join(backupDir, 'matches.json'), JSON.stringify(matches));
  if (cardStats !== undefined)
    fs.writeFileSync(path.join(backupDir, 'cardStats.json'), JSON.stringify(cardStats));
  if (drafts !== undefined)
    fs.writeFileSync(path.join(backupDir, 'drafts.json'), JSON.stringify(drafts));
  if (settings !== undefined)
    fs.writeFileSync(path.join(backupDir, 'settings.json'), JSON.stringify(settings));
}

// ── importFromDirectory ────────────────────────────────────────────────────

describe('DataStore — importFromDirectory', () => {
  let ds;
  let backupDir;

  beforeEach(() => {
    MOCK_USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-ds-'));
    backupDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-backup-'));
    ds = new DataStore();
  });

  afterEach(() => {
    fs.rmSync(MOCK_USERDATA, { recursive: true, force: true });
    fs.rmSync(backupDir,     { recursive: true, force: true });
  });

  // ── matches ───────────────────────────────────────────────────────────────

  test('imports matches from matches.json', () => {
    writeBackupFiles(backupDir, {
      matches: { matches: [{ id: 'm1', result: 'win' }], decks: {} },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getMatches()).toHaveLength(1);
    expect(ds.getMatches()[0].id).toBe('m1');
  });

  test('skips duplicate matches already present', () => {
    ds.data.matches.push({ id: 'm1', result: 'win' });
    ds.saveData();
    writeBackupFiles(backupDir, {
      matches: {
        matches: [
          { id: 'm1', result: 'win' },
          { id: 'm2', result: 'loss' },
        ],
        decks: {},
      },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getMatches()).toHaveLength(2);
  });

  test('imports decks from matches.json', () => {
    writeBackupFiles(backupDir, {
      matches: { matches: [], decks: { 'Mono Red': { name: 'Mono Red' } } },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getDeck('Mono Red')).toMatchObject({ name: 'Mono Red' });
  });

  test('persists imported matches to disk', () => {
    writeBackupFiles(backupDir, {
      matches: { matches: [{ id: 'm1', result: 'win' }], decks: {} },
    });
    ds.importFromDirectory(backupDir);
    const ds2 = new DataStore();
    expect(ds2.getMatches()).toHaveLength(1);
  });

  // ── cardStats ─────────────────────────────────────────────────────────────

  test('imports card stats from cardStats.json', () => {
    writeBackupFiles(backupDir, {
      cardStats: {
        processedGames: ['game1'],
        statsByFormat: {
          'Premier_Draft_SOS': {
            '102460': { gamesInDeck: 5, gamesInHand: 3, gamesWonInHand: 2,
                        gamesOpenHand: 1, gamesWonOpenHand: 1 },
          },
        },
      },
    });
    ds.importFromDirectory(backupDir);
    const stats = ds.getAllCardGameStats('Premier_Draft_SOS');
    expect(stats['102460'].gamesInDeck).toBe(5);
    expect(stats['102460'].gamesInHand).toBe(3);
  });

  test('accumulates card stats when the same grpId already has data', () => {
    ds.cardStats.statsByFormat['Premier_Draft_SOS'] = {
      '102460': { gamesInDeck: 2, gamesInHand: 2, gamesWonInHand: 1,
                  gamesOpenHand: 1, gamesWonOpenHand: 0 },
    };
    writeBackupFiles(backupDir, {
      cardStats: {
        processedGames: [],
        statsByFormat: {
          'Premier_Draft_SOS': {
            '102460': { gamesInDeck: 3, gamesInHand: 3, gamesWonInHand: 2,
                        gamesOpenHand: 2, gamesWonOpenHand: 1 },
          },
        },
      },
    });
    ds.importFromDirectory(backupDir);
    const s = ds.getAllCardGameStats('Premier_Draft_SOS')['102460'];
    expect(s.gamesInDeck).toBe(5);
    expect(s.gamesInHand).toBe(5);
    expect(s.gamesWonInHand).toBe(3);
  });

  test('merges card stats formats that did not previously exist', () => {
    writeBackupFiles(backupDir, {
      cardStats: {
        processedGames: [],
        statsByFormat: {
          'Quick_Draft_SOS':   { '102460': { gamesInDeck: 1, gamesInHand: 1, gamesWonInHand: 0, gamesOpenHand: 0, gamesWonOpenHand: 0 } },
          'Premier_Draft_SOS': { '102461': { gamesInDeck: 2, gamesInHand: 2, gamesWonInHand: 1, gamesOpenHand: 1, gamesWonOpenHand: 0 } },
        },
      },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getAllCardGameStats('Quick_Draft_SOS')['102460'].gamesInDeck).toBe(1);
    expect(ds.getAllCardGameStats('Premier_Draft_SOS')['102461'].gamesInDeck).toBe(2);
  });

  test('persists imported card stats to disk', () => {
    writeBackupFiles(backupDir, {
      cardStats: {
        processedGames: ['g1'],
        statsByFormat: { 'Premier_Draft_SOS': { '102460': { gamesInDeck: 4, gamesInHand: 2, gamesWonInHand: 1, gamesOpenHand: 1, gamesWonOpenHand: 0 } } },
      },
    });
    ds.importFromDirectory(backupDir);
    const ds2 = new DataStore();
    expect(ds2.getAllCardGameStats('Premier_Draft_SOS')['102460'].gamesInDeck).toBe(4);
  });

  // ── drafts ────────────────────────────────────────────────────────────────

  test('imports drafts from drafts.json', () => {
    writeBackupFiles(backupDir, {
      drafts: { drafts: { 'draft-1': { draftId: 'draft-1', startedAt: 1000, picks: [] } } },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getDraft('draft-1')).toMatchObject({ draftId: 'draft-1' });
  });

  test('skips drafts that already exist', () => {
    ds.upsertDraft({ draftId: 'draft-1', picks: [{ pack: 1, pick: 1, options: [10], picked: 10 }], currentPack: null });
    writeBackupFiles(backupDir, {
      drafts: { drafts: { 'draft-1': { draftId: 'draft-1', startedAt: 999, picks: [] } } },
    });
    ds.importFromDirectory(backupDir);
    // Original picks should be preserved, not overwritten by the empty backup
    expect(ds.getDraft('draft-1').picks).toHaveLength(1);
  });

  test('persists imported drafts to disk', () => {
    writeBackupFiles(backupDir, {
      drafts: { drafts: { 'draft-1': { draftId: 'draft-1', startedAt: 1000, picks: [] } } },
    });
    ds.importFromDirectory(backupDir);
    const ds2 = new DataStore();
    expect(ds2.getDraft('draft-1')).not.toBeNull();
  });

  // ── settings ──────────────────────────────────────────────────────────────

  test('imports settings from settings.json', () => {
    writeBackupFiles(backupDir, {
      settings: { logPath: 'C:\\Users\\user\\log.txt', minimizeToTray: false },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getSettings().logPath).toBe('C:\\Users\\user\\log.txt');
    expect(ds.getSettings().minimizeToTray).toBe(false);
  });

  test('does not import mtgaDbPath from settings (likely stale after reinstall)', () => {
    writeBackupFiles(backupDir, {
      settings: { logPath: 'C:\\log.txt', mtgaDbPath: 'C:\\old\\path\\Raw_CardDatabase.mtga' },
    });
    ds.importFromDirectory(backupDir);
    expect(ds.getSettings().mtgaDbPath || '').toBe('');
  });

  // ── missing files ─────────────────────────────────────────────────────────

  test('handles an empty backup directory without throwing', () => {
    expect(() => ds.importFromDirectory(backupDir)).not.toThrow();
  });

  test('imports only the files that are present (partial backup)', () => {
    writeBackupFiles(backupDir, {
      matches: { matches: [{ id: 'm1', result: 'win' }], decks: {} },
      // cardStats, drafts, settings intentionally absent
    });
    expect(() => ds.importFromDirectory(backupDir)).not.toThrow();
    expect(ds.getMatches()).toHaveLength(1);
  });
});

// ─── Migration: _backfillPremierDraft ─────────────────────────────────────────

describe('DataStore — _backfillPremierDraft migration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir       = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-ds-mig-'));
    MOCK_USERDATA = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMatches(matches) {
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'matches.json'), JSON.stringify({ matches, decks: {} }));
  }

  function writeCardStats(statsByFormat) {
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'cardStats.json'), JSON.stringify({
      processedGames: [],
      statsByFormat,
    }));
  }

  test('"[Set] Draft" match format is upgraded to "Premier Draft [Set]"', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Secrets of Strixhaven Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft Secrets of Strixhaven');
  });

  test('bare "Draft" format is upgraded to "Premier Draft"', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft');
  });

  test('Quick Draft format is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Strixhaven Quick Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Strixhaven Quick Draft');
  });

  test('Traditional Draft format is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Strixhaven Traditional Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Strixhaven Traditional Draft');
  });

  test('Sealed format is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Strixhaven Sealed' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Strixhaven Sealed');
  });

  test('already-correct "Premier Draft [Set]" is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Premier Draft Secrets of Strixhaven' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft Secrets of Strixhaven');
  });

  test('cardStats key "[Set] Draft" is renamed to "Premier Draft [Set]"', () => {
    writeMatches([]);
    writeCardStats({
      'Secrets of Strixhaven Draft': { '111': { gamesInDeck: 5, gamesInHand: 3, gamesWon: 2, gamesOpenHand: 1, gamesWonOpenHand: 1 } },
    });
    const ds = new DataStore();
    expect(ds.cardStats.statsByFormat['Premier Draft Secrets of Strixhaven']).toBeDefined();
    expect(ds.cardStats.statsByFormat['Secrets of Strixhaven Draft']).toBeUndefined();
    expect(ds.cardStats.statsByFormat['Premier Draft Secrets of Strixhaven']['111'].gamesInDeck).toBe(5);
  });

  test('cardStats for non-draft formats are not changed', () => {
    writeMatches([]);
    writeCardStats({ 'Standard': { '222': { gamesInDeck: 1, gamesInHand: 0, gamesWon: 0, gamesOpenHand: 0, gamesWonOpenHand: 0 } } });
    const ds = new DataStore();
    expect(ds.cardStats.statsByFormat['Standard']).toBeDefined();
  });
});

// ─── Migration: _reorderPremierDraft ─────────────────────────────────────────

describe('DataStore — _reorderPremierDraft migration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir        = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-ds-reorder-'));
    MOCK_USERDATA = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeMatches(matches) {
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'matches.json'), JSON.stringify({ matches, decks: {} }));
  }

  function writeCardStats(statsByFormat) {
    const dataDir = path.join(tmpDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'cardStats.json'), JSON.stringify({
      processedGames: [],
      statsByFormat,
    }));
  }

  test('"[Set] Premier Draft" is reordered to "Premier Draft [Set]"', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Secrets of Strixhaven Premier Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft Secrets of Strixhaven');
  });

  test('already-correct "Premier Draft [Set]" is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Premier Draft Secrets of Strixhaven' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft Secrets of Strixhaven');
  });

  test('bare "Premier Draft" (no set name) is not changed', () => {
    writeMatches([{ id: '1', matchId: 'x', result: 'win', format: 'Premier Draft' }]);
    const ds = new DataStore();
    expect(ds.getMatches()[0].format).toBe('Premier Draft');
  });

  test('cardStats key "[Set] Premier Draft" is reordered', () => {
    writeMatches([]);
    writeCardStats({
      'Secrets of Strixhaven Premier Draft': { '333': { gamesInDeck: 3, gamesInHand: 2, gamesWon: 1, gamesOpenHand: 0, gamesWonOpenHand: 0 } },
    });
    const ds = new DataStore();
    expect(ds.cardStats.statsByFormat['Premier Draft Secrets of Strixhaven']).toBeDefined();
    expect(ds.cardStats.statsByFormat['Secrets of Strixhaven Premier Draft']).toBeUndefined();
  });

  test('multiple matches across both old formats are all migrated in one pass', () => {
    writeMatches([
      { id: '1', matchId: 'a', result: 'win',  format: 'Secrets of Strixhaven Premier Draft' },
      { id: '2', matchId: 'b', result: 'loss', format: 'Secrets of Strixhaven Premier Draft' },
      { id: '3', matchId: 'c', result: 'win',  format: 'Premier Draft Secrets of Strixhaven' },
    ]);
    const ds = new DataStore();
    const formats = ds.getMatches().map(m => m.format);
    expect(formats.every(f => f === 'Premier Draft Secrets of Strixhaven')).toBe(true);
  });
});
