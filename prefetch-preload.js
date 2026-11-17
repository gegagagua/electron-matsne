// Preload for the hidden background-prefetch window. Unlike the main preload,
// this one runs with contextIsolation disabled so it can install the fetch/XHR
// interceptor into the page's main world *before* the site's own scripts run.
// That timing matters: a fresh full-page load fires the document-detail XHRs
// during bootstrap, so the interceptor must already be in place to catch them.
const { ipcRenderer } = require('electron');
const { INTERCEPTOR_SCRIPT } = require('./interceptor');

// Expose the same bridge the interceptor expects. Because contextIsolation is
// off for this window, this assignment lands on the page's real window object.
window.matsne = {
  cacheFavorites: (url, data) => ipcRenderer.send('matsne:cache-favorites', { url, data }),
  cacheToken: (key, value) => ipcRenderer.send('matsne:cache-token', { key, value }),
  cacheDocPart: (payload) => ipcRenderer.send('matsne:cache-doc-part', payload),
  cacheDocumentUrl: (payload) => ipcRenderer.send('matsne:cache-document-url', payload),
};

// Patch fetch/XHR now, before any page script executes.
try { (0, eval)(INTERCEPTOR_SCRIPT); } catch (e) { /* ignore */ }
