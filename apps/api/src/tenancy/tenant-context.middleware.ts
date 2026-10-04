import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { runWithTenantContext } from '@mocha-house/database';
import { HttpTenantContextResolver } from './http-tenant-context.resolver';
import type { TenantContextRequest } from './tenant-context-request';

export { REQUEST_ID_HEADER } from './request-id.middleware';

// Establishes the TenantContext for every NON-member API request (public,
// customer and other unauthenticated routes), before any guard or handler
// runs:
//   1. Reads the server-side request id RequestIdMiddleware assigned.
//   2. Asks the resolver for the context. The resolver is never given the
//      request, so no client-supplied tenant id (header, query, body) can
//      reach tenant selection.
//   3. Attaches it as `request.tenantContext` (the explicit access path) and
//      runs the rest of the request inside the async-scoped carrier used by
//      diagnostics such as the tenant query audit.
//
// Milestone S0F — NOT applied to the member routes (/api/v1/admin/*,
// /api/v1/internal/*; see TenancyModule). Their tenant is the authenticated
// administrator's validated active business, which only InternalAuthGuard
// can establish — a deployment-wide tenant must never stand in for it.
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly resolver: HttpTenantContextResolver) {}

  use(request: TenantContextRequest, _response: Response, next: NextFunction) {
    if (!request.requestId) {
      throw new Error(
        'RequestIdMiddleware must run before TenantContextMiddleware.',
      );
    }
    const context = this.resolver.resolve(request.requestId);

    request.tenantContext = context;

    runWithTenantContext(context, () => next());
  }
}
