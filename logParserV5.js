/**
 * MTG Arena Log Parser v5
 * Handles actual UnityCrossThreadLogger format with timestamps
 */

class LogParserV5 {
  constructor() {
    this.currentMatch = null;
    this.matchStartTime = null;
    this.processedEvents = new Set();
    this.pendingResult = null; // Track result from game end events
    this.deckNames = new Map(); // Cache deck names by timestamp/event
    this.deckCards = null; // Store deck cards found in log
    this.playerSeatId = 1; // Default, will be detected from game state
  }

  parse(data) {
    const events = [];
    const lines = data.split('\n');

    // Clear any stale data from previous scans
    this.currentMatch = null;
    this.matchStartTime = null;
    this.pendingResult = null;
    this.playerSeatId = 1;
    this.processedEvents.clear(); // Clear processed events to allow fresh detection

    // Pre-parse to extract deck names and deck cards
    this.extractDeckNames(lines);
    this.extractDeckCards(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const event = this.parseLine(line, lines, i);
      if (event) {
        // Better duplicate detection using matchId and type
        const matchId = event.data.matchId || 'unknown';
        const result = event.data.result || 'none';
        // Include result in key for match end events - same match can have multiple results (bo3)
        let eventKey;
        if (event.type === 'MATCH_END') {
          eventKey = `${event.type}_${matchId}_${result}_${event.data.timestamp?.split('T')[0] || 'unknown'}`;
        } else if (event.type === 'INVENTORY_UPDATE') {
          // Inventory updates use timestamp to allow multiple updates
          eventKey = `${event.type}_${event.data.timestamp}`;
        } else {
          eventKey = `${event.type}_${matchId}`;
        }

        if (!this.processedEvents.has(eventKey)) {
          this.processedEvents.add(eventKey);
          events.push(event);
        } else {
          console.log(`[Parser] Skipping duplicate event: ${eventKey}`);
        }
      }
    }

    // Limit processed events set size
    if (this.processedEvents.size > 1000) {
      const entries = Array.from(this.processedEvents).slice(-500);
      this.processedEvents = new Set(entries);
    }

    return events;
  }

  parseLine(line, allLines, index) {
    // UnityCrossThreadLogger format with timestamp:
    // [UnityCrossThreadLogger]2/27/2026 3:40:07 PM: Match to XXCFERDVHJCHTPGSJVKHNMLKW4: MatchGameRoomStateType

    // Check for STATE CHANGED to Playing (match start)
    if (line.includes('STATE CHANGED') && line.includes('"new":"Playing"')) {
      return this.handleMatchStartFromState(line);
    }

    // Check for MatchGameRoomState (match started/connecting)
    if (line.includes('MatchGameRoomStateType') || line.includes('MatchGameRoomState')) {
      if (!this.currentMatch) {
        return this.handleMatchStartFromGameRoom(line, allLines, index);
      }
    }

    // Check for STATE CHANGED to MatchCompleted
    if (line.includes('STATE CHANGED') && line.includes('"new":"MatchCompleted"')) {
      return this.handleMatchCompleted(line, allLines, index);
    }

    // Check for scene changes
    if (line.includes('OnSceneLoaded for MatchEndScene')) {
      return this.handleMatchEndScene(line, allLines, index);
    }

    // Check for OnExitMatchScene
    if (line.includes('OnExitMatchScene')) {
      return this.handleMatchExit(line);
    }

    // Check for match results in JSON
    if (line.includes('"resultType"') || line.includes('"ResultType"')) {
      return this.handleResultFromJSON(line);
    }

    // Check for InventoryInfo (player resources)
    if (line.includes('"InventoryInfo"')) {
      return this.handleInventoryInfo(line);
    }

    // Check for GRE game end
    if (line.includes('"gameEndReason"') || line.includes('"winningTeamId"')) {
      return this.handleGameEnd(line);
    }

    return null;
  }

