const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

export function nowIso() {
  return new Date().toISOString();
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Accepts ISO, dd-mm-yyyy and dd/mm/yyyy; returns yyyy-mm-dd or null. */
export function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dmy = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function isValidDate(value) {
  const iso = toDateOnly(value);
  if (!iso) return false;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
}

/** "October 09, 2025" — the long form used in the legal document. */
export function formatLongDate(value) {
  const iso = toDateOnly(value);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

/** "Mar 03, 2026" */
export function formatShortDate(value) {
  const iso = toDateOnly(value);
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${String(d).padStart(2, '0')}, ${y}`;
}

/** "04-03-2026" — the dd-mm-yyyy form used in the scope table. */
export function formatDmy(value) {
  const iso = toDateOnly(value);
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

export function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const d = String(date.getDate()).padStart(2, '0');
  const mo = MONTHS_SHORT[date.getMonth()];
  const y = date.getFullYear();
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${d} ${mo} ${y} ${h}:${mi}`;
}

export function addMinutes(minutes, from = new Date()) {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export function addHours(hours, from = new Date()) {
  return addMinutes(hours * 60, from);
}

export function addDays(days, from = new Date()) {
  return addMinutes(days * 24 * 60, from);
}

export function isPast(isoString) {
  if (!isoString) return true;
  return new Date(isoString).getTime() <= Date.now();
}

export function daysBetween(fromIso, toIso = nowIso()) {
  if (!fromIso) return 0;
  const diff = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Math.floor(diff / 86_400_000);
}

/** Business days (Mon-Fri) added to a date, used for timeline estimation. */
export function addBusinessDays(startIso, days) {
  const iso = toDateOnly(startIso);
  if (!iso || !Number.isFinite(days)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  let remaining = Math.ceil(days);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

export function businessDaysBetween(startIso, endIso) {
  const a = toDateOnly(startIso);
  const b = toDateOnly(endIso);
  if (!a || !b) return null;
  let count = 0;
  const cursor = new Date(`${a}T00:00:00Z`);
  const end = new Date(`${b}T00:00:00Z`);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

export function monthKey(value) {
  const iso = toDateOnly(value);
  return iso ? iso.slice(0, 7) : null;
}

export function monthLabel(key) {
  if (!key) return '';
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_SHORT[m - 1]} ${y}`;
}

export function startOfMonthIso(date = new Date()) {
  return `${date.toISOString().slice(0, 7)}-01`;
}
