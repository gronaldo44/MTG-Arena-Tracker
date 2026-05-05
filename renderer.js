/**
 * Renderer Process — UI Logic
 * Handles the interface and communication with main process.
 */

const { ipcRenderer } = require('electron');
const { isDraftLimited } = require('./sets');

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let bundle = null;              // ViewerBundle currently loaded; null until first draft seen
let draftList = [];             // [{draftId, startedAt, pickCount}] for the dropdown
let viewingCoord = null;        // {pack, pick} the user is currently viewing
let csvLoaded = false;          // whether 17Lands CSV is loaded in main process
let _currentPackOptions = [];   // cached options for detail drawer lookups
let _picksData = [];            // raw picks array for re-render on sort/search
let _picksSortField = 'pick';   // 'pick' | 'gihWr' | 'color'
let _picksSearchQuery = '';     // current picks search string
let _loadingDraftId = null;

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(page) {
    currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item =>
        item.classList.toggle('active', item.dataset.page === page)
    );

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');

    if (page === 'dashboard') loadDashboard();
    if (page === 'draft') renderDraftPage();
    if (page === 'matches') loadMatches();
    if (page === 'stats') loadStats();
    if (page === 'settings') loadSettings();
    if (page === 'deckbuilder') { initHypGeoFromDraft(); renderHypGeoTable(); }
}

// ─── Window controls ──────────────────────────────────────────────────────────
function minimizeWindow() { ipcRenderer.send('minimize-window'); }
function maximizeWindow() { ipcRenderer.send('maximize-window'); }
function closeWindow() { ipcRenderer.send('close-window'); }
function openExternalLink(url) { ipcRenderer.send('open-external', url); }

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadDashboard() {
    const stats = await ipcRenderer.invoke('get-stats');
    const inventory = await ipcRenderer.invoke('get-inventory');

    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-wins').textContent = stats.wins || 0;
    document.getElementById('stat-losses').textContent = stats.losses || 0;
    document.getElementById('stat-winrate').textContent = `${stats.winRate || 0}%`;

    const inventoryContainer = document.getElementById('inventory-widget');
    if (inventoryContainer) {
        inventoryContainer.innerHTML = renderInventory(inventory);
    }

    const formatContainer = document.getElementById('format-stats');
    const formats = stats.formats || {};

    if (Object.keys(formats).length === 0) {
        formatContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="icon">🎮</div>
                <p>No matches recorded yet. Start playing MTG Arena!</p>
            </div>`;
    } else {
        formatContainer.innerHTML = Object.entries(formats)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([format, data]) => {
                const winRate = data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0;
                return `
                    <div class="format-card">
                        <h4>
                            <span class="format-name">${format}</span>
                            <span class="format-badge">${data.total} matches</span>
                        </h4>
                        <div class="format-stats">
                            <div class="mini-stat"><span class="number">${data.wins}</span><span class="label">Wins</span></div>
                            <div class="mini-stat"><span class="number">${data.losses}</span><span class="label">Losses</span></div>
                            <div class="mini-stat"><span class="number">${winRate}%</span><span class="label">Win Rate</span></div>
                        </div>
                        <div class="winrate-bar"><div class="fill" style="width: ${winRate}%"></div></div>
                    </div>`;
            }).join('');
    }

    const recentContainer = document.getElementById('recent-matches');
    const matches = await ipcRenderer.invoke('get-matches');
    const recent = matches.slice(0, 10);

    recentContainer.innerHTML = recent.length === 0
        ? `<div class="empty-state"><div class="icon">📝</div><p>No matches yet. Your matches will appear here automatically.</p></div>`
        : recent.map(renderMatchItem).join('');
}

// ─── Matches ──────────────────────────────────────────────────────────────────

let _matchesAllMatches      = [];
let _matchesFormat          = null;
let _matchesSelectedCombos  = new Set();

// Dot background colors keyed by MTG color letter
const _dotColor = { W: '#f5f0e0', U: '#1e6daf', B: '#555', R: '#c1160e', G: '#1a6b3a' };
const _dotBorder = { B: 'border:1px solid #888;' };

// Colors with this many or fewer copies are considered a splash and excluded from
// the combo key used for Format-card grouping and filtering.
const SPLASH_THRESHOLD = 4;

function isSplashColor(count) {
    return count > 0 && count <= SPLASH_THRESHOLD;
}

// Returns the canonical color-combo key (e.g. "UR") for a match, excluding any
// colors the deck only splashes.  Pass deckColorCounts so splash detection works;
// omitting it (legacy path) includes all colors as before.
function getColorCombo(colors, colorCounts) {
    const counts = colorCounts || {};
    return ['W', 'U', 'B', 'R', 'G']
        .filter(c => (colors || []).includes(c) && !isSplashColor(counts[c] || 0))
        .join('');
}

function comboDotsHtml(combo) {
    return [...combo].map(c =>
        `<span class="mfc-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}"></span>`
    ).join('');
}

function colorLabel(c) {
    return { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[c] || c;
}

function renderMatchColorPips(match) {
    const colors = match.deckColors;
    const counts = match.deckColorCounts || {};
    const colorlessCnt = counts['C'] || 0;

    const ordered = ['W', 'U', 'B', 'R', 'G'].filter(c => (colors || []).includes(c));
    if (ordered.length === 0 && colorlessCnt === 0) return '';

    const pips = ordered.map(c => {
        const count = counts[c] || 0;
        const isSplash = isSplashColor(count);
        const title = count > 0
            ? `${colorLabel(c)}: ${count} card${count !== 1 ? 's' : ''}`
            : colorLabel(c);
        const pipStyle = isSplash
            ? `background:transparent;border:2px solid ${c === 'B' ? '#888' : _dotColor[c]};`
            : `background:${_dotColor[c]};${_dotBorder[c] || ''}`;
        return `<span class="match-pip-dot" style="${pipStyle}" title="${title}"></span>`;
    });

    if (colorlessCnt > 0) {
        pips.push(`<span class="match-pip-dot match-pip-colorless"
            title="Colorless: ${colorlessCnt} card${colorlessCnt !== 1 ? 's' : ''}">✦</span>`);
    }

    return `<div class="match-color-pips">${pips.join('')}</div>`;
}

async function loadMatches() {
    _matchesAllMatches = await ipcRenderer.invoke('get-matches');
    renderMatchFormatCards();
    renderMatchList();
}

function renderMatchFormatCards() {
    const container = document.getElementById('matches-format-cards');
    if (!container) return;
    if (_matchesAllMatches.length === 0) { container.innerHTML = ''; return; }

    // Build per-format totals and per-combo breakdown
    const fmtMap = {};
    for (const m of _matchesAllMatches) {
        const fmt   = m.format || 'Unknown';
        const combo = getColorCombo(m.deckColors, m.deckColorCounts);
        if (!fmtMap[fmt]) fmtMap[fmt] = { total: 0, wins: 0, losses: 0, combos: {} };
        fmtMap[fmt].total++;
        if (m.result === 'win')  fmtMap[fmt].wins++;
        if (m.result === 'loss') fmtMap[fmt].losses++;
        if (combo) {
            if (!fmtMap[fmt].combos[combo]) fmtMap[fmt].combos[combo] = { total: 0, wins: 0, losses: 0 };
            fmtMap[fmt].combos[combo].total++;
            if (m.result === 'win')  fmtMap[fmt].combos[combo].wins++;
            if (m.result === 'loss') fmtMap[fmt].combos[combo].losses++;
        }
    }

    const cardsHtml = Object.entries(fmtMap)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([fmt, data]) => {
            const contested = data.wins + data.losses;
            const wr        = contested > 0 ? Math.round(data.wins / contested * 100) : 0;
            const isActive  = fmt === _matchesFormat;
            const safeF     = fmt.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

            const comboRows = Object.entries(data.combos)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([combo, cd]) => {
                    const cContested = cd.wins + cd.losses;
                    const cWr        = cContested > 0 ? Math.round(cd.wins / cContested * 100) : 0;
                    const rowActive  = isActive && _matchesSelectedCombos.has(combo);
                    return `<div class="mfc-combo-row${rowActive ? ' active' : ''}"
                        onclick="event.stopPropagation(); toggleMatchCombo('${safeF}','${combo}')">
                        <div class="mfc-combo-dots">${comboDotsHtml(combo)}</div>
                        <span class="mfc-combo-count">${cd.total} match${cd.total !== 1 ? 'es' : ''}</span>
                        <span class="mfc-combo-wr ${cWr >= 50 ? 'positive' : 'negative'}">${cWr}%</span>
                    </div>`;
                }).join('');

            return `<div class="matches-format-card${isActive ? ' active' : ''}" onclick="selectMatchFormat('${safeF}')">
                <div class="mfc-header">
                    <span class="mfc-name" title="${fmt}">${fmt}</span>
                    <span class="mfc-wr ${wr >= 50 ? 'positive' : 'negative'}">${wr}%</span>
                </div>
                <div class="mfc-meta">${data.total} match${data.total !== 1 ? 'es' : ''}</div>
                ${comboRows ? `<div class="mfc-combo-list">${comboRows}</div>` : ''}
            </div>`;
        }).join('');

    container.innerHTML = `<div class="matches-format-cards-grid">${cardsHtml}</div>`;
}

function renderMatchList() {
    const container = document.getElementById('all-matches');
    let visible = _matchesAllMatches;
    if (_matchesFormat) visible = visible.filter(m => m.format === _matchesFormat);
    if (_matchesSelectedCombos.size > 0) {
        visible = visible.filter(m => _matchesSelectedCombos.has(getColorCombo(m.deckColors, m.deckColorCounts)));
    }
    container.innerHTML = visible.length === 0
        ? `<div class="empty-state"><div class="icon">📝</div><p>${
            _matchesAllMatches.length === 0 ? 'No matches recorded yet.' : 'No matches for this filter.'
          }</p></div>`
        : `<div class="match-list">${visible.map(renderMatchItem).join('')}</div>`;
}

function selectMatchFormat(format) {
    if (_matchesFormat === format) {
        _matchesFormat = null;
        _matchesSelectedCombos.clear();
    } else {
        _matchesFormat = format;
        _matchesSelectedCombos.clear();
    }
    renderMatchFormatCards();
    renderMatchList();
}

function toggleMatchCombo(format, combo) {
    if (_matchesFormat !== format) {
        _matchesFormat = format;
        _matchesSelectedCombos.clear();
    }
    if (_matchesSelectedCombos.has(combo)) {
        _matchesSelectedCombos.delete(combo);
    } else {
        _matchesSelectedCombos.add(combo);
    }
    renderMatchFormatCards();
    renderMatchList();
}

// ─── Stats ────────────────────────────────────────────────────────────────────

let _cardStatsData     = [];
let _cardStatsSortKey  = 'gihWr17l';
// 'format' = personal-stats format keys (e.g., "Premier_Draft_SOS"); existing path.
// 'set'    = MTGA set codes (e.g., "SOS"); used when the user has no draft history yet
//           so the table can still surface 17Lands data for an upcoming draft.
let _cardStatsMode     = 'format';
let _cardStatsSortDir  = -1;           // -1 = desc, 1 = asc
let _cardStatsFormats  = [];           // formats that have data
let _cardStatsFormat   = null;         // currently selected format

async function loadStats() {
    const stats = await ipcRenderer.invoke('get-stats');

    const formatTbody = document.getElementById('stats-formats-table').querySelector('tbody');
    const formats = stats.formats || {};
    formatTbody.innerHTML = Object.keys(formats).length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted);">No data available</td></tr>`
        : Object.entries(formats).sort((a, b) => b[1].total - a[1].total).map(([format, data]) => {
            const contested = data.wins + data.losses;
            const wr = contested > 0 ? Math.round((data.wins / contested) * 100) : 0;
            const safeFormat = format.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const draftClickable = isDraftLimited(format);
            const nameEl = draftClickable
                ? `<strong onclick="selectCardStatsFormat('${safeFormat}')" class="format-name-link">${format}</strong>`
                : `<strong>${format}</strong>`;
            return `<tr>
                <td>${nameEl}</td>
                <td>${data.total}</td>
                <td class="positive">${data.wins}</td>
                <td class="negative">${data.losses}</td>
                <td class="${wr >= 50 ? 'positive' : 'negative'}">${wr}%</td>
                <td><button onclick="deleteFormat('${safeFormat}')" title="Delete all data for this format"
                    style="background:none;border:none;cursor:pointer;font-size:15px;color:var(--text-muted);padding:0 4px;"
                    onmouseover="this.style.color='var(--danger)'" onmouseout="this.style.color='var(--text-muted)'">🗑</button></td>
            </tr>`;
        }).join('');

    // Personal card stats — load available formats, then data for selected format.
    // Falls back to a set-code browse mode when there's no draft history yet.
    const allFormats = await ipcRenderer.invoke('get-card-stat-formats');
    const draftFormats = allFormats.filter(isDraftLimited);

    const previousMode = _cardStatsMode;
    if (draftFormats.length > 0) {
        _cardStatsMode    = 'format';
        _cardStatsFormats = draftFormats;
    } else {
        _cardStatsMode    = 'set';
        const sets = await ipcRenderer.invoke('get-main-draft-sets');
        _cardStatsFormats = sets.map(s => s.code);
    }

    // First time entering browse mode, drop the Min GIH default to 0 so the
    // table actually surfaces 17Lands rows for cards the user hasn't played.
    if (_cardStatsMode === 'set' && previousMode !== 'set') {
        const minInput = document.getElementById('card-stats-min-gih');
        if (minInput) minInput.value = '0';
    }

    // Auto-select when exactly one option exists; otherwise keep current selection
    if (_cardStatsFormats.length === 1) {
        _cardStatsFormat = _cardStatsFormats[0];
    } else if (_cardStatsFormat && !_cardStatsFormats.includes(_cardStatsFormat)) {
        _cardStatsFormat = null; // stale selection
    } else if (_cardStatsFormats.length > 0 && !_cardStatsFormat && _cardStatsMode === 'set') {
        _cardStatsFormat = _cardStatsFormats[0]; // default to most-recent set
    }

    _cardStatsData = await fetchCardStats();

    renderCardStatsFormatSelector();
    renderCardStatsTable();
}

async function fetchCardStats() {
    if (!_cardStatsFormat) return [];
    const channel = _cardStatsMode === 'set' ? 'get-set-card-stats' : 'get-card-game-stats';
    return ipcRenderer.invoke(channel, _cardStatsFormat);
}

function renderCardStatsFormatSelector() {
    const el = document.getElementById('card-stats-format-selector');
    if (!el) return;

    const filterRow = document.getElementById('card-stats-filter-row');

    if (_cardStatsFormats.length === 0) {
        el.innerHTML = '';
        if (filterRow) filterRow.style.display = 'none';
        return;
    }

    const labelText = _cardStatsMode === 'set' ? 'Browsing set' : 'Set';

    if (_cardStatsFormats.length === 1) {
        // Single option — just show a label, no dropdown needed
        el.innerHTML = `<span style="font-size:13px;color:var(--text-muted);">${labelText}: <strong style="color:var(--text);">${_cardStatsFormat}</strong></span>`;
        if (filterRow) filterRow.style.display = 'flex';
        return;
    }

    const opts = _cardStatsFormats
        .map(f => `<option value="${f}"${f === _cardStatsFormat ? ' selected' : ''}>${f}</option>`)
        .join('');

    el.innerHTML = `
        <label style="font-size:13px;color:var(--text-muted);">${labelText}:
            <select onchange="selectCardStatsFormat(this.value)"
                style="margin-left:8px;padding:5px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;">
                <option value="">— Select a draft set —</option>
                ${opts}
            </select>
        </label>`;

    if (filterRow) filterRow.style.display = _cardStatsFormat ? 'flex' : 'none';
}

async function selectCardStatsFormat(format) {
    _cardStatsFormat = format || null;
    _cardStatsData = await fetchCardStats();

    const filterRow = document.getElementById('card-stats-filter-row');
    if (filterRow) filterRow.style.display = _cardStatsFormat ? 'flex' : 'none';

    renderCardStatsTable();
}

function sortCardStats(key) {
    if (_cardStatsSortKey === key) {
        _cardStatsSortDir *= -1;
    } else {
        _cardStatsSortKey = key;
        _cardStatsSortDir = key === 'name' ? 1 : -1;
    }
    renderCardStatsTable();
}

function renderCardStatsTable() {
    // Highlight the active sort column header regardless of data state
    document.querySelectorAll('#stats-cards-table th[data-sort-key]').forEach(th => {
        th.classList.toggle('sort-active-col', th.dataset.sortKey === _cardStatsSortKey);
    });

    const tbody  = document.getElementById('stats-cards-tbody');
    if (!tbody) return;

    const filter = (document.getElementById('card-stats-filter')?.value || '').toLowerCase();
    const minGih = parseInt(document.getElementById('card-stats-min-gih')?.value || '1', 10);

    let rows = _cardStatsData.filter(c =>
        c.gamesInHand >= minGih &&
        (!filter || c.name.toLowerCase().includes(filter))
    );

    const key = _cardStatsSortKey;
    const dir = _cardStatsSortDir;
    rows.sort((a, b) => {
        const av = a[key] ?? (key === 'name' ? '' : -Infinity);
        const bv = b[key] ?? (key === 'name' ? '' : -Infinity);
        if (typeof av === 'string') return dir * av.localeCompare(bv);
        return dir * (av - bv);
    });

    if (!_cardStatsFormat) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-muted);">
            Select a draft set above to view card stats.</td></tr>`;
        return;
    }

    if (rows.length === 0) {
        const msg = _cardStatsMode === 'set'
            ? `No cards visible for <strong>${_cardStatsFormat}</strong>. Lower the Min GIH filter to 0 to see 17Lands data for unplayed cards, or load a 17Lands CSV.`
            : `No card stats yet for <strong>${_cardStatsFormat}</strong>. Play some games to start tracking.`;
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-muted);">${msg}</td></tr>`;
        return;
    }

    const fmt       = v => v !== null ? `${(v * 100).toFixed(1)}%` : '—';
    const deltaClass = d => d === null ? '' : d > 0 ? 'positive' : d < 0 ? 'negative' : '';
    const deltaStr   = d => d === null ? '—' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;

    tbody.innerHTML = rows.map(c => `
        <tr>
            <td><strong>${c.name}</strong> ${cardEyeballHtml(c.grpId, c.name, c.set || _cardStatsFormat)}</td>
            <td>${c.gamesInDeck}</td>
            <td>${c.gamesInHand}</td>
            <td>${fmt(c.gihWrPersonal)}</td>
            <td>${fmt(c.gihWr17l)}</td>
            <td class="${deltaClass(c.delta)}">${deltaStr(c.delta)}</td>
            <td>${c.gamesOpenHand}</td>
            <td>${fmt(c.ohWrPersonal)}</td>
        </tr>`).join('');
}

