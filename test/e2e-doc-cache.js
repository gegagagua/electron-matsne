// End-to-end test: builds the hidden window exactly like the background prefetch
// (same prefetch-preload + interceptor) and drives it against the live staging
// document API, then asserts the document's detail parts land in the cache.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const B = process.env.MATSNE_BASE_URL || 'https://ldms-matsne.staging.cloud.gov.ge/';
const DOC_ID = process.env.TEST_DOC_ID || '1000';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'matsne-e2e-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('disable-gpu');

function docCachePath(id) {
  const dir = path.join(tmp, 'docs-cache');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, String(id) + '.json');
}
// Mirror main.js's cache-doc-part handler exactly.
ipcMain.on('matsne:cache-doc-part', (_e, payload) => {
  if (!payload || !payload.id || !payload.part) return;
  const p = docCachePath(payload.id);
  let rec = { id: String(payload.id), parts: {}, savedAt: null };
  if (fs.existsSync(p)) { try { rec = JSON.parse(fs.readFileSync(p, 'utf8')) || rec; } catch {} if (!rec.parts) rec.parts = {}; }
  rec.parts[payload.part] = payload.data;
  rec.savedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(rec, null, 2), 'utf8');
  console.log('  captured part:', payload.part, '(id ' + payload.id + ')');
});
ipcMain.on('matsne:cache-document-url', () => {});
ipcMain.on('matsne:cache-favorites', () => {});
ipcMain.on('matsne:cache-token', () => {});

function fail(m) { console.log('\nFAIL:', m); app.exit(1); }
function pass(m) { console.log('\nPASS:', m); app.exit(0); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'prefetch-preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const url = B + 'documents/search?id=' + DOC_ID;
  console.log('Loading', url);
  try { await win.webContents.loadURL(url); } catch (e) { console.log('loadURL note:', e.message); }

  const p = docCachePath(DOC_ID);
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
        const parts = (rec && rec.parts) || {};
        if (parts.pageGet && parts.pageContent) {
          console.log('\nCache file:', p);
          console.log('Parts:', Object.keys(parts).join(', '));
          console.log('pageGet top keys:', Object.keys(parts.pageGet).slice(0, 10).join(', '));
          const contentStr = JSON.stringify(parts.pageContent);
          console.log('pageContent size:', contentStr.length, 'bytes');
          return pass('document ' + DOC_ID + ' fully cached offline (pageGet + pageContent)');
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 400));
  }
  if (fs.existsSync(p)) {
    const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
    return fail('timed out; only got parts: ' + Object.keys(rec.parts || {}).join(', '));
  }
  fail('timed out; no cache file written');
});
app.on('window-all-closed', () => {});
setTimeout(() => fail('global timeout'), 30000);
