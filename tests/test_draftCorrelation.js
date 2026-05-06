'use strict';

const { missingCardsForPick } = require('../draftCorrelation');

// Helper: build a DraftRecord from a flat array of pick descriptors.
function record(...picks) {
  return { draftId: 'd1', startedAt: 0, picks };
}

describe('missingCardsForPick', () => {
  test('returns [] for picks <= 8 (no wheel possible)', () => {
    const r = record(
      { pack: 1, pick: 1, options: [10, 11, 12], picked: 10 },
      { pack: 1, pick: 8, options: [20, 21],     picked: 20 },
    );
    expect(missingCardsForPick(r, 1, 1)).toEqual([]);
    expect(missingCardsForPick(r, 1, 8)).toEqual([]);
  });

  test('standard wheel: pick 9 against pick 1, excludes own pick', () => {
    const r = record(
      // Pick 1: opened 14 cards, took id 100
      { pack: 1, pick: 1, options: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113], picked: 100 },
      // Pick 9: 6 cards remain (8 taken: us + 7 left-neighbors)
      { pack: 1, pick: 9, options: [108, 109, 110, 111, 112, 113], picked: null },
    );
    const result = missingCardsForPick(r, 1, 9);
    // Expected: 101..107 (the 7 cards taken by other players), NOT 100 (our own pick).
    expect(result.sort()).toEqual([101, 102, 103, 104, 105, 106, 107]);
  });

  test('returns [] when prior pick is missing from record', () => {
    const r = record(
      { pack: 1, pick: 9, options: [108], picked: null },
    );
    expect(missingCardsForPick(r, 1, 9)).toEqual([]);
  });

  test('returns [] when current pick is missing from record', () => {
    const r = record(
      { pack: 1, pick: 1, options: [100, 101], picked: 100 },
    );
    expect(missingCardsForPick(r, 1, 9)).toEqual([]);
  });

  test('prior pick has picked: null (auto-pick gap) — full diff with no card excluded', () => {
    const r = record(
      { pack: 1, pick: 1, options: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113], picked: null },
      { pack: 1, pick: 9, options: [108, 109, 110, 111, 112, 113], picked: null },
    );
    const result = missingCardsForPick(r, 1, 9);
    // 8 cards missing including the one whose picker we don't know.
    expect(result.sort()).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
  });

  test('15-card pack still works (wheel stays at pick - 8)', () => {
    const opts = Array.from({length: 15}, (_, i) => 200 + i); // 200..214
    const r = record(
      { pack: 1, pick: 1, options: opts,             picked: 200 },
      { pack: 1, pick: 9, options: opts.slice(8),    picked: null }, // 7 cards remain after 8 picks
    );
    const result = missingCardsForPick(r, 1, 9);
    // 8 cards missing total, minus our own pick (200) = 7 cards
    expect(result.sort()).toEqual([201, 202, 203, 204, 205, 206, 207]);
  });

  test('returns [] when draftRecord.picks is not an array', () => {
    expect(missingCardsForPick({ picks: 'notanarray' }, 1, 9)).toEqual([]);
    expect(missingCardsForPick({ picks: null }, 1, 9)).toEqual([]);
    expect(missingCardsForPick({ picks: 42 }, 1, 9)).toEqual([]);
  });

  test('pack 2 (right-pass) returns the same shape as pack 1', () => {
    const r = record(
      { pack: 2, pick: 1, options: [300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313], picked: 300 },
      { pack: 2, pick: 9, options: [308, 309, 310, 311, 312, 313], picked: null },
    );
    const result = missingCardsForPick(r, 2, 9);
    expect(result.sort()).toEqual([301, 302, 303, 304, 305, 306, 307]);
  });

  test('wheel at pick 14 against pick 6', () => {
    const r = record(
      { pack: 1, pick: 6,  options: [400, 401, 402, 403, 404, 405, 406, 407, 408], picked: 400 },
      { pack: 1, pick: 14, options: [408],                                          picked: null },
    );
    const result = missingCardsForPick(r, 1, 14);
    // 8 cards in earlier view, 1 remains, 1 was our own pick. Missing = 6 (excludes our own pick).
    expect(result.sort()).toEqual([401, 402, 403, 404, 405, 406, 407]);
  });
});
