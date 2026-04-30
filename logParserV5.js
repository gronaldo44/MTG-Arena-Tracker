/**
 * MTG Arena Log Parser v5
 * Handles actual UnityCrossThreadLogger format with timestamps
 */

const { SET_NAMES, SKIP_CODES } = require('./sets');

class LogParserV5 {
  constructor() {
    this.currentMatch = null;
    this.matchStartTime = null;
    this.processedEvents = new Set();
    this.pendingResult = null; // Track result from game end events
    this.deckNames = new Map(); // Cache deck names by timestamp/event
    this.deckCards = null; // Store deck cards found in log
    this.playerSeatId = 1; // Default, will be detected from game state
    this.currentDraft = null;
  }
 
  parse(data) {
    const events = [];
    const lines = data.split('\n');
 
    // Clear any stale data from previous scans
    this.currentMatch = null;
    this.matchStartTime = null;
    this.pendingResult = null;
    this.playerSeatId = 1;
    this.currentDraft = null; // Always rebuild draft state from scratch each parse
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
        } else if (event.type === 'DRAFT_PICK') {
          // DRAFT_PICK is a legacy type — currently not emitted, but key it properly if it ever is
          eventKey = `DRAFT_PICK_${event.data.draftId}_${event.data.pack}_${event.data.pick}`;
        } else if (event.type === 'DRAFT_UPDATE') {
          // Never deduplicate DRAFT_UPDATE — the parser rebuilds full draft state each scan,
          // and we always want the renderer to receive the latest pack/pick state.
          // Use a unique key so it always passes through.
          eventKey = `DRAFT_UPDATE_${event.data.draftId}_${event.data.currentPack?.pack}_${event.data.currentPack?.pick}_${event.data.picks?.length ?? 0}_${i}`;
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
 
    // Check for draft packs
    if (line.includes('Draft.Notify')) {
      return this.handleDraftNotify(line);
    }
 
    // Check for draft picks
    if (line.includes('EventPlayerDraftMakePick')) {
      return this.handleDraftPick(line);
    }
 
    return null;
  }
 
