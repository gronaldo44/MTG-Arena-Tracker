'use strict';

const { ipcRenderer } = require('electron');
const {
    _dotColor, _dotBorder, SPLASH_THRESHOLD,
    colorLabel, isSplashColor, getColorCombo, comboDotsHtml,
    renderMatchColorPips, cardEyeballHtml, draftCardColorPips, gihWrTierClass,
    formatCardGroupKey,
    isDraftFormat, groupIntoDraftRuns, draftComboTrophyStats,
} = require('./shared');

// Short label for match rows: strips the set name from Premier/Contender drafts.
function matchRowFormatLabel(fmt) {
    const m = (fmt || '').match(/^(Premier Draft|Contender Draft) /);
    return m ? m[1] : (fmt || 'Unknown Format');
}

// ─── Local state ──────────────────────────────────────────────────────────────

let _matchesAllMatches     = [];
let _matchesFormat         = null;
let _matchesSelectedCombos = new Set();

// ─── Draft pagination state ───────────────────────────────────────────────────

const DRAFT_PAGE_SIZE = 8;
let _draftRuns           = [];   // all runs for current filter, newest-first
let _draftTotals         = {};   // draftId → { wins, losses } across all matches
let _draftRunsShown      = 0;    // how many runs are currently rendered
let _expandedDraftIds    = new Set(); // draft keys that are currently expanded
let _draftExpandedFormat = null; // the format _expandedDraftIds belongs to

// ─── Deck view state ──────────────────────────────────────────────────────────

let _selectorResizeObserver = null;
let _expandedMatchId        = null;
let _cardCache         = new Map();   // matchId → { deckCards, sbCards }
let _expandedMainCards = [];
let _expandedSbCards   = [];
let _deckSort          = 'manaCost';
let _deckSearch        = '';
let _sbSort            = 'gihWr';
let _sbSearch          = '';
let _sbTracked         = true;   // false when deck came from GRE (no sideboard)

// ─── Match item renderer ──────────────────────────────────────────────────────

