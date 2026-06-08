const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function getProbeDir(baseDir) {
  return path.join(baseDir, 'cli-probe');
}

function ensureProbeWorkspace(baseDir) {
  const probeDir = getProbeDir(baseDir);
  try {
    fs.mkdirSync(probeDir, { recursive: true });
  } catch (error) {
    console.error('[usage-fetcher] failed to create probe workspace:', error.message);
  }

  try {
    ensureClaudeTrust(probeDir);
  } catch (error) {
    console.error('[usage-fetcher] failed to preseed Claude trust:', error.message);
  }

  try {
    ensureCodexTrust(probeDir);
  } catch (error) {
    console.error('[usage-fetcher] failed to preseed Codex trust:', error.message);
  }

  return probeDir;
}

function ensureClaudeTrust(probeDir, homeDir = os.homedir()) {
  try {
    const configPath = path.join(homeDir, '.claude.json');
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      config = {};
    }

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      config = {};
    }
    if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
      config.projects = {};
    }

    const key = probeDir.replace(/\\/g, '/');
    const project = config.projects[key] && typeof config.projects[key] === 'object'
      ? config.projects[key]
      : {};

    if (project.hasTrustDialogAccepted === true) {
      return;
    }

    config.projects[key] = {
      ...project,
      hasTrustDialogAccepted: true,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // Best effort only. Usage fetching must continue even if trust cannot be preseeded.
  }
}

function ensureCodexTrust(probeDir, homeDir = os.homedir()) {
  try {
    const codexDir = path.join(homeDir, '.codex');
    const configPath = path.join(codexDir, 'config.toml');
    const key = probeDir.toLowerCase();
    let config = '';
    try {
      config = fs.readFileSync(configPath, 'utf8');
    } catch {
      config = '';
    }

    const hasSection = config.split(/\r?\n/).some((line) => {
      const match = line.match(/^\s*\[projects\.'(.+)'\]\s*$/);
      return match && match[1].toLowerCase() === key;
    });
    if (hasSection) {
      return;
    }

    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(configPath, `${config}\n[projects.'${key}']\ntrust_level = "trusted"\n`, 'utf8');
  } catch {
    // Best effort only. Usage fetching must continue even if trust cannot be preseeded.
  }
}

module.exports = {
  ensureClaudeTrust,
  ensureCodexTrust,
  ensureProbeWorkspace,
  getProbeDir,
};