  handleDraftPick(line) {
    try {
      const requestMatch = line.match(/"request":"(.*)"/);
      if (!requestMatch) return null;
 
      const requestJson = JSON.parse(requestMatch[1].replace(/\\"/g, '"'));
      const pickedCard = requestJson.GrpIds?.[0];
 
      if (!this.currentDraft) return null;
 
      const pickData = {
        draftId: requestJson.DraftId,
        pack: requestJson.Pack,
        pick: requestJson.Pick,
        picked: pickedCard,
        options: this.currentDraft.currentPack?.options || []
      };
 
      this.currentDraft.picks.push(pickData);
 
      return {
        type: 'DRAFT_UPDATE',
        data: this.currentDraft
      };
    } catch {
      return null;
    }
  }
 
  handleDraftNotify(line) {
    try {
      // The line format from MTGA is:
      //   [UnityCrossThreadLogger]4/26/2026 1:23:45 PM: Draft.Notify {"draftId":...}
      // We find the first '{' after 'Draft.Notify' to extract the JSON robustly.
      const notifyIdx = line.indexOf('Draft.Notify');
      if (notifyIdx === -1) return null;

      const jsonStart = line.indexOf('{', notifyIdx);
      if (jsonStart === -1) return null;

      const data = JSON.parse(line.slice(jsonStart));

      if (!data.draftId) {
        console.log('[Parser] Draft.Notify missing draftId:', line.slice(0, 120));
        return null;
      }

      const packCards = data.PackCards
        ? data.PackCards.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
        : [];

      console.log(`[Parser] Draft.Notify: draftId=${data.draftId} pack=${data.SelfPack} pick=${data.SelfPick} cards=${packCards.length}`);

      // Start new draft or continue existing one
      if (!this.currentDraft || this.currentDraft.draftId !== data.draftId) {
        this.currentDraft = {
          draftId: data.draftId,
          picks: [],
          currentPack: null
        };
      }

      this.currentDraft.currentPack = {
        pack: data.SelfPack,
        pick: data.SelfPick,
        options: packCards
      };

      return {
        type: 'DRAFT_UPDATE',
        data: this.currentDraft
      };
    } catch (e) {
      console.log('[Parser] Failed to parse Draft.Notify:', e.message, '| line:', line.slice(0, 120));
      return null;
    }
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
          console.log(`[Parser] Found deck name from Courses: ${deckSummaryMatch[1].trim()}`);
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
    this.currentMatch = null;
    return null;
  }
 
  handleMatchExit(line) {
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
        const playerTeam = this.playerSeatId;
        const result = winningTeam === playerTeam ? 'win' : 'loss';
        console.log(`[Parser] Game end detected: winningTeam=${winningTeam}, playerTeam=${playerTeam}, result=${result}`);
 
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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('"deckMessage"') && line.includes('"deckCards"')) {
        console.log(`[Parser] Found deckMessage with deckCards at line ${i}`);
        try {
          const cardsMatch = line.match(/"deckCards"\s*:\s*(\[[^\]]*\])/);
          if (cardsMatch) {
            const deckCards = JSON.parse(cardsMatch[1]);
            let commanderCards = [];
            const cmdrMatch = line.match(/"commanderCards"\s*:\s*(\[[^\]]*\])/);
            if (cmdrMatch) {
              commanderCards = JSON.parse(cmdrMatch[1]);
            }
            let sideboardCards = [];
            const sbMatch = line.match(/"sideboardCards"\s*:\s*(\[[^\]]*\])/);
            if (sbMatch) {
              sideboardCards = JSON.parse(sbMatch[1]);
            }
            // Store in this.deckCards so handleMatchStartFromGameRoom can pick it up.
            this.deckCards = {
              deckCards: deckCards,
              sideboardCards: sideboardCards,
              commandZoneCards: commanderCards
            };
            console.log(`[Parser] Cached deck cards: ${deckCards.length} main, ${sideboardCards.length} sideboard, ${commanderCards.length} commanders`);
            console.log(`[Parser] First 5 card IDs: ${deckCards.slice(0, 5).join(', ')}`);
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
              if (course.CourseDeckSummary && course.CourseDeckSummary.Name) {
                const eventName = course.InternalEventName || 'Unknown';
                this.deckNames.set(eventName, course.CourseDeckSummary.Name);
                console.log(`[Parser] Cached deck for ${eventName}: ${course.CourseDeckSummary.Name}`);
              }
            });
          } catch (e) {
            const nameMatches = line.matchAll(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/g);
            for (const match of nameMatches) {
              const deckName = match[1];
              console.log(`[Parser] Found deck name via regex: ${deckName}`);
            }
          }
        }
      }
 
      if (line.includes('"CourseDeckSummary"')) {
        const nameMatch = line.match(/"CourseDeckSummary".*?"Name"\s*:\s*"([^"]+)"/);
        if (nameMatch) {
          console.log(`[Parser] Found deck in early lines: ${nameMatch[1]}`);
        }
      }
    }
  }
 
  formatCourseId(courseId) {
    if (!courseId) return 'Unknown Deck';
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
      return 'Historic';
    }
    if (name.includes('explorer')) return 'Explorer';
    if (name.includes('pioneer')) return 'Pioneer';
    if (name.includes('timeless')) return 'Timeless';
    if (name.includes('brawl')) return 'Brawl';
    if (name.includes('constructed')) return 'Constructed';
    if (name.includes('draft') || name.includes('sealed')) return this.detectDraftFormat(eventName);

    return 'Unknown';
  }

  /**
   * Given a draft/sealed event name, return a specific format label that
   * includes the set name, e.g. "Secrets of Strixhaven Quick Draft".
   *
   * MTGA event names follow patterns like:
   *   Human_PremierDraft_SOS_20260401
   *   Traditional_PremierDraft_SOS
   *   Draft_QuickDraft_SOS
   *   Human_SealedDeck_SOS
   *
   * The set code is the 2–4 uppercase-only segment that isn't a type keyword.
   */
  detectDraftFormat(eventName) {
    const name = eventName.toLowerCase();

    // Determine draft subtype
    let draftType;
    if (name.includes('sealed')) draftType = 'Sealed';
    else if (name.includes('quick')) draftType = 'Quick Draft';
    else if (name.includes('traditional')) draftType = 'Traditional Draft';
    else draftType = 'Draft';

    // Extract set code: a segment of 2–4 all-uppercase letters that isn't a
    // common keyword (those use mixed case like "PremierDraft", "QuickDraft").
    const setCode = eventName
      .split(/[_\-\s]+/)
      .find(p => /^[A-Z]{2,4}$/.test(p) && !SKIP_CODES.has(p)) ?? null;

    if (setCode) {
      const setName = SET_NAMES[setCode] ?? setCode;
      return `${setName} ${draftType}`;
    }

    return draftType;
  }
}
 
module.exports = LogParserV5;