async function deleteFormat(format) {
    if (!confirm(`Delete all data for "${format}"? This cannot be undone.`)) return;
    await ipcRenderer.invoke('delete-format', format);
    loadStats();
}

async function clearCardStats() {
    if (!confirm('Clear all personal card stats? This cannot be undone.')) return;
    await ipcRenderer.invoke('clear-card-stats');
    _cardStatsData    = [];
    _cardStatsFormat  = null;
    _cardStatsFormats = [];
    renderCardStatsFormatSelector();
    renderCardStatsTable();
}

// ─── Deck Builder ─────────────────────────────────────────────────────────────

const HYPGEO_DECK_SIZE = 40;
const HYPGEO_MAX_TURN  = 10;

// Sources per color — hardcoded for now; 0 means the deck doesn't play that color.
const _hypGeoSources = { W: 0, U: 8, B: 0, R: 0, G: 9 };

let _hypGeoGoingFirst = true;
let _hypGeoConverge   = false;
let _hypGeoPipRows    = []; // unique pip combos from draft; each is {W,U,B,R,G} count obj
let _hypGeoLands      = 17;
const _customLands    = {}; // colorKey (e.g. 'GU') → count of that land type
let _selectedCustomColors = new Set(); // colors toggled in the add-land UI

// Precomputed binomial coefficients C(n,k) for n,k < 61.
const _binom = (() => {
    const MAX = 61;
    const t = Array.from({ length: MAX }, () => Array(MAX).fill(0));
    for (let n = 0; n < MAX; n++) {
        t[n][0] = 1;
        for (let k = 1; k <= n; k++) t[n][k] = t[n-1][k-1] + t[n-1][k];
    }
    return (n, k) => (n < 0 || k < 0 || k > n) ? 0 : t[n][k];
})();

