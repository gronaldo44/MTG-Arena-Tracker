'use strict';

const { extractScryfallImageUrl } = require('./shared');

// ─── Cache ────────────────────────────────────────────────────────────────────

const _cardImageCache = new Map(); // grpId (string) → Promise<string|null>

// ─── Fetching ─────────────────────────────────────────────────────────────────

async function _scryfallFetch(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

function fetchCardImageUrl(grpId, name, setCode) {
    const key = String(grpId);
    if (_cardImageCache.has(key)) return _cardImageCache.get(key);

    const promise = (async () => {
        let card = await _scryfallFetch(`https://api.scryfall.com/cards/arena/${encodeURIComponent(key)}`);
        let url = extractScryfallImageUrl(card);
        if (url) return url;

        if (name) {
            if (setCode) {
                const params = new URLSearchParams({ exact: name, set: setCode.toLowerCase() });
                card = await _scryfallFetch(`https://api.scryfall.com/cards/named?${params.toString()}`);
                url = extractScryfallImageUrl(card);
                if (url) return url;
            }
            const params = new URLSearchParams({ fuzzy: name });
            card = await _scryfallFetch(`https://api.scryfall.com/cards/named?${params.toString()}`);
            url = extractScryfallImageUrl(card);
            if (url) return url;
        }
        return null;
    })();

    _cardImageCache.set(key, promise);
    return promise;
}

// ─── Preview element ──────────────────────────────────────────────────────────

let _previewEl = null;

function ensurePreviewEl() {
    if (_previewEl || typeof document === 'undefined' || !document.body) return _previewEl;
    _previewEl = document.createElement('div');
    _previewEl.id = 'card-image-preview';
    _previewEl.style.display = 'none';
    document.body.appendChild(_previewEl);
    return _previewEl;
}

function positionPreview(anchor) {
    if (!_previewEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const previewWidth = 260;
    const margin = 8;
    let left = rect.right + margin;
    if (left + previewWidth > window.innerWidth) {
        left = rect.left - previewWidth - margin;
    }
    if (left < margin) left = margin;
    let top = rect.top - 20;
    if (top < margin) top = margin;
    _previewEl.style.left = `${left}px`;
    _previewEl.style.top  = `${top}px`;
}

let _previewToken = 0;

async function showCardPreview(anchor, grpId, name, setCode) {
    const el = ensurePreviewEl();
    if (!el) return;
    const myToken = ++_previewToken;
    el.innerHTML = '<div class="card-image-preview-loading">Loading…</div>';
    el.style.display = 'block';
    positionPreview(anchor);
    const url = await fetchCardImageUrl(grpId, name, setCode);
    if (myToken !== _previewToken) return;
    if (url) {
        el.innerHTML = `<img src="${url}" alt="card preview" />`;
    } else {
        el.innerHTML = '<div class="card-image-preview-empty">No Scryfall image.</div>';
    }
}

function hideCardPreview() {
    _previewToken++;
    if (_previewEl) _previewEl.style.display = 'none';
}

// ─── Delegated event listeners ────────────────────────────────────────────────

function initCardPreview() {
    if (typeof document === 'undefined') return;
    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest && e.target.closest('.card-eyeball');
        if (!target) return;
        const grpId = target.dataset.grpid;
        if (!grpId) return;
        const name    = target.dataset.cardName ? decodeURIComponent(target.dataset.cardName) : null;
        const setCode = target.dataset.cardSet || null;
        showCardPreview(target, grpId, name, setCode);
    });
    document.addEventListener('mouseout', (e) => {
        const target = e.target.closest && e.target.closest('.card-eyeball');
        if (!target) return;
        if (e.relatedTarget && target.contains(e.relatedTarget)) return;
        hideCardPreview();
    });
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    _cardImageCache,
    fetchCardImageUrl,
    showCardPreview,
    hideCardPreview,
    initCardPreview,
};
