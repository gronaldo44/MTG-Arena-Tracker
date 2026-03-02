/**
 * MTG Arena Log Parser v4
 * Based on actual MTG Arena log format with NodeStates
 */

class LogParserV4 {
  constructor() {
    this.currentMatch = null;
    this.pendingResult = null;
    this.processedMatches = new Set();
  }

  parse(data) {
    const events = [];
    const lines = data.split('\n');

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = this.parseLine(line);
      if (event) {
        // Avoid duplicate events
        const eventKey = `${event.type}_${event.data.matchId}_${event.data.timestamp}`;
        if (!this.processedMatches.has(eventKey)) {
          this.processedMatches.add(eventKey);
          events.push(event);
        }
      }
    }

    return events;
  }

  parseLine(line) {
    // Only parse JSON lines
    if (!line.trim().startsWith('{')) return null;

    let data;
    try {
      data = JSON.parse(line);
    } catch (e) {
      return null;
    }

    // Check for NodeStates - indicates active/completed game nodes
    if (data.NodeStates || data.nodeStates) {
      return this.parseNodeStates(data);
    }

    // Check for match result events
    if (data.matchResult !== undefined || data.MatchResult !== undefined) {
      return this.handleMatchResult(data);
    }

    // Check for explicit match end
    if (data.eventName === 'MatchEnd' || data.EventName === 'MatchEnd') {
      return this.handleMatchEnd(data);
    }

    // Check for winning team ID (game result)
    if (data.winningTeamId !== undefined || data.WinningTeamId !== undefined) {
      return this.handleGameResult(data);
    }

    // Check for match start
    if (data.eventName === 'MatchStart' || data.EventName === 'MatchStart') {
      return this.handleMatchStart(data);
    }

    return null;
  }

  parseNodeStates(data) {
    const nodes = data.NodeStates || data.nodeStates;
    const milestones = data.MilestoneStates || data.milestoneStates;

    // Look for PlayMatch node to detect match activity
    for (const [nodeName, nodeState] of Object.entries(nodes)) {
      // Match started
      if ((nodeName.includes('PlayMatch') || nodeName.includes('Match')) &&
          (nodeState.Status === 'Active' || nodeState.Status === 'Started')) {

        if (!this.currentMatch) {
          this.currentMatch = {
            matchId: `match_${Date.now()}`,
            startTime: Date.now(),
            format: this.detectFormatFromNodes(nodes),
            timestamp: new Date().toISOString()
          };

          return {
            type: 'MATCH_START',
            data: { ...this.currentMatch }
          };
        }
      }

      // Match ended
      if ((nodeName.includes('PlayMatch') || nodeName.includes('Match')) &&
          nodeState.Status === 'Completed') {

        if (this.currentMatch) {
          // Try to determine result from milestone rewards
          let result = 'unknown';

          if (milestones) {
            result = this.determineResultFromMilestones(milestones);
          }

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

    return null;
  }

  determineResultFromMilestones(milestones) {
    // Check milestone rewards to determine win/loss
    for (const [name, state] of Object.entries(milestones)) {
      if (name.includes('Match') || name.includes('Game')) {
        const rewards = state.RewardItems || state.rewards;
        if (rewards && rewards.length > 0) {
          // Has rewards = likely a win
          return 'win';
        }

        // Check if claimed/completed without rewards = likely a loss
        if (state.Status === 'Claimed' || state.Status === 'Completed') {
          return 'loss';
        }
      }
    }

    return 'unknown';
  }

  detectFormatFromNodes(nodes) {
    // Try to detect format from node names
    for (const nodeName of Object.keys(nodes)) {
      if (nodeName.includes('Standard')) return 'Standard';
      if (nodeName.includes('Alchemy')) return 'Alchemy';
      if (nodeName.includes('Historic')) return 'Historic';
      if (nodeName.includes('Explorer')) return 'Explorer';
      if (nodeName.includes('Brawl')) return 'Brawl';
      if (nodeName.includes('Draft')) return 'Draft';
      if (nodeName.includes('Sealed')) return 'Sealed';
    }
    return 'Unknown';
  }

  handleMatchStart(data) {
    this.currentMatch = {
      matchId: data.matchId || data.MatchId || `match_${Date.now()}`,
      eventId: data.eventId || data.EventId || 'unknown',
      format: this.detectFormat(data),
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchEnd(data) {
    const result = this.extractResult(data);

    const matchData = {
      matchId: this.currentMatch?.matchId || data.matchId || 'unknown',
      result: result,
      format: this.currentMatch?.format || this.detectFormat(data),
      timestamp: new Date().toISOString()
    };

    this.currentMatch = null;

    return {
      type: 'MATCH_END',
      data: matchData
    };
  }

  handleMatchResult(data) {
    const result = this.extractResult(data);

    return {
      type: 'MATCH_END',
      data: {
        matchId: this.currentMatch?.matchId || data.matchId || 'unknown',
        result: result,
        format: this.currentMatch?.format || 'Unknown',
        timestamp: new Date().toISOString()
      }
    };
  }

  handleGameResult(data) {
    const winningTeamId = data.winningTeamId || data.WinningTeamId;
    const playerTeamId = 1; // Assume player is team 1

    const result = (winningTeamId === playerTeamId) ? 'win' : 'loss';

    // Store pending result - might be updated by match end
    this.pendingResult = result;

    return {
      type: 'GAME_END',
      data: {
        result: result,
        winningTeamId: winningTeamId,
        timestamp: new Date().toISOString()
      }
    };
  }

  extractResult(data) {
    if (data.result !== undefined) return this.normalizeResult(data.result);
    if (data.Result !== undefined) return this.normalizeResult(data.Result);
    if (data.matchResult !== undefined) return this.normalizeResult(data.matchResult);
    if (data.MatchResult !== undefined) return this.normalizeResult(data.MatchResult);

    return this.pendingResult || 'unknown';
  }

  detectFormat(data) {
    const formatType = data.formatType || data.FormatType || data.format || data.Format;
    if (formatType) return this.normalizeFormat(formatType);

    const eventId = data.eventId || data.EventId || data.event_id;
    if (eventId) return this.formatFromEventId(eventId);

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

module.exports = LogParserV4;
