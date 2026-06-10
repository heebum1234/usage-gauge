const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  READY_COMMAND_DELAY_MS,
  spawnUsagePty,
} = require('./cliPty');
const {
  MONTHS,
  clampPct,
  deltaFromDate,
  latestScreen,
  normalizeText,
  parseClockParts,
  parseLocalReset,
} = require('./usageText');

const KEY_DOWN = '\x1b[B';
const STAGE_ENTER_DELAY_MS = 150;
const STAGE_KEY_DELAY_MS = 45;
const STATUS_COMMAND_KEYS = Array.from('/status');

function parseCodexStatus(raw) {
  const text = normalizeText(raw);
  const limitLine = text.split('\n').find((line) => /\b5h limit\s*:/.test(line));
  if (!limitLine) {
    return null;
  }

  const pctMatch = limitLine.match(/(\d{1,3})\s*%\s+left/i);
  if (!pctMatch) {
    return null;
  }

  let resetInMs = null;
  const resetMatch = limitLine.match(/resets\s+(\d{1,2}:\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})/i);
  if (resetMatch) {
    const month = MONTHS[resetMatch[3].toLowerCase()];
    const clock = parseClockParts(resetMatch[1]);
    if (month !== undefined && clock) {
      const now = new Date();
      const reset = new Date(now);
      reset.setMonth(month, Number(resetMatch[2]));
      reset.setHours(clock.hours, clock.minutes, 0, 0);
      resetInMs = deltaFromDate(reset, now);
    }
  } else {
    const timeOnlyResetMatch = limitLine.match(/resets\s+(\d{1,2}:\d{2})(?:\)|\s|$)/i);
    if (timeOnlyResetMatch) {
      resetInMs = parseLocalReset(timeOnlyResetMatch[1]);
    }
  }

  const planMatch = text.match(/Account:\s+\S+\s*\(([A-Za-z]+)\)/i);
  return {
    service: 'codex',
    pct: clampPct(Number(pctMatch[1])),
    resetInMs,
    plan: planMatch ? planMatch[1].toUpperCase() : null,
    source: 'cli-pty',
    fetchedAt: Date.now(),
  };
}

function detectCodexScreen(raw) {
  const text = latestScreen(raw);
  if (/\b5h limit\s*:/.test(text)) {
    return 'status';
  }
  if (
    /Update available!/i.test(text)
    && /\bSkip\b/i.test(text)
  ) {
    return 'update';
  }
  if (
    /trust the contents(?:\s+of)?/i.test(text)
    && /(?:Yes,\s*continue|\bYes\b[\s\S]{0,80}\bcontinue\b)/i.test(text)
  ) {
    return 'trust';
  }
  if (/›/.test(text) || /Ask Codex/i.test(text) || /Explain this codebase/i.test(text) || /\?\s+for shortcuts/i.test(text)) {
    return 'ready';
  }
  return null;
}

function predismissCodexUpdate() {
  const versionPath = path.join(os.homedir(), '.codex', 'version.json');
  let version;

  try {
    version = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
  } catch (error) {
    return;
  }

  if (
    !version
    || typeof version !== 'object'
    || !version.latest_version
    || version.dismissed_version === version.latest_version
  ) {
    return;
  }

  try {
    fs.writeFileSync(versionPath, JSON.stringify({
      ...version,
      dismissed_version: version.latest_version,
    }));
  } catch (error) {
    // Best effort only. Usage fetching must continue even if this cache cannot be updated.
  }
}

function createCodexStageState() {
  return {
    updateSkipped: false,
    trustAccepted: false,
    statusSent: false,
    waitingForScreen: null,
  };
}

function codexStageStep(state, screen) {
  const nextState = { ...createCodexStageState(), ...(state || {}) };
  const writes = [];

  if (screen === 'status') {
    return { writes, state: nextState, done: true };
  }

  if (nextState.waitingForScreen) {
    if (screen === nextState.waitingForScreen) {
      return { writes, state: nextState };
    }
    nextState.waitingForScreen = null;
  }

  if (screen === 'update') {
    if (!nextState.updateSkipped) {
      nextState.updateSkipped = true;
      nextState.waitingForScreen = 'update';
      writes.push(KEY_DOWN, '\r');
    }
    return { writes, state: nextState };
  }

  if (screen === 'trust') {
    if (!nextState.trustAccepted) {
      nextState.trustAccepted = true;
      nextState.waitingForScreen = 'trust';
      writes.push('\r');
    }
    return { writes, state: nextState };
  }

  if (screen === 'ready' && !nextState.statusSent) {
    nextState.statusSent = true;
    writes.push(...STATUS_COMMAND_KEYS, '\r');
  }

  return { writes, state: nextState };
}