function renderMatchItem(match) {
    const date     = new Date(match.timestamp).toLocaleDateString();
    const time     = new Date(match.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const opp      = match.opponentName ? `vs ${match.opponentName}` : '';
    const pipsHtml = renderMatchColorPips(match);
    return `
        <div class="match-item-wrap" data-match-id="${match.id}">
            <div class="match-item ${match.result} has-deck" onclick="toggleDeckView('${match.id}')">
                <div class="match-badge ${match.result}">${match.result}</div>
                <div class="match-info">
                    <h4>${matchRowFormatLabel(match.format)}</h4>
                    ${opp ? `<p>${opp}</p>` : ''}
                </div>
                ${pipsHtml}
                <div class="match-date">${date}<br>${time}</div>
                <button class="btn btn-secondary"
                    onclick="event.stopPropagation(); deleteMatch('${match.id}')"
                    style="padding:5px 10px;font-size:12px;">Delete</button>
            </div>
        </div>`;
}

// ─── Draft group helpers ──────────────────────────────────────────────────────

// Returns a CSS class for the draft group's tier border color.
// Tier mapping (wins in a single draft):
//   7   → red   (trophy)
//   5-6 → gold
//   4   → silver
//   1-3 → black
//   0   → silver
function draftTierClass(wins) {
    if (wins >= 7) return 'draft-tier-red';
    if (wins >= 5) return 'draft-tier-gold';
    if (wins === 4) return 'draft-tier-silver';
    if (wins === 3) return 'draft-tier-black';
    return 'draft-tier-brown';
}

// ─── Match list ───────────────────────────────────────────────────────────────

async function loadMatches() {
    _matchesAllMatches = await ipcRenderer.invoke('get-matches');
    // Default to the most recently played format so the list always shows
    // something meaningful on first load. Users click a format card to switch.
    if (!_matchesFormat && _matchesAllMatches.length > 0) {
        _matchesFormat = formatCardGroupKey(_matchesAllMatches[0].format || 'Unknown');
    }
    renderMatchFormatCards();
    renderMatchList();
}

function _buildFmtMap() {
    const fmtMap = {};
    for (const m of _matchesAllMatches) {
        const key   = formatCardGroupKey(m.format || 'Unknown');
        const combo = getColorCombo(m.deckColors, m.deckColorCounts);
        if (!fmtMap[key]) fmtMap[key] = { total: 0, wins: 0, losses: 0, combos: {}, matches: [], premierMatches: [], contenderMatches: [] };
        fmtMap[key].total++;
        fmtMap[key].matches.push(m);
        if ((m.format || '').startsWith('Premier Draft'))        fmtMap[key].premierMatches.push(m);
        else if ((m.format || '').startsWith('Contender Draft')) fmtMap[key].contenderMatches.push(m);
        if (m.result === 'win')  fmtMap[key].wins++;
        if (m.result === 'loss') fmtMap[key].losses++;
        if (combo) {
            if (!fmtMap[key].combos[combo]) fmtMap[key].combos[combo] = { total: 0, wins: 0, losses: 0 };
            fmtMap[key].combos[combo].total++;
            if (m.result === 'win')  fmtMap[key].combos[combo].wins++;
            if (m.result === 'loss') fmtMap[key].combos[combo].losses++;
        }
    }
    return fmtMap;
}

function _buildDraftFmtStats(fmtMap) {
    const draftFmtStats = {};
    for (const [fmt, data] of Object.entries(fmtMap)) {
        if (!isDraftFormat(fmt)) continue;
        const allRuns       = groupIntoDraftRuns(data.matches);
        const premierRuns   = groupIntoDraftRuns(data.premierMatches);
        const contenderRuns = groupIntoDraftRuns(data.contenderMatches);
        draftFmtStats[fmt] = {
            totalRuns:         allRuns.length,
            comboStats:        draftComboTrophyStats(allRuns, getColorCombo),
            premierRuns:       premierRuns.length,
            premierTrophies:   premierRuns.filter(r => r.trophy).length,
            contenderRuns:     contenderRuns.length,
            contenderTrophies: contenderRuns.filter(r => r.trophy).length,
        };
    }
    return draftFmtStats;
}

function _buildMetaHtml(data, ds) {
    if (ds) {
        const matchWord = data.total !== 1 ? 'matches' : 'match';
        const draftWord = ds.totalRuns !== 1 ? 'drafts' : 'draft';
        let html = `<span class="mfc-meta-label">${data.total} ${matchWord}</span><span class="mfc-meta-value">${ds.totalRuns} ${draftWord}</span>`;
        if (ds.premierRuns > 0) {
            const pct = Math.round(ds.premierTrophies / ds.premierRuns * 100);
            html += `<span class="mfc-meta-label">Premier Trophy:</span><span class="mfc-meta-value">${pct}% (${ds.premierTrophies}/${ds.premierRuns})</span>`;
        }
        if (ds.contenderRuns > 0) {
            const pct = Math.round(ds.contenderTrophies / ds.contenderRuns * 100);
            html += `<span class="mfc-meta-label">Contender Trophy:</span><span class="mfc-meta-value">${pct}% (${ds.contenderTrophies}/${ds.contenderRuns})</span>`;
        }
        return html;
    }
    return `<span class="mfc-meta">${data.total} match${data.total !== 1 ? 'es' : ''}</span>`;
}

function _buildSelectorCombosHtml(top3, ds, maxPips) {
    if (!top3 || top3.length === 0) return '';
    const dotW = maxPips * 15; // fixed width keeps columns aligned across all 3 rows
    const rows = top3.map(([combo, cd]) => {
        const contested  = cd.wins + cd.losses;
        const wr         = contested > 0 ? Math.round(cd.wins / contested * 100) : 0;
        const trophyText = ds?.comboStats?.[combo]
            ? `${ds.comboStats[combo].trophies}/${ds.comboStats[combo].runs} T`
            : '';
        return `<div class="sel-combo-row">
            <div class="sel-combo-dots" style="min-width:${dotW}px">${comboDotsHtml(combo)}</div>
            <span class="sel-combo-count">${cd.total} match${cd.total !== 1 ? 'es' : ''}</span>
            <span class="sel-combo-wr ${wr >= 50 ? 'positive' : 'negative'}">${wr}%</span>
            <span class="sel-combo-trophy">${trophyText}</span>
        </div>`;
    }).join('');
    return `<div class="sel-combos">${rows}</div>`;
}

function _updateSelectorStages(listEl) {
    for (const row of listEl.querySelectorAll('.format-selector-row')) {
        const w         = row.offsetWidth;
        const tPips     = +row.dataset.tPips    || Infinity;
        const tWr       = +row.dataset.tWr      || Infinity;
        const tMatches  = +row.dataset.tMatches || Infinity;
        const tTrophies = (row.dataset.tTrophies !== '' && row.dataset.tTrophies)
            ? +row.dataset.tTrophies : Infinity;
        row.classList.remove('sel-stage-1', 'sel-stage-2', 'sel-stage-3', 'sel-stage-4');
        if      (w >= tTrophies) row.classList.add('sel-stage-4');
        else if (w >= tMatches)  row.classList.add('sel-stage-3');
        else if (w >= tWr)       row.classList.add('sel-stage-2');
        else if (w >= tPips)     row.classList.add('sel-stage-1');
    }
}

function renderMatchFormatCards() {
    const listEl = document.getElementById('format-selector-list');
    const cardEl = document.getElementById('selected-format-card-area');
    if (!listEl || !cardEl) return;
    if (_matchesAllMatches.length === 0) { listEl.innerHTML = ''; cardEl.innerHTML = ''; return; }

    const fmtMap       = _buildFmtMap();
    const draftFmtStats = _buildDraftFmtStats(fmtMap);
    const sorted       = Object.entries(fmtMap).sort((a, b) => b[1].total - a[1].total);

    // Ensure a valid selection
    if (!_matchesFormat || !fmtMap[_matchesFormat]) {
        _matchesFormat = sorted[0][0];
    }

    // ── Scrollable selector list ────────────────────────────────────────────
    listEl.innerHTML = sorted.map(([fmt, data]) => {
        const contested  = data.wins + data.losses;
        const wr         = contested > 0 ? Math.round(data.wins / contested * 100) : 0;
        const safeF      = fmt.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const isActive   = fmt === _matchesFormat;
        const ds         = draftFmtStats[fmt];
        const top3       = Object.entries(data.combos)
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 3);
        const maxPips    = top3.reduce((mx, [combo]) =>
            Math.max(mx, (combo.match(/[WUBRG]/g) || []).length), 0);
        const combosHtml = _buildSelectorCombosHtml(top3, ds, maxPips);
        return `<div class="format-selector-row${isActive ? ' active' : ''}"
            onclick="selectMatchFormat('${safeF}')"
            data-max-pips="${maxPips}"
            data-has-draft="${ds ? '1' : '0'}">
            <div class="mfc-name" title="${fmt}">
                <span class="sel-fmt-name">${fmt}</span>
                <span class="mfc-wr ${wr >= 50 ? 'positive' : 'negative'}">${wr}%</span>
            </div>
            <div class="mfc-stats-row">
                <div class="mfc-meta-lines">${_buildMetaHtml(data, ds)}</div>
                ${combosHtml}
            </div>
        </div>`;
    }).join('');

    // ── Selected format card (with combo rows) ──────────────────────────────
    const [selFmt, selData] = sorted.find(([fmt]) => fmt === _matchesFormat) || sorted[0];
    const ds = draftFmtStats[selFmt];
    const selContested = selData.wins + selData.losses;
    const selWr        = selContested > 0 ? Math.round(selData.wins / selContested * 100) : 0;
    const safeSelF     = selFmt.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const comboRows = Object.entries(selData.combos)
        .sort((a, b) => b[1].total - a[1].total)
        .map(([combo, cd]) => {
            const cContested = cd.wins + cd.losses;
            const cWr        = cContested > 0 ? Math.round(cd.wins / cContested * 100) : 0;
            const rowActive  = _matchesSelectedCombos.has(combo);
            const trophyHtml = ds?.comboStats[combo]
                ? `<span class="mfc-combo-trophy">${ds.comboStats[combo].trophies}/${ds.comboStats[combo].runs} T</span>`
                : '';
            return `<div class="mfc-combo-row${rowActive ? ' active' : ''}"
                onclick="event.stopPropagation(); toggleMatchCombo('${safeSelF}','${combo}')">
                <div class="mfc-combo-dots">${comboDotsHtml(combo)}</div>
                <span class="mfc-combo-count">${cd.total} match${cd.total !== 1 ? 'es' : ''}</span>
                <span class="mfc-combo-wr ${cWr >= 50 ? 'positive' : 'negative'}">${cWr}%</span>
                ${trophyHtml}
            </div>`;
        }).join('');

    // metaRows drives the WR% font-size: 3 rows (both premier + contender) → larger type.
    const metaRows = !ds ? 1
        : 1 + (ds.premierRuns > 0 ? 1 : 0) + (ds.contenderRuns > 0 ? 1 : 0);

    cardEl.innerHTML = `<div class="matches-format-card mfc-rows-${metaRows}">
        <div class="mfc-name" title="${selFmt}">${selFmt}</div>
        <div class="mfc-stats-row">
            <div class="mfc-meta-lines">${_buildMetaHtml(selData, ds)}</div>
            <span class="mfc-wr ${selWr >= 50 ? 'positive' : 'negative'}">${selWr}%</span>
        </div>
        ${comboRows ? `<div class="mfc-combo-list">${comboRows}</div>` : ''}
    </div>`;

    // ── Sync list height to card height, compute combo stage thresholds ─────
    requestAnimationFrame(() => {
        const cardH = cardEl.offsetHeight;
        const rows  = listEl.querySelectorAll('.format-selector-row');
        const rowH  = rows.length > 0 ? rows[0].offsetHeight : 80;
        listEl.style.paddingBottom = `${rowH}px`;
        listEl.style.minHeight     = `${Math.min(rows.length, 2) * rowH}px`;
        listEl.style.maxHeight     = cardH > 0 ? `${cardH}px` : 'none';

        // Combo stage thresholds: row must be at least this wide to show each stage.
        // BASE = row H-padding(24) + one stats-row gap(12) + combo section padding(20)
        // WR% is now in the name bar, so it no longer contributes to the stats-row width.
        const BASE = 56;
        for (const row of rows) {
            const maxPips = parseInt(row.dataset.maxPips || '0', 10);
            if (maxPips === 0) continue;
            const metaEl = row.querySelector('.mfc-meta-lines');
            const metaW  = metaEl ? metaEl.offsetWidth : 80;
            const dotCol = maxPips * 15;
            const base   = BASE + metaW + dotCol;
            row.dataset.tPips     = base;
            row.dataset.tWr       = base + 36;   // + gap(4) + WR(32)
            row.dataset.tMatches  = base + 100;  // + gap(4) + count(60) + gap(4) + WR(32)
            row.dataset.tTrophies = row.dataset.hasDraft === '1'
                ? base + 144  // + gap(4) + count(60) + gap(4) + WR(32) + gap(4) + trophy(40)
                : '';
        }
        _updateSelectorStages(listEl);

        if (_selectorResizeObserver) _selectorResizeObserver.disconnect();
        _selectorResizeObserver = new ResizeObserver(() => _updateSelectorStages(listEl));
        _selectorResizeObserver.observe(listEl);
    });
}

