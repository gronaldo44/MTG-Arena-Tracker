'use strict';

const LogParserV5 = require('../logParserV5');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TS = '[UnityCrossThreadLogger]2/27/2026 3:40:07 PM:';

function matchStartStateLine() {
  return `${TS} STATE CHANGED {"old":"Lobby","new":"Playing"}`;
}

function gameRoomLine(matchId = 'TESTMATCH') {
  return `${TS} Match to ${matchId}: MatchGameRoomStateType`;
}

function matchCompletedLine() {
  return `${TS} STATE CHANGED {"old":"Playing","new":"MatchCompleted"}`;
}

function draftNotifyLine(opts = {}) {
  const {
    draftId = 'draft-001',
    pack = 1,
    pick = 1,
    cards = [102460, 102461, 102462],
  } = opts;
  const payload = JSON.stringify({
    draftId,
    SelfPack: pack,
    SelfPick: pick,
    PackCards: cards.join(','),
  });
  return `${TS} Draft.Notify ${payload}`;
}

function draftPickLine(opts = {}) {
  const { draftId = 'draft-001', pack = 1, pick = 1, grpId = 102460 } = opts;
  const inner = JSON.stringify({ DraftId: draftId, Pack: pack, Pick: pick, GrpIds: [grpId] });
  return `${TS} EventPlayerDraftMakePick {"request":"${inner.replace(/"/g, '\\"')}"}`;
}

function inventoryLine(opts = {}) {
  const info = {
    Gems: opts.gems ?? 1000,
    Gold: opts.gold ?? 5000,
    TotalVaultProgress: opts.vault ?? 1234,
    WildCardCommons: opts.commons ?? 3,
    WildCardUnCommons: opts.uncommons ?? 2,
    WildCardRares: opts.rares ?? 1,
    WildCardMythics: opts.mythics ?? 0,
    Boosters: opts.boosters ?? [],
  };
  return JSON.stringify({ InventoryInfo: info });
}

