/**
 * End-to-end workflow test.
 * Runs the real server against a throwaway database and walks the whole
 * lifecycle: OTP login -> account -> CR -> submit -> approve (portal OTP) ->
 * document -> share -> customer OTP -> sign -> completed -> reports.
 *
 *   node tests/smoke.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrms-test-'));
process.env.STORAGE_DIR = tmp;
process.env.DATABASE_FILE = path.join(tmp, 'test.db');
process.env.PORT = String(4300 + Math.floor(Math.random() * 300));
process.env.APP_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.NODE_ENV = 'test';
process.env.SEED_ON_BOOT = 'true';

const BASE = process.env.APP_URL;
const cookieJars = { app: new Map(), portal: new Map() };

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function step(label, fn) {
  try {
    const result = await fn();
    ok(label);
    return result;
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${label}\n     ${error.message}`);
    throw error;
  }
}

function jar(name) {
  if (!cookieJars[name]) cookieJars[name] = new Map();
  return Array.from(cookieJars[name].entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(response, jarName) {
  if (!cookieJars[jarName]) cookieJars[jarName] = new Map();
  for (const cookie of response.headers.getSetCookie?.() || []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    cookieJars[jarName].set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)));
  }
}

async function api(method, url, body, { jarName = 'app', raw = false } = {}) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: jar(jarName)
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual'
  });

  storeCookies(response, jarName);

  if (raw) return response;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `HTTP ${response.status}`;
    const details = payload?.error?.details ? ` :: ${JSON.stringify(payload.error.details)}` : '';
    throw new Error(`${method} ${url} -> ${response.status} ${message}${details}`);
  }
  return payload.data;
}

const MASTER_CODE = '011235';

/**
 * The master code needs no outstanding challenge, so tests do not request one —
 * requesting repeatedly for the same address would hit the resend cooldown.
 */
