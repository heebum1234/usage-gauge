const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = childProcess;

const DEFAULT_TIMEOUT_MS = 15000;
const READY_SILENCE_MS = 500;
const READY_FALLBACK_MS = 8000;
const READY_COMMAND_DELAY_MS = 1200;
const COMMAND_SUBMIT_DELAY_MS = 180;
const COMMAND_EXEC_DELAY_MS = 380;
const SILENCE_AFTER_COMMAND_MS = 3000;
const PARSE_GRACE_MS = 250;

const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const SERVICE_CONFIG = {
  claude: {
    command: 'claude',
    slashCommand: '/usage',
    postCommandSilenceMs: SILENCE_AFTER_COMMAND_MS,
  },
  codex: {
    command: 'codex',
    slashCommand: '/status',
    postCommandSilenceMs: 6000,
  },
};

const inFlightByService = new Map();
let ptyForkPatched = false;

function prepareSilentForkArgs(modulePath, args, options) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const normalizedOptions = Array.isArray(args) ? { ...(options || {}) } : { ...((args && typeof args === 'object') ? args : {}) };
  if (/conpty_console_list_agent(?:\.js)?$/i.test(String(modulePath || ''))) {
    normalizedOptions.silent = true;
  }
  return {
    args: normalizedArgs,
    options: normalizedOptions,
  };
}

function patchNodePtyFork() {
  if (ptyForkPatched || process.platform !== 'win32') {
    return;
  }

  const originalFork = childProcess.fork;
  childProcess.fork = function patchedFork(modulePath, args, options) {
    const prepared = prepareSilentForkArgs(modulePath, args, options);
    return originalFork.call(this, modulePath, prepared.args, prepared.options);
  };
  ptyForkPatched = true;
}

function getInitialSubmitCount(service) {
  return service === 'claude' ? 1 : 2;
}

function getReadyCommandDelay(service) {
  return service === 'claude' ? 0 : READY_COMMAND_DELAY_MS;
}

function loadPty() {
  try {
    patchNodePtyFork();
    return require('node-pty');
  } catch {
    return null;
  }
}

function stripAnsi(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
}

