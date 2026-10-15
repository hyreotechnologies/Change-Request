import { all, get, insert, run, transaction, update } from '../db/index.js';
import { uid, randomToken } from '../lib/ids.js';
import { nowIso, addHours, isPast, formatDateTime } from '../lib/dates.js';
import { hashToken, maskEmail } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { normaliseEmail, validate } from '../lib/validate.js';
import { formatMoney } from '../lib/money.js';
import changeRequests from './changeRequests.js';
import documents from './documents.js';
import shareLinks from './shareLinks.js';
import approvals from './approvals.js';
import authService from './auth.js';
import email from './email.js';
import notifications from './notifications.js';
import chat from './chat.js';
import audit, { ACTIONS } from './audit.js';
import { getSetting } from './settings.js';
import { composeMessageHtml } from './emailTemplates.js';
import config from '../config.js';

const PORTAL_SESSION_HOURS = 2;

/* ------------------------------------------------- share with customer -- */

export function shareWithCustomer(crId, payload, actor) {
  const cr = changeRequests.find(crId);

  if (!['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER', 'SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status)) {
    throw errors.invalidState('Only an internally approved change request can be shared with the customer');
  }
  if (!documents.hasFinal(crId)) {
    throw errors.invalidState('Generate the final change request document before sharing it with the customer');
  }

  const data = validate(payload || {}, {
    to: { type: 'email', label: 'Customer email', required: true },
    cc: { type: 'array', label: 'CC', maxItems: 10 },
    subject: { type: 'string', label: 'Subject', maxLength: 300 },
    message: { type: 'text', label: 'Message', maxLength: 8000 },
    contact_name: { type: 'string', label: 'Contact name', maxLength: 120 },
    attach_docx: { type: 'boolean', label: 'Attach Word document', default: 1 },
    attach_pdf: { type: 'boolean', label: 'Attach PDF', default: 1 }
  });

  const ccList = (data.cc || []).map(normaliseEmail).filter(Boolean);

  return transaction(() => {
    let approval = get('SELECT * FROM customer_approvals WHERE cr_id = ? AND lower(contact_email) = lower(?)', [crId, data.to]);
    if (!approval) {
      const row = {
        id: uid('CAP'),
        cr_id: crId,
        signer_order: (get('SELECT MAX(signer_order) AS max FROM customer_approvals WHERE cr_id = ?', [crId])?.max || 0) + 1,
        contact_name: data.contact_name || cr.snapshot_customer_approver,
        contact_email: normaliseEmail(data.to),
        designation: cr.snapshot_customer_approver_designation,
        status: 'PENDING',
        sent_at: nowIso()
      };
      insert('customer_approvals', row);
      approval = row;
    } else {
      update('customer_approvals', approval.id, { sent_at: nowIso(), status: approval.status === 'REJECTED' ? 'PENDING' : approval.status });
    }

    const link = shareLinks.createLink({
      crId,
      audience: 'CUSTOMER',
      email: data.to,
      recipientName: approval.contact_name,
      actor
    });

    const attachments = [];
    if (data.attach_pdf !== 0) {
      const pdf = documents.latestFinal(crId, 'PDF');
      if (pdf) attachments.push(attachmentFor(pdf));
    }
    if (data.attach_docx !== 0) {
      const docx = documents.latestFinal(crId, 'DOCX');
      if (docx) attachments.push(attachmentFor(docx));
    }

    const variables = {
      customer_name: approval.contact_name || 'there',
      cr_number: cr.cr_number,
      cr_reference: cr.cr_reference,
      cr_title: cr.title,
      account_name: cr.account?.account_name,
      cr_cost: formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR'),
      target_release_date: cr.target_release_date || 'To be confirmed',
      portal_url: link.url,
      company_name: getSetting('company.name', 'Hyreo')
    };

    email.send({
      templateCode: 'CUSTOMER_APPROVAL_REQUEST',
      to: data.to,
      cc: ccList,
      crId,
      crReference: cr.cr_reference,
      subject: data.subject || undefined,
      bodyHtml: data.message ? composeMessageHtml(data.message, { ctaUrl: link.url, ctaLabel: 'Review & Sign Change Request' }) : undefined,
      variables,
      attachments,
      actor
    });

    changeRequests.applyTransition(changeRequests.findRaw(crId), 'share', {
      actor,
      patch: { shared_at: nowIso(), shared_by: actor?.id || null }
    });

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: crId,
      crId,
      action: ACTIONS.SHARED_WITH_CUSTOMER,
      actor,
      newValue: { to: data.to, cc: ccList, attachments: attachments.map((a) => a.filename) },
      ip: actor?.ip
    });

    notifications.notify({
      userIds: [cr.created_by].filter(Boolean),
      type: 'CR_SHARED',
      title: `${cr.cr_number} sent to customer`,
      body: `Sent to ${data.to}`,
      link: `/change-requests/${crId}`,
      crId
    });

    return { shared: true, to: data.to, cc: ccList, portal_url: link.url, attachments: attachments.map((a) => a.filename) };
  });
}

