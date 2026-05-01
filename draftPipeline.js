'use strict';

/**
 * draftPipeline
 *
 * Composes the per-event DRAFT_UPDATE pipeline:
 *   1. dataStore.upsertDraft(state)
 *   2. dataStore.getDraft(draftId)            ← canonical state
 *   3. draftCorrelation.missingCardsForPick   ← grpIds taken since last view
 *   4. draftAssistant.rankPack on both lists
 *   5. fillMissingPickPlaceholders            ← gap-fill for renderer's My Picks
 *   6. assemble IPC payload
 *
 * Side effects: writes to dataStore, logs warnings on detected gaps.
 * Returns: the IPC payload to send to the renderer (does NOT call webContents.send).
 */

const { missingCardsForPick } = require('./draftCorrelation');

const DEFAULT_PACK_SIZE = 14;

// One-shot per-process dedup for "missing pick" warnings.
// Keyed by `${draftId}:${pack}:${pick}`.
const _warnedGaps = new Set();

/**
 * Detect missing (pack, pick) coordinates within the OBSERVED range and
 * return a new picks array with `{ missing: true }` placeholders inserted
 * for each gap. Does not mutate the input.
 *
 * Pack size is derived from (P, 1).options.length when (P, 1) is present;
 * otherwise we fall back to DEFAULT_PACK_SIZE.
 */
function fillMissingPickPlaceholders(record) {
  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return [];
  }

  // Group picks by pack and find the max pick observed in each pack.
  const picksByPack = new Map(); // pack → Map<pick, entry>
  let maxPack = 0;
  for (const p of record.picks) {
    if (!picksByPack.has(p.pack)) picksByPack.set(p.pack, new Map());
    picksByPack.get(p.pack).set(p.pick, p);
    if (p.pack > maxPack) maxPack = p.pack;
  }

  const out = [];
  for (let pack = 1; pack <= maxPack; pack++) {
    const pickMap = picksByPack.get(pack);
    if (!pickMap) continue; // unobserved pack — don't fabricate

    let maxPick = 0;
    for (const k of pickMap.keys()) if (k > maxPick) maxPick = k;

    // Pack size: prefer (P, 1).options.length; fall back to DEFAULT_PACK_SIZE.
    const firstPick = pickMap.get(1);
    const packSize = firstPick && Array.isArray(firstPick.options)
      ? firstPick.options.length
      : DEFAULT_PACK_SIZE;

    // Fill 1..maxPick (the OBSERVED range only — don't extrapolate forward).
    const upper = Math.min(maxPick, packSize);
    for (let pick = 1; pick <= upper; pick++) {
      const entry = pickMap.get(pick);
      if (entry) {
        out.push(entry);
      } else {
        const key = `${record.draftId}:${pack}:${pick}`;
        if (!_warnedGaps.has(key)) {
          _warnedGaps.add(key);
          console.warn(`[DraftStore] Missing pick (pack=${pack}, pick=${pick}) for draft ${record.draftId} — likely auto-pick during disconnect`);
        }
        out.push({ pack, pick, options: [], picked: null, missing: true });
      }
    }
  }
  return out;
}

/**
 * Build the IPC payload for a single DRAFT_UPDATE event.
 *
 * @param {object}   eventData     - Parser DRAFT_UPDATE state: {draftId, picks, currentPack}
 * @param {object}   dataStore     - DataStore instance (must have upsertDraft, getDraft)
 * @param {object}   draftAssistant- DraftAssistant instance (must have isLoaded, rankPack, getCardStats, getCardTier, getStatus)
 * @param {Function} resolveCards  - (grpId[]) => card[]   (grpId → resolved card objects)
 * @param {Function} resolveCard   - (grpId)   => card     (single)
 * @returns {object} The IPC payload suitable for webContents.send('draft-update', ...).
 */
function buildDraftUpdatePayload(eventData, dataStore, draftAssistant, resolveCards, resolveCard) {
  dataStore.upsertDraft(eventData);
  const persisted = dataStore.getDraft(eventData.draftId);
  const currentPack = eventData.currentPack || null;

  // Compute removed cards for the live pack view.
  const removedGrpIds = currentPack
    ? missingCardsForPick(persisted, currentPack.pack, currentPack.pick)
    : [];

  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();

  // Resolve + rank the live pack options.
  const resolvedOptions = currentPack ? resolveCards(currentPack.options) : [];
  const rankedOptions = assistantLoaded
    ? draftAssistant.rankPack(resolvedOptions)
    : resolvedOptions.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));

  // Resolve + rank the removed cards (same rank-and-enrich treatment).
  const resolvedRemoved = resolveCards(removedGrpIds);
  const rankedRemoved = assistantLoaded
    ? draftAssistant.rankPack(resolvedRemoved)
    : resolvedRemoved.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));

  // Build the renderer-facing picks list:
  //   - start from gap-filled persisted picks
  //   - drop entries with picked: null and !missing (those are pending pack views, not yet a pick)
  //   - for missing: true entries, leave picked card resolution to renderer (it will show a placeholder row)
  //   - for completed picks, resolve and enrich the picked card the same way main.js used to.
  const filledPicks = fillMissingPickPlaceholders(persisted);
  const rendererPicks = filledPicks
    .filter(p => p.missing === true || p.picked !== null)
    .map(p => {
      if (p.missing) return { pack: p.pack, pick: p.pick, missing: true };
      const picked = resolveCard(p.picked);
      if (assistantLoaded && picked.name) {
        const s = draftAssistant.getCardStats(picked.name);
        picked.gihWr     = s?.gihWr ?? null;
        picked.lowSample = s ? s.lowSample : true;
        picked.tier      = draftAssistant.getCardTier(picked.gihWr, picked.name, picked.lowSample);
      }
      return {
        pack: p.pack,
        pick: p.pick,
        picked,
        options: resolveCards(p.options),
      };
    });

  return {
    draftId: eventData.draftId,
    currentPack: currentPack
      ? { ...currentPack, options: rankedOptions }
      : null,
    removedCards: rankedRemoved,
    picks: rendererPicks,
    assistantLoaded,
    assistantStatus: draftAssistant.getStatus ? draftAssistant.getStatus() : null,
  };
}

// Exposed for unit tests; not part of the public API.
function _resetWarnedGaps() {
  _warnedGaps.clear();
}

module.exports = {
  buildDraftUpdatePayload,
  fillMissingPickPlaceholders,
  _resetWarnedGaps,
};
