/**
 * Renderer Process - UI Logic
 * Handles the interface and communication with main process
 */

const { ipcRenderer } = require('electron');

// State
let currentPage = 'dashboard';
let matches = [];
let decks = [];
let stats = {};

// Navigation
function showPage(page) {
    currentPage = page;

    // Update nav items
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
        if (item.textContent.toLowerCase().includes(page)) {
            item.classList.add('active');
        }
    });

    // Update pages
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
    });
    document.getElementById(`page-${page}`).classList.add('active');

    // Load data for page
    if (page === 'dashboard') loadDashboard();
    if (page === 'matches') loadMatches();
    if (page === 'decks') loadDecks();
    if (page === 'stats') loadStats();
    if (page === 'settings') loadSettings();
}

// Window controls
function minimizeWindow() {
    ipcRenderer.send('minimize-window');
}

function maximizeWindow() {
    ipcRenderer.send('maximize-window');
}

function closeWindow() {
    ipcRenderer.send('close-window');
}

function openExternalLink(url) {
    ipcRenderer.send('open-external', url);
}

// Load Dashboard
async function loadDashboard() {
    const stats = await ipcRenderer.invoke('get-stats');
    const inventory = await ipcRenderer.invoke('get-inventory');

    // Update summary cards
    document.getElementById('stat-total').textContent = stats.total || 0;
    document.getElementById('stat-wins').textContent = stats.wins || 0;
    document.getElementById('stat-losses').textContent = stats.losses || 0;
    document.getElementById('stat-winrate').textContent = `${stats.winRate || 0}%`;

    // Update inventory display
    const inventoryContainer = document.getElementById('inventory-widget');
    if (inventoryContainer) {
        inventoryContainer.innerHTML = renderInventory(inventory);
    }

    // Update format grid
    const formatContainer = document.getElementById('format-stats');
    const formats = stats.formats || {};

    if (Object.keys(formats).length === 0) {
        formatContainer.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="icon">🎮</div>
                <p>No matches recorded yet. Start playing MTG Arena!</p>
            </div>
        `;
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
                            <div class="mini-stat">
                                <span class="number">${data.wins}</span>
                                <span class="label">Wins</span>
                            </div>
                            <div class="mini-stat">
                                <span class="number">${data.losses}</span>
                                <span class="label">Losses</span>
                            </div>
                            <div class="mini-stat">
                                <span class="number">${winRate}%</span>
                                <span class="label">Win Rate</span>
                            </div>
                        </div>
                        <div class="winrate-bar">
                            <div class="fill" style="width: ${winRate}%"></div>
                        </div>
                    </div>
                `;
            }).join('');
    }

    // Update recent matches
    const recentContainer = document.getElementById('recent-matches');
    const matches = await ipcRenderer.invoke('get-matches');
    const recent = matches.slice(0, 10);

    if (recent.length === 0) {
        recentContainer.innerHTML = `
            <div class="empty-state">
                <div class="icon">📝</div>
                <p>No matches yet. Your matches will appear here automatically.</p>
            </div>
        `;
    } else {
        recentContainer.innerHTML = recent.map(match => renderMatchItem(match)).join('');
    }
}

