'use strict';

const { ipcRenderer } = require('electron');
const {
    _dotColor, _dotBorder, SPLASH_THRESHOLD,
    colorLabel, isSplashColor, getColorCombo, comboDotsHtml,
    renderMatchColorPips, cardEyeballHtml,
} = require('./shared');

// ─── Local state ──────────────────────────────────────────────────────────────

let _matchesAllMatches     = [];
let _matchesFormat         = null;
let _matchesSelectedCombos = new Set();

// ─── Match item renderer ──────────────────────────────────────────────────────

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

// ─── Match list ───────────────────────────────────────────────────────────────

async function loadMatches() {
    _matchesAllMatches = await ipcRenderer.invoke('get-matches');
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
    if (success) { alert('Data imported successfully!'); require('./dashboard').loadDashboard(); }
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
};