// P(drawing at least 1 of K successes in n draws from a deck of N cards).
// Uses the exact hypergeometric formula P(X≥1) = 1 − ∏(N−K−i)/(N−i).
function hypGeoAtLeastOne(N, K, n) {
    if (K <= 0 || n <= 0) return 0;
    if (N - K < n) return 1; // not enough non-hits to fill the draw
    let p = 1;
    for (let i = 0; i < n; i++) p *= (N - K - i) / (N - i);
    return 1 - p;
}

// Parse Scryfall-style mana cost into per-color pip counts, e.g. "{G}{G}{U}" → {G:2, U:1}.
// Hybrid pips like {2/G} are skipped since they're not a hard pip requirement.
function parsePips(manaCost) {
    const pips = {};
    for (const [, c] of (manaCost || '').matchAll(/\{([WUBRG])\}/g)) {
        pips[c] = (pips[c] || 0) + 1;
    }
    return pips;
}

// Canonical string key for a pip object, e.g. {G:2, U:1} → "GGU".
function pipKey(pips) {
    return ['W', 'U', 'B', 'R', 'G']
        .filter(c => (pips[c] || 0) > 0)
        .map(c => c.repeat(pips[c]))
        .join('');
}

// P(drawing at least pipReq[c] copies of each required color c in n draws from N-card deck).
// Exact multivariate hypergeometric via recursive enumeration.
function multiHypGeoProb(N, colorSources, n, pipReq) {
    const colors = ['W', 'U', 'B', 'R', 'G'].filter(c => (pipReq[c] || 0) > 0);
    if (colors.length === 0) return 1;
    const K    = colors.map(c => colorSources[c] || 0);
    const kMin = colors.map(c => pipReq[c]);
    for (let i = 0; i < colors.length; i++) if (K[i] < kMin[i]) return 0;
    const K_other = N - K.reduce((s, v) => s + v, 0);
    if (K_other < 0) return 0;
    const total = _binom(N, n);
    if (total === 0) return 0;
    let num = 0;
    (function enumerate(idx, drawn, term) {
        if (idx === colors.length) {
            const g_other = n - drawn;
            if (g_other >= 0 && g_other <= K_other) num += term * _binom(K_other, g_other);
            return;
        }
        for (let g = kMin[idx]; g <= Math.min(K[idx], n - drawn); g++)
            enumerate(idx + 1, drawn + g, term * _binom(K[idx], g));
    })(0, 0, 1);
    return Math.min(1, num / total);
}

// Exact multivariate hypergeometric that correctly models dual lands.
// customLands: { colorKey → count }, e.g. { 'GU': 3, 'WUR': 1 }.
// Unspecified source cards are treated as mono-color basics (conservative fallback).
// Groups the deck into disjoint piles by which *required* colors each card produces,
// then enumerates draws over those piles — so a GU dual drawn satisfies both G and U.
function multiHypGeoExact(N, colorSources, n, pipReq, customLands, totalLands) {
    const reqColors = ['W', 'U', 'B', 'R', 'G'].filter(c => (pipReq[c] || 0) > 0);
    if (reqColors.length === 0) return 1;
    const m = reqColors.length;

    // How much of each color is covered by specified custom lands
    const customContrib = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(customLands)) {
        for (const c of key) customContrib[c] += cnt;
    }

    // Remaining sources per color: treated as mono-color basics
    const mono = {};
    for (const c of ['W', 'U', 'B', 'R', 'G'])
        mono[c] = Math.max(0, (colorSources[c] || 0) - customContrib[c]);

    // Build disjoint groups keyed by required-color bitmask.
    // Bit i set → this group produces reqColors[i].
    const groupK = new Array(1 << m).fill(0);

    for (const [key, cnt] of Object.entries(customLands)) {
        let mask = 0;
        for (let i = 0; i < m; i++) if (key.includes(reqColors[i])) mask |= 1 << i;
        groupK[mask] += cnt;
    }
    for (let i = 0; i < m; i++) groupK[1 << i] += mono[reqColors[i]];

    // K_other = everything not in a required-color group (non-land cards + non-required basics)
    const relevantTotal = groupK.reduce((s, v) => s + v, 0);
    const K_other = N - relevantTotal + groupK[0]; // mask=0 custom lands fold into other
    groupK[0] = 0;

    // Quick infeasibility check
    for (let i = 0; i < m; i++) {
        let avail = 0;
        for (let mask = 1; mask < (1 << m); mask++) if ((mask >> i) & 1) avail += groupK[mask];
        if (avail < (pipReq[reqColors[i]] || 0)) return 0;
    }

    const denom = _binom(N, n);
    if (denom === 0) return 0;

    const groups = [];
    for (let mask = 1; mask < (1 << m); mask++) if (groupK[mask] > 0) groups.push({ mask, K: groupK[mask] });
    const req = reqColors.map(c => pipReq[c] || 0);
    let num = 0;

    (function enumerate(gi, drawn, term, colorDrawn) {
        if (gi === groups.length) {
            for (let i = 0; i < m; i++) if (colorDrawn[i] < req[i]) return;
            const g_other = n - drawn;
            if (g_other >= 0 && g_other <= K_other) num += term * _binom(K_other, g_other);
            return;
        }
        const { mask, K } = groups[gi];
        for (let g = 0; g <= Math.min(K, n - drawn); g++) {
            const cd = colorDrawn.slice();
            for (let i = 0; i < m; i++) if ((mask >> i) & 1) cd[i] += g;
            enumerate(gi + 1, drawn + g, term * _binom(K, g), cd);
        }
    })(0, 0, 1, new Array(m).fill(0));

    return Math.min(1, num / denom);
}

function setHypGeoGoingFirst(goFirst) {
    _hypGeoGoingFirst = goFirst;
    document.getElementById('hypgeo-first-btn').classList.toggle('active', goFirst);
    document.getElementById('hypgeo-second-btn').classList.toggle('active', !goFirst);
    const thumb = document.getElementById('go-toggle-thumb');
    if (thumb) thumb.classList.toggle('at-second', !goFirst);
    renderHypGeoTable();
}

function initHypGeoFromDraft() {
    const picks = currentDraftState?.picks || [];

    for (const c of ['W', 'U', 'B', 'R', 'G']) _hypGeoSources[c] = 0;
    _hypGeoPipRows = [];
    if (picks.length === 0) return;

    // Count how many drafted cards include each color (per-card, not per-pip).
    const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const pipRowMap = new Map(); // key → { pips, maxGihWr }
    for (const pick of picks) {
        const pips   = parsePips(pick.picked?.manaCost);
        const key    = pipKey(pips);
        const gihWr  = pick.picked?.gihWr ?? null;
        if (key) {
            for (const c of Object.keys(pips)) colorCounts[c]++;
            if (!pipRowMap.has(key)) {
                pipRowMap.set(key, { pips, maxGihWr: gihWr });
            } else {
                const entry = pipRowMap.get(key);
                if (gihWr !== null && (entry.maxGihWr === null || gihWr > entry.maxGihWr))
                    entry.maxGihWr = gihWr;
            }
        }
    }

    // Top color gets 9 sources, second gets 8, rest stay 0.
    const ranked = ['W', 'U', 'B', 'R', 'G']
        .filter(c => colorCounts[c] > 0)
        .sort((a, b) => colorCounts[b] - colorCounts[a]);

    if (ranked.length >= 1) _hypGeoSources[ranked[0]] = 9;
    if (ranked.length >= 2) _hypGeoSources[ranked[1]] = 8;

    _hypGeoPipRows = [...pipRowMap.values()];
}

function adjustHypGeoSource(color, delta) {
    _hypGeoSources[color] = Math.max(0, Math.min(HYPGEO_DECK_SIZE, (_hypGeoSources[color] || 0) + delta));
    renderHypGeoTable();
}

function adjustHypGeoLands(delta) {
    _hypGeoLands = Math.max(1, Math.min(HYPGEO_DECK_SIZE, _hypGeoLands + delta));
    renderHypGeoTable();
}

function adjustCustomLand(key, delta) {
    const val = (_customLands[key] || 0) + delta;
    if (val <= 0) delete _customLands[key];
    else _customLands[key] = val;
    // Mirror each color pip: adding a land decrements that source, removing restores it.
    for (const c of key) {
        _hypGeoSources[c] = Math.max(0, (_hypGeoSources[c] || 0) - delta);
    }
    renderCustomLandsModal();
    renderHypGeoTable();
}

function toggleCustomLandColor(c) {
    if (_selectedCustomColors.has(c)) _selectedCustomColors.delete(c);
    else _selectedCustomColors.add(c);
    const btn = document.querySelector(`.custom-land-toggle[data-clr="${c}"]`);
    if (btn) btn.classList.toggle('active', _selectedCustomColors.has(c));
    const addBtn = document.getElementById('custom-land-add-btn');
    if (addBtn) addBtn.disabled = _selectedCustomColors.size < 1;
}

function commitCustomLand() {
    if (_selectedCustomColors.size < 1) return;
    const key = ['W', 'U', 'B', 'R', 'G'].filter(c => _selectedCustomColors.has(c)).join('');
    _customLands[key] = (_customLands[key] || 0) + 1;
    for (const c of key) {
        _hypGeoSources[c] = Math.max(0, (_hypGeoSources[c] || 0) - 1);
    }
    _selectedCustomColors = new Set();
    renderCustomLandsModal();
    renderHypGeoTable();
}

function openCustomLandsModal() {
    document.getElementById('custom-lands-modal').style.display = 'flex';
    renderCustomLandsModal();
}

function closeCustomLandsModal() {
    document.getElementById('custom-lands-modal').style.display = 'none';
}

