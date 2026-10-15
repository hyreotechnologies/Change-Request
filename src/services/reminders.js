import { all, get, insert } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';
import { errors } from '../lib/errors.js';
import changeRequests from './changeRequests.js';
import shareLinks from './shareLinks.js';
import email from './email.js';
import notifications from './notifications.js';
import chat from './chat.js';
import audit, { ACTIONS } from './audit.js';
import stateMachine from './stateMachine.js';
import { getSetting } from './settings.js';
import config from '../config.js';

/**
 * Chases whoever is holding up a change request.
 *  - an internal approver who has not decided gets a reminder, repeated on a cadence
 *  - a customer signatory who has not responded gets the same treatment
 *  - once either has waited past the escalation threshold, the CR owner and the
 *    escalation contact are told, once per request
 * Every send is recorded in workflow_reminders so the scheduler is idempotent.
 */

const DAY_MS = 86_400_000;
const MANUAL_COOLDOWN_MINUTES = 60;

const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / DAY_MS : 0);

function lastSent(targetType, targetId, kind) {
  return get(
    'SELECT MAX(sent_at) AS at FROM workflow_reminders WHERE target_type = ? AND target_id = ? AND kind = ?',
    [targetType, targetId, kind]
  )?.at || null;
}

function countSent(targetType, targetId, kind) {
  return get('SELECT COUNT(*) AS count FROM workflow_reminders WHERE target_type = ? AND target_id = ? AND kind = ?', [
    targetType,
    targetId,
    kind
  ])?.count || 0;
}

function record({ crId, targetType, targetId, kind, recipient, trigger, actor }) {
  insert('workflow_reminders', {
    id: uid('RMD'),
    cr_id: crId,
    target_type: targetType,
    target_id: targetId,
    kind,
    recipient,
    trigger_type: trigger,
    sent_by: actor?.id || null,
    sent_at: nowIso()
  });
  audit.record({
    entityType: 'CHANGE_REQUEST',
    entityId: crId,
    crId,
    action: kind === 'ESCALATION' ? ACTIONS.ESCALATION_SENT : ACTIONS.REMINDER_SENT,
    actor: actor || { type: 'SYSTEM', name: 'System' },
    newValue: { to: recipient, target: targetType, trigger }
  });
}

/* ------------------------------------------------------------ targets -- */

/** Approvals at the level that is currently being decided. */
function pendingApprovals(crId = null) {
  return all(
    `SELECT ap.*, cr.cr_number FROM change_request_approvals ap
       JOIN change_requests cr ON cr.id = ap.cr_id
      WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL'
        AND ap.level = (SELECT MIN(level) FROM change_request_approvals x WHERE x.cr_id = cr.id AND x.status = 'PENDING')
        ${crId ? 'AND cr.id = ?' : ''}`,
    crId ? [crId] : []
  );
}

function pendingCustomers(crId = null) {
  const statuses = stateMachine.STATUS_GROUPS.PENDING_CUSTOMER;
  return all(
    `SELECT ca.*, cr.cr_number, cr.shared_at FROM customer_approvals ca
       JOIN change_requests cr ON cr.id = ca.cr_id
      WHERE ca.status IN ('PENDING','VIEWED')
        AND cr.status IN (${statuses.map(() => '?').join(', ')})
        ${crId ? 'AND cr.id = ?' : ''}`,
    crId ? [...statuses, crId] : statuses
  );
}

/* -------------------------------------------------------------- sends -- */

