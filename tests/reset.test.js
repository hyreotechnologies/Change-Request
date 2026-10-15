import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const originalEnv = { ...process.env };

function runReset(dbFile) {
  return spawnSync(process.execPath, ['scripts/reset.js', '--force'], {
    cwd: root,
    env: {
      ...originalEnv,
      STORAGE_DIR: path.dirname(dbFile),
      DATABASE_FILE: dbFile,
      NODE_ENV: 'test',
      APP_URL: 'http://127.0.0.1:4100'
    },
    encoding: 'utf8'
  });
}

test('reset.js can force a rebuild when the database is already seeded', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hcrms-reset-'));
  const dbFile = path.join(tmp, 'hcrms.db');
  const storageDir = path.dirname(dbFile);

  process.env.STORAGE_DIR = storageDir;
  process.env.DATABASE_FILE = dbFile;
  process.env.NODE_ENV = 'test';
  process.env.APP_URL = 'http://127.0.0.1:4100';

  const db = await import('../src/db/index.js');
  db.migrate();
  const { seed } = await import('../src/db/seed.js');
  seed();
  db.close();

  const result = runReset(dbFile);

  assert.equal(result.status, 0, result.stderr || result.stdout || 'reset exited unexpectedly');
  assert.match(result.stdout, /Reset complete/i, 'reset output should confirm completion');
  assert.ok(fs.existsSync(dbFile), 'database file should exist after reset');
});
