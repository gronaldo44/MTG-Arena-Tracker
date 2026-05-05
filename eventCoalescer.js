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
  const nonDraft = [];
  const lastByDraft = new Map(); // draftId → event

  for (const event of events) {
    if (event.type === 'DRAFT_UPDATE') {
      lastByDraft.set(event.data?.draftId, event);
    } else {
      nonDraft.push(event);
    }
  }

  return lastByDraft.size === 0
    ? nonDraft
    : [...nonDraft, ...lastByDraft.values()];
}

module.exports = { coalesceEvents };
