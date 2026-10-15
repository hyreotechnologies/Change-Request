import { Router } from 'express';
import { handler, rateLimit, requireSession } from '../middleware/index.js';
import { validate } from '../lib/validate.js';
import authService from '../services/auth.js';
import { publicSettings } from '../services/settings.js';
import config from '../config.js';

const router = Router();

const otpLimiter = rateLimit({ windowMs: 60_000, max: 10 });

router.post(
  '/otp/request',
  otpLimiter,
  handler((req, res) => {
    const { email } = validate(req.body, { email: { type: 'email', required: true, label: 'Email address' } });
    const result = authService.requestLoginOtp({ emailAddress: email, ip: req.clientIp });
    res.json({ data: result });
  })
);

router.post(
  '/otp/resend',
  otpLimiter,
  handler((req, res) => {
    const { email } = validate(req.body, { email: { type: 'email', required: true, label: 'Email address' } });
    const result = authService.requestLoginOtp({ emailAddress: email, ip: req.clientIp });
    res.json({ data: result });
  })
);

router.post(
  '/otp/verify',
  rateLimit({ windowMs: 60_000, max: 20 }),
  handler((req, res) => {
    const { email, code } = validate(req.body, {
      email: { type: 'email', required: true, label: 'Email address' },
      code: { type: 'string', required: true, label: 'Verification code', maxLength: 10 }
    });
    const { token, user } = authService.verifyLoginOtp({
      emailAddress: email,
      code,
      ip: req.clientIp,
      userAgent: req.userAgent
    });
    res.setCookie(config.cookies.session, token, { maxAgeSeconds: 12 * 3600 });
    res.json({ data: { user, settings: publicSettings() } });
  })
);

router.get(
  '/me',
  requireSession,
  handler((req, res) => {
    res.json({ data: { user: req.user, settings: publicSettings() } });
  })
);

router.post(
  '/logout',
  handler((req, res) => {
    authService.logout(req.sessionToken, req.user);
    res.clearCookie2(config.cookies.session);
    res.json({ data: { ok: true } });
  })
);

router.get(
  '/sessions',
  requireSession,
  handler((req, res) => {
    res.json({ data: authService.activeSessions(req.user.id) });
  })
);

export default router;
