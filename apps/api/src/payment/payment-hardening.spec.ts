/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from '@mocha-house/integrations';
import {
  GIFT_CARD_PURCHASE_NOT_FOUND,
  type CheckoutRequest,
} from '@mocha-house/contracts';
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
import {
  HELD_PAYMENT_MESSAGE,
  PAYMENT_DECLINED_MESSAGE,
  PAYMENT_FAILED_MESSAGE,
} from './payment-charge';
import { CheckoutService } from '../orders/application/checkout.service';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from '../gift-cards/application/gift-card-configuration.service';
import { hashRecoveryCredential } from '../gift-cards/infrastructure/gift-card-recovery-credential';

// ESP-03 PR 3 — payment hardening, processor-neutral. Real services and a
// real disposable database; the provider is a controlled double so every
// outcome (decline, failure, throw, pending, a success whose write is lost)
// can be forced. Covers: gift-card key reuse across purchase types, amounts,
// businesses and payment states (R1); authorisation before any payment state
// is revealed (R3); reconciliation cases and kept provider references for
// held or unrecorded outcomes (R2); and fixed customer wording (R8).

// Provider text that must never reach a customer.
const MARKER = 'PROVIDER-INTERNAL-7731 card ending 4242 risk_score=97';

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

describe('ESP-03 PR 3 payment hardening (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let purchases: GiftCardPurchaseService;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'payment-hardening-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'payment-hardening-spec-recovery-secret';
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
    await prisma.giftCardPurchase.deleteMany({
      where: { tenantId: TEST_TENANT_B_ID },
    });
    await prisma.paymentAttempt.deleteMany({
      where: { tenantId: TEST_TENANT_B_ID },
    });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  const checkoutBody = (idempotencyKey = `ph_${randomUUID()}`) =>
    ({
      idempotencyKey,
      locationId,
      guest: { name: 'Hardening Guest', phone: '5551230000' },
      lines: [
        {
          productId,
          quantity: 1,
          selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
        },
      ],
    }) satisfies CheckoutRequest;

  const attemptOf = (key: string) =>
    prisma.paymentAttempt.findUniqueOrThrow({ where: { idempotencyKey: key } });
  const casesFor = (paymentAttemptId: string) =>
    prisma.paymentReconciliationCase.findMany({
      where: { paymentAttemptId },
      include: { events: true },
    });
  const expectNoProviderText = (response: unknown) =>
    expect(JSON.stringify(response)).not.toContain('PROVIDER-INTERNAL');

  // --- Safe customer messages (R8) ------------------------------------

  describe('customer-facing messages', () => {
    it.each([
      ['declined', PAYMENT_DECLINED_MESSAGE],
      ['failed', PAYMENT_FAILED_MESSAGE],
    ] as const)(
      'a %s checkout answers with fixed wording, first time and on replay; the provider text stays internal',
      async (outcome, message) => {
        provider.behavior = async () => ({ outcome, reason: MARKER });
        const body = checkoutBody();
        const first = await outcomeOf(() =>
          checkout.checkout(body, undefined, t1),
        );
        expect(first.status).toBe(402);
        expect(first.response).toEqual({ outcome, message });
        const replay = await outcomeOf(() =>
          checkout.checkout(body, undefined, t1),
        );
        expect(replay.response).toEqual({ outcome, message });
        expect(provider.calls).toHaveLength(1);
        expect((await attemptOf(body.idempotencyKey)).failureReason).toBe(
          MARKER,
        );
      },
    );

    it('a declined gift-card purchase answers the buyer with fixed wording', async () => {
      provider.behavior = async () => ({ outcome: 'declined', reason: MARKER });
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      const run = () =>
        purchases.purchase(
          {
            idempotencyKey: req.idempotencyKey,
            recoveryCredential: i.recoveryCredential ?? undefined,
          },
          undefined,
          t1,
        );
      for (const r of [await outcomeOf(run), await outcomeOf(run)]) {
        expect(r.status).toBe(402);
        expect(r.response).toEqual({
          outcome: 'declined',
          message: PAYMENT_DECLINED_MESSAGE,
        });
      }
      expect(provider.calls).toHaveLength(1);
    });
  });

  // --- Held outcomes open a reconciliation case (R2) -------------------

  describe('uncertain outcomes', () => {
    it('a provider exception is held, opens exactly one case, and retries never charge again', async () => {
      provider.behavior = async () => {
        throw new Error(MARKER);
      };
      const body = checkoutBody();
      for (let i = 0; i < 3; i++) {
        const r = await outcomeOf(() => checkout.checkout(body, undefined, t1));
        expect(r.status).toBe(409);
        expect(r.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
        expectNoProviderText(r.response);
      }
      expect(provider.calls).toHaveLength(1);
      const attempt = await attemptOf(body.idempotencyKey);
      expect(attempt.paymentState).toBe('UNKNOWN');
      const cases = await casesFor(attempt.id);
      expect(cases).toHaveLength(1);
      expect(cases[0]).toMatchObject({
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        status: 'OPEN',
        reasonCode: 'PROVIDER_OUTCOME_UNKNOWN',
      });
      expect(cases[0].events).toHaveLength(1);
      expect(cases[0].events[0]).toMatchObject({
        actorKind: 'SYSTEM',
        actorInternalUserId: null,
        action: 'OPENED',
        detail: {
          source: 'payment-charge',
          reasonCode: 'PROVIDER_OUTCOME_UNKNOWN',
          outcome: 'unknown',
        },
      });
      expectNoProviderText(cases[0].events[0].detail);
    });

    it('a pending result keeps its provider reference and opens a case', async () => {
      provider.behavior = async (req) => ({
        outcome: 'pending',
        reason: MARKER,
        providerReference: `pend_${req.idempotencyKey}`,
      });
      const body = checkoutBody();
      const r = await outcomeOf(() => checkout.checkout(body, undefined, t1));
      expect(r.status).toBe(409);
      const attempt = await attemptOf(body.idempotencyKey);
      expect(attempt).toMatchObject({
        paymentState: 'AWAITING_CONFIRMATION',
        status: 'PENDING',
        providerReference: `pend_${body.idempotencyKey}`,
      });
      const cases = await casesFor(attempt.id);
      expect(cases.map((c) => c.reasonCode)).toEqual([
        'PROVIDER_AWAITING_CONFIRMATION',
      ]);
      expect(
        await prisma.order.count({ where: { paymentAttemptId: attempt.id } }),
      ).toBe(0);
    });

    it('concurrent retries of a held payment charge once and open one case', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      provider.behavior = async () => {
        await gate;
        return { outcome: 'unknown', reason: MARKER };
      };
      const body = checkoutBody();
      const first = outcomeOf(() => checkout.checkout(body, undefined, t1));
      // Let the first request claim the charge, then pile on.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const others = Promise.all(
        Array.from({ length: 4 }, () =>
          outcomeOf(() => checkout.checkout(body, undefined, t1)),
        ),
      );
      release();
      const results = [await first, ...(await others)];
      expect(results.every((r) => r.status === 409)).toBe(true);
      expect(provider.calls).toHaveLength(1);
      const attempt = await attemptOf(body.idempotencyKey);
      expect(await casesFor(attempt.id)).toHaveLength(1);
    });

    it('a held gift-card payment opens a case too', async () => {
      provider.behavior = async () => {
        throw new Error(MARKER);
      };
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      const r = await outcomeOf(() =>
        purchases.purchase(
          {
            idempotencyKey: req.idempotencyKey,
            recoveryCredential: i.recoveryCredential ?? undefined,
          },
          undefined,
          t1,
        ),
      );
      expect(r.status).toBe(409);
      const attempt = await attemptOf(req.idempotencyKey);
      expect((await casesFor(attempt.id)).map((c) => c.reasonCode)).toEqual([
        'PROVIDER_OUTCOME_UNKNOWN',
      ]);
    });
  });

  // --- A provider success whose write is lost (R2) ---------------------

  describe('provider success that cannot be recorded', () => {
    it('another writer moved the attempt mid-charge: the reference is kept, a case opened, no order, no second charge', async () => {
      const body = checkoutBody();
      provider.behavior = async (req) => {
        // Something else (a future reconciler) moves the row while the
        // provider is answering.
        await prisma.paymentAttempt.updateMany({
          where: { idempotencyKey: req.idempotencyKey },
          data: { paymentState: 'UNKNOWN' },
        });
        return { outcome: 'succeeded', providerReference: 'ref_lost_write' };
      };
      const r = await outcomeOf(() => checkout.checkout(body, undefined, t1));
      expect(r.status).toBe(409);
      expect(r.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      const attempt = await attemptOf(body.idempotencyKey);
      expect(attempt.providerReference).toBe('ref_lost_write');
      expect(attempt.paymentState).toBe('UNKNOWN');
      const cases = await casesFor(attempt.id);
      expect(cases.map((c) => c.reasonCode)).toEqual([
        'PROVIDER_SUCCEEDED_UNRECORDED',
      ]);
      expect(cases[0].events[0].detail).toMatchObject({ outcome: 'succeeded' });
      expect(
        await prisma.order.count({ where: { paymentAttemptId: attempt.id } }),
      ).toBe(0);
      await outcomeOf(() => checkout.checkout(body, undefined, t1));
      expect(provider.calls).toHaveLength(1);
    });

    it('the outcome write fails outright: the reference is still kept and a case opened', async () => {
      const body = checkoutBody();
      // The database refuses only the write that records the success.
      type UpdateMany = (args: {
        where: object;
        data: { paymentState?: string };
      }) => Promise<{ count: number }>;
      const delegate = prisma.paymentAttempt as unknown as {
        updateMany: UpdateMany;
      };
      const real = delegate.updateMany;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- the real Prisma method, typed by UpdateMany above
      const original: UpdateMany = (args) => real.call(delegate, args);
      const spy = jest
        .spyOn(delegate, 'updateMany')
        .mockImplementation((args) =>
          args.data.paymentState === 'SUCCEEDED'
            ? Promise.reject(new Error('simulated database outage'))
            : original(args),
        );
      try {
        provider.behavior = async () => ({
          outcome: 'succeeded',
          providerReference: 'ref_write_failed',
        });
        const r = await outcomeOf(() => checkout.checkout(body, undefined, t1));
        expect(r.status).toBe(409);
        expect(r.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      } finally {
        spy.mockRestore();
      }
      const attempt = await attemptOf(body.idempotencyKey);
      expect(attempt.providerReference).toBe('ref_write_failed');
      // The claim stands: still held, never charged again.
      expect(attempt.paymentState).toBe('CHARGING');
      expect((await casesFor(attempt.id)).map((c) => c.reasonCode)).toEqual([
        'PROVIDER_SUCCEEDED_UNRECORDED',
      ]);
      await outcomeOf(() => checkout.checkout(body, undefined, t1));
      expect(provider.calls).toHaveLength(1);
    });
  });

  // --- Gift-card key reuse (R1) ---------------------------------------

  function intent(extra: Record<string, unknown> = {}) {
    return {
      idempotencyKey: randomUUID(),
      amountMinorUnits: 2500,
      purchaserEmail: 'ph-buyer@example.test',
      purchaserName: 'PH Buyer',
      ...extra,
    };
  }

  const bareAttempt = (
    data: Partial<{
      tenantId: string;
      locationId: string | null;
      amount: number;
      status: 'PENDING' | 'SUCCEEDED';
      paymentState: string | null;
    }> = {},
  ) =>
    prisma.paymentAttempt.create({
      data: {
        tenantId: data.tenantId ?? TENANT_1_MOCHA_HOUSE_ID,
        idempotencyKey: randomUUID(),
        provider: provider.name,
        locationId: data.locationId ?? null,
        amount: data.amount ?? 2500,
        currency: 'USD',
        status: data.status ?? 'PENDING',
        paymentState:
          data.paymentState === undefined ? 'NOT_SENT' : data.paymentState,
      },
    });

  describe('gift-card key reuse', () => {
    const unchanged = async (id: string, before: object) => {
      const after = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id },
        include: { giftCardPurchase: true },
      });
      expect(after).toMatchObject(before);
      expect(after.giftCardPurchase).toBeNull();
    };

    it("never turns a food-order checkout's payment into a gift-card purchase", async () => {
      const key = randomUUID();
      await checkout.checkout(checkoutBody(key), undefined, t1);
      const before = await attemptOf(key);
      const r = await outcomeOf(() =>
        purchases.createIntent(intent({ idempotencyKey: key }), undefined, t1),
      );
      expect(r.status).toBe(409);
      await unchanged(before.id, {
        status: 'SUCCEEDED',
        locationId,
        amount: before.amount,
      });
    });

    it.each([
      ['with a Location', { locationId: 'LOCATION' }],
      ['for a different amount', { amount: 5000 }],
      ['already charging', { paymentState: 'CHARGING' }],
      ['held as unknown', { paymentState: 'UNKNOWN' }],
      ['already charged', { status: 'SUCCEEDED', paymentState: 'SUCCEEDED' }],
    ] as const)(
      'refuses a key whose payment attempt is %s, creating and changing nothing',
      async (_label, shape) => {
        const attempt = await bareAttempt({
          ...(shape as Parameters<typeof bareAttempt>[0]),
          locationId: 'locationId' in shape ? locationId : null,
        });
        const r = await outcomeOf(() =>
          purchases.createIntent(
            intent({ idempotencyKey: attempt.idempotencyKey }),
            undefined,
            t1,
          ),
        );
        expect(r.status).toBe(409);
        expect(r.response).toMatchObject({
          message: 'This idempotency key cannot be used. Start a new purchase.',
        });
        await unchanged(attempt.id, {
          amount: attempt.amount,
          status: attempt.status,
          paymentState: attempt.paymentState,
        });
        expect(provider.calls).toHaveLength(0);
      },
    );

    it('still completes an uncharged gift-card attempt for the same amount (an interrupted first step)', async () => {
      const attempt = await bareAttempt();
      const i = await purchases.createIntent(
        intent({ idempotencyKey: attempt.idempotencyKey }),
        undefined,
        t1,
      );
      expect(i.amountMinorUnits).toBe(2500);
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: attempt.id },
      });
      expect(purchase.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    });

    it("refuses another business's key on both steps with answers that reveal nothing", async () => {
      const bAttempt = await bareAttempt({ tenantId: TEST_TENANT_B_ID });
      const created = await outcomeOf(() =>
        purchases.createIntent(
          intent({ idempotencyKey: bAttempt.idempotencyKey }),
          undefined,
          t1,
        ),
      );
      expect(created.status).toBe(409);
      // Business B's own started purchase, with its own recovery credential.
      const bPaid = await bareAttempt({ tenantId: TEST_TENANT_B_ID });
      await prisma.giftCardPurchase.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          paymentAttemptId: bPaid.id,
          amountMinorUnits: 2500,
          currency: 'USD',
          purchaserEmail: 'b-buyer@example.test',
          recoveryCredentialHash: hashRecoveryCredential('b-credential'),
        },
      });
      const unknownKey = await outcomeOf(() =>
        purchases.purchase({ idempotencyKey: randomUUID() }, undefined, t1),
      );
      const foreign = await outcomeOf(() =>
        purchases.purchase(
          {
            idempotencyKey: bPaid.idempotencyKey,
            recoveryCredential: 'b-credential',
          },
          undefined,
          t1,
        ),
      );
      expect(foreign).toEqual(unknownKey);
      expect(unknownKey.response).toMatchObject({
        code: GIFT_CARD_PURCHASE_NOT_FOUND,
      });
      await unchanged(bAttempt.id, { tenantId: TEST_TENANT_B_ID });
      expect(provider.calls).toHaveLength(0);
    });
  });

  // --- Authorisation before payment state (R3) -------------------------

  describe('unauthorised callers learn nothing about a payment', () => {
    const unknownKeyAnswer = () =>
      outcomeOf(() =>
        purchases.purchase({ idempotencyKey: randomUUID() }, undefined, t1),
      );

    async function started() {
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      const asBuyer = () =>
        outcomeOf(() =>
          purchases.purchase(
            {
              idempotencyKey: req.idempotencyKey,
              recoveryCredential: i.recoveryCredential ?? undefined,
            },
            undefined,
            t1,
          ),
        );
      const asStranger = async () => [
        await outcomeOf(() =>
          purchases.purchase(
            { idempotencyKey: req.idempotencyKey },
            undefined,
            t1,
          ),
        ),
        await outcomeOf(() =>
          purchases.purchase(
            { idempotencyKey: req.idempotencyKey, recoveryCredential: 'wrong' },
            undefined,
            t1,
          ),
        ),
      ];
      return { req, asBuyer, asStranger };
    }

    it('pending, declined, failed, held and reconciliation all answer a stranger exactly like an unknown key', async () => {
      const expected = await unknownKeyAnswer();
      expect(expected.status).toBe(409);

      const pending = await started();
      for (const r of await pending.asStranger()) expect(r).toEqual(expected);

      for (const outcome of ['declined', 'failed'] as const) {
        provider.behavior = async () => ({ outcome, reason: MARKER });
        const s = await started();
        expect((await s.asBuyer()).status).toBe(402);
        for (const r of await s.asStranger()) expect(r).toEqual(expected);
      }

      provider.behavior = async () => {
        throw new Error(MARKER);
      };
      const held = await started();
      expect((await held.asBuyer()).status).toBe(409);
      for (const r of await held.asStranger()) expect(r).toEqual(expected);

      provider.reset();
      const reconciling = await started();
      const attempt = await bareAttemptFor(reconciling.req.idempotencyKey);
      await prisma.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          reconciliationRequired: true,
        },
      });
      await prisma.giftCardPurchase.update({
        where: { paymentAttemptId: attempt.id },
        data: { status: 'RECONCILIATION_REQUIRED' },
      });
      for (const r of await reconciling.asStranger())
        expect(r).toEqual(expected);
      // The buyer still gets the real explanation.
      expect(JSON.stringify((await reconciling.asBuyer()).response)).toContain(
        'Do not pay again',
      );
    });

    it('an issued purchase answers a stranger exactly like an unknown key; the buyer still gets the code', async () => {
      const expected = await unknownKeyAnswer();
      const s = await started();
      const done = await s.asBuyer();
      expect(done.ok).toBe(true);
      for (const r of await s.asStranger()) expect(r).toEqual(expected);
      const again = await s.asBuyer();
      expect(again.ok).toBe(true);
      expect(provider.calls).toHaveLength(1);
    });

    it('step 1 replays only while the purchase still waits for its first payment', async () => {
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      // A client retrying step 1 before paying gets the same intent back.
      const replay = await purchases.createIntent(req, undefined, t1);
      expect(replay.purchaseId).toBe(i.purchaseId);
      expect(replay.status).toBe('PENDING');
      // Once paid, step 1 reveals nothing about the payment.
      await purchases.purchase(
        {
          idempotencyKey: req.idempotencyKey,
          recoveryCredential: i.recoveryCredential ?? undefined,
        },
        undefined,
        t1,
      );
      const after = await outcomeOf(() =>
        purchases.createIntent(req, undefined, t1),
      );
      expect(after.status).toBe(409);
      expect(JSON.stringify(after.response)).not.toContain('ISSUED');
      expect(JSON.stringify(after.response)).not.toContain(i.purchaseId);
    });

    it('a stranded charge claim (payment never sent) opens a case on retry and is never charged', async () => {
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      const attempt = await bareAttemptFor(req.idempotencyKey);
      // The process stopped between the purchase claim and the payment claim.
      await prisma.giftCardPurchase.update({
        where: { paymentAttemptId: attempt.id },
        data: { chargeClaimedAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
      const run = () =>
        outcomeOf(() =>
          purchases.purchase(
            {
              idempotencyKey: req.idempotencyKey,
              recoveryCredential: i.recoveryCredential ?? undefined,
            },
            undefined,
            t1,
          ),
        );
      expect((await run()).status).toBe(409);
      expect((await run()).status).toBe(409);
      expect(provider.calls).toHaveLength(0);
      const cases = await casesFor(attempt.id);
      expect(cases.map((c) => [c.reasonCode, c.events.length])).toEqual([
        ['CHARGE_CLAIM_STRANDED', 1],
      ]);
    });

    it('a fresh claim in flight is not treated as stranded', async () => {
      const req = intent();
      const i = await purchases.createIntent(req, undefined, t1);
      const attempt = await bareAttemptFor(req.idempotencyKey);
      await prisma.giftCardPurchase.update({
        where: { paymentAttemptId: attempt.id },
        data: { chargeClaimedAt: new Date() },
      });
      const r = await outcomeOf(() =>
        purchases.purchase(
          {
            idempotencyKey: req.idempotencyKey,
            recoveryCredential: i.recoveryCredential ?? undefined,
          },
          undefined,
          t1,
        ),
      );
      expect(r.status).toBe(409);
      expect(await casesFor(attempt.id)).toEqual([]);
    });

    it('the buyer still completes the purchase after a stranger probed it', async () => {
      const s = await started();
      await s.asStranger();
      expect(provider.calls).toHaveLength(0);
      const done = await s.asBuyer();
      expect(done.ok).toBe(true);
      expect(provider.calls).toHaveLength(1);
    });

    const bareAttemptFor = (key: string) =>
      prisma.paymentAttempt.findUniqueOrThrow({
        where: { idempotencyKey: key },
      });
  });
});
