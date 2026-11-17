const { app, BrowserWindow, globalShortcut, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { INTERCEPTOR_SCRIPT } = require('./interceptor');

// Live site. When it cannot be reached, the app falls back to bundled offline
// pages. If the user has ever visited their favorites while logged in, the
// favorites page is shown offline; otherwise the generic home page is shown.
// BASE_URL is the single place to switch between local dev and staging.
// Defaults to the local Angular dev server; override with MATSNE_BASE_URL.
const BASE_URL = process.env.MATSNE_BASE_URL || 'http://localhost:4200/';
const TARGET_URL = BASE_URL;
const FAVORITES_LIVE_URL = BASE_URL + 'profile/favorites';
const HOME_FILE = path.join(__dirname, 'home.html');
const FAVORITES_FILE = path.join(__dirname, 'favorites.html');

let mainWindow;
let retryTimer = null;

// --- Cache paths (persisted under Electron userData) ---------------------
function favoritesCachePath() {
  return path.join(app.getPath('userData'), 'favorites-cache.json');
}
function tokenCachePath() {
  return path.join(app.getPath('userData'), 'token-cache.json');
}
function docsCacheDir() {
  const dir = path.join(app.getPath('userData'), 'docs-cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function docCachePath(id) {
  return path.join(docsCacheDir(), String(id) + '.json');
}
function docUrlIndexPath() {
  return path.join(docsCacheDir(), '_urls.json');
}
function readDocUrlIndex() {
  try {
    if (!fs.existsSync(docUrlIndexPath())) return {};
    return JSON.parse(fs.readFileSync(docUrlIndexPath(), 'utf8'));
  } catch { return {}; }
}
function saveDocUrlIndex(idx) {
  try { fs.writeFileSync(docUrlIndexPath(), JSON.stringify(idx, null, 2), 'utf8'); } catch {}
}
function hasCachedFavorites() {
  try { return fs.existsSync(favoritesCachePath()); } catch { return false; }
}
function hasCachedDocument(id) {
  try { return !!id && fs.existsSync(docCachePath(id)); } catch { return false; }
}

// Returns true if the machine appears to have network connectivity.
function isOnline() {
  return net.isOnline();
}

// Load the appropriate offline page. Prefer the cached favorites page when
// the user has previously logged in and fetched their favorites.
function loadOffline() {
  if (!mainWindow) return;
  if (hasCachedFavorites()) {
    mainWindow.loadFile(FAVORITES_FILE);
  } else {
    mainWindow.loadFile(HOME_FILE);
  }
  startRetryTimer();
}

// Try the live site; the did-fail-load handler falls back to the offline page.
function loadLive() {
  if (mainWindow) mainWindow.loadURL(TARGET_URL);
}
function loadLiveFavorites() {
  if (mainWindow) mainWindow.loadURL(FAVORITES_LIVE_URL);
}

function openDocument(id) {
  if (!mainWindow || !id) return;
  const sid = String(id);
  if (isOnline()) {
    const idx = readDocUrlIndex();
    const rec = idx[sid];
    if (rec && rec.pageUrl) {
      mainWindow.loadURL(rec.pageUrl);
    } else {
      // Live-site URL pattern for a document view (per staging routing).
      mainWindow.loadURL(TARGET_URL + 'documents/search?id=' + encodeURIComponent(sid));
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, 'document.html'), { query: { id: sid } });
  }
}

function startRetryTimer() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(() => {
    if (isOnline()) loadLive();
  }, 5000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    title: 'Matsne',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  // Decide the initial page based on connectivity.
  if (isOnline()) {
    loadLive();
  } else {
    loadOffline();
  }

  // If the live site fails to load, show the offline page and keep retrying
  // the live site quietly in the background.
  mainWindow.webContents.on('did-fail-load', (event, errorCode, _desc, validatedURL) => {
    // Ignore aborted navigations (e.g. user-triggered reloads).
    if (errorCode === -3) return;
    if (validatedURL && validatedURL.startsWith('file://')) return;

    loadOffline();
  });

  // Once a live page loads, inject the fetch/XHR interceptor so we can cache
  // the favorites API response the moment the user opens that page online.
  // Also stop the retry loop.
  mainWindow.webContents.on('did-finish-load', () => {
    let url = '';
    try { url = mainWindow.webContents.getURL(); } catch {}
    let liveOrigin = '';
    try { liveOrigin = new URL(TARGET_URL).origin; } catch {}
    if (liveOrigin && url.startsWith(liveOrigin)) {
      injectInterceptor();
      if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Injected into the live site's main world. Patches fetch and XMLHttpRequest
// so any response for the favorites API is forwarded to the main process for
// caching. Also mirrors any known auth-token localStorage keys.
function injectInterceptor(webContents) {
  const wc = webContents || (mainWindow && mainWindow.webContents);
  if (!wc) return;
  wc.executeJavaScript(INTERCEPTOR_SCRIPT, false).catch(() => {});
}

// --- Background prefetch: full offline backup of every favorite ----------
// Triggered whenever the favorites list is cached (i.e. the logged-in user is
// on their favorites page). Opens a hidden window that visits each favorite
// document so the existing interceptor caches its detail parts for offline use.
const PREFETCH_SETTLE_MS = 9000;           // max wait per document for its APIs
const PREFETCH_POLL_MS = 400;              // cache-file poll interval
const PREFETCH_GAP_MS = 400;               // pause between documents
const PREFETCH_MIN_INTERVAL_MS = 60 * 1000; // throttle repeated triggers

let prefetchWindow = null;
let prefetchRunning = false;
let lastPrefetchAt = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Mirror favorites.html's item extraction so we read the same list shape.
function extractFavoriteItems(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.content)) return data.content;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.results)) return data.results;
  if (Array.isArray(data.data)) return data.data;
  if (data.data && typeof data.data === 'object') return extractFavoriteItems(data.data);
  return [];
}

function favoriteIdsFromData(data) {
  const ids = [];
  const seen = new Set();
  for (const it of extractFavoriteItems(data)) {
    if (!it || typeof it !== 'object') continue;
    const id = it.id || it.documentId || it.docId;
    if (id == null || id === '') continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    ids.push(sid);
  }
  return ids;
}

function docCachedParts(id) {
  try {
    const p = docCachePath(id);
    if (!fs.existsSync(p)) return {};
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (rec && rec.parts) || {};
  } catch { return {}; }
}

function prefetchDocUrl(id) {
  const idx = readDocUrlIndex();
  const rec = idx[String(id)];
  if (rec && rec.pageUrl) return rec.pageUrl;
  return TARGET_URL + 'documents/search?id=' + encodeURIComponent(String(id));
}

function writePrefetchStatus(status) {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'prefetch-status.json'),
      JSON.stringify(status, null, 2), 'utf8');
  } catch {}
}

