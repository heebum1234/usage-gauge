const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { fetchServiceResult } = require('./usage-fetcher');
const { ensureProbeWorkspace } = require('./services/cliWorkspace');

const WINDOW_WIDTH = 456;
const WINDOW_HEIGHT = 260;
const WINDOW_INSET = 24;
const USAGE_REFRESH_MS = 30000;
const USAGE_RETRY_MS = 5000;
const MAX_FAST_RETRIES = 2;

const DEFAULT_PREFS = {
  gauge: 'bar',
  theme: 'dark',
  glow: 'on',
};

let mainWindow = null;
let moveSaveTimer = null;
let stateFile = '';
let probeDir = '';
let savedState = { ...DEFAULT_PREFS };
let lastSuccessfulUsage = { claude: null, codex: null };
let usageRefreshStopped = false;
const usageRefreshState = {
  claude: { timer: null, inFlight: null, fastRetryCount: 0 },
  codex: { timer: null, inFlight: null, fastRetryCount: 0 },
};

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_PREFS, ...parsed, glow: 'on' };
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
  const results = await Promise.all(['claude', 'codex'].map((service) => refreshUsageServiceNow(service)));
  return {
    claude: results[0] && results[0].parsed,
    codex: results[1] && results[1].parsed,
    fetchedAt: Date.now(),
  };
}

function refreshUsageServiceNow(service) {
  const state = usageRefreshState[service];
  if (!state) {
    return Promise.resolve({ parsed: null, raw: '', error: `Unknown service: ${service}`, tier: null });
  }
  if (state.inFlight) {
    return state.inFlight;
  }

  const options = probeDir ? { cwd: probeDir } : undefined;
  state.inFlight = fetchServiceResult(service, options)
    .catch((error) => ({ parsed: null, raw: '', error: error.message, tier: null }))
    .then((result) => {
      handleServiceUsageResult(service, result);
      return result;
    })
    .finally(() => {
      state.inFlight = null;
    });

  return state.inFlight;
}

function handleServiceUsageResult(service, result) {
  const parsed = result && result.parsed;

  if (parsed) {
    lastSuccessfulUsage[service] = parsed;
  } else if (result && result.raw) {
    writeRawUsageLog(service, result.raw);
  }

  logServiceUsageStatus(service, parsed);
  sendUsageSnapshot();
  scheduleNextServiceUsageRefresh(service, Boolean(parsed));
}

function sendUsageSnapshot() {
  const rendererUsage = {
    claude: lastSuccessfulUsage.claude || null,
    codex: lastSuccessfulUsage.codex || null,
    fetchedAt: Date.now(),
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('usage-gauge:usage-update', rendererUsage);
  }
}

function writeRawUsageLog(service, raw) {
  if (!raw) {
    return;
  }

  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), `last-usage-output-${service}.log`),
      raw,
      'utf8',
    );
  } catch {
    // Debug logs are best-effort only.
  }
}

function logServiceUsageStatus(service, result) {
  if (result && Number.isFinite(result.pct)) {
    console.log(`[usage] ${service}=ok ${result.pct}% (${result.source || 'unknown'})`);
  } else {
    console.log(`[usage] ${service}=unreachable`);
  }
}

function startUsageRefresh() {
  usageRefreshStopped = false;
  for (const service of ['claude', 'codex']) {
    clearServiceUsageRefresh(service);
    usageRefreshState[service].fastRetryCount = 0;
    refreshUsageServiceNow(service);
  }
}

function clearServiceUsageRefresh(service) {
  const state = usageRefreshState[service];
  if (!state) {
    return;
  }
  clearTimeout(state.timer);
  state.timer = null;
}

function scheduleServiceUsageRefresh(service, delayMs) {
  if (usageRefreshStopped) {
    return;
  }
  const state = usageRefreshState[service];
  if (!state) {
    return;
  }
  clearTimeout(state.timer);
  state.timer = setTimeout(() => runScheduledServiceUsageRefresh(service), delayMs);
}

function scheduleNextServiceUsageRefresh(service, completed) {
  if (usageRefreshStopped) {
    return;
  }
  const state = usageRefreshState[service];
  if (!state) {
    return;
  }
  if (!completed && state.fastRetryCount < MAX_FAST_RETRIES) {
    state.fastRetryCount += 1;
    scheduleServiceUsageRefresh(service, USAGE_RETRY_MS);
    return;
  }

  state.fastRetryCount = 0;
  scheduleServiceUsageRefresh(service, USAGE_REFRESH_MS);
}

function runScheduledServiceUsageRefresh(service) {
  refreshUsageServiceNow(service);
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
    probeDir = ensureProbeWorkspace(app.getPath('userData'));
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
  usageRefreshStopped = true;
  for (const service of ['claude', 'codex']) {
    clearServiceUsageRefresh(service);
  }
  app.quit();
});
