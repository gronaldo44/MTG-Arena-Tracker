const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const LogParser = require('./logParserV5');
const DataStore = require('./dataStore');
const CardUpdater = require('./cardUpdater');

let mainWindow;
let tray;
let logWatcher;
let parser;
let dataStore;
let cardUpdater;
let isQuitting = false;

// Default log path for MTG Arena on Windows
// MTG Arena uses "Player.log" but sometimes "output_log.txt"
const MTGA_LOG_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData',
  'LocalLow',
  'Wizards Of The Coast',
  'MTGA'
);

function getLogPath() {
  // Try Player.log first, then output_log.txt
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

  // Return default even if not found, so user can see error
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
    frame: false, // Borderless window
    show: false // Don't show until ready
  });

  mainWindow.loadFile('index.html');

  // Show window when ready to prevent flash
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
  // Use a default icon or create one if needed
  let iconPath;
  try {
    // Try to use the app icon if available, otherwise use nativeImage
    const trayIconPath = path.join(__dirname, 'tray-icon.png');
    if (fs.existsSync(trayIconPath)) {
      iconPath = trayIconPath;
    } else {
      // Use an empty native image as fallback
      iconPath = null;
    }
  } catch (e) {
    iconPath = null;
  }

  try {
    if (iconPath) {
      tray = new Tray(iconPath);
    } else {
      // Create a simple 16x16 transparent icon programmatically
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

function startLogWatcher(logPath) {
  if (logWatcher) {
    logWatcher.close();
  }

  // Create parser
  parser = new LogParser();
  // dataStore is now created in app.whenReady() after card update

  // Check if log file exists
  if (!fs.existsSync(logPath)) {
    console.log('Log file not found at:', logPath);
    updateTrayStatus('Log file not found - Check settings');
    return false;
  }

  // Watch the log file
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

  let lastSize = 0;
  try {
    const stats = fs.statSync(logPath);
    lastSize = stats.size;
    console.log('Initial log size:', lastSize);
  } catch (e) {
    console.error('Error getting initial file size:', e);
  }

  // Periodic full re-parse to catch new events
  // This is more reliable than trying to parse only new data
  console.log('[AutoScan] Starting auto-scan every 2 seconds...');
  setInterval(async () => {
    try {
      const stats = fs.statSync(logPath);
      const currentSize = stats.size;

      if (currentSize > 0) {
        const fullData = fs.readFileSync(logPath, 'utf8');

        // Only re-parse if size changed significantly or periodically
        if (Math.abs(currentSize - lastSize) > 100 || !lastSize) {
          lastSize = currentSize;

          // Create fresh parser to avoid state issues
          const freshParser = new LogParser();
          const events = freshParser.parse(fullData);

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
        } else {
          console.log('[AutoScan] No changes detected (log size unchanged)');
        }
      }
    } catch (error) {
      console.error('[AutoScan] Error in periodic log check:', error);
    }
  }, 2000); // Check every 2 seconds

  // Also watch for file changes (for when log rotates)
  logWatcher.on('change', async (filePath) => {
    try {
      const stats = fs.statSync(filePath);
      const currentSize = stats.size;

      if (currentSize < lastSize) {
        // Log was rotated (game restarted)
        console.log('Log file rotated, re-reading...');
        const fullData = fs.readFileSync(filePath, 'utf8');
        lastSize = fullData.length;

        // Create fresh parser
        const freshParser = new LogParser();
        const events = freshParser.parse(fullData);

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
      // Individual game ended - store for later
      console.log('Game ended, result:', event.data.result);
      break;

    case 'MATCH_END':
      // Match completed
      try {
        dataStore.addMatch(event.data);
        console.log('Match saved:', event.data);
        updateTrayStatus(`Match ended: ${event.data.result}`);

        // Save deck with card data if available
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

        // Send notification
        if (mainWindow) {
          mainWindow.webContents.send('match-ended', event.data);
        }

        // Show tray notification (if enabled in settings)
        const settings = dataStore.getSettings();
        console.log('[Notification] Settings:', settings);
        console.log('[Notification] Tray available:', !!tray);
        console.log('[Notification] Show notifications:', settings.showNotifications);

        if (tray && settings.showNotifications !== false) {
          const result = event.data.result;
          const emoji = result === 'win' ? '🏆' : result === 'loss' ? '❌' : '🤝';
          console.log('[Notification] Displaying notification');

          // Use balloon on Windows, native on other platforms
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
        } else {
          console.log('[Notification] Skipping notification - disabled or no tray');
        }
      } catch (e) {
        console.error('Error handling match end:', e);
      }
      break;

    case 'INVENTORY_UPDATE':
      // Inventory data updated
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
      // Deck submitted for a match
      if (mainWindow) {
        mainWindow.webContents.send('deck-submitted', event.data);
      }
      break;

    case 'GRE_TO_CLIENT':
      // Game state events
      break;
  }
}

// IPC handlers
ipcMain.handle('get-inventory', async () => {
  if (!dataStore) return null;
  return dataStore.getInventory();
});

ipcMain.handle('get-card-name', async (event, cardId) => {
  if (!dataStore) return `Card ${cardId}`;
  return dataStore.getCardName(cardId);
});

ipcMain.handle('get-deck', async (event, deckId) => {
  if (!dataStore) return null;
  const deck = dataStore.getDeck(deckId);
  if (deck) {
    // Add card names to the deck data
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

// Window control handlers
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

// Debug: manually trigger a log read
ipcMain.handle('refresh-log', async () => {
  const logPath = getLogPath();
  if (fs.existsSync(logPath)) {
    try {
      const data = fs.readFileSync(logPath, 'utf8');
      const freshParser = new LogParser();
      const events = freshParser.parse(data);
      console.log(`[Manual Refresh] Parsed ${events.length} events from ${data.length} bytes`);

      // Actually save the events!
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

// Card database management
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

    // Reload cards in data store
    if (dataStore) {
      dataStore.reloadCards();
    }

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

// Window controls
ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
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

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

// Open external link
ipcMain.on('open-external', (event, url) => {
  console.log('[External Link] Opening:', url);
  shell.openExternal(url);
});

// Test notification
ipcMain.handle('test-notification', async () => {
  try {
    const settings = dataStore.getSettings();
    console.log('[Test Notification] Settings:', settings);
    console.log('[Test Notification] Tray available:', !!tray);

    if (!tray) {
      return { success: false, error: 'Tray not available' };
    }

    if (settings.showNotifications === false) {
      return { success: false, error: 'Notifications are disabled in settings' };
    }

    // Check if we're on Windows (balloon notifications only work reliably there)
    const isWindows = process.platform === 'win32';
    console.log('[Test Notification] Platform:', process.platform);

    // Show notification - try balloon first (Windows), fallback to native
    let notificationMethod = 'balloon';

    if (isWindows) {
      tray.displayBalloon({
        title: 'MTG Arena Tracker - Test',
        content: '🏆 This is a test notification! Match ended: WIN',
        iconType: 'info'
      });
      console.log('[Test Notification] Balloon displayed');
    } else {
      // Use native Notification API for non-Windows platforms
      notificationMethod = 'native';
      const notification = new Notification({
        title: 'MTG Arena Tracker - Test',
        body: '🏆 This is a test notification! Match ended: WIN',
        icon: path.join(__dirname, 'icon.png')
      });
      notification.show();
      console.log('[Test Notification] Native notification displayed');
    }

    // Return platform info for troubleshooting
    return {
      success: true,
      platform: process.platform,
      isWindows,
      method: isWindows ? 'balloon' : 'native',
      troubleshooting: isWindows ? [
        'Notification sent to Windows tray. If you don\'t see it:',
        '1. Check Windows Settings → System → Notifications',
        '2. Make sure "MTG Arena Tracker" is allowed to show notifications',
        '3. Check Focus Assist is not blocking notifications (Win+A)',
        '4. Look in the system tray area for the notification icon',
        '5. Some notifications only show in Action Center (bottom-right corner)',
        '6. Try running the app as Administrator if notifications still don\'t appear'
      ].join('\n') : 'Using native notification API'
    };
  } catch (error) {
    console.error('[Test Notification] Error:', error);
    return { success: false, error: error.message };
  }
});

// App event handlers
app.whenReady().then(async () => {
  createWindow();
  createTray();

  // Update card database on launch
  console.log('[App] Checking for card database updates...');
  cardUpdater = new CardUpdater();

  try {
    const updated = await cardUpdater.update();
    if (updated) {
      console.log('[App] Card database was updated');
    } else {
      console.log('[App] Card database is up to date');
    }
  } catch (error) {
    console.error('[App] Failed to update card database:', error.message);
    // Continue anyway - we'll use existing cards or empty database
  }

  // Create data store (will load the updated cards)
  dataStore = new DataStore();

  // Start watching the log file
  const logPath = getLogPath();
  console.log('Using log path:', logPath);
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

// Handle app single instance
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
