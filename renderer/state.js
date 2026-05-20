'use strict';

// Shared mutable state. All panels read and write to this single object.
// Node's module cache ensures every require() gets the same instance.

module.exports = {
    currentPage:    'dashboard',
    bundle:         null,   // ViewerBundle | null
    draftList:      [],     // [{draftId, startedAt, pickCount}]
    viewingCoord:   null,   // {pack, pick} | null
    liveDraftId:    null,   // draftId of the currently-active live draft, or null
    liveDraftEnded: false,  // true once the live draft has ended (7W / 3L / retire)
};
