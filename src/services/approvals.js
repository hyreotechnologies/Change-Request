import { all, get, insert, run, transaction, update } from '../db/index.js';
import { uid } from '../lib/ids.js';
import { nowIso, formatDateTime, daysBetween } from '../lib/dates.js';
import { formatMoney } from '../lib/money.js';
import { errors } from '../lib/errors.js';
import { normaliseEmail } from '../lib/validate.js';
import changeRequests from './changeRequests.js';
import documents from './documents.js';
import shareLinks from './shareLinks.js';
import email from './email.js';
import notifications from './notifications.js';
import chat from './chat.js';
import audit, { ACTIONS } from './audit.js';
import { getSetting } from './settings.js';
import config from '../config.js';

/* ------------------------------------------------------- approval ladder -- */

export function levelsForAccount(accountId) {
  const accountLevels = all(
    'SELECT * FROM cr_approval_levels WHERE account_id = ? AND is_active = 1 ORDER BY level',
    [accountId]
  );
  if (accountLevels.length) return accountLevels;
  return all('SELECT * FROM cr_approval_levels WHERE account_id IS NULL AND is_active = 1 ORDER BY level');
}

export function listLevels() {
  return all(
    `SELECT l.*, a.account_name FROM cr_approval_levels l
       LEFT JOIN accounts a ON a.id = l.account_id
      ORDER BY (l.account_id IS NOT NULL), a.account_name, l.level`
  );
}

export function saveLevels(levels, actor) {
  const cleaned = (Array.isArray(levels) ? levels : []).map((level, index) => ({
    id: level.id || uid('LVL'),
    account_id: level.account_id || null,
    level: Number(level.level) || index + 1,
    name: String(level.name || `Level ${index + 1}`).slice(0, 80),
    approver_name: level.approver_name || null,
    approver_email: level.approver_email ? normaliseEmail(level.approver_email) : null,
    is_active: level.is_active === false ? 0 : 1,
    created_at: nowIso()
  }));

  transaction(() => {
    run('DELETE FROM cr_approval_levels');
    for (const level of cleaned) insert('cr_approval_levels', level);
  });
  audit.record({ entityType: 'SETTINGS', entityId: 'approval_levels', action: ACTIONS.SETTINGS_UPDATED, actor, newValue: cleaned });
  return listLevels();
}

/* -------------------------------------------------------------- submit -- */

export function submit(crId, actor) {
  const { ok, problems, cr } = changeRequests.assertReadyForSubmission(crId);
  if (!ok) throw errors.validation('This change request is not ready to be submitted', problems.map((p) => ({ field: 'general', message: p })));
  if (!['DRAFT', 'REVISION'].includes(cr.status)) {
    throw errors.invalidState('Only a draft or revised change request can be submitted for approval');
  }

  const detail = changeRequests.find(crId);
  const configured = levelsForAccount(cr.account_id);
  const ladder = configured.length
    ? configured
    : [
        {
          level: 1,
          name: 'Internal Approval',
          approver_name: cr.snapshot_internal_approver,
          approver_email: cr.snapshot_internal_approver_email
        }
      ];

  const missing = ladder.filter((level) => !level.approver_email);
  if (missing.length) throw errors.invalidState('An internal approver email is not configured for this account');

  const result = transaction(() => {
    // fresh approval rows for this revision
    run("UPDATE change_request_approvals SET status = 'SKIPPED' WHERE cr_id = ? AND status = 'PENDING'", [crId]);

    for (const level of ladder) {
      insert('change_request_approvals', {
        id: uid('APR'),
        cr_id: crId,
        level: level.level,
        level_name: level.name,
        approver_name: level.approver_name,
        approver_email: normaliseEmail(level.approver_email),
        status: 'PENDING',
        requested_at: nowIso(),
        revision: cr.revision || 0
      });
    }

    const updated = changeRequests.applyTransition(cr, 'submit', {
      actor,
      patch: {
        submitted_at: nowIso(),
        submitted_by: actor?.id || null,
        internal_rejected_at: null,
        internal_rejection_comments: null,
        current_owner_user_id: resolveUserId(ladder[0].approver_email) || cr.current_owner_user_id
      }
    });

    // what the approver is asked to review, kept for the next revision's comparison
    changeRequests.takeSnapshot(crId, actor);

    audit.record({
      entityType: 'CHANGE_REQUEST',
      entityId: crId,
      crId,
      action: ACTIONS.CR_SUBMITTED,
      actor,
      newValue: { levels: ladder.length, approvers: ladder.map((l) => l.approver_email) },
      ip: actor?.ip
    });

    return updated;
  });

  // Always produce a fresh draft document: on a resubmission after rejection the
  // previous version reflects the pre-edit content, and the approver must review
  // exactly what was submitted.
  documents.generate(crId, {
    format: getSetting('defaults.document_format', 'PDF'),
    final: false,
    actor,
    notes: cr.revision > 0
      ? `Generated on resubmission for approval (revision ${cr.revision})`
      : 'Generated on submission for approval'
  });

  notifyLevel(crId, ladder[0].level, actor);
  return changeRequests.find(crId, { actor });
}

