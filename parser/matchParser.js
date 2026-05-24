'use strict';

const { SET_NAMES, SKIP_CODES } = require('../sets');

// Lazy-load the card DB to check basic land type without a hard dependency.
let _cardDb = null;
function _isBasicLand(grpId) {
    if (!_cardDb) {
        try { _cardDb = require('../cards.json'); } catch { _cardDb = { cards: {} }; }
    }
    return _cardDb.cards?.[String(grpId)]?.type === 'Basic Land';
}

/**
 * Parses match-lifecycle lines from the MTGA UnityCrossThreadLogger.
 *
 * Emits: MATCH_START, MATCH_END, GAME_END, INVENTORY_UPDATE
 *
 * Call reset() before each log scan, then pass each line to parseLine().
 * extractDeckNames() / extractDeckCards() must be called once per scan
 * before the line loop so deck metadata is available when match-start
 * lines are processed.
 */
class MatchParser {
  constructor() {
    this.deckNames = new Map(); // persists across scans — deck name cache
    this.reset();
  }

  reset() {
    this.currentMatch    = null;
    this.matchStartTime  = null;
    this.pendingResult   = null;
    this.deckCards       = null;
    this.playerSeatId    = 1;
  }

  // ─── Line routing ──────────────────────────────────────────────────────────

  parseLine(line, allLines, index) {
    if (line.includes('STATE CHANGED') && line.includes('"new":"Playing"')) {
      return this.handleMatchStartFromState(line);
    }
    if (line.includes('MatchGameRoomStateType') || line.includes('MatchGameRoomState')) {
      if (!this.currentMatch) return this.handleMatchStartFromGameRoom(line, allLines, index);
    }
    if (line.includes('STATE CHANGED') && line.includes('"new":"MatchCompleted"')) {
      return this.handleMatchCompleted(line, allLines, index);
    }
    if (line.includes('OnSceneLoaded for MatchEndScene')) {
      return this.handleMatchEndScene();
    }
    if (line.includes('OnExitMatchScene')) {
      return this.handleMatchExit();
    }
    if (line.includes('"resultType"') || line.includes('"ResultType"')) {
      return this.handleResultFromJSON(line);
    }
    if (line.includes('"InventoryInfo"')) {
      return this.handleInventoryInfo(line);
    }
    if (line.includes('"gameEndReason"') || line.includes('"winningTeamId"')) {
      return this.handleGameEnd(line);
    }
    // deckMessage arrives in the GRE ConnectResp right after each game starts.
    // Handle it inline so each match picks up its own deck, not just the first
    // deck found in a pre-scan pass.
    if (line.includes('"deckMessage"') && line.includes('"deckCards"')) {
      this._handleDeckMessage(line);
      return null;
    }
    return null;
  }

  // ─── Match start ───────────────────────────────────────────────────────────

  handleMatchStartFromState(line) {
    if (this.currentMatch) return null;

    const match = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = match ? match[1].trim() : new Date().toISOString();

    this.currentMatch = {
      matchId:   `match_${Date.now()}`,
      startTime: timestamp,
      format:    'Unknown',
      timestamp: new Date().toISOString(),
    };
    return { type: 'MATCH_START', data: { ...this.currentMatch } };
  }

