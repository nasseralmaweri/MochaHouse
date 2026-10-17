import type { OwnerRegistrationAvailability } from '@mocha-house/contracts';

// SC4a — business owner self-service registration is OFF unless the
// deployment turns it on (owner decision D1), and read fresh on every request
// so turning it off takes effect at once. Every registration route checks it
// server-side; a disabled deployment answers 404, as if the routes did not
// exist.
//
// Enabled needs ALL of:
//   SELF_SERVICE_REGISTRATION_ENABLED  exactly "1" or "true"
//   SELF_SERVICE_TERMS_VERSION         the Terms version shown and recorded
//   SELF_SERVICE_PRIVACY_VERSION       the Privacy Policy version (D8)
//   SELF_SERVICE_REGISTRATION_SECRET   at least 32 characters: the server-only
//                                      key for a new login's initial password
// Anything missing or malformed keeps registration OFF (fail closed).
// Optional:
//   SELF_SERVICE_TERMS_URL / SELF_SERVICE_PRIVACY_URL  https links to the
//     documents (http only on a loopback host); no link is shown otherwise.
//   SELF_SERVICE_REGISTRATION_DAILY_LIMIT  new registrations accepted per
//     rolling 24 hours, all emails together (default 50).
export const SELF_SERVICE_REGISTRATION_ENV =
  'SELF_SERVICE_REGISTRATION_ENABLED';
export const SELF_SERVICE_TERMS_VERSION_ENV = 'SELF_SERVICE_TERMS_VERSION';
export const SELF_SERVICE_PRIVACY_VERSION_ENV = 'SELF_SERVICE_PRIVACY_VERSION';
export const SELF_SERVICE_TERMS_URL_ENV = 'SELF_SERVICE_TERMS_URL';
export const SELF_SERVICE_PRIVACY_URL_ENV = 'SELF_SERVICE_PRIVACY_URL';
export const SELF_SERVICE_REGISTRATION_SECRET_ENV =
  'SELF_SERVICE_REGISTRATION_SECRET';
export const SELF_SERVICE_REGISTRATION_DAILY_LIMIT_ENV =
  'SELF_SERVICE_REGISTRATION_DAILY_LIMIT';

const DEFAULT_DAILY_LIMIT = 50;
const MIN_SECRET_LENGTH = 32;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface OwnerRegistrationConfig {
  termsVersion: string;
  privacyVersion: string;
  termsUrl: string | null;
  privacyUrl: string | null;
  secret: string;
  dailyLimit: number;
}

type Env = Record<string, string | undefined>;

function documentUrl(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return url.toString();
    if (
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      return url.toString();
    }
  } catch {
    // not a URL: no link
  }
  return null;
}

function dailyLimit(raw: string | undefined): number | null {
  const value = raw?.trim() ?? '';
  if (value === '') return DEFAULT_DAILY_LIMIT;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000
    ? parsed
    : null;
}

// The effective configuration, or null when registration is OFF.
export function ownerRegistrationConfig(
  env: Env = process.env,
): OwnerRegistrationConfig | null {
  const flag = (env[SELF_SERVICE_REGISTRATION_ENV] ?? '').trim().toLowerCase();
  if (flag !== '1' && flag !== 'true') return null;
  const termsVersion = env[SELF_SERVICE_TERMS_VERSION_ENV]?.trim() ?? '';
  const privacyVersion = env[SELF_SERVICE_PRIVACY_VERSION_ENV]?.trim() ?? '';
  const secret = env[SELF_SERVICE_REGISTRATION_SECRET_ENV] ?? '';
  const limit = dailyLimit(env[SELF_SERVICE_REGISTRATION_DAILY_LIMIT_ENV]);
  if (
    !VERSION_PATTERN.test(termsVersion) ||
    !VERSION_PATTERN.test(privacyVersion) ||
    secret.length < MIN_SECRET_LENGTH ||
    limit === null
  ) {
    return null;
  }
  return {
    termsVersion,
    privacyVersion,
    termsUrl: documentUrl(env[SELF_SERVICE_TERMS_URL_ENV]),
    privacyUrl: documentUrl(env[SELF_SERVICE_PRIVACY_URL_ENV]),
    secret,
    dailyLimit: limit,
  };
}

export function ownerRegistrationAvailability(
  env: Env = process.env,
): OwnerRegistrationAvailability {
  const config = ownerRegistrationConfig(env);
  if (!config) return { enabled: false };
  return {
    enabled: true,
    termsVersion: config.termsVersion,
    privacyVersion: config.privacyVersion,
    termsUrl: config.termsUrl,
    privacyUrl: config.privacyUrl,
  };
}