function renderCustomLandsModal() {
    const body = document.getElementById('custom-lands-body');
    if (!body) return;

    const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

    // Effective sources = mono basics (steppers, post-decrement) + custom land contributions.
    const contribPerColor = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(_customLands))
        for (const c of key) contribPerColor[c] += cnt;
    const totalSources   = ['W', 'U', 'B', 'R', 'G']
        .reduce((s, c) => s + (_hypGeoSources[c] || 0) + contribPerColor[c], 0);

    const dualSlots      = Math.max(0, totalSources - _hypGeoLands);
    const specifiedDuals = Object.entries(_customLands)
        .filter(([k]) => k.length >= 2).reduce((s, [k, v]) => s + (k.length - 1) * v, 0);
    const unaccounted    = Math.max(0, dualSlots - specifiedDuals);
    // Over-accounted only when there IS a dual requirement and we've exceeded it.
    // When dualSlots = 0 (sources and lands in sync), there is no requirement to exceed.
    const isOverAccounted = dualSlots > 0 && specifiedDuals > dualSlots;
    const pct            = dualSlots > 0
        ? Math.min(100, Math.round(specifiedDuals / dualSlots * 100))
        : 100;

    const landList = Object.entries(_customLands).map(([key, count]) => {
        const dots = [...key].map(c =>
            `<span class="hypgeo-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorNames[c]}"></span>`
        ).join('');
        return `<div class="custom-land-item">
            <div class="hypgeo-pip-cell">${dots}</div>
            <div class="src-stepper">
                <button onclick="adjustCustomLand('${key}', -1)">−</button>
                <span>${count}</span>
                <button onclick="adjustCustomLand('${key}', +1)">+</button>
            </div>
        </div>`;
    }).join('');

    const toggles = ['W', 'U', 'B', 'R', 'G'].map(c => {
        const active = _selectedCustomColors.has(c);
        return `<button class="custom-land-toggle${active ? ' active' : ''}" data-clr="${c}"
            onclick="toggleCustomLandColor('${c}')"
            style="background:${_dotColor[c]};${_dotBorder[c] || ''}"
            title="${colorNames[c]}"></button>`;
    }).join('');

    const progressLabel = dualSlots === 0
        ? 'No multi-color lands needed'
        : `${specifiedDuals} / ${dualSlots} extra color source${dualSlots !== 1 ? 's' : ''} accounted for`;
    const progressBadge = isOverAccounted
        ? `<span class="cl-over-badge">Over-specified. Reduce multi-color lands or lower source counts.</span>`
        : (unaccounted === 0 ? `<span class="cl-exact-badge">Exact</span>` : '');

    body.innerHTML = `
        <div class="cl-progress">
            <div class="cl-progress-track">
                <div class="cl-progress-fill${isOverAccounted ? ' cl-progress-over' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="cl-progress-text">${progressLabel} ${progressBadge}</span>
        </div>
        ${landList
            ? `<div class="custom-lands-list">${landList}</div>`
            : `<p class="cl-empty">No custom lands added yet.</p>`}
        <div class="cl-add-row">
            <span class="cl-add-row-label">Add a land: select colors it taps for</span>
            <div class="cl-toggles">${toggles}</div>
            <button class="cl-add-btn" id="custom-land-add-btn"
                onclick="commitCustomLand()"
                ${_selectedCustomColors.size < 1 ? 'disabled' : ''}>Add Land</button>
        </div>
        <p class="cl-hint">Each color a land taps for beyond its first covers one extra source (dual: 1, tri-land: 2, 5-color: 4).</p>
    `;
}

function toggleHypGeoConverge() {
    _hypGeoConverge = !_hypGeoConverge;
    document.getElementById('hypgeo-converge-btn').classList.toggle('active', _hypGeoConverge);
    renderHypGeoTable();
}

// P(at least X distinct colors each have ≥1 source drawn in n cards from deck of N).
// Uses inclusion-exclusion over subsets of active colors. Assumes non-overlapping sources.
function convergeProb(N, colorSources, n, X) {
    const active = ['W', 'U', 'B', 'R', 'G'].filter(c => (colorSources[c] || 0) > 0);
    const m = active.length;
    if (X <= 0) return 1;
    if (X > m)  return 0;

    const src = active.map(c => colorSources[c]);

    function bits(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

    // P(all colors in bitmask are missed in n draws)
    function qMiss(mask) {
        let K = 0;
        for (let i = 0; i < m; i++) if (mask >> i & 1) K += src[i];
        if (N - K < n) return 0;
        let p = 1;
        for (let i = 0; i < n; i++) p *= (N - K - i) / (N - i);
        return p;
    }

    // P(exactly the colors in `covered` bitmask are covered, all others missed)
    function pExact(covered) {
        const notCov = ((1 << m) - 1) ^ covered;
        let sum = 0;
        for (let S = covered; ; S = (S - 1) & covered) {
            sum += (bits(S) % 2 === 0 ? 1 : -1) * qMiss(notCov | S);
            if (S === 0) break;
        }
        return sum;
    }

    let total = 0;
    for (let mask = 0; mask < (1 << m); mask++) {
        if (bits(mask) >= X) total += pExact(mask);
    }
    return Math.max(0, Math.min(1, total));
}

function renderHypGeoTable() {
    const sourcesPanel = document.getElementById('hypgeo-sources-panel');
    const headerRow    = document.getElementById('hypgeo-header-row');
    const tbody        = document.getElementById('hypgeo-tbody');
    if (!sourcesPanel || !headerRow || !tbody) return;

    const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

    // ── Sources panel (left) ──────────────────────────────────────────────────
    // With auto-decrement, _hypGeoSources holds mono-only counts.
    // Effective sources = mono + custom contributions, keeping dualSlots stable as lands are added.
    const _customContrib = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(_customLands))
        for (const c of key) _customContrib[c] += cnt;
    const _effectiveSrc = {};
    for (const c of ['W', 'U', 'B', 'R', 'G'])
        _effectiveSrc[c] = (_hypGeoSources[c] || 0) + _customContrib[c];

    const totalSources = ['W', 'U', 'B', 'R', 'G'].reduce((s, c) => s + _effectiveSrc[c], 0);
    const dualSlots    = Math.max(0, totalSources - _hypGeoLands);

    // Remaining unspecified dual slots drive the residual bias.
    // Only multi-color custom lands (2+ colors) fill dual slots; mono-color don't.
    const specifiedDuals  = Object.entries(_customLands)
        .filter(([k]) => k.length >= 2).reduce((s, [k, v]) => s + (k.length - 1) * v, 0);
    const remainingDuals  = Math.max(0, dualSlots - specifiedDuals);

    // If all color sources are fully specified (accountedFor >= totalSources), every land
    // is explicitly typed and multiHypGeoExact has no approximation left to make.
    const accountedFor    = Object.entries(_customLands).reduce((s, [k, v]) => s + k.length * v, 0);
    const isExact         = remainingDuals === 0 || accountedFor >= totalSources;

    let biasEstimate = 0;
    if (!isExact) {
        const active = ['W', 'U', 'B', 'R', 'G']
            .filter(c => _effectiveSrc[c] > 0)
            .sort((a, b) => _effectiveSrc[b] - _effectiveSrc[a]);
        if (active.length >= 2) {
            const K_A       = _effectiveSrc[active[0]];
            const K_B       = _effectiveSrc[active[1]];
            const n_hand    = _hypGeoGoingFirst ? 7 : 8;
            const poolModel = HYPGEO_DECK_SIZE - K_A - K_B + specifiedDuals;
            const poolCorr  = poolModel + remainingDuals;
            if (poolModel >= 0 && poolCorr <= HYPGEO_DECK_SIZE) {
                biasEstimate = (_binom(poolCorr, n_hand) - _binom(poolModel, n_hand))
                             / _binom(HYPGEO_DECK_SIZE, n_hand);
            }
        }
    }

    // ── Custom land rows interleaved into sources panel ───────────────────────
    // Group custom lands by their "primary" color (first char), with 5-pip at top.
    const customByGroup = {};
    for (const [key, cnt] of Object.entries(_customLands)) {
        const group = key.length === 5 ? 'WUBRG' : key[0];
        if (!customByGroup[group]) customByGroup[group] = [];
        customByGroup[group].push([key, cnt]);
    }
    // Within each group sort by pip count, then canonical key order (already WUBRG-sorted).
    for (const entries of Object.values(customByGroup)) {
        entries.sort(([a], [b]) => a.length !== b.length ? a.length - b.length : (a < b ? -1 : 1));
    }

    function customLandRowHtml(key, count) {
        const dots = [...key].map(c =>
            `<span class="hypgeo-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorNames[c]}"></span>`
        ).join('');
        return `<div class="src-row src-custom-land-row">
            <div class="hypgeo-pip-cell">${dots}</div>
            <div class="src-stepper">
                <button onclick="adjustCustomLand('${key}', -1)">−</button>
                <span>${count}</span>
                <button onclick="adjustCustomLand('${key}', +1)">+</button>
            </div>
        </div>`;
    }

    // ── Disclaimer + Add Lands button ─────────────────────────────────────────
    const disclaimerHtml = dualSlots > 0 ? (() => {
        const biasPct = Math.round(biasEstimate * 100);
        const label   = isExact
            ? `Multi-color lands<br><span class="src-disclaimer-sub">All extra sources covered · Exact</span>`
            : `Multi-color lands<br><span class="src-disclaimer-sub">~+${biasPct}% on multicolor pips</span>`;
        const tooltip = isExact
            ? 'All multi-color lands specified. Probabilities are exact.'
            : `${remainingDuals} of ${dualSlots} extra color sources unspecified. Add your multi-color lands for exact odds.`;
        return `<span class="src-dual-disclaimer" data-tooltip="${tooltip}">${label}</span>`;
    })() : '';

    sourcesPanel.innerHTML =
        `<div class="src-panel-label">Sources</div>` +
        (customByGroup['WUBRG'] || []).map(([k, v]) => customLandRowHtml(k, v)).join('') +
        ['W', 'U', 'B', 'R', 'G'].map(color => {
            const K        = _hypGeoSources[color] || 0;
            const dotStyle = `background:${_dotColor[color]};${_dotBorder[color] || ''}`;
            const colorRow = `<div class="src-row">
                <span class="hypgeo-pip-dot" style="${dotStyle}" title="${colorNames[color]}"></span>
                <div class="src-stepper">
                    <button onclick="adjustHypGeoSource('${color}', -1)">−</button>
                    <span>${K}</span>
                    <button onclick="adjustHypGeoSource('${color}', +1)">+</button>
                </div>
            </div>`;
            const subRows = (customByGroup[color] || []).map(([k, v]) => customLandRowHtml(k, v)).join('');
            return colorRow + subRows;
        }).join('') +
        `<div class="src-row src-row-lands">
            <span class="src-lands-label">Lands</span>
            <div class="src-stepper">
                <button onclick="adjustHypGeoLands(-1)">−</button>
                ${(() => {
                    if (isExact) return `<span>${_hypGeoLands}</span>`;
                    const diff = totalSources - _hypGeoLands;
                    const tip = `${diff} more source${diff !== 1 ? 's' : ''} than lands. Some lands must cover multiple colors. Add your multi-color lands for exact odds.`;
                    return `<span style="color:var(--warning);cursor:default;" title="${tip}">${_hypGeoLands}</span>`;
                })()}
                <button onclick="adjustHypGeoLands(+1)">+</button>
            </div>
        </div>` +
        disclaimerHtml +
        `<button class="src-add-lands-btn" onclick="openCustomLandsModal()">+ Add / Edit Lands</button>`;

    // ── Probability table (right) ─────────────────────────────────────────────
    const turnHeaders = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) =>
        `<th>T${i + 1}</th>`
    ).join('');

    const dashCell = `<td class="hypgeo-pct-zero">—</td>`;

    function pctCell(prob) {
        if (prob === 0) return dashCell;
        const pct = (prob * 100).toFixed(1);
        const cls = prob < 0.33 ? 'hypgeo-pct-low'
                  : prob < 0.66 ? 'hypgeo-pct-mid'
                  : prob < 0.80 ? ''
                  : 'hypgeo-pct-high';
        return `<td class="${cls}">${pct}%</td>`;
    }

    headerRow.innerHTML = `<th>Pips</th>${turnHeaders}`;

    const rows = [];

    if (_hypGeoConverge) {
        for (const X of [2, 3, 4, 5]) {
            // Sort by the first turn where the spell is castable (TX).
            const n_sort  = _hypGeoGoingFirst ? (6 + X) : (7 + X);
            const sortKey = convergeProb(HYPGEO_DECK_SIZE, _effectiveSrc, n_sort, X);
            const cells   = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) => {
                if ((i + 1) < X) return dashCell;
                const n = _hypGeoGoingFirst ? (6 + i + 1) : (7 + i + 1);
                return pctCell(convergeProb(HYPGEO_DECK_SIZE, _effectiveSrc, n, X));
            }).join('');
            rows.push({ sortKey, html: `<tr><td><span class="hypgeo-converge-label">C${X}</span></td>${cells}</tr>` });
        }
    }

    // One row per unique pip combination found in the draft.
    for (const { pips, maxGihWr } of _hypGeoPipRows) {
        const totalPips = Object.values(pips).reduce((s, v) => s + v, 0);
        // Sort by the first turn where the spell is castable (T<totalPips>).
        const n_sort  = _hypGeoGoingFirst ? (6 + totalPips) : (7 + totalPips);
        const sortKey = multiHypGeoExact(HYPGEO_DECK_SIZE, _effectiveSrc, n_sort, pips, _customLands, _hypGeoLands);
        const dots = ['W', 'U', 'B', 'R', 'G'].flatMap(c => {
            const cnt = pips[c] || 0;
            if (!cnt) return [];
            const dotStyle = `background:${_dotColor[c]};${_dotBorder[c] || ''}`;
            return Array.from({ length: cnt }, () =>
                `<span class="hypgeo-pip-dot" style="${dotStyle}" title="${colorNames[c]}"></span>`
            );
        }).join('');
        const cells = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) => {
            if ((i + 1) < totalPips) return dashCell;
            const n = _hypGeoGoingFirst ? (6 + i + 1) : (7 + i + 1);
            return pctCell(multiHypGeoExact(HYPGEO_DECK_SIZE, _effectiveSrc, n, pips, _customLands, _hypGeoLands));
        }).join('');
        rows.push({ sortKey, maxGihWr, html: `<tr><td><div class="hypgeo-pip-cell">${dots}</div></td>${cells}</tr>` });
    }

    // Non-zero rows: sort by T1 probability descending.
    // Zero rows: sort by max GIH WR descending (cards with no WR data fall to the bottom).
    const nonZero = rows.filter(r => r.sortKey > 0).sort((a, b) => b.sortKey - a.sortKey);
    const zero    = rows.filter(r => r.sortKey === 0).sort((a, b) => {
        const aw = a.maxGihWr ?? -Infinity;
        const bw = b.maxGihWr ?? -Infinity;
        return bw - aw;
    });
    tbody.innerHTML = [...nonZero, ...zero].map(r => r.html).join('');

    // Keep modal in sync if it's open while sources/lands change
    const modal = document.getElementById('custom-lands-modal');
    if (modal && modal.style.display !== 'none') renderCustomLandsModal();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    const logPath = await ipcRenderer.invoke('get-log-path');

    document.getElementById('log-path-input').value = settings.logPath || logPath;
    document.getElementById('mtga-db-path-input').value = settings.mtgaDbPath || '';
    document.getElementById('setting-minimize').checked = settings.minimizeToTray !== false;
    document.getElementById('setting-notifications').checked = settings.showNotifications !== false;

    await loadCardDbStatus();
    await updateCsvStatusUI();
}

