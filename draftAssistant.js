/**
 * DraftAssistant
 *
 * Parses a 17Lands CSV (manually downloaded by the user) and provides
 * per-card statistics for use during drafts.
 *
 * Scalability note: all columns from the CSV are stored as-is on each card
 * entry. To surface a new stat in the UI, you only need to read a new key —
 * no changes to this file are required.
 *
 * Expected CSV columns (as of 2025):
 *   Name, Color, Rarity, # Seen, ALSA, # Picked, ATA,
 *   # GP, % GP, GP WR, # OH, OH WR, # GD, GD WR,
 *   # GIH, GIH WR, # GNS, GNS WR, IIH
 */

const fs = require('fs');
const path = require('path');

// Minimum number of "games in hand" before we trust the GIH WR figure.
// Cards with fewer samples get flagged as low-confidence.
const MIN_GIH_SAMPLE = 200;

class DraftAssistant {
  constructor() {
    /**
     * Map of lowercase card name → stats object.
     * Keyed by lowercase name so lookups are case-insensitive.
     *
     * Each stats object looks like:
     * {
     *   name:      "Environmental Scientist",   // original capitalisation
     *   color:     "G",
     *   rarity:    "U",
     *   alsa:      2.93,       // Average Last Seen At
     *   ata:       3.26,       // Average Taken At
     *   gihWr:     0.626,      // Games In Hand Win Rate  (null if no data)
     *   gihCount:  13647,      // sample size for GIH WR
     *   ohWr:      0.635,      // Opening Hand Win Rate   (null if no data)
     *   gpWr:      0.573,      // Game in Pool Win Rate   (null if no data)
     *   gdWr:      0.618,      // Games Drawn Win Rate    (null if no data)
     *   gnsWr:     0.530,      // Games Not Seen Win Rate (null if no data)
     *   iih:       9.6,        // Impact when In Hand (pp)
     *   lowSample: false,      // true when gihCount < MIN_GIH_SAMPLE
     *   raw:       { ...all original CSV fields as strings }
     * }
     */
    this.cardStats = new Map();
    this.csvPath = null;
    this.setName = null; // derived from the filename, e.g. "card-ratings-2026-04-26"
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Load (or reload) a 17Lands CSV file.
   * Throws on file-not-found or parse failure.
   *
   * @param {string} filePath  Absolute path to the downloaded CSV.
   * @returns {{ cardCount: number, setName: string }}
   */
  loadCSV(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`17Lands CSV not found: ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const result = this._parseCSV(raw);

    this.cardStats = result.cardStats;
    this.csvPath = filePath;
    this.setName = path.basename(filePath, '.csv');

    console.log(`[DraftAssistant] Loaded ${this.cardStats.size} cards from "${this.setName}"`);
    return { cardCount: this.cardStats.size, setName: this.setName };
  }

  /**
   * Check whether a CSV has been loaded.
   */
  isLoaded() {
    return this.cardStats.size > 0;
  }

  /**
   * Return the full stats object for a single card, or null if unknown.
   *
   * @param {string} cardName  Card name (case-insensitive).
   */
  getCardStats(cardName) {
    if (!cardName) return null;
    return this.cardStats.get(cardName.toLowerCase()) ?? null;
  }

  /**
   * Given an array of resolved card objects (from resolveCards in main.js),
   * return them sorted best-to-worst by GIH WR with stats attached.
   *
   * Cards with no GIH WR data are sorted to the bottom.
   *
   * @param {Array<{ arena_id: number, name: string, manaCost?: string, type?: string }>} resolvedCards
   * @returns {Array<RankedCard>}
   */
  rankPack(resolvedCards) {
    const ranked = resolvedCards.map(card => {
      const stats = this.getCardStats(card.name);
      return {
        ...card,
        stats: stats ?? null,
        gihWr: stats?.gihWr ?? null,
        gihCount: stats?.gihCount ?? 0,
        lowSample: stats ? stats.lowSample : true,
      };
    });

    ranked.sort((a, b) => {
      // Cards with data beat cards without data
      if (a.gihWr === null && b.gihWr === null) return 0;
      if (a.gihWr === null) return 1;
      if (b.gihWr === null) return -1;
      return b.gihWr - a.gihWr;
    });

    return ranked;
  }

  /**
   * Return a specific numeric stat for a card by metric key.
   * Useful when the UI wants to display one particular column.
   *
   * Supported keys: 'gihWr', 'ohWr', 'gpWr', 'gdWr', 'gnsWr',
   *                 'alsa', 'ata', 'iih', and any key in stats.raw.
   *
   * @param {string} cardName
   * @param {string} metric
   * @returns {number|string|null}
   */
  getStat(cardName, metric) {
    const stats = this.getCardStats(cardName);
    if (!stats) return null;
    if (metric in stats) return stats[metric];
    if (stats.raw && metric in stats.raw) return stats.raw[metric];
    return null;
  }

  /**
   * Describe the currently loaded dataset (for display in settings UI).
   */
  getStatus() {
    if (!this.isLoaded()) {
      return { loaded: false, cardCount: 0, setName: null, csvPath: null };
    }
    return {
      loaded: true,
      cardCount: this.cardStats.size,
      setName: this.setName,
      csvPath: this.csvPath,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse the full CSV text into a Map of lowercase-name → stats.
   */
  _parseCSV(text) {
    // Strip the UTF-8 BOM that 17Lands includes
    const clean = text.replace(/^\uFEFF/, '');
    const lines = clean.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      throw new Error('CSV appears empty or has no data rows');
    }

    const headers = this._splitCSVLine(lines[0]);
    const cardStats = new Map();

    for (let i = 1; i < lines.length; i++) {
      const values = this._splitCSVLine(lines[i]);
      if (values.length < headers.length) continue; // skip malformed rows

      // Build a raw key→value map for every column
      const raw = {};
      headers.forEach((h, idx) => {
        raw[h] = values[idx] ?? '';
      });

      const name = raw['Name'];
      if (!name) continue;

      const stats = {
        name,
        color:     raw['Color']   ?? '',
        rarity:    raw['Rarity']  ?? '',
        alsa:      this._parseFloat(raw['ALSA']),
        ata:       this._parseFloat(raw['ATA']),
        gihWr:     this._parsePercent(raw['GIH WR']),
        gihCount:  this._parseInt(raw['# GIH']),
        ohWr:      this._parsePercent(raw['OH WR']),
        gpWr:      this._parsePercent(raw['GP WR']),
        gdWr:      this._parsePercent(raw['GD WR']),
        gnsWr:     this._parsePercent(raw['GNS WR']),
        iih:       this._parseFloat(raw['IIH']),  // stored as "9.6pp" → 9.6
        lowSample: false,
        raw,
      };

      // Mark low-confidence cards
      stats.lowSample = stats.gihWr === null || stats.gihCount < MIN_GIH_SAMPLE;

      cardStats.set(name.toLowerCase(), stats);
    }

    return { cardStats };
  }

  /**
   * Split a single CSV line respecting quoted fields.
   * 17Lands wraps every field in double-quotes.
   */
  _splitCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  /**
   * Parse a percentage string like "62.6%" → 0.626, or "" → null.
   */
  _parsePercent(str) {
    if (!str || str.trim() === '') return null;
    const n = parseFloat(str.replace('%', ''));
    return isNaN(n) ? null : n / 100;
  }

  /**
   * Parse a float string, stripping trailing non-numeric chars (handles "9.6pp").
   * Returns null for empty/missing values.
   */
  _parseFloat(str) {
    if (!str || str.trim() === '') return null;
    const n = parseFloat(str);
    return isNaN(n) ? null : n;
  }

  /**
   * Parse an integer string. Returns 0 for empty/missing values.
   */
  _parseInt(str) {
    if (!str || str.trim() === '') return 0;
    const n = parseInt(str, 10);
    return isNaN(n) ? 0 : n;
  }
}

module.exports = DraftAssistant;