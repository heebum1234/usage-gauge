const DEFAULTS = {
  gauge: 'bar',
  theme: 'dark',
  glow: 'on',
  claude: null,
  codex: null,
  claudePlan: null,
  codexPlan: null,
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
const refreshBtn = document.getElementById('refreshBtn');
let pulseTimer = null;

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
    return '-';
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
  const displayValue = value === null ? '...' : String(value);
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
    reset.textContent = value === null ? '-' : formatReset(data.resetInMs);
  });

  const plan = typeof data.plan === 'string' && data.plan.trim() ? data.plan.trim().toUpperCase() : '-';
  const planEl = el.querySelector('.svc-plan');
  if (planEl) {
    planEl.textContent = plan;
  }

  return status;
}

function triggerBorderPulse(level) {
  widget.dataset.pulse = 'none';
  void widget.offsetWidth;
  widget.dataset.pulse = level;
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    widget.dataset.pulse = 'none';
  }, level === 'crit' ? 2800 : 1800);
}

function maybePulse(prevPct, pct) {
  if (prevPct === null || pct === null) {
    return;
  }

  const prevBucket = Math.floor(prevPct / 10);
  const bucket = Math.floor(pct / 10);
  if (bucket < prevBucket && bucket <= 5) {
    triggerBorderPulse(pct <= 20 ? 'crit' : 'warn');
  }
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
    maybePulse(prevC, state.claude);
    maybePulse(prevX, state.codex);
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

function applyUsageUpdate(usage) {
  const claude = usage && usage.claude ? usage.claude : null;
  const codex = usage && usage.codex ? usage.codex : null;

  state.claude = normalizePct(claude && claude.pct);
  state.codex = normalizePct(codex && codex.pct);
  state.claudeResetInMs = claude ? claude.resetInMs : null;
  state.codexResetInMs = codex ? codex.resetInMs : null;
  state.claudePlan = claude && claude.plan ? claude.plan : null;
  state.codexPlan = codex && codex.plan ? codex.plan : null;

  applyAll();
}

function bindEvents() {
  refreshBtn.addEventListener('click', requestRefresh);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'r' || event.key === 'R') {
      requestRefresh();
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
  state.glow = 'on';

  applyAll({ checkToast: false });
}

bindEvents();
bootstrap();
