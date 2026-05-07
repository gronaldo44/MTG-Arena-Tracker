'use strict';

const state = require('../state');
const { _dotColor, _dotBorder } = require('../shared');

// ─── Constants ────────────────────────────────────────────────────────────────

const HYPGEO_DECK_SIZE = 40;
const HYPGEO_MAX_TURN  = 10;

// ─── Local state ──────────────────────────────────────────────────────────────

const _hypGeoSources    = { W: 0, U: 8, B: 0, R: 0, G: 9 };
let _hypGeoGoingFirst   = true;
let _hypGeoConverge     = false;
let _hypGeoPipRows      = [];
let _hypGeoLands        = 17;
const _customLands      = {};
let _selectedCustomColors = new Set();

// ─── Binomial coefficients ────────────────────────────────────────────────────

const _binom = (() => {
    const MAX = 61;
    const t = Array.from({ length: MAX }, () => Array(MAX).fill(0));
    for (let n = 0; n < MAX; n++) {
        t[n][0] = 1;
        for (let k = 1; k <= n; k++) t[n][k] = t[n-1][k-1] + t[n-1][k];
    }
    return (n, k) => (n < 0 || k < 0 || k > n) ? 0 : t[n][k];
})();

// ─── Probability math ─────────────────────────────────────────────────────────

function hypGeoAtLeastOne(N, K, n) {
    if (K <= 0 || n <= 0) return 0;
    if (N - K < n) return 1;
    let p = 1;
    for (let i = 0; i < n; i++) p *= (N - K - i) / (N - i);
    return 1 - p;
}

function parsePips(manaCost) {
    const pips = {};
    for (const [, c] of (manaCost || '').matchAll(/\{([WUBRG])\}/g)) {
        pips[c] = (pips[c] || 0) + 1;
    }
    return pips;
}

function pipKey(pips) {
    return ['W', 'U', 'B', 'R', 'G']
        .filter(c => (pips[c] || 0) > 0)
        .map(c => c.repeat(pips[c]))
        .join('');
}

function multiHypGeoProb(N, colorSources, n, pipReq) {
    const colors = ['W', 'U', 'B', 'R', 'G'].filter(c => (pipReq[c] || 0) > 0);
    if (colors.length === 0) return 1;
    const K    = colors.map(c => colorSources[c] || 0);
    const kMin = colors.map(c => pipReq[c]);
    for (let i = 0; i < colors.length; i++) if (K[i] < kMin[i]) return 0;
    const K_other = N - K.reduce((s, v) => s + v, 0);
    if (K_other < 0) return 0;
    const total = _binom(N, n);
    if (total === 0) return 0;
    let num = 0;
    (function enumerate(idx, drawn, term) {
        if (idx === colors.length) {
            const g_other = n - drawn;
            if (g_other >= 0 && g_other <= K_other) num += term * _binom(K_other, g_other);
            return;
        }
        for (let g = kMin[idx]; g <= Math.min(K[idx], n - drawn); g++)
            enumerate(idx + 1, drawn + g, term * _binom(K[idx], g));
    })(0, 0, 1);
    return Math.min(1, num / total);
}

