import { Inject, Injectable } from '@nestjs/common';
import {
  createTenantContext,
  type SingleTenantResolution,
  type TenantContext,
} from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';
import { SINGLE_TENANT_RESOLUTION } from './single-tenant-resolution.provider';

// The seam through which an HTTP request's TenantContext is established.
// Everything downstream consumes the TenantContext and never learns which
// resolver produced it.
//
// A resolver never receives the request itself, so no client-supplied
// header, query string or body field can influence which tenant is chosen.
// Since SC4f-1 it receives one more input: a storefront hostname that
// TenantContextMiddleware has already VERIFIED as signed by the web tier
// (storefront-context.ts) — or null. It returns null when no business serves
// the request; the middleware then refuses it.
export abstract class HttpTenantContextResolver {
  abstract resolve(
    requestId: string,
    verifiedStorefrontHost: string | null,
  ): Promise<TenantContext | null>;
}

// S0C: every NON-member request (public / customer routes) operates as the
// single tenant validated at startup. principalType is 'anonymous' because
// no authenticated principal is bound to the tenant — binding for customers
// arrives with tenant-bound customer auth (S0G). Since S0F this resolver is
// never consulted for the authenticated internal routes (/api/v1/admin/*,
// /api/v1/internal/*): their TenantContext is the administrator's validated
// active business, established by InternalAuthGuard.
//
// SC4f-1: the resolver while STOREFRONT_HOST_ROUTING_ENABLED is off — the
// legacy behaviour, unchanged; any storefront hostname is ignored.
@Injectable()
export class SingleTenantHttpContextResolver extends HttpTenantContextResolver {
  constructor(
    @Inject(SINGLE_TENANT_RESOLUTION)
    private readonly resolution: SingleTenantResolution,
  ) {
    super();
  }

  resolve(requestId: string): Promise<TenantContext> {
    return Promise.resolve(
      createTenantContext({
        tenantId: this.resolution.tenantId,
        principalType: 'anonymous',
        requestId,
      }),
    );
  }
}

// SC4f-1: the resolver while STOREFRONT_HOST_ROUTING_ENABLED is on. The
// business is the one the approved hostname registry assigns to the verified
// hostname — exact match, and only while published. Anything else (no
// verified hostname, an unknown one, an unpublished one) is null: there is
// no default business, the legacy one included (Mocha House's own addresses
// are registry rows like any other).
@Injectable()
export class StorefrontHostHttpContextResolver extends HttpTenantContextResolver {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async resolve(
    requestId: string,
    verifiedStorefrontHost: string | null,
  ): Promise<TenantContext | null> {
    if (verifiedStorefrontHost === null) return null;
    const host = await this.prisma.storefrontHost.findUnique({
      where: { hostname: verifiedStorefrontHost },
      select: { storefrontTenantId: true, published: true },
    });
    if (!host || !host.published) return null;
    return createTenantContext({
      tenantId: host.storefrontTenantId,
      principalType: 'anonymous',
      requestId,
    });
  }
}