function attachmentFor(version) {
  const resolved = documents.resolveFile(version.id);
  return { filename: resolved.fileName, path: resolved.absolutePath, contentType: resolved.mime };
}

/** Default content for the share composer. */
export function shareDefaults(crId) {
  const cr = changeRequests.find(crId);
  const company = getSetting('company.name', 'Hyreo');
  return {
    to: cr.snapshot_customer_approver_email || cr.customer_contact_email || '',
    contact_name: cr.snapshot_customer_approver || cr.customer_contact_name || '',
    subject: `Change Request ${cr.cr_number} - Approval Required`,
    message:
      `Dear ${cr.snapshot_customer_approver || 'Sir/Madam'},\n\n` +
      `The Change Request document ${cr.cr_reference} for ${cr.title} is ready for your review and approval. ` +
      `The document is attached for your records, and can be reviewed and signed securely using the button below.\n\n` +
      `Regards,\n${company}`,
    documents: documents.listForChangeRequest(crId).filter((d) => ['FINAL', 'SIGNED'].includes(d.status))
  };
}

/* --------------------------------------------------------- portal access -- */

export function context(token, { ip = null, userAgent = null } = {}) {
  const link = shareLinks.registerClick(token, { ip, userAgent });
  const cr = changeRequests.findRaw(link.cr_id);
  const account = get('SELECT account_name, legal_entity_name FROM accounts WHERE id = ?', [cr.account_id]);
  email.markClicked(cr.id, link.email);

  return {
    audience: link.audience,
    masked_email: maskEmail(link.email),
    cr_number: cr.cr_number,
    cr_reference: cr.cr_reference,
    cr_title: cr.title,
    account_name: account?.account_name,
    company_name: getSetting('company.name', 'Hyreo'),
    status: cr.status,
    expires_at: link.expires_at,
    decided: link.audience === 'APPROVER'
      ? !get("SELECT 1 AS ok FROM change_request_approvals WHERE cr_id = ? AND status = 'PENDING' AND lower(approver_email) = lower(?)", [cr.id, link.email])
      : ['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED', 'CUSTOMER_REJECTED'].includes(cr.status)
  };
}

export function requestOtp(token, emailAddress, { ip = null } = {}) {
  const link = shareLinks.resolveToken(token);
  if (normaliseEmail(emailAddress) !== normaliseEmail(link.email)) {
    // do not reveal the bound address
    throw errors.forbidden('This email address does not match the address this change request was sent to');
  }
  const cr = changeRequests.findRaw(link.cr_id);
  const purpose = link.audience === 'CUSTOMER' ? 'CUSTOMER_PORTAL' : 'APPROVER_PORTAL';
  const { code, validity } = authService.issueOtp({ emailAddress: link.email, purpose, contextId: link.cr_id, ip });
  authService.logCaptureCode(link.email, code);

  email.send({
    templateCode: 'OTP_PORTAL',
    to: link.email,
    crId: cr.id,
    crReference: cr.cr_reference,
    variables: {
      otp_code: code,
      cr_number: cr.cr_number,
      account_name: get('SELECT account_name FROM accounts WHERE id = ?', [cr.account_id])?.account_name,
      validity_minutes: validity
    }
  });

  audit.record({
    entityType: 'PORTAL',
    entityId: link.id,
    crId: cr.id,
    action: ACTIONS.OTP_ISSUED,
    actor: { type: link.audience === 'CUSTOMER' ? 'CUSTOMER' : 'APPROVER', name: link.email },
    ip
  });

  return { sent: true, masked: maskEmail(link.email), validity_minutes: validity };
}

