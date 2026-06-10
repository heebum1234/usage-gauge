const fs = require('node:fs');
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

  return probeDir;
}

module.exports = {
  ensureProbeWorkspace,
  getProbeDir,
};