function multiHypGeoExact(N, colorSources, n, pipReq, customLands, totalLands) {
    const reqColors = ['W', 'U', 'B', 'R', 'G'].filter(c => (pipReq[c] || 0) > 0);
    if (reqColors.length === 0) return 1;
    const m = reqColors.length;

    const customContrib = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(customLands)) {
        for (const c of key) customContrib[c] += cnt;
    }

    const mono = {};
    for (const c of ['W', 'U', 'B', 'R', 'G'])
        mono[c] = Math.max(0, (colorSources[c] || 0) - customContrib[c]);

    const groupK = new Array(1 << m).fill(0);

    for (const [key, cnt] of Object.entries(customLands)) {
        let mask = 0;
        for (let i = 0; i < m; i++) if (key.includes(reqColors[i])) mask |= 1 << i;
        groupK[mask] += cnt;
    }
    for (let i = 0; i < m; i++) groupK[1 << i] += mono[reqColors[i]];

    const relevantTotal = groupK.reduce((s, v) => s + v, 0);
    const K_other = N - relevantTotal + groupK[0];
    groupK[0] = 0;

    for (let i = 0; i < m; i++) {
        let avail = 0;
        for (let mask = 1; mask < (1 << m); mask++) if ((mask >> i) & 1) avail += groupK[mask];
        if (avail < (pipReq[reqColors[i]] || 0)) return 0;
    }

    const denom = _binom(N, n);
    if (denom === 0) return 0;

    const groups = [];
    for (let mask = 1; mask < (1 << m); mask++) if (groupK[mask] > 0) groups.push({ mask, K: groupK[mask] });
    const req = reqColors.map(c => pipReq[c] || 0);
    let num = 0;

    (function enumerate(gi, drawn, term, colorDrawn) {
        if (gi === groups.length) {
            for (let i = 0; i < m; i++) if (colorDrawn[i] < req[i]) return;
            const g_other = n - drawn;
            if (g_other >= 0 && g_other <= K_other) num += term * _binom(K_other, g_other);
            return;
        }
        const { mask, K } = groups[gi];
        for (let g = 0; g <= Math.min(K, n - drawn); g++) {
            const cd = colorDrawn.slice();
            for (let i = 0; i < m; i++) if ((mask >> i) & 1) cd[i] += g;
            enumerate(gi + 1, drawn + g, term * _binom(K, g), cd);
        }
    })(0, 0, 1, new Array(m).fill(0));

    return Math.min(1, num / denom);
}

function convergeProb(N, colorSources, n, X) {
    const active = ['W', 'U', 'B', 'R', 'G'].filter(c => (colorSources[c] || 0) > 0);
    const m = active.length;
    if (X <= 0) return 1;
    if (X > m)  return 0;

    const src = active.map(c => colorSources[c]);

    function bits(x) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

    function qMiss(mask) {
        let K = 0;
        for (let i = 0; i < m; i++) if (mask >> i & 1) K += src[i];
        if (N - K < n) return 0;
        let p = 1;
        for (let i = 0; i < n; i++) p *= (N - K - i) / (N - i);
        return p;
    }

    function pExact(covered) {
        const notCov = ((1 << m) - 1) ^ covered;
        let sum = 0;
        for (let S = covered; ; S = (S - 1) & covered) {
            sum += (bits(S) % 2 === 0 ? 1 : -1) * qMiss(notCov | S);
            if (S === 0) break;
        }
        return sum;
    }

    let total = 0;
    for (let mask = 0; mask < (1 << m); mask++) {
        if (bits(mask) >= X) total += pExact(mask);
    }
    return Math.max(0, Math.min(1, total));
}

// ─── Sources init from draft ──────────────────────────────────────────────────

function initHypGeoFromDraft() {
    const picks = state.bundle?.picks || [];

    for (const c of ['W', 'U', 'B', 'R', 'G']) _hypGeoSources[c] = 0;
    _hypGeoPipRows = [];
    if (picks.length === 0) return;

    const colorCounts = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const pipRowMap   = new Map();
    for (const pick of picks) {
        const pips  = parsePips(pick.pickedCard?.manaCost);
        const key   = pipKey(pips);
        const gihWr = pick.pickedCard?.gihWr ?? null;
        if (key) {
            for (const c of Object.keys(pips)) colorCounts[c]++;
            if (!pipRowMap.has(key)) {
                pipRowMap.set(key, { pips, maxGihWr: gihWr });
            } else {
                const entry = pipRowMap.get(key);
                if (gihWr !== null && (entry.maxGihWr === null || gihWr > entry.maxGihWr))
                    entry.maxGihWr = gihWr;
            }
        }
    }

    const ranked = ['W', 'U', 'B', 'R', 'G']
        .filter(c => colorCounts[c] > 0)
        .sort((a, b) => colorCounts[b] - colorCounts[a]);

    if (ranked.length >= 1) _hypGeoSources[ranked[0]] = 9;
    if (ranked.length >= 2) _hypGeoSources[ranked[1]] = 8;

    _hypGeoPipRows = [...pipRowMap.values()];
}

