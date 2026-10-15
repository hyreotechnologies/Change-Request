import { all, get, insert, run, transaction } from '../db/index.js';
import { uid, randomToken, numericCode } from '../lib/ids.js';
import { nowIso, addMinutes, addHours, isPast } from '../lib/dates.js';
import { hashToken, maskEmail, timingSafeEqual } from '../lib/crypto.js';
import { errors } from '../lib/errors.js';
import { normaliseEmail } from '../lib/validate.js';
import { getSetting } from './settings.js';
import { permissionsForRole } from './rbac.js';
import email from './email.js';
import audit, { ACTIONS } from './audit.js';
import config from '../config.js';

/* ------------------------------------------------------------------ OTP -- */

/**
 * Issue a one-time code. The plain code is returned to the caller so it can be
 * placed in an email; only its hash is persisted.
 */
export function issueOtp({ emailAddress, purpose, contextId = null, ip = null }) {
  const address = normaliseEmail(emailAddress);
  const cooldown = Number(getSetting('otp.resend_cooldown_seconds', 60));
  const recent = get(
    `SELECT created_at FROM otp_codes
      WHERE lower(email) = ? AND purpose = ? AND IFNULL(context_id,'') = IFNULL(?,'')
      ORDER BY created_at DESC LIMIT 1`,
    [address, purpose, contextId]
  );
  if (recent && Date.now() - new Date(recent.created_at).getTime() < cooldown * 1000) {
    const wait = Math.ceil((cooldown * 1000 - (Date.now() - new Date(recent.created_at).getTime())) / 1000);
    throw errors.rateLimited(`Please wait ${wait} second${wait === 1 ? '' : 's'} before requesting another code`);
  }

  const hourAgo = addHours(-1);
  const lastHour =
    get(
      `SELECT COUNT(*) AS count FROM otp_codes WHERE lower(email) = ? AND purpose = ? AND created_at > ?`,
      [address, purpose, hourAgo]
    )?.count || 0;
  if (lastHour >= config.rateLimit.otpRequestsPerHour) {
    throw errors.rateLimited('Too many verification codes requested. Please try again later.');
  }

  const length = Number(getSetting('otp.length', 6));
  const validity = Number(getSetting('otp.validity_minutes', 10));
  const code = numericCode(length);

  // invalidate previous outstanding codes for this challenge
  run(
    `UPDATE otp_codes SET consumed_at = ?
      WHERE lower(email) = ? AND purpose = ? AND IFNULL(context_id,'') = IFNULL(?,'') AND consumed_at IS NULL`,
    [nowIso(), address, purpose, contextId]
  );

  const row = {
    id: uid('OTP'),
    email: address,
    purpose,
    context_id: contextId,
    code_hash: hashToken(`${purpose}:${contextId || ''}:${code}`),
    attempts: 0,
    max_attempts: Number(getSetting('otp.max_attempts', 5)),
    expires_at: addMinutes(validity),
    created_at: nowIso(),
    ip
  };
  insert('otp_codes', row);
  return { row, code, validity };
}

/**
 * Demo convenience: a fixed code that stands in for any emailed OTP.
 * Returns '' — disabling the bypass entirely — whenever NODE_ENV=production,
 * so it can never weaken a real deployment regardless of the stored setting.
 */
export function masterCode() {
  if (config.isProduction) return '';
  return String(getSetting('otp.master_code', '') || '').trim();
}

