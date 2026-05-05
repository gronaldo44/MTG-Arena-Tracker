'use strict';

const { ipcRenderer } = require('electron');
const state = require('./state');
const {
    gihWrTierClass, draftCardColorPips, wheelIndicatorHtml, cardEyeballHtml,
    prevCoord, nextCoord,
} = require('./shared');

// ─── Local state ──────────────────────────────────────────────────────────────

let csvLoaded          = false;
let _currentPackOptions = [];
let _picksData         = [];
let _picksSortField    = 'pick';
let _picksSearchQuery  = '';
let _loadingDraftId    = null;

const MISSING_PICK_MSG = 'Pick missing from log (likely auto-pick during disconnect)';

// ─── Coord helpers ────────────────────────────────────────────────────────────

function getViewingPick() {
    if (!state.bundle || !state.viewingCoord) return null;
    return state.bundle.picks.find(p =>
        p.pack === state.viewingCoord.pack && p.pick === state.viewingCoord.pick
    ) || null;
}

function ensureValidViewingCoord() {
    if (!state.bundle || !Array.isArray(state.bundle.picks) || state.bundle.picks.length === 0) {
        state.viewingCoord = null;
        return;
    }
    const exists = state.bundle.picks.some(p =>
        p.pack === state.viewingCoord?.pack && p.pick === state.viewingCoord?.pick
    );
    if (!exists) state.viewingCoord = state.bundle.liveCoord;
}

// ─── Draft page renderer ──────────────────────────────────────────────────────

function renderDraftPage() {
    const activeEl  = document.getElementById('draft-active');
    const waitingEl = document.getElementById('draft-waiting');

    if (!state.bundle || !Array.isArray(state.bundle.picks) || state.bundle.picks.length === 0) {
        activeEl.style.display  = 'none';
        waitingEl.style.display = 'block';
        return;
    }

    activeEl.style.display  = 'block';
    waitingEl.style.display = 'none';

    ensureValidViewingCoord();
    syncDropdownSelection();

    const viewingPick = getViewingPick();
    if (!viewingPick) return;

    if (viewingPick.missing) {
        renderMissingPickPanel(viewingPick);
    } else {
        renderCurrentPack(viewingPick);
    }
    renderRemovedSection(viewingPick.removedCards || [], viewingPick.pick);
    renderPickHistory(state.bundle.picks, state.viewingCoord);
}

// ─── Dropdown ─────────────────────────────────────────────────────────────────

function rebuildDraftDropdown() {
    const sel = document.getElementById('draft-select');
    if (!sel) return;
    if (!Array.isArray(state.draftList) || state.draftList.length === 0) {
        sel.innerHTML = '<option value="" disabled selected>No past drafts yet</option>';
        sel.disabled  = true;
        return;
    }
    sel.disabled  = false;
    sel.innerHTML = state.draftList.map(d => {
        const date = new Date(d.startedAt).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
        return `<option value="${d.draftId}">${date} (${d.pickCount} picks)</option>`;
    }).join('');
    if (state.bundle?.draftId) sel.value = state.bundle.draftId;
}

function syncDropdownSelection() {
    const sel = document.getElementById('draft-select');
    if (!sel || !state.bundle?.draftId) return;
    if (sel.value !== state.bundle.draftId) sel.value = state.bundle.draftId;
}

async function onDraftSelectChange(draftId) {
    if (!draftId) return;
    _loadingDraftId = draftId;
    const newBundle = await ipcRenderer.invoke('view-draft-record', draftId);
    if (_loadingDraftId !== draftId) return;
    if (!newBundle) {
        console.warn('[Draft] view-draft-record returned null for', draftId);
        return;
    }
    state.bundle       = newBundle;
    state.viewingCoord = newBundle.liveCoord;
    renderDraftPage();
}

// ─── Pack panel ───────────────────────────────────────────────────────────────

function renderMissingPickPanel(pick) {
    document.getElementById('draft-pack-num').textContent   = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent   = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = '—';

    document.getElementById('draft-card-list').innerHTML = `
        <div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-style:italic;">
            ⚠️ ${MISSING_PICK_MSG}
        </div>`;
}