function renderMatchList() {
    _expandedMatchId = null;
    const container = document.getElementById('all-matches');
    let visible = _matchesAllMatches;
    if (_matchesFormat) visible = visible.filter(m => formatCardGroupKey(m.format) === _matchesFormat);
    if (_matchesSelectedCombos.size > 0) {
        visible = visible.filter(m => _matchesSelectedCombos.has(getColorCombo(m.deckColors, m.deckColorCounts)));
    }

    if (visible.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="icon">📝</div><p>${
            _matchesAllMatches.length === 0 ? 'No matches recorded yet.' : 'No matches for this filter.'
        }</p></div>`;
        return;
    }

    const state = require('./state');

    // Non-draft formats: show individual matches newest-first.
    if (!_matchesFormat || !isDraftFormat(_matchesFormat)) {
        const html = [...visible]
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .map(m => renderMatchItem(m))
            .join('');
        container.innerHTML = `<div class="match-list">${html}</div>`;
        return;
    }

    // Draft format — paginated by DRAFT_PAGE_SIZE runs at a time.
    // For tagged runs, header totals come from ALL matches (not just the
    // combo-filtered visible set) so the record stays accurate when filtered.
    _draftTotals = {};
    for (const m of _matchesAllMatches) {
        if (!m.draftId) continue;
        if (!_draftTotals[m.draftId]) _draftTotals[m.draftId] = { wins: 0, losses: 0 };
        if (m.result === 'win')        _draftTotals[m.draftId].wins++;
        else if (m.result === 'loss')  _draftTotals[m.draftId].losses++;
    }

    const latestTs = run => Math.max(...run.matches.map(m => new Date(m.timestamp).getTime()));
    _draftRuns = groupIntoDraftRuns(visible);
    _draftRuns.sort((a, b) => latestTs(b) - latestTs(a));

    // When the format changes, reset expanded state and auto-expand the latest run.
    if (_matchesFormat !== _draftExpandedFormat) {
        _expandedDraftIds.clear();
        _draftExpandedFormat = _matchesFormat;
        const firstKey = _draftRuns[0]?.matches[0]?.draftId || _draftRuns[0]?.matches[0]?.id;
        if (firstKey) _expandedDraftIds.add(firstKey);
    }

    const firstBatch = _draftRuns.slice(0, DRAFT_PAGE_SIZE);
    _draftRunsShown  = firstBatch.length;

    const html = firstBatch.map(run => _renderDraftRunHtml(run, state)).join('');
    container.innerHTML = `<div class="match-list">${html}</div>${_loadMoreBtnHtml()}`;
}

function _renderDraftRunHtml(run, state) {
    const taggedDraftId = run.matches[0]?.draftId || null;
    const draftKey      = taggedDraftId || run.matches[0]?.id || 'unknown';
    const totals        = taggedDraftId && _draftTotals[taggedDraftId]
        ? _draftTotals[taggedDraftId]
        : { wins: run.wins, losses: run.losses };

    const tier     = draftTierClass(totals.wins);
    const isActive = taggedDraftId
        ? taggedDraftId === state.liveDraftId && !state.liveDraftEnded
        : false;
    const label    = isActive
        ? `${totals.wins}-${totals.losses} Active`
        : totals.wins >= 7
            ? `${totals.wins}-${totals.losses} Trophy`
            : `${totals.wins}-${totals.losses}`;

    // IDs passed as a JSON array in the onclick — UUIDs are safe unescaped
    const matchIdsJson = JSON.stringify(run.matches.map(m => m.id));
    const safeKey      = draftKey.replace(/'/g, "\\'");
    const deleteBtn    = `<button class="btn btn-secondary draft-delete-btn"
        onclick="event.stopPropagation(); deleteDraftRun(${matchIdsJson})"
        style="padding:4px 10px;font-size:11px;flex-shrink:0;">Delete</button>`;

    if (_expandedDraftIds.has(draftKey)) {
        const matchItems = [...run.matches].reverse().map(m => renderMatchItem(m)).join('');
        return `<div class="draft-group ${tier}" data-draft-key="${draftKey}">
            <div class="draft-group-header" onclick="toggleDraftCollapse('${safeKey}')">
                <span class="draft-group-record">${label}</span>
                <span class="draft-header-spacer"></span>
                ${deleteBtn}
            </div>
            ${matchItems}
        </div>`;
    }

    // Collapsed: one summary row
    const latestMatch = run.matches[run.matches.length - 1];
    const fmt         = matchRowFormatLabel(latestMatch?.format || '');
    const pipsHtml    = renderMatchColorPips(latestMatch || {});
    const date        = latestMatch
        ? new Date(latestMatch.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
    return `<div class="draft-group ${tier} collapsed" data-draft-key="${draftKey}">
        <div class="draft-group-header" onclick="toggleDraftCollapse('${safeKey}')">
            <span class="draft-group-record">${label}</span>
            <span class="draft-header-format">${fmt}</span>
            <span class="draft-header-spacer"></span>
            ${pipsHtml}
            <span class="draft-header-date">${date}</span>
            ${deleteBtn}
        </div>
    </div>`;
}

function _loadMoreBtnHtml() {
    const remaining = _draftRuns.length - _draftRunsShown;
    if (remaining <= 0) return '';
    const count = Math.min(DRAFT_PAGE_SIZE, remaining);
    return `<div class="load-more-container">
        <button class="btn btn-secondary" onclick="loadMoreDraftRuns()">Load ${count} more draft${count !== 1 ? 's' : ''}</button>
    </div>`;
}

function loadMoreDraftRuns() {
    const state     = require('./state');
    const nextBatch = _draftRuns.slice(_draftRunsShown, _draftRunsShown + DRAFT_PAGE_SIZE);
    if (nextBatch.length === 0) return;
    _draftRunsShown += nextBatch.length;

    const matchList = document.querySelector('#all-matches .match-list');
    if (matchList) {
        matchList.insertAdjacentHTML('beforeend', nextBatch.map(r => _renderDraftRunHtml(r, state)).join(''));
    }

    document.querySelector('#all-matches .load-more-container')?.remove();
    const container = document.getElementById('all-matches');
    if (container) container.insertAdjacentHTML('beforeend', _loadMoreBtnHtml());
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

// ─── Deck view ────────────────────────────────────────────────────────────────

const _WUBRG = ['W', 'U', 'B', 'R', 'G'];

function _parseCmc(manaCost) {
    if (!manaCost) return 0;
    let cmc = 0;
    for (const t of (manaCost.match(/\{[^}]+\}/g) || [])) {
        const inner = t.slice(1, -1);
        if (/^\d+$/.test(inner)) cmc += parseInt(inner, 10);
        else if (inner !== 'X' && inner !== 'Y') cmc += 1;
    }
    return cmc;
}

function _deckColorKeys(manaCost) {
    const colors = _WUBRG.filter(c => (manaCost || '').includes(c));
    return colors.length > 0 ? colors : ['C'];
}

const _DV_COLOR_GROUPS = [
    { key: 'W', label: 'White',     textColor: '#f0e8d5' },
    { key: 'U', label: 'Blue',      textColor: '#5ba3e8' },
    { key: 'B', label: 'Black',     textColor: '#c4a8e8' },
    { key: 'R', label: 'Red',       textColor: '#ef5252' },
    { key: 'G', label: 'Green',     textColor: '#3dba74' },
    { key: 'C', label: 'Colorless', textColor: '#9ca3af' },
];

function _isLandCard(card) {
    return (card.type || '').toLowerCase().includes('land');
}

function _collapseBasicLands(cards) {
    const result = [];
    const landIndex = new Map();
    for (const card of cards) {
        if (card.type === 'Basic Land') {
            const key = card.name || card.arena_id;
            if (landIndex.has(key)) {
                result[landIndex.get(key)].count++;
            } else {
                landIndex.set(key, result.length);
                result.push({ ...card, count: 1 });
            }
        } else {
            result.push(card);
        }
    }
    return result;
}

function _deckCardRowHtml(card) {
    const name  = card.name || `Unknown (${card.arena_id})`;
    const pips  = draftCardColorPips(null, card.manaCost || '');
    const eye   = cardEyeballHtml(card.arena_id, card.name, null);
    const wrHtml = card.count != null
        ? `<div class="dv-card-wr">${card.count}</div>`
        : `<div class="dv-card-wr ${gihWrTierClass(card.tier || 'none')}">${card.gihWr != null ? `${(card.gihWr * 100).toFixed(1)}%` : '—'}</div>`;
    return `<div class="dv-card-row">
        <div class="dv-card-pips">${pips}</div>
        <div class="dv-card-name"><span title="${name}">${name}</span>${eye}</div>
        ${wrHtml}
    </div>`;
}

function _deckTableHtml(label, cards, headerStyle) {
    if (cards.length === 0) return '';
    const collapsed = _collapseBasicLands(cards);
    const total = collapsed.reduce((s, c) => s + (c.count ?? 1), 0);
    const styleAttr = headerStyle ? ` style="${headerStyle}"` : '';
    return `<div class="dv-table-group">
        <div class="dv-table-header"${styleAttr}>${label} <span class="dv-table-count">(${total})</span></div>
        <div class="dv-table-list">${collapsed.map(_deckCardRowHtml).join('')}</div>
    </div>`;
}

function _renderMainTablesHtml() {
    const q = _deckSearch.trim().toLowerCase();
    const allFiltered = q
        ? _expandedMainCards.filter(c => (c.name || '').toLowerCase().includes(q))
        : _expandedMainCards;

    const landCards    = allFiltered.filter(_isLandCard);
    const nonLandCards = allFiltered.filter(c => !_isLandCard(c));
    const landsTable   = _deckTableHtml('Lands', landCards);

    if (_deckSort === 'manaCost') {
        const cmcTables = [0, 1, 2, 3, 4, 5, 6].map(cmc => {
            const group = nonLandCards
                .filter(c => cmc === 6 ? _parseCmc(c.manaCost) >= 6 : _parseCmc(c.manaCost) === cmc)
                .sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1) || (a.name || '').localeCompare(b.name || ''));
            return _deckTableHtml(cmc === 6 ? 'Converted Mana Cost 6+' : `Converted Mana Cost ${cmc}`, group);
        }).join('');
        return cmcTables + landsTable;
    }

    if (_deckSort === 'gihWr') {
        const sorted = [...nonLandCards].sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
        return _deckTableHtml('Spells', sorted) + landsTable;
    }

    if (_deckSort === 'color') {
        const colorTables = _DV_COLOR_GROUPS.map(({ key, label, textColor }) => {
            const group = nonLandCards
                .filter(c => _deckColorKeys(c.manaCost).includes(key))
                .sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
            return _deckTableHtml(label, group, `color:${textColor}`);
        }).join('');
        return colorTables + landsTable;
    }

    return '';
}

function _renderSbListHtml() {
    const q = _sbSearch.trim().toLowerCase();
    const cards = q
        ? _expandedSbCards.filter(c => (c.name || '').toLowerCase().includes(q))
        : [..._expandedSbCards];

    if (_sbSort === 'gihWr') {
        cards.sort((a, b) => (b.gihWr ?? -1) - (a.gihWr ?? -1));
    } else if (_sbSort === 'color') {
        const ORDER = { W: 0, U: 1, B: 2, R: 3, G: 4, C: 5 };
        cards.sort((a, b) => {
            const ak = _deckColorKeys(a.manaCost)[0], bk = _deckColorKeys(b.manaCost)[0];
            return ((ORDER[ak] ?? 5) - (ORDER[bk] ?? 5)) || (b.gihWr ?? -1) - (a.gihWr ?? -1);
        });
    }

    if (cards.length === 0) {
        if (!_sbTracked) {
            return '<div class="dv-empty dv-empty-explain">Sideboard unavailable — historical matches only captured the main deck. Sideboard data is recorded for new matches going forward.</div>';
        }
        return '<div class="dv-empty">No cards match</div>';
    }
    return cards.map(_deckCardRowHtml).join('');
}

function _buildDeckPanelHtml() {
    const sbCount = _expandedSbCards.length;
    return `
        <div class="dv-main-area">
            <div class="dv-main-controls">
                <input class="dv-search" type="text" placeholder="Search deck..."
                    oninput="setDeckSearch(this.value)"
                    value="${_deckSearch.replace(/"/g, '&quot;')}">
                <div class="dv-sort-btns">
                    <button class="dv-sort-btn${_deckSort === 'manaCost' ? ' active' : ''}"
                        data-deck-sort="manaCost" onclick="setDeckSort('manaCost')">Mana Cost</button>
                    <button class="dv-sort-btn${_deckSort === 'gihWr' ? ' active' : ''}"
                        data-deck-sort="gihWr" onclick="setDeckSort('gihWr')">GIH WR</button>
                    <button class="dv-sort-btn${_deckSort === 'color' ? ' active' : ''}"
                        data-deck-sort="color" onclick="setDeckSort('color')">Color</button>
                </div>
            </div>
            <div class="dv-tables-row">${_renderMainTablesHtml()}</div>
        </div>
        <div class="dv-sb-area">
            <div class="dv-sb-header">Sideboard <span class="dv-table-count">(${sbCount})</span></div>
            <div class="dv-sb-controls">
                <input class="dv-search" type="text" placeholder="Search sideboard..."
                    oninput="setSbSearch(this.value)"
                    value="${_sbSearch.replace(/"/g, '&quot;')}">
                <div class="dv-sort-btns">
                    <button class="dv-sort-btn${_sbSort === 'gihWr' ? ' active' : ''}"
                        data-sb-sort="gihWr" onclick="setSbSort('gihWr')">GIH WR</button>
                    <button class="dv-sort-btn${_sbSort === 'color' ? ' active' : ''}"
                        data-sb-sort="color" onclick="setSbSort('color')">Color</button>
                </div>
            </div>
            <div class="dv-sb-list">${_renderSbListHtml()}</div>
        </div>`;
}

async function toggleDeckView(matchId) {
    const list = document.getElementById('all-matches');
    const qs   = sel => list?.querySelector(sel) ?? null;

    if (_expandedMatchId === matchId) {
        _expandedMatchId = null;
        qs(`.match-item-wrap[data-match-id="${matchId}"] .deck-view-panel`)?.remove();
        return;
    }

    if (_expandedMatchId) {
        qs(`.match-item-wrap[data-match-id="${_expandedMatchId}"] .deck-view-panel`)?.remove();
    }

    _expandedMatchId = matchId;
    const match = _matchesAllMatches.find(m => m.id === matchId);

    const wrap = qs(`.match-item-wrap[data-match-id="${matchId}"]`);
    if (!wrap) return;

    if (!match?.playerDeck?.deckCards?.length) {
        console.log('[toggleDeckView] no deck data — showing message panel');
        const panel = document.createElement('div');
        panel.className = 'deck-view-panel';
        panel.innerHTML = '<div class="dv-empty dv-empty-explain" style="flex:1;">No deck list recorded for this match.</div>';
        wrap.appendChild(panel);
        return;
    }

    if (!_cardCache.has(matchId)) {
        const [deckCards, sbCards] = await Promise.all([
            ipcRenderer.invoke('get-deck-card-details', match.playerDeck.deckCards || []),
            ipcRenderer.invoke('get-deck-card-details', match.playerDeck.sideboardCards || []),
        ]);
        _cardCache.set(matchId, { deckCards, sbCards });
    }

    const cached       = _cardCache.get(matchId);
    _expandedMainCards = cached.deckCards;
    _expandedSbCards   = cached.sbCards;
    _sbTracked         = !match.playerDeck?.greOnly;
    _deckSearch        = '';
    _sbSearch          = '';

    const panel = document.createElement('div');
    panel.className = 'deck-view-panel';
    panel.innerHTML = _buildDeckPanelHtml();
    wrap.appendChild(panel);
}

function setDeckSort(sort) {
    _deckSort = sort;
    const tablesRow = document.querySelector('.dv-tables-row');
    if (tablesRow) tablesRow.innerHTML = _renderMainTablesHtml();
    document.querySelectorAll('[data-deck-sort]').forEach(b => {
        b.classList.toggle('active', b.dataset.deckSort === _deckSort);
    });
}

function setDeckSearch(query) {
    _deckSearch = query;
    const tablesRow = document.querySelector('.dv-tables-row');
    if (tablesRow) tablesRow.innerHTML = _renderMainTablesHtml();
}

function setSbSort(sort) {
    _sbSort = sort;
    const sbList = document.querySelector('.dv-sb-list');
    if (sbList) sbList.innerHTML = _renderSbListHtml();
    document.querySelectorAll('[data-sb-sort]').forEach(b => {
        b.classList.toggle('active', b.dataset.sbSort === _sbSort);
    });
}

function setSbSearch(query) {
    _sbSearch = query;
    const sbList = document.querySelector('.dv-sb-list');
    if (sbList) sbList.innerHTML = _renderSbListHtml();
}

// ─── Draft collapse / delete ──────────────────────────────────────────────────

function toggleDraftCollapse(draftKey) {
    if (_expandedDraftIds.has(draftKey)) {
        _expandedDraftIds.delete(draftKey);
    } else {
        _expandedDraftIds.add(draftKey);
    }

    const run = _draftRuns.find(r => (r.matches[0]?.draftId || r.matches[0]?.id) === draftKey);
    if (!run) return;

    // Clear any open deck view that belongs to this run
    if (_expandedMatchId && run.matches.some(m => m.id === _expandedMatchId)) {
        _expandedMatchId = null;
    }

    const state    = require('./state');
    const draftEl  = document.querySelector(`#all-matches [data-draft-key="${draftKey.replace(/"/g, '\\"')}"]`);
    if (!draftEl) return;

    const temp = document.createElement('div');
    temp.innerHTML = _renderDraftRunHtml(run, state);
    draftEl.replaceWith(temp.firstElementChild);
}

