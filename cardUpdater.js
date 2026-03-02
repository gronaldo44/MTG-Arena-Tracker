/**
 * Card Database Updater
 * Fetches MTG Arena card data from Scryfall bulk API
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const BULK_DATA_URL = 'https://api.scryfall.com/bulk-data';
const CARDS_FILE = path.join(__dirname, 'cards.json');
const UPDATE_INTERVAL_HOURS = 24; // Update once per day

class CardUpdater {
  constructor() {
    this.cardsData = { cards: {}, lastUpdated: null };
  }

  /**
   * Check if update is needed (last update was more than UPDATE_INTERVAL_HOURS ago)
   */
  needsUpdate() {
    try {
      if (!fs.existsSync(CARDS_FILE)) {
        console.log('[CardUpdater] cards.json does not exist, update needed');
        return true;
      }

      const content = fs.readFileSync(CARDS_FILE, 'utf8');
      const data = JSON.parse(content);

      if (!data.lastUpdated) {
        console.log('[CardUpdater] No lastUpdated timestamp, update needed');
        return true;
      }

      const lastUpdate = new Date(data.lastUpdated);
      const now = new Date();
      const hoursSinceUpdate = (now - lastUpdate) / (1000 * 60 * 60);

      if (hoursSinceUpdate >= UPDATE_INTERVAL_HOURS) {
        console.log(`[CardUpdater] Last update was ${hoursSinceUpdate.toFixed(1)} hours ago, update needed`);
        return true;
      }

      console.log(`[CardUpdater] Last update was ${hoursSinceUpdate.toFixed(1)} hours ago, skipping update`);
      return false;
    } catch (error) {
      console.error('[CardUpdater] Error checking update status:', error.message);
      return true; // Update on error to be safe
    }
  }

  /**
   * Fetch JSON from URL
   */
  fetchJSON(url) {
    return new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'MTG-Arena-Tracker/1.0',
          'Accept': 'application/json'
        }
      };

      https.get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect
          https.get(res.headers.location, options, (redirectRes) => {
            handleResponse(redirectRes, resolve, reject);
          }).on('error', reject);
        } else {
          handleResponse(res, resolve, reject);
        }
      }).on('error', reject);
    });

    function handleResponse(res, resolve, reject) {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
      res.on('error', reject);
    }
  }

  /**
   * Download and process the bulk card data
   * Uses streaming to handle large files efficiently
   */
  async downloadCards() {
    console.log('[CardUpdater] Starting card database update...');

    try {
      // Step 1: Get the bulk data info
      console.log('[CardUpdater] Fetching bulk data info from Scryfall...');
      const bulkInfo = await this.fetchJSON(BULK_DATA_URL);

      const defaultCards = bulkInfo.data.find(d => d.type === 'default_cards');
      if (!defaultCards) {
        throw new Error('Could not find default_cards bulk data');
      }

      console.log(`[CardUpdater] Found default cards dataset: ${(defaultCards.size / 1024 / 1024).toFixed(1)} MB`);
      console.log(`[CardUpdater] Last updated: ${defaultCards.updated_at}`);
      console.log(`[CardUpdater] Download URL: ${defaultCards.download_uri}`);

      // Step 2: Download and process the card data
      console.log('[CardUpdater] Downloading card data (this may take 30-60 seconds)...');
      console.log('[CardUpdater] Processing cards with Arena IDs only...');

      const cards = await this.downloadAndProcessCards(defaultCards.download_uri);

      // Step 3: Save the processed data
      this.cardsData = {
        cards: cards,
        lastUpdated: new Date().toISOString(),
        source: 'scryfall',
        sourceUpdatedAt: defaultCards.updated_at
      };

      // Write to temp file first, then rename for atomic operation
      const tempFile = CARDS_FILE + '.tmp';
      fs.writeFileSync(tempFile, JSON.stringify(this.cardsData, null, 2));
      fs.renameSync(tempFile, CARDS_FILE);

      const cardCount = Object.keys(cards).length;
      console.log(`[CardUpdater] Successfully saved ${cardCount} cards with Arena IDs to cards.json`);

      if (cardCount === 0) {
        console.warn('[CardUpdater] Warning: No cards with Arena IDs found!');
        return false;
      }

      return true;

    } catch (error) {
      console.error('[CardUpdater] Error updating cards:', error.message);

      // If we have existing cards, keep using them
      if (fs.existsSync(CARDS_FILE)) {
        console.log('[CardUpdater] Keeping existing cards.json');
        return false;
      }

      throw error;
    }
  }

  /**
   * Download the large JSON file and extract Arena cards
   * Uses streaming for memory efficiency
   */
  downloadAndProcessCards(url) {
    return new Promise((resolve, reject) => {
      const cards = {};
      let processed = 0;
      let withArenaId = 0;
      let buffer = '';

      const options = {
        headers: {
          'User-Agent': 'MTG-Arena-Tracker/1.0',
          'Accept': 'application/json'
        }
      };

      https.get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          https.get(res.headers.location, options, (redirectRes) => {
            processStream(redirectRes);
          }).on('error', reject);
        } else {
          processStream(res);
        }
      }).on('error', reject);

      function processStream(stream) {
        // Check if content is gzip encoded
        const contentEncoding = stream.headers['content-encoding'];
        const isGzip = contentEncoding === 'gzip';

        let dataStream = stream;

        if (isGzip) {
          console.log('[CardUpdater] Content is gzip encoded, decompressing...');
          const zlib = require('zlib');
          const gunzip = zlib.createGunzip();
          stream.pipe(gunzip);
          dataStream = gunzip;
        } else {
          console.log('[CardUpdater] Content is not compressed');
        }

        dataStream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');

          // Process complete objects from buffer
          // The file is a JSON array, so we need to parse it carefully
          let startIdx = 0;
          let braceCount = 0;
          let inString = false;
          let escapeNext = false;
          let objectStart = -1;

          for (let i = 0; i < buffer.length; i++) {
            const char = buffer[i];

            if (escapeNext) {
              escapeNext = false;
              continue;
            }

            if (char === '\\') {
              escapeNext = true;
              continue;
            }

            if (char === '"' && !escapeNext) {
              inString = !inString;
              continue;
            }

            if (!inString) {
              if (char === '{') {
                if (braceCount === 0) {
                  objectStart = i;
                }
                braceCount++;
              } else if (char === '}') {
                braceCount--;
                if (braceCount === 0 && objectStart !== -1) {
                  // We have a complete object
                  const objStr = buffer.substring(objectStart, i + 1);
                  try {
                    const card = JSON.parse(objStr);
                    processed++;

                    if (card.arena_id) {
                      withArenaId++;
                      cards[card.arena_id] = {
                        name: card.name,
                        manaCost: card.mana_cost || '',
                        type: card.type_line ? card.type_line.split('—')[0].trim() : 'Unknown'
                      };
                    }

                    if (processed % 1000 === 0) {
                      console.log(`[CardUpdater] Processed ${processed} cards, found ${withArenaId} with Arena IDs...`);
                    }
                  } catch (e) {
                    // Skip malformed objects
                  }

                  startIdx = i + 1;
                  objectStart = -1;
                }
              }
            }
          }

          // Keep remaining buffer
          buffer = buffer.substring(startIdx);
        });

        dataStream.on('end', () => {
          console.log(`[CardUpdater] Finished processing ${processed} cards, found ${withArenaId} with Arena IDs`);
          resolve(cards);
        });

        dataStream.on('error', (err) => {
          reject(new Error(`Stream error: ${err.message}`));
        });
      }
    });
  }

  /**
   * Main update function - checks if update is needed and downloads if so
   */
  async update() {
    if (this.needsUpdate()) {
      return await this.downloadCards();
    }
    return false; // No update needed
  }

  /**
   * Load cards from disk
   */
  loadCards() {
    try {
      if (fs.existsSync(CARDS_FILE)) {
        const content = fs.readFileSync(CARDS_FILE, 'utf8');
        const data = JSON.parse(content);
        this.cardsData = data;
        console.log(`[CardUpdater] Loaded ${Object.keys(data.cards || {}).length} cards from disk`);
        return data.cards || {};
      }
    } catch (error) {
      console.error('[CardUpdater] Error loading cards:', error.message);
    }
    return {};
  }
}

module.exports = CardUpdater;
