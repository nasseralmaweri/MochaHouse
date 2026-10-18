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
  type LocationMenuResponse,
  type StorefrontProfileResponse,
} from '@mocha-house/contracts';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  createTenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  TEST_TENANT_C_ID,
  TEST_TENANT_C_NAME,
  createTestTenantB,
  createTestTenantC,
  removeTestTenantB,
  removeTestTenantC,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { LoyaltySettingsService } from '../loyalty/application/loyalty-settings.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { signStorefrontContext } from './storefront-context';

// SC4f-3b — the storefront profile and per-business loyalty names, end to
// end through one API serving three businesses by their signed storefront
// hostname (host routing on), and a single-business API (routing off):
// each business's own name, ordering availability and points name;
// presentation "legacy" only for the configured business; menus and prices
// isolated; unknown and unpublished hostnames 404; the points name is
// presentation only (balances untouched) and changed only with an audit.
describe('SC4f-3b storefront profile (integration)', () => {
  let hostsApp: INestApplication<App>;
  let legacyApp: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);
  const secret = `sc4f3b-storefront-secret-${'x'.repeat(24)}`;
  const HOST_A = `mocha-${suffix}.shop.test`;
  const HOST_B = `bravo-${suffix}.shop.test`;
  const HOST_C = `charlie-${suffix}.shop.test`;
  const HOST_HIDDEN = `hidden-${suffix}.shop.test`;
  const createdLocationIds: string[] = [];
  const createdStaffIds: string[] = [];
  let locationB: string;
  let productB: string;
  let menuB: string;
  let categoryB: string;

  async function buildApi(hostRouting: boolean, legacyTenantId?: string) {
    process.env.STOREFRONT_HOST_ROUTING_ENABLED = hostRouting ? '1' : '0';
    if (legacyTenantId)
      process.env.LEGACY_STOREFRONT_TENANT_ID = legacyTenantId;
    else delete process.env.LEGACY_STOREFRONT_TENANT_ID;
    const moduleFixture = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        LocationsModule,
        CatalogModule,
        CustomerAuthModule,
        InternalAuthModule,
        SubscriptionsModule,
        LoyaltyModule,
      ],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }
  const at = (hostname: string) => {
    const seconds = Math.floor(Date.now() / 1000);
    return {
      [STOREFRONT_HOST_HEADER]: hostname,
      [STOREFRONT_HOST_TIMESTAMP_HEADER]: String(seconds),
      [STOREFRONT_HOST_SIGNATURE_HEADER]: signStorefrontContext(
        secret,
        hostname,
        seconds,
      ),
    };
  };
  const profileAt = (host: string) =>
    request(hostsApp.getHttpServer())
      .get('/api/v1/storefront/profile')
      .set(at(host));
  const bodyOf = (res: { body: unknown }) =>
    res.body as StorefrontProfileResponse;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.SINGLE_TENANT_ID = TENANT_1_MOCHA_HOUSE_ID;
    process.env.STOREFRONT_CONTEXT_SECRET = secret;
    legacyApp = await buildApi(false);
    prisma = legacyApp.get(PrismaService);
    await createTestTenantB(prisma);
    await createTestTenantC(prisma);
    // The configured legacy business: Mocha House.
    hostsApp = await buildApi(true, TENANT_1_MOCHA_HOUSE_ID);

    const now = new Date();
    await prisma.storefrontHost.createMany({
      data: [
        {
          hostname: HOST_A,
          storefrontTenantId: TENANT_1_MOCHA_HOUSE_ID,
          kind: 'LEGACY',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_B,
          storefrontTenantId: TEST_TENANT_B_ID,
          kind: 'PLATFORM_SUBDOMAIN',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_C,
          storefrontTenantId: TEST_TENANT_C_ID,
          kind: 'PLATFORM_SUBDOMAIN',
          published: true,
          publishedAt: now,
        },
        {
          hostname: HOST_HIDDEN,
          storefrontTenantId: TEST_TENANT_C_ID,
          kind: 'PLATFORM_SUBDOMAIN',
        },
      ],
    });
    // Business B: its own points name, and one location taking online
    // orders with its own menu and price.
    await prisma.loyaltyConfiguration.upsert({
      where: { tenantId_key: { tenantId: TEST_TENANT_B_ID, key: 'company' } },
      update: { pointsLabel: 'Stars' },
      create: {
        tenantId: TEST_TENANT_B_ID,
        key: 'company',
        pointsLabel: 'Stars',
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        name: `Bravo ${suffix}`,
        slug: `bravo-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
      select: { id: true },
    });
    locationB = location.id;
    createdLocationIds.push(location.id);
    categoryB = (
      await prisma.category.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'Tea',
          slug: `tea-${suffix}`,
        },
        select: { id: true },
      })
    ).id;
    productB = (
      await prisma.product.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: `Bravo Tea ${suffix}`,
          slug: `bravo-tea-${suffix}`,
          categoryId: categoryB,
          basePrice: 375,
        },
        select: { id: true },
      })
    ).id;
    menuB = (
      await prisma.menu.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          name: 'Bravo Menu',
          slug: `bravo-menu-${suffix}`,
        },
        select: { id: true },
      })
    ).id;
    await prisma.menuProduct.create({
      data: { tenantId: TEST_TENANT_B_ID, menuId: menuB, productId: productB },
    });
    await prisma.locationMenu.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        locationId: locationB,
        menuId: menuB,
      },
    });
  });

  afterAll(async () => {
    try {
      await prisma.locationMenu.deleteMany({ where: { menuId: menuB } });
      await prisma.menuProduct.deleteMany({ where: { menuId: menuB } });
      await prisma.menu.deleteMany({ where: { id: menuB } });
      await prisma.product.deleteMany({ where: { id: productB } });
      await prisma.category.deleteMany({ where: { id: categoryB } });
      await prisma.location.deleteMany({
        where: { id: { in: createdLocationIds } },
      });
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'SET LOCAL session_replication_role = replica',
        );
        await tx.storefrontHost.deleteMany({
          where: { hostname: { in: [HOST_A, HOST_B, HOST_C, HOST_HIDDEN] } },
        });
        await tx.internalAuditEvent.deleteMany({
          where: { tenantId: { in: [TEST_TENANT_B_ID, TEST_TENANT_C_ID] } },
        });
        await tx.internalUser.deleteMany({
          where: { id: { in: createdStaffIds } },
        });
      });
      await prisma.loyaltyConfiguration.deleteMany({
        where: { tenantId: { in: [TEST_TENANT_B_ID, TEST_TENANT_C_ID] } },
      });
      await removeTestTenantC(prisma);
      await removeTestTenantB(prisma);
    } finally {
      await hostsApp?.close();
      await legacyApp?.close();
      process.env = { ...originalEnv };
    }
  });

  it("gives each storefront only its own business's name, ordering state and points name", async () => {
    const a = bodyOf(await profileAt(HOST_A).expect(200));
    const b = bodyOf(await profileAt(HOST_B).expect(200));
    const c = bodyOf(await profileAt(HOST_C).expect(200));

    expect(a).toEqual({
      businessName: 'Mocha House',
      orderingAvailable: true,
      loyaltyPointsLabel: 'Mocha Beans',
      presentation: 'legacy',
    });
    expect(b).toEqual({
      businessName: TEST_TENANT_B_NAME,
      orderingAvailable: true,
      loyaltyPointsLabel: 'Stars',
      presentation: 'standard',
    });
    // No location taking orders: browse only.
    expect(c).toEqual({
      businessName: TEST_TENANT_C_NAME,
      orderingAvailable: false,
      loyaltyPointsLabel: 'Points',
      presentation: 'standard',
    });
    for (const [body, others] of [
      [b, ['Mocha', 'Mocha Beans', TEST_TENANT_C_NAME]],
      [c, ['Mocha', 'Stars', TEST_TENANT_B_NAME]],
    ] as const) {
      for (const other of others)
        expect(JSON.stringify(body)).not.toContain(other);
    }
  });

  it('answers no-store, varying by storefront', async () => {
    const res = await profileAt(HOST_B).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toMatch(/x-centerivo-storefront-host/i);
  });

  it('refuses unknown and unpublished hostnames, and unsigned or spoofed requests', async () => {
    for (const res of [
      await profileAt(`nobody-${suffix}.shop.test`),
      await profileAt(HOST_HIDDEN),
      await request(hostsApp.getHttpServer())
        .get('/api/v1/storefront/profile')
        .set({ Host: HOST_B }),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'STOREFRONT_NOT_FOUND' });
    }
  });

  it("serves each storefront's own menu at its own prices, and nothing of another's", async () => {
    const own = await request(hostsApp.getHttpServer())
      .get(`/api/v1/locations/${locationB}/menu`)
      .set(at(HOST_B))
      .expect(200);
    expect(
      (own.body as LocationMenuResponse).menu.products[0].effectivePrice,
    ).toBe(375);
    const foreign = await request(hostsApp.getHttpServer())
      .get(`/api/v1/locations/${locationB}/menu`)
      .set(at(HOST_C));
    const missing = await request(hostsApp.getHttpServer())
      .get(`/api/v1/locations/${randomUUID()}/menu`)
      .set(at(HOST_C));
    // Another business's location reads exactly like a missing one.
    expect(foreign.status).toBe(missing.status);
    expect(foreign.body).toEqual(missing.body);
    expect(JSON.stringify(foreign.body)).not.toContain(productB);
  });

  it('closes ordering for a business not taking sales, even with a location taking orders', async () => {
    await prisma.location.update({
      where: { id: locationB },
      data: { isDigitalOrderingEnabled: false },
    });
    try {
      expect(
        bodyOf(await profileAt(HOST_B).expect(200)).orderingAvailable,
      ).toBe(false);
    } finally {
      await prisma.location.update({
        where: { id: locationB },
        data: { isDigitalOrderingEnabled: true },
      });
    }
  });

  it('a suspended business keeps its existing refusal', async () => {
    await prisma.tenant.update({
      where: { id: TEST_TENANT_C_ID },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    try {
      const res = await profileAt(HOST_C);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'BUSINESS_UNAVAILABLE' });
    } finally {
      await prisma.tenant.update({
        where: { id: TEST_TENANT_C_ID },
        data: { status: 'ACTIVE', suspensionReason: null },
      });
    }
  });

  it('with routing off, the single business keeps its legacy presentation without any setting', async () => {
    const res = await request(legacyApp.getHttpServer())
      .get('/api/v1/storefront/profile')
      .set(at(HOST_B))
      .expect(200);
    expect(res.body).toEqual({
      businessName: 'Mocha House',
      orderingAvailable: true,
      loyaltyPointsLabel: 'Mocha Beans',
      presentation: 'legacy',
    });
  });

  describe('points name settings', () => {
    const corporate = {
      assertCorporate: () => undefined,
    } as unknown as AuthorizationContext;
    const tenantC = createTenantContext({
      tenantId: TEST_TENANT_C_ID,
      principalType: 'member',
      requestId: 'sc4f3b',
    });
    let staffId: string;

    beforeAll(async () => {
      const staff = await prisma.internalUser.findFirst({
        where: { tenantId: TEST_TENANT_C_ID },
        select: { id: true },
      });
      staffId = staff
        ? staff.id
        : (
            await prisma.internalUser.create({
              data: {
                tenantId: TEST_TENANT_C_ID,
                externalProvider: 'internal-dev',
                externalSubject: `internal-dev:sc4f3b-${suffix}`,
                email: `sc4f3b-staff-${suffix}@example.test`,
                displayName: 'Staff',
                status: 'ACTIVE',
              },
              select: { id: true },
            })
          ).id;
      if (!staff) createdStaffIds.push(staffId);
    });

    it('sets, normalizes, audits and clears a business’s own points name — presentation only', async () => {
      const settings = hostsApp.get(LoyaltySettingsService);
      expect(await settings.getPointsLabel(corporate, tenantC)).toEqual({
        pointsLabel: null,
        effectivePointsLabel: 'Points',
      });
      const balanceBefore = await prisma.customerLoyaltyAccount.count();

      expect(
        await settings.updatePointsLabel(
          '  Charlie   Coins ',
          staffId,
          corporate,
          tenantC,
        ),
      ).toEqual({
        pointsLabel: 'Charlie Coins',
        effectivePointsLabel: 'Charlie Coins',
      });
      expect(
        bodyOf(await profileAt(HOST_C).expect(200)).loyaltyPointsLabel,
      ).toBe('Charlie Coins');
      // Other businesses unaffected.
      expect(
        bodyOf(await profileAt(HOST_B).expect(200)).loyaltyPointsLabel,
      ).toBe('Stars');
      expect(
        await prisma.internalAuditEvent.count({
          where: {
            tenantId: TEST_TENANT_C_ID,
            action: 'loyalty.points_label_changed',
          },
        }),
      ).toBe(1);

      for (const bad of [
        'x'.repeat(33),
        '<b>bold</b>',
        'semi;colon',
        '-leading',
        42,
      ]) {
        await expect(
          settings.updatePointsLabel(bad, staffId, corporate, tenantC),
        ).rejects.toThrow();
      }
      expect(
        await settings.updatePointsLabel('   ', staffId, corporate, tenantC),
      ).toEqual({
        pointsLabel: null,
        effectivePointsLabel: 'Points',
      });
      expect(await prisma.customerLoyaltyAccount.count()).toBe(balanceBefore);
    });
  });
});
