'use strict';

// hypgeoCalculator.js has no electron/DOM dependency for its pure math exports.
// We require it directly without any mocking.

const {
    parsePips,
    pipKey,
    hypGeoAtLeastOne,
    multiHypGeoExact,
    convergeProb,
} = require('../renderer/deckBuilder/hypgeoCalculator');

// ─── parsePips ────────────────────────────────────────────────────────────────

describe('parsePips', () => {
    test('single mono-color pip', () => {
        expect(parsePips('{W}')).toEqual({ W: 1 });
    });

    test('multiple pips of the same color', () => {
        expect(parsePips('{U}{U}')).toEqual({ U: 2 });
    });

    test('mixed color pips', () => {
        expect(parsePips('{G}{G}{W}')).toEqual({ G: 2, W: 1 });
    });

    test('hybrid pips like {2/G} are ignored (not a hard pip requirement)', () => {
        expect(parsePips('{2/G}{W}')).toEqual({ W: 1 });
    });

    test('generic mana {3} is ignored', () => {
        expect(parsePips('{3}{R}')).toEqual({ R: 1 });
    });

    test('null / undefined / empty returns empty object', () => {
        expect(parsePips(null)).toEqual({});
        expect(parsePips(undefined)).toEqual({});
        expect(parsePips('')).toEqual({});
    });
});

// ─── pipKey ───────────────────────────────────────────────────────────────────

describe('pipKey', () => {
    test('mono-color single pip', () => {
        expect(pipKey({ R: 1 })).toBe('R');
    });

    test('repeats the letter for multiple pips of the same color', () => {
        expect(pipKey({ U: 2 })).toBe('UU');
    });

    test('multi-color follows WUBRG canonical order', () => {
        expect(pipKey({ G: 2, W: 1 })).toBe('WGG');
    });

    test('empty pips object → empty string', () => {
        expect(pipKey({})).toBe('');
    });

    test('zero-count entries are omitted', () => {
        expect(pipKey({ W: 0, R: 1 })).toBe('R');
    });
});

// ─── hypGeoAtLeastOne ─────────────────────────────────────────────────────────

describe('hypGeoAtLeastOne', () => {
    test('K = 0 → probability 0 (no successes in deck)', () => {
        expect(hypGeoAtLeastOne(40, 0, 7)).toBe(0);
    });

    test('n = 0 → probability 0 (drawing nothing)', () => {
        expect(hypGeoAtLeastOne(40, 17, 0)).toBe(0);
    });

    test('more successes than non-successes forces a hit → probability 1', () => {
        // N=10, K=8, n=3: only 2 non-successes, can't fill 3 draws without a hit
        expect(hypGeoAtLeastOne(10, 8, 3)).toBe(1);
    });

    test('17 lands in 40-card deck, 7-card opening hand (going first) ≈ 98.7%', () => {
        const p = hypGeoAtLeastOne(40, 17, 7);
        expect(p).toBeGreaterThan(0.95);
        expect(p).toBeLessThan(1);
    });

    test('result is between 0 and 1 for valid inputs', () => {
        const p = hypGeoAtLeastOne(40, 5, 7);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
    });
});

// ─── multiHypGeoExact ────────────────────────────────────────────────────────

describe('multiHypGeoExact', () => {
    // For a mono-color requirement with no custom lands, multiHypGeoExact should
    // match hypGeoAtLeastOne — they model the same scenario.
    test('mono-color requirement matches hypGeoAtLeastOne', () => {
        const N = 40, n = 7, K = 9, pipReq = { G: 1 };
        const sources = { W: 0, U: 0, B: 0, R: 0, G: K };
        const exact = multiHypGeoExact(N, sources, n, pipReq, {}, K);
        const atLeast = hypGeoAtLeastOne(N, K, n);
        expect(exact).toBeCloseTo(atLeast, 6);
    });

    test('impossible requirement (more pips than sources) → 0', () => {
        const sources = { W: 0, U: 0, B: 0, R: 0, G: 2 };
        const pipReq  = { G: 3 }; // need 3 green sources, only 2 exist
        expect(multiHypGeoExact(40, sources, 7, pipReq, {}, 17)).toBe(0);
    });

    test('no pip requirement → probability 1', () => {
        const sources = { W: 9, U: 0, B: 0, R: 0, G: 0 };
        expect(multiHypGeoExact(40, sources, 7, {}, {}, 17)).toBe(1);
    });

    test('result is between 0 and 1 for a two-color requirement', () => {
        const sources = { W: 9, U: 8, B: 0, R: 0, G: 0 };
        const pipReq  = { W: 1, U: 1 };
        const p = multiHypGeoExact(40, sources, 7, pipReq, {}, 17);
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThanOrEqual(1);
    });
});

// ─── convergeProb ─────────────────────────────────────────────────────────────

describe('convergeProb', () => {
    test('X = 0 → probability 1 (trivially satisfied)', () => {
        const sources = { W: 9, U: 8, B: 0, R: 0, G: 0 };
        expect(convergeProb(40, sources, 7, 0)).toBe(1);
    });

    test('X > number of active colors → probability 0 (impossible)', () => {
        const sources = { W: 9, U: 0, B: 0, R: 0, G: 0 }; // 1 active color
        expect(convergeProb(40, sources, 7, 2)).toBe(0);
    });

    test('C2 with two balanced sources gives meaningful probability', () => {
        const sources = { W: 9, U: 8, B: 0, R: 0, G: 0 };
        const p = convergeProb(40, sources, 13, 2); // 7 + turn 6 card
        expect(p).toBeGreaterThan(0.5);
        expect(p).toBeLessThanOrEqual(1);
    });

    test('result is between 0 and 1', () => {
        const sources = { W: 5, U: 5, B: 5, R: 0, G: 0 };
        const p = convergeProb(40, sources, 10, 2);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
    });
});