function resolveUserId(emailAddress) {
  if (!emailAddress) return null;
  return get('SELECT id FROM users WHERE lower(email) = ? AND is_active = 1', [normaliseEmail(emailAddress)])?.id || null;
}

/** Email + notify every pending approver at a given level. */
export function notifyLevel(crId, level, actor = null) {
  const cr = changeRequests.find(crId);
  const pending = all(
    "SELECT * FROM change_request_approvals WHERE cr_id = ? AND level = ? AND status = 'PENDING'",
    [crId, level]
  );

  // a new request replaces any earlier one for this change request
  notifications.resolve({ crId, types: ['CR_APPROVAL_REQUESTED'] });

  for (const approval of pending) {
    const link = shareLinks.createLink({
      crId,
      audience: 'APPROVER',
      email: approval.approver_email,
      recipientName: approval.approver_name,
      approvalId: approval.id,
      actor
    });

    email.send({
      templateCode: 'INTERNAL_APPROVAL_REQUEST',
      to: approval.approver_email,
      cc: [cr.snapshot_cr_manager && resolveEmail(cr.created_by)].filter(Boolean),
      crId,
      crReference: cr.cr_reference,
      variables: {
        approver_name: approval.approver_name || 'there',
        cr_number: cr.cr_number,
        cr_reference: cr.cr_reference,
        account_name: cr.account?.account_name,
        msa_number: cr.snapshot_msa_number,
        cr_title: cr.title,
        cr_cost: formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR'),
        total_effort: cr.total_effort,
        target_release_date: cr.target_release_date || 'To be confirmed',
        submitted_by: actor?.name || cr.snapshot_cr_manager || '',
        review_url: link.url
      },
      actor
    });

    notifications.notify({
      emails: [approval.approver_email],
      type: 'CR_APPROVAL_REQUESTED',
      title: `Approval required: ${cr.cr_number}`,
      body: `${cr.account?.account_name} — ${cr.title}`,
      link: `/change-requests/${crId}`,
      crId,
      severity: 'ACTION'
    });
  }

  if (pending.length) {
    chat.post({
      title: `Approval required: ${cr.cr_number} · ${cr.account?.account_name}`,
      text: `${cr.title}
Waiting on ${pending.map((a) => a.approver_name || a.approver_email).join(', ')} · ${formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR')}`,
      link: `/change-requests/${crId}`
    });
  }
  return pending.length;
}

function resolveEmail(userId) {
  if (!userId) return null;
  return get('SELECT email FROM users WHERE id = ?', [userId])?.email || null;
}

/* ------------------------------------------------------------- decision -- */

/**
 * Record an approval decision. Used by both the in-app approver screen and the
 * external OTP portal, so the rules live in exactly one place.
 */
