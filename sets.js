'use strict';

/**
 * sets.js — MTG Arena set reference data
 *
 * Shared by logParserV5.js (format detection) and renderer.js (UI filtering).
 * Add a new entry here whenever a new set releases on Arena.
 */

const SET_NAMES = {
  SOS: 'Secrets of Strixhaven',
  STX: 'Strixhaven',
  FDN: 'Foundations',
  DSK: 'Duskmourn',
  BLB: 'Bloomburrow',
  OTJ: 'Outlaws of Thunder Junction',
  MKM: 'Murders at Karlov Manor',
  WOE: 'Wilds of Eldraine',
  LCI: 'Lost Caverns of Ixalan',
  MOM: 'March of the Machine',
  ONE: 'Phyrexia: All Will Be One',
  BRO: "Brothers' War",
  DMU: 'Dominaria United',
  MH3: 'Modern Horizons 3',
  MH2: 'Modern Horizons 2',
};

// Segments that appear in MTGA event names but are type keywords, not set codes.
// Used by logParserV5 when extracting the set code from an event name like
// "Human_PremierDraft_SOS" — "AI", "BO1", etc. must not be mistaken for sets.
const SKIP_CODES = new Set(['AI', 'BO1', 'BO3', 'PVP', 'NPC']);

/**
 * Returns true if a format string represents a draft or sealed limited event.
 * Used by the renderer to filter the card-stats format selector to draft formats.
 */
function isDraftLimited(format) {
  return /draft|sealed/i.test(format);
}

module.exports = { SET_NAMES, SKIP_CODES, isDraftLimited };
