'use strict';

/**
 * Given a list of parsed game events, coalesce DRAFT_UPDATE events so that
 * only the last event per draftId is retained.  All other event types pass
 * through in their original order before the surviving draft events.
 *
 * Without this, a periodic full-log scan re-emits every historical
 * DRAFT_UPDATE (because the parser clears its dedup set each run), causing
 * the renderer to re-render the draft view dozens of times per scan and
 * making the pack list appear to jump around.
 *
 * @param {Array<{type:string, data:object}>} events
 * @returns {Array<{type:string, data:object}>}
 */
function coalesceEvents(events) {
  // Build map of draftId → last DRAFT_UPDATE (most up-to-date state for renderer).
  const lastByDraft = new Map();
  for (const event of events) {
    if (event.type === 'DRAFT_UPDATE') {
      lastByDraft.set(event.data?.draftId, event);
    }
  }

  if (lastByDraft.size === 0) return events;

  // Walk events in order. Keep each DRAFT_UPDATE at its *first* occurrence
  // position (so activeDraftId is set before that draft's MATCH_END events)
  // but substitute the *last* occurrence's data (freshest state for renderer).
  const seen = new Set();
  return events.map(event => {
    if (event.type !== 'DRAFT_UPDATE') return event;
    const draftId = event.data?.draftId;
    if (seen.has(draftId)) return null;
    seen.add(draftId);
    return lastByDraft.get(draftId);
  }).filter(Boolean);
}

module.exports = { coalesceEvents };
