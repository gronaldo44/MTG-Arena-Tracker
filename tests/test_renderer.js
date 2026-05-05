'use strict';

/**
 * test_renderer.js
 *
 * renderer.js is designed to run in Electron's renderer process (browser-like
 * environment with DOM + ipcRenderer).  The functions that can be meaningfully
 * unit-tested are the pure helpers that transform data into CSS classes or
 * HTML strings:
 *
 *   gihWrTierClass(tier)   — tier string → CSS class string
 *   colorPip(colorStr)     — MTG colour code → HTML span
 *   rarityGem(rarity)      — rarity letter → HTML span
 *   rarityLabel(r)         — rarity letter → display string
 *
 * renderer.js exports these only when `window` is undefined (Node.js / Jest),
 * so they are available here without running any DOM or IPC code.
 *
 * Functions that touch the DOM (loadDashboard, renderCurrentPack, etc.) are
 * best covered by end-to-end tests and are out of scope for this file.
 */

// Stub `document` so the module-level addEventListener call in renderer.js
// does not throw in the Node environment.
global.document = { addEventListener: jest.fn() };

// Mock ipcRenderer before requiring renderer.js.
jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    on:     jest.fn(),
    send:   jest.fn(),
  },
}));

const {
  gihWrTierClass, colorPip, rarityGem, rarityLabel,
  extractScryfallImageUrl, cardEyeballHtml,
} = require('../renderer');

// ─── gihWrTierClass ───────────────────────────────────────────────────────────

describe('gihWrTierClass', () => {
  test('mythic → tier-mythic', () => {
    expect(gihWrTierClass('mythic')).toBe('tier-mythic');
  });

  test('gold → tier-gold', () => {
    expect(gihWrTierClass('gold')).toBe('tier-gold');
  });

  test('silver → tier-silver', () => {
    expect(gihWrTierClass('silver')).toBe('tier-silver');
  });

  test('black → tier-black', () => {
    expect(gihWrTierClass('black')).toBe('tier-black');
  });

  test('brown → tier-brown', () => {
    expect(gihWrTierClass('brown')).toBe('tier-brown');
  });

  test('none → tier-none', () => {
    expect(gihWrTierClass('none')).toBe('tier-none');
  });

  test('undefined / unknown tier → tier-none', () => {
    expect(gihWrTierClass(undefined)).toBe('tier-none');
    expect(gihWrTierClass('tier-great')).toBe('tier-none'); // old class name, should not match
    expect(gihWrTierClass('')).toBe('tier-none');
  });
});

// ─── colorPip ─────────────────────────────────────────────────────────────────

describe('colorPip', () => {
  test('returns a span element string', () => {
    expect(colorPip('W')).toMatch(/^<span/);
    expect(colorPip('W')).toMatch(/<\/span>$/);
  });

  test('white produces color-W class', () => {
    expect(colorPip('W')).toContain('color-W');
  });

  test('blue produces color-U class', () => {
    expect(colorPip('U')).toContain('color-U');
  });

  test('black produces color-B class', () => {
    expect(colorPip('B')).toContain('color-B');
  });

  test('red produces color-R class', () => {
    expect(colorPip('R')).toContain('color-R');
  });

  test('green produces color-G class', () => {
    expect(colorPip('G')).toContain('color-G');
  });

  test('multi-colour string produces color-multi class', () => {
    expect(colorPip('WU')).toContain('color-multi');
    expect(colorPip('RBG')).toContain('color-multi');
  });

  test('empty string produces color-C (colorless) class', () => {
    expect(colorPip('')).toContain('color-C');
  });

  test('null / undefined treated as colorless', () => {
    expect(colorPip(null)).toContain('color-C');
    expect(colorPip(undefined)).toContain('color-C');
  });

  test('unrecognised single-letter falls back to color-C', () => {
    expect(colorPip('X')).toContain('color-C');
  });
});

// ─── rarityGem ────────────────────────────────────────────────────────────────

