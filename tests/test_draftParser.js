'use strict';

const DraftParser = require('../parser/draftParser');
const LogParserV5 = require('../logParserV5');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TS = '[UnityCrossThreadLogger]2/27/2026 3:40:07 PM:';

function draftNotifyLine(opts = {}) {
  const {
    draftId = 'draft-001',
    pack    = 1,
    pick    = 1,
    cards   = [102460, 102461, 102462],
  } = opts;
  const payload = JSON.stringify({
    draftId,
    SelfPack:  pack,
    SelfPick:  pick,
    PackCards: cards.join(','),
  });
  return `${TS} Draft.Notify ${payload}`;
}

function draftPickLine(opts = {}) {
  const { draftId = 'draft-001', pack = 1, pick = 1, grpId = 102460 } = opts;
  const inner = JSON.stringify({ DraftId: draftId, Pack: pack, Pick: pick, GrpIds: [grpId] });
  return `${TS} EventPlayerDraftMakePick {"request":"${inner.replace(/"/g, '\\"')}"}`;
}

// ─── DraftParser unit tests ───────────────────────────────────────────────────

describe('DraftParser', () => {
  let parser;

  beforeEach(() => {
    parser = new DraftParser();
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  describe('reset', () => {
    test('reset clears currentDraft', () => {
      parser.currentDraft = { draftId: 'x' };
      parser.reset();
      expect(parser.currentDraft).toBeNull();
    });
  });

  // ── handleDraftNotify ─────────────────────────────────────────────────────

  describe('handleDraftNotify', () => {
    test('returns DRAFT_UPDATE event', () => {
      const event = parser.parseLine(draftNotifyLine());
      expect(event).not.toBeNull();
      expect(event.type).toBe('DRAFT_UPDATE');
    });

    test('event contains draftId, pack, pick, options', () => {
      const event = parser.parseLine(draftNotifyLine({ draftId: 'd-42', pack: 2, pick: 3, cards: [100, 200, 300] }));
      const data  = event.data;
      expect(data.draftId).toBe('d-42');
      expect(data.currentPack.pack).toBe(2);
      expect(data.currentPack.pick).toBe(3);
      expect(data.currentPack.options).toEqual([100, 200, 300]);
      expect(data.picks).toEqual([]);
    });

    test('PackCards with NaN entries are filtered out', () => {
      const line  = `${TS} Draft.Notify {"draftId":"d1","SelfPack":1,"SelfPick":1,"PackCards":"100,,200,abc,300"}`;
      const event = parser.parseLine(line);
      expect(event.data.currentPack.options).toEqual([100, 200, 300]);
    });

    test('missing draftId returns null', () => {
      const line = `${TS} Draft.Notify {"SelfPack":1,"SelfPick":1,"PackCards":"100"}`;
      expect(parser.parseLine(line)).toBeNull();
    });

    test('malformed JSON returns null', () => {
      const line = `${TS} Draft.Notify {broken json`;
      expect(parser.parseLine(line)).toBeNull();
    });

    test('new draftId resets picks', () => {
      parser.parseLine(draftNotifyLine({ draftId: 'A', pack: 1, pick: 1, cards: [10] }));
      parser.parseLine(draftPickLine({ draftId: 'A', pack: 1, pick: 1, grpId: 10 }));
      const event = parser.parseLine(draftNotifyLine({ draftId: 'B', pack: 1, pick: 1, cards: [20] }));
      expect(event.data.draftId).toBe('B');
      expect(event.data.picks).toHaveLength(0);
    });

    test('same draftId preserves existing picks', () => {
      parser.parseLine(draftNotifyLine({ draftId: 'same', pack: 1, pick: 1, cards: [10, 20] }));
      parser.parseLine(draftPickLine({ draftId: 'same', pack: 1, pick: 1, grpId: 10 }));
      const event = parser.parseLine(draftNotifyLine({ draftId: 'same', pack: 1, pick: 2, cards: [30, 40] }));
      expect(event.data.picks).toHaveLength(1);
      expect(event.data.currentPack.pick).toBe(2);
    });
  });

  // ── handleDraftPick ───────────────────────────────────────────────────────

  describe('handleDraftPick', () => {
    test('pick after notify records the pick and emits DRAFT_UPDATE', () => {
      parser.parseLine(draftNotifyLine({ draftId: 'd1', pack: 1, pick: 1, cards: [100, 200] }));
      const event = parser.parseLine(draftPickLine({ draftId: 'd1', pack: 1, pick: 1, grpId: 100 }));
      expect(event.type).toBe('DRAFT_UPDATE');
      expect(event.data.picks).toHaveLength(1);
      expect(event.data.picks[0].picked).toBe(100);
    });

    test('pick without prior notify returns null', () => {
      expect(parser.parseLine(draftPickLine())).toBeNull();
    });

    test('pick carries pack/pick index', () => {
      parser.parseLine(draftNotifyLine({ draftId: 'd1', pack: 2, pick: 5, cards: [50] }));
      const event = parser.parseLine(draftPickLine({ draftId: 'd1', pack: 2, pick: 5, grpId: 50 }));
      expect(event.data.picks[0].pack).toBe(2);
      expect(event.data.picks[0].pick).toBe(5);
    });
  });
});

// ─── Integration: draft events through LogParserV5 ────────────────────────────

describe('LogParserV5 — draft events', () => {
  let parser;

  beforeEach(() => {
    parser = new LogParserV5();
  });

  test('Draft.Notify produces DRAFT_UPDATE', () => {
    const events = parser.parse(draftNotifyLine());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('DRAFT_UPDATE');
  });

  test('draft pick after notify records the pick', () => {
    const log = [
      draftNotifyLine({ draftId: 'd1', pack: 1, pick: 1, cards: [100, 200, 300] }),
      draftPickLine({ draftId: 'd1', pack: 1, pick: 1, grpId: 100 }),
    ].join('\n');
    const updates = parser.parse(log).filter(e => e.type === 'DRAFT_UPDATE');
    expect(updates).toHaveLength(2);
    expect(updates[updates.length - 1].data.picks).toHaveLength(1);
    expect(updates[updates.length - 1].data.picks[0].picked).toBe(100);
  });

  test('draft pick without prior notify is ignored', () => {
    expect(parser.parse(draftPickLine()).filter(e => e.type === 'DRAFT_UPDATE')).toHaveLength(0);
  });

  test('DRAFT_UPDATE events are never deduplicated across parse() calls', () => {
    const log = draftNotifyLine();
    const first  = parser.parse(log).filter(e => e.type === 'DRAFT_UPDATE');
    const second = parser.parse(log).filter(e => e.type === 'DRAFT_UPDATE');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });
});
