'use strict';

// ─── DOM stub ────────────────────────────────────────────────────────────────

let mockContainer = { innerHTML: '' };
const mockSortBtn = { classList: { add: jest.fn(), remove: jest.fn() } };

global.document = {
    addEventListener: jest.fn(),
    getElementById:   jest.fn(),
    querySelectorAll: jest.fn(),
};

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('../renderer/state', () => ({
    bundle: null,
}));

jest.mock('../renderer/shared', () => ({
    draftCardColorPips: () => '<span>pip</span>',
    gihWrTierClass:     () => 'tier-none',
    cardEyeballHtml:    () => '',
}));

const state = require('../renderer/state');
const {
    cardColorKeys,
    renderColorTables,
    setColorTableSort,
    setColorTableSearch,
} = require('../renderer/deckBuilder/colorPool');

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makePick(cardOverrides = {}, pickOverrides = {}) {
    return {
        missing:    false,
        picked:     1,
        pack:       1,
        pick:       1,
        pickedCard: {
            name:     'Test Card',
            color:    'W',
            manaCost: '{W}',
            gihWr:    0.60,
            tier:     'gold',
            arena_id: 123,
            ...cardOverrides,
        },
        ...pickOverrides,
    };
}

beforeEach(() => {
    mockContainer = { innerHTML: '' };
    document.getElementById.mockImplementation(id => {
        if (id === 'color-pool-container') return mockContainer;
        return mockSortBtn;
    });
    document.querySelectorAll.mockReturnValue([]);
    mockSortBtn.classList.add.mockClear();
    mockSortBtn.classList.remove.mockClear();

    state.bundle = null;

    // Reset sort and search to module defaults before each test.
    setColorTableSort('gihWr');
    setColorTableSearch('');
});

// ─── cardColorKeys ────────────────────────────────────────────────────────────

describe('cardColorKeys', () => {
    test('each mono-color card returns a single-element array', () => {
        expect(cardColorKeys({ color: 'W' })).toEqual(['W']);
        expect(cardColorKeys({ color: 'U' })).toEqual(['U']);
        expect(cardColorKeys({ color: 'B' })).toEqual(['B']);
        expect(cardColorKeys({ color: 'R' })).toEqual(['R']);
        expect(cardColorKeys({ color: 'G' })).toEqual(['G']);
    });

    test('multi-color card returns all relevant color keys in WUBRG order', () => {
        expect(cardColorKeys({ color: 'WU' })).toEqual(['W', 'U']);
        expect(cardColorKeys({ color: 'BG' })).toEqual(['B', 'G']);
        expect(cardColorKeys({ color: 'WUBRG' })).toEqual(['W', 'U', 'B', 'R', 'G']);
    });

    test('falls back to manaCost when color field is absent', () => {
        expect(cardColorKeys({ color: '',   manaCost: '{R}{R}'   })).toEqual(['R']);
        expect(cardColorKeys({ color: '',   manaCost: '{W}{U}'   })).toEqual(['W', 'U']);
        expect(cardColorKeys({ color: null, manaCost: '{1}{G}{G}' })).toEqual(['G']);
    });

    test('colorless artifact (no color, generic mana only) → Colorless', () => {
        expect(cardColorKeys({ color: '', manaCost: '{3}' })).toEqual(['C']);
    });

    test('land card (no color, no mana cost) → Colorless', () => {
        expect(cardColorKeys({ color: '',   manaCost: ''   })).toEqual(['C']);
        expect(cardColorKeys({ color: '',   manaCost: null })).toEqual(['C']);
        expect(cardColorKeys({ color: null, manaCost: null })).toEqual(['C']);
    });
});

// ─── renderColorTables ────────────────────────────────────────────────────────

describe('renderColorTables', () => {
    test('no container element → returns without throwing', () => {
        document.getElementById.mockReturnValueOnce(null);
        expect(() => renderColorTables()).not.toThrow();
    });

    test('no bundle → shows "No picks" message', () => {
        state.bundle = null;
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('No picks');
    });

    test('empty picks array → shows "No picks" message', () => {
        state.bundle = { picks: [] };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('No picks');
    });

    test('all picks marked missing → shows "No picks" message', () => {
        state.bundle = { picks: [{ missing: true }] };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('No picks');
    });

    test('renders a group header and card count for a color that has picks', () => {
        state.bundle = { picks: [makePick({ color: 'W', name: 'Serra Angel' })] };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('White');
        expect(mockContainer.innerHTML).toContain('Serra Angel');
        expect(mockContainer.innerHTML).toContain('(1)');
    });

    test('renders card name in the output HTML', () => {
        state.bundle = { picks: [makePick({ color: 'R', name: 'Lightning Bolt' })] };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('Lightning Bolt');
    });

    test('multi-color card appears in each of its color groups', () => {
        state.bundle = {
            picks: [makePick({ color: 'WU', name: 'Teferi', manaCost: '{W}{U}' })],
        };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('White');
        expect(mockContainer.innerHTML).toContain('Blue');
        // Card appears in two separate color-pool-group divs (class="color-pool-group" once per group)
        const groupCount = (mockContainer.innerHTML.match(/class="color-pool-group"/g) || []).length;
        expect(groupCount).toBe(2);
    });

    test('land card (no color, no mana cost) appears in the Colorless group', () => {
        state.bundle = {
            picks: [makePick({ color: '', manaCost: '', name: 'Forest' })],
        };
        renderColorTables();
        expect(mockContainer.innerHTML).toContain('Colorless');
        expect(mockContainer.innerHTML).toContain('Forest');
    });

    test('color groups with zero cards are not rendered', () => {
        state.bundle = { picks: [makePick({ color: 'W', name: 'White Card' })] };
        renderColorTables();
        expect(mockContainer.innerHTML).not.toContain('>Blue<');
        expect(mockContainer.innerHTML).not.toContain('>Black<');
        expect(mockContainer.innerHTML).not.toContain('>Red<');
        expect(mockContainer.innerHTML).not.toContain('>Green<');
        expect(mockContainer.innerHTML).not.toContain('>Colorless<');
    });

    test('groups are ordered by card count descending', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'R', name: 'Red A' }),
                makePick({ color: 'R', name: 'Red B' }),
                makePick({ color: 'G', name: 'Green A' }),
            ],
        };
        renderColorTables();
        // Headers render as "Red (2)" / "Green (1)" — search for the label text
        const redIdx   = mockContainer.innerHTML.indexOf('Red (');
        const greenIdx = mockContainer.innerHTML.indexOf('Green (');
        expect(redIdx).toBeGreaterThanOrEqual(0);
        expect(greenIdx).toBeGreaterThanOrEqual(0);
        expect(redIdx).toBeLessThan(greenIdx);
    });
});

