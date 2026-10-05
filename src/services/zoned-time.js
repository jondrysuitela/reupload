export function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function getLocalDateKey(date, timezone) {
  const parts = getZonedParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0, timezone }) {
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = targetAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getZonedParts(new Date(candidate), timezone);
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const difference = targetAsUtc - representedAsUtc;
    candidate += difference;
    if (difference === 0) break;
  }

  return new Date(candidate);
}

export function getNextZonedTime({ now = new Date(), timezone, hour = 10, minute = 0 } = {}) {
  const local = getZonedParts(now, timezone);
  const year = Number(local.year);
  const month = Number(local.month);
  const day = Number(local.day);
  let next = zonedTimeToUtc({ year, month, day, hour, minute, timezone });

  if (next <= now) {
    const nextLocalDay = new Date(Date.UTC(year, month - 1, day + 1));
    next = zonedTimeToUtc({
      year: nextLocalDay.getUTCFullYear(),
      month: nextLocalDay.getUTCMonth() + 1,
      day: nextLocalDay.getUTCDate(),
      hour,
      minute,
      timezone,
    });
  }

  return next;
}