// Load Matches
async function loadMatches() {
    const matches = await ipcRenderer.invoke('get-matches');
    const container = document.getElementById('all-matches');

    if (matches.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">📝</div>
                <p>No matches recorded yet.</p>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div class="match-list">
                ${matches.map(match => renderMatchItem(match)).join('')}
            </div>
        `;
    }
}

// Load Decks
async function loadDecks() {
    const stats = await ipcRenderer.invoke('get-stats');
    const deckStats = stats.decks || {};
    const container = document.getElementById('decks-list');

    const decksWithMatches = Object.values(deckStats).filter(d => d.total > 0);

    if (decksWithMatches.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="icon">🎴</div>
                <p>No decks recorded yet. Decks are automatically detected from your matches.</p>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div class="format-grid">
                ${decksWithMatches
                    .sort((a, b) => b.total - a.total)
                    .map(deck => {
                        const winRate = deck.total > 0 ? Math.round((deck.wins / deck.total) * 100) : 0;
                        return `
                            <div class="format-card deck-card" onclick="showDeckDetails('${deck.id}')" style="cursor: pointer;">
                                <h4>
                                    <span class="format-name">${deck.name}</span>
                                    <span class="format-badge">${deck.total} matches</span>
                                </h4>
                                <div class="format-stats">
                                    <div class="mini-stat">
                                        <span class="number">${deck.wins}</span>
                                        <span class="label">Wins</span>
                                    </div>
                                    <div class="mini-stat">
                                        <span class="number">${deck.losses}</span>
                                        <span class="label">Losses</span>
                                    </div>
                                    <div class="mini-stat">
                                        <span class="number" style="color: ${winRate >= 50 ? 'var(--success)' : 'var(--danger)'}">${winRate}%</span>
                                        <span class="label">Win Rate</span>
                                    </div>
                                </div>
                                <div class="winrate-bar">
                                    <div class="fill" style="width: ${winRate}%"></div>
                                </div>
                                <div style="margin-top: 10px; text-align: center; font-size: 12px; color: var(--text-muted);">
                                    Click to view deck list
                                </div>
                            </div>
                        `;
                    }).join('')}
            </div>
        `;
    }
}