// ─── Search ───────────────────────────────────────────────────────────────────

describe('setColorTableSearch', () => {
    test('filters to only matching card names', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'W', name: 'Serra Angel' }),
                makePick({ color: 'W', name: 'Wrath of God' }),
            ],
        };
        setColorTableSearch('serra');
        expect(mockContainer.innerHTML).toContain('Serra Angel');
        expect(mockContainer.innerHTML).not.toContain('Wrath of God');
    });

    test('search is case-insensitive', () => {
        state.bundle = {
            picks: [makePick({ color: 'U', name: 'Counterspell' })],
        };
        setColorTableSearch('COUNTER');
        expect(mockContainer.innerHTML).toContain('Counterspell');
    });

    test('no matches → shows "No cards match" fallback message', () => {
        state.bundle = {
            picks: [makePick({ color: 'B', name: 'Dark Ritual' })],
        };
        setColorTableSearch('zzznomatch');
        expect(mockContainer.innerHTML).toContain('No cards match');
    });

    test('empty search shows all cards', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'G', name: 'Llanowar Elves' }),
                makePick({ color: 'G', name: 'Giant Growth' }),
            ],
        };
        setColorTableSearch('');
        expect(mockContainer.innerHTML).toContain('Llanowar Elves');
        expect(mockContainer.innerHTML).toContain('Giant Growth');
    });
});

// ─── Sort ─────────────────────────────────────────────────────────────────────

describe('setColorTableSort — gihWr', () => {
    test('highest GIH WR card appears first', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'U', name: 'Low WR',  gihWr: 0.50 }),
                makePick({ color: 'U', name: 'High WR', gihWr: 0.70 }),
            ],
        };
        setColorTableSort('gihWr');
        const html = mockContainer.innerHTML;
        expect(html.indexOf('High WR')).toBeLessThan(html.indexOf('Low WR'));
    });

    test('cards with null gihWr sort to the end', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'B', name: 'No Data',  gihWr: null }),
                makePick({ color: 'B', name: 'Has Data', gihWr: 0.55 }),
            ],
        };
        setColorTableSort('gihWr');
        const html = mockContainer.innerHTML;
        expect(html.indexOf('Has Data')).toBeLessThan(html.indexOf('No Data'));
    });

    test('two null-gihWr cards keep stable relative position (both at end)', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'R', name: 'Null A', gihWr: null }),
                makePick({ color: 'R', name: 'Null B', gihWr: null }),
                makePick({ color: 'R', name: 'Known',  gihWr: 0.60 }),
            ],
        };
        setColorTableSort('gihWr');
        const html = mockContainer.innerHTML;
        const knownIdx = html.indexOf('Known');
        expect(html.indexOf('Null A')).toBeGreaterThan(knownIdx);
        expect(html.indexOf('Null B')).toBeGreaterThan(knownIdx);
    });
});

describe('setColorTableSort — order', () => {
    test('earlier pack comes before later pack', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'G', name: 'Pack 2 Card', gihWr: 0.99 }, { pack: 2, pick: 1 }),
                makePick({ color: 'G', name: 'Pack 1 Card', gihWr: 0.40 }, { pack: 1, pick: 1 }),
            ],
        };
        setColorTableSort('order');
        const html = mockContainer.innerHTML;
        expect(html.indexOf('Pack 1 Card')).toBeLessThan(html.indexOf('Pack 2 Card'));
    });

    test('within the same pack, earlier pick comes first', () => {
        state.bundle = {
            picks: [
                makePick({ color: 'R', name: 'Pick 5' }, { pack: 1, pick: 5 }),
                makePick({ color: 'R', name: 'Pick 2' }, { pack: 1, pick: 2 }),
            ],
        };
        setColorTableSort('order');
        const html = mockContainer.innerHTML;
        expect(html.indexOf('Pick 2')).toBeLessThan(html.indexOf('Pick 5'));
    });
});
