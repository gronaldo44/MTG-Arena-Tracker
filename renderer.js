/**
 * Renderer Process — UI Logic
 * Handles the interface and communication with main process.
 */

const { ipcRenderer } = require('electron');
const { isDraftLimited } = require('./sets');

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentDraftState = null;   // latest DRAFT_UPDATE payload
let csvLoaded = false;          // whether 17Lands CSV is loaded in main process
let _currentPackOptions = [];   // cached options for detail drawer lookups

// ─── Navigation ───────────────────────────────────────────────────────────────
function showPage(page) {
    currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    // Match nav item by inner text content
    document.querySelectorAll('.nav-item').forEach(item => {
        if (item.textContent.trim().toLowerCase().includes(page)) {
            item.classList.add('active');
        }
    });

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');

    if (page === 'dashboard') loadDashboard();
    if (page === 'draft') renderDraftPage();
    if (page === 'matches') loadMatches();
    if (page === 'stats') loadStats();
    if (page === 'settings') loadSettings();
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

function getColorCombo(colors) {
    return ['W', 'U', 'B', 'R', 'G'].filter(c => (colors || []).includes(c)).join('');
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
        const isSplash = count > 0 && count <= 5;
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
        const combo = getColorCombo(m.deckColors);
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
        visible = visible.filter(m => _matchesSelectedCombos.has(getColorCombo(m.deckColors)));
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
let _cardStatsSortKey  = 'gamesInHand';
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

    // Personal card stats — load available formats, then data for selected format
    const allFormats = await ipcRenderer.invoke('get-card-stat-formats');
    _cardStatsFormats = allFormats.filter(isDraftLimited);

    // Auto-select when exactly one format exists; otherwise keep current selection
    if (_cardStatsFormats.length === 1) {
        _cardStatsFormat = _cardStatsFormats[0];
    } else if (_cardStatsFormat && !_cardStatsFormats.includes(_cardStatsFormat)) {
        _cardStatsFormat = null; // stale selection
    }

    _cardStatsData = _cardStatsFormat
        ? await ipcRenderer.invoke('get-card-game-stats', _cardStatsFormat)
        : [];

    renderCardStatsFormatSelector();
    renderCardStatsTable();
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

    if (_cardStatsFormats.length === 1) {
        // Single format — just show a label, no dropdown needed
        el.innerHTML = `<span style="font-size:13px;color:var(--text-muted);">Set: <strong style="color:var(--text);">${_cardStatsFormat}</strong></span>`;
        if (filterRow) filterRow.style.display = 'flex';
        return;
    }

    const opts = _cardStatsFormats
        .map(f => `<option value="${f}"${f === _cardStatsFormat ? ' selected' : ''}>${f}</option>`)
        .join('');

    el.innerHTML = `
        <label style="font-size:13px;color:var(--text-muted);">Set:
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
    _cardStatsData = _cardStatsFormat
        ? await ipcRenderer.invoke('get-card-game-stats', _cardStatsFormat)
        : [];

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
        tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text-muted);">
            No card stats yet for <strong>${_cardStatsFormat}</strong> — play some games to start tracking.</td></tr>`;
        return;
    }

    const fmt       = v => v !== null ? `${(v * 100).toFixed(1)}%` : '—';
    const deltaClass = d => d === null ? '' : d > 0 ? 'positive' : d < 0 ? 'negative' : '';
    const deltaStr   = d => d === null ? '—' : `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%`;

    tbody.innerHTML = rows.map(c => `
        <tr>
            <td><strong>${c.name}</strong></td>
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

// ─── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    const logPath = await ipcRenderer.invoke('get-log-path');

    document.getElementById('log-path-input').value = settings.logPath || logPath;
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
        minimizeToTray: document.getElementById('setting-minimize').checked,
        showNotifications: document.getElementById('setting-notifications').checked
    };
    await ipcRenderer.invoke('save-settings', settings);
    alert('Settings saved!');
}

async function browseLogPath() {
    alert('Please manually enter the log path in the text field.\n\nDefault: %USERPROFILE%\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log');
}

async function scanLogNow() {
    const result = await ipcRenderer.invoke('refresh-log');
    if (result.success) {
        alert(`Scan complete!\nFound ${result.eventsFound} events\nProcessed ${result.matchesProcessed || 0} matches\nRead ${result.bytesRead} bytes\n\nCheck the Matches tab to see results.`);
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
        textEl.textContent = `${status.setName} — ${status.cardCount.toLocaleString()} cards loaded`;
    } else {
        banner.className = 'csv-status-banner not-loaded';
        iconEl.textContent = '⚠️';
        textEl.textContent = 'No 17Lands data loaded — ratings unavailable';
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

// ─── Draft — rendering ────────────────────────────────────────────────────────

function renderDraftPage() {
    const activeEl = document.getElementById('draft-active');
    const waitingEl = document.getElementById('draft-waiting');

    if (!currentDraftState || !currentDraftState.currentPack) {
        activeEl.style.display = 'none';
        waitingEl.style.display = 'block';
        return;
    }

    activeEl.style.display = 'block';
    waitingEl.style.display = 'none';

    renderCurrentPack(currentDraftState.currentPack);
    renderPickHistory(currentDraftState.picks || []);
}

/**
 * Render the current pack's ranked card list.
 * Each card in options may carry .gihWr, .lowSample, .stats from main.js.
 */
function renderCurrentPack(pack) {
    document.getElementById('draft-pack-num').textContent = `Pack ${pack.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent = `Pick ${pack.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = `${pack.options.length} cards`;

    const listEl = document.getElementById('draft-card-list');
    if (!pack.options || pack.options.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No cards in pack</div>';
        return;
    }

    _currentPackOptions = pack.options;

    listEl.innerHTML = pack.options.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;
        const lowSample = card.lowSample;
        const stats = card.stats;

        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');

        const colorStr = stats?.color || '';
        const rarityStr = stats?.rarity || '';

        return `
            <div class="draft-card-row ${tierClass}" data-idx="${idx}" onclick="toggleCardDetail(${idx})">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${rarityGem(rarityStr)}
                    ${lowSample && gihWr !== null ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div style="font-size:11px;font-weight:600;color:${rarityColor(rarityStr)};text-align:right;">${rarityStr || ''}</div>
            </div>`;
    }).join('');
}

/**
 * Render the picks history sidebar.
 */
function renderPickHistory(picks) {
    document.getElementById('picks-count').textContent = picks.length;
    const listEl = document.getElementById('draft-picks-list');

    if (picks.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No picks yet</div>';
        return;
    }

    // Picks come in chronological order; display most recent first
    listEl.innerHTML = [...picks].reverse().map((pick, idx) => {
        const overallPick = picks.length - idx;
        const card = pick.picked;
        const name = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr = card?.gihWr ?? null;
        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');

        return `
            <div class="draft-pick-item">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-name" title="${name}">${name}</div>
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
    if (currentPage === 'stats') {
        const allFormats = await ipcRenderer.invoke('get-card-stat-formats');
        _cardStatsFormats = allFormats.filter(isDraftLimited);
        if (_cardStatsFormats.length === 1 && !_cardStatsFormat) {
            _cardStatsFormat = _cardStatsFormats[0];
        }
        _cardStatsData = _cardStatsFormat
            ? await ipcRenderer.invoke('get-card-game-stats', _cardStatsFormat)
            : [];
        renderCardStatsFormatSelector();
        renderCardStatsTable();
    }
});

/**
 * Main process sends this whenever a new pack arrives or a pick is made.
 * We store the latest state and re-render if the draft page is visible.
 */
ipcRenderer.on('draft-update', (event, data) => {
    console.log('[Draft] Update received:', data);
    currentDraftState = data;

    // Flash the Draft nav item if user is on a different page
    const navDraft = document.getElementById('nav-draft');
    if (navDraft && currentPage !== 'draft') {
        // Show/update a live badge
        let badge = navDraft.querySelector('.draft-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'draft-badge';
            navDraft.appendChild(badge);
        }
        const count = data.currentPack?.options?.length ?? 0;
        badge.textContent = `${count}`;
    }

    if (currentPage === 'draft') renderDraftPage();
});

// ─── Status bar ───────────────────────────────────────────────────────────────
function updateStatus(text) {
    document.getElementById('status-text').textContent = text;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await updateCsvStatusUI();
    loadDashboard();
});

// Export pure helpers for unit testing.
// Only active when running in Node.js (Jest); `window` is undefined there.
if (typeof window === 'undefined') {
    module.exports = { gihWrTierClass, colorPip, rarityGem, rarityLabel, rarityColor };
}