  handleMatchStartFromState(line) {
    // If we already have a match from GameRoom, don't overwrite it
    if (this.currentMatch) {
      return null;
    }

    // Extract timestamp and match info from Unity log
    // Format: [UnityCrossThreadLogger]2/27/2026 3:40:07 PM: Match to ...
    const match = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = match ? match[1].trim() : new Date().toISOString();

    this.currentMatch = {
      matchId: `match_${Date.now()}`,
      startTime: timestamp,
      format: 'Unknown',
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchStartFromGameRoom(line, allLines, index) {
    // Extract timestamp
    // Format: [UnityCrossThreadLogger]2/27/2026 3:40:07 PM: Match to ...
    const match = line.match(/\[UnityCrossThreadLogger\](\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M):/);
    const timestamp = match ? match[1].trim() : new Date().toISOString();

    // Try to extract match ID from line
    const idMatch = line.match(/Match to ([^:]+):/);
    const matchId = idMatch ? idMatch[1].trim() : `match_${Date.now()}`;

    // Try to detect format from nearby lines (look ahead)
    let format = 'Unknown';
    let deckName = 'Unknown Deck';

    // First, look BACKWARDS for deck submission (happens before match)
    for (let i = index; i >= Math.max(0, index - 200); i--) {
      const checkLine = allLines[i];

      // Look for deck submission in Courses data
      if (checkLine.includes('"CourseDeckSummary"')) {
        const nameMatch = checkLine.match(/"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch && nameMatch[1].trim()) {
          deckName = nameMatch[1].trim();
          console.log(`[Parser] Found deck name from earlier CourseDeckSummary: ${deckName}`);
          break;
        }
      }

      // Look for deck name in Courses array
      if (checkLine.includes('"Courses"')) {
        const coursesMatch = checkLine.match(/"Courses".*?"Name"\s*:\s*"([^"]+)"/s);
        if (coursesMatch && coursesMatch[1].trim()) {
          deckName = coursesMatch[1].trim();
          console.log(`[Parser] Found deck name from earlier Courses: ${deckName}`);
          break;
        }
      }
    }

    let opponentName = null;
    let playerDeck = null;
    let opponentDeck = null;
    let actualMatchId = matchId; // Will try to find the real matchId from JSON

    // First: detect player seat ID from game state (scan forwards from match start)
    // This appears shortly after match start in game state messages
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

    // Second pass: find opponent and other data (forwards)
    let reservedPlayersData = null;
    for (let i = index; i < Math.min(index + 100, allLines.length); i++) {
      const checkLine = allLines[i];

      // Look for the actual matchId in JSON (more reliable than 'Match to' line)
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      if (checkLine.includes('"matchId"')) {
        const matchIdMatch = checkLine.match(/"matchId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
        if (matchIdMatch) {
          actualMatchId = matchIdMatch[1];
          console.log(`[Parser] Found actual matchId from JSON: ${actualMatchId}`);
        }
      }

      // Look for format - check both InternalEventName and eventId
      if (checkLine.includes('"InternalEventName"')) {
        const formatMatch = checkLine.match(/"InternalEventName"\s*:\s*"([^"]+)"/);
        if (formatMatch) {
          format = this.detectFormatFromEventName(formatMatch[1]);
          // Check if we have a cached deck for this event
          if (this.deckNames.has(formatMatch[1])) {
            deckName = this.deckNames.get(formatMatch[1]);
            console.log(`[Parser] Using cached deck name: ${deckName}`);
          }
        }
      }
      if (format === 'Unknown' && checkLine.includes('"eventId"')) {
        const eventMatch = checkLine.match(/"eventId"\s*:\s*"([^"]+)"/);
        if (eventMatch) {
          format = this.detectFormatFromEventName(eventMatch[1]);
        }
      }

      // Store reservedPlayers for later processing (after we know player seat)
      if (!reservedPlayersData && checkLine.includes('"reservedPlayers"')) {
        const playersMatch = checkLine.match(/"reservedPlayers"\s*:\s*(\[.*?\])/);
        if (playersMatch) {
          reservedPlayersData = playersMatch[1];
        }
      }

      // Look for deck name in various patterns
      // Pattern 1: "CourseName":"Deck Name"
      if (checkLine.includes('"CourseName"') || checkLine.includes('"courseName"')) {
        const deckMatch = checkLine.match(/"[Cc]ourseName"\s*:\s*"([^"]+)"/);
        if (deckMatch && deckMatch[1].trim()) {
          deckName = deckMatch[1].trim();
          console.log(`[Parser] Found deck name: ${deckName}`);
        }
      }

      // Pattern 2: "DeckName":"Deck Name"
      if (checkLine.includes('"DeckName"') || checkLine.includes('"deckName"')) {
        const deckMatch = checkLine.match(/"[Dd]eckName"\s*:\s*"([^"]+)"/);
        if (deckMatch && deckMatch[1].trim()) {
          deckName = deckMatch[1].trim();
          console.log(`[Parser] Found deck name: ${deckName}`);
        }
      }