// ─── Source / land controls ───────────────────────────────────────────────────

function setHypGeoGoingFirst(goFirst) {
    _hypGeoGoingFirst = goFirst;
    document.getElementById('hypgeo-first-btn').classList.toggle('active', goFirst);
    document.getElementById('hypgeo-second-btn').classList.toggle('active', !goFirst);
    const thumb = document.getElementById('go-toggle-thumb');
    if (thumb) thumb.classList.toggle('at-second', !goFirst);
    renderHypGeoTable();
}

function toggleHypGeoGoingFirst() {
    setHypGeoGoingFirst(!_hypGeoGoingFirst);
}

function adjustHypGeoSource(color, delta) {
    _hypGeoSources[color] = Math.max(0, Math.min(HYPGEO_DECK_SIZE, (_hypGeoSources[color] || 0) + delta));
    renderHypGeoTable();
}

function adjustHypGeoLands(delta) {
    _hypGeoLands = Math.max(1, Math.min(HYPGEO_DECK_SIZE, _hypGeoLands + delta));
    renderHypGeoTable();
}

function adjustCustomLand(key, delta) {
    const val = (_customLands[key] || 0) + delta;
    if (val <= 0) delete _customLands[key];
    else _customLands[key] = val;
    // Decrement source count when adding a custom land; don't restore when removing.
    if (delta > 0) {
        for (const c of key) {
            _hypGeoSources[c] = Math.max(0, (_hypGeoSources[c] || 0) - delta);
        }
    }
    renderCustomLandsModal();
    renderHypGeoTable();
}

function toggleCustomLandColor(c) {
    if (_selectedCustomColors.has(c)) _selectedCustomColors.delete(c);
    else _selectedCustomColors.add(c);
    const btn = document.querySelector(`.custom-land-toggle[data-clr="${c}"]`);
    if (btn) btn.classList.toggle('active', _selectedCustomColors.has(c));
    const addBtn = document.getElementById('custom-land-add-btn');
    if (addBtn) addBtn.disabled = _selectedCustomColors.size < 1;
}

function commitCustomLand() {
    if (_selectedCustomColors.size < 1) return;
    const key = ['W', 'U', 'B', 'R', 'G'].filter(c => _selectedCustomColors.has(c)).join('');
    _customLands[key] = (_customLands[key] || 0) + 1;
    for (const c of key) {
        _hypGeoSources[c] = Math.max(0, (_hypGeoSources[c] || 0) - 1);
    }
    _selectedCustomColors = new Set();
    renderCustomLandsModal();
    renderHypGeoTable();
}

function openCustomLandsModal() {
    document.getElementById('custom-lands-modal').style.display = 'flex';
    renderCustomLandsModal();
}

function closeCustomLandsModal() {
    document.getElementById('custom-lands-modal').style.display = 'none';
}

function toggleHypGeoConverge() {
    _hypGeoConverge = !_hypGeoConverge;
    document.getElementById('hypgeo-converge-btn').classList.toggle('active', _hypGeoConverge);
    renderHypGeoTable();
}

// ─── Custom lands modal ───────────────────────────────────────────────────────

