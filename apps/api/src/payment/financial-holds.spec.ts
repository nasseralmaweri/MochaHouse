/* eslint-disable @typescript-eslint/require-await -- controlled provider doubles are async by contract */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Test, type TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removePaymentRecoveryRecordsForTest,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import type {
  ChargeRequest,
  ChargeResult,
  PaymentProvider,
} from '@mocha-house/integrations';
import { CHECKOUT_RESOURCE_UNAVAILABLE } from '@mocha-house/contracts';
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
import { heldOnGiftCard, heldOnPromotion } from './financial-holds';
import { CheckoutService } from '../orders/application/checkout.service';
import { LoyaltyService } from '../loyalty/application/loyalty.service';
import { LoyaltyAdminService } from '../loyalty/application/loyalty-admin.service';
import { GiftCardsAdminService } from '../gift-cards/application/gift-cards-admin.service';
import { GiftCardBalanceService } from '../gift-cards/application/gift-card-balance.service';
import { PromotionsAdminService } from '../promotions/application/promotions-admin.service';
import type { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
} from '../gift-cards/infrastructure/gift-card-code';
import {
  attemptsOfCheckout,
  checkoutAttemptsOfThisSuite,
  checkoutSessionsOfThisSuite,
  submitCheckout,
  type LabelledCheckoutRequest,
} from '../../test/checkout-session';

// ESP-03 PR 8 — pre-charge financial holds. Real services and a real
// disposable database; the provider is a controlled double (it can hold a
// charge open, decline, fail, stay pending or unknown) and failures are real
// database failures. Covers: holds are created with the payment attempt and
// before the charge; what is available is balance or limit minus active
// holds, so competing checkouts for the last coupon redemption, gift-card
// balance or Mocha Beans never both get charged; a failed reservation rolls
// everything back and charges nothing; holds are consumed exactly once by the
// order (including recovery, retries, concurrency and zero-charge orders),
// released only by a definitive decline, failure or abandonment, and kept
// for pending, unknown and paid-but-unfulfilled payments; staff deductions,
// promotion limit edits, checkout previews and the balance check respect
// them; the guest coupon policy; and tenant isolation.

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

const codeOf = (r: { response?: unknown }) =>
  (r.response as { code?: string } | undefined)?.code;

