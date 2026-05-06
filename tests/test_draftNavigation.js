'use strict';

/**
 * test_draftNavigation.js
 *
 * Tests for the five pack-navigation buttons and their button-state helper:
 *
 *   navPrevPick   — same as pressing ←
 *   navNextPick   — same as pressing →
 *   navCurrent    — jump to liveCoord of the newest draft
 *   navPrevDraft  — load the next-older draft (higher index in draftList)
 *   navNextDraft  — load the next-newer draft (lower index in draftList)
 *   updateNavButtons — sets .disabled and .at-live on the five button elements
 *
 * draftAssistant.js runs in Electron's renderer process and calls
 * document.getElementById extensively inside renderDraftPage / updateNavButtons.
 * We provide a universal DOM stub that returns a minimal fake element for every
 * id so the module can be loaded without crashing.
 */

// ─── Mock electron BEFORE any require ────────────────────────────────────────

jest.mock('electron', () => ({
  ipcRenderer: {
    invoke: jest.fn(),
    on:     jest.fn(),
    send:   jest.fn(),
  },
}));

const { ipcRenderer } = require('electron');

// ─── Universal DOM stub ───────────────────────────────────────────────────────

function makeMockEl() {
  return {
    disabled:    false,
    style:       { display: '' },
    textContent: '',
    innerHTML:   '',
    value:       '',
    classList: {
      toggle:   jest.fn(),
      remove:   jest.fn(),
      add:      jest.fn(),
      contains: jest.fn(() => false),
    },
  };
}

// Elements are keyed by id and reused across calls so tests can inspect them.
const _elements = {};

global.document = {
  getElementById:   jest.fn(id => (_elements[id] = _elements[id] || makeMockEl())),
  querySelectorAll: jest.fn(() => []),
  addEventListener: jest.fn(),
};

// ─── Module under test (loaded after DOM stub is in place) ────────────────────

const state       = require('../renderer/state');
const draftAssist = require('../renderer/draftAssistant');

const {
  navPrevPick, navNextPick, navCurrent,
  navPrevDraft, navNextDraft,
} = draftAssist;

// updateNavButtons is not in the public exports — call it via a round-trip
// through renderDraftPage (which calls it internally).  For direct assertion
// we pull the internal reference through a tiny shim.
// It IS exported from the module (added in the same commit), so:
// eslint-disable-next-line prefer-destructuring
const updateNavButtons = draftAssist.updateNavButtons;

// ─── Shared test helpers ──────────────────────────────────────────────────────

const mkCard = id => ({
  arena_id: id, name: `Card ${id}`, gihWr: null,
  tier: 'none', lowSample: false, stats: null, manaCost: '',
});

function makeBundle(opts = {}) {
  const picks = opts.picks || [
    { pack: 1, pick: 1, options: [mkCard(101)], picked: 101 },
    { pack: 1, pick: 2, options: [mkCard(102)], picked: null },
  ];
  const liveCoord = opts.liveCoord
    || { pack: picks[picks.length - 1].pack, pick: picks[picks.length - 1].pick };
  return {
    draftId:         opts.draftId    || 'draft-1',
    startedAt:       opts.startedAt  || 1000,
    picks,
    liveCoord,
    assistantLoaded: true,
    assistantStatus: { loaded: true },
  };
}

function resetEl(id) {
  const el = _elements[id];
  if (!el) return;
  el.disabled = false;
  el.classList.toggle.mockClear();
  el.classList.remove.mockClear();
  el.classList.add.mockClear();
}

const NAV_IDS = [
  'draft-nav-prev-draft', 'draft-nav-prev-pick',
  'draft-nav-current',
  'draft-nav-next-pick',  'draft-nav-next-draft',
];

// ─── navPrevPick ──────────────────────────────────────────────────────────────

describe('navPrevPick', () => {
  beforeEach(() => {
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue(makeBundle());
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1000, pickCount: 2 }];
    state.bundle       = makeBundle();
    state.viewingCoord = { pack: 1, pick: 2 };
  });

  test('steps back one pick', () => {
    navPrevPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 1 });
  });

  test('no-op when already at the first pick', () => {
    state.viewingCoord = { pack: 1, pick: 1 };
    navPrevPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 1 });
  });

  test('crosses a pack boundary (P2p1 → P1p14)', () => {
    const picks = [
      { pack: 1, pick: 14, options: [mkCard(110)], picked: 110 },
      { pack: 2, pick: 1,  options: [mkCard(200)], picked: null },
    ];
    state.bundle       = makeBundle({ picks, liveCoord: { pack: 2, pick: 1 } });
    state.viewingCoord = { pack: 2, pick: 1 };
    navPrevPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 14 });
  });

  test('no-op when bundle is null', () => {
    state.bundle = null;
    state.viewingCoord = { pack: 1, pick: 1 };
    navPrevPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 1 });
  });

  test('no-op when viewingCoord is null', () => {
    state.viewingCoord = null;
    navPrevPick(); // must not throw
    expect(state.viewingCoord).toBeNull();
  });
});