function renderCustomLandsModal() {
    const body = document.getElementById('custom-lands-body');
    if (!body) return;

    const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

    const contribPerColor = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(_customLands))
        for (const c of key) contribPerColor[c] += cnt;
    const totalSources = ['W', 'U', 'B', 'R', 'G']
        .reduce((s, c) => s + (_hypGeoSources[c] || 0) + contribPerColor[c], 0);

    const dualSlots      = Math.max(0, totalSources - _hypGeoLands);
    const specifiedDuals = Object.entries(_customLands)
        .filter(([k]) => k.length >= 2).reduce((s, [k, v]) => s + (k.length - 1) * v, 0);
    const unaccounted    = Math.max(0, dualSlots - specifiedDuals);
    const isOverAccounted = dualSlots > 0 && specifiedDuals > dualSlots;
    const pct             = dualSlots > 0
        ? Math.min(100, Math.round(specifiedDuals / dualSlots * 100))
        : 100;

    const landList = Object.entries(_customLands).map(([key, count]) => {
        const dots = [...key].map(c =>
            `<span class="hypgeo-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorNames[c]}"></span>`
        ).join('');
        return `<div class="custom-land-item">
            <div class="hypgeo-pip-cell">${dots}</div>
            <div class="src-stepper">
                <button onclick="adjustCustomLand('${key}', -1)">−</button>
                <span>${count}</span>
                <button onclick="adjustCustomLand('${key}', +1)">+</button>
            </div>
        </div>`;
    }).join('');

    const toggles = ['W', 'U', 'B', 'R', 'G'].map(c => {
        const active = _selectedCustomColors.has(c);
        return `<button class="custom-land-toggle${active ? ' active' : ''}" data-clr="${c}"
            onclick="toggleCustomLandColor('${c}')"
            style="background:${_dotColor[c]};${_dotBorder[c] || ''}"
            title="${colorNames[c]}"></button>`;
    }).join('');

    const progressLabel = dualSlots === 0
        ? 'No multi-color lands needed'
        : `${specifiedDuals} / ${dualSlots} extra color source${dualSlots !== 1 ? 's' : ''} accounted for`;
    const progressBadge = isOverAccounted
        ? `<span class="cl-over-badge">Over-specified. Reduce multi-color lands or lower source counts.</span>`
        : (unaccounted === 0 ? `<span class="cl-exact-badge">Exact</span>` : '');

    body.innerHTML = `
        <div class="cl-progress">
            <div class="cl-progress-track">
                <div class="cl-progress-fill${isOverAccounted ? ' cl-progress-over' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="cl-progress-text">${progressLabel} ${progressBadge}</span>
        </div>
        ${landList
            ? `<div class="custom-lands-list">${landList}</div>`
            : `<p class="cl-empty">No custom lands added yet.</p>`}
        <div class="cl-add-row">
            <span class="cl-add-row-label">Add a land: select colors it taps for</span>
            <div class="cl-toggles">${toggles}</div>
            <button class="cl-add-btn" id="custom-land-add-btn"
                onclick="commitCustomLand()"
                ${_selectedCustomColors.size < 1 ? 'disabled' : ''}>Add Land</button>
        </div>
        <p class="cl-hint">Each color a land taps for beyond its first covers one extra source (dual: 1, tri-land: 2, 5-color: 4).</p>
    `;
}

// ─── Hypgeo table ─────────────────────────────────────────────────────────────