function renderCurrentPack(pick) {
    document.getElementById('draft-pack-num').textContent   = `Pack ${pick.pack ?? '?'}`;
    document.getElementById('draft-pick-num').textContent   = `Pick ${pick.pick ?? '?'}`;
    document.getElementById('draft-cards-left').textContent = `${pick.options.length} cards`;

    const listEl = document.getElementById('draft-card-list');
    if (!pick.options || pick.options.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">No cards in pack</div>';
        return;
    }

    _currentPackOptions = pick.options;

    listEl.innerHTML = pick.options.map((card, idx) => {
        const rank      = idx + 1;
        const name      = card.name || `Card ${card.arena_id}`;
        const gihWr     = card.gihWr;
        const lowSample = card.lowSample;
        const stats     = card.stats;
        const wrText    = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');
        const colorStr  = stats?.color || '';
        const ata       = stats?.ata ?? null;

        return `
            <div class="draft-card-row ${tierClass}" data-idx="${idx}" onclick="toggleCardDetail(${idx})">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${lowSample && gihWr !== null ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div class="wheel-indicator">${wheelIndicatorHtml(ata, pick.pick)}</div>
            </div>`;
    }).join('');
}

function renderRemovedSection(removedCards, currentPick) {
    const sectionEl = document.getElementById('draft-removed-section');
    const listEl    = document.getElementById('draft-removed-list');
    const headerEl  = document.getElementById('draft-removed-header');

    if (!removedCards || removedCards.length === 0) {
        sectionEl.style.display = 'none';
        return;
    }

    sectionEl.style.display = 'block';

    const priorPick = (typeof currentPick === 'number' && currentPick > 8)
        ? currentPick - 8
        : 1;
    headerEl.textContent = `Removed since pick ${priorPick}`;

    listEl.innerHTML = removedCards.map((card, idx) => {
        const rank      = idx + 1;
        const name      = card.name || `Card ${card.arena_id}`;
        const gihWr     = card.gihWr;
        const lowSample = card.lowSample;
        const stats     = card.stats;
        const wrText    = gihWr !== null && gihWr !== undefined ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const tierClass = gihWrTierClass(card.tier || 'none');
        const colorStr  = stats?.color || '';
        const ata       = stats?.ata ?? null;

        return `
            <div class="draft-card-row removed ${tierClass}">
                <div class="draft-rank">${rank}</div>
                <div class="draft-card-name">
                    ${draftCardColorPips(colorStr, card.manaCost || '')}
                    <span title="${name}">${name}</span>
                    ${lowSample && gihWr !== null && gihWr !== undefined ? '<span class="low-sample-dot" title="Low sample size"></span>' : ''}
                    ${cardEyeballHtml(card.arena_id, card.name, card.set)}
                </div>
                <div class="gih-wr ${tierClass}">${wrText}</div>
                <div class="wheel-indicator">${ata !== null ? `<span class="wheel-ata" title="Avg taken at pick ${ata.toFixed(1)}">${ata.toFixed(1)}</span>` : ''}</div>
            </div>`;
    }).join('');
}

// ─── Pick history ─────────────────────────────────────────────────────────────

function renderPickHistory(picks, _viewingCoord) {
    const completed = picks.filter(p => p.missing === true || p.picked !== null);
    document.getElementById('picks-count').textContent = completed.length;
    _picksData = completed;
    _renderFilteredPicks();
}

function _picksColorSection(colorStr, manaCost) {
    const WUBRG   = ['W', 'U', 'B', 'R', 'G'];
    const weights = { W: 16, U: 8, B: 4, R: 2, G: 1 };
    const source  = colorStr || manaCost || '';
    const colors  = WUBRG.filter(c => source.includes(c));

    if (colors.length === 0) return 9999;
    if (colors.length === 1) return WUBRG.indexOf(colors[0]);

    const bitmask = colors.reduce((acc, c) => acc + weights[c], 0);
    return colors.length * 100 + (31 - bitmask);
}