// ─── navNextPick ──────────────────────────────────────────────────────────────

describe('navNextPick', () => {
  beforeEach(() => {
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue(makeBundle());
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1000, pickCount: 2 }];
    state.bundle       = makeBundle();
    state.viewingCoord = { pack: 1, pick: 1 };
  });

  test('steps forward one pick', () => {
    navNextPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 2 });
  });

  test('no-op when already at the last pick', () => {
    state.viewingCoord = { pack: 1, pick: 2 };
    navNextPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 2 });
  });

  test('crosses a pack boundary (P1p14 → P2p1)', () => {
    const picks = [
      { pack: 1, pick: 14, options: [mkCard(110)], picked: 110 },
      { pack: 2, pick: 1,  options: [mkCard(200)], picked: null },
    ];
    state.bundle       = makeBundle({ picks, liveCoord: { pack: 2, pick: 1 } });
    state.viewingCoord = { pack: 1, pick: 14 };
    navNextPick();
    expect(state.viewingCoord).toEqual({ pack: 2, pick: 1 });
  });

  test('no-op when bundle is null', () => {
    state.bundle = null;
    state.viewingCoord = { pack: 1, pick: 1 };
    navNextPick();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 1 });
  });
});

// ─── navCurrent ───────────────────────────────────────────────────────────────

