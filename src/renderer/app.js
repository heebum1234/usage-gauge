const DEFAULTS = {
  gauge: 'bar',
  theme: 'dark',
  glow: 'on',
  claude: 82,
  codex: 71,
};

const ALLOWED = {
  gauge: ['bar', 'ring', 'num'],
  theme: ['dark', 'light', 'glass'],
  glow: ['on', 'off'],
};

const state = {
  ...DEFAULTS,
  thresholds: {
    claude: DEFAULTS.claude,
    codex: DEFAULTS.codex,
  },
};

const pauseAutoUntil = {
  claude: 0,
  codex: 0,
};

let autoTickHandle = null;

const widget = document.getElementById('widget');
const svcC = document.getElementById('svcClaude');
const svcX = document.getElementById('svcCodex');
const toast = document.getElementById('toast');
const toastT1 = document.getElementById('toastT1');
const toastT2 = document.getElementById('toastT2');
const toastIcon = document.getElementById('toastIcon');

const simClaude = document.getElementById('simClaude');
const simCodex = document.getElementById('simCodex');
const simClaudeVal = document.getElementById('simClaudeVal');
const simCodexVal = document.getElementById('simCodexVal');

const tweaksEl = document.getElementById('tweaks');
const tweaksFab = document.getElementById('tweaksFab');
const refreshBtn = document.getElementById('refreshBtn');
const simBtn = document.getElementById('simBtn');

function statusFor(pct) {
  if (pct <= 20) {
    return 'crit';
  }
  if (pct <= 50) {
    return 'warn';
  }
  return 'ok';
}

function formatReset(pct) {
  const hours = Math.max(0, Math.floor(pct * 0.08));
  const mins = Math.floor((pct * 0.08 - hours) * 60);
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

function applyPct(el, pct) {
  const value = Math.max(0, Math.min(100, Math.round(pct)));
  const status = statusFor(value);
  el.dataset.status = status;
  el.querySelectorAll('.num').forEach((n) => {
    n.textContent = value;
  });
  el.querySelector('.bar-fill').style.width = `${value}%`;
  const circ = 2 * Math.PI * 18;
  const offset = circ * (1 - value / 100);
  el.querySelectorAll('.gauge-ring .fill').forEach((ring) => {
    ring.style.strokeDashoffset = offset;
  });
  el.querySelectorAll('.reset').forEach((reset) => {
    reset.textContent = formatReset(value);
  });
  return status;
}

function maybeToast(key, prevPct, pct, label) {
  const prevBucket = Math.floor(prevPct / 10);
  const bucket = Math.floor(pct / 10);
  if (bucket < prevBucket && bucket <= 5) {
    showToast(label, pct);
  }
}

function showToast(label, pct) {
  const crit = pct <= 20;
  toast.classList.toggle('crit', crit);
  toastIcon.textContent = crit ? '!' : '⚠';
  toastT1.textContent = `${label} · ${pct}% remaining`;
  toastT2.textContent = `threshold crossed · ${Math.floor(pct / 10) * 10}%`;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3400);
}

function applyAll(opts = {}) {
  const prevC = state.thresholds.claude;
  const prevX = state.thresholds.codex;

  widget.dataset.gauge = state.gauge;
  widget.dataset.theme = state.theme;
  widget.dataset.glow = state.glow;

  const sC = applyPct(svcC, state.claude);
  const sX = applyPct(svcX, state.codex);

  const rank = { ok: 0, warn: 1, crit: 2 };
  const worst = rank[sC] >= rank[sX] ? sC : sX;
  widget.dataset.wstatus = state.glow === 'off' ? 'ok' : worst;

  state.thresholds.claude = state.claude;
  state.thresholds.codex = state.codex;

  if (opts.checkToast !== false) {
    maybeToast('claude', prevC, state.claude, 'Claude Code');
    maybeToast('codex', prevX, state.codex, 'Codex');
  }
}

function persistPrefs() {
  window.usageGauge.savePrefs({
    gauge: state.gauge,
    theme: state.theme,
    glow: state.glow,
  });
}

function seedSeg(id, key) {
  document.getElementById(id).querySelectorAll('button').forEach((button) => {
    button.classList.toggle('active', button.dataset.v === state[key]);
  });
}

function bindSeg(id, key) {
  const group = document.getElementById(id);
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) {
      return;
    }

    const value = button.dataset.v;
    if (!ALLOWED[key].includes(value)) {
      return;
    }

    state[key] = value;
    seedSeg(id, key);
    applyAll({ checkToast: false });
    persistPrefs();
  });
}