function remindApprover(approval, { trigger = 'AUTO', actor = null } = {}) {
  const cr = changeRequests.find(approval.cr_id);
  const waited = Math.max(1, Math.floor(daysSince(approval.requested_at)));
  const link = shareLinks.createLink({
    crId: cr.id,
    audience: 'APPROVER',
    email: approval.approver_email,
    recipientName: approval.approver_name,
    approvalId: approval.id,
    actor
  });

  email.send({
    templateCode: 'APPROVAL_REMINDER',
    to: approval.approver_email,
    crId: cr.id,
    crReference: cr.cr_reference,
    variables: {
      approver_name: approval.approver_name || 'there',
      cr_number: cr.cr_number,
      account_name: cr.account?.account_name,
      cr_title: cr.title,
      cr_cost: formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR'),
      waiting_days: waited,
      review_url: link.url
    },
    actor
  });

  // same type as the original request, so it clears itself once a decision is made
  notifications.notify({
    emails: [approval.approver_email],
    type: 'CR_APPROVAL_REQUESTED',
    title: `Reminder: ${cr.cr_number} is waiting for your approval`,
    body: `${cr.account?.account_name} — waiting ${waited} day(s)`,
    link: `/change-requests/${cr.id}`,
    crId: cr.id,
    severity: 'ACTION'
  });

  record({ crId: cr.id, targetType: 'APPROVAL', targetId: approval.id, kind: 'REMINDER', recipient: approval.approver_email, trigger, actor });
  return approval.approver_email;
}

function remindCustomer(signatory, { trigger = 'AUTO', actor = null } = {}) {
  const cr = changeRequests.find(signatory.cr_id);
  const waited = Math.max(1, Math.floor(daysSince(signatory.sent_at || cr.shared_at)));
  const link = shareLinks.createLink({
    crId: cr.id,
    audience: 'CUSTOMER',
    email: signatory.contact_email,
    recipientName: signatory.contact_name,
    actor
  });

  email.send({
    templateCode: 'CUSTOMER_REMINDER',
    to: signatory.contact_email,
    crId: cr.id,
    crReference: cr.cr_reference,
    variables: {
      customer_name: signatory.contact_name || 'Sir/Madam',
      cr_number: cr.cr_number,
      cr_reference: cr.cr_reference,
      cr_title: cr.title,
      cr_cost: formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR'),
      waiting_days: waited,
      portal_url: link.url,
      company_name: getSetting('company.name', 'Hyreo')
    },
    actor
  });

  record({ crId: cr.id, targetType: 'CUSTOMER', targetId: signatory.id, kind: 'REMINDER', recipient: signatory.contact_email, trigger, actor });
  return signatory.contact_email;
}

function escalate({ crId, targetType, targetId, waitingOn, waitedDays }) {
  const cr = changeRequests.find(crId);
  const owner = cr.created_by ? get('SELECT id, name, email FROM users WHERE id = ? AND is_active = 1', [cr.created_by]) : null;
  const contact = String(getSetting('reminders.escalation_email', '') || '').trim().toLowerCase();
  const admins = contact ? [] : all("SELECT id, name, email FROM users WHERE role_code = 'ADMIN' AND is_active = 1");

  const recipients = new Map();
  if (owner?.email) recipients.set(owner.email.toLowerCase(), owner.name);
  if (contact) recipients.set(contact, get('SELECT name FROM users WHERE lower(email) = ?', [contact])?.name || 'there');
  for (const admin of admins) recipients.set(admin.email.toLowerCase(), admin.name);

  const stage = targetType === 'APPROVAL' ? 'Internal approval' : 'Customer approval';
  const reminders = countSent(targetType, targetId, 'REMINDER');

  for (const [address, name] of recipients) {
    email.send({
      templateCode: 'ESCALATION_NOTICE',
      to: address,
      crId,
      crReference: cr.cr_reference,
      variables: {
        recipient_name: name || 'there',
        cr_number: cr.cr_number,
        account_name: cr.account?.account_name,
        cr_title: cr.title,
        stage,
        waiting_on: waitingOn,
        waiting_days: waitedDays,
        reminders_sent: reminders,
        cr_url: `${config.appUrl}/change-requests/${crId}`
      }
    });
  }

  notifications.notify({
    userIds: [owner?.id, ...admins.map((a) => a.id)].filter(Boolean),
    emails: contact ? [contact] : [],
    type: 'CR_ESCALATED',
    title: `Escalation: ${cr.cr_number} stuck for ${waitedDays} days`,
    body: `${stage} — waiting on ${waitingOn}`,
    link: `/change-requests/${crId}`,
    crId,
    severity: 'WARNING'
  });

  chat.post({
    title: `Escalation: ${cr.cr_number} stuck for ${waitedDays} days · ${cr.account?.account_name}`,
    text: `${cr.title}\n${stage} — waiting on ${waitingOn}. ${reminders} reminder(s) already sent.`,
    link: `/change-requests/${crId}`
  });

  record({ crId, targetType, targetId, kind: 'ESCALATION', recipient: [...recipients.keys()].join(', '), trigger: 'AUTO', actor: null });
}

