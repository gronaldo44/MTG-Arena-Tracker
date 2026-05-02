const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const LogParser = require('./logParserV5');
const GREParser = require('./greParser');
const DataStore = require('./dataStore');
const CardUpdater = require('./cardUpdater');
const setEnricher = require('./setEnricher');
const DraftAssistant = require('./draftAssistant');
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

let cards = {};

function loadCards() {
  try {
    const cardsPath = path.join(__dirname, 'cards.json');
    const data = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
    cards = data.cards || {};
    console.log(`[Cards] Loaded ${Object.keys(cards).length} cards`);
  } catch (e) {
    console.error('[Cards] Failed to load cards:', e);
    cards = {};
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
    for (const event of events) {
      if (event.type === 'MATCH_END') matchCount++;
      handleGameEvent(event);
    }

    const greEvents = greParser.parse(fullData);
    let newGames = 0;
    for (const ev of greEvents) {
      if (ev.type === 'GAME_STATS') {
        const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
        if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
        dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
      }
    }

    console.log(`[Startup] Initial scan done: ${matchCount} matches, ${newGames} new game stat(s)`);
  } catch (e) {
    console.error('[Startup] Initial scan error:', e);
  }
}

function startLogWatcher(logPath) {
  if (scanInterval) clearInterval(scanInterval);

  // Start at 0 so the first interval tick always processes the full log.
  // initialLogScan() already ran at startup; the dedup in parser + dataStore
  // prevents double-counting any events it already processed.
  let lastSize = 0;

  scanInterval = setInterval(async () => {
    try {
      const stats = fs.statSync(logPath);
      const currentSize = stats.size;

      if (currentSize > 0) {
        if (Math.abs(currentSize - lastSize) > 100 || !lastSize) {
          lastSize = currentSize;
          const fullData = fs.readFileSync(logPath, 'utf8');

          if (!parser) {
            parser = new LogParser();
          }

          const events = parser.parse(fullData);

          if (events.length > 0) {
            console.log(`[AutoScan] Parsed ${events.length} events from full log`);
            let matchCount = 0;
            for (const event of events) {
              if (event.type === 'MATCH_END') {
                matchCount++;
                console.log(`[AutoScan] Found match: ${event.data.matchId} - Result: ${event.data.result}`);
              }
              handleGameEvent(event);
            }
            console.log(`[AutoScan] Processed ${matchCount} matches`);
          }

          // GRE parser: track personal card stats
          if (dataStore) {
            const greEvents = greParser.parse(fullData);
            let newGames = 0;
            for (const ev of greEvents) {
              if (ev.type === 'GAME_STATS') {
                const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
                if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
                dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
              }
            }
            if (newGames > 0) {
              console.log(`[GREParser] Recorded stats for ${newGames} new game(s)`);
              if (mainWindow) mainWindow.webContents.send('card-stats-updated');
            }
          }
        } else {
          console.log('[AutoScan] No changes detected (log size unchanged)');
        }
      }
    } catch (error) {
      console.error('[AutoScan] Error in periodic log check:', error);
    }
  }, 2000);

  if (logWatcher) {
    logWatcher.close();
  }

  parser = new LogParser();

  if (!fs.existsSync(logPath)) {
    console.log('Log file not found at:', logPath);
    updateTrayStatus('Log file not found - Check settings');
    return false;
  }

  logWatcher = chokidar.watch(logPath, {
    persistent: true,
    usePolling: true,
    interval: 1000,
    binaryInterval: 1000,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  console.log('[AutoScan] Starting auto-scan every 2 seconds...');

  logWatcher.on('change', async (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      if (currentSize < lastSize) {
        // Log was rotated (game restarted)
        console.log('Log file rotated, re-reading...');
        const fullData = fs.readFileSync(filePath, 'utf8');
        lastSize = fullData.length;

        if (!parser) {
          parser = new LogParser();
        }

        const events = parser.parse(fullData);
        for (const event of events) {
          handleGameEvent(event);
        }
      }
    } catch (error) {
      console.error('Error reading log file:', error);
    }
  });

  logWatcher.on('error', error => {
    console.error('Log watcher error:', error);
    updateTrayStatus('Error watching log');
  });

  console.log('Started watching log file:', logPath);
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
        dataStore.addMatch(event.data);
        console.log('Match saved:', event.data);
        updateTrayStatus(`Match ended: ${event.data.result}`);

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

        const settings = dataStore.getSettings();
        if (tray && settings.showNotifications !== false) {
          const result = event.data.result;
          const emoji = result === 'win' ? '🏆' : result === 'loss' ? '❌' : '🤝';

          if (process.platform === 'win32') {
            tray.displayBalloon({
              title: 'MTG Arena Tracker',
              content: `${emoji} Match ended: ${result.toUpperCase()}`,
              iconType: 'info'
            });
          } else {
            const notif = new Notification({
              title: 'MTG Arena Tracker',
              body: `${emoji} Match ended: ${result.toUpperCase()}`,
              icon: path.join(__dirname, 'icon.png')
            });
            notif.show();
          }
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

    case 'DRAFT_UPDATE':
      if (mainWindow) {
        lastDraftEventData = event.data; // persist for re-enrichment when CSV is loaded later
        const packData = event.data.currentPack;
        const resolvedOptions = packData ? resolveCards(packData.options) : [];

        // Rank the pack by GIH WR if a CSV is loaded; otherwise pass through unranked
        const rankedOptions = draftAssistant.isLoaded()
          ? draftAssistant.rankPack(resolvedOptions)
          : resolvedOptions.map(c => ({ ...c, gihWr: null, lowSample: true, stats: null }));

        mainWindow.webContents.send('draft-update', {
          draftId: event.data.draftId,
          currentPack: packData
            ? { ...packData, options: rankedOptions }
            : null,
          picks: event.data.picks.map(p => {
            const picked = resolveCard(p.picked);
            if (draftAssistant.isLoaded() && picked.name) {
              const s = draftAssistant.getCardStats(picked.name);
              picked.gihWr     = s?.gihWr ?? null;
              picked.lowSample = s ? s.lowSample : true;
              picked.tier      = draftAssistant.getCardTier(picked.gihWr, picked.name, picked.lowSample);
            }
            return { ...p, picked, options: resolveCards(p.options) };
          }),
          assistantLoaded: draftAssistant.isLoaded(),
          assistantStatus: draftAssistant.getStatus(),
        });
      }
      break;
  }
}

// IPC handlers
ipcMain.handle('get-inventory', async () => {
  if (!dataStore) return null;
  return dataStore.getInventory();
});

ipcMain.handle('run-set-enrichment', async () => {
  if (!dataStore) return { success: false, error: 'App not ready' };
  const { mtgaDbPath } = dataStore.getSettings();
  try {
    const enriched = await setEnricher.enrich({ mtgaDbPath, force: true });
    if (enriched) loadCards();
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
  const raw = dataStore.getAllCardGameStats(format);
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

ipcMain.handle('delete-format', async (event, format) => {
  if (!dataStore || !format) return false;
  dataStore.deleteMatchesByFormat(format);
  return true;
});

// Main draftable sets (≥100 primary cards, no DigitalReleaseSet) for the
// Personal Card Stats browse-by-set dropdown. The list is precomputed by
// import_sos.py and read from cards.json so the renderer never needs the
// MTGA SQLite DB at runtime.
ipcMain.handle('get-main-draft-sets', async () => {
  if (!dataStore) return [];
  return dataStore.getMainDraftSets();
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
    filters: [
      { name: 'JSON Files', extensions: ['json'] }
    ],
    properties: ['openFile']
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
      for (const event of events) {
        handleGameEvent(event);
        if (event.type === 'MATCH_END') {
          matchCount++;
        } else if (event.type === 'INVENTORY_UPDATE') {
          inventoryUpdated = true;
        }
      }
      console.log(`[Manual Refresh] Processed ${matchCount} matches, inventory updated: ${inventoryUpdated}`);

      // GRE parser: process card stats on manual refresh too
      if (dataStore) {
        const greEvents = greParser.parse(data);
        let newGames = 0;
        for (const ev of greEvents) {
          if (ev.type === 'GAME_STATS') {
            const format = dataStore.getMatchFormat(ev.data.matchId) ?? 'Unknown';
            if (dataStore.updateCardGameStats(ev.data, format)) newGames++;
            dataStore.updateMatchColors(ev.data.matchId, deriveColors(ev.data.deckGrpIds), deriveColorCounts(ev.data.deckCardsRaw));
          }
        }
        console.log(`[Manual Refresh] Recorded stats for ${newGames} new game(s)`);
      }

      return { success: true, eventsFound: events.length, matchesProcessed: matchCount, bytesRead: data.length };
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
    const cardsPath = path.join(__dirname, 'cards.json');
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
    cardUpdater = new CardUpdater();
  }

  try {
    const result = await cardUpdater.update();

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

ipcMain.handle('test-notification', async () => {
  try {
    const settings = dataStore.getSettings();

    if (!tray) {
      return { success: false, error: 'Tray not available' };
    }

    if (settings.showNotifications === false) {
      return { success: false, error: 'Notifications are disabled in settings' };
    }

    const isWindows = process.platform === 'win32';

    if (isWindows) {
      tray.displayBalloon({
        title: 'MTG Arena Tracker - Test',
        content: '🏆 This is a test notification! Match ended: WIN',
        iconType: 'info'
      });
    } else {
      const notification = new Notification({
        title: 'MTG Arena Tracker - Test',
        body: '🏆 This is a test notification! Match ended: WIN',
        icon: path.join(__dirname, 'icon.png')
      });
      notification.show();
    }

    return {
      success: true,
      platform: process.platform,
      isWindows,
      method: isWindows ? 'balloon' : 'native'
    };
  } catch (error) {
    console.error('[Test Notification] Error:', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(async () => {
  createWindow();
  createTray();

  console.log('[App] Checking for card database updates...');
  cardUpdater = new CardUpdater();

  let scryfallUpdated = false;
  try {
    scryfallUpdated = await cardUpdater.update();
    if (scryfallUpdated) {
      console.log('[App] Card database was updated');
    } else {
      console.log('[App] Card database is up to date');
    }
  } catch (error) {
    console.error('[App] Failed to update card database:', error.message);
  }

  // DataStore must be ready before enrichment so we can read the configured MTGA DB path.
  dataStore = new DataStore();

  // Enrich cards.json with MTGA-sourced data for sets not yet mapped on Scryfall.
  // Runs when Scryfall just refreshed or when enrichment hasn't been done yet.
  if (scryfallUpdated || setEnricher.needsEnrichment()) {
    const { mtgaDbPath } = dataStore.getSettings();
    await setEnricher.enrich({ mtgaDbPath });
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

  loadCards();

  const logPath = getLogPath();
  console.log('Using log path:', logPath);

  // Parse existing log data immediately on startup so the user sees their
  // history right away without needing to hit "Scan Now".
  await initialLogScan(logPath);

  startLogWatcher(logPath);

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