export function verifyOtp(token, emailAddress, code, { ip = null, userAgent = null } = {}) {
  const link = shareLinks.resolveToken(token);
  if (normaliseEmail(emailAddress) !== normaliseEmail(link.email)) throw errors.otpInvalid('That code is not correct.');

  const purpose = link.audience === 'CUSTOMER' ? 'CUSTOMER_PORTAL' : 'APPROVER_PORTAL';
  const challenge = authService.verifyOtp({ emailAddress: link.email, purpose, contextId: link.cr_id, code });

  const portalToken = randomToken(32);
  insert('portal_sessions', {
    id: uid('PSN'),
    share_link_id: link.id,
    cr_id: link.cr_id,
    email: link.email,
    audience: link.audience,
    token_hash: hashToken(portalToken),
    created_at: nowIso(),
    expires_at: addHours(PORTAL_SESSION_HOURS),
    ip,
    user_agent: userAgent
  });

  audit.record({
    entityType: 'PORTAL',
    entityId: link.id,
    crId: link.cr_id,
    action: 'PORTAL_VERIFIED',
    actor: { type: link.audience === 'CUSTOMER' ? 'CUSTOMER' : 'APPROVER', name: link.email },
    comments: challenge?.via_master ? 'Verified with the demo master code' : null,
    ip,
    userAgent
  });

  return { token: portalToken, audience: link.audience, cr_id: link.cr_id };
}

export function resolveSession(portalToken, shareToken = null) {
  if (!portalToken) throw errors.authRequired('Please verify your email address to continue');
  const session = get('SELECT * FROM portal_sessions WHERE token_hash = ? AND revoked_at IS NULL', [hashToken(portalToken)]);
  if (!session || isPast(session.expires_at)) throw errors.authRequired('Your verification has expired. Please request a new code.');

  if (shareToken) {
    const link = shareLinks.resolveToken(shareToken);
    if (link.id !== session.share_link_id) throw errors.forbidden('This verification does not match the link you opened');
  }
  return session;
}

/** Read-only projection of the CR for an external actor. */
export function viewChangeRequest(session, { ip = null } = {}) {
  const cr = changeRequests.find(session.cr_id);

  if (session.audience === 'CUSTOMER') {
    markCustomerViewed(session, ip);
  }

  const refreshed = changeRequests.find(session.cr_id);
  return {
    audience: session.audience,
    cr: project(refreshed, session.audience),
    document_html: documents.previewHtml(session.cr_id),
    documents: documents
      .listForChangeRequest(session.cr_id)
      .filter((d) => ['FINAL', 'SIGNED'].includes(d.status) || session.audience === 'APPROVER')
      .map((d) => ({ id: d.id, version: d.version, format: d.format, status: d.status, generated_at: d.generated_at, file_size: d.file_size })),
    decision: currentDecision(refreshed, session)
  };
}

function currentDecision(cr, session) {
  if (session.audience === 'APPROVER') {
    const approval = get(
      'SELECT * FROM change_request_approvals WHERE cr_id = ? AND lower(approver_email) = lower(?) ORDER BY level DESC LIMIT 1',
      [cr.id, session.email]
    );
    return approval
      ? { type: 'APPROVER', status: approval.status, comments: approval.comments, decided_at: approval.decided_at, can_decide: approval.status === 'PENDING' && cr.status === 'PENDING_INTERNAL_APPROVAL' }
      : { type: 'APPROVER', status: 'NONE', can_decide: false };
  }
  const approval = get('SELECT * FROM customer_approvals WHERE cr_id = ? AND lower(contact_email) = lower(?) LIMIT 1', [cr.id, session.email]);
  return approval
    ? {
        type: 'CUSTOMER',
        status: approval.status,
        comments: approval.comments,
        decided_at: approval.decided_at,
        signature_name: approval.signature_name,
        can_decide: ['PENDING', 'VIEWED'].includes(approval.status) && !['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED', 'CANCELLED'].includes(cr.status)
      }
    : { type: 'CUSTOMER', status: 'NONE', can_decide: false };
}

