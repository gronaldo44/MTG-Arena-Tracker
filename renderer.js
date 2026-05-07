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

    if (page === 'dashboard')   dashboard.loadDashboard();
    if (page === 'draft')       draftAssist.ensureDraftLoaded().then(() => draftAssist.renderDraftPage());
    if (page === 'matches')     matchHistory.loadMatches();
    if (page === 'stats')       stats.loadStats();
    if (page === 'settings')    settings.loadSettings();
    if (page === 'deckbuilder') draftAssist.ensureDraftLoaded().then(() => deckBuilder.initDeckBuilder());
    updateDraftBadge();
}

// ─── Window controls ──────────────────────────────────────────────────────────

function minimizeWindow()      { ipcRenderer.send('minimize-window'); }
function maximizeWindow()      { ipcRenderer.send('maximize-window'); }
function closeWindow()         { ipcRenderer.send('close-window'); }
function openExternalLink(url) { ipcRenderer.send('open-external', url); }

function toggleSidebar() {
    const collapsed = document.getElementById('sidebar').classList.toggle('collapsed');
    localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '');
}

function updateDraftBadge() {
    const navDraft = document.getElementById('nav-draft');
    if (!navDraft) return;

    let badge = navDraft.querySelector('.draft-badge');

    const viewingLive = !!state.liveDraftId && state.bundle?.draftId === state.liveDraftId;
    const showReplay  = !!state.bundle && !viewingLive;
    const showLive    = viewingLive || (!!state.liveDraftId && !state.bundle);

    if (!showReplay && !showLive) {
        if (badge) badge.remove();
        return;
    }

    if (!badge) {
        badge = document.createElement('span');
        navDraft.appendChild(badge);
    }

    if (showReplay) {
        badge.className = 'draft-badge replay';
        badge.textContent = 'Replay';
    } else {
        badge.className = 'draft-badge live';
        badge.textContent = 'Live';
    }

    _updateDeckBuilderNotice();
}

function _updateDeckBuilderNotice() {
    const navEl = document.getElementById('nav-deckbuilder');
    if (!navEl) return;
    const iconEl = navEl.querySelector('.icon');
    if (!iconEl) return;
    const picks = state.bundle?.picks || [];
    const isLatest      = !!state.bundle && state.bundle.draftId === state.draftList?.[0]?.draftId;
    const isDraftComplete = isLatest
        && picks.length === 42
        && picks.every(p => p.missing || p.picked !== null);
    iconEl.classList.toggle('db-ready', isDraftComplete);
}

if (typeof window !== 'undefined') {
    Object.assign(window, { showPage, minimizeWindow, maximizeWindow, closeWindow, openExternalLink, toggleSidebar, updateDraftBadge });
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
    // If the user has explicitly selected a different (past) draft, preserve
    // that selection — only switch the bundle if they are following the live draft.
    const replayMode = !!state.bundle && state.bundle.draftId !== data.draftId;

    state.liveDraftId = data.draftId;
    if (!replayMode) {
        state.bundle       = data;
        state.viewingCoord = data.liveCoord;
    }

    if (!state.draftList.some(d => d.draftId === data.draftId)) {
        ipcRenderer.invoke('list-drafts').then(list => {
            state.draftList = list;
            draftAssist.rebuildDraftDropdown();
        });
    } else {
        draftAssist.rebuildDraftDropdown();
    }

    updateDraftBadge();

    if (state.currentPage === 'draft' && !replayMode) draftAssist.renderDraftPage();
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
        if (localStorage.getItem('sidebar-collapsed')) {
            document.getElementById('sidebar').classList.add('collapsed');
        }

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
        updateDeckBuilderNotice: _updateDeckBuilderNotice,
    };
}
