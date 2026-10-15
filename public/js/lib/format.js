const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const CURRENCY_LOCALE = { INR: 'en-IN', USD: 'en-US', EUR: 'de-DE', GBP: 'en-GB', AED: 'en-AE', SGD: 'en-SG', AUD: 'en-AU' };

export function money(value, currency = 'INR', { decimals = 2 } = {}) {
  const amount = Number(value || 0);
  const locale = CURRENCY_LOCALE[currency] || 'en-IN';
  return `${currency} ${amount.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function compactMoney(value, currency = 'INR') {
  const amount = Number(value || 0);
  const abs = Math.abs(amount);
  if (abs >= 1e7) return `${currency} ${(amount / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${currency} ${(amount / 1e5).toFixed(2)} L`;
  if (abs >= 1000) return `${currency} ${(amount / 1000).toFixed(1)}K`;
  return `${currency} ${amount.toLocaleString(CURRENCY_LOCALE[currency] || 'en-IN')}`;
}

export function number(value, decimals = 0) {
  const n = Number(value || 0);
  return n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function hours(value) {
  const n = Number(value || 0);
  return `${Number.isInteger(n) ? n : n.toFixed(1)} h`;
}

export function date(value) {
  if (!value) return '—';
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '—';
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}

export function dateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return `${String(parsed.getDate()).padStart(2, '0')} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}, ${String(
    parsed.getHours()
  ).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`;
}

export function relative(value) {
  if (!value) return '—';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hrs = Math.round(minutes / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date(value);
}

export function inputDate(value) {
  return value ? String(value).slice(0, 10) : '';
}

export function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

export function fileSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function truncate(value, length = 70) {
  const text = String(value || '');
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function pluralise(count, singular, plural = null) {
  return `${count} ${count === 1 ? singular : plural || `${singular}s`}`;
}

export const PRIORITY_COLORS = { LOW: 'slate', MEDIUM: 'blue', HIGH: 'amber', CRITICAL: 'red' };

export const APPROVAL_COLORS = {
  PENDING: 'amber',
  APPROVED: 'green',
  REJECTED: 'red',
  SKIPPED: 'slate',
  VIEWED: 'blue',
  COMPLETED: 'green',
  SENT: 'blue',
  DELIVERED: 'blue',
  SIGNED: 'green',
  DECLINED: 'red',
  VOIDED: 'slate',
  CREATED: 'slate',
  QUEUED: 'slate',
  FAILED: 'red',
  OPENED: 'blue',
  CLICKED: 'blue',
  DRAFT: 'slate',
  FINAL: 'green',
  SUPERSEDED: 'slate'
};
