const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell } = require('electron');

// Must be set before any call to app.getPath('userData') so the user-data
// folder is "MTG Arena Tracker" rather than the package name "mtg-arena-auto-tracker".
app.setName('MTG Arena Tracker');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const LogParser = require('./logParserV5');
const GREParser = require('./parser/greParser');
const DataStore = require('./dataStore');
const CardUpdater = require('./cardUpdater');
const setEnricher = require('./setEnricher');
const DraftAssistant = require('./draftAssistant');
const draftPipeline = require('./draftPipeline');
const { coalesceEvents } = require('./eventCoalescer');
const { formatCardGroupKey } = require('./renderer/shared');
const { clear } = require('console');

let mainWindow;
let tray;
let logWatcher;
let parser;
let greParser = new GREParser();
let dataStore;
let cardUpdater;
let draftAssistant = new DraftAssistant();
let isQuitting = false;
let scanInterval;
let lastDraftEventData = null; // raw DRAFT_UPDATE event.data for re-enrichment after CSV load

// Active draft tracking — reset when a draft ends or a new one starts.
let activeDraftId    = null;
let activeDraftWins  = 0;
let activeDraftLoss  = 0;

function endActiveDraft() {
  if (!activeDraftId) return;
  const draftId = activeDraftId;
  const wins    = activeDraftWins;
  const losses  = activeDraftLoss;
  dataStore.endDraft(draftId, wins, losses);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('draft-ended', { draftId, wins, losses, trophy: wins >= 7 });
  }
  console.log(`[Draft] Ended draft ${draftId}: ${wins}W-${losses}L${wins >= 7 ? ' TROPHY' : ''}`);
  activeDraftId   = null;
  activeDraftWins = 0;
  activeDraftLoss = 0;
}

let cards = {};

function loadCards() {
  try {
    const cardsPath = path.join(app.getPath('userData'), 'cards.json');
    const data = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
    cards = data.cards || {};
    console.log(`[Cards] Loaded ${Object.keys(cards).length} cards`);
  } catch (e) {
    console.error('[Cards] Failed to load cards:', e);
    cards = {};
  }
}

function migrateCardsJson() {
  const devPath  = path.join(__dirname, 'cards.json');
  const userPath = path.join(app.getPath('userData'), 'cards.json');
  if (fs.existsSync(devPath) && !fs.existsSync(userPath)) {
    try {
      fs.copyFileSync(devPath, userPath);
      console.log('[Cards] Migrated cards.json to userData');
    } catch (e) {
      console.error('[Cards] Migration failed:', e.message);
    }
  }
}

// Default log path for MTG Arena on Windows
const MTGA_LOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'LocalLow',
  'Wizards Of The Coast',
  'MTGA'
);

function getLogPath() {
  const playerLog = path.join(MTGA_LOG_DIR, 'Player.log');
  const outputLog = path.join(MTGA_LOG_DIR, 'output_log.txt');

  if (fs.existsSync(playerLog)) {
    console.log('Found log file:', playerLog);
    return playerLog;
  }
  if (fs.existsSync(outputLog)) {
    console.log('Found log file:', outputLog);
    return outputLog;
  }

  return playerLog;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    frame: false,
    show: false
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  let iconPath;
  try {
    const trayIconPath = path.join(__dirname, 'tray-icon.png');
    if (fs.existsSync(trayIconPath)) {
      iconPath = trayIconPath;
    } else {
      iconPath = null;
    }
  } catch (e) {
    iconPath = null;
  }

  try {
    if (iconPath) {
      tray = new Tray(iconPath);
    } else {
      const { nativeImage } = require('electron');
      const emptyIcon = nativeImage.createEmpty();
      tray = new Tray(emptyIcon);
    }
  } catch (e) {
    console.log('Could not create tray icon:', e.message);
    return null;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Tracker',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Status: Waiting for MTG Arena...',
      id: 'status',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('MTG Arena Tracker');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    } else {
      createWindow();
    }
  });

  return contextMenu;
}

