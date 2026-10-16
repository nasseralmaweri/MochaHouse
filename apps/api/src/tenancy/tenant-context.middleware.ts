import {
  Injectable,
  NestMiddleware,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { runWithTenantContext } from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';
import { HttpTenantContextResolver } from './http-tenant-context.resolver';
import type { TenantContextRequest } from './tenant-context-request';

export { REQUEST_ID_HEADER } from './request-id.middleware';

export const BUSINESS_UNAVAILABLE = 'BUSINESS_UNAVAILABLE';

// SC0.5a — the ONLY routes a non-ACTIVE (SUSPENDED) business still answers
// on its public/customer surface. Fail-closed: every other route — including
// any route added later — is refused until someone deliberately lists it here.
//   GET /                         static scaffold route (load-balancer probe)
//   GET /api/v1/orders/:orderId   guest order status: read-only and gated by
//                                 the order's access token, so a customer who
//                                 has already paid can still see their order.
// Deliberately NOT listed: the signed-in customer routes (/customers/me/*).
// Even their GETs create the customer record on first use
// (CustomersService.resolveOrCreateFromIdentity), so they are business writes.
// Matching is case-insensitive and tolerates one trailing slash, like
// Express's routing; only GET is ever allowed, so a match can only reach a
// read.
const SUSPENDED_TENANT_ALLOWED_GET_PATHS: readonly RegExp[] = [
  /^\/$/,
  /^\/api\/v1\/orders\/[^/]+\/?$/i,
];

export function isAllowedWhileTenantInactive(
  method: string,
  originalUrl: string,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }
  const path = originalUrl.split('?', 1)[0];
  return SUSPENDED_TENANT_ALLOWED_GET_PATHS.some((pattern) =>
    pattern.test(path),
  );
}

// Establishes the TenantContext for every NON-member API request (public,
// customer and other unauthenticated routes), before any guard or handler
// runs:
//   1. Reads the server-side request id RequestIdMiddleware assigned.
//   2. Asks the resolver for the context. The resolver is never given the
//      request, so no client-supplied tenant id (header, query, body) can
//      reach tenant selection.
//   3. SC0.5a — refuses the request unless the business is ACTIVE (or the
//      route is one of the few listed above). Read on EVERY request, so a
//      suspension takes effect, and a reactivation restores service, without
//      a restart. The answer is one generic 503 that never says why the
//      business is unavailable (billing, security, request …).
//   4. Attaches it as `request.tenantContext` (the explicit access path) and
//      runs the rest of the request inside the async-scoped carrier used by
//      diagnostics such as the tenant query audit.
//
// Milestone S0F — NOT applied to the member routes (/api/v1/admin/*,
// /api/v1/internal/*; see TenancyModule). Their tenant is the authenticated
// administrator's validated active business, which only InternalAuthGuard
// can establish — a deployment-wide tenant must never stand in for it. That
// guard already refuses a non-ACTIVE business (InternalTenantMembershipService)
// — except, since SC3c-1, a business suspended for BILLING, whose staff it
// admits only to the routes marked for the operational wind-down.
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly resolver: HttpTenantContextResolver,
    private readonly prisma: PrismaService,
  ) {}

  async use(
    request: TenantContextRequest,
    response: Response,
    next: NextFunction,
  ) {
    if (!request.requestId) {
      throw new Error(
        'RequestIdMiddleware must run before TenantContextMiddleware.',
      );
    }
    const context = this.resolver.resolve(request.requestId);

    if (!isAllowedWhileTenantInactive(request.method, request.originalUrl)) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: context.tenantId },
        select: { status: true },
      });
      // A missing row is treated exactly like a suspended one: fail closed.
      if (tenant?.status !== 'ACTIVE') {
        response.setHeader('Cache-Control', 'no-store');
        throw new ServiceUnavailableException({
          statusCode: 503,
          error: 'Service Unavailable',
          code: BUSINESS_UNAVAILABLE,
          message: 'This business is not available right now.',
        });
      }
    }

    request.tenantContext = context;

    runWithTenantContext(context, () => next());
  }
}
