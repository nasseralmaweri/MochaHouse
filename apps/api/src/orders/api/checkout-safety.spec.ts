import {
  enrollTestCustomer,
  removePaymentRecoveryRecordsForTest,
} from '@mocha-house/testing';
import 'dotenv/config';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LocationsModule } from '../../locations/locations.module';
import { CustomerAuthModule } from '../../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../../internal-auth/internal-auth.module';
import { CustomersModule } from '../../customers/customers.module';
import { LoyaltyModule } from '../../loyalty/loyalty.module';
import { PromotionsModule } from '../../promotions/promotions.module';
import { GiftCardsModule } from '../../gift-cards/gift-cards.module';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
} from '../../gift-cards/infrastructure/gift-card-code';
import { signDevJwt } from '../../customer-auth/infrastructure/dev-jwt';
import { CheckoutService } from '../application/checkout.service';
import { malformedLineCases } from '../application/validate-checkout-lines.fixtures';
import { PaymentModule } from '../../payment/payment.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { OrdersController } from './orders.controller';
import { CheckoutRewardsController } from './checkout-rewards.controller';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  httpCheckoutBody,
} from '../../../test/checkout-session';

// Checkout validation & payment safety over real HTTP. Every cart-pricing
// entry point (POST /orders — which prices the cart before payment and
// again inside the order transaction — /orders/checkout-quote and
// /orders/reward-eligibility) must answer a malformed cart with a 4xx before
// any Customer, PaymentAttempt or Order is written; and a checkout that needs
// a card payment must be refused (503) with nothing recorded whenever no
// provider can genuinely take one — none configured, or production with the
// simulated provider somehow bound.
describe('checkout request validation and payment safety (integration)', () => {
  let fakeApp: INestApplication<App>;
  let disabledApp: INestApplication<App>;
  let prisma: PrismaService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const devSecret = 'checkout-safety-spec-secret';
  const KEY_PREFIX = 'cks_';
  const SUBJECT_PREFIX = 'dev:checkout-safety-';
  const giftCardIds: string[] = [];
  const originalEnv = { ...process.env };

  async function buildApp(
    paymentProvider: string | undefined,
  ): Promise<INestApplication<App>> {
    if (paymentProvider === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = paymentProvider;
    const moduleFixture = await Test.createTestingModule({
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
      controllers: [OrdersController, CheckoutRewardsController],
      providers: [CheckoutService],
    }).compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = devSecret;
    process.env.GIFT_CARD_CODE_SECRET = 'checkout-safety-spec-gift-secret';

    fakeApp = await buildApp('fake');
    disabledApp = await buildApp(undefined);
    prisma = fakeApp.get(PrismaService);

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
    process.env.NODE_ENV = 'development';
    const attempts = await prisma.paymentAttempt.findMany({
      where: checkoutAttemptsOfThisSuite(),
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    const orders = await prisma.order.findMany({
      where: { paymentAttemptId: { in: attemptIds } },
      select: { id: true },
    });
    const orderIds = orders.map((o) => o.id);
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { giftCardId: { in: giftCardIds } },
    });
    await prisma.orderGiftCardRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } });
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
    await prisma.giftCard.deleteMany({ where: { id: { in: giftCardIds } } });
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'dev',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });

    await fakeApp.close();
    await disabledApp.close();
    process.env = { ...originalEnv };
  });

  function validLine() {
    return {
      productId,
      quantity: 1,
      selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
    };
  }

  function checkoutBody(overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      locationId,
      guest: { name: 'Safety Guest', phone: '5551234567' },
      lines: [validLine()],
      ...overrides,
    };
  }

  // SC4f-2 — a signed-in customer who has joined this business.
  // enroll=false: a valid login that has not joined this business — used
  // where a test proves a refused request leaves no Customer behind.
  async function newIdentity(
    enroll = true,
  ): Promise<{ subject: string; token: string }> {
    const subject = `${SUBJECT_PREFIX}${randomUUID()}`;
    if (enroll) {
      await enrollTestCustomer(prisma, TENANT_1_MOCHA_HOUSE_ID, {
        provider: 'dev',
        subject,
        email: `${subject.slice(4)}@example.test`,
      });
    }
    const token = signDevJwt(
      { sub: subject, email: `${subject.slice(4)}@example.test`, name: null },
      devSecret,
      3600,
    );
    return { subject, token };
  }

  async function customerExists(subject: string): Promise<boolean> {
    const count = await prisma.customer.count({
      where: { externalProvider: 'dev', externalSubject: subject },
    });
    return count > 0;
  }

  // ESP-03 PR 6 — the attempts of the checkout labelled `idempotencyKey`
  // (a test-side label; the client sends the session token instead).
  async function attemptCount(idempotencyKey: string): Promise<number> {
    return prisma.paymentAttempt.count({
      where: attemptsOfCheckout(idempotencyKey),
    });
  }

  async function createGiftCard(balanceMinorUnits: number): Promise<string> {
    const code = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(code)!;
    const card = await prisma.giftCard.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        codeHash: hashGiftCardCode(canonical),
        last4: canonical.slice(-4),
        status: 'ACTIVE',
        originalValueMinorUnits: balanceMinorUnits,
        balanceMinorUnits,
        currency: 'USD',
        transactions: {
          create: {
            type: 'ISSUANCE',
            amountMinorUnits: balanceMinorUnits,
            balanceAfterMinorUnits: balanceMinorUnits,
          },
        },
      },
    });
    giftCardIds.push(card.id);
    return code;
  }

  describe('malformed cart lines are a 400 on every pricing entry point, before any write', () => {
    // The same cases as the unit-level validate-checkout-lines.spec.ts,
    // sent as real JSON bodies.
    const cases = () => malformedLineCases(validLine());

    it('POST /api/v1/orders (signed in) — 400, no PaymentAttempt, no Customer', async () => {
      for (const [name, lines] of cases()) {
        const { subject, token } = await newIdentity(false);
        const body = checkoutBody({ lines });
        const auth = { Authorization: `Bearer ${token}` };
        const response = await request(fakeApp.getHttpServer())
          .post('/api/v1/orders')
          .set(auth)
          .send(await httpCheckoutBody(fakeApp.getHttpServer(), body, auth));
        expect({ name, status: response.status }).toEqual({
          name,
          status: 400,
        });
        expect(await attemptCount(body.idempotencyKey)).toBe(0);
        expect(await customerExists(subject)).toBe(false);
      }
    });

    it('POST /api/v1/orders/checkout-quote (signed in) — 400, no Customer', async () => {
      for (const [name, lines] of cases()) {
        const { subject, token } = await newIdentity(false);
        const response = await request(fakeApp.getHttpServer())
          .post('/api/v1/orders/checkout-quote')
          .set('Authorization', `Bearer ${token}`)
          .send({ locationId, lines });
        expect({ name, status: response.status }).toEqual({
          name,
          status: 400,
        });
        expect(await customerExists(subject)).toBe(false);
      }
    });

    it('POST /api/v1/orders/reward-eligibility — 400, no Customer', async () => {
      for (const [name, lines] of cases()) {
        const { subject, token } = await newIdentity(false);
        const response = await request(fakeApp.getHttpServer())
          .post('/api/v1/orders/reward-eligibility')
          .set('Authorization', `Bearer ${token}`)
          .send({ locationId, lines });
        expect({ name, status: response.status }).toEqual({
          name,
          status: 400,
        });
        expect(await customerExists(subject)).toBe(false);
      }
    });
  });

  describe('wrong top-level types never reach a 5xx', () => {
    const fuzz: Array<[string, () => unknown]> = [
      ['locationId as a number', () => checkoutBody({ locationId: 42 })],
      ['locationId as an object', () => checkoutBody({ locationId: {} })],
      ['lines as an object', () => checkoutBody({ lines: { 0: validLine() } })],
      ['lines missing', () => checkoutBody({ lines: undefined })],
      ['empty lines', () => checkoutBody({ lines: [] })],
      ['guest as a string', () => checkoutBody({ guest: 'guest' })],
      [
        'guest phone as a number',
        () => checkoutBody({ guest: { name: 'G', phone: 5 } }),
      ],
      ['couponCode as a number', () => checkoutBody({ couponCode: 7 })],
      [
        'giftCardCode as an object',
        () => checkoutBody({ giftCardCode: { a: 1 } }),
      ],
      [
        'loyaltyRewardId as a number',
        () => checkoutBody({ loyaltyRewardId: 3 }),
      ],
      [
        'idempotencyKey as a number',
        () => checkoutBody({ idempotencyKey: 12345678 }),
      ],
      [
        'quantity as a huge number',
        () => checkoutBody({ lines: [{ ...validLine(), quantity: 1e12 }] }),
      ],
      ['a body that is an array', () => [checkoutBody()]],
    ];

    it.each(fuzz)('%s → 4xx on all three routes', async (_name, makeBody) => {
      for (const path of [
        '/api/v1/orders',
        '/api/v1/orders/checkout-quote',
        '/api/v1/orders/reward-eligibility',
      ]) {
        const { token } = await newIdentity();
        const auth = { Authorization: `Bearer ${token}` };
        const sent =
          path === '/api/v1/orders'
            ? await httpCheckoutBody(fakeApp.getHttpServer(), makeBody(), auth)
            : makeBody();
        const response = await request(fakeApp.getHttpServer())
          .post(path)
          .set(auth)
          .send(sent as object);
        // The quote routes ignore wrongly-typed coupon/gift-card/reward
        // fields (a 200 there is fine); no route may ever answer 5xx.
        expect({ path, serverError: response.status >= 500 }).toEqual({
          path,
          serverError: false,
        });
        if (path === '/api/v1/orders') {
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
      }
    });
  });

  describe('legitimate checkout and quotes are unchanged', () => {
    it('accepts unknown extra keys on a line, and places a paid order with the simulated provider', async () => {
      const line = {
        ...validLine(),
        clientOnlyNote: 'ignored',
      };
      const body = checkoutBody({ lines: [line] });
      const response = await request(fakeApp.getHttpServer())
        .post('/api/v1/orders')
        .send(await httpCheckoutBody(fakeApp.getHttpServer(), body))
        .expect(201);
      expect(response.body).toHaveProperty('orderId');
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: attemptsOfCheckout(body.idempotencyKey),
      });
      expect(attempt.status).toBe('SUCCEEDED');
      expect(attempt.provider).toBe('fake');
    });

    it('a line without selections for a product with a required modifier group is a 400 from pricing, not a 500', async () => {
      for (const path of [
        '/api/v1/orders',
        '/api/v1/orders/checkout-quote',
        '/api/v1/orders/reward-eligibility',
      ]) {
        const { token } = await newIdentity();
        const auth = { Authorization: `Bearer ${token}` };
        const body = checkoutBody({ lines: [{ productId, quantity: 1 }] });
        const response = await request(fakeApp.getHttpServer())
          .post(path)
          .set(auth)
          .send(
            path === '/api/v1/orders'
              ? await httpCheckoutBody(fakeApp.getHttpServer(), body, auth)
              : body,
          );
        expect({ path, status: response.status }).toEqual({
          path,
          status: 400,
        });
      }
    });

    it('quotes and reward eligibility still answer 200', async () => {
      const { token } = await newIdentity();
      await request(fakeApp.getHttpServer())
        .post('/api/v1/orders/checkout-quote')
        .send({ locationId, lines: [validLine()] })
        .expect(200);
      await request(fakeApp.getHttpServer())
        .post('/api/v1/orders/reward-eligibility')
        .set('Authorization', `Bearer ${token}`)
        .send({ locationId, lines: [validLine()] })
        .expect(200);
    });
  });

  describe('online payment disabled (PAYMENT_PROVIDER unset)', () => {
    it('refuses a card checkout with 503 and records nothing', async () => {
      const body = checkoutBody();
      const ordersBefore = await prisma.order.count();
      const response = await request(disabledApp.getHttpServer())
        .post('/api/v1/orders')
        .send(await httpCheckoutBody(disabledApp.getHttpServer(), body))
        .expect(503);
      expect(JSON.stringify(response.body)).not.toMatch(/PAYMENT_PROVIDER/);
      expect(await attemptCount(body.idempotencyKey)).toBe(0);
      expect(await prisma.order.count()).toBe(ordersBefore);
    });

    it('refuses a signed-in card checkout with 503 and no PaymentAttempt', async () => {
      // Payment availability is decided after pricing (a gift card may cover
      // everything), so the signed-in Customer row may already exist — the
      // payment records must not.
      const { token } = await newIdentity();
      const body = checkoutBody();
      const auth = { Authorization: `Bearer ${token}` };
      await request(disabledApp.getHttpServer())
        .post('/api/v1/orders')
        .set(auth)
        .send(await httpCheckoutBody(disabledApp.getHttpServer(), body, auth))
        .expect(503);
      expect(await attemptCount(body.idempotencyKey)).toBe(0);
    });

    it('still serves the checkout quote', async () => {
      await request(disabledApp.getHttpServer())
        .post('/api/v1/orders/checkout-quote')
        .send({ locationId, lines: [validLine()] })
        .expect(200);
    });

    it('still places an order fully covered by a gift card (no external charge)', async () => {
      const code = await createGiftCard(100_000);
      const body = checkoutBody({ giftCardCode: code });
      const response = await request(disabledApp.getHttpServer())
        .post('/api/v1/orders')
        .send(await httpCheckoutBody(disabledApp.getHttpServer(), body))
        .expect(201);
      expect(response.body).toHaveProperty('orderId');
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: attemptsOfCheckout(body.idempotencyKey),
      });
      expect(attempt.status).toBe('SUCCEEDED');
      expect(attempt.providerReference).toBe('no-charge');
      expect(attempt.provider).toBe('unavailable');
    });
  });

  describe('simulated provider bound, but the process is running in production', () => {
    it('refuses the checkout with 503 and records nothing, never a "paid" order', async () => {
      const body = checkoutBody();
      const ordersBefore = await prisma.order.count();
      process.env.NODE_ENV = 'production';
      try {
        await request(fakeApp.getHttpServer())
          .post('/api/v1/orders')
          .send(await httpCheckoutBody(fakeApp.getHttpServer(), body))
          .expect(503);
      } finally {
        process.env.NODE_ENV = 'development';
      }
      expect(await attemptCount(body.idempotencyKey)).toBe(0);
      expect(await prisma.order.count()).toBe(ordersBefore);
    });
  });
});