function updateTrayStatus(message) {
  if (tray) {
    const menu = Menu.buildFromTemplate([
      {
        label: 'Show Tracker',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
          }
        }
      },
      { type: 'separator' },
      {
        label: `Status: ${message}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`MTG Arena Tracker - ${message}`);
  }
}

async function initialLogScan(logPath) {
  if (!fs.existsSync(logPath)) return;
  try {
    console.log('[Startup] Running initial log scan...');
    const fullData = fs.readFileSync(logPath, 'utf8');
    if (!parser) parser = new LogParser();

    const events = parser.parse(fullData);
    let matchCount = 0;
    const seenDraftIds = new Set();
    for (const event of events) {
      if (event.type === 'DRAFT_UPDATE') {
        if (dataStore && event.data?.draftId) {
          dataStore.upsertDraft(event.data);
          seenDraftIds.add(event.data.draftId);
        }
        // Set activeDraftId so subsequent MATCH_END events get tagged with it.
        // A new draftId means the previous draft was retired.
        const { draftId } = event.data;
        if (activeDraftId && activeDraftId !== draftId) endActiveDraft();
        if (activeDraftId !== draftId) {
          activeDraftId   = draftId;
          activeDraftWins = 0;
          activeDraftLoss = 0;
        }
      } else {
        if (event.type === 'MATCH_END') matchCount++;
        handleGameEvent(event);
      }
    }

    const greEvents = greParser.parse(fullData);
    let newGames = 0;
    for (const ev of greEvents) {
      if (ev.type === 'GAME_STATS') {
        const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
        if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
        dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
        dataStore.updateMatchPlayerDeck(ev.data.matchId, ev.data.deckCardsRaw);
      }
    }

    const draftsProcessed = seenDraftIds.size;
    console.log(`[Startup] Initial scan done: ${matchCount} matches, ${draftsProcessed} draft(s), ${newGames} new game stat(s)`);
  } catch (e) {
    console.error('[Startup] Initial scan error:', e);
  }
}

// startOffset: byte offset to begin scanning from. Pass the file size after
// initialLogScan() so we only read bytes written after startup.
// Defaults to 0 for cases like a user changing the log path in settings.
function startLogWatcher(logPath, startOffset = 0) {
  if (scanInterval) clearTimeout(scanInterval);
  scanInterval = null;

  // When called with no offset (e.g. log path changed), reset to a clean parser
  // so stale in-progress match state from the old file is discarded.
  if (startOffset === 0) {
    parser = new LogParser();
    greParser = new GREParser();
  }

  // lastProcessedOffset tracks the byte position we've read up to.
  let lastProcessedOffset = startOffset;

  // Reads and processes only the bytes appended since lastProcessedOffset.
  let _scanCount = 0;

  async function doScan() {
    _scanCount++;
    if (_scanCount % 10 === 0) {
      const mb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
      console.log(`[Scan] Heap: ${mb} MB (scan #${_scanCount})`);
    }
    try {
      const stat = fs.statSync(logPath);
      const currentSize = stat.size;

      // Detect log rotation (MTGA restarted, file truncated).
      let rotated = false;
      if (currentSize < lastProcessedOffset) {
        console.log('[Scan] Log rotated, resetting to start');
        lastProcessedOffset = 0;
        rotated = true;
      }

      if (currentSize <= lastProcessedOffset) return;

      // Read only the bytes we haven't seen yet.
      const readFrom    = lastProcessedOffset;
      const bytesToRead = currentSize - readFrom;
      let chunk;

      const fd = fs.openSync(logPath, 'r');
      try {
        const buffer    = Buffer.allocUnsafe(bytesToRead);
        const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, readFrom);
        chunk = buffer.slice(0, bytesRead).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      lastProcessedOffset = currentSize;

      if (!parser) parser = new LogParser();

      // Full parse (with reset + extractDeckNames) on first scan or after rotation.
      // Incremental parse otherwise — preserves in-progress match/draft state.
      const useFull = rotated || readFrom === 0;
      const events = useFull
        ? coalesceEvents(parser.parse(chunk))
        : coalesceEvents(parser.parseIncremental(chunk));

      if (events.length > 0) {
        console.log(`[Scan] ${events.length} events from ${(bytesToRead / 1024).toFixed(1)} KB`);
        let matchCount = 0;
        let lastDraftEvent = null;
        for (const event of events) {
          if (event.type === 'DRAFT_UPDATE') {
            // Upsert all drafts but hold the renderer update until the end
            // so it only fires once (for the live draft) instead of once per
            // historical draft, which causes the draft tab to flicker.
            if (dataStore && event.data?.draftId) dataStore.upsertDraft(event.data);
            const { draftId } = event.data;
            if (activeDraftId && activeDraftId !== draftId) endActiveDraft();
            if (activeDraftId !== draftId) {
              activeDraftId   = draftId;
              activeDraftWins = 0;
              activeDraftLoss = 0;
            }
            lastDraftEvent = event;
          } else {
            if (event.type === 'MATCH_END') {
              matchCount++;
              console.log(`[Scan] Match: ${event.data.matchId} - ${event.data.result}`);
            }
            handleGameEvent(event);
          }
        }
        // Push only the final live draft state to the renderer.
        if (lastDraftEvent) handleGameEvent(lastDraftEvent);
        if (matchCount > 0) console.log(`[Scan] Processed ${matchCount} matches`);
      }

      // GRE parser: track personal card stats
      if (dataStore) {
        const greEvents = useFull
          ? greParser.parse(chunk)
          : greParser.parseIncremental(chunk);
        let newGames = 0;
        for (const ev of greEvents) {
          if (ev.type === 'GAME_STATS') {
            const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
            if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
            dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
            dataStore.updateMatchPlayerDeck(ev.data.matchId, ev.data.deckCardsRaw);
          }
        }
        if (newGames > 0) {
          console.log(`[Scan] Card stats for ${newGames} new game(s)`);
          if (mainWindow) mainWindow.webContents.send('card-stats-updated');
        }
      }
    } catch (error) {
      console.error('[Scan] Error:', error);
    }
  }

  // Schedule a scan at most once per 2 seconds. Rapid successive writes to the
  // log (common mid-game) collapse into a single scan that reads all new bytes.
  function scheduleScan() {
    if (scanInterval) return; // scan already queued
    scanInterval = setTimeout(async () => {
      scanInterval = null;
      await doScan();
    }, 2000);
  }

  if (logWatcher) {
    logWatcher.close();
  }

  if (!fs.existsSync(logPath)) {
    console.log('Log file not found at:', logPath);
    updateTrayStatus('Log file not found - Check settings');
    return false;
  }

  logWatcher = chokidar.watch(logPath, {
    persistent: true,
    usePolling: true,
    interval: 1000,
  });

  // Scan only when the file actually changes; rapid writes coalesce into one scan.
  logWatcher.on('change', scheduleScan);
  logWatcher.on('error', error => {
    console.error('Log watcher error:', error);
    updateTrayStatus('Error watching log');
  });

  console.log('[Scan] Watching for changes from offset', startOffset);
  updateTrayStatus('Connected - Watching for matches');
  return true;
}

function handleGameEvent(event) {
  console.log('Game event:', event.type, event.data);

  if (!dataStore) {
    console.error('dataStore not initialized, cannot save event');
    return;
  }

  switch (event.type) {
    case 'MATCH_START':
      updateTrayStatus('Match in progress...');
      if (mainWindow) {
        mainWindow.webContents.send('match-started', event.data);
      }
      break;

    case 'GAME_END':
      console.log('Game ended, result:', event.data.result);
      break;

    case 'MATCH_END':
      try {
        dataStore.addMatch(event.data, activeDraftId);
        console.log('Match saved:', event.data);
        updateTrayStatus(`Match ended: ${event.data.result}`);

        // Update active draft win/loss counters and detect natural end.
        if (activeDraftId) {
          if (event.data.result === 'win')       activeDraftWins++;
          else if (event.data.result === 'loss') activeDraftLoss++;
          if (activeDraftWins >= 7 || activeDraftLoss >= 3) endActiveDraft();
        }

        if (event.data.playerDeck) {
          console.log('[Deck Save] Saving deck with card data:', JSON.stringify(event.data.playerDeck));
          dataStore.addDeck({
            name: event.data.deckName,
            format: event.data.format,
            mainDeck: event.data.playerDeck.deckCards,
            sideboard: event.data.playerDeck.sideboardCards,
            commandZone: event.data.playerDeck.commandZoneCards,
            timestamp: event.data.timestamp
          });
        } else {
          console.log('[Deck Save] No playerDeck data found in event');
        }

        if (mainWindow) {
          mainWindow.webContents.send('match-ended', event.data);
        }

      } catch (e) {
        console.error('Error handling match end:', e);
      }
      break;

    case 'INVENTORY_UPDATE':
      try {
        dataStore.updateInventory(event.data);
        console.log('[Inventory] Updated:', event.data.gems, 'gems,', event.data.gold, 'gold,', event.data.totalVaultProgress, 'vault progress');
        if (mainWindow) {
          mainWindow.webContents.send('inventory-updated', event.data);
          console.log('[Inventory] Sent update to renderer');
        }
      } catch (e) {
        console.error('[Inventory] Error handling inventory update:', e);
      }
      break;

    case 'DECK_SUBMISSION':
      if (mainWindow) {
        mainWindow.webContents.send('deck-submitted', event.data);
      }
      break;

    case 'GRE_TO_CLIENT':
      break;

    case 'DRAFT_UPDATE': {
      const { draftId } = event.data;
      // A new draftId means the player retired the previous draft.
      if (activeDraftId && activeDraftId !== draftId) endActiveDraft();
      if (activeDraftId !== draftId) {
        activeDraftId   = draftId;
        activeDraftWins = 0;
        activeDraftLoss = 0;
      }
      if (mainWindow) {
        lastDraftEventData = event.data;
        const payload = draftPipeline.buildDraftUpdatePayload(
          event.data,
          dataStore,
          draftAssistant,
          resolveCards,
          resolveCard
        );
        mainWindow.webContents.send('draft-update', payload);
      }
      break;
    }
  }
}

// IPC handlers
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('get-inventory', async () => {
  if (!dataStore) return null;
  return dataStore.getInventory();
});

ipcMain.handle('run-set-enrichment', async () => {
  if (!dataStore) return { success: false, error: 'App not ready' };
  const { mtgaDbPath } = dataStore.getSettings();
  try {
    const enriched = await setEnricher.enrich({ mtgaDbPath, force: true });
    if (enriched) {
      if (dataStore) dataStore.reloadCards();
      loadCards();
      if (mainWindow) mainWindow.webContents.send('card-stats-updated');
    }
    return { success: true, enriched };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('browse-mtga-db', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select MTGA Card Database',
    filters: [{ name: 'MTGA Database', extensions: ['mtga'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Let the user pick a 17Lands CSV via file dialog
ipcMain.handle('load-17lands-csv', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select 17Lands CSV',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
    properties: ['openFile'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, reason: 'cancelled' };
  }

  try {
    const info = draftAssistant.loadCSV(result.filePaths[0]);
    // Persist path so we can auto-load it on next startup
    if (dataStore) dataStore.saveSettings({ lastCsvPath: result.filePaths[0] });
    // Re-enrich the cached draft state now that we have WR data
    if (lastDraftEventData && mainWindow) {
      handleGameEvent({ type: 'DRAFT_UPDATE', data: lastDraftEventData });
    }
    return { success: true, ...info };
  } catch (e) {
    console.error('[DraftAssistant] Failed to load CSV:', e.message);
    return { success: false, reason: e.message };
  }
});
 
// Return current assistant status (for the settings/status UI)
ipcMain.handle('get-draft-assistant-status', async () => {
  return draftAssistant.getStatus();
});

ipcMain.handle('get-card-name', async (event, cardId) => {
  if (!dataStore) return `Card ${cardId}`;
  return dataStore.getCardName(cardId);
});

ipcMain.handle('get-card-stat-formats', async () => {
  if (!dataStore) return [];
  return dataStore.getCardStatFormats();
});

ipcMain.handle('get-card-game-stats', async (event, format) => {
  if (!dataStore || !format) return [];
  // If format is a merged group key (e.g. "Draft SOS"), collect and merge all matching raw formats.
  const allRawFormats = dataStore.getCardStatFormats();
  const matchingFormats = allRawFormats.filter(f => f === format || formatCardGroupKey(f) === format);
  let raw;
  if (matchingFormats.length <= 1) {
    raw = dataStore.getAllCardGameStats(matchingFormats[0] ?? format);
  } else {
    raw = {};
    for (const fmt of matchingFormats) {
      for (const [grpId, s] of Object.entries(dataStore.getAllCardGameStats(fmt))) {
        if (!raw[grpId]) raw[grpId] = { gamesInDeck: 0, gamesInHand: 0, gamesWonInHand: 0, gamesOpenHand: 0, gamesWonOpenHand: 0 };
        raw[grpId].gamesInDeck      += s.gamesInDeck      || 0;
        raw[grpId].gamesInHand      += s.gamesInHand      || 0;
        raw[grpId].gamesWonInHand   += s.gamesWonInHand   || 0;
        raw[grpId].gamesOpenHand    += s.gamesOpenHand    || 0;
        raw[grpId].gamesWonOpenHand += s.gamesWonOpenHand || 0;
      }
    }
  }
  const assistantLoaded = draftAssistant.isLoaded();

  const results = Object.entries(raw).map(([grpId, s]) => {
    const name          = dataStore.getCardName(grpId);
    const gihWrPersonal = s.gamesInHand > 0 ? s.gamesWonInHand / s.gamesInHand : null;
    const ohWrPersonal  = s.gamesOpenHand > 0 ? s.gamesWonOpenHand / s.gamesOpenHand : null;
    const stats17l      = assistantLoaded ? draftAssistant.getCardStats(name) : null;
    const gihWr17l      = stats17l?.gihWr ?? null;
    const ohWr17l       = stats17l?.ohWr ?? null;
    const delta         = (gihWrPersonal !== null && gihWr17l !== null)
      ? gihWrPersonal - gihWr17l : null;
    return {
      grpId, name,
      gamesInDeck: s.gamesInDeck, gamesInHand: s.gamesInHand, gamesWonInHand: s.gamesWonInHand,
      gihWrPersonal,
      gamesOpenHand: s.gamesOpenHand, gamesWonOpenHand: s.gamesWonOpenHand,
      ohWrPersonal, gihWr17l, ohWr17l, delta,
    };
  });

  // When a CSV is loaded, also include 17Lands cards the user has never played.
  // They appear in the table only when the Min GIH filter is set to 0.
  if (assistantLoaded) {
    const personalGrpIds = new Set(Object.keys(raw));
    const nameToGrpId = {};
    for (const [grpId, card] of Object.entries(dataStore.cards)) {
      if (card.name) nameToGrpId[card.name.toLowerCase()] = grpId;
    }
    for (const stats17l of draftAssistant.getAllCardStats()) {
      const grpId = nameToGrpId[stats17l.name.toLowerCase()];
      if (grpId && !personalGrpIds.has(grpId)) {
        results.push({
          grpId, name: stats17l.name,
          gamesInDeck: 0, gamesInHand: 0, gamesWonInHand: 0,
          gihWrPersonal: null,
          gamesOpenHand: 0, gamesWonOpenHand: 0,
          ohWrPersonal: null,
          gihWr17l: stats17l.gihWr, ohWr17l: stats17l.ohWr,
          delta: null,
        });
      }
    }
  }

  return results.sort((a, b) => b.gamesInHand - a.gamesInHand);
});

ipcMain.handle('clear-card-stats', async () => {
  if (!dataStore) return false;
  dataStore.clearCardStats();
  return true;
});

ipcMain.handle('get-card-stats-by-grpid', async (event, grpId) => {
  if (!dataStore) return null;

  // The draft log and GRE game events may use different grpIds for the same card
  // (different art printings). Resolve by card name and aggregate across all grpIds
  // that share the same name so draft pack cards always find their stored stats.
  const name = dataStore.getCardName(String(grpId));
  const siblingIds = new Set();
  for (const [id, card] of Object.entries(dataStore.cards)) {
    if (card.name === name) siblingIds.add(id);
  }

  let gamesInDeck = 0, gamesInHand = 0, gamesWonInHand = 0,
      gamesOpenHand = 0, gamesWonOpenHand = 0;
  for (const fmt of dataStore.getCardStatFormats()) {
    const statsMap = dataStore.getAllCardGameStats(fmt);
    for (const id of siblingIds) {
      const s = statsMap[id];
      if (s) {
        gamesInDeck      += s.gamesInDeck;
        gamesInHand      += s.gamesInHand;
        gamesWonInHand   += s.gamesWonInHand;
        gamesOpenHand    += s.gamesOpenHand;
        gamesWonOpenHand += s.gamesWonOpenHand;
      }
    }
  }

  if (gamesInHand === 0 && gamesInDeck === 0) return null;
  const gihWrPersonal = gamesInHand > 0 ? gamesWonInHand / gamesInHand : null;
  const ohWrPersonal  = gamesOpenHand > 0 ? gamesWonOpenHand / gamesOpenHand : null;
  const stats17l      = draftAssistant.isLoaded() ? draftAssistant.getCardStats(name) : null;
  const gihWr17l      = stats17l?.gihWr ?? null;
  const delta         = (gihWrPersonal !== null && gihWr17l !== null) ? gihWrPersonal - gihWr17l : null;
  return { grpId, name, gamesInDeck, gamesInHand, gihWrPersonal, gamesOpenHand, ohWrPersonal, gihWr17l, delta };
});

ipcMain.handle('get-deck-card-details', async (event, grpIds) => {
  if (!dataStore || !Array.isArray(grpIds)) return [];
  return grpIds.map(grpId => {
    const card      = resolveCard(grpId);
    const stats     = draftAssistant.isLoaded() ? draftAssistant.getCardStats(card.name) : null;
    const gihWr     = stats?.gihWr ?? null;
    const lowSample = stats ? stats.lowSample : true;
    const tier      = draftAssistant.isLoaded()
      ? draftAssistant.getCardTier(gihWr, card.name, lowSample)
      : 'none';
    return { ...card, gihWr, tier };
  });
});

ipcMain.handle('delete-format', async (event, format) => {
  if (!dataStore || !format) return false;
  dataStore.deleteMatchesByFormat(format);
  return true;
});

// Main draftable sets (≥100 primary cards, no DigitalReleaseSet) for the
// Personal Card Stats browse-by-set dropdown. The list is precomputed by
// card-import/import_set.py (or generate_enrichment_data.py) and read from
// cards.json so the renderer never needs the MTGA SQLite DB at runtime.
ipcMain.handle('get-main-draft-sets', async () => {
  if (!dataStore) return [];
  return dataStore.getMainDraftSets();
});

// Draft replay viewer: dropdown metadata and on-demand bundle for past records.
ipcMain.handle('list-drafts', async () => {
  if (!dataStore) return [];
  return dataStore.getDraftSummaries();
});

ipcMain.handle('view-draft-record', async (event, draftId) => {
  if (!dataStore || !draftId) return null;
  const record = dataStore.getDraft(draftId);
  if (!record) return null;
  return draftPipeline.buildViewerBundle(
    record,
    draftAssistant,
    resolveCards,
    resolveCard,
  );
});

// Browse-mode card stats for a given set code. Aggregates personal stats by
// card name across every draft format that mentions the set (so a user who's
// played Premier_Draft_SOS and Quick_Draft_SOS sees combined numbers), pulls
// in Special Guests for the same parent (SPG-<set>), and falls back to a
// pure 17Lands view when there are no personal records yet.
ipcMain.handle('get-set-card-stats', async (event, setCode) => {
  if (!dataStore || !setCode) return [];
  const setCards = dataStore.getCardsBySet(setCode);
  if (setCards.length === 0) return [];

  const assistantLoaded = draftAssistant.isLoaded();

  // Build name -> aggregated personal stats across all draft formats that
  // mention this set. Aggregating by name (not GrpId) handles alt-art GrpId
  // siblings the same way get-card-stats-by-grpid already does.
  const formats = dataStore.getCardStatFormats().filter(f => f.includes(setCode));
  const personalByName = {};
  for (const fmt of formats) {
    const raw = dataStore.getAllCardGameStats(fmt);
    for (const [grpId, s] of Object.entries(raw)) {
      const name = dataStore.getCardName(grpId);
      const acc = personalByName[name] ||
        { gamesInDeck: 0, gamesInHand: 0, gamesWonInHand: 0,
          gamesOpenHand: 0, gamesWonOpenHand: 0 };
      acc.gamesInDeck      += s.gamesInDeck;
      acc.gamesInHand      += s.gamesInHand;
      acc.gamesWonInHand   += s.gamesWonInHand;
      acc.gamesOpenHand    += s.gamesOpenHand;
      acc.gamesWonOpenHand += s.gamesWonOpenHand;
      personalByName[name] = acc;
    }
  }

  // Dedupe by name — alt-art GrpIds in cards.json would otherwise produce
  // duplicate rows in the table.
  const seenNames = new Set();
  const results = [];
  for (const c of setCards) {
    if (!c.name || seenNames.has(c.name)) continue;
    seenNames.add(c.name);

    const p = personalByName[c.name];
    const gihWrPersonal = p && p.gamesInHand > 0
      ? p.gamesWonInHand / p.gamesInHand : null;
    const ohWrPersonal = p && p.gamesOpenHand > 0
      ? p.gamesWonOpenHand / p.gamesOpenHand : null;
    const stats17l = assistantLoaded ? draftAssistant.getCardStats(c.name) : null;
    const gihWr17l = stats17l?.gihWr ?? null;
    const ohWr17l  = stats17l?.ohWr  ?? null;
    const delta = (gihWrPersonal !== null && gihWr17l !== null)
      ? gihWrPersonal - gihWr17l : null;

    results.push({
      grpId:           c.grpId,
      name:            c.name,
      set:             c.set || '',
      gamesInDeck:     p?.gamesInDeck      ?? 0,
      gamesInHand:     p?.gamesInHand      ?? 0,
      gamesWonInHand:  p?.gamesWonInHand   ?? 0,
      gihWrPersonal,
      gamesOpenHand:   p?.gamesOpenHand    ?? 0,
      gamesWonOpenHand: p?.gamesWonOpenHand ?? 0,
      ohWrPersonal,
      gihWr17l, ohWr17l, delta,
    });
  }
  return results;
});

ipcMain.handle('get-deck', async (event, deckId) => {
  if (!dataStore) return null;
  const deck = dataStore.getDeck(deckId);
  if (deck) {
    const mainDeckWithNames = deck.mainDeck.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId)
    }));
    const sideboardWithNames = deck.sideboard.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId)
    }));
    const commandZoneWithNames = deck.commandZone.map(cardId => ({
      cardId,
      name: dataStore.getCardName(cardId)
    }));
    return {
      ...deck,
      mainDeck: mainDeckWithNames,
      sideboard: sideboardWithNames,
      commandZone: commandZoneWithNames
    };
  }
  return deck;
});