async function loadCardDbStatus() {
    try {
        const status = await ipcRenderer.invoke('get-card-db-status');
        const statusEl = document.getElementById('card-db-status');
        const detailsEl = document.getElementById('card-db-details');
        const lastEl = document.getElementById('card-db-last-update');

        if (!status) { statusEl.textContent = 'Unable to check card database'; statusEl.style.color = 'var(--danger)'; return; }

        if (status.exists && (status.cardCount || 0) > 0) {
            statusEl.textContent = `✅ Card database ready (${status.cardCount.toLocaleString()} cards)`;
            statusEl.style.color = 'var(--success)';
            detailsEl.textContent = `Source: ${status.source || 'unknown'}`;
        } else if (status.exists) {
            statusEl.textContent = '⚠️ Card database is empty';
            statusEl.style.color = 'var(--warning)';
            detailsEl.textContent = 'Card names may not display correctly';
        } else {
            statusEl.textContent = '❌ Card database not found';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = 'Click "Update Now" to download card data';
        }

        lastEl.textContent = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : 'Never';
    } catch (e) {
        console.error('Error loading card database status:', e);
    }
}

async function updateCardDatabase() {
    const statusEl = document.getElementById('card-db-status');
    const detailsEl = document.getElementById('card-db-details');
    statusEl.textContent = '📥 Downloading card database...';
    statusEl.style.color = 'var(--primary)';
    detailsEl.textContent = 'This may take 30–60 seconds. Please wait…';

    try {
        const result = await ipcRenderer.invoke('update-card-db');
        if (result.success) {
            statusEl.textContent = result.updated
                ? `✅ Updated! (${result.cardCount?.toLocaleString() || '0'} cards)`
                : '✅ Already up to date';
            statusEl.style.color = 'var(--success)';
        } else {
            statusEl.textContent = '❌ Update failed';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = result.error || 'Unknown error';
        }
        setTimeout(loadCardDbStatus, 1000);
    } catch (error) {
        statusEl.textContent = '❌ Update failed';
        statusEl.style.color = 'var(--danger)';
        detailsEl.textContent = error.message;
    }
}

async function saveSettings() {
    const settings = {
        logPath: document.getElementById('log-path-input').value,
        mtgaDbPath: document.getElementById('mtga-db-path-input').value,
        minimizeToTray: document.getElementById('setting-minimize').checked,
        showNotifications: document.getElementById('setting-notifications').checked
    };
    await ipcRenderer.invoke('save-settings', settings);
    alert('Settings saved!');
}

async function browseLogPath() {
    alert('Please manually enter the log path in the text field.\n\nDefault: %USERPROFILE%\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log');
}

async function browseMtgaDb() {
    const filePath = await ipcRenderer.invoke('browse-mtga-db');
    if (filePath) document.getElementById('mtga-db-path-input').value = filePath;
}

async function runSetEnrichment() {
    const statusEl = document.getElementById('mtga-enrich-status');
    statusEl.textContent = 'Running import...';
    statusEl.style.color = 'var(--text-muted)';
    const result = await ipcRenderer.invoke('run-set-enrichment');
    if (result.success) {
        statusEl.textContent = result.enriched ? 'Import complete.' : 'Already up to date.';
        statusEl.style.color = 'var(--success)';
    } else {
        statusEl.textContent = `Import failed: ${result.error}`;
        statusEl.style.color = 'var(--danger)';
    }
}

async function scanLogNow() {
    const result = await ipcRenderer.invoke('refresh-log');
    if (result.success) {
        const draftMsg = result.draftsProcessed ? `\nStored ${result.draftsProcessed} draft${result.draftsProcessed !== 1 ? 's' : ''}` : '';
        alert(`Scan complete!\nProcessed ${result.matchesProcessed || 0} matches${draftMsg}\n\nCheck the Matches tab to see results.`);
        loadDashboard();
    } else {
        alert(`Error: ${result.error}`);
    }
}

async function testNotification() {
    const result = await ipcRenderer.invoke('test-notification');
    if (result.success) {
        alert('Test notification sent!' + (result.troubleshooting ? '\n\n' + result.troubleshooting : ''));
    } else {
        alert(`Notification failed: ${result.error}`);
    }
}

// ─── Inventory ────────────────────────────────────────────────────────────────
function renderInventory(inventory) {
    if (!inventory || !inventory.lastUpdated) {
        return '<div class="inventory-empty">No inventory data yet</div>';
    }
    const vaultPercent = Math.round((inventory.totalVaultProgress || 0) / 10);
    return `
        <div class="inventory-widget">
            <div class="inventory-section">
                <div class="inventory-item currency"><span class="label">💎 Gems</span><span class="value">${inventory.gems?.toLocaleString() || 0}</span></div>
                <div class="inventory-item currency"><span class="label">🪙 Gold</span><span class="value">${inventory.gold?.toLocaleString() || 0}</span></div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item wildcards">
                    <span class="label">🃏 Wildcards</span>
                    <span class="value">
                        <span title="Common" style="color:#fff;">${inventory.wildCardCommons || 0}</span> /
                        <span title="Uncommon" style="color:#c0c0c0;">${inventory.wildCardUnCommons || 0}</span> /
                        <span title="Rare" style="color:#ffd700;">${inventory.wildCardRares || 0}</span> /
                        <span title="Mythic" style="color:#ff4500;">${inventory.wildCardMythics || 0}</span>
                    </span>
                </div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item vault">
                    <span class="label">🏛️ Vault</span>
                    <span class="value">${vaultPercent}%</span>
                    <div class="progress-bar"><div class="fill" style="width:${vaultPercent}%"></div></div>
                </div>
                <div class="inventory-item packs" title="Pack count from last log update.">
                    <span class="label">📦 Packs</span>
                    <span class="value">${(inventory.boosters || []).reduce((s, b) => s + (b.Count || 0), 0)}</span>
                </div>
            </div>
        </div>`;
}

