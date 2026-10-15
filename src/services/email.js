import fs from 'node:fs';
import { all, get, insert, run } from '../db/index.js';
import { uid, randomToken } from '../lib/ids.js';
import { nowIso, formatDateTime } from '../lib/dates.js';
import { hashToken } from '../lib/crypto.js';
import { getSetting } from './settings.js';
import { getTemplate } from './emailTemplates.js';
import audit, { ACTIONS } from './audit.js';
import config from '../config.js';

/**
 * Transport-agnostic outbound email.
 *  - queue()   writes an email_logs row synchronously (so the caller's transaction owns it)
 *  - flush()   delivers queued rows through the configured transport
 * The default "capture" transport keeps everything inside the application, which
 * makes the whole workflow demoable without SMTP credentials.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderTemplateString(template, variables = {}) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), variables);
    if (value === null || value === undefined) return '';
    return /_url$|_href$/.test(key) ? String(value) : escapeHtml(value);
  });
}

// Email clients can't recolour images, and hyreo.com only hosts the dark and all-white logos, so the app
// serves a white + cyan version of https://hyreo.com/wp-content/uploads/2024/01/Hyreo-Logo.png itself.
const emailLogoUrl = () => `${config.appUrl}/img/hyreo-logo-on-dark.png`;

export function wrapLayout({ subject, contentHtml, trackingToken = null, crReference = null }) {
  const companyName = getSetting('company.name', 'Hyreo');
  const pixel = trackingToken
    ? `<img src="${config.appUrl}/api/public/track/open/${trackingToken}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;"/>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f2f4f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#101828;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="width:620px;max-width:100%;background:#ffffff;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden;">
<tr><td style="background:#1f3864;padding:18px 28px;">
  <img src="${emailLogoUrl()}" width="73" height="30" alt="${escapeHtml(companyName)}" style="display:block;border:0;width:73px;height:30px;"/>
  <div style="color:#8fb4e8;font-size:12px;margin-top:4px;">Change Request Management</div>
</td></tr>
<tr><td style="padding:28px;font-size:14px;line-height:1.6;color:#344054;">${contentHtml}</td></tr>
<tr><td style="padding:16px 28px;background:#fafbfc;border-top:1px solid #e4e7ec;color:#667085;font-size:12px;line-height:1.5;">
  ${crReference ? `Reference: <strong>${escapeHtml(crReference)}</strong><br/>` : ''}
  This message and any attachment are confidential and intended solely for the addressee.
  Sent by the ${escapeHtml(companyName)} Change Request Management System.
</td></tr>
</table></td></tr></table>${pixel}
</body></html>`;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Queue a message. Returns the persisted email_logs row.
 * attachments: [{ filename, path, contentType }]
 */
export function queue({
  templateCode = null,
  to,
  cc = [],
  variables = {},
  subject: subjectOverride = null,
  bodyHtml: bodyOverride = null,
  crId = null,
  crReference = null,
  attachments = [],
  actor = null
}) {
  const template = templateCode ? getTemplate(templateCode) : null;
  const subject = subjectOverride ?? renderTemplateString(template?.subject || 'Notification', variables);
  const inner = bodyOverride ?? renderTemplateString(template?.body_html || '', variables);
  const trackingToken = randomToken(18);
  const html = wrapLayout({ subject, contentHtml: inner, trackingToken, crReference });

  const row = {
    id: uid('EML'),
    cr_id: crId,
    template_code: templateCode,
    to_email: String(to || '').toLowerCase(),
    cc_emails: (Array.isArray(cc) ? cc : [cc]).filter(Boolean).join(', ') || null,
    from_email: `${getSetting('email.from_name', 'Hyreo')} <${getSetting('email.from_address', 'no-reply@hyreo.com')}>`,
    subject,
    body_html: html,
    body_text: htmlToText(inner),
    status: 'QUEUED',
    provider: getSetting('email.transport', 'capture'),
    queued_at: nowIso(),
    tracking_token: trackingToken,
    attachments_json: attachments.length ? JSON.stringify(attachments.map((a) => ({ filename: a.filename, contentType: a.contentType }))) : null,
    created_by: actor?.id || null
  };
  insert('email_logs', row);
  row._attachments = attachments;
  pending.push(row.id);
  return row;
}

const pending = [];
let flushing = false;

async function smtpTransport() {
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport({
    host: getSetting('email.smtp_host'),
    port: Number(getSetting('email.smtp_port', 587)),
    secure: Boolean(getSetting('email.smtp_secure', false)),
    auth: getSetting('email.smtp_user')
      ? { user: getSetting('email.smtp_user'), pass: getSetting('email.smtp_password') }
      : undefined
  });
}

