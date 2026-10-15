import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const db = new DatabaseSync(config.databaseFile);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');

/** Normalise JS values into types node:sqlite accepts. */
function normalise(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

const cache = new Map();
function prepare(sql) {
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

function plain(row) {
  return row === undefined ? undefined : { ...row };
}

export function run(sql, params = []) {
  return prepare(sql).run(...params.map(normalise));
}

export function get(sql, params = []) {
  return plain(prepare(sql).get(...params.map(normalise)));
}

export function all(sql, params = []) {
  return prepare(sql).all(...params.map(normalise)).map((r) => ({ ...r }));
}

export function pluck(sql, params = []) {
  const row = get(sql, params);
  if (!row) return undefined;
  return Object.values(row)[0];
}

export function exec(sql) {
  db.exec(sql);
}

let txDepth = 0;

/** Run fn inside a transaction (savepoints allow safe nesting). */
export function transaction(fn) {
  const isOuter = txDepth === 0;
  const name = `sp_${txDepth}`;
  if (isOuter) db.exec('BEGIN IMMEDIATE');
  else db.exec(`SAVEPOINT ${name}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (isOuter) db.exec('COMMIT');
    else db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    txDepth -= 1;
    try {
      if (isOuter) db.exec('ROLLBACK');
      else db.exec(`ROLLBACK TO ${name}`);
    } catch {
      /* connection already unwound */
    }
    throw error;
  }
}

/** Build an INSERT from a plain object. */
export function insert(table, data) {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  return run(sql, keys.map((k) => data[k]));
}

/** Build an UPDATE ... WHERE id = ? from a plain object. */
export function update(table, id, data, idColumn = 'id') {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length === 0) return { changes: 0 };
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE ${idColumn} = ?`;
  return run(sql, [...keys.map((k) => data[k]), id]);
}

/** Atomically allocate the next value of a named sequence. */
export function nextSequence(name) {
  return transaction(() => {
    run('INSERT INTO sequences (name, next_value) VALUES (?, 1) ON CONFLICT(name) DO NOTHING', [name]);
    const value = pluck('SELECT next_value FROM sequences WHERE name = ?', [name]);
    run('UPDATE sequences SET next_value = next_value + 1 WHERE name = ?', [name]);
    return Number(value);
  });
}

/** CREATE TABLE IF NOT EXISTS leaves existing tables alone, so later columns are added here. */
function addMissingColumns(table, columns) {
  const existing = new Set(all(`PRAGMA table_info(${table})`).map((column) => column.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  addMissingColumns('accounts', { go_live_date: 'TEXT', next_renewal_date: 'TEXT' });
  const version = '2026.10.08';
  run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING', [
    version,
    new Date().toISOString()
  ]);
  return version;
}

export function close() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } catch {
    /* ignore */
  }
  db.close();
}

export default { db, run, get, all, pluck, exec, transaction, insert, update, nextSequence, migrate, close };
