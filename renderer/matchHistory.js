'use strict';

const { ipcRenderer } = require('electron');
const {
    _dotColor, _dotBorder, SPLASH_THRESHOLD,
    colorLabel, isSplashColor, getColorCombo, comboDotsHtml,
    renderMatchColorPips, cardEyeballHtml, draftCardColorPips, gihWrTierClass,
    isDraftFormat, groupIntoDraftRuns, draftComboTrophyStats,
} = require('./shared');

// ─── Local state ──────────────────────────────────────────────────────────────

let _matchesAllMatches     = [];
let _matchesFormat         = null;
let _matchesSelectedCombos = new Set();

// ─── Draft pagination state ───────────────────────────────────────────────────

const DRAFT_PAGE_SIZE = 4;
let _draftRuns      = [];   // all runs for current filter, newest-first
let _draftTotals    = {};   // draftId → { wins, losses } across all matches
let _draftRunsShown = 0;    // how many runs are currently rendered

// ─── Deck view state ──────────────────────────────────────────────────────────

let _expandedMatchId   = null;
let _cardCache         = new Map();   // matchId → { deckCards, sbCards }
let _expandedMainCards = [];
let _expandedSbCards   = [];
let _deckSort          = 'manaCost';
let _deckSearch        = '';
let _sbSort            = 'gihWr';
let _sbSearch          = '';
let _sbTracked         = true;   // false when deck came from GRE (no sideboard)

// ─── Match item renderer ──────────────────────────────────────────────────────

function renderMatchItem(match) {
    const date     = new Date(match.timestamp).toLocaleDateString();
    const time     = new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opp      = match.opponentName ? `vs ${match.opponentName}` : '';
    const pipsHtml = renderMatchColorPips(match);
    return `
        <div class="match-item-wrap" data-match-id="${match.id}">
            <div class="match-item ${match.result} has-deck" onclick="toggleDeckView('${match.id}')">
                <div class="match-badge ${match.result}">${match.result}</div>
                <div class="match-info">
                    <h4>${match.format || 'Unknown Format'}</h4>
                    ${opp ? `<p>${opp}</p>` : ''}
                </div>
                ${pipsHtml}
                <div class="match-date">${date}<br>${time}</div>
                <button class="btn btn-secondary"
                    onclick="event.stopPropagation(); deleteMatch('${match.id}')"
                    style="padding:5px 10px;font-size:12px;">Delete</button>
            </div>
        </div>`;
}

// ─── Draft group helpers ──────────────────────────────────────────────────────

// Returns a CSS class for the draft group's tier border color.
// Tier mapping (wins in a single draft):
//   7   → red   (trophy)
//   5-6 → gold
//   4   → silver
//   1-3 → black
//   0   → silver
function draftTierClass(wins) {
    if (wins >= 7) return 'draft-tier-red';
    if (wins >= 5) return 'draft-tier-gold';
    if (wins === 4) return 'draft-tier-silver';
    if (wins >= 1) return 'draft-tier-black';
    return 'draft-tier-brown';
}

// ─── Match list ───────────────────────────────────────────────────────────────

async function loadMatches() {
    _matchesAllMatches = await ipcRenderer.invoke('get-matches');
    // Default to the most recently played format so the list always shows
    // something meaningful on first load. Users click a format card to switch.
    if (!_matchesFormat && _matchesAllMatches.length > 0) {
        _matchesFormat = _matchesAllMatches[0].format || 'Unknown';
    }
    renderMatchFormatCards();
    renderMatchList();
}

