const { contextBridge, ipcRenderer } = require('electron');

const isDev = process.env.USAGE_GAUGE_DEV === '1' || process.env.npm_lifecycle_event === 'dev';

contextBridge.exposeInMainWorld('usageGauge', {
  isDev: () => isDev,
  getState: () => ipcRenderer.invoke('usage-gauge:get-state'),
  savePrefs: (prefs) => ipcRenderer.send('usage-gauge:save-prefs', prefs),
  quit: () => ipcRenderer.send('usage-gauge:quit'),
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
