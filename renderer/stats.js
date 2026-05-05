'use strict';

const { ipcRenderer } = require('electron');
const { isDraftLimited } = require('../sets');
const { cardEyeballHtml } = require('./shared');

// ─── Local state ──────────────────────────────────────────────────────────────

let _cardStatsData    = [];
let _cardStatsSortKey = 'gihWr17l';
let _cardStatsMode    = 'format';   // 'format' | 'set'
let _cardStatsSortDir = -1;         // -1 = desc, 1 = asc
let _cardStatsFormats = [];
let _cardStatsFormat  = null;

// ─── Stats page ───────────────────────────────────────────────────────────────

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

    if (_cardStatsMode === 'set' && previousMode !== 'set') {
        const minInput = document.getElementById('card-stats-min-gih');
        if (minInput) minInput.value = '0';
    }

    if (_cardStatsFormats.length === 1) {
        _cardStatsFormat = _cardStatsFormats[0];
    } else if (_cardStatsFormat && !_cardStatsFormats.includes(_cardStatsFormat)) {
        _cardStatsFormat = null;
    } else if (_cardStatsFormats.length > 0 && !_cardStatsFormat && _cardStatsMode === 'set') {
        _cardStatsFormat = _cardStatsFormats[0];
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
    document.querySelectorAll('#stats-cards-table th[data-sort-key]').forEach(th => {
        th.classList.toggle('sort-active-col', th.dataset.sortKey === _cardStatsSortKey);
    });

    const tbody = document.getElementById('stats-cards-tbody');
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    loadStats,
    renderCardStatsTable,
    renderCardStatsFormatSelector,
    selectCardStatsFormat,
    sortCardStats,
    deleteFormat,
    clearCardStats,
};