function gameEndLine(winningTeamId) {
  return JSON.stringify({ winningTeamId });
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LogParserV5', () => {
  let parser;

  beforeEach(() => {
    parser = new LogParserV5();
  });

  // ── detectFormatFromEventName ─────────────────────────────────────────────

  describe('detectFormatFromEventName', () => {
    const cases = [
      ['Standard_Event', 'Standard'],
      ['Alchemy_Ladder', 'Alchemy'],
      ['Historic_Play', 'Historic'],
      ['Historic_Brawl', 'Historic Brawl'],
      ['Explorer_Play', 'Explorer'],
      ['Pioneer_League', 'Pioneer'],
      ['Timeless_Event', 'Timeless'],
      ['Brawl_FriendlyBrawl', 'Brawl'],
      ['Draft_QuickDraft_SOS', 'Draft'],
      ['Sealed_Event', 'Sealed'],
      ['Constructed_Event', 'Constructed'],
      ['historic_play', 'Historic'],
      ['', 'Unknown'],
      [null, 'Unknown'],
      ['WeekendChampionship', 'Unknown'],
    ];

    test.each(cases)('"%s" → "%s"', (input, expected) => {
      expect(parser.detectFormatFromEventName(input)).toBe(expected);
    });
  });

  // ── normalizeResult ───────────────────────────────────────────────────────

  describe('normalizeResult', () => {
    test('Victory → win', () => expect(parser.normalizeResult('Victory')).toBe('win'));
    test('victory (lowercase) → win', () => expect(parser.normalizeResult('victory')).toBe('win'));
    test('Defeat → loss', () => expect(parser.normalizeResult('Defeat')).toBe('loss'));
    test('Draw → draw', () => expect(parser.normalizeResult('Draw')).toBe('draw'));
    test('unknown string → unknown', () => expect(parser.normalizeResult('something')).toBe('unknown'));
    test('non-string → unknown', () => expect(parser.normalizeResult(42)).toBe('unknown'));
  });

  // ── parse() — edge cases ─────────────────────────────────────────────────

  describe('parse() edge cases', () => {
    test('empty string returns empty array', () => {
      expect(parser.parse('')).toEqual([]);
    });

    test('whitespace-only content returns empty array', () => {
      expect(parser.parse('   \n  \n  ')).toEqual([]);
    });

    test('irrelevant log content returns empty array', () => {
      const log = [
        '[UnityCrossThreadLogger]2/27/2026 3:00:00 PM: Unity initialized',
        'Some other log line',
        'No match data here',
      ].join('\n');
      expect(parser.parse(log)).toEqual([]);
    });
  });

  // ── parse() — match start ─────────────────────────────────────────────────

  describe('parse() — match start', () => {
    test('STATE CHANGED Playing produces MATCH_START event', () => {
      const events = parser.parse(matchStartStateLine());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MATCH_START');
    });

    test('MatchGameRoomStateType line produces MATCH_START event', () => {
      const events = parser.parse(gameRoomLine('MATCH-XYZ'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MATCH_START');
    });

    test('match start from STATE CHANGED does not repeat if GameRoom follows', () => {
      // STATE CHANGED fires first, setting currentMatch → GameRoom line is ignored
      const log = [matchStartStateLine(), gameRoomLine()].join('\n');
      const events = parser.parse(log);
      const starts = events.filter(e => e.type === 'MATCH_START');
      expect(starts).toHaveLength(1);
    });

    test('match data includes matchId from GameRoom line', () => {
      const events = parser.parse(gameRoomLine('MY-MATCH-ID'));
      expect(events[0].data.matchId).toBe('MY-MATCH-ID');
    });

    test('real UUID matchId is extracted from JSON when present', () => {
      const uuid = 'a1b2c3d4-1111-2222-3333-444455556666';
      const log = [
        gameRoomLine('raw-id'),
        `{"matchId":"${uuid}"}`,
      ].join('\n');
      const events = parser.parse(log);
      expect(events[0].data.matchId).toBe(uuid);
    });

    test('format is detected from InternalEventName', () => {
      const log = [
        gameRoomLine(),
        `{"InternalEventName":"Draft_QuickDraft_SOS"}`,
      ].join('\n');
      const events = parser.parse(log);
      expect(events[0].data.format).toBe('Draft');
    });
  });

  // ── parse() — match end ──────────────────────────────────────────────────

  describe('parse() — match end', () => {
    function logWithResult(resultLine) {
      return [
        gameRoomLine(),
        matchCompletedLine(),
        resultLine,
      ].join('\n');
    }

    test('Victory after MatchCompleted → win', () => {
      const events = parser.parse(logWithResult('{"resultType":"Victory"}'));
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end).toBeDefined();
      expect(end.data.result).toBe('win');
    });

    test('Defeat after MatchCompleted → loss', () => {
      const events = parser.parse(logWithResult('{"resultType":"Defeat"}'));
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('loss');
    });

    test('Draw after MatchCompleted → draw', () => {
      const events = parser.parse(logWithResult('{"resultType":"Draw"}'));
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('draw');
    });

    test('winningTeamId=1 with playerSeat=1 → win', () => {
      const log = [
        gameRoomLine(),
        '{"systemSeatIds":[1]}',     // player is seat 1
        matchCompletedLine(),
        '{"winningTeamId":1}',
      ].join('\n');
      const events = parser.parse(log);
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('win');
    });

    test('winningTeamId=2 with playerSeat=1 → loss', () => {
      const log = [
        gameRoomLine(),
        '{"systemSeatIds":[1]}',
        matchCompletedLine(),
        '{"winningTeamId":2}',
      ].join('\n');
      const events = parser.parse(log);
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('loss');
    });

    test('no result line → unknown result', () => {
      const log = [gameRoomLine(), matchCompletedLine()].join('\n');
      const events = parser.parse(log);
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('unknown');
    });

    test('MatchCompleted without a preceding MATCH_START produces no MATCH_END', () => {
      const events = parser.parse(matchCompletedLine());
      expect(events.find(e => e.type === 'MATCH_END')).toBeUndefined();
    });

    test('MATCH_END carries deckName and matchId from MATCH_START', () => {
      const log = [
        gameRoomLine('MYID'),
        `{"InternalEventName":"Standard_Event"}`,
        `{"CourseName":"My Cool Deck"}`,
        matchCompletedLine(),
        '{"resultType":"Victory"}',
      ].join('\n');
      const events = parser.parse(log);
      const end = events.find(e => e.type === 'MATCH_END');
      expect(end.data.matchId).toBe('MYID');
      expect(end.data.deckName).toBe('My Cool Deck');
    });
  });

  // ── parse() — draft ──────────────────────────────────────────────────────

  describe('parse() — draft', () => {
    test('Draft.Notify produces DRAFT_UPDATE', () => {
      const events = parser.parse(draftNotifyLine());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('DRAFT_UPDATE');
    });

    test('DRAFT_UPDATE contains draftId, pack, pick, options', () => {
      const log = draftNotifyLine({ draftId: 'd-42', pack: 2, pick: 3, cards: [100, 200, 300] });
      const events = parser.parse(log);
      const data = events[0].data;
      expect(data.draftId).toBe('d-42');
      expect(data.currentPack.pack).toBe(2);
      expect(data.currentPack.pick).toBe(3);
      expect(data.currentPack.options).toEqual([100, 200, 300]);
      expect(data.picks).toEqual([]);
    });

    test('PackCards with NaN entries are filtered out', () => {
      const line = `${TS} Draft.Notify {"draftId":"d1","SelfPack":1,"SelfPick":1,"PackCards":"100,,200,abc,300"}`;
      const events = parser.parse(line);
      expect(events[0].data.currentPack.options).toEqual([100, 200, 300]);
    });

    test('Draft.Notify missing draftId returns no event', () => {
      const line = `${TS} Draft.Notify {"SelfPack":1,"SelfPick":1,"PackCards":"100"}`;
      const events = parser.parse(line);
      expect(events).toHaveLength(0);
    });

    test('Draft.Notify with malformed JSON returns no event', () => {
      const line = `${TS} Draft.Notify {broken json`;
      const events = parser.parse(line);
      expect(events).toHaveLength(0);
    });

    test('draft pick after notify records the pick and emits DRAFT_UPDATE', () => {
      const log = [
        draftNotifyLine({ draftId: 'd1', pack: 1, pick: 1, cards: [100, 200, 300] }),
        draftPickLine({ draftId: 'd1', pack: 1, pick: 1, grpId: 100 }),
      ].join('\n');
      const events = parser.parse(log);
      const updates = events.filter(e => e.type === 'DRAFT_UPDATE');
      // One from notify, one from pick
      expect(updates).toHaveLength(2);
      const afterPick = updates[updates.length - 1];
      expect(afterPick.data.picks).toHaveLength(1);
      expect(afterPick.data.picks[0].picked).toBe(100);
    });

    test('draft pick without prior notify is ignored', () => {
      const events = parser.parse(draftPickLine());
      const updates = events.filter(e => e.type === 'DRAFT_UPDATE');
      expect(updates).toHaveLength(0);
    });

    test('sequential packs accumulate picks across Draft.Notify calls with same draftId', () => {
      const log = [
        draftNotifyLine({ draftId: 'same', pack: 1, pick: 1, cards: [10, 20] }),
        draftPickLine({ draftId: 'same', pack: 1, pick: 1, grpId: 10 }),
        draftNotifyLine({ draftId: 'same', pack: 1, pick: 2, cards: [30, 40] }),
      ].join('\n');
      const events = parser.parse(log);
      const lastUpdate = [...events].reverse().find(e => e.type === 'DRAFT_UPDATE');
      expect(lastUpdate.data.picks).toHaveLength(1);
      expect(lastUpdate.data.currentPack.pick).toBe(2);
    });

    test('new draftId resets picks', () => {
      const log = [
        draftNotifyLine({ draftId: 'draft-A', pack: 1, pick: 1 }),
        draftPickLine({ draftId: 'draft-A', pack: 1, pick: 1, grpId: 100 }),
        draftNotifyLine({ draftId: 'draft-B', pack: 1, pick: 1 }),
      ].join('\n');
      const events = parser.parse(log);
      const lastUpdate = [...events].reverse().find(e => e.type === 'DRAFT_UPDATE');
      expect(lastUpdate.data.draftId).toBe('draft-B');
      expect(lastUpdate.data.picks).toHaveLength(0);
    });
  });

  // ── parse() — inventory ──────────────────────────────────────────────────

  describe('parse() — inventory', () => {
    test('InventoryInfo line produces INVENTORY_UPDATE', () => {
      const events = parser.parse(inventoryLine());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('INVENTORY_UPDATE');
    });

    test('INVENTORY_UPDATE carries gems and gold', () => {
      const events = parser.parse(inventoryLine({ gems: 250, gold: 3000 }));
      expect(events[0].data.gems).toBe(250);
      expect(events[0].data.gold).toBe(3000);
    });

    test('INVENTORY_UPDATE carries wildcard counts', () => {
      const events = parser.parse(inventoryLine({ commons: 5, uncommons: 4, rares: 3, mythics: 1 }));
      const d = events[0].data;
      expect(d.wildCardCommons).toBe(5);
      expect(d.wildCardUnCommons).toBe(4);
      expect(d.wildCardRares).toBe(3);
      expect(d.wildCardMythics).toBe(1);
    });

    test('INVENTORY_UPDATE has a timestamp string', () => {
      const events = parser.parse(inventoryLine());
      expect(typeof events[0].data.timestamp).toBe('string');
    });

    test('non-InventoryInfo JSON is ignored', () => {
      const events = parser.parse('{"SomeOtherKey":{"Gems":999}}');
      expect(events).toHaveLength(0);
    });
  });

  // ── parse() — game end ───────────────────────────────────────────────────

  describe('parse() — game end', () => {
    test('winningTeamId line produces GAME_END', () => {
      const events = parser.parse(gameEndLine(1));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('GAME_END');
    });

    test('GAME_END sets pendingResult on the parser', () => {
      parser.playerSeatId = 1;
      parser.parseLine(gameEndLine(1), [], 0);
      expect(parser.pendingResult).toBe('win');
    });

    test('winningTeamId != playerSeat → pendingResult is loss', () => {
      parser.playerSeatId = 1;
      parser.parseLine(gameEndLine(2), [], 0);
      expect(parser.pendingResult).toBe('loss');
    });
  });

  // ── deduplication ────────────────────────────────────────────────────────

  describe('deduplication', () => {
    test('same MATCH_START log parsed twice still yields one MATCH_START', () => {
      const log = gameRoomLine('DUP-ID');
      parser.parse(log);
      const events = parser.parse(log);
      const starts = events.filter(e => e.type === 'MATCH_START');
      expect(starts).toHaveLength(1);
    });

    test('DRAFT_UPDATE events are never deduplicated (always pass through)', () => {
      const log = draftNotifyLine();
      const first = parser.parse(log);
      const second = parser.parse(log);
      // Each parse call rebuilds state from scratch — both should yield 1 DRAFT_UPDATE
      expect(first.filter(e => e.type === 'DRAFT_UPDATE')).toHaveLength(1);
      expect(second.filter(e => e.type === 'DRAFT_UPDATE')).toHaveLength(1);
    });

    test('INVENTORY_UPDATE is keyed by timestamp so multiple can appear', () => {
      // Two separate parse() calls guarantee different toISOString() timestamps,
      // so neither is deduplicated against the other.
      const first  = parser.parse(inventoryLine({ gems: 100 }));
      const second = parser.parse(inventoryLine({ gems: 200 }));
      expect(first.filter(e => e.type === 'INVENTORY_UPDATE')).toHaveLength(1);
      expect(second.filter(e => e.type === 'INVENTORY_UPDATE')).toHaveLength(1);
    });
  });

  // ── end-to-end log sequence ──────────────────────────────────────────────

  describe('end-to-end sequence', () => {
    test('full match: start → game end → match completed → produces expected events', () => {
      const log = [
        gameRoomLine('FULL-MATCH'),
        '{"InternalEventName":"Historic_Play"}',
        '{"winningTeamId":1}',
        matchCompletedLine(),
      ].join('\n');

      const events = parser.parse(log);
      const types = events.map(e => e.type);

      expect(types).toContain('MATCH_START');
      expect(types).toContain('GAME_END');
      expect(types).toContain('MATCH_END');

      const start = events.find(e => e.type === 'MATCH_START');
      const end = events.find(e => e.type === 'MATCH_END');

      expect(start.data.format).toBe('Historic');
      expect(end.data.matchId).toBe('FULL-MATCH');
      expect(end.data.result).toBe('win');
    });
  });
});