ipcMain.handle('get-stats', async () => {
  if (!dataStore) return { matches: [], decks: [] };
  return dataStore.getStats();
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('close-window', () => {
  isQuitting = true;
  if (mainWindow) mainWindow.close();
});

ipcMain.handle('get-matches', async () => {
  if (!dataStore) return [];
  return dataStore.getMatches();
});

ipcMain.handle('get-decks', async () => {
  if (!dataStore) return [];
  return dataStore.getDecks();
});

ipcMain.handle('delete-match', async (event, matchId) => {
  if (!dataStore) return false;
  dataStore.deleteMatch(matchId);
  return true;
});

ipcMain.handle('clear-data', async () => {
  if (!dataStore) return false;
  dataStore.clearAll();
  return true;
});

ipcMain.handle('export-data', async () => {
  if (!dataStore) return null;

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `mtg-arena-data-${new Date().toISOString().split('T')[0]}.json`,
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ]
  });

  if (!result.canceled) {
    dataStore.exportToFile(result.filePath);
    return result.filePath;
  }
  return null;
});

ipcMain.handle('import-data', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your data backup file',
    filters: [{ name: 'JSON Files', extensions: ['json'] }],
    properties: ['openFile'],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    try {
      dataStore.importFromFile(result.filePaths[0]);
      return true;
    } catch (e) {
      console.error('Import error:', e);
      return false;
    }
  }
  return false;
});

