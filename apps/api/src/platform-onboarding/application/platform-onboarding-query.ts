import {
  PLATFORM_ONBOARDING_FILTERS,
  PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT,
  PLATFORM_REGISTRATION_FILTERS,
  type PlatformOnboardingFilter,
  type PlatformRegistrationFilter,
} from '@mocha-house/contracts';
import {
  PlatformTenantQueryError,
  parsePaging,
  type PlatformPaging,
} from '../../platform-tenants/application/platform-tenant-query';

// SC4e — the onboarding reports' query parameters, validated strictly and
// bounded like the tenant registry's: anything else is a 400, never coerced.

type Raw = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STUCK_DAYS = /^[1-9][0-9]?$/;
export const STUCK_DAYS_MAX = 90;
const REASON_MIN = 10;
const REASON_MAX = 500;

function single(raw: Raw, name: string): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PlatformTenantQueryError(`Invalid ${name}.`);
  }
  return value;
}

function oneOf<T extends string>(
  raw: Raw,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = single(raw, name);
  if (value === undefined || value === '') return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new PlatformTenantQueryError(`Invalid ${name}.`);
  }
  return value as T;
}

// A calendar day (UTC) as YYYY-MM-DD, checked to be a real date.
function day(raw: Raw, name: string): string | null {
  const value = single(raw, name);
  if (value === undefined || value === '') return null;
  if (!DATE.test(value)) throw new PlatformTenantQueryError(`Invalid ${name}.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new PlatformTenantQueryError(`Invalid ${name}.`);
  }
  return value;
}

export interface RegistrationListQuery extends PlatformPaging {
  filter: PlatformRegistrationFilter;
  createdFrom: string | null;
  createdTo: string | null;
}

export function parseRegistrationListQuery(raw: Raw): RegistrationListQuery {
  const createdFrom = day(raw, 'createdFrom');
  const createdTo = day(raw, 'createdTo');
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw new PlatformTenantQueryError(
      'createdFrom must not be after createdTo.',
    );
  }
  return {
    filter: oneOf(raw, 'filter', PLATFORM_REGISTRATION_FILTERS, 'all'),
    createdFrom,
    createdTo,
    ...parsePaging(raw),
  };
}

export interface OnboardingListQuery extends PlatformPaging {
  filter: PlatformOnboardingFilter;
  stuckDays: number;
}

export function parseOnboardingListQuery(raw: Raw): OnboardingListQuery {
  const rawDays = single(raw, 'stuckDays');
  let stuckDays = PLATFORM_ONBOARDING_STUCK_DAYS_DEFAULT;
  if (rawDays !== undefined && rawDays !== '') {
    if (!STUCK_DAYS.test(rawDays) || Number(rawDays) > STUCK_DAYS_MAX) {
      throw new PlatformTenantQueryError('Invalid stuckDays.');
    }
    stuckDays = Number(rawDays);
  }
  return {
    filter: oneOf(raw, 'filter', PLATFORM_ONBOARDING_FILTERS, 'all'),
    stuckDays,
    ...parsePaging(raw),
  };
}

export interface RegistrationControlInput {
  paused: boolean;
  reason: string;
}

// Body exactly { paused, reason }: nothing else is accepted.
export function parseRegistrationControl(
  body: unknown,
): RegistrationControlInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PlatformTenantQueryError('The request body must be an object.');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== 'paused' || keys[1] !== 'reason') {
    throw new PlatformTenantQueryError('Send exactly { paused, reason }.');
  }
  if (typeof record.paused !== 'boolean') {
    throw new PlatformTenantQueryError('paused must be true or false.');
  }
  const reason = typeof record.reason === 'string' ? record.reason.trim() : '';
  if (
    reason.length < REASON_MIN ||
    reason.length > REASON_MAX ||
    // Control characters are refused on purpose (the same rule as SC4d text).
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(reason)
  ) {
    throw new PlatformTenantQueryError(
      `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`,
    );
  }
  return { paused: record.paused, reason };
}
