/**
 * MTG Arena Log Parser v5 — thin coordinator
 *
 * Delegates match parsing to MatchParser and draft parsing to DraftParser.
 * Owns deduplication of emitted events across calls to parse().
 */

'use strict';

const MatchParser = require('./parser/matchParser');
const DraftParser = require('./parser/draftParser');

class LogParserV5 {
  constructor() {
    this.matchParser     = new MatchParser();
    this.draftParser     = new DraftParser();
    this.processedEvents = new Set();
  }

  parse(data) {
    const events = [];
    const lines  = data.split('\n');

    // Reset ephemeral state and dedup set for this scan.
    // DataStore handles cross-scan dedup; processedEvents only deduplicates
    // duplicate log lines within a single parse() call.
    this.matchParser.reset();
    this.draftParser.reset();
    this.processedEvents.clear();

    // Pre-scan deck metadata before the main line loop
    this.matchParser.extractDeckNames(lines);
    this.matchParser.extractDeckCards(lines);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const event =
        this.matchParser.parseLine(line, lines, i) ||
        this.draftParser.parseLine(line);
      if (!event) continue;

      const eventKey = this._makeKey(event, i);
      if (!this.processedEvents.has(eventKey)) {
        this.processedEvents.add(eventKey);
        events.push(event);
      } else {
        console.log(`[Parser] Skipping duplicate event: ${eventKey}`);
      }
    }

    // Keep the processed-events set bounded
    if (this.processedEvents.size > 1000) {
      this.processedEvents = new Set(Array.from(this.processedEvents).slice(-500));
    }

    return events;
  }

  _makeKey(event, lineIndex) {
    const matchId = event.data.matchId || 'unknown';
    const result  = event.data.result  || 'none';
    switch (event.type) {
      case 'MATCH_END':
        return `MATCH_END_${matchId}_${result}_${event.data.timestamp?.split('T')[0] ?? 'unknown'}`;
      case 'INVENTORY_UPDATE':
        return `INVENTORY_UPDATE_${event.data.timestamp}`;
      case 'DRAFT_PICK':
        return `DRAFT_PICK_${event.data.draftId}_${event.data.pack}_${event.data.pick}`;
      case 'DRAFT_UPDATE':
        return `DRAFT_UPDATE_${event.data.draftId}_${event.data.currentPack?.pack}_${event.data.currentPack?.pick}_${event.data.picks?.length ?? 0}_${lineIndex}`;
      default:
        return `${event.type}_${matchId}`;
    }
  }
}

module.exports = LogParserV5;
