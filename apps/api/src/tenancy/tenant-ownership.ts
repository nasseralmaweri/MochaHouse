import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@mocha-house/database';

// Milestone S0D-2 — establishes the tenant a CHILD write belongs to, from a
// parent row the server has already loaded (a Location, a checklist
// template, …), and fails closed unless that parent belongs to the
// request's TenantContext.
//
// Returns the parent's own tenantId, so the child copies ownership from its
// validated parent — never from client input, never from a default, never
// from the async context carrier. A parent in another tenant is reported
// exactly like a missing one (404 with the caller's message), so a write
// path can never be used to confirm that another tenant's record exists.
//
// This is write-path ownership validation only. General read isolation is
// S0E's job.
export function requireTenantOwnership(
  parent: { tenantId: string | null } | null | undefined,
  context: TenantContext,
  notFoundMessage: string,
): string {
  if (
    !parent ||
    parent.tenantId === null ||
    parent.tenantId !== context.tenantId
  ) {
    throw new NotFoundException(notFoundMessage);
  }
  return parent.tenantId;
}
