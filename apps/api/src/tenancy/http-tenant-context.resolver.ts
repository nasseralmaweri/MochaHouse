import { Inject, Injectable } from '@nestjs/common';
import {
  createTenantContext,
  type SingleTenantResolution,
  type TenantContext,
} from '@mocha-house/database';
import { SINGLE_TENANT_RESOLUTION } from './single-tenant-resolution.provider';

// The seam through which an HTTP request's TenantContext is established.
// Everything downstream consumes the TenantContext and never learns which
// resolver produced it; later milestones swap the implementation (host /
// domain resolution, TenantSession) behind this abstract class without
// touching consumers.
//
// A resolver receives only the request id — deliberately NOT the request
// itself in S0C — so no client-supplied header, query string or body field
// can ever influence which tenant is chosen.
export abstract class HttpTenantContextResolver {
  abstract resolve(requestId: string): TenantContext;
}

// S0C: every NON-member request (public / customer routes) operates as the
// single tenant validated at startup. principalType is 'anonymous' because
// no authenticated principal is bound to the tenant — binding for customers
// arrives with tenant-bound customer auth (S0G). Since S0F this resolver is
// never consulted for the authenticated internal routes (/api/v1/admin/*,
// /api/v1/internal/*): their TenantContext is the administrator's validated
// active business, established by InternalAuthGuard.
@Injectable()
export class SingleTenantHttpContextResolver extends HttpTenantContextResolver {
  constructor(
    @Inject(SINGLE_TENANT_RESOLUTION)
    private readonly resolution: SingleTenantResolution,
  ) {
    super();
  }

  resolve(requestId: string): TenantContext {
    return createTenantContext({
      tenantId: this.resolution.tenantId,
      principalType: 'anonymous',
      requestId,
    });
  }
}