function renderHypGeoTable() {
    const sourcesPanel = document.getElementById('hypgeo-sources-panel');
    const headerRow    = document.getElementById('hypgeo-header-row');
    const tbody        = document.getElementById('hypgeo-tbody');
    if (!sourcesPanel || !headerRow || !tbody) return;

    const colorNames = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

    const _customContrib = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    for (const [key, cnt] of Object.entries(_customLands))
        for (const c of key) _customContrib[c] += cnt;
    const _effectiveSrc = {};
    for (const c of ['W', 'U', 'B', 'R', 'G'])
        _effectiveSrc[c] = (_hypGeoSources[c] || 0) + _customContrib[c];

    const totalSources = ['W', 'U', 'B', 'R', 'G'].reduce((s, c) => s + _effectiveSrc[c], 0);
    const dualSlots    = Math.max(0, totalSources - _hypGeoLands);

    const specifiedDuals  = Object.entries(_customLands)
        .filter(([k]) => k.length >= 2).reduce((s, [k, v]) => s + (k.length - 1) * v, 0);
    const remainingDuals  = Math.max(0, dualSlots - specifiedDuals);

    const accountedFor = Object.entries(_customLands).reduce((s, [k, v]) => s + k.length * v, 0);
    const isExact      = remainingDuals === 0 || accountedFor >= totalSources;

    let biasEstimate = 0;
    if (!isExact) {
        const active = ['W', 'U', 'B', 'R', 'G']
            .filter(c => _effectiveSrc[c] > 0)
            .sort((a, b) => _effectiveSrc[b] - _effectiveSrc[a]);
        if (active.length >= 2) {
            const K_A       = _effectiveSrc[active[0]];
            const K_B       = _effectiveSrc[active[1]];
            const n_hand    = _hypGeoGoingFirst ? 7 : 8;
            const poolModel = HYPGEO_DECK_SIZE - K_A - K_B + specifiedDuals;
            const poolCorr  = poolModel + remainingDuals;
            if (poolModel >= 0 && poolCorr <= HYPGEO_DECK_SIZE) {
                biasEstimate = (_binom(poolCorr, n_hand) - _binom(poolModel, n_hand))
                             / _binom(HYPGEO_DECK_SIZE, n_hand);
            }
        }
    }

    const customByGroup = {};
    for (const [key, cnt] of Object.entries(_customLands)) {
        const group = key.length === 5 ? 'WUBRG' : key[0];
        if (!customByGroup[group]) customByGroup[group] = [];
        customByGroup[group].push([key, cnt]);
    }
    for (const entries of Object.values(customByGroup)) {
        entries.sort(([a], [b]) => a.length !== b.length ? a.length - b.length : (a < b ? -1 : 1));
    }

    function customLandRowHtml(key, count) {
        const dots = [...key].map(c =>
            `<span class="hypgeo-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorNames[c]}"></span>`
        ).join('');
        return `<div class="src-row src-custom-land-row">
            <div class="hypgeo-pip-cell">${dots}</div>
            <div class="src-stepper">
                <button onclick="adjustCustomLand('${key}', -1)">−</button>
                <span>${count}</span>
                <button onclick="adjustCustomLand('${key}', +1)">+</button>
            </div>
        </div>`;
    }

    const disclaimerHtml = dualSlots > 0 ? (() => {
        const biasPct = Math.round(biasEstimate * 100);
        const label   = isExact
            ? `Multi-color lands<br><span class="src-disclaimer-sub">All extra sources covered · Exact</span>`
            : `Multi-color lands<br><span class="src-disclaimer-sub">~+${biasPct}% on multicolor pips</span>`;
        const tooltip = isExact
            ? 'All multi-color lands specified. Probabilities are exact.'
            : `${remainingDuals} of ${dualSlots} extra color sources unspecified. Add your multi-color lands for exact odds.`;
        return `<span class="src-dual-disclaimer" data-tooltip="${tooltip}">${label}</span>`;
    })() : '';

    sourcesPanel.innerHTML =
        `<div class="src-panel-label">Sources</div>` +
        (customByGroup['WUBRG'] || []).map(([k, v]) => customLandRowHtml(k, v)).join('') +
        ['W', 'U', 'B', 'R', 'G'].map(color => {
            const K        = _hypGeoSources[color] || 0;
            const dotStyle = `background:${_dotColor[color]};${_dotBorder[color] || ''}`;
            const colorRow = `<div class="src-row">
                <span class="hypgeo-pip-dot" style="${dotStyle}" title="${colorNames[color]}"></span>
                <div class="src-stepper">
                    <button onclick="adjustHypGeoSource('${color}', -1)">−</button>
                    <span>${K}</span>
                    <button onclick="adjustHypGeoSource('${color}', +1)">+</button>
                </div>
            </div>`;
            const subRows = (customByGroup[color] || []).map(([k, v]) => customLandRowHtml(k, v)).join('');
            return colorRow + subRows;
        }).join('') +
        `<div class="src-row src-row-lands">
            <span class="src-lands-label">Lands</span>
            <div class="src-stepper">
                <button onclick="adjustHypGeoLands(-1)">−</button>
                ${(() => {
                    if (isExact) return `<span>${_hypGeoLands}</span>`;
                    const diff = totalSources - _hypGeoLands;
                    const tip = `${diff} more source${diff !== 1 ? 's' : ''} than lands. Some lands must cover multiple colors. Add your multi-color lands for exact odds.`;
                    return `<span style="color:var(--warning);cursor:default;" title="${tip}">${_hypGeoLands}</span>`;
                })()}
                <button onclick="adjustHypGeoLands(+1)">+</button>
            </div>
        </div>` +
        disclaimerHtml +
        `<button class="src-add-lands-btn" onclick="openCustomLandsModal()">+ Add / Edit Lands</button>`;

    const turnHeaders = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) =>
        `<th>Draw ${i + 1}</th>`
    ).join('');

    const dashCell = `<td class="hypgeo-pct-zero">—</td>`;

    function pctCell(prob) {
        if (prob === 0) return dashCell;
        const pct = (prob * 100).toFixed(1);
        const cls = prob < 0.33 ? 'hypgeo-pct-low'
                  : prob < 0.66 ? 'hypgeo-pct-mid'
                  : prob < 0.80 ? ''
                  : 'hypgeo-pct-high';
        return `<td class="${cls}">${pct}%</td>`;
    }

    headerRow.innerHTML = `<th>Pips</th>${turnHeaders}`;

    const rows = [];

    if (_hypGeoConverge) {
        for (const X of [2, 3, 4, 5]) {
            const n_sort  = _hypGeoGoingFirst ? (6 + X) : (7 + X);
            const sortKey = convergeProb(HYPGEO_DECK_SIZE, _effectiveSrc, n_sort, X);
            const cells   = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) => {
                if ((i + 1) < X) return dashCell;
                const n = _hypGeoGoingFirst ? (6 + i + 1) : (7 + i + 1);
                return pctCell(convergeProb(HYPGEO_DECK_SIZE, _effectiveSrc, n, X));
            }).join('');
            rows.push({ sortKey, html: `<tr><td><span class="hypgeo-converge-label">C${X}</span></td>${cells}</tr>` });
        }
    }

    for (const { pips, maxGihWr } of _hypGeoPipRows) {
        const totalPips = Object.values(pips).reduce((s, v) => s + v, 0);
        const n_sort    = _hypGeoGoingFirst ? (6 + totalPips) : (7 + totalPips);
        const sortKey   = multiHypGeoExact(HYPGEO_DECK_SIZE, _effectiveSrc, n_sort, pips, _customLands, _hypGeoLands);
        const dots = ['W', 'U', 'B', 'R', 'G'].flatMap(c => {
            const cnt = pips[c] || 0;
            if (!cnt) return [];
            const dotStyle = `background:${_dotColor[c]};${_dotBorder[c] || ''}`;
            return Array.from({ length: cnt }, () =>
                `<span class="hypgeo-pip-dot" style="${dotStyle}" title="${colorNames[c]}"></span>`
            );
        }).join('');
        const cells = Array.from({ length: HYPGEO_MAX_TURN }, (_, i) => {
            if ((i + 1) < totalPips) return dashCell;
            const n = _hypGeoGoingFirst ? (6 + i + 1) : (7 + i + 1);
            return pctCell(multiHypGeoExact(HYPGEO_DECK_SIZE, _effectiveSrc, n, pips, _customLands, _hypGeoLands));
        }).join('');
        rows.push({ sortKey, maxGihWr, html: `<tr><td><div class="hypgeo-pip-cell">${dots}</div></td>${cells}</tr>` });
    }

    const nonZero = rows.filter(r => r.sortKey > 0).sort((a, b) => b.sortKey - a.sortKey);
    const zero    = rows.filter(r => r.sortKey === 0).sort((a, b) => {
        const aw = a.maxGihWr ?? -Infinity;
        const bw = b.maxGihWr ?? -Infinity;
        return bw - aw;
    });
    tbody.innerHTML = [...nonZero, ...zero].map(r => r.html).join('');

    const modal = document.getElementById('custom-lands-modal');
    if (modal && modal.style.display !== 'none') renderCustomLandsModal();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Pure math — exported for unit testing
    parsePips,
    pipKey,
    hypGeoAtLeastOne,
    multiHypGeoExact,
    convergeProb,

    // DOM-touching functions
    initHypGeoFromDraft,
    renderHypGeoTable,
    setHypGeoGoingFirst,
    toggleHypGeoGoingFirst,
    adjustHypGeoSource,
    adjustHypGeoLands,
    adjustCustomLand,
    toggleCustomLandColor,
    commitCustomLand,
    openCustomLandsModal,
    closeCustomLandsModal,
    toggleHypGeoConverge,
    renderCustomLandsModal,
};
