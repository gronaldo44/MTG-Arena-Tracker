'use strict';

/**
 * GRE (Game Rules Engine) Parser
 *
 * Reads GreToClientEvent messages from the MTGA log and emits GAME_STATS events
 * that describe which cards the player held in each game and whether they won.
 *
 * Metrics tracked per game:
 *   deckGrpIds      – cards in the deck at game start (GP equivalent)
 *   handGrpIds      – cards ever seen in the player's hand (GIH equivalent)
 *   openingHandGrpIds – cards in hand after all mulligan decisions (OH equivalent)
 *   result          – 'win' | 'loss'
 *
 * Opening hand accuracy with London mulligan:
 *   The log shows each candidate hand during mulligan phase (GameStage_Start).
 *   We REPLACE the opening-hand candidates on every hand-zone update, so the
 *   final set before the stage exits GameStage_Start reflects the kept hand,
 *   including any cards the player bottomed.
 */

class GREParser {
  constructor() {
    this.currentGame = null;
  }

  /**
   * Parse the full log text and return an array of GAME_STATS events.
   * Called on each scan; per-scan dedup is handled by processedGames below.
   * Persistent dedup (across scans) is handled by DataStore.
   */
  parse(logData) {
    const events = [];
    const lines = logData.split('\n');
    this.currentGame = null;

    const processedThisScan = new Set();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('GreToClientEvent')) continue;

      const jsonLine = lines[i + 1];
      if (!jsonLine || jsonLine[0] !== '{') continue;

      // Performance filter: skip lines we definitely don't care about.
      // Every line we need will contain at least one of these substrings.
      if (
        !jsonLine.includes('"connectResp"') &&
        !jsonLine.includes('ZoneType_Hand') &&
        !jsonLine.includes('GameStage_GameOver') &&
        !jsonLine.includes('GameStateType_Full')
      ) continue;

      let data;
      try { data = JSON.parse(jsonLine); } catch { continue; }

      const messages = data.greToClientEvent?.greToClientMessages;
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        const event = this._processMessage(msg);
        if (!event) continue;

