const {
  detectClaudeScreen,
  fetchClaude,
  fetchClaudeResult,
  parseClaudeUsage,
  shouldConfirmClaudeUsage,
} = require('./services/claudeUsage');
const {
  detectCodexScreen,
  fetchCodex,
  fetchCodexResult,
  parseCodexStatus,
} = require('./services/codexUsage');
const {
  prepareSilentForkArgs,
  resolveCodexEntrypoint,
  resolveCommand,
  shouldIgnorePtyException,
} = require('./services/cliPty');
const { stripAnsi } = require('./services/usageText');

const inFlightByService = new Map();

const SERVICE_FETCHERS = {
  claude: fetchClaudeResult,
  codex: fetchCodexResult,
};

function parseUsage(service, raw) {
  if (service === 'claude') {
    return parseClaudeUsage(raw);
  }
  if (service === 'codex') {
    return parseCodexStatus(raw);
  }
  return null;
}

function detectServiceScreen(service, raw) {
  if (service === 'claude') {
    return detectClaudeScreen(raw);
  }
  if (service === 'codex') {
    return detectCodexScreen(raw);
  }
  return null;
}

async function fetchServiceResult(service, options = {}) {
  const existing = inFlightByService.get(service);
  if (existing) {
    return existing;
  }

  const fetcher = SERVICE_FETCHERS[service];
  if (!fetcher) {
    return { parsed: null, raw: '', error: `Unknown service: ${service}` };
  }

  const promise = fetcher(options).finally(() => {
    inFlightByService.delete(service);
  });
  inFlightByService.set(service, promise);
  return promise;
}

async function fetchService(service, options = {}) {
  if (service === 'claude') {
    return fetchClaude(options);
  }
  if (service === 'codex') {
    return fetchCodex(options);
  }
  return null;
}

async function fetchUsage(options = {}) {
  const claudeResult = await fetchServiceResult('claude', options);
  const codexResult = await fetchServiceResult('codex', options);

  const usage = {
    claude: claudeResult.parsed,
    codex: codexResult.parsed,
    fetchedAt: Date.now(),
  };

  if (options.debug || !claudeResult.parsed || !codexResult.parsed) {
    usage.raw = {
      claude: claudeResult.raw,
      codex: codexResult.raw,
    };
    usage.errors = {
      claude: claudeResult.error,
      codex: codexResult.error,
    };
  }

  if (options.debug) {
    if (usage.claude) {
      usage.claude = { ...usage.claude, raw: claudeResult.raw };
    }
    if (usage.codex) {
      usage.codex = { ...usage.codex, raw: codexResult.raw };
    }
  }

  return usage;
}

module.exports = {
  detectClaudeScreen,
  detectCodexScreen,
  detectServiceScreen,
  fetchClaude,
  fetchCodex,
  fetchService,
  fetchUsage,
  parseClaudeUsage,
  parseCodexStatus,
  parseUsage,
  prepareSilentForkArgs,
  resolveCodexEntrypoint,
  resolveCommand,
  shouldConfirmClaudeUsage,
  shouldIgnorePtyException,
  stripAnsi,
};
