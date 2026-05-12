'use strict';

/**
 * Set Enricher
 *
 * Merges pre-baked SOS/SOA card data (sos-card-data.json) into the user's
 * cards.json. The pre-baked file ships with the installer; no Python or
 * SQLite is needed at runtime.
 *
 * To support the next unmapped set:
 *   1. Update sos-card-import/generate_enrichment_data.py with the new set codes.
 *   2. Run:  python sos-card-import/generate_enrichment_data.py
 *   3. Commit the updated sos-card-data.json and rebuild the installer.
 */

const path = require('path');
const fs   = require('fs');

// Path to the pre-baked enrichment bundle shipped with the app.
// Electron's fs transparently handles reads from inside the asar archive.
let ENRICHMENT_FILE = path.join(__dirname, 'sos-card-data.json');
let CARDS_FILE      = path.join(__dirname, 'cards.json');

function init(userDataPath) {
  CARDS_FILE = path.join(userDataPath, 'cards.json');
}

function loadEnrichmentData() {
  return JSON.parse(fs.readFileSync(ENRICHMENT_FILE, 'utf8'));
}

function needsEnrichment() {
  try {
    const data = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    if (!data.mainDraftSets?.length) return true;
    let enrichment;
    try { enrichment = loadEnrichmentData(); } catch { return false; }
    const done = new Set(data.enrichedSets || []);
    return !enrichment.setCodes.every(c => done.has(c));
  } catch {
    return true;
  }
}

// opts.force: run even when needsEnrichment() returns false
async function enrich(opts = {}) {
  if (!opts.force && !needsEnrichment()) {
    console.log('[SetEnricher] Already up to date, skipping');
    return false;
  }

  let enrichmentData;
  try {
    enrichmentData = loadEnrichmentData();
  } catch (err) {
    console.warn('[SetEnricher] Could not load enrichment bundle:', err.message);
    return false;
  }

  try {
    const cardsData = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    const cards = cardsData.cards || {};

    let added = 0;
    for (const [grpId, entry] of Object.entries(enrichmentData.cards)) {
      const existing = cards[grpId];
      if (existing?.manaCost) {
        existing.set               = entry.set;
        existing.digitalReleaseSet = entry.digitalReleaseSet;
      } else {
        cards[grpId] = entry;
        added++;
      }
    }

    cardsData.cards         = cards;
    cardsData.mainDraftSets = enrichmentData.mainDraftSets;
    cardsData.enrichedSets  = [
      ...new Set([...(cardsData.enrichedSets || []), ...enrichmentData.setCodes]),
    ];

    const tmp = CARDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cardsData, null, 2));
    fs.renameSync(tmp, CARDS_FILE);

    console.log(`[SetEnricher] Merged ${added} cards; sets: ${enrichmentData.setCodes.join(', ')}`);
    return true;
  } catch (err) {
    console.error('[SetEnricher] Enrichment failed:', err.message);
    return false;
  }
}

module.exports = { enrich, needsEnrichment, init };
