import { Router } from 'express';
import { handler, requireSession, requirePermission } from '../middleware/index.js';
import { can } from '../services/rbac.js';
import integrations from '../services/integrations.js';
import email from '../services/email.js';
import chat from '../services/chat.js';

const router = Router();

/**
 * The provider sends the browser back here after consent. It is a page
 * navigation, not an API call, so every outcome redirects to the screen.
 */
router.get(
  '/:key/callback',
  handler(async (req, res) => {
    const back = (params) => res.redirect(`/integrations?${new URLSearchParams(params)}`);
    if (!req.user) return res.redirect('/login');
    if (!can(req.user, 'integration.manage')) return back({ error: 'You do not have permission to manage integrations' });
    try {
      const result = await integrations.completeConnect(req.params.key, req.query, req.user);
      return back({ connected: result.key });
    } catch (error) {
      return back({ error: error?.message || 'The connection could not be completed' });
    }
  })
);

router.use(requireSession, requirePermission('integration.manage'));

router.get(
  '/',
  handler(async (req, res) => {
    res.json({ data: await integrations.list() });
  })
);

router.post(
  '/:key/connect',
  handler((req, res) => {
    res.json({ data: integrations.startConnect(req.params.key, req.user) });
  })
);

router.post(
  '/:key/disconnect',
  handler((req, res) => {
    res.json({ data: integrations.disconnect(req.params.key, req.user) });
  })
);

router.post(
  '/:key/use-for-email',
  handler((req, res) => {
    res.json({ data: integrations.useForEmail(req.params.key, req.user) });
  })
);

router.get(
  '/teams/channels',
  handler(async (req, res) => {
    res.json({ data: await integrations.teamsChannels() });
  })
);

router.put(
  '/teams/channel',
  handler((req, res) => {
    res.json({ data: integrations.setTeamsChannel(req.body || {}, req.user) });
  })
);

/** Prove the connection end to end: an email to the signed-in user, or a channel post. */
router.post(
  '/:key/test',
  handler(async (req, res, next) => {
    const { key } = req.params;
    if (key === 'outlook' || key === 'gmail') {
      const html = email.wrapLayout({
        subject: 'Test email',
        contentHtml: `<p>This test was sent through the connected mailbox, requested by ${req.user.name}.</p><p>If it arrived, email delivery through this mailbox works.</p>`
      });
      const sent = await integrations.sendMail(key, {
        to: req.user.email,
        subject: 'Test email from Hyreo Account Management',
        html,
        attachments: email.inlineAttachments(html),
        text: 'This test was sent through the connected mailbox. If it arrived, email delivery through this mailbox works.'
      });
      return res.json({ data: { ok: true, message: `Test email sent from ${sent.from} to ${req.user.email}.` } });
    }
    if (key === 'slack' || key === 'teams') {
      const results = await chat.deliver(
        { title: 'Test message from Hyreo Account Management', text: `Requested by ${req.user.name}. Approval requests, decisions and signatures will appear here.`, link: '/dashboard' },
        { only: key }
      );
      const result = results[key];
      if (!result?.ok) return res.status(502).json({ error: { code: 'DELIVERY_FAILED', message: result?.error || 'Nothing was delivered' } });
      return res.json({ data: { ok: true, message: 'Test message posted.' } });
    }
    // anything else (e.g. the webhook test at /integrations/chat/test) belongs to a later route
    return next();
  })
);

export default router;
