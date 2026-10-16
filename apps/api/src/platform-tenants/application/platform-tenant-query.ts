import type { PlatformTenantStatus } from '@mocha-house/contracts';

// SC1c — the tenant registry's query parameters, validated strictly and
// bounded. Anything outside these rules is refused (400), never coerced:
// a typo must not silently widen a search.

export const PLATFORM_TENANT_PAGE_SIZE_DEFAULT = 20;
export const PLATFORM_TENANT_PAGE_SIZE_MAX = 50;
// Caps the OFFSET a request can ask for (at most 49,950 rows skipped).
export const PLATFORM_TENANT_PAGE_MAX = 1_000;
export const PLATFORM_TENANT_SEARCH_MAX_LENGTH = 80;

// Letters, digits, spaces and - ' & . , only. Deliberately no % or _ (SQL
// LIKE wildcards) and no control characters.
const SEARCH_PATTERN = /^[\p{L}\p{N} '&.,-]+$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,4}$/;
const STATUSES: readonly PlatformTenantStatus[] = ['ACTIVE', 'SUSPENDED'];

export class PlatformTenantQueryError extends Error {}

export interface PlatformPaging {
  page: number;
  pageSize: number;
}

export interface PlatformTenantListQuery extends PlatformPaging {
  q: string | null;
  status: PlatformTenantStatus | null;
}

type Raw = Record<string, unknown>;

function single(raw: Raw, name: string): string | undefined {
  const value = raw[name];
  if (value === undefined) return undefined;
  // ?status=A&status=B arrives as an array: refused, not "first wins".
  if (typeof value !== 'string') {
    throw new PlatformTenantQueryError(`Invalid ${name}.`);
  }
  return value;
}

function boundedInteger(
  raw: Raw,
  name: string,
  fallback: number,
  max: number,
): number {
  const value = single(raw, name);
  if (value === undefined) return fallback;
  if (!POSITIVE_INTEGER.test(value) || Number(value) > max) {
    throw new PlatformTenantQueryError(`Invalid ${name}.`);
  }
  return Number(value);
}

export function parsePaging(raw: Raw): PlatformPaging {
  return {
    page: boundedInteger(raw, 'page', 1, PLATFORM_TENANT_PAGE_MAX),
    pageSize: boundedInteger(
      raw,
      'pageSize',
      PLATFORM_TENANT_PAGE_SIZE_DEFAULT,
      PLATFORM_TENANT_PAGE_SIZE_MAX,
    ),
  };
}

export function parseTenantListQuery(raw: Raw): PlatformTenantListQuery {
  const rawQ = single(raw, 'q');
  let q: string | null = null;
  if (rawQ !== undefined) {
    const trimmed = rawQ.trim().replace(/\s+/g, ' ');
    if (trimmed.length > 0) {
      if (
        trimmed.length > PLATFORM_TENANT_SEARCH_MAX_LENGTH ||
        !SEARCH_PATTERN.test(trimmed)
      ) {
        throw new PlatformTenantQueryError('Invalid q.');
      }
      q = trimmed;
    }
  }

  const rawStatus = single(raw, 'status');
  let status: PlatformTenantStatus | null = null;
  if (rawStatus !== undefined && rawStatus !== '') {
    if (!STATUSES.includes(rawStatus as PlatformTenantStatus)) {
      throw new PlatformTenantQueryError('Invalid status.');
    }
    status = rawStatus as PlatformTenantStatus;
  }

  return { q, status, ...parsePaging(raw) };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTenantId(value: string): boolean {
  return UUID_PATTERN.test(value);
}