function project(cr, audience) {
  const base = {
    id: cr.id,
    cr_number: cr.cr_number,
    cr_reference: cr.cr_reference,
    title: cr.title,
    cr_date: cr.cr_date,
    status: cr.status,
    status_label: cr.status_label,
    priority: cr.priority,
    cr_type: cr.cr_type,
    description: cr.description,
    account_name: cr.account?.account_name,
    legal_entity: cr.snapshot_legal_entity,
    msa_number: cr.snapshot_msa_number,
    msa_date: cr.snapshot_msa_date,
    contract_start_date: cr.snapshot_contract_start,
    contract_end_date: cr.snapshot_contract_end,
    items: cr.items,
    efforts: cr.efforts,
    total_effort: cr.total_effort,
    costs: cr.costs,
    assumptions: cr.assumptions,
    dependencies: cr.dependencies,
    target_release_date: cr.target_release_date,
    estimated_timeline: cr.estimated_timeline,
    estimated_business_days: cr.estimated_business_days,
    payment_terms: cr.payment_terms,
    po_required: cr.po_required,
    po_number: cr.po_number,
    invoice_terms: cr.invoice_terms,
    general_terms: cr.general_terms,
    customer_approver: cr.snapshot_customer_approver,
    customer_approver_designation: cr.snapshot_customer_approver_designation
  };
  if (audience === 'APPROVER') {
    base.internal_approver = cr.snapshot_internal_approver;
    base.account_manager = cr.snapshot_account_manager;
    base.cr_manager = cr.snapshot_cr_manager;
    base.approvals = cr.approvals?.map((a) => ({ level: a.level, level_name: a.level_name, approver_name: a.approver_name, status: a.status, decided_at: a.decided_at, comments: a.comments }));
  }
  return base;
}

function markCustomerViewed(session, ip) {
  const cr = changeRequests.findRaw(session.cr_id);
  const approval = get('SELECT * FROM customer_approvals WHERE cr_id = ? AND lower(contact_email) = lower(?)', [session.cr_id, session.email]);
  if (approval && !approval.viewed_at) {
    update('customer_approvals', approval.id, { viewed_at: nowIso(), status: approval.status === 'PENDING' ? 'VIEWED' : approval.status, ip_address: ip });
  }
  if (cr.customer_viewed_at) return;

  transaction(() => {
    if (cr.status === 'SENT_TO_CUSTOMER') {
      changeRequests.applyTransition(cr, 'customer_view', {
        actor: { type: 'CUSTOMER', name: session.email, ip },
        patch: { customer_viewed_at: nowIso() }
      });
      changeRequests.applyTransition(changeRequests.findRaw(session.cr_id), 'await_customer', {
        actor: { type: 'SYSTEM', name: 'System' }
      });
    } else {
      update('change_requests', cr.id, { customer_viewed_at: nowIso() });
    }
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: cr.id,
      crId: cr.id,
      action: ACTIONS.CUSTOMER_VIEWED,
      actor: { type: 'CUSTOMER', name: session.email },
      ip
    });
  });

  const detail = changeRequests.find(session.cr_id);
  const managerId = detail.created_by;
  email.send({
    templateCode: 'CUSTOMER_VIEWED_NOTICE',
    to: get('SELECT email FROM users WHERE id = ?', [managerId])?.email || getSetting('company.email'),
    crId: cr.id,
    crReference: cr.cr_reference,
    variables: {
      manager_name: get('SELECT name FROM users WHERE id = ?', [managerId])?.name || 'there',
      cr_number: cr.cr_number,
      account_name: detail.account?.account_name,
      customer_email: session.email,
      viewed_at: formatDateTime(nowIso()),
      cr_url: `${config.appUrl}/change-requests/${cr.id}`
    }
  });
  notifications.notify({
    userIds: [managerId].filter(Boolean),
    type: 'CUSTOMER_VIEWED',
    title: `Customer viewed ${cr.cr_number}`,
    body: session.email,
    link: `/change-requests/${cr.id}`,
    crId: cr.id
  });
}

/* ------------------------------------------------------------ decisions -- */

export function approverDecision(session, { decision, comments }, { ip = null } = {}) {
  if (session.audience !== 'APPROVER') throw errors.forbidden('This link is not an approval link');
  return approvals.decide(session.cr_id, {
    decision,
    comments,
    approverEmail: session.email,
    actor: { type: 'APPROVER', name: session.email, email: session.email, ip },
    via: 'PORTAL',
    ip
  });
}

