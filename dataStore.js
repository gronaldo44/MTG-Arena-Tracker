/**
 * Data Store for MTG Arena Tracker
 * Manages saving and loading match data
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class DataStore {
  constructor() {
    // Determine data directory based on environment
    if (process.type === 'browser' || process.type === undefined) {
      // Main process
      this.dataDir   = path.join(app.getPath('userData'), 'data');
      this.cardsFile = path.join(app.getPath('userData'), 'cards.json');
    } else {
      // Renderer process - use app.getPath won't work, use a default
      this.dataDir   = path.join(require('os').homedir(), '.mtg-arena-tracker', 'data');
      this.cardsFile = path.join(require('os').homedir(), '.mtg-arena-tracker', 'cards.json');
    }

    this.dataFile     = path.join(this.dataDir, 'matches.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.cardStatsFile = path.join(this.dataDir, 'cardStats.json');
    this.draftsFile   = path.join(this.dataDir, 'drafts.json');

    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load existing data
    this.data       = this.loadData();
    this.settings   = this.loadSettings();
    this.cards      = this.loadCards();
    this.cardStats  = this.loadCardStats();
    this.drafts     = this.loadDrafts();

    // One-time migration: collapse any cross-day duplicates created before the
    // addMatch dedup fix (parser always stamps with new Date(), not log time).
    this._deduplicateMatches();
    // One-time migration: backfill the `id` field for matches recorded before
    // it was added to the schema (prevents all such matches sharing data-match-id="undefined").
    this._backfillMatchIds();
    // One-time migration: rename bare "… Draft" format labels to "… Premier Draft"
    // for matches recorded before the parser distinguished Premier Draft from other draft types.
    this._backfillPremierDraft();
    // One-time migration: reorder "[Set] Premier Draft" → "Premier Draft [Set]".
    this._reorderPremierDraft();
  }

  /**
   * Load card database
   */
  loadCards() {
    try {
      if (fs.existsSync(this.cardsFile)) {
        const content = fs.readFileSync(this.cardsFile, 'utf8');
        const cardsData = JSON.parse(content);
        const cards = cardsData.cards || {};
        this.mainDraftSets = Array.isArray(cardsData.mainDraftSets) ? cardsData.mainDraftSets : [];
        const cardCount = Object.keys(cards).length;
        console.log(`[DataStore] Loaded ${cardCount} cards from database`);
        if (cardsData.lastUpdated) {
          console.log(`[DataStore] Card database last updated: ${cardsData.lastUpdated}`);
        }
        return cards;
      }
    } catch (error) {
      console.error('[DataStore] Error loading cards database:', error);
    }
    this.mainDraftSets = [];
    console.log('[DataStore] No card database found, card names will not be available');
    return {};
  }

  /**
   * Reload card database (useful after update)
   */
  reloadCards() {
    this.cards = this.loadCards();
    return this.cards;
  }

  /**
   * Returns the precomputed list of main draftable sets, ordered most-recent-first.
   * Each entry: { code, primaryCount, firstGrpId }. Populated by import_sos.py.
   */
  getMainDraftSets() {
    return this.mainDraftSets || [];
  }

  /**
   * Returns [{ grpId, name, manaCost, type }] for every card whose `set`
   * matches the given code. Special Guests for the same parent set
   * (digitalReleaseSet === `SPG-${setCode}`) are included so the browse view
   * mirrors the actual draft pool.
   */
  getCardsBySet(setCode) {
    if (!setCode) return [];
    const spgKey = `SPG-${setCode}`;
    const result = [];
    for (const [grpId, card] of Object.entries(this.cards)) {
      if (card.set === setCode || card.digitalReleaseSet === spgKey) {
        result.push({ grpId, ...card });
      }
    }
    return result;
  }

  /**
   * Get card name by ID
   */
  getCardName(cardId) {
    const card = this.cards[cardId];
    return card ? card.name : `Card ${cardId}`;
  }

  /**
   * Get full card info by ID
   */
  getCardInfo(cardId) {
    return this.cards[cardId] || { name: `Card ${cardId}`, manaCost: '?', type: 'Unknown' };
  }

  /**
   * Load data from file
   */
  loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const content = fs.readFileSync(this.dataFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    }

    return {
      matches: [],
      decks: {},
      inventory: {
        gems: 0,
        gold: 0,
        totalVaultProgress: 0,
        wildCardCommons: 0,
        wildCardUnCommons: 0,
        wildCardRares: 0,
        wildCardMythics: 0,
        boosters: [],
        lastUpdated: null
      }
    };
  }

  /**
   * Load settings from file
   */
  loadSettings() {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const content = fs.readFileSync(this.settingsFile, 'utf8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }

    return {
      logPath: '',
      autoLaunch: false,
      minimizeToTray: true
    };
  }

  /**
   * Save data to file
   */
  saveData() {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Error saving data:', error);
    }
  }

  /**
   * Save settings to file
   */
  saveSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  /**
   * Update inventory data
   */
  updateInventory(inventoryData) {
    this.data.inventory = {
      ...this.data.inventory,
      ...inventoryData,
      lastUpdated: new Date().toISOString()
    };
    this.saveData();
    console.log('[DataStore] Inventory updated:', inventoryData);
  }

  /**
   * Get inventory data
   */
  getInventory() {
    return this.data.inventory;
  }

  /**
   * Add or update a deck with full card data
   */
  addDeck(deckData) {
    // Generate deck ID from name if not provided
    const deckId = deckData.id || deckData.deckId ||
      ('deck_' + (deckData.name || deckData.deckName || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_'));

    // Check if deck already exists
    const existingDeck = this.data.decks[deckId];

    if (existingDeck) {
      // Update existing deck with new data, preserving existing data if not provided
      this.data.decks[deckId] = {
        ...existingDeck,
        id: deckId,
        name: deckData.name || deckData.deckName || existingDeck.name,
        format: deckData.format || existingDeck.format,
        // Only update card data if provided and not empty
        mainDeck: (deckData.mainDeck && deckData.mainDeck.length > 0)
          ? deckData.mainDeck
          : existingDeck.mainDeck,
        sideboard: (deckData.sideboard && deckData.sideboard.length > 0)
          ? deckData.sideboard
          : existingDeck.sideboard,
        commandZone: (deckData.commandZone && deckData.commandZone.length > 0)
          ? deckData.commandZone
          : existingDeck.commandZone,
        lastUsed: deckData.timestamp || new Date().toISOString()
      };
      console.log(`[DataStore] Updated existing deck: ${deckId}`);
    } else {
      // Create new deck
      this.data.decks[deckId] = {
        id: deckId,
        name: deckData.name || deckData.deckName || 'Unknown Deck',
        format: deckData.format || 'Unknown',
        mainDeck: deckData.mainDeck || [],
        sideboard: deckData.sideboard || [],
        commandZone: deckData.commandZone || [],
        colors: deckData.colors || 0,
        lastUsed: deckData.timestamp || new Date().toISOString()
      };
      console.log(`[DataStore] Created new deck: ${deckId} - ${this.data.decks[deckId].name}`);
    }

    this.saveData();
    return this.data.decks[deckId];
  }

  /**
   * Get a specific deck by ID
   */
  getDeck(deckId) {
    return this.data.decks[deckId];
  }

  /**
   * Add a match result
   */
  addMatch(matchData, draftId = null) {
    // Dedup: for known matchIds use matchId+result only (no date) because the
    // parser always stamps events with new Date(), not the actual match time.
    // For the fallback 'unknown' matchId, include the day to avoid merging
    // genuinely different matches that lack an ID.
    const incomingId = matchData.matchId || 'unknown';
    const existingMatchIndex = this.data.matches.findIndex(m => {
      if (incomingId !== 'unknown') {
        return m.matchId === incomingId && m.result === (matchData.result || 'unknown');
      }
      const matchDate    = new Date(matchData.timestamp || Date.now()).toDateString();
      const existingDate = new Date(m.timestamp).toDateString();
      return m.matchId === 'unknown' && existingDate === matchDate && m.result === matchData.result;
    });

    if (existingMatchIndex >= 0) {
      // Update existing match with new data (same result, same matchId, same day)
      const existingMatch = this.data.matches[existingMatchIndex];
      const updatedMatch = {
        ...existingMatch,
        result: matchData.result || existingMatch.result,
        format: matchData.format || existingMatch.format,
        deckName: matchData.deckName || existingMatch.deckName,
        deckId: matchData.deckId || existingMatch.deckId,
        gamesPlayed: matchData.gamesPlayed || existingMatch.gamesPlayed,
        // Backfill draftId, deckFingerprint, and playerDeck if re-processed
        draftId:         existingMatch.draftId         || draftId                    || null,
        deckFingerprint: existingMatch.deckFingerprint || matchData.deckFingerprint  || null,
        playerDeck:      existingMatch.playerDeck      || matchData.playerDeck       || null,
      };
      this.data.matches[existingMatchIndex] = updatedMatch;
      this.saveData();
      console.log(`[DataStore] Updated existing match: ${matchData.matchId}`);
      return updatedMatch;
    }

    const match = {
      id: this.generateId(),
      matchId: matchData.matchId || 'unknown',
      result: matchData.result || 'unknown',
      format: matchData.format || 'Unknown',
      gamesPlayed: matchData.gamesPlayed || 1,
      deckId: matchData.deckId || matchData.deckInfo?.deckId || null,
      deckName: matchData.deckName || matchData.deckInfo?.deckName || 'Unknown Deck',
      deckColors: matchData.deckInfo?.colors || [],
      opponentDeck: matchData.opponentDeck || null,
      opponentName: matchData.opponentName || null,
      opponentRank: matchData.opponentRank || null,
      timestamp:       matchData.timestamp || new Date().toISOString(),
      raw:             matchData.raw || null,
      draftId:         draftId || null,
      deckFingerprint: matchData.deckFingerprint || null,
      playerDeck:      matchData.playerDeck      || null,
    };

    this.data.matches.push(match);
    console.log(`[DataStore] Added match: ${match.matchId} - ${match.result} (${match.format})`);

    // Update deck info if available - create deck ID from name if needed
    const deckName = match.deckName;
    if (deckName && deckName !== 'Unknown Deck') {
      // Generate deck ID from deck name (slug)
      const deckId = 'deck_' + deckName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      match.deckId = deckId;

      // Create or update deck entry
      if (!this.data.decks[deckId]) {
        this.data.decks[deckId] = {
          id: deckId,
          name: deckName,
          format: match.format || 'Unknown',
          mainDeck: matchData.playerDeck?.deckCards || [],
          sideboard: matchData.playerDeck?.sideboardCards || [],
          commandZone: matchData.playerDeck?.commandZoneCards || [],
          colors: matchData.deckColors || [],
          lastUsed: match.timestamp
        };
        console.log(`[DataStore] Created new deck: ${deckId} - ${deckName}`);
      } else {
        // Update last used and card data if available
        this.data.decks[deckId].lastUsed = match.timestamp;
        if (matchData.playerDeck?.deckCards) {
          this.data.decks[deckId].mainDeck = matchData.playerDeck.deckCards;
        }
        console.log(`[DataStore] Updated deck: ${deckId}`);
      }
    }

    this.saveData();
    return match;
  }

  /**
   * Backfill deck colors and per-color copy counts on a stored match.
   * Only writes fields that are currently empty to avoid redundant saves.
   */
  updateMatchColors(matchId, colors, colorCounts) {
    if (!colors || colors.length === 0) return;
    const match = this.data.matches.find(m => m.matchId === matchId);
    if (!match) return;
    let changed = false;
    if (!match.deckColors || match.deckColors.length === 0) {
      match.deckColors = colors;
      changed = true;
    }
    if (colorCounts) {
      if (!match.deckColorCounts || Object.keys(match.deckColorCounts).length === 0) {
        match.deckColorCounts = colorCounts;
        changed = true;
      } else if (!('C' in match.deckColorCounts) && 'C' in colorCounts) {
        // Backfill colorless count for matches stored before colorless tracking was added
        match.deckColorCounts['C'] = colorCounts['C'];
        changed = true;
      }
    }
    if (changed) this.saveData();
  }

  /**
   * Backfill the main deck card list for a match from GRE GAME_STATS data.
   * Only runs when the match has no playerDeck yet (i.e., was recorded before
   * per-match deck tracking was added).  Sideboard is unavailable from GRE
   * data, so sideboardCards is left empty and greOnly is flagged so the UI
   * can explain the gap to the user.
   */
  updateMatchPlayerDeck(matchId, deckCardsRaw) {
    if (!matchId || !deckCardsRaw?.length) return;
    const match = this.data.matches.find(m => m.matchId === matchId);
    if (!match || match.playerDeck?.deckCards?.length) return;
    match.playerDeck = {
      deckCards:        deckCardsRaw.map(Number),
      sideboardCards:   [],
      commandZoneCards: [],
      greOnly:          true,  // sideboard data not available from GRE logs
    };
    this.saveData();
  }

  /**
   * Delete a match by ID
   */
  deleteMatch(matchId) {
    this.data.matches = this.data.matches.filter(m => m.id !== matchId);
    this.saveData();
  }

  /**
   * Delete all matches and card stats for a given format.
   */
  deleteMatchesByFormat(format) {
    this.data.matches = this.data.matches.filter(m => m.format !== format);
    delete this.cardStats.statsByFormat[format];
    this.saveData();
    this.saveCardStats();
    console.log(`[DataStore] Deleted all data for format: ${format}`);
  }

  /**
   * Get all matches
   */
  getMatches() {
    return this.data.matches.sort((a, b) =>
      new Date(b.timestamp) - new Date(a.timestamp)
    );
  }

  /**
   * Get all decks
   */
  getDecks() {
    return Object.values(this.data.decks).sort((a, b) =>
      new Date(b.lastUsed || 0) - new Date(a.lastUsed || 0)
    );
  }

  /**
   * Get statistics
   */
  getStats() {
    const matches = this.data.matches;
    const total = matches.length;
    const wins = matches.filter(m => m.result === 'win').length;
    const losses = matches.filter(m => m.result === 'loss').length;
    const draws = matches.filter(m => m.result === 'draw').length;

    // Stats by format
    const formatStats = {};
    matches.forEach(match => {
      const format = match.format || 'Unknown';
      if (!formatStats[format]) {
        formatStats[format] = { total: 0, wins: 0, losses: 0, draws: 0 };
      }
      formatStats[format].total++;
      if (match.result === 'win') formatStats[format].wins++;
      else if (match.result === 'loss') formatStats[format].losses++;
      else if (match.result === 'draw') formatStats[format].draws++;
    });

    // Stats by deck
    const deckStats = {};
    matches.forEach(match => {
      const deckName = match.deckName || 'Unknown Deck';
      // Generate deck ID from name if not present
      const deckId = match.deckId || ('deck_' + deckName.toLowerCase().replace(/[^a-z0-9]+/g, '_'));

      if (!deckStats[deckId]) {
        deckStats[deckId] = {
          id: deckId,
          name: deckName,
          total: 0,
          wins: 0,
          losses: 0,
          draws: 0
        };
      }
      deckStats[deckId].total++;
      if (match.result === 'win') deckStats[deckId].wins++;
      else if (match.result === 'loss') deckStats[deckId].losses++;
      else if (match.result === 'draw') deckStats[deckId].draws++;
    });

    return {
      total,
      wins,
      losses,
      draws,
      winRate: total > 0 ? Math.round((wins / total) * 100) : 0,
      formats: formatStats,
      decks: deckStats
    };
  }

  /**
   * Get current settings
   */
  getSettings() {
    return this.settings;
  }

  /**
   * Clear all data
   */
  clearAll() {
    this.data = {
      matches: [],
      decks: {}
    };
    this.saveData();
  }

  /**
   * Export data to file
   */
  exportToFile(filePath) {
    const exportData = {
      ...this.data,
      exportDate: new Date().toISOString(),
      version: '1.0'
    };
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
  }

  /**
   * Import all data files from a backup directory.
   * Reads matches.json, cardStats.json, drafts.json, and settings.json
   * if present, merging each into the current data without overwriting
   * records that already exist.
   */
  importFromDirectory(dirPath) {
    const read = name => {
      const p = path.join(dirPath, name);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    };

    const matchesData = read('matches.json');
    if (matchesData?.matches && Array.isArray(matchesData.matches)) {
      const existingIds = new Set(this.data.matches.map(m => m.id));
      const newMatches  = matchesData.matches.filter(m => !existingIds.has(m.id));
      this.data.matches.push(...newMatches);
    }
    if (matchesData?.decks) {
      this.data.decks = { ...this.data.decks, ...matchesData.decks };
    }
    this.saveData();

    const statsData = read('cardStats.json');
    if (statsData?.statsByFormat) {
      for (const [fmt, stats] of Object.entries(statsData.statsByFormat)) {
        if (!this.cardStats.statsByFormat[fmt]) {
          this.cardStats.statsByFormat[fmt] = {};
        }
        for (const [grpId, s] of Object.entries(stats)) {
          const existing = this.cardStats.statsByFormat[fmt][grpId];
          if (existing) {
            existing.gamesInDeck      += s.gamesInDeck      || 0;
            existing.gamesInHand      += s.gamesInHand      || 0;
            existing.gamesWonInHand   += s.gamesWonInHand   || 0;
            existing.gamesOpenHand    += s.gamesOpenHand    || 0;
            existing.gamesWonOpenHand += s.gamesWonOpenHand || 0;
          } else {
            this.cardStats.statsByFormat[fmt][grpId] = { ...s };
          }
        }
      }
      if (Array.isArray(statsData.processedGames)) {
        for (const id of statsData.processedGames) this.cardStats.processedGames.add(id);
      }
      this.saveCardStats();
    }

    const draftsData = read('drafts.json');
    if (draftsData?.drafts) {
      for (const [id, draft] of Object.entries(draftsData.drafts)) {
        if (!this.drafts[id]) this.drafts[id] = draft;
      }
      this.saveDrafts();
    }

    const settingsData = read('settings.json');
    if (settingsData) {
      const { mtgaDbPath: _ignored, ...safeSettings } = settingsData;
      this.saveSettings(safeSettings);
    }
  }

  // ─── Personal card game stats ────────────────────────────────────────────

  loadCardStats() {
    try {
      if (fs.existsSync(this.cardStatsFile)) {
        const content = fs.readFileSync(this.cardStatsFile, 'utf8');
        const parsed = JSON.parse(content);

        // Migration: old format had a flat `stats` key, new format uses `statsByFormat`.
        // Resetting processedGames forces a full rebuild on next scan so every game
        // gets attributed to its correct format.
        if (parsed.stats && !parsed.statsByFormat) {
          console.log('[DataStore] Migrating card stats to format-segmented structure');
          return { processedGames: new Set(), statsByFormat: {} };
        }

        return {
          processedGames: new Set(parsed.processedGames || []),
          statsByFormat:  parsed.statsByFormat || {},
        };
      }
    } catch (e) {
      console.error('[DataStore] Error loading card stats:', e);
    }
    return { processedGames: new Set(), statsByFormat: {} };
  }

  saveCardStats() {
    try {
      const serialized = {
        processedGames: Array.from(this.cardStats.processedGames),
        statsByFormat:  this.cardStats.statsByFormat,
      };
      fs.writeFileSync(this.cardStatsFile, JSON.stringify(serialized, null, 2));
    } catch (e) {
      console.error('[DataStore] Error saving card stats:', e);
    }
  }

  /**
   * Record card stats from one completed game, bucketed by format.
   * gameSummary: { matchId, gameNumber, result, deckGrpIds[], handGrpIds[], openingHandGrpIds[] }
   * format: string — the format label (e.g. "Secrets of Strixhaven Draft")
   * Returns true if the game was new (not already processed).
   */
  updateCardGameStats(gameSummary, format = 'Unknown') {
    const key = `${gameSummary.matchId}_game${gameSummary.gameNumber}`;
    if (this.cardStats.processedGames.has(key)) return false;

    this.cardStats.processedGames.add(key);
    const won = gameSummary.result === 'win';

    if (!this.cardStats.statsByFormat[format]) {
      this.cardStats.statsByFormat[format] = {};
    }
    const stats = this.cardStats.statsByFormat[format];

    const ensureEntry = grpId => {
      if (!stats[grpId]) {
        stats[grpId] = {
          gamesInDeck: 0, gamesInHand: 0, gamesWonInHand: 0,
          gamesOpenHand: 0, gamesWonOpenHand: 0,
        };
      }
      return stats[grpId];
    };

    for (const grpId of gameSummary.deckGrpIds) {
      ensureEntry(grpId).gamesInDeck++;
    }

    const openSet = new Set(gameSummary.openingHandGrpIds);
    for (const grpId of gameSummary.handGrpIds) {
      const s = ensureEntry(grpId);
      s.gamesInHand++;
      if (won) s.gamesWonInHand++;
    }
    for (const grpId of openSet) {
      const s = ensureEntry(grpId);
      s.gamesOpenHand++;
      if (won) s.gamesWonOpenHand++;
    }

    this.saveCardStats();
    console.log(`[DataStore] Card stats updated for game ${key} (${format}): ${gameSummary.handGrpIds.length} cards in hand`);
    return true;
  }

  /** Return the raw per-grpId stats object for a specific format. */
  getAllCardGameStats(format) {
    if (!format) return {};
    return this.cardStats.statsByFormat[format] ?? {};
  }

  /** Return sorted list of formats that have any card stats recorded. */
  getCardStatFormats() {
    return Object.keys(this.cardStats.statsByFormat).sort();
  }

  /** Look up the format string for a stored match by its Arena matchId. */
  getMatchFormat(matchId) {
    const match = this.data.matches.find(m => m.matchId === matchId);
    return match?.format ?? null;
  }

  clearCardStats() {
    this.cardStats = { processedGames: new Set(), statsByFormat: {} };
    this.saveCardStats();
  }

  /**
   * Load drafts from disk. Returns {} if file missing or unreadable.
   * Shape on disk: { drafts: { [draftId]: DraftRecord } }
   */
  loadDrafts() {
    try {
      if (fs.existsSync(this.draftsFile)) {
        const content = fs.readFileSync(this.draftsFile, 'utf8');
        const parsed = JSON.parse(content);
        return parsed.drafts || {};
      }
    } catch (e) {
      console.error('[DataStore] Error loading drafts:', e);
    }
    return {};
  }

  /**
   * Persist all drafts to disk via atomic-rename. Survives mid-write process kill.
   */
  saveDrafts() {
    try {
      this._atomicWrite(
        this.draftsFile,
        JSON.stringify({ drafts: this.drafts }, null, 2)
      );
    } catch (e) {
      console.error('[DataStore] Error saving drafts:', e);
    }
  }

  /**
   * Atomic write: write to .tmp, then rename. fs.renameSync is atomic on
   * POSIX and Windows for files on the same volume.
   */
  _atomicWrite(filePath, content) {
    const tmpPath = filePath + '.tmp';
    // Clean up any orphaned .tmp from a prior crashed write before we begin.
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Idempotently merge a draft state into the persisted store.
   *
   * @param {object} state - Parser's DRAFT_UPDATE shape:
   *   { draftId, picks: [{pack, pick, options, picked}], currentPack: {pack, pick, options} | null }
   *
   * Merge rules:
   *  - If no record exists for draftId → create with startedAt = Date.now().
   *  - For each picks[] entry, key by (pack, pick):
   *      • absent → append
   *      • present with picked: null and incoming picked set → patch picked
   *      • present with non-null picked → no-op (never overwrite)
   *  - If currentPack is set and (pack, pick) is not yet recorded → append as picked: null entry.
   */
  upsertDraft(state) {
    if (!state || !state.draftId) return;
    const { draftId, picks: incomingPicks = [], currentPack = null } = state;

    if (!this.drafts[draftId]) {
      this.drafts[draftId] = {
        draftId,
        startedAt: Date.now(),
        picks: [],
      };
    }
    const record = this.drafts[draftId];

    const findIdx = (pack, pick) =>
      record.picks.findIndex(p => p.pack === pack && p.pick === pick);

    const mergeEntry = (pack, pick, options, picked) => {
      const idx = findIdx(pack, pick);
      if (idx === -1) {
        record.picks.push({ pack, pick, options: [...options], picked: picked ?? null });
        return;
      }
      const existing = record.picks[idx];
      // Patch picked only if it's currently null and the incoming sets it.
      if (existing.picked === null && picked != null) {
        existing.picked = picked;
      }
      // options are stable for a given (pack, pick) — leave existing options as-is.
    };

    for (const p of incomingPicks) {
      mergeEntry(p.pack, p.pick, p.options || [], p.picked ?? null);
    }

    if (currentPack && currentPack.pack != null && currentPack.pick != null) {
      mergeEntry(currentPack.pack, currentPack.pick, currentPack.options || [], null);
    }

    this.saveDrafts();
  }

  /**
   * Mark a draft as ended and store its final win/loss record.
   */
  endDraft(draftId, wins, losses) {
    const record = this.drafts[draftId];
    if (!record) return;
    record.ended  = true;
    record.wins   = wins;
    record.losses = losses;
    record.trophy = wins >= 7;
    this.saveDrafts();
    console.log(`[DataStore] Draft ended: ${draftId} (${wins}W-${losses}L)${wins >= 7 ? ' TROPHY' : ''}`);
  }

  /**
   * Return the DraftRecord for draftId, or null.
   */
  getDraft(draftId) {
    return this.drafts[draftId] || null;
  }

  /**
   * Return all DraftRecords as an array.
   */
  getAllDrafts() {
    return Object.values(this.drafts);
  }

  /**
   * Return [{draftId, startedAt, pickCount}] for every persisted draft,
   * sorted by startedAt descending. pickCount is the raw count of stored
   * picks entries — includes any pending `picked: null` pack-view entry,
   * but NOT gap-fill placeholders (those are computed in the pipeline,
   * not persisted).
   */
  getDraftSummaries() {
    return Object.values(this.drafts)
      .map(r => ({
        draftId:   r.draftId,
        startedAt: r.startedAt,
        pickCount: Array.isArray(r.picks) ? r.picks.length : 0,
      }))
      .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  /**
   * Merge duplicate match records that share the same matchId+result.
   * Duplicates arise when the parser stamps events with new Date() instead of
   * the actual log timestamp, causing the old date-based dedup to miss them on
   * subsequent days. For each duplicate group we keep the earliest record and
   * backfill any fields (draftId, deckColors, deckColorCounts) from the others.
   */
  _deduplicateMatches() {
    const groups = new Map(); // `${matchId}_${result}` → [match, ...]
    const unknown = [];

    for (const m of this.data.matches) {
      if (!m.matchId || m.matchId === 'unknown') { unknown.push(m); continue; }
      const key = `${m.matchId}_${m.result}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    const removeIds = new Set();
    const merged    = [];

    for (const dupes of groups.values()) {
      if (dupes.length === 1) { merged.push(dupes[0]); continue; }

      // Keep earliest timestamp as canonical; merge useful fields from later copies.
      dupes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      const base = { ...dupes[0] };
      for (let i = 1; i < dupes.length; i++) {
        const d = dupes[i];
        if (!base.draftId        && d.draftId)        base.draftId        = d.draftId;
        if (!base.deckColors?.length && d.deckColors?.length) base.deckColors = d.deckColors;
        if (!base.deckColorCounts && d.deckColorCounts) base.deckColorCounts = d.deckColorCounts;
        if (!base.opponentName    && d.opponentName)    base.opponentName    = d.opponentName;
        if (!base.deckFingerprint && d.deckFingerprint) base.deckFingerprint = d.deckFingerprint;
        removeIds.add(d.id);
      }
      merged.push(base);
    }

    if (removeIds.size === 0) return;

    this.data.matches = [...merged, ...unknown];
    this.saveData();
    console.log(`[DataStore] Removed ${removeIds.size} duplicate match record(s)`);
  }

  _backfillMatchIds() {
    let dirty = false;
    for (const match of this.data.matches) {
      if (!match.id) {
        match.id = this.generateId();
        dirty = true;
      }
    }
    if (dirty) {
      this.saveData();
      console.log('[DataStore] Backfilled missing id fields on match records');
    }
  }

  _backfillPremierDraft() {
    const needsUpgrade = fmt => {
      if (!fmt) return false;
      const lower = fmt.toLowerCase();
      return (fmt === 'Draft' || fmt.endsWith(' Draft'))
        && !lower.includes('quick')
        && !lower.includes('traditional')
        && !lower.includes('premier')
        && !lower.includes('sealed');
    };
    const upgrade = fmt => fmt === 'Draft'
      ? 'Premier Draft'
      : `Premier Draft ${fmt.replace(/ Draft$/, '')}`;

    let matchDirty = false;
    for (const match of this.data.matches) {
      if (needsUpgrade(match.format)) {
        match.format = upgrade(match.format);
        matchDirty = true;
      }
    }
    if (matchDirty) {
      this.saveData();
      console.log('[DataStore] Backfilled Premier Draft format on historical match records');
    }

    let statsDirty = false;
    for (const fmt of Object.keys(this.cardStats.statsByFormat)) {
      if (!needsUpgrade(fmt)) continue;
      const newFmt = upgrade(fmt);
      const oldStats = this.cardStats.statsByFormat[fmt];
      if (!this.cardStats.statsByFormat[newFmt]) {
        this.cardStats.statsByFormat[newFmt] = oldStats;
      } else {
        for (const [grpId, s] of Object.entries(oldStats)) {
          const existing = this.cardStats.statsByFormat[newFmt][grpId];
          if (existing) {
            existing.gamesInDeck      += s.gamesInDeck      || 0;
            existing.gamesInHand      += s.gamesInHand      || 0;
            existing.gamesWon         += s.gamesWon         || 0;
            existing.gamesOpenHand    += s.gamesOpenHand    || 0;
            existing.gamesWonOpenHand += s.gamesWonOpenHand || 0;
          } else {
            this.cardStats.statsByFormat[newFmt][grpId] = { ...s };
          }
        }
      }
      delete this.cardStats.statsByFormat[fmt];
      statsDirty = true;
    }
    if (statsDirty) {
      this.saveCardStats();
      console.log('[DataStore] Backfilled Premier Draft format on historical card stat records');
    }
  }

  _reorderPremierDraft() {
    const needsReorder = fmt => fmt && fmt.endsWith(' Premier Draft') && !fmt.startsWith('Premier Draft');
    const reorder = fmt => `Premier Draft ${fmt.replace(/ Premier Draft$/, '')}`;

    let matchDirty = false;
    for (const match of this.data.matches) {
      if (needsReorder(match.format)) {
        match.format = reorder(match.format);
        matchDirty = true;
      }
    }
    if (matchDirty) {
      this.saveData();
      console.log('[DataStore] Reordered Premier Draft format labels to "Premier Draft [Set]"');
    }

    let statsDirty = false;
    for (const fmt of Object.keys(this.cardStats.statsByFormat)) {
      if (!needsReorder(fmt)) continue;
      const newFmt = reorder(fmt);
      const oldStats = this.cardStats.statsByFormat[fmt];
      if (!this.cardStats.statsByFormat[newFmt]) {
        this.cardStats.statsByFormat[newFmt] = oldStats;
      } else {
        for (const [grpId, s] of Object.entries(oldStats)) {
          const existing = this.cardStats.statsByFormat[newFmt][grpId];
          if (existing) {
            existing.gamesInDeck      += s.gamesInDeck      || 0;
            existing.gamesInHand      += s.gamesInHand      || 0;
            existing.gamesWon         += s.gamesWon         || 0;
            existing.gamesOpenHand    += s.gamesOpenHand    || 0;
            existing.gamesWonOpenHand += s.gamesWonOpenHand || 0;
          } else {
            this.cardStats.statsByFormat[newFmt][grpId] = { ...s };
          }
        }
      }
      delete this.cardStats.statsByFormat[fmt];
      statsDirty = true;
    }
    if (statsDirty) {
      this.saveCardStats();
      console.log('[DataStore] Reordered Premier Draft format labels in card stats');
    }
  }

  /**
   * Generate a unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

module.exports = DataStore;