export function decide(crId, { decision, comments = null, approverEmail, actor = null, via = 'APP', ip = null }) {
  const cr = changeRequests.findRaw(crId);
  if (cr.status !== 'PENDING_INTERNAL_APPROVAL') {
    throw errors.invalidState(`This change request is not awaiting internal approval (current status: ${cr.status})`);
  }
  if (decision === 'REJECT' && String(comments || '').trim().length < 5) {
    throw errors.validation('Please provide the reason for rejection', [
      { field: 'comments', message: 'A rejection reason of at least 5 characters is required' }
    ]);
  }

  const address = normaliseEmail(approverEmail);
  const currentLevel = get(
    "SELECT MIN(level) AS level FROM change_request_approvals WHERE cr_id = ? AND status = 'PENDING'",
    [crId]
  )?.level;
  if (currentLevel === null || currentLevel === undefined) {
    throw errors.invalidState('There is no pending approval for this change request');
  }

  const approval = get(
    "SELECT * FROM change_request_approvals WHERE cr_id = ? AND level = ? AND status = 'PENDING' AND lower(approver_email) = ?",
    [crId, currentLevel, address]
  );
  if (!approval) {
    throw errors.forbidden('You are not the approver for the current approval level of this change request');
  }

  const decisionActor = actor || { type: 'APPROVER', name: approval.approver_name || address, email: address, ip };

  if (decision === 'REJECT') {
    return transaction(() => {
      update('change_request_approvals', approval.id, {
        status: 'REJECTED',
        decided_at: nowIso(),
        comments: String(comments).trim(),
        decided_via: via,
        ip_address: ip
      });
      run("UPDATE change_request_approvals SET status = 'SKIPPED' WHERE cr_id = ? AND status = 'PENDING'", [crId]);

      changeRequests.applyTransition(cr, 'reject', {
        actor: decisionActor,
        comments,
        patch: {
          internal_rejected_at: nowIso(),
          internal_rejected_by: decisionActor.id || null,
          internal_rejection_comments: String(comments).trim()
        }
      });

      // a rejected CR moves into revision: editable again, and visibly distinct
      // from a change request that has never been submitted
      const rejected = changeRequests.findRaw(crId);
      changeRequests.applyTransition(rejected, 'revise', {
        actor: { type: 'SYSTEM', name: 'System' },
        patch: { locked: 0, revision: (cr.revision || 0) + 1, current_owner_user_id: cr.created_by }
      });

      notifications.resolve({ crId, types: ['CR_APPROVAL_REQUESTED'], emails: [address] });

      audit.record({
        entityType: 'APPROVAL',
        entityId: approval.id,
        crId,
        action: ACTIONS.CR_REJECTED,
        actor: decisionActor,
        comments: String(comments).trim(),
        newValue: { level: approval.level, approver: address },
        ip
      });

      sendRejectionNotice(crId, decisionActor, comments);
      return changeRequests.find(crId);
    });
  }

  // APPROVE
  return transaction(() => {
    update('change_request_approvals', approval.id, {
      status: 'APPROVED',
      decided_at: nowIso(),
      comments: comments ? String(comments).trim() : null,
      decided_via: via,
      ip_address: ip
    });

    notifications.resolve({ crId, types: ['CR_APPROVAL_REQUESTED'], emails: [address] });

    audit.record({
      entityType: 'APPROVAL',
      entityId: approval.id,
      crId,
      action: ACTIONS.CR_APPROVED,
      actor: decisionActor,
      comments: comments || null,
      newValue: { level: approval.level, approver: address },
      ip
    });

    const stillPendingThisLevel = get(
      "SELECT COUNT(*) AS count FROM change_request_approvals WHERE cr_id = ? AND level = ? AND status = 'PENDING'",
      [crId, currentLevel]
    )?.count || 0;

    if (stillPendingThisLevel > 0) return changeRequests.find(crId);

    const nextLevel = get(
      "SELECT MIN(level) AS level FROM change_request_approvals WHERE cr_id = ? AND status = 'PENDING'",
      [crId]
    )?.level;

    if (nextLevel !== null && nextLevel !== undefined) {
      run('UPDATE change_requests SET current_owner_user_id = ? WHERE id = ?', [
        resolveUserId(get('SELECT approver_email FROM change_request_approvals WHERE cr_id = ? AND level = ? LIMIT 1', [crId, nextLevel])?.approver_email),
        crId
      ]);
      notifyLevel(crId, nextLevel, decisionActor);
      return changeRequests.find(crId);
    }

    // final level approved
    changeRequests.applyTransition(changeRequests.findRaw(crId), 'approve', {
      actor: decisionActor,
      patch: {
        internally_approved_at: nowIso(),
        internally_approved_by: decisionActor.id || null,
        current_owner_user_id: cr.created_by
      }
    });

    documents.generate(crId, {
      format: getSetting('defaults.document_format', 'PDF'),
      final: true,
      actor: decisionActor,
      notes: `Final document generated on internal approval by ${decisionActor.name || address}`
    });

    changeRequests.applyTransition(changeRequests.findRaw(crId), 'ready', { actor: { type: 'SYSTEM', name: 'System' } });

    sendApprovalNotice(crId, decisionActor);
    return changeRequests.find(crId);
  });
}

