const {
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
const CODEX_TIMEOUT_MS = 90000;

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
  const fullText = normalizeText(raw);
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
  if (isCodexBusy(text)) {
    return null;
  }
  if (
    /\bOpenAI\s+Codex\b/i.test(fullText)
    && /\bmodel:\s*(?!loading\b)\S+/i.test(fullText)
    && /›/.test(text)
  ) {
    return 'ready';
  }
  return null;
}

function isCodexBusy(text) {
  return /Booting MCP server|esc to interrupt|task is in progress/i.test(text);
}

async function fetchCodexPtyResult(options = {}) {
  return spawnUsagePty({
    service: 'codex',
    command: 'codex',
    slashCommand: '/status',
    postCommandSilenceMs: 8000,
    readyCommandDelayMs: 0,
    useReadyFallback: false,
    detect: detectCodexScreen,
    parse: parseCodexStatus,
    createState() {
      return {
        busyLogged: false,
        updateSkipped: false,
        trustAccepted: false,
        statusSent: false,
      };
    },
    handlePreCommandData({ finish, markCommandSent, raw, state, term }) {
      const text = latestScreen(raw);
      if (isCodexBusy(text)) {
        if (!state.busyLogged) {
          state.busyLogged = true;
          console.log('[usage-flow] codex waiting for MCP');
        }
        return true;
      }

      const screen = detectCodexScreen(raw);

      if (screen === 'status') {
        finish();
        return true;
      }

      if (screen === 'update') {
        if (!state.updateSkipped) {
          state.updateSkipped = true;
          try {
            console.log('[usage-preflight] codex update -> down, enter');
            term.write(KEY_DOWN);
            term.write('\r');
          } catch (error) {
            finish(error.message);
          }
        }
        return true;
      }

      if (screen === 'trust') {
        if (!state.trustAccepted) {
          state.trustAccepted = true;
          try {
            console.log('[usage-preflight] codex trust -> enter');
            term.write('\r');
          } catch (error) {
            finish(error.message);
          }
        }
        return true;
      }

      if (screen === 'ready') {
        if (!state.statusSent) {
          state.statusSent = true;
          console.log('[usage-flow] codex ready -> /status');
          try {
            term.write('/status\r');
            markCommandSent();
          } catch (error) {
            finish(error.message);
          }
        }
        return true;
      }

      return false;
    },
  }, { ...options, timeoutMs: options.timeoutMs || CODEX_TIMEOUT_MS }).then((result) => {
    try {
      const screen = result.raw ? normalizeText(result.raw) : '(empty)';
      const logPath = path.join(os.tmpdir(), 'usage-gauge-codex-status.log');
      fs.writeFileSync(logPath, screen, 'utf8');
    } catch {
      // Best-effort diagnostic; must never block usage fetching.
    }
    console.log(`[usage-flow] codex result parsed=${Boolean(result.parsed)}${result.error ? ` error=${result.error}` : ''}`);
    return { ...result, tier: 'cli-pty' };
  });
}

async function fetchCodexResult(options = {}) {
  return fetchCodexPtyResult(options);
}

async function fetchCodex(options = {}) {
  const result = await fetchCodexResult(options);
  if (!result.parsed) {
    return null;
  }
  return options.debug ? { ...result.parsed, raw: result.raw } : result.parsed;
}

module.exports = {
  detectCodexScreen,
  fetchCodex,
  fetchCodexResult,
  parseCodexStatus,
};
