'use strict';

const GREParser = require('../parser/greParser');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal GreToClientEvent log line pair.
 * @param {object[]} messages  — array of GRE message objects
 */
function greEventLines(messages) {
  const event = { greToClientEvent: { greToClientMessages: messages } };
  return ['[UnityCrossThreadLogger]GreToClientEvent', JSON.stringify(event)].join('\n');
}

function connectRespMsg(opts = {}) {
  const { playerSeat = 1, deckCards = [] } = opts;
  return {
    type:          'GREMessageType_ConnectResp',
    systemSeatIds: [playerSeat],
    connectResp:   { deckMessage: { deckCards } },
  };
}

function gameStateMsg(opts = {}) {
  const {
    matchID    = 'match-001',
    gameNumber = 1,
    stage      = null,
    gameObjects = [],
    zones       = [],
    results     = [],
    type        = 'GameStateType_Diff',
  } = opts;
  return {
    type:             'GREMessageType_GameStateMessage',
    gameStateMessage: {
      type,
      gameInfo: { matchID, gameNumber, stage, results },
      gameObjects,
      zones,
    },
  };
}

function handZone(opts = {}) {
  const { ownerSeatId = 1, zoneId = 10, objectInstanceIds = [] } = opts;
  return { type: 'ZoneType_Hand', ownerSeatId, zoneId, objectInstanceIds };
}

function gameObject(opts = {}) {
  const { ownerSeatId = 1, instanceId, grpId, zoneId = 10 } = opts;
  return { type: 'GameObjectType_Card', ownerSeatId, instanceId, grpId, zoneId };
}

function gameOverState(opts = {}) {
  const { matchID = 'match-001', gameNumber = 1, winningTeamId = 1 } = opts;
  return gameStateMsg({
    matchID, gameNumber,
    stage: 'GameStage_GameOver',
    results: [{ scope: 'MatchScope_Game', winningTeamId }],
  });
}

// ─── GREParser tests ─────────────────────────────────────────────────────────