ipcMain.handle('refresh-log', async () => {
  const logPath = getLogPath();
  if (fs.existsSync(logPath)) {
    try {
      const data = fs.readFileSync(logPath, 'utf8');
      const freshParser = new LogParser();
      const events = freshParser.parse(data);
      console.log(`[Manual Refresh] Parsed ${events.length} events from ${data.length} bytes`);

      let matchCount = 0;
      let inventoryUpdated = false;
      const seenDraftIds = new Set();
      for (const event of events) {
        if (event.type === 'DRAFT_UPDATE') {
          // Store draft data without enriching or notifying the renderer —
          // historical events shouldn't clobber the live Draft tab view.
          if (dataStore && event.data?.draftId) {
            dataStore.upsertDraft(event.data);
            seenDraftIds.add(event.data.draftId);
          }
        } else {
          handleGameEvent(event);
          if (event.type === 'MATCH_END') matchCount++;
          else if (event.type === 'INVENTORY_UPDATE') inventoryUpdated = true;
        }
      }
      const draftsProcessed = seenDraftIds.size;
      console.log(`[Manual Refresh] Processed ${matchCount} matches, ${draftsProcessed} draft(s), inventory updated: ${inventoryUpdated}`);

      // GRE parser: process card stats on manual refresh too
      if (dataStore) {
        const greEvents = greParser.parse(data);
        let newGames = 0;
        for (const ev of greEvents) {
          if (ev.type === 'GAME_STATS') {
            const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
            if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
            dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
        dataStore.updateMatchPlayerDeck(ev.data.matchId, ev.data.deckCardsRaw);
          }
        }
        console.log(`[Manual Refresh] Recorded stats for ${newGames} new game(s)`);
      }

      return { success: true, eventsFound: events.length, matchesProcessed: matchCount, draftsProcessed, bytesRead: data.length };
    } catch (e) {
      console.error('[Manual Refresh] Error:', e);
      return { success: false, error: e.message };
    }
  }
  return { success: false, error: 'Log file not found' };
});

