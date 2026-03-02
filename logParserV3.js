/**
 * MTG Arena Log Parser v3
 * Handles plain JSON logs (not Unity-formatted)
 */

class LogParserV3 {
  constructor() {
    this.currentMatch = null;
    this.buffer = '';
    this.debugMode = true;
    this.processedLines = new Set(); // Track processed lines to avoid duplicates
  }

  parse(data) {
    const events = [];
    this.buffer += data;

    // Process line by line
    let lineEnd;
    while ((lineEnd = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, lineEnd).trim();
      this.buffer = this.buffer.substring(lineEnd + 1);

      if (!line) continue;

      // Skip if we've already processed this exact line
      const lineHash = this.hashLine(line);
      if (this.processedLines.has(lineHash)) {
        continue;
      }
      this.processedLines.add(lineHash);

      const event = this.parseLine(line);
      if (event) {
        events.push(event);
        if (this.debugMode) {
          console.log(`[ParserV3] Found event: ${event.type}`);
        }
      }
    }

    // Prevent buffer/memory growth
    if (this.buffer.length > 100000) {
      this.buffer = this.buffer.slice(-50000);
    }
    if (this.processedLines.size > 10000) {
      this.processedLines.clear();
    }

    return events;
  }

  hashLine(line) {
    // Simple hash for tracking
    let hash = 0;
    for (let i = 0; i < Math.min(line.length, 100); i++) {
      const char = line.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash;
  }

  parseLine(line) {
    // Try parsing as JSON first
    if (line.startsWith('{')) {
      return this.parseJSONLine(line);
    }

    // Try Unity format (some logs have this)
    const unityMatch = line.match(/^\[UnityCrossThreadLogger\]\s+\S+\s+(\S+):\s*(.+)$/);
    if (unityMatch) {
      return this.parseUnityEvent(unityMatch[1], unityMatch[2]);
    }

    return null;
  }

  parseJSONLine(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      return null;
    }

    // Check for Match State messages
    // These have NodeStates or specific match structures
    if (data.NodeStates || data.nodeStates) {
      const matchStart = this.checkNodeStatesForMatch(data);
      if (matchStart) return matchStart;
    }

    // Check for MatchResult directly
    if (data.matchResult !== undefined || data.MatchResult !== undefined) {
      return this.handleMatchEnd(data);
    }

    // Check for result field
    if (data.result !== undefined || data.Result !== undefined) {
      // Could be a match end
      if (this.isMatchResult(data)) {
        return this.handleMatchEnd(data);
      }
    }

    // Check for winningTeamId
    if (data.winningTeamId !== undefined || data.WinningTeamId !== undefined) {
      return this.handleGameResult(data);
    }

    // Check for event name patterns
    const eventName = data.eventName || data.EventName || data.method || data.Method;
    if (eventName) {
      if (eventName.includes('MatchStart') || eventName === 'MatchState') {
        return this.handleMatchStart(data);
      }
      if (eventName.includes('MatchEnd')) {
        return this.handleMatchEnd(data);
      }
    }

    // Check for match-specific fields
    if (data.matchId || data.MatchId) {
      // This might be match-related data
      if (this.isMatchStartData(data)) {
        return this.handleMatchStart(data);
      }
    }

    // Check for deck submission
    if (data.submitDeckV2 || data.SubmitDeckV2 || data.deck || data.Deck) {
      return this.handleDeckSubmission(data);
    }

    // GRE/Game events
    if (data.greToClientEvent || data.GreToClientEvent || data.payload) {
      return this.handleGameEvent(data);
    }

    return null;
  }

