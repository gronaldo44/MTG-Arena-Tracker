/**
 * Renderer Process — UI Logic
 * Handles the interface and communication with main process.
 */

const { ipcRenderer } = require('electron');

// ─── State ────────────────────────────────────────────────────────────────────
let currentPage = 'dashboard';
let currentDraftState = null;   // latest DRAFT_UPDATE payload
let csvLoaded = false;          // whether 17Lands CSV is loaded in main process

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
    if (page === 'decks') loadDecks();
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
async function loadMatches() {
    const matches = await ipcRenderer.invoke('get-matches');
    const container = document.getElementById('all-matches');

    container.innerHTML = matches.length === 0
        ? `<div class="empty-state"><div class="icon">📝</div><p>No matches recorded yet.</p></div>`
        : `<div class="match-list">${matches.map(renderMatchItem).join('')}</div>`;
}

// ─── Decks ────────────────────────────────────────────────────────────────────
async function loadDecks() {
    const stats = await ipcRenderer.invoke('get-stats');
    const deckStats = stats.decks || {};
    const container = document.getElementById('decks-list');
    const decksWithMatches = Object.values(deckStats).filter(d => d.total > 0);

    if (decksWithMatches.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="icon">🎴</div><p>No decks recorded yet. Decks are automatically detected from your matches.</p></div>`;
        return;
    }

    container.innerHTML = `
        <div class="format-grid">
            ${decksWithMatches.sort((a, b) => b.total - a.total).map(deck => {
        const winRate = deck.total > 0 ? Math.round((deck.wins / deck.total) * 100) : 0;
        return `
                    <div class="format-card deck-card" onclick="showDeckDetails('${deck.id}')" style="cursor:pointer;">
                        <h4>
                            <span class="format-name">${deck.name}</span>
                            <span class="format-badge">${deck.total} matches</span>
                        </h4>
                        <div class="format-stats">
                            <div class="mini-stat"><span class="number">${deck.wins}</span><span class="label">Wins</span></div>
                            <div class="mini-stat"><span class="number">${deck.losses}</span><span class="label">Losses</span></div>
                            <div class="mini-stat"><span class="number" style="color:${winRate >= 50 ? 'var(--success)' : 'var(--danger)'}">${winRate}%</span><span class="label">Win Rate</span></div>
                        </div>
                        <div class="winrate-bar"><div class="fill" style="width:${winRate}%"></div></div>
                        <div style="margin-top:10px;text-align:center;font-size:12px;color:var(--text-muted);">Click to view deck list</div>
                    </div>`;
    }).join('')}
        </div>`;
}

// ─── Deck modal ───────────────────────────────────────────────────────────────
async function showDeckDetails(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) { alert('Deck not found'); return; }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width:800px;max-height:90vh;overflow-y:auto;">
            <div class="modal-header">
                <h2>${deck.name}</h2>
                <div style="display:flex;gap:10px;">
                    <button class="btn btn-primary" onclick="exportDeckToClipboard('${deckId}')">📋 Copy</button>
                    <button class="btn btn-secondary" onclick="closeDeckModal()">✕</button>
                </div>
            </div>
            <div class="modal-body">
                <div class="deck-info">
                    <p><strong>Format:</strong> ${deck.format || 'Unknown'}</p>
                    <p><strong>Last Used:</strong> ${new Date(deck.lastUsed).toLocaleDateString()}</p>
                </div>
                <div class="deck-lists">
                    <div class="deck-section">
                        <h3>Main Deck (${deck.mainDeck?.length || 0} cards)</h3>
                        <div class="card-list">${renderCardList(deck.mainDeck)}</div>
                    </div>
                    ${deck.sideboard?.length > 0 ? `<div class="deck-section"><h3>Sideboard (${deck.sideboard.length} cards)</h3><div class="card-list">${renderCardList(deck.sideboard)}</div></div>` : ''}
                    ${deck.commandZone?.length > 0 ? `<div class="deck-section"><h3>Command Zone (${deck.commandZone.length} cards)</h3><div class="card-list">${renderCardList(deck.commandZone)}</div></div>` : ''}
                </div>
            </div>
        </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeDeckModal(); });
}

function renderCardList(cards) {
    if (!cards || cards.length === 0) return '<p class="empty">No cards</p>';
    const cardCounts = {};
    cards.forEach(card => {
        const cardId = typeof card === 'number' ? card : card.cardId;
        const cardName = typeof card === 'object' && card.name ? card.name : `Card ${cardId}`;
        if (!cardCounts[cardId]) cardCounts[cardId] = { count: 0, name: cardName };
        cardCounts[cardId].count++;
    });
    return `<ul class="card-list-items">${Object.entries(cardCounts).map(([, d]) => `<li>${d.count}x ${d.name}</li>`).join('')}</ul>`;
}

function closeDeckModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

async function exportDeckToClipboard(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) { alert('Deck not found'); return; }

    let exportText = `About\nName ${deck.name}\n\n`;
    const formatCardList = async (cards) => {
        if (!cards || cards.length === 0) return '';
        const counts = {};
        for (const card of cards) {
            const cardId = typeof card === 'number' ? card : card.cardId;
            const cardName = await ipcRenderer.invoke('get-card-name', cardId);
            counts[cardName] = (counts[cardName] || 0) + 1;
        }
        return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `${c} ${n}`).join('\n');
    };

    if (deck.commandZone?.length > 0) exportText += `Commander\n${await formatCardList(deck.commandZone)}\n\n`;
    exportText += `Deck\n${await formatCardList(deck.mainDeck)}\n`;
    if (deck.sideboard?.length > 0) exportText += `\nSideboard\n${await formatCardList(deck.sideboard)}\n`;

    try {
        await navigator.clipboard.writeText(exportText);
    } catch {
        const ta = document.createElement('textarea');
        ta.value = exportText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }
    alert('Deck copied to clipboard!');
}

// ─── Stats ────────────────────────────────────────────────────────────────────
async function loadStats() {
    const stats = await ipcRenderer.invoke('get-stats');

    const formatTbody = document.getElementById('stats-formats-table').querySelector('tbody');
    const formats = stats.formats || {};
    formatTbody.innerHTML = Object.keys(formats).length === 0
        ? `<tr><td colspan="6" style="text-align:center;padding:30px;color:var(--text-muted);">No data available</td></tr>`
        : Object.entries(formats).sort((a, b) => b[1].total - a[1].total).map(([format, data]) => {
            const wr = data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0;
            return `<tr><td><strong>${format}</strong></td><td>${data.total}</td><td class="positive">${data.wins}</td><td class="negative">${data.losses}</td><td>${data.draws}</td><td class="${wr >= 50 ? 'positive' : 'negative'}">${wr}%</td></tr>`;
        }).join('');

    const deckTbody = document.getElementById('stats-decks-table').querySelector('tbody');
    const deckStats = stats.decks || {};
    const decksWithMatches = Object.values(deckStats).filter(d => d.total > 0);
    deckTbody.innerHTML = decksWithMatches.length === 0
        ? `<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted);">No deck data available</td></tr>`
        : decksWithMatches.sort((a, b) => b.total - a.total).map(deck => {
            const wr = deck.total > 0 ? Math.round((deck.wins / deck.total) * 100) : 0;
            return `<tr><td><strong>${deck.name}</strong></td><td>${deck.total}</td><td class="positive">${deck.wins}</td><td class="negative">${deck.losses}</td><td class="${wr >= 50 ? 'positive' : 'negative'}">${wr}%</td></tr>`;
        }).join('');
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
    return `
        <div class="match-item ${match.result}">
            <div class="match-badge ${match.result}">${match.result}</div>
            <div class="match-info">
                <h4>${match.deckName || 'Unknown Deck'}</h4>
                <p>${match.format || 'Unknown'} • ${match.gamesPlayed || 1} game${match.gamesPlayed !== 1 ? 's' : ''}${opp}</p>
            </div>
            <div class="match-date">${date}<br>${time}</div>
            <button class="btn btn-secondary" onclick="deleteMatch('${match.id}')" style="padding:5px 10px;font-size:12px;">Delete</button>
        </div>`;
}

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    await ipcRenderer.invoke('delete-match', matchId);
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'matches') loadMatches();
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

    listEl.innerHTML = pack.options.map((card, idx) => {
        const rank = idx + 1;
        const name = card.name || `Card ${card.arena_id}`;
        const gihWr = card.gihWr;          // null or 0.0–1.0
        const lowSample = card.lowSample;
        const stats = card.stats;

        const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(gihWr, lowSample);

        const colorStr = stats?.color || '';
        const rarityStr = stats?.rarity || '';

        return `
            <div class="draft-card-row">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${colorPip(colorStr)}
                    <span title="${name}">${name}</span>
                    ${rarityGem(rarityStr)}
                    ${lowSample && gihWr !== null ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                </div>
                <div class="gih-wr ${wrClass}">${wrText}</div>
                <div style="font-size:11px;color:var(--text-muted);text-align:right;">${rarityStr || ''}</div>
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
        const wrClass = gihWrTierClass(gihWr, false);

        return `
            <div class="draft-pick-item">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-name" title="${name}">${name}</div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
}

// ─── Draft — helpers ──────────────────────────────────────────────────────────

/**
 * Map a GIH WR value to a CSS class name for colour coding.
 * Thresholds based on 17Lands community conventions (~57% is average for most sets).
 */
function gihWrTierClass(gihWr, lowSample) {
    if (gihWr === null) return 'tier-none';
    if (lowSample) return 'tier-avg';   // de-emphasise uncertain data
    if (gihWr >= 0.63) return 'tier-great';
    if (gihWr >= 0.60) return 'tier-good';
    if (gihWr >= 0.57) return 'tier-avg';
    if (gihWr >= 0.54) return 'tier-below';
    return 'tier-bad';
}

/**
 * Render a small colour indicator pip given a 17Lands color string (e.g. "WU", "R", "").
 */
function colorPip(colorStr) {
    if (!colorStr) return `<span class="color-pip color-C" title="Colorless">◆</span>`;
    if (colorStr.length > 1) return `<span class="color-pip color-multi" title="${colorStr}">◆</span>`;
    const map = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };
    const key = map[colorStr] || 'C';
    return `<span class="color-pip color-${key}" title="${colorStr}">◆</span>`;
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

// ─── IPC event listeners ──────────────────────────────────────────────────────

ipcRenderer.on('match-started', (event, data) => {
    console.log('Match started:', data);
    updateStatus('Match in progress…');
});

ipcRenderer.on('match-ended', (event, data) => {
    console.log('Match ended:', data);
    updateStatus(`Match ended: ${data.result}`);
    if (currentPage === 'dashboard') loadDashboard();
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