function sendApprovalNotice(crId, decisionActor) {
  const cr = changeRequests.find(crId);
  const managerEmail = resolveEmail(cr.created_by) || getSetting('company.email');
  const managerName = get('SELECT name FROM users WHERE id = ?', [cr.created_by])?.name || 'there';

  email.send({
    templateCode: 'CR_APPROVED',
    to: managerEmail,
    crId,
    crReference: cr.cr_reference,
    variables: {
      manager_name: managerName,
      cr_number: cr.cr_number,
      account_name: cr.account?.account_name,
      msa_number: cr.snapshot_msa_number,
      cr_title: cr.title,
      cr_cost: formatMoney(cr.costs?.total_cost, cr.costs?.currency || 'INR'),
      approved_by: decisionActor.name || decisionActor.email,
      approved_date: formatDateTime(cr.internally_approved_at || nowIso()),
      cr_url: `${config.appUrl}/change-requests/${crId}`
    }
  });

  notifications.notify({
    userIds: [cr.created_by].filter(Boolean),
    roles: [],
    type: 'CR_APPROVED',
    title: `${cr.cr_number} approved internally`,
    body: 'Ready to share with the customer.',
    link: `/change-requests/${crId}`,
    crId,
    severity: 'SUCCESS'
  });

  chat.post({
    title: `Approved internally: ${cr.cr_number} · ${cr.account?.account_name}`,
    text: `${cr.title}
Approved by ${decisionActor.name || decisionActor.email}. Ready to share with the customer.`,
    link: `/change-requests/${crId}`
  });
}

function sendRejectionNotice(crId, decisionActor, comments) {
  const cr = changeRequests.find(crId);
  const managerEmail = resolveEmail(cr.created_by) || getSetting('company.email');
  const managerName = get('SELECT name FROM users WHERE id = ?', [cr.created_by])?.name || 'there';

  email.send({
    templateCode: 'CR_REJECTED',
    to: managerEmail,
    crId,
    crReference: cr.cr_reference,
    variables: {
      manager_name: managerName,
      cr_number: cr.cr_number,
      account_name: cr.account?.account_name,
      cr_title: cr.title,
      rejected_by: decisionActor.name || decisionActor.email,
      rejected_date: formatDateTime(nowIso()),
      rejection_comments: comments,
      cr_url: `${config.appUrl}/change-requests/${crId}`
    }
  });

  notifications.notify({
    userIds: [cr.created_by].filter(Boolean),
    type: 'CR_REJECTED',
    title: `${cr.cr_number} rejected`,
    body: String(comments).slice(0, 160),
    link: `/change-requests/${crId}`,
    crId,
    severity: 'WARNING'
  });

  chat.post({
    title: `Rejected internally: ${cr.cr_number} · ${cr.account?.account_name}`,
    text: `${cr.title}
Rejected by ${decisionActor.name || decisionActor.email}: ${String(comments).slice(0, 300)}`,
    link: `/change-requests/${crId}`
  });
}

/* ----------------------------------------------------------- my queue -- */

export function pendingQueue(actor) {
  const isAdmin = actor.role_code === 'ADMIN';
  const rows = all(
    `SELECT ap.id AS approval_id, ap.level, ap.level_name, ap.approver_email, ap.approver_name, ap.requested_at,
            cr.id, cr.cr_number, cr.cr_reference, cr.title, cr.status, cr.priority, cr.cr_date, cr.target_release_date,
            a.account_name, m.msa_reference_number,
            IFNULL(cc.total_cost,0) AS total_cost, IFNULL(cc.currency,'INR') AS currency,
            IFNULL((SELECT SUM(hours) FROM change_request_efforts e WHERE e.cr_id = cr.id),0) AS total_effort,
            u.name AS submitted_by_name
       FROM change_request_approvals ap
       JOIN change_requests cr ON cr.id = ap.cr_id
       JOIN accounts a ON a.id = cr.account_id
       JOIN msa_contracts m ON m.id = cr.msa_id
       LEFT JOIN change_request_costs cc ON cc.cr_id = cr.id
       LEFT JOIN users u ON u.id = cr.submitted_by
      WHERE ap.status = 'PENDING' AND cr.status = 'PENDING_INTERNAL_APPROVAL'
        AND (? = 1 OR lower(ap.approver_email) = lower(?))
      ORDER BY ap.requested_at ASC`,
    [isAdmin ? 1 : 0, actor.email]
  );

  return rows.map((row) => ({
    ...row,
    ageing_days: daysBetween(row.requested_at),
    is_mine: normaliseEmail(row.approver_email) === normaliseEmail(actor.email)
  }));
}

export function historyFor(crId) {
  return all(
    `SELECT * FROM change_request_approvals WHERE cr_id = ? ORDER BY level, requested_at`,
    [crId]
  );
}

export default { submit, decide, notifyLevel, pendingQueue, historyFor, levelsForAccount, listLevels, saveLevels };
