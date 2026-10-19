/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
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
import type {
  OrderConfirmation,
  PurchaseGiftCardResponse,
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
import { HELD_PAYMENT_MESSAGE } from './payment-charge';
import { CheckoutService } from '../orders/application/checkout.service';
import { GiftCardPurchaseService } from '../gift-cards/application/gift-card-purchase.service';
import { GiftCardIssuanceService } from '../gift-cards/application/gift-card-issuance.service';
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

// ESP-03 PR 4 — resumable fulfilment (PAY-3). Real services and a real
// disposable database; the provider is a controlled double, and database
// failures are real: a temporary trigger makes one write fail (the saved
// checkout, the order, the gift card) exactly where production could fail.
// Covers: the checkout is saved before any charge (and no charge without
// it); a charged payment whose order failed, crashed or was interrupted is
// fulfilled later from the SAVED checkout — never from a retried cart —
// exactly once, under retries and concurrency, without calling the provider
// again; uncertain payments are never fulfilled; a pricing change keeps the
// payment for review instead of changing the order; tenant isolation; and
// the same for gift-card issuance.

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

describe('ESP-03 PR 4 resumable fulfilment (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let purchases: GiftCardPurchaseService;
  let issuance: GiftCardIssuanceService;
  let locationId: string;
  let menuId: string;
  let productId: string;
  let sizeGroupId: string;
  let smallOptionId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };

  // Real database failures, injected and removed around one step.
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
      CREATE OR REPLACE FUNCTION esp03_pr4_simulated_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$;`);
    for (const f of failures) {
      await sql(`CREATE TRIGGER esp03_pr4_fail BEFORE ${f.event ?? 'INSERT'}
        ON "${f.table}" FOR EACH ROW ${f.when ? `WHEN (${f.when})` : ''}
        EXECUTE FUNCTION esp03_pr4_simulated_failure();`);
    }
    try {
      return await fn();
    } finally {
      for (const f of failures) {
        await sql(`DROP TRIGGER IF EXISTS esp03_pr4_fail ON "${f.table}";`);
      }
    }
  }
  const withFailingWrites = <T>(table: string, fn: () => Promise<T>) =>
    withFailures([{ table }], fn);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'resumable-fulfilment-spec-secret';
    process.env.GIFT_CARD_PURCHASE_CODE_KEK =
      'c4097ecec7942a636761a7c4acc30277edaa900a9ee56f4974c8993a344e963e';
    process.env.GIFT_CARD_PURCHASE_RECOVERY_SECRET =
      'resumable-fulfilment-spec-recovery-secret';
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
    issuance = moduleRef.get(GiftCardIssuanceService, { strict: false });

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
    await sql(`DROP TRIGGER IF EXISTS esp03_pr4_fail ON "Order";
      DROP TRIGGER IF EXISTS esp03_pr4_fail ON "CheckoutSnapshot";
      DROP TRIGGER IF EXISTS esp03_pr4_fail ON "GiftCard";
      DROP TRIGGER IF EXISTS esp03_pr4_fail ON "PaymentAttempt";
      DROP TRIGGER IF EXISTS esp03_pr4_fail ON "PaymentReconciliationCase";
      DROP FUNCTION IF EXISTS esp03_pr4_simulated_failure();`);
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
    optionId = mediumOptionId,
    quantity = 2,
  ): LabelledCheckoutRequest => ({
    clientRef: `rf_${randomUUID()}`,
    locationId,
    guest: { name: 'Resume Guest', phone: '5551239999' },
    lines: [
      {
        productId,
        quantity,
        selections: [{ groupId: sizeGroupId, optionIds: [optionId] }],
      },
    ],
    ...overrides,
  });
  const attemptOf = (key: string) =>
    prisma.paymentAttempt.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
      where: attemptsOfCheckout(key),
    });
  const snapshotOf = (paymentAttemptId: string) =>
    prisma.checkoutSnapshot.findUnique({ where: { paymentAttemptId } });
  const ordersFor = (paymentAttemptId: string) =>
    prisma.order.findMany({
      where: { paymentAttemptId },
      include: { lines: true },
    });
  const caseOf = (paymentAttemptId: string) =>
    prisma.paymentReconciliationCase.findUnique({
      where: {
        tenantId_paymentAttemptId: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          paymentAttemptId,
        },
      },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    });

  // A charged payment whose order could not be created (a real write
  // failure inside the order transaction).
  async function chargedWithoutOrder(request = body()) {
    const first = await withFailingWrites('Order', () =>
      outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
    );
    expect(first.ok).toBe(false);
    const attempt = await attemptOf(request.clientRef);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
      reconciliationRequired: true,
      fulfilmentStatus: 'NEEDS_REVIEW',
    });
    expect(await ordersFor(attempt.id)).toHaveLength(0);
    return { request, attempt };
  }

  describe('saving the checkout before the charge', () => {
    it('commits the attempt and its saved checkout before the provider is called; nothing secret is saved', async () => {
      const request = body({
        guest: { name: '  Spaced Guest ', phone: '5551230001', email: null },
      });
      let seenDuringCharge: unknown = undefined;
      provider.behavior = async (req) => {
        const attempt = await attemptOf(req.idempotencyKey);
        seenDuringCharge = await snapshotOf(attempt.id);
        return { outcome: 'succeeded', providerReference: 'ref_ok' };
      };
      const confirmation = await submitCheckout(
        checkout,
        request,
        undefined,
        t1,
      );
      expect(seenDuringCharge).toMatchObject({
        version: 1,
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        payload: {
          locationId,
          guest: { name: 'Spaced Guest', phone: '5551230001', email: null },
          customerId: null,
          giftCardPlan: null,
        },
      });
      const saved = JSON.stringify(seenDuringCharge);
      expect(saved).not.toContain(request.clientRef);
      // Fulfilled: the order exists and the saved checkout is gone.
      const attempt = await attemptOf(request.clientRef);
      expect(attempt.fulfilmentStatus).toBe('DONE');
      expect(await snapshotOf(attempt.id)).toBeNull();
      expect(confirmation.orderId).toBe((await ordersFor(attempt.id))[0].id);
    });

    it('never charges when the checkout cannot be saved, and leaves no payment behind', async () => {
      const request = body();
      const r = await withFailingWrites('CheckoutSnapshot', () =>
        outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
      );
      expect(r.ok).toBe(false);
      expect(provider.calls).toHaveLength(0);
      expect(
        await prisma.paymentAttempt.findFirst({
          orderBy: { createdAt: 'desc' },
          where: attemptsOfCheckout(request.clientRef),
        }),
      ).toBeNull();
    });

    it('a definitive decline needs no saved checkout', async () => {
      provider.behavior = async () => ({ outcome: 'declined', reason: 'no' });
      const request = body();
      expect(
        (
          await outcomeOf(() =>
            submitCheckout(checkout, request, undefined, t1),
          )
        ).status,
      ).toBe(402);
      const attempt = await attemptOf(request.clientRef);
      expect(attempt.fulfilmentStatus).toBe('NOT_REQUIRED');
      expect(await snapshotOf(attempt.id)).toBeNull();
    });
  });

  describe('a charged payment whose order failed', () => {
    it('is kept for review with its saved checkout; a changed retry is refused (ESP-03 PR 6), the same retry is fulfilled from the SAVED checkout', async () => {
      const { request, attempt } = await chargedWithoutOrder(
        body({}, mediumOptionId, 2),
      );
      expect(await snapshotOf(attempt.id)).not.toBeNull();
      const opened = await caseOf(attempt.id);
      expect(opened).toMatchObject({
        status: 'OPEN',
        reasonCode: 'FULFILMENT_FAILED',
      });

      // A retry that sends a different cart and guest is refused: it never
      // changes the saved order and is never answered with another order.
      const tampered = {
        ...request,
        guest: { name: 'Someone Else', phone: '5550000000' },
        lines: [
          {
            productId,
            quantity: 9,
            selections: [{ groupId: sizeGroupId, optionIds: [smallOptionId] }],
          },
        ],
      };
      const refused = await outcomeOf(() =>
        submitCheckout(checkout, tampered, undefined, t1),
      );
      expect(refused.status).toBe(409);
      expect(refused.response).toMatchObject({
        code: 'CHECKOUT_CHANGED_DURING_PAYMENT',
      });
      expect(await ordersFor(attempt.id)).toHaveLength(0);
      // The same checkout retried: the order comes from the SAVED checkout.
      const resumed = await submitCheckout(checkout, request, undefined, t1);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ guestName: 'Resume Guest' });
      expect(orders[0].lines.map((l) => l.quantity)).toEqual([2]);
      expect(JSON.stringify(orders[0].lines[0].selections)).toContain(
        mediumOptionId,
      );
      expect(resumed.orderId).toBe(orders[0].id);
      expect(provider.calls).toHaveLength(1);

      const after = await attemptOf(request.clientRef);
      expect(after).toMatchObject({
        status: 'SUCCEEDED',
        reconciliationRequired: false,
        fulfilmentStatus: 'DONE',
        providerReference: attempt.providerReference,
      });
      expect(await snapshotOf(attempt.id)).toBeNull();
      const resolved = await caseOf(attempt.id);
      expect(resolved).toMatchObject({
        status: 'RESOLVED',
        resolution: 'FULFILLED',
      });
      expect(resolved!.events.map((e) => [e.actorKind, e.action])).toEqual([
        ['SYSTEM', 'OPENED'],
        ['SYSTEM', 'RESOLVED'],
      ]);
    });

    it('after a crash or database interruption (no flag, no case) a server-side recovery creates the order from the saved checkout', async () => {
      const request = body();
      // The order write fails and so does every attempt to record the
      // failure: the state a crash right after the charge leaves behind.
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
      expect(attempt).toMatchObject({
        status: 'SUCCEEDED',
        paymentState: 'SUCCEEDED',
        reconciliationRequired: false,
        fulfilmentStatus: 'PENDING',
      });
      expect(await caseOf(attempt.id)).toBeNull();
      expect(await snapshotOf(attempt.id)).not.toBeNull();
      const recovered = await checkout.recoverFulfilment(
        attempt.id,
        TENANT_1_MOCHA_HOUSE_ID,
      );
      expect(recovered.orderId).toBe((await ordersFor(attempt.id))[0].id);
      // A late retry by the customer sees the same order.
      const replay = await submitCheckout(checkout, request, undefined, t1);
      expect(replay.orderId).toBe(recovered.orderId);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    });

    it('repeated and concurrent recoveries create exactly one order and spend a gift card once', async () => {
      const card = await issuance.issue({
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        originalValueMinorUnits: 300,
        currency: 'USD',
      });
      const { request, attempt } = await chargedWithoutOrder(
        body({ giftCardCode: card.displayCode }),
      );
      const saved = await snapshotOf(attempt.id);
      expect(JSON.stringify(saved)).not.toContain(card.canonicalCode);
      expect(JSON.stringify(saved)).not.toContain(card.displayCode);

      const results = await Promise.all([
        ...Array.from({ length: 4 }, () =>
          outcomeOf(() =>
            checkout.recoverFulfilment(attempt.id, TENANT_1_MOCHA_HOUSE_ID),
          ),
        ),
        ...Array.from({ length: 4 }, () =>
          outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
        ),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      expect(new Set(results.map((r) => r.value!.orderId))).toEqual(
        new Set([orders[0].id]),
      );
      for (let i = 0; i < 3; i++) {
        await checkout.recoverFulfilment(attempt.id, TENANT_1_MOCHA_HOUSE_ID);
      }
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardId: card.card.id, type: 'REDEMPTION' },
        }),
      ).toBe(1);
      expect(
        (
          await prisma.giftCard.findUniqueOrThrow({
            where: { id: card.card.id },
          })
        ).balanceMinorUnits,
      ).toBe(0);
      expect(provider.calls).toHaveLength(1);
    });

    it('an existing order is returned as it is; nothing is created or charged again', async () => {
      const request = body();
      const first = await submitCheckout(checkout, request, undefined, t1);
      const attempt = await attemptOf(request.clientRef);
      const again = await submitCheckout(checkout, request, undefined, t1);
      const recovered = await checkout.recoverFulfilment(
        attempt.id,
        TENANT_1_MOCHA_HOUSE_ID,
      );
      expect(again.orderId).toBe(first.orderId);
      expect(recovered.orderId).toBe(first.orderId);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
      expect(provider.calls).toHaveLength(1);
    });

    it('a pricing change keeps the payment for review and never changes the order', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      await prisma.locationProductPriceOverride.upsert({
        where: {
          locationId_menuId_productId: { locationId, menuId, productId },
        },
        create: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          locationId,
          menuId,
          productId,
          price: 9_999,
        },
        update: { price: 9_999 },
      });
      try {
        const retry = await outcomeOf(() =>
          submitCheckout(checkout, request, undefined, t1),
        );
        expect(retry.status).toBe(409);
        expect(JSON.stringify(retry.response)).toContain('manual review');
        const recovery = await outcomeOf(() =>
          checkout.recoverFulfilment(attempt.id, TENANT_1_MOCHA_HOUSE_ID),
        );
        expect(recovery.ok).toBe(false);
        expect(await ordersFor(attempt.id)).toHaveLength(0);
        expect(await attemptOf(request.clientRef)).toMatchObject({
          status: 'SUCCEEDED',
          paymentState: 'SUCCEEDED',
          reconciliationRequired: true,
          fulfilmentStatus: 'NEEDS_REVIEW',
        });
        expect(await snapshotOf(attempt.id)).not.toBeNull();
        expect((await caseOf(attempt.id))?.status).toBe('OPEN');
      } finally {
        await prisma.locationProductPriceOverride.deleteMany({
          where: { locationId, menuId, productId },
        });
      }
      // Once the price matches what was charged again, recovery completes.
      const recovered = await checkout.recoverFulfilment(
        attempt.id,
        TENANT_1_MOCHA_HOUSE_ID,
      );
      expect(recovered.orderId).toBe((await ordersFor(attempt.id))[0].id);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('never treats an uncertain payment as a success', () => {
    it('a held payment is never fulfilled by recovery or retry, and keeps its saved checkout', async () => {
      provider.behavior = async () => ({ outcome: 'unknown', reason: 'x' });
      const request = body();
      expect(
        (
          await outcomeOf(() =>
            submitCheckout(checkout, request, undefined, t1),
          )
        ).status,
      ).toBe(409);
      const attempt = await attemptOf(request.clientRef);
      const recovery = await outcomeOf(() =>
        checkout.recoverFulfilment(attempt.id, TENANT_1_MOCHA_HOUSE_ID),
      );
      expect(recovery.status).toBe(409);
      const retry = await outcomeOf(() =>
        submitCheckout(checkout, request, undefined, t1),
      );
      expect(retry.response).toMatchObject({ message: HELD_PAYMENT_MESSAGE });
      expect(await ordersFor(attempt.id)).toHaveLength(0);
      expect(await snapshotOf(attempt.id)).not.toBeNull();
      expect((await attemptOf(request.clientRef)).paymentState).toBe('UNKNOWN');
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('tenant isolation', () => {
    it("another business can neither recover nor observe a payment's order", async () => {
      const { request, attempt } = await chargedWithoutOrder();
      const foreign = await outcomeOf(() =>
        checkout.recoverFulfilment(attempt.id, TEST_TENANT_B_ID),
      );
      expect(foreign.status).toBe(409);
      const foreignRetry = await outcomeOf(() =>
        submitCheckout(
          checkout,
          request,
          undefined,
          tenantContextFor(TEST_TENANT_B_ID),
        ),
      );
      // Another business cannot even name this business's location (the
      // same 404 as a missing one), let alone its checkout session.
      expect(foreignRetry.status).toBe(404);
      expect(await ordersFor(attempt.id)).toHaveLength(0);
      // The saved checkout cannot be moved to another business.
      await expect(
        sql(
          `UPDATE "CheckoutSnapshot" SET "tenantId" = '${TEST_TENANT_B_ID}' WHERE "paymentAttemptId" = '${attempt.id}'`,
        ),
      ).rejects.toThrow();
      // The owner still recovers it.
      await checkout.recoverFulfilment(attempt.id, TENANT_1_MOCHA_HOUSE_ID);
      expect(await ordersFor(attempt.id)).toHaveLength(1);
    });
  });

  describe('lost acknowledgements, transient errors and interruptions', () => {
    // The real transaction, typed (bind() is untyped).
    const real = () =>
      prisma.$transaction.bind(prisma) as typeof prisma.$transaction;
    // A transaction that COMMITS, after which the caller sees an error — a
    // lost commit acknowledgement.
    const commitsThenFails = (realTx: typeof prisma.$transaction) =>
      (async (fn: never) => {
        await (realTx as (f: never) => Promise<unknown>)(fn);
        throw new Error('connection lost after commit');
      }) as never;

    it('an order whose commit acknowledgement is lost is returned as it is, with nothing flagged', async () => {
      const request = body();
      const realTx = real();
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(realTx) // the attempt and its saved checkout
        .mockImplementationOnce(commitsThenFails(realTx)); // the order
      let confirmation: OrderConfirmation | undefined;
      try {
        confirmation = await submitCheckout(checkout, request, undefined, t1);
      } finally {
        spy.mockRestore();
      }
      const attempt = await attemptOf(request.clientRef);
      const orders = await ordersFor(attempt.id);
      expect(orders.map((o) => o.id)).toEqual([confirmation.orderId]);
      expect(attempt).toMatchObject({
        reconciliationRequired: false,
        fulfilmentStatus: 'DONE',
      });
      expect(await caseOf(attempt.id)).toBeNull();
      expect(provider.calls).toHaveLength(1);
    });

    it('a transient error while resuming asks the customer to retry; the retry completes', async () => {
      const { request, attempt } = await chargedWithoutOrder();
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('database briefly unavailable'));
      let transient: Awaited<ReturnType<typeof outcomeOf>> | undefined;
      try {
        transient = await outcomeOf(() =>
          submitCheckout(checkout, request, undefined, t1),
        );
      } finally {
        spy.mockRestore();
      }
      expect(transient.status).toBe(503);
      expect(JSON.stringify(transient.response)).toContain('Do not pay again');
      const resumed = await submitCheckout(checkout, request, undefined, t1);
      expect((await ordersFor(attempt.id)).map((o) => o.id)).toEqual([
        resumed.orderId,
      ]);
      expect(provider.calls).toHaveLength(1);
    });

    it('an attempt saved but never sent is abandoned after a while (never charged) and the retry pays once; a fresh one is left alone', async () => {
      const stale = body();
      const fresh = body();
      // Two requests that stopped right after saving, before any charge.
      for (const request of [stale, fresh]) {
        const r = await withFailures(
          [
            {
              table: 'PaymentAttempt',
              event: 'UPDATE',
              when: `NEW."paymentState" = 'CHARGING'`,
            },
          ],
          () =>
            outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
        );
        expect(r.ok).toBe(false);
      }
      expect(provider.calls).toHaveLength(0);
      const staleAttempt = await attemptOf(stale.clientRef);
      await prisma.paymentAttempt.update({
        where: { id: staleAttempt.id },
        data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) },
      });

      // ESP-03 PR 6 — the stranded attempt is closed as ABANDONED (it was
      // never sent, so nothing was charged) and the same checkout continues
      // with one new attempt: one charge, one order.
      const retried = await submitCheckout(checkout, stale, undefined, t1);
      expect(provider.calls).toHaveLength(1);
      expect(await snapshotOf(staleAttempt.id)).toBeNull();
      expect(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: staleAttempt.id },
        }),
      ).toMatchObject({
        status: 'FAILED',
        paymentState: 'ABANDONED',
        fulfilmentStatus: 'NOT_REQUIRED',
      });
      expect(await ordersFor(staleAttempt.id)).toHaveLength(0);
      const paid = await attemptOf(stale.clientRef);
      expect(paid.id).not.toBe(staleAttempt.id);
      expect((await ordersFor(paid.id)).map((o) => o.id)).toEqual([
        retried.orderId,
      ]);

      const freshAttempt = await attemptOf(fresh.clientRef);
      const busy = await outcomeOf(() =>
        submitCheckout(checkout, fresh, undefined, t1),
      );
      expect(JSON.stringify(busy.response)).toContain(
        'already being processed',
      );
      expect(await snapshotOf(freshAttempt.id)).not.toBeNull();
      expect(provider.calls).toHaveLength(1);
    });

    it('a gift card whose commit acknowledgement is lost is still handed to the buyer, never flagged', async () => {
      const req = {
        clientRef: randomUUID(),
        amountMinorUnits: 2500,
        purchaserEmail: 'rf-ack@example.test',
        purchaserName: 'RF Ack',
      };
      const i = await createGiftIntent(purchases, req, undefined, t1);
      const spy = jest
        .spyOn(prisma, '$transaction')
        .mockImplementationOnce(commitsThenFails(real()));
      let first: PurchaseGiftCardResponse | undefined;
      try {
        first = await purchaseGiftCard(
          purchases,
          {
            clientRef: req.clientRef,
            recoveryCredential: i.recoveryCredential ?? undefined,
          },
          undefined,
          t1,
        );
      } finally {
        spy.mockRestore();
      }
      expect(first.status).toBe('ISSUED');
      expect(first.code).not.toBeNull();
      const attempt = await attemptOf(req.clientRef);
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: attempt.id },
      });
      expect(purchase.status).toBe('ISSUED');
      expect(attempt.reconciliationRequired).toBe(false);
      expect(await caseOf(attempt.id)).toBeNull();
      // A retry answers with the same card.
      const again = await purchaseGiftCard(
        purchases,
        {
          clientRef: req.clientRef,
          recoveryCredential: i.recoveryCredential ?? undefined,
        },
        undefined,
        t1,
      );
      expect(again.last4).toBe(first.last4);
      expect(provider.calls).toHaveLength(1);
    });
  });

  describe('gift-card issuance', () => {
    const intent = () => ({
      clientRef: randomUUID(),
      amountMinorUnits: 2500,
      purchaserEmail: 'rf-buyer@example.test',
      purchaserName: 'RF Buyer',
    });

    it('a charged purchase whose card failed to issue gets exactly one card on retry, never charged again', async () => {
      const req = intent();
      const i = await createGiftIntent(purchases, req, undefined, t1);
      const run = () =>
        outcomeOf(() =>
          purchaseGiftCard(
            purchases,
            {
              clientRef: req.clientRef,
              recoveryCredential: i.recoveryCredential ?? undefined,
            },
            undefined,
            t1,
          ),
        );
      const failed = await withFailingWrites('GiftCard', run);
      expect(failed.status).toBe(409);
      const attempt = await attemptOf(req.clientRef);
      expect(attempt).toMatchObject({
        status: 'SUCCEEDED',
        reconciliationRequired: true,
      });
      expect((await caseOf(attempt.id))?.reasonCode).toBe('FULFILMENT_FAILED');

      const results = await Promise.all(Array.from({ length: 4 }, run));
      expect(results.every((r) => r.ok)).toBe(true);
      const purchase = await prisma.giftCardPurchase.findUniqueOrThrow({
        where: { paymentAttemptId: attempt.id },
      });
      expect(purchase.status).toBe('ISSUED');
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardPurchaseId: purchase.id, type: 'ISSUANCE' },
        }),
      ).toBe(1);
      expect(new Set(results.map((r) => r.value!.last4))).toEqual(
        new Set([results[0].value!.last4]),
      );
      expect(provider.calls).toHaveLength(1);
      expect((await caseOf(attempt.id))?.status).toBe('RESOLVED');
    });
  });
});
