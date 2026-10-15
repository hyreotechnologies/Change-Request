import { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import { errors } from '../lib/errors.js';
import authRouter from './auth.js';
import accountRouter, { msaRouter } from './accounts.js';
import changeRequestRouter from './changeRequests.js';
import documentRouter, { reportRouter } from './documents.js';
import portalRouter, { publicRouter } from './portal.js';
import { userRouter, roleRouter, settingsRouter } from './admin.js';
import dashboard from '../services/dashboard.js';
import notifications from '../services/notifications.js';
import approvals from '../services/approvals.js';
import audit from '../services/audit.js';
import emailService from '../services/email.js';
import docusign from '../services/docusign.js';
import changeRequests from '../services/changeRequests.js';
import stateMachine from '../services/stateMachine.js';
import { CURRENCIES } from '../lib/money.js';
import savedViews from '../services/savedViews.js';
import reminders from '../services/reminders.js';
import chat from '../services/chat.js';

const router = Router();

router.get('/health', (req, res) => {
  res.json({ data: { status: 'ok', time: new Date().toISOString() } });
});

router.use('/auth', authRouter);
router.use('/accounts', accountRouter);
router.use('/msas', msaRouter);
router.use('/change-requests', changeRequestRouter);
router.use('/documents', documentRouter);
router.use('/reports', reportRouter);
router.use('/users', userRouter);
router.use('/roles', roleRouter);
router.use('/settings', settingsRouter);
router.use('/portal', portalRouter);
router.use('/public', publicRouter);

/* ------------------------------------------------------------- dashboard -- */

router.get(
  '/dashboard',
  requireSession,
  requirePermission('dashboard.view'),
  handler((req, res) => {
    res.json({ data: dashboard.overview(req.user) });
  })
);

router.get(
  '/search',
  requireSession,
  handler((req, res) => {
    res.json({ data: dashboard.search(req.query.q, req.user) });
  })
);

router.get(
  '/my-queue',
  requireSession,
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: dashboard.myQueue(req.user) });
  })
);

/* ---------------------------------------------------------- saved views -- */

router.get(
  '/saved-views',
  requireSession,
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: savedViews.list(req.user.id) });
  })
);

router.post(
  '/saved-views',
  requireSession,
  requirePermission('cr.view'),
  handler((req, res) => {
    res.status(201).json({ data: savedViews.create(req.user.id, req.body || {}) });
  })
);

router.delete(
  '/saved-views/:id',
  requireSession,
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: savedViews.remove(req.user.id, req.params.id) });
  })
);

/* ----------------------------------------------------------- automation -- */

router.post(
  '/reminders/run',
  requireSession,
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: reminders.runDue() });
  })
);

router.post(
  '/integrations/chat/test',
  requireSession,
  requirePermission('integration.manage'),
  handler(async (req, res) => {
    if (!chat.isConfigured()) throw errors.invalidState('Add a Slack or Teams webhook URL and save before sending a test message');
    const results = await chat.deliver({
      title: 'Hyreo CRMS test message',
      text: `Sent by ${req.user.name}. If you can read this, change request updates will arrive in this channel.`,
      link: '/dashboard'
    });
    res.json({ data: results });
  })
);

/* ------------------------------------------------------------- approvals -- */

router.get(
  '/approvals/pending',
  requireSession,
  requirePermission('cr.view'),
  handler((req, res) => {
    res.json({ data: approvals.pendingQueue(req.user) });
  })
);

/* --------------------------------------------------------- notifications -- */

router.get(
  '/notifications',
  requireSession,
  requirePermission('notification.view'),
  handler((req, res) => {
    const { unreadOnly, limit = 50 } = req.query;
    res.json({ data: notifications.list(req.user.id, { unreadOnly: unreadOnly === '1', limit: Number(limit) }) });
  })
);