function setPicksSort(field) {
    _picksSortField = field;
    document.querySelectorAll('.picks-sort-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`picks-sort-${field}`);
    if (btn) btn.classList.add('active');
    _renderFilteredPicks();
}

function setPicksSearch(query) {
    _picksSearchQuery = query;
    _renderFilteredPicks();
}

function _renderFilteredPicks() {
    const listEl = document.getElementById('draft-picks-list');

    if (_picksData.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No picks yet</div>';
        return;
    }

    const q = _picksSearchQuery.trim().toLowerCase();
    let picks = q
        ? _picksData.filter(p => !p.missing && (p.pickedCard?.name || '').toLowerCase().includes(q))
        : [..._picksData];

    if (picks.length === 0) {
        listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">No matches</div>';
        return;
    }

    if (_picksSortField === 'gihWr') {
        picks.sort((a, b) => {
            if (a.missing) return 1;
            if (b.missing) return -1;
            const aw = a.pickedCard?.gihWr ?? null;
            const bw = b.pickedCard?.gihWr ?? null;
            if (aw === null && bw === null) return 0;
            if (aw === null) return 1;
            if (bw === null) return -1;
            return bw - aw;
        });
    } else if (_picksSortField === 'color') {
        picks.sort((a, b) => {
            if (a.missing) return 1;
            if (b.missing) return -1;
            const sectionDiff = _picksColorSection(a.pickedCard?.color, a.pickedCard?.manaCost)
                              - _picksColorSection(b.pickedCard?.color, b.pickedCard?.manaCost);
            if (sectionDiff !== 0) return sectionDiff;
            const aw = a.pickedCard?.gihWr ?? null;
            const bw = b.pickedCard?.gihWr ?? null;
            if (aw === null && bw === null) return 0;
            if (aw === null) return 1;
            if (bw === null) return -1;
            return bw - aw;
        });
    } else {
        picks.reverse();
    }

    listEl.innerHTML = picks.map(pick => {
        const isViewing = !!state.viewingCoord
            && pick.pack === state.viewingCoord.pack
            && pick.pick === state.viewingCoord.pick;
        const isFuture = !isViewing && !!state.viewingCoord && (
            pick.pack > state.viewingCoord.pack ||
            (pick.pack === state.viewingCoord.pack && pick.pick > state.viewingCoord.pick)
        );
        const stateClass = isViewing ? 'viewing' : isFuture ? 'future' : '';

        if (pick.missing) {
            return `
                <div class="draft-pick-item missing ${stateClass}">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-colors"></div>
                    <div class="pick-name" title="${MISSING_PICK_MSG}">⚠️ ${MISSING_PICK_MSG}</div>
                    <div class="pick-wr">—</div>
                </div>`;
        }
        const card    = pick.pickedCard;
        const name    = card?.name || `Card ${card?.arena_id ?? '?'}`;
        const gihWr   = card?.gihWr ?? null;
        const wrText  = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
        const wrClass = gihWrTierClass(card?.tier || 'none');
        const colorStr = card?.color || '';

        return `
            <div class="draft-pick-item ${stateClass}">
                <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                <div class="pick-colors">${draftCardColorPips(colorStr, card?.manaCost || '')}</div>
                <div class="pick-name">
                    <span title="${name}">${name}</span>
                    ${cardEyeballHtml(card?.arena_id, card?.name, null)}
                </div>
                <div class="pick-wr ${wrClass}">${wrText}</div>
            </div>`;
    }).join('');
}

// ─── Card detail drawer ───────────────────────────────────────────────────────

async function toggleCardDetail(idx) {
    const card = _currentPackOptions[idx];
    if (!card) return;

    const rowEl = document.querySelector(`#draft-card-list [data-idx="${idx}"]`);
    if (!rowEl) return;

    const existing = rowEl.nextElementSibling;
    if (existing && existing.classList.contains('draft-card-detail')) {
        existing.remove();
        rowEl.classList.remove('detail-open');
        return;
    }

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

// ─── 17Lands CSV ──────────────────────────────────────────────────────────────

async function loadCsvFile() {
    const result = await ipcRenderer.invoke('load-17lands-csv');
    if (result.success) {
        csvLoaded = true;
        await updateCsvStatusUI();
        if (state.currentPage === 'draft') renderDraftPage();
    } else if (result.reason !== 'cancelled') {
        alert(`Failed to load CSV: ${result.reason}`);
    }
}

async function updateCsvStatusUI() {
    const status = await ipcRenderer.invoke('get-draft-assistant-status');
    csvLoaded = status.loaded;

    const banner = document.getElementById('csv-status-banner');
    const iconEl = document.getElementById('csv-status-icon');
    const textEl = document.getElementById('csv-status-text');

    if (status.loaded) {
        banner.className = 'csv-status-banner loaded';
        iconEl.textContent = '✅';
        textEl.textContent = `${status.setName} (${status.cardCount.toLocaleString()} cards loaded)`;
    } else {
        banner.className = 'csv-status-banner not-loaded';
        iconEl.textContent = '⚠️';
        textEl.textContent = 'No 17Lands data loaded. Ratings unavailable.';
    }

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

// ─── Init ─────────────────────────────────────────────────────────────────────

async function initDraftView() {
    try {
        state.draftList = await ipcRenderer.invoke('list-drafts');
    } catch (e) {
        console.warn('[Draft] list-drafts failed:', e);
        state.draftList = [];
    }
    rebuildDraftDropdown();
    if (!state.bundle && state.draftList.length > 0) {
        await onDraftSelectChange(state.draftList[0].draftId);
    } else if (state.bundle && state.currentPage === 'draft') {
        renderDraftPage();
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    renderDraftPage,
    rebuildDraftDropdown,
    syncDropdownSelection,
    onDraftSelectChange,
    renderPickHistory,
    setPicksSort,
    setPicksSearch,
    toggleCardDetail,
    loadCsvFile,
    updateCsvStatusUI,
    initDraftView,
};
