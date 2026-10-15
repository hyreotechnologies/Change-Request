import { all, get, run } from '../db/index.js';
import { encryptSecret, decryptSecret, isEncrypted } from '../lib/crypto.js';
import { nowIso } from '../lib/dates.js';
import { errors } from '../lib/errors.js';

/**
 * Every configurable business rule lives here. Nothing in the services layer
 * hard-codes a rate, a term, a numbering format or a policy window.
 */
export const SETTING_DEFINITIONS = [
  // Company
  { key: 'company.name', value: 'Hyreo', category: 'COMPANY', label: 'Company name' },
  { key: 'company.legal_name', value: 'Hyreo Services India Private Limited', category: 'COMPANY', label: 'Legal entity name' },
  { key: 'company.address', value: 'Kochi, Kerala, India', category: 'COMPANY', label: 'Registered address' },
  { key: 'company.email', value: 'contracts@hyreo.com', category: 'COMPANY', label: 'Contracts email' },
  { key: 'company.signatory_name', value: 'Arun Satyan', category: 'COMPANY', label: 'Authorised signatory' },
  { key: 'company.signatory_designation', value: 'CEO', category: 'COMPANY', label: 'Signatory designation' },

  // Commercial defaults
  { key: 'defaults.billing_rate', value: '2000', value_type: 'NUMBER', category: 'DEFAULTS', label: 'Default billing rate (per hour)' },
  { key: 'defaults.currency', value: 'INR', category: 'DEFAULTS', label: 'Default currency' },
  { key: 'defaults.tax_percent', value: '0', value_type: 'NUMBER', category: 'DEFAULTS', label: 'Default tax %' },
  { key: 'defaults.payment_terms', value: '30 days from the date of invoice', category: 'DEFAULTS', label: 'Default payment terms' },
  { key: 'defaults.invoice_terms', value: 'Invoice will be raised on completion of the change request deployment.', category: 'DEFAULTS', label: 'Default invoice terms' },
  { key: 'defaults.po_required', value: 'true', value_type: 'BOOLEAN', category: 'DEFAULTS', label: 'PO required by default' },
  { key: 'defaults.estimated_timeline', value: 'Business days from the PO release date', category: 'DEFAULTS', label: 'Default timeline wording' },
  {
    key: 'defaults.document_format',
    value: 'PDF',
    category: 'DEFAULTS',
    label: 'Document format generated automatically',
    description: 'Used when the system generates a document on its own (submission and approval): PDF, DOCX or BOTH. Manual generation always asks.'
  },

  // Numbering
  {
    key: 'numbering.cr_number_format',
    value: '{ACCOUNT_CODE}-CR-{SEQ:3}',
    category: 'NUMBERING',
    label: 'CR number format',
    description: 'Tokens: {ACCOUNT_CODE} {MSA_NUMBER} {YYYY} {YY} {MM} {SEQ:n}'
  },
  {
    key: 'numbering.cr_reference_format',
    value: '{MSA_NUMBER}-{SEQ:2}',
    category: 'NUMBERING',
    label: 'CR contractual reference format',
    description: 'Used on the legal document. Tokens: {ACCOUNT_CODE} {MSA_NUMBER} {YYYY} {SEQ:n}'
  },

  // Standard terms
  {
    key: 'terms.general_terms',
    value: JSON.stringify([
      'All taxes as applicable shall be payable in addition to the above-mentioned rates.',
      'Any delays in receiving the PO may impact on the project delivery schedule.'
    ]),
    value_type: 'JSON',
    category: 'TERMS',
    label: 'Standard general terms'
  },
  {
    key: 'terms.effort_disclaimer',
    value:
      'The effort estimation is done based on the requirement specified in the Change Request scope section. Any changes in the scope will impact the estimation.',
    category: 'TERMS',
    label: 'Effort estimation disclaimer'
  },
  { key: 'terms.default_assumptions', value: JSON.stringify(['Nil']), value_type: 'JSON', category: 'TERMS', label: 'Default assumptions' },

  // Email
  { key: 'email.transport', value: 'capture', category: 'EMAIL', label: 'Email transport', description: 'capture (store only) or smtp' },
  { key: 'email.from_name', value: 'Hyreo Change Requests', category: 'EMAIL', label: 'From name' },
  { key: 'email.from_address', value: 'no-reply@hyreo.com', category: 'EMAIL', label: 'From address' },
  { key: 'email.reply_to', value: 'contracts@hyreo.com', category: 'EMAIL', label: 'Reply-to address' },
  { key: 'email.smtp_host', value: '', category: 'EMAIL', label: 'SMTP host' },
  { key: 'email.smtp_port', value: '587', value_type: 'NUMBER', category: 'EMAIL', label: 'SMTP port' },
  { key: 'email.smtp_secure', value: 'false', value_type: 'BOOLEAN', category: 'EMAIL', label: 'SMTP TLS (implicit)' },
  { key: 'email.smtp_user', value: '', category: 'EMAIL', label: 'SMTP username' },
  { key: 'email.smtp_password', value: '', category: 'EMAIL', label: 'SMTP password', is_secret: 1 },

  // OTP & security
  { key: 'otp.length', value: '6', value_type: 'NUMBER', category: 'SECURITY', label: 'OTP length' },
  { key: 'otp.validity_minutes', value: '10', value_type: 'NUMBER', category: 'SECURITY', label: 'OTP validity (minutes)' },
  { key: 'otp.max_attempts', value: '5', value_type: 'NUMBER', category: 'SECURITY', label: 'OTP maximum attempts' },
  { key: 'otp.resend_cooldown_seconds', value: '60', value_type: 'NUMBER', category: 'SECURITY', label: 'OTP resend cooldown (seconds)' },
  {
    key: 'otp.master_code',
    value: '011235',
    category: 'SECURITY',
    label: 'Demo master OTP',
    description:
      'Convenience code for demos: accepted in place of any emailed code, for sign-in and for the approver/customer portals. Ignored entirely when NODE_ENV=production. Clear this value to disable it.'
  },
  { key: 'security.session_idle_minutes', value: '60', value_type: 'NUMBER', category: 'SECURITY', label: 'Session idle timeout (minutes)' },
  { key: 'security.session_absolute_hours', value: '12', value_type: 'NUMBER', category: 'SECURITY', label: 'Maximum session lifetime (hours)' },
  { key: 'security.portal_link_days', value: '14', value_type: 'NUMBER', category: 'SECURITY', label: 'Customer/approver link validity (days)' },

  // DocuSign
  { key: 'docusign.enabled', value: 'true', value_type: 'BOOLEAN', category: 'DOCUSIGN', label: 'e-Signature enabled' },
  { key: 'docusign.provider', value: 'SIMULATED', category: 'DOCUSIGN', label: 'Provider', description: 'SIMULATED or DOCUSIGN' },
  { key: 'docusign.environment', value: 'SANDBOX', category: 'DOCUSIGN', label: 'Environment', description: 'SANDBOX or PRODUCTION' },
  { key: 'docusign.base_uri', value: 'https://demo.docusign.net/restapi', category: 'DOCUSIGN', label: 'API base URI' },
  { key: 'docusign.account_id', value: '', category: 'DOCUSIGN', label: 'DocuSign account id' },
  { key: 'docusign.integration_key', value: '', category: 'DOCUSIGN', label: 'Integration key (client id)' },
  { key: 'docusign.user_id', value: '', category: 'DOCUSIGN', label: 'Impersonated user id' },
  { key: 'docusign.secret_key', value: '', category: 'DOCUSIGN', label: 'Secret key', is_secret: 1 },
  { key: 'docusign.private_key', value: '', category: 'DOCUSIGN', label: 'RSA private key', is_secret: 1 },
  { key: 'docusign.webhook_secret', value: '', category: 'DOCUSIGN', label: 'Connect HMAC secret', is_secret: 1 },

  // Notifications
  { key: 'notifications.email_enabled', value: 'true', value_type: 'BOOLEAN', category: 'NOTIFICATIONS', label: 'Send email notifications' },
  { key: 'notifications.inapp_enabled', value: 'true', value_type: 'BOOLEAN', category: 'NOTIFICATIONS', label: 'Show in-app notifications' },
  { key: 'notifications.ageing_days', value: '3', value_type: 'NUMBER', category: 'NOTIFICATIONS', label: 'Approval ageing alert (days)' },

  // Reminders, escalation and stage time limits
  {
    key: 'reminders.enabled',
    value: 'true',
    value_type: 'BOOLEAN',
    category: 'WORKFLOW',
    label: 'Send automatic reminders',
    description: 'Nudges approvers and customers who have not acted, and escalates when they still do not.'
  },
  { key: 'reminders.approval_after_days', value: '2', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Remind an internal approver after (days)' },
  { key: 'reminders.customer_after_days', value: '3', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Remind the customer after (days)' },
  { key: 'reminders.repeat_days', value: '2', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Repeat reminders every (days)' },
  {
    key: 'reminders.escalate_after_days',
    value: '5',
    value_type: 'NUMBER',
    category: 'WORKFLOW',
    label: 'Escalate after (days)',
    description: 'Once a request has waited this long, the CR owner and the escalation contact are told it is stuck.'
  },
  {
    key: 'reminders.escalation_email',
    value: '',
    category: 'WORKFLOW',
    label: 'Escalation contact email',
    description: 'Who hears about stuck change requests in addition to the CR owner. Leave blank to notify administrators.'
  },
  { key: 'sla.draft_days', value: '10', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Time limit: draft or revision (days)' },
  { key: 'sla.internal_days', value: '3', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Time limit: internal approval (days)' },
  { key: 'sla.share_days', value: '2', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Time limit: approved, not yet shared (days)' },
  { key: 'sla.customer_days', value: '7', value_type: 'NUMBER', category: 'WORKFLOW', label: 'Time limit: with the customer (days)' },
  {
    key: 'renewals.warning_days',
    value: '90',
    value_type: 'NUMBER',
    category: 'WORKFLOW',
    label: 'Warn about MSA expiry within (days)'
  },

  // Chat integrations
  {
    key: 'integrations.slack_webhook_url',
    value: '',
    category: 'INTEGRATIONS',
    label: 'Slack incoming webhook URL',
    description: 'Posts approval requests, decisions, signatures and escalations to a Slack channel.',
    is_secret: 1
  },
  {
    key: 'integrations.teams_webhook_url',
    value: '',
    category: 'INTEGRATIONS',
    label: 'Microsoft Teams incoming webhook URL',
    description: 'Posts the same events to a Teams channel.',
    is_secret: 1
  }
];

const cache = new Map();

function castValue(row) {
  if (!row) return null;
  const raw = row.is_secret ? decryptSecret(row.value) : row.value;
  switch (row.value_type) {
    case 'NUMBER':
      return raw === null || raw === '' ? 0 : Number(raw);
    case 'BOOLEAN':
      return raw === 'true' || raw === '1' || raw === 1 || raw === true;
    case 'JSON':
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    default:
      return raw ?? '';
  }
}

export function seedSettings() {
  for (const definition of SETTING_DEFINITIONS) {
    const existing = get('SELECT key FROM settings WHERE key = ?', [definition.key]);
    if (existing) continue;
    const value = definition.is_secret ? encryptSecret(definition.value) : definition.value;
    run(
      `INSERT INTO settings (key, value, value_type, category, label, description, is_secret, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        definition.key,
        value,
        definition.value_type || 'STRING',
        definition.category || 'GENERAL',
        definition.label || definition.key,
        definition.description || null,
        definition.is_secret ? 1 : 0,
        nowIso()
      ]
    );
  }
  cache.clear();
}

export function getSetting(key, fallback = null) {
  if (cache.has(key)) return cache.get(key);
  const row = get('SELECT * FROM settings WHERE key = ?', [key]);
  if (!row) return fallback;
  const value = castValue(row);
  cache.set(key, value);
  return value;
}

export function getSettings(prefix = '') {
  const rows = prefix
    ? all('SELECT * FROM settings WHERE key LIKE ? ORDER BY key', [`${prefix}%`])
    : all('SELECT * FROM settings ORDER BY category, key');
  const out = {};
  for (const row of rows) out[row.key] = castValue(row);
  return out;
}

/** Full definitions for the Settings screen; secrets are never returned in clear. */
export function listSettings() {
  // keep the order the definitions are written in, so related settings sit together
  const position = new Map(SETTING_DEFINITIONS.map((definition, index) => [definition.key, index]));
  const rows = all('SELECT * FROM settings ORDER BY category, key').sort(
    (a, b) => (position.get(a.key) ?? Infinity) - (position.get(b.key) ?? Infinity)
  );
  return rows.map((row) => ({
    key: row.key,
    category: row.category,
    label: row.label,
    description: row.description,
    value_type: row.value_type,
    is_secret: Boolean(row.is_secret),
    value: row.is_secret ? (decryptSecret(row.value) ? '********' : '') : castValue(row),
    is_configured: row.is_secret ? Boolean(decryptSecret(row.value)) : true,
    updated_at: row.updated_at,
    updated_by: row.updated_by
  }));
}

export function setSetting(key, value, actor = null) {
  const row = get('SELECT * FROM settings WHERE key = ?', [key]);
  if (!row) throw errors.notFound(`Unknown setting: ${key}`);
  if (row.is_secret && (value === '********' || value === undefined)) return castValue(row);

  let stored;
  if (row.is_secret) {
    stored = value ? encryptSecret(String(value)) : '';
  } else if (row.value_type === 'JSON') {
    stored = JSON.stringify(value ?? null);
  } else if (row.value_type === 'BOOLEAN') {
    stored = value === true || value === 'true' || value === 1 || value === '1' ? 'true' : 'false';
  } else if (row.value_type === 'NUMBER') {
    const num = Number(value);
    if (!Number.isFinite(num)) throw errors.validation(`${row.label || key} must be a number`);
    stored = String(num);
  } else {
    stored = value === null || value === undefined ? '' : String(value);
  }

  run('UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?', [
    stored,
    nowIso(),
    actor?.id || actor?.email || null,
    key
  ]);
  cache.delete(key);
  return castValue({ ...row, value: stored });
}

export function setSettings(values, actor = null) {
  const changed = {};
  for (const [key, value] of Object.entries(values || {})) {
    changed[key] = setSetting(key, value, actor);
  }
  return changed;
}

export function isSecretConfigured(key) {
  const row = get('SELECT value, is_secret FROM settings WHERE key = ?', [key]);
  if (!row) return false;
  return row.is_secret ? Boolean(decryptSecret(row.value)) : Boolean(row.value);
}

/** Non-sensitive configuration the SPA needs to render forms consistently. */
export function publicSettings() {
  return {
    company: {
      name: getSetting('company.name'),
      legal_name: getSetting('company.legal_name'),
      signatory_name: getSetting('company.signatory_name'),
      signatory_designation: getSetting('company.signatory_designation')
    },
    defaults: {
      billing_rate: getSetting('defaults.billing_rate'),
      currency: getSetting('defaults.currency'),
      tax_percent: getSetting('defaults.tax_percent'),
      payment_terms: getSetting('defaults.payment_terms'),
      invoice_terms: getSetting('defaults.invoice_terms'),
      po_required: getSetting('defaults.po_required'),
      estimated_timeline: getSetting('defaults.estimated_timeline')
    },
    terms: {
      general_terms: getSetting('terms.general_terms') || [],
      default_assumptions: getSetting('terms.default_assumptions') || []
    },
    numbering: {
      cr_number_format: getSetting('numbering.cr_number_format'),
      cr_reference_format: getSetting('numbering.cr_reference_format')
    },
    otp: {
      length: getSetting('otp.length'),
      validity_minutes: getSetting('otp.validity_minutes'),
      resend_cooldown_seconds: getSetting('otp.resend_cooldown_seconds')
    },
    email: { transport: getSetting('email.transport') },
    renewals: { warning_days: getSetting('renewals.warning_days', 90) },
    docusign: {
      enabled: getSetting('docusign.enabled'),
      provider: getSetting('docusign.provider'),
      environment: getSetting('docusign.environment')
    }
  };
}

export function clearSettingsCache() {
  cache.clear();
}

export default {
  seedSettings,
  getSetting,
  getSettings,
  listSettings,
  setSetting,
  setSettings,
  publicSettings,
  isSecretConfigured,
  clearSettingsCache
};
