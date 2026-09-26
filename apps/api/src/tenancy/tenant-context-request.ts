import type { Request } from 'express';
import type { TenantContext } from '@mocha-house/database';

// The request shape once TenantContextMiddleware has run — mirrors how the
// auth guards attach `customerIdentity` / `internalUser` / `authorization`.
export interface TenantContextRequest extends Request {
  tenantContext?: TenantContext;
}
