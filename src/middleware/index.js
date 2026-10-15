import crypto from 'node:crypto';
import { AppError, errors, translateDbError } from '../lib/errors.js';
import authService from '../services/auth.js';
import { can } from '../services/rbac.js';
import config from '../config.js';

/** Minimal cookie parser — avoids an extra dependency for two cookies. */
export function cookies(req, res, next) {
  const header = req.headers.cookie || '';
  req.cookies = Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        if (index === -1) return [part, ''];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );

  res.setCookie = (name, value, { maxAgeSeconds = 43200, httpOnly = true, path = '/' } = {}) => {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      `Path=${path}`,
      `Max-Age=${maxAgeSeconds}`,
      'SameSite=Lax'
    ];
    if (httpOnly) parts.push('HttpOnly');
    if (config.cookies.secure) parts.push('Secure');
    appendCookie(res, parts.join('; '));
  };

  res.clearCookie2 = (name, path = '/') => {
    appendCookie(res, `${name}=; Path=${path}; Max-Age=0; SameSite=Lax${config.cookies.secure ? '; Secure' : ''}; HttpOnly`);
  };

  next();
}

function appendCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [value]);
  else res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, value] : [existing, value]);
}

export function requestContext(req, res, next) {
  req.id = crypto.randomUUID();
  req.clientIp =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
  req.userAgent = req.headers['user-agent'] || null;
  res.setHeader('X-Request-Id', req.id);
  next();
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.cookies.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** Attaches req.user when a valid session cookie is present; never throws. */
export function loadSession(req, res, next) {
  const token = req.cookies?.[config.cookies.session];
  if (token) {
    const resolved = authService.resolveSession(token);
    if (resolved) {
      req.sessionToken = token;
      req.user = { ...resolved.user, ip: req.clientIp, userAgent: req.userAgent };
    }
  }
  next();
}

export function requireSession(req, res, next) {
  if (!req.user) return next(errors.authRequired());
  return next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return next(errors.authRequired());
    if (!can(req.user, permission)) return next(errors.forbidden());
    return next();
  };
}

/** Wraps async handlers so rejections reach the error middleware. */
export function handler(fn) {
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 60, key = (req) => req.clientIp } = {}) {
  return (req, res, next) => {
    const id = `${req.path}:${key(req)}`;
    const now = Date.now();
    const bucket = buckets.get(id) || { count: 0, resetAt: now + windowMs };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    buckets.set(id, bucket);
    if (bucket.count > max) {
      res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
      return next(errors.rateLimited());
    }
    return next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
}, 300_000).unref?.();

export function notFound(req, res, next) {
  next(errors.notFound(`No route matches ${req.method} ${req.path}`));
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const translated = error instanceof AppError ? error : translateDbError(error) || null;
  const appError = translated || errors.internal();

  if (!(error instanceof AppError) && !translated) {
    console.error(`[${req.id}] ${req.method} ${req.path}`, error);
  }

  return res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      details: appError.details || undefined,
      request_id: req.id
    }
  });
}

export default {
  cookies,
  requestContext,
  securityHeaders,
  loadSession,
  requireSession,
  requirePermission,
  handler,
  rateLimit,
  notFound,
  errorHandler
};
