const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { fetchUsage } = require('./usage-fetcher');

const WINDOW_WIDTH = 456;
const WINDOW_HEIGHT = 260;
const WINDOW_INSET = 24;
const USAGE_REFRESH_MS = 30000;

const DEFAULT_PREFS = {
  gauge: 'bar',
  theme: 'dark',
  glow: 'on',
};

let mainWindow = null;
let moveSaveTimer = null;
let usageRefreshTimer = null;
let usageRefreshInFlight = null;
let stateFile = '';
let savedState = { ...DEFAULT_PREFS };

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_PREFS, ...parsed };
    }
  } catch {
    // Ignore missing or malformed file.
  }
  return { ...DEFAULT_PREFS };
}

function writeState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(savedState, null, 2), 'utf8');
  } catch {
    // Ignore transient write failures.
  }
}

function saveWindowPositionNow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const [x, y] = mainWindow.getPosition();
  savedState.x = x;
  savedState.y = y;
  writeState();
}

function scheduleWindowPositionSave() {
  clearTimeout(moveSaveTimer);
  moveSaveTimer = setTimeout(saveWindowPositionNow, 300);
}

function initialPosition() {
  const workArea = screen.getPrimaryDisplay().workArea;

  if (Number.isFinite(savedState.x) && Number.isFinite(savedState.y)) {
    return clampWindowPosition(savedState.x, savedState.y, workArea);
  }

  return {
    x: Math.round(workArea.x + workArea.width - WINDOW_WIDTH - WINDOW_INSET),
    y: Math.round(workArea.y + WINDOW_INSET),
  };
}

function clampWindowPosition(x, y, workArea = screen.getPrimaryDisplay().workArea) {
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - WINDOW_WIDTH);
  const maxY = Math.max(minY, workArea.y + workArea.height - WINDOW_HEIGHT);

  return {
    x: Math.round(Math.min(Math.max(x, minX), maxX)),
    y: Math.round(Math.min(Math.max(y, minY), maxY)),
  };
}

async function refreshUsageNow() {
  if (usageRefreshInFlight) {
    return usageRefreshInFlight;
  }

  usageRefreshInFlight = fetchUsage()
    .catch(() => ({ claude: null, codex: null, fetchedAt: Date.now() }))
    .then((usage) => {
      writeRawUsageLogs(usage);
      logUsageStatus(usage);

      const rendererUsage = {
        claude: usage.claude || null,
        codex: usage.codex || null,
        fetchedAt: usage.fetchedAt || Date.now(),
      };

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('usage-gauge:usage-update', rendererUsage);
      }
      return rendererUsage;
    })
    .finally(() => {
      usageRefreshInFlight = null;
    });

  return usageRefreshInFlight;
}

function writeRawUsageLogs(usage) {
  if (!usage || !usage.raw) {
    return;
  }

  for (const service of ['claude', 'codex']) {
    if (usage[service] || !usage.raw[service]) {
      continue;
    }

    try {
      fs.writeFileSync(
        path.join(app.getPath('userData'), `last-usage-output-${service}.log`),
        usage.raw[service],
        'utf8',
      );
    } catch {
      // Debug logs are best-effort only.
    }
  }
}

function logUsageStatus(usage) {
  for (const service of ['claude', 'codex']) {
    const result = usage && usage[service];
    if (result && Number.isFinite(result.pct)) {
      console.log(`[usage] ${service}=ok ${result.pct}%`);
    } else {
      console.log(`[usage] ${service}=unreachable`);
    }
  }
}

function startUsageRefresh() {
  clearInterval(usageRefreshTimer);
  refreshUsageNow();
  usageRefreshTimer = setInterval(refreshUsageNow, USAGE_REFRESH_MS);
}

function handleLocalShortcut(event, input) {
  if (input.type !== 'keyDown') {
    return;
  }

  const key = (input.key || '').toLowerCase();
  const cmdOrCtrl = process.platform === 'darwin' ? input.meta : input.control;

  if (cmdOrCtrl && input.shift && key === 'd') {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('toggle-dev-mode');
    }
    return;
  }

  const shouldQuit =
    (process.platform === 'darwin' && input.meta && key === 'q') ||
    (process.platform !== 'darwin' && input.control && key === 'w');

  if (shouldQuit) {
    event.preventDefault();
    app.quit();
  }
}

function createWindow() {
  const { x, y } = initialPosition();

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (process.platform === 'darwin') {
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.on('before-input-event', handleLocalShortcut);

  mainWindow.on('move', scheduleWindowPositionSave);
  mainWindow.on('close', () => {
    clearTimeout(moveSaveTimer);
    saveWindowPositionNow();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', startUsageRefresh);
}

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    stateFile = path.join(app.getPath('userData'), 'window-state.json');
    savedState = readState();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

ipcMain.handle('usage-gauge:get-state', () => ({
  prefs: {
    gauge: savedState.gauge || DEFAULT_PREFS.gauge,
    theme: savedState.theme || DEFAULT_PREFS.theme,
    glow: savedState.glow || DEFAULT_PREFS.glow,
  },
}));

ipcMain.on('usage-gauge:save-prefs', (_event, prefs) => {
  if (!prefs || typeof prefs !== 'object') {
    return;
  }

  if (typeof prefs.gauge === 'string') {
    savedState.gauge = prefs.gauge;
  }
  if (typeof prefs.theme === 'string') {
    savedState.theme = prefs.theme;
  }
  if (typeof prefs.glow === 'string') {
    savedState.glow = prefs.glow;
  }

  writeState();
});

ipcMain.on('usage-gauge:quit', () => {
  app.quit();
});

ipcMain.handle('usage-gauge:request-usage-refresh', () => refreshUsageNow());

app.on('window-all-closed', () => {
  clearInterval(usageRefreshTimer);
  app.quit();
});
