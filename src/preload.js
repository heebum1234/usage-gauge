const { contextBridge, ipcRenderer } = require('electron');

const isDev = process.env.USAGE_GAUGE_DEV === '1' || process.env.npm_lifecycle_event === 'dev';

contextBridge.exposeInMainWorld('usageGauge', {
  isDev: () => isDev,
  getState: () => ipcRenderer.invoke('usage-gauge:get-state'),
  savePrefs: (prefs) => ipcRenderer.send('usage-gauge:save-prefs', prefs),
  requestUsageRefresh: () => ipcRenderer.invoke('usage-gauge:request-usage-refresh'),
  quit: () => ipcRenderer.send('usage-gauge:quit'),
  onUsageUpdate: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = (_event, usage) => callback(usage);
    ipcRenderer.on('usage-gauge:usage-update', listener);
    return () => {
      ipcRenderer.removeListener('usage-gauge:usage-update', listener);
    };
  },
  onToggleDevMode: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }

    const listener = () => callback();
    ipcRenderer.on('toggle-dev-mode', listener);
    return () => {
      ipcRenderer.removeListener('toggle-dev-mode', listener);
    };
  },
});