async function until(condition: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

jest.setTimeout(240_000);

describe('ESP-03 PR 8 financial holds (integration)', () => {
  const provider = new ControlledProvider();
  const t1 = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const suffix = randomUUID().slice(0, 8);
  const authorization = {
    assertCorporate: () => undefined,
  } as unknown as AuthorizationContext;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let checkout: CheckoutService;
  let loyaltyAdmin: LoyaltyAdminService;
  let giftCardsAdmin: GiftCardsAdminService;
  let giftCardBalance: GiftCardBalanceService;
  let promotionsAdmin: PromotionsAdminService;
  let actorId: string;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };
  const created = {
    promotions: [] as string[],
    rewards: [] as string[],
    giftCards: [] as string[],
    attempts: [] as string[],
  };

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
  type Failure = { table: string; event?: 'INSERT' | 'UPDATE'; when?: string };
  async function withFailures<T>(
    failures: Failure[],
    fn: () => Promise<T>,
  ): Promise<T> {
    await sql(`
      CREATE OR REPLACE FUNCTION esp03_pr8_simulated_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated database failure'; END $$;`);
    for (const f of failures) {
      await sql(`CREATE TRIGGER esp03_pr8_fail BEFORE ${f.event ?? 'INSERT'}
        ON "${f.table}" FOR EACH ROW ${f.when ? `WHEN (${f.when})` : ''}
        EXECUTE FUNCTION esp03_pr8_simulated_failure();`);
    }
    try {
      return await fn();
    } finally {
      for (const f of failures) {
        await sql(`DROP TRIGGER IF EXISTS esp03_pr8_fail ON "${f.table}";`);
      }
    }
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.GIFT_CARD_CODE_SECRET = 'financial-holds-spec-secret';
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
    loyaltyAdmin = moduleRef.get(LoyaltyAdminService, { strict: false });
    giftCardsAdmin = moduleRef.get(GiftCardsAdminService, { strict: false });
    giftCardBalance = moduleRef.get(GiftCardBalanceService, { strict: false });
    promotionsAdmin = moduleRef.get(PromotionsAdminService, { strict: false });
    actorId = (
      await prisma.internalUser.findFirstOrThrow({
        where: { tenantId: TENANT_1_MOCHA_HOUSE_ID, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      })
    ).id;

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
    await createTestTenantB(prisma);
  });

  afterAll(async () => {
    await sql(`DROP TRIGGER IF EXISTS esp03_pr8_fail ON "Order";
      DROP TRIGGER IF EXISTS esp03_pr8_fail ON "PaymentAttempt";
      DROP TRIGGER IF EXISTS esp03_pr8_fail ON "FinancialHold";
      DROP FUNCTION IF EXISTS esp03_pr8_simulated_failure();`);
    jest.restoreAllMocks();
    const attemptIds = [
      ...(
        await prisma.paymentAttempt.findMany({
          where: checkoutAttemptsOfThisSuite(),
          select: { id: true },
        })
      ).map((a) => a.id),
      ...created.attempts,
    ];
    const orderIds = (
      await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      })
    ).map((o) => o.id);
    const bonuses = await prisma.orderLoyaltyBonus.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    await prisma.orderLoyaltyBonusItem.deleteMany({
      where: { orderLoyaltyBonusId: { in: bonuses.map((b) => b.id) } },
    });
    await prisma.orderLoyaltyBonus.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderPromotionRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.orderLoyaltyRewardRedemption.deleteMany({
      where: { orderId: { in: orderIds } },
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { orderId: { in: orderIds } },
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
    await removePaymentRecoveryRecordsForTest(attemptIds);
    await prisma.paymentAttempt.deleteMany({
      where: { id: { in: attemptIds } },
    });
    await prisma.checkoutSession.deleteMany({
      where: checkoutSessionsOfThisSuite(),
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { giftCardId: { in: created.giftCards } },
    });
    await prisma.giftCard.deleteMany({
      where: { id: { in: created.giftCards } },
    });
    await prisma.promotionCustomerUsage.deleteMany({
      where: { promotionId: { in: created.promotions } },
    });
    await prisma.promotion.deleteMany({
      where: { id: { in: created.promotions } },
    });
    await prisma.loyaltyReward.deleteMany({
      where: { id: { in: created.rewards } },
    });
    const customers = await prisma.customer.findMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: `test-customer-pr8-${suffix}` },
      },
      select: { id: true },
    });
    const customerIds = customers.map((c) => c.id);
    await prisma.mochaBeanLedgerEntry.deleteMany({
      where: { loyaltyAccount: { customerId: { in: customerIds } } },
    });
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    process.env = { ...originalEnv };
  });

  beforeEach(() => provider.reset());
  afterEach(() => jest.restoreAllMocks());

  // --- fixtures ------------------------------------------------------------------

  const body = (
    overrides: Partial<LabelledCheckoutRequest> = {},
    quantity = 2,
  ): LabelledCheckoutRequest => ({
    clientRef: `fh_${randomUUID()}`,
    locationId,
    guest: { name: 'Hold Guest', phone: '5551238888' },
    lines: [
      {
        productId,
        quantity,
        selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
      },
    ],
    ...overrides,
  });

  async function member(beans = 0) {
    const identity = {
      provider: 'test' as const,
      subject: `test-customer-pr8-${suffix}-${randomUUID()}`,
      email: `pr8-${randomUUID().slice(0, 8)}@example.com`,
      name: null,
      emailVerified: null,
    };
    const customer = await prisma.customer.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: identity.provider,
        externalSubject: identity.subject,
        email: identity.email,
      },
    });
    const account = await prisma.customerLoyaltyAccount.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        customerId: customer.id,
        balance: beans,
      },
    });
    return { identity, customer, account };
  }

  async function coupon(limits: { total?: number; perCustomer?: number } = {}) {
    const code = `PR8${randomUUID().slice(0, 8)}`.toUpperCase();
    const promotion = await prisma.promotion.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `PR8 coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue: 100,
        appliesToAllLocations: true,
        totalRedemptionLimit: limits.total ?? null,
        perCustomerRedemptionLimit: limits.perCustomer ?? null,
      },
    });
    created.promotions.push(promotion.id);
    return { code, promotion };
  }

  async function reward(beanCost: number) {
    const row = await prisma.loyaltyReward.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        name: `PR8 reward ${randomUUID().slice(0, 8)}`,
        type: 'FIXED_AMOUNT',
        beanCost,
        fixedAmountMinorUnits: 100,
      },
    });
    created.rewards.push(row.id);
    return row;
  }

  async function giftCard(balanceMinorUnits: number) {
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
    created.giftCards.push(card.id);
    return { id: card.id, code };
  }

  const attemptsOf = (key: string) =>
    prisma.paymentAttempt.findMany({ where: attemptsOfCheckout(key) });
  const attemptOf = async (key: string) => {
    const [attempt] = await prisma.paymentAttempt.findMany({
      where: attemptsOfCheckout(key),
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return attempt;
  };
  const holdsOf = (paymentAttemptId: string) =>
    prisma.financialHold.findMany({
      where: { paymentAttemptId },
      orderBy: { kind: 'asc' },
    });
  const ordersFor = (paymentAttemptId: string) =>
    prisma.order.findMany({ where: { paymentAttemptId } });
  const promotionCount = async (id: string) =>
    (await prisma.promotion.findUniqueOrThrow({ where: { id } }))
      .redemptionCount;
  const cardBalance = async (id: string) =>
    (await prisma.giftCard.findUniqueOrThrow({ where: { id } }))
      .balanceMinorUnits;
  const beans = async (accountId: string) =>
    (
      await prisma.customerLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      })
    ).balance;
  const redeemEntries = (accountId: string) =>
    prisma.mochaBeanLedgerEntry.count({
      where: { loyaltyAccountId: accountId, type: 'REDEEM' },
    });
  const recover = (paymentAttemptId: string) =>
    checkout.recoverFulfilment(paymentAttemptId, TENANT_1_MOCHA_HOUSE_ID);

  // A payment whose provider outcome stays open until `settle` is called.
  function openCharge() {
    let settle!: (result: ChargeResult) => void;
    const result = new Promise<ChargeResult>((resolve) => {
      settle = resolve;
    });
    provider.behavior = async () => result;
    return settle;
  }

  // A payment the provider reports as unknown (or pending): held.
  async function heldPayment(
    request: LabelledCheckoutRequest,
    identity?: Awaited<ReturnType<typeof member>>['identity'],
    outcome: 'unknown' | 'pending' = 'unknown',
  ) {
    provider.behavior = async () =>
      outcome === 'pending'
        ? { outcome: 'pending', reason: 'provider pending' }
        : { outcome: 'unknown', reason: 'provider did not answer' };
    const r = await outcomeOf(() =>
      submitCheckout(checkout, request, identity, t1),
    );
    expect(r.ok).toBe(false);
    provider.reset();
    return attemptOf(request.clientRef);
  }

  // A charged payment whose order could not be created (a real write
  // failure inside the order transaction), kept for review.
  async function chargedWithoutOrder(
    request: LabelledCheckoutRequest,
    identity?: Awaited<ReturnType<typeof member>>['identity'],
  ) {
    const first = await withFailures([{ table: 'Order' }], () =>
      outcomeOf(() => submitCheckout(checkout, request, identity, t1)),
    );
    expect(first.ok).toBe(false);
    const attempt = await attemptOf(request.clientRef);
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      paymentState: 'SUCCEEDED',
      reconciliationRequired: true,
    });
    expect(await ordersFor(attempt.id)).toHaveLength(0);
    return attempt;
  }

  // --- reserving before the charge --------------------------------------------

  describe('reserving before the charge', () => {
    it('reserves the coupon, gift card and Beans with the attempt, before the provider is called, and consumes each exactly once', async () => {
      const { identity, customer, account } = await member(20);
      const { code, promotion } = await coupon({ total: 5, perCustomer: 2 });
      const rw = await reward(10);
      const card = await giftCard(300);
      const request = body({
        couponCode: code,
        loyaltyRewardId: rw.id,
        giftCardCode: card.code,
      });
      let seen: Awaited<ReturnType<typeof holdsOf>> = [];
      provider.behavior = async (req) => {
        const attempt = await prisma.paymentAttempt.findFirstOrThrow({
          where: { idempotencyKey: req.idempotencyKey },
        });
        seen = await holdsOf(attempt.id);
        return { outcome: 'succeeded', providerReference: 'ref_hold' };
      };
      const confirmation = await submitCheckout(
        checkout,
        request,
        identity,
        t1,
      );
      expect(seen.map((h) => [h.kind, h.status, h.amount])).toEqual([
        ['GIFT_CARD_TENDER', 'ACTIVE', 300],
        ['LOYALTY_REDEMPTION', 'ACTIVE', 10],
        ['PROMOTION_REDEMPTION', 'ACTIVE', 1],
      ]);
      const attempt = await attemptOf(request.clientRef);
      const holds = await holdsOf(attempt.id);
      expect(holds.map((h) => h.status)).toEqual([
        'CONSUMED',
        'CONSUMED',
        'CONSUMED',
      ]);
      expect(holds.every((h) => h.tenantId === TENANT_1_MOCHA_HOUSE_ID)).toBe(
        true,
      );
      expect(
        holds.find((h) => h.kind === 'PROMOTION_REDEMPTION'),
      ).toMatchObject({ promotionId: promotion.id, customerId: customer.id });
      expect((await ordersFor(attempt.id)).map((o) => o.id)).toEqual([
        confirmation.orderId,
      ]);
      expect(await promotionCount(promotion.id)).toBe(1);
      expect(await cardBalance(card.id)).toBe(0);
      expect(await redeemEntries(account.id)).toBe(1);
      expect(provider.calls).toHaveLength(1);
      // Nothing is held any more.
      expect(
        await heldOnGiftCard(prisma, TENANT_1_MOCHA_HOUSE_ID, card.id),
      ).toBe(0);
    });

    it('if any reservation fails, nothing is reserved, no attempt exists and nothing is charged', async () => {
      const { identity, account } = await member(5);
      const { code, promotion } = await coupon({ total: 1 });
      const rw = await reward(10);
      const card = await giftCard(300);
      // The early check is passed (as if the Beans were spent between the
      // preview and the reservation), so the reservation itself refuses.
      jest
        .spyOn(
          moduleRef.get(LoyaltyService, { strict: false }),
          'getAvailableBalanceForCustomer',
        )
        .mockResolvedValue(1_000);
      const request = body({
        couponCode: code,
        loyaltyRewardId: rw.id,
        giftCardCode: card.code,
      });
      const r = await outcomeOf(() =>
        submitCheckout(checkout, request, identity, t1),
      );
      expect(r.status).toBe(409);
      expect(codeOf(r)).toBe(CHECKOUT_RESOURCE_UNAVAILABLE);
      expect(await attemptsOf(request.clientRef)).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
      expect(
        await heldOnPromotion(
          prisma,
          TENANT_1_MOCHA_HOUSE_ID,
          promotion.id,
          null,
        ),
      ).toEqual({ total: 0, customer: 0 });
      expect(
        await heldOnGiftCard(prisma, TENANT_1_MOCHA_HOUSE_ID, card.id),
      ).toBe(0);
      expect(await beans(account.id)).toBe(5);
      // The coupon's last redemption is still there for someone else.
      jest.restoreAllMocks();
      const other = await submitCheckout(
        checkout,
        body({ couponCode: code }),
        undefined,
        t1,
      );
      expect(other.orderId).toBeTruthy();
      expect(await promotionCount(promotion.id)).toBe(1);
    });
  });

  // --- competing checkouts --------------------------------------------------------

  describe('competing checkouts', () => {
    it('two customers competing for the final coupon redemption: one is charged, the other is refused before any charge', async () => {
      const { code, promotion } = await coupon({ total: 1 });
      const a = await member();
      const b = await member();
      const settle = openCharge();
      const first = body({ couponCode: code });
      const firstDone = outcomeOf(() =>
        submitCheckout(checkout, first, a.identity, t1),
      );
      await until(() => provider.calls.length === 1);
      // While A's charge is in flight, B cannot have the last redemption.
      const second = body({ couponCode: code });
      const r = await outcomeOf(() =>
        submitCheckout(checkout, second, b.identity, t1),
      );
      expect(r.ok).toBe(false);
      expect([400, 409]).toContain(r.status);
      expect(provider.calls).toHaveLength(1);
      expect(await attemptsOf(second.clientRef)).toHaveLength(0);
      settle({ outcome: 'succeeded', providerReference: 'ref_a' });
      expect((await firstDone).ok).toBe(true);
      expect(await promotionCount(promotion.id)).toBe(1);

      // And truly concurrent: exactly one of two simultaneous checkouts.
      const { code: lastCode, promotion: last } = await coupon({ total: 1 });
      const results = await Promise.all(
        [a, b].map((m) =>
          outcomeOf(() =>
            submitCheckout(
              checkout,
              body({ couponCode: lastCode }),
              m.identity,
              t1,
            ),
          ),
        ),
      );
      expect(results.filter((x) => x.ok)).toHaveLength(1);
      expect(await promotionCount(last.id)).toBe(1);
      expect(provider.calls).toHaveLength(2);
    });

    it('two simultaneous checkouts with one gift card never spend more than its balance', async () => {
      const card = await giftCard(300);
      const settle = openCharge();
      const first = body({ giftCardCode: card.code });
      const firstDone = outcomeOf(() =>
        submitCheckout(checkout, first, undefined, t1),
      );
      await until(() => provider.calls.length === 1);
      // The card's whole balance is held: the second checkout sees none.
      expect(await giftCardBalance.lookup(card.code, t1)).toMatchObject({
        balanceMinorUnits: 0,
        status: 'depleted',
      });
      const second = body({ giftCardCode: card.code });
      const r = await outcomeOf(() =>
        submitCheckout(checkout, second, undefined, t1),
      );
      expect(r.ok).toBe(false);
      expect(await attemptsOf(second.clientRef)).toHaveLength(0);
      settle({ outcome: 'succeeded', providerReference: 'ref_gc' });
      expect((await firstDone).ok).toBe(true);
      expect(await cardBalance(card.id)).toBe(0);

      const shared = await giftCard(300);
      const results = await Promise.all(
        [1, 2].map(() =>
          outcomeOf(() =>
            submitCheckout(
              checkout,
              body({ giftCardCode: shared.code }),
              undefined,
              t1,
            ),
          ),
        ),
      );
      expect(results.filter((x) => x.ok)).toHaveLength(1);
      expect(await cardBalance(shared.id)).toBe(0);
      expect(
        await prisma.giftCardTransaction.count({
          where: { giftCardId: shared.id, type: 'REDEMPTION' },
        }),
      ).toBe(1);
      // Only the successful checkouts were ever charged.
      expect(provider.calls).toHaveLength(2);
    });

    it('concurrent loyalty redemptions never spend more Beans than the customer has', async () => {
      const { identity, account } = await member(10);
      const rw = await reward(10);
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          outcomeOf(() =>
            submitCheckout(
              checkout,
              body({ loyaltyRewardId: rw.id }),
              identity,
              t1,
            ),
          ),
        ),
      );
      expect(results.filter((x) => x.ok)).toHaveLength(1);
      expect(await redeemEntries(account.id)).toBe(1);
      expect(await beans(account.id)).toBeGreaterThanOrEqual(0);
      expect(provider.calls).toHaveLength(1);
    });
  });

  // --- outcomes -----------------------------------------------------------------

  describe('payment outcomes', () => {
    it.each(['declined', 'failed'] as const)(
      'a confirmed %s payment releases its holds atomically; the capacity is available again',
      async (outcome) => {
        const { code, promotion } = await coupon({ total: 1 });
        const card = await giftCard(300);
        provider.behavior = async () => ({
          outcome,
          reason: `provider ${outcome}`,
        });
        const request = body({ couponCode: code, giftCardCode: card.code });
        const r = await outcomeOf(() =>
          submitCheckout(checkout, request, undefined, t1),
        );
        expect(r.ok).toBe(false);
        const attempt = await attemptOf(request.clientRef);
        expect(attempt.status).toBe(
          outcome === 'declined' ? 'DECLINED' : 'FAILED',
        );
        const holds = await holdsOf(attempt.id);
        expect(holds.map((h) => [h.status, h.releaseReason])).toEqual([
          ['RELEASED', outcome.toUpperCase()],
          ['RELEASED', outcome.toUpperCase()],
        ]);
        provider.reset();
        // The same checkout retries once, reserving again.
        const retried = await submitCheckout(checkout, request, undefined, t1);
        expect(retried.orderId).toBeTruthy();
        expect(await promotionCount(promotion.id)).toBe(1);
        expect(await cardBalance(card.id)).toBe(0);
      },
    );

    it('a payment that was never sent is abandoned and releases its holds; the retry is charged once', async () => {
      const { code, promotion } = await coupon({ total: 1 });
      const request = body({ couponCode: code });
      const r = await withFailures(
        [
          {
            table: 'PaymentAttempt',
            event: 'UPDATE',
            when: `NEW."paymentState" = 'CHARGING'`,
          },
        ],
        () => outcomeOf(() => submitCheckout(checkout, request, undefined, t1)),
      );
      expect(r.ok).toBe(false);
      expect(provider.calls).toHaveLength(0);
      const stale = await attemptOf(request.clientRef);
      expect((await holdsOf(stale.id)).map((h) => h.status)).toEqual([
        'ACTIVE',
      ]);
      await prisma.paymentAttempt.update({
        where: { id: stale.id },
        data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) },
      });
      const retried = await submitCheckout(checkout, request, undefined, t1);
      expect(retried.orderId).toBeTruthy();
      expect(
        (await holdsOf(stale.id)).map((h) => [h.status, h.releaseReason]),
      ).toEqual([['RELEASED', 'ABANDONED']]);
      expect(provider.calls).toHaveLength(1);
      expect(await promotionCount(promotion.id)).toBe(1);
    });

    it('the recovery sweep closes payments never sent long ago and releases their holds; a recent one keeps them', async () => {
      const { code } = await coupon({ total: 2 });
      const stale = body({ couponCode: code });
      const fresh = body({ couponCode: code });
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
      const staleAttempt = await attemptOf(stale.clientRef);
      const freshAttempt = await attemptOf(fresh.clientRef);
      await prisma.paymentAttempt.update({
        where: { id: staleAttempt.id },
        data: { createdAt: new Date(Date.now() - 20 * 60 * 1000) },
      });
      expect(
        await checkout.abandonStrandedUnsentAttempts(),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: staleAttempt.id },
        }),
      ).toMatchObject({ status: 'FAILED', paymentState: 'ABANDONED' });
      expect(
        (await holdsOf(staleAttempt.id)).map((h) => [
          h.status,
          h.releaseReason,
        ]),
      ).toEqual([['RELEASED', 'ABANDONED']]);
      expect((await holdsOf(freshAttempt.id)).map((h) => h.status)).toEqual([
        'ACTIVE',
      ]);
      expect(provider.calls).toHaveLength(0);
    });

    it.each(['unknown', 'pending'] as const)(
      'an %s payment keeps its holds — never released by time — and blocks what it reserved',
      async (outcome) => {
        const { identity, account } = await member(10);
        const { code, promotion } = await coupon({ total: 1 });
        const rw = await reward(10);
        const card = await giftCard(300);
        const request = body({
          couponCode: code,
          loyaltyRewardId: rw.id,
          giftCardCode: card.code,
        });
        const attempt = await heldPayment(request, identity, outcome);
        // Long after the browser session and the abandon window.
        await prisma.paymentAttempt.update({
          where: { id: attempt.id },
          data: { createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
        });
        await prisma.checkoutSession.updateMany({
          where: { paymentAttempts: { some: { id: attempt.id } } },
          data: {
            createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000),
            expiresAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
            tokenExpiresAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
          },
        });
        const retry = await outcomeOf(() =>
          submitCheckout(checkout, request, identity, t1),
        );
        expect(retry.ok).toBe(false);
        expect((await holdsOf(attempt.id)).map((h) => h.status)).toEqual([
          'ACTIVE',
          'ACTIVE',
          'ACTIVE',
        ]);
        // The retry was never charged again.
        expect(provider.calls).toHaveLength(0);
        // Nobody else can have what it holds.
        const other = await member(10);
        const competing = await outcomeOf(() =>
          submitCheckout(
            checkout,
            body({ couponCode: code }),
            other.identity,
            t1,
          ),
        );
        expect(competing.ok).toBe(false);
        expect(await giftCardBalance.lookup(card.code, t1)).toMatchObject({
          balanceMinorUnits: 0,
        });
        expect(await promotionCount(promotion.id)).toBe(0);
        expect(await beans(account.id)).toBe(10);
      },
    );

    it('a successful payment whose order failed keeps its holds; recovery and retries consume them exactly once', async () => {
      const { identity, account } = await member(10);
      const { code, promotion } = await coupon({ total: 1 });
      const rw = await reward(10);
      const card = await giftCard(300);
      const request = body({
        couponCode: code,
        loyaltyRewardId: rw.id,
        giftCardCode: card.code,
      });
      const attempt = await chargedWithoutOrder(request, identity);
      expect((await holdsOf(attempt.id)).map((h) => h.status)).toEqual([
        'ACTIVE',
        'ACTIVE',
        'ACTIVE',
      ]);
      // Nobody else can take what this paid order still needs.
      const other = await member(10);
      expect(
        (
          await outcomeOf(() =>
            submitCheckout(
              checkout,
              body({ couponCode: code }),
              other.identity,
              t1,
            ),
          )
        ).ok,
      ).toBe(false);
      const results = await Promise.all([
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => recover(attempt.id)),
        outcomeOf(() => submitCheckout(checkout, request, identity, t1)),
      ]);
      const orders = await ordersFor(attempt.id);
      expect(orders).toHaveLength(1);
      for (const r of results.filter((x) => x.ok)) {
        expect((r.value as { orderId: string }).orderId).toBe(orders[0].id);
      }
      expect((await recover(attempt.id)).orderId).toBe(orders[0].id);
      expect((await holdsOf(attempt.id)).map((h) => h.status)).toEqual([
        'CONSUMED',
        'CONSUMED',
        'CONSUMED',
      ]);
      expect(await promotionCount(promotion.id)).toBe(1);
      expect(await cardBalance(card.id)).toBe(0);
      expect(await redeemEntries(account.id)).toBe(1);
      expect(provider.calls).toHaveLength(1);
    });

    it('a zero-charge checkout (gift card covers everything) reserves and consumes atomically without calling the provider', async () => {
      const card = await giftCard(10_000);
      const request = body({ giftCardCode: card.code });
      const confirmation = await submitCheckout(
        checkout,
        request,
        undefined,
        t1,
      );
      const attempt = await attemptOf(request.clientRef);
      expect(attempt.amount).toBe(0);
      expect(provider.calls).toHaveLength(0);
      const [hold] = await holdsOf(attempt.id);
      expect(hold).toMatchObject({
        kind: 'GIFT_CARD_TENDER',
        status: 'CONSUMED',
      });
      expect(await cardBalance(card.id)).toBe(10_000 - hold.amount);
      expect((await ordersFor(attempt.id))[0].id).toBe(confirmation.orderId);

      // A zero-charge order that failed keeps its hold until recovery.
      const failing = body({ giftCardCode: card.code });
      const paid = await chargedWithoutOrder(failing);
      expect((await holdsOf(paid.id)).map((h) => h.status)).toEqual(['ACTIVE']);
      await recover(paid.id);
      expect((await holdsOf(paid.id)).map((h) => h.status)).toEqual([
        'CONSUMED',
      ]);
      expect(provider.calls).toHaveLength(0);
    });

    it('a payment from before holds existed reserves at fulfilment and is kept for review when another payment holds what it needs', async () => {
      const { code } = await coupon({ total: 1 });
      const legacy = await chargedWithoutOrder(body({ couponCode: code }));
      // As if created before ESP-03 PR 8: no holds (test-only bypass).
      await sql(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM "FinancialHold" WHERE "paymentAttemptId" = '${legacy.id}'; COMMIT;`);
      // Meanwhile another payment holds the last redemption.
      const holder = await heldPayment(body({ couponCode: code }));
      expect((await holdsOf(holder.id)).map((h) => h.status)).toEqual([
        'ACTIVE',
      ]);
      expect((await outcomeOf(() => recover(legacy.id))).ok).toBe(false);
      expect(await ordersFor(legacy.id)).toHaveLength(0);
      expect(await holdsOf(legacy.id)).toHaveLength(0);
    });
  });

  // --- staff, limits, previews and policy ----------------------------------------------

  describe('staff changes, limits, previews and policy', () => {
    it('staff deductions can never take held Beans or gift-card balance; credits and unheld amounts are fine', async () => {
      const { identity, customer, account } = await member(30);
      const rw = await reward(20);
      const card = await giftCard(100);
      // Two held payments (each still charged something): 20 Beans, and
      // the card's whole 100.
      await heldPayment(body({ loyaltyRewardId: rw.id }, 1), identity);
      await heldPayment(body({ giftCardCode: card.code }, 1));
      const held = await heldOnGiftCard(
        prisma,
        TENANT_1_MOCHA_HOUSE_ID,
        card.id,
      );
      expect(held).toBe(100);
      // Credit the card: only the credit is available to deduct.
      const key = () => `pr8-${randomUUID()}`;
      await giftCardsAdmin.correct(
        card.id,
        { deltaMinorUnits: 400, reason: 'test credit', operationKey: key() },
        actorId,
        authorization,
        t1,
      );
      const tooMuchBeans = await outcomeOf(() =>
        loyaltyAdmin.adjust(
          customer.id,
          { deltaBeans: -11, reason: 'test deduction', operationKey: key() },
          actorId,
          authorization,
          t1,
        ),
      );
      expect(tooMuchBeans.status).toBe(409);
      await loyaltyAdmin.adjust(
        customer.id,
        { deltaBeans: -10, reason: 'test deduction', operationKey: key() },
        actorId,
        authorization,
        t1,
      );
      await loyaltyAdmin.adjust(
        customer.id,
        { deltaBeans: 5, reason: 'test credit', operationKey: key() },
        actorId,
        authorization,
        t1,
      );
      expect(await beans(account.id)).toBe(25);

      const tooMuchCard = await outcomeOf(() =>
        giftCardsAdmin.correct(
          card.id,
          {
            deltaMinorUnits: -(500 - held + 1),
            reason: 'test correction',
            operationKey: key(),
          },
          actorId,
          authorization,
          t1,
        ),
      );
      expect(tooMuchCard.status).toBe(409);
      await giftCardsAdmin.correct(
        card.id,
        {
          deltaMinorUnits: -(500 - held),
          reason: 'test correction',
          operationKey: key(),
        },
        actorId,
        authorization,
        t1,
      );
      expect(await cardBalance(card.id)).toBe(held);
    });

    it('promotion limits cannot be lowered below what is used plus held', async () => {
      const { identity, customer } = await member();
      const { code, promotion } = await coupon({ total: 5, perCustomer: 3 });
      await submitCheckout(checkout, body({ couponCode: code }), identity, t1);
      await heldPayment(body({ couponCode: code }), identity);
      // Used 1 + held 1 = 2, all by this customer.
      const edit = (data: object) =>
        outcomeOf(() =>
          promotionsAdmin.updatePromotion(
            promotion.id,
            data,
            actorId,
            authorization,
            t1,
          ),
        );
      expect((await edit({ totalRedemptionLimit: 1 })).status).toBe(409);
      expect((await edit({ perCustomerRedemptionLimit: 1 })).status).toBe(409);
      expect((await edit({ totalRedemptionLimit: 2 })).ok).toBe(true);
      expect((await edit({ perCustomerRedemptionLimit: 2 })).ok).toBe(true);
      // And no new checkout fits any more.
      const other = await member();
      expect(
        (
          await outcomeOf(() =>
            submitCheckout(
              checkout,
              body({ couponCode: code }),
              other.identity,
              t1,
            ),
          )
        ).ok,
      ).toBe(false);
      expect(customer.id).toBeTruthy();
    });

    it('checkout previews show what is available after holds', async () => {
      const { identity, account } = await member(15);
      const rw = await reward(10);
      await heldPayment(body({ loyaltyRewardId: rw.id }, 1), identity);
      const loyalty = moduleRef.get(LoyaltyService, { strict: false });
      expect(
        await loyalty.getAvailableBalanceForCustomer(
          account.customerId,
          TENANT_1_MOCHA_HOUSE_ID,
        ),
      ).toBe(5);
      // The early check refuses a second reward the customer can no longer
      // afford, before any attempt exists.
      const second = body({ loyaltyRewardId: rw.id }, 1);
      expect(
        (await outcomeOf(() => submitCheckout(checkout, second, identity, t1)))
          .status,
      ).toBe(409);
      expect(await attemptsOf(second.clientRef)).toHaveLength(0);
    });

    it('a per-customer-limited coupon needs a signed-in customer; a globally limited one works for guests', async () => {
      const perCustomer = await coupon({ perCustomer: 1 });
      const guest = await outcomeOf(() =>
        submitCheckout(
          checkout,
          body({ couponCode: perCustomer.code }),
          undefined,
          t1,
        ),
      );
      expect(guest.ok).toBe(false);
      expect(JSON.stringify(guest.response)).toContain('Sign in');
      expect(provider.calls).toHaveLength(0);

      const global = await coupon({ total: 3 });
      const request = body({ couponCode: global.code });
      await submitCheckout(checkout, request, undefined, t1);
      const [hold] = await holdsOf((await attemptOf(request.clientRef)).id);
      expect(hold).toMatchObject({
        kind: 'PROMOTION_REDEMPTION',
        customerId: null,
        status: 'CONSUMED',
      });
    });
  });

  // --- isolation and integrity --------------------------------------------------------

  describe('isolation and integrity', () => {
    it("holds belong to one business: another business's holds are invisible and cross-business holds are refused by the database", async () => {
      const { code, promotion } = await coupon({ total: 1 });
      const card = await giftCard(300);
      const holder = await heldPayment(
        body({ couponCode: code, giftCardCode: card.code }),
      );
      expect(await heldOnGiftCard(prisma, TEST_TENANT_B_ID, card.id)).toBe(0);
      expect(
        (await heldOnPromotion(prisma, TEST_TENANT_B_ID, promotion.id, null))
          .total,
      ).toBe(0);
      const other = await prisma.paymentAttempt.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          idempotencyKey: `pr8-${randomUUID()}`,
          provider: 'controlled-test',
          amount: 100,
          currency: 'USD',
        },
      });
      created.attempts.push(other.id);
      await expect(
        prisma.financialHold.create({
          data: {
            tenantId: TEST_TENANT_B_ID,
            paymentAttemptId: other.id,
            kind: 'GIFT_CARD_TENDER',
            amount: 100,
            giftCardId: card.id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.financialHold.create({
          data: {
            tenantId: TENANT_1_MOCHA_HOUSE_ID,
            paymentAttemptId: other.id,
            kind: 'PROMOTION_REDEMPTION',
            amount: 1,
            promotionId: promotion.id,
          },
        }),
      ).rejects.toThrow();
      expect((await holdsOf(holder.id)).map((h) => h.status)).toEqual([
        'ACTIVE',
        'ACTIVE',
      ]);
    });

    it('the database never lets a hold be released while its payment may have succeeded, consumed twice, or deleted', async () => {
      const { code } = await coupon({ total: 2 });
      const held = await heldPayment(body({ couponCode: code }));
      const [hold] = await holdsOf(held.id);
      await expect(
        prisma.financialHold.update({
          where: { id: hold.id },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            releaseReason: 'DECLINED',
          },
        }),
      ).rejects.toThrow(/released only/);
      await expect(
        prisma.financialHold.update({
          where: { id: hold.id },
          data: { status: 'CONSUMED', consumedAt: new Date() },
        }),
      ).rejects.toThrow(/consumed only/);
      await expect(
        prisma.financialHold.delete({ where: { id: hold.id } }),
      ).rejects.toThrow(/never deleted/);
      await expect(
        prisma.financialHold.update({
          where: { id: hold.id },
          data: { amount: 2 },
        }),
      ).rejects.toThrow();
      expect((await holdsOf(held.id))[0].status).toBe('ACTIVE');
    });
  });
});
