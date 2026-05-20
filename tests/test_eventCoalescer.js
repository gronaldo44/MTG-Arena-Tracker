'use strict';

const { coalesceEvents } = require('../eventCoalescer');

// Helper to build a DRAFT_UPDATE event for a given draft ID.
function draftEv(draftId, pack = 1, pick = 1) {
  return { type: 'DRAFT_UPDATE', data: { draftId, currentPack: { pack, pick } } };
}

// Helper to build a non-draft event.
function otherEv(type, id = 'match1') {
  return { type, data: { matchId: id } };
}

describe('coalesceEvents', () => {
  test('empty array → empty array', () => {
    expect(coalesceEvents([])).toEqual([]);
  });

  test('no DRAFT_UPDATEs → same events in order', () => {
    const events = [otherEv('MATCH_START'), otherEv('MATCH_END')];
    expect(coalesceEvents(events)).toEqual(events);
  });

  test('single DRAFT_UPDATE → passes through', () => {
    const events = [draftEv('d1')];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('DRAFT_UPDATE');
    expect(result[0].data.draftId).toBe('d1');
  });

  test('multiple DRAFT_UPDATEs for same draftId → only last is kept', () => {
    const events = [
      draftEv('d1', 1, 1),
      draftEv('d1', 1, 2),
      draftEv('d1', 1, 3),
    ];
    const result = coalesceEvents(events);
    expect(result).toHaveLength(1);
    expect(result[0].data.currentPack.pick).toBe(3);
  });

  test('DRAFT_UPDATEs for different draftIds → one event per draftId', () => {
    const events = [
      draftEv('d1', 1, 1),
      draftEv('d2', 1, 1),
      draftEv('d1', 1, 2),
      draftEv('d2', 1, 2),
    ];
    const result = coalesceEvents(events);
    const draftEvents = result.filter(e => e.type === 'DRAFT_UPDATE');
    expect(draftEvents).toHaveLength(2);

    const byId = Object.fromEntries(draftEvents.map(e => [e.data.draftId, e]));
    expect(byId['d1'].data.currentPack.pick).toBe(2);
    expect(byId['d2'].data.currentPack.pick).toBe(2);
  });

  test('DRAFT_UPDATE at first occurrence position, before interleaved non-draft events', () => {
    // DRAFT_UPDATE appears first in input → kept first so activeDraftId is set before MATCH_END.
    const events = [
      draftEv('d1', 1, 1),
      otherEv('MATCH_END'),
      draftEv('d1', 1, 2),
    ];
    const result = coalesceEvents(events);
    expect(result[0].type).toBe('DRAFT_UPDATE');
    expect(result[1].type).toBe('MATCH_END');
  });

  test('non-draft events preserve their original relative order', () => {
    const ev1 = otherEv('MATCH_START', 'm1');
    const ev2 = otherEv('INVENTORY_UPDATE', 'm2');
    const ev3 = otherEv('MATCH_END', 'm1');
    const events = [ev1, draftEv('d1'), ev2, draftEv('d1'), ev3];
    const result = coalesceEvents(events);
    const nonDraft = result.filter(e => e.type !== 'DRAFT_UPDATE');
    expect(nonDraft).toEqual([ev1, ev2, ev3]);
  });

  test('64 DRAFT_UPDATEs for the same draft → coalesces to 1 IPC send', () => {
    // Simulate a full pack-1 (14 notify + 14 pick events × ~2 packs + some extras)
    const events = Array.from({ length: 64 }, (_, i) =>
      draftEv('draft-abc', Math.ceil((i + 1) / 14), ((i % 14) + 1))
    );
    const result = coalesceEvents(events);
    expect(result.filter(e => e.type === 'DRAFT_UPDATE')).toHaveLength(1);
  });

  test('DRAFT_UPDATE with undefined draftId is treated as one group', () => {
    const events = [
      { type: 'DRAFT_UPDATE', data: {} },
      { type: 'DRAFT_UPDATE', data: {} },
    ];
    const result = coalesceEvents(events);
    expect(result.filter(e => e.type === 'DRAFT_UPDATE')).toHaveLength(1);
  });
});