function reassembleTuiRows(raw) {
  return String(raw || '')
    .replace(/\\x1b/g, '\x1b')
    .replace(/\x1b\[(\d+)C/g, (_match, count) => ' '.repeat(Math.max(1, Number(count) || 1)))
    .replace(/\x1b\[(?:\d+;)?\d+H/g, '\n');
}

function normalizeText(raw) {
  return stripAnsi(reassembleTuiRows(raw))
    .replace(/[│╭╮╰╯─]/g, ' ')
    .replace(/[█▌░▒▓]/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function clampPct(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function parseClockParts(value) {
  const match = String(value || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;

  if (meridiem === 'pm' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  }

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return { hours, minutes };
}

function deltaFromDate(reset, now) {
  if (reset.getTime() <= now.getTime()) {
    reset.setFullYear(reset.getFullYear() + 1);
  }
  return reset.getTime() - now.getTime();
}

function parseLocalReset(value, now = new Date()) {
  const text = String(value || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/,/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  if (!text) {
    return null;
  }

  const monthDayTime = text.match(/^([A-Za-z]{3,})\s+(\d{1,2})(?:\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?$/i);
  if (monthDayTime) {
    const month = MONTHS[monthDayTime[1].slice(0, 3).toLowerCase()];
    const day = Number(monthDayTime[2]);
    const clock = monthDayTime[3] ? parseClockParts(monthDayTime[3]) : { hours: 0, minutes: 0 };
    if (month === undefined || !clock) {
      return null;
    }

    const reset = new Date(now);
    reset.setMonth(month, day);
    reset.setHours(clock.hours, clock.minutes, 0, 0);
    return deltaFromDate(reset, now);
  }

  const clock = parseClockParts(text);
  if (clock) {
    const reset = new Date(now);
    reset.setHours(clock.hours, clock.minutes, 0, 0);
    if (reset.getTime() <= now.getTime()) {
      reset.setDate(reset.getDate() + 1);
    }
    return reset.getTime() - now.getTime();
  }

  return null;
}

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

  const resetMatch = section.match(/Resets\s+([^\n]+?)(?:\s*\(|$)/i);
  const planMatch = text.match(/\bClaude\s+(Max\s*20(?:x|×)|Max|Pro)\b/i);
  const plan = planMatch ? planMatch[1].replace(/\s+/g, '').replace(/×/g, 'X').toUpperCase() : null;
  return {
    pct: clampPct(100 - Number(usedMatch[1])),
    resetInMs: resetMatch ? parseLocalReset(resetMatch[1]) : null,
    plan,
    source: 'cli',
  };
}

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
    pct: clampPct(Number(pctMatch[1])),
    resetInMs,
    plan: planMatch ? planMatch[1].toUpperCase() : null,
    source: 'cli',
  };
}

function parseUsage(service, raw) {
  if (service === 'claude') {
    return parseClaudeUsage(raw);
  }
  if (service === 'codex') {
    return parseCodexStatus(raw);
  }
  return null;
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

function detectServiceScreen(service, raw) {
  if (service === 'claude') {
    return detectClaudeScreen(raw);
  }
  if (service === 'codex') {
    return detectCodexScreen(raw);
  }
  return null;
}

function shouldConfirmClaudeUsage(raw) {
  return /\/usage\s+Show session cost,\s+plan usage,\s+and activity stats/i.test(normalizeText(raw));
}

function shouldIgnorePtyException(error) {
  const message = error && error.message ? error.message : String(error);
  return /AttachConsole failed/i.test(message);
}

function chooseWindowsCommandCandidate(candidates) {
  if (candidates.length === 0) {
    return null;
  }

  const voltaBin = candidates.filter((candidate) => candidate.toLowerCase().includes('\\volta\\bin\\'));
  const nonInternal = candidates.filter((candidate) => !candidate.toLowerCase().includes('\\volta\\tools\\'));
  const pool = voltaBin.length > 0 ? voltaBin : nonInternal;
  const exe = pool.find((candidate) => /\.exe$/i.test(candidate));
  const script = pool.find((candidate) => /\.(cmd|bat)$/i.test(candidate));
  return exe || script || pool[0] || null;
}

function getPathCandidates(command) {
  let candidates = [];
  try {
    candidates = execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    candidates = findWindowsPathCandidates(command);
  }

  return candidates;
}

function resolveCodexEntrypoint(candidates) {
  const toolShim = candidates.find((candidate) => /\\volta\\tools\\image\\node\\[^\\]+\\codex(?:\.(?:cmd|ps1))?$/i.test(candidate));
  if (!toolShim) {
    return null;
  }

  const baseDir = path.dirname(toolShim);
  const nodeExe = path.join(baseDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const cliScript = path.join(baseDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(nodeExe) || !fs.existsSync(cliScript)) {
    return null;
  }

  return {
    file: nodeExe,
    args: [cliScript],
    resolvedPath: cliScript,
  };
}

function findWindowsPathCandidates(command) {
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const hasExtension = /\.[^\\/]+$/.test(command);
  const extensions = hasExtension ? [''] : ['', '.exe', '.cmd', '.bat'];
  const seen = new Set();
  const candidates = [];

  for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      const key = candidate.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      try {
        if (fs.existsSync(candidate)) {
          candidates.push(candidate);
        }
      } catch {
        // Ignore unreadable PATH entries.
      }
    }
  }

  return candidates;
}

function resolveCommand(command) {
  if (process.platform !== 'win32') {
    return { file: command, args: [], resolvedPath: command };
  }

  const candidates = getPathCandidates(command);
  if (command === 'codex') {
    const codexEntrypoint = resolveCodexEntrypoint(candidates);
    if (codexEntrypoint) {
      return codexEntrypoint;
    }
  }

  const resolvedPath = chooseWindowsCommandCandidate(candidates) || command;

  if (/\.(cmd|bat)$/i.test(resolvedPath)) {
    return {
      file: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', resolvedPath],
      resolvedPath,
    };
  }

  return { file: resolvedPath, args: [], resolvedPath };
}

function spawnServicePty(service, options = {}) {
  const config = SERVICE_CONFIG[service];
  if (!config) {
    return Promise.resolve({ parsed: null, raw: '', error: `Unknown service: ${service}` });
  }

  const pty = loadPty();
  if (!pty) {
    return Promise.resolve({ parsed: null, raw: '', error: 'node-pty is not installed' });
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, TERM: 'xterm-256color', ...(options.env || {}) };
  const command = resolveCommand(config.command);
  const postCommandSilenceMs = config.postCommandSilenceMs || SILENCE_AFTER_COMMAND_MS;

  console.error('[usage-fetcher] spawn:', service, '→', command.resolvedPath);

  return new Promise((resolve) => {
    let term = null;
    let raw = '';
    let commandSent = false;
    let commandPending = false;
    let claudeAwaitingUsageConfirm = false;
    let claudeUsageConfirmSent = false;
    let codexInterstitialDismissed = false;
    let settled = false;
    let readySilenceTimer = null;
    let readyCommandTimer = null;
    let postCommandSilenceTimer = null;
    let parseGraceTimer = null;
    let claudeConfirmFallbackTimer = null;
    let firstDataAt = null;
    const startedAt = Date.now();

    const onPtyUncaughtException = (error) => {
      if (shouldIgnorePtyException(error)) {
        return;
      }
      const message = error && error.message ? error.message : String(error);
      if (/conpty|\\\\\.\\pipe\\|node-pty/i.test(message)) {
        finish(message);
        return;
      }
      process.nextTick(() => {
        throw error;
      });
    };

    const finish = (error = null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(readyFallbackTimer);
      clearTimeout(readySilenceTimer);
      clearTimeout(readyCommandTimer);
      clearTimeout(postCommandSilenceTimer);
      clearTimeout(parseGraceTimer);
      clearTimeout(claudeConfirmFallbackTimer);
      setTimeout(() => {
        process.removeListener('uncaughtException', onPtyUncaughtException);
      }, 1500);

      try {
        if (term) {
          term.kill();
        }
      } catch {
        // Ignore process teardown races.
      }

      resolve({
        parsed: parseUsage(service, raw),
        raw,
        error,
      });
    };

    const queueClaudeUsageConfirm = () => {
      if (claudeUsageConfirmSent) {
        return;
      }
      claudeUsageConfirmSent = true;
      if (settled || !term || commandSent) {
        return;
      }
      try {
        term.write('\r');
        commandSent = true;
        commandPending = false;
        claudeAwaitingUsageConfirm = false;
        clearTimeout(postCommandSilenceTimer);
        postCommandSilenceTimer = setTimeout(() => finish(), SILENCE_AFTER_COMMAND_MS);
        clearTimeout(claudeConfirmFallbackTimer);
        claudeConfirmFallbackTimer = setTimeout(() => {
          if (settled || !term || parseUsage('claude', raw) || !shouldConfirmClaudeUsage(raw)) {
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
    };

    const sendSlashCommand = () => {
      if (settled || !term || commandSent || commandPending) {
        return;
      }
      commandPending = true;
      const initialSubmitCount = getInitialSubmitCount(service);
      try {
        term.write(config.slashCommand);
        setTimeout(() => {
          if (settled || !term || commandSent) {
            return;
          }
          try {
            term.write('\r');
            setTimeout(() => {
              if (settled || !term || commandSent) {
                return;
              }
              try {
                const finalize = () => {
                  commandSent = true;
                  commandPending = false;
                  clearTimeout(postCommandSilenceTimer);
                  postCommandSilenceTimer = setTimeout(() => finish(), postCommandSilenceMs);
                };
                if (service === 'claude') {
                  claudeAwaitingUsageConfirm = true;
                  if (!claudeUsageConfirmSent && shouldConfirmClaudeUsage(raw)) {
                    queueClaudeUsageConfirm();
                  }
                  return;
                }
                if (initialSubmitCount > 1) {
                  term.write('\r');
                }
                finalize();
              } catch (error) {
                finish(error.message);
              }
            }, COMMAND_EXEC_DELAY_MS);
          } catch (error) {
            finish(error.message);
          }
        }, COMMAND_SUBMIT_DELAY_MS);
      } catch (error) {
        finish(error.message);
        return;
      }
    };

    const scheduleReadySend = (delayMs = READY_SILENCE_MS) => {
      if (commandSent || commandPending) {
        return;
      }
      clearTimeout(readyCommandTimer);
      readyCommandTimer = setTimeout(sendSlashCommand, delayMs);
    };

    const totalTimer = setTimeout(() => finish('timeout'), timeoutMs);
    const readyFallbackTimer = setTimeout(sendSlashCommand, READY_FALLBACK_MS);
    process.on('uncaughtException', onPtyUncaughtException);

    try {
      term = pty.spawn(command.file, command.args, {
        name: 'xterm-256color',
        cols: 200,
        rows: 60,
        cwd,
        env,
        useConpty: process.platform === 'win32',
      });
    } catch (error) {
      finish(error.message);
      return;
    }

    term.onData((data) => {
      raw += data;

      if (!firstDataAt) {
        firstDataAt = Date.now();
        console.error('[usage-fetcher]', service, 'first data after', firstDataAt - startedAt, 'ms, bytes=', data.length);
      }

      if (!commandSent) {
        if (service === 'claude' && !claudeUsageConfirmSent && shouldConfirmClaudeUsage(raw)) {
          queueClaudeUsageConfirm();
          return;
        }
        const screen = detectServiceScreen(service, raw);
        if (service === 'codex' && screen === 'update' && !codexInterstitialDismissed) {
          codexInterstitialDismissed = true;
          try {
            term.write('2\r');
          } catch (error) {
            finish(error.message);
          }
          return;
        }
        if (screen === 'ready') {
          scheduleReadySend(getReadyCommandDelay(service));
          return;
        }
        if (screen === 'status') {
          finish();
          return;
        }
        clearTimeout(readySilenceTimer);
        readySilenceTimer = setTimeout(sendSlashCommand, READY_SILENCE_MS);
        return;
      }

      clearTimeout(postCommandSilenceTimer);
      postCommandSilenceTimer = setTimeout(() => finish(), postCommandSilenceMs);

      if (parseUsage(service, raw)) {
        clearTimeout(parseGraceTimer);
        parseGraceTimer = setTimeout(() => finish(), PARSE_GRACE_MS);
      }
    });

    term.onExit((event) => {
      if (settled) {
        return;
      }
      console.error('[usage-fetcher]', service, 'exit code=', event.exitCode, 'signal=', event.signal);
      finish(event.exitCode === 0 ? null : `exit ${event.exitCode}`);
    });
  });
}

async function fetchServiceResult(service, options = {}) {
  const existing = inFlightByService.get(service);
  if (existing) {
    return existing;
  }

  const promise = spawnServicePty(service, options).finally(() => {
    inFlightByService.delete(service);
  });
  inFlightByService.set(service, promise);
  return promise;
}

async function fetchService(service, options = {}) {
  const result = await fetchServiceResult(service, options);
  if (!result.parsed) {
    return null;
  }

  return options.debug ? { ...result.parsed, raw: result.raw } : result.parsed;
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

const CLAUDE_SAMPLE = `
   Status   Config   Usage   Stats

  Current session
  █████████████████████████████▌                     59% used
  Resets 3am (Asia/Seoul)

  Current week (all models)
  ███████████████████▌                               39% used
  Resets Apr 24, 9am (Asia/Seoul)

  Extra usage
  ██████████████████████████████████████████████████ 100% used
  $20.67 / $20.00 spent · Resets May 1 (Asia/Seoul)

  Esc to cancel
`;

const CODEX_SAMPLE = `
╭─────────────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.121.0)                                                     │
│                                                                                 │
│ Visit https://chatgpt.com/codex/settings/usage for up-to-date                   │
│ information on rate limits and credits                                          │
│                                                                                 │
│  Model:                gpt-5.4 (reasoning none, summaries auto)                 │
│  Directory:            E:\\githubWorkSpace\\usage-gauge                           │
│  Permissions:          Custom (workspace-write, on-request)                     │
│  Agents.md:            <none>                                                   │
│  Account:              huibeomjeong99@gmail.com (Plus)                          │
│  Collaboration mode:   Default                                                  │
│  Session:              019dab47-891d-7e40-b2ad-9915bb8aad92                     │
│                                                                                 │
│  5h limit:             [██████████████████░░] 88% left (resets 03:48 on 21 Apr) │
│  Weekly limit:         [█████████████████░░░] 83% left (resets 09:34 on 24 Apr) │
╰─────────────────────────────────────────────────────────────────────────────────╯
`;

const CLAUDE_RAW_SAMPLE = String.raw`\x1b[?25l\x1b[1;1HClaude Pro\x1b[3;1HStatus   Config   Usage   Stats\x1b[10;3HCurrent session\x1b[11;3H███████████████                     59% used\x1b[12;3HResets 3am (Asia/Seoul)\x1b[14;3HCurrent week (all models)\x1b[15;3H██████████                               39% used\x1b[?25h`;

function runTests() {
  const resolvedVolta = chooseWindowsCommandCandidate([
    'C:\\Users\\shjung\\AppData\\Local\\Volta\\tools\\image\\node\\18.12.0\\codex.cmd',
    'C:\\Users\\shjung\\AppData\\Local\\Volta\\bin\\codex.cmd',
  ]);
  assert.equal(resolvedVolta, 'C:\\Users\\shjung\\AppData\\Local\\Volta\\bin\\codex.cmd');

  const resolvedExe = chooseWindowsCommandCandidate([
    'C:\\Users\\shjung\\.local\\bin\\claude.cmd',
    'C:\\Users\\shjung\\.local\\bin\\claude.exe',
  ]);
  assert.equal(resolvedExe, 'C:\\Users\\shjung\\.local\\bin\\claude.exe');

  const codexEntrypoint = resolveCodexEntrypoint([
    'C:\\Users\\shjung\\AppData\\Local\\Volta\\bin\\codex.cmd',
    'C:\\Users\\shjung\\AppData\\Local\\Volta\\tools\\image\\node\\18.12.0\\codex.cmd',
  ]);
  if (process.platform === 'win32') {
    assert.ok(codexEntrypoint);
    assert.equal(codexEntrypoint.file.toLowerCase().endsWith('\\node.exe'), true);
    assert.equal(codexEntrypoint.args[0].toLowerCase().endsWith('\\node_modules\\@openai\\codex\\bin\\codex.js'), true);
  } else {
    assert.equal(codexEntrypoint, null);
  }

  if (process.platform === 'win32') {
    const resolvedCmd = resolveCommand('codex');
    assert.ok(Array.isArray(resolvedCmd.args));
  }

  const pathCandidates = findWindowsPathCandidates('definitely-not-a-real-usage-gauge-command');
  assert.deepEqual(pathCandidates, []);

  const claude = parseClaudeUsage(CLAUDE_SAMPLE);
  assert.equal(claude.pct, 41);
  assert.equal(claude.plan, null);
  assert.equal(claude.source, 'cli');
  assert.equal(typeof claude.resetInMs, 'number');
  assert.ok(claude.resetInMs > 0);

  const rawClaude = parseClaudeUsage(CLAUDE_RAW_SAMPLE);
  assert.ok(rawClaude);
  assert.ok(rawClaude.pct >= 0 && rawClaude.pct <= 100);
  assert.equal(rawClaude.plan, 'PRO');
  assert.equal(typeof rawClaude.resetInMs, 'number');
  assert.ok(rawClaude.resetInMs > 0);

  const codex = parseCodexStatus(CODEX_SAMPLE);
  assert.equal(codex.pct, 88);
  assert.equal(codex.plan, 'PLUS');
  assert.equal(codex.source, 'cli');
  assert.equal(typeof codex.resetInMs, 'number');
  assert.ok(codex.resetInMs > 0);

  const codexTimeOnly = parseCodexStatus(`
    5h limit: [████████████████░░░░] 77% left (resets 14:32)
  `);
  assert.equal(codexTimeOnly.pct, 77);
  assert.equal(typeof codexTimeOnly.resetInMs, 'number');
  assert.ok(codexTimeOnly.resetInMs > 0);

  assert.equal(detectCodexScreen('Update available!\nPress enter to continue'), 'update');
  assert.equal(detectCodexScreen('› Explain this codebase\n  gpt-5.4 default'), 'ready');
  assert.equal(detectCodexScreen(CODEX_SAMPLE), 'status');
  assert.equal(shouldConfirmClaudeUsage('/usage                              Show session cost, plan usage, and activity stats'), true);
  assert.equal(shouldConfirmClaudeUsage('Claude Code\n? for shortcuts'), false);
  assert.equal(shouldIgnorePtyException(new Error('AttachConsole failed')), true);
  assert.equal(shouldIgnorePtyException(new Error('EPERM: operation not permitted, open \\\\.\\pipe\\conpty-test')), false);
  assert.deepEqual(prepareSilentForkArgs('E:\\workspace\\usage-gauge\\node_modules\\node-pty\\lib\\conpty_console_list_agent.js', ['123']), {
    args: ['123'],
    options: { silent: true },
  });
  assert.deepEqual(
    prepareSilentForkArgs('E:\\workspace\\usage-gauge\\node_modules\\node-pty\\lib\\conpty_console_list_agent.js', ['123'], { cwd: 'E:\\workspace\\usage-gauge' }),
    { args: ['123'], options: { cwd: 'E:\\workspace\\usage-gauge', silent: true } },
  );
  assert.deepEqual(
    prepareSilentForkArgs('E:\\workspace\\usage-gauge\\other-agent.js', ['123'], { cwd: 'E:\\workspace\\usage-gauge' }),
    { args: ['123'], options: { cwd: 'E:\\workspace\\usage-gauge' } },
  );
  assert.equal(getInitialSubmitCount('claude'), 1);
  assert.equal(getInitialSubmitCount('codex'), 2);

  assert.equal(detectClaudeScreen('Claude Code\n? for shortcuts'), 'ready');
  assert.equal(detectClaudeScreen(CLAUDE_RAW_SAMPLE), 'status');
  assert.equal(detectServiceScreen('claude', CLAUDE_RAW_SAMPLE), 'status');
  assert.equal(detectServiceScreen('codex', CODEX_SAMPLE), 'status');

  console.log('usage-fetcher self-test passed');
}

if (require.main === module) {
  runTests();
}

module.exports = {
  fetchService,
  fetchUsage,
  detectClaudeScreen,
  parseClaudeUsage,
  parseCodexStatus,
  parseUsage,
  detectCodexScreen,
  detectServiceScreen,
  resolveCodexEntrypoint,
  resolveCommand,
  prepareSilentForkArgs,
  getInitialSubmitCount,
  shouldConfirmClaudeUsage,
  shouldIgnorePtyException,
  stripAnsi,
};