export function customerSign(session, payload, { ip = null, userAgent = null } = {}) {
  if (session.audience !== 'CUSTOMER') throw errors.forbidden('This link is not a customer signature link');

  const data = validate(payload || {}, {
    signature_name: { type: 'string', required: true, label: 'Full name', maxLength: 120, minLength: 2 },
    designation: { type: 'string', label: 'Designation', maxLength: 120 },
    consent: { type: 'boolean', label: 'Consent', required: true },
    comments: { type: 'text', label: 'Comments', maxLength: 2000 }
  });
  if (!data.consent) throw errors.validation('Please confirm that you agree to sign this change request electronically');

  const cr = changeRequests.findRaw(session.cr_id);
  if (['CUSTOMER_APPROVED', 'SIGNED', 'COMPLETED'].includes(cr.status)) {
    throw errors.invalidState('This change request has already been signed');
  }
  if (!['SENT_TO_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_APPROVAL_PENDING'].includes(cr.status)) {
    throw errors.invalidState('This change request is not awaiting customer approval');
  }

  const signedAt = nowIso();
  const approval = get('SELECT * FROM customer_approvals WHERE cr_id = ? AND lower(contact_email) = lower(?)', [session.cr_id, session.email]);

  transaction(() => {
    if (approval) {
      update('customer_approvals', approval.id, {
        status: 'APPROVED',
        decided_at: signedAt,
        comments: data.comments || null,
        signature_name: data.signature_name,
        signature_method: 'PORTAL',
        signed_at: signedAt,
        ip_address: ip,
        user_agent: userAgent,
        designation: data.designation || approval.designation
      });
    }

    changeRequests.applyTransition(cr, 'customer_approve', {
      actor: { type: 'CUSTOMER', name: data.signature_name, email: session.email, ip },
      comments: data.comments,
      patch: { customer_decided_at: signedAt }
    });

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: cr.id,
      crId: cr.id,
      action: ACTIONS.CUSTOMER_APPROVED,
      actor: { type: 'CUSTOMER', name: data.signature_name, email: session.email },
      comments: data.comments,
      ip,
      userAgent
    });
  });

  // signature + completion
  const signedPdf = documents.renderSignedPdf(session.cr_id, {
    signer_name: data.signature_name,
    signer_email: session.email,
    signature_name: data.signature_name,
    signed_at: signedAt,
    ip_address: ip,
    method: 'Portal (email OTP verified)'
  });
  documents.storeSignedDocument(session.cr_id, signedPdf, { source: 'PORTAL' });

  transaction(() => {
    changeRequests.applyTransition(changeRequests.findRaw(session.cr_id), 'sign', {
      actor: { type: 'CUSTOMER', name: data.signature_name, email: session.email },
      patch: { signed_at: signedAt }
    });
    changeRequests.applyTransition(changeRequests.findRaw(session.cr_id), 'complete', {
      actor: { type: 'SYSTEM', name: 'System' },
      patch: { completed_at: nowIso() }
    });
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: cr.id,
      crId: cr.id,
      action: ACTIONS.CUSTOMER_SIGNED,
      actor: { type: 'CUSTOMER', name: data.signature_name, email: session.email },
      newValue: { signature_name: data.signature_name, signed_at: signedAt },
      ip
    });
  });

  // the "sent to customer" and "customer viewed" prompts are now answered
  notifications.resolve({ crId: cr.id, types: ['CR_SHARED', 'CUSTOMER_VIEWED'] });
  notifySigned(session.cr_id, data.signature_name, session.email, signedAt);
  return { signed: true, signed_at: signedAt };
}

