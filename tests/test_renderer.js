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

const { gihWrTierClass, colorPip, rarityGem, rarityLabel } = require('../renderer');

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