ipcMain.handle('get-log-path', async () => {
  return getLogPath();
});

ipcMain.handle('set-log-path', async (event, logPath) => {
  startLogWatcher(logPath);
  return true;
});

ipcMain.handle('get-settings', async () => {
  if (!dataStore) return {};
  return dataStore.getSettings();
});

ipcMain.handle('save-settings', async (event, settings) => {
  if (!dataStore) return false;
  dataStore.saveSettings(settings);
  return true;
});

ipcMain.handle('get-card-db-status', async () => {
  try {
    const cardsPath = path.join(app.getPath('userData'), 'cards.json');
    if (!fs.existsSync(cardsPath)) {
      return { exists: false, cardCount: 0, lastUpdated: null };
    }

    const content = fs.readFileSync(cardsPath, 'utf8');
    const data = JSON.parse(content);
    const cardCount = Object.keys(data.cards || {}).length;

    return {
      exists: true,
      cardCount,
      lastUpdated: data.lastUpdated || null,
      source: data.source || 'unknown',
      sourceUpdatedAt: data.sourceUpdatedAt || null
    };
  } catch (error) {
    return { exists: false, cardCount: 0, error: error.message };
  }
});

ipcMain.handle('update-card-db', async () => {
  if (!cardUpdater) {
    cardUpdater = new CardUpdater(app.getPath('userData'));
  }

  try {
    const progressSender = (progress) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('card-db-progress', progress);
      }
    };
    const result = await cardUpdater.update(progressSender);
    progressSender({ done: true });

    if (dataStore) {
      dataStore.reloadCards();
    }

    loadCards();

    return {
      success: true,
      updated: result,
      cardCount: Object.keys(cardUpdater.cardsData.cards || {}).length
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
});