  checkNodeStatesForMatch(data) {
    // NodeStates contain match progress info
    const nodes = data.NodeStates || data.nodeStates;
    if (!nodes) return null;

    // Look for PlayMatch node which indicates active match
    for (const [nodeName, nodeState] of Object.entries(nodes)) {
      if (nodeName.includes('PlayMatch') || nodeName.includes('Match')) {
        if (nodeState.Status === 'Active' || nodeState.Status === 'Started') {
          // Match is active - create or update match
          if (!this.currentMatch) {
            this.currentMatch = {
              matchId: 'match_' + Date.now(),
              eventId: 'unknown',
              format: 'Unknown',
              timestamp: new Date().toISOString()
            };

            return {
              type: 'MATCH_START',
              data: { ...this.currentMatch }
            };
          }
        }

        if (nodeState.Status === 'Completed' && this.currentMatch) {
          // Match ended - need to find result elsewhere
          // Don't return here, just update state
        }
      }
    }

    // Also check MilestoneStates
    const milestones = data.MilestoneStates || data.milestoneStates;
    if (milestones) {
      for (const [name, state] of Object.entries(milestones)) {
        if (name.includes('Match') && state.Status === 'Claimed') {
          // Match milestone completed - check for rewards that might indicate win
          if (this.currentMatch) {
            // Look at rewards to determine if it was a win
            const result = this.inferResultFromMilestone(state);
            if (result) {
              const matchData = {
                matchId: this.currentMatch.matchId,
                result: result,
                format: this.currentMatch.format,
                timestamp: new Date().toISOString()
              };

              this.currentMatch = null;

              return {
                type: 'MATCH_END',
                data: matchData
              };
            }
          }
        }
      }
    }

    return null;
  }

  inferResultFromMilestone(milestone) {
    // Try to infer win/loss from milestone rewards
    const rewards = milestone.RewardItems || milestone.rewards || [];
    // If there are rewards, likely a win
    if (rewards.length > 0) {
      return 'win';
    }
    return null;
  }

  parseUnityEvent(method, payload) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch (e) {
      return null;
    }

    if (method === 'MatchState' || method === 'MatchStart') {
      return this.handleMatchStart(data);
    }
    if (method === 'MatchEnd' || method === 'MatchResult') {
      return this.handleMatchEnd(data);
    }
    if (method === 'SubmitDeckV2') {
      return this.handleDeckSubmission(data);
    }

    return null;
  }

  handleMatchStart(data) {
    const matchId = data.matchId || data.MatchId ||
                   data.match_id || 'match_' + Date.now();
    const eventId = data.eventId || data.EventId ||
                   data.event_id || 'unknown';
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

    // Try all possible result fields
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

  handleGameResult(data) {
    const winningTeamId = data.winningTeamId || data.WinningTeamId;
    if (winningTeamId === undefined) return null;

    const playerTeamId = this.currentMatch?.playerTeamId || 1;
    const result = (winningTeamId === playerTeamId) ? 'win' : 'loss';

    if (this.currentMatch) {
      // Update current match with game result
      // Only count as match end if this is the final game
      return {
        type: 'GAME_END',
        data: {
          result,
          winningTeamId,
          timestamp: new Date().toISOString()
        }
      };
    }

    return null;
  }

  handleDeckSubmission(data) {
    const deckData = data.submitDeckV2 || data.SubmitDeckV2 ||
                     data.deck || data.Deck || data;

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
    // Handle GRE/Game events
    if (data.payload) {
      const payload = data.payload;

      // Check for game end in payload
      if (payload.winningTeamId !== undefined) {
        return this.handleGameResult(payload);
      }
    }

    return null;
  }

  isMatchResult(data) {
    // Check if this data represents a match result
    return data.matchResult !== undefined ||
           data.MatchResult !== undefined ||
           (data.result !== undefined && (data.matchId || data.MatchId)) ||
           data.winningTeamId !== undefined;
  }

  isMatchStartData(data) {
    // Check if this looks like match start data
    return data.eventName?.includes('Match') ||
           data.method?.includes('Match') ||
           data.gameRoomConfig ||
           data.GameRoomConfig;
  }

  detectFormat(data) {
    const formatType = data.formatType || data.FormatType ||
                      data.format || data.Format;

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
      if (lower === 'defeat' || lower === 'loss' || lower === 'defeated') return 'loss';
      if (lower === 'draw') return 'draw';
    }

    return 'unknown';
  }
}

module.exports = LogParserV3;
