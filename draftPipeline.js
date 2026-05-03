'use strict';

/**
 * draftPipeline
 *
 * Composes per-pick enrichment + the ViewerBundle shape.
 *
 * Two entry points produce the SAME bundle shape:
 *   - buildDraftUpdatePayload(eventData, dataStore, ...) — live path; upserts
 *     the event into the store first.
 *   - buildViewerBundle(record, ...)                     — past-draft path;
 *     consumes a stored DraftRecord directly.
 *
 * The bundle is the renderer's single source of truth: every (pack, pick)
 * coordinate the user can step to is a fully enriched entry in `picks[]`,
 * and `liveCoord` points to the most recent observed coordinate.
 */

const { missingCardsForPick } = require('./draftCorrelation');

const DEFAULT_PACK_SIZE = 14;

const _warnedGaps = new Set();

function fillMissingPickPlaceholders(record) {
  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return [];
  }

  const picksByPack = new Map();
  let maxPack = 0;
  for (const p of record.picks) {
    if (!picksByPack.has(p.pack)) picksByPack.set(p.pack, new Map());
    picksByPack.get(p.pack).set(p.pick, p);
    if (p.pack > maxPack) maxPack = p.pack;
  }

  const out = [];
  for (let pack = 1; pack <= maxPack; pack++) {
    const pickMap = picksByPack.get(pack);
    if (!pickMap) continue;

    let maxPick = 0;
    for (const k of pickMap.keys()) if (k > maxPick) maxPick = k;

    const firstPick = pickMap.get(1);
    const packSize = firstPick && Array.isArray(firstPick.options)
      ? firstPick.options.length
      : DEFAULT_PACK_SIZE;

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

function _rankOrFallback(resolved, draftAssistant, assistantLoaded) {
  return assistantLoaded
    ? draftAssistant.rankPack(resolved)
    : resolved.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));
}

/**
 * Build the enriched per-pick entry for the bundle. Pure aside from the
 * draftAssistant calls (which are pure if the assistant has loaded data).
 */
function enrichPick(rawPick, record, draftAssistant, resolveCards, resolveCard) {
  if (rawPick.missing) {
    return {
      pack: rawPick.pack,
      pick: rawPick.pick,
      missing: true,
      picked: null,
      options: [],
      removedCards: [],
    };
  }

  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();

  const resolvedOptions = resolveCards(rawPick.options);
  const rankedOptions = _rankOrFallback(resolvedOptions, draftAssistant, assistantLoaded);

  const removedGrpIds = missingCardsForPick(record, rawPick.pack, rawPick.pick);
  const resolvedRemoved = resolveCards(removedGrpIds);
  const rankedRemoved = _rankOrFallback(resolvedRemoved, draftAssistant, assistantLoaded);

  const out = {
    pack: rawPick.pack,
    pick: rawPick.pick,
    picked: rawPick.picked ?? null,
    options: rankedOptions,
    removedCards: rankedRemoved,
  };

  if (rawPick.picked != null) {
    const picked = resolveCard(rawPick.picked);
    if (assistantLoaded && picked.name) {
      const s = draftAssistant.getCardStats(picked.name);
      picked.gihWr     = s?.gihWr ?? null;
      picked.lowSample = s ? s.lowSample : true;
      picked.tier      = draftAssistant.getCardTier(picked.gihWr, picked.name, picked.lowSample);
    }
    out.pickedCard = picked;
  }

  return out;
}

/**
 * Build a ViewerBundle from a stored DraftRecord. Returns the same shape the
 * live 'draft-update' event emits, so the renderer never branches on source.
 */
function buildViewerBundle(record, draftAssistant, resolveCards, resolveCard) {
  const assistantLoaded = !!draftAssistant.isLoaded && draftAssistant.isLoaded();
  const assistantStatus = draftAssistant.getStatus ? draftAssistant.getStatus() : null;

  if (!record || !Array.isArray(record.picks) || record.picks.length === 0) {
    return {
      draftId:   record?.draftId   ?? null,
      startedAt: record?.startedAt ?? null,
      liveCoord: null,
      picks:     [],
      assistantLoaded,
      assistantStatus,
    };
  }

  const filled = fillMissingPickPlaceholders(record);
  const sorted = filled.slice().sort((a, b) =>
    a.pack !== b.pack ? a.pack - b.pack : a.pick - b.pick
  );

  const enrichedPicks = sorted.map(p =>
    enrichPick(p, record, draftAssistant, resolveCards, resolveCard)
  );

  const last = sorted[sorted.length - 1];

  return {
    draftId:   record.draftId,
    startedAt: record.startedAt,
    liveCoord: { pack: last.pack, pick: last.pick },
    picks:     enrichedPicks,
    assistantLoaded,
    assistantStatus,
  };
}

/**
 * Live path: upsert the event into the store, then build the bundle.
 */
function buildDraftUpdatePayload(eventData, dataStore, draftAssistant, resolveCards, resolveCard) {
  dataStore.upsertDraft(eventData);
  const persisted = dataStore.getDraft(eventData.draftId);
  return buildViewerBundle(persisted, draftAssistant, resolveCards, resolveCard);
}

function _resetWarnedGaps() {
  _warnedGaps.clear();
}

module.exports = {
  buildDraftUpdatePayload,
  buildViewerBundle,
  enrichPick,
  fillMissingPickPlaceholders,
  _resetWarnedGaps,
};