      // Pattern 3: SubmitDeck or deck submission
      if (checkLine.includes('"SubmitDeck"') || checkLine.includes('"submitDeck"')) {
        const submitMatch = checkLine.match(/"[Dd]eck[Nn]ame"\s*:\s*"([^"]+)"/);
        if (submitMatch && submitMatch[1].trim()) {
          deckName = submitMatch[1].trim();
          console.log(`[Parser] Found deck from submission: ${deckName}`);
        }
      }

      // Pattern 4: CourseDeckSummary with deck name (from PlayerCourse events)
      if (checkLine.includes('"CourseDeckSummary"')) {
        const nameMatch = checkLine.match(/"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch && nameMatch[1].trim()) {
          deckName = nameMatch[1].trim();
          console.log(`[Parser] Found deck name from CourseDeckSummary: ${deckName}`);
        }
      }

      // Pattern 5: Deck summary in Courses array
      if (checkLine.includes('"Courses"') || checkLine.includes('"CourseDeckSummary"')) {
        const deckSummaryMatch = checkLine.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (deckSummaryMatch && deckSummaryMatch[1].trim()) {
          deckName = deckSummaryMatch[1].trim();
          console.log(`[Parser] Found deck name from Courses: ${deckName}`);
        }
      }
    }

    // Process opponent after we know player seat ID
    if (reservedPlayersData) {
      try {
        const players = JSON.parse(reservedPlayersData);
        const opponent = players.find(p => p.systemSeatId !== this.playerSeatId);
        if (opponent) {
          opponentName = opponent.playerName;
          console.log(`[Parser] Found opponent: ${opponentName} (player is seat ${this.playerSeatId})`);
        }
      } catch (e) {
        // Fallback to regex
        const targetSeat = this.playerSeatId === 1 ? 2 : 1;
        const oppMatch = reservedPlayersData.match(new RegExp(`"playerName"\\s*:\\s*"([^"]+)".*?"systemSeatId"\\s*:\\s*${targetSeat}`));
        if (oppMatch) {
          opponentName = oppMatch[1];
          console.log(`[Parser] Found opponent via regex: ${opponentName}`);
        }
      }
    }

    this.currentMatch = {
      matchId: actualMatchId,
      startTime: timestamp,
      format: format,
      deckName: deckName,
      opponentName: opponentName,
      playerDeck: playerDeck || this.deckCards,
      timestamp: new Date().toISOString()
    };

    return {
      type: 'MATCH_START',
      data: { ...this.currentMatch }
    };
  }

  handleMatchCompleted(line, allLines, index) {
    // STATE CHANGED to MatchCompleted - look for result in nearby lines
    if (!this.currentMatch) return null;

    let result = this.pendingResult || 'unknown';

    // Look ahead for result information
    for (let i = index + 1; i < Math.min(index + 20, allLines.length); i++) {
      const nextLine = allLines[i];

      // Check for victory/defeat indicators
      if (nextLine.includes('Victory') || nextLine.includes('"resultType":"Victory"')) {
        result = 'win';
        break;
      }
      if (nextLine.includes('Defeat') || nextLine.includes('"resultType":"Defeat"')) {
        result = 'loss';
        break;
      }
      if (nextLine.includes('Draw') || nextLine.includes('"resultType":"Draw"')) {
        result = 'draw';
        break;
      }

      // Check for winning team
      if (nextLine.includes('"winningTeamId"')) {
        const teamMatch = nextLine.match(/"winningTeamId"\s*:\s*(\d+)/);
        if (teamMatch) {
          const winningTeam = parseInt(teamMatch[1]);
          // Player's teamId equals their seatId in 2-player games
          const playerTeam = this.playerSeatId;
          result = winningTeam === playerTeam ? 'win' : 'loss';
          console.log(`[Parser] Match end (lookahead): winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);
          break;
        }
      }
    }

    // Also check lines before for result (game end events come before match completed)
    if (result === 'unknown') {
      for (let i = Math.max(0, index - 50); i < index; i++) {
        const prevLine = allLines[i];
        if (prevLine.includes('Victory') || prevLine.includes('"resultType":"Victory"')) {
          result = 'win';
          break;
        }
        if (prevLine.includes('Defeat') || prevLine.includes('"resultType":"Defeat"')) {
          result = 'loss';
          break;
        }
        if (prevLine.includes('"winningTeamId"')) {
          const teamMatch = prevLine.match(/"winningTeamId"\s*:\s*(\d+)/);
          if (teamMatch) {
            const winningTeam = parseInt(teamMatch[1]);
            // Player's teamId equals their seatId in 2-player games
            const playerTeam = this.playerSeatId;
            result = winningTeam === playerTeam ? 'win' : 'loss';
            console.log(`[Parser] Match end (lookback): winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);
            break;
          }
        }
      }
    }

    const matchData = {
      matchId: this.currentMatch.matchId,
      result: result,
      format: this.currentMatch.format,
      deckName: this.currentMatch.deckName || 'Unknown Deck',
      opponentName: this.currentMatch.opponentName || null,
      playerDeck: this.currentMatch.playerDeck || null,
      timestamp: new Date().toISOString()
    };

    console.log(`[Parser] Match ended: ${matchData.matchId}, Result: ${result}, Deck: ${matchData.deckName}, Opponent: ${matchData.opponentName}`);

    // Clear pending result and current match
    this.pendingResult = null;

    // Don't clear currentMatch yet - wait for MatchEndScene
    return {
      type: 'MATCH_END',
      data: matchData
    };
  }

  handleMatchEndScene(line, allLines, index) {
    // OnSceneLoaded for MatchEndScene - match has fully ended
    // Just clean up currentMatch - don't emit event (already handled by handleMatchCompleted)
    this.currentMatch = null;
    return null;
  }

  handleMatchExit(line) {
    // OnExitMatchScene - final cleanup
    // Just clean up currentMatch - don't emit event (already handled by handleMatchCompleted)
    this.currentMatch = null;
    return null;
  }

  handleResultFromJSON(line) {
    try {
      const data = JSON.parse(line);
      const resultType = data.resultType || data.ResultType;

      if (resultType) {
        const result = this.normalizeResult(resultType);

        return {
          type: 'GAME_END',
          data: {
            result: result,
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
      // Not valid JSON or no result
    }

    return null;
  }

  handleGameEnd(line) {
    try {
      const data = JSON.parse(line);

      if (data.winningTeamId !== undefined) {
        const winningTeam = data.winningTeamId;
        // Player's teamId equals their seatId in 2-player games
        const playerTeam = this.playerSeatId;
        const result = winningTeam === playerTeam ? 'win' : 'loss';
        console.log(`[Parser] Game end detected: winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);

        // Store for match end
        this.pendingResult = result;

        return {
          type: 'GAME_END',
          data: {
            result: result,
            winningTeamId: winningTeam,
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
      // Not valid JSON
    }

    return null;
  }

  handleInventoryInfo(line) {
    try {
      const data = JSON.parse(line);
      if (data.InventoryInfo) {
        const info = data.InventoryInfo;
        return {
          type: 'INVENTORY_UPDATE',
          data: {
            gems: info.Gems || 0,
            gold: info.Gold || 0,
            totalVaultProgress: info.TotalVaultProgress || 0,
            wildCardCommons: info.WildCardCommons || 0,
            wildCardUnCommons: info.WildCardUnCommons || 0,
            wildCardRares: info.WildCardRares || 0,
            wildCardMythics: info.WildCardMythics || 0,
            boosters: info.Boosters || [],
            timestamp: new Date().toISOString()
          }
        };
      }
    } catch (e) {
      // Not valid JSON
    }
    return null;
  }

  normalizeResult(result) {
    if (typeof result === 'string') {
      const lower = result.toLowerCase();
      if (lower === 'victory') return 'win';
      if (lower === 'defeat') return 'loss';
      if (lower === 'draw') return 'draw';
    }
    return 'unknown';
  }

  extractDeckCards(lines) {
    console.log(`[Parser] Searching for deck cards in ${lines.length} lines...`);
    // Look through all lines for deck card data (only use first match for now)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('"deckMessage"') && line.includes('"deckCards"')) {
        console.log(`[Parser] Found deckMessage with deckCards at line ${i}`);
        try {
          // Extract deckCards array
          const cardsMatch = line.match(/"deckCards"\s*:\s*(\[[^\]]*\])/);
          if (cardsMatch) {
            const deckCards = JSON.parse(cardsMatch[1]);
            // Look for commander cards
            let commanderCards = [];
            const cmdrMatch = line.match(/"commanderCards"\s*:\s*(\[[^\]]*\])/);
            if (cmdrMatch) {
              commanderCards = JSON.parse(cmdrMatch[1]);
            }
            // Look for sideboard cards
            let sideboardCards = [];
            const sbMatch = line.match(/"sideboardCards"\s*:\s*(\[[^\]]*\])/);
            if (sbMatch) {
              sideboardCards = JSON.parse(sbMatch[1]);
            }
            this.deckCards = {
              deckCards: deckCards,
              sideboardCards: sideboardCards,
              commandZoneCards: commanderCards
            };
            console.log(`[Parser] Cached deck cards: ${deckCards.length} main, ${sideboardCards.length} sideboard, ${commanderCards.length} commanders`);
            console.log(`[Parser] First 5 card IDs: ${deckCards.slice(0, 5).join(', ')}`);
            return; // Only need first occurrence
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
    // Look through the first 500 lines for deck submissions
    for (let i = 0; i < Math.min(500, lines.length); i++) {
      const line = lines[i];

      // Look for Courses array with deck data
      if (line.includes('"Courses"')) {
        // Extract all deck names from this line
        const coursesMatch = line.match(/"Courses":\s*(\[.*?\])/);
        if (coursesMatch) {
          try {
            const coursesData = JSON.parse(coursesMatch[1]);
            coursesData.forEach(course => {
              if (course.CourseDeckSummary && course.CourseDeckSummary.Name) {
                const eventName = course.InternalEventName || 'Unknown';
                this.deckNames.set(eventName, course.CourseDeckSummary.Name);
                console.log(`[Parser] Cached deck for ${eventName}: ${course.CourseDeckSummary.Name}`);
              }
            });
          } catch (e) {
            // JSON parse failed, try regex extraction
            const nameMatches = line.matchAll(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/g);
            for (const match of nameMatches) {
              const deckName = match[1];
              console.log(`[Parser] Found deck name via regex: ${deckName}`);
            }
          }
        }
      }

      // Also look for single CourseDeck entries
      if (line.includes('"CourseDeckSummary"')) {
        const nameMatch = line.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
          console.log(`[Parser] Found deck in early lines: ${nameMatch[1]}`);
        }
      }
    }
  }

  formatCourseId(courseId) {
    // Convert courseId like "Avatar_Basic_Adventurer" to readable name
    if (!courseId) return 'Unknown Deck';
    // Extract the meaningful part after Avatar_Basic_
    const match = courseId.match(/Avatar_Basic_(.+)/);
    if (match) {
      return match[1].replace(/_/g, ' ');
    }
    return courseId.replace(/_/g, ' ');
  }

  detectFormatFromEventName(eventName) {
    if (!eventName) return 'Unknown';
    const name = eventName.toLowerCase();

    if (name.includes('standard')) return 'Standard';
    if (name.includes('alchemy')) return 'Alchemy';
    if (name.includes('historic')) {
      if (name.includes('brawl')) return 'Historic Brawl';
      if (name.includes('play')) return 'Historic';
      return 'Historic';
    }
    if (name === 'historic_play') return 'Historic';
    if (name.includes('explorer')) return 'Explorer';
    if (name.includes('pioneer')) return 'Pioneer';
    if (name.includes('timeless')) return 'Timeless';
    if (name.includes('brawl')) return 'Brawl';
    if (name.includes('draft')) return 'Draft';
    if (name.includes('sealed')) return 'Sealed';
    if (name.includes('constructed')) return 'Constructed';

    return 'Unknown';
  }
}

module.exports = LogParserV5;
