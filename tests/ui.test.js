/**
 * Browser test: drives the real SPA in headless Edge/Chrome.
 * Covers OTP sign-in, every authenticated screen, the create-CR wizard, the
 * approver portal and the customer signature portal — failing on any console
 * error or unhandled rejection along the way.
 *
 *   node tests/ui.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
];

const executablePath = BROWSERS.find((candidate) => fs.existsSync(candidate));
if (!executablePath) {
  console.error('No Chromium-based browser found — skipping UI test.');
  process.exit(0);
}

const PORT = 4190 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrms-ui-'));
const downloads = path.join(storage, 'downloads');
fs.mkdirSync(downloads, { recursive: true });

let passed = 0;
let failed = 0;
const consoleErrors = [];

function ok(label, detail = '') {
  passed += 1;
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label, error) {
  failed += 1;
  console.error(`  \u2717 ${label}\n     ${error.message || error}`);
}

async function step(label, fn) {
  try {
    const result = await fn();
    ok(label, typeof result === 'string' ? result : '');
    return result;
  } catch (error) {
    fail(label, error);
    throw error;
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PORT: String(PORT),
        APP_URL: BASE,
        STORAGE_DIR: storage,
        DATABASE_FILE: path.join(storage, 'ui.db'),
        NODE_ENV: 'test',
        SEED_ON_BOOT: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('environment')) setTimeout(() => resolve(child), 350);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) => reject(new Error(`server exited early (${code}): ${output}`)));
    setTimeout(() => reject(new Error(`server did not start: ${output}`)), 20000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CSS text-transform changes innerText casing, so compare case-insensitively
const hasText = (haystack, needle) => String(haystack).toLowerCase().includes(String(needle).toLowerCase());

async function main() {
  const server = await startServer();
  const { browser, browserProcess } = await launchBrowser();

  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });

  // let the browser actually save files so downloads can be asserted
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (text.includes('favicon') || text.includes('Failed to load resource: the server responded with a status of 4')) return;
      consoleErrors.push(text);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

  const text = () => page.evaluate(() => document.body.innerText);
  const count = (selector) => page.evaluate((s) => document.querySelectorAll(s).length, selector);
  const go = async (path_) => {
    await page.bringToFront();
    await page.goto(`${BASE}${path_}`, { waitUntil: 'networkidle2' });
    await sleep(400);
  };

  try {
    console.log('\nHyreo Account Management — browser walkthrough\n');

    /* ---------------------------------------------------------- sign in -- */

    await step('login screen renders the email step', async () => {
      await go('/login');
      const body = await text();
      if (!hasText(body, 'Hyreo Account Management')) throw new Error('title missing');
      if (!hasText(body, 'Send OTP')) throw new Error('Send OTP button missing');
      if ((await count('.auth__brand')) !== 1) throw new Error('brand panel missing');
    });

    await step('OTP step appears with six inputs and a resend control', async () => {
      await page.type('input[type=email]', 'sahaf@hyreo.com');
      await page.click('button[type=submit]');
      await page.waitForSelector('.otp-inputs input', { timeout: 8000 });
      if ((await count('.otp-inputs input')) !== 6) throw new Error('expected six OTP boxes');
      const body = await text();
      if (!hasText(body, 'OTP verification')) throw new Error('OTP heading missing');
      if (!hasText(body, 'Resend OTP')) throw new Error('resend missing');
    });

    await step('OTP verification signs the user in with the demo master code', async () => {
      const leaked = await count('.dev-hint');
      if (leaked) throw new Error('the demo hint box is still shown on the OTP screen');
      const code = '011235';
      for (const digit of code.split('')) await page.type('.otp-inputs input:not([value])', digit).catch(() => {});
      await page.evaluate((value) => {
        document.querySelectorAll('.otp-inputs input').forEach((input, index) => {
          input.value = value[index];
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }, code);
      await page.click('form button[type=submit]');
      await page.waitForFunction(() => location.pathname === '/dashboard', { timeout: 10000 , polling: 150 });
      await sleep(900);
      return `signed in, landed on ${await page.evaluate(() => location.pathname)}`;
    });

    /* -------------------------------------------------------- dashboard -- */

    await step('dashboard renders KPI cards, charts and recent CRs', async () => {
      const kpis = await count('.kpi');
      if (kpis < 12) throw new Error(`expected 12 KPI cards, found ${kpis}`);
      const charts = await count('.chart svg');
      if (charts < 5) throw new Error(`expected 6 charts, found ${charts}`);
      const body = await text();
      for (const label of ['Total Accounts', 'Active MSAs', 'Pending Internal Approval', 'Total CR Value', 'Recent change requests']) {
        if (!hasText(body, label)) throw new Error(`missing "${label}"`);
      }
      if (!hasText(body, 'PEERISLANDS-CR-001')) throw new Error('seeded CR not listed');
      return `${kpis} KPIs, ${charts} charts`;
    });

    await step('global search finds the MSA and its change requests', async () => {
      await page.type('.search-box input', 'PEERISLANDS-0001');
      await page.waitForSelector('.search-results__item', { timeout: 6000 });
      const body = await page.$eval('.search-results', (node) => node.innerText);
      if (!hasText(body, 'PEERISLANDS-0001')) throw new Error('MSA not in results');
      if (!hasText(body, 'PEERISLANDS-CR-001')) throw new Error('CR not in results');
      await page.keyboard.press('Escape');
    });

    /* --------------------------------------------------------- accounts -- */

    await step('accounts list shows both seeded accounts', async () => {
      await go('/accounts');
      await page.waitForSelector('table.data tbody tr');
      const body = await text();
      if (!hasText(body, 'PeerIslands')) throw new Error('PeerIslands missing');
      if (!hasText(body, 'Acme Technologies')) throw new Error('Acme missing');
      if (!hasText(body, 'PEERISLANDS-0001')) throw new Error('MSA number column missing');
    });

    const accountId = await step('account detail shows MSA facts and CR history', async () => {
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('table.data tbody tr')].find((tr) => tr.innerText.includes('PeerIslands'));
        row.click();
      });
      await page.waitForFunction(() => location.pathname.startsWith('/accounts/ACC'), { timeout: 8000 , polling: 150 });
      await sleep(700);
      const body = await text();
      for (const label of ['Change request history', 'MSA & contract', 'Internal ownership', 'Total CR value']) {
        if (!hasText(body, label)) throw new Error(`missing "${label}"`);
      }
      if (!hasText(body, 'PEERISLANDS-0001-01')) throw new Error('CR reference missing from history');
      return page.evaluate(() => location.pathname.split('/')[2]);
    });

    await step('manual entry remains available and renders every section', async () => {
      await go('/accounts/new');
      const upload = await text();
      if (!hasText(upload, 'Upload the signed MSA')) throw new Error('the upload step should come first');

      await clickButton(page, 'Enter details manually instead');
      await page.waitForSelector('input[name=msa_reference_number]', { timeout: 8000 });
      const body = await text();
      for (const label of ['Account details', 'MSA details', 'Customer contacts', 'Internal ownership', 'Approval contact']) {
        if (!hasText(body, label)) throw new Error(`missing section "${label}"`);
      }
      const prefilled = await page.$eval('input[name=account_name]', (node) => node.value);
      if (prefilled) throw new Error('manual entry should start empty');
    });

    /* ---------------------------------------------------- the CR wizard -- */

    await step('CR wizard step 1 lists accounts and auto-populates MSA details', async () => {
      await go('/change-requests/new');
      await page.waitForSelector('.stepper__step');
      const steps = await count('.stepper__step');
      if (steps !== 7) throw new Error(`expected 7 wizard steps, found ${steps}`);
      await page.evaluate(() => {
        const cards = [...document.querySelectorAll('.card .card')];
        const target = cards.find((card) => card.innerText.includes('PeerIslands'));
        if (!target) throw new Error('PeerIslands account card not rendered');
        target.click();
      });
      await sleep(500);
      const body = await text();
      if (!hasText(body, 'Auto-populated from the account')) throw new Error('auto-populate panel missing');
      if (!hasText(body, 'PEERISLANDS-0001')) throw new Error('MSA not auto-populated');
      if (!hasText(body, 'arun.satyan@hyreo.com')) throw new Error('internal approver not auto-populated');
    });

    const crNumber = await step('wizard step 2 previews the next CR number and saves the draft', async () => {
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Continue'));
        button.click();
      });
      await page.waitForSelector('input[name=title]', { timeout: 8000 });
      await sleep(600);
      const preview = await page.evaluate(() => document.body.innerText.match(/PEERISLANDS-CR-\d+/)?.[0]);
      if (preview !== 'PEERISLANDS-CR-002') throw new Error(`expected PEERISLANDS-CR-002, saw ${preview}`);
      await page.type('input[name=title]', 'Panel feedback reminder emails');
      await page.type('input[name=requested_by]', 'Vinod Krishnan');
      await clickButton(page, 'Save & continue');
      await page.waitForFunction(() => location.pathname.endsWith('/edit'), { timeout: 8000 , polling: 150 });
      await sleep(700);
      return preview;
    });

    await step('wizard step 3 adds scope items', async () => {
      await clickButton(page, 'Add change item');
      await sleep(250);
      await page.type('.repeater__body input.input', 'Automated reminder email');
      await page.type('.repeater__body textarea.textarea', 'Send a reminder to panellists 24 hours before the interview.');
      await clickButton(page, 'Save & continue');
      await sleep(900);
      const body = await text();
      if (!hasText(body, 'Development Efforts')) throw new Error('did not reach the effort step');
    });

    await step('wizard step 4 totals effort as it is typed', async () => {
      await page.evaluate(() => {
        const set = (name, value) => {
          const input = document.querySelector(`input[name=${name}]`);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('DEVELOPMENT', 12);
        set('TESTING', 6);
        set('BUSINESS_ANALYSIS', 2);
      });
      await sleep(300);
      const body = await text();
      if (!hasText(body, '20 h')) throw new Error(`total effort not calculated (${body.match(/Total effort[\s\S]{0,20}/)})`);
      await clickButton(page, 'Save & continue');
      await sleep(900);
    });

    await step('wizard step 5 calculates subtotal, discount and tax live', async () => {
      await page.evaluate(() => {
        const rate = document.querySelector('input[name=billing_rate]');
        rate.value = '2000';
        rate.dispatchEvent(new Event('input', { bubbles: true }));
        const type = document.querySelector('select[name=discount_type]');
        type.value = 'PERCENT';
        type.dispatchEvent(new Event('change', { bubbles: true }));
        const value = document.querySelector('input[name=discount_value]');
        value.value = '10';
        value.dispatchEvent(new Event('input', { bubbles: true }));
        const tax = document.querySelector('input[name=tax_percent]');
        tax.value = '18';
        tax.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(350);
      const body = await text();
      if (!hasText(body, 'INR 40,000.00')) throw new Error('subtotal not calculated');
      if (!hasText(body, 'INR 42,480.00')) throw new Error('total not calculated (expected INR 42,480.00)');
      await clickButton(page, 'Save & continue');
      await sleep(900);
    });

    await step('wizard step 6 accepts timeline, terms, assumptions and dependencies', async () => {
      const body = await text();
      if (!hasText(body, 'Timeline') || !hasText(body, 'Commercial terms')) throw new Error('terms step did not render');
      await page.evaluate(() => {
        const target = document.querySelector('input[name=target_release_date]');
        target.value = '2026-06-30';
        target.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickButton(page, 'Add assumption');
      await sleep(200);
      await clickButton(page, 'Save & continue');
      await sleep(1000);
    });

    const crId = await step('wizard step 7 summarises the change request', async () => {
      const body = await text();
      for (const label of ['Step 7 — Review', 'Total CR cost', 'Submit for approval', 'Generate preview']) {
        if (!hasText(body, label)) throw new Error(`review step missing "${label}"`);
      }
      if (!hasText(body, 'INR 42,480.00')) throw new Error('review total incorrect');
      return page.evaluate(() => location.pathname.split('/')[2]);
    });

    await step('document preview renders the legal document structure', async () => {
      await clickButton(page, 'Generate preview');
      await page.waitForSelector('.doc-page', { timeout: 8000 });
      const doc = await page.$eval('.doc-page', (node) => node.innerText);
      for (const marker of ['CHANGE REQUEST', 'Master Subscription Agreement Reference No.', 'Change Request Scope', 'LICENSOR', 'LICENSEE']) {
        if (!hasText(doc, marker)) throw new Error(`document preview missing "${marker}"`);
      }
      await clickButton(page, 'Close');
      await sleep(400);
    });

    await step('submit for approval locks the change request', async () => {
      await clickButton(page, 'Submit for approval');
      await page.waitForSelector('.modal', { timeout: 6000 });
      await clickButton(page, 'Submit for approval', '.modal__foot');
      await page.waitForFunction((id) => location.pathname === `/change-requests/${id}`, { timeout: 12000 , polling: 150 }, crId);
      await sleep(1200);
      const body = await text();
      if (!hasText(body, 'Pending Internal Approval')) throw new Error('status did not change');
      if (!hasText(body, 'Awaiting internal approval')) throw new Error('banner missing');
    });

    /* ------------------------------------------------------- CR detail -- */

    await step('CR detail shows the lifecycle timeline and all seven tabs', async () => {
      const steps = await count('.timeline__step');
      if (steps < 8) throw new Error(`expected the full lifecycle timeline, found ${steps} steps`);
      const tabs = await page.$$eval('.tab', (nodes) => nodes.map((n) => n.textContent.trim()));
      for (const label of ['Overview', 'Scope', 'Effort & Cost', 'Approvals', 'Documents', 'Emails', 'Audit Log']) {
        if (!tabs.some((tab) => tab.startsWith(label))) throw new Error(`tab "${label}" missing`);
      }
      return tabs.join(' · ');
    });

    await step('every CR detail tab renders and highlights the tab you are on', async () => {
      for (const label of ['Scope', 'Effort & Cost', 'Approvals', 'Documents', 'Emails', 'Audit Log', 'Overview']) {
        await page.evaluate((tabLabel) => {
          const tab = [...document.querySelectorAll('.tab')].find((node) => node.textContent.trim().startsWith(tabLabel));
          tab.click();
        }, label);
        await sleep(650);
        const body = await text();
        if (hasText(body, 'Unable to load')) throw new Error(`tab ${label} failed to load`);

        const active = await page.$$eval('.tab.is-active', (nodes) => nodes.map((n) => n.textContent.trim()));
        if (active.length !== 1) throw new Error(`expected exactly one highlighted tab, found ${active.length}`);
        if (!active[0].startsWith(label)) {
          throw new Error(`opened "${label}" but "${active[0]}" is highlighted`);
        }
      }
      await page.evaluate(() => {
        const tab = [...document.querySelectorAll('.tab')].find((node) => node.textContent.trim().startsWith('Audit'));
        tab.click();
      });
      await sleep(700);
      const audit = await text();
      for (const entry of ['Change request created', 'Submitted for approval', 'Status changed']) {
        if (!hasText(audit, entry)) throw new Error(`audit missing "${entry}"`);
      }
    });

    /* --------------------------------------------------- approver portal */

    const approverLink = await step('approval email carries a secure review link', async () => {
      await go('/outbox');
      await page.waitForSelector('table.data tbody tr');
      const link = await page.evaluate(async (id) => {
        const response = await fetch(`/api/emails?crId=${id}`, { credentials: 'same-origin' });
        const { data } = await response.json();
        const row = data.rows.find((r) => r.template_code === 'INTERNAL_APPROVAL_REQUEST');
        const detail = await (await fetch(`/api/emails/${row.id}`, { credentials: 'same-origin' })).json();
        return detail.data.body_html.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1];
      }, crId);
      if (!link) throw new Error('no portal link in the approval email');
      return link;
    });

    const approverPage = await browser.newPage();
    approverPage.on('pageerror', (error) => consoleErrors.push(`portal pageerror: ${error.message}`));

    await step('approver portal blocks access until the OTP is verified', async () => {
      await approverPage.goto(`${BASE}/s/${approverLink}`, { waitUntil: 'networkidle2' });
      await sleep(900);
      const body = await approverPage.evaluate(() => document.body.innerText);
      if (!hasText(body, 'Review change request')) throw new Error('portal gate missing');
      if (hasText(body, 'Approve CR')) throw new Error('CR shown before verification');
      if (!hasText(body, '*')) throw new Error('recipient email is not masked');
    });

    await step('approver verifies OTP and sees the read-only change request', async () => {
      await approverPage.type('input[type=email]', 'arun.satyan@hyreo.com');
      await approverPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Send verification code')).click();
      });
      await approverPage.waitForSelector('.otp-inputs input', { timeout: 8000 });
      await sleep(600);
      if (await approverPage.$('.dev-hint')) throw new Error('the demo hint box is still shown on the portal');
      const code = '011235';
      await approverPage.evaluate((value) => {
        document.querySelectorAll('.otp-inputs input').forEach((input, index) => {
          input.value = value[index];
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }, code);
      await approverPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Verify & open')).click();
      });
      await approverPage.waitForSelector('.doc-page', { timeout: 12000 });
      await sleep(600);
      const body = await approverPage.evaluate(() => document.body.innerText);
      for (const marker of ['Change request summary', 'Scope', 'Effort estimate', 'Approve CR', 'Reject CR']) {
        if (!hasText(body, marker)) throw new Error(`portal missing "${marker}"`);
      }
      if (!hasText(body, 'INR 42,480.00')) throw new Error('cost not shown to the approver');
    });

    await step('approver approves and the CR becomes ready for the customer', async () => {
      await approverPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Approve CR')).click();
      });
      await approverPage.waitForSelector('.modal', { timeout: 6000 });
      const question = await approverPage.$eval('.modal__body', (node) => node.innerText);
      if (!hasText(question, 'Are you sure you want to approve this Change Request?')) {
        throw new Error('confirmation wording missing');
      }
      await approverPage.evaluate(() => {
        [...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.includes('Yes, approve')).click();
      });
      await approverPage.waitForFunction(() => document.body.innerText.includes('Change request approved'), { timeout: 15000 , polling: 150 });

      await go(`/change-requests/${crId}`);
      const body = await text();
      if (!hasText(body, 'Ready for Customer')) throw new Error('CR did not advance to READY_FOR_CUSTOMER');
      if (!hasText(body, 'Approved internally')) throw new Error('approval banner missing');
    });

    /* --------------------------------------------------- customer portal */

    await step('share with customer composes an email with attachments', async () => {
      await page.bringToFront();
      await clickButton(page, 'Share with customer');
      await page.waitForSelector('.modal', { timeout: 8000 });
      await sleep(500);
      const modalText = await page.$eval('.modal', (node) => node.innerText);
      // input values are not part of innerText, so read the control directly
      const recipient = await page.$eval('.modal input[name=to]', (node) => node.value);
      if (recipient !== 'customer.approver@peerislands.example') throw new Error(`customer approver not pre-filled (saw "${recipient}")`);
      const subject = await page.$eval('.modal input[name=subject]', (node) => node.value);
      if (!subject.includes('Approval Required')) throw new Error('subject not pre-filled');
      if (!hasText(modalText, 'Attach PDF')) throw new Error('attachment options missing');
      await page.evaluate(() => {
        [...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.trim() === 'Send').click();
      });
      try {
        await page.waitForFunction(() => document.body.innerText.includes('Sent to Customer'), { timeout: 15000 , polling: 150 });
      } catch (error) {
        const diag = await page.evaluate(() => ({
          toast: document.querySelector('.toast')?.innerText || 'none',
          modal: Boolean(document.querySelector('.modal')),
          badges: [...document.querySelectorAll('.badge')].map((b) => b.textContent).slice(0, 6),
          path: location.pathname
        }));
        throw new Error(`${error.message} | ${JSON.stringify(diag)} | console=${consoleErrors.slice(-3).join(' ;; ')}`);
      }
    });

    const customerLink = await step('customer receives a review & sign link', async () =>
      page.evaluate(async (id) => {
        const response = await fetch(`/api/emails?crId=${id}`, { credentials: 'same-origin' });
        const { data } = await response.json();
        const row = data.rows.find((r) => r.template_code === 'CUSTOMER_APPROVAL_REQUEST');
        const detail = await (await fetch(`/api/emails/${row.id}`, { credentials: 'same-origin' })).json();
        return detail.data.body_html.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1];
      }, crId)
    );

    const customerPage = await browser.newPage();
    customerPage.on('pageerror', (error) => consoleErrors.push(`customer pageerror: ${error.message}`));

    await step('customer verifies OTP and views the change request', async () => {
      await customerPage.goto(`${BASE}/s/${customerLink}`, { waitUntil: 'networkidle2' });
      await sleep(900);
      await customerPage.type('input[type=email]', 'customer.approver@peerislands.example');
      await customerPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Send verification code')).click();
      });
      await customerPage.waitForSelector('.otp-inputs input', { timeout: 8000 });
      await sleep(400);
      const code = '011235';
      await customerPage.evaluate((value) => {
        document.querySelectorAll('.otp-inputs input').forEach((input, index) => {
          input.value = value[index];
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }, code);
      await customerPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Verify & open')).click();
      });
      await customerPage.waitForSelector('.doc-page', { timeout: 15000 });
      await sleep(500);
      const body = await customerPage.evaluate(() => document.body.innerText);
      if (!hasText(body, 'Approve & Sign')) throw new Error('sign action missing');
      if (hasText(body, 'Internal approver')) throw new Error('internal detail leaked to the customer');
    });

    await step('customer signs and the change request completes', async () => {
      await customerPage.evaluate(() => {
        [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Approve & Sign')).click();
      });
      await customerPage.waitForSelector('.modal', { timeout: 8000 });
      await sleep(400);
      await customerPage.evaluate(() => {
        const name = document.querySelector('input[name=signature_name]');
        name.value = 'Vinod Krishnan';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.checkbox input[type=checkbox]').click();
      });
      const signature = await customerPage.$eval('.signature-preview', (node) => node.textContent.trim());
      if (signature !== 'Vinod Krishnan') throw new Error('signature preview did not update');
      await customerPage.evaluate(() => {
        [...document.querySelectorAll('.modal__foot button')].find((b) => b.textContent.includes('Approve & sign')).click();
      });
      await customerPage.waitForFunction(() => document.body.innerText.includes('Change request signed'), { timeout: 20000 , polling: 150 });
      const receipt = await customerPage.evaluate(() => document.body.innerText);
      if (!hasText(receipt, 'Download signed PDF')) throw new Error('signed document download not offered');
    });

    await step('change request is COMPLETED with a signed document and full audit', async () => {
      await go(`/change-requests/${crId}?tab=documents`);
      await sleep(900);
      const body = await text();
      if (!hasText(body, 'Completed')) throw new Error('CR status is not Completed');
      if (!hasText(body, 'Signed')) throw new Error('signed document version missing');
      if (!hasText(body, 'v2.0')) throw new Error('final version 2.0 missing');
    });

    /* ------------------------------------------------- remaining screens */

    await step('downloading a document saves a file instead of navigating', async () => {
      await go(`/change-requests/${crId}?tab=documents`);
      await page.waitForSelector('table.data tbody tr', { timeout: 10000 });
      const before = await page.evaluate(() => location.pathname + location.search);
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('table.data button')].find((node) => /^(PDF|DOCX)$/.test(node.textContent.trim()));
        if (!button) throw new Error('no download button on the documents tab');
        button.click();
      });
      const files = await waitForDownload(/\.(pdf|docx)$/i);
      const after = await page.evaluate(() => location.pathname + location.search);
      if (after !== before) throw new Error(`the download navigated the app to ${after}`);
      const body = await text();
      if (hasText(body, 'Page not found')) throw new Error('the download was intercepted by the SPA router');
      return files[0];
    });

    await step('generating a document produces only the chosen format', async () => {
      // the signed CR is closed, so use the seeded draft for generation
      await go('/change-requests');
      await page.waitForSelector('table.data tbody tr');
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('table.data tbody tr')].find((tr) => tr.innerText.includes('PEERISLANDS-CR-001'));
        row.click();
      });
      await page.waitForFunction(() => document.body.innerText.includes('PEERISLANDS-CR-001'), { timeout: 10000, polling: 150 });
      await sleep(800);

      const versionsBefore = await page.evaluate(async () => {
        const path_ = location.pathname.split('/')[2];
        const response = await fetch(`/api/change-requests/${path_}/documents`, { credentials: 'same-origin' });
        return (await response.json()).data.length;
      });

      await clickButton(page, 'Generate document');
      await page.waitForSelector('.modal select[name=format]', { timeout: 8000 });
      const options = await page.$$eval('.modal select[name=format] option', (nodes) => nodes.map((n) => n.value));
      if (!['PDF', 'DOCX', 'BOTH'].every((value) => options.includes(value))) {
        throw new Error(`format choice incomplete: ${options.join(', ')}`);
      }
      await page.select('.modal select[name=format]', 'DOCX');
      await clickButton(page, 'Generate document', '.modal__foot');

      await waitForDownload(/PEERISLANDS-CR-001.*\.docx$/i);
      await sleep(1200);

      const generated = await page.evaluate(async () => {
        const path_ = location.pathname.split('/')[2];
        const response = await fetch(`/api/change-requests/${path_}/documents`, { credentials: 'same-origin' });
        return (await response.json()).data;
      });
      if (generated.length !== versionsBefore + 1) {
        throw new Error(`expected exactly one new version, got ${generated.length - versionsBefore}`);
      }
      if (generated[0].format !== 'DOCX') throw new Error(`newest version is ${generated[0].format}, expected DOCX`);
      return `v${generated[0].version} DOCX only`;
    });

    await step('a rejected change request opens in the edit wizard and can be resubmitted', async () => {
      // set up a rejected CR the way a reviewer would leave one
      const rejectedId = await page.evaluate(async () => {
        const post = async (url, payload) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload || {})
          });
          return (await response.json()).data;
        };
        const put = (url, payload) =>
          fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
          });

        const accounts = await (await fetch('/api/accounts/lookup', { credentials: 'same-origin' })).json();
        const account = accounts.data.find((a) => a.account_name === 'Acme Technologies') || accounts.data[0];
        const cr = await post('/api/change-requests', { account_id: account.id, title: 'Rejected then revised' });
        await put(`/api/change-requests/${cr.id}/items`, { items: [{ feature_name: 'Something', requested_change: 'Do something' }] });
        await put(`/api/change-requests/${cr.id}/efforts`, { efforts: [{ category: 'DEVELOPMENT', hours: 4 }] });
        await put(`/api/change-requests/${cr.id}/costs`, { billing_rate: 2000, currency: 'INR' });
        await post(`/api/change-requests/${cr.id}/submit`);
        await post(`/api/change-requests/${cr.id}/reject`, { comments: 'Please add more detail before approval.' });
        return cr.id;
      });

      // the detail page must show why it came back and offer Edit
      await go(`/change-requests/${rejectedId}`);
      const detail = await text();
      if (!hasText(detail, 'Under Revision')) throw new Error('a rejected CR should show as Under Revision, not Draft');
      if (!hasText(detail, 'Rejected during internal review')) throw new Error('rejection banner missing');
      if (!hasText(detail, 'Please add more detail')) throw new Error('rejection reason not shown');
      if (!hasText(detail, 'Revision 1')) throw new Error('revision badge missing');
      const timeline = await page.$eval('.timeline', (node) => node.innerText);
      if (/USR-\d+/.test(timeline)) throw new Error(`timeline shows a raw user id: ${timeline.match(/USR-\d+/)[0]}`);

      // the bug: Edit used to render an empty wizard
      await clickButton(page, 'Edit');
      await page.waitForFunction(() => location.pathname.endsWith('/edit'), { timeout: 10000, polling: 150 });
      await page.waitForSelector('input[name=title]', { timeout: 10000 });
      await sleep(600);
      const titleValue = await page.$eval('input[name=title]', (node) => node.value);
      if (titleValue !== 'Rejected then revised') throw new Error(`edit form did not load the CR (title="${titleValue}")`);
      const steps = await count('.stepper__step');
      if (steps !== 7) throw new Error('wizard stepper incomplete');

      // edit and resubmit for approval
      await page.evaluate(() => {
        const input = document.querySelector('input[name=title]');
        input.value = 'Rejected then revised — updated';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickButton(page, 'Save & continue');
      await sleep(1200);

      await go(`/change-requests/${rejectedId}`);
      await clickButton(page, 'Submit for approval');
      await page.waitForSelector('.modal', { timeout: 8000 });
      await clickButton(page, 'Submit', '.modal__foot');
      await page.waitForFunction(() => document.body.innerText.includes('Pending Internal Approval'), {
        timeout: 15000,
        polling: 150
      });

      const resubmitted = await text();
      if (!hasText(resubmitted, 'Rejected then revised — updated')) throw new Error('the edit was not saved');
      return 'edited and resubmitted';
    });

    await step('creating an account starts by uploading the MSA', async () => {
      await go('/accounts/new');
      const body = await text();
      if (!hasText(body, 'Upload the signed MSA')) throw new Error('the upload step is missing');
      if (!hasText(body, 'Enter details manually instead')) throw new Error('no manual fallback offered');
      if (!(await count('.dropzone'))) throw new Error('dropzone missing');

      // drive the file input the way the browser would
      const contract = [
        'MASTER SUBSCRIPTION AGREEMENT',
        '',
        'This Master Subscription Agreement is dated 02 February 2026 and is entered into by and between',
        'Hyreo Services India Private Limited (the "Supplier") and Initech Systems Pvt Ltd (the "Customer").',
        '',
        'MSA Reference Number: INITECH-0007',
        'Effective Date: 01 March 2026',
        'Expiry Date: 28 February 2029',
        'Payment Terms: 30 days from the date of invoice',
        'This agreement is governed by the laws of India.'
      ].join('\n');

      const fixture = path.join(storage, 'initech-msa.txt');
      fs.writeFileSync(fixture, contract, 'utf8');
      const input = await page.$('input[type=file]');
      await input.uploadFile(fixture);

      await page.waitForSelector('input[name=msa_reference_number]', { timeout: 15000 });
      await sleep(800);

      const reference = await page.$eval('input[name=msa_reference_number]', (node) => node.value);
      if (reference !== 'INITECH-0007') throw new Error(`MSA reference not prefilled (saw "${reference}")`);
      const entity = await page.$eval('input[name=legal_entity_name]', (node) => node.value);
      if (entity !== 'Initech Systems Pvt Ltd') throw new Error(`legal entity not prefilled (saw "${entity}")`);
      const start = await page.$eval('input[name=contract_start_date]', (node) => node.value);
      if (start !== '2026-03-01') throw new Error(`contract start not prefilled (saw "${start}")`);

      const summary = await text();
      if (!hasText(summary, 'field(s) read')) throw new Error('extraction summary missing');
      if (!hasText(summary, 'Check every value before saving')) throw new Error('review warning missing');
      if (!hasText(summary, 'View MSA')) throw new Error('no way to open the uploaded MSA');

      // finish the account so the document can be opened again later
      await page.evaluate(() => {
        const approver = document.querySelector('select[name=internal_approver_email]');
        approver.value = [...approver.options].find((o) => o.value.includes('arun'))?.value || approver.options[1].value;
        approver.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await clickButton(page, 'Create account');
      await page.waitForFunction(() => /\/accounts\/ACC-/.test(location.pathname), { timeout: 15000, polling: 150 });
      await sleep(900);

      const detail = await text();
      if (!hasText(detail, 'Initech Systems')) throw new Error('account not created from the MSA');
      if (!hasText(detail, 'INITECH-0007')) throw new Error('MSA reference not saved');
      if (!hasText(detail, 'Signed MSA on file')) throw new Error('the stored contract is not shown on the account');
      return 'account created from the contract';
    });

    await step('the stored MSA can be opened again from the accounts list', async () => {
      await go('/accounts');
      await page.waitForSelector('#accounts-table table.data tbody tr');
      const viewButtons = await count('button[title="View MSA document"]');
      if (viewButtons < 1) throw new Error('no View MSA action on the accounts list');

      const href = await page.evaluate(async () => {
        const rows = [...document.querySelectorAll('#accounts-table table.data tbody tr')];
        const row = rows.find((tr) => tr.innerText.includes('Initech'));
        const response = await fetch('/api/accounts/lookup?q=Initech', { credentials: 'same-origin' });
        const { data } = await response.json();
        const detail = await (await fetch(`/api/accounts/${data[0].id}`, { credentials: 'same-origin' })).json();
        return `/api/accounts/msa-documents/${detail.data.primary_msa.document.id}/download?inline=1`;
      });

      const opened = await page.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'same-origin' });
        return { status: response.status, text: (await response.text()).slice(0, 80) };
      }, href);
      if (opened.status !== 200) throw new Error(`MSA document not served (HTTP ${opened.status})`);
      if (!opened.text.includes('MASTER SUBSCRIPTION AGREEMENT')) throw new Error('wrong document served');
      return 'contract served back';
    });

    await step('notifications can be dismissed individually and cleared', async () => {
      await go('/notifications');
      await sleep(600);
      const before = await count('.feed__item');
      if (before < 1) throw new Error('expected notifications from the workflow');

      await page.evaluate(() => {
        document.querySelector('.feed__item button[title="Clear this notification"]').click();
      });
      await sleep(1200);
      const after = await count('.feed__item');
      if (after !== before - 1) throw new Error(`dismiss did not remove the row (${before} -> ${after})`);

      await clickButton(page, 'Clear all');
      await page.waitForSelector('.modal', { timeout: 8000 });
      await clickButton(page, 'Clear all', '.modal__foot');
      await page.waitForFunction(() => document.body.innerText.includes('You are all caught up'), {
        timeout: 12000,
        polling: 150
      });
      return 'dismiss and clear all work';
    });

    await step('accounts list always offers a delete action', async () => {
      await go('/accounts');
      await page.waitForSelector('#accounts-table table.data tbody tr');
      const deleteButtons = await page.$$eval('#accounts-table table.data button[title="Delete account"]', (nodes) => nodes.length);
      const rows = await count('#accounts-table table.data tbody tr');
      if (deleteButtons !== rows) throw new Error(`expected a delete action on all ${rows} rows, found ${deleteButtons}`);
      const deactivate = await count('#accounts-table table.data button[title="Deactivate account"]');
      if (deactivate < 1) throw new Error('deactivate action missing');
      return `${deleteButtons} delete actions`;
    });

    await step('deleting an account with contractual CRs is refused and offers deactivation', async () => {
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('#accounts-table table.data tbody tr')].find((tr) => tr.innerText.includes('PeerIslands'));
        row.querySelector('button[title="Delete account"]').click();
      });
      await page.waitForSelector('.modal', { timeout: 8000 });
      await sleep(600);
      const body = await page.$eval('.modal', (node) => node.innerText);
      if (!hasText(body, 'Cannot delete')) throw new Error('expected the delete to be refused');
      if (!hasText(body, 'contractual records')) throw new Error('reason not explained');
      if (!hasText(body, 'Deactivate instead')) throw new Error('no deactivation alternative offered');
      await clickButton(page, 'Close', '.modal__foot');
      await sleep(400);
    });

    await step('an account with only drafts deletes after typing its name', async () => {
      const created = await page.evaluate(async () => {
        const post = async (url, payload) => {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
          });
          return (await response.json()).data;
        };
        const account = await post('/api/accounts', {
          account: { account_name: 'Disposable Ltd', account_code: 'DISPOSABLE', legal_entity_name: 'Disposable Ltd' },
          msa: { msa_reference_number: 'DISPOSABLE-0001', msa_date: '2026-01-01', contract_start_date: '2026-01-01' }
        });
        await post('/api/change-requests', { account_id: account.id, title: 'Draft that goes with it' });
        return account.id;
      });

      await go('/accounts?q=Disposable');
      await page.waitForSelector('#accounts-table table.data tbody tr');
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('#accounts-table table.data tbody tr')].find((tr) => tr.innerText.includes('Disposable'));
        row.querySelector('button[title="Delete account"]').click();
      });
      await page.waitForSelector('.modal input.input', { timeout: 8000 });
      const dialog = await page.$eval('.modal', (node) => node.innerText);
      if (!hasText(dialog, '1 draft change request')) throw new Error('impact not spelled out in the dialog');

      // a wrong confirmation must not delete anything
      await page.type('.modal input.input', 'wrong');
      await clickButton(page, 'Delete account', '.modal__foot');
      await sleep(900);
      const stillOpen = await page.evaluate(() => Boolean(document.querySelector('.modal')));
      if (!stillOpen) throw new Error('the dialog closed on a wrong confirmation');

      await page.evaluate(() => {
        const input = document.querySelector('.modal input.input');
        input.value = 'Disposable Ltd';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await clickButton(page, 'Delete account', '.modal__foot');
      await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 12000, polling: 150 });
      await sleep(900);

      const gone = await page.evaluate(
        async (id) => (await fetch(`/api/accounts/${id}`, { credentials: 'same-origin' })).status,
        created
      );
      if (gone !== 404) throw new Error(`account still exists (HTTP ${gone})`);
      return 'account and its draft removed';
    });

    await step('approvals queue renders', async () => {
      await go('/approvals');
      const body = await text();
      if (!hasText(body, 'Approvals')) throw new Error('heading missing');
      if (!hasText(body, 'Awaiting my decision')) throw new Error('queue tiles missing');
    });

    await step('documents library lists generated versions', async () => {
      await go('/documents');
      await page.waitForSelector('table.data tbody tr');
      const rows = await count('table.data tbody tr');
      if (rows < 4) throw new Error(`expected several document versions, found ${rows}`);
      return `${rows} versions`;
    });

    await step('reports run and export controls are present', async () => {
      await go('/reports');
      await page.waitForSelector('table.data tbody tr', { timeout: 10000 });
      const body = await text();
      for (const label of ['CR Register', 'Pending Approval Report', 'Effort Report', 'XLSX', 'CSV', 'PDF']) {
        if (!hasText(body, label)) throw new Error(`missing "${label}"`);
      }
      await page.evaluate(() => {
        [...document.querySelectorAll('.stepper__step')].find((b) => b.textContent.includes('Effort Report')).click();
      });
      await sleep(900);
      if (!(await text()).includes('Effort by category')) throw new Error('report switch failed');
    });

    await step('notifications centre renders', async () => {
      await go('/notifications');
      const body = await text();
      if (!hasText(body, 'Notifications')) throw new Error('heading missing');
    });

    await step('email outbox lists the workflow emails with tracking', async () => {
      await go('/outbox');
      await page.waitForSelector('table.data tbody tr');
      const body = await text();
      for (const label of ['Internal Approval Request', 'Customer Approval Request', 'Cr Approved']) {
        if (!hasText(body, label)) throw new Error(`missing template "${label}"`);
      }
    });

    await step('settings tabs all render', async () => {
      await go('/settings');
      const tabLabels = ['Company', 'Defaults', 'CR numbering', 'Standard terms', 'Email', 'OTP & security', 'DocuSign', 'Email templates', 'Approval levels', 'Users', 'Roles'];
      const tabs = await page.$$eval('.tab', (nodes) => nodes.map((n) => n.textContent.trim()));
      for (const label of tabLabels) {
        if (!tabs.includes(label)) throw new Error(`settings tab "${label}" missing`);
      }
      for (const label of ['Users', 'Roles', 'DocuSign', 'Email templates', 'Approval levels', 'CR numbering']) {
        await page.evaluate((tabLabel) => {
          [...document.querySelectorAll('.tab')].find((node) => node.textContent.trim() === tabLabel).click();
        }, label);
        await sleep(800);
        const body = await text();
        if (hasText(body, 'Unable to')) throw new Error(`settings tab ${label} failed`);
        if (label === 'Users' && !hasText(body, 'sahaf@hyreo.com')) throw new Error('user list did not load');
        if (label === 'Roles' && !hasText(body, 'cr.approve')) throw new Error('permission matrix did not load');
        if (label === 'DocuSign' && !hasText(body, 'Simulated')) throw new Error('integration panel did not load');
      }
    });

    await step('responsive layout collapses the sidebar on small screens', async () => {
      await page.setViewport({ width: 560, height: 900 });
      await go('/dashboard');
      const sidebarVisible = await page.evaluate(() => {
        const sidebar = document.querySelector('.sidebar');
        return sidebar.getBoundingClientRect().right > 0;
      });
      if (sidebarVisible) throw new Error('sidebar should be off-canvas below 900px');
      const menuVisible = await page.evaluate(() => {
        const button = document.querySelector('.topbar__menu');
        return button && getComputedStyle(button).display !== 'none';
      });
      if (!menuVisible) throw new Error('mobile menu button not shown');
      await page.setViewport({ width: 1500, height: 1000 });
    });

    await step('sign out returns to the login screen', async () => {
      await go('/dashboard');
      await page.click('.user-chip');
      await page.waitForSelector('.dropdown', { timeout: 5000 });
      await page.evaluate(() => {
        [...document.querySelectorAll('.dropdown__item')].find((item) => item.textContent.includes('Sign out')).click();
      });
      await page.waitForFunction(() => location.pathname === '/login', { timeout: 8000 , polling: 150 });
    });

    await step('no console errors were raised anywhere in the walkthrough', async () => {
      if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 6).join(' | '));
      return '0 errors';
    });
  } catch {
    /* individual failures already reported */
  } finally {
    await browser.disconnect().catch(() => {});
    browserProcess.kill();
    server.kill();
  }

  console.log(`\n${passed} checks passed, ${failed} failed`);
  if (consoleErrors.length) {
    console.log('\nConsole errors:');
    for (const error of consoleErrors.slice(0, 12)) console.log(`  · ${error}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

/**
 * Launch the browser ourselves and attach over the DevTools protocol.
 * Edge refuses puppeteer's default profile handling on Windows, so we hand it
 * a throwaway profile directory and connect to the debugging port instead.
 */
/** Wait for a file matching `pattern` to finish downloading. */
async function waitForDownload(pattern, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = fs.readdirSync(downloads).filter((name) => pattern.test(name) && !name.endsWith('.crdownload'));
    if (files.length) return files;
    await sleep(250);
  }
  throw new Error(`no download matching ${pattern} appeared in ${downloads} (saw: ${fs.readdirSync(downloads).join(', ') || 'nothing'})`);
}

async function launchBrowser() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrms-profile-'));
  const port = 9400 + Math.floor(Math.random() * 400);
  const browserProcess = spawn(
    executablePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1500,1000',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(300);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        return { browser, browserProcess };
      }
    } catch {
      /* still starting */
    }
  }
  browserProcess.kill();
  throw new Error('browser did not expose a debugging port');
}

async function clickButton(page, label, scope = 'body') {
  const clicked = await page.evaluate(
    (text_, selector) => {
      const root = document.querySelector(selector) || document.body;
      const button = [...root.querySelectorAll('button')].find((node) => node.textContent.trim().includes(text_) && !node.disabled);
      if (!button) return false;
      button.click();
      return true;
    },
    label,
    scope
  );
  if (!clicked) throw new Error(`button "${label}" not found`);
  await sleep(320);
}

main().catch((error) => {
  console.error('FATAL', error);
  process.exit(1);
});
