import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/dates.js';
import { errors } from '../lib/errors.js';

const button = (url, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:#1f3864;border-radius:6px;">
   <a href="${url}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-weight:600;font-size:14px;text-decoration:none;">${label}</a>
   </td></tr></table>`;

const escapeHtml = (value) =>
  String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SIGN_OFF = /^(regards|best regards|kind regards|warm regards|with regards|thanks|thank you|many thanks|sincerely|yours sincerely|yours faithfully|best|cheers)\b[\s,.!]*$/i;

/**
 * Turns a plain-text message typed in a composer into email HTML: blank lines
 * start paragraphs, single newlines become line breaks, and the call-to-action
 * button sits just before the sign-off ("Regards, ...") — or at the end if none.
 */
export function composeMessageHtml(text, { ctaUrl, ctaLabel }) {
  const blocks = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const signOffAt = blocks.findIndex((block) => SIGN_OFF.test(block.split('\n')[0].trim()));
  const html = blocks.map((block) => `<p style="margin:0 0 14px;">${escapeHtml(block).replace(/\n/g, '<br/>')}</p>`);
  html.splice(signOffAt === -1 ? html.length : signOffAt, 0, button(ctaUrl, escapeHtml(ctaLabel)));
  return html.join('\n');
}

const factsTable = (rows) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">${rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:7px 10px;background:#f6f7f9;border:1px solid #e4e7ec;color:#475467;width:42%;">${label}</td>
          <td style="padding:7px 10px;border:1px solid #e4e7ec;color:#101828;font-weight:600;">${value}</td></tr>`
    )
    .join('')}</table>`;

export const DEFAULT_TEMPLATES = [
  {
    code: 'OTP_LOGIN',
    name: 'Login OTP',
    description: 'One-time passcode for signing in to the application.',
    subject: 'Your {{company_name}} sign-in code: {{otp_code}}',
    variables: ['user_name', 'otp_code', 'validity_minutes', 'company_name'],
    body_html: `<p>Hello {{user_name}},</p>
<p>Use the one-time code below to sign in to the {{company_name}} Change Request Management System.</p>
<p style="font-size:32px;font-weight:700;letter-spacing:10px;color:#1f3864;margin:24px 0;">{{otp_code}}</p>
<p>This code expires in {{validity_minutes}} minutes and can be used once.</p>
<p style="color:#667085;font-size:13px;">If you did not request this code, you can safely ignore this email.</p>`
  },
  {
    code: 'OTP_PORTAL',
    name: 'Portal OTP',
    description: 'One-time passcode for the external approver / customer portal.',
    subject: 'Your verification code for Change Request {{cr_number}}',
    variables: ['otp_code', 'cr_number', 'account_name', 'validity_minutes'],
    body_html: `<p>Hello,</p>
<p>Use the verification code below to open Change Request <strong>{{cr_number}}</strong> for {{account_name}}.</p>
<p style="font-size:32px;font-weight:700;letter-spacing:10px;color:#1f3864;margin:24px 0;">{{otp_code}}</p>
<p>This code expires in {{validity_minutes}} minutes.</p>`
  },
  {
    code: 'INTERNAL_APPROVAL_REQUEST',
    name: 'Internal approval request',
    description: 'Sent to the internal approver when a CR is submitted.',
    subject: 'Approval required - Change Request {{cr_number}} - {{account_name}}',
    variables: [
      'approver_name', 'cr_number', 'cr_reference', 'account_name', 'msa_number', 'cr_title',
      'cr_cost', 'total_effort', 'target_release_date', 'submitted_by', 'review_url'
    ],
    body_html: `<p>Hello {{approver_name}},</p>