/** Deliver everything that is queued. Safe to call repeatedly. */
export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const rows = all("SELECT * FROM email_logs WHERE status = 'QUEUED' ORDER BY queued_at LIMIT 50");
    for (const row of rows) {
      const transport = getSetting('email.transport', 'capture');
      try {
        if (transport === 'smtp' && getSetting('email.smtp_host')) {
          const mailer = await smtpTransport();
          const attachments = readAttachments(row);
          const info = await mailer.sendMail({
            from: row.from_email,
            to: row.to_email,
            cc: row.cc_emails || undefined,
            replyTo: getSetting('email.reply_to') || undefined,
            subject: row.subject,
            html: row.body_html,
            text: row.body_text,
            attachments
          });
          run('UPDATE email_logs SET status = ?, sent_at = ?, delivered_at = ?, provider = ?, provider_message_id = ? WHERE id = ?', [
            'DELIVERED',
            nowIso(),
            nowIso(),
            'smtp',
            info?.messageId || null,
            row.id
          ]);
        } else {
          run('UPDATE email_logs SET status = ?, sent_at = ?, provider = ? WHERE id = ?', [
            'SENT',
            nowIso(),
            'capture',
            row.id
          ]);
        }
        audit.record({
          entityType: 'EMAIL',
          entityId: row.id,
          crId: row.cr_id,
          action: ACTIONS.EMAIL_SENT,
          actor: { type: 'SYSTEM', name: 'System' },
          newValue: { to: row.to_email, subject: row.subject, template: row.template_code }
        });
      } catch (error) {
        run('UPDATE email_logs SET status = ?, error = ? WHERE id = ?', ['FAILED', String(error?.message || error), row.id]);
      }
    }
  } finally {
    flushing = false;
    pending.length = 0;
  }
}

function readAttachments(row) {
  const stored = attachmentPaths.get(row.id) || [];
  return stored
    .filter((a) => a.path && fs.existsSync(a.path))
    .map((a) => ({ filename: a.filename, path: a.path, contentType: a.contentType }));
}

const attachmentPaths = new Map();

/** Remember file paths for a queued message (not persisted in the log body). */
export function attachFiles(emailId, attachments = []) {
  if (attachments.length) attachmentPaths.set(emailId, attachments);
}

/** Queue + deliver. Returns the log row; delivery happens in the background. */
export function send(options) {
  const row = queue(options);
  if (options.attachments?.length) attachFiles(row.id, options.attachments);
  setImmediate(() => {
    flush().catch(() => {});
  });
  return row;
}

export function markOpened(trackingToken, ip = null) {
  const row = get('SELECT * FROM email_logs WHERE tracking_token = ?', [trackingToken]);
  if (!row) return null;
  run(
    `UPDATE email_logs SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?),
       status = CASE WHEN status IN ('SENT','DELIVERED') THEN 'OPENED' ELSE status END WHERE id = ?`,
    [nowIso(), row.id]
  );
  if (!row.opened_at) {
    audit.record({
      entityType: 'EMAIL',
      entityId: row.id,
      crId: row.cr_id,
      action: ACTIONS.EMAIL_OPENED,
      actor: { type: 'SYSTEM', name: row.to_email },
      ip
    });
  }
  return row;
}

export function markClicked(crId, email) {
  const row = get(
    `SELECT * FROM email_logs WHERE cr_id = ? AND lower(to_email) = lower(?) ORDER BY queued_at DESC LIMIT 1`,
    [crId, email]
  );
  if (!row) return null;
  run(
    `UPDATE email_logs SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?),
       status = CASE WHEN status IN ('SENT','DELIVERED','OPENED') THEN 'CLICKED' ELSE status END WHERE id = ?`,
    [nowIso(), row.id]
  );
  return row;
}

export function listEmails({ crId = null, status = null, q = null, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (crId) {
    where.push('e.cr_id = ?');
    params.push(crId);
  }
  if (status) {
    where.push('e.status = ?');
    params.push(status);
  }
  if (q) {
    where.push('(e.to_email LIKE ? OR e.subject LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(
    `SELECT e.id, e.cr_id, e.template_code, e.to_email, e.cc_emails, e.subject, e.status,
            e.queued_at, e.sent_at, e.opened_at, e.clicked_at, e.open_count, e.click_count, e.error,
            cr.cr_number
       FROM email_logs e LEFT JOIN change_requests cr ON cr.id = e.cr_id
       ${clause} ORDER BY e.queued_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const total = get(`SELECT COUNT(*) AS count FROM email_logs e ${clause}`, params)?.count || 0;
  return { rows: rows.map((r) => ({ ...r, queued_at_label: formatDateTime(r.queued_at) })), total };
}

export function getEmail(id) {
  return get('SELECT * FROM email_logs WHERE id = ?', [id]);
}

/** True when OTP codes may be surfaced in the UI (no real mail transport). */
export function isCaptureMode() {
  return getSetting('email.transport', 'capture') !== 'smtp' || !getSetting('email.smtp_host');
}

export function verifyTransport() {
  const transport = getSetting('email.transport', 'capture');
  if (transport !== 'smtp') {
    return { ok: true, transport, message: 'Capture transport active — messages are stored in the outbox and not delivered externally.' };
  }
  if (!getSetting('email.smtp_host')) {
    return { ok: false, transport, message: 'SMTP transport selected but no host is configured.' };
  }
  return { ok: true, transport, message: `SMTP configured for ${getSetting('email.smtp_host')}:${getSetting('email.smtp_port')}` };
}

export { hashToken };

export default {
  queue,
  send,
  flush,
  markOpened,
  markClicked,
  listEmails,
  getEmail,
  isCaptureMode,
  verifyTransport,
  renderTemplateString,
  wrapLayout
};
