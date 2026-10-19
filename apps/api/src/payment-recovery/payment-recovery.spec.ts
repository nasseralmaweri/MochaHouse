/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { TEST_TENANT_B_ID, tenantContextFor } from '@mocha-house/testing';
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
import { PaymentModule } from '../payment/payment.module';
import { PAYMENT_PROVIDER } from '../payment/payment-provider.token';
import { HELD_PAYMENT_MESSAGE } from '../payment/payment-charge';
import { CheckoutService } from '../orders/application/checkout.service';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GIFT_CARD_CONFIGURATION_KEY } from '../gift-cards/application/gift-card-configuration.service';
import {
  MAX_AUTOMATIC_ATTEMPTS,
  PaymentRecoveryService,
  RECOVERY_GRACE_MS,
  RECOVERY_STALE_MS,
  backoffAfter,
  nextAutomaticAttemptAt,
  recoveryHistoryOf,
  type RecoveryOutcome,
} from './application/payment-recovery.service';
import { PlatformPaymentCasesService } from './application/platform-payment-cases.service';
import {
  attemptsOfCheckout,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';
import {
  createGiftIntent,
  purchaseGiftCard,
} from '../../test/checkout-session';

// ESP-03 PR 5 — payment reconciliation and automatic recovery, on real
// services and a real disposable database. The provider is a controlled
// double; database failures are real (a temporary trigger makes one write
// fail exactly where production could fail). Covers: a confirmed payment
// with no order is recovered from its saved checkout (and a gift card from
// its purchase) — by the sweeper and on request — exactly once, never
// charging again; a crash mid-recovery; concurrent recoveries and customer
// retries; uncertain payments are never touched; same-key retries never
// start a second charge (PAY-4); tenant isolation; one case per payment;
// failure, backoff and the attempt cap; the audit history; a pricing change
// kept for review; and no case resolved without the durable record.

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

describe('ESP-03 PR 5 payment reconciliation and automatic recovery (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let purchases: GiftCardPurchaseService;
  let recovery: PaymentRecoveryService;
  let cases: PlatformPaymentCasesService;
  let locationId: string;
  let menuId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };

  const sql = async (text: string) => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL!.split('?')[0],
    });
    await client.connect();
    try {
      await client.query(text);
    } finally {
      await client.end();
    }
  };
  type Failure = {
    table: string;
    event?: 'INSERT' | 'UPDATE';
    when?: string;
  };
  async function withFailures<T>(
    failures: Failure[],
    fn: () => Promise<T>,
  ): Promise<T> {
    await sql(`
      CREATE OR REPLACE FUNCTION esp03_pr5_simulated_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$;`);
    for (const f of failures) {
      await sql(`CREATE TRIGGER esp03_pr5_fail BEFORE ${f.event ?? 'INSERT'}
        ON "${f.table}" FOR EACH ROW ${f.when ? `WHEN (${f.when})` : ''}
        EXECUTE FUNCTION esp03_pr5_simulated_failure();`);
    }
    try {
      return await fn();
    } finally {
      for (const f of failures) {
        await sql(`DROP TRIGGER IF EXISTS esp03_pr5_fail ON "${f.table}";`);
      }
    }
  }
  const withFailingWrites = <T>(table: string, fn: () => Promise<T>) =>
    withFailures([{ table }], fn);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.PAYMENT_AUTO_RECOVERY_ENABLED;
    process.env.GIFT_CARD_CODE_SECRET = 'payment-recovery-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'payment-recovery-spec-recovery-secret';
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
      providers: [
        CheckoutService,
        PaymentRecoveryService,
        PlatformPaymentCasesService,
      ],
    })
      .overrideProvider(PAYMENT_PROVIDER)
      .useValue(provider)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    checkout = moduleRef.get(CheckoutService);
    purchases = moduleRef.get(GiftCardPurchaseService, { strict: false });
    recovery = moduleRef.get(PaymentRecoveryService);
    cases = moduleRef.get(PlatformPaymentCasesService);

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
    menuId = (
      await prisma.locationMenu.findFirstOrThrow({
        where: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          isActive: true,
        },
      })
    ).menuId;
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
    await sql(`DROP TRIGGER IF EXISTS esp03_pr5_fail ON "Order";
      DROP TRIGGER IF EXISTS esp03_pr5_fail ON "GiftCard";
      DROP TRIGGER IF EXISTS esp03_pr5_fail ON "PaymentAttempt";
      DROP TRIGGER IF EXISTS esp03_pr5_fail ON "PaymentReconciliationCase";
      DROP FUNCTION IF EXISTS esp03_pr5_simulated_failure();`);
    await prisma.locationProductPriceOverride.deleteMany({
      where: { locationId, menuId, productId },
    });
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
  ): LabelledCheckoutRequest => ({
    clientRef: `pr5_${randomUUID()}`,
    locationId,
    guest: { name: 'Recovery Guest', phone: '5551238888' },
    lines: [
      {
        productId,
        quantity: 2,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
    ...overrides,
  });
  const attemptOf = (key: string) =>
    prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(key),
    });
  const ordersFor = (paymentAttemptId: string) =>
    prisma.order.findMany({ where: { paymentAttemptId } });
  const caseOf = (paymentAttemptId: string) =>
    prisma.paymentReconciliationCase.findUnique({
      where: {
        tenantId_paymentAttemptId: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          paymentAttemptId,
        },
      },
      include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  const actionsOf = async (paymentAttemptId: string) =>
    (await caseOf(paymentAttemptId))?.events.map((e) => e.action) ?? [];
  const later = (ms: number) => new Date(Date.now() + ms);

  // Sweeps (as the automatic recovery would, with the clock moved on) until
  // `done` holds. Payments left behind by earlier suites in this disposable
  // database are swept too; each is either recovered or set aside, so this
  // always settles.
  async function sweepUntil(
    done: () => Promise<boolean>,
    now = later(RECOVERY_GRACE_MS + 60_000),
  ): Promise<RecoveryOutcome[]> {
    const all: RecoveryOutcome[] = [];
    for (let i = 0; i < 30; i++) {
      const { outcomes } = await recovery.sweep(now);
      all.push(...outcomes);
      if (await done()) return all;
      if (outcomes.length === 0) break;
    }
    throw new Error('the sweep did not settle');
  }

  // A charged payment whose order could not be created (a real write
  // failure inside the order transaction): flagged, with an open case.
  async function chargedWithoutOrder(request = body()) {
    const first = await withFailingWrites('Order', () =>
      outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
    );
    expect(first.ok).toBe(false);
    const attempt = await attemptOf(request.clientRef);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
      fulfilmentStatus: 'NEEDS_REVIEW',
    });
    expect(await ordersFor(attempt.id)).toHaveLength(0);
    expect((await caseOf(attempt.id))?.reasonCode).toBe('FULFILMENT_FAILED');
    return { request, attempt };
  }

  // A held payment (the provider's answer is unknown).
  async function heldPayment(request = body()) {
    provider.behavior = async () => ({ outcome: 'unknown', reason: 'x' });
    const first = await outcomeOf(() =>
      submitCheckout(checkout, request, undefined, t1),
    );
    expect(first.status).toBe(409);
    provider.reset();
    const attempt = await attemptOf(request.clientRef);
    expect(attempt.paymentState).toBe('UNKNOWN');
    return { request, attempt };
  }

  describe('the automatic recovery switch', () => {
    it('is OFF by default: nothing is scheduled unless PAYMENT_AUTO_RECOVERY_ENABLED=1', () => {
      const off = new PaymentRecoveryService(prisma, checkout, purchases);
      delete process.env.PAYMENT_AUTO_RECOVERY_ENABLED;
      off.onModuleInit();
      expect((off as unknown as { timer: unknown }).timer).toBeNull();
      process.env.PAYMENT_AUTO_RECOVERY_ENABLED = 'true';
      off.onModuleInit();
      expect((off as unknown as { timer: unknown }).timer).toBeNull();

      process.env.PAYMENT_AUTO_RECOVERY_ENABLED = '1';
      const on = new PaymentRecoveryService(prisma, checkout, purchases);
      try {
        on.onModuleInit();
        expect((on as unknown as { timer: unknown }).timer).not.toBeNull();
      } finally {
        on.onModuleDestroy();
        delete process.env.PAYMENT_AUTO_RECOVERY_ENABLED;
      }
      expect((on as unknown as { timer: unknown }).timer).toBeNull();
    });
  });

  describe('a successful payment with a missing order', () => {
    it('is recovered automatically from its saved checkout, exactly once, never charging again, with a complete history', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      // Not before the grace period: the first request may still finish.
      expect(
        (await recovery.dueCandidates(new Date())).map((c) => c.id),
      ).not.toContain(attempt.id);

      await sweepUntil(async () => (await ordersFor(attempt.id)).length > 0);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
      expect(await attemptOf(request.clientRef)).toMatchObject({
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
        fulfilmentStatus: 'DONE',
        reconciliationRequired: false,
      });
      expect(
        await prisma.checkoutSnapshot.count({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toBe(0);

      const resolved = await caseOf(attempt.id);
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        resolution: 'FULFILLED',
      });
      expect(resolved!.events.map((e) => [e.actorKind, e.action])).toEqual([
        ['SYSTEM', 'OPENED'],
        ['SYSTEM', 'RECOVERY_STARTED'],
        ['SYSTEM', 'RESOLVED'],
        ['SYSTEM', 'RECOVERY_SUCCEEDED'],
      ]);
      const [, started, resolvedEvent, succeeded] = resolved!.events;
      expect(started.detail).toEqual({
        source: 'recovery',
        trigger: 'automatic',
        paymentAttemptId: attempt.id,
      });
      // Before / after state and the record that proves it.
      expect(resolvedEvent.detail).toEqual({
        source: 'fulfilment',
        resolution: 'FULFILLED',
        from: 'OPEN',
        to: 'RESOLVED',
        paymentAttemptId: attempt.id,
        orderId: orders[0].id,
      });
      expect(succeeded.detail).toMatchObject({ orderId: orders[0].id });
      // Nothing personal in the history.
      expect(JSON.stringify(resolved!.events)).not.toContain('5551238888');
      expect(JSON.stringify(resolved!.events)).not.toContain('Recovery Guest');

      // A late customer retry sees the same order and is not charged.
      const replay = await submitCheckout(checkout, request, undefined, t1);
      expect(replay.orderId).toBe(orders[0].id);
      expect(provider.calls).toHaveLength(1);
      // A further recovery finds it fulfilled and writes nothing new.
      const again = await recovery.recoverOne(
        attempt.id,
        TENANT_1_MOCHA_HOUSE_ID,
        { trigger: 'automatic' },
      );
      expect(again).toEqual({ kind: 'already_fulfilled' });
      expect(await actionsOf(attempt.id)).toHaveLength(4);
    });

    it('after a crash that left no case at all, the sweep opens one and recovers the order', async () => {
      const request = body();
      const first = await withFailures(
        [
          { table: 'Order' },
          {
            table: 'PaymentAttempt',
            event: 'UPDATE',
            when: 'NEW."reconciliationRequired"',
          },
          { table: 'PaymentReconciliationCase' },
        ],
        () => outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
      );
      expect(first.ok).toBe(false);
      const attempt = await attemptOf(request.clientRef);
      expect(await caseOf(attempt.id)).toBeNull();

      await sweepUntil(async () => (await ordersFor(attempt.id)).length > 0);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      const opened = await caseOf(attempt.id);
      expect(opened).toMatchObject({
        reasonCode: 'FULFILMENT_INCOMPLETE',
        status: 'RESOLVED',
        resolution: 'FULFILLED',
      });
      expect(opened!.events.map((e) => e.action)).toEqual([
        'OPENED',
        'RECOVERY_STARTED',
        'RESOLVED',
        'RECOVERY_SUCCEEDED',
      ]);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('a worker restart during recovery', () => {
    it('a recovery interrupted after it started is seen as in progress, then picked up again once stale', async () => {
      const { attempt } = await chargedWithoutOrder();
      const open = await caseOf(attempt.id);
      // The state a process that stopped mid-recovery leaves behind.
      await prisma.paymentReconciliationEvent.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          caseId: open!.id,
          actorKind: 'SYSTEM',
          action: 'RECOVERY_STARTED',
          detail: { source: 'recovery', trigger: 'automatic' },
        },
      });
      const shortly = later(RECOVERY_GRACE_MS + 1_000);
      expect((await cases.detail(open!.id)).case.category).toBe(
        'RECOVERY_IN_PROGRESS',
      );
      expect(
        (await recovery.dueCandidates(shortly)).map((c) => c.id),
      ).not.toContain(attempt.id);

      await sweepUntil(
        async () => (await ordersFor(attempt.id)).length > 0,
        later(RECOVERY_STALE_MS + RECOVERY_GRACE_MS + 60_000),
      );
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
      expect((await cases.detail(open!.id)).case.category).toBe('RECOVERED');
    });
  });

  describe('concurrency', () => {
    it('concurrent recoveries, sweeps and customer retries create exactly one order and charge once', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      const results = await Promise.all([
        ...Array.from({ length: 4 }, () =>
          recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
            trigger: 'platform_support',
          }),
        ),
        outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
        outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
      ]);
      const recoveries = results.slice(0, 4) as RecoveryOutcome[];
      for (const r of recoveries) {
        expect(['recovered', 'already_fulfilled', 'busy']).toContain(r.kind);
      }
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
      // Every customer retry that answered got that one order.
      for (const retry of results.slice(4) as {
        ok: boolean;
        value?: { orderId: string };
      }[]) {
        if (retry.ok) expect(retry.value!.orderId).toBe(orders[0].id);
      }
      // Busy callers wrote nothing: starts and outcomes pair up.
      const actions = await actionsOf(attempt.id);
      expect(actions.filter((a) => a === 'RECOVERY_STARTED').length).toBe(
        actions.filter(
          (a) => a === 'RECOVERY_SUCCEEDED' || a === 'RECOVERY_FAILED',
        ).length,
      );
      expect(actions.filter((a) => a === 'RESOLVED')).toHaveLength(1);
    });

    // Another API process holding a lock is simulated by a separate
    // database connection holding the same advisory lock.
    async function holdingLock<T>(
      key: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const client = new Client({
        connectionString: process.env.DATABASE_URL!.split('?')[0],
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [key],
        );
        return await fn();
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }

    it('one sweeper at a time: a sweep in this process or another makes a second one a no-op', async () => {
      const [a, b] = await Promise.all([
        recovery.sweep(later(RECOVERY_GRACE_MS + 60_000)),
        recovery.sweep(later(RECOVERY_GRACE_MS + 60_000)),
      ]);
      expect([a.swept, b.swept].filter(Boolean)).toHaveLength(1);
      const other = new PaymentRecoveryService(prisma, checkout, purchases);
      const blocked = await holdingLock(
        'esp03-payment-auto-recovery-sweep',
        () => other.sweep(later(RECOVERY_GRACE_MS + 60_000)),
      );
      expect(blocked).toEqual({ swept: false, outcomes: [] });
    });

    it('a payment being recovered elsewhere is left alone: busy, nothing written', async () => {
      const { attempt } = await chargedWithoutOrder();
      const before = await actionsOf(attempt.id);
      const busy = await holdingLock(
        `esp03-payment-recovery:${TENANT_1_MOCHA_HOUSE_ID}:${attempt.id}`,
        () =>
          recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
            trigger: 'automatic',
          }),
      );
      expect(busy).toEqual({ kind: 'busy' });
      expect(await actionsOf(attempt.id)).toEqual(before);
      expect(await ordersFor(attempt.id)).toHaveLength(0);
    });
  });

  describe('same-key retries never start another charge (PAY-4)', () => {
    it('while the payment is unknown: the retry is told to wait; recovery refuses; nothing is charged again', async () => {
      const { request, attempt } = await heldPayment();
      const retry = await outcomeOf(() =>
        submitCheckout(checkout, request, undefined, t1),
      );
      expect(retry.status).toBe(409);
      expect(retry.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      const before = await actionsOf(attempt.id);
      expect(
        await recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'platform_support',
        }),
      ).toEqual({ kind: 'not_confirmed' });
      await recovery.sweep(later(RECOVERY_GRACE_MS + 60_000));
      expect(await actionsOf(attempt.id)).toEqual(before);
      expect(await ordersFor(attempt.id)).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
      const open = await caseOf(attempt.id);
      expect(open?.status).toBe('OPEN');
      expect((await cases.detail(open!.id)).case).toMatchObject({
        category: 'AWAITING_PAYMENT_OUTCOME',
        recovery: { recoverable: false },
      });
    });

    it('after a confirmed success: the retry returns the same order and is not charged', async () => {
      const request = body();
      const first = await submitCheckout(checkout, request, undefined, t1);
      const retries = await Promise.all(
        Array.from({ length: 3 }, () =>
          submitCheckout(checkout, request, undefined, t1),
        ),
      );
      expect(new Set(retries.map((r) => r.orderId))).toEqual(
        new Set([first.orderId]),
      );
      expect(provider.calls).toHaveLength(1);
    });

    it('while the first request is still pending: the retry is refused and nothing is charged', async () => {
      const request = body();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      provider.behavior = async (req) => {
        await gate;
        return {
          outcome: 'succeeded',
          providerReference: `ctl_${req.idempotencyKey}`,
        };
      };
      const first = submitCheckout(checkout, request, undefined, t1);
      // Wait until the attempt is charging.
      for (let i = 0; i < 50; i++) {
        const row = await prisma.paymentAttempt.findFirst({
          orderBy: { createdAt: 'desc' },
          where: attemptsOfCheckout(request.clientRef),
        });
        if (row?.paymentState === 'CHARGING') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const retry = await outcomeOf(() =>
        submitCheckout(checkout, request, undefined, t1),
      );
      expect(retry.status).toBe(409);
      release();
      const confirmed = await first;
      expect(provider.calls).toHaveLength(1);
      expect(await ordersFor((await attemptOf(request.clientRef)).id)).toEqual([
        expect.objectContaining({ id: confirmed.orderId }),
      ]);
    });

    it('while the payment is under recovery: the retry meets the same single order', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      const [recovered, retry] = await Promise.all([
        recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'automatic',
        }),
        outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
      ]);
      expect(['recovered', 'already_fulfilled']).toContain(recovered.kind);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      if (retry.ok) {
        expect((retry.value as { orderId: string }).orderId).toBe(orders[0].id);
      }
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('gift-card issuance recovery', () => {
    it('a charged purchase whose card was not issued gets exactly one card, without the code ever leaving recovery', async () => {
      const idempotencyKey = randomUUID();
      const intent = await createGiftIntent(
        purchases,
        {
          clientRef: idempotencyKey,
          amountMinorUnits: 2500,
          purchaserEmail: 'pr5-buyer@example.test',
          purchaserName: 'PR5 Buyer',
        },
        undefined,
        t1,
      );
      const buy = () =>
        purchaseGiftCard(
          purchases,
          {
            clientRef: idempotencyKey,
            recoveryCredential: intent.recoveryCredential ?? undefined,
          },
          undefined,
          t1,
        );
      const failed = await withFailingWrites('GiftCard', () => outcomeOf(buy));
      expect(failed.status).toBe(409);
      const attempt = await attemptOf(idempotencyKey);
      expect(attempt).toMatchObject({
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
      });

      const outcomes = await Promise.all([
        recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'automatic',
        }),
        recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'platform_support',
        }),
      ]);
      const recovered = outcomes.find((o) => o.kind === 'recovered');
      expect(recovered).toBeDefined();
      // Only references: the code never comes back from a recovery.
      expect(JSON.stringify(outcomes)).not.toMatch(/code/i);
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: attempt.id },
      });
      expect(recovered).toEqual({
        kind: 'recovered',
        giftCardPurchaseId: purchase.id,
      });
      expect(purchase.status).toBe('ISSUED');
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardPurchaseId: purchase.id, type: 'ISSUANCE' },
        }),
      ).toBe(1);
      const resolved = await caseOf(attempt.id);
      expect(resolved?.status).toBe('RESOLVED');
      expect(
        resolved!.events.find((e) => e.action === 'RESOLVED')!.detail,
      ).toMatchObject({ giftCardPurchaseId: purchase.id, from: 'OPEN' });
      expect(JSON.stringify(resolved!.events)).not.toContain(
        'pr5-buyer@example.test',
      );
      // The buyer still retrieves the card through their own authorised
      // replay, and nothing is charged again.
      const replay = await buy();
      expect(replay.code).toEqual(expect.any(String));
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('tenant isolation', () => {
    it('another business can neither recover nor even see a payment', async () => {
      const { attempt } = await chargedWithoutOrder();
      const before = await actionsOf(attempt.id);
      expect(
        await recovery.recoverOne(attempt.id, TEST_TENANT_B_ID, {
          trigger: 'platform_support',
        }),
      ).toEqual({ kind: 'not_found' });
      expect(await actionsOf(attempt.id)).toEqual(before);
      expect(await ordersFor(attempt.id)).toHaveLength(0);
      const foreignCase = await prisma.paymentReconciliationCase.findFirst({
        where: { paymentAttemptId: attempt.id, tenantId: TEST_TENANT_B_ID },
      });
      expect(foreignCase).toBeNull();
    });
  });

  describe('one case per payment', () => {
    it('repeated failures and recoveries never open a second case', async () => {
      const { attempt } = await chargedWithoutOrder();
      for (let i = 0; i < 2; i++) {
        await withFailingWrites('Order', () =>
          recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
            trigger: 'automatic',
          }),
        );
      }
      expect(
        await prisma.paymentReconciliationCase.count({
          where: { paymentAttemptId: attempt.id },
        }),
      ).toBe(1);
      // The database refuses a second case for the same payment.
      const open = await caseOf(attempt.id);
      await expect(
        prisma.paymentReconciliationCase.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            paymentAttemptId: attempt.id,
            reasonCode: 'FULFILMENT_FAILED',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect(open?.status).toBe('OPEN');
    });
  });

  describe('failure and retry backoff', () => {
    it('a temporary failure is retried with growing waits, then left for people after the attempt cap', async () => {
      const { attempt } = await chargedWithoutOrder();
      const failures: RecoveryOutcome[] = [];
      for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS; i++) {
        failures.push(
          await withFailingWrites('Order', () =>
            recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
              trigger: 'automatic',
            }),
          ),
        );
        const events = (await caseOf(attempt.id))!.events;
        const history = recoveryHistoryOf(events);
        expect(history.automaticAttempts).toBe(i + 1);
        const { updatedAt } = await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
        });
        const next = nextAutomaticAttemptAt(history, updatedAt, true);
        if (i + 1 < MAX_AUTOMATIC_ATTEMPTS) {
          // Not due just after the failure; due once the wait has passed.
          expect(next!.getTime()).toBe(
            history.lastFailureAt!.getTime() + backoffAfter(i + 1),
          );
          const ids = async (now: Date) =>
            (await recovery.dueCandidates(now)).map((c) => c.id);
          expect(await ids(new Date(next!.getTime() - 1_000))).not.toContain(
            attempt.id,
          );
        } else {
          expect(next).toBeNull();
        }
      }
      expect(failures.every((f) => f.kind === 'failed')).toBe(true);
      expect(failures[0]).toEqual({
        kind: 'failed',
        failure: 'TRANSIENT_ERROR',
        retryable: true,
      });
      // Exhausted: never due again automatically, the case stays open and
      // needs attention; a support-triggered recovery still works.
      expect(
        (await recovery.dueCandidates(later(48 * 3600_000))).map((c) => c.id),
      ).not.toContain(attempt.id);
      const open = await caseOf(attempt.id);
      expect(open?.status).toBe('OPEN');
      expect((await cases.detail(open!.id)).case).toMatchObject({
        category: 'NEEDS_ATTENTION',
        recovery: {
          recoverable: true,
          automaticAttempts: MAX_AUTOMATIC_ATTEMPTS,
          lastFailure: 'TRANSIENT_ERROR',
          nextAutomaticAttemptAt: null,
        },
      });
      expect(
        await recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'platform_support',
        }),
      ).toMatchObject({ kind: 'recovered' });
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    });

    it('interrupted attempts (started, never finished) count toward the cap and are backed off, never retried in a loop', async () => {
      const { attempt } = await chargedWithoutOrder();
      const open = await caseOf(attempt.id);
      const started = (minutesAgo: number) =>
        prisma.paymentReconciliationEvent.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            caseId: open!.id,
            actorKind: 'SYSTEM',
            action: 'RECOVERY_STARTED',
            detail: { source: 'recovery', trigger: 'automatic' },
            createdAt: new Date(Date.now() - minutesAgo * 60_000),
          },
        });
      // One interrupted attempt 6 minutes ago: stale, so not in progress, but
      // it counts — the next try waits out the first backoff from its start.
      await started(6);
      const history = recoveryHistoryOf((await caseOf(attempt.id))!.events);
      expect(history).toMatchObject({
        automaticAttempts: 1,
        inProgressSince: null,
      });
      expect(
        nextAutomaticAttemptAt(history, new Date(0), true)!.getTime(),
      ).toBe(history.lastAttemptAt!.getTime() + backoffAfter(1));
      const ids = async (now: Date) =>
        (await recovery.dueCandidates(now)).map((c) => c.id);
      // Used up by interruptions alone: set aside in SQL, never due again.
      for (let i = 0; i < MAX_AUTOMATIC_ATTEMPTS - 1; i++) {
        await started(10 + i);
      }
      expect(await ids(later(48 * 3600_000))).not.toContain(attempt.id);
      expect((await cases.detail(open!.id)).case.recovery).toMatchObject({
        automaticAttempts: MAX_AUTOMATIC_ATTEMPTS,
        nextAutomaticAttemptAt: null,
      });
    });

    it('backs off exponentially, capped', () => {
      expect(backoffAfter(0)).toBe(0);
      expect(backoffAfter(1)).toBe(5 * 60_000);
      expect(backoffAfter(2)).toBe(10 * 60_000);
      expect(backoffAfter(3)).toBe(20 * 60_000);
      expect(backoffAfter(20)).toBe(6 * 3600_000);
    });
  });

  // ESP-03 PR 7 — a price change no longer blocks a frozen checkout; a
  // location that stopped taking online orders still does (D5).
  describe('an operational restriction', () => {
    it('fails the recovery for review (no automatic retry), keeps the case open, and never changes the order', async () => {
      const { attempt } = await chargedWithoutOrder();
      await prisma.location.update({
        where: { id: locationId },
        data: { isDigitalOrderingEnabled: false },
      });
      try {
        const failed = await recovery.recoverOne(
          attempt.id,
          TENANT_1_MOCHA_HOUSE_ID,
          { trigger: 'automatic' },
        );
        expect(failed).toEqual({
          kind: 'failed',
          failure: 'FULFILMENT_REJECTED',
          retryable: false,
        });
        expect(await ordersFor(attempt.id)).toHaveLength(0);
        const open = await caseOf(attempt.id);
        expect(open?.status).toBe('OPEN');
        // Never retried automatically.
        expect(
          (await recovery.dueCandidates(later(48 * 3600_000))).map((c) => c.id),
        ).not.toContain(attempt.id);
        expect((await cases.detail(open!.id)).case).toMatchObject({
          category: 'NEEDS_ATTENTION',
          recovery: {
            lastFailure: 'FULFILMENT_REJECTED',
            nextAutomaticAttemptAt: null,
          },
        });
      } finally {
        await prisma.location.update({
          where: { id: locationId },
          data: { isDigitalOrderingEnabled: true },
        });
      }
      // Once the location takes orders again, a support recovery completes.
      expect(
        await recovery.recoverOne(attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'platform_support',
        }),
      ).toMatchObject({ kind: 'recovered' });
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('no false case resolution', () => {
    it('a failed recovery, an uncertain payment and a payment with nothing saved all stay open', async () => {
      const failed = await chargedWithoutOrder();
      await withFailingWrites('Order', () =>
        recovery.recoverOne(failed.attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'automatic',
        }),
      );
      expect((await caseOf(failed.attempt.id))?.status).toBe('OPEN');

      const held = await heldPayment();
      await recovery.sweep(later(RECOVERY_GRACE_MS + 60_000));
      expect((await caseOf(held.attempt.id))?.status).toBe('OPEN');

      // Confirmed, but nothing durable to recover from.
      const bare = await chargedWithoutOrder();
      await prisma.checkoutSnapshot.deleteMany({
        where: { paymentAttemptId: bare.attempt.id },
      });
      const before = await actionsOf(bare.attempt.id);
      expect(
        await recovery.recoverOne(bare.attempt.id, TENANT_1_MOCHA_HOUSE_ID, {
          trigger: 'platform_support',
        }),
      ).toEqual({ kind: 'nothing_to_recover' });
      expect(await actionsOf(bare.attempt.id)).toEqual(before);
      const bareCase = await caseOf(bare.attempt.id);
      expect(bareCase?.status).toBe('OPEN');
      expect((await cases.detail(bareCase!.id)).case).toMatchObject({
        category: 'NEEDS_ATTENTION',
        recovery: { recoverable: false },
      });
      expect(await ordersFor(bare.attempt.id)).toHaveLength(0);
    });

    it('the history is append-only', async () => {
      const { attempt } = await chargedWithoutOrder();
      const open = await caseOf(attempt.id);
      await expect(
        sql(
          `UPDATE "PaymentReconciliationEvent" SET action = 'EDITED' WHERE "caseId" = '${open!.id}'`,
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        sql(
          `DELETE FROM "PaymentReconciliationEvent" WHERE "caseId" = '${open!.id}'`,
        ),
      ).rejects.toThrow(/append-only/);
    });
  });
});
