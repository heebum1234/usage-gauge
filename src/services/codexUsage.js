const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  COMMAND_SUBMIT_DELAY_MS,
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
  if (
    /(?:trust|allow)[\s\S]{0,120}(?:folder|directory)/i.test(text)
    && /(?:yes|allow|approve|continue|press\s+enter|\b1[.)]?)/i.test(text)
  ) {
    return 'trust';
  }
  if (/Update available!/i.test(text) || /Press enter to continue/i.test(text)) {
    return 'update';
  }
  if (/\b5h limit\s*:/.test(text)) {
    return 'status';
  }
  if (/Explain this codebase/i.test(text) || /Find and fix a bug in @filename/i.test(text) || /\?\s+for shortcuts/i.test(text)) {
    return 'ready';
  }
  return null;
}

function shouldRetryCodexStatusSubmit(raw) {
  const text = normalizeText(raw);
  if (/\b5h limit\s*:/.test(text)) {
    return false;
  }
  return /(^|\n)\s*[›>]\s*\/status\b/im.test(text);
}

function shouldRefreshCodexLimits(raw) {
  const text = normalizeText(raw);
  if (/\b5h limit\s*:/.test(text)) {
    return false;
  }
  return /(?:>_\s*OpenAI Codex|Limits\s*:)/i.test(text)
    && /refresh requested|run \/status again/i.test(text);
}

function bracketedPaste(text) {
  return `\x1b[200~${text}\x1b[201~`;
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

function fetchCodexResult(options = {}) {
  try {
    predismissCodexUpdate();
  } catch (error) {
    // Best effort only. The PTY update prompt handler remains as a fallback.
  }

  return spawnUsagePty({
    service: 'codex',
    command: 'codex',
    slashCommand: bracketedPaste('/status'),
    postCommandSilenceMs: 8000,
    readyCommandDelayMs: READY_COMMAND_DELAY_MS,
    detect: detectCodexScreen,
    parse: parseCodexStatus,
    createState() {
      return {
        interstitialDismissed: false,
        limitsRefreshRetryCount: 0,
        limitsRefreshTimer: null,
        statusRetryCount: 0,
        trustAccepted: false,
      };
    },
    teardownState(state) {
      clearTimeout(state.limitsRefreshTimer);
    },
    afterInitialSubmit({ markCommandSent }) {
      markCommandSent();
      return true;
    },
    handlePreCommandData({ finish, raw, scheduleReadySend, state, term }) {
      const screen = detectCodexScreen(raw);
      if (screen === 'trust' && !state.trustAccepted) {
        state.trustAccepted = true;
        try {
          // Best-effort fallback; preseeded trust config should usually avoid this prompt.
          term.write('\r');
        } catch (error) {
          finish(error.message);
        }
        return true;
      }
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
    handlePostCommandData({ finish, raw, state, term }) {
      if (shouldRefreshCodexLimits(raw) && state.limitsRefreshRetryCount < 2) {
        state.limitsRefreshRetryCount += 1;
        clearTimeout(state.limitsRefreshTimer);
        state.limitsRefreshTimer = setTimeout(() => {
          try {
            term.write(bracketedPaste('/status'));
            setTimeout(() => {
              try {
                term.write('\r');
              } catch (error) {
                finish(error.message);
              }
            }, COMMAND_SUBMIT_DELAY_MS);
          } catch (error) {
            finish(error.message);
          }
        }, 1800);
        return true;
      }
      if (!shouldRetryCodexStatusSubmit(raw) || state.statusRetryCount > 0) {
        return false;
      }
      state.statusRetryCount += 1;
      try {
        term.write('\r');
      } catch (error) {
        finish(error.message);
      }
      return false;
    },
  }, { ...options, timeoutMs: options.timeoutMs || 30000 });
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
  predismissCodexUpdate,
  bracketedPaste,
  shouldRefreshCodexLimits,
  shouldRetryCodexStatusSubmit,
};
