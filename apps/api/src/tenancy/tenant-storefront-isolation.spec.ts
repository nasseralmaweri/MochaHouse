import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  CategorySummary,
  LocationMenuResponse,
  LocationSummary,
  MenuSummary,
  ModifierGroupSummary,
  ProductSummary,
  PublicJobOpeningsResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CareersModule } from '../careers/careers.module';
import { CareersPublicThrottleGuard } from '../careers/infrastructure/careers-public-throttle.guard';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { OrdersController } from '../orders/api/orders.controller';
import { CheckoutService } from '../orders/application/checkout.service';

// Security Phase 3 — public storefront tenant isolation. The storefront's
// business is the deployment's server-resolved TenantContext
// (SINGLE_TENANT_ID via TenancyModule), so this spec boots TWO storefront
// apps against the same database: one serving Tenant A (Mocha House) and
// one serving Tenant B (the test-only isolation tenant). Both businesses
// get identical slugs and names; every public catalog, location, menu and
// careers read must return only the serving business's records, a foreign
// id must read exactly like a missing one, and no client-supplied tenant
// identifier may change which business is served.
describe('Public storefront tenant isolation (integration)', () => {
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;

  type Fixtures = {
    locationId: string;
    categoryId: string;
    productId: string;
    menuId: string;
    modifierGroupId: string;
    modifierOptionId: string;
    jobId: string;
  };
  let A: Fixtures;
  let B: Fixtures;
  const createdJobIds: string[] = [];

  async function buildStorefront(tenantId: string) {
    process.env.SINGLE_TENANT_ID = tenantId;
    const moduleFixture = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        LocationsModule,
        CatalogModule,
        CareersModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    })
      // Every supertest request shares one loopback IP; the real Redis
      // throttle is exercised by the careers specs.
      .overrideGuard(CareersPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  // Identical slugs and names in both businesses: only ownership tells
  // them apart.
  async function fixturesFor(tenantId: string): Promise<Fixtures> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `TSI Store ${suffix}`,
        slug: `tsi-store-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: `TSI Cat ${suffix}`, slug: `tsi-cat-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `TSI Latte ${suffix}`,
        slug: `tsi-latte-${suffix}`,
        categoryId: category.id,
        basePrice: 500,
      },
    });
    const menu = await prisma.menu.create({
      data: {
        tenantId,
        name: `TSI Menu ${suffix}`,
        slug: `tsi-menu-${suffix}`,
      },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    const group = await prisma.modifierGroup.create({
      data: { tenantId, name: `TSI Milk ${suffix}` },
    });
    const option = await prisma.modifierOption.create({
      data: { tenantId, modifierGroupId: group.id, name: `TSI Oat ${suffix}` },
    });
    await prisma.productModifierGroup.create({
      data: { tenantId, productId: product.id, modifierGroupId: group.id },
    });
    const job = await prisma.jobOpening.create({
      data: {
        tenantId,
        title: `TSI Barista ${suffix}`,
        employmentType: 'FULL_TIME',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        locationId: location.id,
        summary: 's',
        description: 'd',
        responsibilities: 'r',
        qualifications: 'q',
      },
    });
    createdJobIds.push(job.id);
    return {
      locationId: location.id,
      categoryId: category.id,
      productId: product.id,
      menuId: menu.id,
      modifierGroupId: group.id,
      modifierOptionId: option.id,
      jobId: job.id,
    };
  }

  // Removes this suite's (fictional) job applications for the given job
  // openings together with the outbox events and deliveries their
  // submission created, so none is left pointing at nothing (Security 4C-1).
  async function removeApplications(jobOpeningIds: string[]) {
    const ids = (
      await prisma.jobApplication.findMany({
        where: { jobOpeningId: { in: jobOpeningIds } },
        select: { id: true },
      })
    ).map((application) => application.id);
    await prisma.notificationDelivery.deleteMany({
      where: { aggregateType: 'JobApplication', aggregateId: { in: ids } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'JobApplication', aggregateId: { in: ids } },
    });
    await prisma.jobApplication.deleteMany({ where: { id: { in: ids } } });
  }

  async function removeFixtures(f: Fixtures | undefined) {
    if (!f) return;
    await removeApplications([f.jobId]);
    await prisma.jobOpening.deleteMany({ where: { id: f.jobId } });
    await prisma.productModifierGroup.deleteMany({
      where: {
        OR: [
          { productId: f.productId },
          { modifierGroupId: f.modifierGroupId },
        ],
      },
    });
    await prisma.modifierOption.deleteMany({
      where: { modifierGroupId: f.modifierGroupId },
    });
    await prisma.modifierGroup.deleteMany({ where: { id: f.modifierGroupId } });
    await prisma.locationMenu.deleteMany({ where: { menuId: f.menuId } });
    await prisma.menuProduct.deleteMany({
      where: { OR: [{ menuId: f.menuId }, { productId: f.productId }] },
    });
    await prisma.menu.deleteMany({ where: { id: f.menuId } });
    await prisma.product.deleteMany({ where: { id: f.productId } });
    await prisma.category.deleteMany({ where: { id: f.categoryId } });
    await prisma.location.deleteMany({ where: { id: f.locationId } });
  }

  const get = (app: INestApplication<App>, path: string) =>
    request(app.getHttpServer()).get(`/api/v1${path}`);
  const post = (app: INestApplication<App>, path: string, body: object) =>
    request(app.getHttpServer()).post(`/api/v1${path}`).send(body);

  type Row = { id: string };
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const ids = (rows: Row[]) => rows.map((row) => row.id);

  // Every public list a storefront exposes, by the ids it should contain.
  async function storefrontIds(app: INestApplication<App>) {
    // Sequential: supertest binds a listener per request.
    const categories = await get(app, '/catalog/categories').expect(200);
    const products = await get(app, '/catalog/products').expect(200);
    const menus = await get(app, '/catalog/menus').expect(200);
    const groups = await get(app, '/catalog/modifier-groups').expect(200);
    const locations = await get(app, '/locations').expect(200);
    const jobs = await get(app, '/careers/jobs').expect(200);
    const groupRows = bodyOf<ModifierGroupSummary[]>(groups);
    return {
      categories: ids(bodyOf<CategorySummary[]>(categories)),
      products: ids(bodyOf<ProductSummary[]>(products)),
      menus: ids(bodyOf<MenuSummary[]>(menus)),
      modifierGroups: ids(groupRows),
      modifierOptions: groupRows.flatMap((g) => ids(g.options)),
      locations: ids(bodyOf<LocationSummary[]>(locations)),
      jobs: ids(bodyOf<PublicJobOpeningsResponse>(jobs).jobs),
    };
  }

  function expectOwnOnly(
    seen: Awaited<ReturnType<typeof storefrontIds>>,
    own: Fixtures,
    other: Fixtures,
  ) {
    for (const [list, ownId, otherId] of [
      [seen.categories, own.categoryId, other.categoryId],
      [seen.products, own.productId, other.productId],
      [seen.menus, own.menuId, other.menuId],
      [seen.modifierGroups, own.modifierGroupId, other.modifierGroupId],
      [seen.modifierOptions, own.modifierOptionId, other.modifierOptionId],
      [seen.locations, own.locationId, other.locationId],
      [seen.jobs, own.jobId, other.jobId],
    ] as const) {
      expect(list).toContain(ownId);
      expect(list).not.toContain(otherId);
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    // Tenant B must exist before its storefront boots (SINGLE_TENANT_ID is
    // validated at startup).
    appA = await buildStorefront(TENANT_A);
    prisma = appA.get(PrismaService);
    await createTestTenantB(prisma);
    appB = await buildStorefront(TENANT_B);

    A = await fixturesFor(TENANT_A);
    B = await fixturesFor(TENANT_B);
  });

  afterAll(async () => {
    try {
      await removeFixtures(A);
      await removeFixtures(B);
      await removeApplications(createdJobIds);
      await removeTestTenantB(prisma);
    } finally {
      await appB?.close();
      await appA?.close();
      process.env = { ...originalEnv };
    }
  });

  // --- (1) and (2) public lists ------------------------------------------

  it("(1) the Mocha House storefront lists none of another business's catalog, locations or jobs", async () => {
    expectOwnOnly(await storefrontIds(appA), A, B);
  });

  it("(2) another business's storefront lists none of Mocha House's", async () => {
    expectOwnOnly(await storefrontIds(appB), B, A);
  });

  // --- (3) foreign ids read like missing ones ------------------------------

  it("(3) another business's location menu and job detail read exactly like missing ones", async () => {
    const missing = randomUUID();
    for (const [app, foreign] of [
      [appA, B],
      [appB, A],
    ] as const) {
      const foreignMenu = await get(
        app,
        `/locations/${foreign.locationId}/menu`,
      );
      const missingMenu = await get(app, `/locations/${missing}/menu`);
      expect(foreignMenu.status).toBe(missingMenu.status);
      expect(foreignMenu.body).toEqual(missingMenu.body);
      expect(JSON.stringify(foreignMenu.body)).not.toContain(foreign.menuId);

      const foreignJob = await get(app, `/careers/jobs/${foreign.jobId}`);
      const missingJob = await get(app, `/careers/jobs/${missing}`);
      expect(foreignJob.status).toBe(404);
      expect(foreignJob.body).toEqual(missingJob.body);
    }
  });

  // --- (4) same-business data still works -----------------------------------

  it('(4) a storefront still serves its own location menu and job detail in full', async () => {
    for (const [app, own] of [
      [appA, A],
      [appB, B],
    ] as const) {
      const res = await get(app, `/locations/${own.locationId}/menu`).expect(
        200,
      );
      const menu = bodyOf<LocationMenuResponse>(res);
      expect(menu.location.id).toBe(own.locationId);
      expect(menu.menu.id).toBe(own.menuId);
      expect(menu.menu.products.map((p) => p.product.id)).toEqual([
        own.productId,
      ]);
      const [item] = menu.menu.products;
      expect(item.effectivePrice).toBe(500);
      expect(item.isAvailable).toBe(true);
      expect(item.modifierGroups.map((g) => g.id)).toEqual([
        own.modifierGroupId,
      ]);
      expect(item.modifierGroups[0].options.map((o) => o.id)).toEqual([
        own.modifierOptionId,
      ]);

      const job = await get(app, `/careers/jobs/${own.jobId}`).expect(200);
      expect(bodyOf<Row>(job).id).toBe(own.jobId);
    }
  });

  it('(4b) a menu never includes another business’s rows, even if a cross-business link exists in the database', async () => {
    // Links that no API path can create (every write validates
    // ownership) — injected directly to prove the read path does not
    // depend on that alone.
    await prisma.menuProduct.create({
      data: { tenantId: TENANT_A, menuId: A.menuId, productId: B.productId },
    });
    await prisma.productModifierGroup.create({
      data: {
        tenantId: TENANT_A,
        productId: A.productId,
        modifierGroupId: B.modifierGroupId,
      },
    });
    await prisma.modifierOption.create({
      data: {
        tenantId: TENANT_B,
        modifierGroupId: A.modifierGroupId,
        name: `TSI foreign option ${suffix}`,
      },
    });
    try {
      const res = await get(appA, `/locations/${A.locationId}/menu`).expect(
        200,
      );
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(B.productId);
      expect(text).not.toContain(B.modifierGroupId);
      expect(text).not.toContain('TSI foreign option');
      const menu = bodyOf<LocationMenuResponse>(res);
      expect(menu.menu.products.map((p) => p.product.id)).toEqual([
        A.productId,
      ]);
    } finally {
      await prisma.menuProduct.deleteMany({
        where: { menuId: A.menuId, productId: B.productId },
      });
      await prisma.productModifierGroup.deleteMany({
        where: { productId: A.productId, modifierGroupId: B.modifierGroupId },
      });
      await prisma.modifierOption.deleteMany({
        where: { modifierGroupId: A.modifierGroupId, tenantId: TENANT_B },
      });
    }
  });

  // --- (5) checkout and job applications ---------------------------------

  const line = (f: Fixtures) => ({
    productId: f.productId,
    quantity: 1,
    selections: [],
  });

  it('(5) checkout and quotes reject another business’s location and products', async () => {
    const missing = randomUUID();
    // Quote: a foreign location is the same 404 as a missing one.
    const foreignQuote = await post(appA, '/orders/checkout-quote', {
      locationId: B.locationId,
      lines: [line(B)],
    });
    const missingQuote = await post(appA, '/orders/checkout-quote', {
      locationId: missing,
      lines: [line(B)],
    });
    expect(foreignQuote.status).toBe(404);
    expect(foreignQuote.body).toEqual(missingQuote.body);

    // Own location, but a product of the other business: not on this menu.
    await post(appA, '/orders/checkout-quote', {
      locationId: A.locationId,
      lines: [line(B)],
    }).expect(400);
    // Own location and product: priced normally.
    const ok = await post(appA, '/orders/checkout-quote', {
      locationId: A.locationId,
      lines: [line(A)],
    }).expect(200);
    expect(bodyOf<{ subtotal: number }>(ok).subtotal).toBe(500);

    // Checkout: refused before any payment attempt exists.
    const idempotencyKey = `tsi_${randomUUID()}`;
    const foreignCheckout = await post(appA, '/orders', {
      idempotencyKey,
      locationId: B.locationId,
      guest: { name: 'TSI Guest', phone: '5551234567' },
      lines: [line(B)],
    });
    expect(foreignCheckout.status).toBe(404);
    expect(
      await prisma.paymentAttempt.count({ where: { idempotencyKey } }),
    ).toBe(0);
  });

  const application = {
    firstName: 'TSI',
    lastName: 'Applicant',
    email: `tsi-${suffix}@example.test`,
    phone: '5550000000',
    location: 'Detroit, MI',
    workAuthorized: true,
    availability: 'Weekends',
    message: 'Hello',
  };

  it('(5b) job applications reject another business’s job and accept the own one', async () => {
    const foreign = await post(
      appA,
      `/careers/jobs/${B.jobId}/applications`,
      application,
    );
    const missing = await post(
      appA,
      `/careers/jobs/${randomUUID()}/applications`,
      application,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(
      await prisma.jobApplication.count({ where: { jobOpeningId: B.jobId } }),
    ).toBe(0);

    await post(
      appA,
      `/careers/jobs/${A.jobId}/applications`,
      application,
    ).expect(201);
    const stored = await prisma.jobApplication.findFirstOrThrow({
      where: { jobOpeningId: A.jobId },
    });
    expect(stored.tenantId).toBe(TENANT_A);
  });

  // --- (6) client-supplied tenant identifiers ---------------------------------

  it('(6) client-supplied tenant identifiers never change the storefront business', async () => {
    const forged = (path: string) =>
      get(
        appA,
        `${path}${path.includes('?') ? '&' : '?'}tenantId=${TENANT_B}&tenant=${TENANT_B}`,
      )
        .set('X-Tenant-Id', TENANT_B)
        .set('X-Tenant', TENANT_B)
        .set('Cookie', `tenantId=${TENANT_B}`);

    for (const path of [
      '/catalog/categories',
      '/catalog/products',
      '/catalog/menus',
      '/catalog/modifier-groups',
      '/locations',
      '/careers/jobs',
    ]) {
      const res = await forged(path).expect(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(B.categoryId);
      expect(text).not.toContain(B.productId);
      expect(text).not.toContain(B.menuId);
      expect(text).not.toContain(B.modifierGroupId);
      expect(text).not.toContain(B.locationId);
      expect(text).not.toContain(B.jobId);
    }
    const menu = await forged(`/locations/${B.locationId}/menu`);
    expect(JSON.stringify(menu.body)).not.toContain(B.menuId);
    await forged(`/careers/jobs/${B.jobId}`).expect(404);
    const quote = await post(appA, '/orders/checkout-quote', {
      locationId: B.locationId,
      lines: [line(B)],
      tenantId: TENANT_B,
    }).set('X-Tenant-Id', TENANT_B);
    expect(quote.status).toBe(404);
  });
});