router.post(
  '/notifications/read-all',
  requireSession,
  requirePermission('notification.view'),
  handler((req, res) => {
    res.json({ data: notifications.markAllRead(req.user.id) });
  })
);

router.delete(
  '/notifications',
  requireSession,
  requirePermission('notification.view'),
  handler((req, res) => {
    res.json({ data: notifications.clear(req.user.id, { readOnly: req.query.readOnly === '1' }) });
  })
);

router.delete(
  '/notifications/:id',
  requireSession,
  requirePermission('notification.view'),
  handler((req, res) => {
    res.json({ data: notifications.remove(req.params.id, req.user.id) });
  })
);

router.post(
  '/notifications/:id/read',
  requireSession,
  requirePermission('notification.view'),
  handler((req, res) => {
    res.json({ data: notifications.markRead(req.params.id, req.user.id) });
  })
);

/* -------------------------------------------------------------- outbox -- */

router.get(
  '/emails',
  requireSession,
  requirePermission('email.view'),
  handler((req, res) => {
    const { q, status, crId, page = 1, pageSize = 50 } = req.query;
    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    res.json({ data: emailService.listEmails({ q, status, crId, limit, offset }) });
  })
);

router.get(
  '/emails/:id',
  requireSession,
  requirePermission('email.view'),
  handler((req, res) => {
    res.json({ data: emailService.getEmail(req.params.id) });
  })
);

/* --------------------------------------------------------------- audit -- */

router.get(
  '/audit',
  requireSession,
  requirePermission('audit.view'),
  handler((req, res) => {
    const { page = 1, pageSize = 100, ...filters } = req.query;
    const limit = Math.min(Number(pageSize) || 100, 500);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    res.json({ data: audit.search({ ...filters, limit, offset }) });
  })
);

/* ---------------------------------------------------------- enumerations -- */

router.get(
  '/enums',
  requireSession,
  handler((req, res) => {
    res.json({
      data: {
        statuses: Object.entries(stateMachine.STATUSES).map(([code, meta]) => ({ code, ...meta })),
        status_groups: stateMachine.STATUS_GROUPS,
        cr_types: changeRequests.CR_TYPES.map((code) => ({ code, label: titleCase(code) })),
        priorities: changeRequests.PRIORITIES.map((code) => ({ code, label: titleCase(code) })),
        effort_categories: changeRequests.EFFORT_CATEGORIES,
        currencies: Object.values(CURRENCIES),
        dependency_types: [
          { code: 'CUSTOMER', label: 'Customer dependency' },
          { code: 'INTERNAL', label: 'Internal dependency' },
          { code: 'THIRD_PARTY', label: 'Third-party dependency' },
          { code: 'RISK', label: 'Risk' },
          { code: 'REMARK', label: 'Remark' }
        ],
        customer_types: ['Enterprise', 'Mid-market', 'SMB', 'Startup', 'Government', 'Partner'],
        industries: [
          'Technology', 'Banking & Financial Services', 'Insurance', 'Healthcare', 'Retail',
          'Manufacturing', 'Telecom', 'Consulting', 'Staffing & Recruitment', 'Education', 'Other'
        ],
        msa_statuses: ['ACTIVE', 'EXPIRED', 'TERMINATED', 'DRAFT'],
        roles: [
          { code: 'ADMIN', label: 'Administrator' },
          { code: 'CR_MANAGER', label: 'Change Request Manager' },
          { code: 'APPROVER', label: 'Approver' },
          { code: 'VIEWER', label: 'Viewer' }
        ]
      }
    });
  })
);

function titleCase(code) {
  return String(code)
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/* ------------------------------------------------------------- webhooks -- */

router.post(
  '/webhooks/docusign',
  handler((req, res) => {
    const signature = req.headers['x-docusign-signature-1'] || req.headers['x-authorization-digest'] || null;
    const result = docusign.handleWebhook(req.rawBody || JSON.stringify(req.body || {}), signature);
    res.json({ data: result });
  })
);

export default router;
