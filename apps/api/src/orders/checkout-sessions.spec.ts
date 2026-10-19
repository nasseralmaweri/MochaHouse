/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  enrollTestCustomer,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { PAYMENT_PROVIDER } from '../payment/payment-provider.token';
import { HELD_PAYMENT_MESSAGE } from '../payment/payment-charge';
import { CheckoutService } from './application/checkout.service';
import {
  canonicalCheckout,
  checkoutFingerprint,
  hashCheckoutToken,
} from './application/checkout-session';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from '../gift-cards/application/gift-card-configuration.service';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';

// ESP-03 PR 6 — server-owned checkout sessions and server-generated payment
// keys, on real services and a real disposable database (the provider is a
// controlled double). Covers: a session's token is only ever stored hashed;
// payment keys come from the server only (a client key is refused); reload
// and lost responses, double clicks and concurrent submissions reach ONE
// payment; a changed checkout while a payment is live is refused (never
// re-charged, never a different order); a definitive decline can be retried
// (with edits) in the same checkout; held / unknown payments are never
// charged again; an intentional identical repeat purchase is a new checkout;
// business and customer isolation; guest data only to the session holder;
// session expiry keeps every payment record; the database's one-live-attempt
// rule; and gift-card purchases with server keys.

class ControlledProvider implements PaymentProvider {
  readonly name = 'controlled-test';
  readonly acceptsPayments = true;
  calls: ChargeRequest[] = [];
  behavior: (req: ChargeRequest) => Promise<ChargeResult> = async (req) => ({
    outcome: 'succeeded',
    providerReference: `ctl_${req.idempotencyKey}`,
  });
  charge(req: ChargeRequest): Promise<ChargeResult> {
    this.calls.push(req);
    return this.behavior(req);
  }
  reset(): void {
    this.calls = [];
    this.behavior = async (req) => ({
      outcome: 'succeeded',
      providerReference: `ctl_${req.idempotencyKey}`,
    });
  }
}

async function outcomeOf<T>(fn: () => Promise<T>): Promise<{
  ok: boolean;
  value?: T;
  status?: number;
  response?: unknown;
}> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    const err = e as {
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    return {
      ok: false,
      status: err.getStatus?.(),
      response: err.getResponse?.(),
    };
  }
}

jest.setTimeout(120_000);