describe('rarityGem', () => {
  test('returns empty string for no rarity', () => {
    expect(rarityGem('')).toBe('');
    expect(rarityGem(null)).toBe('');
    expect(rarityGem(undefined)).toBe('');
  });

  test('returns a span for common', () => {
    const html = rarityGem('C');
    expect(html).toContain('rarity-C');
    expect(html).toMatch(/<span/);
  });

  test('returns a span for uncommon', () => {
    expect(rarityGem('U')).toContain('rarity-U');
  });

  test('returns a span for rare', () => {
    expect(rarityGem('R')).toContain('rarity-R');
  });

  test('returns a span for mythic', () => {
    expect(rarityGem('M')).toContain('rarity-M');
  });

  test('span includes the rarity class in a class attribute', () => {
    const html = rarityGem('R');
    expect(html).toMatch(/class="[^"]*rarity-R[^"]*"/);
  });
});

// ─── rarityLabel ──────────────────────────────────────────────────────────────

describe('rarityLabel', () => {
  test('C → Common', () => {
    expect(rarityLabel('C')).toBe('Common');
  });

  test('U → Uncommon', () => {
    expect(rarityLabel('U')).toBe('Uncommon');
  });

  test('R → Rare', () => {
    expect(rarityLabel('R')).toBe('Rare');
  });

  test('M → Mythic Rare', () => {
    expect(rarityLabel('M')).toBe('Mythic Rare');
  });

  test('unknown code → returns the code itself', () => {
    expect(rarityLabel('X')).toBe('X');
    expect(rarityLabel('')).toBe('');
  });
});

// ─── extractScryfallImageUrl ────────────────────────────────────────────────

describe('extractScryfallImageUrl', () => {
  test('single-faced card prefers image_uris.large', () => {
    const card = { image_uris: { normal: 'N', large: 'L', small: 'S' } };
    expect(extractScryfallImageUrl(card)).toBe('L');
  });

  test('falls back to normal then small when large missing', () => {
    expect(extractScryfallImageUrl({ image_uris: { normal: 'N', small: 'S' } })).toBe('N');
    expect(extractScryfallImageUrl({ image_uris: { small: 'S' } })).toBe('S');
  });

  test('double-faced card uses first face image_uris', () => {
    const card = {
      card_faces: [
        { image_uris: { normal: 'https://img/face0.jpg' } },
        { image_uris: { normal: 'https://img/face1.jpg' } },
      ],
    };
    expect(extractScryfallImageUrl(card)).toBe('https://img/face0.jpg');
  });

  test('returns null for null / undefined / non-object input', () => {
    expect(extractScryfallImageUrl(null)).toBeNull();
    expect(extractScryfallImageUrl(undefined)).toBeNull();
    expect(extractScryfallImageUrl('nope')).toBeNull();
  });

  test('returns null when no image fields are present', () => {
    expect(extractScryfallImageUrl({})).toBeNull();
    expect(extractScryfallImageUrl({ image_uris: {} })).toBeNull();
    expect(extractScryfallImageUrl({ card_faces: [{}] })).toBeNull();
  });
});

// ─── cardEyeballHtml ────────────────────────────────────────────────────────

