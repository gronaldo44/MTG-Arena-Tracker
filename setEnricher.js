'use strict';

/**
 * Set Enricher
 *
 * Merges a pre-baked card data bundle (enrichment-data.json) into the user's
 * cards.json. The bundle is a comprehensive baseline — every Scryfall
 * arena_id-linked card plus whatever newest set(s) Scryfall hasn't linked
 * yet — so this alone can bootstrap a working cards.json from nothing (a
 * fresh install with no network on first launch) as well as top up an
 * existing one. The pre-baked file ships with the installer; no Python or
 * SQLite is needed at runtime. cardUpdater.js's live 24h Scryfall refresh
 * still runs on top of whatever this produces, for freshness/corrections.
 *
 * To support the next unmapped set:
 *   1. Run:  python card-import/generate_enrichment_data.py <set_specs> [<mtga_db_path>] [<scryfall_json_path>]
 *      e.g.: python card-import/generate_enrichment_data.py "MSH,MSC,MAR:MAR-MSH"
 *   2. Commit the updated enrichment-data.json and rebuild the installer.
 */

const path = require('path');
const fs   = require('fs');

// Path to the pre-baked enrichment bundle shipped with the app.
// Electron's fs transparently handles reads from inside the asar archive.
let ENRICHMENT_FILE = path.join(__dirname, 'enrichment-data.json');
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
    let cardsData = { cards: {} };
    try {
      cardsData = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // No cards.json yet (fresh install) — bootstrap one from the bundle below.
    }
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
