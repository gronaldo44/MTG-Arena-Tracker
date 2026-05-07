'use strict';

const hypgeo    = require('./deckBuilder/hypgeoCalculator');
const colorPool = require('./deckBuilder/colorPool');

// ─── Deck Builder aggregator ──────────────────────────────────────────────────
// Entry point called by renderer.js when the user switches to the deckbuilder
// page. Each tool's init re-reads shared state so the data is always fresh.

function initDeckBuilder() {
    hypgeo.initHypGeoFromDraft();
    hypgeo.renderHypGeoTable();
    colorPool.renderColorTables();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    initDeckBuilder,
    // Re-export all tool functions so renderer.js can attach them to window.
    ...hypgeo,
    ...colorPool,
};
