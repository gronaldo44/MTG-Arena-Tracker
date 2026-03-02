/**
 * MTG Arena Log Parser v2
 * Alternative approach that reads the log differently
 */

class LogParserV2 {
  constructor() {
    this.currentMatch = null;
    this.buffer = '';
    this.debugMode = true;
  }

  parse(data) {
    const events = [];
    this.buffer += data;

    // Process the entire buffer
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = this.parseLine(line);
      if (event) {
        events.push(event);
        if (this.debugMode) {
          console.log(`[ParserV2] Found event: ${event.type}`);
        }
      }
    }

    return events;
  }

  parseLine(line) {
    // Debug: log what we're looking at
    if (this.debugMode && line.includes('Match')) {
      console.log(`[ParserV2] Checking line: ${line.slice(0, 100)}...`);
    }

    // Pattern 1: UnityCrossThreadLogger format
    // [UnityCrossThreadLogger] timestamp method: {json}
    const unityMatch = line.match(/^\[UnityCrossThreadLogger\]\s+\S+\s+(\S+):\s*(.+)$/);
    if (unityMatch) {
      const method = unityMatch[1];
      const payload = unityMatch[2];
      return this.parseUnityEvent(method, payload, line);
    }

    // Pattern 2: Raw JSON lines that start with {
    if (line.trim().startsWith('{')) {
      return this.parseJSONLine(line);
    }

    // Pattern 3: Lines with embedded JSON
    const jsonStart = line.indexOf('{');
    if (jsonStart !== -1) {
      const jsonPart = line.slice(jsonStart);
      return this.parseJSONLine(jsonPart);
    }

    return null;
  }

  parseUnityEvent(method, payload, rawLine) {
    // Parse the JSON payload
    let data = null;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      // JSON might be malformed, try to extract what we can
      return null;
    }

    // Match start
    if (method === 'MatchState' || method === 'MatchStart') {
      return this.handleMatchStart(data);
    }

    // Match end
    if (method === 'MatchEnd' || method === 'MatchResult') {
      return this.handleMatchEnd(data);
    }

    // Deck submission
    if (method === 'SubmitDeckV2' || method === 'SubmitDeckRequest') {
      return this.handleDeckSubmission(data);
    }

    // Game state
    if (method === 'GreToClientEvent' || method.includes('GreTo')) {
      return this.handleGameEvent(data);
    }

    return null;
  }

  parseJSONLine(line) {
    let data = null;
    try {
      data = JSON.parse(line);
    } catch (e) {
      return null;
    }

    // Check for event type in the JSON
    const eventName = data.eventName || data.EventName || data.method || data.Method;

    if (eventName) {
      if (eventName.includes('Match') && (eventName.includes('Start') || eventName.includes('State'))) {
        return this.handleMatchStart(data);
      }
      if (eventName.includes('Match') && eventName.includes('End')) {
        return this.handleMatchEnd(data);
      }
      if (eventName.includes('Deck')) {
        return this.handleDeckSubmission(data);
      }
    }

    // Check for match result patterns
    if (data.result !== undefined || data.Result !== undefined || data.matchResult !== undefined) {
      return this.handleMatchEnd(data);
    }

    // Check for match ID patterns
    if (data.matchId || data.MatchId) {
      if (!this.currentMatch) {
        return this.handleMatchStart(data);
      }
    }

    return null;
  }

  handleMatchStart(data) {
    const matchId = data.matchId || data.MatchId || data.match_id || 'unknown';
    const eventId = data.eventId || data.EventId || data.event_id || 'unknown';
    const format = this.detectFormat(data);

    this.currentMatch = {
      matchId,
      eventId,
      format,
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchEnd(data) {
    let result = 'unknown';

    // Try to extract result from various fields
    if (data.result !== undefined) {
      result = this.normalizeResult(data.result);
    } else if (data.Result !== undefined) {
      result = this.normalizeResult(data.Result);
    } else if (data.matchResult !== undefined) {
      result = this.normalizeResult(data.matchResult);
    } else if (data.MatchResult !== undefined) {
      result = this.normalizeResult(data.MatchResult);
    }

    // Check winning team
    const winningTeamId = data.winningTeamId || data.WinningTeamId;
    if (winningTeamId !== undefined && this.currentMatch) {
      const playerTeamId = this.currentMatch.playerTeamId || 1;
      result = (winningTeamId === playerTeamId) ? 'win' : 'loss';
    }

    const matchData = {
      matchId: this.currentMatch?.matchId || data.matchId || 'unknown',
      result,
      format: this.currentMatch?.format || this.detectFormat(data),
      timestamp: new Date().toISOString()
    };

    this.currentMatch = null;

    return {
      type: 'MATCH_END',
      data: matchData
    };
  }

  handleDeckSubmission(data) {
    const deckData = data.submitDeckV2 || data.SubmitDeckV2 || data.deck || data.Deck || data;

    if (!deckData) return null;

    const deckInfo = {
      deckId: deckData.id || deckData.Id || deckData.deckId || 'unknown',
      deckName: deckData.deckName || deckData.name || deckData.Name || 'Unknown Deck',
      colors: deckData.colors || deckData.Colors || [],
      timestamp: new Date().toISOString()
    };

    if (this.currentMatch) {
      this.currentMatch.deckInfo = deckInfo;
    }

    return {
      type: 'DECK_SUBMISSION',
      data: deckInfo
    };
  }

  handleGameEvent(data) {
    // Look for game end in GRE events
    if (data.payload) {
      const payload = data.payload;

      if (payload.winningTeamId !== undefined) {
        const winningTeamId = payload.winningTeamId;
        const playerTeamId = this.currentMatch?.playerTeamId || 1;
        const result = (winningTeamId === playerTeamId) ? 'win' : 'loss';

        return {
          type: 'GAME_END',
          data: {
            result,
            winningTeamId,
            timestamp: new Date().toISOString()
          }
        };
      }
    }

    return null;
  }

  detectFormat(data) {
    // Try to detect format from various fields
    const formatType = data.formatType || data.FormatType || data.format || data.Format;

    if (formatType) {
      return this.normalizeFormat(formatType);
    }

    const eventId = data.eventId || data.EventId || data.event_id;
    if (eventId) {
      return this.formatFromEventId(eventId);
    }

    return 'Unknown';
  }

  normalizeFormat(format) {
    const map = {
      'Standard': 'Standard',
      'Alchemy': 'Alchemy',
      'Historic': 'Historic',
      'Explorer': 'Explorer',
      'Pioneer': 'Pioneer',
      'Timeless': 'Timeless',
      'Brawl': 'Brawl',
      'HistoricBrawl': 'Historic Brawl',
      'Draft': 'Draft',
      'Sealed': 'Sealed'
    };
    return map[format] || format;
  }

  formatFromEventId(eventId) {
    if (!eventId) return 'Unknown';
    const id = eventId.toLowerCase();

    if (id.includes('standard')) return 'Standard';
    if (id.includes('alchemy')) return 'Alchemy';
    if (id.includes('historic')) {
      if (id.includes('brawl')) return 'Historic Brawl';
      return 'Historic';
    }
    if (id.includes('explorer')) return 'Explorer';
    if (id.includes('pioneer')) return 'Pioneer';
    if (id.includes('timeless')) return 'Timeless';
    if (id.includes('brawl')) return 'Brawl';
    if (id.includes('draft')) return 'Draft';
    if (id.includes('sealed')) return 'Sealed';

    return 'Unknown';
  }

  normalizeResult(result) {
    if (typeof result === 'number') {
      if (result === 1) return 'win';
      if (result === 2) return 'loss';
      if (result === 0) return 'draw';
    }

    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'victory' || lower === 'win') return 'win';
      if (lower === 'defeat' || lower === 'loss') return 'loss';
      if (lower === 'draw') return 'draw';
    }

    return 'unknown';
  }
}

module.exports = LogParserV2;
