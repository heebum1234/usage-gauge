const {
  READY_COMMAND_DELAY_MS,
  spawnUsagePty,
} = require('./cliPty');
const {
  MONTHS,
  clampPct,
  deltaFromDate,
  normalizeText,
  parseClockParts,
  parseLocalReset,
} = require('./usageText');

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
    source: 'cli',
    fetchedAt: Date.now(),
  };
}

function detectCodexScreen(raw) {
  const text = normalizeText(raw);
  if (/Update available!/i.test(text) || /Press enter to continue/i.test(text)) {
    return 'update';
  }
  if (/\b5h limit\s*:/.test(text)) {
    return 'status';
  }
  if (/Explain this codebase/i.test(text) || /\?\s+for shortcuts/i.test(text)) {
    return 'ready';
  }
  return null;
}

function fetchCodexResult(options = {}) {
  return spawnUsagePty({
    service: 'codex',
    command: 'codex',
    slashCommand: '/status',
    postCommandSilenceMs: 6000,
    readyCommandDelayMs: READY_COMMAND_DELAY_MS,
    detect: detectCodexScreen,
    parse: parseCodexStatus,
    createState() {
      return {
        interstitialDismissed: false,
      };
    },
    afterInitialSubmit({ markCommandSent, term }) {
      if (!term) {
        return false;
      }
      term.write('\r');
      markCommandSent();
      return true;
    },
    handlePreCommandData({ finish, raw, scheduleReadySend, state, term }) {
      const screen = detectCodexScreen(raw);
      if (screen === 'update' && !state.interstitialDismissed) {
        state.interstitialDismissed = true;
        try {
          term.write('2\r');
        } catch (error) {
          finish(error.message);
        }
        return true;
      }
      if (screen === 'ready') {
        scheduleReadySend(READY_COMMAND_DELAY_MS);
        return true;
      }
      if (screen === 'status') {
        finish();
        return true;
      }
      return false;
    },
  }, options);
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
