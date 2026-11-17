const { app, BrowserWindow, globalShortcut, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');

// Live site. When it cannot be reached, the app falls back to bundled offline
// pages. If the user has ever visited their favorites while logged in, the
// favorites page is shown offline; otherwise the generic home page is shown.
const TARGET_URL = 'https://ldms-matsne.staging.cloud.gov.ge/';
const FAVORITES_LIVE_URL = 'https://ldms-matsne.staging.cloud.gov.ge/profile/favorites';
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
function injectInterceptor() {
  if (!mainWindow) return;
  const script = `
    (function () {
      if (window.__matsneHooked) return;
      window.__matsneHooked = true;

      function isFavUrl(u) {
        return typeof u === 'string' && u.indexOf('/profile/favorites') !== -1;
      }
      function getQueryParam(u, name) {
        try {
          var q = String(u).split('?')[1];
          if (!q) return null;
          var re = new RegExp('(?:^|&)' + name + '=([^&#]+)');
          var m = q.match(re);
          return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
      }
      // Cache the currently-viewed document id so page/content and structure/get
      // responses (which key on publicationId) can be associated with it.
      window.__matsneCurrentDocId = null;

      function classifyDocApi(u) {
        // Returns { id, part } if the URL is a doc-detail API we want to cache.
        try {
          if (typeof u !== 'string') return null;
          if (u.indexOf('/normative/page/get') !== -1) {
            var idA = getQueryParam(u, 'id');
            if (idA) return { id: idA, part: 'pageGet' };
          }
          if (u.indexOf('/normative/page/content') !== -1 && window.__matsneCurrentDocId) {
            return { id: window.__matsneCurrentDocId, part: 'pageContent' };
          }
          if (u.indexOf('/normative/structure/get') !== -1 && window.__matsneCurrentDocId) {
            return { id: window.__matsneCurrentDocId, part: 'structureGet' };
          }
        } catch (e) {}
        return null;
      }

      var origFetch = window.fetch;
      window.fetch = function () {
        var args = arguments;
        var url = '';
        try { url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''; } catch (e) {}
        return origFetch.apply(this, args).then(function (res) {
          try {
            if (isFavUrl(url) && res && res.ok) {
              res.clone().json().then(function (data) {
                try { window.matsne && window.matsne.cacheFavorites && window.matsne.cacheFavorites(url, data); } catch (e) {}
              }).catch(function () {});
            }
            var docCls = classifyDocApi(url);
            if (docCls && res && res.ok) {
              res.clone().json().then(function (data) {
                try { window.matsne && window.matsne.cacheDocPart && window.matsne.cacheDocPart({ id: docCls.id, part: docCls.part, data: data }); } catch (e) {}
              }).catch(function () {});
            }
          } catch (e) {}
          return res;
        });
      };

      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__matsneUrl = u; return origOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        var self = this;
        this.addEventListener('load', function () {
          try {
            var u = self.__matsneUrl;
            if (isFavUrl(u) && self.status >= 200 && self.status < 300) {
              var data = null;
              try { data = JSON.parse(self.responseText); } catch (e) {}
              if (data) {
                try { window.matsne && window.matsne.cacheFavorites && window.matsne.cacheFavorites(u, data); } catch (e) {}
              }
            }
            var docCls = classifyDocApi(u);
            if (docCls && self.status >= 200 && self.status < 300) {
              var docData = null;
              try { docData = JSON.parse(self.responseText); } catch (e) {}
              if (docData) {
                try { window.matsne && window.matsne.cacheDocPart && window.matsne.cacheDocPart({ id: docCls.id, part: docCls.part, data: docData }); } catch (e) {}
              }
            }
          } catch (e) {}
        });
        return origSend.apply(this, arguments);
      };

      function reportDocLocation() {
        try {
          if (location.pathname.indexOf('/documents/search') !== -1) {
            var id = getQueryParam(location.search, 'id');
            if (id) {
              window.__matsneCurrentDocId = id;
              try { window.matsne && window.matsne.cacheDocumentUrl && window.matsne.cacheDocumentUrl({ id: id, pageUrl: location.href }); } catch (e) {}
            }
          } else {
            window.__matsneCurrentDocId = null;
          }
        } catch (e) {}
      }
      var _push = history.pushState;
      history.pushState = function () { var r = _push.apply(history, arguments); reportDocLocation(); return r; };
      var _replace = history.replaceState;
      history.replaceState = function () { var r = _replace.apply(history, arguments); reportDocLocation(); return r; };
      window.addEventListener('popstate', reportDocLocation);
      reportDocLocation();
      setInterval(reportDocLocation, 3000);

      function pushToken() {
        try {
          var keys = ['token', 'authToken', 'access_token', 'accessToken', 'jwt', 'Authorization', 'id_token'];
          for (var i = 0; i < keys.length; i++) {
            var v = null;
            try { v = localStorage.getItem(keys[i]); } catch (e) {}
            if (v) {
              try { window.matsne && window.matsne.cacheToken && window.matsne.cacheToken(keys[i], v); } catch (e) {}
              return;
            }
          }
        } catch (e) {}
      }
      pushToken();
      setInterval(pushToken, 5000);
    })();
  `;
  mainWindow.webContents.executeJavaScript(script, false).catch(() => {});
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

app.whenReady().then(() => {
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
