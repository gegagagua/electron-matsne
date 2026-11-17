const { contextBridge, ipcRenderer } = require('electron');

// Bridge exposed to both the live site (for caching favorites/tokens/documents)
// and the bundled offline pages (for reading the cache and switching back online).
contextBridge.exposeInMainWorld('matsne', {
  openLive: () => ipcRenderer.send('matsne:open-live'),
  openLiveFavorites: () => ipcRenderer.send('matsne:open-live-favorites'),
  openDocument: (id) => ipcRenderer.send('matsne:open-document', id),
  cacheFavorites: (url, data) => ipcRenderer.send('matsne:cache-favorites', { url, data }),
  cacheToken: (key, value) => ipcRenderer.send('matsne:cache-token', { key, value }),
  cacheDocument: (payload) => ipcRenderer.send('matsne:cache-document', payload),
  cacheDocPart: (payload) => ipcRenderer.send('matsne:cache-doc-part', payload),
  cacheDocumentUrl: (payload) => ipcRenderer.send('matsne:cache-document-url', payload),
  getCachedFavorites: () => ipcRenderer.invoke('matsne:get-cached-favorites'),
  hasCachedFavorites: () => ipcRenderer.invoke('matsne:has-cached-favorites'),
  getCachedDocument: (id) => ipcRenderer.invoke('matsne:get-cached-document', id),
  hasCachedDocument: (id) => ipcRenderer.invoke('matsne:has-cached-document', id),
  isOnline: () => ipcRenderer.invoke('matsne:is-online'),
});
