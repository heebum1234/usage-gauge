const {
  READY_SILENCE_MS,
  SILENCE_AFTER_COMMAND_MS,
  spawnUsagePty,
} = require('./cliPty');
const {
  clampPct,
  normalizeText,
  parseLocalReset,
} = require('./usageText');

function parseClaudeUsage(raw) {
  const text = normalizeText(raw);
  const sectionMatch = text.match(/Current\s+session([\s\S]{0,1600}?)(?:Current\s+week|Extra usage|Esc to cancel|$)/i);
  if (!sectionMatch) {
    return null;
  }

  const section = sectionMatch[1];
  const usedMatch = section.match(/(\d{1,3})\s*%\s+used/i);
  if (!usedMatch) {
    return null;
  }

  const resetSource = extractClaudeResetText(section);
  const planMatch = text.match(/\bClaude\s+(Max\s*20(?:x|횞)|Max|Pro)\b/i);
  const plan = planMatch ? planMatch[1].replace(/\s+/g, '').replace(/횞/g, 'X').toUpperCase() : null;
  return {
    service: 'claude',
    pct: clampPct(100 - Number(usedMatch[1])),
    resetInMs: resetSource ? parseLocalReset(resetSource) : null,
    plan,
    source: 'cli',
    fetchedAt: Date.now(),
  };
}

function extractClaudeResetText(section) {
  const explicitMatch = section.match(/Resets?\s+([^\n]+)/i);
  if (explicitMatch) {
    return explicitMatch[1].trim();
  }

  // Claude's ANSI row reassembly can split "Resets" into fragments like "Rese s".
  const fallbackMatch = section.match(/Rese[\s\S]{0,12}?((?:[A-Za-z]{3,}\s+\d{1,2},\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s*\([^)]*\))?)/i);
  if (fallbackMatch) {
    return fallbackMatch[1].trim();
  }

  return null;
}

function detectClaudeScreen(raw) {
  const text = normalizeText(raw);
  if (/Current session/i.test(text)) {
    return 'status';
  }
  if (/\?\s+for shortcuts/i.test(text) || /\bClaude Code\b/i.test(text)) {
    return 'ready';
  }
  return null;
}

function shouldConfirmClaudeUsage(raw) {
  return /\/usage\s+Show session cost,\s+plan usage,\s+and activity stats/i.test(normalizeText(raw));
}

function fetchClaudeResult(options = {}) {
  let claudeConfirmFallbackTimer = null;
  return spawnUsagePty({
    service: 'claude',
    command: 'claude',
    slashCommand: '/usage',
    postCommandSilenceMs: SILENCE_AFTER_COMMAND_MS,
    readyCommandDelayMs: 0,
    detect: detectClaudeScreen,
    parse: parseClaudeUsage,
    createState() {
      return {
        awaitingUsageConfirm: false,
        usageConfirmSent: false,
      };
    },
    teardownState() {
      clearTimeout(claudeConfirmFallbackTimer);
    },
    afterInitialSubmit({ raw, state }) {
      state.awaitingUsageConfirm = true;
      if (state.usageConfirmSent || !shouldConfirmClaudeUsage(raw)) {
        return true;
      }
      return false;
    },
    handlePreCommandData({ finish, markCommandSent, raw, sendSlashCommand, state, term }) {
      const queueClaudeUsageConfirm = () => {
        if (state.usageConfirmSent) {
          return true;
        }
        state.usageConfirmSent = true;
        if (!term) {
          return true;
        }
        try {
          term.write('\r');
          state.awaitingUsageConfirm = false;
          markCommandSent();
          clearTimeout(claudeConfirmFallbackTimer);
          claudeConfirmFallbackTimer = setTimeout(() => {
            if (!term || parseClaudeUsage(raw) || !shouldConfirmClaudeUsage(raw)) {
              return;
            }
            try {
              term.write('\r');
            } catch (error) {
              finish(error.message);
            }
          }, 180);
        } catch (error) {
          finish(error.message);
        }
        return true;
      };

      if (!state.usageConfirmSent && shouldConfirmClaudeUsage(raw)) {
        return queueClaudeUsageConfirm();
      }

      const screen = detectClaudeScreen(raw);
      if (screen === 'ready') {
        sendSlashCommand();
        return true;
      }
      if (screen === 'status') {
        finish();
        return true;
      }

      if (state.awaitingUsageConfirm) {
        clearTimeout(claudeConfirmFallbackTimer);
        claudeConfirmFallbackTimer = setTimeout(() => {
          if (!term || parseClaudeUsage(raw) || !shouldConfirmClaudeUsage(raw)) {
            return;
          }
          try {
            term.write('\r');
          } catch (error) {
            finish(error.message);
          }
        }, READY_SILENCE_MS);
      }

      return false;
    },
  }, options);
}

async function fetchClaude(options = {}) {
  const result = await fetchClaudeResult(options);
  if (!result.parsed) {
    return null;
  }
  return options.debug ? { ...result.parsed, raw: result.raw } : result.parsed;
}

module.exports = {
  detectClaudeScreen,
  extractClaudeResetText,
  fetchClaude,
  fetchClaudeResult,
  parseClaudeUsage,
  shouldConfirmClaudeUsage,
};
