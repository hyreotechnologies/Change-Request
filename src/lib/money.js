export const CURRENCIES = {
  INR: { symbol: '₹', code: 'INR', label: 'Indian Rupee', locale: 'en-IN' },
  USD: { symbol: '$', code: 'USD', label: 'US Dollar', locale: 'en-US' },
  EUR: { symbol: '€', code: 'EUR', label: 'Euro', locale: 'de-DE' },
  GBP: { symbol: '£', code: 'GBP', label: 'Pound Sterling', locale: 'en-GB' },
  AED: { symbol: 'AED', code: 'AED', label: 'UAE Dirham', locale: 'en-AE' },
  SGD: { symbol: 'S$', code: 'SGD', label: 'Singapore Dollar', locale: 'en-SG' },
  AUD: { symbol: 'A$', code: 'AUD', label: 'Australian Dollar', locale: 'en-AU' }
};

export function round2(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Grouped amount without the currency code, e.g. 48,000.00 */
export function formatAmount(value, currency = 'INR') {
  const meta = CURRENCIES[currency] || CURRENCIES.INR;
  const n = round2(value);
  try {
    return new Intl.NumberFormat(meta.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(n);
  } catch {
    return n.toFixed(2);
  }
}

/** "INR 48,000.00" — the form used in the CR document. */
export function formatMoney(value, currency = 'INR') {
  return `${currency} ${formatAmount(value, currency)}`;
}

/** Compact form for dashboard tiles, e.g. "INR 1.2M". */
export function formatCompact(value, currency = 'INR') {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const units = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = n / size;
      return `${currency} ${(Math.round(scaled * 10) / 10).toFixed(1)}${suffix}`;
    }
  }
  return `${currency} ${Math.round(n)}`;
}

/**
 * Single source of truth for CR cost arithmetic. Always recomputed server-side.
 * effortByCategory: { DEVELOPMENT, TESTING, BUSINESS_ANALYSIS, PROJECT_MANAGEMENT, DEPLOYMENT, OTHER }
 */
export function computeCosts({ effortByCategory = {}, billingRate = 0, discountType = 'NONE', discountValue = 0, taxPercent = 0 }) {
  const rate = round2(toNumber(billingRate));
  const hours = (key) => Math.max(0, toNumber(effortByCategory[key]));

  const development = hours('DEVELOPMENT');
  const testing = hours('TESTING');
  const others =
    hours('BUSINESS_ANALYSIS') + hours('PROJECT_MANAGEMENT') + hours('DEPLOYMENT') + hours('OTHER');
  const totalEffort = round2(development + testing + others);

  const developmentCost = round2(development * rate);
  const testingCost = round2(testing * rate);
  const otherCost = round2(others * rate);
  const subtotal = round2(developmentCost + testingCost + otherCost);

  let discountAmount = 0;
  const value = Math.max(0, toNumber(discountValue));
  if (discountType === 'PERCENT') discountAmount = round2((subtotal * Math.min(value, 100)) / 100);
  else if (discountType === 'FIXED') discountAmount = round2(Math.min(value, subtotal));

  const netAmount = round2(subtotal - discountAmount);
  const taxAmount = round2((netAmount * Math.max(0, toNumber(taxPercent))) / 100);
  const totalCost = round2(netAmount + taxAmount);

  return {
    total_effort: totalEffort,
    billing_rate: rate,
    development_cost: developmentCost,
    testing_cost: testingCost,
    other_cost: otherCost,
    subtotal,
    discount_type: ['NONE', 'PERCENT', 'FIXED'].includes(discountType) ? discountType : 'NONE',
    discount_value: round2(value),
    discount_amount: discountAmount,
    net_amount: netAmount,
    tax_percent: round2(toNumber(taxPercent)),
    tax_amount: taxAmount,
    total_cost: totalCost
  };
}