// ─── Matches ──────────────────────────────────────────────────────────────────
function renderMatchItem(match) {
    const date = new Date(match.timestamp).toLocaleDateString();
    const time = new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opp = match.opponentName ? ` • vs ${match.opponentName}` : '';
    const pipsHtml = renderMatchColorPips(match);
    return `
        <div class="match-item ${match.result}">
            <div class="match-badge ${match.result}">${match.result}</div>
            <div class="match-info">
                <h4>${match.format || 'Unknown Format'}</h4>
                <p>${match.gamesPlayed || 1} game${match.gamesPlayed !== 1 ? 's' : ''}${opp}</p>
            </div>
            ${pipsHtml}
            <div class="match-date">${date}<br>${time}</div>
            <button class="btn btn-secondary" onclick="deleteMatch('${match.id}')" style="padding:5px 10px;font-size:12px;">Delete</button>
        </div>`;
}

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    await ipcRenderer.invoke('delete-match', matchId);
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'matches') {
        // Re-fetch but keep active format/color filters
        _matchesAllMatches = await ipcRenderer.invoke('get-matches');
        renderMatchFormatCards();
        renderMatchList();
    }
}

async function exportData() {
    const path = await ipcRenderer.invoke('export-data');
    if (path) alert(`Data exported to: ${path}`);
}

async function importData() {
    const success = await ipcRenderer.invoke('import-data');
    if (success) { alert('Data imported successfully!'); loadDashboard(); }
    else alert('Failed to import data.');
}

async function clearAllData() {
    if (!confirm('WARNING: This will delete ALL your match data. This cannot be undone.\n\nAre you sure?')) return;
    if (!confirm('Are you absolutely sure? All your data will be permanently lost.')) return;
    await ipcRenderer.invoke('clear-data');
    alert('All data has been cleared.');
    loadDashboard();
}

// ─── Draft — 17Lands CSV ─────────────────────────────────────────────────────

/**
 * Open a file dialog to let the user pick a 17Lands CSV,
 * then tell main.js to load it into DraftAssistant.
 */
async function loadCsvFile() {
    const result = await ipcRenderer.invoke('load-17lands-csv');
    if (result.success) {
        csvLoaded = true;
        await updateCsvStatusUI();
        // Re-render draft page if it's visible so ratings appear immediately
        if (currentPage === 'draft') renderDraftPage();
    } else if (result.reason !== 'cancelled') {
        alert(`Failed to load CSV: ${result.reason}`);
    }
}

/**
 * Update the CSV status banner (draft page) and settings row.
 */
async function updateCsvStatusUI() {
    const status = await ipcRenderer.invoke('get-draft-assistant-status');
    csvLoaded = status.loaded;

    // Draft page banner
    const banner = document.getElementById('csv-status-banner');
    const iconEl = document.getElementById('csv-status-icon');
    const textEl = document.getElementById('csv-status-text');

    if (status.loaded) {
        banner.className = 'csv-status-banner loaded';
        iconEl.textContent = '✅';
        textEl.textContent = `${status.setName} (${status.cardCount.toLocaleString()} cards loaded)`;
    } else {
        banner.className = 'csv-status-banner not-loaded';
        iconEl.textContent = '⚠️';
        textEl.textContent = 'No 17Lands data loaded. Ratings unavailable.';
    }

    // Settings page row
    const settingsCsvEl = document.getElementById('settings-csv-status');
    if (settingsCsvEl) {
        if (status.loaded) {
            settingsCsvEl.textContent = `✅ ${status.setName} (${status.cardCount.toLocaleString()} cards)`;
            settingsCsvEl.style.color = 'var(--success)';
        } else {
            settingsCsvEl.textContent = 'No CSV loaded';
            settingsCsvEl.style.color = 'var(--text-muted)';
        }
    }
}

// ─── Draft — coord stepping ───────────────────────────────────────────────────
//
// Pure helpers that walk a sorted picks[] array (as delivered by the bundle).
// They return the same coord when there's nowhere to go (start, end, or coord
// not in the array) so the caller can render a silent no-op without branching.
//
// Precondition: `coord` is a non-null {pack, pick} object. The "not in array"
// no-op is intentionally indistinguishable from the boundary no-op — callers
// are responsible for ensuring the coord is valid before calling.

function prevCoord(picks, coord) {
    if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
    const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
    if (idx <= 0) return coord;
    const prev = picks[idx - 1];
    return { pack: prev.pack, pick: prev.pick };
}

function nextCoord(picks, coord) {
    if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
    const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
    if (idx === -1 || idx >= picks.length - 1) return coord;
    const next = picks[idx + 1];
    return { pack: next.pack, pick: next.pick };
}

// ─── Draft — rendering ────────────────────────────────────────────────────────
const MISSING_PICK_MSG = 'Pick missing from log (likely auto-pick during disconnect)';

function getViewingPick() {
    if (!bundle || !viewingCoord) return null;
    return bundle.picks.find(p =>
        p.pack === viewingCoord.pack && p.pick === viewingCoord.pick
    ) || null;
}

function ensureValidViewingCoord() {
    if (!bundle || !Array.isArray(bundle.picks) || bundle.picks.length === 0) {
        viewingCoord = null;
        return;
    }
    const exists = bundle.picks.some(p =>
        p.pack === viewingCoord?.pack && p.pick === viewingCoord?.pick
    );
    if (!exists) viewingCoord = bundle.liveCoord;
}

function renderDraftPage() {
    const activeEl  = document.getElementById('draft-active');
    const waitingEl = document.getElementById('draft-waiting');

    if (!bundle || !Array.isArray(bundle.picks) || bundle.picks.length === 0) {
        activeEl.style.display = 'none';
        waitingEl.style.display = 'block';
        return;
    }

    activeEl.style.display = 'block';
    waitingEl.style.display = 'none';

    ensureValidViewingCoord();
    syncDropdownSelection();

    const viewingPick = getViewingPick();
    if (!viewingPick) return;

    if (viewingPick.missing) {
        renderMissingPickPanel(viewingPick);
    } else {
        renderCurrentPack(viewingPick);
    }
    renderRemovedSection(viewingPick.removedCards || [], viewingPick.pick);
    renderPickHistory(bundle.picks, viewingCoord);
}

function wheelIndicatorHtml(ata, currentPick) {
    if (ata == null || !currentPick) return '';
    if (ata >= currentPick + 8) {
        return `<span class="wheel-icon" title="Likely to wheel (ATA ${ata.toFixed(1)})">↻</span>`;
    }
    if (currentPick > ata) {
        return `<span class="wheel-late" title="Past average taken at (${ata.toFixed(1)})">${ata.toFixed(1)}</span>`;
    }
    return '';
}

/**
 * Rebuild the dropdown option list from the current draftList. Only call
 * when draftList actually changes (new draft starts or at boot).
 */
function rebuildDraftDropdown() {
    const sel = document.getElementById('draft-select');
    if (!sel) return;
    if (!Array.isArray(draftList) || draftList.length === 0) {
        sel.innerHTML = '<option value="" disabled selected>No past drafts yet</option>';
        sel.disabled = true;
        return;
    }
    sel.disabled = false;
    sel.innerHTML = draftList.map(d => {
        const date = new Date(d.startedAt).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        return `<option value="${d.draftId}">${date} (${d.pickCount} picks)</option>`;
    }).join('');
    if (bundle?.draftId) sel.value = bundle.draftId;
}

/**
 * Sync the dropdown's selected value to the currently loaded bundle without
 * rebuilding the option list.
 */
function syncDropdownSelection() {
    const sel = document.getElementById('draft-select');
    if (!sel || !bundle?.draftId) return;
    if (sel.value !== bundle.draftId) sel.value = bundle.draftId;
}

async function onDraftSelectChange(draftId) {
    if (!draftId) return;
    _loadingDraftId = draftId;
    const newBundle = await ipcRenderer.invoke('view-draft-record', draftId);
    if (_loadingDraftId !== draftId) return;   // superseded by a later change
    if (!newBundle) {
        console.warn('[Draft] view-draft-record returned null for', draftId);
        return;
    }
    bundle = newBundle;
    viewingCoord = bundle.liveCoord;
    renderDraftPage();
}

/**
 * Render the placeholder shown in the pack panel when the viewing coord is
 * a missing-pick gap. Mirrors the My Picks missing-row styling so the user
 * knows they're not looking at empty data.
 */
function renderMissingPickPanel(pick) {
    document.getElementById('draft-pack-num').textContent  = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent  = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = '—';

    const listEl = document.getElementById('draft-card-list');
    listEl.innerHTML = `
        <div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-style:italic;">
            ⚠️ ${MISSING_PICK_MSG}
        </div>`;
}

/**
 * Render the current pack's ranked card list. `pick` is a bundle pick entry
 * (carries pack, pick, options[]). Each option may have .gihWr, .lowSample, .stats.
 */
function renderCurrentPack(pick) {
    document.getElementById('draft-pack-num').textContent   = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent   = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = `${pick.options.length} cards`;

    const listEl = document.getElementById('draft-card-list');
    if (!pick.options || pick.options.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No cards in pack</div>';
        return;
    }

    _currentPackOptions = pick.options;

    listEl.innerHTML = pick.options.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;
        const lowSample = card.lowSample;
        const stats = card.stats;

        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');

        const colorStr = stats?.color || '';
        const ata = stats?.ata ?? null;

        return `
            <div class="draft-card-row ${tierClass}" data-idx="${idx}" onclick="toggleCardDetail(${idx})">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${lowSample && gihWr !== null ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div class="wheel-indicator">${wheelIndicatorHtml(ata, pack.pick)}</div>
            </div>`;
    }).join('');
}

/**
 * Render the "Removed since pick N" greyed-out card list under the pack panel.
 * `currentPick` is the viewing coord's pick number.
 * Hidden when removedCards is empty.
 */
function renderRemovedSection(removedCards, currentPick) {
    const sectionEl = document.getElementById('draft-removed-section');
    const listEl    = document.getElementById('draft-removed-list');
    const headerEl  = document.getElementById('draft-removed-header');

    if (!removedCards || removedCards.length === 0) {
        sectionEl.style.display = 'none';
        return;
    }

    sectionEl.style.display = 'block';

    const priorPick = (typeof currentPick === 'number' && currentPick > 8)
        ? currentPick - 8
        : 1;
    headerEl.textContent = `Removed since pick ${priorPick}`;

    listEl.innerHTML = removedCards.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;
        const lowSample = card.lowSample;
        const stats = card.stats;
        const wrText = gihWr !== null && gihWr !== undefined ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');
        const colorStr = stats?.color || '';
        const ata = stats?.ata ?? null;

        return `
            <div class="draft-card-row removed ${tierClass}">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${lowSample && gihWr !== null && gihWr !== undefined ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div class="wheel-indicator">${ata !== null ? `<span class="wheel-ata" title="Avg taken at pick ${ata.toFixed(1)}">${ata.toFixed(1)}</span>` : ''}</div>
            </div>`;
    }).join('');
}