describe('navCurrent', () => {
  const latestBundle = makeBundle({ draftId: 'newest', startedAt: 2000, liveCoord: { pack: 3, pick: 14 } });
  const olderBundle  = makeBundle({ draftId: 'older',  startedAt: 1000, liveCoord: { pack: 2, pick: 7  } });

  beforeEach(() => {
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockImplementation((channel) =>
      channel === 'view-draft-record' ? Promise.resolve(latestBundle) : Promise.resolve(null)
    );
    state.draftList = [
      { draftId: 'newest', startedAt: 2000, pickCount: 42 },
      { draftId: 'older',  startedAt: 1000, pickCount: 42 },
    ];
  });

  test('on latest draft, not at liveCoord: jumps to liveCoord without IPC', async () => {
    state.bundle       = latestBundle;
    state.viewingCoord = { pack: 1, pick: 1 };
    await navCurrent();
    expect(state.viewingCoord).toEqual({ pack: 3, pick: 14 });
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('already at liveCoord of latest draft: state unchanged, no IPC', async () => {
    state.bundle       = latestBundle;
    state.viewingCoord = { pack: 3, pick: 14 };
    await navCurrent();
    expect(state.viewingCoord).toEqual({ pack: 3, pick: 14 });
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('on older draft: calls view-draft-record with the latest draftId', async () => {
    state.bundle       = olderBundle;
    state.viewingCoord = { pack: 1, pick: 1 };
    await navCurrent();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('view-draft-record', 'newest');
  });

  test('on older draft: bundle and viewingCoord switch to the latest draft', async () => {
    state.bundle       = olderBundle;
    state.viewingCoord = { pack: 1, pick: 1 };
    await navCurrent();
    expect(state.bundle.draftId).toBe('newest');
    expect(state.viewingCoord).toEqual(latestBundle.liveCoord);
  });

  test('no-op when draftList is empty', async () => {
    state.draftList    = [];
    state.bundle       = latestBundle;
    state.viewingCoord = { pack: 1, pick: 1 };
    await navCurrent();
    expect(state.viewingCoord).toEqual({ pack: 1, pick: 1 });
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});

// ─── navPrevDraft ─────────────────────────────────────────────────────────────
// draftList is newest-first (index 0 = newest).
// navPrevDraft goes to a higher index (older draft).

describe('navPrevDraft', () => {
  const oldestBundle = makeBundle({ draftId: 'draft-1', startedAt: 1000 });

  beforeEach(() => {
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue(oldestBundle);
    state.draftList = [
      { draftId: 'draft-3', startedAt: 3000, pickCount: 10 },
      { draftId: 'draft-2', startedAt: 2000, pickCount: 10 },
      { draftId: 'draft-1', startedAt: 1000, pickCount: 10 },
    ];
  });

  test('from newest draft: loads the next-older draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-3' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navPrevDraft();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('view-draft-record', 'draft-2');
  });

  test('from middle draft: loads the next-older draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-2' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navPrevDraft();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('view-draft-record', 'draft-1');
  });

  test('no-op when already at the oldest draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-1' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navPrevDraft();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('no-op when draftList is empty', async () => {
    state.draftList = [];
    state.bundle    = makeBundle({ draftId: 'draft-1' });
    await navPrevDraft();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});

// ─── navNextDraft ─────────────────────────────────────────────────────────────
// navNextDraft goes to a lower index (newer draft).

describe('navNextDraft', () => {
  const newestBundle = makeBundle({ draftId: 'draft-3', startedAt: 3000 });

  beforeEach(() => {
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue(newestBundle);
    state.draftList = [
      { draftId: 'draft-3', startedAt: 3000, pickCount: 10 },
      { draftId: 'draft-2', startedAt: 2000, pickCount: 10 },
      { draftId: 'draft-1', startedAt: 1000, pickCount: 10 },
    ];
  });

  test('from oldest draft: loads the next-newer draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-1' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navNextDraft();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('view-draft-record', 'draft-2');
  });

  test('from middle draft: loads the next-newer draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-2' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navNextDraft();
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('view-draft-record', 'draft-3');
  });

  test('no-op when already at the newest draft', async () => {
    state.bundle       = makeBundle({ draftId: 'draft-3' });
    state.viewingCoord = { pack: 1, pick: 1 };
    await navNextDraft();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });

  test('no-op when draftList is empty', async () => {
    state.draftList = [];
    state.bundle    = makeBundle({ draftId: 'draft-3' });
    await navNextDraft();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });
});

// ─── updateNavButtons ─────────────────────────────────────────────────────────

describe('updateNavButtons', () => {
  function el(id) {
    return _elements[id] || (_elements[id] = makeMockEl());
  }

  const twoPicks = [
    { pack: 1, pick: 1, options: [mkCard(101)], picked: 101 },
    { pack: 1, pick: 2, options: [mkCard(102)], picked: null },
  ];

  beforeEach(() => {
    NAV_IDS.forEach(resetEl);
    ipcRenderer.invoke.mockClear();
    ipcRenderer.invoke.mockResolvedValue(null);
  });

  // ── << prev-draft ──────────────────────────────────────────────────────────

  test('<< disabled when on the oldest draft (last index)', () => {
    state.draftList    = [{ draftId: 'new', startedAt: 2 }, { draftId: 'old', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'old', picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-prev-draft').disabled).toBe(true);
  });

  test('<< enabled when not on the oldest draft', () => {
    state.draftList    = [{ draftId: 'new', startedAt: 2 }, { draftId: 'old', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'new', picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-prev-draft').disabled).toBe(false);
  });

  // ── >> next-draft ──────────────────────────────────────────────────────────

  test('>> disabled when on the newest draft (index 0)', () => {
    state.draftList    = [{ draftId: 'new', startedAt: 2 }, { draftId: 'old', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'new', picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-next-draft').disabled).toBe(true);
  });

  test('>> enabled when not on the newest draft', () => {
    state.draftList    = [{ draftId: 'new', startedAt: 2 }, { draftId: 'old', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'old', picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-next-draft').disabled).toBe(false);
  });

  // ── < prev-pick ────────────────────────────────────────────────────────────

  test('< disabled at the first pick', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-prev-pick').disabled).toBe(true);
  });

  test('< enabled when not at the first pick', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 2 };
    updateNavButtons();
    expect(el('draft-nav-prev-pick').disabled).toBe(false);
  });

  // ── > next-pick ────────────────────────────────────────────────────────────

  test('> disabled at the last pick', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 2 };
    updateNavButtons();
    expect(el('draft-nav-next-pick').disabled).toBe(true);
  });

  test('> enabled when not at the last pick', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ picks: twoPicks });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-next-pick').disabled).toBe(false);
  });

  // ── Current / at-live ──────────────────────────────────────────────────────

  test('Current gets at-live when on newest draft at its liveCoord', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'draft-1', picks: twoPicks, liveCoord: { pack: 1, pick: 2 } });
    state.viewingCoord = { pack: 1, pick: 2 };
    updateNavButtons();
    expect(el('draft-nav-current').classList.toggle)
      .toHaveBeenCalledWith('at-live', true);
  });

  test('Current does NOT get at-live when on newest draft but not at liveCoord', () => {
    state.draftList    = [{ draftId: 'draft-1', startedAt: 1 }];
    state.bundle       = makeBundle({ draftId: 'draft-1', picks: twoPicks, liveCoord: { pack: 1, pick: 2 } });
    state.viewingCoord = { pack: 1, pick: 1 };
    updateNavButtons();
    expect(el('draft-nav-current').classList.toggle)
      .toHaveBeenCalledWith('at-live', false);
  });

  test('Current does NOT get at-live when on an older draft even at its liveCoord', () => {
    state.draftList    = [
      { draftId: 'newest', startedAt: 2 },
      { draftId: 'older',  startedAt: 1 },
    ];
    state.bundle       = makeBundle({ draftId: 'older', picks: twoPicks, liveCoord: { pack: 1, pick: 2 } });
    state.viewingCoord = { pack: 1, pick: 2 };
    updateNavButtons();
    expect(el('draft-nav-current').classList.toggle)
      .toHaveBeenCalledWith('at-live', false);
  });

  test('all pick buttons disabled and at-live removed when no bundle is loaded', () => {
    state.bundle       = null;
    state.viewingCoord = null;
    state.draftList    = [];
    updateNavButtons();
    expect(el('draft-nav-prev-pick').disabled).toBe(true);
    expect(el('draft-nav-next-pick').disabled).toBe(true);
    expect(el('draft-nav-current').disabled).toBe(true);
    expect(el('draft-nav-current').classList.remove).toHaveBeenCalledWith('at-live');
  });
});
