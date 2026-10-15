/**
 * Delete the database and generated documents, then re-seed from scratch.
 *
 * This destroys real work, so it refuses to run when the database holds
 * anything beyond the pristine demo set. Pass --force to override, having read
 * the list of what will be lost.
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import config from '../src/config.js';

const force = process.argv.includes('--force') || process.argv.includes('-f');

const SEEDED_ACCOUNT_CODES = ['PEERISLANDS', 'ACMETECH'];
const SEEDED_USER_EMAILS = ['sahaf@hyreo.com', 'arun.satyan@hyreo.com', 'cr.manager@hyreo.com', 'viewer@hyreo.com'];
const SEEDED_CR_NUMBERS = ['PEERISLANDS-CR-001', 'ACMETECH-CR-001', 'ACMETECH-CR-002', 'ACMETECH-CR-003'];

async function describeUserData() {
  if (!fs.existsSync(config.databaseFile)) return null;

  const db = new DatabaseSync(config.databaseFile);
  try {
    const get = (sql, params = []) => db.prepare(sql).get(...params);
    const all = (sql, params = []) => db.prepare(sql).all(...params);

    const tableExists = get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'accounts'");
    if (!tableExists) return null;

    const accounts = all(
      `SELECT account_code, account_name FROM accounts WHERE upper(account_code) NOT IN (${SEEDED_ACCOUNT_CODES.map(() => '?').join(', ')})`,
      SEEDED_ACCOUNT_CODES
    );
    const changeRequests = all(
      `SELECT cr_number, title FROM change_requests WHERE upper(cr_number) NOT IN (${SEEDED_CR_NUMBERS.map(() => '?').join(', ')})`,
      SEEDED_CR_NUMBERS
    );
    const users = all(
      `SELECT email FROM users WHERE lower(email) NOT IN (${SEEDED_USER_EMAILS.map(() => '?').join(', ')})`,
      SEEDED_USER_EMAILS
    );
    const msaDocuments = all('SELECT file_name FROM msa_documents');

    if (!accounts.length && !changeRequests.length && !users.length && !msaDocuments.length) return null;
    return { accounts, changeRequests, users, msaDocuments };
  } finally {
    db.close();
  }
}

const userData = await describeUserData();

if (userData && !force) {
  console.error('\nRefusing to reset: this database contains data that was not seeded.\n');
  for (const account of userData.accounts) console.error(`  account        ${account.account_code} — ${account.account_name}`);
  for (const cr of userData.changeRequests) console.error(`  change request ${cr.cr_number} — ${cr.title}`);
  for (const user of userData.users) console.error(`  user           ${user.email}`);
  for (const doc of userData.msaDocuments) console.error(`  MSA document   ${doc.file_name}`);
  console.error('\nResetting deletes all of it permanently. Re-run with --force if that is what you want.\n');
  process.exit(1);
}

if (userData) {
  console.warn(`Forced reset — discarding ${userData.accounts.length} account(s), ${userData.changeRequests.length} change request(s), ${userData.users.length} user(s).`);
}

try {
  for (const file of [config.databaseFile, `${config.databaseFile}-wal`, `${config.databaseFile}-shm`]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
} catch (error) {
  if (error.code === 'EPERM' || error.code === 'EBUSY') {
    console.error('The database is in use — stop the running server before resetting.');
    process.exit(1);
  }
  throw error;
}

if (fs.existsSync(config.documentsDir)) fs.rmSync(config.documentsDir, { recursive: true, force: true });
fs.mkdirSync(config.documentsDir, { recursive: true });

const { migrate } = await import('../src/db/index.js');
const { seed } = await import('../src/db/seed.js');
migrate();
const result = seed();
console.log(`Reset complete — ${result.users} users, ${result.accounts || 0} accounts seeded.`);