/**
 * Store raw picks and re-render with current sort/search state.
 */
function renderPickHistory(picks, _viewingCoord) {
    const completed = picks.filter(p => p.missing === true || p.picked !== null);
    document.getElementById('picks-count').textContent = completed.length;
    _picksData = completed;
    _renderFilteredPicks();
}

/**
 * Return a numeric section key for color-sort grouping.
 *
 * Encoding:
 *   Mono W/U/B/R/G   → 0–4          (WUBRG canonical order)
 *   2-color pairs     → 200–228
 *   3-color           → 300–328
 *   4-color           → 400–428
 *   5-color           → 500
 *   Colorless / land  → 9999
 *
 * Within each color-count tier the bitmask (W=16 U=8 B=4 R=2 G=1),
 * inverted, preserves the canonical MTG ordering of color combinations
 * (WU before UB before RG, etc.).  Crucially, identical color sets
 * always map to the same key, so they end up adjacent after sorting.
 */
function _picksColorSection(colorStr, manaCost) {
    const WUBRG  = ['W', 'U', 'B', 'R', 'G'];
    const weights = { W: 16, U: 8, B: 4, R: 2, G: 1 };
    const source = colorStr || manaCost || '';
    const colors = WUBRG.filter(c => source.includes(c));

    if (colors.length === 0) return 9999;
    if (colors.length === 1) return WUBRG.indexOf(colors[0]); // 0–4

    const bitmask = colors.reduce((acc, c) => acc + weights[c], 0);
    return colors.length * 100 + (31 - bitmask);
}

/** Update active sort button and re-render. */
function setPicksSort(field) {
    _picksSortField = field;
    document.querySelectorAll('.picks-sort-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`picks-sort-${field}`);
    if (btn) btn.classList.add('active');
    _renderFilteredPicks();
}

/** Update search filter and re-render. */
function setPicksSearch(query) {
    _picksSearchQuery = query;
    _renderFilteredPicks();
}

/** Apply current search + sort state and paint the picks list. */
function _renderFilteredPicks() {
    const listEl = document.getElementById('draft-picks-list');

    if (_picksData.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No picks yet</div>';
        return;
    }

    const q = _picksSearchQuery.trim().toLowerCase();
    let picks = q
        ? _picksData.filter(p => !p.missing && (p.pickedCard?.name || '').toLowerCase().includes(q))
        : [..._picksData];

    if (picks.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No matches</div>';
        return;
    }

    if (_picksSortField === 'gihWr') {
        picks.sort((a, b) => {
            if (a.missing) return 1;
            if (b.missing) return -1;
            const aw = a.pickedCard?.gihWr ?? null;
            const bw = b.pickedCard?.gihWr ?? null;
            if (aw === null && bw === null) return 0;
            if (aw === null) return 1;
            if (bw === null) return -1;
            return bw - aw;
        });
    } else if (_picksSortField === 'color') {
        picks.sort((a, b) => {
            if (a.missing) return 1;
            if (b.missing) return -1;
            const sectionDiff = _picksColorSection(a.pickedCard?.color, a.pickedCard?.manaCost)
                              - _picksColorSection(b.pickedCard?.color, b.pickedCard?.manaCost);
            if (sectionDiff !== 0) return sectionDiff;
            // Same section: GIH WR descending
            const aw = a.pickedCard?.gihWr ?? null;
            const bw = b.pickedCard?.gihWr ?? null;
            if (aw === null && bw === null) return 0;
            if (aw === null) return 1;
            if (bw === null) return -1;
            return bw - aw;
        });
    } else {
        // Pick order: most recent first (picks arrive chronologically)
        picks.reverse();
    }

    listEl.innerHTML = picks.map(pick => {
        const isViewing = !!viewingCoord
            && pick.pack === viewingCoord.pack
            && pick.pick === viewingCoord.pick;
        const isFuture = !isViewing && !!viewingCoord && (
            pick.pack > viewingCoord.pack ||
            (pick.pack === viewingCoord.pack && pick.pick > viewingCoord.pick)
        );
        const stateClass = isViewing ? 'viewing' : isFuture ? 'future' : '';

        if (pick.missing) {
            return `
                <div class="draft-pick-item missing ${stateClass}">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-colors"></div>
                    <div class="pick-name" title="${MISSING_PICK_MSG}">⚠️ ${MISSING_PICK_MSG}</div>
                    <div class="pick-wr">—</div>
                </div>`;
        }
        const card = pick.pickedCard;
        const name = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr = card?.gihWr ?? null;
        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');
        const colorStr = card?.color || '';

        return `
            <div class="draft-pick-item ${stateClass}">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-colors">${draftCardColorPips(colorStr, card?.manaCost || '')}</div>
                <div class="pick-name">
                    <span title="${name}">${name}</span>
                    ${cardEyeballHtml(card?.arena_id, card?.name, null)}
                </div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
}

// ─── Draft — card detail drawer ───────────────────────────────────────────────

async function toggleCardDetail(idx) {
    const card = _currentPackOptions[idx];
    if (!card) return;

    const rowEl = document.querySelector(`#draft-card-list [data-idx="${idx}"]`);
    if (!rowEl) return;

    // Close if already open for this card
    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('draft-card-detail')) {
        existing.remove();
        rowEl.classList.remove('detail-open');
        return;
    }

    // Close any other open drawer
    document.querySelectorAll('.draft-card-detail').forEach(el => el.remove());
    document.querySelectorAll('.draft-card-row.detail-open').forEach(el => el.classList.remove('detail-open'));

    rowEl.classList.add('detail-open');

    const personal = await ipcRenderer.invoke('get-card-stats-by-grpid', card.arena_id);

    const detail = document.createElement('div');
    detail.className = 'draft-card-detail';
    detail.innerHTML = renderCardDetailContent(card, personal);
    rowEl.insertAdjacentElement('afterend', detail);
}

function renderCardDetailContent(card, personal) {
    const fmt   = v => v !== null && v !== undefined ? `${(v * 100).toFixed(1)}%` : '—';
    const dStr  = d => d === null || d === undefined ? '—' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;
    const dCls  = d => d === null || d === undefined ? '' : d > 0.02 ? 'positive' : d < -0.02 ? 'negative' : '';
    const num   = v => v !== null && v !== undefined ? v.toLocaleString() : '—';
    const fixed = v => v !== null && v !== undefined ? v.toFixed(1) : '—';

    const stats = card.stats;

    return `
        <div class="detail-columns">
            <div class="detail-col">
                <div class="detail-section-label">17Lands Community</div>
                <div class="detail-row"><span>GIH WR</span><span class="detail-val">${fmt(card.gihWr)}</span></div>
                <div class="detail-row"><span>OH WR</span><span class="detail-val">${fmt(stats?.ohWr ?? null)}</span></div>
                <div class="detail-row"><span>Sample</span><span class="detail-val">${num(stats?.gihCount)}</span></div>
                <div class="detail-row"><span>ALSA</span><span class="detail-val">${fixed(stats?.alsa ?? null)}</span></div>
                <div class="detail-row"><span>ATA</span><span class="detail-val">${fixed(stats?.ata ?? null)}</span></div>
            </div>
            <div class="detail-col">
                <div class="detail-section-label">My Stats</div>
                <div class="detail-row"><span>GIH WR</span><span class="detail-val">${fmt(personal?.gihWrPersonal ?? null)}</span></div>
                <div class="detail-row"><span>OH WR</span><span class="detail-val">${fmt(personal?.ohWrPersonal ?? null)}</span></div>
                <div class="detail-row"><span>GIH count</span><span class="detail-val">${personal ? personal.gamesInHand : 0}</span></div>
                <div class="detail-row"><span>GP count</span><span class="detail-val">${personal ? personal.gamesInDeck : 0}</span></div>
                <div class="detail-row"><span>vs 17L Δ</span><span class="detail-val ${dCls(personal?.delta ?? null)}">${dStr(personal?.delta ?? null)}</span></div>
            </div>
        </div>`;
}

// ─── Draft — helpers ──────────────────────────────────────────────────────────

/**
 * Map a card tier string to a CSS class name.
 * Tiers are assigned relative to the loaded set's GIH WR distribution
 * by DraftAssistant.getCardTier() and arrive pre-computed on each card object.
 */
function gihWrTierClass(tier) {
    const map = {
        mythic: 'tier-mythic',
        gold:   'tier-gold',
        silver: 'tier-silver',
        black:  'tier-black',
        brown:  'tier-brown',
        none:   'tier-none',
    };
    return map[tier] ?? 'tier-none';
}

/**
 * Render a small colour indicator pip given a 17Lands color string (e.g. "WU", "R", "").
 * Legacy single-pip version — kept for module.exports compatibility.
 */
function colorPip(colorStr) {
    if (!colorStr) return `<span class="color-pip color-C" title="Colorless">◆</span>`;
    if (colorStr.length > 1) return `<span class="color-pip color-multi" title="${colorStr}">◆</span>`;
    const map = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };
    const key = map[colorStr] || 'C';
    return `<span class="color-pip color-${key}" title="${colorStr}">◆</span>`;
}

/**
 * Render individual colored dots for a draft card using the match-pip system.
 * colorStr comes from the 17Lands CSV (e.g. "WU"); falls back to parsing manaCost.
 */
function draftCardColorPips(colorStr, manaCost) {
    const WUBRG = ['W', 'U', 'B', 'R', 'G'];
    const source = colorStr || manaCost || '';
    const colors = WUBRG.filter(c => source.includes(c));

    if (colors.length === 0) {
        // Has a mana cost but no colored symbols → colorless (artifact / Eldrazi)
        if (manaCost) {
            return `<span class="match-pip-dot match-pip-colorless" title="Colorless">✦</span>`;
        }
        return ''; // Land or no data available
    }

    const dots = colors.map(c =>
        `<span class="match-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorLabel(c)}"></span>`
    ).join('');
    return `<span style="display:inline-flex;gap:3px;align-items:center;flex-shrink:0;">${dots}</span>`;
}

/**
 * Render a small rarity gem dot.
 */
function rarityGem(rarity) {
    if (!rarity) return '';
    return `<span class="rarity-gem rarity-${rarity}" title="${rarityLabel(rarity)}"></span>`;
}

function rarityLabel(r) {
    return { C: 'Common', U: 'Uncommon', R: 'Rare', M: 'Mythic Rare' }[r] || r;
}

function rarityColor(r) {
    return {
        C: 'var(--tier-black)',
        U: 'var(--tier-silver)',
        R: 'var(--tier-gold)',
        M: 'var(--tier-mythic)',
    }[r] || 'var(--text-muted)';
}

// ─── IPC event listeners ──────────────────────────────────────────────────────

ipcRenderer.on('match-started', (event, data) => {
    console.log('Match started:', data);
    updateStatus('Match in progress…');
});

ipcRenderer.on('match-ended', (event, data) => {
    console.log('Match ended:', data);
    updateStatus(`Match ended: ${data.result}`);
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'matches') loadMatches();
});

