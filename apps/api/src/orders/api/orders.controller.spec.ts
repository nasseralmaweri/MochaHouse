import {
  enrollTestCustomer,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import 'dotenv/config';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type {
  CheckoutRequest,
  OrderConfirmation,
} from '@mocha-house/contracts';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { CustomersModule } from '../../customers/customers.module';
import { LoyaltyModule } from '../../loyalty/loyalty.module';
import { PromotionsModule } from '../../promotions/promotions.module';
import { GiftCardsModule } from '../../gift-cards/gift-cards.module';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CheckoutService } from '../application/checkout.service';
import { PaymentModule } from '../../payment/payment.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { OrdersController } from './orders.controller';
import { hashCheckoutToken } from '../application/checkout-session';

// Full HTTP integration test for POST /api/v1/orders' optional-auth
// behavior (Milestone 4B fix): OptionalCustomerAuthGuard +
// OrdersController + CheckoutService wired exactly as OrdersModule wires
// them. This is the only place that can prove the guard-level 401 for a
// bad token actually happens over real HTTP, before CheckoutService (and
// therefore payment) is ever reached — checkout.service.spec.ts calls the
// service directly and never exercises the guard at all.
describe('POST /api/v1/orders — optional customer authentication (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const devSecret = 'orders-controller-spec-secret';
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
        // The controllers below apply RateLimitGuard (R1 / S3a).
        RateLimitModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    await prisma.$connect();

    const location = await prisma.location.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'dearborn-heights',
        },
      },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: {
        tenantId_slug: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          slug: 'drip-coffee',
        },
      },
      include: {
        modifierGroups: {
          include: { modifierGroup: { include: { options: true } } },
        },
      },
    });
    locationId = location.id;
    productId = product.id;
    const sizeGroup = product.modifierGroups[0].modifierGroup;
    sizeGroupId = sizeGroup.id;
    mediumOptionId = sizeGroup.options.find((o) => o.name === 'Medium')!.id;
  });

  afterAll(async () => {
    const attempts = await prisma.paymentAttempt.findMany({
      // ESP-03 PR 6 — the attempts of this file's checkout sessions.
      where: { checkoutSession: { tokenHash: { in: sessionTokenHashes } } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);

      await prisma.orderLine.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderStatusHistory.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.outboxEvent.deleteMany({
        where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      // ESP-03 PR 4 — a payment's saved checkout and reconciliation records
      // (append-only) go first, through the disposable-only test helper.
      await removePaymentRecoveryRecordsForTest(
        (
          await prisma.paymentAttempt.findMany({
            where: { id: { in: attemptIds } },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
    }
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: 'dev:test-' },
      },
    });

    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // ESP-03 PR 6 — every checkout starts a server-owned session (here as a
  // guest; a session is bound to its customer, so a signed-in submission
  // starts its own with the same Authorization).
  const sessionTokenHashes: string[] = [];
  async function startSession(authorization?: string): Promise<string> {
    const req = request(app.getHttpServer())
      .post('/api/v1/orders/checkout-sessions')
      .send({ locationId });
    if (authorization) req.set('Authorization', authorization);
    const res = await req.expect(200);
    const token = (res.body as { checkoutToken: string }).checkoutToken;
    sessionTokenHashes.push(hashCheckoutToken(token));
    return token;
  }

  function buildCheckoutRequest(
    overrides: Partial<CheckoutRequest> = {},
  ): Omit<CheckoutRequest, 'checkoutToken'> {
    void randomUUID;
    return {
      locationId,
      guest: { name: 'Test Guest', phone: '5551234567' },
      lines: [
        {
          productId,
          quantity: 1,
          selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
        },
      ],
      ...overrides,
    };
  }

  async function paymentAttemptExists(checkoutToken: string): Promise<boolean> {
    const attempt = await prisma.paymentAttempt.findFirst({
      where: {
        checkoutSession: { tokenHash: hashCheckoutToken(checkoutToken) },
      },
    });
    return attempt !== null;
  }

  it('succeeds as guest with no Authorization header, and the Order has customerId null', async () => {
    const checkoutRequest = {
      ...buildCheckoutRequest(),
      checkoutToken: await startSession(),
    };

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(checkoutRequest)
      .expect(201);

    const confirmation = response.body as OrderConfirmation;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).toBeNull();
  });

  it('succeeds with a valid customer token and associates the correct Customer', async () => {
    const identifier = `test-${randomUUID()}@example.com`;
    // SC4f-2 — the customer has joined this business.
    await enrollTestCustomer(prisma, TENANT_1_MOCHA_HOUSE_ID, {
      provider: 'dev',
      subject: `dev:${identifier}`,
      email: identifier,
    });
    const token = signDevJwt(
      { sub: `dev:${identifier}`, email: identifier, name: null },
      devSecret,
      3600,
    );
    const checkoutRequest = {
      ...buildCheckoutRequest(),
      checkoutToken: await startSession(`Bearer ${token}`),
    };

    const response = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(checkoutRequest)
      .expect(201);

    const confirmation = response.body as OrderConfirmation;
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(order.customerId).not.toBeNull();

    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        tenantId_externalProvider_externalSubject: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          externalProvider: 'dev',
          externalSubject: `dev:${identifier}`,
        },
      },
    });
    expect(order.customerId).toBe(customer.id);
  });

  it('rejects an invalid token with 401 and creates no payment attempt or order', async () => {
    const checkoutRequest = {
      ...buildCheckoutRequest(),
      checkoutToken: await startSession(),
    };

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', 'Bearer not-a-real-token')
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.checkoutToken)).toBe(
      false,
    );
  });

  it('rejects an expired token with 401 and creates no payment attempt or order', async () => {
    const expiredToken = signDevJwt(
      {
        sub: 'dev:test-expired@example.com',
        email: 'test-expired@example.com',
        name: null,
      },
      devSecret,
      -1,
    );
    const checkoutRequest = {
      ...buildCheckoutRequest(),
      checkoutToken: await startSession(),
    };

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${expiredToken}`)
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.checkoutToken)).toBe(
      false,
    );
  });

  it('rejects a token signed with the wrong secret with 401 and creates no payment attempt or order', async () => {
    const tamperedToken = signDevJwt(
      {
        sub: 'dev:test-tampered@example.com',
        email: 'test-tampered@example.com',
        name: null,
      },
      'a-completely-different-secret',
      3600,
    );
    const checkoutRequest = {
      ...buildCheckoutRequest(),
      checkoutToken: await startSession(),
    };

    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${tamperedToken}`)
      .send(checkoutRequest)
      .expect(401);

    expect(await paymentAttemptExists(checkoutRequest.checkoutToken)).toBe(
      false,
    );
  });
});
