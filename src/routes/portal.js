import fs from 'node:fs';
import { Router } from 'express';
import { handler, rateLimit } from '../middleware/index.js';
import { validate } from '../lib/validate.js';
import portal from '../services/portal.js';
import emailService from '../services/email.js';
import docusign from '../services/docusign.js';
import config from '../config.js';

/**
 * Public portal API. Authentication is: share-link token (bound to one CR and
 * one email address) + an OTP challenge on that address. No application session
 * is involved, and nothing outside the linked change request is reachable.
 */
const router = Router();

const otpLimiter = rateLimit({ windowMs: 60_000, max: 10 });

function portalSession(req, shareToken) {
  return portal.resolveSession(req.cookies?.[config.cookies.portal], shareToken);
}

router.get(
  '/:token',
  handler((req, res) => {
    res.json({
      data: portal.context(req.params.token, { ip: req.clientIp, userAgent: req.userAgent })
    });
  })
);

router.post(
  '/:token/otp/request',
  otpLimiter,
  handler((req, res) => {
    const { email } = validate(req.body, { email: { type: 'email', required: true, label: 'Email address' } });
    res.json({ data: portal.requestOtp(req.params.token, email, { ip: req.clientIp }) });
  })
);

router.post(
  '/:token/otp/verify',
  rateLimit({ windowMs: 60_000, max: 20 }),
  handler((req, res) => {
    const { email, code } = validate(req.body, {
      email: { type: 'email', required: true, label: 'Email address' },
      code: { type: 'string', required: true, label: 'Verification code', maxLength: 10 }
    });
    const result = portal.verifyOtp(req.params.token, email, code, { ip: req.clientIp, userAgent: req.userAgent });
    res.setCookie(config.cookies.portal, result.token, { maxAgeSeconds: 2 * 3600 });
    res.json({ data: { audience: result.audience } });
  })
);

router.get(
  '/:token/cr',
  handler((req, res) => {
    const session = portalSession(req, req.params.token);
    res.json({ data: portal.viewChangeRequest(session, { ip: req.clientIp }) });
  })
);

router.get(
  '/:token/documents/:versionId',
  handler((req, res) => {
    const session = portalSession(req, req.params.token);
    const file = portal.portalDocument(session, req.params.versionId);
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    fs.createReadStream(file.absolutePath).pipe(res);
  })
);

router.post(
  '/:token/approve',
  handler((req, res) => {
    const session = portalSession(req, req.params.token);
    res.json({
      data: portal.approverDecision(session, { decision: 'APPROVE', comments: req.body?.comments || null }, { ip: req.clientIp })
    });
  })
);

router.post(
  '/:token/reject',
  handler((req, res) => {
    const session = portalSession(req, req.params.token);
    if (session.audience === 'CUSTOMER') {
      res.json({ data: portal.customerReject(session, req.body, { ip: req.clientIp }) });
      return;
    }
    const { comments } = validate(req.body || {}, {
      comments: { type: 'text', required: true, label: 'Rejection reason', minLength: 5, maxLength: 4000 }
    });
    res.json({ data: portal.approverDecision(session, { decision: 'REJECT', comments }, { ip: req.clientIp }) });
  })
);

router.post(
  '/:token/sign',
  handler((req, res) => {
    const session = portalSession(req, req.params.token);
    const result = portal.customerSign(session, req.body, { ip: req.clientIp, userAgent: req.userAgent });
    docusign.reconcile(session.cr_id);
    res.json({ data: result });
  })
);

/* ----------------------------------------------------------- tracking -- */

export const publicRouter = Router();

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

publicRouter.get(
  '/track/open/:token',
  handler((req, res) => {
    try {
      emailService.markOpened(req.params.token, req.clientIp);
    } catch {
      /* tracking must never break the email */
    }
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.end(PIXEL);
  })
);

export default router;