describe('ESP-03 PR 6 checkout sessions and server-generated payment keys (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tB = tenantContextFor(TEST_TENANT_B_ID);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let purchases: GiftCardPurchaseService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let smallOptionId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'checkout-sessions-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'checkout-sessions-spec-recovery-secret';
    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        LocationsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      providers: [CheckoutService],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(provider)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    purchases = moduleRef.get(GiftCardPurchaseService, { strict: false });

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
    smallOptionId = group.options.find((o) => o.name === 'Small')!.id;
    mediumOptionId = group.options.find((o) => o.name === 'Medium')!.id;
    await prisma.giftCardConfiguration.upsert({
      where: {
        tenantId_key: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          key: GIFT_CARD_CONFIGURATION_KEY,
        },
      },
      create: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: GIFT_CARD_CONFIGURATION_KEY,
        presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
        customAmountEnabled: true,
      },
      update: {
        presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
        customAmountEnabled: true,
      },
    });
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    await removeTestTenantB(prisma).catch(() => undefined);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  const cart = (
    overrides: Partial<Omit<CheckoutRequest, 'checkoutToken'>> = {},
    optionId = mediumOptionId,
  ): Omit<CheckoutRequest, 'checkoutToken'> => ({
    locationId,
    guest: { name: 'Session Guest', phone: '5551237777' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [optionId] }],
      },
    ],
    ...overrides,
  });
  const start = async (
    who: CustomerIdentity | undefined = undefined,
    tenant = t1,
    checkoutToken?: string,
  ) =>
    checkout.startSession(
      { locationId, ...(checkoutToken ? { checkoutToken } : {}) },
      who,
      tenant,
    );
  const submit = (
    token: string,
    body = cart(),
    who: CustomerIdentity | undefined = undefined,
    tenant = t1,
  ) => checkout.checkout({ ...body, checkoutToken: token }, who, tenant);
  const sessionOf = (token: string) =>
    prisma.checkoutSession.findUniqueOrThrow({
      where: { tokenHash: hashCheckoutToken(token) },
      include: { paymentAttempts: { orderBy: { createdAt: 'asc' } } },
    });
  const ordersOf = async (token: string) =>
    prisma.order.findMany({
      where: {
        paymentAttempt: {
          checkoutSession: { tokenHash: hashCheckoutToken(token) },
        },
      },
    });

  async function customer(label: string): Promise<CustomerIdentity> {
    const subject = `test:pr6-${label}-${run}`;
    await enrollTestCustomer(prisma, TENANT_1_MOCHA_HOUSE_ID, {
      provider: 'test',
      subject,
      email: `pr6-${label}-${run}@example.test`,
    });
    return {
      provider: 'test',
      subject,
      email: `pr6-${label}-${run}@example.test`,
      name: null,
      emailVerified: true,
    };
  }

  describe('the session and its token', () => {
    it('is created by the server; only the token hash is stored; resuming keeps the same session', async () => {
      const first = await start();
      expect(first).toMatchObject({ state: 'OPEN', confirmation: null });
      expect(first.checkoutToken).toMatch(/^cs_[A-Za-z0-9_-]{43}$/);
      const stored = await sessionOf(first.checkoutToken);
      expect(stored.tokenHash).toBe(
        createHash('sha256').update(first.checkoutToken).digest('hex'),
      );
      expect(JSON.stringify(stored)).not.toContain(first.checkoutToken);
      expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(
        24 * 3600_000,
      );
      expect(stored.tokenExpiresAt.getTime() - stored.createdAt.getTime()).toBe(
        7 * 24 * 3600_000,
      );

      const resumed = await start(undefined, t1, first.checkoutToken);
      expect(resumed).toMatchObject({
        checkoutToken: first.checkoutToken,
        state: 'OPEN',
      });
      expect(
        await prisma.checkoutSession.count({
          where: { tokenHash: hashCheckoutToken(first.checkoutToken) },
        }),
      ).toBe(1);
    });

    it('payment keys come from the server only: a client key is refused before anything happens', async () => {
      const { checkoutToken } = await start();
      const refused = await outcomeOf(() =>
        checkout.checkout(
          { ...cart(), checkoutToken, idempotencyKey: randomUUID() } as never,
          undefined,
          t1,
        ),
      );
      expect(refused.status).toBe(400);
      expect(refused.response).toMatchObject({
        code: 'CLIENT_PAYMENT_KEY_NOT_ACCEPTED',
      });
      expect(provider.calls).toHaveLength(0);
      expect((await sessionOf(checkoutToken)).paymentAttempts).toHaveLength(0);

      const placed = await submit(checkoutToken);
      const [attempt] = (await sessionOf(checkoutToken)).paymentAttempts;
      expect(attempt.idempotencyKey).toMatch(/^ck_[A-Za-z0-9_-]{43}$/);
      expect(provider.calls[0].idempotencyKey).toBe(attempt.idempotencyKey);
      expect(attempt.idempotencyKey).not.toContain(checkoutToken.slice(3));
      // The fingerprint is an HMAC keyed with the token: not reproducible
      // from the stored data (an unkeyed hash of the checkout differs).
      expect(attempt.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
      const unkeyed = createHash('sha256')
        .update(
          canonicalCheckout({
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            locationId,
            customerId: null,
            guest: cart().guest,
            lines: cart().lines,
            rewardId: null,
            couponCode: null,
            giftCardCode: null,
          }),
        )
        .digest('hex');
      expect(attempt.requestFingerprint).not.toBe(unkeyed);
      expect(placed.orderId).toBe((await ordersOf(checkoutToken))[0].id);
    });
  });

  describe('retries reach the same payment', () => {
    it('a reload after a lost response: the session reports the completed order, and a retry returns it, charged once', async () => {
      const { checkoutToken } = await start();
      const placed = await submit(checkoutToken); // the response "is lost"
      const resumed = await start(undefined, t1, checkoutToken);
      expect(resumed.state).toBe('COMPLETED');
      expect(resumed.confirmation).toMatchObject({
        orderId: placed.orderId,
        accessToken: placed.accessToken,
      });
      const retry = await submit(checkoutToken);
      expect(retry.orderId).toBe(placed.orderId);
      expect(provider.calls).toHaveLength(1);
    });

    it('double clicks and concurrent submissions create one payment attempt, one charge and one order', async () => {
      const { checkoutToken } = await start();
      provider.behavior = async (req) => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          outcome: 'succeeded',
          providerReference: `ctl_${req.idempotencyKey}`,
        };
      };
      const results = await Promise.all(
        Array.from({ length: 6 }, () => outcomeOf(() => submit(checkoutToken))),
      );
      expect(provider.calls).toHaveLength(1);
      const session = await sessionOf(checkoutToken);
      expect(session.paymentAttempts).toHaveLength(1);
      const orders = await ordersOf(checkoutToken);
      expect(orders).toHaveLength(1);
      for (const r of results) {
        if (r.ok)
          expect((r.value as { orderId: string }).orderId).toBe(orders[0].id);
        else expect(r.status).toBe(409);
      }
    });

    it('a successful order replays exactly, with no charge', async () => {
      const { checkoutToken } = await start();
      const first = await submit(checkoutToken);
      const again = await submit(checkoutToken);
      expect(again).toEqual(first);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('while a payment is live, the checkout cannot change', () => {
    it('a held (unknown) payment: the same checkout is told to wait, a changed one is refused; nothing is charged again or saved differently', async () => {
      provider.behavior = async () => ({ outcome: 'unknown', reason: 'x' });
      const { checkoutToken } = await start();
      const first = await outcomeOf(() => submit(checkoutToken));
      expect(first.status).toBe(409);
      provider.reset();
      const saved = await prisma.checkoutSnapshot.findFirstOrThrow({
        where: {
          paymentAttempt: {
            checkoutSession: { tokenHash: hashCheckoutToken(checkoutToken) },
          },
        },
      });

      const same = await outcomeOf(() => submit(checkoutToken));
      expect(same.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      const changed = await outcomeOf(() =>
        submit(checkoutToken, cart({}, smallOptionId)),
      );
      expect(changed.status).toBe(409);
      expect(changed.response).toMatchObject({
        code: 'CHECKOUT_CHANGED_DURING_PAYMENT',
      });
      expect(provider.calls).toHaveLength(0);
      expect(
        await prisma.checkoutSnapshot.findUniqueOrThrow({
          where: { id: saved.id },
        }),
      ).toEqual(saved);
      expect((await sessionOf(checkoutToken)).paymentAttempts).toHaveLength(1);
      expect((await start(undefined, t1, checkoutToken)).state).toBe(
        'IN_PROGRESS',
      );
    });

    it('a completed payment: a changed checkout is refused, never answered with a different order', async () => {
      const { checkoutToken } = await start();
      const placed = await submit(checkoutToken);
      for (const changed of [
        cart({}, smallOptionId),
        cart({ guest: { name: 'Someone Else', phone: '5550001111' } }),
      ]) {
        const r = await outcomeOf(() => submit(checkoutToken, changed));
        expect(r.status).toBe(409);
        expect(r.response).toMatchObject({
          code: 'CHECKOUT_ALREADY_COMPLETED',
        });
        expect(JSON.stringify(r.response)).not.toContain(placed.orderId);
      }
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('after a definitive decline', () => {
    it('the same checkout may be retried, with edits, as one new attempt; nothing else changes', async () => {
      provider.behavior = async () => ({ outcome: 'declined', reason: 'card' });
      const { checkoutToken } = await start();
      const declined = await outcomeOf(() => submit(checkoutToken));
      expect(declined.status).toBe(402);
      provider.reset();
      const edited = cart({}, smallOptionId);
      const placed = await submit(checkoutToken, edited);
      const attempts = (await sessionOf(checkoutToken)).paymentAttempts;
      expect(attempts.map((a) => a.status)).toEqual(['DECLINED', 'SUCCEEDED']);
      expect(attempts[0].requestFingerprint).not.toBe(
        attempts[1].requestFingerprint,
      );
      expect(provider.calls).toHaveLength(1);
      expect((await ordersOf(checkoutToken)).map((o) => o.id)).toEqual([
        placed.orderId,
      ]);
    });
  });

  describe('an intentional repeat purchase', () => {
    it('an identical order in a NEW checkout is a new payment and a new order (no matching on cart, phone or amount)', async () => {
      const a = await start();
      const b = await start();
      const first = await submit(a.checkoutToken);
      const second = await submit(b.checkoutToken);
      expect(second.orderId).not.toBe(first.orderId);
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[0].idempotencyKey).not.toBe(
        provider.calls[1].idempotencyKey,
      );
    });
  });

  describe('isolation', () => {
    it('another business cannot use a session: refused exactly like an unknown token, nothing revealed or charged', async () => {
      const { checkoutToken } = await start();
      const placed = await submit(
        checkoutToken,
        cart({ guest: { name: 'Private Guest', phone: '5559998888' } }),
      );
      const unknown = await outcomeOf(() => submit(`cs_${'A'.repeat(43)}`));
      const foreign = await outcomeOf(() =>
        checkout.checkout({ ...cart(), checkoutToken }, undefined, tB),
      );
      // Tenant B cannot even name Tenant 1's location.
      expect(foreign.status).toBe(404);
      expect(unknown.response).toMatchObject({
        code: 'CHECKOUT_SESSION_INVALID',
      });
      for (const r of [unknown, foreign]) {
        const text = JSON.stringify(r.response);
        expect(text).not.toContain(placed.orderId);
        expect(text).not.toContain(placed.accessToken);
        expect(text).not.toContain('Private Guest');
      }
      // Starting a session in Tenant B with Tenant 1's token never resumes it.
      const fromB = await outcomeOf(() =>
        checkout.startSession({ locationId, checkoutToken }, undefined, tB),
      );
      expect(fromB.status).toBe(404);
      expect(provider.calls).toHaveLength(1);
    });

    it('a session belongs to its customer (or guest): another identity is refused and never sees its order', async () => {
      const ann = await customer('ann');
      const bob = await customer('bob');
      const annSession = await start(ann);
      const placed = await submit(annSession.checkoutToken, cart(), ann);

      for (const who of [bob, undefined]) {
        const r = await outcomeOf(() =>
          submit(annSession.checkoutToken, cart(), who),
        );
        expect(r.response).toMatchObject({ code: 'CHECKOUT_SESSION_INVALID' });
        expect(JSON.stringify(r.response)).not.toContain(placed.orderId);
        // Resuming with Ann's token as someone else starts a NEW session.
        const resumed = await start(who, t1, annSession.checkoutToken);
        expect(resumed.checkoutToken).not.toBe(annSession.checkoutToken);
        expect(resumed.confirmation).toBeNull();
      }
      // A guest session cannot be taken over by a signed-in customer.
      const guest = await start();
      const takeover = await outcomeOf(() =>
        submit(guest.checkoutToken, cart(), bob),
      );
      expect(takeover.response).toMatchObject({
        code: 'CHECKOUT_SESSION_INVALID',
      });
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('expiry', () => {
    it('an unused session stops accepting payments after 24 hours; nothing is deleted', async () => {
      const { checkoutToken } = await start();
      await prisma.checkoutSession.update({
        where: { tokenHash: hashCheckoutToken(checkoutToken) },
        data: {
          createdAt: new Date(Date.now() - 25 * 3600_000),
          expiresAt: new Date(Date.now() - 3600_000),
        },
      });
      const expired = await outcomeOf(() => submit(checkoutToken));
      expect(expired.response).toMatchObject({
        code: 'CHECKOUT_SESSION_EXPIRED',
      });
      expect(provider.calls).toHaveLength(0);
      // Resuming it starts a new session; the old one is kept.
      const resumed = await start(undefined, t1, checkoutToken);
      expect(resumed.checkoutToken).not.toBe(checkoutToken);
      expect(await sessionOf(checkoutToken)).toBeDefined();
    });

    it('a held payment keeps its session, payment, saved checkout and case after the session expires; the token is recognised for its 7 days', async () => {
      provider.behavior = async () => ({ outcome: 'unknown', reason: 'x' });
      const { checkoutToken } = await start();
      await outcomeOf(() => submit(checkoutToken));
      provider.reset();
      await prisma.checkoutSession.update({
        where: { tokenHash: hashCheckoutToken(checkoutToken) },
        data: {
          createdAt: new Date(Date.now() - 2 * 24 * 3600_000),
          expiresAt: new Date(Date.now() - 24 * 3600_000),
        },
      });
      const held = await outcomeOf(() => submit(checkoutToken));
      expect(held.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      expect((await start(undefined, t1, checkoutToken)).state).toBe(
        'IN_PROGRESS',
      );
      const [attempt] = (await sessionOf(checkoutToken)).paymentAttempts;
      expect(
        await prisma.checkoutSnapshot.count({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toBe(1);
      expect(
        await prisma.paymentReconciliationCase.count({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toBe(1);

      // Past the token's own lifetime it is no longer recognised — and the
      // records are still all there.
      await prisma.checkoutSession.update({
        where: { tokenHash: hashCheckoutToken(checkoutToken) },
        data: {
          createdAt: new Date(Date.now() - 9 * 24 * 3600_000),
          expiresAt: new Date(Date.now() - 8 * 24 * 3600_000),
          tokenExpiresAt: new Date(Date.now() - 2 * 24 * 3600_000),
        },
      });
      const stale = await outcomeOf(() => submit(checkoutToken));
      expect(stale.response).toMatchObject({
        code: 'CHECKOUT_SESSION_INVALID',
      });
      expect(
        await prisma.paymentAttempt.count({ where: { id: attempt.id } }),
      ).toBe(1);
      expect(
        await prisma.checkoutSnapshot.count({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toBe(1);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('the database', () => {
    it('refuses a second live payment attempt for one session, and allows one after a definitive decline', async () => {
      const { checkoutToken } = await start();
      const session = await sessionOf(checkoutToken);
      const attempt = (
        status: 'PENDING' | 'DECLINED' | 'SUCCEEDED',
        paymentState: string,
      ) =>
        prisma.paymentAttempt.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            idempotencyKey: `ck_test_${randomUUID()}`,
            checkoutSessionId: session.id,
            requestFingerprint: 'a'.repeat(64),
            provider: 'test',
            locationId,
            amount: 100,
            currency: 'USD',
            status,
            paymentState,
          },
        });
      await attempt('DECLINED', 'DECLINED');
      await attempt('PENDING', 'UNKNOWN');
      await expect(attempt('PENDING', 'CHARGING')).rejects.toMatchObject({
        code: 'P2002',
      });
      await expect(attempt('SUCCEEDED', 'SUCCEEDED')).rejects.toMatchObject({
        code: 'P2002',
      });
      // A session attempt always carries its fingerprint.
      await expect(
        prisma.paymentAttempt.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            idempotencyKey: `ck_test_${randomUUID()}`,
            checkoutSessionId: session.id,
            provider: 'test',
            locationId,
            amount: 100,
            currency: 'USD',
            status: 'DECLINED',
          },
        }),
      ).rejects.toThrow(/check constraint/i);
    });

    it('a never-sent attempt is abandoned only while still NOT_SENT: a claimed (charging) one is never abandoned', async () => {
      const { checkoutToken } = await start();
      const session = await sessionOf(checkoutToken);
      const charging = await prisma.paymentAttempt.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          idempotencyKey: `ck_test_${randomUUID()}`,
          checkoutSessionId: session.id,
          requestFingerprint: 'b'.repeat(64),
          provider: 'test',
          locationId,
          amount: 100,
          currency: 'USD',
          paymentState: 'CHARGING',
          createdAt: new Date(Date.now() - 60 * 60_000),
        },
      });
      const r = await outcomeOf(() => submit(checkoutToken));
      expect(r.status).toBe(409);
      expect(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: charging.id },
        }),
      ).toMatchObject({ status: 'PENDING', paymentState: 'CHARGING' });
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('review hardening', () => {
    const sessionAttempt = async (
      checkoutToken: string,
      data: Record<string, unknown>,
    ) => {
      const session = await sessionOf(checkoutToken);
      return prisma.paymentAttempt.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          idempotencyKey: `ck_test_${randomUUID()}`,
          checkoutSessionId: session.id,
          requestFingerprint: 'c'.repeat(64),
          provider: 'test',
          locationId,
          amount: 100,
          currency: 'USD',
          ...data,
        },
      });
    };

    it("a customer's session whose customer is removed is refused, never treated as a guest's", async () => {
      const cid = await customer('removed');
      const { checkoutToken } = await start(cid);
      const session = await sessionOf(checkoutToken);
      expect(session.customerBound).toBe(true);
      // The state a removed customer leaves (ON DELETE SET NULL).
      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { customerId: null },
      });
      const r = await outcomeOf(() => submit(checkoutToken));
      expect(r.response).toMatchObject({ code: 'CHECKOUT_SESSION_INVALID' });
      const resumed = await start(undefined, t1, checkoutToken);
      expect(resumed.checkoutToken).not.toBe(checkoutToken);
      expect(provider.calls).toHaveLength(0);
    });

    it('unused sessions past their token lifetime are cleaned up; any session with a payment is kept', async () => {
      const unused = await start();
      const paid = await start();
      await submit(paid.checkoutToken);
      const past = new Date(Date.now() - 24 * 3600_000);
      for (const token of [unused.checkoutToken, paid.checkoutToken]) {
        await prisma.checkoutSession.update({
          where: { tokenHash: hashCheckoutToken(token) },
          data: {
            createdAt: new Date(Date.now() - 9 * 24 * 3600_000),
            expiresAt: new Date(Date.now() - 8 * 24 * 3600_000),
            tokenExpiresAt: past,
          },
        });
      }
      await start();
      expect(
        await prisma.checkoutSession.count({
          where: { tokenHash: hashCheckoutToken(unused.checkoutToken) },
        }),
      ).toBe(0);
      expect(
        await prisma.checkoutSession.count({
          where: { tokenHash: hashCheckoutToken(paid.checkoutToken) },
        }),
      ).toBe(1);
    });

    it('a confirmed payment with neither its order nor its saved checkout is flagged with a case, never silent or charged again', async () => {
      const { checkoutToken } = await start();
      // A paid attempt for exactly this checkout, whose saved checkout is gone.
      const attempt = await sessionAttempt(checkoutToken, {
        requestFingerprint: checkoutFingerprint(checkoutToken, {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          customerId: null,
          guest: cart().guest,
          lines: cart().lines,
          rewardId: null,
          couponCode: null,
          giftCardCode: null,
        }),
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
      });
      const r = await outcomeOf(() => submit(checkoutToken));
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.response)).toContain('manual review');
      expect(
        await prisma.paymentReconciliationCase.findFirst({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toMatchObject({ reasonCode: 'FULFILMENT_FAILED', status: 'OPEN' });
      expect(provider.calls).toHaveLength(0);
    });

    it('a charge claimed long ago with no recorded outcome is made visible (a case), never abandoned or charged again', async () => {
      const { checkoutToken } = await start();
      const stuck = await sessionAttempt(checkoutToken, {
        paymentState: 'CHARGING',
      });
      await prisma.$executeRaw`
        UPDATE "PaymentAttempt" SET "updatedAt" = now() - interval '30 minutes'
        WHERE id = ${stuck.id}`;
      // (A different checkout here: refused while that payment is live.)
      const r = await outcomeOf(() => submit(checkoutToken));
      expect(r.status).toBe(409);
      expect(r.response).toMatchObject({
        code: 'CHECKOUT_CHANGED_DURING_PAYMENT',
      });
      expect((await start(undefined, t1, checkoutToken)).state).toBe(
        'IN_PROGRESS',
      );
      expect(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: stuck.id },
        }),
      ).toMatchObject({ status: 'PENDING', paymentState: 'CHARGING' });
      expect(
        await prisma.paymentReconciliationCase.findFirst({
          where: { paymentAttemptId: stuck.id },
        }),
      ).toMatchObject({ reasonCode: 'CHARGE_STRANDED', status: 'OPEN' });
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('gift-card purchases', () => {
    it('use server-generated keys; retries name the purchase and never charge or issue twice', async () => {
      const intent = await purchases.createIntent(
        {
          amountMinorUnits: 2500,
          purchaserEmail: `pr6-gift-${run}@example.test`,
          purchaserName: 'PR6 Gift',
        },
        undefined,
        t1,
      );
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({
        where: { giftCardPurchase: { id: intent.purchaseId } },
      });
      expect(attempt.idempotencyKey).toMatch(/^gc_[A-Za-z0-9_-]{43}$/);
      const buy = () =>
        purchases.purchase(
          {
            purchaseId: intent.purchaseId,
            recoveryCredential: intent.recoveryCredential,
          },
          undefined,
          t1,
        );
      const results = await Promise.all([
        outcomeOf(buy),
        outcomeOf(buy),
        outcomeOf(buy),
      ]);
      expect(results.some((r) => r.ok)).toBe(true);
      const again = await buy();
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].idempotencyKey).toBe(attempt.idempotencyKey);
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardPurchaseId: intent.purchaseId, type: 'ISSUANCE' },
        }),
      ).toBe(1);
      expect(again.purchaseId).toBe(intent.purchaseId);
    });
  });
});
