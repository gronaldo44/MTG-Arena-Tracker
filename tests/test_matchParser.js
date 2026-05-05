'use strict';

const MatchParser  = require('../parser/matchParser');
const LogParserV5  = require('../logParserV5');

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

function inventoryLine(opts = {}) {
  const info = {
    Gems: opts.gems ?? 1000,
    Gold: opts.gold ?? 5000,
    TotalVaultProgress: opts.vault ?? 1234,
    WildCardCommons:    opts.commons    ?? 3,
    WildCardUnCommons:  opts.uncommons  ?? 2,
    WildCardRares:      opts.rares      ?? 1,
    WildCardMythics:    opts.mythics    ?? 0,
    Boosters:           opts.boosters   ?? [],
  };
  return JSON.stringify({ InventoryInfo: info });
}

function gameEndLine(winningTeamId) {
  return JSON.stringify({ winningTeamId });
}

// ─── MatchParser unit tests ───────────────────────────────────────────────────

describe('MatchParser', () => {
  let parser;

  beforeEach(() => {
    parser = new MatchParser();
  });

  // ── detectFormatFromEventName ─────────────────────────────────────────────

  describe('detectFormatFromEventName', () => {
    const cases = [
      ['Standard_Event',        'Standard'],
      ['Alchemy_Ladder',        'Alchemy'],
      ['Historic_Play',         'Historic'],
      ['Historic_Brawl',        'Historic Brawl'],
      ['Explorer_Play',         'Explorer'],
      ['Pioneer_League',        'Pioneer'],
      ['Timeless_Event',        'Timeless'],
      ['Brawl_FriendlyBrawl',   'Brawl'],
      ['Draft_QuickDraft_SOS',  'Secrets of Strixhaven Quick Draft'],
      ['Sealed_Event',          'Sealed'],
      ['Constructed_Event',     'Constructed'],
      ['historic_play',         'Historic'],
      ['',                      'Unknown'],
      [null,                    'Unknown'],
      ['WeekendChampionship',   'Unknown'],
    ];

    test.each(cases)('"%s" → "%s"', (input, expected) => {
      expect(parser.detectFormatFromEventName(input)).toBe(expected);
    });
  });

  // ── normalizeResult ───────────────────────────────────────────────────────

  describe('normalizeResult', () => {
    test('Victory → win',              () => expect(parser.normalizeResult('Victory')).toBe('win'));
    test('victory (lowercase) → win',  () => expect(parser.normalizeResult('victory')).toBe('win'));
    test('Defeat → loss',              () => expect(parser.normalizeResult('Defeat')).toBe('loss'));
    test('Draw → draw',                () => expect(parser.normalizeResult('Draw')).toBe('draw'));
    test('unknown string → unknown',   () => expect(parser.normalizeResult('something')).toBe('unknown'));
    test('non-string → unknown',       () => expect(parser.normalizeResult(42)).toBe('unknown'));
  });

  // ── parseLine — game end ──────────────────────────────────────────────────

  describe('parseLine — game end', () => {
    test('winningTeamId=1 with playerSeat=1 sets pendingResult win', () => {
      parser.playerSeatId = 1;
      parser.parseLine(gameEndLine(1), [], 0);
      expect(parser.pendingResult).toBe('win');
    });

    test('winningTeamId=2 with playerSeat=1 sets pendingResult loss', () => {
      parser.playerSeatId = 1;
      parser.parseLine(gameEndLine(2), [], 0);
      expect(parser.pendingResult).toBe('loss');
    });
  });

  // ── reset ─────────────────────────────────────────────────────────────────

  describe('reset', () => {
    test('reset clears currentMatch and pendingResult', () => {
      parser.currentMatch  = { matchId: 'x' };
      parser.pendingResult = 'win';
      parser.reset();
      expect(parser.currentMatch).toBeNull();
      expect(parser.pendingResult).toBeNull();
    });

    test('reset preserves deckNames cache', () => {
      parser.deckNames.set('SomeEvent', 'Cool Deck');
      parser.reset();
      expect(parser.deckNames.get('SomeEvent')).toBe('Cool Deck');
    });
  });
});

// ─── Integration: match events through LogParserV5 ────────────────────────────