// Wait until the document's detail parts land in the cache, or give up.
async function waitForDocParts(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const parts = docCachedParts(id);
    if (parts.pageGet && parts.pageContent) return true;
    await sleep(PREFETCH_POLL_MS);
  }
  return false;
}

async function loadDocInPrefetchWindow(id) {
  if (!prefetchWindow || prefetchWindow.isDestroyed()) return;
  const wc = prefetchWindow.webContents;
  try {
    await wc.loadURL(prefetchDocUrl(id));
  } catch (e) {
    // -3 (aborted) and transient nav errors are expected; still try to cache.
  }
  // The interceptor is installed by prefetch-preload.js before page scripts run,
  // so the doc-detail XHRs are already being captured — just wait for the parts.
  await waitForDocParts(id, PREFETCH_SETTLE_MS);
}

async function prefetchFavoriteDocuments(data) {
  if (prefetchRunning) return;
  if (!isOnline()) return;
  const ids = favoriteIdsFromData(data);
  if (!ids.length) return;

  const now = Date.now();
  if (now - lastPrefetchAt < PREFETCH_MIN_INTERVAL_MS) return;
  lastPrefetchAt = now;
  prefetchRunning = true;

  writePrefetchStatus({ state: 'running', total: ids.length, done: 0, startedAt: new Date().toISOString() });

  try {
    prefetchWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'prefetch-preload.js'),
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });

    let done = 0;
    for (const id of ids) {
      if (!prefetchWindow || prefetchWindow.isDestroyed()) break;
      await loadDocInPrefetchWindow(id);
      done++;
      writePrefetchStatus({ state: 'running', total: ids.length, done, updatedAt: new Date().toISOString() });
      await sleep(PREFETCH_GAP_MS);
    }
    writePrefetchStatus({ state: 'done', total: ids.length, done, finishedAt: new Date().toISOString() });
    console.log('[prefetch] cached ' + done + '/' + ids.length + ' favorite documents');
  } catch (e) {
    console.error('Prefetch failed:', e);
    writePrefetchStatus({ state: 'error', error: String((e && e.message) || e) });
  } finally {
    try { if (prefetchWindow && !prefetchWindow.isDestroyed()) prefetchWindow.destroy(); } catch {}
    prefetchWindow = null;
    prefetchRunning = false;
  }
}

