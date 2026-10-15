import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { removeTestTenant } from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { OrdersController } from '../orders/api/orders.controller';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { CheckoutService } from '../orders/application/checkout.service';
import { AppController } from '../app.controller';
import { AppService } from '../app.service';
import {
  BUSINESS_UNAVAILABLE,
  isAllowedWhileTenantInactive,
} from './tenant-context.middleware';

// SC0.5a — a SUSPENDED business's public storefront is closed, fail-closed,
// with one generic answer that never says why; its ACTIVE neighbours
// (including Mocha House, Tenant #1) are unaffected; reactivation restores it
// without a restart; nothing it already owns is touched.
//
// Two storefront apps share one database: one serves a test-only business
// (S) that the tests suspend and reactivate, one serves Mocha House, which is
// never suspended.
describe('Tenant suspension — public storefront (integration)', () => {
  let appS: INestApplication<App>;
  let appA: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);

  // A test-only business (7e57 marker: deletable by the shared guard).
  const TENANT_S = '01a0db02-f800-7000-8000-7e570000050b';

  let order: { id: string; accessToken: string };
  let locationId: string;
  let attemptId: string;

  const GENERIC_BODY = {
    statusCode: 503,
    error: 'Service Unavailable',
    code: BUSINESS_UNAVAILABLE,
    message: 'This business is not available right now.',
  };

  async function buildStorefront(tenantId: string) {
    process.env.SINGLE_TENANT_ID = tenantId;
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
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
        RateLimitModule,
      ],
      controllers: [OrdersController, AppController],
      providers: [CheckoutService, AppService],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  const suspend = (reason: 'BILLING' | 'SECURITY' | 'REQUESTED' = 'BILLING') =>
    prisma.tenant.update({
      where: { id: TENANT_S },
      data: { status: 'SUSPENDED', suspensionReason: reason },
    });
  const reactivate = () =>
    prisma.tenant.update({
      where: { id: TENANT_S },
      data: { status: 'ACTIVE', suspensionReason: null },
    });

  const http = (app: INestApplication<App>) => request(app.getHttpServer());

  // Everything the business owns that a stray write could have touched.
  const ownedCounts = async () => ({
    orders: await prisma.order.count({ where: { tenantId: TENANT_S } }),
    attempts: await prisma.paymentAttempt.count({
      where: { tenantId: TENANT_S },
    }),
    customers: await prisma.customer.count({ where: { tenantId: TENANT_S } }),
    giftCardPurchases: await prisma.giftCardPurchase.count({
      where: { tenantId: TENANT_S },
    }),
    outbox: await prisma.outboxEvent.count({ where: { tenantId: TENANT_S } }),
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    appA = await buildStorefront(TENANT_1_MOCHA_HOUSE_ID);
    prisma = appA.get(PrismaService);
    // Suspension is never applied to Tenant #1 by this suite.
    await prisma.tenant.upsert({
      where: { id: TENANT_S },
      update: { status: 'ACTIVE', suspensionReason: null },
      create: {
        id: TENANT_S,
        slug: 'sc05a-test-tenant-storefront',
        name: 'SC0.5a Test Tenant (suspension tests only)',
        status: 'ACTIVE',
      },
    });
    appS = await buildStorefront(TENANT_S);

    const location = await prisma.location.create({
      data: {
        tenantId: TENANT_S,
        name: `SC05a Store ${suffix}`,
        slug: `sc05a-store-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
    });
    locationId = location.id;
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId: TENANT_S,
        idempotencyKey: `sc05a-${randomUUID()}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId,
        amount: 500,
        currency: 'USD',
      },
    });
    attemptId = attempt.id;
    order = await prisma.order.create({
      data: {
        tenantId: TENANT_S,
        orderNumber: `SC05A-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId,
        paymentAttemptId: attempt.id,
        guestName: 'Suspension Guest',
        guestPhone: '5551230000',
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
      },
      select: { id: true, accessToken: true },
    });
  });

  afterEach(async () => {
    await reactivate();
  });

  afterAll(async () => {
    try {
      await prisma.orderStatusHistory.deleteMany({
        where: { orderId: order?.id },
      });
      await prisma.order.deleteMany({ where: { tenantId: TENANT_S } });
      await prisma.paymentAttempt.deleteMany({ where: { id: attemptId } });
      await prisma.location.deleteMany({ where: { id: locationId } });
      await removeTestTenant(prisma, TENANT_S);
    } finally {
      await appS?.close();
      await appA?.close();
      process.env = { ...originalEnv };
    }
  });

  it('an ACTIVE business is served normally', async () => {
    const res = await http(appS).get('/api/v1/locations').expect(200);
    expect((res.body as Array<{ id: string }>).map((l) => l.id)).toContain(
      locationId,
    );
  });

  it('a SUSPENDED business refuses its storefront with one generic, uncacheable 503', async () => {
    await suspend();
    for (const path of [
      '/api/v1/locations',
      `/api/v1/locations/${locationId}/menu`,
      '/api/v1/catalog/products',
      '/api/v1/gift-cards/purchase-options',
    ]) {
      const res = await http(appS).get(path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual(GENERIC_BODY);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('the answer never reveals the reason: BILLING, SECURITY and REQUESTED are indistinguishable', async () => {
    const bodies: string[] = [];
    for (const reason of ['BILLING', 'SECURITY', 'REQUESTED'] as const) {
      await suspend(reason);
      const res = await http(appS).get('/api/v1/locations').expect(503);
      bodies.push(JSON.stringify(res.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/billing|security|requested|suspen/i);
  });

  it('customer order creation and every other storefront write are refused before any guard, pipe or handler runs', async () => {
    await suspend();
    const before = await ownedCounts();

    const writes: Array<[string, string, object]> = [
      ['post', '/api/v1/orders', { locationId, lines: [] }],
      ['post', '/api/v1/orders/checkout-quote', { locationId, lines: [] }],
      ['post', '/api/v1/orders/reward-eligibility', { locationId }],
      ['post', '/api/v1/gift-cards/purchase-intents', {}],
      ['post', '/api/v1/gift-cards/purchase', {}],
      ['post', '/api/v1/gift-cards/balance', {}],
      ['post', '/api/v1/auth/register', {}],
      ['post', '/api/v1/auth/sign-in', {}],
      ['patch', '/api/v1/customers/me', {}],
      // Path spellings Express routes the same way.
      ['post', '/API/V1/ORDERS', { locationId, lines: [] }],
      ['post', '/api/v1/orders/', { locationId, lines: [] }],
      ['post', '/api/v1/orders?x=1', { locationId, lines: [] }],
    ];
    for (const [method, path, body] of writes) {
      const agent = http(appS);
      const pending = method === 'post' ? agent.post(path) : agent.patch(path);
      const res = await pending
        .set('Authorization', 'Bearer not-a-real-token')
        .send(body);
      expect({ path, status: res.status }).toEqual({ path, status: 503 });
      expect(res.body).toEqual(GENERIC_BODY);
    }

    // A signed-in customer GET creates the customer record on first use, so
    // it is refused too (and before the customer guard: 503, not 401).
    const me = await http(appS)
      .get('/api/v1/customers/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(me.status).toBe(503);

    expect(await ownedCounts()).toEqual(before);
  });

  it('guest order status stays readable (with its access token) so a paying customer can see their order, and changes nothing', async () => {
    await suspend();
    const before = await ownedCounts();
    const res = await http(appS)
      .get(`/api/v1/orders/${order.id}`)
      .set('x-order-access-token', order.accessToken)
      .expect(200);
    expect((res.body as { orderId: string }).orderId).toBe(order.id);

    // The access token is still required.
    await http(appS)
      .get(`/api/v1/orders/${order.id}`)
      .set('x-order-access-token', randomUUID())
      .expect(404);
    expect(await ownedCounts()).toEqual(before);
  });

  it('the static root route still answers (load-balancer probe)', async () => {
    await suspend();
    await http(appS).get('/').expect(200);
  });

  it('suspension changes no historical order, payment or ledger data', async () => {
    const snapshot = async () => ({
      order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      attempt: await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      }),
      counts: await ownedCounts(),
    });
    const before = await snapshot();
    await suspend();
    await http(appS).get('/api/v1/locations').expect(503);
    await reactivate();
    expect(await snapshot()).toEqual(before);
  });

  it('Mocha House (Tenant #1, ACTIVE) is unaffected while another business is suspended', async () => {
    await suspend();
    await http(appS).get('/api/v1/locations').expect(503);
    await http(appA).get('/api/v1/locations').expect(200);
    // An ACTIVE business's write still reaches its handler (validation
    // answers, not the suspension gate).
    const res = await http(appA).post('/api/v1/orders').send({});
    expect(res.status).not.toBe(503);
  });

  it('reactivation restores the storefront immediately, without a restart', async () => {
    await suspend();
    await http(appS).get('/api/v1/locations').expect(503);
    await reactivate();
    await http(appS).get('/api/v1/locations').expect(200);
    const res = await http(appS).post('/api/v1/orders').send({});
    expect(res.status).not.toBe(503);
  });

  it('a business row that no longer exists fails closed exactly like a suspended one', async () => {
    // The storefront app's own client (each app has its own PrismaService).
    const spy = jest
      .spyOn(appS.get(PrismaService).tenant, 'findUnique')
      .mockResolvedValueOnce(null);
    try {
      const res = await http(appS).get('/api/v1/locations');
      expect(res.status).toBe(503);
      expect(res.body).toEqual(GENERIC_BODY);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('isAllowedWhileTenantInactive', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/api/v1/orders/abc'],
    ['GET', '/api/v1/orders/abc/'],
    ['GET', '/API/V1/ORDERS/abc'],
    ['GET', '/api/v1/orders/abc?accessToken=x'],
    ['HEAD', '/api/v1/orders/abc'],
  ])('allows %s %s', (method, url) => {
    expect(isAllowedWhileTenantInactive(method, url)).toBe(true);
  });

  it.each([
    ['POST', '/api/v1/orders/abc'],
    ['POST', '/api/v1/orders'],
    ['POST', '/'],
    ['GET', '/api/v1/orders'],
    ['GET', '/api/v1/orders/abc/extra'],
    ['GET', '/api/v1/customers/me/orders/abc'],
    ['GET', '/api/v1/locations'],
    ['GET', '/api/v1/media/objects/media/x.png'],
    ['GET', '//'],
  ])('refuses %s %s', (method, url) => {
    expect(isAllowedWhileTenantInactive(method, url)).toBe(false);
  });
});
