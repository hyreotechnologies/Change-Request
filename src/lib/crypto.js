import crypto from 'node:crypto';
import config from '../config.js';

const KEY = crypto.createHash('sha256').update(String(config.appSecret)).digest();

/** Keyed hash used for OTP codes and session/portal tokens. */
export function hashToken(value) {
  return crypto.createHmac('sha256', KEY).update(String(value)).digest('hex');
}

export function sha256File(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** AES-256-GCM encryption for secrets stored in the settings table. */
export function encryptSecret(plainText) {
  if (plainText === null || plainText === undefined || plainText === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSecret(value) {
  if (!value || typeof value !== 'string' || !value.startsWith('enc:v1:')) return value || '';
  try {
    const [, , ivB64, tagB64, dataB64] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
}

/** HMAC signature used to verify inbound webhooks. */
export function hmacSignature(payload, secret) {
  return crypto.createHmac('sha256', String(secret)).update(payload).digest('base64');
}

export function maskEmail(email) {
  const text = String(email || '');
  const [name, domain] = text.split('@');
  if (!domain) return text;
  const visible = name.slice(0, Math.min(2, name.length));
  return `${visible}${'*'.repeat(Math.max(1, name.length - visible.length))}@${domain}`;
}