function writeCodexStageKeys(term, writes, onDone, onError) {
  let index = 0;

  const writeNext = () => {
    if (!term || index >= writes.length) {
      onDone();
      return;
    }

    const write = writes[index];
    index += 1;
    try {
      term.write(write);
    } catch (error) {
      onError(error);
      return;
    }

    const delay = write === KEY_DOWN || write === '\r' ? STAGE_ENTER_DELAY_MS : STAGE_KEY_DELAY_MS;
    setTimeout(writeNext, delay);
  };

  writeNext();
}

async function fetchCodexPtyResult(options = {}) {
  try {
    predismissCodexUpdate();
  } catch (error) {
    // Best effort only. The PTY update prompt handler remains as a fallback.
  }

  return spawnUsagePty({
    service: 'codex',
    command: 'codex',
    slashCommand: '/status',
    postCommandSilenceMs: 8000,
    readyCommandDelayMs: READY_COMMAND_DELAY_MS,
    useReadyFallback: false,
    detect: detectCodexScreen,
    parse: parseCodexStatus,
    createState() {
      return createCodexStageState();
    },
    handlePreCommandData({ finish, markCommandSent, raw, state, term }) {
      const screen = detectCodexScreen(raw);
      const step = codexStageStep(state, screen);
      Object.assign(state, step.state);

      if (step.done) {
        finish();
        return true;
      }

      if (step.writes.length > 0) {
        try {
          writeCodexStageKeys(term, step.writes, () => {
            if (state.statusSent) {
              markCommandSent();
            }
          }, (error) => {
            finish(error.message);
          });
        } catch (error) {
          finish(error.message);
        }
        return true;
      }

      return screen === 'update' || screen === 'trust' || screen === 'ready';
    },
  }, { ...options, timeoutMs: options.timeoutMs || 30000 }).then((result) => ({ ...result, tier: 'cli-pty' }));
}

function collectCodexSessionFiles(dir, files = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCodexSessionFiles(entryPath, files);
    } else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) {
      try {
        files.push({ file: entryPath, mtimeMs: fs.statSync(entryPath).mtimeMs });
      } catch {
        // Ignore files that disappear during scan.
      }
    }
  }
  return files;
}

function parseCodexSessionRecord(record) {
  const payload = record && record.payload;
  const rateLimits = payload && payload.rate_limits;
  const primary = rateLimits && rateLimits.primary;
  const timestampMs = Date.parse(record && record.timestamp);
  const usedPercent = Number(primary && primary.used_percent);
  if (
    !payload
    || payload.type !== 'token_count'
    || !primary
    || !Number.isFinite(timestampMs)
    || !Number.isFinite(usedPercent)
  ) {
    return null;
  }

  let resetInMs = null;
  if (Number.isFinite(Number(primary.resets_at))) {
    resetInMs = (Number(primary.resets_at) * 1000) - Date.now();
  } else if (Number.isFinite(Number(primary.resets_in_seconds))) {
    resetInMs = timestampMs + (Number(primary.resets_in_seconds) * 1000) - Date.now();
  }

  return {
    service: 'codex',
    pct: clampPct(100 - usedPercent),
    resetInMs,
    plan: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type.toUpperCase() : null,
    source: 'session-file',
    fetchedAt: Date.now(),
    capturedAt: timestampMs,
  };
}

function parseCodexSession(options = {}) {
  const base = options.baseDir || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const sessionDir = path.join(base, 'sessions');
  const files = collectCodexSessionFiles(sessionDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 8);

  let latest = null;
  for (const { file } of files) {
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }

    let lastInFile = null;
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = parseCodexSessionRecord(JSON.parse(line));
        if (parsed) {
          lastInFile = parsed;
        }
      } catch {
        // Ignore malformed session lines.
      }
    }

    if (!lastInFile) {
      continue;
    }
    if (!latest || lastInFile.capturedAt > latest.capturedAt) {
      latest = lastInFile;
    }
  }

  return latest;
}

async function fetchCodexResult(options = {}) {
  const tier1 = await fetchCodexPtyResult(options);
  if (tier1.parsed) {
    return tier1;
  }

  const parsed = parseCodexSession(options);
  return {
    parsed,
    raw: parsed ? '' : tier1.raw,
    error: parsed ? null : (tier1.error || 'session snapshot unavailable'),
    tier: 'session-file',
  };
}

async function fetchCodex(options = {}) {
  const result = await fetchCodexResult(options);
  if (!result.parsed) {
    return null;
  }
  return options.debug ? { ...result.parsed, raw: result.raw } : result.parsed;
}

module.exports = {
  codexStageStep,
  createCodexStageState,
  detectCodexScreen,
  fetchCodex,
  fetchCodexResult,
  parseCodexSession,
  parseCodexSessionRecord,
  parseCodexStatus,
  predismissCodexUpdate,
};