        const key = `${event.data.matchId}_game${event.data.gameNumber}`;
        if (!processedThisScan.has(key)) {
          processedThisScan.add(key);
          events.push(event);
        }
      }
    }

    return events;
  }

  // ─── Message dispatch ──────────────────────────────────────────────────────

  _processMessage(msg) {
    if (msg.type === 'GREMessageType_ConnectResp') return this._handleConnectResp(msg);
    if (msg.type === 'GREMessageType_GameStateMessage') return this._handleGameState(msg);
    return null;
  }

  // ─── ConnectResp: start of a new match ────────────────────────────────────

  _handleConnectResp(msg) {
    const playerSeat = msg.systemSeatIds?.[0] ?? 1;
    const deckCards = msg.connectResp?.deckMessage?.deckCards ?? [];

    this.currentGame = {
      matchId: null,
      gameNumber: 1,
      playerSeat,
      deckCardsRaw: deckCards.map(String),           // with duplicates — used for copy-count
      deckGrpIds:   [...new Set(deckCards.map(String))], // unique — used for card stats

      // instanceId (number) → grpId (string)
      instanceMap: Object.create(null),

      // zoneId for the player's hand (discovered from zone listings)
      playerHandZoneId: null,

      // All grpIds ever seen in player's hand during this game
      handGrpIds: new Set(),

      // Opening hand tracking (replaced on each mulligan reredraw)
      inMulliganPhase: true,
      openingHandLocked: false,
      openingHandCandidates: new Set(),
      openingHandGrpIds: new Set(),
    };

    return null;
  }

  // ─── GameStateMessage: ongoing game state ─────────────────────────────────

  _handleGameState(msg) {
    if (!this.currentGame) return null;
    const game = this.currentGame;
    const gsm = msg.gameStateMessage;
    if (!gsm) return null;

    // Track matchId and game number
    if (gsm.gameInfo) {
      if (gsm.gameInfo.matchID)    game.matchId    = gsm.gameInfo.matchID;
      if (gsm.gameInfo.gameNumber) game.gameNumber = gsm.gameInfo.gameNumber;
    }

    // Detect a new game within a bo3 match (new Full message with higher gameNumber)
    if (gsm.type === 'GameStateType_Full' && gsm.gameInfo?.gameNumber > 1) {
      this._resetHandTracking(game);
    }

    // Step 1: Update instanceMap from gameObjects, and accumulate GIH.
    // We process gameObjects BEFORE zones so the map is ready when we need it.
    if (gsm.gameObjects) {
      for (const obj of gsm.gameObjects) {
        if (obj.ownerSeatId !== game.playerSeat) continue;
        if (obj.type !== 'GameObjectType_Card') continue;

        game.instanceMap[obj.instanceId] = String(obj.grpId);

        // Any card that appears in the hand zone → GIH
        if (game.playerHandZoneId && obj.zoneId === game.playerHandZoneId) {
          game.handGrpIds.add(String(obj.grpId));
        }
      }
    }

    // Step 2: Process zone listings.
    // ZoneType_Hand updates give us the definitive current hand contents.
    if (gsm.zones) {
      for (const zone of gsm.zones) {
        if (zone.type !== 'ZoneType_Hand' || zone.ownerSeatId !== game.playerSeat) continue;

        game.playerHandZoneId = zone.zoneId;

        // GIH: also add from zone listing (catches cases where gameObjects is absent)
        if (zone.objectInstanceIds) {
          for (const iid of zone.objectInstanceIds) {
            const grpId = game.instanceMap[iid];
            if (grpId) game.handGrpIds.add(grpId);
          }
        }

        // Opening hand: REPLACE candidates on each hand update during mulligan.
        // This correctly handles mulligans and London-mulligan bottoming.
        if (game.inMulliganPhase && !game.openingHandLocked && zone.objectInstanceIds) {
          game.openingHandCandidates = new Set();
          for (const iid of zone.objectInstanceIds) {
            const grpId = game.instanceMap[iid];
            if (grpId) game.openingHandCandidates.add(grpId);
          }
        }

        break;
      }
    }

    // Step 3: Detect end of mulligan phase.
    const stage = gsm.gameInfo?.stage;
    if (game.inMulliganPhase && stage && stage !== 'GameStage_Start') {
      game.openingHandGrpIds = new Set(game.openingHandCandidates);
      game.openingHandLocked = true;
      game.inMulliganPhase   = false;
    }

    // Step 4: Detect game over and emit GAME_STATS.
    if (stage === 'GameStage_GameOver') {
      const results = gsm.gameInfo?.results ?? [];
      const gameResult = results.find(r => r.scope === 'MatchScope_Game');
      if (!gameResult || !game.matchId) return null;

      const won = gameResult.winningTeamId === game.playerSeat;

      const event = {
        type: 'GAME_STATS',
        data: {
          matchId:          game.matchId,
          gameNumber:       game.gameNumber,
          result:           won ? 'win' : 'loss',
          deckGrpIds:       game.deckGrpIds,
          deckCardsRaw:     game.deckCardsRaw,
          handGrpIds:       Array.from(game.handGrpIds),
          openingHandGrpIds: Array.from(game.openingHandGrpIds),
        }
      };

      // Prepare for the next game in a bo3 (hand tracking only; deck stays the same)
      this._resetHandTracking(game);

      return event;
    }

    return null;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _resetHandTracking(game) {
    game.instanceMap          = Object.create(null);
    game.playerHandZoneId     = null;
    game.handGrpIds           = new Set();
    game.inMulliganPhase      = true;
    game.openingHandLocked    = false;
    game.openingHandCandidates = new Set();
    game.openingHandGrpIds    = new Set();
  }
}

module.exports = GREParser;