/* ---------------------------------------------------------- scheduler -- */

/** One pass of the scheduler. Safe to run as often as you like. */
export function runDue() {
  const summary = { reminders: 0, escalations: 0, errors: 0 };
  if (!getSetting('reminders.enabled', true)) return { ...summary, skipped: 'disabled' };

  const approvalAfter = Number(getSetting('reminders.approval_after_days', 2)) || 0;
  const customerAfter = Number(getSetting('reminders.customer_after_days', 3)) || 0;
  const repeat = Math.max(1, Number(getSetting('reminders.repeat_days', 2)) || 1);
  const escalateAfter = Number(getSetting('reminders.escalate_after_days', 5)) || 0;

  const consider = (targetType, row, waitedFrom, threshold, send, waitingOn) => {
    try {
      const waited = daysSince(waitedFrom);
      const last = lastSent(targetType, row.id, 'REMINDER');
      if (threshold > 0 && waited >= threshold && (!last || daysSince(last) >= repeat)) {
        send(row);
        summary.reminders += 1;
      }
      if (escalateAfter > 0 && waited >= escalateAfter && !lastSent(targetType, row.id, 'ESCALATION')) {
        escalate({ crId: row.cr_id, targetType, targetId: row.id, waitingOn, waitedDays: Math.floor(waited) });
        summary.escalations += 1;
      }
    } catch (error) {
      summary.errors += 1;
      console.warn(`[hcrms] reminder for ${row.cr_number} failed: ${error?.message || error}`);
    }
  };

  for (const approval of pendingApprovals()) {
    consider('APPROVAL', approval, approval.requested_at, approvalAfter, (row) => remindApprover(row), approval.approver_name || approval.approver_email);
  }
  for (const signatory of pendingCustomers()) {
    consider('CUSTOMER', signatory, signatory.sent_at || signatory.shared_at, customerAfter, (row) => remindCustomer(row), signatory.contact_name || signatory.contact_email);
  }
  return summary;
}

/* ------------------------------------------------------- manual nudge -- */

/** "Send reminder now" for one change request: chases whoever it is waiting on. */
export function remindNow(crId, actor) {
  const cr = changeRequests.findRaw(crId);
  const approvalsDue = pendingApprovals(cr.id);
  const customersDue = pendingCustomers(cr.id);
  if (!approvalsDue.length && !customersDue.length) {
    throw errors.invalidState(`${cr.cr_number} is not waiting on an approver or the customer (status: ${stateMachine.label(cr.status)})`);
  }

  const recent = get(
    `SELECT MAX(sent_at) AS at FROM workflow_reminders WHERE cr_id = ? AND kind = 'REMINDER'`,
    [cr.id]
  )?.at;
  if (recent && Date.now() - new Date(recent).getTime() < MANUAL_COOLDOWN_MINUTES * 60_000) {
    const minutes = Math.ceil((Date.now() - new Date(recent).getTime()) / 60_000);
    throw errors.invalidState(`A reminder for ${cr.cr_number} went out ${minutes} minute(s) ago. Try again later.`);
  }

  const recipients = [
    ...approvalsDue.map((row) => remindApprover(row, { trigger: 'MANUAL', actor })),
    ...customersDue.map((row) => remindCustomer(row, { trigger: 'MANUAL', actor }))
  ];
  return { id: cr.id, cr_number: cr.cr_number, recipients };
}

/** Reminder history for one change request, newest first. */
export function historyFor(crId) {
  return all(
    `SELECT r.*, u.name AS sent_by_name FROM workflow_reminders r
       LEFT JOIN users u ON u.id = r.sent_by
      WHERE r.cr_id = ? ORDER BY r.sent_at DESC`,
    [crId]
  );
}

export default { runDue, remindNow, historyFor };
