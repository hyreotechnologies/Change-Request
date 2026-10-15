import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function loadDotEnv() {
  const file = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

if (isProduction && (!env.APP_SECRET || env.APP_SECRET.length < 32)) {
  throw new Error('APP_SECRET of at least 32 characters is required when NODE_ENV=production');
}

export const config = {
  env: env.NODE_ENV || 'development',
  isProduction,
  port: Number(env.PORT || 4100),
  host: env.HOST || '0.0.0.0',
  appUrl: (env.APP_URL || `http://localhost:${Number(env.PORT || 4100)}`).replace(/\/+$/, ''),
  appSecret: env.APP_SECRET || 'hyreo-crms-development-secret-change-me-please',
  rootDir: ROOT_DIR,
  storageDir: env.STORAGE_DIR || path.join(ROOT_DIR, 'storage'),
  get documentsDir() {
    return path.join(this.storageDir, 'documents');
  },
  get databaseFile() {
    return env.DATABASE_FILE || path.join(this.storageDir, 'hcrms.db');
  },
  publicDir: path.join(ROOT_DIR, 'public'),
  cookies: {
    session: 'hcrms_session',
    portal: 'hcrms_portal',
    secure: (env.APP_URL || '').startsWith('https://')
  },
  seedOnBoot: env.SEED_ON_BOOT !== 'false',
  logLevel: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  // OAuth apps registered once by the vendor; customers only click Connect
  oauth: {
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '' },
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
    slack: { clientId: env.SLACK_CLIENT_ID || '', clientSecret: env.SLACK_CLIENT_SECRET || '' }
  },
  rateLimit: {
    otpRequestsPerHour: Number(env.OTP_REQUESTS_PER_HOUR || 20),
    apiRequestsPerMinute: Number(env.API_REQUESTS_PER_MINUTE || 600)
  }
};

for (const dir of [config.storageDir, config.documentsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export default config;
