import { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import { errors } from '../lib/errors.js';
import { validate } from '../lib/validate.js';
import { get } from '../db/index.js';
import changeRequests from '../services/changeRequests.js';
import approvals from '../services/approvals.js';
import documents from '../services/documents.js';
import portal from '../services/portal.js';
import docusign from '../services/docusign.js';
import audit from '../services/audit.js';
import emailService from '../services/email.js';
import reminders from '../services/reminders.js';
import accounts from '../services/accounts.js';

const router = Router();
router.use(requireSession);

/* --------------------------------------------------------------- listing -- */

router.get(
  '/',
  requirePermission('cr.view'),
  handler((req, res) => {
    const { page = 1, pageSize = 25, ...filters } = req.query;
    const limit = Math.min(Number(pageSize) || 25, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    res.json({ data: changeRequests.list({ ...filters, limit, offset }, req.user) });
  })
);

router.post(
  '/',
  requirePermission('cr.create'),
  handler((req, res) => {
    res.status(201).json({ data: changeRequests.create(req.body, req.user) });
  })
);

/* ----------------------------------------------------------- bulk work -- */

const BULK_LIMIT = 100;

function bulkIds(body) {
  const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id) : [];
  if (!ids.length) throw errors.validation('Select at least one change request');
  if (ids.length > BULK_LIMIT) throw errors.validation(`Select at most ${BULK_LIMIT} change requests at a time`);
  return [...new Set(ids)];
}

/** Run an action per change request and report each outcome, so one failure never hides the rest. */
function eachOutcome(ids, req, fn) {
  return ids.map((id) => {
    try {
      changeRequests.find(id, { actor: req.user });
      return { id, ok: true, ...fn(id) };
    } catch (error) {
      return { id, ok: false, error: error.message };
    }
  });
}

router.post(
  '/bulk/remind',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const results = eachOutcome(bulkIds(req.body), req, (id) => reminders.remindNow(id, req.user));
    res.json({ data: { results, sent: results.filter((r) => r.ok).length } });
  })
);

router.post(
  '/bulk/reassign',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const userId = req.body?.userId;
    if (!userId) throw errors.validation('Choose who to assign the change requests to');
    const results = eachOutcome(bulkIds(req.body), req, (id) => changeRequests.reassign(id, userId, req.user));
    res.json({ data: { results, updated: results.filter((r) => r.ok && r.changed).length } });
  })
);

router.get(
  '/:id',
  requirePermission('cr.view'),
  handler((req, res) => {
    docusign.reconcile(req.params.id);
    const cr = changeRequests.find(req.params.id, { actor: req.user });
    res.json({
      data: {
        ...cr,
        timeline: changeRequests.timeline(cr.id),
        share_links: portal.activeLinks(cr.id),
        timeline_suggestion: changeRequests.suggestTimeline(cr.id),
        contract: cr.msa ? { renewal: accounts.renewalState(cr.msa), budget: accounts.msaBudget(cr.msa) } : null
      }
    });
  })
);

router.post(
  '/:id/duplicate',
  requirePermission('cr.create'),
  handler((req, res) => {
    changeRequests.find(req.params.id, { actor: req.user });
    res.status(201).json({ data: changeRequests.duplicate(req.params.id, req.user) });
  })
);

router.post(
  '/:id/remind',
  requirePermission('cr.edit'),
  handler((req, res) => {
    changeRequests.find(req.params.id, { actor: req.user });
    res.json({ data: reminders.remindNow(req.params.id, req.user) });
  })
);

router.get(
  '/:id/reminders',
  requirePermission('cr.view'),
  handler((req, res) => {
    changeRequests.find(req.params.id, { actor: req.user });
    res.json({ data: reminders.historyFor(req.params.id) });
  })
);

router.get(
  '/:id/compare',
  requirePermission('cr.view'),
  handler((req, res) => {
    changeRequests.find(req.params.id, { actor: req.user });
    res.json({ data: changeRequests.compareVersions(req.params.id) });
  })
);

