import { BadRequestException } from '@nestjs/common';
import { isValidTenantId } from '@mocha-house/database';

// Milestone S0F — how an internal client states which business it wants to
// operate in for one request (the future Business switcher sends it on
// every Admin API call).
//
// It is INTENT, never authority: InternalAuthGuard only builds a
// TenantContext for it after proving the authenticated identity is an
// ACTIVE member of that ACTIVE tenant. Changing it to another tenant's id
// therefore yields the same generic 403 as "no such business".
//
// A header (rather than server-side session state or a cookie) because the
// internal boundary is a stateless bearer-token API: the web keeps the
// token server-side and proxies Admin calls, so it can attach this header
// the same way it attaches Authorization. Nothing is persisted, so there is
// no server-side "current business" that could go stale across tabs.
export const ACTIVE_TENANT_HEADER = 'x-tenant-id';

// Absent -> null (the guard may select the identity's only business).
// Present -> must be exactly one canonical tenant id; anything else is a
// malformed request (400), never "fall back to some default tenant".
export function readRequestedTenantId(
  value: string | string[] | undefined,
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || !isValidTenantId(value)) {
    throw new BadRequestException(
      `${ACTIVE_TENANT_HEADER} must be a single canonical business id.`,
    );
  }
  return value;
}