describe('LogParserV5 — match events', () => {
  let parser;

  beforeEach(() => {
    parser = new LogParserV5();
  });

  // ── parse edge cases ──────────────────────────────────────────────────────

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
      ].join('\n');
      expect(parser.parse(log)).toEqual([]);
    });
  });

  // ── match start ───────────────────────────────────────────────────────────

  describe('parse() — match start', () => {
    test('STATE CHANGED Playing produces MATCH_START', () => {
      const events = parser.parse(matchStartStateLine());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MATCH_START');
    });

    test('MatchGameRoomStateType line produces MATCH_START', () => {
      const events = parser.parse(gameRoomLine('MATCH-XYZ'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('MATCH_START');
    });

    test('STATE CHANGED first then GameRoom → only one MATCH_START', () => {
      const log = [matchStartStateLine(), gameRoomLine()].join('\n');
      const starts = parser.parse(log).filter(e => e.type === 'MATCH_START');
      expect(starts).toHaveLength(1);
    });

    test('matchId extracted from GameRoom line', () => {
      const events = parser.parse(gameRoomLine('MY-MATCH-ID'));
      expect(events[0].data.matchId).toBe('MY-MATCH-ID');
    });

    test('real UUID matchId extracted from JSON when present', () => {
      const uuid = 'a1b2c3d4-1111-2222-3333-444455556666';
      const log = [gameRoomLine('raw-id'), `{"matchId":"${uuid}"}`].join('\n');
      expect(parser.parse(log)[0].data.matchId).toBe(uuid);
    });

    test('format detected from InternalEventName', () => {
      const log = [gameRoomLine(), `{"InternalEventName":"Draft_QuickDraft_SOS"}`].join('\n');
      expect(parser.parse(log)[0].data.format).toBe('Secrets of Strixhaven Quick Draft');
    });
  });

  // ── match end ─────────────────────────────────────────────────────────────

  describe('parse() — match end', () => {
    function logWithResult(resultLine) {
      return [gameRoomLine(), matchCompletedLine(), resultLine].join('\n');
    }

    test('Victory after MatchCompleted → win', () => {
      const end = parser.parse(logWithResult('{"resultType":"Victory"}')).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('win');
    });

    test('Defeat after MatchCompleted → loss', () => {
      const end = parser.parse(logWithResult('{"resultType":"Defeat"}')).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('loss');
    });

    test('Draw after MatchCompleted → draw', () => {
      const end = parser.parse(logWithResult('{"resultType":"Draw"}')).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('draw');
    });

    test('winningTeamId=1 with playerSeat=1 → win', () => {
      const log = [gameRoomLine(), '{"systemSeatIds":[1]}', matchCompletedLine(), '{"winningTeamId":1}'].join('\n');
      const end = parser.parse(log).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('win');
    });

    test('winningTeamId=2 with playerSeat=1 → loss', () => {
      const log = [gameRoomLine(), '{"systemSeatIds":[1]}', matchCompletedLine(), '{"winningTeamId":2}'].join('\n');
      const end = parser.parse(log).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('loss');
    });

    test('no result line → unknown result', () => {
      const end = parser.parse([gameRoomLine(), matchCompletedLine()].join('\n')).find(e => e.type === 'MATCH_END');
      expect(end.data.result).toBe('unknown');
    });

    test('MatchCompleted without MATCH_START produces no MATCH_END', () => {
      expect(parser.parse(matchCompletedLine()).find(e => e.type === 'MATCH_END')).toBeUndefined();
    });

    test('MATCH_END carries deckName and matchId from MATCH_START', () => {
      const log = [
        gameRoomLine('MYID'),
        `{"InternalEventName":"Standard_Event"}`,
        `{"CourseName":"My Cool Deck"}`,
        matchCompletedLine(),
        '{"resultType":"Victory"}',
      ].join('\n');
      const end = parser.parse(log).find(e => e.type === 'MATCH_END');
      expect(end.data.matchId).toBe('MYID');
      expect(end.data.deckName).toBe('My Cool Deck');
    });
  });

  // ── inventory ─────────────────────────────────────────────────────────────

  describe('parse() — inventory', () => {
    test('InventoryInfo line produces INVENTORY_UPDATE', () => {
      const events = parser.parse(inventoryLine());
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('INVENTORY_UPDATE');
    });

    test('INVENTORY_UPDATE carries gems and gold', () => {
      const d = parser.parse(inventoryLine({ gems: 250, gold: 3000 }))[0].data;
      expect(d.gems).toBe(250);
      expect(d.gold).toBe(3000);
    });

    test('INVENTORY_UPDATE carries wildcard counts', () => {
      const d = parser.parse(inventoryLine({ commons: 5, uncommons: 4, rares: 3, mythics: 1 }))[0].data;
      expect(d.wildCardCommons).toBe(5);
      expect(d.wildCardUnCommons).toBe(4);
      expect(d.wildCardRares).toBe(3);
      expect(d.wildCardMythics).toBe(1);
    });

    test('INVENTORY_UPDATE has a timestamp string', () => {
      expect(typeof parser.parse(inventoryLine())[0].data.timestamp).toBe('string');
    });

    test('non-InventoryInfo JSON is ignored', () => {
      expect(parser.parse('{"SomeOtherKey":{"Gems":999}}')).toHaveLength(0);
    });
  });

  // ── game end ──────────────────────────────────────────────────────────────

  describe('parse() — game end', () => {
    test('winningTeamId line produces GAME_END', () => {
      const events = parser.parse(gameEndLine(1));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('GAME_END');
    });
  });

  // ── deduplication ─────────────────────────────────────────────────────────

  describe('deduplication', () => {
    test('same MATCH_START log parsed twice still yields one MATCH_START per call', () => {
      const log = gameRoomLine('DUP-ID');
      parser.parse(log);
      const events = parser.parse(log);
      expect(events.filter(e => e.type === 'MATCH_START')).toHaveLength(1);
    });

    test('INVENTORY_UPDATE keyed by timestamp — two calls both yield one update', () => {
      const first  = parser.parse(inventoryLine({ gems: 100 }));
      const second = parser.parse(inventoryLine({ gems: 200 }));
      expect(first.filter(e => e.type === 'INVENTORY_UPDATE')).toHaveLength(1);
      expect(second.filter(e => e.type === 'INVENTORY_UPDATE')).toHaveLength(1);
    });
  });

  // ── end-to-end ────────────────────────────────────────────────────────────

  describe('end-to-end sequence', () => {
    test('full match: start → game end → match completed → expected events', () => {
      const log = [
        gameRoomLine('FULL-MATCH'),
        '{"InternalEventName":"Historic_Play"}',
        '{"winningTeamId":1}',
        matchCompletedLine(),
      ].join('\n');

      const events = parser.parse(log);
      const types  = events.map(e => e.type);
      expect(types).toContain('MATCH_START');
      expect(types).toContain('GAME_END');
      expect(types).toContain('MATCH_END');

      const start = events.find(e => e.type === 'MATCH_START');
      const end   = events.find(e => e.type === 'MATCH_END');
      expect(start.data.format).toBe('Historic');
      expect(end.data.matchId).toBe('FULL-MATCH');
      expect(end.data.result).toBe('win');
    });
  });
});