// Show deck details modal
async function showDeckDetails(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 800px; max-height: 90vh; overflow-y: auto;">
            <div class="modal-header">
                <h2>${deck.name}</h2>
                <div style="display: flex; gap: 10px;">
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
                        <div class="card-list">
                            ${renderCardList(deck.mainDeck)}
                        </div>
                    </div>

                    ${deck.sideboard?.length > 0 ? `
                    <div class="deck-section">
                        <h3>Sideboard (${deck.sideboard.length} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.sideboard)}
                        </div>
                    </div>
                    ` : ''}

                    ${deck.commandZone?.length > 0 ? `
                    <div class="deck-section">
                        <h3>Command Zone (${deck.commandZone.length} cards)</h3>
                        <div class="card-list">
                            ${renderCardList(deck.commandZone)}
                        </div>
                    </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(modal);

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDeckModal();
    });
}

// Render card list with names
function renderCardList(cards) {
    if (!cards || cards.length === 0) {
        return '<p class="empty">No cards</p>';
    }

    // Count card quantities
    const cardCounts = {};
    cards.forEach(card => {
        const cardId = typeof card === 'number' ? card : card.cardId;
        const cardName = typeof card === 'object' && card.name ? card.name : `Card ${cardId}`;
        if (!cardCounts[cardId]) {
            cardCounts[cardId] = { count: 0, name: cardName };
        }
        cardCounts[cardId].count++;
    });

    return `
        <ul class="card-list-items">
            ${Object.entries(cardCounts).map(([cardId, data]) => {
                return `<li>${data.count}x ${data.name}</li>`;
            }).join('')}
        </ul>
    `;
}

// Close deck modal
function closeDeckModal() {
    const modal = document.querySelector('.modal-overlay');
    if (modal) modal.remove();
}

// Export deck to clipboard
async function exportDeckToClipboard(deckId) {
    const deck = await ipcRenderer.invoke('get-deck', deckId);
    if (!deck) {
        alert('Deck not found');
        return;
    }

    // Build export text
    let exportText = 'About\n';
    exportText += `Name ${deck.name}\n\n`;

    // Helper to format card list - get names via IPC
    const formatCardList = async (cards) => {
        if (!cards || cards.length === 0) return '';
        const counts = {};
        for (const card of cards) {
            const cardId = typeof card === 'number' ? card : card.cardId;
            const cardName = await ipcRenderer.invoke('get-card-name', cardId);
            counts[cardName] = (counts[cardName] || 0) + 1;
        }
        return Object.entries(counts)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([name, count]) => `${count} ${name}`)
            .join('\n');
    };

    // Add Commander section if present
    if (deck.commandZone?.length > 0) {
        exportText += 'Commander\n';
        exportText += await formatCardList(deck.commandZone) + '\n\n';
    }

    // Add main deck
    exportText += 'Deck\n';
    exportText += await formatCardList(deck.mainDeck) + '\n';

    // Add sideboard if present
    if (deck.sideboard?.length > 0) {
        exportText += '\nSideboard\n';
        exportText += await formatCardList(deck.sideboard) + '\n';
    }

    // Copy to clipboard
    try {
        await navigator.clipboard.writeText(exportText);
        alert('Deck copied to clipboard!');
    } catch (err) {
        // Fallback for older Electron versions
        const textArea = document.createElement('textarea');
        textArea.value = exportText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        alert('Deck copied to clipboard!');
    }
}

// Load Statistics
async function loadStats() {
    const stats = await ipcRenderer.invoke('get-stats');

    // Format table
    const formatTable = document.getElementById('stats-formats-table');
    const formatTbody = formatTable.querySelector('tbody');
    const formats = stats.formats || {};

    if (Object.keys(formats).length === 0) {
        formatTbody.innerHTML = `
            <tr><td colspan="6" style="text-align: center; padding: 30px; color: var(--text-muted);">No data available</td></tr>
        `;
    } else {
        formatTbody.innerHTML = Object.entries(formats)
            .sort((a, b) => b[1].total - a[1].total)
            .map(([format, data]) => {
                const winRate = data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0;
                return `
                    <tr>
                        <td><strong>${format}</strong></td>
                        <td>${data.total}</td>
                        <td class="positive">${data.wins}</td>
                        <td class="negative">${data.losses}</td>
                        <td>${data.draws}</td>
                        <td class="${winRate >= 50 ? 'positive' : 'negative'}">${winRate}%</td>
                    </tr>
                `;
            }).join('');
    }

    // Deck table
    const deckTable = document.getElementById('stats-decks-table');
    const deckTbody = deckTable.querySelector('tbody');
    const deckStats = stats.decks || {};
    const decksWithMatches = Object.values(deckStats).filter(d => d.total > 0);

    if (decksWithMatches.length === 0) {
        deckTbody.innerHTML = `
            <tr><td colspan="5" style="text-align: center; padding: 30px; color: var(--text-muted);">No deck data available</td></tr>
        `;
    } else {
        deckTbody.innerHTML = decksWithMatches
            .sort((a, b) => b.total - a.total)
            .map(deck => {
                const winRate = deck.total > 0 ? Math.round((deck.wins / deck.total) * 100) : 0;
                return `
                    <tr>
                        <td><strong>${deck.name}</strong></td>
                        <td>${deck.total}</td>
                        <td class="positive">${deck.wins}</td>
                        <td class="negative">${deck.losses}</td>
                        <td class="${winRate >= 50 ? 'positive' : 'negative'}">${winRate}%</td>
                    </tr>
                `;
            }).join('');
    }
}

// Load Settings
async function loadSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    const logPath = await ipcRenderer.invoke('get-log-path');

    document.getElementById('log-path-input').value = settings.logPath || logPath;
    document.getElementById('setting-minimize').checked = settings.minimizeToTray !== false;
    document.getElementById('setting-notifications').checked = settings.showNotifications !== false;

    // Load card database status
    await loadCardDbStatus();
}

// Load card database status
async function loadCardDbStatus() {
    try {
        const status = await ipcRenderer.invoke('get-card-db-status');
        const statusEl = document.getElementById('card-db-status');
        const detailsEl = document.getElementById('card-db-details');
        const lastUpdateEl = document.getElementById('card-db-last-update');

        if (!status) {
            statusEl.textContent = 'Unable to check card database';
            statusEl.style.color = 'var(--danger)';
            return;
        }

        if (status.exists) {
            const cardCount = status.cardCount || 0;
            if (cardCount > 0) {
                statusEl.textContent = `✅ Card database ready (${cardCount.toLocaleString()} cards)`;
                statusEl.style.color = 'var(--success)';
                detailsEl.textContent = `Source: ${status.source || 'unknown'}`;
            } else {
                statusEl.textContent = '⚠️ Card database is empty';
                statusEl.style.color = 'var(--warning)';
                detailsEl.textContent = 'Card names may not display correctly';
            }

            if (status.lastUpdated) {
                const date = new Date(status.lastUpdated);
                lastUpdateEl.textContent = date.toLocaleString();
            } else {
                lastUpdateEl.textContent = 'Unknown';
            }
        } else {
            statusEl.textContent = '❌ Card database not found';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = 'Click "Update Now" to download card data';
            lastUpdateEl.textContent = 'Never';
        }
    } catch (error) {
        console.error('Error loading card database status:', error);
        const statusEl = document.getElementById('card-db-status');
        if (statusEl) {
            statusEl.textContent = 'Error checking card database';
            statusEl.style.color = 'var(--danger)';
        }
    }
}

// Update card database
async function updateCardDatabase() {
    const statusEl = document.getElementById('card-db-status');
    const detailsEl = document.getElementById('card-db-details');

    statusEl.textContent = '📥 Downloading card database...';
    statusEl.style.color = 'var(--primary)';
    detailsEl.textContent = 'This may take 30-60 seconds. Please wait...';

    try {
        const result = await ipcRenderer.invoke('update-card-db');

        if (result.success) {
            if (result.updated) {
                statusEl.textContent = `✅ Updated! (${result.cardCount?.toLocaleString() || '0'} cards)`;
                statusEl.style.color = 'var(--success)';
            } else {
                statusEl.textContent = '✅ Already up to date';
                statusEl.style.color = 'var(--success)';
            }

            // Refresh the status display
            setTimeout(loadCardDbStatus, 1000);
        } else {
            statusEl.textContent = '❌ Update failed';
            statusEl.style.color = 'var(--danger)';
            detailsEl.textContent = result.error || 'Unknown error';
        }
    } catch (error) {
        statusEl.textContent = '❌ Update failed';
        statusEl.style.color = 'var(--danger)';
        detailsEl.textContent = error.message;
    }
}

// Render inventory widget
function renderInventory(inventory) {
    if (!inventory || !inventory.lastUpdated) {
        return '<div class="inventory-empty">No inventory data yet</div>';
    }

    const vaultPercent = Math.round((inventory.totalVaultProgress || 0) / 10);

    return `
        <div class="inventory-widget">
            <div class="inventory-section">
                <div class="inventory-item currency">
                    <span class="label">💎 Gems</span>
                    <span class="value">${inventory.gems?.toLocaleString() || 0}</span>
                </div>
                <div class="inventory-item currency">
                    <span class="label">🪙 Gold</span>
                    <span class="value">${inventory.gold?.toLocaleString() || 0}</span>
                </div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item wildcards">
                    <span class="label">🃏 Wildcards</span>
                    <span class="value">
                        <span class="wc-common" title="Common" style="color: #ffffff; text-shadow: 0 0 2px #000;">${inventory.wildCardCommons || 0}</span> /
                        <span class="wc-uncommon" title="Uncommon" style="color: #c0c0c0;">${inventory.wildCardUnCommons || 0}</span> /
                        <span class="wc-rare" title="Rare" style="color: #ffd700; text-shadow: 0 0 2px #000;">${inventory.wildCardRares || 0}</span> /
                        <span class="wc-mythic" title="Mythic" style="color: #ff4500;">${inventory.wildCardMythics || 0}</span>
                    </span>
                </div>
            </div>
            <div class="inventory-section">
                <div class="inventory-item vault">
                    <span class="label">📦 Vault</span>
                    <span class="value">${vaultPercent}%</span>
                    <div class="progress-bar">
                        <div class="fill" style="width: ${vaultPercent}%"></div>
                    </div>
                </div>
                <div class="inventory-item packs" title="Pack count from last log update. Restart MTG Arena to refresh.">
                    <span class="label">📦 Packs</span>
                    <span class="value">${(inventory.boosters || []).reduce((sum, b) => sum + (b.Count || 0), 0)}</span>
                </div>
            </div>
        </div>
    `;
}

// Render a match item
function renderMatchItem(match) {
    const date = new Date(match.timestamp).toLocaleDateString();
    const time = new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opponentText = match.opponentName ? `vs ${match.opponentName}` : '';

    return `
        <div class="match-item ${match.result}">
            <div class="match-badge ${match.result}">${match.result}</div>
            <div class="match-info">
                <h4>${match.deckName || 'Unknown Deck'}</h4>
                <p>${match.format || 'Unknown'} • ${match.gamesPlayed || 1} game${match.gamesPlayed !== 1 ? 's' : ''}${opponentText ? ' • ' + opponentText : ''}</p>
            </div>
            <div class="match-date">${date}<br>${time}</div>
            <button class="btn btn-secondary" onclick="deleteMatch('${match.id}')" style="padding: 5px 10px; font-size: 12px;">Delete</button>
        </div>
    `;
}

// Actions
async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;

    await ipcRenderer.invoke('delete-match', matchId);

    // Refresh current page
    if (currentPage === 'dashboard') loadDashboard();
    if (currentPage === 'matches') loadMatches();
}

async function exportData() {
    const path = await ipcRenderer.invoke('export-data');
    if (path) {
        alert(`Data exported to: ${path}`);
    }
}

async function importData() {
    const success = await ipcRenderer.invoke('import-data');
    if (success) {
        alert('Data imported successfully!');
        loadDashboard();
    } else {
        alert('Failed to import data.');
    }
}

async function clearAllData() {
    if (!confirm('WARNING: This will delete ALL your match data. This cannot be undone.\n\nAre you sure?')) return;
    if (!confirm('Are you absolutely sure? All your data will be permanently lost.')) return;

    await ipcRenderer.invoke('clear-data');
    alert('All data has been cleared.');
    loadDashboard();
}

async function browseLogPath() {
    // This would open a file dialog - simplified for now
    alert('Please manually enter the log path in the text field.\n\nDefault: %USERPROFILE%\\AppData\\LocalLow\\Wizards Of The Coast\\MTGA\\Player.log');
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

async function scanLogNow() {
    const result = await ipcRenderer.invoke('refresh-log');
    if (result.success) {
        alert(`Scan complete!\nFound ${result.eventsFound} events\nProcessed ${result.matchesProcessed || 0} matches\nRead ${result.bytesRead} bytes\n\nCheck the Matches tab to see results.`);
        // Refresh the dashboard
        loadDashboard();
    } else {
        alert(`Error: ${result.error}`);
    }
}

async function testNotification() {
    const result = await ipcRenderer.invoke('test-notification');
    if (result.success) {
        let message = 'Test notification sent!';
        if (result.troubleshooting) {
            message += '\n\n' + result.troubleshooting;
        }
        alert(message);
    } else {
        alert(`Notification failed: ${result.error}`);
    }
}

// Status updates
function updateStatus(text) {
    document.getElementById('status-text').textContent = text;
}

// Listen for events from main process
ipcRenderer.on('match-started', (event, data) => {
    console.log('Match started:', data);
    updateStatus('Match in progress...');
});

ipcRenderer.on('match-ended', (event, data) => {
    console.log('Match ended:', data);
    updateStatus(`Match ended: ${data.result}`);

    // Refresh dashboard if on it
    if (currentPage === 'dashboard') {
        loadDashboard();
    }
});

ipcRenderer.on('deck-submitted', (event, data) => {
    console.log('Deck submitted:', data);
});

// Listen for inventory updates
ipcRenderer.on('inventory-updated', (event, data) => {
    console.log('[Renderer] Inventory updated:', data);
    // Refresh inventory widget if on dashboard
    if (currentPage === 'dashboard') {
        const inventoryContainer = document.getElementById('inventory-widget');
        if (inventoryContainer) {
            inventoryContainer.innerHTML = renderInventory(data);
        }
    }
});

// Initial load
document.addEventListener('DOMContentLoaded', () => {
    loadDashboard();
});