  handleMatchStartFromGameRoom(line, allLines, index) {
    const tsMatch = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = tsMatch ? tsMatch[1].trim() : new Date().toISOString();

    const idMatch = line.match(/Match to ([^:]+):/);
    const matchId = idMatch ? idMatch[1].trim() : `match_${Date.now()}`;

    let format    = 'Unknown';
    let deckName  = 'Unknown Deck';

    // Look backwards for deck submission before the match line
    for (let i = index; i >= Math.max(0, index - 200); i--) {
      const checkLine = allLines[i];
      if (checkLine.includes('"CourseDeckSummary"')) {
        const nameMatch = checkLine.match(/"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch && nameMatch[1].trim()) { deckName = nameMatch[1].trim(); break; }
      }
      if (checkLine.includes('"Courses"')) {
        const coursesMatch = checkLine.match(/"Courses".*?"Name"\s*:\s*"([^"]+)"/s);
        if (coursesMatch && coursesMatch[1].trim()) { deckName = coursesMatch[1].trim(); break; }
      }
    }

    let opponentName        = null;
    let actualMatchId       = matchId;
    let reservedPlayersData = null;

    // Detect player seat ID (scan forward)
    for (let i = index; i < Math.min(index + 200, allLines.length); i++) {
      const checkLine = allLines[i];
      if (checkLine.includes('"systemSeatIds"')) {
        const seatMatch = checkLine.match(/"systemSeatIds"\s*:\s*\[\s*(\d+)\s*\]/);
        if (seatMatch) {
          this.playerSeatId = parseInt(seatMatch[1]);
          console.log(`[Parser] Detected player seat ID: ${this.playerSeatId}`);
          break;
        }
      }
    }

    // Scan forward for match details
    for (let i = index; i < Math.min(index + 100, allLines.length); i++) {
      const checkLine = allLines[i];

      if (checkLine.includes('"matchId"')) {
        const matchIdMatch = checkLine.match(/"matchId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
        if (matchIdMatch) {
          actualMatchId = matchIdMatch[1];
          console.log(`[Parser] Found actual matchId from JSON: ${actualMatchId}`);
        }
      }
      if (checkLine.includes('"InternalEventName"')) {
        const formatMatch = checkLine.match(/"InternalEventName"\s*:\s*"([^"]+)"/);
        if (formatMatch) {
          format = this.detectFormatFromEventName(formatMatch[1]);
          if (this.deckNames.has(formatMatch[1])) deckName = this.deckNames.get(formatMatch[1]);
        }
      }
      if (!reservedPlayersData && checkLine.includes('"reservedPlayers"')) {
        const playersMatch = checkLine.match(/"reservedPlayers"\s*:\s*(\[.*?\])/);
        if (playersMatch) {
          reservedPlayersData = playersMatch[1];
          if (format === 'Unknown') {
            try {
              const players = JSON.parse(playersMatch[1]);
              const me = players.find(p => p.systemSeatId === this.playerSeatId);
              if (me?.eventId) format = this.detectFormatFromEventName(me.eventId);
            } catch { /* ignore */ }
          }
        }
      }
      if (format === 'Unknown' && checkLine.includes('"eventId"') && !checkLine.includes('"reservedPlayers"')) {
        const eventMatch = checkLine.match(/"eventId"\s*:\s*"([^"]+)"/);
        if (eventMatch) format = this.detectFormatFromEventName(eventMatch[1]);
      }
      if (checkLine.includes('"CourseName"') || checkLine.includes('"courseName"')) {
        const m = checkLine.match(/"[Cc]ourseName"\s*:\s*"([^"]+)"/);
        if (m && m[1].trim()) { deckName = m[1].trim(); console.log(`[Parser] Found deck name: ${deckName}`); }
      }
      if (checkLine.includes('"DeckName"') || checkLine.includes('"deckName"')) {
        const m = checkLine.match(/"[Dd]eckName"\s*:\s*"([^"]+)"/);
        if (m && m[1].trim()) { deckName = m[1].trim(); console.log(`[Parser] Found deck name: ${deckName}`); }
      }
      if (checkLine.includes('"SubmitDeck"') || checkLine.includes('"submitDeck"')) {
        const m = checkLine.match(/"[Dd]eck[Nn]ame"\s*:\s*"([^"]+)"/);
        if (m && m[1].trim()) { deckName = m[1].trim(); console.log(`[Parser] Found deck from submission: ${deckName}`); }
      }
      if (checkLine.includes('"CourseDeckSummary"')) {
        const m = checkLine.match(/"Name"\s*:\s*"([^"]+)"/);
        if (m && m[1].trim()) { deckName = m[1].trim(); console.log(`[Parser] Found deck name from CourseDeckSummary: ${deckName}`); }
      }
      if (checkLine.includes('"Courses"') || checkLine.includes('"CourseDeckSummary"')) {
        const m = checkLine.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (m && m[1].trim()) { deckName = m[1].trim(); console.log(`[Parser] Found deck name from Courses: ${m[1].trim()}`); }
      }
    }

    // Resolve opponent after we know the player seat
    if (reservedPlayersData) {
      try {
        const players = JSON.parse(reservedPlayersData);
        const opp = players.find(p => p.systemSeatId !== this.playerSeatId);
        if (opp) {
          opponentName = opp.playerName;
          console.log(`[Parser] Found opponent: ${opponentName} (player is seat ${this.playerSeatId})`);
        }
      } catch {
        const targetSeat = this.playerSeatId === 1 ? 2 : 1;
        const oppMatch = reservedPlayersData.match(
          new RegExp(`"playerName"\\s*:\\s*"([^"]+)".*?"systemSeatId"\\s*:\\s*${targetSeat}`)
        );
        if (oppMatch) {
          opponentName = oppMatch[1];
          console.log(`[Parser] Found opponent via regex: ${opponentName}`);
        }
      }
    }

    this.currentMatch = {
      matchId:      actualMatchId,
      startTime:    timestamp,
      format,
      deckName,
      opponentName,
      playerDeck:   this.deckCards,
      timestamp:    new Date().toISOString(),
    };
    return { type: 'MATCH_START', data: { ...this.currentMatch } };
  }

  // ─── Match end ─────────────────────────────────────────────────────────────

  handleMatchCompleted(line, allLines, index) {
    if (!this.currentMatch) return null;

    let result = this.pendingResult || 'unknown';

    // Look ahead for result
    for (let i = index + 1; i < Math.min(index + 20, allLines.length); i++) {
      const nextLine = allLines[i];
      if (nextLine.includes('Victory') || nextLine.includes('"resultType":"Victory"')) { result = 'win'; break; }
      if (nextLine.includes('Defeat')  || nextLine.includes('"resultType":"Defeat"'))  { result = 'loss'; break; }
      if (nextLine.includes('Draw')    || nextLine.includes('"resultType":"Draw"'))    { result = 'draw'; break; }
      if (nextLine.includes('"winningTeamId"')) {
        const teamMatch = nextLine.match(/"winningTeamId"\s*:\s*(\d+)/);
        if (teamMatch) {
          const winningTeam = parseInt(teamMatch[1]);
          result = winningTeam === this.playerSeatId ? 'win' : 'loss';
          console.log(`[Parser] Match end (lookahead): winningTeam=${winningTeam}, playerTeam=${this.playerSeatId}, result=${result}`);
          break;
        }
      }
    }

    // Look back for result
    if (result === 'unknown') {
      for (let i = Math.max(0, index - 50); i < index; i++) {
        const prevLine = allLines[i];
        if (prevLine.includes('Victory') || prevLine.includes('"resultType":"Victory"')) { result = 'win'; break; }
        if (prevLine.includes('Defeat')  || prevLine.includes('"resultType":"Defeat"'))  { result = 'loss'; break; }
        if (prevLine.includes('"winningTeamId"')) {
          const teamMatch = prevLine.match(/"winningTeamId"\s*:\s*(\d+)/);
          if (teamMatch) {
            const winningTeam = parseInt(teamMatch[1]);
            result = winningTeam === this.playerSeatId ? 'win' : 'loss';
            console.log(`[Parser] Match end (lookback): winningTeam=${winningTeam}, playerTeam=${this.playerSeatId}, result=${result}`);
            break;
          }
        }
      }
    }

    const playerDeck = this.currentMatch.playerDeck || null;
    // Sorted non-basic grpId lists for main deck + sideboard, pipe-separated.
    // Basic lands are excluded — they vary per-printing and add no signal for
    // draft identity (any draft could run the same basics).
    // Including the sideboard makes collisions across different drafts impossible.
    const deckFingerprint = playerDeck?.deckCards?.length
      ? [...playerDeck.deckCards].filter(id => !_isBasicLand(id)).sort((a, b) => a - b).join(',')
        + '|'
        + [...(playerDeck.sideboardCards || [])].filter(id => !_isBasicLand(id)).sort((a, b) => a - b).join(',')
      : null;

    const matchData = {
      matchId:         this.currentMatch.matchId,
      result,
      format:          this.currentMatch.format,
      deckName:        this.currentMatch.deckName || 'Unknown Deck',
      opponentName:    this.currentMatch.opponentName || null,
      playerDeck,
      deckFingerprint,
      timestamp:       new Date().toISOString(),
    };
    console.log(`[Parser] Match ended: ${matchData.matchId}, Result: ${result}, Deck: ${matchData.deckName}, Opponent: ${matchData.opponentName}`);
    this.pendingResult = null;
    return { type: 'MATCH_END', data: matchData };
  }

  handleMatchEndScene() {
    this.currentMatch = null;
    return null;
  }

  handleMatchExit() {
    this.currentMatch = null;
    return null;
  }

  // ─── Result / game-end helpers ─────────────────────────────────────────────

  handleResultFromJSON(line) {
    try {
      const data = JSON.parse(line);
      const resultType = data.resultType || data.ResultType;
      if (resultType) {
        return {
          type: 'GAME_END',
          data: { result: this.normalizeResult(resultType), timestamp: new Date().toISOString() },
        };
      }
    } catch { /* not valid JSON */ }
    return null;
  }

  handleGameEnd(line) {
    try {
      const data = JSON.parse(line);
      if (data.winningTeamId !== undefined) {
        const winningTeam = data.winningTeamId;
        const result = winningTeam === this.playerSeatId ? 'win' : 'loss';
        console.log(`[Parser] Game end detected: winningTeam=${winningTeam}, playerTeam=${this.playerSeatId}, result=${result}`);
        this.pendingResult = result;
        return {
          type: 'GAME_END',
          data: { result, winningTeamId: winningTeam, timestamp: new Date().toISOString() },
        };
      }
    } catch { /* not valid JSON */ }
    return null;
  }

  // ─── Inventory ─────────────────────────────────────────────────────────────

  handleInventoryInfo(line) {
    try {
      const data = JSON.parse(line);
      if (data.InventoryInfo) {
        const info = data.InventoryInfo;
        return {
          type: 'INVENTORY_UPDATE',
          data: {
            gems:               info.Gems               || 0,
            gold:               info.Gold               || 0,
            totalVaultProgress: info.TotalVaultProgress || 0,
            wildCardCommons:    info.WildCardCommons     || 0,
            wildCardUnCommons:  info.WildCardUnCommons   || 0,
            wildCardRares:      info.WildCardRares       || 0,
            wildCardMythics:    info.WildCardMythics     || 0,
            boosters:           info.Boosters            || [],
            timestamp:          new Date().toISOString(),
          },
        };
      }
    } catch { /* not valid JSON */ }
    return null;
  }

  // ─── Inline deck message handler ──────────────────────────────────────────

  _handleDeckMessage(line) {
    try {
      const cardsMatch = line.match(/"deckCards"\s*:\s*(\[[^\]]*\])/);
      if (!cardsMatch) return;
      const deckCards      = JSON.parse(cardsMatch[1]);
      const sbMatch        = line.match(/"sideboardCards"\s*:\s*(\[[^\]]*\])/);
      const sideboardCards = sbMatch  ? JSON.parse(sbMatch[1])  : [];
      const cmdrMatch      = line.match(/"commanderCards"\s*:\s*(\[[^\]]*\])/);
      const commanderCards = cmdrMatch ? JSON.parse(cmdrMatch[1]) : [];
      this.deckCards = { deckCards, sideboardCards, commandZoneCards: commanderCards };
      // Update the live match so handleMatchCompleted sees the correct deck.
      if (this.currentMatch) this.currentMatch.playerDeck = this.deckCards;
    } catch (e) {
      console.log('[Parser] Failed to parse inline deckMessage:', e.message);
    }
  }

  // ─── Pre-scan deck extraction ──────────────────────────────────────────────

  extractDeckCards(lines) {
    console.log(`[Parser] Searching for deck cards in ${lines.length} lines...`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('"deckMessage"') && line.includes('"deckCards"')) {
        console.log(`[Parser] Found deckMessage with deckCards at line ${i}`);
        try {
          const cardsMatch = line.match(/"deckCards"\s*:\s*(\[[^\]]*\])/);
          if (cardsMatch) {
            const deckCards = JSON.parse(cardsMatch[1]);
            const cmdrMatch = line.match(/"commanderCards"\s*:\s*(\[[^\]]*\])/);
            const commanderCards = cmdrMatch ? JSON.parse(cmdrMatch[1]) : [];
            const sbMatch = line.match(/"sideboardCards"\s*:\s*(\[[^\]]*\])/);
            const sideboardCards = sbMatch ? JSON.parse(sbMatch[1]) : [];
            this.deckCards = { deckCards, sideboardCards, commandZoneCards: commanderCards };
            console.log(`[Parser] Cached deck cards: ${deckCards.length} main, ${sideboardCards.length} sideboard, ${commanderCards.length} commanders`);
            return;
          } else {
            console.log(`[Parser] Found deckMessage but could not extract deckCards array`);
          }
        } catch (e) {
          console.log('[Parser] Failed to extract deck cards:', e.message);
        }
      }
    }
    console.log(`[Parser] No deckMessage with deckCards found in log`);
  }

  extractDeckNames(lines) {
    for (let i = 0; i < Math.min(500, lines.length); i++) {
      const line = lines[i];
      if (line.includes('"Courses"')) {
        const coursesMatch = line.match(/"Courses":\s*(\[.*?\])/);
        if (coursesMatch) {
          try {
            const coursesData = JSON.parse(coursesMatch[1]);
            coursesData.forEach(course => {
              if (course.CourseDeckSummary?.Name) {
                const eventName = course.InternalEventName || 'Unknown';
                this.deckNames.set(eventName, course.CourseDeckSummary.Name);
                console.log(`[Parser] Cached deck for ${eventName}: ${course.CourseDeckSummary.Name}`);
              }
            });
          } catch { /* regex fallback already logged elsewhere */ }
        }
      }
    }
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  normalizeResult(result) {
    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'victory') return 'win';
      if (lower === 'defeat')  return 'loss';
      if (lower === 'draw')    return 'draw';
    }
    return 'unknown';
  }

  detectFormatFromEventName(eventName) {
    if (!eventName) return 'Unknown';
    const name = eventName.toLowerCase();
    if (name.includes('standard'))   return 'Standard';
    if (name.includes('alchemy'))    return 'Alchemy';
    if (name.includes('historic')) {
      if (name.includes('brawl')) return 'Historic Brawl';
      return 'Historic';
    }
    if (name.includes('explorer'))   return 'Explorer';
    if (name.includes('pioneer'))    return 'Pioneer';
    if (name.includes('timeless'))   return 'Timeless';
    if (name.includes('brawl'))      return 'Brawl';
    if (name.includes('constructed')) return 'Constructed';
    if (name.includes('draft') || name.includes('sealed')) return this.detectDraftFormat(eventName);
    return 'Unknown';
  }

  /**
   * Given a draft/sealed event name, return a format label that includes the
   * set name, e.g. "Secrets of Strixhaven Quick Draft".
   */
  detectDraftFormat(eventName) {
    const name = eventName.toLowerCase();
    let draftType;
    if (name.includes('sealed'))           draftType = 'Sealed';
    else if (name.includes('quick'))       draftType = 'Quick Draft';
    else if (name.includes('traditional') || name.includes('trad')) draftType = 'Traditional Draft';
    else if (name.includes('contender'))   draftType = 'Contender Draft';
    else if (name.includes('premier'))     draftType = 'Premier Draft';
    else                                   draftType = 'Draft';

    const setCode = eventName
      .split(/[_\-\s]+/)
      .find(p => /^[A-Z]{2,4}$/.test(p) && !SKIP_CODES.has(p)) ?? null;

    if (setCode) {
      const setName = SET_NAMES[setCode] ?? setCode;
      if (draftType === 'Premier Draft' || draftType === 'Contender Draft') return `${draftType} ${setName}`;
      return `${setName} ${draftType}`;
    }
    return draftType;
  }
}

module.exports = MatchParser;
