'use strict';

// Shared mutable state. All panels read and write to this single object.
// Node's module cache ensures every require() gets the same instance.

module.exports = {
    currentPage:  'dashboard',
    bundle:       null,   // ViewerBundle | null
    draftList:    [],     // [{draftId, startedAt, pickCount}]
    viewingCoord: null,   // {pack, pick} | null
};
