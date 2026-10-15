import crypto from 'node:crypto';
import { nextSequence } from '../db/index.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic, sortable, collision-resistant id for child records. */
export function uid(prefix = '') {
  const time = Date.now();
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i += 1) {
    timePart = ALPHABET[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  const random = crypto.randomBytes(8);
  let randomPart = '';
  for (const byte of random) randomPart += ALPHABET[byte % 32];
  return `${prefix}${timePart}${randomPart}`;
}

function pad(value, size) {
  return String(value).padStart(size, '0');
}

export function nextAccountId() {
  return `ACC-${pad(nextSequence('account_id'), 4)}`;
}

export function nextMsaId() {
  return `MSA-${pad(nextSequence('msa_id'), 4)}`;
}

export function nextChangeRequestId() {
  return `CR-${pad(nextSequence('change_request_id'), 6)}`;
}

export function nextUserId() {
  return `USR-${pad(nextSequence('user_id'), 4)}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function numericCode(length = 6) {
  const max = 10 ** length;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(length, '0');
}

/** Slug used for account codes when the user does not supply one. */
export function slugifyCode(value, fallback = 'ACCOUNT') {
  const slug = String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 20);
  return slug || fallback;
}

export { pad };