ipcMain.on('maximize-window', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('open-external', (event, url) => {
  console.log('[External Link] Opening:', url);
  shell.openExternal(url);
});


app.whenReady().then(async () => {
  // Point all modules that write cards.json to the writable userData directory,
  // then migrate any existing dev-time cards.json from the project root.
  setEnricher.init(app.getPath('userData'));
  migrateCardsJson();

  // Initialize dataStore and cards before creating the window so that IPC
  // handlers (list-drafts, view-draft-record, etc.) have data available when
  // the renderer fires DOMContentLoaded. Without this, the renderer's first
  // list-drafts call races against the async cardUpdater.update() below and
  // always wins — returning [] even though drafts.json has saved records.
  dataStore = new DataStore();

  // Clear any stored mtgaDbPath that no longer exists on disk (e.g. after an
  // MTGA update renames the database file, or after moving the install).
  const { mtgaDbPath } = dataStore.getSettings();
  if (mtgaDbPath && !fs.existsSync(mtgaDbPath)) {
    dataStore.saveSettings({ mtgaDbPath: '' });
  }

  loadCards();

  createWindow();
  createTray();

  console.log('[App] Checking for card database updates...');
  cardUpdater = new CardUpdater(app.getPath('userData'));

  const sendProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('card-db-progress', progress);
    }
  };

  let scryfallUpdated = false;
  try {
    scryfallUpdated = await cardUpdater.update(sendProgress);
    if (scryfallUpdated) {
      console.log('[App] Card database was updated');
      loadCards();
    } else {
      console.log('[App] Card database is up to date');
    }
  } catch (error) {
    console.error('[App] Failed to update card database:', error.message);
  }
  sendProgress({ done: true });

  // Enrich cards.json with MTGA-sourced data for sets not yet mapped on Scryfall.
  // Runs when Scryfall just refreshed or when enrichment hasn't been done yet.
  if (scryfallUpdated || setEnricher.needsEnrichment()) {
    const { mtgaDbPath } = dataStore.getSettings();
    const enriched = await setEnricher.enrich({ mtgaDbPath });
    if (enriched) {
      dataStore.reloadCards();
      loadCards();
    }
  }

  // Auto-load last 17Lands CSV from previous session
  const savedCsvPath = dataStore.getSettings().lastCsvPath;
  if (savedCsvPath && fs.existsSync(savedCsvPath)) {
    try {
      draftAssistant.loadCSV(savedCsvPath);
      console.log('[App] Auto-loaded 17Lands CSV:', savedCsvPath);
    } catch (e) {
      console.error('[App] Failed to auto-load saved CSV:', e.message);
    }
  }

  const logPath = getLogPath();
  console.log('Using log path:', logPath);

  // Parse existing log data immediately on startup so the user sees their
  // history right away without needing to hit "Scan Now".
  await initialLogScan(logPath);

  // Start the watcher from the current end of the file so the interval only
  // processes bytes written after startup — not the entire 100+ MB log again.
  let scanStartOffset = 0;
  try { scanStartOffset = fs.statSync(logPath).size; } catch { /* file absent */ }
  startLogWatcher(logPath, scanStartOffset);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (logWatcher) {
    logWatcher.close();
  }
});

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function deriveColors(grpIds) {
  const found = new Set();
  for (const id of grpIds) {
    const card = cards[String(id)];
    if (!card?.manaCost) continue;
    for (const ch of card.manaCost) {
      if (ch === 'W' || ch === 'U' || ch === 'B' || ch === 'R' || ch === 'G') found.add(ch);
    }
  }
  return ['W', 'U', 'B', 'R', 'G'].filter(c => found.has(c));
}

// Count how many deck cards contribute to each color (multi-color cards count once per color).
// rawGrpIds is the non-deduplicated list from deckCardsRaw.
function deriveColorCounts(rawGrpIds) {
  const counts = {};
  for (const id of (rawGrpIds || [])) {
    const card = cards[String(id)];
    if (!card?.manaCost) continue;
    const colorsInCard = new Set();
    for (const ch of card.manaCost) {
      if ('WUBRG'.includes(ch)) colorsInCard.add(ch);
    }
    if (colorsInCard.size === 0) {
      // Non-land card with no colored pips — counts as colorless
      counts['C'] = (counts['C'] || 0) + 1;
    } else {
      for (const c of colorsInCard) {
        counts[c] = (counts[c] || 0) + 1;
      }
    }
  }
  return counts;
}

function resolveCard(grpId) {
  const card = cards[String(grpId)];

  if (!card) {
    return {
      arena_id: grpId,
      name: `Unknown (${grpId})`
    };
  }

  return {
    arena_id: grpId,
    name: card.name,
    manaCost: card.manaCost,
    type: card.type
  };
}

function resolveCards(ids) {
  return ids.map(resolveCard);
}
