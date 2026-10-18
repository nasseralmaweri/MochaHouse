import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  STOREFRONT_HOST_HEADER,
  STOREFRONT_HOST_SIGNATURE_HEADER,
  STOREFRONT_HOST_TIMESTAMP_HEADER,
  STOREFRONT_NOT_FOUND,
  type LocationMenuResponse,
  type LocationSummary,
} from '@mocha-house/contracts';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  createTenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  enrollTestCustomer,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { MediaStorageModule } from '../media/storage/media-storage.module';
import { MediaObjectsController } from '../media/api/media-objects.controller';
import { LocalMediaStorage } from '../media/storage/local-media-storage';
import { GettingStartedService } from '../locations/application/getting-started.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { signStorefrontContext } from './storefront-context';

// SC4f-1 — storefront host routing, end to end through the real middleware,
// resolver and registry. One API with STOREFRONT_HOST_ROUTING_ENABLED on
// serves two businesses (Mocha House and the test-only Tenant B) by the
// signed storefront hostname alone; a second API with the switch off proves
// the legacy single-business behaviour is unchanged. Covers: Host-header
// spoofing, forged / stale / tampered storefront context, unknown and
// unpublished hostnames, cross-business menus and prices, customer session
// isolation, per-business caching headers, suspension per resolved
// business, and no fallback to the legacy business.
describe('SC4f-1 storefront host routing (integration)', () => {
  let hostsApp: INestApplication<App>;
  let legacyApp: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);
  const secret = `sc4f1-storefront-secret-${'x'.repeat(24)}`;
  const customerSecret = 'sc4f1-customer-secret';

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;
  const HOST_A = `mocha-${suffix}.shop.test`;
  const HOST_B = `bravo-${suffix}.shop.test`;
  const HOST_HIDDEN = `hidden-${suffix}.shop.test`;
  const HOST_UNKNOWN = `nobody-${suffix}.shop.test`;
  const HOST_CUSTOM = `order-${suffix}.bravo-cafe.test`;
  const PRICE_A = 500;
  const PRICE_B = 725;

  type Fixtures = {
    locationId: string;
    categoryId: string;
    productId: string;
    menuId: string;
  };
  let A: Fixtures;
  let B: Fixtures;
  const createdSubjects: string[] = [];

  async function buildApi(hostRouting: boolean) {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = hostRouting ? '1' : '0';
    const moduleFixture = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        LocationsModule,
        CatalogModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        MediaStorageModule,
      ],
      controllers: [AppController, MediaObjectsController],
      providers: [AppService],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  async function fixturesFor(
    tenantId: string,
    price: number,
  ): Promise<Fixtures> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `HR Store ${suffix}`,
        slug: `hr-store-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
      select: { id: true },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: `HR Cat ${suffix}`, slug: `hr-cat-${suffix}` },
      select: { id: true },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `HR Latte ${suffix}`,
        slug: `hr-latte-${suffix}`,
        categoryId: category.id,
        basePrice: price,
      },
      select: { id: true },
    });
    const menu = await prisma.menu.create({
      data: { tenantId, name: `HR Menu ${suffix}`, slug: `hr-menu-${suffix}` },
      select: { id: true },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    return {
      locationId: location.id,
      categoryId: category.id,
      productId: product.id,
      menuId: menu.id,
    };
  }

  async function removeFixtures(f: Fixtures | undefined) {
    if (!f) return;
    await prisma.locationMenu.deleteMany({ where: { menuId: f.menuId } });
    await prisma.menuProduct.deleteMany({ where: { menuId: f.menuId } });
    await prisma.menu.deleteMany({ where: { id: f.menuId } });
    await prisma.product.deleteMany({ where: { id: f.productId } });
    await prisma.category.deleteMany({ where: { id: f.categoryId } });
    await prisma.location.deleteMany({ where: { id: f.locationId } });
  }

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const signed = (
    hostname: string,
    opts: { seconds?: number; key?: string; headerHost?: string } = {},
  ) => {
    const seconds = opts.seconds ?? nowSeconds();
    return {
      [STOREFRONT_HOST_HEADER]: opts.headerHost ?? hostname,
      [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
      [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
        opts.key ?? secret,
        hostname,
        seconds,
      ),
    };
  };
  const get = (
    app: INestApplication<App>,
    path: string,
    headers: Record<string, string> = {},
  ) => request(app.getHttpServer()).get(path).set(headers);

  const NOT_FOUND_BODY = {
    statusCode: 404,
    error: 'Not Found',
    code: STOREFRONT_NOT_FOUND,
    message: 'This storefront is not available.',
  };
  async function expectNoStorefront(
    path: string,
    headers: Record<string, string>,
  ) {
    const res = await get(hostsApp, path, headers);
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND_BODY);
    expect(res.headers['cache-control']).toBe('no-store');
  }

  const locationIds = async (headers: Record<string, string>) =>
    (
      (await get(hostsApp, '/api/v1/locations', headers).expect(200))
        .body as LocationSummary[]
    ).map((l) => l.id);

  // Approved hostnames are never deleted (database guard); the test removes
  // its own with triggers suspended for that one transaction.
  async function removeHosts() {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      await tx.storefrontHost.deleteMany({
        where: {
          hostname: { in: [HOST_A, HOST_B, HOST_HIDDEN, HOST_CUSTOM] },
        },
      });
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.SINGLE_TENANT_ID = TENANT_A;
    process.env.STOREFRONT_CONTEXT_SECRET = secret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    legacyApp = await buildApi(false);
    prisma = legacyApp.get(PrismaService);
    await createTestTenantB(prisma);
    hostsApp = await buildApi(true);

    A = await fixturesFor(TENANT_A, PRICE_A);
    B = await fixturesFor(TENANT_B, PRICE_B);
    const now = new Date();
    await prisma.storefrontHost.createMany({
      data: [
        {
          hostname: HOST_A,
          storefrontTenantId: TENANT_A,
          kind: 'LEGACY',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_B,
          storefrontTenantId: TENANT_B,
          kind: 'PLATFORM_SUBDOMAIN',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_HIDDEN,
          storefrontTenantId: TENANT_B,
          kind: 'PLATFORM_SUBDOMAIN',
        },
        {
          hostname: HOST_CUSTOM,
          storefrontTenantId: TENANT_B,
          kind: 'CUSTOM',
          published: true,
          publishedAt: now,
        },
      ],
    });
  });

  afterAll(async () => {
    try {
      await prisma.customer.deleteMany({
        where: { externalSubject: { in: createdSubjects } },
      });
      await removeHosts();
      await removeFixtures(A);
      await removeFixtures(B);
      await removeTestTenantB(prisma);
    } finally {
      await hostsApp?.close();
      await legacyApp?.close();
      process.env = { ...originalEnv };
    }
  });

  // --- resolution by signed hostname --------------------------------------

  it("serves each business's own locations by its signed hostname, and nothing of the other's", async () => {
    const seenA = await locationIds(signed(HOST_A));
    expect(seenA).toContain(A.locationId);
    expect(seenA).not.toContain(B.locationId);
    const seenB = await locationIds(signed(HOST_B));
    expect(seenB).toContain(B.locationId);
    expect(seenB).not.toContain(A.locationId);
  });

  it("serves each business's own menu at its own prices; the other's location reads like a missing one", async () => {
    for (const [host, own, other, price] of [
      [HOST_A, A, B, PRICE_A],
      [HOST_B, B, A, PRICE_B],
    ] as const) {
      const res = await get(
        hostsApp,
        `/api/v1/locations/${own.locationId}/menu`,
        signed(host),
      ).expect(200);
      const menu = res.body as LocationMenuResponse;
      expect(menu.menu.id).toBe(own.menuId);
      expect(menu.menu.products.map((p) => p.product.id)).toEqual([
        own.productId,
      ]);
      expect(menu.menu.products[0].effectivePrice).toBe(price);

      const foreign = await get(
        hostsApp,
        `/api/v1/locations/${other.locationId}/menu`,
        signed(host),
      );
      const missing = await get(
        hostsApp,
        `/api/v1/locations/${randomUUID()}/menu`,
        signed(host),
      );
      expect(foreign.status).toBe(missing.status);
      expect(foreign.body).toEqual(missing.body);
      expect(JSON.stringify(foreign.body)).not.toContain(other.menuId);
    }
  });

  it('marks every storefront answer uncacheable and varying by storefront', async () => {
    const res = await get(hostsApp, '/api/v1/locations', signed(HOST_A));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toMatch(/x-centerivo-storefront-host/i);
  });

  // --- no business: one uniform 404, never a default business --------------

  it('refuses a request with no storefront context — no fallback to the legacy business', async () => {
    await expectNoStorefront('/api/v1/locations', {});
  });

  it('ignores Host / X-Forwarded-Host spoofing: only a signed context counts', async () => {
    await expectNoStorefront('/api/v1/locations', { Host: HOST_B });
    await expectNoStorefront('/api/v1/locations', {
      'X-Forwarded-Host': HOST_B,
    });
    // An unsigned storefront header is no better.
    await expectNoStorefront('/api/v1/locations', {
      [STOREFRONT_HOST_HEADER]: HOST_B,
    });
    // A signed context for A still serves A, whatever Host claims.
    const seen = await locationIds({ ...signed(HOST_A), Host: HOST_B });
    expect(seen).toContain(A.locationId);
    expect(seen).not.toContain(B.locationId);
  });

  it('refuses a forged, stale, future-dated or tampered storefront context', async () => {
    const path = `/api/v1/locations/${B.locationId}/menu`;
    // Signed with the wrong key.
    await expectNoStorefront(path, signed(HOST_B, { key: 'y'.repeat(48) }));
    // Outside the 60-second window, either side.
    await expectNoStorefront(
      path,
      signed(HOST_B, { seconds: nowSeconds() - 120 }),
    );
    await expectNoStorefront(
      path,
      signed(HOST_B, { seconds: nowSeconds() + 120 }),
    );
    // A's valid signature presented for B's hostname.
    await expectNoStorefront(path, signed(HOST_A, { headerHost: HOST_B }));
    // Signed, but not in normalized form.
    await expectNoStorefront(path, signed(HOST_B.toUpperCase()));
    await expectNoStorefront(path, signed(`${HOST_B}:443`));
    // Malformed signature and timestamp.
    await expectNoStorefront(path, {
      ...signed(HOST_B),
      [STOREFRONT_HOST_SIGNATURE_HEADER]: 'not-hex',
    });
    await expectNoStorefront(path, {
      ...signed(HOST_B),
      [STOREFRONT_HOST_TIMESTAMP_HEADER]: '1e9',
    });
  });

  it('refuses an unknown or unpublished hostname, even when correctly signed', async () => {
    await expectNoStorefront('/api/v1/locations', signed(HOST_UNKNOWN));
    await expectNoStorefront('/api/v1/locations', signed(HOST_HIDDEN));
  });

  it('unpublishing takes effect on the next request, and republishing restores it', async () => {
    await prisma.storefrontHost.update({
      where: { hostname: HOST_B },
      data: { published: false, publishedAt: null },
    });
    try {
      await expectNoStorefront('/api/v1/locations', signed(HOST_B));
    } finally {
      await prisma.storefrontHost.update({
        where: { hostname: HOST_B },
        data: { published: true, publishedAt: new Date() },
      });
    }
    expect(await locationIds(signed(HOST_B))).toContain(B.locationId);
  });

  it('resolves a published custom-domain hostname like any other approved address', async () => {
    const seen = await locationIds(signed(HOST_CUSTOM));
    expect(seen).toContain(B.locationId);
    expect(seen).not.toContain(A.locationId);
  });

  it('refuses HEAD and writes without a context just like reads', async () => {
    const head = await request(hostsApp.getHttpServer()).head(
      '/api/v1/locations',
    );
    expect(head.status).toBe(404);
    const write = await request(hostsApp.getHttpServer())
      .patch('/api/v1/customers/me')
      .set({ Host: HOST_A })
      .send({ displayName: 'x' });
    expect(write.status).toBe(404);
  });

  // Documented limit (docs/security/storefront-host-routing.md): a context
  // is not bound to one request, so within its window it can be reused — but
  // only for that same published storefront, which the public web app
  // serves to anyone anyway.
  it('a reused context still reaches only its own storefront', async () => {
    const context = signed(HOST_B);
    expect(await locationIds(context)).toContain(B.locationId);
    const again = await locationIds(context);
    expect(again).toContain(B.locationId);
    expect(again).not.toContain(A.locationId);
  });

  it('keeps the business-free routes reachable without a storefront context', async () => {
    await get(hostsApp, '/').expect(200);
    await request(hostsApp.getHttpServer()).head('/').expect(200);
    // Local/dev media bytes: keys are not per business, and production
    // serves the same bytes from a public bucket whatever the business's
    // state — so they are answered without a business, as before.
    await hostsApp.get(LocalMediaStorage).put({
      objectKey: `media/sc4f1-${suffix}.txt`,
      body: Buffer.from('bytes'),
      contentType: 'text/plain',
    });
    await get(
      hostsApp,
      `/api/v1/media/objects/media/sc4f1-${suffix}.txt`,
    ).expect(200);
  });

  it('reports the storefront as live only while one of its hostnames is published', async () => {
    const service = hostsApp.get(GettingStartedService);
    const authorization = {
      assertCorporate: () => undefined,
    } as unknown as AuthorizationContext;
    const live = async (tenantId: string) =>
      (
        await service.checklist(
          authorization,
          createTenantContext({
            tenantId,
            principalType: 'anonymous',
            requestId: 'sc4f1',
          }),
        )
      ).storefrontLive;
    expect(await live(TENANT_B)).toBe(true);
    await prisma.storefrontHost.updateMany({
      where: { hostname: { in: [HOST_B, HOST_CUSTOM] } },
      data: { published: false, publishedAt: null },
    });
    try {
      expect(await live(TENANT_B)).toBe(false);
    } finally {
      await prisma.storefrontHost.updateMany({
        where: { hostname: { in: [HOST_B, HOST_CUSTOM] } },
        data: { published: true, publishedAt: new Date() },
      });
    }
  });

  // --- existing rules per resolved business --------------------------------

  it("a suspended business's storefront is closed; the other business is unaffected", async () => {
    await prisma.tenant.update({
      where: { id: TENANT_B },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    try {
      const res = await get(hostsApp, '/api/v1/locations', signed(HOST_B));
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'BUSINESS_UNAVAILABLE' });
      // Without a context it is still the uniform 404: nothing reveals the
      // suspension to a caller who cannot name the storefront.
      await expectNoStorefront('/api/v1/locations', { Host: HOST_B });
      expect(await locationIds(signed(HOST_A))).toContain(A.locationId);
    } finally {
      await prisma.tenant.update({
        where: { id: TENANT_B },
        data: { status: 'ACTIVE', suspensionReason: null },
      });
    }
  });

  it("a customer signed in on one business's storefront cannot use that session on another's", async () => {
    const subject = `dev:sc4f1-${suffix}`;
    createdSubjects.push(subject);
    const token = signDevJwt(
      { sub: subject, email: `sc4f1-${suffix}@example.com`, name: 'SC4f1' },
      customerSecret,
      3600,
    );
    const me = (host: string) =>
      get(hostsApp, '/api/v1/customers/me', {
        ...signed(host),
        Authorization: `Bearer ${token}`,
      });

    // SC4f-2 — the customer has joined business A only.
    await enrollTestCustomer(prisma, TENANT_A, { provider: 'dev', subject });
    await me(HOST_A).expect(200);
    const crossed = await me(HOST_B);
    expect(crossed.status).toBe(403);
    expect(crossed.body).toMatchObject({ code: 'CUSTOMER_NOT_ENROLLED' });
    // Nothing was created for the other business.
    const rows = await prisma.customer.findMany({
      where: { externalSubject: subject },
      select: { tenantId: true },
    });
    expect(rows).toEqual([{ tenantId: TENANT_A }]);
  });

  // --- legacy mode ----------------------------------------------------------

  it('with routing off, serves the single business exactly as before and ignores any storefront context', async () => {
    const variants: Record<string, string>[] = [
      {},
      signed(HOST_B),
      { Host: HOST_B },
    ];
    for (const headers of variants) {
      const res = await get(legacyApp, '/api/v1/locations', headers).expect(
        200,
      );
      const seen = (res.body as LocationSummary[]).map((l) => l.id);
      expect(seen).toContain(A.locationId);
      expect(seen).not.toContain(B.locationId);
      expect(res.headers['vary'] ?? '').not.toMatch(/storefront/i);
    }
  });
});
