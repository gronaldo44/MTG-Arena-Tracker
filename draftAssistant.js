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

    // Set-level statistics computed when a CSV is loaded.
    // Used to assign relative quality tiers (mythic/gold/silver/black/brown).
    this.setMean   = 0;
    this.setStdDev = 1;
    this.top20Set  = new Set(); // lowercase names of the 20 highest GIH WR cards
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

    this._computeSetStats();

    console.log(`[DraftAssistant] Loaded ${this.cardStats.size} cards from "${this.setName}" (mean GIH WR: ${(this.setMean * 100).toFixed(1)}%, σ: ${(this.setStdDev * 100).toFixed(1)}%)`);
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
   * Assign a quality tier to a single card based on set-relative statistics.
   *
   * Tiers (best to worst):
   *   'mythic' — one of the top 20 cards in the set by GIH WR
   *   'gold'   — z-score > +0.75 (significantly above average)
   *   'silver' — z-score > +0.25 (slightly above average)
   *   'black'  — z-score > -0.50 (roughly average)
   *   'brown'  — z-score ≤ -0.50 (below average)
   *   'none'   — no reliable data (null WR or low sample)
   *
   * @param {number|null} gihWr
   * @param {string}      cardName
   * @param {boolean}     lowSample
   * @returns {'mythic'|'gold'|'silver'|'black'|'brown'|'none'}
   */
  getCardTier(gihWr, cardName, lowSample) {
    if (gihWr === null || lowSample) return 'none';

    if (this.top20Set.has((cardName || '').toLowerCase())) return 'mythic';

    const z = this.setStdDev > 0
      ? (gihWr - this.setMean) / this.setStdDev
      : 0;

    if (z > 0.75) return 'gold';
    if (z > 0.25) return 'silver';
    if (z > -0.50) return 'black';
    return 'brown';
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
      const gihWr = stats?.gihWr ?? null;
      const lowSample = stats ? stats.lowSample : true;
      return {
        ...card,
        stats: stats ?? null,
        gihWr,
        gihCount: stats?.gihCount ?? 0,
        lowSample,
        tier: this.getCardTier(gihWr, card.name, lowSample),
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
   * Return all card stats as an array (for "show all 17Lands cards" mode).
   */
  getAllCardStats() {
    return Array.from(this.cardStats.values());
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
   * Compute set-level GIH WR statistics from the loaded cardStats.
   * Stores mean, standard deviation, and the top-20 card name set.
   * Only cards with reliable data (non-null, non-low-sample WR) are included.
   */
  _computeSetStats() {
    const rates = [];
    for (const stats of this.cardStats.values()) {
      if (stats.gihWr !== null && !stats.lowSample) {
        rates.push({ name: stats.name.toLowerCase(), gihWr: stats.gihWr });
      }
    }

    if (rates.length === 0) {
      this.setMean   = 0;
      this.setStdDev = 1;
      this.top20Set  = new Set();
      return;
    }

    const values = rates.map(r => r.gihWr);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;

    this.setMean   = mean;
    this.setStdDev = Math.sqrt(variance) || 1; // guard against all-identical WRs

    rates.sort((a, b) => b.gihWr - a.gihWr);
    this.top20Set = new Set(rates.slice(0, 20).map(r => r.name));
  }

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