/**
 * MTG Arena Log Parser
 * Parses the Player.log file to extract game events
 * Based on the actual MTG Arena log format
 */

class LogParser {
  constructor() {
    this.currentMatch = null;
    this.currentGame = null;
    this.buffer = '';
    this.debugMode = true; // Enable debug logging

    // Log patterns based on actual MTG Arena log format
    this.patterns = {
      // Unity logger prefix pattern
      unityLog: /\[UnityCrossThreadLogger\]/,

      // Match events
      matchState: /MatchState|MatchStateMethod|"MatchState"/,
      matchEnd: /MatchEnd|"MatchEnd"|"EventName":"MatchEnd"/,
      matchResult: /"ResultType":|"Result":|MatchResult|"MatchCompleted"/,

      // Game events
      gameState: /"GameState"|"GameStateMessage"/,
      greToClient: /"GreToClientEvent"|"greToClientEvent"/,

      // Deck events
      submitDeck: /"SubmitDeckV2"|"DeckSubmit"|"SubmitDeckRequest"/,

      // Event/Format info
      eventName: /"EventName":/,
      formatType: /"FormatType":|"formatType":/,

      // Player info
      playerId: /"playerId":|"PlayerId":/,
      teamId: /"teamId":|"TeamId":|"winningTeamId":/,

      // Results
      victory: /"ResultType":"Victory"|"Victory"|"Result":"Victory"/,
      defeat: /"ResultType":"Defeat"|"Defeat"|"Result":"Defeat"/,
      draw: /"ResultType":"Draw"|"Draw"|"Result":"Draw"/
    };
  }

  /**
   * Parse new data from the log file
   */
  parse(data) {
    const events = [];
    this.buffer += data;

    if (this.debugMode && data.length > 0) {
      console.log(`[Parser] Received ${data.length} bytes of data`);
    }

    // Process complete lines from buffer
    let lineEnd;
    while ((lineEnd = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, lineEnd).trim();
      this.buffer = this.buffer.substring(lineEnd + 1);

      if (!line) continue;

      try {
        const event = this.parseLine(line);
        if (event) {
          events.push(event);
          if (this.debugMode) {
            console.log(`[Parser] Detected event: ${event.type}`);
          }
        }
      } catch (error) {
        // Silently ignore parse errors
        if (this.debugMode) {
          // console.log('[Parser] Parse error:', error.message);
        }
      }
    }

    // Prevent buffer from growing indefinitely
    if (this.buffer.length > 100000) {
      this.buffer = this.buffer.slice(-50000);
    }

    return events;
  }

  /**
   * Parse a single log line
   */
  parseLine(line) {
    // Look for Unity log format: [UnityCrossThreadLogger] timestamp: method
    const unityMatch = line.match(/\[UnityCrossThreadLogger\]([^:]+):\s*(.+)/);

    if (unityMatch) {
      const method = unityMatch[1].trim();
      const payload = unityMatch[2].trim();

      // Try to parse the payload as JSON
      let data = null;
      try {
        if (payload.startsWith('{')) {
          data = JSON.parse(payload);
        }
      } catch (e) {
        // Not valid JSON
      }

      // Route to appropriate handler based on method name
      if (method.includes('MatchState') || method.includes('MatchStart')) {
        return this.handleMatchStart(data, payload, line);
      }

      if (method.includes('MatchEnd') || method.includes('MatchResult')) {
        return this.handleMatchEnd(data, payload, line);
      }

      if (method.includes('SubmitDeck')) {
        return this.handleDeckSubmission(data, payload, line);
      }

      if (method.includes('GreToClient') || method.includes('GameState')) {
        return this.handleGameEvent(data, payload, line);
      }
    }

    // Try parsing raw JSON lines (some logs don't have Unity prefix)
    if (line.startsWith('{')) {
      try {
        const data = JSON.parse(line);

        // Check for specific event types in the JSON
        if (this.isMatchStartJSON(data)) {
          return this.handleMatchStart(data, line, line);
        }

        if (this.isMatchEndJSON(data)) {
          return this.handleMatchEnd(data, line, line);
        }

        if (this.isDeckSubmissionJSON(data)) {
          return this.handleDeckSubmission(data, line, line);
        }

      } catch (e) {
        // Not valid JSON
      }
    }

    // Look for result patterns in plain text
    if (line.includes('Result') || line.includes('Victory') || line.includes('Defeat')) {
      const result = this.extractResultFromLine(line);
      if (result && this.currentMatch) {
        return {
          type: 'GAME_RESULT',
          data: {
            result: result,
            matchId: this.currentMatch.matchId,
            timestamp: new Date().toISOString()
          }
        };
      }
    }

    return null;
  }

  /**
   * Check if JSON data represents a match start
   */
  isMatchStartJSON(data) {
    return data.matchId || data.MatchId ||
           (data.eventName && data.eventName.includes('Match')) ||
           data.gameRoomConfig || data.GameRoomConfig;
  }

