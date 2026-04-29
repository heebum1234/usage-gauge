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
    .replace(/[^\S\n]{2,}/g, '  ')
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

module.exports = {
  MONTHS,
  clampPct,
  deltaFromDate,
  normalizeText,
  parseClockParts,
  parseLocalReset,
  reassembleTuiRows,
  stripAnsi,
};