describe('GREParser', () => {
  let parser;

  beforeEach(() => {
    parser = new GREParser();
  });

  // ── parse edge cases ──────────────────────────────────────────────────────

  describe('parse() edge cases', () => {
    test('empty string returns empty array', () => {
      expect(parser.parse('')).toEqual([]);
    });

    test('log without GreToClientEvent returns empty array', () => {
      expect(parser.parse('random log line\nanother line')).toEqual([]);
    });

    test('GreToClientEvent with no relevant fields returns empty array', () => {
      const log = greEventLines([{ type: 'GREMessageType_UIMessage' }]);
      expect(parser.parse(log)).toEqual([]);
    });
  });

  // ── connectResp ───────────────────────────────────────────────────────────

  describe('ConnectResp', () => {
    test('does not emit an event', () => {
      const log = greEventLines([connectRespMsg({ playerSeat: 1, deckCards: [100, 200, 300] })]);
      expect(parser.parse(log)).toHaveLength(0);
    });

    test('sets up currentGame with deckGrpIds', () => {
      const log = greEventLines([connectRespMsg({ playerSeat: 2, deckCards: [111, 222, 111] })]);
      parser.parse(log);
      // currentGame is internal but we can verify via GAME_STATS emitted later
      // Here just confirm no crash and no event
      expect(parser.parse(log)).toHaveLength(0);
    });
  });

  // ── GAME_STATS emission ───────────────────────────────────────────────────

  describe('GAME_STATS', () => {
    function fullGameLog(opts = {}) {
      const {
        playerSeat   = 1,
        deckCards    = [100, 200, 300],
        winningTeam  = 1,
        matchID      = 'match-001',
        handCards    = [],
      } = opts;

      const connectResp = connectRespMsg({ playerSeat, deckCards });

      const handObjs = handCards.map((grpId, i) =>
        gameObject({ ownerSeatId: playerSeat, instanceId: i + 1, grpId, zoneId: 10 })
      );
      const handIids = handCards.map((_, i) => i + 1);

      const handState = gameStateMsg({
        matchID,
        gameObjects: handObjs,
        zones: [handZone({ ownerSeatId: playerSeat, zoneId: 10, objectInstanceIds: handIids })],
        stage: 'GameStage_Play',
      });

      const gameOver = gameOverState({ matchID, winningTeamId: winningTeam });

      return [
        greEventLines([connectResp]),
        greEventLines([handState]),
        greEventLines([gameOver]),
      ].join('\n');
    }

    test('winning game emits GAME_STATS with result=win', () => {
      const log    = fullGameLog({ playerSeat: 1, winningTeam: 1 });
      const events = parser.parse(log);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('GAME_STATS');
      expect(events[0].data.result).toBe('win');
    });

    test('losing game emits GAME_STATS with result=loss', () => {
      const log    = fullGameLog({ playerSeat: 1, winningTeam: 2 });
      const events = parser.parse(log);
      expect(events[0].data.result).toBe('loss');
    });

    test('GAME_STATS carries matchId', () => {
      const log    = fullGameLog({ matchID: 'abc-123' });
      const events = parser.parse(log);
      expect(events[0].data.matchId).toBe('abc-123');
    });

    test('GAME_STATS carries deckGrpIds as unique string IDs', () => {
      const log    = fullGameLog({ deckCards: [100, 200, 100, 300] });
      const events = parser.parse(log);
      const grpIds = events[0].data.deckGrpIds;
      expect(grpIds).toEqual(expect.arrayContaining(['100', '200', '300']));
      expect(grpIds).toHaveLength(3);
    });

    test('GAME_STATS carries handGrpIds seen during the game', () => {
      const log    = fullGameLog({ playerSeat: 1, handCards: [100, 200] });
      const events = parser.parse(log);
      expect(events[0].data.handGrpIds).toEqual(expect.arrayContaining(['100', '200']));
    });

    test('no GAME_STATS when matchId is absent', () => {
      const gameOver = {
        type:             'GREMessageType_GameStateMessage',
        gameStateMessage: {
          gameInfo: { stage: 'GameStage_GameOver', results: [{ scope: 'MatchScope_Game', winningTeamId: 1 }] },
        },
      };
      const log = [
        greEventLines([connectRespMsg()]),
        greEventLines([gameOver]),
      ].join('\n');
      expect(parser.parse(log)).toHaveLength(0);
    });

    test('per-scan dedup: same game log parsed once → one GAME_STATS', () => {
      const log    = fullGameLog();
      const events = parser.parse(log);
      expect(events.filter(e => e.type === 'GAME_STATS')).toHaveLength(1);
    });

    test('second parse call (new scan) re-emits GAME_STATS', () => {
      const log    = fullGameLog();
      parser.parse(log);
      const events = parser.parse(log);
      expect(events.filter(e => e.type === 'GAME_STATS')).toHaveLength(1);
    });
  });

  // ── _processMessage unknown type (line 81) ────────────────────────────────

  describe('_processMessage with unknown message type', () => {
    test('unknown GRE message type produces no event', () => {
      // Embed ZoneType_Hand so the performance filter passes, then use an
      // unknown message type so _processMessage hits the `return null` branch.
      const event = {
        greToClientEvent: {
          greToClientMessages: [
            {
              type: 'GREMessageType_UIMessage',
              gameStateMessage: { zones: [{ type: 'ZoneType_Hand', ownerSeatId: 1, zoneId: 1, objectInstanceIds: [] }] },
            },
          ],
        },
      };
      const log = '[UnityCrossThreadLogger]GreToClientEvent\n' + JSON.stringify(event);
      expect(parser.parse(log)).toHaveLength(0);
    });
  });

  // ── GameStateType_Full resets hand tracking (line 125) ────────────────────

  describe('GameStateType_Full between games', () => {
    test('Full state with gameNumber > 1 resets hand tracking for game 2', () => {
      // game 1: connect + game-over → emit GAME_STATS
      // game 2: GameStateType_Full (triggers _resetHandTracking) + game-over → another GAME_STATS
      const log = [
        greEventLines([connectRespMsg({ playerSeat: 1, deckCards: [100] })]),
        greEventLines([gameOverState({ matchID: 'abc', gameNumber: 1, winningTeamId: 1 })]),
        greEventLines([
          gameStateMsg({
            type:       'GameStateType_Full',
            matchID:    'abc',
            gameNumber: 2,
            zones:      [handZone({ zoneId: 10 })],
          }),
        ]),
        greEventLines([gameOverState({ matchID: 'abc', gameNumber: 2, winningTeamId: 2 })]),
      ].join('\n');

      const events = parser.parse(log);
      const stats  = events.filter(e => e.type === 'GAME_STATS');
      expect(stats).toHaveLength(2);
      expect(stats[0].data.gameNumber).toBe(1);
      expect(stats[1].data.gameNumber).toBe(2);
    });
  });

  // ── gameObjects tracked via hand zone ID (line 136) ───────────────────────

  describe('hand tracking via zone ID on gameObjects', () => {
    test('card in hand zone is added to handGrpIds when zone was set in a prior message', () => {
      // Two messages in the same GRE event:
      //   msg 1 → sets playerHandZoneId via zones
      //   msg 2 → has a gameObject in that zone → line 136 is hit
      const log = [
        greEventLines([connectRespMsg({ playerSeat: 1, deckCards: [100] })]),
        greEventLines([
          // Message 1: set the hand zone (also adds instanceMap entry via objectInstanceIds path is N/A here)
          gameStateMsg({ matchID: 'abc', zones: [handZone({ ownerSeatId: 1, zoneId: 10, objectInstanceIds: [] })] }),
          // Message 2: game object with zoneId matching the hand zone set above → line 136
          gameStateMsg({ matchID: 'abc', gameObjects: [gameObject({ ownerSeatId: 1, instanceId: 1, grpId: 100, zoneId: 10 })] }),
        ]),
        greEventLines([gameOverState({ matchID: 'abc', gameNumber: 1, winningTeamId: 1 })]),
      ].join('\n');

      const events = parser.parse(log);
      const stats  = events.find(e => e.type === 'GAME_STATS');
      expect(stats).toBeDefined();
      expect(stats.data.handGrpIds).toContain('100');
    });
  });
});