<p>A change request has been submitted for your review and approval.</p>
${factsTable([
  ['Customer', '{{account_name}}'],
  ['MSA reference', '{{msa_number}}'],
  ['CR number', '{{cr_number}}'],
  ['CR reference', '{{cr_reference}}'],
  ['CR title', '{{cr_title}}'],
  ['Total effort', '{{total_effort}} person hours'],
  ['CR cost', '{{cr_cost}}'],
  ['Target release date', '{{target_release_date}}'],
  ['Submitted by', '{{submitted_by}}']
])}
${button('{{review_url}}', 'Review Change Request')}
<p style="color:#667085;font-size:13px;">You will be asked to verify your email address with a one-time code before the change request is displayed.</p>`
  },
  {
    code: 'CR_APPROVED',
    name: 'CR approved internally',
    description: 'Sent to the CR manager once all internal approvals are complete.',
    subject: 'Change Request Approved - {{cr_number}} - {{account_name}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'msa_number', 'cr_title', 'cr_cost', 'approved_by', 'approved_date', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>The Change Request has been approved internally and is ready to be shared with the customer.</p>
${factsTable([
  ['CR number', '{{cr_number}}'],
  ['Customer', '{{account_name}}'],
  ['MSA reference', '{{msa_number}}'],
  ['CR title', '{{cr_title}}'],
  ['CR cost', '{{cr_cost}}'],
  ['Approved by', '{{approved_by}}'],
  ['Approved on', '{{approved_date}}']
])}
${button('{{cr_url}}', 'View Change Request')}`
  },
  {
    code: 'CR_REJECTED',
    name: 'CR rejected internally',
    description: 'Sent to the CR manager when an internal approver rejects.',
    subject: 'Change Request Rejected - {{cr_number}} - {{account_name}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'cr_title', 'rejected_by', 'rejected_date', 'rejection_comments', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>The Change Request below has been <strong style="color:#b42318;">rejected</strong> during internal review and has been returned to draft for revision.</p>
${factsTable([
  ['CR number', '{{cr_number}}'],
  ['Customer', '{{account_name}}'],
  ['CR title', '{{cr_title}}'],
  ['Rejected by', '{{rejected_by}}'],
  ['Rejected on', '{{rejected_date}}']
])}
<p style="margin:0 0 6px;color:#475467;font-size:13px;">Reason for rejection</p>
<blockquote style="margin:0;padding:12px 16px;background:#fef3f2;border-left:3px solid #b42318;color:#101828;">{{rejection_comments}}</blockquote>
${button('{{cr_url}}', 'Open Change Request')}`
  },
  {
    code: 'CUSTOMER_APPROVAL_REQUEST',
    name: 'Customer approval request',
    description: 'Sent to the customer approver with the CR document attached.',
    subject: 'Change Request {{cr_number}} - Approval Required',
    variables: ['customer_name', 'cr_number', 'cr_reference', 'cr_title', 'account_name', 'cr_cost', 'target_release_date', 'portal_url', 'company_name'],
    body_html: `<p>Dear {{customer_name}},</p>
<p>The Change Request document is ready for your review and approval. The document is attached for your records.</p>
${factsTable([
  ['CR reference', '{{cr_reference}}'],
  ['CR number', '{{cr_number}}'],
  ['CR title', '{{cr_title}}'],
  ['CR cost', '{{cr_cost}}'],
  ['Target release date', '{{target_release_date}}']
])}
${button('{{portal_url}}', 'Review &amp; Sign Change Request')}
<p style="color:#667085;font-size:13px;">For your security, you will be asked to verify this email address with a one-time code before the change request is displayed.</p>
<p>Regards,<br/>{{company_name}}</p>`
  },
  {
    code: 'CUSTOMER_VIEWED_NOTICE',
    name: 'Customer viewed the CR',
    description: 'Informs the CR manager that the customer opened the portal.',
    subject: 'Customer viewed Change Request {{cr_number}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'customer_email', 'viewed_at', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>{{customer_email}} opened Change Request <strong>{{cr_number}}</strong> ({{account_name}}) on {{viewed_at}}.</p>
${button('{{cr_url}}', 'View Change Request')}`
  },
  {
    code: 'CUSTOMER_APPROVED',
    name: 'Customer approved and signed',
    description: 'Sent to the CR manager when the customer signs.',
    subject: 'Change Request {{cr_number}} signed by {{account_name}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'signed_by', 'signature_name', 'signed_at', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>The customer has approved and signed the Change Request.</p>
${factsTable([
  ['CR number', '{{cr_number}}'],
  ['Customer', '{{account_name}}'],
  ['Signed by', '{{signed_by}}'],
  ['Signature', '{{signature_name}}'],
  ['Signed on', '{{signed_at}}']
])}
${button('{{cr_url}}', 'Open Change Request')}`
  },
  {
    code: 'CUSTOMER_REJECTED',
    name: 'Customer rejected',
    description: 'Sent to the CR manager when the customer rejects.',
    subject: 'Change Request {{cr_number}} rejected by {{account_name}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'rejected_by', 'rejection_comments', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>{{rejected_by}} has rejected Change Request <strong>{{cr_number}}</strong> for {{account_name}}. The change request has been moved to revision.</p>
<blockquote style="margin:0;padding:12px 16px;background:#fef3f2;border-left:3px solid #b42318;color:#101828;">{{rejection_comments}}</blockquote>
${button('{{cr_url}}', 'Open Change Request')}`
  },
  {
    code: 'DOCUSIGN_SENT',
    name: 'DocuSign envelope sent',
    description: 'Confirmation that an envelope has been dispatched.',
    subject: 'Envelope sent for Change Request {{cr_number}}',
    variables: ['manager_name', 'cr_number', 'envelope_id', 'recipients', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>An e-signature envelope has been sent for Change Request <strong>{{cr_number}}</strong>.</p>
${factsTable([
  ['Envelope id', '{{envelope_id}}'],
  ['Recipients', '{{recipients}}']
])}
${button('{{cr_url}}', 'Track Signature Status')}`
  },
  {
    code: 'DOCUSIGN_COMPLETED',
    name: 'DocuSign envelope completed',
    description: 'Sent when every signer has completed the envelope.',
    subject: 'Signed - Change Request {{cr_number}} - {{account_name}}',
    variables: ['manager_name', 'cr_number', 'account_name', 'envelope_id', 'completed_at', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>All parties have signed Change Request <strong>{{cr_number}}</strong> for {{account_name}}. The change request is now complete and the signed document has been stored.</p>
${factsTable([
  ['Envelope id', '{{envelope_id}}'],
  ['Completed on', '{{completed_at}}']
])}
${button('{{cr_url}}', 'Download Signed Change Request')}`
  },
  {
    code: 'DOCUMENT_GENERATED',
    name: 'Document generated',
    description: 'Notifies the CR manager that a new document version exists.',
    subject: 'Change Request {{cr_number}} document v{{version}} generated',
    variables: ['manager_name', 'cr_number', 'version', 'generated_by', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>Version <strong>{{version}}</strong> of the Change Request document for {{cr_number}} was generated by {{generated_by}}.</p>
${button('{{cr_url}}', 'View Documents')}`
  },
  {
    code: 'CR_CANCELLED',
    name: 'CR cancelled',
    description: 'Sent when a change request is cancelled.',
    subject: 'Change Request {{cr_number}} cancelled',
    variables: ['manager_name', 'cr_number', 'account_name', 'cancelled_by', 'reason', 'cr_url'],
    body_html: `<p>Hello {{manager_name}},</p>
<p>Change Request <strong>{{cr_number}}</strong> ({{account_name}}) was cancelled by {{cancelled_by}}.</p>
<blockquote style="margin:0;padding:12px 16px;background:#f6f7f9;border-left:3px solid #98a2b3;color:#101828;">{{reason}}</blockquote>
${button('{{cr_url}}', 'Open Change Request')}`
  },
  {
    code: 'APPROVAL_REMINDER',
    name: 'Internal approval reminder',
    description: 'Sent to an internal approver who has not decided yet.',
    subject: 'Reminder: approval pending - Change Request {{cr_number}} - {{account_name}}',
    variables: ['approver_name', 'cr_number', 'account_name', 'cr_title', 'cr_cost', 'waiting_days', 'review_url'],
    body_html: `<p>Hello {{approver_name}},</p>
<p>Change Request <strong>{{cr_number}}</strong> has been waiting for your decision for <strong>{{waiting_days}} day(s)</strong>.</p>
${factsTable([
  ['Customer', '{{account_name}}'],
  ['CR title', '{{cr_title}}'],
  ['CR cost', '{{cr_cost}}']
])}
${button('{{review_url}}', 'Review Change Request')}
<p style="color:#667085;font-size:13px;">This link replaces any earlier one you received for this change request.</p>`
  },
  {
    code: 'CUSTOMER_REMINDER',
    name: 'Customer approval reminder',
    description: 'Sent to a customer signatory who has not responded yet.',
    subject: 'Reminder: Change Request {{cr_number}} is awaiting your approval',
    variables: ['customer_name', 'cr_number', 'cr_reference', 'cr_title', 'cr_cost', 'waiting_days', 'portal_url', 'company_name'],
    body_html: `<p>Dear {{customer_name}},</p>
<p>This is a friendly reminder that Change Request <strong>{{cr_reference}}</strong> has been awaiting your review for {{waiting_days}} day(s).</p>
${factsTable([
  ['CR number', '{{cr_number}}'],
  ['CR title', '{{cr_title}}'],
  ['CR cost', '{{cr_cost}}']
])}
${button('{{portal_url}}', 'Review &amp; Sign Change Request')}
<p style="color:#667085;font-size:13px;">This link replaces any earlier one we sent for this change request.</p>
<p>Regards,<br/>{{company_name}}</p>`
  },
  {
    code: 'ESCALATION_NOTICE',
    name: 'Stuck change request escalation',
    description: 'Tells the CR owner and the escalation contact that a request has waited too long.',
    subject: 'Escalation: Change Request {{cr_number}} waiting {{waiting_days}} days on {{waiting_on}}',
    variables: ['recipient_name', 'cr_number', 'account_name', 'cr_title', 'stage', 'waiting_on', 'waiting_days', 'reminders_sent', 'cr_url'],
    body_html: `<p>Hello {{recipient_name}},</p>
<p>Change Request <strong>{{cr_number}}</strong> has not moved for <strong style="color:#b42318;">{{waiting_days}} days</strong> and may need a follow-up.</p>
${factsTable([
  ['Customer', '{{account_name}}'],
  ['CR title', '{{cr_title}}'],
  ['Stage', '{{stage}}'],
  ['Waiting on', '{{waiting_on}}'],
  ['Reminders already sent', '{{reminders_sent}}']
])}
${button('{{cr_url}}', 'Open Change Request')}`
  },
  {
    code: 'TEST_EMAIL',
    name: 'Test email',
    description: 'Sent from Settings to verify the email configuration.',
    subject: '{{company_name}} CRMS - test email',
    variables: ['company_name', 'sent_by'],
    body_html: `<p>This is a test message from the {{company_name}} Change Request Management System, requested by {{sent_by}}.</p>
<p>If you received it, outbound email is configured correctly.</p>`
  }
];

export function seedEmailTemplates() {
  for (const template of DEFAULT_TEMPLATES) {
    const existing = get('SELECT code FROM email_templates WHERE code = ?', [template.code]);
    if (existing) continue;
    run(
      `INSERT INTO email_templates (code, name, description, subject, body_html, variables_json, is_active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        template.code,
        template.name,
        template.description,
        template.subject,
        template.body_html,
        JSON.stringify(template.variables || []),
        nowIso()
      ]
    );
  }
}