ipcRenderer.on('deck-submitted', (event, data) => {
    console.log('Deck submitted:', data);
});

ipcRenderer.on('inventory-updated', (event, data) => {
    if (currentPage === 'dashboard') {
        const el = document.getElementById('inventory-widget');
        if (el) el.innerHTML = renderInventory(data);
    }
});

ipcRenderer.on('card-stats-updated', async () => {
    // Refresh the whole card-stats panel so a brand-new draft format flips
    // us out of browse mode and into the personal-stats view automatically.
    if (currentPage === 'stats') {
        await loadStats();
    }
});

ipcRenderer.on('draft-update', (event, data) => {
    console.log('[Draft] Update received:', data);
    bundle = data;
    viewingCoord = bundle.liveCoord;

    // Refresh the dropdown — if this is a new draft, refetch the list so it
    // appears as an option; otherwise just re-sync the selection.
    if (!draftList.some(d => d.draftId === bundle?.draftId)) {
        ipcRenderer.invoke('list-drafts').then(list => {
            draftList = list;
            rebuildDraftDropdown();
        });
    } else {
        rebuildDraftDropdown();
    }

    // Flash the Draft nav item if user is on a different page
    const navDraft = document.getElementById('nav-draft');
    if (navDraft && currentPage !== 'draft') {
        let badge = navDraft.querySelector('.draft-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'draft-badge';
            navDraft.appendChild(badge);
        }
        const liveEntry = bundle?.picks?.find(p =>
            p.pack === bundle.liveCoord?.pack && p.pick === bundle.liveCoord?.pick
        );
        const count = liveEntry?.options?.length ?? 0;
        badge.textContent = `${count}`;
    }

    if (currentPage === 'draft') renderDraftPage();
});

// ─── Status bar ───────────────────────────────────────────────────────────────
function updateStatus(text) {
    document.getElementById('status-text').textContent = text;
}

// ─── Card image preview (hover-to-reveal Scryfall art) ───────────────────────
//
// The user wanted a way to glance at card art while learning a new set without
// leaving the tracker. Strategy: a small "eyeball" badge next to each card
// name; hovering it pops up a Scryfall image via the public arena_id endpoint.
// Lookups are cached for the lifetime of the page (Promise-cached so concurrent
// hovers don't double-fetch). Misses are cached as null so a card Scryfall
// hasn't indexed yet doesn't keep retrying.

const _cardImageCache = new Map(); // grpId (string) -> Promise<string|null>

/**
 * Pull the best image URL out of a Scryfall card JSON object. Handles
 * single-faced cards (`image_uris`) and double-faced cards which keep their
 * images on `card_faces[i].image_uris`. Prefers `large` to match what
 * 17lands serves and what the user expects when learning a set.
 * Returns null when Scryfall has the card but no usable image.
 */
function extractScryfallImageUrl(card) {
    if (!card || typeof card !== 'object') return null;
    const pick = imgs => imgs?.large || imgs?.normal || imgs?.small || null;
    const direct = pick(card.image_uris);
    if (direct) return direct;
    const face = Array.isArray(card.card_faces) ? card.card_faces[0] : null;
    return pick(face?.image_uris);
}

async function _scryfallFetch(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

/**
 * Find a card's image URL with three fallbacks, in order of reliability:
 *   1. /cards/arena/{grpId}      — direct, but Scryfall populates arena_id
 *                                   manually so brand-new sets often miss.
 *   2. /cards/named?exact=…&set= — pinpoints the exact printing when we
 *                                   know the set code.
 *   3. /cards/named?fuzzy=…      — last-ditch name match across all printings.
 * Result (URL or null) is cached by grpId for the page lifetime.
 */
function fetchCardImageUrl(grpId, name, setCode) {
    const key = String(grpId);
    if (_cardImageCache.has(key)) return _cardImageCache.get(key);

    const promise = (async () => {
        // 1: arena_id
        let card = await _scryfallFetch(`https://api.scryfall.com/cards/arena/${encodeURIComponent(key)}`);
        let url = extractScryfallImageUrl(card);
        if (url) return url;

        if (name) {
            // 2: exact name + set
            if (setCode) {
                const params = new URLSearchParams({ exact: name, set: setCode.toLowerCase() });
                card = await _scryfallFetch(`https://api.scryfall.com/cards/named?${params.toString()}`);
                url = extractScryfallImageUrl(card);
                if (url) return url;
            }
            // 3: fuzzy name across all printings
            const params = new URLSearchParams({ fuzzy: name });
            card = await _scryfallFetch(`https://api.scryfall.com/cards/named?${params.toString()}`);
            url = extractScryfallImageUrl(card);
            if (url) return url;
        }
        return null;
    })();

    _cardImageCache.set(key, promise);
    return promise;
}

/**
 * Returns inline HTML for the hover-trigger eyeball badge. Renders an SVG
 * eye and stamps the grpId, name, and (optional) set onto data attributes
 * so a single delegated handler can drive every badge in every table or
 * tile and also fall back to name-based Scryfall lookup when arena_id misses.
 */
function cardEyeballHtml(grpId, name, setCode) {
    if (grpId === undefined || grpId === null || grpId === '') return '';
    const dataName = name ? ` data-card-name="${encodeURIComponent(name)}"` : '';
    const dataSet  = setCode ? ` data-card-set="${setCode}"` : '';
    return `<span class="card-eyeball" data-grpid="${grpId}"${dataName}${dataSet} title="Hover to preview"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></span>`;
}

// Singleton preview element — built lazily so unit tests that don't touch the
// DOM never need to provide a body element.
let _previewEl = null;
function ensurePreviewEl() {
    if (_previewEl || typeof document === 'undefined' || !document.body) return _previewEl;
    _previewEl = document.createElement('div');
    _previewEl.id = 'card-image-preview';
    _previewEl.style.display = 'none';
    document.body.appendChild(_previewEl);
    return _previewEl;
}

function positionPreview(anchor) {
    if (!_previewEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const previewWidth = 260;   // matches CSS width
    const margin = 8;
    let left = rect.right + margin;
    if (left + previewWidth > window.innerWidth) {
        left = rect.left - previewWidth - margin;  // flip to the left side
    }
    if (left < margin) left = margin;
    let top = rect.top - 20;
    if (top < margin) top = margin;
    _previewEl.style.left = `${left}px`;
    _previewEl.style.top  = `${top}px`;
}

let _previewToken = 0;  // increments on every show; lets us drop stale fetch results
async function showCardPreview(anchor, grpId, name, setCode) {
    const el = ensurePreviewEl();
    if (!el) return;
    const myToken = ++_previewToken;
    el.innerHTML = '<div class="card-image-preview-loading">Loading…</div>';
    el.style.display = 'block';
    positionPreview(anchor);
    const url = await fetchCardImageUrl(grpId, name, setCode);
    if (myToken !== _previewToken) return; // user moved off before fetch resolved
    if (url) {
        el.innerHTML = `<img src="${url}" alt="card preview" />`;
    } else {
        el.innerHTML = '<div class="card-image-preview-empty">No Scryfall image.</div>';
    }
}

function hideCardPreview() {
    _previewToken++;
    if (_previewEl) _previewEl.style.display = 'none';
}

if (typeof document !== 'undefined') {
    // Delegated handlers — works for any .card-eyeball anywhere on the page,
    // including elements rendered by future re-renders.
    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest && e.target.closest('.card-eyeball');
        if (!target) return;
        const grpId = target.dataset.grpid;
        if (!grpId) return;
        const name = target.dataset.cardName ? decodeURIComponent(target.dataset.cardName) : null;
        const setCode = target.dataset.cardSet || null;
        showCardPreview(target, grpId, name, setCode);
    });
    document.addEventListener('mouseout', (e) => {
        const target = e.target.closest && e.target.closest('.card-eyeball');
        if (!target) return;
        // mouseout fires when leaving children too; only hide when leaving the badge itself
        if (e.relatedTarget && target.contains(e.relatedTarget)) return;
        hideCardPreview();
    });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await updateCsvStatusUI();
    loadDashboard();
    initDraftView();
});

/**
 * Populate the draft dropdown and, if no live draft has arrived yet,
 * auto-load the most recent past draft. The 'draft-update' handler may
 * race ahead and replace the bundle; that's the desired behavior — live
 * always wins.
 */
async function initDraftView() {
    try {
        draftList = await ipcRenderer.invoke('list-drafts');
    } catch (e) {
        console.warn('[Draft] list-drafts failed:', e);
        draftList = [];
    }
    rebuildDraftDropdown();
    if (!bundle && draftList.length > 0) {
        await onDraftSelectChange(draftList[0].draftId);
    } else if (bundle && currentPage === 'draft') {
        renderDraftPage();
    }
}

// ─── Draft — keyboard stepping ────────────────────────────────────────────────
//
// Single delegated keydown handler bound at module load. Only fires when the
// draft page is the active page and no input/textarea/select has focus, so
// dropdown keyboard navigation still works. Silent no-op at boundaries.

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (currentPage !== 'draft') return;
        if (!bundle || !viewingCoord) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();

        const target = e.key === 'ArrowLeft'
            ? prevCoord(bundle.picks, viewingCoord)
            : nextCoord(bundle.picks, viewingCoord);

        if (target.pack === viewingCoord.pack && target.pick === viewingCoord.pick) {
            return; // boundary — silent no-op
        }
        viewingCoord = target;
        renderDraftPage();
    });
}

// Export pure helpers for unit testing.
// Only active when running in Node.js (Jest); `window` is undefined there.
if (typeof window === 'undefined') {
    module.exports = {
        gihWrTierClass, colorPip, rarityGem, rarityLabel, rarityColor,
        extractScryfallImageUrl, cardEyeballHtml, _cardImageCache,
        prevCoord, nextCoord,
    };
}
