import 'dotenv/config';
import { removePaymentRecoveryRecordsForTest } from '@mocha-house/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PAYMENT_SIMULATION_NOT_AVAILABLE,
  type CheckoutPaymentRequiredResponse,
  type CheckoutRequest,
  type OrderConfirmation,
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
import { CheckoutService } from '../application/checkout.service';
import { PaymentModule } from '../../payment/payment.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { OrdersController } from './orders.controller';
import { hashCheckoutToken } from '../application/checkout-session';

// ESP-04 M2 — the two-step checkout over real HTTP, with PAYMENT_PROVIDER set
// to the development two-step fake: POST /orders answers 202 with what the
// customer must do, the check endpoint reads the outcome from the provider
// (202 while waiting, 200 with the order), a retry of the checkout replays
// that same order, and the development simulator answers 204 (404 in a
// production-like environment). Responses are never cacheable.
describe('two-step checkout over HTTP (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };
  const sessionTokenHashes: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.PAYMENT_PROVIDER = 'fake-two-step';
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
        RateLimitModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
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
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
    mediumOptionId = group.options.find((o) => o.name === 'Medium')!.id;
  });

  afterAll(async () => {
    const attemptIds = (
      await prisma.paymentAttempt.findMany({
        where: { checkoutSession: { tokenHash: { in: sessionTokenHashes } } },
        select: { id: true },
      })
    ).map((a) => a.id);
    const orderIds = (
      await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      })
    ).map((o) => o.id);
    await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderStatusHistory.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.outboxEvent.deleteMany({
      where: { aggregateType: 'Order', aggregateId: { in: orderIds } },
    });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await removePaymentRecoveryRecordsForTest(attemptIds);
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await prisma.checkoutSession.deleteMany({
      where: { tokenHash: { in: sessionTokenHashes } },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  async function startSession(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/orders/checkout-sessions')
      .send({ locationId })
      .expect(200);
    const token = (res.body as { checkoutToken: string }).checkoutToken;
    sessionTokenHashes.push(hashCheckoutToken(token));
    return token;
  }

  const order = (checkoutToken: string): CheckoutRequest => ({
    checkoutToken,
    locationId,
    guest: { name: 'Http Two Step', phone: '5551236666' },
    lines: [
      {
        productId,
        quantity: 1,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
  });

  const checkPayment = (checkoutToken: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders/checkout-sessions/payment')
      .send({ locationId, checkoutToken });

  const simulate = (checkoutToken: string, outcome: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders/checkout-sessions/payment/simulate')
      .send({ locationId, checkoutToken, outcome });

  it('202 while the payment waits, 200 with the order once the provider says it succeeded', async () => {
    const checkoutToken = await startSession();
    const submitted = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(order(checkoutToken))
      .expect(202);
    const waiting = submitted.body as CheckoutPaymentRequiredResponse;
    expect(waiting.outcome).toBe('PAYMENT_REQUIRED');
    expect(waiting.payment).toMatchObject({
      provider: 'fake-two-step',
      state: 'REQUIRES_CUSTOMER_ACTION',
      clientSecret: null,
    });
    // Nothing that names the provider's intent or our records leaks.
    expect(JSON.stringify(submitted.body)).not.toMatch(/fakepi_|idempotency/i);

    const stillWaiting = await checkPayment(checkoutToken).expect(202);
    expect(stillWaiting.headers['cache-control']).toBe('no-store');

    await simulate(checkoutToken, 'succeed').expect(204);
    const paid = await checkPayment(checkoutToken).expect(200);
    const confirmation = paid.body as OrderConfirmation;
    expect(confirmation.orderId).toEqual(expect.any(String));

    // A retried submission of the same checkout replays the same order.
    const replay = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(order(checkoutToken))
      .expect(201);
    expect((replay.body as OrderConfirmation).orderId).toBe(
      confirmation.orderId,
    );
  });

  it('a cancelled payment answers 402', async () => {
    const checkoutToken = await startSession();
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(order(checkoutToken))
      .expect(202);
    await simulate(checkoutToken, 'cancel').expect(204);
    await checkPayment(checkoutToken).expect(402);
  });

  it('the simulator answers 404 in a production-like environment', async () => {
    const checkoutToken = await startSession();
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .send(order(checkoutToken))
      .expect(202);
    process.env.DEPLOYMENT_ENV = 'production';
    try {
      const refused = await simulate(checkoutToken, 'succeed').expect(404);
      expect((refused.body as { code?: string }).code).toBe(
        PAYMENT_SIMULATION_NOT_AVAILABLE,
      );
    } finally {
      delete process.env.DEPLOYMENT_ENV;
    }
    await checkPayment(checkoutToken).expect(202);
  });
});
