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

function loadPty() {
  try {
    patchNodePtyFork();
    return require('node-pty');
  } catch {
    return null;
  }
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

function spawnUsagePty(config, options = {}) {
  const pty = loadPty();
  if (!pty) {
    return Promise.resolve({ parsed: null, raw: '', error: 'node-pty is not installed' });
  }

  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, TERM: 'xterm-256color', ...(options.env || {}) };
  const command = resolveCommand(config.command);
  const postCommandSilenceMs = config.postCommandSilenceMs || SILENCE_AFTER_COMMAND_MS;

  console.error('[usage-fetcher] spawn:', config.service, '→', command.resolvedPath);

  return new Promise((resolve) => {
    let term = null;
    let raw = '';
    let commandSent = false;
    let commandPending = false;
    let settled = false;
    let readySilenceTimer = null;
    let readyCommandTimer = null;
    let postCommandSilenceTimer = null;
    let parseGraceTimer = null;
    let firstDataAt = null;
    const startedAt = Date.now();
    const state = config.createState ? config.createState() : {};

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
      if (typeof config.teardownState === 'function') {
        config.teardownState(state);
      }
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
        parsed: config.parse(raw),
        raw,
        error,
      });
    };

    const markCommandSent = () => {
      commandSent = true;
      commandPending = false;
      clearTimeout(postCommandSilenceTimer);
      postCommandSilenceTimer = setTimeout(() => finish(), postCommandSilenceMs);
    };

    const sendSlashCommand = () => {
      if (settled || !term || commandSent || commandPending) {
        return;
      }
      commandPending = true;
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
                const handled = typeof config.afterInitialSubmit === 'function'
                  ? config.afterInitialSubmit({
                    finish,
                    markCommandSent,
                    raw,
                    state,
                    term,
                  })
                  : false;
                if (!handled) {
                  markCommandSent();
                }
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

    state.term = term;

    term.onData((data) => {
      raw += data;

      if (!firstDataAt) {
        firstDataAt = Date.now();
        console.error('[usage-fetcher]', config.service, 'first data after', firstDataAt - startedAt, 'ms, bytes=', data.length);
      }

      if (!commandSent) {
        const handled = typeof config.handlePreCommandData === 'function'
          ? config.handlePreCommandData({
            finish,
            markCommandSent,
            raw,
            scheduleReadySend,
            sendSlashCommand,
            state,
            term,
          })
          : false;
        if (handled) {
          return;
        }

        const screen = config.detect(raw);
        if (screen === 'ready') {
          scheduleReadySend(config.readyCommandDelayMs || 0);
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

      if (config.parse(raw)) {
        clearTimeout(parseGraceTimer);
        parseGraceTimer = setTimeout(() => finish(), PARSE_GRACE_MS);
      }
    });

    term.onExit((event) => {
      if (settled) {
        return;
      }
      console.error('[usage-fetcher]', config.service, 'exit code=', event.exitCode, 'signal=', event.signal);
      finish(event.exitCode === 0 ? null : `exit ${event.exitCode}`);
    });
  });
}

module.exports = {
  COMMAND_EXEC_DELAY_MS,
  COMMAND_SUBMIT_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  PARSE_GRACE_MS,
  READY_COMMAND_DELAY_MS,
  READY_FALLBACK_MS,
  READY_SILENCE_MS,
  SILENCE_AFTER_COMMAND_MS,
  chooseWindowsCommandCandidate,
  findWindowsPathCandidates,
  getPathCandidates,
  loadPty,
  patchNodePtyFork,
  prepareSilentForkArgs,
  resolveCodexEntrypoint,
  resolveCommand,
  shouldIgnorePtyException,
  spawnUsagePty,
};