export function listTemplates() {
  return all('SELECT * FROM email_templates ORDER BY name').map((row) => ({
    ...row,
    variables: safeParse(row.variables_json),
    is_active: Boolean(row.is_active)
  }));
}

export function getTemplate(code) {
  const row = get('SELECT * FROM email_templates WHERE code = ?', [code]);
  if (!row) return null;
  return { ...row, variables: safeParse(row.variables_json), is_active: Boolean(row.is_active) };
}

export function updateTemplate(code, { subject, body_html, is_active }, actor = null) {
  const existing = getTemplate(code);
  if (!existing) throw errors.notFound('Email template not found');
  run(
    `UPDATE email_templates SET subject = ?, body_html = ?, is_active = ?, updated_at = ?, updated_by = ? WHERE code = ?`,
    [
      subject ?? existing.subject,
      body_html ?? existing.body_html,
      is_active === undefined ? existing.is_active : is_active ? 1 : 0,
      nowIso(),
      actor?.id || null,
      code
    ]
  );
  return getTemplate(code);
}

export function resetTemplate(code) {
  const fallback = DEFAULT_TEMPLATES.find((t) => t.code === code);
  if (!fallback) throw errors.notFound('Email template not found');
  run('UPDATE email_templates SET subject = ?, body_html = ?, updated_at = ? WHERE code = ?', [
    fallback.subject,
    fallback.body_html,
    nowIso(),
    code
  ]);
  return getTemplate(code);
}

function safeParse(value) {
  try {
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

export default { DEFAULT_TEMPLATES, seedEmailTemplates, listTemplates, getTemplate, updateTemplate, resetTemplate };
