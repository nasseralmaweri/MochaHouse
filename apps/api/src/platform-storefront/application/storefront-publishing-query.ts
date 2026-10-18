import { PlatformTenantQueryError } from '../../platform-tenants/application/platform-tenant-query';

// SC4f-3a — request bodies for storefront publishing. Exact shapes only: an
// unknown field is refused, never ignored, so nothing else can be smuggled
// into a publishing decision (and nothing in a body can name a business —
// that is the route's :tenantId).

const REASON_MIN = 10;
const REASON_MAX = 500;
const SLUG_MAX = 63;

export interface StorefrontChangeInput {
  reason: string;
  confirmSlug: string;
}

export interface StorefrontAssignInput extends StorefrontChangeInput {
  kind: 'PLATFORM_SUBDOMAIN' | 'LEGACY';
  hostname: string | null;
}

function record(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PlatformTenantQueryError('The request body must be an object.');
  }
  return body as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !keys.includes(key))
  ) {
    throw new PlatformTenantQueryError(
      `Send exactly { ${allowed.join(', ')} }.`,
    );
  }
}

function reasonOf(value: unknown): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (
    reason.length < REASON_MIN ||
    reason.length > REASON_MAX ||
    // Control characters are refused on purpose (the same rule as SC4e).
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(reason)
  ) {
    throw new PlatformTenantQueryError(
      `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`,
    );
  }
  return reason;
}

function slugOf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SLUG_MAX
  ) {
    throw new PlatformTenantQueryError("Type the business's slug to confirm.");
  }
  return value.trim();
}

export function parseStorefrontChange(body: unknown): StorefrontChangeInput {
  const value = record(body);
  exactKeys(value, ['reason', 'confirmSlug'], ['reason', 'confirmSlug']);
  return {
    reason: reasonOf(value.reason),
    confirmSlug: slugOf(value.confirmSlug),
  };
}

export function parseStorefrontAssign(body: unknown): StorefrontAssignInput {
  const value = record(body);
  exactKeys(
    value,
    ['kind', 'hostname', 'reason', 'confirmSlug'],
    ['kind', 'reason', 'confirmSlug'],
  );
  if (value.kind !== 'PLATFORM_SUBDOMAIN' && value.kind !== 'LEGACY') {
    throw new PlatformTenantQueryError(
      'kind must be PLATFORM_SUBDOMAIN or LEGACY.',
    );
  }
  let hostname: string | null = null;
  if (value.kind === 'LEGACY') {
    if (typeof value.hostname !== 'string' || value.hostname.trim() === '') {
      throw new PlatformTenantQueryError(
        'Choose one of the approved existing addresses.',
      );
    }
    hostname = value.hostname.trim();
  } else if (value.hostname !== undefined) {
    // The platform address is always derived from the business's slug.
    throw new PlatformTenantQueryError(
      'A platform address is derived from the business; do not send hostname.',
    );
  }
  return {
    kind: value.kind,
    hostname,
    reason: reasonOf(value.reason),
    confirmSlug: slugOf(value.confirmSlug),
  };
}
