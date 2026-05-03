/**
 * Set Enricher
 *
 * Supplements cards.json with Arena card data for sets that Scryfall has not yet
 * assigned arena_ids to. Runs after the regular Scryfall update step on startup.
 *
 * To support the next unmapped set:
 *   1. Copy sos-card-import/import_sos.py → import_<set>.py and update the set codes inside.
 *   2. Update CURRENT_ENRICHMENT below.
 */

const path   = require('path');
const fs     = require('fs');
const { spawn } = require('child_process');

// ── Change this when a new set is the "latest unmapped" one ──────────────────
const CURRENT_ENRICHMENT = {
  script:   path.join(__dirname, 'sos-card-import', 'import_sos.py'),
  setCodes: ['SOS', 'SOA'],   // MTGA ExpansionCodes this script covers
};
// ─────────────────────────────────────────────────────────────────────────────

const CARDS_FILE = path.join(__dirname, 'cards.json');

// Standard MTGA install locations on Windows, plus the bundled fallback DB
// shipped with the tracker in sos-card-import/. Each entry is
// [directory, filename-prefix] — sorted so the most recent file is picked
// when multiple files match (readdirSync + sort + pop).
const MTGA_DB_CANDIDATES = [
  ['C:\\Program Files\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Data',    'data_cards_'],
  ['C:\\Program Files (x86)\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Data', 'data_cards_'],
  ['C:\\Program Files\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw',     'Raw_CardDatabase_'],
  ['C:\\Program Files (x86)\\Wizards of the Coast\\MTGA\\MTGA_Data\\Downloads\\Raw',  'Raw_CardDatabase_'],
  // Bundled fallback — used when MTGA is not installed at a standard path
  [path.join(__dirname, 'sos-card-import'), 'Raw_CardDatabase_'],
];

function findMtgaDb() {
  for (const [dir, prefix] of MTGA_DB_CANDIDATES) {
    if (!fs.existsSync(dir)) continue;
    const match = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.mtga'))
      .sort()
      .pop();
    if (match) return path.join(dir, match);
  }
  return null;
}

// Look for a compatible Scryfall bulk JSON in the import directory.
// Optional — import scripts fall back to MTGA's own mana data when absent.
function findScryfallJson() {
  const dir = path.join(__dirname, 'sos-card-import');
  if (!fs.existsSync(dir)) return '';
  const candidates = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && /all.cards|bulk|default/i.test(f));
  if (!candidates.length) return '';
  candidates.sort((a, b) =>
    fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs
  );
  return path.join(dir, candidates[0]);
}

function needsEnrichment() {
  try {
    const data = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    if (!data.mainDraftSets?.length) return true;
    const done = new Set(data.enrichedSets || []);
    return !CURRENT_ENRICHMENT.setCodes.every(c => done.has(c));
  } catch {
    return true;
  }
}

function runScript(dbPath, scryfallPath) {
  return new Promise((resolve, reject) => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    const args   = [CURRENT_ENRICHMENT.script, dbPath, scryfallPath, CARDS_FILE];
    const proc   = spawn(python, args, { stdio: 'pipe' });

    proc.stdout.on('data', d => console.log('[SetEnricher]', d.toString().trimEnd()));
    proc.stderr.on('data', d => console.error('[SetEnricher]', d.toString().trimEnd()));
    proc.on('error', err => reject(new Error(`Could not start Python: ${err.message}`)));
    proc.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`Enrichment script exited with code ${code}`))
    );
  });
}

// opts.mtgaDbPath: user-configured path from settings (takes precedence over auto-detect)
// opts.force: skip the needsEnrichment() check and always run
async function enrich(opts = {}) {
  if (!opts.force && !needsEnrichment()) {
    console.log('[SetEnricher] Already up to date, skipping');
    return false;
  }

  const dbPath = (opts.mtgaDbPath && fs.existsSync(opts.mtgaDbPath))
    ? opts.mtgaDbPath
    : findMtgaDb();

  if (!dbPath) {
    console.log('[SetEnricher] MTGA database not found — set the path in Settings or run import_sos.py manually');
    return false;
  }

  if (!fs.existsSync(CURRENT_ENRICHMENT.script)) {
    console.warn('[SetEnricher] Enrichment script missing:', CURRENT_ENRICHMENT.script);
    return false;
  }

  const scryfallPath = findScryfallJson();
  console.log(`[SetEnricher] Enriching sets: ${CURRENT_ENRICHMENT.setCodes.join(', ')}`);
  console.log(`[SetEnricher] MTGA DB: ${path.basename(dbPath)}`);
  if (scryfallPath) console.log(`[SetEnricher] Scryfall JSON: ${path.basename(scryfallPath)}`);
  else              console.log('[SetEnricher] No Scryfall JSON found — using MTGA mana data as fallback');

  try {
    await runScript(dbPath, scryfallPath);

    // Record which sets have been enriched so we don't re-run unnecessarily
    const data = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    data.enrichedSets = [...new Set([...(data.enrichedSets || []), ...CURRENT_ENRICHMENT.setCodes])];
    const tmp = CARDS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CARDS_FILE);

    console.log(`[SetEnricher] Done. enrichedSets: ${data.enrichedSets.join(', ')}`);
    return true;
  } catch (err) {
    console.error('[SetEnricher] Enrichment failed:', err.message);
    return false;
  }
}

module.exports = { enrich, needsEnrichment };
