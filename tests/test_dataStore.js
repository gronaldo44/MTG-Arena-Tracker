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
});