export function verifyOtp({ emailAddress, purpose, contextId = null, code }) {
  const address = normaliseEmail(emailAddress);
  const supplied = String(code ?? '').trim();

  const master = masterCode();
  if (master && supplied === master) {
    // burn any outstanding challenge so the emailed code cannot be replayed later
    run(
      `UPDATE otp_codes SET consumed_at = ?
        WHERE lower(email) = ? AND purpose = ? AND IFNULL(context_id,'') = IFNULL(?,'') AND consumed_at IS NULL`,
      [nowIso(), address, purpose, contextId]
    );
    return { via_master: true, email: address, purpose, context_id: contextId };
  }

  const row = get(
    `SELECT * FROM otp_codes
      WHERE lower(email) = ? AND purpose = ? AND IFNULL(context_id,'') = IFNULL(?,'') AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [address, purpose, contextId]
  );
  if (!row) throw errors.otpInvalid('No active verification code was found. Please request a new one.');
  if (isPast(row.expires_at)) throw errors.otpExpired();
  if (row.attempts >= row.max_attempts) {
    run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [nowIso(), row.id]);
    throw errors.otpInvalid('Too many incorrect attempts. Please request a new code.');
  }

  const expected = row.code_hash;
  const presented = hashToken(`${purpose}:${contextId || ''}:${supplied}`);
  if (!timingSafeEqual(expected, presented)) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    const remaining = row.max_attempts - (row.attempts + 1);
    throw errors.otpInvalid(
      remaining > 0 ? `That code is not correct. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` : 'That code is not correct.'
    );
  }

  run('UPDATE otp_codes SET consumed_at = ? WHERE id = ?', [nowIso(), row.id]);
  return row;
}

/* -------------------------------------------------------------- Sessions -- */

export function createSession(user, { ip = null, userAgent = null } = {}) {
  const token = randomToken(32);
  const idle = Number(getSetting('security.session_idle_minutes', 60));
  const absolute = Number(getSetting('security.session_absolute_hours', 12));
  const row = {
    id: uid('SES'),
    user_id: user.id,
    token_hash: hashToken(token),
    created_at: nowIso(),
    last_seen_at: nowIso(),
    expires_at: addMinutes(idle),
    absolute_expires_at: addHours(absolute),
    ip,
    user_agent: userAgent
  };
  insert('sessions', row);
  return { token, session: row };
}

export function resolveSession(token) {
  if (!token) return null;
  const session = get('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL', [hashToken(token)]);
  if (!session) return null;
  if (isPast(session.expires_at) || isPast(session.absolute_expires_at)) {
    run('UPDATE sessions SET revoked_at = ? WHERE id = ?', [nowIso(), session.id]);
    return null;
  }
  const user = get('SELECT * FROM users WHERE id = ? AND is_active = 1', [session.user_id]);
  if (!user) return null;

  const idle = Number(getSetting('security.session_idle_minutes', 60));
  run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [nowIso(), addMinutes(idle), session.id]);

  return { session, user: toActor(user) };
}

export function revokeSession(token) {
  if (!token) return;
  run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [nowIso(), hashToken(token)]);
}

export function revokeAllSessionsForUser(userId) {
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
}

export function toActor(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role_code: user.role_code,
    department: user.department,
    designation: user.designation,
    is_active: Boolean(user.is_active),
    last_login_at: user.last_login_at,
    permissions: permissionsForRole(user.role_code),
    type: 'USER'
  };
}

/* ------------------------------------------------------------ Login flow -- */

export function requestLoginOtp({ emailAddress, ip = null }) {
  const address = normaliseEmail(emailAddress);
  const user = get('SELECT * FROM users WHERE lower(email) = ?', [address]);

  // Do not disclose whether an address is registered.
  if (!user || !user.is_active) {
    audit.record({
      entityType: 'AUTH',
      action: ACTIONS.LOGIN_FAILED,
      actor: { type: 'SYSTEM', name: address },
      comments: user ? 'Inactive user requested a login code' : 'Unknown email requested a login code',
      ip
    });
    return { sent: true, masked: maskEmail(address), validity_minutes: Number(getSetting('otp.validity_minutes', 10)) };
  }

  const { code, validity } = issueOtp({ emailAddress: address, purpose: 'LOGIN', ip });
  logCaptureCode(address, code);
  email.send({
    templateCode: 'OTP_LOGIN',
    to: address,
    variables: {
      user_name: user.name,
      otp_code: code,
      validity_minutes: validity,
      company_name: getSetting('company.name', 'Hyreo')
    }
  });
  audit.record({
    entityType: 'AUTH',
    entityId: user.id,
    action: ACTIONS.OTP_ISSUED,
    actor: { id: user.id, name: user.name, email: user.email, type: 'USER' },
    ip
  });

  return { sent: true, masked: maskEmail(address), validity_minutes: validity };
}

/**
 * With the capture transport nothing is delivered, so the code is written to the
 * server log — visible to whoever runs the process, never to an HTTP client.
 */
export function logCaptureCode(address, code) {
  if (config.isProduction || !email.isCaptureMode()) return;
  console.log(`[hcrms] one-time code for ${address}: ${code}`);
}

export function verifyLoginOtp({ emailAddress, code, ip = null, userAgent = null }) {
  const address = normaliseEmail(emailAddress);
  const user = get('SELECT * FROM users WHERE lower(email) = ?', [address]);

  if (!user || !user.is_active) {
    // Normally we never reveal whether an address is registered. The demo master
    // code only exists outside production, where saying plainly that there is no
    // such user costs nothing and saves a confusing dead end.
    const master = masterCode();
    if (master && String(code ?? '').trim() === master) {
      throw errors.otpInvalid(
        user
          ? `The account for ${address} is deactivated. An administrator can reactivate it under Settings → Users.`
          : `No user account exists for ${address}. Sign in with a registered address, or have an administrator add this one under Settings → Users.`
      );
    }
    throw errors.otpInvalid('That code is not correct.');
  }

  const challenge = verifyOtp({ emailAddress: address, purpose: 'LOGIN', code });

  return transaction(() => {
    run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    const { token } = createSession(user, { ip, userAgent });
    audit.record({
      entityType: 'AUTH',
      entityId: user.id,
      action: ACTIONS.LOGIN_SUCCEEDED,
      actor: { id: user.id, name: user.name, email: user.email, type: 'USER' },
      comments: challenge?.via_master ? 'Signed in with the demo master code' : null,
      ip,
      userAgent
    });
    return { token, user: toActor(get('SELECT * FROM users WHERE id = ?', [user.id])) };
  });
}

export function logout(token, actor) {
  revokeSession(token);
  if (actor) {
    audit.record({ entityType: 'AUTH', entityId: actor.id, action: ACTIONS.LOGOUT, actor });
  }
  return { ok: true };
}

export function activeSessions(userId) {
  return all('SELECT id, created_at, last_seen_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC', [
    userId
  ]);
}

export default {
  issueOtp,
  verifyOtp,
  masterCode,
  logCaptureCode,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForUser,
  requestLoginOtp,
  verifyLoginOtp,
  logout,
  toActor,
  activeSessions
};