export function customerReject(session, payload, { ip = null } = {}) {
  if (session.audience !== 'CUSTOMER') throw errors.forbidden('This link is not a customer link');
  const data = validate(payload || {}, {
    comments: { type: 'text', required: true, label: 'Reason', minLength: 5, maxLength: 4000 }
  });

  const cr = changeRequests.findRaw(session.cr_id);
  const approval = get('SELECT * FROM customer_approvals WHERE cr_id = ? AND lower(contact_email) = lower(?)', [session.cr_id, session.email]);

  transaction(() => {
    if (approval) {
      update('customer_approvals', approval.id, {
        status: 'REJECTED',
        decided_at: nowIso(),
        comments: data.comments,
        ip_address: ip
      });
    }
    changeRequests.applyTransition(cr, 'customer_reject', {
      actor: { type: 'CUSTOMER', name: session.email, ip },
      comments: data.comments,
      patch: { customer_decided_at: nowIso(), customer_rejection_comments: data.comments }
    });
    changeRequests.applyTransition(changeRequests.findRaw(session.cr_id), 'revise', {
      actor: { type: 'SYSTEM', name: 'System' },
      patch: { revision: (cr.revision || 0) + 1, current_owner_user_id: cr.created_by }
    });
    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: cr.id,
      crId: cr.id,
      action: ACTIONS.CUSTOMER_REJECTED,
      actor: { type: 'CUSTOMER', name: session.email },
      comments: data.comments,
      ip
    });
  });

  const detail = changeRequests.find(session.cr_id);
  const managerId = detail.created_by;
  email.send({
    templateCode: 'CUSTOMER_REJECTED',
    to: get('SELECT email FROM users WHERE id = ?', [managerId])?.email || getSetting('company.email'),
    crId: cr.id,
    crReference: cr.cr_reference,
    variables: {
      manager_name: get('SELECT name FROM users WHERE id = ?', [managerId])?.name || 'there',
      cr_number: cr.cr_number,
      account_name: detail.account?.account_name,
      rejected_by: session.email,
      rejection_comments: data.comments,
      cr_url: `${config.appUrl}/change-requests/${cr.id}`
    }
  });
  notifications.notify({
    userIds: [managerId].filter(Boolean),
    type: 'CUSTOMER_REJECTED',
    title: `${cr.cr_number} rejected by customer`,
    body: data.comments.slice(0, 160),
    link: `/change-requests/${cr.id}`,
    crId: cr.id,
    severity: 'WARNING'
  });

  notifications.resolve({ crId: cr.id, types: ['CR_SHARED', 'CUSTOMER_VIEWED'] });
  chat.post({
    title: `Customer rejected: ${cr.cr_number} · ${detail.account?.account_name}`,
    text: `${cr.title}
${session.email}: ${data.comments.slice(0, 300)}`,
    link: `/change-requests/${cr.id}`
  });
  return { rejected: true };
}

export function notifySigned(crId, signerName, signerEmail, signedAt) {
  const cr = changeRequests.find(crId);
  const managerId = cr.created_by;
  email.send({
    templateCode: 'CUSTOMER_APPROVED',
    to: get('SELECT email FROM users WHERE id = ?', [managerId])?.email || getSetting('company.email'),
    crId,
    crReference: cr.cr_reference,
    variables: {
      manager_name: get('SELECT name FROM users WHERE id = ?', [managerId])?.name || 'there',
      cr_number: cr.cr_number,
      account_name: cr.account?.account_name,
      signed_by: signerEmail,
      signature_name: signerName,
      signed_at: formatDateTime(signedAt),
      cr_url: `${config.appUrl}/change-requests/${crId}`
    }
  });
  notifications.notify({
    userIds: [managerId].filter(Boolean),
    roles: ['ADMIN'],
    type: 'CUSTOMER_SIGNED',
    title: `${cr.cr_number} signed`,
    body: `${signerName} signed on behalf of ${cr.account?.account_name}`,
    link: `/change-requests/${crId}`,
    crId,
    severity: 'SUCCESS'
  });
  chat.post({
    title: `Signed by the customer: ${cr.cr_number} · ${cr.account?.account_name}`,
    text: `${cr.title}
Signed by ${signerName} (${signerEmail}) · ${formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR')}`,
    link: `/change-requests/${crId}`
  });
}

export function portalDocument(session, versionId) {
  const version = documents.getVersion(versionId);
  if (version.cr_id !== session.cr_id) throw errors.forbidden('This document does not belong to the change request you opened');
  if (session.audience === 'CUSTOMER' && !['FINAL', 'SIGNED'].includes(version.status)) {
    throw errors.forbidden('Only the final change request document is available');
  }
  audit.record({
    entityType: 'DOCUMENT',
    entityId: version.document_id,
    crId: session.cr_id,
    action: ACTIONS.DOCUMENT_DOWNLOADED,
    actor: { type: session.audience === 'CUSTOMER' ? 'CUSTOMER' : 'APPROVER', name: session.email }
  });
  return documents.resolveFile(versionId);
}

export function activeLinks(crId) {
  return all(
    `SELECT id, audience, email, expires_at, revoked_at, click_count, first_clicked_at, last_clicked_at, created_at
       FROM share_links WHERE cr_id = ? ORDER BY created_at DESC`,
    [crId]
  );
}

export default {
  shareWithCustomer,
  shareDefaults,
  context,
  requestOtp,
  verifyOtp,
  resolveSession,
  viewChangeRequest,
  approverDecision,
  customerSign,
  customerReject,
  portalDocument,
  activeLinks
};
