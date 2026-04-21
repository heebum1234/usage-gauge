const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15000;
const READY_SILENCE_MS = 500;
const READY_FALLBACK_MS = 4000;
const SILENCE_AFTER_COMMAND_MS = 800;
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
    slashCommand: '/usage\r',
  },
  codex: {
    command: 'codex',
    slashCommand: '/status\r',
  },
};

const inFlightByService = new Map();

function loadPty() {
  try {
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
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\s*Current session\s*$/i.test(line));
  if (start === -1) {
    return null;
  }

  const section = lines.slice(start + 1, start + 8).join('\n');
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

  const resolvedPath = chooseWindowsCommandCandidate(candidates) || command;

  if (/\.(cmd|bat)$/i.test(resolvedPath)) {
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${resolvedPath}"`],
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

  console.error('[usage-fetcher] spawn:', service, '→', command.resolvedPath);

  return new Promise((resolve) => {
    let term = null;
    let raw = '';
    let commandSent = false;
    let settled = false;
    let readySilenceTimer = null;
    let postCommandSilenceTimer = null;
    let parseGraceTimer = null;
    let firstDataAt = null;
    const startedAt = Date.now();

    const onPtyUncaughtException = (error) => {
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
      clearTimeout(postCommandSilenceTimer);
      clearTimeout(parseGraceTimer);
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

    const sendSlashCommand = () => {
      if (settled || !term || commandSent) {
        return;
      }
      commandSent = true;
      try {
        term.write(config.slashCommand);
      } catch (error) {
        finish(error.message);
        return;
      }
      clearTimeout(postCommandSilenceTimer);
      postCommandSilenceTimer = setTimeout(() => finish(), SILENCE_AFTER_COMMAND_MS);
    };

    const scheduleReadySend = () => {
      if (commandSent) {
        return;
      }
      clearTimeout(readySilenceTimer);
      readySilenceTimer = setTimeout(sendSlashCommand, READY_SILENCE_MS);
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
        scheduleReadySend();
        return;
      }

      clearTimeout(postCommandSilenceTimer);
      postCommandSilenceTimer = setTimeout(() => finish(), SILENCE_AFTER_COMMAND_MS);

      if (parseUsage(service, raw)) {
        clearTimeout(parseGraceTimer);
        parseGraceTimer = setTimeout(() => finish(), PARSE_GRACE_MS);
      }
    });

    term.onExit((event) => {
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
  const [claudeResult, codexResult] = await Promise.all([
    fetchServiceResult('claude', options),
    fetchServiceResult('codex', options),
  ]);

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

  console.log('usage-fetcher self-test passed');
}

if (require.main === module) {
  runTests();
}

module.exports = {
  fetchService,
  fetchUsage,
  parseClaudeUsage,
  parseCodexStatus,
  parseUsage,
  stripAnsi,
};
