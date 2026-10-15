import path from 'node:path';
import express from 'express';
import config from './src/config.js';
import { migrate, close } from './src/db/index.js';
import { seed } from './src/db/seed.js';
import apiRouter from './src/routes/index.js';
import shareLinks from './src/services/shareLinks.js';
import authService from './src/services/auth.js';
import emailService from './src/services/email.js';
import reminders from './src/services/reminders.js';
import {
  cookies,
  requestContext,
  securityHeaders,
  loadSession,
  errorHandler,
  notFound,
  rateLimit
} from './src/middleware/index.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* ------------------------------------------------------------ bootstrap -- */

migrate();
if (config.seedOnBoot) {
  const result = seed();
  if (result.seeded) console.log(`[hcrms] demo data seeded (${result.accounts} accounts, ${result.users} users)`);
}

/* ---------------------------------------------------------- middleware -- */

app.use(requestContext);
app.use(securityHeaders);

// An uploaded MSA arrives as base64 JSON and routinely exceeds the general
// body limit. This parser runs first for that one path; the global parser below
// then finds the body already parsed and leaves it alone.
app.use('/api/accounts/msa-documents', express.json({ limit: '25mb' }));

app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      // the DocuSign webhook signature is computed over the raw body
      if (req.path === '/api/webhooks/docusign') req.rawBody = buf.toString('utf8');
    }
  })
);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookies);
app.use(loadSession);
app.use('/api', rateLimit({ windowMs: 60_000, max: config.rateLimit.apiRequestsPerMinute }));

/* ---------------------------------------------------------------- API -- */

app.use('/api', apiRouter);

// An unmatched API route must answer in JSON; falling through to the SPA
// handler (or Express's HTML default) turns a typo into an unreadable error.
app.use('/api', notFound);

/* ------------------------------------------------- tracked secure links -- */

app.get('/s/:token', (req, res) => {
  try {
    shareLinks.registerClick(req.params.token, { ip: req.clientIp, userAgent: req.userAgent });
  } catch {
    /* an invalid token still lands on the portal, which explains the problem */
  }
  res.redirect(302, `/portal/${encodeURIComponent(req.params.token)}`);
});

/* ------------------------------------------------------------ frontend -- */

app.use(
  express.static(config.publicDir, {
    index: false,
    maxAge: config.isProduction ? '1h' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  })
);

// SPA fallback — everything that is not an API route renders the shell
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

app.use(errorHandler);

/* -------------------------------------------------------------- server -- */

const server = app.listen(config.port, config.host, () => {
  console.log('');
  console.log('  Hyreo Account Management System');
  console.log(`  ${config.appUrl}`);
  console.log(`  environment : ${config.env}`);
  console.log(`  database    : ${config.databaseFile}`);
  console.log(`  documents   : ${config.documentsDir}`);
  const master = authService.masterCode();
  if (master) {
    console.log(`  WARNING     : demo master OTP "${master}" is active — clear otp.master_code in Settings,`);
    console.log('                or run with NODE_ENV=production, to disable it.');
  }
  console.log('');
});

// deliver anything that was queued while the process was starting
setTimeout(() => emailService.flush().catch(() => {}), 1000).unref();
const flushTimer = setInterval(() => emailService.flush().catch(() => {}), 30_000);
flushTimer.unref();

// chase stalled approvals and customers; the test suite drives the clock itself
function runReminders() {
  try {
    const result = reminders.runDue();
    if (result.reminders || result.escalations) {
      console.log(`[hcrms] reminders sent: ${result.reminders}, escalations: ${result.escalations}`);
    }
  } catch (error) {
    console.warn(`[hcrms] reminder pass failed: ${error?.message || error}`);
  }
}
const reminderTimer = config.env === 'test' ? null : setInterval(runReminders, 15 * 60_000);
reminderTimer?.unref();
if (reminderTimer) setTimeout(runReminders, 60_000).unref();

function shutdown(signal) {
  console.log(`\n[hcrms] ${signal} received, shutting down`);
  clearInterval(flushTimer);
  if (reminderTimer) clearInterval(reminderTimer);
  server.close(() => {
    close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
