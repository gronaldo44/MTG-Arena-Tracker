'use strict';

const { ipcRenderer } = require('electron');

// ─── Inventory widget ─────────────────────────────────────────────────────────

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

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
    const stats     = await ipcRenderer.invoke('get-stats');
    const inventory = await ipcRenderer.invoke('get-inventory');

    document.getElementById('stat-total').textContent   = stats.total || 0;
    document.getElementById('stat-wins').textContent    = stats.wins || 0;
    document.getElementById('stat-losses').textContent  = stats.losses || 0;
    document.getElementById('stat-winrate').textContent = `${stats.winRate || 0}%`;

    const inventoryContainer = document.getElementById('inventory-widget');
    if (inventoryContainer) inventoryContainer.innerHTML = renderInventory(inventory);

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
    const { renderMatchItem } = require('./matchHistory');

    recentContainer.innerHTML = matches.slice(0, 10).length === 0
        ? `<div class="empty-state"><div class="icon">📝</div><p>No matches yet. Your matches will appear here automatically.</p></div>`
        : matches.slice(0, 10).map(renderMatchItem).join('');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { loadDashboard, renderInventory };