  /**
   * Check if JSON data represents a match end
   */
  isMatchEndJSON(data) {
    return (data.result !== undefined) ||
           (data.Result !== undefined) ||
           data.matchResult || data.MatchResult ||
           data.winningTeamId !== undefined ||
           (data.eventName && data.eventName.includes('End'));
  }

  /**
   * Check if JSON data represents a deck submission
   */
  isDeckSubmissionJSON(data) {
    return data.submitDeckV2 || data.SubmitDeckV2 ||
           data.deck || data.Deck ||
           (data.eventName && data.eventName.includes('Deck'));
  }

  /**
   * Handle match start event
   */
  handleMatchStart(data, payload, rawLine) {
    let matchId = 'unknown';
    let eventId = 'unknown';
    let format = 'Unknown';
    let playerTeamId = 1;

    if (data) {
      matchId = data.matchId || data.MatchId || data.match_id ||
                (data.gameRoomConfig && data.gameRoomConfig.matchId) ||
                'unknown';

      eventId = data.eventId || data.EventId || data.event_id ||
                (data.gameRoomConfig && data.gameRoomConfig.eventId) ||
                'unknown';

      // Try to determine format
      const formatType = data.formatType || data.FormatType ||
                        (data.gameRoomConfig && data.gameRoomConfig.formatType);

      if (formatType) {
        format = this.normalizeFormat(formatType);
      }

      // Try to get player team ID
      if (data.playerTeamId !== undefined) {
        playerTeamId = data.playerTeamId;
      } else if (data.teamId !== undefined) {
        playerTeamId = data.teamId;
      }
    }

    // Extract from raw line if JSON parsing failed
    if (matchId === 'unknown') {
      const matchIdMatch = rawLine.match(/"matchId":"([^"]+)"/i);
      if (matchIdMatch) matchId = matchIdMatch[1];
    }