// --- IPC handlers --------------------------------------------------------

ipcMain.on('matsne:open-live', () => loadLive());
ipcMain.on('matsne:open-live-favorites', () => loadLiveFavorites());

ipcMain.on('matsne:cache-favorites', (_event, payload) => {
  try {
    const record = {
      url: payload && payload.url,
      data: payload && payload.data,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(favoritesCachePath(), JSON.stringify(record, null, 2), 'utf8');
    // On each login/favorites visit, back up every favorite document in detail.
    if (payload && payload.data) prefetchFavoriteDocuments(payload.data);
  } catch (e) {
    console.error('Failed to cache favorites:', e);
  }
});

ipcMain.on('matsne:cache-token', (_event, payload) => {
  try {
    const record = {
      key: payload && payload.key,
      value: payload && payload.value,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(tokenCachePath(), JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to cache token:', e);
  }
});

ipcMain.handle('matsne:get-cached-favorites', () => {
  try {
    if (!fs.existsSync(favoritesCachePath())) return null;
    return JSON.parse(fs.readFileSync(favoritesCachePath(), 'utf8'));
  } catch { return null; }
});

ipcMain.handle('matsne:has-cached-favorites', () => hasCachedFavorites());

ipcMain.on('matsne:cache-document', (_event, payload) => {
  try {
    if (!payload || !payload.id) return;
    const record = {
      id: String(payload.id),
      url: payload.url,
      data: payload.data,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(docCachePath(payload.id), JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to cache document:', e);
  }
});

ipcMain.on('matsne:cache-doc-part', (_event, payload) => {
  try {
    if (!payload || !payload.id || !payload.part) return;
    const p = docCachePath(payload.id);
    let rec = { id: String(payload.id), parts: {}, savedAt: null };
    if (fs.existsSync(p)) {
      try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) || rec; } catch {}
      if (!rec.parts) rec.parts = {};
    }
    rec.parts[payload.part] = payload.data;
    rec.savedAt = new Date().toISOString();
    fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to cache doc part:', e);
  }
});

ipcMain.on('matsne:cache-document-url', (_event, payload) => {
  try {
    if (!payload || !payload.id || !payload.pageUrl) return;
    const idx = readDocUrlIndex();
    idx[String(payload.id)] = { pageUrl: payload.pageUrl, savedAt: new Date().toISOString() };
    saveDocUrlIndex(idx);
  } catch (e) {
    console.error('Failed to cache document url:', e);
  }
});

ipcMain.handle('matsne:get-cached-document', (_event, id) => {
  try {
    const p = docCachePath(id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
});

ipcMain.handle('matsne:has-cached-document', (_event, id) => hasCachedDocument(id));

ipcMain.on('matsne:open-document', (_event, id) => openDocument(id));

ipcMain.handle('matsne:is-online', () => isOnline());

// Expose internals for integration tests (see test/). No effect on the app.
module.exports = { prefetchFavoriteDocuments, favoriteIdsFromData };

app.whenReady().then(() => {
  // MATSNE_HEADLESS lets tests drive the prefetch without opening the main
  // fullscreen window; the normal app always creates it.
  if (process.env.MATSNE_HEADLESS) return;
  createWindow();

  // Exit fullscreen with Escape, toggle with F11.
  globalShortcut.register('Escape', () => {
    if (mainWindow && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  });
  globalShortcut.register('F11', () => {
    if (mainWindow) {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (retryTimer) clearInterval(retryTimer);
  globalShortcut.unregisterAll();
});
