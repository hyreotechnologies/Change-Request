import { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import { validate } from '../lib/validate.js';
import users from '../services/users.js';
import rbac from '../services/rbac.js';
import settings from '../services/settings.js';
import emailTemplates from '../services/emailTemplates.js';
import emailService from '../services/email.js';
import docusign from '../services/docusign.js';
import approvals from '../services/approvals.js';
import audit, { ACTIONS } from '../services/audit.js';

/* ----------------------------------------------------------------- users -- */

export const userRouter = Router();
userRouter.use(requireSession);

userRouter.get(
  '/',
  requirePermission('user.manage'),
  handler((req, res) => {
    res.json({ data: users.list(req.query) });
  })
);

userRouter.get(
  '/pick-list',
  handler((req, res) => {
    res.json({ data: users.pickList() });
  })
);

userRouter.post(
  '/',
  requirePermission('user.manage'),
  handler((req, res) => {
    res.status(201).json({ data: users.create(req.body, req.user) });
  })
);

userRouter.get(
  '/:id',
  requirePermission('user.manage'),
  handler((req, res) => {
    res.json({ data: users.find(req.params.id) });
  })
);

userRouter.patch(
  '/:id',
  requirePermission('user.manage'),
  handler((req, res) => {
    res.json({ data: users.edit(req.params.id, req.body, req.user) });
  })
);

userRouter.post(
  '/:id/status',
  requirePermission('user.manage'),
  handler((req, res) => {
    res.json({ data: users.setStatus(req.params.id, Boolean(req.body?.is_active), req.user) });
  })
);

/* ----------------------------------------------------------------- roles -- */

export const roleRouter = Router();
roleRouter.use(requireSession);

roleRouter.get(
  '/',
  handler((req, res) => {
    res.json({ data: rbac.listRoles() });
  })
);

roleRouter.get(
  '/permissions',
  requirePermission('role.manage'),
  handler((req, res) => {
    res.json({ data: rbac.listPermissions() });
  })
);

roleRouter.put(
  '/:code/permissions',
  requirePermission('role.manage'),
  handler((req, res) => {
    const permissions = Array.isArray(req.body) ? req.body : req.body?.permissions || [];
    const saved = rbac.setRolePermissions(req.params.code, permissions);
    audit.record({
      entityType: 'ROLE',
      entityId: req.params.code,
      action: ACTIONS.PERMISSIONS_UPDATED,
      actor: req.user,
      newValue: saved
    });
    res.json({ data: saved });
  })
);

/* -------------------------------------------------------------- settings -- */

export const settingsRouter = Router();
settingsRouter.use(requireSession);

settingsRouter.get(
  '/public',
  handler((req, res) => {
    res.json({ data: settings.publicSettings() });
  })
);

settingsRouter.get(
  '/',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: settings.listSettings() });
  })
);

settingsRouter.put(
  '/',
  requirePermission('settings.manage'),
  handler((req, res) => {
    const values = req.body?.values || req.body || {};
    const changed = settings.setSettings(values, req.user);
    audit.record({
      entityType: 'SETTINGS',
      action: ACTIONS.SETTINGS_UPDATED,
      actor: req.user,
      newValue: Object.keys(values)
    });
    res.json({ data: { changed: Object.keys(changed), settings: settings.listSettings() } });
  })
);

settingsRouter.get(
  '/email-templates',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: emailTemplates.listTemplates() });
  })
);

settingsRouter.get(
  '/email-templates/:code',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: emailTemplates.getTemplate(req.params.code) });
  })
);

settingsRouter.put(
  '/email-templates/:code',
  requirePermission('settings.manage'),
  handler((req, res) => {
    const data = validate(req.body || {}, {
      subject: { type: 'string', label: 'Subject', maxLength: 300 },
      body_html: { type: 'text', label: 'Body', maxLength: 60000 },
      is_active: { type: 'boolean', label: 'Active' }
    }, { partial: true });
    const saved = emailTemplates.updateTemplate(req.params.code, data, req.user);
    audit.record({
      entityType: 'EMAIL_TEMPLATE',
      entityId: req.params.code,
      action: ACTIONS.SETTINGS_UPDATED,
      actor: req.user
    });
    res.json({ data: saved });
  })
);

settingsRouter.post(
  '/email-templates/:code/reset',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: emailTemplates.resetTemplate(req.params.code) });
  })
);

settingsRouter.get(
  '/email/status',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: emailService.verifyTransport() });
  })
);

settingsRouter.post(
  '/email/test',
  requirePermission('settings.manage'),
  handler(async (req, res) => {
    const { email } = validate(req.body || {}, { email: { type: 'email', required: true, label: 'Email address' } });
    emailService.send({
      templateCode: 'TEST_EMAIL',
      to: email,
      variables: { company_name: settings.getSetting('company.name', 'Hyreo'), sent_by: req.user.name },
      actor: req.user
    });
    await emailService.flush();
    res.json({ data: { sent: true, transport: emailService.verifyTransport() } });
  })
);

settingsRouter.get(
  '/docusign',
  requirePermission('integration.manage'),
  handler((req, res) => {
    res.json({ data: docusign.integrationStatus() });
  })
);

settingsRouter.put(
  '/docusign',
  requirePermission('integration.manage'),
  handler((req, res) => {
    const allowed = [
      'docusign.enabled', 'docusign.provider', 'docusign.environment', 'docusign.base_uri',
      'docusign.account_id', 'docusign.integration_key', 'docusign.user_id',
      'docusign.secret_key', 'docusign.private_key', 'docusign.webhook_secret'
    ];
    const values = Object.fromEntries(Object.entries(req.body || {}).filter(([key]) => allowed.includes(key)));
    settings.setSettings(values, req.user);
    audit.record({
      entityType: 'SETTINGS',
      entityId: 'docusign',
      action: ACTIONS.SETTINGS_UPDATED,
      actor: req.user,
      newValue: Object.keys(values)
    });
    res.json({ data: docusign.integrationStatus() });
  })
);

settingsRouter.post(
  '/docusign/test',
  requirePermission('integration.manage'),
  handler(async (req, res) => {
    res.json({ data: await docusign.testConnection() });
  })
);

settingsRouter.get(
  '/approval-levels',
  requirePermission('settings.manage'),
  handler((req, res) => {
    res.json({ data: approvals.listLevels() });
  })
);

settingsRouter.put(
  '/approval-levels',
  requirePermission('settings.manage'),
  handler((req, res) => {
    const levels = Array.isArray(req.body) ? req.body : req.body?.levels || [];
    res.json({ data: approvals.saveLevels(levels, req.user) });
  })
);

export default { userRouter, roleRouter, settingsRouter };
