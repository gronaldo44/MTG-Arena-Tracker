'use strict';

// ─── Environment stubs ────────────────────────────────────────────────────────

let mockIconEl;
let mockNavEl;

global.document = {
    addEventListener: jest.fn(),
    getElementById:   jest.fn(),
    querySelectorAll: jest.fn(() => []),
};

jest.mock('electron', () => ({
    ipcRenderer: { invoke: jest.fn(), on: jest.fn(), send: jest.fn() },
}));

// ─── State mock ───────────────────────────────────────────────────────────────

jest.mock('../renderer/state', () => ({
    bundle:       null,
    draftList:    [],
    currentPage:  'dashboard',
    viewingCoord: null,
    liveDraftId:  null,
}));

const state = require('../renderer/state');
const { updateDeckBuilderNotice } = require('../renderer');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const settledPick = (id = 1) => ({ missing: false, picked: id });
const missingPick = ()        => ({ missing: true,  picked: null });
const pendingPick = ()        => ({ missing: false,  picked: null });

function make42Picks(overrides = []) {
    const picks = Array.from({ length: 42 }, (_, i) => settledPick(i + 1));
    overrides.forEach(({ index, pick }) => { picks[index] = pick; });
    return picks;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    mockIconEl = { classList: { toggle: jest.fn() } };
    mockNavEl  = { querySelector: jest.fn(() => mockIconEl) };

    document.getElementById.mockImplementation(id =>
        id === 'nav-deckbuilder' ? mockNavEl : null
    );

    state.bundle    = null;
    state.draftList = [];
});

// ─── DOM guard ────────────────────────────────────────────────────────────────

describe('updateDeckBuilderNotice — DOM guards', () => {
    test('missing nav element → returns without throwing', () => {
        document.getElementById.mockReturnValueOnce(null);
        expect(() => updateDeckBuilderNotice()).not.toThrow();
    });

    test('missing icon element → returns without throwing', () => {
        mockNavEl.querySelector.mockReturnValueOnce(null);
        state.bundle    = { draftId: 'a', picks: make42Picks() };
        state.draftList = [{ draftId: 'a' }];
        expect(() => updateDeckBuilderNotice()).not.toThrow();
    });
});

// ─── No bundle ────────────────────────────────────────────────────────────────

describe('updateDeckBuilderNotice — no bundle', () => {
    test('no bundle → db-ready is off', () => {
        state.bundle = null;
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });

    test('empty draftList with no bundle → db-ready is off', () => {
        state.bundle    = null;
        state.draftList = [];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });
});

// ─── Not the latest draft ─────────────────────────────────────────────────────

describe('updateDeckBuilderNotice — older draft selected', () => {
    test('selected draft is not first in draftList → db-ready is off', () => {
        state.bundle    = { draftId: 'older', picks: make42Picks() };
        state.draftList = [{ draftId: 'newest' }, { draftId: 'older' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });

    test('older draft with all 42 picks settled still produces no highlight', () => {
        state.bundle    = { draftId: 'draft-1', picks: make42Picks() };
        state.draftList = [{ draftId: 'draft-3' }, { draftId: 'draft-2' }, { draftId: 'draft-1' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });
});

// ─── Incomplete draft ─────────────────────────────────────────────────────────

describe('updateDeckBuilderNotice — draft not yet complete', () => {
    test('latest draft with fewer than 42 picks → db-ready is off', () => {
        state.bundle    = { draftId: 'live', picks: Array.from({ length: 30 }, (_, i) => settledPick(i)) };
        state.draftList = [{ draftId: 'live' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });

    test('latest draft with 41 picks → db-ready is off', () => {
        const picks = Array.from({ length: 41 }, (_, i) => settledPick(i));
        state.bundle    = { draftId: 'live', picks };
        state.draftList = [{ draftId: 'live' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });

    test('latest draft with 42 picks but one still pending → db-ready is off', () => {
        state.bundle    = { draftId: 'live', picks: make42Picks([{ index: 41, pick: pendingPick() }]) };
        state.draftList = [{ draftId: 'live' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });

    test('zero picks (fresh live draft) → db-ready is off', () => {
        state.bundle    = { draftId: 'live', picks: [] };
        state.draftList = [{ draftId: 'live' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', false);
    });
});

// ─── Complete draft ───────────────────────────────────────────────────────────

describe('updateDeckBuilderNotice — complete draft', () => {
    test('latest draft with all 42 picks settled → db-ready is on', () => {
        state.bundle    = { draftId: 'latest', picks: make42Picks() };
        state.draftList = [{ draftId: 'latest' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', true);
    });

    test('latest draft with some missing picks (all 42 slots filled) → db-ready is on', () => {
        const picks = make42Picks([
            { index: 3,  pick: missingPick() },
            { index: 17, pick: missingPick() },
        ]);
        state.bundle    = { draftId: 'latest', picks };
        state.draftList = [{ draftId: 'latest' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', true);
    });

    test('latest draft where all 42 picks are missing → db-ready is on', () => {
        const picks = Array.from({ length: 42 }, missingPick);
        state.bundle    = { draftId: 'latest', picks };
        state.draftList = [{ draftId: 'latest' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', true);
    });

    test('latest when multiple drafts exist → db-ready is on only for newest', () => {
        state.bundle    = { draftId: 'newest', picks: make42Picks() };
        state.draftList = [{ draftId: 'newest' }, { draftId: 'older' }];
        updateDeckBuilderNotice();
        expect(mockIconEl.classList.toggle).toHaveBeenCalledWith('db-ready', true);
    });
});
