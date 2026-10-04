import type { Request } from 'express';
import type { TenantContext } from '@mocha-house/database';

// The request shape once the tenancy middleware has run — mirrors how the
// auth guards attach `customerIdentity` / `internalUser` / `authorization`.
//   requestId     — set by RequestIdMiddleware on every route.
//   tenantContext — set by TenantContextMiddleware on non-member routes, and
//                   by InternalAuthGuard (Milestone S0F) on member routes.
export interface TenantContextRequest extends Request {
  requestId?: string;
  tenantContext?: TenantContext;
}
