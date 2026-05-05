/**
 * Renderer Process — thin coordinator
 *
 * Owns: navigation, window controls, IPC event listeners, keyboard handler,
 * DOMContentLoaded init. All panel logic lives in renderer/*.
 */

const { ipcRenderer } = require('electron');
const { isDraftLimited } = require('./sets');

const state       = require('./renderer/state');
const shared      = require('./renderer/shared');
const cardPreview = require('./renderer/cardPreview');
const dashboard   = require('./renderer/dashboard');
const matchHistory = require('./renderer/matchHistory');
const stats       = require('./renderer/stats');
const draftAssist = require('./renderer/draftAssistant');
const settings    = require('./renderer/settings');
const deckBuilder = require('./renderer/deckBuilder');

// ─── Attach panel functions to window for onclick handlers ────────────────────
if (typeof window !== 'undefined') {
    Object.assign(window, dashboard);
    Object.assign(window, matchHistory);
    Object.assign(window, stats);
    Object.assign(window, draftAssist);
    Object.assign(window, settings);
    Object.assign(window, deckBuilder);
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function showPage(page) {
    state.currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item =>
        item.classList.toggle('active', item.dataset.page === page)
    );
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${page}`).classList.add('active');

    if (page === 'dashboard')  dashboard.loadDashboard();
    if (page === 'draft')      draftAssist.renderDraftPage();
    if (page === 'matches')    matchHistory.loadMatches();
    if (page === 'stats')      stats.loadStats();
    if (page === 'settings')   settings.loadSettings();
    if (page === 'deckbuilder') deckBuilder.initDeckBuilder();
}

// ─── Window controls ──────────────────────────────────────────────────────────

function minimizeWindow()      { ipcRenderer.send('minimize-window'); }
function maximizeWindow()      { ipcRenderer.send('maximize-window'); }
function closeWindow()         { ipcRenderer.send('close-window'); }
function openExternalLink(url) { ipcRenderer.send('open-external', url); }

if (typeof window !== 'undefined') {
    Object.assign(window, { showPage, minimizeWindow, maximizeWindow, closeWindow, openExternalLink });
}

// ─── IPC event listeners ──────────────────────────────────────────────────────

ipcRenderer.on('match-started', (event, data) => {
    console.log('Match started:', data);
    updateStatus('Match in progress…');
});

ipcRenderer.on('match-ended', (event, data) => {
    console.log('Match ended:', data);
    updateStatus(`Match ended: ${data.result}`);
    if (state.currentPage === 'dashboard') dashboard.loadDashboard();
    if (state.currentPage === 'matches')   matchHistory.loadMatches();
});

ipcRenderer.on('deck-submitted', (event, data) => {
    console.log('Deck submitted:', data);
});

ipcRenderer.on('inventory-updated', (event, data) => {
    if (state.currentPage === 'dashboard') {
        const el = document.getElementById('inventory-widget');
        if (el) el.innerHTML = dashboard.renderInventory(data);
    }
});

ipcRenderer.on('card-stats-updated', async () => {
    if (state.currentPage === 'stats') {
        await stats.loadStats();
    }
});

ipcRenderer.on('draft-update', (event, data) => {
    console.log('[Draft] Update received:', data);
    state.bundle       = data;
    state.viewingCoord = data.liveCoord;

    if (!state.draftList.some(d => d.draftId === state.bundle?.draftId)) {
        ipcRenderer.invoke('list-drafts').then(list => {
            state.draftList = list;
            draftAssist.rebuildDraftDropdown();
        });
    } else {
        draftAssist.rebuildDraftDropdown();
    }

    const navDraft = document.getElementById('nav-draft');
    if (navDraft && state.currentPage !== 'draft') {
        let badge = navDraft.querySelector('.draft-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'draft-badge';
            navDraft.appendChild(badge);
        }
        const liveEntry = state.bundle?.picks?.find(p =>
            p.pack === state.bundle.liveCoord?.pack && p.pick === state.bundle.liveCoord?.pick
        );
        badge.textContent = `${liveEntry?.options?.length ?? 0}`;
    }

    if (state.currentPage === 'draft') draftAssist.renderDraftPage();
});

// ─── Status bar ───────────────────────────────────────────────────────────────

function updateStatus(text) {
    document.getElementById('status-text').textContent = text;
}

// ─── Keyboard stepping ────────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
    document.addEventListener('keydown', (e) => {
        if (state.currentPage !== 'draft') return;
        if (!state.bundle || !state.viewingCoord) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();

        const target = e.key === 'ArrowLeft'
            ? shared.prevCoord(state.bundle.picks, state.viewingCoord)
            : shared.nextCoord(state.bundle.picks, state.viewingCoord);

        if (target.pack === state.viewingCoord.pack && target.pick === state.viewingCoord.pick) return;
        state.viewingCoord = target;
        draftAssist.renderDraftPage();
    });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', async () => {
        cardPreview.initCardPreview();
        await draftAssist.updateCsvStatusUI();
        dashboard.loadDashboard();
        draftAssist.initDraftView();
    });
}

// ─── Node/Jest exports (test_renderer.js imports from here) ──────────────────

if (typeof window === 'undefined') {
    module.exports = {
        ...shared,
        ...cardPreview,
    };
}
