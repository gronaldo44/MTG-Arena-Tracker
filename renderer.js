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
    const bar = document.querySelector('.status-bar');
    if (bar) bar.style.left = collapsed ? '56px' : '220px';
}

function updateDraftBadge() {
    const navDraft = document.getElementById('nav-draft');
    if (!navDraft) return;

    let badge = navDraft.querySelector('.draft-badge');

    const hasLive     = !!state.liveDraftId && !state.liveDraftEnded;
    const viewingLive = hasLive && state.bundle?.draftId === state.liveDraftId;
    const showReplay  = !!state.bundle && !viewingLive;
    const showLive    = viewingLive || (hasLive && !state.bundle);

    if (!showReplay && !showLive) {
        if (badge) badge.remove();
        _updateDeckBuilderNotice();
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

    // Highlight only when the user is viewing a draft that is currently live (in progress).
    const isLive = !!state.bundle && state.bundle.draftId === state.liveDraftId && !state.liveDraftEnded;

    iconEl.classList.toggle('db-ready', isLive);
}

if (typeof window !== 'undefined') {
    Object.assign(window, { showPage, minimizeWindow, maximizeWindow, closeWindow, openExternalLink, toggleSidebar, updateDraftBadge });
}

// ─── IPC event listeners ──────────────────────────────────────────────────────

ipcRenderer.on('match-started', (event, data) => {
    console.log('Match started:', data);
});

ipcRenderer.on('match-ended', (event, data) => {
    console.log('Match ended:', data);
    if (state.currentPage === 'dashboard') dashboard.loadDashboard();
    if (state.currentPage === 'matches')   matchHistory.loadMatches();
});

const STATUS_DEFAULT = 'Connected — Watching for matches';
let _statusResetTimer = null;

ipcRenderer.on('card-db-progress', (event, data) => {
    if (data.done) {
        clearTimeout(_statusResetTimer);
        _statusResetTimer = setTimeout(() => updateStatus(STATUS_DEFAULT), 2000);
        return;
    }
    updateStatus(`Downloading card database… ${data.withArenaId.toLocaleString()} cards`);
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

ipcRenderer.on('draft-ended', (event, data) => {
    if (data.draftId === state.liveDraftId) {
        state.liveDraftEnded = true;
        updateDraftBadge();
    }
});

ipcRenderer.on('draft-update', (event, data) => {
    // Replay mode: the user is viewing a past draft while the SAME live draft
    // continues to emit updates. Only applies when the live draft hasn't changed —
    // a brand-new draft session always takes over regardless of what's displayed.
    const isNewDraft = data.draftId !== state.liveDraftId;
    const replayMode = !isNewDraft && !!state.bundle && state.bundle.draftId !== data.draftId;

    if (isNewDraft) state.liveDraftEnded = false;
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
            const bar = document.querySelector('.status-bar');
            if (bar) bar.style.left = '56px';
        }

        cardPreview.initCardPreview();
        await draftAssist.updateCsvStatusUI();
        dashboard.loadDashboard();
        draftAssist.initDraftView();

        const versionEl = document.getElementById('app-version');
        if (versionEl) {
            const v = await ipcRenderer.invoke('get-app-version');
            versionEl.textContent = `v${v}`;
        }
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
