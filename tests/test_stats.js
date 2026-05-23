'use strict';

// stats.js requires electron (ipcRenderer) and DOM APIs at module level.
// Stub them out so we can import the pure helper in Node/Jest.
global.document = { addEventListener: jest.fn() };
jest.mock('electron', () => ({
    ipcRenderer: { invoke: jest.fn(), on: jest.fn(), send: jest.fn() },
}));

const { groupFormatStats } = require('../renderer/stats');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtData(total, wins, losses, draws = 0) {
    return { total, wins, losses, draws };
}

// ─── groupFormatStats ─────────────────────────────────────────────────────────

describe('groupFormatStats', () => {

    // ── key merging ───────────────────────────────────────────────────────────

    describe('key merging', () => {
        test('Premier Draft and Contender Draft for the same set merge into one Draft key', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
            });
            expect(Object.keys(result)).toHaveLength(1);
            expect(result['Draft DSK']).toBeDefined();
        });

        test('only Premier Draft still maps to Draft key', () => {
            const result = groupFormatStats({ 'Premier Draft FDN': fmtData(8, 5, 3) });
            expect(result['Draft FDN']).toBeDefined();
            expect(result['Premier Draft FDN']).toBeUndefined();
        });

        test('only Contender Draft still maps to Draft key', () => {
            const result = groupFormatStats({ 'Contender Draft FDN': fmtData(4, 2, 2) });
            expect(result['Draft FDN']).toBeDefined();
            expect(result['Contender Draft FDN']).toBeUndefined();
        });

        test('non-draft formats pass through unchanged', () => {
            const result = groupFormatStats({ 'Standard': fmtData(20, 12, 8) });
            expect(result['Standard']).toBeDefined();
        });

        test('Historic, Alchemy, and other non-draft formats each get their own key', () => {
            const result = groupFormatStats({
                'Standard': fmtData(10, 6, 4),
                'Historic': fmtData(8, 4, 4),
                'Alchemy':  fmtData(3, 1, 2),
            });
            expect(Object.keys(result)).toHaveLength(3);
        });

        test('draft and non-draft formats coexist without collision', () => {
            const result = groupFormatStats({
                'Premier Draft DSK': fmtData(10, 6, 4),
                'Standard':          fmtData(20, 12, 8),
            });
            expect(Object.keys(result)).toHaveLength(2);
            expect(result['Draft DSK']).toBeDefined();
            expect(result['Standard']).toBeDefined();
        });

        test('two different draft sets produce two separate merged keys', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
                'Premier Draft FDN':   fmtData(8, 5, 3),
                'Contender Draft FDN': fmtData(6, 4, 2),
            });
            expect(Object.keys(result)).toHaveLength(2);
            expect(result['Draft DSK']).toBeDefined();
            expect(result['Draft FDN']).toBeDefined();
        });
    });

    // ── stat summation ────────────────────────────────────────────────────────

    describe('stat summation', () => {
        test('total is summed across Premier and Contender', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
            });
            expect(result['Draft DSK'].total).toBe(15);
        });

        test('wins are summed across Premier and Contender', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
            });
            expect(result['Draft DSK'].wins).toBe(9);
        });

        test('losses are summed across Premier and Contender', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
            });
            expect(result['Draft DSK'].losses).toBe(6);
        });

        test('draws are summed across Premier and Contender', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 3, 1),
                'Contender Draft DSK': fmtData(5, 3, 1, 1),
            });
            expect(result['Draft DSK'].draws).toBe(2);
        });

        test('missing draws field treated as zero', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   { total: 10, wins: 6, losses: 4 },
                'Contender Draft DSK': { total: 5,  wins: 3, losses: 2 },
            });
            expect(result['Draft DSK'].draws).toBe(0);
        });

        test('single format stats are preserved exactly', () => {
            const result = groupFormatStats({ 'Standard': fmtData(20, 12, 7, 1) });
            expect(result['Standard']).toMatchObject({ total: 20, wins: 12, losses: 7, draws: 1 });
        });
    });

    // ── originals tracking ────────────────────────────────────────────────────

    describe('originals tracking', () => {
        test('merged row originals contains both Premier and Contender keys', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
            });
            expect(result['Draft DSK'].originals).toHaveLength(2);
            expect(result['Draft DSK'].originals).toContain('Premier Draft DSK');
            expect(result['Draft DSK'].originals).toContain('Contender Draft DSK');
        });

        test('single-variant row originals contains just that format', () => {
            const result = groupFormatStats({ 'Premier Draft FDN': fmtData(8, 5, 3) });
            expect(result['Draft FDN'].originals).toEqual(['Premier Draft FDN']);
        });

        test('non-draft row originals contains original format name', () => {
            const result = groupFormatStats({ 'Standard': fmtData(10, 6, 4) });
            expect(result['Standard'].originals).toEqual(['Standard']);
        });

        test('originals for two different sets do not cross-contaminate', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(10, 6, 4),
                'Contender Draft DSK': fmtData(5, 3, 2),
                'Premier Draft FDN':   fmtData(8, 5, 3),
            });
            expect(result['Draft DSK'].originals).not.toContain('Premier Draft FDN');
            expect(result['Draft FDN'].originals).not.toContain('Premier Draft DSK');
            expect(result['Draft FDN'].originals).not.toContain('Contender Draft DSK');
        });
    });

    // ── edge cases ────────────────────────────────────────────────────────────

    describe('edge cases', () => {
        test('empty formats object returns empty result', () => {
            expect(groupFormatStats({})).toEqual({});
        });

        test('all-zero stats merge correctly', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':   fmtData(0, 0, 0),
                'Contender Draft DSK': fmtData(0, 0, 0),
            });
            expect(result['Draft DSK']).toMatchObject({ total: 0, wins: 0, losses: 0, draws: 0 });
        });

        test('Quick Draft is not merged with Premier or Contender', () => {
            const result = groupFormatStats({
                'Premier Draft DSK':              fmtData(10, 6, 4),
                'Secrets of Strixhaven Quick Draft': fmtData(5, 3, 2),
            });
            expect(Object.keys(result)).toHaveLength(2);
        });
    });
});
