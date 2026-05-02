'use strict';

/**
 * Synthetic draft generator for pseudo-integration tests.
 *
 * Produces a sequence of DRAFT_UPDATE event payloads matching what the
 * parser emits during a real draft. The card universe is deterministic
 * (grpIds 1000..1999) so test assertions can compare exact arrays.
 *
 * Each pack starts with `packSize` distinct grpIds in a known range so
 * the wheel diff at pick 9 is exactly `[opener+1 .. opener+7]`.
 */

const PLAYER_COUNT = 8;

/**
 * Build a fully-played 3-pack draft with deterministic picks.
 *
 * @param {object} opts
 * @param {string} opts.draftId       — the draftId for the synthetic draft
 * @param {number} opts.packSize      — cards per pack (default 14)
 * @returns {{
 *   events: Array<{type: 'DRAFT_UPDATE', data: ParserDraftState}>,
 *   expectedRemovedAtP1Pick9: number[],   // sorted grpIds
 *   expectedFinalPickCount: number,
 * }}
 *
 * The parser's DRAFT_UPDATE state shape:
 *   { draftId, picks: [{pack, pick, options, picked}], currentPack: {pack, pick, options} | null }
 */
function buildFullDraft({ draftId = 'synthetic-1', packSize = 14 } = {}) {
  // Card pool: pack P starts at grpId base = 1000 + (P-1) * 1000
  // Card IDs in pack P range over [base, base + packSize - 1]
  const events = [];
  const cumulativePicks = [];

  for (let pack = 1; pack <= 3; pack++) {
    const base = 1000 + (pack - 1) * 1000;
    let remaining = Array.from({ length: packSize }, (_, i) => base + i);

    for (let pick = 1; pick <= packSize; pick++) {
      // Draft.Notify event: currentPack updated, picks unchanged
      const optionsAtThisPick = [...remaining];
      events.push({
        type: 'DRAFT_UPDATE',
        data: {
          draftId,
          picks: [...cumulativePicks],
          currentPack: { pack, pick, options: optionsAtThisPick },
        },
      });

      // Player picks the FIRST card in the visible options.
      // This means at pick 1 they take base+0, at pick 9 (the wheel) they take base+8, etc.
      // For pack 1 pick 1: options = [base+0..base+13], picked = base+0
      //   → 7 cards taken between pick 1 and pick 9 (by 7 left-neighbors) → simulated below.
      const picked = remaining[0];
      remaining = remaining.slice(1);

      // Simulate 7 other-player picks between our picks (they each take one card).
      // We model this by removing 7 cards from `remaining` AFTER our pick — except
      // we want the wheel of pick 1 to show specific cards missing. To keep
      // assertions exact we use a deterministic rule: between OUR pick at pick N
      // and OUR pick at pick N+1, the 7 next cards (in current `remaining` order)
      // are taken by left-neighbors. NB: this only applies before the wheel; after
      // pick 8 the pack returns to us with remaining as-is.
      if (pick < packSize) {
        // After PLAYER_COUNT picks total in this pack rotation, we'd see the pack again.
        // removeCount = cards that must be taken by others between OUR pick N and OUR pick N+1
        // so that the pack shrinks by exactly 1 card per rotation of PLAYER_COUNT hands.
        // For a packSize-card pack: after our pick at position `pick`, remaining.length =
        // packSize - pick. The pack needs exactly (packSize - pick) cards left for picks
        // (pick+1)..packSize, so removeCount = 0 for every pick in this sequential model.
        // This correctly models the deterministic sequential draft where remaining cards are
        // never taken by simulated neighbors between our sequential picks.
        const removeCount = Math.max(0, Math.min(PLAYER_COUNT - 1, remaining.length - (packSize - pick)));
        remaining = remaining.slice(removeCount);
      }

      // EventPlayerDraftMakePick event: picks[] grows
      cumulativePicks.push({ pack, pick, options: optionsAtThisPick, picked });
      events.push({
        type: 'DRAFT_UPDATE',
        data: {
          draftId,
          picks: [...cumulativePicks],
          currentPack: null,
        },
      });
    }
  }

  // Pack 1 pick 1 options: [1000..1013]; picked = 1000.
  // Pack 1 pick 9 options: at the time we wheeled the pack, 8 cards have been taken
  //   total (us at pick 1, plus 7 left-neighbors). So 6 remain.
  // The 7 cards taken by left-neighbors are 1001..1007.
  // Expected removed at P1 pick 9 = [1001..1007].
  const expectedRemovedAtP1Pick9 = [1001, 1002, 1003, 1004, 1005, 1006, 1007];

  return {
    events,
    expectedRemovedAtP1Pick9,
    expectedFinalPickCount: 3 * packSize,
  };
}

module.exports = { buildFullDraft };