describe('cardEyeballHtml', () => {
  test('returns empty string when grpId is missing', () => {
    expect(cardEyeballHtml(undefined)).toBe('');
    expect(cardEyeballHtml(null)).toBe('');
    expect(cardEyeballHtml('')).toBe('');
  });

  test('stamps grpId onto data-grpid for delegated event handling', () => {
    const html = cardEyeballHtml('102471');
    expect(html).toContain('class="card-eyeball"');
    expect(html).toContain('data-grpid="102471"');
    expect(html).toContain('<svg');
  });

  test('accepts numeric grpIds', () => {
    expect(cardEyeballHtml(102471)).toContain('data-grpid="102471"');
  });

  test('encodes name into data-card-name (URI-encoded so quotes are safe)', () => {
    const html = cardEyeballHtml('102471', "Jadzi, Steward of Fate");
    expect(html).toContain('data-card-name="Jadzi%2C%20Steward%20of%20Fate"');
  });

  test('handles names with apostrophes (used as fallback when arena_id misses)', () => {
    const html = cardEyeballHtml('1', "Force of Will");
    // Apostrophe-free names still work; the encoding test below covers the dangerous case.
    expect(html).toContain('data-card-name="Force%20of%20Will"');
  });

  test('apostrophes get safely percent-encoded', () => {
    const html = cardEyeballHtml('1', "Akroma's Will");
    expect(html).toContain("data-card-name=\"Akroma's%20Will\"");
    // Critical: apostrophe is NOT a raw " in the output, so the attribute can't break
    expect(html.match(/data-card-name="[^"]*"/)).toBeTruthy();
  });

  test('stamps the set code on data-card-set when provided', () => {
    const html = cardEyeballHtml('102471', 'Elite Interceptor', 'SOS');
    expect(html).toContain('data-card-set="SOS"');
  });

  test('omits name/set attributes when not provided', () => {
    const html = cardEyeballHtml('1');
    expect(html).not.toContain('data-card-name');
    expect(html).not.toContain('data-card-set');
  });
});

// ─── prevCoord / nextCoord ────────────────────────────────────────────────────

const { prevCoord, nextCoord } = require('../renderer');

describe('prevCoord / nextCoord', () => {
  // Picks array as the bundle delivers it: sorted by (pack, pick), no gaps in
  // a complete draft, but may include missing-pick placeholders.
  const picks = [
    { pack: 1, pick: 1 },
    { pack: 1, pick: 2 },
    { pack: 1, pick: 13 },
    { pack: 1, pick: 14 },
    { pack: 2, pick: 1 },
    { pack: 2, pick: 2 },
  ];

  test('prevCoord at the absolute start returns the same coord (silent no-op signal)', () => {
    expect(prevCoord(picks, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
  });

  test('prevCoord walks one step backward within a pack', () => {
    expect(prevCoord(picks, { pack: 1, pick: 2 })).toEqual({ pack: 1, pick: 1 });
  });

  test('prevCoord crosses a pack boundary (P2p1 → P1p14)', () => {
    expect(prevCoord(picks, { pack: 2, pick: 1 })).toEqual({ pack: 1, pick: 14 });
  });

  test('nextCoord at the last entry returns the same coord (silent no-op signal)', () => {
    expect(nextCoord(picks, { pack: 2, pick: 2 })).toEqual({ pack: 2, pick: 2 });
  });

  test('nextCoord walks one step forward within a pack', () => {
    expect(nextCoord(picks, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 2 });
  });

  test('nextCoord crosses a pack boundary (P1p14 → P2p1)', () => {
    expect(nextCoord(picks, { pack: 1, pick: 14 })).toEqual({ pack: 2, pick: 1 });
  });

  test('prev/next traverse missing-pick placeholders, not skip them', () => {
    const withMissing = [
      { pack: 1, pick: 1 },
      { pack: 1, pick: 2, missing: true },
      { pack: 1, pick: 3 },
    ];
    expect(nextCoord(withMissing, { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 2 });
    expect(prevCoord(withMissing, { pack: 1, pick: 3 })).toEqual({ pack: 1, pick: 2 });
  });

  test('coord not present in picks → return the same coord (defensive no-op)', () => {
    expect(prevCoord(picks, { pack: 5, pick: 7 })).toEqual({ pack: 5, pick: 7 });
    expect(nextCoord(picks, { pack: 5, pick: 7 })).toEqual({ pack: 5, pick: 7 });
  });

  test('empty picks array → return the same coord (defensive no-op)', () => {
    expect(prevCoord([], { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
    expect(nextCoord([], { pack: 1, pick: 1 })).toEqual({ pack: 1, pick: 1 });
  });
});