    if (eventId === 'unknown') {
      const eventIdMatch = rawLine.match(/"eventId":"([^"]+)"/i);
      if (eventIdMatch) eventId = eventIdMatch[1];
    }

    if (format === 'Unknown' && eventId !== 'unknown') {
      // Try to determine format from event ID
      format = this.formatFromEventId(eventId);
    }

    this.currentMatch = {
      matchId,
      eventId,
      format,
      playerTeamId,
      timestamp: new Date().toISOString()
    };

    if (this.debugMode) {
      console.log('[Parser] Match started:', this.currentMatch);
    }

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  /**
   * Handle match end event
   */
  handleMatchEnd(data, payload, rawLine) {
    if (!this.currentMatch && this.debugMode) {
      console.log('[Parser] Match end without current match context');
    }

    let result = 'unknown';
    let winningTeamId = null;
    let gamesPlayed = 1;

    if (data) {
      // Try to extract result
      if (data.result !== undefined) {
        result = this.normalizeResult(data.result);
      } else if (data.Result !== undefined) {
        result = this.normalizeResult(data.Result);
      } else if (data.matchResult !== undefined) {
        result = this.normalizeResult(data.matchResult);
      }

      // Check winning team
      if (data.winningTeamId !== undefined) {
        winningTeamId = parseInt(data.winningTeamId);
      } else if (data.WinningTeamId !== undefined) {
        winningTeamId = parseInt(data.WinningTeamId);
      }

      // Determine result from winning team
      if (winningTeamId !== null && this.currentMatch) {
        result = (winningTeamId === this.currentMatch.playerTeamId) ? 'win' : 'loss';
      }

      // Get games played
      if (data.gamesPlayed !== undefined) {
        gamesPlayed = data.gamesPlayed;
      } else if (data.GamesPlayed !== undefined) {
        gamesPlayed = data.GamesPlayed;
      }
    }

    // Try to extract from raw line if JSON parsing failed
    if (result === 'unknown') {
      result = this.extractResultFromLine(rawLine);
    }

    const matchData = {
      matchId: this.currentMatch?.matchId || 'unknown',
      result: result,
      format: this.currentMatch?.format || 'Unknown',
      gamesPlayed,
      timestamp: new Date().toISOString()
    };

    if (this.debugMode) {
      console.log('[Parser] Match ended:', matchData);
    }

    // Clear current match
    const event = {
      type: 'MATCH_END',
      data: matchData
    };

    this.currentMatch = null;

    return event;
  }

  /**
   * Handle deck submission event
   */
  handleDeckSubmission(data, payload, rawLine) {
    if (!data) return null;

    const deckData = data.submitDeckV2 || data.SubmitDeckV2 ||
                     data.deck || data.Deck || data;

    if (!deckData) return null;

    // Extract deck name
    let deckName = 'Unknown Deck';
    if (deckData.deckName) {
      deckName = deckData.deckName;
    } else if (deckData.name) {
      deckName = deckData.name;
    }

    // Extract colors
    const colors = deckData.colors || deckData.Colors || [];

    // Extract cards if available
    let cards = [];
    if (deckData.cardSkins || deckData.CardSkins) {
      const skins = deckData.cardSkins || deckData.CardSkins;
      cards = Object.keys(skins).map(key => {
        const parts = key.split(':');
        return {
          grpId: parts[0],
          quantity: parseInt(parts[1]) || 1
        };
      });
    }

    const deckInfo = {
      deckId: deckData.id || deckData.Id || deckData.deckId || 'unknown',
      deckName,
      colors,
      cards,
      timestamp: new Date().toISOString()
    };

    // Update current match with deck info
    if (this.currentMatch) {
      this.currentMatch.deckInfo = deckInfo;
    }

    if (this.debugMode) {
      console.log('[Parser] Deck submitted:', deckInfo);
    }

    return {
      type: 'DECK_SUBMISSION',
      data: deckInfo
    };
  }

  /**
   * Handle game event (GRE messages)
   */
  handleGameEvent(data, payload, rawLine) {
    // Look for game end within GRE events
    if (data && data.payload) {
      const payload = data.payload;

      // Check for game end
      if (payload.gameEndReason || payload.winningTeamId !== undefined) {
        const winningTeamId = payload.winningTeamId;
        const playerTeamId = this.currentMatch?.playerTeamId || 1;

        if (winningTeamId !== undefined) {
          const result = (winningTeamId === playerTeamId) ? 'win' : 'loss';

          return {
            type: 'GAME_END',
            data: {
              result,
              winningTeamId,
              turnCount: payload.turnCount || payload.turnNumber,
              timestamp: new Date().toISOString()
            }
          };
        }
      }
    }

    return null;
  }

  /**
   * Normalize result value
   */
  normalizeResult(result) {
    if (typeof result === 'number') {
      if (result === 1 || result === 'Victory') return 'win';
      if (result === 2 || result === 'Defeat') return 'loss';
      if (result === 0 || result === 'Draw') return 'draw';
    }

    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'victory' || lower === 'win' || lower === 'winner') return 'win';
      if (lower === 'defeat' || lower === 'loss' || lower === 'lose' || lower === 'loser') return 'loss';
      if (lower === 'draw' || lower === 'tie') return 'draw';
    }

    return 'unknown';
  }

  /**
   * Normalize format name
   */
  normalizeFormat(format) {
    const formatMap = {
      'Standard': 'Standard',
      'Alchemy': 'Alchemy',
      'Historic': 'Historic',
      'Explorer': 'Explorer',
      'Pioneer': 'Pioneer',
      'Timeless': 'Timeless',
      'Brawl': 'Brawl',
      'HistoricBrawl': 'Historic Brawl',
      'Draft': 'Draft',
      'Sealed': 'Sealed',
      'TraditionalDraft': 'Traditional Draft',
      'PremierDraft': 'Premier Draft',
      'QuickDraft': 'Quick Draft',
      'CompDraft': 'Competitive Draft'
    };

    const normalized = formatMap[format];
    if (normalized) return normalized;

    // Try to clean up the format string
    const cleaned = format.replace(/([A-Z])/g, ' $1').trim();
    return cleaned || format;
  }

  /**
   * Try to determine format from event ID
   */
  formatFromEventId(eventId) {
    if (!eventId) return 'Unknown';

    const eventIdLower = eventId.toLowerCase();

    if (eventIdLower.includes('standard')) return 'Standard';
    if (eventIdLower.includes('alchemy')) return 'Alchemy';
    if (eventIdLower.includes('historic')) {
      if (eventIdLower.includes('brawl')) return 'Historic Brawl';
      return 'Historic';
    }
    if (eventIdLower.includes('explorer')) return 'Explorer';
    if (eventIdLower.includes('pioneer')) return 'Pioneer';
    if (eventIdLower.includes('timeless')) return 'Timeless';
    if (eventIdLower.includes('brawl')) return 'Brawl';
    if (eventIdLower.includes('draft')) {
      if (eventIdLower.includes('premier')) return 'Premier Draft';
      if (eventIdLower.includes('quick')) return 'Quick Draft';
      if (eventIdLower.includes('trad')) return 'Traditional Draft';
      return 'Draft';
    }
    if (eventIdLower.includes('sealed')) return 'Sealed';

    return 'Unknown';
  }

  /**
   * Extract result from a log line
   */
  extractResultFromLine(line) {
    const lower = line.toLowerCase();

    // Look for explicit result patterns
    if (lower.includes('"resulttype":"victory"') ||
        lower.includes('"result":"victory"') ||
        lower.includes('victory')) {
      return 'win';
    }

    if (lower.includes('"resulttype":"defeat"') ||
        lower.includes('"result":"defeat"') ||
        lower.includes('defeat')) {
      return 'loss';
    }

    if (lower.includes('"resulttype":"draw"') ||
        lower.includes('"result":"draw"') ||
        lower.includes('draw')) {
      return 'draw';
    }

    // Check for Result codes
    const resultMatch = line.match(/"Result"[:\s]*["']?([^"',}\s]+)/i);
    if (resultMatch) {
      return this.normalizeResult(resultMatch[1]);
    }

    return null;
  }
}

module.exports = LogParser;