async function login(email, jarName = 'app') {
  const response = await fetch(`${BASE}/api/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code: MASTER_CODE })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message);
  storeCookies(response, jarName);
  return payload.data.user;
}

async function main() {
  await import('../server.js');
  await new Promise((resolve) => setTimeout(resolve, 600));

  console.log('\nHyreo Account Management — end-to-end workflow\n');

  const admin = await step('1  email OTP login issues a session', async () => {
    const request = await fetch(`${BASE}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sahaf@hyreo.com' })
    });
    const requested = await request.json();
    assert.ok(requested.data?.sent, 'the code is issued');
    assert.equal(requested.data.dev_code, undefined, 'one-time codes must never be returned over HTTP');
    return login('sahaf@hyreo.com');
  });
  assert.equal(admin.role_code, 'ADMIN');

  await step('1b master OTP signs in while a wrong code still fails', async () => {
    const request = await fetch(`${BASE}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cr.manager@hyreo.com' })
    });
    const { data } = await request.json();
    assert.equal(data.dev_code, undefined, 'the emailed code stays out of the response');
    assert.equal(data.master_code, undefined, 'the master code is not advertised over HTTP either');

    const bad = await fetch(`${BASE}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cr.manager@hyreo.com', code: '000000' })
    });
    assert.equal(bad.status, 400, 'an arbitrary code is still rejected');

    const good = await fetch(`${BASE}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'cr.manager@hyreo.com', code: '011235' })
    });
    assert.equal(good.status, 200, 'the master code is accepted');

    // an unregistered address is a dead end unless the error says so
    const unknown = await fetch(`${BASE}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@hyreo.com', code: '011235' })
    });
    const unknownBody = await unknown.json();
    assert.equal(unknown.status, 400);
    assert.match(unknownBody.error.message, /No user account exists/i, 'the demo build explains an unknown address');

    // but a wrong code still gives nothing away
    const guess = await fetch(`${BASE}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@hyreo.com', code: '424242' })
    });
    const guessBody = await guess.json();
    assert.match(guessBody.error.message, /code is not correct/i, 'no user enumeration without the master code');
  });

  await step('2  seeded CR reproduces the source document', async () => {
    const list = await api('GET', '/api/change-requests?q=PEERISLANDS');
    const cr = list.rows.find((r) => r.cr_number === 'PEERISLANDS-CR-001');
    assert.ok(cr, 'PEERISLANDS-CR-001 exists');
    assert.equal(cr.cr_reference, 'PEERISLANDS-0001-01');
    assert.equal(cr.total_effort, 24);
    assert.equal(cr.total_cost, 0, 'CR cost is zero after the full discount');
  });

  const account = await step('3  account + MSA created with contacts', async () =>
    api('POST', '/api/accounts', {
      account: {
        account_name: 'Northwind Trading',
        account_code: 'NORTHWIND',
        legal_entity_name: 'Northwind Trading Ltd',
        customer_type: 'Enterprise',
        industry: 'Retail',
        country: 'United Kingdom',
        internal_approver_name: 'Arun Satyan',
        internal_approver_email: 'arun.satyan@hyreo.com'
      },
      msa: {
        msa_reference_number: 'NORTHWIND-0001',
        msa_date: '2026-01-15',
        contract_start_date: '2026-02-01',
        contract_end_date: '2028-01-31',
        currency: 'INR',
        payment_terms: '30 days',
        po_required: true,
        status: 'ACTIVE'
      },
      primary_contact: { name: 'Ada Clarke', email: 'ada.clarke@northwind.example', designation: 'Head of HR' },
      approval_contact: { name: 'Ben Shaw', email: 'ben.shaw@northwind.example', designation: 'COO' }
    })
  );
  assert.match(account.id, /^ACC-\d{4}$/);
  assert.equal(account.primary_msa.msa_reference_number, 'NORTHWIND-0001');

  await step('3b an account can be created from an uploaded MSA', async () => {
    const contract = [
      'MASTER SUBSCRIPTION AGREEMENT',
      '',
      'This Master Subscription Agreement is dated 14 March 2026 and is entered into by and between',
      'Hyreo Services India Private Limited (the "Supplier") and Globex Retail Solutions Pvt Ltd (the "Customer").',
      '',
      'MSA Reference Number: GLOBEX-2026-002',
      'Effective Date: 01 April 2026',
      'Expiry Date: 31 March 2029',
      'Total Contract Value: INR 4,500,000',
      'Payment Terms: 45 days from the date of invoice',
      'A valid purchase order is required before any work commences.',
      'This agreement is governed by the laws of India.',
      'Customer contact: priya.nair@globex.example'
    ].join('\n');

    const upload = await api('POST', '/api/accounts/msa-documents', {
      fileName: 'globex-msa.txt',
      contentType: 'text/plain',
      base64: Buffer.from(contract, 'utf8').toString('base64')
    });

    assert.equal(upload.document_kind, 'TEXT');
    assert.equal(upload.confidence, 'HIGH');
    assert.equal(upload.fields.msa_reference_number, 'GLOBEX-2026-002');
    assert.equal(upload.fields.msa_date, '2026-03-14');
    assert.equal(upload.fields.contract_start_date, '2026-04-01');
    assert.equal(upload.fields.contract_end_date, '2029-03-31');
    assert.equal(upload.fields.legal_entity_name, 'Globex Retail Solutions Pvt Ltd');
    assert.equal(upload.fields.contract_value, 4500000);
    assert.equal(upload.fields.currency, 'INR');
    assert.equal(upload.fields.payment_terms, '45 days from the date of invoice');
    assert.equal(upload.fields.po_required, true);
    assert.ok(upload.evidence.msa_reference_number, 'each field carries the snippet it came from');
    assert.ok(upload.emails.includes('priya.nair@globex.example'));

    const created = await api('POST', '/api/accounts', {
      msa_document_id: upload.id,
      account: {
        account_name: upload.fields.account_name,
        account_code: upload.fields.account_code,
        legal_entity_name: upload.fields.legal_entity_name,
        country: upload.fields.country,
        internal_approver_name: 'Arun Satyan',
        internal_approver_email: 'arun.satyan@hyreo.com'
      },
      msa: {
        msa_reference_number: upload.fields.msa_reference_number,
        msa_date: upload.fields.msa_date,
        contract_start_date: upload.fields.contract_start_date,
        contract_end_date: upload.fields.contract_end_date,
        contract_value: upload.fields.contract_value,
        currency: upload.fields.currency,
        payment_terms: upload.fields.payment_terms,
        po_required: upload.fields.po_required,
        status: 'ACTIVE'
      }
    });

    assert.equal(created.primary_msa.msa_reference_number, 'GLOBEX-2026-002');
    assert.ok(created.primary_msa.document, 'the uploaded MSA is attached to the MSA it created');
    assert.equal(created.primary_msa.document.id, upload.id);

    // and it can be opened again later
    const stored = await api('GET', `/api/msas/${created.primary_msa.id}/document`);
    assert.equal(stored.file_name, 'globex-msa.txt');
    const download = await api('GET', `/api/accounts/msa-documents/${upload.id}/download`, undefined, { raw: true });
    assert.equal(download.status, 200);
    const body = await download.text();
    assert.match(body, /GLOBEX-2026-002/, 'the original contract is served back verbatim');

    const anonymous = await fetch(`${BASE}/api/accounts/msa-documents/${upload.id}/download`);
    assert.equal(anonymous.status, 401, 'contracts are never public');
  });

  await step('3c large MSAs upload, and unknown API routes answer in JSON', async () => {
    // a real contract easily exceeds the general 2 MB body limit
    const filler = 'This Master Subscription Agreement contains standard boilerplate. '.repeat(60000);
    const contract = ['MASTER SUBSCRIPTION AGREEMENT', '', 'MSA Reference Number: BIGDOC-0001', 'Effective Date: 01 April 2026', filler].join(String.fromCharCode(10));
    const base64 = Buffer.from(contract, 'utf8').toString('base64');
    assert.ok(base64.length > 4 * 1024 * 1024, 'the payload must exceed the general body limit for this to mean anything');

    const upload = await api('POST', '/api/accounts/msa-documents', {
      fileName: 'big-msa.txt',
      contentType: 'text/plain',
      base64
    });
    assert.equal(upload.fields.msa_reference_number, 'BIGDOC-0001');

    // and a route that does not exist must not fall through to the SPA shell
    const missing = await fetch(`${BASE}/api/accounts/does-not-exist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: jar('app') },
      body: '{}'
    });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('content-type') || '', /application\/json/, 'API errors are always JSON');
    const body = await missing.json();
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await step('3d unreadable PDF text is rejected rather than offered as data', async () => {
    const { looksLikeText } = await import('../src/lib/textExtract.js');
    const { analyse } = await import('../src/services/msaExtract.js');

    // what a CID-encoded font decodes to when read as characters
    const garbage = 'IdentityAdobeUü:!JöÖ1ÂØÅÔÕØê>ÒÿÇu§!-8ÑÀÒÒó©¸';
    assert.equal(looksLikeText(garbage), false, 'glyph noise must not pass as text');
    assert.equal(looksLikeText('Master Subscription Agreement dated 01 April 2026 between two parties.'), true);

    const analysed = analyse(garbage.repeat(20));
    assert.equal(analysed.found, 0, 'nothing is extracted from unreadable text');
    assert.equal(analysed.confidence, 'NONE');

    // a label followed by binary noise must not become a field value
    const poisoned = `MSA Reference Number: 
${'Some readable contract prose here. '.repeat(4)}`;
    assert.equal(analyse(poisoned).fields.msa_reference_number, undefined, 'binary values are refused');
  });

  await step('3e a PDF with subset fonts in object streams is decoded', async () => {
    const { extractText } = await import('../src/lib/textExtract.js');

    // A contract exported from Word draws text as glyph codes with a /ToUnicode
    // table, and hides its font dictionary inside a compressed object stream.
    // This fixture is that shape in miniature.
    const sentence = 'MASTER SUBSCRIPTION AGREEMENT REFERENCE';
    const codes = [...sentence]
      .map((ch) => (ch === ' ' ? 0x1b : ch.charCodeAt(0) - 64))
      .map((code) => code.toString(16).padStart(4, '0'))
      .join('');

    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      '1 beginbfrange',
      '<0001> <001A> <0041>',
      'endbfrange',
      '1 beginbfchar',
      '<001B> <0020>',
      'endbfchar',
      'endcmap end end'
    ].join('\n');

    const fontDict = '<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>';
    const objStmHeader = '5 0 ';
    const objStmBody = `${objStmHeader}${fontDict}`;
    const content = `BT /F1 12 Tf <${codes}> Tj ET`;

    const parts = [
      '%PDF-1.7',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
      `4 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream endobj`,
      `7 0 obj << /Type /ObjStm /N 1 /First ${objStmHeader.length} /Length ${objStmBody.length} >>\nstream\n${objStmBody}\nendstream endobj`,
      `6 0 obj << /Length ${cmap.length} >>\nstream\n${cmap}\nendstream endobj`,
      'trailer << /Root 1 0 R >>',
      '%%EOF'
    ];

    const pdf = Buffer.from(parts.join('\n'), 'latin1');
    const result = extractText(pdf, { fileName: 'subset-font.pdf' });

    assert.equal(result.kind, 'PDF');
    assert.match(
      result.text,
      /MASTER SUBSCRIPTION AGREEMENT REFERENCE/,
      `glyph codes were not decoded through the /ToUnicode table (got: ${JSON.stringify(result.text.slice(0, 80))})`
    );
    assert.equal(result.warnings.length, 0);
  });

  await step('4  duplicate MSA reference is rejected', async () => {
    await assert.rejects(
      () =>
        api('POST', '/api/accounts', {
          account: { account_name: 'Copycat Ltd', legal_entity_name: 'Copycat Ltd' },
          msa: { msa_reference_number: 'NORTHWIND-0001', msa_date: '2026-01-15', contract_start_date: '2026-02-01' }
        }),
      /already registered/i
    );
  });

  const cr = await step('5  change request created with auto-numbering', async () => {
    const created = await api('POST', '/api/change-requests', {
      account_id: account.id,
      title: 'Bulk candidate import',
      cr_date: '2026-04-01',
      cr_type: 'NEW_FEATURE',
      priority: 'HIGH',
      requested_by: 'Ada Clarke'
    });
    assert.equal(created.cr_number, 'NORTHWIND-CR-001');
    assert.equal(created.cr_reference, 'NORTHWIND-0001-01');
    assert.equal(created.snapshot_msa_number, 'NORTHWIND-0001', 'MSA details are snapshotted');
    return created;
  });

  await step('6  scope items saved and renumbered', async () => {
    const items = await api('PUT', `/api/change-requests/${cr.id}/items`, {
      items: [
        { feature_name: 'CSV import', requested_change: 'Import candidates from CSV', release_date: '2026-05-01' },
        { feature_name: 'Duplicate detection', requested_change: 'Flag duplicates on import', release_date: '2026-05-01' }
      ]
    });
    assert.equal(items.length, 2);
    assert.equal(items[1].item_no, 2);
  });

  await step('7  effort and cost calculate server-side', async () => {
    const effort = await api('PUT', `/api/change-requests/${cr.id}/efforts`, {
      efforts: [
        { category: 'DEVELOPMENT', hours: 30 },
        { category: 'TESTING', hours: 10 },
        { category: 'BUSINESS_ANALYSIS', hours: 5 }
      ]
    });
    assert.equal(effort.costs.total_effort, 45);

    const costs = await api('PUT', `/api/change-requests/${cr.id}/costs`, {
      billing_rate: 2000,
      currency: 'INR',
      discount_type: 'PERCENT',
      discount_value: 10,
      tax_percent: 18
    });
    assert.equal(costs.subtotal, 90000);
    assert.equal(costs.discount_amount, 9000);
    assert.equal(costs.tax_amount, 14580);
    assert.equal(costs.total_cost, 95580);
  });

  await step('8  draft document version 1.0 generated in the agreed layout', async () => {
    const result = await api('POST', `/api/change-requests/${cr.id}/documents/generate`, { format: 'BOTH' });
    assert.equal(result.version, '1.0');
    assert.equal(result.files.length, 2);

    const { readZip } = await import('../src/lib/unzip.js');
    const docx = result.files.find((file) => file.format === 'DOCX');
    const bytes = fs.readFileSync(path.join(process.env.STORAGE_DIR, docx.file_path));
    const xml = readZip(bytes).get('word/document.xml').toString('utf8');

    // the cost table is label + amount; no empty third column
    const grids = [...xml.matchAll(/<w:tblGrid>(.*?)<\/w:tblGrid>/g)].map(
      (m) => (m[1].match(/<w:gridCol/g) || []).length
    );
    assert.deepEqual(grids, [2, 5, 2, 2], 'reference, scope, cost and signature tables have the agreed column counts');
    assert.ok(!/Document version/.test(xml), 'the generated-by line is not printed in the document');

    const pdf = result.files.find((file) => file.format === 'PDF');
    const { extractText } = await import('../src/lib/textExtract.js');
    const pdfText = extractText(fs.readFileSync(path.join(process.env.STORAGE_DIR, pdf.file_path)), { fileName: 'x.pdf' }).text;
    assert.ok(!/Document version/.test(pdfText), 'nor in the PDF');
    assert.match(pdfText, /Total Change Request \(CR\) Cost/, 'the cost table still reads correctly');
  });

  await step('9  submit moves the CR to pending approval and locks it', async () => {
    const before = (await api('GET', `/api/change-requests/${cr.id}/documents`)).length;
    const submitted = await api('POST', `/api/change-requests/${cr.id}/submit`);

    // automatic generation produces one file, not a pair
    const afterDocuments = await api('GET', `/api/change-requests/${cr.id}/documents`);
    assert.equal(afterDocuments.length, before + 1, 'submission generates a single document');
    assert.equal(afterDocuments[0].format, 'PDF', 'in the configured default format');
    assert.equal(submitted.status, 'PENDING_INTERNAL_APPROVAL');
    assert.equal(submitted.locked, 1);
    await assert.rejects(
      () => api('PATCH', `/api/change-requests/${cr.id}`, { title: 'Sneaky edit' }),
      /locked|cannot be edited/i
    );
  });

  const approvalLink = await step('10 approval email contains a secure review link', async () => {
    const emails = await api('GET', `/api/emails?crId=${cr.id}`);
    const approvalEmail = emails.rows.find((e) => e.template_code === 'INTERNAL_APPROVAL_REQUEST');
    assert.ok(approvalEmail, 'approver received an email');
    assert.equal(approvalEmail.to_email, 'arun.satyan@hyreo.com');
    const full = await api('GET', `/api/emails/${approvalEmail.id}`);
    const match = full.body_html.match(/\/s\/([A-Za-z0-9_-]+)/);
    assert.ok(match, 'email carries a portal link');
    return match[1];
  });

  await step('11 approver portal requires OTP on the bound address', async () => {
    const context = await api('GET', `/api/portal/${approvalLink}`, undefined, { jarName: 'portal' });
    assert.equal(context.audience, 'APPROVER');
    assert.match(context.masked_email, /\*/);

    await assert.rejects(
      () => api('POST', `/api/portal/${approvalLink}/otp/request`, { email: 'attacker@evil.example' }, { jarName: 'portal' }),
      /does not match/i
    );
    await assert.rejects(
      () => api('GET', `/api/portal/${approvalLink}/cr`, undefined, { jarName: 'portal' }),
      /verify your email/i
    );
  });

  await step('12 approver verifies OTP and approves', async () => {
    const otp = await api('POST', `/api/portal/${approvalLink}/otp/request`, { email: 'arun.satyan@hyreo.com' }, { jarName: 'portal' });
    assert.equal(otp.dev_code, undefined, 'portal codes are not returned over HTTP');
    await api('POST', `/api/portal/${approvalLink}/otp/verify`, { email: 'arun.satyan@hyreo.com', code: MASTER_CODE }, { jarName: 'portal' });

    const view = await api('GET', `/api/portal/${approvalLink}/cr`, undefined, { jarName: 'portal' });
    assert.equal(view.cr.cr_number, 'NORTHWIND-CR-001');
    assert.equal(view.decision.can_decide, true);

    await api('POST', `/api/portal/${approvalLink}/approve`, { comments: 'Approved, proceed.' }, { jarName: 'portal' });
    const after = await api('GET', `/api/change-requests/${cr.id}`);
    assert.equal(after.status, 'READY_FOR_CUSTOMER');
    const finals = after.documents.filter((d) => d.status === 'FINAL');
    assert.equal(finals.length, 1, 'approval generates a single final document');
    assert.equal(finals[0].version, '2.0');
    assert.equal(finals[0].format, 'PDF');
    assert.equal(finals[0].is_locked, 1);

    // the Word counterpart joins the same approved version rather than starting a new one
    const companion = await api('POST', `/api/change-requests/${cr.id}/documents/generate`, { format: 'DOCX' });
    assert.equal(companion.version, '2.0', 'the companion format keeps the approved version number');
    assert.equal(companion.status, 'FINAL');
    assert.equal(companion.files.length, 1);

    const withCompanion = await api('GET', `/api/change-requests/${cr.id}/documents`);
    const finalFormats = withCompanion.filter((d) => d.status === 'FINAL' && d.version === '2.0').map((d) => d.format).sort();
    assert.deepEqual(finalFormats, ['DOCX', 'PDF']);
  });

  await step('13 rejection requires a reason', async () => {
    await assert.rejects(
      () => api('POST', `/api/change-requests/${cr.id}/reject`, { comments: '' }),
      /required|reason/i
    );
  });

  await step('13b reject -> edit -> resubmit -> approve completes a revision cycle', async () => {
    const revisionCr = await api('POST', '/api/change-requests', {
      account_id: account.id,
      title: 'Candidate merge tool',
      cr_date: '2026-04-10',
      cr_type: 'ENHANCEMENT',
      priority: 'MEDIUM'
    });
    await api('PUT', `/api/change-requests/${revisionCr.id}/items`, {
      items: [{ feature_name: 'Merge duplicates', requested_change: 'Merge duplicate candidate records' }]
    });
    await api('PUT', `/api/change-requests/${revisionCr.id}/efforts`, { efforts: [{ category: 'DEVELOPMENT', hours: 10 }] });
    await api('PUT', `/api/change-requests/${revisionCr.id}/costs`, { billing_rate: 2000, currency: 'INR' });
    await api('POST', `/api/change-requests/${revisionCr.id}/submit`);

    // reject it
    const rejected = await api('POST', `/api/change-requests/${revisionCr.id}/reject`, {
      comments: 'Scope is too vague, please detail the merge rules.'
    });
    assert.equal(rejected.status, 'REVISION', 'a rejected CR moves into revision, not back to a plain draft');
    assert.equal(rejected.status_label, 'Under Revision');
    assert.equal(rejected.locked, 0, 'a CR under revision is unlocked for editing');
    assert.equal(rejected.revision, 1);
    assert.match(rejected.internal_rejection_comments, /merge rules/);
    assert.equal(rejected.is_editable, true, 'the CR must be editable after rejection');

    const firstDecision = rejected.approvals.find((a) => a.status === 'REJECTED');
    assert.ok(firstDecision, 'the rejection is retained in the approval history');

    // work sent back must stay visible on the dashboard and in the register
    const dashDuringRevision = await api('GET', '/api/dashboard');
    assert.ok(dashDuringRevision.kpis.revision_crs >= 1, 'the dashboard counts CRs under revision');
    assert.ok(
      dashDuringRevision.kpis.rejected_crs >= 1,
      'a CR sent back for revision still counts as rejected work'
    );
    assert.ok(
      dashDuringRevision.charts.by_status.some((row) => row.key === 'REVISION' && row.label === 'Under Revision'),
      'the status chart distinguishes revisions'
    );
    const revisionList = await api('GET', '/api/change-requests?statusGroup=REVISION');
    assert.ok(
      revisionList.rows.some((row) => row.id === revisionCr.id),
      'the register can be filtered to CRs under revision'
    );

    // edit it — this is what the Edit button opens
    const edited = await api('PATCH', `/api/change-requests/${revisionCr.id}`, {
      title: 'Candidate merge tool (revised)'
    });
    assert.equal(edited.title, 'Candidate merge tool (revised)');
    await api('PUT', `/api/change-requests/${revisionCr.id}/items`, {
      items: [
        { feature_name: 'Merge duplicates', requested_change: 'Merge duplicate candidate records' },
        { feature_name: 'Merge rules', requested_change: 'Match on email, then phone, then name + DOB' }
      ]
    });

    const documentsBefore = (await api('GET', `/api/change-requests/${revisionCr.id}/documents`)).length;

    // resubmit for approval
    const resubmitted = await api('POST', `/api/change-requests/${revisionCr.id}/submit`);
    assert.equal(resubmitted.status, 'PENDING_INTERNAL_APPROVAL');
    assert.equal(resubmitted.locked, 1);

    const pending = resubmitted.approvals.filter((a) => a.status === 'PENDING');
    assert.equal(pending.length, 1, 'exactly one fresh approval is pending after resubmission');
    assert.equal(pending[0].revision, 1, 'the new approval belongs to the current revision');
    assert.ok(
      resubmitted.approvals.some((a) => a.status === 'REJECTED'),
      'the earlier rejection stays on the record'
    );

    // the approver must review the edited content, not the pre-rejection draft
    const documentsAfter = await api('GET', `/api/change-requests/${revisionCr.id}/documents`);
    assert.ok(documentsAfter.length > documentsBefore, 'resubmission regenerates the review document');
    assert.match(documentsAfter[0].notes || '', /resubmission/i);

    // approve the revision
    const approved = await api('POST', `/api/change-requests/${revisionCr.id}/approve`, { comments: 'Clear now.' });
    assert.equal(approved.status, 'READY_FOR_CUSTOMER');
    assert.ok(approved.documents.some((d) => d.status === 'FINAL'), 'approval produces a final document');

    const trail = await api('GET', `/api/change-requests/${revisionCr.id}/audit`);
    const actions = trail.map((row) => row.action);
    assert.ok(actions.filter((a) => a === 'CR_SUBMITTED').length >= 2, 'both submissions are audited');
    assert.ok(actions.includes('CR_REJECTED') && actions.includes('CR_APPROVED'), 'both decisions are audited');
  });

  await step('13c a decided approval closes its own notification', async () => {
    const approverLogin = 'arun.satyan@hyreo.com';
    const notifyCr = await api('POST', '/api/change-requests', {
      account_id: account.id,
      title: 'Notification lifecycle check'
    });
    await api('PUT', `/api/change-requests/${notifyCr.id}/items`, {
      items: [{ feature_name: 'Something', requested_change: 'Do something' }]
    });
    await api('PUT', `/api/change-requests/${notifyCr.id}/efforts`, { efforts: [{ category: 'DEVELOPMENT', hours: 4 }] });
    await api('PUT', `/api/change-requests/${notifyCr.id}/costs`, { billing_rate: 2000, currency: 'INR' });
    await api('POST', `/api/change-requests/${notifyCr.id}/submit`);

    await login(approverLogin, 'notify');
    const requested = await api('GET', '/api/notifications?limit=100', undefined, { jarName: 'notify' });
    const request = requested.rows.find((row) => row.cr_id === notifyCr.id && row.type === 'CR_APPROVAL_REQUESTED');
    assert.ok(request, 'the approver is asked to approve');

    // resubmitting must not stack a second request for the same CR
    await api('POST', `/api/change-requests/${notifyCr.id}/reject`, { comments: 'Needs more detail please.' });
    await api('POST', `/api/change-requests/${notifyCr.id}/submit`);
    const afterResubmit = await api('GET', '/api/notifications?limit=100', undefined, { jarName: 'notify' });
    const outstanding = afterResubmit.rows.filter((row) => row.cr_id === notifyCr.id && row.type === 'CR_APPROVAL_REQUESTED');
    assert.equal(outstanding.length, 1, 'a new request replaces the previous one');

    await api('POST', `/api/change-requests/${notifyCr.id}/approve`, { comments: 'Fine now.' });
    const afterApproval = await api('GET', '/api/notifications?limit=100', undefined, { jarName: 'notify' });
    assert.ok(
      !afterApproval.rows.some((row) => row.cr_id === notifyCr.id && row.type === 'CR_APPROVAL_REQUESTED'),
      'once decided, the approval request closes itself'
    );
  });

  const customerLink = await step('14 shared with the customer with attachments', async () => {
    const defaults = await api('GET', `/api/change-requests/${cr.id}/share/defaults`);
    assert.equal(defaults.to, 'ben.shaw@northwind.example');

    const shared = await api('POST', `/api/change-requests/${cr.id}/share`, {
      to: defaults.to,
      subject: defaults.subject,
      message: defaults.message,
      attach_docx: true,
      attach_pdf: true
    });
    assert.equal(shared.attachments.length, 2);

    const after = await api('GET', `/api/change-requests/${cr.id}`);
    assert.equal(after.status, 'SENT_TO_CUSTOMER');
    return shared.portal_url.split('/s/')[1];
  });

  await step('15 customer OTP, view marks CUSTOMER_APPROVAL_PENDING', async () => {
    await api('POST', `/api/portal/${customerLink}/otp/request`, { email: 'ben.shaw@northwind.example' }, { jarName: 'portal' });
    await api('POST', `/api/portal/${customerLink}/otp/verify`, { email: 'ben.shaw@northwind.example', code: MASTER_CODE }, { jarName: 'portal' });
    const view = await api('GET', `/api/portal/${customerLink}/cr`, undefined, { jarName: 'portal' });
    assert.equal(view.audience, 'CUSTOMER');
    assert.equal(view.cr.internal_approver, undefined, 'internal ownership is hidden from the customer');
    const after = await api('GET', `/api/change-requests/${cr.id}`);
    assert.equal(after.status, 'CUSTOMER_APPROVAL_PENDING');
  });

  await step('15b customer rejection requires comments', async () => {
    await assert.rejects(
      () => api('POST', `/api/portal/${customerLink}/reject`, { comments: '' }, { jarName: 'portal' }),
      /required|reason/i
    );
    await assert.rejects(
      () => api('POST', `/api/portal/${customerLink}/sign`, { signature_name: 'Ben Shaw', consent: false }, { jarName: 'portal' }),
      /consent|confirm/i
    );
  });

  await step('16 customer signs -> SIGNED -> COMPLETED with a signed PDF', async () => {
    await api('POST', `/api/portal/${customerLink}/sign`, { signature_name: 'Ben Shaw', designation: 'COO', consent: true }, { jarName: 'portal' });
    const after = await api('GET', `/api/change-requests/${cr.id}`);
    assert.equal(after.status, 'COMPLETED');
    assert.ok(after.completed_at);
    const signed = after.documents.find((d) => d.status === 'SIGNED');
    assert.ok(signed, 'signed document stored');
    assert.equal(after.customer_approvals[0].status, 'APPROVED');
  });

  await step('17 completed change requests cannot be modified or deleted', async () => {
    await assert.rejects(() => api('PATCH', `/api/change-requests/${cr.id}`, { title: 'x' }), /cannot be edited|locked/i);
    await assert.rejects(() => api('DELETE', `/api/change-requests/${cr.id}`), /draft/i);
  });

  await step('17b account deletion is blocked while contractual CRs exist', async () => {
    const impact = await api('GET', `/api/accounts/${account.id}/deletion-impact`);
    assert.equal(impact.can_delete, false, 'an account with a completed CR cannot be deleted');
    assert.match(impact.reason, /contractual records/i);
    await assert.rejects(() => api('DELETE', `/api/accounts/${account.id}`), /contractual records/i);

    // deactivation is the supported alternative
    const deactivated = await api('POST', `/api/accounts/${account.id}/status`, { status: 'INACTIVE' });
    assert.equal(deactivated.status, 'INACTIVE');
    await api('POST', `/api/accounts/${account.id}/status`, { status: 'ACTIVE' });
  });

  await step('17c an account with only drafts deletes after typed confirmation', async () => {
    const throwaway = await api('POST', '/api/accounts', {
      account: { account_name: 'Temporary Holdings', account_code: 'TEMPHOLD', legal_entity_name: 'Temporary Holdings Ltd' },
      msa: { msa_reference_number: 'TEMPHOLD-0001', msa_date: '2026-01-01', contract_start_date: '2026-01-01' }
    });
    const draft = await api('POST', '/api/change-requests', { account_id: throwaway.id, title: 'Throwaway draft' });
    await api('POST', `/api/change-requests/${draft.id}/documents/generate`, { format: 'PDF' });

    const impact = await api('GET', `/api/accounts/${throwaway.id}/deletion-impact`);
    assert.equal(impact.can_delete, true);
    assert.equal(impact.requires_confirmation, true);
    assert.equal(impact.draft_change_requests.length, 1);

    await assert.rejects(
      () => api('DELETE', `/api/accounts/${throwaway.id}?confirm=wrong+name`),
      /Type the account name/i
    );

    const result = await api('DELETE', `/api/accounts/${throwaway.id}?confirm=${encodeURIComponent('Temporary Holdings')}`);
    assert.equal(result.deleted, true);
    assert.equal(result.deleted_change_requests, 1);

    await assert.rejects(() => api('GET', `/api/accounts/${throwaway.id}`), /not found/i);
    await assert.rejects(() => api('GET', `/api/change-requests/${draft.id}`), /not found/i);

    // the generated document of the deleted draft is gone with it
    const documents = await api('GET', '/api/documents?q=TEMPHOLD');
    assert.equal(documents.total, 0, 'documents of a deleted draft are removed');
  });

  await step('18 audit trail is complete and append-only', async () => {
    const trail = await api('GET', `/api/change-requests/${cr.id}/audit`);
    const actions = new Set(trail.map((row) => row.action));
    for (const expected of ['CR_CREATED', 'CR_SUBMITTED', 'CR_APPROVED', 'STATUS_CHANGED', 'DOCUMENT_GENERATED', 'SHARED_WITH_CUSTOMER', 'CUSTOMER_VIEWED', 'CUSTOMER_SIGNED']) {
      assert.ok(actions.has(expected), `audit contains ${expected}`);
    }
    const { db } = await import('../src/db/index.js');
    assert.throws(() => db.exec("UPDATE audit_logs SET action = 'TAMPERED'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM audit_logs'), /append-only/);
  });

  await step('18b notifications can be cleared once read', async () => {
    const before = await api('GET', '/api/notifications?limit=100');
    assert.ok(before.rows.length > 0, 'the workflow produced notifications');

    const target = before.rows[0];
    await api('POST', `/api/notifications/${target.id}/read`);
    await api('DELETE', `/api/notifications/${target.id}`);

    const afterOne = await api('GET', '/api/notifications?limit=100');
    assert.equal(afterOne.total, before.total - 1, 'a read notification can still be dismissed');
    assert.ok(!afterOne.rows.some((row) => row.id === target.id));

    await api('DELETE', '/api/notifications');
    const cleared = await api('GET', '/api/notifications?limit=100');
    assert.equal(cleared.total, 0, 'clear all empties the list');
    assert.equal(cleared.unread, 0);
  });

  await step('19 role-based access control is enforced server-side', async () => {
    await login('viewer@hyreo.com', 'viewer');
    await assert.rejects(
      () =>
        api('POST', '/api/change-requests', { account_id: account.id, title: 'Nope' }, { jarName: 'viewer' }),
      /permission/i
    );
    const visible = await api('GET', '/api/change-requests', undefined, { jarName: 'viewer' });
    assert.ok(visible.total >= 1, 'viewer can still read');

    await login('arun.satyan@hyreo.com', 'approver');
    const approverView = await api('GET', '/api/change-requests', undefined, { jarName: 'approver' });
    assert.ok(approverView.rows.every((r) => r.account_name), 'approver list is scoped without error');
  });

  await step('20 dashboard, search and reports respond', async () => {
    const dash = await api('GET', '/api/dashboard');
    assert.ok(dash.kpis.total_crs >= 5);
    assert.ok(dash.charts.by_status.length > 0);

    const search = await api('GET', '/api/search?q=NORTHWIND-0001');
    assert.equal(search.msas[0].msa_reference_number, 'NORTHWIND-0001');
    assert.ok(search.change_requests.length >= 1);

    const register = await api('GET', '/api/reports/cr-register');
    assert.ok(register.rows.length >= 5);

    // MSA-wise history: opening the MSA lists every CR raised against it
    const msaId = search.msas[0].id;
    const msaHistory = await api('GET', `/api/msas/${msaId}/change-requests`);
    assert.equal(msaHistory.msa.msa_reference_number, 'NORTHWIND-0001');
    assert.ok(msaHistory.change_requests.some((row) => row.cr_number === 'NORTHWIND-CR-001'));

    const msaSummary = await api('GET', '/api/reports/msa-cr-summary');
    assert.ok(msaSummary.rows.some((row) => row.msa_reference_number === 'NORTHWIND-0001' && row.cr_count >= 1));

    for (const format of ['xlsx', 'csv', 'pdf']) {
      const response = await api('GET', `/api/reports/cr-register/export?format=${format}`, undefined, { raw: true });
      assert.equal(response.status, 200);
      const buffer = Buffer.from(await response.arrayBuffer());
      assert.ok(buffer.length > 200, `${format} export has content`);
      if (format === 'pdf') assert.equal(buffer.subarray(0, 4).toString(), '%PDF');
      if (format === 'xlsx') assert.equal(buffer.subarray(0, 2).toString(), 'PK');
    }
  });

  await step('21 document download is authorised and streams bytes', async () => {
    const versions = await api('GET', `/api/change-requests/${cr.id}/documents`);
    const pdf = versions.find((v) => v.format === 'PDF' && v.status === 'SIGNED');
    const response = await api('GET', `/api/documents/versions/${pdf.id}/download`, undefined, { raw: true });
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), '%PDF');

    const anonymous = await fetch(`${BASE}/api/documents/versions/${pdf.id}/download`);
    assert.equal(anonymous.status, 401, 'documents are never public');
  });

  await step('22 e-signature integration layer is wired', async () => {
    const status = await api('GET', '/api/settings/docusign');
    assert.equal(status.provider, 'SIMULATED');
    assert.equal(status.ready, true);
    const envelopes = await api('GET', `/api/change-requests/${cr.id}`);
    assert.ok(Array.isArray(envelopes.envelopes));
  });

  console.log(`\n${passed} checks passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nFAILED:', error.message);
  console.error(error.stack?.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
