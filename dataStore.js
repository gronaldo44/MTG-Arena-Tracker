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
      this.dataDir = path.join(app.getPath('userData'), 'data');
    } else {
      // Renderer process - use app.getPath won't work, use a default
      this.dataDir = path.join(require('os').homedir(), '.mtg-arena-tracker', 'data');
    }

    this.dataFile     = path.join(this.dataDir, 'matches.json');
    this.settingsFile = path.join(this.dataDir, 'settings.json');
    this.cardsFile    = path.join(__dirname, 'cards.json');
    this.cardStatsFile = path.join(this.dataDir, 'cardStats.json');

    // Ensure data directory exists
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    // Load existing data
    this.data       = this.loadData();
    this.settings   = this.loadSettings();
    this.cards      = this.loadCards();
    this.cardStats  = this.loadCardStats();
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
      minimizeToTray: true,
      showNotifications: true
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
  addMatch(matchData) {
    // Check for existing match - same matchId, same day, AND same result
    // Different results (win/loss) are treated as separate games
    const matchDate = new Date(matchData.timestamp || Date.now()).toDateString();
    const existingMatchIndex = this.data.matches.findIndex(m => {
      const existingDate = new Date(m.timestamp).toDateString();
      return m.matchId === (matchData.matchId || 'unknown') &&
             existingDate === matchDate &&
             m.result === matchData.result;
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
        gamesPlayed: matchData.gamesPlayed || existingMatch.gamesPlayed
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
      timestamp: matchData.timestamp || new Date().toISOString(),
      raw: matchData.raw || null
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
    if (colorCounts && (!match.deckColorCounts || Object.keys(match.deckColorCounts).length === 0)) {
      match.deckColorCounts = colorCounts;
      changed = true;
    }
    if (changed) this.saveData();
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
   * Import data from file
   */
  importFromFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const importData = JSON.parse(content);

    if (importData.matches && Array.isArray(importData.matches)) {
      // Merge with existing data, avoiding duplicates by ID
      const existingIds = new Set(this.data.matches.map(m => m.id));
      const newMatches = importData.matches.filter(m => !existingIds.has(m.id));
      this.data.matches.push(...newMatches);
    }

    if (importData.decks) {
      this.data.decks = { ...this.data.decks, ...importData.decks };
    }

    this.saveData();
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
   * Generate a unique ID
   */
  generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
  }
}

module.exports = DataStore;