router.patch(
  '/:id',
  requirePermission('cr.edit'),
  handler((req, res) => {
    res.json({ data: changeRequests.editHeader(req.params.id, req.body, req.user) });
  })
);

router.delete(
  '/:id',
  requirePermission('cr.delete'),
  handler((req, res) => {
    res.json({ data: changeRequests.remove(req.params.id, req.user) });
  })
);

/* --------------------------------------------------------- sub-resources -- */

router.put(
  '/:id/items',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body?.items;
    res.json({ data: changeRequests.saveItems(req.params.id, items || [], req.user) });
  })
);

router.put(
  '/:id/efforts',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const efforts = Array.isArray(req.body) ? req.body : req.body?.efforts;
    const saved = changeRequests.saveEfforts(req.params.id, efforts || [], req.user);
    res.json({ data: { efforts: saved, costs: get('SELECT * FROM change_request_costs WHERE cr_id = ?', [req.params.id]) } });
  })
);

router.put(
  '/:id/costs',
  requirePermission('cr.edit'),
  handler((req, res) => {
    res.json({ data: changeRequests.saveCosts(req.params.id, req.body, req.user) });
  })
);

router.put(
  '/:id/assumptions',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const entries = Array.isArray(req.body) ? req.body : req.body?.assumptions;
    res.json({ data: changeRequests.saveAssumptions(req.params.id, entries || [], req.user) });
  })
);

router.put(
  '/:id/dependencies',
  requirePermission('cr.edit'),
  handler((req, res) => {
    const entries = Array.isArray(req.body) ? req.body : req.body?.dependencies;
    res.json({ data: changeRequests.saveDependencies(req.params.id, entries || [], req.user) });
  })
);

/* ------------------------------------------------------------- workflow -- */

router.get(
  '/:id/readiness',
  requirePermission('cr.view'),
  handler((req, res) => {
    const { ok, problems } = changeRequests.assertReadyForSubmission(req.params.id);
    res.json({ data: { ok, problems } });
  })
);

router.post(
  '/:id/submit',
  requirePermission('cr.submit'),
  handler((req, res) => {
    res.json({ data: approvals.submit(req.params.id, req.user) });
  })
);

router.post(
  '/:id/approve',
  requirePermission('cr.approve'),
  handler((req, res) => {
    const { comments } = validate(req.body || {}, { comments: { type: 'text', label: 'Comments', maxLength: 4000 } }, { partial: true });
    res.json({ data: decideInApp(req, 'APPROVE', comments) });
  })
);

router.post(
  '/:id/reject',
  requirePermission('cr.approve'),
  handler((req, res) => {
    const { comments } = validate(req.body || {}, {
      comments: { type: 'text', required: true, label: 'Rejection reason', minLength: 5, maxLength: 4000 }
    });
    res.json({ data: decideInApp(req, 'REJECT', comments) });
  })
);

/**
 * In-app decisions run through exactly the same engine as the portal.
 * An administrator may decide on behalf of the assigned approver; the audit
 * trail records the administrator as the actor and notes the override.
 */
function decideInApp(req, decision, comments) {
  const crId = req.params.id;
  const mine = get(
    `SELECT approver_email FROM change_request_approvals
      WHERE cr_id = ? AND status = 'PENDING' AND lower(approver_email) = lower(?)
      ORDER BY level LIMIT 1`,
    [crId, req.user.email]
  );

  let approverEmail = mine?.approver_email;
  let note = comments;

  if (!approverEmail) {
    if (req.user.role_code !== 'ADMIN') {
      throw errors.forbidden('You are not the assigned approver for this change request');
    }
    const pending = get(
      `SELECT approver_email FROM change_request_approvals
        WHERE cr_id = ? AND status = 'PENDING'
        ORDER BY level LIMIT 1`,
      [crId]
    );
    if (!pending) throw errors.invalidState('There is no pending approval for this change request');
    approverEmail = pending.approver_email;
    note = `${comments ? `${comments} ` : ''}[Recorded by administrator ${req.user.name} on behalf of ${approverEmail}]`;
  }

  return approvals.decide(crId, {
    decision,
    comments: note,
    approverEmail,
    actor: req.user,
    via: 'APP',
    ip: req.clientIp
  });
}

