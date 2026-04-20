const DEFAULTS = {
  gauge: 'bar',
  theme: 'dark',
  glow: 'on',
  claude: null,
  codex: null,
  claudePlan: 'PRO',
  codexPlan: 'PRO',
  claudeResetInMs: null,
  codexResetInMs: null,
};

const ALLOWED = {
  gauge: ['bar', 'ring', 'num'],
  theme: ['dark', 'light', 'glass'],
  glow: ['on', 'off'],
};

const state = {
  ...DEFAULTS,
  thresholds: {
    claude: null,
    codex: null,
  },
};

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
  if (pct === null) {
    return 'unk';
  }
  if (pct <= 20) {
    return 'crit';
  }
  if (pct <= 50) {
    return 'warn';
  }
  return 'ok';
}

function formatReset(resetInMs) {
  if (typeof resetInMs !== 'number' || !Number.isFinite(resetInMs) || resetInMs <= 0) {
    return 'unknown';
  }

  const totalMinutes = Math.max(0, Math.round(resetInMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

function normalizePct(pct) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function applyService(el, data) {
  const value = normalizePct(data.pct);
  const status = statusFor(value);
  const displayValue = value === null ? '—' : String(value);
  const width = value === null ? 0 : value;

  el.dataset.status = status;
  el.querySelectorAll('.num').forEach((n) => {
    n.textContent = displayValue;
  });
  el.querySelectorAll('.sym').forEach((sym) => {
    sym.style.visibility = value === null ? 'hidden' : '';
  });
  el.querySelector('.bar-fill').style.width = `${width}%`;

  const circ = 2 * Math.PI * 18;
  const offset = circ * (1 - width / 100);
  el.querySelectorAll('.gauge-ring .fill').forEach((ring) => {
    ring.style.strokeDashoffset = offset;
  });
  el.querySelectorAll('.reset').forEach((reset) => {
    reset.textContent = value === null ? 'unavailable' : formatReset(data.resetInMs);
  });

  const plan = typeof data.plan === 'string' && data.plan.trim() ? data.plan.trim().toUpperCase() : '—';
  const planEl = el.querySelector('.svc-plan');
  if (planEl) {
    planEl.textContent = plan;
  }

  return status;
}

function maybeToast(prevPct, pct, label) {
  if (prevPct === null || pct === null) {
    return;
  }

  const prevBucket = Math.floor(prevPct / 10);
  const bucket = Math.floor(pct / 10);
  if (bucket < prevBucket && bucket <= 5) {
    showToast(label, pct);
  }
}

function showToast(label, pct) {
  const crit = pct <= 20;
  toast.classList.toggle('crit', crit);
  toastIcon.textContent = crit ? '!' : '?';
  toastT1.textContent = `${label} - ${pct}% remaining`;
  toastT2.textContent = `threshold crossed - ${Math.floor(pct / 10) * 10}%`;
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

  const sC = applyService(svcC, {
    pct: state.claude,
    resetInMs: state.claudeResetInMs,
    plan: state.claudePlan,
  });
  const sX = applyService(svcX, {
    pct: state.codex,
    resetInMs: state.codexResetInMs,
    plan: state.codexPlan,
  });

  const rank = { ok: 0, unk: 0, warn: 1, crit: 2 };
  const worst = rank[sC] >= rank[sX] ? sC : sX;
  widget.dataset.wstatus = state.glow === 'off' || worst === 'unk' ? 'ok' : worst;

  state.thresholds.claude = state.claude;
  state.thresholds.codex = state.codex;

  if (opts.checkToast !== false) {
    maybeToast(prevC, state.claude, 'Claude Code');
    maybeToast(prevX, state.codex, 'Codex');
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
  const claudeValue = state.claude === null ? 0 : state.claude;
  const codexValue = state.codex === null ? 0 : state.codex;
  simClaude.value = claudeValue;
  simCodex.value = codexValue;
  simClaudeVal.textContent = state.claude === null ? '—%' : `${state.claude}%`;
  simCodexVal.textContent = state.codex === null ? '—%' : `${state.codex}%`;
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

function requestRefresh() {
  refreshAnimation();
  window.usageGauge.requestUsageRefresh();
}

function simulateDrop() {
  if (!isDevMode()) {
    return;
  }

  state.claude = Math.max(0, (state.claude ?? 100) - (6 + Math.floor(Math.random() * 14)));
  state.codex = Math.max(0, (state.codex ?? 100) - (6 + Math.floor(Math.random() * 14)));
  syncSimValues();
  applyAll();
}

function applyUsageUpdate(usage) {
  const claude = usage && usage.claude ? usage.claude : null;
  const codex = usage && usage.codex ? usage.codex : null;

  state.claude = normalizePct(claude && claude.pct);
  state.codex = normalizePct(codex && codex.pct);
  state.claudeResetInMs = claude ? claude.resetInMs : null;
  state.codexResetInMs = codex ? codex.resetInMs : null;
  state.claudePlan = claude && claude.plan ? claude.plan : DEFAULTS.claudePlan;
  state.codexPlan = codex && codex.plan ? codex.plan : DEFAULTS.codexPlan;

  syncSimValues();
  applyAll();
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
    simClaudeVal.textContent = `${state.claude}%`;
    applyAll();
  });

  simCodex.addEventListener('input', () => {
    if (!isDevMode()) {
      return;
    }
    state.codex = Number(simCodex.value);
    simCodexVal.textContent = `${state.codex}%`;
    applyAll();
  });

  refreshBtn.addEventListener('click', requestRefresh);
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
      requestRefresh();
    }

    if (event.key === 's' || event.key === 'S') {
      simulateDrop();
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

  window.usageGauge.onUsageUpdate(applyUsageUpdate);
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
  window.usageGauge.requestUsageRefresh();
}

bindEvents();
bootstrap();
