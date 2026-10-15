/**
 * Workflow productivity features: time limits, the "waiting on me" queue,
 * duplicate, reassign, saved views, reminders and escalation, version
 * comparison, contract renewal and budget, chat integration guard.
 *
 *   node tests/features.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrms-features-'));
process.env.STORAGE_DIR = tmp;
process.env.DATABASE_FILE = path.join(tmp, 'test.db');
process.env.PORT = String(4600 + Math.floor(Math.random() * 300));
process.env.APP_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.NODE_ENV = 'test';
process.env.SEED_ON_BOOT = 'true';

const BASE = process.env.APP_URL;
const jars = new Map();

let passed = 0;
let failed = 0;

async function step(label, fn) {
  try {
    const result = await fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
    return result;
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}\n     ${error.message}`);
    return null;
  }
}

function cookieHeader(name) {
  return Array.from((jars.get(name) || new Map()).entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function keepCookies(response, name) {
  if (!jars.has(name)) jars.set(name, new Map());
  for (const cookie of response.headers.getSetCookie?.() || []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    jars.get(name).set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
  }
}

async function call(method, url, body, { as = 'admin', expect = null } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(as) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  keepCookies(response, as);
  const payload = await response.json().catch(() => ({}));
  if (expect !== null) {
    assert.equal(response.status, expect, `${method} ${url} answered ${response.status}: ${payload?.error?.message || ''}`);
    return payload;
  }
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status} ${payload?.error?.message || ''}`);
  return payload.data;
}

async function login(email, as) {
  const response = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: '011235' })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message);
  keepCookies(response, as);
  return payload.data.user;
}

async function main() {
  await import('../server.js');
  const db = await import('../src/db/index.js');
  await new Promise((resolve) => setTimeout(resolve, 600));

  console.log('\nHyreo Account Management — workflow productivity features\n');

  await login('sahaf@hyreo.com', 'admin');
  const manager = await login('cr.manager@hyreo.com', 'manager');

  const all = await call('GET', '/api/change-requests?pageSize=100');
  const pending = all.rows.find((row) => row.status === 'PENDING_INTERNAL_APPROVAL');
  const draft = all.rows.find((row) => row.status === 'DRAFT');
  assert.ok(pending && draft, 'the demo data has a pending and a draft change request');

  await step('1  list rows carry the stage time limit', async () => {
    assert.ok(pending.sla, 'pending CR has a time-limit view');
    assert.equal(pending.sla.stage, 'INTERNAL');
    assert.ok(['on_track', 'due_soon', 'overdue'].includes(pending.sla.state));
    const done = all.rows.find((row) => row.status === 'COMPLETED');
    assert.equal(done.sla, null, 'closed change requests have no time limit');
  });

  await step('2  overdue filter finds a change request once it exceeds its limit', async () => {
    const before = await call('GET', '/api/change-requests?due=overdue&pageSize=100');
    assert.ok(!before.rows.some((row) => row.id === pending.id));
    // the audit trail is append-only, so age the CR by shrinking the limit instead (~1.7 seconds)
    await call('PUT', '/api/settings', { 'sla.internal_days': 0.00002 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const after = await call('GET', '/api/change-requests?due=overdue&pageSize=100');
    const row = after.rows.find((r) => r.id === pending.id);
    assert.ok(row, 'the aged CR is overdue');
    assert.equal(row.sla.state, 'overdue');
    const dashboard = await call('GET', '/api/dashboard');
    assert.ok(dashboard.time_limits.overdue >= 1, 'dashboard counts it');
    await call('PUT', '/api/settings', { 'sla.internal_days': 3 });
  });

  await step('3  waiting-on-me queue lists the approver\'s decision and the owner\'s drafts', async () => {
    const approver = await login('arun.satyan@hyreo.com', 'approver');
    const queue = await call('GET', '/api/my-queue', undefined, { as: 'approver' });
    assert.ok(queue.items.some((item) => item.id === pending.id && item.kind === 'APPROVE'), 'pending approval is on the approver queue');
    assert.ok(approver);
    const dashboard = await call('GET', '/api/dashboard');
    assert.ok(Array.isArray(dashboard.my_queue.items));
    assert.equal(typeof dashboard.time_limits.overdue, 'number');
    assert.ok(Array.isArray(dashboard.time_limits.stage_durations));
    assert.ok(Array.isArray(dashboard.renewals));
  });

  const copy = await step('4  duplicate starts a new draft with the same scope and cost', async () => {
    const source = await call('GET', `/api/change-requests/${pending.id}`);
    const created = await call('POST', `/api/change-requests/${pending.id}/duplicate`, {}, { as: 'manager' });
    assert.equal(created.status, 'DRAFT');
    assert.notEqual(created.cr_number, source.cr_number);
    assert.ok(created.title.startsWith('Copy of'));
    assert.equal(created.items.length, source.items.length);
    assert.equal(created.total_effort, source.total_effort);
    assert.equal(created.costs.total_cost, source.costs.total_cost);
    assert.equal(created.target_release_date, null, 'dates are not carried over');
    return created;
  });

  await step('5  bulk reassign changes the owner and reports each outcome', async () => {
    const result = await call('POST', '/api/change-requests/bulk/reassign', { ids: [copy.id, draft.id], userId: manager.id });
    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.ok));
    const reloaded = await call('GET', `/api/change-requests/${draft.id}`);
    assert.equal(reloaded.current_owner_user_id, manager.id);
    const mine = await call('GET', '/api/change-requests?owner=me&pageSize=100', undefined, { as: 'manager' });
    assert.ok(mine.rows.some((row) => row.id === draft.id), '"owner=me" resolves to the caller');
  });

  await step('6  saved views are private, named uniquely and filtered', async () => {
    const view = await call('POST', '/api/saved-views', { name: 'My overdue', query: 'due=overdue&owner=me&evil=1' }, { as: 'manager' });
    assert.equal(view.query, 'due=overdue&owner=me', 'unknown keys are dropped');
    await call('POST', '/api/saved-views', { name: 'my overdue', query: 'due=overdue' }, { as: 'manager', expect: 422 });
    const views = await call('GET', '/api/saved-views', undefined, { as: 'manager' });
    assert.equal(views.length, 1);
    const adminViews = await call('GET', '/api/saved-views');
    assert.equal(adminViews.length, 0, 'views belong to one user');
    await call('DELETE', `/api/saved-views/${view.id}`, undefined, { as: 'admin', expect: 404 });
    await call('DELETE', `/api/saved-views/${view.id}`, undefined, { as: 'manager' });
  });

  await step('7  a manual reminder emails the approver, then cools down', async () => {
    const before = db.get('SELECT COUNT(*) AS count FROM email_logs WHERE template_code = ?', ['APPROVAL_REMINDER']).count;
    const result = await call('POST', `/api/change-requests/${pending.id}/remind`, {}, { as: 'manager' });
    assert.ok(result.recipients.includes('arun.satyan@hyreo.com'));
    const after = db.get('SELECT COUNT(*) AS count FROM email_logs WHERE template_code = ?', ['APPROVAL_REMINDER']).count;
    assert.equal(after, before + 1);
    await call('POST', `/api/change-requests/${pending.id}/remind`, {}, { as: 'manager', expect: 409 });
    await call('POST', `/api/change-requests/${draft.id}/remind`, {}, { as: 'manager', expect: 409 });
  });

  await step('8  the scheduler escalates a stuck approval exactly once', async () => {
    db.run("UPDATE change_request_approvals SET requested_at = ? WHERE cr_id = ? AND status = 'PENDING'", [
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
      pending.id
    ]);
    const first = await call('POST', '/api/reminders/run');
    assert.ok(first.escalations >= 1, 'escalation sent');
    const escalations = db.get('SELECT COUNT(*) AS count FROM email_logs WHERE template_code = ?', ['ESCALATION_NOTICE']).count;
    assert.ok(escalations >= 1);
    const second = await call('POST', '/api/reminders/run');
    assert.equal(second.escalations, 0, 'no repeat escalation');
    const history = await call('GET', `/api/change-requests/${pending.id}/reminders`);
    assert.ok(history.some((r) => r.kind === 'ESCALATION'));
    assert.ok(history.some((r) => r.trigger_type === 'MANUAL'));
    await call('POST', '/api/reminders/run', {}, { as: 'manager', expect: 403 });
  });

  await step('9  version comparison shows what a revision changed', async () => {
    const detail = await call('GET', `/api/change-requests/${copy.id}`);
    await call('PUT', `/api/change-requests/${copy.id}/costs`, { billing_rate: 2500 });
    const first = await call('GET', `/api/change-requests/${copy.id}/compare`);
    assert.equal(first.available, false, 'nothing to compare before the first submission');

    await call('POST', `/api/change-requests/${copy.id}/submit`);
    await call('POST', `/api/change-requests/${copy.id}/reject`, { comments: 'Please reduce the testing effort.' });
    await call('PATCH', `/api/change-requests/${copy.id}`, { title: `${detail.title} (revised)` });
    const efforts = detail.efforts.map((e) => ({ category: e.category, hours: e.category === 'TESTING' ? Math.max(0, e.hours - 4) : e.hours }));
    await call('PUT', `/api/change-requests/${copy.id}/efforts`, efforts);

    const editing = await call('GET', `/api/change-requests/${copy.id}/compare`);
    assert.equal(editing.available, true);
    assert.equal(editing.mode, 'since_last_submission');
    assert.ok(editing.changes.some((c) => c.label === 'Title'), 'title change listed');
    assert.ok(editing.changes.some((c) => c.section === 'Effort'), 'effort change listed');

    await call('POST', `/api/change-requests/${copy.id}/submit`);
    const resubmitted = await call('GET', `/api/change-requests/${copy.id}/compare`);
    assert.equal(resubmitted.mode, 'between_submissions');
    assert.ok(resubmitted.changes.some((c) => c.label === 'Title'));
  });

  await step('10 contract renewal and budget are reported', async () => {
    const account = await call('GET', `/api/accounts/${pending.account_id}`);
    assert.ok(account.primary_msa.budget, 'budget block present');
    assert.ok('committed' in account.primary_msa.budget);
    assert.ok(account.primary_msa.renewal.state);

    db.run('UPDATE msa_contracts SET contract_end_date = ? WHERE id = ?', [
      new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
      account.primary_msa.id
    ]);
    const dashboard = await call('GET', '/api/dashboard');
    const expiring = dashboard.renewals.find((r) => r.id === account.primary_msa.id);
    assert.ok(expiring, 'MSA ending within the window is listed');
    assert.equal(expiring.state, 'expiring');
    const cr = await call('GET', `/api/change-requests/${pending.id}`);
    assert.equal(cr.contract.renewal.state, 'expiring');
  });

  await step('11 chat test refuses until a webhook is configured', async () => {
    await call('POST', '/api/integrations/chat/test', {}, { expect: 409 });
  });

  console.log(`\n${passed} checks passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  console.error(error.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