async function deleteDraftRun(matchIds) {
    const count = matchIds.length;
    if (!confirm(`Delete this draft (${count} match${count !== 1 ? 'es' : ''})? This cannot be undone.`)) return;
    await Promise.all(matchIds.map(id => ipcRenderer.invoke('delete-match', id)));
    _matchesAllMatches = await ipcRenderer.invoke('get-matches');
    renderMatchFormatCards();
    renderMatchList();
}

// ─── Data actions ─────────────────────────────────────────────────────────────

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    await ipcRenderer.invoke('delete-match', matchId);
    const state = require('./state');
    if (state.currentPage === 'dashboard') {
        require('./dashboard').loadDashboard();
    } else if (state.currentPage === 'matches') {
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
    if (success) { alert('Data imported successfully! Please restart the app to see all your data.'); require('./dashboard').loadDashboard(); }
    else alert('Failed to import data.');
}

async function clearAllData() {
    if (!confirm('WARNING: This will delete ALL your match data. This cannot be undone.\n\nAre you sure?')) return;
    if (!confirm('Are you absolutely sure? All your data will be permanently lost.')) return;
    await ipcRenderer.invoke('clear-data');
    alert('All data has been cleared.');
    require('./dashboard').loadDashboard();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    renderMatchItem,
    loadMatches,
    renderMatchFormatCards,
    renderMatchList,
    selectMatchFormat,
    toggleMatchCombo,
    toggleDraftCollapse,
    deleteDraftRun,
    deleteMatch,
    exportData,
    importData,
    clearAllData,
    toggleDeckView,
    setDeckSort,
    setDeckSearch,
    setSbSort,
    setSbSearch,
    loadMoreDraftRuns,
};