router.post(
  '/:id/revise',
  requirePermission('cr.revise'),
  handler((req, res) => {
    res.json({ data: changeRequests.revise(req.params.id, req.user) });
  })
);

router.post(
  '/:id/cancel',
  requirePermission('cr.cancel'),
  handler((req, res) => {
    const { reason } = validate(req.body || {}, {
      reason: { type: 'text', required: true, label: 'Reason', minLength: 5, maxLength: 2000 }
    });
    res.json({ data: changeRequests.cancel(req.params.id, reason, req.user) });
  })
);

router.post(
  '/:id/hold',
  requirePermission('cr.hold'),
  handler((req, res) => {
    res.json({ data: changeRequests.hold(req.params.id, req.body?.reason || null, req.user) });
  })
);

router.post(
  '/:id/resume',
  requirePermission('cr.hold'),
  handler((req, res) => {
    res.json({ data: changeRequests.resume(req.params.id, req.user) });
  })
);

/* ------------------------------------------------------------ documents -- */

router.get(
  '/:id/documents',
  requirePermission('document.view'),
  handler((req, res) => {
    res.json({ data: documents.listForChangeRequest(req.params.id) });
  })
);

router.post(
  '/:id/documents/generate',
  requirePermission('document.generate'),
  handler((req, res) => {
    const { format = 'BOTH', final = false, notes = null } = req.body || {};
    const cr = changeRequests.findRaw(req.params.id);
    if (['COMPLETED', 'CANCELLED', 'EXPIRED'].includes(cr.status)) {
      throw errors.invalidState('This change request is closed — existing document versions remain downloadable, but no new version can be generated');
    }
    if (final && !['INTERNALLY_APPROVED', 'READY_FOR_CUSTOMER'].includes(cr.status)) {
      throw errors.invalidState('A final document is produced automatically on internal approval');
    }
    res.json({ data: documents.generate(req.params.id, { format, final: Boolean(final), notes, actor: req.user }) });
  })
);

router.get(
  '/:id/documents/preview',
  requirePermission('document.view'),
  handler((req, res) => {
    res.json({ data: { html: documents.previewHtml(req.params.id) } });
  })
);

/* -------------------------------------------------------- customer share -- */

router.get(
  '/:id/share/defaults',
  requirePermission('customer.share'),
  handler((req, res) => {
    res.json({ data: portal.shareDefaults(req.params.id) });
  })
);

router.post(
  '/:id/share',
  requirePermission('customer.share'),
  handler((req, res) => {
    res.json({ data: portal.shareWithCustomer(req.params.id, req.body, req.user) });
  })
);

/* ------------------------------------------------------------- e-sign -- */

router.post(
  '/:id/docusign/send',
  requirePermission('docusign.send'),
  handler(async (req, res) => {
    const result = await docusign.sendEnvelope(req.params.id, req.body || {}, req.user);
    res.json({ data: result });
  })
);

router.post(
  '/:id/docusign/refresh',
  requirePermission('docusign.send'),
  handler(async (req, res) => {
    res.json({ data: await docusign.refresh(req.params.id) });
  })
);

router.post(
  '/:id/docusign/void',
  requirePermission('docusign.void'),
  handler((req, res) => {
    res.json({ data: docusign.voidEnvelope(req.params.id, req.body?.reason || null, req.user) });
  })
);

/* -------------------------------------------------------------- history -- */

router.get(
  '/:id/timeline',
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: changeRequests.timeline(req.params.id) });
  })
);

router.get(
  '/:id/audit',
  requirePermission('audit.view'),
  handler((req, res) => {
    res.json({ data: audit.listForChangeRequest(req.params.id) });
  })
);

router.get(
  '/:id/emails',
  requirePermission('email.view'),
  handler((req, res) => {
    res.json({ data: emailService.listEmails({ crId: req.params.id, limit: 200 }) });
  })
);

router.get(
  '/:id/approvals',
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: approvals.historyFor(req.params.id) });
  })
);

export default router;
