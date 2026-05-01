'use strict';

/**
 * draftCorrelation
 *
 * Pure functions that derive insights from a persisted DraftRecord.
 * No I/O; safe to import from any process.
 *
 * A DraftRecord has shape:
 *   { draftId, startedAt, picks: [{ pack, pick, options: number[], picked: number|null }] }
 *
 * The wheel correlation: for any pick (pack, pick) where pick > 8, the
 * "physical" pack we're seeing is the same one we saw at (pack, pick - 8).
 * After 8 picks any pack returns to whoever held it last — the cycle is
 * tied to the player count (8), not the pass direction. So the same
 * formula works for left-pass (packs 1, 3) and right-pass (pack 2) alike.
 */

/**
 * Return the grpIds that were taken from this pack between the player's
 * last view (at pick - 8) and the current view (at pick). Excludes the
 * card the player picked at the earlier view.
 *
 * Returns [] when correlation isn't possible (pick <= 8, prior pick or
 * current pick missing from record).
 */
function missingCardsForPick(draftRecord, pack, pick) {
  if (pick <= 8) return [];
  if (!draftRecord || !Array.isArray(draftRecord.picks)) return [];

  const earlier = draftRecord.picks.find(
    p => p.pack === pack && p.pick === pick - 8
  );
  if (!earlier) return [];

  const current = draftRecord.picks.find(
    p => p.pack === pack && p.pick === pick
  );
  if (!current) return [];

  const stillHere = new Set(current.options);
  const ownPick = earlier.picked != null ? earlier.picked : null;

  return earlier.options.filter(
    grpId => !stillHere.has(grpId) && grpId !== ownPick
  );
}

module.exports = { missingCardsForPick };
