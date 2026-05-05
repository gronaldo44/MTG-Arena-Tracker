'use strict';

/**
 * Parses draft-lifecycle lines from the MTGA UnityCrossThreadLogger.
 *
 * Emits: DRAFT_UPDATE
 *
 * Call reset() before each log scan, then pass each line to parseLine().
 */
class DraftParser {
  constructor() {
    this.reset();
  }

  reset() {
    this.currentDraft = null;
  }

  // ─── Line routing ──────────────────────────────────────────────────────────

  parseLine(line) {
    if (line.includes('Draft.Notify')) return this.handleDraftNotify(line);
    if (line.includes('EventPlayerDraftMakePick')) return this.handleDraftPick(line);
    return null;
  }

  // ─── Draft handlers ────────────────────────────────────────────────────────

  handleDraftNotify(line) {
    try {
      const notifyIdx = line.indexOf('Draft.Notify');
      if (notifyIdx === -1) return null;

      const jsonStart = line.indexOf('{', notifyIdx);
      if (jsonStart === -1) return null;

      const data = JSON.parse(line.slice(jsonStart));

      if (!data.draftId) {
        console.log('[DraftParser] Draft.Notify missing draftId:', line.slice(0, 120));
        return null;
      }

      const packCards = data.PackCards
        ? data.PackCards.split(',').map(id => parseInt(id)).filter(id => !isNaN(id))
        : [];

      console.log(`[DraftParser] Draft.Notify: draftId=${data.draftId} pack=${data.SelfPack} pick=${data.SelfPick} cards=${packCards.length}`);

      if (!this.currentDraft || this.currentDraft.draftId !== data.draftId) {
        this.currentDraft = { draftId: data.draftId, picks: [], currentPack: null };
      }

      this.currentDraft.currentPack = {
        pack:    data.SelfPack,
        pick:    data.SelfPick,
        options: packCards,
      };

      return { type: 'DRAFT_UPDATE', data: this.currentDraft };
    } catch (e) {
      console.log('[DraftParser] Failed to parse Draft.Notify:', e.message, '| line:', line.slice(0, 120));
      return null;
    }
  }

  handleDraftPick(line) {
    try {
      const requestMatch = line.match(/"request":"(.*)"/);
      if (!requestMatch) return null;

      const requestJson = JSON.parse(requestMatch[1].replace(/\\"/g, '"'));
      const pickedCard  = requestJson.GrpIds?.[0];

      if (!this.currentDraft) return null;

      this.currentDraft.picks.push({
        draftId: requestJson.DraftId,
        pack:    requestJson.Pack,
        pick:    requestJson.Pick,
        picked:  pickedCard,
        options: this.currentDraft.currentPack?.options || [],
      });

      return { type: 'DRAFT_UPDATE', data: this.currentDraft };
    } catch {
      return null;
    }
  }
}

module.exports = DraftParser;