function syncSimValues() {
  simClaude.value = state.claude;
  simCodex.value = state.codex;
  simClaudeVal.textContent = `${state.claude}%`;
  simCodexVal.textContent = `${state.codex}%`;
}

function isDevMode() {
  return document.body.dataset.dev === 'on';
}

function setDevMode(on) {
  document.body.dataset.dev = on ? 'on' : 'off';
  if (!on) {
    tweaksEl.classList.remove('open');
  }
}

function refreshAnimation() {
  refreshBtn.style.transform = 'rotate(360deg)';
  refreshBtn.style.transition = 'transform .7s cubic-bezier(.2,.8,.2,1)';
  setTimeout(() => {
    refreshBtn.style.transform = '';
    refreshBtn.style.transition = '';
  }, 720);
}

function simulateDrop() {
  if (!isDevMode()) {
    return;
  }

  state.claude = Math.max(0, state.claude - (6 + Math.floor(Math.random() * 14)));
  state.codex = Math.max(0, state.codex - (6 + Math.floor(Math.random() * 14)));
  pauseAutoUntil.claude = Date.now() + 60000;
  pauseAutoUntil.codex = Date.now() + 60000;
  syncSimValues();
  applyAll();
}

function autoTick() {
  const now = Date.now();

  if (now >= pauseAutoUntil.claude) {
    state.claude = Math.max(0, state.claude - Math.floor(Math.random() * 5));
  }
  if (now >= pauseAutoUntil.codex) {
    state.codex = Math.max(0, state.codex - Math.floor(Math.random() * 5));
  }

  syncSimValues();
  applyAll();
}

function startAutoTick() {
  clearInterval(autoTickHandle);
  autoTickHandle = setInterval(autoTick, 30000);
}

function bindEvents() {
  bindSeg('segGauge', 'gauge');
  bindSeg('segTheme', 'theme');
  bindSeg('segGlow', 'glow');

  simClaude.addEventListener('input', () => {
    if (!isDevMode()) {
      return;
    }
    state.claude = Number(simClaude.value);
    pauseAutoUntil.claude = Date.now() + 60000;
    simClaudeVal.textContent = `${state.claude}%`;
    applyAll();
  });

  simCodex.addEventListener('input', () => {
    if (!isDevMode()) {
      return;
    }
    state.codex = Number(simCodex.value);
    pauseAutoUntil.codex = Date.now() + 60000;
    simCodexVal.textContent = `${state.codex}%`;
    applyAll();
  });

  refreshBtn.addEventListener('click', refreshAnimation);
  simBtn.addEventListener('click', simulateDrop);

  tweaksFab.addEventListener('click', () => {
    if (!isDevMode()) {
      return;
    }
    tweaksEl.classList.add('open');
  });
  document.getElementById('closeTweaks').addEventListener('click', () => {
    tweaksEl.classList.remove('open');
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'r' || event.key === 'R') {
      refreshAnimation();
    }

    if (event.key === 's' || event.key === 'S') {
      if (isDevMode()) {
        simulateDrop();
      }
    }

    const key = event.key.toLowerCase();
    const isMac = navigator.platform.toLowerCase().includes('mac');
    const quitShortcut =
      (isMac && event.metaKey && key === 'q') ||
      (!isMac && event.ctrlKey && key === 'w');

    if (quitShortcut) {
      event.preventDefault();
      window.usageGauge.quit();
    }
  });

  window.usageGauge.onToggleDevMode(() => {
    setDevMode(!isDevMode());
  });
}

async function bootstrap() {
  const appState = await window.usageGauge.getState();
  const prefs = appState && appState.prefs ? appState.prefs : {};

  if (ALLOWED.gauge.includes(prefs.gauge)) {
    state.gauge = prefs.gauge;
  }
  if (ALLOWED.theme.includes(prefs.theme)) {
    state.theme = prefs.theme;
  }
  if (ALLOWED.glow.includes(prefs.glow)) {
    state.glow = prefs.glow;
  }

  setDevMode(window.usageGauge.isDev());

  seedSeg('segGauge', 'gauge');
  seedSeg('segTheme', 'theme');
  seedSeg('segGlow', 'glow');
  syncSimValues();

  applyAll({ checkToast: false });
  startAutoTick();
}

bindEvents();
bootstrap();
