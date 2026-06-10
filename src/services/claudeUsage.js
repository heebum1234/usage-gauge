const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  READY_SILENCE_MS,
  SILENCE_AFTER_COMMAND_MS,
  spawnUsagePty,
} = require('./cliPty');
const { resolveCommand } = require('./cliPty');
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
    source: 'cli-pty',
    fetchedAt: Date.now(),
  };
}

function parseClaudeUsageText(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const match = text.match(/Current session:\s*(\d{1,3})\s*%\s*used[^\n]*?resets?\s+([^\n]+)/i);
  if (!match) {
    return null;
  }

  return {
    service: 'claude',
    pct: clampPct(100 - Number(match[1])),
    resetInMs: parseLocalReset(match[2].trim()),
    plan: null,
    source: 'cli-print',
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
  if (/Do you trust the files in this folder/i.test(text) || /trust the files/i.test(text)) {
    return 'trust';
  }
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

function fetchClaudePrintResult(options = {}) {
  const command = resolveCommand('claude');
  const timeoutMs = options.timeoutMs || 15000;
  const cwd = options.cwd || os.homedir();

  return new Promise((resolve) => {
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const raw = stdout || stderr;
      resolve({
        parsed: parseClaudeUsageText(stdout),
        raw,
        error,
        tier: 'cli-print',
      });
    };

    const timer = setTimeout(() => {
      try {
        if (child) {
          child.kill();
        }
      } catch {
        // Ignore teardown races.
      }
      finish('timeout');
    }, timeoutMs);

    try {
      child = childProcess.spawn(command.file, [...command.args, '-p', '/usage'], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(error.message);
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    child.on('error', (error) => finish(error.message));
    child.on('close', (code) => {
      const parsed = parseClaudeUsageText(stdout);
      resolve({
        parsed,
        raw: stdout || stderr,
        error: parsed ? null : (code === 0 ? null : `exit ${code}`),
        tier: 'cli-print',
      });
      settled = true;
      clearTimeout(timer);
    });
  });
}

function fetchClaudePtyResult(options = {}) {
  let claudeConfirmFallbackTimer = null;
  return spawnUsagePty({
    service: 'claude',
    command: 'claude',
    slashCommand: '/usage',
    postCommandSilenceMs: SILENCE_AFTER_COMMAND_MS,
    readyCommandDelayMs: 0,
    useReadyFallback: false,
    detect: detectClaudeScreen,
    parse: parseClaudeUsage,
    createState() {
      return {
        awaitingUsageConfirm: false,
        trustAccepted: false,
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
      if (screen === 'trust' && !state.trustAccepted) {
        state.trustAccepted = true;
        try {
          term.write('\r');
        } catch (error) {
          finish(error.message);
        }
        return true;
      }
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
  }, options).then((result) => ({ ...result, tier: 'cli-pty' }));
}

function readClaudeCredentials() {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const oauth = parsed && parsed.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      return null;
    }
    return {
      accessToken: typeof oauth.accessToken === 'string' ? oauth.accessToken : null,
      expiresAt: Number(oauth.expiresAt),
      plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType.toUpperCase() : null,
    };
  } catch {
    return null;
  }
}

async function fetchClaudeOauthResult() {
  const credentials = readClaudeCredentials();
  if (!credentials) {
    return { parsed: null, raw: '', error: 'credentials unavailable', tier: 'oauth-http' };
  }

  if (!credentials.accessToken || !Number.isFinite(credentials.expiresAt) || credentials.expiresAt < Date.now()) {
    const parsed = credentials.plan
      ? {
        service: 'claude',
        pct: null,
        resetInMs: null,
        plan: credentials.plan,
        source: 'credentials-file',
        fetchedAt: Date.now(),
      }
      : null;
    return { parsed, raw: '', error: parsed ? null : 'credentials expired', tier: 'credentials-file' };
  }

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      return { parsed: null, raw: `HTTP ${response.status}`, error: `HTTP ${response.status}`, tier: 'oauth-http' };
    }

    const body = await response.json();
    const fiveHour = body && body.five_hour;
    const utilization = Number(fiveHour && fiveHour.utilization);
    const resetsAt = Date.parse(fiveHour && fiveHour.resets_at);
    if (!Number.isFinite(utilization) || !Number.isFinite(resetsAt)) {
      return { parsed: null, raw: JSON.stringify(maskClaudeCredentials(body)), error: 'usage response missing five_hour', tier: 'oauth-http' };
    }

    return {
      parsed: {
        service: 'claude',
        pct: clampPct(100 - utilization),
        resetInMs: resetsAt - Date.now(),
        plan: credentials.plan,
        source: 'oauth-http',
        fetchedAt: Date.now(),
      },
      raw: '',
      error: null,
      tier: 'oauth-http',
    };
  } catch (error) {
    return { parsed: null, raw: '', error: error.message, tier: 'oauth-http' };
  }
}

function maskClaudeCredentials(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(maskClaudeCredentials);
  }
  const masked = {};
  for (const [key, child] of Object.entries(value)) {
    masked[key] = /token/i.test(key) ? '[redacted]' : maskClaudeCredentials(child);
  }
  return masked;
}

async function fetchClaudeResult(options = {}) {
  const tier1 = await fetchClaudePtyResult(options);
  if (tier1.parsed) {
    return tier1;
  }

  const tier2 = await fetchClaudePrintResult(options);
  if (tier2.parsed) {
    return tier2;
  }

  return fetchClaudeOauthResult(options);
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
  parseClaudeUsageText,
  shouldConfirmClaudeUsage,
};
