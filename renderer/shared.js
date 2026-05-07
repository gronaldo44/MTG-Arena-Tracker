'use strict';

// ─── Color constants ──────────────────────────────────────────────────────────

const _dotColor  = { W: '#f5f0e0', U: '#1e6daf', B: '#555', R: '#c1160e', G: '#1a6b3a' };
const _dotBorder = { B: 'border:1px solid #888;' };

const SPLASH_THRESHOLD = 4;

// ─── Color helpers ────────────────────────────────────────────────────────────

function colorLabel(c) {
    return { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' }[c] || c;
}

function isSplashColor(count) {
    return count > 0 && count <= SPLASH_THRESHOLD;
}

function getColorCombo(colors, colorCounts) {
    const counts = colorCounts || {};
    return ['W', 'U', 'B', 'R', 'G']
        .filter(c => (colors || []).includes(c) && !isSplashColor(counts[c] || 0))
        .join('');
}

function comboDotsHtml(combo) {
    return [...combo].map(c =>
        `<span class="mfc-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}"></span>`
    ).join('');
}

function renderMatchColorPips(match) {
    const colors = match.deckColors;
    const counts = match.deckColorCounts || {};
    const colorlessCnt = counts['C'] || 0;

    const ordered = ['W', 'U', 'B', 'R', 'G'].filter(c => (colors || []).includes(c));
    if (ordered.length === 0 && colorlessCnt === 0) return '';

    const pips = ordered.map(c => {
        const count = counts[c] || 0;
        const isSplash = isSplashColor(count);
        const title = count > 0
            ? `${colorLabel(c)}: ${count} card${count !== 1 ? 's' : ''}`
            : colorLabel(c);
        const pipStyle = isSplash
            ? `background:transparent;border:2px solid ${c === 'B' ? '#888' : _dotColor[c]};`
            : `background:${_dotColor[c]};${_dotBorder[c] || ''}`;
        return `<span class="match-pip-dot" style="${pipStyle}" title="${title}"></span>`;
    });

    if (colorlessCnt > 0) {
        pips.push(`<span class="match-pip-dot match-pip-colorless"
            title="Colorless: ${colorlessCnt} card${colorlessCnt !== 1 ? 's' : ''}">✦</span>`);
    }

    return `<div class="match-color-pips">${pips.join('')}</div>`;
}

// ─── Draft card pip renderer ──────────────────────────────────────────────────

function draftCardColorPips(colorStr, manaCost) {
    const WUBRG = ['W', 'U', 'B', 'R', 'G'];
    const source = colorStr || manaCost || '';
    const colors = WUBRG.filter(c => source.includes(c));

    if (colors.length === 0) {
        if (manaCost) {
            return `<span class="match-pip-dot match-pip-colorless" title="Colorless">✦</span>`;
        }
        return `<span class="pip-land-label">Land</span>`;
    }

    const dots = colors.map(c =>
        `<span class="match-pip-dot" style="background:${_dotColor[c]};${_dotBorder[c] || ''}" title="${colorLabel(c)}"></span>`
    ).join('');
    return `<span style="display:inline-flex;gap:3px;align-items:center;flex-shrink:0;">${dots}</span>`;
}

// ─── Wheel indicator ──────────────────────────────────────────────────────────

function wheelIndicatorHtml(ata, currentPick) {
    if (ata == null || !currentPick) return '';
    if (ata >= currentPick + 8) {
        return `<span class="wheel-icon" title="Likely to wheel (ATA ${ata.toFixed(1)})">↻</span>`;
    }
    if (currentPick > ata + 1) {
        return `<span class="wheel-late" title="Avg taken at pick ${ata.toFixed(1)}">${ata.toFixed(1)}</span>`;
    }
    return `<span class="wheel-ata" title="Avg taken at pick ${ata.toFixed(1)}">${ata.toFixed(1)}</span>`;
}

// ─── Card eyeball badge ───────────────────────────────────────────────────────

function cardEyeballHtml(grpId, name, setCode) {
    if (grpId === undefined || grpId === null || grpId === '') return '';
    const dataName = name ? ` data-card-name="${encodeURIComponent(name)}"` : '';
    const dataSet  = setCode ? ` data-card-set="${setCode}"` : '';
    return `<span class="card-eyeball" data-grpid="${grpId}"${dataName}${dataSet} title="Hover to preview"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-9.27 3.11-11 7.5C2.73 16.89 7 20 12 20s9.27-3.11 11-7.5C21.27 8.11 17 5 12 5zm0 12.5a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg></span>`;
}

// ─── Scryfall image URL extractor ─────────────────────────────────────────────

function extractScryfallImageUrl(card) {
    if (!card || typeof card !== 'object') return null;
    const pick = imgs => imgs?.large || imgs?.normal || imgs?.small || null;
    const direct = pick(card.image_uris);
    if (direct) return direct;
    const face = Array.isArray(card.card_faces) ? card.card_faces[0] : null;
    return pick(face?.image_uris);
}

// ─── Draft coord walking helpers ──────────────────────────────────────────────

function prevCoord(picks, coord) {
    if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
    const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
    if (idx <= 0) return coord;
    const prev = picks[idx - 1];
    return { pack: prev.pack, pick: prev.pick };
}

function nextCoord(picks, coord) {
    if (!Array.isArray(picks) || picks.length === 0 || !coord) return coord;
    const idx = picks.findIndex(p => p.pack === coord.pack && p.pick === coord.pick);
    if (idx === -1 || idx >= picks.length - 1) return coord;
    const next = picks[idx + 1];
    return { pack: next.pack, pick: next.pick };
}

// ─── Tier / rarity helpers ────────────────────────────────────────────────────

function gihWrTierClass(tier) {
    const map = {
        mythic: 'tier-mythic',
        gold:   'tier-gold',
        silver: 'tier-silver',
        black:  'tier-black',
        brown:  'tier-brown',
        none:   'tier-none',
    };
    return map[tier] ?? 'tier-none';
}

function colorPip(colorStr) {
    if (!colorStr) return `<span class="color-pip color-C" title="Colorless">◆</span>`;
    if (colorStr.length > 1) return `<span class="color-pip color-multi" title="${colorStr}">◆</span>`;
    const map = { W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };
    const key = map[colorStr] || 'C';
    return `<span class="color-pip color-${key}" title="${colorStr}">◆</span>`;
}

function rarityGem(rarity) {
    if (!rarity) return '';
    return `<span class="rarity-gem rarity-${rarity}" title="${rarityLabel(rarity)}"></span>`;
}

function rarityLabel(r) {
    return { C: 'Common', U: 'Uncommon', R: 'Rare', M: 'Mythic Rare' }[r] || r;
}

function rarityColor(r) {
    return {
        C: 'var(--tier-black)',
        U: 'var(--tier-silver)',
        R: 'var(--tier-gold)',
        M: 'var(--tier-mythic)',
    }[r] || 'var(--text-muted)';
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    _dotColor, _dotBorder, SPLASH_THRESHOLD,
    colorLabel, isSplashColor, getColorCombo, comboDotsHtml, renderMatchColorPips,
    draftCardColorPips, wheelIndicatorHtml,
    cardEyeballHtml, extractScryfallImageUrl,
    prevCoord, nextCoord,
    gihWrTierClass, colorPip, rarityGem, rarityLabel, rarityColor,
};
