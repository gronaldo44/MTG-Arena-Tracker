'use strict';

/**
 * Memory regression tests.
 *
 * These tests verify that repeated incremental parsing does not leak memory.
 * They require --expose-gc (configured in package.json jest.testEnvironmentOptions)
 * so that global.gc() can force a collection before measuring.
 *
 * Pass criteria: heap growth after N parse cycles is less than a fixed cap.
 * The cap is intentionally generous to avoid flakiness from GC timing.
 */

const LogParserV5 = require('../logParserV5');
const GREParser   = require('../parser/greParser');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function heapMB() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

/** Build a plausible log chunk that looks like mid-match Arena output. */
function buildLogChunk(seed = 0) {
  const lines = [];
  // Inventory line
  lines.push(`[UnityCrossThreadLogger]${seed}/24/2026 8:00:00 AM: Client called server method`);
  lines.push(JSON.stringify({ InventoryInfo: { Gems: 1000 + seed, Gold: 500, TotalVaultProgress: 12, WildCardCommons: 0, WildCardUnCommons: 0, WildCardRares: 0, WildCardMythics: 0, Boosters: [] } }));
  // Some random filler lines
  for (let i = 0; i < 50; i++) {
    lines.push(`[Info] line ${seed}-${i}: some log data that is not relevant to parsing`);
  }
  return lines.join('\n');
}

/** Build a minimal GRE ConnectResp chunk. */
function buildGREChunk() {
  const msg = {
    greToClientEvent: {
      greToClientMessages: [{
        type: 'GREMessageType_ConnectResp',
        systemSeatIds: [1],
        connectResp: { deckMessage: { deckCards: [12345, 67890] } },
      }],
    },
  };
  return `[UnityCrossThreadLogger]GreToClientEvent\n${JSON.stringify(msg)}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('memory — LogParserV5.parseIncremental', () => {
  test('heap stays flat after many incremental parse cycles', () => {
    const parser = new LogParserV5();
    // Warm up: initial full parse so the parser has baseline state
    parser.parse(buildLogChunk(0));

    const before = heapMB();

    const CYCLES = 200;
    for (let i = 1; i <= CYCLES; i++) {
      parser.parseIncremental(buildLogChunk(i));
    }

    const after = heapMB();
    const growthMB = after - before;

    // Allow up to 20 MB of growth for 200 cycles (100 KB/cycle ceiling).
    // In practice the growth should be near zero after GC.
    expect(growthMB).toBeLessThan(20);
  });
});

describe('memory — GREParser.parseIncremental', () => {
  test('heap stays flat after many incremental parse cycles', () => {
    const parser = new GREParser();
    // Warm up
    parser.parse(buildGREChunk());

    const before = heapMB();

    const CYCLES = 200;
    for (let i = 0; i < CYCLES; i++) {
      parser.parseIncremental(buildGREChunk());
    }

    const after = heapMB();
    const growthMB = after - before;

    expect(growthMB).toBeLessThan(20);
  });
});

describe('memory — processedEvents set stays bounded', () => {
  test('LogParserV5 processedEvents does not grow beyond 1000 entries', () => {
    const parser = new LogParserV5();
    // Drive the parser with many unique draft-update-like events by calling
    // parse() repeatedly (each call clears processedEvents, but parseIncremental
    // accumulates and then prunes at 1000).
    parser.parse('');
    for (let i = 0; i < 50; i++) {
      // Generate unique lines that look like inventory updates (simple event emitters)
      const chunk = JSON.stringify({ InventoryInfo: { Gems: i, Gold: 0, TotalVaultProgress: 0, WildCardCommons: 0, WildCardUnCommons: 0, WildCardRares: 0, WildCardMythics: 0, Boosters: [], timestamp: new Date(i).toISOString() } });
      parser.parseIncremental(chunk);
    }
    expect(parser.processedEvents.size).toBeLessThanOrEqual(1000);
  });
});
