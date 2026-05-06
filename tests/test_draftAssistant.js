'use strict';

const fs = require('fs');
const DraftAssistant = require('../draftAssistant');

// ─── CSV helpers ──────────────────────────────────────────────────────────────

const CSV_HEADER =
  '"Name","Color","Rarity","# Seen","ALSA","# Picked","ATA",' +
  '"# GP","% GP","GP WR","# OH","OH WR","# GD","GD WR",' +
  '"# GIH","GIH WR","# GNS","GNS WR","IIH"';

/**
 * Build a single CSV data row. Supply at minimum a name and gihWr.
 * gihWr should be 0.0–1.0; gihCount defaults to 500 (above MIN_GIH_SAMPLE).
 */
function row(name, { color = 'C', rarity = 'C', gihWr = null, gihCount = 500 } = {}) {
  const wrStr = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '';
  return (
    `"${name}","${color}","${rarity}","500","2.50","400","3.00",` +
    `"2000","40.0%","55.0%","1200","56.0%","800","54.0%",` +
    `"${gihCount}","${wrStr}","300","52.0%","5.0pp"`
  );
}

function makeCsv(...rows) {
  return [CSV_HEADER, ...rows].join('\n');
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('DraftAssistant', () => {
  let assistant;

  beforeEach(() => {
    assistant = new DraftAssistant();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── constructor ───────────────────────────────────────────────────────────

  describe('constructor', () => {
    test('starts unloaded', () => {
      expect(assistant.isLoaded()).toBe(false);
    });

    test('setMean initialises to 0', () => {
      expect(assistant.setMean).toBe(0);
    });

    test('setStdDev initialises to 1', () => {
      expect(assistant.setStdDev).toBe(1);
    });

    test('top20Set is empty', () => {
      expect(assistant.top20Set.size).toBe(0);
    });
  });

  // ── loadCSV ───────────────────────────────────────────────────────────────

  describe('loadCSV', () => {
    test('throws if file does not exist', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(() => assistant.loadCSV('/fake/path.csv')).toThrow();
    });

    test('returns cardCount and setName on success', () => {
      const csv = makeCsv(row('Lightning Bolt', { gihWr: 0.62 }));
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);

      const result = assistant.loadCSV('/data/card-ratings-SOS.csv');
      expect(result.cardCount).toBe(1);
      expect(result.setName).toBe('card-ratings-SOS');
    });

    test('isLoaded() becomes true after successful load', () => {
      const csv = makeCsv(row('Forest', { gihWr: 0.55 }));
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);

      assistant.loadCSV('/data/ratings.csv');
      expect(assistant.isLoaded()).toBe(true);
    });

    test('strips UTF-8 BOM from CSV content', () => {
      const csv = '﻿' + makeCsv(row('Brainstorm', { gihWr: 0.60 }));
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);

      const result = assistant.loadCSV('/data/ratings.csv');
      expect(result.cardCount).toBe(1);
    });

    test('cards with no GIH WR are still stored but count as low sample', () => {
      const csv = makeCsv(row('New Card', { gihWr: null, gihCount: 0 }));
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);

      assistant.loadCSV('/data/ratings.csv');
      const stats = assistant.getCardStats('New Card');
      expect(stats).not.toBeNull();
      expect(stats.gihWr).toBeNull();
    });
  });

  // ── getCardStats ──────────────────────────────────────────────────────────

  describe('getCardStats', () => {
    beforeEach(() => {
      const csv = makeCsv(
        row('Lightning Bolt', { color: 'R', rarity: 'U', gihWr: 0.64 }),
        row('Forest',         { color: 'G', rarity: 'C', gihWr: 0.52 }),
      );
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);
      assistant.loadCSV('/data/ratings.csv');
    });

    test('returns null for unknown card', () => {
      expect(assistant.getCardStats('Unknown Card')).toBeNull();
    });

    test('returns null for null/undefined input', () => {
      expect(assistant.getCardStats(null)).toBeNull();
      expect(assistant.getCardStats(undefined)).toBeNull();
    });

    test('lookup is case-insensitive', () => {
      expect(assistant.getCardStats('LIGHTNING BOLT')).not.toBeNull();
      expect(assistant.getCardStats('lightning bolt')).not.toBeNull();
      expect(assistant.getCardStats('Lightning Bolt')).not.toBeNull();
    });

    test('returns correct stats for a known card', () => {
      const stats = assistant.getCardStats('Lightning Bolt');
      expect(stats.name).toBe('Lightning Bolt');
      expect(stats.color).toBe('R');
      expect(stats.rarity).toBe('U');
      expect(stats.gihWr).toBeCloseTo(0.64);
      expect(stats.lowSample).toBe(false);
    });
  });

  // ── _computeSetStats ──────────────────────────────────────────────────────

  describe('_computeSetStats', () => {
    test('handles empty cardStats (no reliable data)', () => {
      assistant.cardStats = new Map();
      assistant._computeSetStats();
      expect(assistant.setMean).toBe(0);
      expect(assistant.setStdDev).toBe(1);
      expect(assistant.top20Set.size).toBe(0);
    });

    test('ignores low-sample cards in statistics', () => {
      assistant.cardStats = new Map([
        ['low', { name: 'Low', gihWr: 0.99, lowSample: true }],
        ['ok',  { name: 'Ok',  gihWr: 0.55, lowSample: false }],
      ]);
      assistant._computeSetStats();
      expect(assistant.setMean).toBeCloseTo(0.55);
      expect(assistant.top20Set.has('ok')).toBe(true);
      expect(assistant.top20Set.has('low')).toBe(false);
    });

    test('ignores cards with null GIH WR in statistics', () => {
      assistant.cardStats = new Map([
        ['nodata', { name: 'Nodata', gihWr: null, lowSample: false }],
        ['hasdata', { name: 'Hasdata', gihWr: 0.60, lowSample: false }],
      ]);
      assistant._computeSetStats();
      expect(assistant.setMean).toBeCloseTo(0.60);
      expect(assistant.top20Set.has('nodata')).toBe(false);
    });

    test('correctly computes mean for a known dataset', () => {
      assistant.cardStats = new Map([
        ['a', { name: 'A', gihWr: 0.70, lowSample: false }],
        ['b', { name: 'B', gihWr: 0.60, lowSample: false }],
        ['c', { name: 'C', gihWr: 0.50, lowSample: false }],
      ]);
      assistant._computeSetStats();
      expect(assistant.setMean).toBeCloseTo(0.60, 5);
    });

    test('correctly computes stddev for a known dataset', () => {
      // WRs: 0.50, 0.60, 0.70 — mean 0.60, variance ((-.1)^2+(0)^2+(.1)^2)/3 = 0.02/3
      assistant.cardStats = new Map([
        ['a', { name: 'A', gihWr: 0.70, lowSample: false }],
        ['b', { name: 'B', gihWr: 0.60, lowSample: false }],
        ['c', { name: 'C', gihWr: 0.50, lowSample: false }],
      ]);
      assistant._computeSetStats();
      expect(assistant.setStdDev).toBeCloseTo(Math.sqrt(0.02 / 3), 5);
    });

    test('top20Set contains the highest-WR card names (lowercase)', () => {
      assistant.cardStats = new Map([
        ['alpha', { name: 'Alpha', gihWr: 0.70, lowSample: false }],
        ['beta',  { name: 'Beta',  gihWr: 0.60, lowSample: false }],
        ['gamma', { name: 'Gamma', gihWr: 0.50, lowSample: false }],
      ]);
      assistant._computeSetStats();
      // With only 3 cards, all 3 enter top20
      expect(assistant.top20Set.has('alpha')).toBe(true);
      expect(assistant.top20Set.has('beta')).toBe(true);
      expect(assistant.top20Set.has('gamma')).toBe(true);
    });

    test('top20Set has at most 20 entries with 21 cards', () => {
      const cards = new Map();
      for (let i = 1; i <= 21; i++) {
        const name = `card ${i}`;
        cards.set(name, { name: `Card ${i}`, gihWr: i * 0.01 + 0.49, lowSample: false });
      }
      assistant.cardStats = cards;
      assistant._computeSetStats();
      expect(assistant.top20Set.size).toBe(20);
    });

    test('the lowest-WR card among 21 is NOT in top20Set', () => {
      const cards = new Map();
      for (let i = 1; i <= 21; i++) {
        const name = `card ${i}`;
        cards.set(name, { name: `Card ${i}`, gihWr: i * 0.01 + 0.49, lowSample: false });
      }
      assistant.cardStats = cards;
      assistant._computeSetStats();
      // card 1 has the lowest WR (0.50) and should not be in the top 20
      expect(assistant.top20Set.has('card 1')).toBe(false);
      // card 2 has WR 0.51 and should be in the top 20
      expect(assistant.top20Set.has('card 2')).toBe(true);
    });

    test('when all cards have the same WR, stdDev guard produces 1 (not 0 or NaN)', () => {
      assistant.cardStats = new Map([
        ['x', { name: 'X', gihWr: 0.58, lowSample: false }],
        ['y', { name: 'Y', gihWr: 0.58, lowSample: false }],
      ]);
      assistant._computeSetStats();
      expect(assistant.setStdDev).toBe(1);
    });
  });

  // ── getCardTier ───────────────────────────────────────────────────────────

  describe('getCardTier', () => {
    // Set up a known statistical context so z-score math is predictable.
    // mean=0.58, stddev=0.03
    // thresholds:
    //   mythic: card name in top20Set
    //   gold:   WR > 0.58 + 0.75*0.03 = 0.6025
    //   silver: WR > 0.58 + 0.25*0.03 = 0.5875
    //   black:  WR > 0.58 - 0.50*0.03 = 0.565
    //   brown:  WR <= 0.565
    beforeEach(() => {
      assistant.setMean   = 0.58;
      assistant.setStdDev = 0.03;
      assistant.top20Set  = new Set(['the best card']);
    });

    test('null GIH WR → none', () => {
      expect(assistant.getCardTier(null, 'Any Card', false)).toBe('none');
    });

    test('low sample → none regardless of WR', () => {
      expect(assistant.getCardTier(0.70, 'Any Card', true)).toBe('none');
    });

    test('card in top20Set → mythic', () => {
      expect(assistant.getCardTier(0.70, 'The Best Card', false)).toBe('mythic');
    });

    test('top20 check is case-insensitive', () => {
      expect(assistant.getCardTier(0.70, 'THE BEST CARD', false)).toBe('mythic');
    });

    test('z > 0.75 and NOT in top20 → gold', () => {
      // WR = 0.61 → z = (0.61-0.58)/0.03 = 1.0 > 0.75
      expect(assistant.getCardTier(0.61, 'Other Card', false)).toBe('gold');
    });

    test('z between 0.06 and 0.75 → silver', () => {
      // WR = 0.595 → z = (0.595-0.58)/0.03 = 0.5 (between 0.06 and 0.75)
      expect(assistant.getCardTier(0.595, 'Other Card', false)).toBe('silver');
    });

    test('z between -1.16 and 0.06 → black', () => {
      // WR = 0.575 → z = (0.575-0.58)/0.03 = -0.167 (between -1.16 and 0.06)
      expect(assistant.getCardTier(0.575, 'Other Card', false)).toBe('black');
    });

    test('z <= -1.16 → brown', () => {
      // WR = 0.545 → z = (0.545-0.58)/0.03 = -1.167 (<= -1.16)
      expect(assistant.getCardTier(0.545, 'Other Card', false)).toBe('brown');
    });

    test('exactly at gold threshold (z = 0.75) → silver (not exclusive)', () => {
      const wr = 0.58 + 0.75 * 0.03; // exactly 0.75 SD above mean
      // z = 0.75 is NOT > 0.75, so falls through to silver check (z > 0.06)
      expect(assistant.getCardTier(wr, 'Other Card', false)).toBe('silver');
    });

    test('card with empty name treated as non-mythic', () => {
      expect(assistant.getCardTier(0.70, '', false)).toBe('gold');
    });
  });

  // ── rankPack ──────────────────────────────────────────────────────────────

  describe('rankPack', () => {
    beforeEach(() => {
      assistant.setMean   = 0.58;
      assistant.setStdDev = 0.03;
      assistant.top20Set  = new Set(['lightning bolt']);
      assistant.cardStats = new Map([
        ['lightning bolt', { name: 'Lightning Bolt', gihWr: 0.65, gihCount: 1000, lowSample: false, color: 'R', rarity: 'U', alsa: 1.5, ata: 2.0, ohWr: 0.63, gpWr: 0.60, gdWr: 0.62, gnsWr: 0.55, iih: 9.0, raw: {} }],
        ['forest',         { name: 'Forest',         gihWr: 0.52, gihCount: 5000, lowSample: false, color: 'G', rarity: 'C', alsa: 8.0, ata: 9.0, ohWr: 0.51, gpWr: 0.50, gdWr: 0.50, gnsWr: 0.48, iih: 1.0, raw: {} }],
      ]);
    });

    test('best card is ranked first', () => {
      const ranked = assistant.rankPack([
        { arena_id: 1, name: 'Forest' },
        { arena_id: 2, name: 'Lightning Bolt' },
      ]);
      expect(ranked[0].name).toBe('Lightning Bolt');
    });

    test('unknown cards (null WR) are sorted to the bottom', () => {
      const ranked = assistant.rankPack([
        { arena_id: 1, name: 'Unknown Card' },
        { arena_id: 2, name: 'Lightning Bolt' },
      ]);
      expect(ranked[ranked.length - 1].name).toBe('Unknown Card');
    });

    test('each card in the result has a tier property', () => {
      const ranked = assistant.rankPack([{ arena_id: 1, name: 'Lightning Bolt' }]);
      expect(ranked[0]).toHaveProperty('tier');
    });

    test('mythic card gets tier "mythic"', () => {
      const ranked = assistant.rankPack([{ arena_id: 1, name: 'Lightning Bolt' }]);
      expect(ranked[0].tier).toBe('mythic');
    });

    test('unknown card gets tier "none"', () => {
      const ranked = assistant.rankPack([{ arena_id: 99, name: 'Unrecognised' }]);
      expect(ranked[0].tier).toBe('none');
    });

    test('gihWr is null for unknown cards', () => {
      const ranked = assistant.rankPack([{ arena_id: 99, name: 'Unrecognised' }]);
      expect(ranked[0].gihWr).toBeNull();
    });

    test('two null-WR cards maintain stable relative order (both null)', () => {
      const ranked = assistant.rankPack([
        { arena_id: 1, name: 'Unknown A' },
        { arena_id: 2, name: 'Unknown B' },
      ]);
      expect(ranked.every(c => c.gihWr === null)).toBe(true);
    });

    test('original card properties are preserved in output', () => {
      const ranked = assistant.rankPack([{ arena_id: 42, name: 'Lightning Bolt', type: 'Instant' }]);
      expect(ranked[0].arena_id).toBe(42);
      expect(ranked[0].type).toBe('Instant');
    });
  });

  // ── getStat ───────────────────────────────────────────────────────────────

  describe('getStat', () => {
    beforeEach(() => {
      assistant.cardStats = new Map([
        ['brainstorm', { name: 'Brainstorm', gihWr: 0.63, alsa: 2.0, ata: 2.5, ohWr: 0.62, gpWr: 0.58, gdWr: 0.61, gnsWr: 0.55, iih: 8.0, gihCount: 1200, lowSample: false, raw: { 'Custom Col': 'custom-value' } }],
      ]);
    });

    test('returns gihWr for known card', () => {
      expect(assistant.getStat('Brainstorm', 'gihWr')).toBeCloseTo(0.63);
    });

    test('returns alsa for known card', () => {
      expect(assistant.getStat('Brainstorm', 'alsa')).toBeCloseTo(2.0);
    });

    test('returns raw column value by key', () => {
      expect(assistant.getStat('Brainstorm', 'Custom Col')).toBe('custom-value');
    });

    test('returns null for unknown card', () => {
      expect(assistant.getStat('Unknown', 'gihWr')).toBeNull();
    });

    test('returns null for missing metric on known card', () => {
      expect(assistant.getStat('Brainstorm', 'nonExistentStat')).toBeNull();
    });
  });

  // ── getStatus ─────────────────────────────────────────────────────────────

  describe('getStatus', () => {
    test('returns loaded:false before CSV is loaded', () => {
      const status = assistant.getStatus();
      expect(status.loaded).toBe(false);
      expect(status.cardCount).toBe(0);
      expect(status.setName).toBeNull();
    });

    test('returns loaded:true and correct counts after CSV is loaded', () => {
      const csv = makeCsv(
        row('Card A', { gihWr: 0.60 }),
        row('Card B', { gihWr: 0.55 }),
      );
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);
      assistant.loadCSV('/data/my-ratings.csv');

      const status = assistant.getStatus();
      expect(status.loaded).toBe(true);
      expect(status.cardCount).toBe(2);
      expect(status.setName).toBe('my-ratings');
      expect(status.csvPath).toBe('/data/my-ratings.csv');
    });
  });

  // ── getAllCardStats ────────────────────────────────────────────────────────

  describe('getAllCardStats', () => {
    test('returns empty array before any CSV is loaded', () => {
      expect(assistant.getAllCardStats()).toEqual([]);
    });

    test('returns an array of all card stat objects after loading', () => {
      const csv = makeCsv(
        row('Lightning Bolt', { gihWr: 0.64 }),
        row('Forest',         { gihWr: 0.52 }),
      );
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(csv);
      assistant.loadCSV('/data/ratings.csv');

      const all = assistant.getAllCardStats();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toHaveLength(2);
      const names = all.map(s => s.name);
      expect(names).toContain('Lightning Bolt');
    });
  });

  // ── _parseCSV error branches ──────────────────────────────────────────────

  describe('_parseCSV error cases', () => {
    test('CSV with fewer than 2 lines throws an error', () => {
      const headerOnly = CSV_HEADER;
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue(headerOnly);
      expect(() => assistant.loadCSV('/data/empty.csv')).toThrow('CSV appears empty or has no data rows');
    });
  });
});
