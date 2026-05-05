'use strict';

const { ipcRenderer } = require('electron');

// ─── Settings page ────────────────────────────────────────────────────────────

async function loadSettings() {
    const settings = await ipcRenderer.invoke('get-settings');
    const logPath  = await ipcRenderer.invoke('get-log-path');

    document.getElementById('log-path-input').value         = settings.logPath || logPath;
    document.getElementById('mtga-db-path-input').value     = settings.mtgaDbPath || '';
    document.getElementById('setting-minimize').checked     = settings.minimizeToTray !== false;
    document.getElementById('setting-notifications').checked = settings.showNotifications !== false;

    await loadCardDbStatus();
    await require('./draftAssistant').updateCsvStatusUI();
}

async function loadCardDbStatus() {
    try {
        const status    = await ipcRenderer.invoke('get-card-db-status');
        const statusEl  = document.getElementById('card-db-status');
        const detailsEl = document.getElementById('card-db-details');
        const lastEl    = document.getElementById('card-db-last-update');

        if (!status) {
            statusEl.textContent = 'Unable to check card database';
            statusEl.style.color = 'var(--danger)';
            return;
        }

        if (status.exists && (status.cardCount || 0) > 0) {
            statusEl.textContent = `✅ Card database ready (${status.cardCount.toLocaleString()} cards)`;
            statusEl.style.color = 'var(--success)';
            detailsEl.textContent = `Source: ${status.source || 'unknown'}`;
        } else if (status.exists) {
            statusEl.textContent  = '⚠️ Card database is empty';
            statusEl.style.color  = 'var(--warning)';
            detailsEl.textContent = 'Card names may not display correctly';
        } else {
            statusEl.textContent  = '❌ Card database not found';
            statusEl.style.color  = 'var(--danger)';
            detailsEl.textContent = 'Click "Update Now" to download card data';
        }

        lastEl.textContent = status.lastUpdated ? new Date(status.lastUpdated).toLocaleString() : 'Never';
    } catch (e) {
        console.error('Error loading card database status:', e);
    }
}

async function updateCardDatabase() {
    const statusEl  = document.getElementById('card-db-status');
    const detailsEl = document.getElementById('card-db-details');
    statusEl.textContent  = '📥 Downloading card database...';
    statusEl.style.color  = 'var(--primary)';
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
        statusEl.textContent  = '❌ Update failed';
        statusEl.style.color  = 'var(--danger)';
        detailsEl.textContent = error.message;
    }
}

async function saveSettings() {
    const settings = {
        logPath:           document.getElementById('log-path-input').value,
        mtgaDbPath:        document.getElementById('mtga-db-path-input').value,
        minimizeToTray:    document.getElementById('setting-minimize').checked,
        showNotifications: document.getElementById('setting-notifications').checked,
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
        const draftMsg = result.draftsProcessed
            ? `\nStored ${result.draftsProcessed} draft${result.draftsProcessed !== 1 ? 's' : ''}`
            : '';
        alert(`Scan complete!\nProcessed ${result.matchesProcessed || 0} matches${draftMsg}\n\nCheck the Matches tab to see results.`);
        require('./dashboard').loadDashboard();
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

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    loadSettings,
    loadCardDbStatus,
    updateCardDatabase,
    saveSettings,
    browseLogPath,
    browseMtgaDb,
    runSetEnrichment,
    scanLogNow,
    testNotification,
};
