/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { tenantContextFor } from '@mocha-house/testing';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from '@mocha-house/integrations';
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
import { PaymentModule } from './payment.module';
import { PAYMENT_PROVIDER } from './payment-provider.token';
import { chargeAttempt } from './payment-charge';
import { CheckoutService } from '../orders/application/checkout.service';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from '../gift-cards/application/gift-card-configuration.service';
import {
  attemptsOfCheckout,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';
import {
  createGiftIntent,
  purchaseGiftCard,
} from '../../test/checkout-session';

// ESP-03 PR 2 — payment provider states and safe retries. Real services and a
// real disposable database; the provider is a controlled double so a throw, a
// timeout, a pending result and a concurrent replay can each be forced.

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

async function outcomeOf(fn: () => Promise<unknown>): Promise<{
  ok: boolean;
  status?: number;
  response?: unknown;
}> {
  try {
    await fn();
    return { ok: true };
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

describe('payment provider states and safe retries (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let purchases: GiftCardPurchaseService;
  let locationId: string;
  let otherLocationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'payment-states-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'payment-states-spec-recovery-secret';
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
    const other = await prisma.location.findFirstOrThrow({
      where: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        id: { not: location.id },
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
    otherLocationId = other.id;
    productId = product.id;
    const group = product.modifierGroups[0].modifierGroup;
    sizeGroupId = group.id;
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
  });

  afterAll(async () => {
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  const checkoutBody = (): LabelledCheckoutRequest => ({
    clientRef: `ps_${randomUUID()}`,
    locationId,
    guest: { name: 'State Guest', phone: '5551230000' },
    lines: [
      {
        productId,
        quantity: 1,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
  });

  const attemptOf = (key: string) =>
    prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(key),
    });
  const ordersFor = (attemptId: string) =>
    prisma.order.count({ where: { paymentAttemptId: attemptId } });

  describe('checkout', () => {
    it('a healthy charge persists CHARGING first and ends SUCCEEDED with one order', async () => {
      let stateDuringCharge: string | null | undefined;
      provider.behavior = async (req) => {
        stateDuringCharge = (await attemptOf(req.idempotencyKey)).paymentState;
        return { outcome: 'succeeded', providerReference: 'ref_1' };
      };
      const b = checkoutBody();
      await submitCheckout(checkout, b, undefined, t1);
      const a = await attemptOf(b.clientRef);
      expect(stateDuringCharge).toBe('CHARGING');
      expect(a.status).toBe('SUCCEEDED');
      expect(a.paymentState).toBe('SUCCEEDED');
      expect(await ordersFor(a.id)).toBe(1);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].idempotencyKey).toMatch(
        /^ck_[A-Za-z0-9_-]{43}$/,
      );
    });

    it('a decline is DECLINED; retrying the same checkout is one new attempt (ESP-03 PR 6), the declined one untouched', async () => {
      provider.behavior = async () => ({
        outcome: 'declined',
        reason: 'Card declined.',
      });
      const b = checkoutBody();
      const first = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      const replay = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      const attempts = await prisma.paymentAttempt.findMany({
        where: attemptsOfCheckout(b.clientRef),
        orderBy: { createdAt: 'asc' },
      });
      expect(first.status).toBe(402);
      expect(replay.status).toBe(402);
      expect(attempts.map((a) => [a.status, a.paymentState])).toEqual([
        ['DECLINED', 'DECLINED'],
        ['DECLINED', 'DECLINED'],
      ]);
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[0].idempotencyKey).not.toBe(
        provider.calls[1].idempotencyKey,
      );
    });

    it('a definitive provider failure is FAILED', async () => {
      provider.behavior = async () => ({
        outcome: 'failed',
        reason: 'Provider rejected the request.',
      });
      const b = checkoutBody();
      expect(
        (await outcomeOf(() => submitCheckout(checkout, b, undefined, t1)))
          .status,
      ).toBe(402);
      const a = await attemptOf(b.clientRef);
      expect([a.status, a.paymentState]).toEqual(['FAILED', 'FAILED']);
    });

    it('a provider exception is UNKNOWN, never FAILED, and is never charged again on retry', async () => {
      provider.behavior = async () => {
        throw new Error('socket hang up');
      };
      const b = checkoutBody();
      const first = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      expect(first.status).toBe(409);
      const a = await attemptOf(b.clientRef);
      expect(a.paymentState).toBe('UNKNOWN');
      expect(a.status).toBe('PENDING');

      // The provider "recovers": a retry of the same key must still not charge.
      provider.reset();
      const retry = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      expect(retry.status).toBe(409);
      expect(provider.calls).toHaveLength(0);
      expect((await attemptOf(b.clientRef)).paymentState).toBe('UNKNOWN');
      expect(await ordersFor(a.id)).toBe(0);
    });

    it('a provider timeout is UNKNOWN, not FAILED', async () => {
      const a = await prisma.paymentAttempt.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          idempotencyKey: `ps_${randomUUID()}`,
          provider: provider.name,
          locationId,
          amount: 500,
          currency: 'USD',
          paymentState: 'NOT_SENT',
        },
      });
      provider.behavior = () => new Promise(() => undefined); // never resolves
      const result = await chargeAttempt(
        prisma,
        provider,
        a,
        { amount: 500, currency: 'USD' },
        { timeoutMs: 25 },
      );
      expect(result).toMatchObject({ kind: 'held', state: 'UNKNOWN' });
      const row = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: a.id },
      });
      expect([row.status, row.paymentState]).toEqual(['PENDING', 'UNKNOWN']);
    });

    it('a pending provider result is AWAITING_CONFIRMATION, not FAILED, and is held on replay', async () => {
      provider.behavior = async () => ({
        outcome: 'pending',
        reason: 'Awaiting bank confirmation.',
        providerReference: 'ref_pending',
      });
      const b = checkoutBody();
      const first = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      const replay = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t1),
      );
      const a = await attemptOf(b.clientRef);
      expect(first.status).toBe(409);
      expect(replay.status).toBe(409);
      expect(a.status).toBe('PENDING');
      expect(a.paymentState).toBe('AWAITING_CONFIRMATION');
      expect(a.providerReference).toBe('ref_pending');
      expect(provider.calls).toHaveLength(1);
      expect(await ordersFor(a.id)).toBe(0);
    });

    it('an unrecognised provider result is UNKNOWN', async () => {
      provider.behavior = async () =>
        ({ outcome: 'weird' }) as unknown as ChargeResult;
      const b = checkoutBody();
      await outcomeOf(() => submitCheckout(checkout, b, undefined, t1));
      expect((await attemptOf(b.clientRef)).paymentState).toBe('UNKNOWN');
    });

    it('concurrent requests with one key charge the provider exactly once', async () => {
      provider.behavior = async (req) => {
        await new Promise((r) => setTimeout(r, 80));
        return {
          outcome: 'succeeded',
          providerReference: `ctl_${req.idempotencyKey}`,
        };
      };
      const b = checkoutBody();
      const results = await Promise.all([
        outcomeOf(() => submitCheckout(checkout, b, undefined, t1)),
        outcomeOf(() => submitCheckout(checkout, b, undefined, t1)),
        outcomeOf(() => submitCheckout(checkout, b, undefined, t1)),
      ]);
      const a = await attemptOf(b.clientRef);
      expect(provider.calls).toHaveLength(1);
      // ESP-03 PR 4 — the requests that lost the charge claim are answered
      // with the one order (created from the saved checkout), never a second
      // charge or order.
      expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
      expect(await ordersFor(a.id)).toBe(1);
    });

    it('concurrent requests with one key while the outcome is unknown never charge twice', async () => {
      provider.behavior = async () => {
        await new Promise((r) => setTimeout(r, 40));
        throw new Error('connection reset');
      };
      const b = checkoutBody();
      await Promise.all([
        outcomeOf(() => submitCheckout(checkout, b, undefined, t1)),
        outcomeOf(() => submitCheckout(checkout, b, undefined, t1)),
      ]);
      expect(provider.calls).toHaveLength(1);
      expect((await attemptOf(b.clientRef)).paymentState).toBe('UNKNOWN');
    });

    it('a key reused for a different Location is refused and does not reveal the original', async () => {
      const b = checkoutBody();
      await submitCheckout(checkout, b, undefined, t1);
      const reused = await outcomeOf(() =>
        submitCheckout(
          checkout,
          { ...b, locationId: otherLocationId },
          undefined,
          t1,
        ),
      );
      expect(reused.status).toBe(409);
      expect(provider.calls).toHaveLength(1);
    });

    it('a legacy attempt (from before checkout sessions) can never be reached by a client: refused before anything happens, never charged, never changed', async () => {
      for (const legacyState of [
        { status: 'PENDING' as const },
        { status: 'DECLINED' as const, failureReason: 'Old decline.' },
      ]) {
        const legacy = await prisma.paymentAttempt.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            idempotencyKey: `legacy_${randomUUID()}`,
            provider: provider.name,
            locationId,
            amount: 500,
            currency: 'USD',
            ...legacyState,
          },
        });
        const { clientRef: _ref, ...rest } = checkoutBody();
        void _ref;
        const result = await outcomeOf(() =>
          checkout.checkout(
            {
              ...rest,
              idempotencyKey: legacy.idempotencyKey,
            } as never,
            undefined,
            t1,
          ),
        );
        expect(result.status).toBe(400);
        expect(result.response).toMatchObject({
          code: 'CLIENT_PAYMENT_KEY_NOT_ACCEPTED',
        });
        expect(provider.calls).toHaveLength(0);
        expect(
          await prisma.paymentAttempt.findUniqueOrThrow({
            where: { id: legacy.id },
          }),
        ).toMatchObject({
          status: legacy.status,
          paymentState: null,
          updatedAt: legacy.updatedAt,
        });
      }
    });

    it('another tenant cannot replay or observe an attempt held for this tenant', async () => {
      provider.behavior = async () => {
        throw new Error('timeout');
      };
      const b = checkoutBody();
      await outcomeOf(() => submitCheckout(checkout, b, undefined, t1));
      provider.reset();
      const t2 = tenantContextFor('01a0db02-f800-7000-8000-0000000000ff');
      const foreign = await outcomeOf(() =>
        submitCheckout(checkout, b, undefined, t2),
      );
      expect(foreign.ok).toBe(false);
      expect(provider.calls).toHaveLength(0);
      expect(JSON.stringify(foreign.response)).not.toContain('UNKNOWN');
    });
  });

  describe('gift-card purchase', () => {
    const intent = (extra: Record<string, unknown> = {}) => ({
      clientRef: randomUUID(),
      amountMinorUnits: 2500,
      purchaserEmail: 'ps-buyer@example.test',
      purchaserName: 'PS Buyer',
      ...extra,
    });
    const run = (key: string, credential: string | null) =>
      purchaseGiftCard(
        purchases,
        { clientRef: key, recoveryCredential: credential ?? undefined },
        undefined,
        t1,
      );

    it('a healthy purchase persists CHARGING first, then SUCCEEDED and issues one card', async () => {
      let stateDuringCharge: string | null | undefined;
      provider.behavior = async (req) => {
        stateDuringCharge = (await attemptOf(req.idempotencyKey)).paymentState;
        return { outcome: 'succeeded', providerReference: 'gc_ref' };
      };
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      const done = await run(req.clientRef, i.recoveryCredential);
      expect(done.status).toBe('ISSUED');
      expect(stateDuringCharge).toBe('CHARGING');
      expect((await attemptOf(req.clientRef)).paymentState).toBe('SUCCEEDED');
      expect(provider.calls).toHaveLength(1);
    });

    it('a provider exception is UNKNOWN and a same-key replay never charges again', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      provider.behavior = async () => {
        throw new Error('timeout');
      };
      const first = await outcomeOf(() =>
        run(req.clientRef, i.recoveryCredential),
      );
      expect(first.status).toBe(409);
      provider.reset();
      const retry = await outcomeOf(() =>
        run(req.clientRef, i.recoveryCredential),
      );
      expect(retry.status).toBe(409);
      expect(provider.calls).toHaveLength(0);
      const a = await attemptOf(req.clientRef);
      expect([a.status, a.paymentState]).toEqual(['PENDING', 'UNKNOWN']);
    });

    it('a pending result is AWAITING_CONFIRMATION and issues no card', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      provider.behavior = async () => ({
        outcome: 'pending',
        reason: 'Awaiting bank.',
      });
      const first = await outcomeOf(() =>
        run(req.clientRef, i.recoveryCredential),
      );
      expect(first.status).toBe(409);
      const a = await attemptOf(req.clientRef);
      expect(a.paymentState).toBe('AWAITING_CONFIRMATION');
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: a.id },
      });
      expect(purchase.status).toBe('PENDING');
      expect(purchase.giftCardId).toBeNull();
    });

    it('a decline is DECLINED (402) and replays without a second charge', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      provider.behavior = async () => ({ outcome: 'declined', reason: 'No.' });
      expect(
        (await outcomeOf(() => run(req.clientRef, i.recoveryCredential)))
          .status,
      ).toBe(402);
      expect(
        (await outcomeOf(() => run(req.clientRef, i.recoveryCredential)))
          .status,
      ).toBe(402);
      expect(provider.calls).toHaveLength(1);
    });

    it('concurrent same-key purchases charge once', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      provider.behavior = async (r) => {
        await new Promise((res) => setTimeout(res, 60));
        return {
          outcome: 'succeeded',
          providerReference: `ctl_${r.idempotencyKey}`,
        };
      };
      const results = await Promise.all([
        outcomeOf(() => run(req.clientRef, i.recoveryCredential)),
        outcomeOf(() => run(req.clientRef, i.recoveryCredential)),
      ]);
      expect(provider.calls).toHaveLength(1);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it('step 1 never replays: each intent is its own uncharged purchase, whatever it repeats', async () => {
      const req = intent();
      const a = await createGiftIntent(purchases, req, undefined, t1);
      const b = await createGiftIntent(
        purchases,
        { ...req, clientRef: randomUUID() },
        undefined,
        t1,
      );
      expect(b.purchaseId).not.toBe(a.purchaseId);
      for (const id of [a.purchaseId, b.purchaseId]) {
        expect(
          await prisma.giftCardPurchase.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ status: 'PENDING', chargeClaimedAt: null });
      }
      expect(provider.calls).toHaveLength(0);
    });

    it('a pre-ESP-03 intent (NULL state, never claimed) can still be charged once', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      await prisma.paymentAttempt.update({
        where: { id: (await attemptOf(req.clientRef)).id },
        data: { paymentState: null },
      });
      const done = await run(req.clientRef, i.recoveryCredential);
      expect(done.status).toBe('ISSUED');
      expect(provider.calls).toHaveLength(1);
      expect((await attemptOf(req.clientRef)).paymentState).toBe('SUCCEEDED');
    });

    it('another tenant cannot complete or observe the purchase', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      const t2 = tenantContextFor('01a0db02-f800-7000-8000-0000000000ff');
      const r = await outcomeOf(() =>
        purchaseGiftCard(
          purchases,
          {
            clientRef: req.clientRef,
            recoveryCredential: i.recoveryCredential ?? undefined,
          },
          undefined,
          t2,
        ),
      );
      expect(r.status).toBe(409);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe('chargeAttempt state machine', () => {
    const fresh = (state: string | null) =>
      prisma.paymentAttempt.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          idempotencyKey: `ps_${randomUUID()}`,
          provider: provider.name,
          locationId,
          amount: 500,
          currency: 'USD',
          paymentState: state,
        },
      });

    it.each([
      'CHARGING',
      'AWAITING_CONFIRMATION',
      'UNKNOWN',
      'SUCCEEDED',
      'DECLINED',
      'FAILED',
    ])('does not claim an attempt already in %s', async (state) => {
      const a = await fresh(state);
      const r = await chargeAttempt(prisma, provider, a, {
        amount: 500,
        currency: 'USD',
      });
      expect(r).toEqual({ kind: 'not-claimed' });
      expect(provider.calls).toHaveLength(0);
    });

    it('only claims a legacy NULL attempt when explicitly allowed', async () => {
      const a = await fresh(null);
      expect(
        await chargeAttempt(prisma, provider, a, {
          amount: 500,
          currency: 'USD',
        }),
      ).toEqual({
        kind: 'not-claimed',
      });
      const b = await chargeAttempt(
        prisma,
        provider,
        a,
        { amount: 500, currency: 'USD' },
        { allowLegacyNullState: true },
      );
      expect(b.kind).toBe('succeeded');
    });

    it('two concurrent claims call the provider once', async () => {
      const a = await fresh('NOT_SENT');
      provider.behavior = async () => {
        await new Promise((r) => setTimeout(r, 40));
        return { outcome: 'succeeded', providerReference: 'x' };
      };
      const [x, y] = await Promise.all([
        chargeAttempt(prisma, provider, a, { amount: 500, currency: 'USD' }),
        chargeAttempt(prisma, provider, a, { amount: 500, currency: 'USD' }),
      ]);
      expect([x.kind, y.kind].sort()).toEqual(['not-claimed', 'succeeded']);
      expect(provider.calls).toHaveLength(1);
    });
  });
});