function renderMatchFormatCards() {
    const container = document.getElementById('matches-format-cards');
    if (!container) return;
    if (_matchesAllMatches.length === 0) { container.innerHTML = ''; return; }

    const fmtMap = {};
    for (const m of _matchesAllMatches) {
        const fmt   = m.format || 'Unknown';
        const combo = getColorCombo(m.deckColors, m.deckColorCounts);
        if (!fmtMap[fmt]) fmtMap[fmt] = { total: 0, wins: 0, losses: 0, combos: {}, matches: [] };
        fmtMap[fmt].total++;
        fmtMap[fmt].matches.push(m);
        if (m.result === 'win')  fmtMap[fmt].wins++;
        if (m.result === 'loss') fmtMap[fmt].losses++;
        if (combo) {
            if (!fmtMap[fmt].combos[combo]) fmtMap[fmt].combos[combo] = { total: 0, wins: 0, losses: 0 };
            fmtMap[fmt].combos[combo].total++;
            if (m.result === 'win')  fmtMap[fmt].combos[combo].wins++;
            if (m.result === 'loss') fmtMap[fmt].combos[combo].losses++;
        }
    }

    // Pre-compute draft run stats for draft formats
    const draftFmtStats = {};
    for (const [fmt, data] of Object.entries(fmtMap)) {
        if (!isDraftFormat(fmt)) continue;
        const runs        = groupIntoDraftRuns(data.matches);
        const trophies    = runs.filter(r => r.trophy).length;
        const comboStats  = draftComboTrophyStats(runs, getColorCombo);
        draftFmtStats[fmt] = { totalRuns: runs.length, trophies, comboStats };
    }

    const cardsHtml = Object.entries(fmtMap)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([fmt, data]) => {
            const contested = data.wins + data.losses;
            const wr        = contested > 0 ? Math.round(data.wins / contested * 100) : 0;
            const isActive  = fmt === _matchesFormat;
            const safeF     = fmt.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            const ds        = draftFmtStats[fmt];

            const countLine = ds
                ? `${data.total} match${data.total !== 1 ? 'es' : ''} · ${ds.totalRuns} draft${ds.totalRuns !== 1 ? 's' : ''}`
                : `${data.total} match${data.total !== 1 ? 'es' : ''}`;
            let trophyLine = '';
            if (ds) {
                const trophyPct = ds.totalRuns > 0
                    ? Math.round(ds.trophies / ds.totalRuns * 100) : 0;
                trophyLine = `Trophy ${trophyPct}% (${ds.trophies}/${ds.totalRuns})`;
            }

            const comboRows = Object.entries(data.combos)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([combo, cd]) => {
                    const cContested = cd.wins + cd.losses;
                    const cWr        = cContested > 0 ? Math.round(cd.wins / cContested * 100) : 0;
                    const rowActive  = isActive && _matchesSelectedCombos.has(combo);

                    let trophyHtml = '';
                    if (ds?.comboStats[combo]) {
                        const cs = ds.comboStats[combo];
                        trophyHtml = `<span class="mfc-combo-trophy">${cs.trophies}/${cs.runs} T</span>`;
                    }

                    return `<div class="mfc-combo-row${rowActive ? ' active' : ''}"
                        onclick="event.stopPropagation(); toggleMatchCombo('${safeF}','${combo}')">
                        <div class="mfc-combo-dots">${comboDotsHtml(combo)}</div>
                        <span class="mfc-combo-count">${cd.total} match${cd.total !== 1 ? 'es' : ''}</span>
                        <span class="mfc-combo-wr ${cWr >= 50 ? 'positive' : 'negative'}">${cWr}%</span>
                        ${trophyHtml}
                    </div>`;
                }).join('');

            return `<div class="matches-format-card${isActive ? ' active' : ''}" onclick="selectMatchFormat('${safeF}')">
                <div class="mfc-name" title="${fmt}">${fmt}</div>
                <div class="mfc-stats-row">
                    <div class="mfc-meta-lines">
                        <div class="mfc-meta">${countLine}</div>
                        ${trophyLine ? `<div class="mfc-meta">${trophyLine}</div>` : ''}
                    </div>
                    <span class="mfc-wr ${wr >= 50 ? 'positive' : 'negative'}">${wr}%</span>
                </div>
                ${comboRows ? `<div class="mfc-combo-list">${comboRows}</div>` : ''}
            </div>`;
        }).join('');

    container.innerHTML = `<div class="matches-format-cards-grid">${cardsHtml}</div>`;
}

