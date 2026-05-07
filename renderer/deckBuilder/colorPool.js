'use strict';

const state = require('../state');
const { draftCardColorPips, gihWrTierClass, cardEyeballHtml } = require('../shared');

// ─── Draft Card Pool ──────────────────────────────────────────────────────────

let _sort   = 'gihWr';
let _search = '';

const COLOR_GROUPS = [
    { key: 'W', label: 'White',     textColor: '#f0e8d5' },
    { key: 'U', label: 'Blue',      textColor: '#5ba3e8' },
    { key: 'B', label: 'Black',     textColor: '#c4a8e8' },
    { key: 'R', label: 'Red',       textColor: '#ef5252' },
    { key: 'G', label: 'Green',     textColor: '#3dba74' },
    { key: 'C', label: 'Colorless', textColor: '#9ca3af' },
];

const WUBRG = ['W', 'U', 'B', 'R', 'G'];

function _cardColorKeys(card) {
    const source = card.color || card.manaCost || '';
    const colors = WUBRG.filter(c => source.includes(c));
    return colors.length > 0 ? colors : ['C'];
}

function renderColorTables() {
    const container = document.getElementById('color-pool-container');
    if (!container) return;

    const picks = state.bundle
        ? state.bundle.picks.filter(p => !p.missing && p.picked !== null && p.pickedCard)
        : [];

    if (picks.length === 0) {
        container.innerHTML = '<p class="color-pool-empty">No picks in the selected draft.</p>';
        return;
    }

    const colorMap = Object.fromEntries(COLOR_GROUPS.map(g => [g.key, []]));
    picks.forEach(pick => {
        _cardColorKeys(pick.pickedCard).forEach(c => {
            if (colorMap[c]) colorMap[c].push(pick);
        });
    });

    const q = _search.trim().toLowerCase();

    const sortedGroups = [...COLOR_GROUPS].sort(
        (a, b) => colorMap[b.key].length - colorMap[a.key].length
    );

    container.innerHTML = sortedGroups.map(({ key, label, textColor }) => {
        const filtered = q
            ? colorMap[key].filter(p => (p.pickedCard?.name || '').toLowerCase().includes(q))
            : colorMap[key];

        if (filtered.length === 0) return '';

        const sorted = [...filtered];
        if (_sort === 'gihWr') {
            sorted.sort((a, b) => {
                const aw = a.pickedCard?.gihWr ?? null;
                const bw = b.pickedCard?.gihWr ?? null;
                if (aw === null && bw === null) return 0;
                if (aw === null) return 1;
                if (bw === null) return -1;
                return bw - aw;
            });
        } else {
            sorted.sort((a, b) =>
                a.pack !== b.pack ? a.pack - b.pack : a.pick - b.pick
            );
        }

        const rows = sorted.map(pick => {
            const card   = pick.pickedCard;
            const name   = card?.name || `Card ${card?.arena_id ?? '?'}`;
            const gihWr  = card?.gihWr ?? null;
            const wrText = gihWr !== null ? `${(gihWr * 100).toFixed(1)}%` : '—';
            const wrClass = gihWrTierClass(card?.tier || 'none');
            return `
                <div class="draft-pick-item">
                    <div class="pick-num">P${pick.pack ?? '?'}p${pick.pick ?? '?'}</div>
                    <div class="pick-colors">${draftCardColorPips(card?.color || '', card?.manaCost || '')}</div>
                    <div class="pick-name">
                        <span title="${name}">${name}</span>
                        ${cardEyeballHtml(card?.arena_id, card?.name, null)}
                    </div>
                    <div class="pick-wr ${wrClass}">${wrText}</div>
                </div>`;
        }).join('');

        return `
            <div class="color-pool-group">
                <h3 class="color-pool-group-header" style="color:${textColor}">${label} (${filtered.length})</h3>
                <div class="color-pool-list">${rows}</div>
            </div>`;
    }).join('');

    if (!container.innerHTML.trim()) {
        container.innerHTML = '<p class="color-pool-empty">No cards match the search.</p>';
    }
}

function setColorTableSort(field) {
    _sort = field;
    document.querySelectorAll('.color-pool-sort-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`color-pool-sort-${field}`);
    if (btn) btn.classList.add('active');
    renderColorTables();
}

function setColorTableSearch(query) {
    _search = query;
    renderColorTables();
}

module.exports = { renderColorTables, setColorTableSort, setColorTableSearch, cardColorKeys: _cardColorKeys };