function renderMatchList() {
    _expandedMatchId = null;
    const container = document.getElementById('all-matches');
    let visible = _matchesAllMatches;
    if (_matchesFormat) visible = visible.filter(m => m.format === _matchesFormat);
    if (_matchesSelectedCombos.size > 0) {
        visible = visible.filter(m => _matchesSelectedCombos.has(getColorCombo(m.deckColors, m.deckColorCounts)));
    }

    if (visible.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="icon">📝</div><p>${
            _matchesAllMatches.length === 0 ? 'No matches recorded yet.' : 'No matches for this filter.'
        }</p></div>`;
        return;
    }

    const state = require('./state');

    // Non-draft formats: show individual matches newest-first.
    if (!_matchesFormat || !isDraftFormat(_matchesFormat)) {
        const html = [...visible]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .map(m => renderMatchItem(m))
            .join('');
        container.innerHTML = `<div class="match-list">${html}</div>`;
        return;
    }

    // Draft format — paginated by DRAFT_PAGE_SIZE runs at a time.
    // For tagged runs, header totals come from ALL matches (not just the
    // combo-filtered visible set) so the record stays accurate when filtered.
    _draftTotals = {};
    for (const m of _matchesAllMatches) {
        if (!m.draftId) continue;
        if (!_draftTotals[m.draftId]) _draftTotals[m.draftId] = { wins: 0, losses: 0 };
        if (m.result === 'win')        _draftTotals[m.draftId].wins++;
        else if (m.result === 'loss')  _draftTotals[m.draftId].losses++;
    }

    const latestTs = run => Math.max(...run.matches.map(m => new Date(m.timestamp).getTime()));
    _draftRuns = groupIntoDraftRuns(visible);
    _draftRuns.sort((a, b) => latestTs(b) - latestTs(a));

    const firstBatch = _draftRuns.slice(0, DRAFT_PAGE_SIZE);
    _draftRunsShown  = firstBatch.length;

    const html = firstBatch.map(run => _renderDraftRunHtml(run, state)).join('');
    container.innerHTML = `<div class="match-list">${html}</div>${_loadMoreBtnHtml()}`;
}

function _renderDraftRunHtml(run, state) {
    const taggedDraftId = run.matches[0]?.draftId || null;
    const totals = taggedDraftId && _draftTotals[taggedDraftId]
        ? _draftTotals[taggedDraftId]
        : { wins: run.wins, losses: run.losses };

    const tier     = draftTierClass(totals.wins);
    const isActive = taggedDraftId
        ? taggedDraftId === state.liveDraftId && !state.liveDraftEnded
        : false;
    const label    = isActive
        ? `${totals.wins}-${totals.losses} Active`
        : totals.wins >= 7
            ? `${totals.wins}-${totals.losses} Trophy`
            : `${totals.wins}-${totals.losses}`;

    const matchItems = [...run.matches].reverse().map(m => renderMatchItem(m)).join('');
    return `<div class="draft-group ${tier}">
        <div class="draft-group-header">
            <span class="draft-group-record">${label}</span>
        </div>
        ${matchItems}
    </div>`;
}

function _loadMoreBtnHtml() {
    const remaining = _draftRuns.length - _draftRunsShown;
    if (remaining <= 0) return '';
    const count = Math.min(DRAFT_PAGE_SIZE, remaining);
    return `<div class="load-more-container">
        <button class="btn btn-secondary" onclick="loadMoreDraftRuns()">Load ${count} more draft${count !== 1 ? 's' : ''}</button>
    </div>`;
}

function loadMoreDraftRuns() {
    const state     = require('./state');
    const nextBatch = _draftRuns.slice(_draftRunsShown, _draftRunsShown + DRAFT_PAGE_SIZE);
    if (nextBatch.length === 0) return;
    _draftRunsShown += nextBatch.length;

    const matchList = document.querySelector('#all-matches .match-list');
    if (matchList) {
        matchList.insertAdjacentHTML('beforeend', nextBatch.map(r => _renderDraftRunHtml(r, state)).join(''));
    }

    document.querySelector('#all-matches .load-more-container')?.remove();
    const container = document.getElementById('all-matches');
    if (container) container.insertAdjacentHTML('beforeend', _loadMoreBtnHtml());
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

// ─── Deck view ────────────────────────────────────────────────────────────────

const _WUBRG = ['W', 'U', 'B', 'R', 'G'];

function _parseCmc(manaCost) {
    if (!manaCost) return 0;
    let cmc = 0;
    for (const t of (manaCost.match(/\{[^}]+\}/g) || [])) {
        const inner = t.slice(1, -1);
        if (/^\d+$/.test(inner)) cmc += parseInt(inner, 10);
        else if (inner !== 'X' && inner !== 'Y') cmc += 1;
    }
    return cmc;
}

function _deckColorKeys(manaCost) {
    const colors = _WUBRG.filter(c => (manaCost || '').includes(c));
    return colors.length > 0 ? colors : ['C'];
}

const _DV_COLOR_GROUPS = [
    { key: 'W', label: 'White',     textColor: '#f0e8d5' },
    { key: 'U', label: 'Blue',      textColor: '#5ba3e8' },
    { key: 'B', label: 'Black',     textColor: '#c4a8e8' },
    { key: 'R', label: 'Red',       textColor: '#ef5252' },
    { key: 'G', label: 'Green',     textColor: '#3dba74' },
    { key: 'C', label: 'Colorless', textColor: '#9ca3af' },
];

function _isLandCard(card) {
    return (card.type || '').toLowerCase().includes('land');
}

function _collapseBasicLands(cards) {
    const result = [];
    const landIndex = new Map();
    for (const card of cards) {
        if (card.type === 'Basic Land') {
            const key = card.name || card.arena_id;
            if (landIndex.has(key)) {
                result[landIndex.get(key)].count++;
            } else {
                landIndex.set(key, result.length);
                result.push({ ...card, count: 1 });
            }
        } else {
            result.push(card);
        }
    }
    return result;
}

function _deckCardRowHtml(card) {
    const name  = card.name || `Unknown (${card.arena_id})`;
    const pips  = draftCardColorPips(null, card.manaCost || '');
    const eye   = cardEyeballHtml(card.arena_id, card.name, null);
    const wrHtml = card.count != null
        ? `<div class="dv-card-wr">${card.count}</div>`
        : `<div class="dv-card-wr ${gihWrTierClass(card.tier || 'none')}">${card.gihWr != null ? `${(card.gihWr * 100).toFixed(1)}%` : '—'}</div>`;
    return `<div class="dv-card-row">
        <div class="dv-card-pips">${pips}</div>
        <div class="dv-card-name"><span title="${name}">${name}</span>${eye}</div>
        ${wrHtml}
    </div>`;
}

function _deckTableHtml(label, cards, headerStyle) {
    if (cards.length === 0) return '';
    const collapsed = _collapseBasicLands(cards);
    const total = collapsed.reduce((s, c) => s + (c.count ?? 1), 0);
    const styleAttr = headerStyle ? ` style="${headerStyle}"` : '';
    return `<div class="dv-table-group">
        <div class="dv-table-header"${styleAttr}>${label} <span class="dv-table-count">(${total})</span></div>
        <div class="dv-table-list">${collapsed.map(_deckCardRowHtml).join('')}</div>
    </div>`;
}

function _renderMainTablesHtml() {
    const q = _deckSearch.trim().toLowerCase();
    const allFiltered = q
        ? _expandedMainCards.filter(c => (c.name || '').toLowerCase().includes(q))
        : _expandedMainCards;

    const landCards    = allFiltered.filter(_isLandCard);
    const nonLandCards = allFiltered.filter(c => !_isLandCard(c));
    const landsTable   = _deckTableHtml('Lands', landCards);

    if (_deckSort === 'manaCost') {
        const cmcTables = [0, 1, 2, 3, 4, 5, 6].map(cmc => {
            const group = nonLandCards
                .filter(c => cmc === 6 ? _parseCmc(c.manaCost) >= 6 : _parseCmc(c.manaCost) === cmc)
                .sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1) || (a.name || '').localeCompare(b.name || ''));
            return _deckTableHtml(cmc === 6 ? 'Converted Mana Cost 6+' : `Converted Mana Cost ${cmc}`, group);
        }).join('');
        return cmcTables + landsTable;
    }

    if (_deckSort === 'gihWr') {
        const sorted = [...nonLandCards].sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
        return _deckTableHtml('Cards', sorted) + landsTable;
    }

    if (_deckSort === 'color') {
        const colorTables = _DV_COLOR_GROUPS.map(({ key, label, textColor }) => {
            const group = nonLandCards
                .filter(c => _deckColorKeys(c.manaCost).includes(key))
                .sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
            return _deckTableHtml(label, group, `color:${textColor}`);
        }).join('');
        return colorTables + landsTable;
    }

    return '';
}

function _renderSbListHtml() {
    const q = _sbSearch.trim().toLowerCase();
    const cards = q
        ? _expandedSbCards.filter(c => (c.name || '').toLowerCase().includes(q))
        : [..._expandedSbCards];

    if (_sbSort === 'gihWr') {
        cards.sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
    } else if (_sbSort === 'color') {
        const ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4, C: 5 };
        cards.sort((a, b) => {
            const ak = _deckColorKeys(a.manaCost)[0], bk = _deckColorKeys(b.manaCost)[0];
            return ((ORDER[ak] ?? 5) - (ORDER[bk] ?? 5)) || (b.gihWr ?? -1) - (a.gihWr ?? -1);
        });
    }

    if (cards.length === 0) {
        if (!_sbTracked) {
            return '<div class="dv-empty dv-empty-explain">Sideboard unavailable — historical matches only captured the main deck. Sideboard data is recorded for new matches going forward.</div>';
        }
        return '<div class="dv-empty">No cards match</div>';
    }
    return cards.map(_deckCardRowHtml).join('');
}

function _buildDeckPanelHtml() {
    const sbCount = _expandedSbCards.length;
    return `
        <div class="dv-main-area">
            <div class="dv-main-controls">
                <input class="dv-search" type="text" placeholder="Search deck..."
                    oninput="setDeckSearch(this.value)"
                    value="${_deckSearch.replace(/"/g, '&quot;')}">
                <div class="dv-sort-btns">
                    <button class="dv-sort-btn${_deckSort === 'manaCost' ? ' active' : ''}"
                        data-deck-sort="manaCost" onclick="setDeckSort('manaCost')">Mana Cost</button>
                    <button class="dv-sort-btn${_deckSort === 'gihWr' ? ' active' : ''}"
                        data-deck-sort="gihWr" onclick="setDeckSort('gihWr')">GIH WR</button>
                    <button class="dv-sort-btn${_deckSort === 'color' ? ' active' : ''}"
                        data-deck-sort="color" onclick="setDeckSort('color')">Color</button>
                </div>
            </div>
            <div class="dv-tables-row">${_renderMainTablesHtml()}</div>
        </div>
        <div class="dv-sb-area">
            <div class="dv-sb-header">Sideboard <span class="dv-table-count">(${sbCount})</span></div>
            <div class="dv-sb-controls">
                <input class="dv-search" type="text" placeholder="Search sideboard..."
                    oninput="setSbSearch(this.value)"
                    value="${_sbSearch.replace(/"/g, '&quot;')}">
                <div class="dv-sort-btns">
                    <button class="dv-sort-btn${_sbSort === 'gihWr' ? ' active' : ''}"
                        data-sb-sort="gihWr" onclick="setSbSort('gihWr')">GIH WR</button>
                    <button class="dv-sort-btn${_sbSort === 'color' ? ' active' : ''}"
                        data-sb-sort="color" onclick="setSbSort('color')">Color</button>
                </div>
            </div>
            <div class="dv-sb-list">${_renderSbListHtml()}</div>
        </div>`;
}

async function toggleDeckView(matchId) {
    const list = document.getElementById('all-matches');
    const qs   = sel => list?.querySelector(sel) ?? null;

    if (_expandedMatchId === matchId) {
        _expandedMatchId = null;
        qs(`.match-item-wrap[data-match-id="${matchId}"] .deck-view-panel`)?.remove();
        return;
    }

    if (_expandedMatchId) {
        qs(`.match-item-wrap[data-match-id="${_expandedMatchId}"] .deck-view-panel`)?.remove();
    }

    _expandedMatchId = matchId;
    const match = _matchesAllMatches.find(m => m.id === matchId);

    const wrap = qs(`.match-item-wrap[data-match-id="${matchId}"]`);
    if (!wrap) return;

    if (!match?.playerDeck?.deckCards?.length) {
        console.log('[toggleDeckView] no deck data — showing message panel');
        const panel = document.createElement('div');
        panel.className = 'deck-view-panel';
        panel.innerHTML = '<div class="dv-empty dv-empty-explain" style="flex:1;">No deck list recorded for this match.</div>';
        wrap.appendChild(panel);
        return;
    }

    if (!_cardCache.has(matchId)) {
        const [deckCards, sbCards] = await Promise.all([
            ipcRenderer.invoke('get-deck-card-details', match.playerDeck.deckCards || []),
            ipcRenderer.invoke('get-deck-card-details', match.playerDeck.sideboardCards || []),
        ]);
        _cardCache.set(matchId, { deckCards, sbCards });
    }

    const cached       = _cardCache.get(matchId);
    _expandedMainCards = cached.deckCards;
    _expandedSbCards   = cached.sbCards;
    _sbTracked         = !match.playerDeck?.greOnly;
    _deckSearch        = '';
    _sbSearch          = '';

    const panel = document.createElement('div');
    panel.className = 'deck-view-panel';
    panel.innerHTML = _buildDeckPanelHtml();
    wrap.appendChild(panel);
}

function setDeckSort(sort) {
    _deckSort = sort;
    const tablesRow = document.querySelector('.dv-tables-row');
    if (tablesRow) tablesRow.innerHTML = _renderMainTablesHtml();
    document.querySelectorAll('[data-deck-sort]').forEach(b => {
        b.classList.toggle('active', b.dataset.deckSort === _deckSort);
    });
}

function setDeckSearch(query) {
    _deckSearch = query;
    const tablesRow = document.querySelector('.dv-tables-row');
    if (tablesRow) tablesRow.innerHTML = _renderMainTablesHtml();
}

function setSbSort(sort) {
    _sbSort = sort;
    const sbList = document.querySelector('.dv-sb-list');
    if (sbList) sbList.innerHTML = _renderSbListHtml();
    document.querySelectorAll('[data-sb-sort]').forEach(b => {
        b.classList.toggle('active', b.dataset.sbSort === _sbSort);
    });
}

function setSbSearch(query) {
    _sbSearch = query;
    const sbList = document.querySelector('.dv-sb-list');
    if (sbList) sbList.innerHTML = _renderSbListHtml();
}

// ─── Data actions ─────────────────────────────────────────────────────────────

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    await ipcRenderer.invoke('delete-match', matchId);
    const state = require('./state');
    if (state.currentPage === 'dashboard') {
        require('./dashboard').loadDashboard();
    } else if (state.currentPage === 'matches') {
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
    if (success) { alert('Data imported successfully! Please restart the app to see all your data.'); require('./dashboard').loadDashboard(); }
    else alert('Failed to import data.');
}

async function clearAllData() {
    if (!confirm('WARNING: This will delete ALL your match data. This cannot be undone.\n\nAre you sure?')) return;
    if (!confirm('Are you absolutely sure? All your data will be permanently lost.')) return;
    await ipcRenderer.invoke('clear-data');
    alert('All data has been cleared.');
    require('./dashboard').loadDashboard();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    renderMatchItem,
    loadMatches,
    renderMatchFormatCards,
    renderMatchList,
    selectMatchFormat,
    toggleMatchCombo,
    deleteMatch,
    exportData,
    importData,
    clearAllData,
    toggleDeckView,
    setDeckSort,
    setDeckSearch,
    setSbSort,
    setSbSearch,
    loadMoreDraftRuns,
};
